import { invoke } from "@tauri-apps/api/core";

/** 系统监控配置（跨窗口持久化） */
export interface SystemMonitorConfig {
  /** 采集刷新间隔（毫秒），可选 1000/2000/5000 */
  intervalMs: number;
  displayMode: SystemMonitorDisplayMode;
}

export type SystemMonitorDisplayMode = "full" | "mini";

/** 默认配置：1 秒刷新 */
export const DEFAULT_SYSTEM_MONITOR_CONFIG: SystemMonitorConfig = {
  intervalMs: 1000,
  displayMode: "full",
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
  return { intervalMs, displayMode };
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
