import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
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
const StickyNoteManager = lazy(() => import("./tools/sticky-note/StickyNoteManager"));
const StickyNote = lazy(() => import("./tools/sticky-note/StickyNote"));
const Settings = lazy(() => import("./components/Settings"));
const UpdatePrompt = lazy(() => import("./components/UpdatePrompt"));
const ContextMenu = lazy(() => import("./components/ContextMenu"));
const PinOcrResult = lazy(() => import("./tools/screenshot/PinOcrResult"));
const SketchTool = lazy(() => import("./tools/sketch/SketchTool"));
const ScrollNavigator = lazy(() => import("./tools/scroll-navigator/ScrollNavigator"));
const UtilityHub = lazy(() => import("./tools/utility-hub/UtilityHub"));

/** screenshot-overlay 窗口的模式切换器 */
function OverlaySwitcher() {
  const [mode, setMode] = useState<"screenshot" | "recording">("screenshot");

  // Keep a native liveness signal so a renderer crash/reload cannot leave a
  // full-screen WebView error page visible indefinitely.
  useEffect(() => {
    const heartbeat = () => {
      void invoke("mark_screenshot_overlay_heartbeat").catch(() => {});
    };
    heartbeat();
    const timer = window.setInterval(heartbeat, 500);
    return () => window.clearInterval(timer);
  }, []);

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
    void Promise.all([un, un2, un3, un4, unReadyRequest]).then(() =>
      emit("screenshot-overlay-ready"),
    );
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

interface OverlayErrorBoundaryProps {
  children: ReactNode;
}

interface OverlayErrorBoundaryState {
  error: Error | null;
}

/** Prevent a renderer/chunk error from leaving a full-screen screenshot overlay stuck. */
class OverlayErrorBoundary extends Component<OverlayErrorBoundaryProps, OverlayErrorBoundaryState> {
  state: OverlayErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): OverlayErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("screenshot overlay failed to render", error, info.componentStack);
    void invoke("cancel_screenshot").catch((cleanupError) => {
      console.error("failed to clean up after screenshot overlay error", cleanupError);
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const hideOverlay = () => {
      void getCurrentWebviewWindow()
        .hide()
        .catch((hideError) => {
          console.error("failed to hide screenshot overlay after render error", hideError);
        });
    };
    return (
      <div
        role="alert"
        style={{
          boxSizing: "border-box",
          width: "100vw",
          minHeight: "100vh",
          padding: "24px",
          display: "grid",
          placeContent: "center",
          gap: "12px",
          color: "#f8fafc",
          background: "rgba(15, 23, 42, 0.94)",
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
        }}
      >
        <strong>截图工具加载失败</strong>
        <span>{this.state.error.message || "截图页面加载失败"}</span>
        <button
          type="button"
          onClick={() => {
            hideOverlay();
            void invoke("cancel_screenshot").catch((cleanupError) => {
              console.error("failed to clean up screenshot after render error", cleanupError);
            });
          }}
          style={{ justifySelf: "center", padding: "8px 16px", cursor: "pointer" }}
        >
          退出截图
        </button>
      </div>
    );
  }
}

function OverlayLoadFallback() {
  return (
    <div
      role="status"
      style={{
        width: "100vw",
        minHeight: "100vh",
        display: "grid",
        placeContent: "center",
        color: "#f8fafc",
        background: "rgba(15, 23, 42, 0.94)",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      正在加载截图工具...
    </div>
  );
}

function App() {
  const windowLabel = getCurrentWebviewWindow().label;

  useEffect(() => {
    if (windowLabel !== "orb") return;
    let disposed = false;
    const openSketch = async () => {
      if (disposed) return;
      try {
        await ensureSketchWindow();
        if (disposed) return;
        await invoke("show_sketch_window");
      } catch (error) {
        console.error("Failed to open sketch window", error);
      }
    };
    const openTodoQuickAdd = async () => {
      if (disposed) return;
      try {
        await ensureTodoWindow();
        if (disposed) return;
        await invoke("show_todo_window");
        if (disposed) return;
        await emit("todo-focus-add");
      } catch (error) {
        console.error("Failed to open todo quick add", error);
      }
    };
    const un = listen("ensure-sketch-window", () => {
      void invoke<boolean>("consume_sketch_start_pending")
        .then((pending) => {
          if (pending && !disposed) void openSketch();
        })
        .catch((error) => console.error("Failed to consume sketch startup request", error));
    });
    const todoQuickAdd = listen("ensure-todo-window-for-quick-add", () => {
      void invoke<boolean>("consume_todo_quick_add_pending")
        .then((pending) => {
          if (pending && !disposed) void openTodoQuickAdd();
        })
        .catch((error) => console.error("Failed to consume todo startup request", error));
    });
    void Promise.all([un, todoQuickAdd])
      .then(async () => {
        const [sketchPending, todoPending] = await Promise.all([
          invoke<boolean>("consume_sketch_start_pending"),
          invoke<boolean>("consume_todo_quick_add_pending"),
        ]);
        if (sketchPending && !disposed) await openSketch();
        if (todoPending && !disposed) await openTodoQuickAdd();
      })
      .catch((error) => console.error("Failed to recover startup tool request", error));
    return () => {
      disposed = true;
      un.then((fn) => fn());
      todoQuickAdd.then((fn) => fn());
    };
  }, [windowLabel]);

  // 非 main 窗口（overlay、controls 等）始终透明背景，
  // 非主窗口保持透明；截图 overlay 使用可见的加载/错误兜底，避免显示默认错误页
  useEffect(() => {
    if (
      windowLabel !== "toolbar" &&
      windowLabel !== "orb" &&
      windowLabel !== "palette" &&
      windowLabel !== "utility-hub-overlay" &&
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
  } else if (windowLabel === "sticky-notes-manager") {
    content = <StickyNoteManager />;
  } else if (windowLabel.startsWith("sticky-note-")) {
    content = <StickyNote />;
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
  } else if (windowLabel === "scroll-navigator-overlay") {
    content = <ScrollNavigator />;
  } else if (windowLabel === "utility-hub-overlay") {
    content = <UtilityHub />;
  } else {
    content = <Settings />;
  }

  if (windowLabel === "screenshot-overlay") {
    return (
      <OverlayErrorBoundary>
        <Suspense fallback={<OverlayLoadFallback />}>{content}</Suspense>
      </OverlayErrorBoundary>
    );
  }
  return <Suspense fallback={null}>{content}</Suspense>;
}

export default App;
