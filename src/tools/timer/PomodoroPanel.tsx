import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
import { formatTime } from "./formatTime";
import { RING_CIRCUMFERENCE, RING_RADIUS, URGENT_SECONDS, ringHeadRotation } from "./ringGeometry";

/** 后端 pomodoro-tick / pomodoro-complete 事件 payload（与 Rust PomodoroStatePayload 对应） */
interface PomodoroStatePayload {
  stage: PomodoroStage;
  remaining_secs: number;
  total_secs: number;
  running: boolean;
  rounds_done: number;
  active_todo_id?: string | null;
}

/** get_todos 返回项中本组件关心的字段 */
interface FocusTodoItem {
  id: string;
  title: string;
  status: string;
}

/**
 * 番茄钟面板 —— 「时间工具」的番茄钟页签内容。
 *
 * 计时状态由后端 `PomodoroState` 持有（专注/休息自动循环、到点提醒都不依赖窗口可见），
 * 本组件只负责渲染与下发命令，因此切换页签、隐藏窗口都不会中断计时。
 */
function PomodoroPanel() {
  const win = useMemo(() => getCurrentWebviewWindow(), []);
  const [state, setState] = useState<PomodoroStatePayload | null>(null);
  const [config, setConfig] = useState<PomodoroConfig>(DEFAULT_POMODORO_CONFIG);
  const [focusTitle, setFocusTitle] = useState<string | null>(null);
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
  /** 强调态：本阶段只剩最后 URGENT_SECONDS 秒且计时中，环与数字统一切到警示色 */
  const urgent = running && remaining > 0 && remaining <= URGENT_SECONDS;
  /** 环描边色：平时按阶段取色，临近结束时转警示色（内联 stroke 无法被 CSS 覆盖，故在此判定） */
  const ringStroke = urgent ? "var(--color-danger)" : ringColor;

  // 拉取初始状态与配置（窗口可能关闭过，状态以后端为准）
  useEffect(() => {
    let cancelled = false;
    invoke<PomodoroStatePayload>("get_pomodoro_state")
      .then((payload) => {
        if (!cancelled) setState(payload);
      })
      .catch(() => {});
    fetchPomodoroConfig().then((stored) => {
      if (!cancelled) setConfig(stored);
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

  // 专注任务标题解析：active_todo_id 只是后端给的任务 id，标题需从待办存储查询。
  // 用 ref 保存当前关联 id，供异步返回与 todo-changed 事件回调读取最新值。
  const activeTodoIdRef = useRef<string | null>(null);
  activeTodoIdRef.current = state?.active_todo_id ?? null;

  const refreshFocusTitle = useCallback(async () => {
    const todoId = activeTodoIdRef.current;
    if (!todoId) {
      setFocusTitle(null);
      return;
    }
    try {
      const todos = await invoke<FocusTodoItem[]>("get_todos", { includeCompleted: true });
      // 查询期间任务可能已切换/解除关联，忽略过期结果避免旧标题覆盖新任务
      if (activeTodoIdRef.current !== todoId) return;
      const item = todos.find((todo) => todo.id === todoId);
      // 已完成/已删除的任务在列表中不可专注，后端也即将解除关联，故不展示标题；
      // 查询成功但找不到/已完成的场景在这里清空，失败场景见下方 catch。
      setFocusTitle(item && item.status !== "completed" ? item.title : null);
    } catch (error) {
      // 瞬时查询失败时保留上一次标题：active_todo_id 未变化不会触发重新解析，
      // 直接清空会导致面板在下次 todo-changed 前一直缺失任务名。
      console.error("resolve pomodoro todo title failed:", error);
    }
  }, []);

  // 关联任务变化（新开/切换专注任务、任务完成/删除后被解除关联）时重新解析标题
  useEffect(() => {
    void refreshFocusTitle();
  }, [refreshFocusTitle, state?.active_todo_id]);

  // 待办数据变化（改名/完成/删除）时刷新标题；完成/删除同时会触发 pomodoro-tick 解除关联
  useEffect(() => {
    const unlistenTodoChanged = listen("todo-changed", () => {
      void refreshFocusTitle();
    });
    return () => {
      unlistenTodoChanged.then((fn) => fn()).catch(console.error);
    };
  }, [refreshFocusTitle]);

  // 面板所在的窗口重新获焦（从待办「开始专注」打开、从托盘唤出）时兜底刷新，
  // 覆盖隐藏期间可能遗漏 todo-changed 导致标题停留在旧值的场景。
  useEffect(() => {
    const unlistenFocus = win.onFocusChanged(({ payload: focused }) => {
      if (focused) void refreshFocusTitle();
    });
    return () => {
      unlistenFocus.then((fn) => fn()).catch(console.error);
    };
  }, [win, refreshFocusTitle]);

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

  return (
    <main className={`timer-pomodoro-view${running ? " is-running" : ""}${urgent ? " is-urgent" : ""}`}>
      <span className="timer-eyebrow">番茄钟</span>
      {state?.active_todo_id && focusTitle && (
        // 只作展示，不发命令：用 span 而不是 button，避免面板里出现一个
        // 可聚焦却没有任何动作的控件。
        <span className="timer-pomodoro-focus" title={`正在专注：${focusTitle}`}>
          <Icon name="Flag" size={11} />
          <span className="timer-pomodoro-focus-text">{focusTitle}</span>
        </span>
      )}
      {/* key=阶段：换阶段时重挂进度环，让弧线重放一次「画入」动画，切换更明确 */}
      <div
        className="timer-ring-view"
        key={stage}
        style={{ "--ring-color": ringStroke, "--ring-from": String(RING_CIRCUMFERENCE) } as CSSProperties}
      >
        <svg viewBox="0 0 120 120" aria-hidden>
          <circle className="timer-ring-bg" cx="60" cy="60" r={RING_RADIUS} />
          {/* 与倒计时页签同一处理：进度为 0 时不画前景弧——`stroke-linecap: round`
              会把零长度弧渲染成 12 点方向的一个小圆点（在最后一秒暂停就会命中）。 */}
          {progress > 0 && (
            <circle
              className="timer-ring-fg"
              cx="60"
              cy="60"
              r={RING_RADIUS}
              style={{
                stroke: ringStroke,
                strokeDasharray: RING_CIRCUMFERENCE,
                strokeDashoffset: RING_CIRCUMFERENCE * (1 - progress),
              }}
            />
          )}
          {/* 环头珠子贴在弧尖上随剩余进度绕圈（旋转量见 ringHeadRotation），
              只在运行时出现（暂停即消失，兼作运行指示） */}
          {running && progress > 0 && (
            <g className="timer-ring-head" style={{ transform: `rotate(${ringHeadRotation(progress)}deg)` }}>
              <circle cx="60" cy="10" r="4.2" />
            </g>
          )}
        </svg>
        <div className="timer-ring-center">
          {/* key=剩余秒数：每秒重挂一次，重放数字跳动动画，让「减少」被看见 */}
          <span className="timer-ring-time" key={remaining}>{formatTime(remaining)}</span>
          <span className="timer-stage-label" key={stage}>{POMODORO_STAGE_LABELS[stage]}</span>
        </div>
      </div>
      <div
        className="timer-rounds"
        aria-label={`本循环已完成 ${roundsInCycle}/${roundsBeforeLongBreak} 轮`}
      >
        {Array.from({ length: roundsBeforeLongBreak }, (_, index) => (
          <span
            key={index}
            className={`timer-round-dot${index < roundsInCycle ? " is-done" : ""}`}
          />
        ))}
        <span className="timer-rounds-text">
          {roundsInCycle}/{roundsBeforeLongBreak} 轮
        </span>
      </div>
      <div className="timer-controls">
        <button className="timer-play" onClick={toggleRunning}>
          <Icon name={running ? "Pause" : "Play"} size={16} />
          {running ? "暂停" : "开始"}
        </button>
        <button aria-label="重置当前阶段" data-tooltip="重置" onClick={doReset}>
          <Icon name="RotateCcw" size={15} />
        </button>
        <button aria-label="跳过当前阶段" data-tooltip="跳过" onClick={doSkip}>
          <Icon name="SkipForward" size={15} />
        </button>
      </div>
    </main>
  );
}

export default PomodoroPanel;
