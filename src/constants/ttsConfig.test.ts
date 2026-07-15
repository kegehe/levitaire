import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_TTS_CONFIG,
  normalizeTtsConfig,
  rateToSpeakingRate,
  fetchTtsConfig,
  saveTtsConfig,
  type TtsConfig,
} from "./ttsConfig";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("normalizeTtsConfig", () => {
  it("合法配置原样保留", () => {
    const cfg: TtsConfig = { rate: "fast", voiceId: "vid-1", volume: 0.5 };
    expect(normalizeTtsConfig(cfg)).toEqual(cfg);
  });

  it("null 回退为默认", () => {
    expect(normalizeTtsConfig(null)).toEqual(DEFAULT_TTS_CONFIG);
  });

  it("非对象（字符串）回退为默认", () => {
    expect(normalizeTtsConfig("not-an-object")).toEqual(DEFAULT_TTS_CONFIG);
  });

  it("rate 非法值回退为 normal", () => {
    const r = normalizeTtsConfig({ rate: "turbo", voiceId: "", volume: 1 });
    expect(r.rate).toBe("normal");
  });

  it("rate 缺失回退为 normal", () => {
    const r = normalizeTtsConfig({ voiceId: "", volume: 1 });
    expect(r.rate).toBe("normal");
  });

  it("voiceId 非字符串回退为空串", () => {
    const r = normalizeTtsConfig({ rate: "slow", voiceId: 123, volume: 1 });
    expect(r.voiceId).toBe("");
  });

  it("volume 越界（>1）回退为 1.0", () => {
    const r = normalizeTtsConfig({ rate: "normal", voiceId: "", volume: 1.5 });
    expect(r.volume).toBe(1.0);
  });

  it("volume 越界（<0）回退为 1.0", () => {
    const r = normalizeTtsConfig({ rate: "normal", voiceId: "", volume: -0.3 });
    expect(r.volume).toBe(1.0);
  });

  it("volume 为 NaN 回退为 1.0", () => {
    const r = normalizeTtsConfig({ rate: "normal", voiceId: "", volume: NaN });
    expect(r.volume).toBe(1.0);
  });

  it("volume 为非数字回退为 1.0", () => {
    const r = normalizeTtsConfig({ rate: "normal", voiceId: "", volume: "loud" });
    expect(r.volume).toBe(1.0);
  });

  it("边界 volume=0 与 volume=1 合法保留", () => {
    expect(normalizeTtsConfig({ rate: "slow", voiceId: "", volume: 0 }).volume).toBe(0);
    expect(normalizeTtsConfig({ rate: "slow", voiceId: "", volume: 1 }).volume).toBe(1);
  });
});

describe("rateToSpeakingRate", () => {
  it("slow → 0.7", () => {
    expect(rateToSpeakingRate("slow")).toBe(0.7);
  });

  it("normal → 1.0", () => {
    expect(rateToSpeakingRate("normal")).toBe(1.0);
  });

  it("fast → 1.5", () => {
    expect(rateToSpeakingRate("fast")).toBe(1.5);
  });
});

describe("fetchTtsConfig", () => {
  it("后端返回 JSON 字符串时正确解析并归一化", async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({ rate: "fast", voiceId: "v1", volume: 0.8 }),
    );
    const result = await fetchTtsConfig();
    expect(result).toEqual({ rate: "fast", voiceId: "v1", volume: 0.8 });
    expect(mockInvoke).toHaveBeenCalledWith("get_tts_config");
  });

  it("后端返回脏数据时归一化（rate 非法→normal）", async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({ rate: "turbo", voiceId: "v1", volume: 2 }),
    );
    const result = await fetchTtsConfig();
    expect(result).toEqual({ rate: "normal", voiceId: "v1", volume: 1.0 });
  });

  it("后端返回空串时回退为默认", async () => {
    mockInvoke.mockResolvedValueOnce("");
    const result = await fetchTtsConfig();
    expect(result).toEqual(DEFAULT_TTS_CONFIG);
  });

  it("invoke 抛错时回退为默认", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("config read failed"));
    const result = await fetchTtsConfig();
    expect(result).toEqual(DEFAULT_TTS_CONFIG);
  });

  it("JSON 解析失败时回退为默认", async () => {
    mockInvoke.mockResolvedValueOnce("{invalid json");
    const result = await fetchTtsConfig();
    expect(result).toEqual(DEFAULT_TTS_CONFIG);
  });
});

describe("saveTtsConfig", () => {
  it("调用 set_tts_config 并以 JSON 字符串持久化", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const cfg: TtsConfig = { rate: "slow", voiceId: "v2", volume: 0.6 };
    await saveTtsConfig(cfg);
    expect(mockInvoke).toHaveBeenCalledWith("set_tts_config", {
      config: JSON.stringify(cfg),
    });
  });
});
