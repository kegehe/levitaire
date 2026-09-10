import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { check, type Update } from "@tauri-apps/plugin-updater";
import {
  Clipboard,
  Copy,
  Download,
  FlipHorizontal2,
  FlipVertical2,
  MonitorUp,
  RotateCcw,
  RotateCw,
  Settings,
  X,
  CircleOff,
  RefreshCw,
  ScanText,
  Wrench,
} from "lucide-react";
import { type ContextMenuRequest, type ContextMenuSource } from "./contextMenuTypes";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../styles/themePreferences";
import { ensurePinOcrWindow, hideContextMenu } from "../utils/toolWindows";
import "./ContextMenu.css";

type Icon = typeof Download;

interface ContextMenuItem {
  id: string;
  label: string;
  icon: Icon;
  destructive?: boolean;
}

type TrayUpdateStatus =
  "idle" | "checking" | "up-to-date" | "available" | "error" | "install-error";

// Every right-click on the tray icon shows this menu, which used to trigger a
// live update check each time. Cache the last result for a while so frequent
// tray clicks do not fire a flood of network requests (and a slow/offline
// network does not leave the menu stuck on "正在检查更新...").
const TRAY_UPDATE_CACHE_TTL_MS = 5 * 60 * 1000;
// A check request that is still in flight gets a much shorter reuse window:
// it only coalesces quick successive right-clicks (no second request while the
// first is pending) without letting a hung request block the menu for the full
// cache TTL.
const TRAY_UPDATE_IN_FLIGHT_WINDOW_MS = 10 * 1000;

const MENUS: Record<ContextMenuSource, ContextMenuItem[][]> = {
  pin: [
    [
      { id: "copy", label: "复制到剪贴板", icon: Clipboard },
      { id: "ocr", label: "OCR", icon: ScanText },
      { id: "save", label: "下载图片", icon: Download },
      { id: "close", label: "关闭贴图", icon: X, destructive: true },
    ],
    [
      { id: "rotate-left", label: "向左旋转", icon: RotateCcw },
      { id: "rotate-right", label: "向右旋转", icon: RotateCw },
    ],
    [
      { id: "flip-horizontal", label: "水平翻转", icon: FlipHorizontal2 },
      { id: "flip-vertical", label: "垂直翻转", icon: FlipVertical2 },
    ],
    [
      { id: "duplicate-mirror", label: "复制镜像", icon: Copy },
      { id: "duplicate-horizontal-mirror", label: "复制水平镜像", icon: FlipHorizontal2 },
      { id: "duplicate-vertical-mirror", label: "复制垂直镜像", icon: FlipVertical2 },
    ],
    [{ id: "tool-config", label: "工具配置", icon: Wrench }],
  ],
  orb: [
    [
      { id: "settings", label: "设置", icon: Settings },
      { id: "tool-config", label: "工具配置", icon: Wrench },
      { id: "hide-orb", label: "隐藏悬浮球", icon: CircleOff },
    ],
    [{ id: "quit", label: "退出", icon: X, destructive: true }],
  ],
  tray: [
    [
      { id: "toggle-orb", label: "显示/隐藏悬浮球", icon: MonitorUp },
      { id: "settings", label: "设置", icon: Settings },
      { id: "tool-config", label: "工具配置", icon: Wrench },
    ],
    [{ id: "quit", label: "退出", icon: X, destructive: true }],
  ],
};

function ContextMenu() {
  const win = getCurrentWebviewWindow();
  const [request, setRequest] = useState<ContextMenuRequest | null>(null);
  const [trayUpdateStatus, setTrayUpdateStatus] = useState<TrayUpdateStatus>("idle");
  const [trayUpdate, setTrayUpdate] = useState<Update | null>(null);
  const hideTimer = useRef<number | null>(null);
  const trayCheckGeneration = useRef(0);
  // 是否有在线检查正在进行：任一菜单打开期间，只要存在进行中的检查就合并复用，
  // 避免慢请求（耗时超过 in-flight 窗口）被误判为「已结束」而并发重复发起。
  const trayCheckInFlightRef = useRef(false);
  const lastTrayUpdateCacheRef = useRef<{
    time: number;
    status: TrayUpdateStatus;
    update: Update | null;
  } | null>(null);

  const checkTrayUpdate = useCallback(async () => {
    const generation = ++trayCheckGeneration.current;
    // Publish the pending state immediately so a menu opened while this request
    // is still running reuses "checking" instead of starting another check().
    lastTrayUpdateCacheRef.current = {
      time: Date.now(),
      status: "checking",
      update: null,
    };
    setTrayUpdateStatus("checking");
    setTrayUpdate(null);
    trayCheckInFlightRef.current = true;
    try {
      const update = await check();
      if (generation !== trayCheckGeneration.current) return;
      const status = update ? "available" : "up-to-date";
      lastTrayUpdateCacheRef.current = { time: Date.now(), status, update };
      setTrayUpdate(update);
      setTrayUpdateStatus(status);
    } catch (error) {
      if (generation !== trayCheckGeneration.current) return;
      console.error("tray update check failed:", error);
      lastTrayUpdateCacheRef.current = {
        time: Date.now(),
        status: "error",
        update: null,
      };
      setTrayUpdateStatus("error");
    } finally {
      // 仅当仍是当前请求时才清标记：若期间有更新的重试请求发起，
      // in-flight 标记由后者接管，此处不得误清覆盖。
      if (generation === trayCheckGeneration.current) {
        trayCheckInFlightRef.current = false;
      }
    }
  }, []);

  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
  }, []);

  useEffect(() => {
    const unlisten = listen<{ pinId: number; text?: string; error?: string }>(
      "pin-ocr-result",
      async (event) => {
        try {
          const window = await ensurePinOcrWindow();
          await emitTo("pin-ocr", "pin-ocr-show", event.payload);
          await window.show();
          await window.setFocus();
        } catch (error) {
          console.error("show pin OCR result failed:", error);
        }
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlistenTheme = subscribeThemePreferences();
    const unlistenShow = listen<ContextMenuRequest>("context-menu-show", (event) => {
      setRequest(event.payload);
    });
    const unlistenFocus = win.onFocusChanged(({ payload: focused }) => {
      if (focused) return;
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => {
        hideTimer.current = null;
        void hideContextMenu();
      }, 80);
    });
    const unlistenReadyRequest = listen("context-menu-ready-request", () => {
      void emit("context-menu-ready");
    });
    void Promise.all([unlistenTheme, unlistenShow, unlistenFocus, unlistenReadyRequest]).then(
      () => {
        void emit("context-menu-ready");
      },
    );
    return () => {
      unlistenTheme.then((fn) => fn());
      unlistenShow.then((fn) => fn());
      unlistenFocus.then((fn) => fn());
      unlistenReadyRequest.then((fn) => fn());
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    };
  }, [win]);

  useEffect(() => {
    if (!request) return;
    void win
      .show()
      .then(() => win.setFocus())
      .catch(console.error);
  }, [request, win]);

  useEffect(() => {
    if (request?.source !== "tray") return;
    const cached = lastTrayUpdateCacheRef.current;
    // A fresh result is within the TTL window: reuse it instead of checking
    // online again. A pending check is only coalesced for the short in-flight
    // window. The explicit "检查更新/重试" item still bypasses all of this by
    // calling checkTrayUpdate() directly.
    if (trayCheckInFlightRef.current && cached?.status === "checking") {
      const age = Date.now() - cached.time;
      // 仅合并仍在 in-flight 窗口内的进行中检查（快速连续右键复用，避免并发重复发起）。
      // 若超过窗口仍未返回，视作挂起请求：放行下面发起新检查，由新 generation 接管
      // in-flight 标记；旧请求即使稍后返回也会因 generation 不匹配而被忽略，
      // 避免托盘菜单永远停在禁用的「正在检查更新...」。
      if (age < TRAY_UPDATE_IN_FLIGHT_WINDOW_MS) {
        setTrayUpdateStatus(cached.status);
        setTrayUpdate(cached.update);
        return;
      }
    }
    if (cached) {
      const age = Date.now() - cached.time;
      const fresh =
        cached.status === "checking"
          ? age < TRAY_UPDATE_IN_FLIGHT_WINDOW_MS
          : age < TRAY_UPDATE_CACHE_TTL_MS;
      if (fresh) {
        setTrayUpdateStatus(cached.status);
        setTrayUpdate(cached.update);
        return;
      }
    }
    void checkTrayUpdate();
  }, [request, checkTrayUpdate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void hideContextMenu();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const groups = useMemo(() => {
    if (!request) return [];
    if (request.source !== "tray") return MENUS[request.source];

    const updateItem: ContextMenuItem =
      trayUpdateStatus === "checking"
        ? { id: "checking-update", label: "正在检查更新...", icon: RefreshCw }
        : trayUpdateStatus === "available" && trayUpdate
          ? { id: "install-update", label: `更新至 v${trayUpdate.version}`, icon: Download }
          : trayUpdateStatus === "up-to-date"
            ? { id: "check-update", label: "检查更新（已是最新）", icon: RefreshCw }
            : trayUpdateStatus === "error"
              ? { id: "check-update", label: "检查更新失败，重试", icon: RefreshCw }
              : trayUpdateStatus === "install-error"
                ? { id: "check-update", label: "更新失败，重试", icon: RefreshCw }
                : { id: "check-update", label: "检查更新", icon: RefreshCw };
    return [MENUS.tray[0], [updateItem], MENUS.tray[1]];
  }, [request, trayUpdate, trayUpdateStatus]);

  const runAction = async (action: string) => {
    if (!request) return;
    try {
      // Tool configuration is a global command, including when opened from a
      // pinned-image context menu (which otherwise dispatches to pin actions).
      if (action === "tool-config") {
        await hideContextMenu();
        await invoke("show_tool_config");
        return;
      }
      if (request.source === "pin") {
        await hideContextMenu();
        if (request.pinId === undefined) return;
        await invoke("pin_context_menu_action", { id: request.pinId, action });
        return;
      }
      if (action === "checking-update") return;
      if (action === "check-update") {
        await checkTrayUpdate();
        return;
      }
      await hideContextMenu();
      switch (action) {
        case "settings":
          await invoke("show_settings");
          return;
        case "tool-config":
          await invoke("show_tool_config");
          return;
        case "hide-orb":
          await invoke("hide_orb");
          return;
        case "toggle-orb":
          await invoke("toggle_orb");
          return;
        case "install-update":
          try {
            await invoke("install_update");
          } catch (error) {
            setTrayUpdate(null);
            setTrayUpdateStatus("install-error");
            await win.show().then(() => win.setFocus());
            throw error;
          }
          return;
        case "quit":
          await invoke("exit_app");
          return;
      }
    } catch (error) {
      console.error(`context menu action ${action} failed:`, error);
    }
  };

  return (
    <nav className="context-menu" aria-label="快捷菜单">
      {groups.map((group, groupIndex) => (
        <div className="context-menu-group" key={group[0]?.id ?? groupIndex}>
          {group.map((item) => {
            const ItemIcon = item.icon;
            return (
              <button
                className={`context-menu-item${item.destructive ? " is-destructive" : ""}`}
                key={item.id}
                onClick={() => void runAction(item.id)}
                disabled={item.id === "checking-update"}
                type="button"
              >
                <ItemIcon aria-hidden="true" size={17} strokeWidth={1.8} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export default ContextMenu;
