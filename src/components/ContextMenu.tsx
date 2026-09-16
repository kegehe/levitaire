import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
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
  RefreshCw,
  ScanText,
  Wrench,
} from "lucide-react";
import { type ContextMenuRequest, type ContextMenuSource } from "./contextMenuTypes";
import { updateProgressPercent, type UpdateSnapshot } from "../hooks/useUpdater";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../styles/themePreferences";
import { ensurePinOcrWindow, hideContextMenu } from "../utils/toolWindows";
import { isShadowMarginClick } from "../utils/panelWindow";
import "./ContextMenu.css";

type Icon = typeof Download;

interface ContextMenuItem {
  id: string;
  label: string;
  icon: Icon;
  destructive?: boolean;
}

/**
 * 托盘菜单里「更新」那一项的瞬时态。
 *
 * 真正的更新状态由后端维护（检测 → 静默下载 → 已就绪），这里只放三类本地信息：
 * 本页发起的手动检查在途、手动检查/安装报错、安装器是否已接管。
 */
interface TrayUpdateFlags {
  checking: boolean;
  failed: boolean;
  installing: boolean;
  /** 手动检查确认过「已是最新」（仅影响文案，后端此刻是 idle） */
  upToDate: boolean;
}

/** 菜单里「进行中 / 不可点」的更新项 */
const INERT_UPDATE_ITEMS = new Set(["checking-update", "downloading-update", "installing-update"]);

/**
 * 托盘菜单里「更新」项的文案与图标。
 *
 * 只读后端快照 —— 菜单不再自己判断版本，避免与提示窗/设置页各说一套。
 *
 * ⚠️ **文案长度有硬预算**：窗口宽度是固定的 `CONTEXT_MENU_WIDTH`（184 逻辑 px），
 * `.context-menu-item` 又是 `white-space: nowrap`。逐层扣掉卡片内边距（6px）、
 * 条目内边距（10px）、图标（17px）与间距（10px）后，留给文字的只有约 **123px**
 * （13px 字号下约 9 个全角字），超出去的文字会溢出卡片边框、被窗口边界硬切。
 * 守卫：`ContextMenu.test.ts` 按「全角 13px / 半角 7px」估算每个分支的字宽。
 */
export function buildTrayUpdateItem(
  snapshot: UpdateSnapshot | null,
  flags: TrayUpdateFlags,
): ContextMenuItem {
  if (flags.installing) {
    return { id: "installing-update", label: "正在安装…", icon: Download };
  }
  if (flags.checking) {
    return { id: "checking-update", label: "正在检查更新...", icon: RefreshCw };
  }
  if (snapshot?.phase === "downloading") {
    const percent = updateProgressPercent(snapshot.received, snapshot.total);
    return {
      id: "downloading-update",
      label: percent != null ? `正在下载更新 ${percent}%` : "正在下载更新…",
      icon: Download,
    };
  }
  if (snapshot?.phase === "ready") {
    return { id: "install-update", label: `更新至 v${snapshot.version}`, icon: Download };
  }
  if (flags.failed) {
    return { id: "check-update", label: "更新失败，重试", icon: RefreshCw };
  }
  if (flags.upToDate) {
    return { id: "check-update", label: "检查更新（最新）", icon: RefreshCw };
  }
  return { id: "check-update", label: "检查更新", icon: RefreshCw };
}

/**
 * 各来源的菜单结构（分组 → 条目）。
 *
 * ⚠️ 改这里必须同步 `contextMenuTypes.ts` 的 `CONTEXT_MENU_SHAPE`（条目数/分组数），
 * 否则菜单窗口的高度会和内容对不上；`ContextMenu.test.ts` 会数这份结构来核对。
 */
export const CONTEXT_MENUS: Record<ContextMenuSource, ContextMenuItem[][]> = {
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
  // getCurrentWebviewWindow() 每次调用都返回新对象，必须 memo 化（它是多个 effect 的依赖）
  const win = useMemo(() => getCurrentWebviewWindow(), []);
  const [request, setRequest] = useState<ContextMenuRequest | null>(null);
  // 后端更新快照（检测 / 静默下载 / 已就绪都在后端维护，菜单只读）
  const [traySnapshot, setTraySnapshot] = useState<UpdateSnapshot | null>(null);
  // 本页发起的手动检查在途：菜单项显示「正在检查更新...」并禁用
  const [trayChecking, setTrayChecking] = useState(false);
  // 手动检查 / 安装的失败原因（后端快照的 error 只覆盖它自己的失败）
  const [trayError, setTrayError] = useState<string | null>(null);
  // 手动检查确认过「已是最新」—— 仅用于菜单文案，不改变后端状态
  const [trayUpToDate, setTrayUpToDate] = useState(false);
  // 安装中：菜单在安装期间保持可见并就地提示，避免「点完菜单消失、毫无反馈」。
  // 下载阶段不再需要（那是后台静默完成的），所以这里只剩「安装器已接管」这一种。
  const [trayInstalling, setTrayInstalling] = useState(false);
  // 供只注册一次的 onFocusChanged 读取最新安装状态（见下方失焦隐藏逻辑）
  const trayInstallingRef = useRef(false);
  const hideTimer = useRef<number | null>(null);
  const trayCheckGeneration = useRef(0);

  /**
   * 手动检查更新：走后端 `check_for_updates`（不再用 JS 插件的 `check()`）。
   * 后端发现新版本会**接着在后台静默下载**，所以这里返回后菜单项可能直接从
   * 「正在下载更新 x%」开始 —— 菜单只管显示后端快照。
   */
  const checkTrayUpdate = useCallback(async () => {
    const generation = ++trayCheckGeneration.current;
    setTrayChecking(true);
    setTrayError(null);
    // 上一次的「已是最新」结论在重新检查期间先撤下，避免停留在过期结论上
    setTrayUpToDate(false);
    try {
      const snapshot = await invoke<UpdateSnapshot>("check_for_updates");
      if (generation !== trayCheckGeneration.current) return;
      setTraySnapshot(snapshot);
      setTrayUpToDate(snapshot.phase === "idle");
    } catch (error) {
      if (generation !== trayCheckGeneration.current) return;
      console.error("tray update check failed:", error);
      setTrayError(typeof error === "string" ? error : String(error));
    } finally {
      // 仅当仍是当前请求时才收掉「正在检查」：若期间有更新的重试请求发起，
      // 该标记由后者接管，此处不得误清覆盖。
      if (generation === trayCheckGeneration.current) {
        setTrayChecking(false);
      }
    }
  }, []);

  // 状态订阅：菜单开着时也能看到下载百分比推进 / 变为「已就绪」。
  // 事件名与后端 `publish()` 的 emit 一致（全量快照，不再有单独的 progress 事件）。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen<UpdateSnapshot>("update-status", (event) => {
      setTraySnapshot(event.payload);
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    // 四周留出投影留白（见 utils/panelWindow.ts）：窗口尺寸由 showContextMenu
    // 算成「菜单 + 2×留白」，留白供 .context-menu 的投影展开，否则投影会被窗口
    // 边界硬切成四个角的直角残影。
    document.body.classList.add("context-menu-window");
    return () => {
      document.body.classList.remove("context-menu-window");
    };
  }, []);

  // 投影留白仍属于本窗口：点击它不会让窗口失焦，也就不会走上面的失焦隐藏。
  // 不处理的话，用户点在菜单边上（视觉上已经在菜单外）菜单却不关，与「点外面
  // 即关闭」的预期不一致；这里按同一语义补上。
  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (!isShadowMarginClick(event)) return;
      // 安装进行中同样不自动隐藏（理由见上面的失焦处理）
      if (trayInstallingRef.current) return;
      void hideContextMenu();
    };
    window.addEventListener("mousedown", onMouseDown, true);
    return () => window.removeEventListener("mousedown", onMouseDown, true);
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

  // 镜像安装状态到 ref：下面的 onFocusChanged 只注册一次（[] 依赖），
  // 闭包里读不到最新的 state，必须经 ref 传递。
  useEffect(() => {
    trayInstallingRef.current = trayInstalling;
  }, [trayInstalling]);

  useEffect(() => {
    const unlistenTheme = subscribeThemePreferences();
    const unlistenShow = listen<ContextMenuRequest>("context-menu-show", (event) => {
      setRequest(event.payload);
    });
    const unlistenFocus = win.onFocusChanged(({ payload: focused }) => {
      if (focused) return;
      // 安装进行中不自动隐藏：此刻菜单是「正在安装」的唯一提示面，
      // 被一次误点隐藏后用户会以为什么都没发生。安装失败会复位该标记，
      // 安装成功则由安装器接管并重启应用，窗口随之销毁。
      if (trayInstallingRef.current) return;
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
    // 每次重新打开托盘菜单都回到干净状态，避免上一轮的报错/文案残留。
    // 但安装进行中不得复位：否则安装途中重新右键会清掉安装态，菜单又变回可点的
    // 「更新至 vX」，从而允许并发重复触发 install_update。
    if (!trayInstallingRef.current) {
      setTrayInstalling(false);
    }
    setTrayError(null);
    // 注意**不**重置 trayUpToDate：它是「上次手动检查确认无新版本」的结论，
    // 跨几次右键保留更贴近旧行为（旧实现在 5 分钟 TTL 内也保留该文案）；
    // 后端一旦进入 downloading/ready，文案分支根本走不到它。重新检查时由
    // checkTrayUpdate 自己撤下。
    // 只读一次后端快照（纯本地、不联网）：监测与静默下载都由后端按自己的节奏跑，
    // 菜单每次右键都发一次网络请求既没必要，也会和「已忽略该版本」等策略互相打架。
    // 需要现场确认时用户点「检查更新」，那时才走 `check_for_updates`。
    void invoke<UpdateSnapshot>("get_update_status")
      .then(setTraySnapshot)
      .catch((error) => console.error("read update status failed:", error));
  }, [request]);

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
    if (request.source !== "tray") return CONTEXT_MENUS[request.source];

    const updateItem = buildTrayUpdateItem(traySnapshot, {
      checking: trayChecking,
      failed: trayError !== null || traySnapshot?.phase === "failed",
      installing: trayInstalling,
      upToDate: trayUpToDate,
    });
    return [CONTEXT_MENUS.tray[0], [updateItem], CONTEXT_MENUS.tray[1]];
  }, [request, traySnapshot, trayChecking, trayError, trayInstalling, trayUpToDate]);

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
      if (INERT_UPDATE_ITEMS.has(action)) return;
      if (action === "check-update") {
        await checkTrayUpdate();
        return;
      }
      // 安装更新：**不隐藏菜单**（其余动作都会隐藏），就地提示「正在安装」——
      // 安装包早已在后台静默下好，这里只等安装器接管，菜单随后随进程一起消失。
      if (action === "install-update") {
        // 已有安装在途时忽略重复触发（双保险：安装中菜单项本身已不可点）
        if (trayInstallingRef.current) return;
        setTrayInstalling(true);
        try {
          await invoke("install_update");
        } catch (error) {
          setTrayError(typeof error === "string" ? error : String(error));
          setTrayInstalling(false);
          throw error;
        }
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
                disabled={INERT_UPDATE_ITEMS.has(item.id)}
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
