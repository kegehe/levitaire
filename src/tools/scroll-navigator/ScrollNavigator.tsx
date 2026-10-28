import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { invoke } from "@tauri-apps/api/core";
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

type ScrollAction = "top" | "bottom" | "page-up" | "page-down" | "line-up" | "line-down";

const EMPTY_STATE: ScrollNavigationState = {
  precise: false,
  percent: null,
  fallbackAvailable: false,
};

/**
 * 轮询间隔。后端每次探测都是一次带预算的跨进程 UIA 遍历（最坏 ~120ms，跑在阻塞线程上），
 * 2s 足够跟上用户在目标窗口里的滚动，又不会持续压后端。
 */
const POLL_INTERVAL_MS = 2000;

function ScrollNavigator() {
  const [state, setState] = useState<ScrollNavigationState>(EMPTY_STATE);
  const [draft, setDraft] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 轮询回调要读最新的忙碌状态，但不能因此重建定时器 → 用 ref 镜像。
  const busyRef = useRef(false);

  const markBusy = (value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  };

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

  /** 读一次后端真值。不带 busy 守卫 —— 供「动作失败后回读」复用。 */
  const fetchState = useCallback(async () => {
    applyState(await invoke<ScrollNavigationState>("get_scroll_navigation_state"));
  }, [applyState]);

  const refresh = useCallback(async () => {
    // 动作进行中不叠加探测请求
    if (busyRef.current) return;
    try {
      setError(null);
      await fetchState();
    } catch {
      setError("无法读取目标窗口");
    }
  }, [fetchState]);

  useEffect(() => {
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    const start = () => {
      if (timer === undefined) {
        timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
      }
    };
    // 通用工具面板关闭时只是原生窗口 hide()，React 树不卸载、定时器照旧跑 ——
    // 所以必须自己看 document.hidden 停下来，否则面板关了后端还在被持续探测。
    const onVisibility = () => {
      if (document.hidden) {
        stop();
        return;
      }
      void refresh();
      start();
    };
    if (!document.hidden) {
      void refresh();
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const setPercent = async (value: number) => {
    if (!state.precise || busy) return;
    const percent = Math.round(Math.max(0, Math.min(100, value)));
    setDraft(String(percent));
    markBusy(true);
    try {
      setError(null);
      applyState(await invoke<ScrollNavigationState>("set_scroll_navigation_percent", { percent }));
    } catch (cause) {
      setError(typeof cause === "string" ? cause : "无法精确定位滚动位置");
      // 失败后回读真值。这里不能走 refresh()：busy 还没解除，会被它的守卫挡掉。
      await fetchState().catch(() => {});
    } finally {
      markBusy(false);
    }
  };

  const navigate = async (action: ScrollAction) => {
    if (!state.fallbackAvailable || busy) return;
    markBusy(true);
    try {
      setError(null);
      applyState(await invoke<ScrollNavigationState>("navigate_scroll", { action }));
    } catch (cause) {
      setError(typeof cause === "string" ? cause : "无法控制目标窗口");
    } finally {
      markBusy(false);
    }
  };

  const recapture = async () => {
    if (busy) return;
    markBusy(true);
    try {
      setError(null);
      applyState(await invoke<ScrollNavigationState>("recapture_scroll_target"));
    } catch (cause) {
      setError(typeof cause === "string" ? cause : "无法重新选择目标窗口");
    } finally {
      markBusy(false);
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

  // 相对滚动（翻页 / 到顶到底 / 滚轮微调）只需要「存在目标窗口」。精确百分比是加分项，
  // 不是「能不能用」的开关 —— 实测浏览器 / Electron / 资源管理器根本拿不到 UIA 滚动器，
  // 旧版在这里整块 disabled，等于对它们彻底不可用（详见 docs/滚动导航问题分析.md）。
  const relativeReady = state.fallbackAvailable && !busy;

  return (
    <main className="scroll-nav" aria-label="滚动导航">
      <section className="scroll-nav-body">
        <div className="scroll-nav-endpoints" aria-label="快速滚动">
          <button
            type="button"
            onClick={() => void navigate("top")}
            disabled={!relativeReady}
            aria-label="到达顶部"
            data-tooltip="顶部"
          >
            <Icon name="ArrowUpToLine" size={16} />
          </button>
          <button
            type="button"
            onClick={() => void navigate("page-up")}
            disabled={!relativeReady}
            aria-label="向上翻页"
            data-tooltip="向上翻页"
          >
            <Icon name="ChevronsUp" size={16} />
          </button>
          <button
            type="button"
            onClick={() => void navigate("page-down")}
            disabled={!relativeReady}
            aria-label="向下翻页"
            data-tooltip="向下翻页"
          >
            <Icon name="ChevronsDown" size={16} />
          </button>
          <button
            type="button"
            onClick={() => void navigate("bottom")}
            disabled={!relativeReady}
            aria-label="到达底部"
            data-tooltip="底部"
          >
            <Icon name="ArrowDownToLine" size={16} />
          </button>
        </div>

        {state.precise ? (
          <div className="scroll-nav-position">
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
                  disabled={busy}
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
              disabled={busy}
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
                  disabled={busy}
                  className={
                    state.percent !== null && Math.round(state.percent) === percent
                      ? "is-active"
                      : ""
                  }
                  onClick={() => void setPercent(percent)}
                >
                  {percent}%
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div
            className={`scroll-nav-position scroll-nav-position--relative ${
              relativeReady ? "" : "is-disabled"
            }`}
          >
            <div className="scroll-nav-percent-row">
              <span className="scroll-nav-relative-label">相对滚动</span>
              <span className="scroll-nav-hint">
                {state.fallbackAvailable ? "无精确滚动条" : "先点一下目标窗口"}
              </span>
            </div>
            <div className="scroll-nav-steps">
              <button
                type="button"
                disabled={!relativeReady}
                onClick={() => void navigate("line-up")}
              >
                <Icon name="ArrowUp" size={13} />
                上滚 3 格
              </button>
              <button
                type="button"
                disabled={!relativeReady}
                onClick={() => void navigate("line-down")}
              >
                <Icon name="ArrowDown" size={13} />
                下滚 3 格
              </button>
            </div>
          </div>
        )}

        {(!state.fallbackAvailable || error) && (
          <div className="scroll-nav-recover">
            <p className="scroll-nav-error" role="status">
              {error ?? "尚未绑定目标窗口"}
            </p>
            <button type="button" disabled={busy} onClick={() => void recapture()}>
              重新选择目标
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

export default ScrollNavigator;
