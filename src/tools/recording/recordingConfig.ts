import { invoke } from "@tauri-apps/api/core";

/** 录屏配置常量 */

/** GIF 帧率选项 */
export const GIF_FPS_OPTIONS = [5, 10, 15] as const;
/** 视频帧率选项 */
export const VIDEO_FPS_OPTIONS = [15, 30] as const;
/** GIF 最大时长选项（秒） */
export const MAX_DURATION_OPTIONS = [10, 30, 60] as const;

/** 默认 GIF 帧率 */
export const DEFAULT_GIF_FPS = 10;
/** 默认视频帧率 */
export const DEFAULT_VIDEO_FPS = 15;
/** 默认最大录制时长（秒） */
export const DEFAULT_MAX_DURATION = 30;

/** GIF 帧率下拉选项 */
export const GIF_FPS_OPTION_ITEMS: ReadonlyArray<{ value: number; label: string }> =
  GIF_FPS_OPTIONS.map((value) => ({ value, label: `${value} 帧/秒` }));
/** 视频帧率下拉选项 */
export const VIDEO_FPS_OPTION_ITEMS: ReadonlyArray<{ value: number; label: string }> =
  VIDEO_FPS_OPTIONS.map((value) => ({ value, label: `${value} 帧/秒` }));
/** 最大录制时长下拉选项 */
export const MAX_DURATION_OPTION_ITEMS: ReadonlyArray<{ value: number; label: string }> =
  MAX_DURATION_OPTIONS.map((value) => ({ value, label: `${value} 秒` }));

/** 录屏配置（跨窗口持久化于 config.json，字段名与后端 camelCase 一致） */
export interface RecordingConfig {
  /** GIF 帧率（帧/秒） */
  gifFps: number;
  /** 视频帧率（帧/秒） */
  videoFps: number;
  /** 最大录制时长（秒） */
  maxDurationSec: number;
}

/** 默认录屏配置 */
export const DEFAULT_RECORDING_CONFIG: RecordingConfig = {
  gifFps: DEFAULT_GIF_FPS,
  videoFps: DEFAULT_VIDEO_FPS,
  maxDurationSec: DEFAULT_MAX_DURATION,
};

/** 判定并归一化存储中的录屏配置，脏数据回退到默认值 */
export function normalizeRecordingConfig(raw: unknown): RecordingConfig {
  if (typeof raw !== "object" || raw === null) {
    return { ...DEFAULT_RECORDING_CONFIG };
  }
  const r = raw as Partial<RecordingConfig>;
  const pickOption = (v: unknown, options: readonly number[], fallback: number) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
    return (options as readonly number[]).includes(v) ? v : fallback;
  };
  return {
    gifFps: pickOption(r.gifFps, GIF_FPS_OPTIONS, DEFAULT_GIF_FPS),
    videoFps: pickOption(r.videoFps, VIDEO_FPS_OPTIONS, DEFAULT_VIDEO_FPS),
    maxDurationSec: pickOption(r.maxDurationSec, MAX_DURATION_OPTIONS, DEFAULT_MAX_DURATION),
  };
}

/**
 * 从后端配置加载录屏配置。
 * 配置跨窗口共享（持久化于 config.json），克服各 WebView localStorage 隔离问题。
 */
export async function fetchRecordingConfig(): Promise<RecordingConfig> {
  try {
    const stored = await invoke<string>("get_recording_config");
    if (stored) {
      return normalizeRecordingConfig(JSON.parse(stored));
    }
  } catch {
    // fallthrough
  }
  return { ...DEFAULT_RECORDING_CONFIG };
}

/** 保存录屏配置到后端（下次录制时生效） */
export async function saveRecordingConfig(config: RecordingConfig): Promise<void> {
  await invoke("set_recording_config", { config: JSON.stringify(config) });
}

/** 录制模式 */
export type RecordMode = "gif" | "video";

/** 区域选择模式 */
export type AreaMode = "fullscreen" | "region" | "window";

/** 录制状态 */
export type RecordingPhase =
  | "idle" // 未开始
  | "mode_select" // 选择 GIF/视频模式
  | "area_select" // 选择录制区域
  | "ready" // 区域已选，准备录制
  | "recording" // 录制中
  | "paused" // 暂停中
  | "encoding" // 编码中
  | "preview" // 预览输出
  | "error"; // 错误

/** 窗口信息（后端 WindowInfo 的前端映射） */
export interface WindowInfo {
  hwnd: number;
  title: string;
  className: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 录制区域 */
export interface RecordRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}
