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

// 按窗口 label 懒加载，每个窗口只加载对应 chunk，减少资源占用
const TextToolbar = lazy(() => import("./tools/text-toolbar/TextToolbar"));
const FloatingOrb = lazy(() => import("./components/FloatingOrb"));
const ToolPalette = lazy(() => import("./components/ToolPalette"));
const ScreenshotTool = lazy(() => import("./tools/screenshot/ScreenshotTool"));
const RecordingTool = lazy(() => import("./tools/recording/RecordingTool"));
const SystemMonitor = lazy(() => import("./tools/system-monitor/SystemMonitor"));
const SystemCleanerTool = lazy(() => import("./tools/system-cleaner/SystemCleanerTool"));
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
const UtilityHub = lazy(() => import("./tools/utility-hub/UtilityHub"));
const RecordingControls = lazy(() => import("./tools/recording/RecordingControls"));
const LongCaptureControls = lazy(() => import("./tools/screenshot/LongCaptureControls"));
const LongCaptureFrame = lazy(() => import("./tools/screenshot/LongCaptureFrame"));

/** screenshot-overlay 窗口的模式切换器 */
function OverlaySwitcher() {
  const [mode, setMode] = useState<"screenshot" | "recording">("screenshot");

  // Keep a native liveness signal so a renderer crash/reload cannot leave a
  // full-screen WebView error page visible indefinitely. The watchdog that
  // consumes this heartbeat only runs while a capture/recording session is
  // active, so the interval is gated on session state instead of firing every
  // 500ms for the lifetime of the always-resident (often hidden) overlay.
  useEffect(() => {
    const heartbeat = () => {
      void invoke("mark_screenshot_overlay_heartbeat").catch(() => {});
    };
    // 立即上报一次存活：wait_for_screenshot_overlay_ready 依赖首个心跳确认
    // 渲染器已挂载，会话激活后不能只依赖事件驱动的心跳补充。
    heartbeat();
    let timer: number | undefined;
    // 并发守卫：active 事件可能密集触发（与初次补偿查询并存），start 内 await 期间
    // 若第二个调用也通过 `timer === undefined` 检查，会让两个心跳 interval 并存且
    // 只有一个 id 被记录，另一个永久泄漏。用 starting 锁串行化启动流程。
    let starting = false;
    // 查询在途期间若又收到 active 信号，先记下来；当本次查询恰落在会话激活之前的
    // 过期快照上而返回 false 时，不直接放弃启动，而是补查一次接住那次被起始守卫
    // 吞掉的激活——否则心跳永不启动，原生 watchdog 会误拆一个仍活跃的截图会话。
    let pendingStart = false;
    // stop() 递增。查询在途时若会话已结束（inactive 先一步到达，而 interval 尚未创建、
    // 无法被 stop 清理），代次变化会让本次查询立即作废，避免事后落下一个空跑到
    // 下一次会话结束的常驻心跳。
    let epoch = 0;
    const start = async () => {
      if (timer !== undefined) return;
      if (starting) {
        pendingStart = true;
        return;
      }
      starting = true;
      let startedEpoch = epoch;
      try {
        while (true) {
          if (disposed) return;
          if (epoch !== startedEpoch) {
            // 查询期间发生过 stop：本次尝试已作废。但若期间又收到 active 信号
            // （pendingStart），说明会话已重新激活——重新锚定到新 epoch 再查一次，
            // 不能把那次激活吞掉，否则心跳永不启动、原生 watchdog 会误拆活跃会话。
            if (pendingStart) {
              pendingStart = false;
              startedEpoch = epoch;
              continue;
            }
            return;
          }
          // 启动心跳前二次确认后端会话确实仍活跃：防止「挂载查询快照 stale」
          // 导致会话已结束却仍启动常驻定时器（空转 IPC）。.catch 兜底使 starting 必复位。
          const active = await invoke<boolean>("is_capture_session_active").catch(() => false);
          // await 期间组件可能已卸载（disposed/stop 已清 timer），此时不可再启动，
          // 否则新 interval 不在清理范围内、逃逸成常驻心跳。
          if (disposed) return;
          if (epoch !== startedEpoch) {
            if (pendingStart) {
              pendingStart = false;
              startedEpoch = epoch;
              continue;
            }
            return;
          }
          if (timer !== undefined) {
            pendingStart = false;
            return;
          }
          if (!active) {
            // 无活跃会话。若本次查询期间收到过 active 信号（pendingStart），
            // 说明快照已过期，补查一次以接住那次激活。
            if (pendingStart) {
              pendingStart = false;
              continue;
            }
            return;
          }
          pendingStart = false;
          timer = window.setInterval(heartbeat, 500);
          // 建立定时器后立刻上报一次：后端 wait_for_screenshot_overlay_ready 在会话
          // 激活后会清零心跳标记，只认「激活之后」的心跳。若只依赖 interval 的首个 tick，
          // 每次截图都要白等一整个周期（实测固定 503~505ms，日志已量化）。
          // 此处已通过 is_capture_session_active 确认会话确实活跃，立即上报与定时心跳
          // 语义一致：都是「渲染器能响应事件并执行 JS」的证据，不削弱崩溃检测。
          heartbeat();
          return;
        }
      } finally {
        starting = false;
      }
    };
    const stop = () => {
      epoch += 1;
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };

    // 先注册事件监听、再查询当前状态：确保 active/inactive 信号在查询落地前已就绪，
    // 避免「查询判活跃 → start() 之后、inactive 监听生效前」这一窗口内会话结束，
    // 导致 inactive 事件丢失、stop 永不调用而留下常驻心跳。
    let disposed = false;
    const unlistens: Array<Promise<() => void>> = [];
    async function init() {
      unlistens.push(listen("capture-session-active", start));
      unlistens.push(listen("capture-session-inactive", stop));
      await Promise.all([unlistens[0], unlistens[1]]);
      if (disposed) return;
      // 弥补挂载前会话已激活（active 事件已发出）时的事件丢失；
      // start 内部会二次确认当前活跃状态，查询结果 stale 也不会误启动。
      void start();
    }
    void init();

    return () => {
      disposed = true;
      stop();
      for (const u of unlistens) void u.then((fn) => fn());
    };
  }, []);

  // 挂载时查询后端当前是否处于录制选区模式。
  // 首次创建 overlay 窗口时，ensureScreenshotWindow 在 tauri://created 时 resolve，
  // 但 webview 可能还在加载 JS/React，此时后端发出的 recording-select-switch 事件
  // 会丢失（前端监听器尚未注册）。通过主动查询后端状态来弥补事件丢失。
  useEffect(() => {
    let disposed = false;
    invoke<boolean>("is_recording_select_active")
      .then((active) => {
        // 查询在监听器注册前发出；卸载/取消后返回的过期快照不能再改 mode。
        if (!disposed && active) setMode("recording");
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
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
  } else if (windowLabel === "system-cleaner-overlay") {
    content = <SystemCleanerTool />;
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
