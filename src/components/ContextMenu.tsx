import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
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
  Video,
  Camera,
} from "lucide-react";
import {
  type ContextMenuRequest,
  type ContextMenuSource,
} from "./contextMenuTypes";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../styles/themePreferences";
import { hideContextMenu } from "../utils/toolWindows";
import { ensureScreenshotWindow } from "../utils/toolWindows";
import "./ContextMenu.css";

type Icon = typeof Download;

interface ContextMenuItem {
  id: string;
  label: string;
  icon: Icon;
  destructive?: boolean;
}

const MENUS: Record<ContextMenuSource, ContextMenuItem[][]> = {
  pin: [
    [{ id: "save", label: "下载图片", icon: Download }],
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
    [
      { id: "copy", label: "复制到剪贴板", icon: Clipboard },
      { id: "close", label: "关闭贴图", icon: X, destructive: true },
    ],
  ],
  orb: [
    [
      { id: "screenshot", label: "屏幕截图", icon: Camera },
      { id: "recording", label: "GIF/录屏", icon: Video },
    ],
    [
      { id: "settings", label: "设置", icon: Settings },
      { id: "hide-orb", label: "隐藏悬浮球", icon: CircleOff },
    ],
    [{ id: "quit", label: "退出", icon: X, destructive: true }],
  ],
  tray: [
    [
      { id: "toggle-orb", label: "显示/隐藏悬浮球", icon: MonitorUp },
      { id: "settings", label: "设置", icon: Settings },
    ],
    [{ id: "quit", label: "退出", icon: X, destructive: true }],
  ],
};

function ContextMenu() {
  const win = getCurrentWebviewWindow();
  const [request, setRequest] = useState<ContextMenuRequest | null>(null);
  const hideTimer = useRef<number | null>(null);

  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
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
    void Promise.all([unlistenTheme, unlistenShow, unlistenFocus, unlistenReadyRequest]).then(() => {
      void emit("context-menu-ready");
    });
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
    void win.show().then(() => win.setFocus()).catch(console.error);
  }, [request, win]);

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

  const groups = useMemo(() => (request ? MENUS[request.source] : []), [request]);

  const runAction = async (action: string) => {
    if (!request) return;
    await hideContextMenu();
    try {
      if (request.source === "pin") {
        if (request.pinId === undefined) return;
        await invoke("pin_context_menu_action", { id: request.pinId, action });
        return;
      }
      switch (action) {
        case "screenshot":
          await ensureScreenshotWindow();
          await invoke("start_screenshot");
          return;
        case "recording":
          await ensureScreenshotWindow();
          await invoke("start_recording_select");
          return;
        case "settings":
          await invoke("show_settings");
          return;
        case "hide-orb":
          await invoke("hide_orb");
          return;
        case "toggle-orb":
          await invoke("toggle_orb");
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
