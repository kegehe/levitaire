import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "../../components/Icon";
import {
  fetchPomodoroConfig,
  DEFAULT_POMODORO_CONFIG,
  POMODORO_STAGE_LABELS,
  POMODORO_STAGE_COLORS,
  type PomodoroConfig,
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
  const actionPending = useRef(false);

  const stage: PomodoroStage = state?.stage ?? "focus";
  const remaining = state?.remaining_secs ?? config.workMinutes * 60;
  const total = state?.total_secs ?? config.workMinutes * 60;
  const running = state?.running ?? false;
  const progress = total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 0;
  const roundsBeforeLongBreak = Math.max(1, config.roundsBeforeLongBreak);
  const done = state?.rounds_done ?? 0;
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
    const unlistenReadyRequest = listen("pomodoro-window-ready-request", () => {
      void emit("pomodoro-window-ready");
    });
    void emit("pomodoro-window-ready");
    return () => {
      unlistenReadyRequest.then((fn) => fn());
    };
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
        setConfig(stored);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 监听设置页配置变更事件，及时更新未开始阶段的倒计时长度。
  useEffect(() => {
    const unlisten = listen<PomodoroConfig>("levitaire-pomodoro-config-changed", (event) => {
      setConfig(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, []);

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

  const onTitleBarMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest(".pomo-icon-btn")) return;
      event.preventDefault();
      win.startDragging().catch((error) => {
        console.error("Failed to start dragging pomodoro window:", error);
      });
    },
    [win],
  );

  return (
    <div className="pomo-container">
      <div className="pomo-body">
        <div className="pomo-titlebar" onMouseDown={onTitleBarMouseDown}>
          <span className="pomo-title">番茄钟</span>
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

        <div
          className="pomo-rounds"
          aria-label={`本循环已完成 ${roundsInCycle}/${roundsBeforeLongBreak} 轮`}
        >
          {Array.from({ length: roundsBeforeLongBreak }, (_, i) => (
            <span key={i} className={`pomo-round-dot${i < roundsInCycle ? " is-done" : ""}`} />
          ))}
          <span className="pomo-rounds-text">
            {roundsInCycle}/{roundsBeforeLongBreak} 轮
          </span>
        </div>

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
      </div>
    </div>
  );
}

export default PomodoroTool;
