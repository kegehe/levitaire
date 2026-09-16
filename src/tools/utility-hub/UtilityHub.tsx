import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "../../components/Icon";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../../styles/themePreferences";
import ScrollNavigator from "../scroll-navigator/ScrollNavigator";
import WindowPinPanel from "./WindowPinPanel";
import { clampWindowToWorkArea, panelWindowSize } from "../../utils/panelWindow";
import "./UtilityHub.css";

type HubMode = "tools" | "color" | "scroll" | "pin";

const TOOLTIP_TOP_GUTTER_PX = 26;

const RECENT_COLORS_KEY = "levitaire-utility-recent-colors";
const HEX_PATTERN = /^#[0-9A-F]{6}$/;

/** 读取历史配色：过滤非法值、去重、最多 6 个；存储不可用或数据损坏时返回空数组 */
function readRecentColors(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) ?? "null");
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(
      (item): item is string => typeof item === "string" && HEX_PATTERN.test(item),
    );
    return [...new Set(valid)].slice(0, 6);
  } catch {
    return [];
  }
}

function writeRecentColors(colors: string[]): void {
  try {
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(colors));
  } catch {
    /* 存储不可用（隐私模式 / 配额耗尽）时降级为仅内存保存 */
  }
}

/** #RRGGBB → "rgb(r, g, b)"；非法输入返回 null */
function toRgbText(hex: string): string | null {
  const match = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(hex);
  if (!match) return null;
  return `rgb(${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)})`;
}

function UtilityHub() {
  const [mode, setMode] = useState<HubMode>("tools");
  const [color, setColor] = useState("#EAB308");
  const [draft, setDraft] = useState("#EAB308");
  const [recent, setRecent] = useState<string[]>(() => readRecentColors());
  const [message, setMessage] = useState<string | null>(null);
  const hubRef = useRef<HTMLElement>(null);
  const lastSizeRef = useRef("");

  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
    document.documentElement.style.background = "transparent";
    document.body.classList.add("utility-hub-window");
    // 投影留白（见 utils/panelWindow.ts 与 global.css 的 body.utility-hub-window）
    // 是一圈透明区域，但它仍属于本窗口：原生层不会把点击透给桌面，于是就变成一圈
    // 「吞点击」的死区。让留白与标题栏一样成为拖拽面——Tauri 的 drag region 只认
    // 命中元素自身，把属性挂在 body 上正好只覆盖留白，不会波及面板内部控件。
    document.body.setAttribute("data-tauri-drag-region", "");
    return () => {
      document.body.classList.remove("utility-hub-window");
      document.body.removeAttribute("data-tauri-drag-region");
    };
  }, []);

  useEffect(() => {
    const unlisten = subscribeThemePreferences();
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  // 历史配色落盘：应用重启后仍可复用（仅在 recent 变化时写入）
  useEffect(() => {
    writeRecentColors(recent);
  }, [recent]);

  useEffect(() => {
    const picked = listen<string>("utility-color-picked", async (event) => {
      const next = event.payload.toUpperCase();
      setColor(next);
      setDraft(next);
      setRecent((items) => [next, ...items.filter((item) => item !== next)].slice(0, 6));
      setMode("color");
      setMessage(null);
      await invoke("show_utility_hub").catch(() => {});
    });
    const failed = listen<string>("utility-color-pick-error", async (event) => {
      setMessage(event.payload || "无法读取屏幕颜色");
      await invoke("show_utility_hub").catch(() => {});
    });
    return () => {
      picked.then((unlisten) => unlisten());
      failed.then((unlisten) => unlisten());
    };
  }, []);

  useLayoutEffect(() => {
    const hub = hubRef.current;
    if (!hub) return;

    const resizeToContent = () => {
      const bounds = hub.getBoundingClientRect();
      const panelWidth = Math.ceil(bounds.width);
      // Keep the transparent top gutter inside the native window. CSS pseudo-elements
      // cannot escape the WebView bounds even when their DOM ancestors allow overflow.
      const panelHeight = Math.ceil(bounds.height);
      if (!panelWidth || !panelHeight) return;
      // 窗口 = 面板 + 投影留白。窗口尺寸若等于面板尺寸，投影没有任何展开空间，
      // 只在面板圆角的「缺口」里露出一小块并被窗口边界硬切成直角（四角各一块）。
      // 顶部 26px tooltip 安全区比留白宽，已覆盖顶部需求，故按 topGutter 传入。
      const { width, height } = panelWindowSize(panelWidth, panelHeight, TOOLTIP_TOP_GUTTER_PX);
      const size = `${width}:${height}`;
      if (size === lastSizeRef.current) return;
      lastSizeRef.current = size;
      getCurrentWebviewWindow()
        .setSize(new LogicalSize(width, height))
        .catch(() => {});
      clampWindowToWorkArea(width, height);
    };

    resizeToContent();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resizeToContent);
    observer.observe(hub);
    return () => observer.disconnect();
  }, [mode, message, recent.length]);

  const pickColor = useCallback(async () => {
    try {
      // 取色与窗口置顶点选都要接管系统光标，进一个之前必须先退出另一个，
      // 否则退出时恢复出来的是对方那只光标。
      await invoke("stop_window_pin_pick");
      setMode("color");
      setMessage(null);
      await invoke("start_utility_color_pick");
    } catch {
      setMessage("无法启动取色，请重试");
    }
  }, []);

  const setHex = (value: string) => {
    const next = value.trim().toUpperCase();
    setDraft(next);
    if (/^#[0-9A-F]{6}$/.test(next)) setColor(next);
  };
  const rgbText = toRgbText(color);
  const copyColor = async () => {
    await invoke("copy_text", { text: color });
    setMessage("已复制 HEX");
    window.setTimeout(() => setMessage(null), 1200);
  };
  const copyRgb = async () => {
    if (!rgbText) return;
    await invoke("copy_text", { text: rgbText });
    setMessage("已复制 RGB");
    window.setTimeout(() => setMessage(null), 1200);
  };

  return (
    <main ref={hubRef} className={`utility-hub utility-hub--${mode}`} aria-label="通用工具">
      <header className="utility-hub-header" data-tauri-drag-region="deep">
        {/* 拖拽手柄：固定 16px 宽，六个点用 mask 画。它只负责「看起来能拖」——
            实际拖拽由标题栏承担：必须写 "deep"，因为 Tauri 的裸属性只在「该元素自己
            就是命中元素」时生效（drag.js: `return el === composedPath[0]`），而中段留白
            的命中元素是 flex:1 的 .utility-hub-actions，裸属性不会向上传播。按钮不受
            影响：drag.js 遇到「可点击元素 + 无属性」会直接 return false。 */}
        <span className="utility-hub-grip" aria-hidden="true" />
        <div className="utility-hub-actions">
          <nav className="utility-hub-tools" aria-label="小工具">
            <button
              className={mode === "color" ? "is-active" : ""}
              type="button"
              aria-label="取色"
              aria-pressed={mode === "color"}
              data-tooltip="取色"
              title="取色"
              onClick={() => void pickColor()}
            >
              <Icon name="Pipette" size={16} />
            </button>
            <button
              className={mode === "scroll" ? "is-active" : ""}
              type="button"
              aria-label="滚动导航"
              aria-pressed={mode === "scroll"}
              data-tooltip="滚动导航"
              title="滚动导航"
              onClick={() => {
                void invoke("stop_utility_color_pick");
                void invoke("stop_window_pin_pick");
                setMode("scroll");
              }}
            >
              <Icon name="ChevronsDown" size={16} />
            </button>
            <button
              className={mode === "pin" ? "is-active" : ""}
              type="button"
              aria-label="窗口置顶"
              aria-pressed={mode === "pin"}
              data-tooltip="窗口置顶"
              title="窗口置顶"
              onClick={() => {
                void invoke("stop_utility_color_pick");
                setMode("pin");
              }}
            >
              <Icon name="AppWindow" size={16} />
            </button>
          </nav>
          <button
            className="utility-hub-close"
            type="button"
            aria-label="关闭"
            data-tooltip="关闭"
            title="关闭"
            onClick={() => void invoke("hide_utility_hub")}
          >
            <Icon name="X" size={14} />
          </button>
        </div>
      </header>
      {mode === "color" && (
        <section className="utility-color" aria-live="polite">
          <div className="utility-color-preview" style={{ backgroundColor: color }} />
          <label>
            <input
              value={draft}
              maxLength={7}
              aria-label="HEX 颜色值"
              onChange={(event) => setHex(event.target.value)}
              onBlur={() => setDraft(color)}
            />
          </label>
          <button
            type="button"
            onClick={() => void copyColor()}
            aria-label="复制 HEX"
            data-tooltip="复制 HEX"
            title="复制 HEX"
          >
            <Icon name="Copy" size={14} />
          </button>
          <input
            type="color"
            value={color}
            onChange={(event) => {
              const next = event.target.value.toUpperCase();
              setColor(next);
              setDraft(next);
            }}
            aria-label="调整颜色"
          />
          {rgbText && (
            <button
              className="utility-rgb"
              type="button"
              onClick={() => void copyRgb()}
              aria-label="复制 RGB 值"
              data-tooltip="复制 RGB"
              title="复制 RGB"
            >
              {rgbText}
            </button>
          )}
          {recent.length > 0 && (
            <div className="utility-recent">
              {recent.map((item) => (
                <button
                  key={item}
                  type="button"
                  style={{ backgroundColor: item }}
                  aria-label={`选择 ${item}`}
                  onClick={() => {
                    setColor(item);
                    setDraft(item);
                  }}
                />
              ))}
            </div>
          )}
        </section>
      )}
      {mode === "scroll" && <ScrollNavigator embedded />}
      {mode === "pin" && <WindowPinPanel />}
      {message && (
        <p className="utility-hub-message" role="status">
          {message}
        </p>
      )}
    </main>
  );
}

export default UtilityHub;
