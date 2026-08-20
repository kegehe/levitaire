import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_GIF_FPS,
  DEFAULT_VIDEO_FPS,
  DEFAULT_MAX_DURATION,
  DEFAULT_RECORDING_CONFIG,
  GIF_FPS_OPTIONS,
  VIDEO_FPS_OPTIONS,
  MAX_DURATION_OPTIONS,
  GIF_FPS_OPTION_ITEMS,
  VIDEO_FPS_OPTION_ITEMS,
  MAX_DURATION_OPTION_ITEMS,
  normalizeRecordingConfig,
  fetchRecordingConfig,
  saveRecordingConfig,
  type RecordingConfig,
} from "./recordingConfig";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("帧率/时长选项", () => {
  it("下拉选项与数值选项一一对应且带可读文案", () => {
    expect(GIF_FPS_OPTION_ITEMS.map((o) => o.value)).toEqual([...GIF_FPS_OPTIONS]);
    expect(VIDEO_FPS_OPTION_ITEMS.map((o) => o.value)).toEqual([...VIDEO_FPS_OPTIONS]);
    expect(MAX_DURATION_OPTION_ITEMS.map((o) => o.value)).toEqual([...MAX_DURATION_OPTIONS]);
    expect(GIF_FPS_OPTION_ITEMS[0].label).toBe("5 帧/秒");
    expect(VIDEO_FPS_OPTION_ITEMS[1].label).toBe("30 帧/秒");
    expect(MAX_DURATION_OPTION_ITEMS[2].label).toBe("60 秒");
  });
});

describe("normalizeRecordingConfig", () => {
  it("合法配置原样保留", () => {
    const cfg: RecordingConfig = {
      gifFps: 15,
      videoFps: 30,
      maxDurationSec: 60,
    };
    expect(normalizeRecordingConfig(cfg)).toEqual(cfg);
  });

  it("null / undefined / 非对象回退为默认", () => {
    expect(normalizeRecordingConfig(null)).toEqual(DEFAULT_RECORDING_CONFIG);
    expect(normalizeRecordingConfig(undefined)).toEqual(DEFAULT_RECORDING_CONFIG);
    expect(normalizeRecordingConfig("bad")).toEqual(DEFAULT_RECORDING_CONFIG);
  });

  it("空对象补齐默认值", () => {
    expect(normalizeRecordingConfig({})).toEqual(DEFAULT_RECORDING_CONFIG);
  });

  it("部分配置合并默认值", () => {
    const r = normalizeRecordingConfig({ gifFps: 5 });
    expect(r.gifFps).toBe(5);
    expect(r.videoFps).toBe(DEFAULT_VIDEO_FPS);
    expect(r.maxDurationSec).toBe(DEFAULT_MAX_DURATION);
  });

  it("不在档位内的值回退为默认", () => {
    expect(normalizeRecordingConfig({ gifFps: 7 }).gifFps).toBe(DEFAULT_GIF_FPS);
    expect(normalizeRecordingConfig({ videoFps: 60 }).videoFps).toBe(DEFAULT_VIDEO_FPS);
    expect(normalizeRecordingConfig({ maxDurationSec: 20 }).maxDurationSec).toBe(
      DEFAULT_MAX_DURATION,
    );
  });

  it("非数字字段回退为默认", () => {
    const r = normalizeRecordingConfig({
      gifFps: "fast",
      videoFps: null,
      maxDurationSec: true,
    } as unknown as Partial<RecordingConfig>);
    expect(r).toEqual(DEFAULT_RECORDING_CONFIG);
  });
});

describe("fetchRecordingConfig", () => {
  it("后端返回 JSON 字符串时正确解析并归一化", async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({ gifFps: 15, videoFps: 30, maxDurationSec: 60 }),
    );
    const result = await fetchRecordingConfig();
    expect(result).toEqual({ gifFps: 15, videoFps: 30, maxDurationSec: 60 });
    expect(mockInvoke).toHaveBeenCalledWith("get_recording_config");
  });

  it("后端返回脏数据时归一化（越界值 → 默认）", async () => {
    mockInvoke.mockResolvedValueOnce(JSON.stringify({ gifFps: 99 }));
    const result = await fetchRecordingConfig();
    expect(result.gifFps).toBe(DEFAULT_GIF_FPS);
  });

  it("后端返回空串时回退为默认", async () => {
    mockInvoke.mockResolvedValueOnce("");
    const result = await fetchRecordingConfig();
    expect(result).toEqual(DEFAULT_RECORDING_CONFIG);
  });

  it("invoke 抛错时回退为默认", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("config read failed"));
    const result = await fetchRecordingConfig();
    expect(result).toEqual(DEFAULT_RECORDING_CONFIG);
  });

  it("JSON 解析失败时回退为默认", async () => {
    mockInvoke.mockResolvedValueOnce("{invalid json");
    const result = await fetchRecordingConfig();
    expect(result).toEqual(DEFAULT_RECORDING_CONFIG);
  });
});

describe("saveRecordingConfig", () => {
  it("调用 set_recording_config 并以 JSON 字符串持久化", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const cfg: RecordingConfig = { ...DEFAULT_RECORDING_CONFIG, gifFps: 15 };
    await saveRecordingConfig(cfg);
    expect(mockInvoke).toHaveBeenCalledWith("set_recording_config", {
      config: JSON.stringify(cfg),
    });
  });
});
