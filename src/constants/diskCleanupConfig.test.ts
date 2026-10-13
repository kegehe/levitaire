import { describe, it, expect } from "vitest";
import {
  CLEAN_STATUS_META,
  CLEAN_TIER_META,
  CLEAN_TIER_ORDER,
  DEFAULT_CLEANER_HEIGHT,
  DEFAULT_CLEANER_WIDTH,
  DEFAULT_QUARANTINE_RETENTION_DAYS,
  DEFAULT_WATCHDOG_INTERVAL_HOURS,
  DEFAULT_WATCHDOG_MIN_AGE_DAYS,
  DEFAULT_WATCHDOG_MIN_BYTES,
  DEFAULT_WATCHDOG_MIN_DELTA_BYTES,
  QUARANTINE_RETENTION_OPTIONS,
  WATCHDOG_INTERVAL_OPTIONS,
  WATCHDOG_MIN_AGE_OPTIONS,
  WATCHDOG_MIN_BYTES_OPTIONS,
  WATCHDOG_MIN_DELTA_OPTIONS,
  formatBytes,
  statusMeta,
} from "./diskCleanupConfig";

describe("分级表", () => {
  it("只列出面板要展示的级别，且顺序固定", () => {
    expect(CLEAN_TIER_ORDER).toEqual(["L1", "L2", "L3"]);
  });

  it("L2/L3 标记为需要管理员，L1 不需要", () => {
    expect(CLEAN_TIER_META.L1.needsAdmin).toBe(false);
    expect(CLEAN_TIER_META.L2.needsAdmin).toBe(true);
    expect(CLEAN_TIER_META.L3.needsAdmin).toBe(true);
  });

  it("只有 L3 是不可逆的 —— 它决定了 UI 必须做不可撤销的视觉区分", () => {
    expect(CLEAN_TIER_META.L1.irreversible).toBe(false);
    expect(CLEAN_TIER_META.L2.irreversible).toBe(false);
    expect(CLEAN_TIER_META.L3.irreversible).toBe(true);
  });

  it("每一级都有非空文案：后果文案不允许省略", () => {
    for (const tier of ["L0", "L1", "L2", "L3"] as const) {
      expect(CLEAN_TIER_META[tier].label.length).toBeGreaterThan(0);
      expect(CLEAN_TIER_META[tier].hint.length).toBeGreaterThan(0);
    }
  });
});

describe("规则状态表", () => {
  it("覆盖后端会返回的每一种状态", () => {
    // 与 Rust 侧 scan::RuleStatus 的 serde 取值一一对应
    for (const status of [
      "ok",
      "no-target",
      "blocked",
      "guarded",
      "not-a-directory",
      "failed",
      "cancelled",
    ]) {
      expect(CLEAN_STATUS_META[status as keyof typeof CLEAN_STATUS_META]).toBeDefined();
    }
  });

  it("未知状态不假设为正常", () => {
    const meta = statusMeta("something-new");
    expect(meta.tone).toBe("warn");
    expect(meta.label).toContain("something-new");
  });
});

describe("formatBytes", () => {
  it("按量级换单位", () => {
    expect(formatBytes(0)).toBe("——");
    expect(formatBytes(-1)).toBe("——");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });

  it("三位数以上不再保留小数（面板宽度有限）", () => {
    expect(formatBytes(512 * 1024)).toBe("512 KB");
  });

  it("非有限值回退成占位符而不是 NaN", () => {
    expect(formatBytes(Number.NaN)).toBe("——");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("——");
  });
});

describe("隔离区保留期", () => {
  it("档位与后端一致，且默认值在档位里", () => {
    const values = QUARANTINE_RETENTION_OPTIONS.map((option) => option.value);
    // 与 Rust 侧 quarantine::RETENTION_CHOICES 对账（守卫在 Rust 那边）
    expect([...values].sort((a, b) => a - b)).toEqual([0, 7, 14, 30]);
    expect(values).toContain(DEFAULT_QUARANTINE_RETENTION_DAYS);
  });

  it("0 的文案说明它是「不自动清理」而不是「立即删除」", () => {
    const zero = QUARANTINE_RETENTION_OPTIONS.find((option) => option.value === 0)!;
    // 语义写反会让用户以为自己选了"马上释放空间"
    expect(zero.label).toContain("不自动清理");
    expect(zero.label).not.toContain("立即删除");
  });
});

describe("看门狗档位", () => {
  it("间隔档位都是低频的（看门狗必须低频，否则它自己就成了负担）", () => {
    for (const hours of WATCHDOG_INTERVAL_OPTIONS) {
      expect(hours).toBeGreaterThanOrEqual(1);
    }
    expect(WATCHDOG_INTERVAL_OPTIONS).toContain(DEFAULT_WATCHDOG_INTERVAL_HOURS);
  });

  it("阈值档位都高于后端的下限（低于下限会被后端夹住，症状是「填了没反应」）", () => {
    // 后端下限：64 MB / 16 MB / 1 天
    for (const option of WATCHDOG_MIN_BYTES_OPTIONS) {
      expect(option.value).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    }
    for (const option of WATCHDOG_MIN_DELTA_OPTIONS) {
      expect(option.value).toBeGreaterThanOrEqual(16 * 1024 * 1024);
    }
    for (const option of WATCHDOG_MIN_AGE_OPTIONS) {
      expect(option.value).toBeGreaterThanOrEqual(1);
    }
  });

  it("默认值都在档位里", () => {
    const bytes = WATCHDOG_MIN_BYTES_OPTIONS.map((option) => option.value);
    const delta = WATCHDOG_MIN_DELTA_OPTIONS.map((option) => option.value);
    const ages = WATCHDOG_MIN_AGE_OPTIONS.map((option) => option.value);
    expect(bytes).toContain(DEFAULT_WATCHDOG_MIN_BYTES);
    expect(delta).toContain(DEFAULT_WATCHDOG_MIN_DELTA_BYTES);
    expect(ages).toContain(DEFAULT_WATCHDOG_MIN_AGE_DAYS);
  });
});

describe("窗口尺寸", () => {
  it("是正数且足够放下报告分区", () => {
    expect(DEFAULT_CLEANER_WIDTH).toBeGreaterThan(360);
    expect(DEFAULT_CLEANER_HEIGHT).toBeGreaterThan(420);
  });
});
