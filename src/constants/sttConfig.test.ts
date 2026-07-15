import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_STT_CONFIG,
  normalizeSttConfig,
  fetchSttConfig,
  saveSttConfig,
  fetchSttApiKey,
  saveSttApiKey,
  type SttConfig,
} from "./sttConfig";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("normalizeSttConfig", () => {
  it("合法配置原样保留", () => {
    const cfg: SttConfig = {
      provider: "openai",
      baseUrl: "https://api.groq.com/openai",
      model: "whisper-large-v3",
      autoPaste: false,
    };
    expect(normalizeSttConfig(cfg)).toEqual(cfg);
  });

  it("null 回退为默认", () => {
    expect(normalizeSttConfig(null)).toEqual(DEFAULT_STT_CONFIG);
  });

  it("非对象（字符串）回退为默认", () => {
    expect(normalizeSttConfig("not-an-object")).toEqual(DEFAULT_STT_CONFIG);
  });

  it("baseUrl 空串回退为默认", () => {
    const r = normalizeSttConfig({ provider: "openai", baseUrl: "", model: "whisper-1", autoPaste: true });
    expect(r.baseUrl).toBe(DEFAULT_STT_CONFIG.baseUrl);
  });

  it("model 空串回退为默认", () => {
    const r = normalizeSttConfig({ provider: "openai", baseUrl: "https://x", model: "", autoPaste: true });
    expect(r.model).toBe(DEFAULT_STT_CONFIG.model);
  });

  it("provider 空串回退为默认", () => {
    const r = normalizeSttConfig({ provider: "", baseUrl: "https://x", model: "m", autoPaste: true });
    expect(r.provider).toBe(DEFAULT_STT_CONFIG.provider);
  });

  it("autoPaste 非布尔回退为 true", () => {
    const r = normalizeSttConfig({ provider: "openai", baseUrl: "https://x", model: "m", autoPaste: "yes" });
    expect(r.autoPaste).toBe(true);
  });

  it("autoPaste 缺失回退为 true", () => {
    const r = normalizeSttConfig({ provider: "openai", baseUrl: "https://x", model: "m" });
    expect(r.autoPaste).toBe(true);
  });
});

describe("fetchSttConfig", () => {
  it("后端返回 JSON 字符串时正确解析并归一化", async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({ provider: "openai", baseUrl: "https://api.groq.com", model: "whisper-large-v3", autoPaste: false }),
    );
    const result = await fetchSttConfig();
    expect(result).toEqual({ provider: "openai", baseUrl: "https://api.groq.com", model: "whisper-large-v3", autoPaste: false });
    expect(mockInvoke).toHaveBeenCalledWith("get_stt_config");
  });

  it("后端返回脏数据时归一化（baseUrl 空串→默认）", async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({ provider: "", baseUrl: "", model: "", autoPaste: "x" }),
    );
    const result = await fetchSttConfig();
    expect(result).toEqual(DEFAULT_STT_CONFIG);
  });

  it("后端返回空串时回退为默认", async () => {
    mockInvoke.mockResolvedValueOnce("");
    const result = await fetchSttConfig();
    expect(result).toEqual(DEFAULT_STT_CONFIG);
  });

  it("invoke 抛错时回退为默认", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("config read failed"));
    const result = await fetchSttConfig();
    expect(result).toEqual(DEFAULT_STT_CONFIG);
  });

  it("JSON 解析失败时回退为默认", async () => {
    mockInvoke.mockResolvedValueOnce("{invalid json");
    const result = await fetchSttConfig();
    expect(result).toEqual(DEFAULT_STT_CONFIG);
  });
});

describe("saveSttConfig", () => {
  it("调用 set_stt_config 并以 JSON 字符串持久化", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const cfg: SttConfig = { provider: "openai", baseUrl: "https://x", model: "m", autoPaste: false };
    await saveSttConfig(cfg);
    expect(mockInvoke).toHaveBeenCalledWith("set_stt_config", {
      config: JSON.stringify(cfg),
    });
  });
});

describe("fetchSttApiKey", () => {
  it("返回后端明文 key", async () => {
    mockInvoke.mockResolvedValueOnce("sk-stt-123");
    const result = await fetchSttApiKey();
    expect(result).toBe("sk-stt-123");
    expect(mockInvoke).toHaveBeenCalledWith("get_stt_api_key");
  });

  it("invoke 抛错时回退空串", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("fail"));
    const result = await fetchSttApiKey();
    expect(result).toBe("");
  });
});

describe("saveSttApiKey", () => {
  it("调用 set_stt_api_key 持久化", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveSttApiKey("sk-stt-456");
    expect(mockInvoke).toHaveBeenCalledWith("set_stt_api_key", { apiKey: "sk-stt-456" });
  });
});
