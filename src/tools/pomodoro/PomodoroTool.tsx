import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "../../components/Icon";
import {
  fetchPomodoroConfig,
  savePomodoroConfig,
  DEFAULT_POMODORO_CONFIG,
  POMODORO_STAGE_LABELS,
  POMODORO_STAGE_COLORS,
  type PomodoroConfig,
  type PomodoroDisplayMode,
  type PomodoroStage,
} from "../../constants/pomodoroConfig";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../../styles/themePreferences";
import { persistWindowPositionOnMove } from "../../utils/windowPosition";
import "./PomodoroTool.css";

/** 后端 pomodoro-tick / pomodoro-complete 事件 payload（与 Rust PomodoroStatePayload 对应） */
interface PomodoroStatePayload {
  stage: PomodoroStage;
  remaining_secs: number;
  total_secs: number;
  running: boolean;
  rounds_done: number;
}

const POMODORO_WINDOW_SIZES: Record<PomodoroDisplayMode, { width: number; height: number }> = {
  full: { width: 240, height: 260 },
  mini: { width: 150, height: 182 },
};

const RING_RADIUS = 52;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function formatTime(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function PomodoroTool() {
  const win = useMemo(() => getCurrentWebviewWindow(), []);
  const [state, setState] = useState<PomodoroStatePayload | null>(null);
  const [config, setConfig] = useState<PomodoroConfig>(DEFAULT_POMODORO_CONFIG);
  const configRef = useRef<PomodoroConfig>(DEFAULT_POMODORO_CONFIG);
  const actionPending = useRef(false);

  const stage: PomodoroStage = state?.stage ?? "focus";
  const remaining = state?.remaining_secs ?? configRef.current.workMinutes * 60;
  const total = state?.total_secs ?? configRef.current.workMinutes * 60;
  const running = state?.running ?? false;
  const isMini = config.displayMode === "mini";
  const progress = total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 0;
  const roundsBeforeLongBreak = Math.max(1, config.roundsBeforeLongBreak);
  const done = state?.rounds_done ?? 0;
  // 取余计算本循环已完成轮数：恰满一轮（rounds_done 为阈值整数倍）时余数为 0，
  // 若正处于长休息，应显示满格 N/N；否则（含长休息结束回专注）按余数显示。
  const roundsInCycle =
    stage === "long_break" && done > 0 && done % roundsBeforeLongBreak === 0
      ? roundsBeforeLongBreak
      : done % roundsBeforeLongBreak;
  const ringColor = POMODORO_STAGE_COLORS[stage];

  // 独立 WebView 需要自行初始化主题和透明背景，避免首帧闪烁。
  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const root = document.getElementById("root");
    if (root) {
      root.style.background = "transparent";
      root.style.margin = "0";
      root.style.height = "100%";
    }
  }, []);

  // 通知后端窗口已就绪（toolWindows 等待此事件后 show）
  useEffect(() => {
    void emit("pomodoro-window-ready");
  }, []);

  // 设置窗口的 localStorage 不应作为运行中跨窗口同步机制。
  useEffect(() => {
    const unlistenTheme = subscribeThemePreferences();
    return () => {
      unlistenTheme.then((fn) => fn()).catch(console.error);
    };
  }, []);

  // 拉取初始状态与配置（窗口可能关闭过，状态以后端为准）
  useEffect(() => {
    let cancelled = false;
    invoke<PomodoroStatePayload>("get_pomodoro_state")
      .then((payload) => {
        if (!cancelled) setState(payload);
      })
      .catch(() => {});
    fetchPomodoroConfig().then((stored) => {
      if (!cancelled) {
        configRef.current = stored;
        setConfig(stored);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 监听设置页配置变更事件：刷新显示配置，displayMode 变更时同步窗口尺寸
  useEffect(() => {
    const unlisten = listen<PomodoroConfig>("levitaire-pomodoro-config-changed", (event) => {
      configRef.current = event.payload;
      setConfig(event.payload);
      const size = POMODORO_WINDOW_SIZES[event.payload.displayMode];
      win.setSize(new LogicalSize(size.width, size.height)).catch(console.error);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, [win]);

  // 订阅后端 tick / complete 事件刷新 UI
  useEffect(() => {
    let un: UnlistenFn[] | undefined;
    let cancelled = false;
    Promise.all([
      listen<PomodoroStatePayload>("pomodoro-tick", (e) => setState(e.payload)),
      listen<PomodoroStatePayload>("pomodoro-complete", (e) => setState(e.payload)),
    ]).then((fns) => {
      // 若组件在 listen resolve 前已卸载，立即取消刚拿到的监听器，避免泄漏
      if (cancelled) {
        fns.forEach((fn) => fn());
      } else {
        un = fns;
      }
    });
    return () => {
      cancelled = true;
      if (un) un.forEach((fn) => fn());
    };
  }, []);

  // Esc 关窗（仅隐藏，计时继续）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        invoke("hide_pomodoro_window").catch(console.error);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 记忆窗口位置：拖动结束后持久化，下次打开恢复上次位置
  useEffect(() => persistWindowPositionOnMove("pomodoro-overlay"), []);

  const toggleRunning = useCallback(async () => {
    if (actionPending.current) return;
    actionPending.current = true;
    try {
      await invoke(running ? "pause_pomodoro" : "start_pomodoro");
    } catch (error) {
      console.error("pomodoro toggle failed:", error);
    } finally {
      actionPending.current = false;
    }
  }, [running]);

  const doReset = useCallback(async () => {
    if (actionPending.current) return;
    actionPending.current = true;
    try {
      await invoke("reset_pomodoro");
    } catch (error) {
      console.error("pomodoro reset failed:", error);
    } finally {
      actionPending.current = false;
    }
  }, []);

  const doSkip = useCallback(async () => {
    if (actionPending.current) return;
    actionPending.current = true;
    try {
      await invoke("skip_pomodoro");
    } catch (error) {
      console.error("pomodoro skip failed:", error);
    } finally {
      actionPending.current = false;
    }
  }, []);

  const toggleDisplayMode = useCallback(async () => {
    const nextMode: PomodoroDisplayMode = isMini ? "full" : "mini";
    const nextConfig = { ...configRef.current, displayMode: nextMode };
    configRef.current = nextConfig;
    setConfig(nextConfig);
    try {
      await savePomodoroConfig(nextConfig);
    } catch (error) {
      console.error("Failed to save pomodoro config:", error);
    }
    const size = POMODORO_WINDOW_SIZES[nextMode];
    win.setSize(new LogicalSize(size.width, size.height)).catch(console.error);
  }, [isMini, win]);

  return (
    <div className="pomo-container">
      <div className={`pomo-body${isMini ? " is-mini" : ""}`} data-tauri-drag-region="">
        <div className="pomo-titlebar" data-tauri-drag-region="">
          <span className="pomo-title">番茄钟</span>
          <button
            className="pomo-icon-btn"
            aria-label={isMini ? "切换到标准模式" : "切换到迷你模式"}
            data-tooltip={isMini ? "切换到标准模式" : "切换到迷你模式"}
            onClick={toggleDisplayMode}
          >
            <Icon name={isMini ? "Maximize2" : "Minimize2"} size={14} />
          </button>
          <button
            className="pomo-icon-btn"
            aria-label="关闭番茄钟"
            data-tooltip="关闭番茄钟"
            onClick={() => invoke("hide_pomodoro_window").catch(console.error)}
          >
            <Icon name="X" size={14} />
          </button>
        </div>

        <div className="pomo-ring-wrap">
          <svg className="pomo-ring" viewBox="0 0 120 120" aria-hidden>
            <circle cx="60" cy="60" r={RING_RADIUS} className="pomo-ring-bg" />
            <circle
              cx="60"
              cy="60"
              r={RING_RADIUS}
              className="pomo-ring-fg"
              style={{
                stroke: ringColor,
                strokeDasharray: RING_CIRCUMFERENCE,
                strokeDashoffset: RING_CIRCUMFERENCE * (1 - progress),
              }}
            />
          </svg>
          <div className="pomo-ring-center">
            <div className="pomo-time">{formatTime(remaining)}</div>
            <div className="pomo-stage-label">{POMODORO_STAGE_LABELS[stage]}</div>
          </div>
        </div>

        {isMini ? (
          <div className="pomo-mini-controls">
            <button
              className="pomo-icon-btn pomo-mini-ctrl"
              aria-label="重置当前阶段"
              data-tooltip="重置当前阶段"
              onClick={doReset}
            >
              <Icon name="RotateCcw" size={13} />
            </button>
            <button
              className="pomo-icon-btn pomo-mini-ctrl pomo-mini-toggle"
              aria-label={running ? "暂停" : "开始"}
              data-tooltip={running ? "暂停" : "开始"}
              onClick={toggleRunning}
            >
              <Icon name={running ? "Pause" : "Play"} size={14} />
            </button>
            <button
              className="pomo-icon-btn pomo-mini-ctrl"
              aria-label="跳过当前阶段"
              data-tooltip="跳过当前阶段"
              onClick={doSkip}
            >
              <Icon name="SkipForward" size={13} />
            </button>
          </div>
        ) : (
          <>
            <div className="pomo-controls">
              <button className="pomo-btn pomo-btn-primary" onClick={toggleRunning}>
                <Icon name={running ? "Pause" : "Play"} size={16} />
                <span>{running ? "暂停" : "开始"}</span>
              </button>
              <button
                className="pomo-btn"
                aria-label="重置当前阶段"
                data-tooltip="重置当前阶段"
                onClick={doReset}
              >
                <Icon name="RotateCcw" size={15} />
              </button>
              <button
                className="pomo-btn"
                aria-label="跳过当前阶段"
                data-tooltip="跳过当前阶段"
                onClick={doSkip}
              >
                <Icon name="SkipForward" size={15} />
              </button>
            </div>
            <div className="pomo-rounds">
              {Array.from({ length: roundsBeforeLongBreak }, (_, i) => (
                <span key={i} className={`pomo-round-dot${i < roundsInCycle ? " is-done" : ""}`} />
              ))}
              <span className="pomo-rounds-text">
                {roundsInCycle}/{roundsBeforeLongBreak} 轮
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default PomodoroTool;
