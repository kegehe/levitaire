import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_POMODORO_CONFIG,
  normalizePomodoroConfig,
  fetchPomodoroConfig,
  savePomodoroConfig,
  POMODORO_STAGE_LABELS,
  POMODORO_STAGE_COLORS,
  type PomodoroConfig,
} from "./pomodoroConfig";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("normalizePomodoroConfig", () => {
  it("合法配置原样保留", () => {
    const cfg: PomodoroConfig = {
      workMinutes: 45,
      shortBreakMinutes: 10,
      longBreakMinutes: 20,
      roundsBeforeLongBreak: 6,
      autoStartNext: true,
      notifySoundType: "tone",
      notifySound: true,
      displayMode: "mini",
    };
    expect(normalizePomodoroConfig(cfg)).toEqual(cfg);
  });

  it("null 回退为默认", () => {
    expect(normalizePomodoroConfig(null)).toEqual(DEFAULT_POMODORO_CONFIG);
  });

  it("undefined 回退为默认", () => {
    expect(normalizePomodoroConfig(undefined)).toEqual(DEFAULT_POMODORO_CONFIG);
  });

  it("非对象（字符串）回退为默认", () => {
    expect(normalizePomodoroConfig("bad")).toEqual(DEFAULT_POMODORO_CONFIG);
  });

  it("空对象补齐默认值", () => {
    expect(normalizePomodoroConfig({})).toEqual(DEFAULT_POMODORO_CONFIG);
  });

  it("部分配置合并默认值", () => {
    const r = normalizePomodoroConfig({ workMinutes: 45 });
    expect(r.workMinutes).toBe(45);
    expect(r.shortBreakMinutes).toBe(DEFAULT_POMODORO_CONFIG.shortBreakMinutes);
    expect(r.displayMode).toBe("full");
  });

  it("时长越界被钳制", () => {
    expect(normalizePomodoroConfig({ workMinutes: 999 }).workMinutes).toBe(120);
    expect(normalizePomodoroConfig({ workMinutes: 0 }).workMinutes).toBe(1);
    expect(normalizePomodoroConfig({ roundsBeforeLongBreak: 99 }).roundsBeforeLongBreak).toBe(12);
    expect(normalizePomodoroConfig({ roundsBeforeLongBreak: 0 }).roundsBeforeLongBreak).toBe(1);
  });

  it("非数字时长回退为默认", () => {
    const r = normalizePomodoroConfig({
      workMinutes: "fast",
    } as unknown as Partial<PomodoroConfig>);
    expect(r.workMinutes).toBe(DEFAULT_POMODORO_CONFIG.workMinutes);
  });

  it("布尔字段非法时回退为默认", () => {
    const r = normalizePomodoroConfig({ autoStartNext: 1 } as unknown as Partial<PomodoroConfig>);
    expect(r.autoStartNext).toBe(DEFAULT_POMODORO_CONFIG.autoStartNext);
  });

  it("displayMode 仅接受 full/mini", () => {
    expect(normalizePomodoroConfig({ displayMode: "mini" }).displayMode).toBe("mini");
    expect(normalizePomodoroConfig({ displayMode: "other" }).displayMode).toBe("full");
  });

  it("旧配置仅 notifySound=false 时回退为静音", () => {
    const r = normalizePomodoroConfig({ notifySound: false });
    expect(r.notifySoundType).toBe("none");
    expect(r.notifySound).toBe(false);
  });

  it("旧配置仅 notifySound=true 时回退为语音播报", () => {
    const r = normalizePomodoroConfig({ notifySound: true });
    expect(r.notifySoundType).toBe("voice");
    expect(r.notifySound).toBe(true);
  });

  it("notifySoundType 仅接受 voice/tone/none", () => {
    expect(normalizePomodoroConfig({ notifySoundType: "tone" }).notifySoundType).toBe("tone");
    expect(normalizePomodoroConfig({ notifySoundType: "none" }).notifySoundType).toBe("none");
    expect(
      normalizePomodoroConfig({ notifySoundType: "other" } as unknown as Partial<PomodoroConfig>)
        .notifySoundType,
    ).toBe("voice");
  });

  it("notifySound 随 notifySoundType 同步", () => {
    expect(normalizePomodoroConfig({ notifySoundType: "tone" }).notifySound).toBe(true);
    expect(normalizePomodoroConfig({ notifySoundType: "none" }).notifySound).toBe(false);
  });
});

describe("POMODORO_STAGE_LABELS / COLORS", () => {
  it("覆盖全部三个阶段", () => {
    expect(POMODORO_STAGE_LABELS.focus).toBeTruthy();
    expect(POMODORO_STAGE_LABELS.short_break).toBeTruthy();
    expect(POMODORO_STAGE_LABELS.long_break).toBeTruthy();
    expect(POMODORO_STAGE_COLORS.focus).toBeTruthy();
    expect(POMODORO_STAGE_COLORS.short_break).toBeTruthy();
    expect(POMODORO_STAGE_COLORS.long_break).toBeTruthy();
  });
});

describe("fetchPomodoroConfig", () => {
  it("后端返回 JSON 字符串时正确解析并归一化", async () => {
    mockInvoke.mockResolvedValueOnce(JSON.stringify({ workMinutes: 45, displayMode: "mini" }));
    const result = await fetchPomodoroConfig();
    expect(result.workMinutes).toBe(45);
    expect(result.displayMode).toBe("mini");
    expect(mockInvoke).toHaveBeenCalledWith("get_pomodoro_config");
  });

  it("后端返回脏数据时归一化（workMinutes 越界 → 钳制）", async () => {
    mockInvoke.mockResolvedValueOnce(JSON.stringify({ workMinutes: 999 }));
    const result = await fetchPomodoroConfig();
    expect(result.workMinutes).toBe(120);
  });

  it("后端返回空串时回退为默认", async () => {
    mockInvoke.mockResolvedValueOnce("");
    const result = await fetchPomodoroConfig();
    expect(result).toEqual(DEFAULT_POMODORO_CONFIG);
  });

  it("invoke 抛错时回退为默认", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("config read failed"));
    const result = await fetchPomodoroConfig();
    expect(result).toEqual(DEFAULT_POMODORO_CONFIG);
  });

  it("JSON 解析失败时回退为默认", async () => {
    mockInvoke.mockResolvedValueOnce("{invalid json");
    const result = await fetchPomodoroConfig();
    expect(result).toEqual(DEFAULT_POMODORO_CONFIG);
  });
});

describe("savePomodoroConfig", () => {
  it("调用 set_pomodoro_config 并以 JSON 字符串持久化", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const cfg: PomodoroConfig = { ...DEFAULT_POMODORO_CONFIG, displayMode: "mini" };
    await savePomodoroConfig(cfg);
    expect(mockInvoke).toHaveBeenCalledWith("set_pomodoro_config", {
      config: JSON.stringify(cfg),
    });
  });
});
