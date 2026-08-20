import { invoke } from "@tauri-apps/api/core";

/** 番茄钟阶段（与后端 PomodoroStage snake_case 序列化一致） */
export type PomodoroStage = "focus" | "short_break" | "long_break";

/** 番茄钟悬浮窗显示模式 */
export type PomodoroDisplayMode = "full" | "mini";

/** 到点提醒方式 */
export type PomodoroNotifySound = "voice" | "tone" | "none";

/** 番茄钟配置（跨窗口持久化于 config.json，字段名与后端 camelCase 一致） */
export interface PomodoroConfig {
  /** 专注时长（分钟） */
  workMinutes: number;
  /** 短休息时长（分钟） */
  shortBreakMinutes: number;
  /** 长休息时长（分钟） */
  longBreakMinutes: number;
  /** 每完成多少个专注进入一次长休息 */
  roundsBeforeLongBreak: number;
  /** 到点后是否自动开始下一阶段 */
  autoStartNext: boolean;
  /** 到点提醒方式（voice=语音播报 / tone=纯提示音 / none=静音） */
  notifySoundType: PomodoroNotifySound;
  /** 到点是否播放提示音（兼容旧配置：notifySoundType 缺失时回退） */
  notifySound: boolean;
  displayMode: PomodoroDisplayMode;
}

/** 默认配置：25 分钟专注 + 5 分钟短休息 + 15 分钟长休息，每 4 轮长休息 */
export const DEFAULT_POMODORO_CONFIG: PomodoroConfig = {
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  roundsBeforeLongBreak: 4,
  autoStartNext: false,
  notifySoundType: "voice",
  notifySound: true,
  displayMode: "full",
};

/** 可选的到点提醒方式档位 */
export const POMODORO_NOTIFY_SOUND_OPTIONS: ReadonlyArray<{
  value: PomodoroNotifySound;
  label: string;
}> = [
  { value: "voice", label: "语音播报" },
  { value: "tone", label: "纯提示音" },
  { value: "none", label: "无" },
];

/** 可选的专注时长档位（分钟） */
export const POMODORO_WORK_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 15, label: "15 分钟" },
  { value: 25, label: "25 分钟" },
  { value: 45, label: "45 分钟" },
  { value: 60, label: "60 分钟" },
];

/** 可选的短休息时长档位（分钟） */
export const POMODORO_SHORT_BREAK_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 3, label: "3 分钟" },
  { value: 5, label: "5 分钟" },
  { value: 10, label: "10 分钟" },
];

/** 可选的长休息时长档位（分钟） */
export const POMODORO_LONG_BREAK_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 10, label: "10 分钟" },
  { value: 15, label: "15 分钟" },
  { value: 20, label: "20 分钟" },
  { value: 30, label: "30 分钟" },
];

/** 可选的长休息间隔轮数 */
export const POMODORO_ROUNDS_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 2, label: "每 2 轮" },
  { value: 4, label: "每 4 轮" },
  { value: 6, label: "每 6 轮" },
];

/** 阶段显示名 */
export const POMODORO_STAGE_LABELS: Record<PomodoroStage, string> = {
  focus: "专注",
  short_break: "短休息",
  long_break: "长休息",
};

/** 阶段对应颜色 token（进度环） */
export const POMODORO_STAGE_COLORS: Record<PomodoroStage, string> = {
  focus: "var(--color-accent)",
  short_break: "var(--color-success)",
  long_break: "var(--color-chart-cpu)",
};

/** 归一化存储中的番茄钟配置，脏数据回退到默认值 */
export function normalizePomodoroConfig(raw: unknown): PomodoroConfig {
  if (typeof raw !== "object" || raw === null) {
    return { ...DEFAULT_POMODORO_CONFIG };
  }
  const r = raw as Partial<PomodoroConfig>;
  const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, Math.round(v)));
  };
  // 提醒方式：优先新字段；旧配置仅含 notifySound 布尔时回退推断
  const rawType = r.notifySoundType;
  const notifySoundType: PomodoroNotifySound =
    rawType === "voice" || rawType === "tone" || rawType === "none"
      ? rawType
      : r.notifySound === false
        ? "none"
        : "voice";
  return {
    workMinutes: clampInt(r.workMinutes, 1, 120, DEFAULT_POMODORO_CONFIG.workMinutes),
    shortBreakMinutes: clampInt(
      r.shortBreakMinutes,
      1,
      60,
      DEFAULT_POMODORO_CONFIG.shortBreakMinutes,
    ),
    longBreakMinutes: clampInt(
      r.longBreakMinutes,
      1,
      120,
      DEFAULT_POMODORO_CONFIG.longBreakMinutes,
    ),
    roundsBeforeLongBreak: clampInt(
      r.roundsBeforeLongBreak,
      1,
      12,
      DEFAULT_POMODORO_CONFIG.roundsBeforeLongBreak,
    ),
    autoStartNext:
      typeof r.autoStartNext === "boolean"
        ? r.autoStartNext
        : DEFAULT_POMODORO_CONFIG.autoStartNext,
    notifySoundType,
    notifySound: notifySoundType !== "none",
    displayMode: r.displayMode === "mini" ? "mini" : "full",
  };
}

/**
 * 从后端配置加载番茄钟配置。
 * 配置跨窗口共享（持久化于 config.json），克服各 WebView localStorage 隔离问题。
 */
export async function fetchPomodoroConfig(): Promise<PomodoroConfig> {
  try {
    const stored = await invoke<string>("get_pomodoro_config");
    if (stored) {
      return normalizePomodoroConfig(JSON.parse(stored));
    }
  } catch {
    // fallthrough
  }
  return { ...DEFAULT_POMODORO_CONFIG };
}

/** 保存番茄钟配置到后端（后端会即时同步到计时状态，不中断计时） */
export async function savePomodoroConfig(config: PomodoroConfig): Promise<void> {
  await invoke("set_pomodoro_config", { config: JSON.stringify(config) });
}
