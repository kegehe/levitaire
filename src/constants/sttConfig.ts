import { invoke } from "@tauri-apps/api/core";

/** 语音输入配置（跨窗口持久化） */
export interface SttConfig {
  /** 服务商标识（当前固定 "openai" 即 OpenAI 兼容接口，预留扩展） */
  provider: string;
  /** API Base URL，如 https://api.openai.com（可填兼容第三方） */
  baseUrl: string;
  /** 识别模型，如 whisper-1 */
  model: string;
  /** 识别后是否自动粘贴到当前焦点窗口 */
  autoPaste: boolean;
}

/** 默认配置：OpenAI 官方 + whisper-1 + 自动粘贴。
 * 注意：apiKey 不在此结构中，单独由 get/set_stt_api_key 加密存储 */
export const DEFAULT_STT_CONFIG: SttConfig = {
  provider: "openai",
  baseUrl: "https://api.openai.com",
  model: "whisper-1",
  autoPaste: true,
};

/** 判定并归一化存储中的语音输入配置，脏数据回退到默认值 */
export function normalizeSttConfig(raw: unknown): SttConfig {
  if (typeof raw !== "object" || raw === null) {
    return { ...DEFAULT_STT_CONFIG };
  }
  const r = raw as Partial<SttConfig>;
  const provider = typeof r.provider === "string" && r.provider ? r.provider : DEFAULT_STT_CONFIG.provider;
  const baseUrl = typeof r.baseUrl === "string" && r.baseUrl ? r.baseUrl : DEFAULT_STT_CONFIG.baseUrl;
  const model = typeof r.model === "string" && r.model ? r.model : DEFAULT_STT_CONFIG.model;
  const autoPaste = typeof r.autoPaste === "boolean" ? r.autoPaste : DEFAULT_STT_CONFIG.autoPaste;
  return { provider, baseUrl, model, autoPaste };
}

/**
 * 从后端配置加载语音输入配置。
 * 配置跨窗口共享（持久化于 config.json），克服各 WebView localStorage 隔离问题。
 */
export async function fetchSttConfig(): Promise<SttConfig> {
  try {
    const stored = await invoke<string>("get_stt_config");
    if (stored) {
      return normalizeSttConfig(JSON.parse(stored));
    }
  } catch {
    // fallthrough
  }
  return { ...DEFAULT_STT_CONFIG };
}

/** 保存语音输入配置到后端 */
export async function saveSttConfig(config: SttConfig): Promise<void> {
  await invoke("set_stt_config", { config: JSON.stringify(config) });
}

/** 获取 STT API Key（加密存储，此处返回明文供设置页回显） */
export async function fetchSttApiKey(): Promise<string> {
  try {
    return await invoke<string>("get_stt_api_key");
  } catch {
    return "";
  }
}

/** 保存 STT API Key（后端加密存储） */
export async function saveSttApiKey(apiKey: string): Promise<void> {
  await invoke("set_stt_api_key", { apiKey });
}
