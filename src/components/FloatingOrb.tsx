import { useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { ensureVoiceWindow, ensureScreenshotWindow, openToolWindow } from "../utils/toolWindows";
import { BACKEND_TOOLS } from "../tools/registry";
import "./FloatingOrb.css";

function FloatingOrb() {
  const win = getCurrentWebviewWindow();
  const windowPosOnMouseDown = useRef<PhysicalPosition | null>(null);
  const mouseUpTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 同步设置页选择的主题（orb 是独立窗口，需手动读取 localStorage）
  useLayoutEffect(() => {
    const theme = localStorage.getItem("floatory-theme") || "light";
    document.documentElement.setAttribute("data-theme", theme);
  }, []);

  // 监听设置窗口的主题变更事件
  useEffect(() => {
    const unlistenTheme = listen<string>("floatory-theme-changed", (event) => {
      document.documentElement.setAttribute("data-theme", event.payload);
      localStorage.setItem("floatory-theme", event.payload);
    });
    return () => {
      unlistenTheme.then((fn) => fn());
    };
  }, []);

  // 监听语音输入全局热键触发：后端 hotkey 线程 emit voice-hotkey-triggered，
  // 由常驻的 orb 窗口接收并唤起录音浮层（getUserMedia 必须在前端 webview 执行）
  useEffect(() => {
    const un = listen("voice-hotkey-triggered", async () => {
      try {
        await ensureVoiceWindow();
        await invoke("show_voice_window");
      } catch (err) {
        console.error(err);
      }
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // 监听录制全局热键触发：后端 hotkey 线程 emit recording-hotkey-triggered 或
  // ensure-overlay-and-start-recording，由常驻 orb 窗口接收并处理
  useEffect(() => {
    const startRecording = async () => {
      try {
        await ensureScreenshotWindow();
        // Native startup waits for the Win32 HWND. The frontend WebviewWindow
        // API has no hwnd() method, so polling it delayed every first launch.
        await invoke("start_recording_select");
      } catch (err) {
        console.error("recording hotkey failed:", err);
      }
    };
    const un1 = listen("recording-hotkey-triggered", startRecording);
    const un2 = listen("ensure-overlay-and-start-recording", startRecording);
    return () => {
      un1.then((fn) => fn());
      un2.then((fn) => fn());
    };
  }, []);

  // Make the orb window non-focusable so it never steals focus from other apps
  // Also set body to transparent (must be done via JS, not CSS, because all windows
  // share the same Vite bundle and a global body rule would break the settings window)
  useEffect(() => {
    win.setFocusable(false).catch(console.error);
    document.documentElement.style.background = "transparent";
    document.documentElement.style.overflow = "visible";
    document.documentElement.style.height = "100%";
    document.body.style.background = "transparent";
    document.body.style.overflow = "visible";
    document.body.style.height = "100%";
    const root = document.getElementById("root");
    if (root) {
      root.style.background = "transparent";
      root.style.margin = "0";
      root.style.padding = "0";
      root.style.overflow = "visible";
      root.style.height = "100%";
    }
  }, [win]);

  // 自启动：应用启动时自动打开"启用 + 自启动"的工具窗口
  // 从后端读取真值，避免 localStorage 与后端 config.json 不同步
  useEffect(() => {
    // 延迟一小段时间再打开，避免 orb 窗口本身还没完全就绪
    const timer = setTimeout(() => {
      Promise.all([
        Promise.all(
          BACKEND_TOOLS.map((t) =>
            invoke<boolean>(t.getter)
              .then((enabled) => ({ id: t.id, enabled }))
              .catch(() => null),
          ),
        ),
        invoke<string[]>("get_tools_autostart").catch(() => []),
      ]).then(([results, autostartIds]) => {
        const enabledIds = results
          .filter((r): r is { id: string; enabled: boolean } => r !== null && r.enabled)
          .map((r) => r.id);
        const toOpen = autostartIds.filter((id) => enabledIds.includes(id));
        for (const toolId of toOpen) {
          openToolWindow(toolId).catch((err) => {
            console.error(`自启动工具 ${toolId} 打开失败:`, err);
          });
        }
      });
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  // Listen for orb-mouseup event from the Rust mouse hook
  // (startDragging() consumes the DOM mouseup, so we use the hook instead)
  // payload = 是否为点击（非拖拽），由后端基于鼠标位移判定，比前端窗口位移判定更可靠
  useEffect(() => {
    const unlistenPromise = win.listen<boolean>("orb-mouseup", async (event) => {
      // Clear the safety timeout since we received the event
      if (mouseUpTimeout.current) {
        clearTimeout(mouseUpTimeout.current);
        mouseUpTimeout.current = null;
      }
      const clicked = event.payload === true;
      if (clicked) {
        // 点击悬浮球：打开卡片工具选择器面板
        invoke("show_palette").catch(console.error);
        windowPosOnMouseDown.current = null;
        return;
      }
      // 拖拽（payload=false 或未传）：仅清理状态，不弹面板
      windowPosOnMouseDown.current = null;
    });

    return () => {
      unlistenPromise.then((fn) => fn());
      if (mouseUpTimeout.current) {
        clearTimeout(mouseUpTimeout.current);
      }
    };
  }, [win]);

  // Handle mousedown: record window position and start dragging
  const handleMouseDown = useCallback(async (e: React.MouseEvent) => {
    // Only react to primary button
    if (e.button !== 0) return;
    e.preventDefault();
    // Clear any stale state from previous interactions
    if (mouseUpTimeout.current) {
      clearTimeout(mouseUpTimeout.current);
      mouseUpTimeout.current = null;
    }
    // Record window position before drag to detect click vs drag later
    try {
      windowPosOnMouseDown.current = await win.outerPosition();
    } catch (err) {
      console.error("Failed to get window position:", err);
    }
    // Safety timeout: if orb-mouseup event is not received within 5 seconds,
    // clean up the stale position to prevent false matches on next interaction
    mouseUpTimeout.current = setTimeout(() => {
      windowPosOnMouseDown.current = null;
      mouseUpTimeout.current = null;
    }, 5000);
    try {
      await win.startDragging();
    } catch (err) {
      console.error("Failed to start dragging:", err);
    }
  }, [win]);

  return (
    <div
      className="orb-container"
      onMouseDown={handleMouseDown}
      role="button"
      aria-label="Floatory 悬浮球 — 拖拽移动，点击触发"
    >
      <div className="orb-inner">
        {/* 原子轨道图标 — 中心圆点 + 3 条椭圆轨道交叉，象征悬浮球为中心、多工具环绕 */}
        <svg
          className="orb-icon"
          width="24"
          height="24"
          viewBox="0 0 18 18"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* 中心实心圆点 */}
          <circle cx="9" cy="9" r="1.5" fill="currentColor" stroke="none" />
          {/* 3 条椭圆轨道，分别旋转 0° / 60° / 120° */}
          <ellipse cx="9" cy="9" rx="7.5" ry="3" transform="rotate(0 9 9)" />
          <ellipse cx="9" cy="9" rx="7.5" ry="3" transform="rotate(60 9 9)" />
          <ellipse cx="9" cy="9" rx="7.5" ry="3" transform="rotate(120 9 9)" />
        </svg>
      </div>
    </div>
  );
}

export default FloatingOrb;
