import { lazy, Suspense, useState, useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { ensureSketchWindow, ensureTodoWindow } from "./utils/toolWindows";
import RecordingControls from "./tools/recording/RecordingControls";
import LongCaptureControls from "./tools/screenshot/LongCaptureControls";
import LongCaptureFrame from "./tools/screenshot/LongCaptureFrame";

// 按窗口 label 懒加载，每个窗口只加载对应 chunk，减少资源占用
const TextToolbar = lazy(() => import("./tools/text-toolbar/TextToolbar"));
const FloatingOrb = lazy(() => import("./components/FloatingOrb"));
const ToolPalette = lazy(() => import("./components/ToolPalette"));
const ScreenshotTool = lazy(() => import("./tools/screenshot/ScreenshotTool"));
const RecordingTool = lazy(() => import("./tools/recording/RecordingTool"));
const SystemMonitor = lazy(() => import("./tools/system-monitor/SystemMonitor"));
const PomodoroTool = lazy(() => import("./tools/pomodoro/PomodoroTool"));
const TimerTool = lazy(() => import("./tools/timer/TimerTool"));
const TodoTool = lazy(() => import("./tools/todo/TodoTool"));
const QuickInputTool = lazy(() => import("./tools/quick-input/QuickInputTool"));
const Settings = lazy(() => import("./components/Settings"));
const UpdatePrompt = lazy(() => import("./components/UpdatePrompt"));
const ContextMenu = lazy(() => import("./components/ContextMenu"));
const PinOcrResult = lazy(() => import("./tools/screenshot/PinOcrResult"));
const SketchTool = lazy(() => import("./tools/sketch/SketchTool"));

/** screenshot-overlay 窗口的模式切换器 */
function OverlaySwitcher() {
  const [mode, setMode] = useState<"screenshot" | "recording">("screenshot");

  // 挂载时查询后端当前是否处于录制选区模式。
  // 首次创建 overlay 窗口时，ensureScreenshotWindow 在 tauri://created 时 resolve，
  // 但 webview 可能还在加载 JS/React，此时后端发出的 recording-select-switch 事件
  // 会丢失（前端监听器尚未注册）。通过主动查询后端状态来弥补事件丢失。
  useEffect(() => {
    invoke<boolean>("is_recording_select_active")
      .then((active) => {
        if (active) setMode("recording");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    // recording-select-switch：立即切换到录制模式（消除 300ms 竞态窗口）
    const un = listen("recording-select-switch", () => {
      setMode("recording");
    });
    // recording-select-start：延迟事件，RecordingTool 用来开始交互
    const un4 = listen("recording-select-start", () => {
      setMode("recording");
    });
    // screenshot-cancelled 时恢复截图模式
    const un2 = listen("screenshot-cancelled", () => {
      setMode("screenshot");
    });
    // recording-select-cancel 时恢复截图模式
    const un3 = listen("recording-select-cancel", () => {
      setMode("screenshot");
    });
    const unReadyRequest = listen("screenshot-overlay-ready-request", () => {
      void emit("screenshot-overlay-ready");
    });
    void Promise.all([un, un2, un3, un4, unReadyRequest]).then(() => emit("screenshot-overlay-ready"));
    return () => {
      un.then((fn) => fn());
      un2.then((fn) => fn());
      un3.then((fn) => fn());
      un4.then((fn) => fn());
      unReadyRequest.then((fn) => fn());
    };
  }, []);

  return mode === "recording" ? <RecordingTool /> : <ScreenshotTool />;
}

function App() {
  const windowLabel = getCurrentWebviewWindow().label;

  useEffect(() => {
    if (windowLabel !== "orb") return;
    const un = listen("ensure-sketch-window", async () => {
      try {
        await ensureSketchWindow();
        await invoke("show_sketch_window");
      } catch (error) {
        console.error("Failed to open sketch window", error);
      }
    });
    const todoQuickAdd = listen("ensure-todo-window-for-quick-add", async () => {
      try {
        await ensureTodoWindow();
        await invoke("show_todo_window");
        await emit("todo-focus-add");
      } catch (error) {
        console.error("Failed to open todo quick add", error);
      }
    });
    return () => { un.then((fn) => fn()); todoQuickAdd.then((fn) => fn()); };
  }, [windowLabel]);

  // 非 main 窗口（overlay、controls 等）始终透明背景，
  // 防止 lazy 组件加载期间 Suspense fallback={null} 导致白色闪烁
  useEffect(() => {
    if (
      windowLabel !== "toolbar" &&
      windowLabel !== "orb" &&
      windowLabel !== "palette" &&
      windowLabel !== "settings" &&
      windowLabel !== "tool-config"
    ) {
      document.documentElement.style.background = "transparent";
      document.body.style.background = "transparent";
      document.body.style.margin = "0";
      document.body.style.overflow = "hidden";
    }
  }, [windowLabel]);

  let content: React.ReactNode;
  if (windowLabel === "toolbar") {
    content = <TextToolbar />;
  } else if (windowLabel === "orb") {
    content = <FloatingOrb />;
  } else if (windowLabel === "palette") {
    content = <ToolPalette />;
  } else if (windowLabel === "screenshot-overlay") {
    content = <OverlaySwitcher />;
  } else if (windowLabel === "recording-controls") {
    content = <RecordingControls />;
  } else if (windowLabel === "long-capture-controls") {
    content = <LongCaptureControls />;
  } else if (windowLabel === "long-capture-frame") {
    content = <LongCaptureFrame />;
  } else if (windowLabel === "monitor-overlay") {
    content = <SystemMonitor />;
  } else if (windowLabel === "pomodoro-overlay") {
    content = <PomodoroTool />;
  } else if (windowLabel === "time-overlay") {
    content = <TimerTool />;
  } else if (windowLabel === "todo-overlay") {
    content = <TodoTool />;
  } else if (windowLabel === "quick-input-overlay") {
    content = <QuickInputTool />;
  } else if (windowLabel === "update-prompt") {
    content = <UpdatePrompt />;
  } else if (windowLabel === "context-menu") {
    content = <ContextMenu />;
  } else if (windowLabel === "settings" || windowLabel === "tool-config") {
    content = <Settings />;
  } else if (windowLabel === "pin-ocr") {
    content = <PinOcrResult />;
  } else if (windowLabel === "sketch-overlay") {
    content = <SketchTool />;
  } else {
    content = <Settings />;
  }

  return <Suspense fallback={null}>{content}</Suspense>;
}

export default App;
