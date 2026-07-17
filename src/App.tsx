import { lazy, Suspense, useState, useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import RecordingControls from "./tools/recording/RecordingControls";

// 按窗口 label 懒加载，每个窗口只加载对应 chunk，减少资源占用
const TextToolbar = lazy(() => import("./tools/text-toolbar/TextToolbar"));
const FloatingOrb = lazy(() => import("./components/FloatingOrb"));
const ToolPalette = lazy(() => import("./components/ToolPalette"));
const ScreenshotTool = lazy(() => import("./tools/screenshot/ScreenshotTool"));
const RecordingTool = lazy(() => import("./tools/recording/RecordingTool"));
const VoiceInput = lazy(() => import("./tools/voice-input/VoiceInput"));
const SystemMonitor = lazy(() => import("./tools/system-monitor/SystemMonitor"));
const Settings = lazy(() => import("./components/Settings"));

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
    void Promise.all([un, un2, un3, un4]).then(() => emit("screenshot-overlay-ready"));
    return () => {
      un.then((fn) => fn());
      un2.then((fn) => fn());
      un3.then((fn) => fn());
      un4.then((fn) => fn());
    };
  }, []);

  return mode === "recording" ? <RecordingTool /> : <ScreenshotTool />;
}

function App() {
  const windowLabel = getCurrentWebviewWindow().label;

  // 非 main 窗口（overlay、controls 等）始终透明背景，
  // 防止 lazy 组件加载期间 Suspense fallback={null} 导致白色闪烁
  useEffect(() => {
    if (windowLabel !== "toolbar" && windowLabel !== "orb" && windowLabel !== "palette" && windowLabel !== "settings") {
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
  } else if (windowLabel === "voice-overlay") {
    content = <VoiceInput />;
  } else if (windowLabel === "monitor-overlay") {
    content = <SystemMonitor />;
  } else {
    content = <Settings />;
  }

  return <Suspense fallback={null}>{content}</Suspense>;
}

export default App;
