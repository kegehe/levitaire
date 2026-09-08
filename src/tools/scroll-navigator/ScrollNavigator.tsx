import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "../../components/Icon";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../../styles/themePreferences";
import "./ScrollNavigator.css";

interface ScrollNavigationState {
  precise: boolean;
  percent: number | null;
  fallbackAvailable: boolean;
}

const EMPTY_STATE: ScrollNavigationState = {
  precise: false,
  percent: null,
  fallbackAvailable: false,
};

function ScrollNavigator({ embedded = false }: { embedded?: boolean }) {
  const [state, setState] = useState<ScrollNavigationState>(EMPTY_STATE);
  const [draft, setDraft] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
  }, []);

  useEffect(() => {
    const unlisten = subscribeThemePreferences();
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const applyState = useCallback((next: ScrollNavigationState) => {
    setState(next);
    if (next.percent !== null) setDraft(String(Math.round(next.percent)));
  }, []);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      applyState(await invoke<ScrollNavigationState>("get_scroll_navigation_state"));
    } catch {
      setError("无法读取目标窗口");
    }
  }, [applyState]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useLayoutEffect(() => {
    if (embedded) return;
    const nav = navRef.current;
    if (!nav) return;

    const resizeToContent = () => {
      const bounds = nav.getBoundingClientRect();
      const width = Math.ceil(bounds.width);
      const height = Math.ceil(bounds.height);
      if (!width || !height) return;
      getCurrentWebviewWindow()
        .setSize(new LogicalSize(width, height))
        .catch(() => {});
    };

    resizeToContent();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resizeToContent);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [embedded, error]);

  const setPercent = async (value: number) => {
    if (!state.precise || busy) return;
    const percent = Math.round(Math.max(0, Math.min(100, value)));
    setDraft(String(percent));
    setBusy(true);
    try {
      setError(null);
      applyState(await invoke<ScrollNavigationState>("set_scroll_navigation_percent", { percent }));
    } catch (cause) {
      setError(typeof cause === "string" ? cause : "无法精确定位滚动位置");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const navigate = async (action: "top" | "bottom" | "page-up" | "page-down") => {
    if (!state.fallbackAvailable || busy) return;
    setBusy(true);
    try {
      setError(null);
      applyState(await invoke<ScrollNavigationState>("navigate_scroll", { action }));
    } catch (cause) {
      setError(typeof cause === "string" ? cause : "无法控制目标窗口");
    } finally {
      setBusy(false);
    }
  };

  const commitDraft = () => {
    const value = Number(draft);
    if (Number.isFinite(value)) void setPercent(value);
    else setDraft(state.percent === null ? "" : String(Math.round(state.percent)));
  };

  const sliderValue = Number.isFinite(Number(draft))
    ? Math.max(0, Math.min(100, Number(draft)))
    : (state.percent ?? 0);

  return (
    <main ref={navRef} className="scroll-nav" aria-label="滚动导航">
      {!embedded && (
        <header className="scroll-nav-header" data-tauri-drag-region>
          <div className="scroll-nav-title" data-tauri-drag-region>
            <span className={`scroll-nav-status ${state.precise ? "is-precise" : ""}`} />
            <span>{state.precise ? "精准定位" : "快捷滚动"}</span>
          </div>
          <div className="scroll-nav-header-actions">
            <button
              className="scroll-nav-icon-button"
              type="button"
              onClick={() => void refresh()}
              aria-label="刷新"
              data-tooltip="刷新"
            >
              <Icon name="RefreshCw" size={14} />
            </button>
            <button
              className="scroll-nav-icon-button"
              type="button"
              onClick={() => void invoke("hide_scroll_navigation")}
              aria-label="关闭"
              data-tooltip="关闭"
            >
              <Icon name="X" size={15} />
            </button>
          </div>
        </header>
      )}

      <section className="scroll-nav-body">
        <div className="scroll-nav-endpoints" aria-label="快速滚动">
          <button
            type="button"
            onClick={() => void navigate("top")}
            disabled={!state.fallbackAvailable || busy}
            aria-label="到达顶部"
            data-tooltip="顶部"
          >
            <Icon name="ArrowUpToLine" size={16} />
          </button>
          <button
            type="button"
            onClick={() => void navigate("page-up")}
            disabled={!state.fallbackAvailable || busy}
            aria-label="向上翻页"
            data-tooltip="向上翻页"
          >
            <Icon name="ChevronsUp" size={16} />
          </button>
          <button
            type="button"
            onClick={() => void navigate("page-down")}
            disabled={!state.fallbackAvailable || busy}
            aria-label="向下翻页"
            data-tooltip="向下翻页"
          >
            <Icon name="ChevronsDown" size={16} />
          </button>
          <button
            type="button"
            onClick={() => void navigate("bottom")}
            disabled={!state.fallbackAvailable || busy}
            aria-label="到达底部"
            data-tooltip="底部"
          >
            <Icon name="ArrowDownToLine" size={16} />
          </button>
        </div>

        <div className={`scroll-nav-position ${state.precise ? "" : "is-disabled"}`}>
          <div className="scroll-nav-percent-row">
            <span className="scroll-nav-percent">
              {state.percent === null ? "--" : `${Math.round(state.percent)}%`}
            </span>
            <label>
              <input
                type="number"
                min="0"
                max="100"
                inputMode="numeric"
                value={draft}
                disabled={!state.precise || busy}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitDraft}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                aria-label="滚动百分比"
              />
              <span>%</span>
            </label>
          </div>
          <input
            className="scroll-nav-slider"
            type="range"
            min="0"
            max="100"
            value={sliderValue}
            disabled={!state.precise || busy}
            onChange={(event) => setDraft(event.target.value)}
            onPointerUp={(event) => void setPercent(Number(event.currentTarget.value))}
            style={{ "--scroll-progress": `${sliderValue}%` } as CSSProperties}
            onKeyUp={(event) => {
              if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
                void setPercent(Number(event.currentTarget.value));
              }
            }}
            aria-label="滚动位置"
          />
          <div className="scroll-nav-presets">
            {[0, 25, 50, 75, 100].map((percent) => (
              <button
                key={percent}
                type="button"
                disabled={!state.precise || busy}
                className={
                  state.percent !== null && Math.round(state.percent) === percent ? "is-active" : ""
                }
                onClick={() => void setPercent(percent)}
              >
                {percent}%
              </button>
            ))}
          </div>
        </div>
        {error && (
          <p className="scroll-nav-error" role="status">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}

export default ScrollNavigator;
