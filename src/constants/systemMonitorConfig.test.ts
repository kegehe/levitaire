import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_SYSTEM_MONITOR_CONFIG,
  MONITOR_INTERVAL_OPTIONS,
  normalizeSystemMonitorConfig,
  fetchSystemMonitorConfig,
  saveSystemMonitorConfig,
  type SystemMonitorConfig,
} from "./systemMonitorConfig";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("normalizeSystemMonitorConfig", () => {
  it("合法配置原样保留", () => {
    const cfg: SystemMonitorConfig = { intervalMs: 2000, displayMode: "full" };
    expect(normalizeSystemMonitorConfig(cfg)).toEqual(cfg);
  });

  it("null 回退为默认", () => {
    expect(normalizeSystemMonitorConfig(null)).toEqual(DEFAULT_SYSTEM_MONITOR_CONFIG);
  });

  it("非对象（字符串）回退为默认", () => {
    expect(normalizeSystemMonitorConfig("not-an-object")).toEqual(DEFAULT_SYSTEM_MONITOR_CONFIG);
  });

  it("undefined 回退为默认", () => {
    expect(normalizeSystemMonitorConfig(undefined)).toEqual(DEFAULT_SYSTEM_MONITOR_CONFIG);
  });

  it("intervalMs 缺失回退为默认 1000", () => {
    const r = normalizeSystemMonitorConfig({});
    expect(r.intervalMs).toBe(DEFAULT_SYSTEM_MONITOR_CONFIG.intervalMs);
  });

  it("intervalMs 为非数字回退为默认", () => {
    const r = normalizeSystemMonitorConfig({ intervalMs: "fast" } as unknown as Partial<SystemMonitorConfig>);
    expect(r.intervalMs).toBe(DEFAULT_SYSTEM_MONITOR_CONFIG.intervalMs);
  });

  it("intervalMs 为 0 回退为默认（低于 200 下限）", () => {
    const r = normalizeSystemMonitorConfig({ intervalMs: 0 });
    expect(r.intervalMs).toBe(DEFAULT_SYSTEM_MONITOR_CONFIG.intervalMs);
  });

  it("intervalMs 为 50 回退为默认（低于 200 下限）", () => {
    const r = normalizeSystemMonitorConfig({ intervalMs: 50 });
    expect(r.intervalMs).toBe(DEFAULT_SYSTEM_MONITOR_CONFIG.intervalMs);
  });

  it("intervalMs 为 200 保留（刚好下限）", () => {
    const r = normalizeSystemMonitorConfig({ intervalMs: 200 });
    expect(r.intervalMs).toBe(200);
  });

  it("intervalMs 为 5000 保留", () => {
    const r = normalizeSystemMonitorConfig({ intervalMs: 5000 });
    expect(r.intervalMs).toBe(5000);
  });
});

describe("MONITOR_INTERVAL_OPTIONS", () => {
  it("包含 3 个选项", () => {
    expect(MONITOR_INTERVAL_OPTIONS).toHaveLength(3);
  });

  it("选项值递增", () => {
    const values = MONITOR_INTERVAL_OPTIONS.map((o) => o.value);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  it("每个选项都有 label", () => {
    MONITOR_INTERVAL_OPTIONS.forEach((opt) => {
      expect(opt.label).toBeTruthy();
      expect(typeof opt.label).toBe("string");
    });
  });
});

describe("fetchSystemMonitorConfig", () => {
  it("后端返回 JSON 字符串时正确解析并归一化", async () => {
    mockInvoke.mockResolvedValueOnce(JSON.stringify({ intervalMs: 2000 }));
    const result = await fetchSystemMonitorConfig();
    expect(result).toEqual({ intervalMs: 2000, displayMode: "full" });
    expect(mockInvoke).toHaveBeenCalledWith("get_system_monitor_config");
  });

  it("后端返回脏数据时归一化（intervalMs 为 0 → 默认 1000）", async () => {
    mockInvoke.mockResolvedValueOnce(JSON.stringify({ intervalMs: 0 }));
    const result = await fetchSystemMonitorConfig();
    expect(result).toEqual(DEFAULT_SYSTEM_MONITOR_CONFIG);
  });

  it("后端返回空串时回退为默认", async () => {
    mockInvoke.mockResolvedValueOnce("");
    const result = await fetchSystemMonitorConfig();
    expect(result).toEqual(DEFAULT_SYSTEM_MONITOR_CONFIG);
  });

  it("invoke 抛错时回退为默认", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("config read failed"));
    const result = await fetchSystemMonitorConfig();
    expect(result).toEqual(DEFAULT_SYSTEM_MONITOR_CONFIG);
  });

  it("JSON 解析失败时回退为默认", async () => {
    mockInvoke.mockResolvedValueOnce("{invalid json");
    const result = await fetchSystemMonitorConfig();
    expect(result).toEqual(DEFAULT_SYSTEM_MONITOR_CONFIG);
  });

  it("保留已保存的迷你显示模式", () => {
    expect(normalizeSystemMonitorConfig({ intervalMs: 1000, displayMode: "mini" })).toEqual({
      intervalMs: 1000,
      displayMode: "mini",
    });
  });
});

describe("saveSystemMonitorConfig", () => {
  it("调用 set_system_monitor_config 并以 JSON 字符串持久化", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const cfg: SystemMonitorConfig = { intervalMs: 5000, displayMode: "mini" };
    await saveSystemMonitorConfig(cfg);
    expect(mockInvoke).toHaveBeenCalledWith("set_system_monitor_config", {
      config: JSON.stringify(cfg),
    });
  });
});
