import { useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import "./FloatingOrb.css";

function FloatingOrb() {
  const win = getCurrentWebviewWindow();
  const windowPosOnMouseDown = useRef<PhysicalPosition | null>(null);
  const mouseUpTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 同步设置页选择的主题（orb 是独立窗口，需手动读取 localStorage）
  useLayoutEffect(() => {
    const theme = localStorage.getItem("floast-theme") || "light";
    document.documentElement.setAttribute("data-theme", theme);
  }, []);

  // 监听设置窗口的主题变更事件
  useEffect(() => {
    const unlistenTheme = listen<string>("floast-theme-changed", (event) => {
      document.documentElement.setAttribute("data-theme", event.payload);
      localStorage.setItem("floast-theme", event.payload);
    });
    return () => {
      unlistenTheme.then((fn) => fn());
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

  // Listen for orb-mouseup event from the Rust mouse hook
  // (startDragging() consumes the DOM mouseup, so we use the hook instead)
  useEffect(() => {
    const unlistenPromise = win.listen("orb-mouseup", async () => {
      // Clear the safety timeout since we received the event
      if (mouseUpTimeout.current) {
        clearTimeout(mouseUpTimeout.current);
        mouseUpTimeout.current = null;
      }
      // Compare window position: if it didn't move, it was a click; if it moved, it was a drag
      if (windowPosOnMouseDown.current) {
        try {
          // Wait one frame for the OS drag loop to fully unwind before reading position.
          // The WH_MOUSE_LL hook fires WM_LBUTTONUP before the OS modal drag loop completes,
          // so outerPosition() might return a stale value without this delay.
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const currentPos = await win.outerPosition();
          const startPos = windowPosOnMouseDown.current;
          const dx = Math.abs(currentPos.x - startPos.x);
          const dy = Math.abs(currentPos.y - startPos.y);
          // If window moved less than 3px, treat as click
          if (dx < 3 && dy < 3) {
            // TODO: 悬浮球点击功能待实现
            // 未来可扩展：打开主面板、快速操作菜单等
          }
        } catch (err) {
          console.error("Failed to get window position:", err);
        }
        windowPosOnMouseDown.current = null;
      }
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
      aria-label="Floast 悬浮球 — 拖拽移动，点击触发"
    >
      <div className="orb-inner" />
    </div>
  );
}

export default FloatingOrb;
