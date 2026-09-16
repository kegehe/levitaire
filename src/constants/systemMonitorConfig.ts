import { invoke } from "@tauri-apps/api/core";

/** 系统监控显示模式（标准 / 迷你） */
export type SystemMonitorDisplayMode = "full" | "mini";

/**
 * 标准模式的**显示样式**（结构完全不同的四套布局）。
 *
 * 曾经只有一套结构（5 张等权重卡片竖排，常态 300×579、悬停还会再长 43px），
 * 这里把它换成四套可选结构 + 标题栏一键切换。没有 "a"：那是"结构不变、只修配色/语义"
 * 的选项，而它的内容（五色色板、折线满宽、阈值色、头部常驻）已经作为**公共修正**
 * 落进所有样式，不需要单独留一套。
 */
export type SystemMonitorLayout = "b" | "c" | "d" | "e";

/** 循环切换顺序（标题栏按钮按此顺序轮换） */
export const SYSTEM_MONITOR_LAYOUTS: readonly SystemMonitorLayout[] = ["b", "c", "d", "e"];

export interface SystemMonitorLayoutOption {
  value: SystemMonitorLayout;
  /** 中文样式名（标题栏与设置页共用同一份，勿另起名字） */
  label: string;
  /** 一句话说明（设置页提示用） */
  hint: string;
  /** 该样式的窗口逻辑宽度 —— 只有 C 是 340，其余 300 */
  width: number;
  /**
   * 内容量完之前的占位高度。
   * 窗口真实高度由前端量内容后下发（SystemMonitor 的高度自适应 effect），
   * 这里只用于「刚打开 / 刚切样式、还没收到第一帧 stats」时避免大幅跳变。
   *
   * 取该样式的**实测自然高度 + 约 12px**（磁盘多一块就多约 13px，留一格余量）：
   * 宁可略高（随后缩回十几像素），也不要偏矮（会截断并出滚动条）。
   * 实测口径：真机渲染（`monitor-preview.html`）× 2 块磁盘 + 有电池 + 有 GPU。
   */
  placeholderHeight: number;
}

/** 四套样式的唯一真源：宽度 / 名称 / 占位高度都从这里取，别在别处抄 */
export const MONITOR_LAYOUT_OPTIONS: ReadonlyArray<SystemMonitorLayoutOption> = [
  {
    value: "b",
    label: "紧凑行式",
    hint: "一行一个指标（标签 / 折线 / 值 / 次要文本同排），常驻屏幕角落最省地方",
    width: 300,
    placeholderHeight: 205,
  },
  {
    value: "c",
    label: "双列宫格",
    hint: "两列卡片，数值最大、一屏全览；窗口会宽 40px",
    width: 340,
    placeholderHeight: 350,
  },
  {
    value: "d",
    label: "焦点分层",
    hint: "CPU 占最大面积（大字号 + 大折线），其余指标降级为紧凑条目",
    width: 300,
    placeholderHeight: 350,
  },
  {
    value: "e",
    label: "共享趋势图",
    hint: "顶部一张全宽多线趋势图，下方五个指标统一成可扫读的电平表",
    width: 300,
    placeholderHeight: 305,
  },
];

/** 默认样式（用户第一次升级到多样式版本时落在这里） */
export const DEFAULT_SYSTEM_MONITOR_LAYOUT: SystemMonitorLayout = "e";

/** mini 模式的尺寸（mini 只有单行三指标，与 layout 无关） */
export const MONITOR_MINI_SIZE = { width: 300, placeholderHeight: 125 } as const;

/** 取某样式的元数据；未知值回退到默认样式（脏数据不抛错） */
export function monitorLayoutOption(layout: SystemMonitorLayout): SystemMonitorLayoutOption {
  return (
    MONITOR_LAYOUT_OPTIONS.find((option) => option.value === layout) ??
    MONITOR_LAYOUT_OPTIONS.find((option) => option.value === DEFAULT_SYSTEM_MONITOR_LAYOUT)!
  );
}

/** 按标题栏按钮的轮换顺序取下一个样式 */
export function nextSystemMonitorLayout(layout: SystemMonitorLayout): SystemMonitorLayout {
  const index = SYSTEM_MONITOR_LAYOUTS.indexOf(layout);
  return SYSTEM_MONITOR_LAYOUTS[(index + 1) % SYSTEM_MONITOR_LAYOUTS.length];
}

/** 系统监控配置（跨窗口持久化） */
export interface SystemMonitorConfig {
  /** 采集刷新间隔（毫秒），可选 1000/2000/5000 */
  intervalMs: number;
  displayMode: SystemMonitorDisplayMode;
  /** 标准模式的显示样式（mini 模式忽略它） */
  layout: SystemMonitorLayout;
}

/** 默认配置：1 秒刷新 · 标准模式 · 共享趋势图 */
export const DEFAULT_SYSTEM_MONITOR_CONFIG: SystemMonitorConfig = {
  intervalMs: 1000,
  displayMode: "full",
  layout: DEFAULT_SYSTEM_MONITOR_LAYOUT,
};

/** 可选的刷新间隔档位（毫秒） */
export const MONITOR_INTERVAL_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1000, label: "1 秒" },
  { value: 2000, label: "2 秒" },
  { value: 5000, label: "5 秒" },
];

/** 判定并归一化存储中的系统监控配置，脏数据回退到默认值 */
export function normalizeSystemMonitorConfig(raw: unknown): SystemMonitorConfig {
  if (typeof raw !== "object" || raw === null) {
    return { ...DEFAULT_SYSTEM_MONITOR_CONFIG };
  }
  const r = raw as Partial<SystemMonitorConfig>;
  const intervalMs =
    typeof r.intervalMs === "number" && r.intervalMs >= 200
      ? r.intervalMs
      : DEFAULT_SYSTEM_MONITOR_CONFIG.intervalMs;
  const displayMode: SystemMonitorDisplayMode =
    r.displayMode === "mini" || r.displayMode === "full"
      ? r.displayMode
      : DEFAULT_SYSTEM_MONITOR_CONFIG.displayMode;
  // 旧版本配置没有 layout 字段；未知值（含已下线的 "a"）一律回退到默认样式。
  const layout: SystemMonitorLayout = SYSTEM_MONITOR_LAYOUTS.includes(
    r.layout as SystemMonitorLayout,
  )
    ? (r.layout as SystemMonitorLayout)
    : DEFAULT_SYSTEM_MONITOR_LAYOUT;
  return { intervalMs, displayMode, layout };
}

/**
 * 从后端配置加载系统监控配置。
 * 配置跨窗口共享（持久化于 config.json），克服各 WebView localStorage 隔离问题。
 */
export async function fetchSystemMonitorConfig(): Promise<SystemMonitorConfig> {
  try {
    const stored = await invoke<string>("get_system_monitor_config");
    if (stored) {
      return normalizeSystemMonitorConfig(JSON.parse(stored));
    }
  } catch {
    // fallthrough
  }
  return { ...DEFAULT_SYSTEM_MONITOR_CONFIG };
}

/** 保存系统监控配置到后端（后端会即时下发新间隔到采集线程） */
export async function saveSystemMonitorConfig(config: SystemMonitorConfig): Promise<void> {
  await invoke("set_system_monitor_config", { config: JSON.stringify(config) });
}
