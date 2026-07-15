import { invoke } from "@tauri-apps/api/core";

/** 朗读语速档位 */
export type TtsRate = "slow" | "normal" | "fast";

/** 朗读配置（跨窗口持久化） */
export interface TtsConfig {
  /** 语速档位 */
  rate: TtsRate;
  /** 语音 id（空串表示系统默认语音） */
  voiceId: string;
  /** 音量 0.0~1.0 */
  volume: number;
}

/** 系统已安装语音信息（后端 tts_get_voices 返回） */
export interface VoiceInfo {
  id: string;
  display_name: string;
  language: string;
  gender: string;
}

/** 默认朗读配置：正常语速、系统默认语音、满音量 */
export const DEFAULT_TTS_CONFIG: TtsConfig = {
  rate: "normal",
  voiceId: "",
  volume: 1.0,
};

const RATE_SET: ReadonlySet<TtsRate> = new Set(["slow", "normal", "fast"]);

/** 判定并归一化存储中的朗读配置，脏数据回退到默认值 */
export function normalizeTtsConfig(raw: unknown): TtsConfig {
  if (typeof raw !== "object" || raw === null) {
    return { ...DEFAULT_TTS_CONFIG };
  }
  const r = raw as Partial<TtsConfig>;
  const rate =
    typeof r.rate === "string" && RATE_SET.has(r.rate as TtsRate)
      ? (r.rate as TtsRate)
      : DEFAULT_TTS_CONFIG.rate;
  const voiceId = typeof r.voiceId === "string" ? r.voiceId : "";
  let volume = typeof r.volume === "number" ? r.volume : DEFAULT_TTS_CONFIG.volume;
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
    volume = DEFAULT_TTS_CONFIG.volume;
  }
  return { rate, voiceId, volume };
}

/** 语速档位转 WinRT SpeakingRate（字/秒）。1.0 为各语言默认基准。 */
export function rateToSpeakingRate(rate: TtsRate): number {
  switch (rate) {
    case "slow":
      return 0.7;
    case "fast":
      return 1.5;
    default:
      return 1.0;
  }
}

/**
 * 从后端配置加载朗读配置。
 * 配置跨窗口共享（持久化于 config.json），克服各 WebView localStorage 隔离问题。
 */
export async function fetchTtsConfig(): Promise<TtsConfig> {
  try {
    const stored = await invoke<string>("get_tts_config");
    if (stored) {
      return normalizeTtsConfig(JSON.parse(stored));
    }
  } catch {
    // fallthrough
  }
  return { ...DEFAULT_TTS_CONFIG };
}

/** 保存朗读配置到后端 */
export async function saveTtsConfig(config: TtsConfig): Promise<void> {
  await invoke("set_tts_config", { config: JSON.stringify(config) });
}

/** 语速选项（供设置页下拉） */
export const TTS_RATE_OPTIONS: ReadonlyArray<{ value: TtsRate; label: string }> = [
  { value: "slow", label: "慢速" },
  { value: "normal", label: "正常" },
  { value: "fast", label: "快速" },
];

/** 音量选项（供设置页下拉） */
export const TTS_VOLUME_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0.2, label: "20%" },
  { value: 0.4, label: "40%" },
  { value: 0.6, label: "60%" },
  { value: 0.8, label: "80%" },
  { value: 1.0, label: "100%" },
];
