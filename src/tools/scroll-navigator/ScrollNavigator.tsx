import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { invoke } from "@tauri-apps/api/core";
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

/**
 * 面板隐藏期间的「可见性探测」间隔。
 *
 * 隐藏时不发探测请求，但仍要能尽快发现「面板又被打开了」，才能立刻补一次刷新；
 * 单次探测只是一次窗口属性 IPC，和它省掉的跨进程 UIA 遍历不是一个量级。
 */
const HIDDEN_PROBE_INTERVAL_MS = 250;

function ScrollNavigator() {
  const [state, setState] = useState<ScrollNavigationState>(EMPTY_STATE);
  const [draft, setDraft] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 轮询回调要读最新的忙碌状态，但不能因此重建定时器 → 用 ref 镜像。
  const busyRef = useRef(false);
  // 用户手动改过百分比（输入框键入 / 拖动滑杆）但还没提交时置位：后台轮询仍更新真实状态，
  // 但不能回写 draft —— 否则每 2s 一次的探测会把输入到一半的数字、拖到一半的滑杆弹回旧值。
  const draftDirtyRef = useRef(false);
  // getCurrentWebviewWindow() 每次调用都返回新对象，必须 memo 化：
  // 它是轮询 effect 的依赖，写在渲染体里会让定时器每次渲染都重建。
  const win = useMemo(() => getCurrentWebviewWindow(), []);

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

  /**
   * 应用后端返回的状态。
   *
   * `respectDraft` 为 true 时（后台轮询专用）：用户正手动设定百分比（draft 脏）、或动作正在
   * 提交时，只更新真实状态、不回写草稿。检查放在响应到达后，顺带挡住「请求在途时用户才开始
   * 输入 / 动作才开始」的竞态 —— 动作自身的 `applyState` 用默认值，不受此限制。
   */
  const applyState = useCallback((next: ScrollNavigationState, respectDraft = false) => {
    setState(next);
    if (respectDraft && (draftDirtyRef.current || busyRef.current)) return;
    draftDirtyRef.current = false;
    if (next.percent !== null) setDraft(String(Math.round(next.percent)));
  }, []);

  /** 读一次后端真值。不带 busy 守卫 —— 供「动作失败后回读」复用。 */
  const fetchState = useCallback(
    async (respectDraft = false) => {
      applyState(await invoke<ScrollNavigationState>("get_scroll_navigation_state"), respectDraft);
    },
    [applyState],
  );

  const refresh = useCallback(async () => {
    // 动作进行中不叠加探测请求
    if (busyRef.current) return;
    try {
      setError(null);
      // 用户正在调整百分比时不回写 draft，避免中途被后台读到的旧值覆盖。
      await fetchState(true);
    } catch {
      setError("无法读取目标窗口");
    }
  }, [fetchState]);

  // 面板关闭时只是原生窗口 hide()，React 树不卸载、定时器照旧跑 —— 必须自己停下来，
  // 否则面板关了后端还在被每 2s 一次、最坏 120ms 的跨进程 UIA 遍历持续压着。
  //
  // 判断依据**不能是 document.hidden**：实测 WebView2 156 上窗口 hide() 之后
  // visibilityState 仍是 "visible"、visibilitychange 也不触发（show → hide 全程实测），
  // 旧守卫因此从未生效。这里改成反问原生窗口：隐藏时只保留一次极便宜的可见性探测，
  // 一旦重新显示就立刻恢复轮询并补刷一次，避免用户看到隐藏前的旧数值。
  useEffect(() => {
    let pollTimer: number | undefined;
    let hiddenProbeTimer: number | undefined;
    let disposed = false;
    let inFlight = false;
    let probingHidden = false;

    const stopPoll = () => {
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };
    const startPoll = () => {
      if (pollTimer === undefined && !disposed) {
        pollTimer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
      }
    };
    const stopHiddenProbe = () => {
      if (hiddenProbeTimer !== undefined) {
        window.clearInterval(hiddenProbeTimer);
        hiddenProbeTimer = undefined;
      }
    };

    /** 隐藏期间只做可见性探测，绝不发探测请求。 */
    const enterHidden = () => {
      stopPoll();
      if (hiddenProbeTimer === undefined && !disposed) {
        hiddenProbeTimer = window.setInterval(() => void probeHidden(), HIDDEN_PROBE_INTERVAL_MS);
      }
    };

    /** 面板重新显示：恢复常规轮询并立刻刷一次。 */
    const resume = () => {
      stopHiddenProbe();
      startPoll();
      void poll();
    };

    const probeHidden = async () => {
      // 探测本身也可能慢（窗口正在销毁），不让多次探测叠加
      if (disposed || probingHidden) return;
      probingHidden = true;
      try {
        let visible = true;
        try {
          visible = await win.isVisible();
        } catch {
          // 读不到可见性就按可见处理：宁可多探一次，也不能让面板停在旧数据上
        }
        if (disposed) return;
        if (visible) resume();
      } finally {
        probingHidden = false;
      }
    };

    const poll = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        let visible = true;
        try {
          visible = await win.isVisible();
        } catch {
          visible = true;
        }
        if (disposed) return;
        if (!visible) {
          enterHidden();
          return;
        }
        await refresh();
      } finally {
        inFlight = false;
      }
    };

    void poll();
    startPoll();
    return () => {
      disposed = true;
      stopPoll();
      stopHiddenProbe();
    };
  }, [refresh, win]);

  const setPercent = async (value: number) => {
    if (!state.precise || busy) {
      // 提交被守卫挡掉时也要解除「草稿保护」，否则后台轮询再也无法把 draft 拉回真值。
      draftDirtyRef.current = false;
      return;
    }
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
    else {
      draftDirtyRef.current = false;
      setDraft(state.percent === null ? "" : String(Math.round(state.percent)));
    }
  };

  /** 用户开始手动设定百分比：暂停后台对 draft 的回写。 */
  const markDraftDirty = () => {
    draftDirtyRef.current = true;
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
                  onChange={(event) => {
                    markDraftDirty();
                    setDraft(event.target.value);
                  }}
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
              onChange={(event) => {
                markDraftDirty();
                setDraft(event.target.value);
              }}
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
