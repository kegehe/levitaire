import { useEffect, useLayoutEffect, useCallback, useRef, useState, useMemo } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen, emit } from "@tauri-apps/api/event";
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
import { BACKEND_TOOLS, resolveToolIdAlias } from "../tools/registry";
import OrbIcon from "./OrbIcon";
import { getOrbIcon, type OrbIconId } from "../constants/orbAppearance";
import "./FloatingOrb.css";

function FloatingOrb() {
  // getCurrentWebviewWindow() 每次调用都返回新对象，必须 memo 化：
  // 它是多个 effect 的依赖，写在渲染体里会让它们每次渲染重跑（见 MEMORY.md 第 8 条）。
  const win = useMemo(() => getCurrentWebviewWindow(), []);
  const orbRef = useRef<HTMLDivElement | null>(null);
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
  // 「点悬浮球收起面板」要读这个状态，但 orb-mouseup 的监听器只在挂载时注册一次
  // （依赖数组是 [win]），闭包里的 state 会永远停在初始值 false —— 必须走 ref。
  const isPaletteOpenRef = useRef(false);
  useEffect(() => {
    const unlisten = listen<boolean>("levitaire-palette-visibility", (event) => {
      const open = event.payload === true;
      isPaletteOpenRef.current = open;
      setIsPaletteOpen(open);
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

  // 球外点击穿透（悬浮球窗口被系统最小宽度拉到 135 逻辑、球只有 56，球外那圈透明留白
  // 压在便签顶栏 / 面板 / 桌面图标上时，那些位置的点按会被它吃掉）**不在这里做**：
  // 由后端鼠标钩子直接切换窗口的 `set_ignore_cursor_events`（见 mouse.rs 的 OrbZone 分支）。
  // 两个原因 —— 钩子是全局的（窗口一旦穿透就收不到自己的鼠标消息，前端监听 mousemove
  // 无法自己走回来），且经前端中转要多一个 emit→IPC→invoke 往返，而这段延迟正好落在
  // 「鼠标移进球体 → 恢复交互」之间，快点击会整下漏掉。

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
        // 已并入其他工具的旧 ID（如 pomodoro → timer）在配置里可能仍然存在，
        // 不映射就会静默丢掉用户的「启动时自动打开」设置；映射后去重，
        // 避免 "pomodoro" 与 "timer" 并存时重复打开同一个窗口。
        const toOpen = [...new Set(autostartIds.map(resolveToolIdAlias))].filter((id) =>
          enabledIds.includes(id),
        );
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
      const clicked = event.payload === true;
      if (clicked) {
        // 点击悬浮球：打开 / 收起卡片工具选择器面板（toggle）
        // The low-level mouse hook reports button-up before Windows finishes
        // activating the orb/drag capture. Defer the palette slightly so its
        // focus is not immediately lost by the tail of that native event.
        if (paletteOpenTimer.current) clearTimeout(paletteOpenTimer.current);
        paletteOpenTimer.current = setTimeout(() => {
          paletteOpenTimer.current = null;
          if (isPaletteOpenRef.current) {
            // 面板（曾经）开过 ⇒ 这一下是「开合切换」，交给面板自己裁决：它用**原生
            // is_visible** 判断真值，比这里的 ref 可靠 —— 截图/长截图等流程会不经前端
            // 直接把面板 hide 掉，那种情况下 ref 会残留成"已展开"。
            // 另外球窗是 focusable(false)，点它不会改变前台窗口，面板的「失焦自动隐藏」
            // 分支不会触发 —— 不主动收起就没有任何路径能关掉它。
            emit("palette-toggle-requested").catch(console.error);
          } else {
            // ref 为 false 有两种情况：面板还没被创建过（必须 show），或面板已收起 ——
            // 后者直接 show 也是对的（show_palette 幂等）。
            invoke("show_palette").catch(console.error);
          }
        }, 80);
        return;
      }
      // 拖拽（payload=false 或未传）：记忆位置，不弹面板
      saveWindowPosition("orb");
    });

    return () => {
      unlistenPromise.then((fn) => fn());
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
      // 点击 / 拖拽的判定由后端 orb-mouseup 的 payload 负责；这里直接开始拖拽，
      // 不再先等一次 outerPosition() 的 IPC（会拖慢每次按下到跟手的间隔）。
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
