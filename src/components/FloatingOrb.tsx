import { useEffect, useLayoutEffect, useCallback, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../styles/themePreferences";
import { invoke } from "@tauri-apps/api/core";
import {
  ensureScreenshotWindow,
  openToolWindow,
  preloadEnabledToolWindows,
  showContextMenu,
} from "../utils/toolWindows";
import type { ContextMenuRequest } from "./contextMenuTypes";
import { saveWindowPosition, persistWindowPositionOnMove } from "../utils/windowPosition";
import { BACKEND_TOOLS } from "../tools/registry";
import OrbIcon from "./OrbIcon";
import { getOrbIcon, type OrbIconId } from "../constants/orbAppearance";
import "./FloatingOrb.css";

function FloatingOrb() {
  const win = getCurrentWebviewWindow();
  const orbRef = useRef<HTMLDivElement | null>(null);
  const windowPosOnMouseDown = useRef<PhysicalPosition | null>(null);
  const mouseUpTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paletteOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [orbIcon, setOrbIcon] = useState<OrbIconId>(() => getOrbIcon());

  // Migrate an existing local preference once so the tray icon is correct even
  // before the settings window is opened again. Subsequent changes are saved
  // by Settings, avoiding duplicate writes when the event is received here.
  useEffect(() => {
    void invoke("set_orb_icon", { icon: getOrbIcon() }).catch((error) => {
      console.error("同步托盘悬浮球图标失败:", error);
    });
  }, []);

  useEffect(() => {
    const unlisten = listen<{ id: string }>("levitaire-orb-icon-changed", (event) => {
      const icon = event.payload?.id as OrbIconId;
      if (icon) setOrbIcon(icon);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  useEffect(() => {
    const unlisten = listen<boolean>("levitaire-palette-visibility", (event) => {
      setIsPaletteOpen(event.payload === true);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 同步设置页选择的主题（orb 是独立窗口，需手动读取 localStorage）
  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
  }, []);

  // 监听设置窗口的主题变更事件
  useEffect(() => {
    const unlistenTheme = subscribeThemePreferences();
    return () => {
      unlistenTheme.then((fn) => fn());
    };
  }, []);

  // Read the persisted enabled-tool configuration at startup and prepare only
  // those tools. All windows stay hidden; actual display remains user-driven.
  useEffect(() => {
    const runtimeMode = (import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE;
    if (runtimeMode === "test") return;
    void preloadEnabledToolWindows().catch((error) => {
      console.error("preload enabled tool windows failed:", error);
    });
  }, []);

  useEffect(() => {
    const show = (event: { payload: ContextMenuRequest }) => {
      void showContextMenu(event.payload).catch((error) => {
        console.error("show context menu failed:", error);
      });
    };
    const pin = listen<ContextMenuRequest>("pin-context-menu-request", show);
    const tray = listen<ContextMenuRequest>("tray-context-menu-request", show);
    return () => {
      pin.then((fn) => fn());
      tray.then((fn) => fn());
    };
  }, []);

  // 监听录制全局热键触发：后端 hotkey 线程 emit recording-hotkey-triggered 或
  // ensure-overlay-and-start-recording，由常驻 orb 窗口接收并处理
  useEffect(() => {
    let disposed = false;
    let screenshotStartQueue = Promise.resolve();
    let recordingStartQueue = Promise.resolve();

    const startScreenshot = async () => {
      const task = screenshotStartQueue.then(async () => {
        if (disposed) return;
        let overlayReady = false;
        try {
          const pending = await invoke<boolean>("consume_screenshot_start_pending");
          if (!pending || disposed) return;
          await ensureScreenshotWindow();
          overlayReady = true;
          if (!disposed) await invoke("start_screenshot");
        } catch (err) {
          console.error("screenshot hotkey failed:", err);
          // start_screenshot itself reports native startup failures. This
          // catch only reports window creation/readiness failures, for which
          // the command was never reached.
          if (!overlayReady) {
            const message =
              typeof err === "string"
                ? err
                : ((err as { message?: string })?.message ?? "截图工具加载失败，请重试");
            void invoke("show_screenshot_error", { message }).catch((dialogError) =>
              console.error("failed to show screenshot error:", dialogError),
            );
          }
        }
      });
      screenshotStartQueue = task;
      await task;
    };
    const startRecording = async () => {
      const task = recordingStartQueue.then(async () => {
        if (disposed) return;
        try {
          const pending = await invoke<boolean>("consume_recording_select_start_pending");
          if (!pending || disposed) return;
          // Native startup waits for the Win32 HWND. The frontend WebviewWindow
          // API has no hwnd() method, so polling it delayed every first launch.
          // A pending hotkey is consumed after the overlay is ready, so startup
          // events cannot be lost while the orb WebView is mounting.
          await ensureScreenshotWindow();
          if (!disposed) await invoke("start_recording_select");
        } catch (err) {
          console.error("recording hotkey failed:", err);
        }
      });
      recordingStartQueue = task;
      await task;
    };
    const un1 = listen("recording-hotkey-triggered", startRecording);
    const un2 = listen("ensure-overlay-and-start-recording", startRecording);
    const un3 = listen("ensure-overlay-and-start-screenshot", startScreenshot);
    // Consume markers only after all event listeners are registered. This
    // recovers hotkeys sent during startup without racing a live event.
    void Promise.all([un1, un2, un3])
      .then(async () => {
        if (disposed) return;
        await win.show();
        if (disposed) return;
        await invoke("mark_orb_ready");
        await Promise.all([startScreenshot(), startRecording()]);
      })
      .catch((err) => console.error("hotkey startup recovery failed:", err));
    return () => {
      disposed = true;
      un1.then((fn) => fn());
      un2.then((fn) => fn());
      un3.then((fn) => fn());
    };
  }, []);

  // 记忆 orb 位置：拖拽结束时即时保存（orb-mouseup），onMoved 防抖作为兜底，
  // 应用重启后恢复上次位置
  useEffect(() => persistWindowPositionOnMove("orb"), []);

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
      // orb 视觉体居中在带透明留白的 96×96 窗口内，阴影不会被窗口边界截断
      root.style.display = "flex";
      root.style.alignItems = "center";
      root.style.justifyContent = "center";
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
  useLayoutEffect(() => {
    const unlistenPromise = win.listen<boolean>("orb-mouseup", async (event) => {
      // Clear the safety timeout since we received the event
      if (mouseUpTimeout.current) {
        clearTimeout(mouseUpTimeout.current);
        mouseUpTimeout.current = null;
      }
      const clicked = event.payload === true;
      if (clicked) {
        // 点击悬浮球：打开卡片工具选择器面板
        // The low-level mouse hook reports button-up before Windows finishes
        // activating the orb/drag capture. Defer the palette slightly so its
        // focus is not immediately lost by the tail of that native event.
        if (paletteOpenTimer.current) clearTimeout(paletteOpenTimer.current);
        paletteOpenTimer.current = setTimeout(() => {
          paletteOpenTimer.current = null;
          invoke("show_palette").catch(console.error);
        }, 80);
        windowPosOnMouseDown.current = null;
        return;
      }
      // 拖拽（payload=false 或未传）：记忆位置，仅清理状态，不弹面板
      saveWindowPosition("orb");
      windowPosOnMouseDown.current = null;
    });

    return () => {
      unlistenPromise.then((fn) => fn());
      if (mouseUpTimeout.current) {
        clearTimeout(mouseUpTimeout.current);
      }
      if (paletteOpenTimer.current) {
        clearTimeout(paletteOpenTimer.current);
      }
    };
  }, [win]);

  // 圆形热区判定：交互半径 = 视觉球容器半径 + 2px 容差，覆盖 hover 放大
  // （scale 1.05）后的球边缘；与后端 mouse.rs ORB_HIT_RADIUS_LOGICAL(30) 保持一致，
  // 使点击球外透明留白不会触发拖拽 / 右键菜单 / 弹面板。坐标缺失（测试环境）时按圆内处理。
  const isPointWithinOrb = useCallback((clientX: number, clientY: number) => {
    const el = orbRef.current;
    if (!el) return true;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return true;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = rect.width / 2 + 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    return dx * dx + dy * dy <= radius * radius;
  }, []);

  const handleContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      // 圆形热区判定：右键球外透明留白不弹出菜单
      if (!isPointWithinOrb(e.clientX, e.clientY)) return;
      e.preventDefault();
      try {
        const [position, scaleFactor] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
        await showContextMenu({
          source: "orb",
          x: position.x + e.clientX * scaleFactor,
          y: position.y + e.clientY * scaleFactor,
        });
      } catch (err) {
        console.error("悬浮球右键菜单打开失败:", err);
      }
    },
    [isPointWithinOrb, win],
  );

  // Handle mousedown: record window position and start dragging
  const handleMouseDown = useCallback(
    async (e: React.MouseEvent) => {
      // Only react to primary button
      if (e.button !== 0) return;
      // 圆形热区判定：点击球外透明留白不进入拖拽，避免空白处拖走悬浮球
      if (!isPointWithinOrb(e.clientX, e.clientY)) return;
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
    },
    [isPointWithinOrb, win],
  );

  return (
    <div
      ref={orbRef}
      className={`orb-container ${isPaletteOpen ? "is-open" : ""}`}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
      role="button"
      aria-label="Levitaire 悬浮球 — 左键点击、拖拽移动，右键快捷菜单"
    >
      <div className="orb-inner">
        <OrbIcon icon={orbIcon} />
      </div>
    </div>
  );
}

export default FloatingOrb;
