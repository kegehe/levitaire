import { describe, it, expect } from "vitest";
import { formatBytes, formatRate, formatUptime } from "./formatBytes";

describe("formatBytes", () => {
  it("0 字节", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("1 字节", () => {
    expect(formatBytes(1)).toBe("1 B");
  });

  it("512 字节", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("1 KB 整", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
  });

  it("1.5 KB", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("100 KB（无小数）", () => {
    expect(formatBytes(1024 * 100)).toBe("100 KB");
  });

  it("1 MB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });

  it("1.5 GB", () => {
    expect(formatBytes(1024 * 1024 * 1536)).toBe("1.5 GB");
  });

  it("1 TB", () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe("1.0 TB");
  });

  it("大值不超出 TB 单位", () => {
    // 5 PB = 5120 TB
    expect(formatBytes(5 * 1024 ** 5)).toBe("5120 TB");
  });
});

describe("formatRate", () => {
  it("0 速率", () => {
    expect(formatRate(0)).toBe("0 B/s");
  });

  it("1 KB/s", () => {
    expect(formatRate(1024)).toBe("1.0 KB/s");
  });

  it("1 MB/s", () => {
    expect(formatRate(1024 * 1024)).toBe("1.0 MB/s");
  });
});

describe("formatUptime", () => {
  it("0 秒", () => {
    expect(formatUptime(0)).toBe("0分");
  });

  it("30 秒", () => {
    expect(formatUptime(30)).toBe("0分");
  });

  it("59 秒", () => {
    expect(formatUptime(59)).toBe("0分");
  });

  it("1 分钟", () => {
    expect(formatUptime(60)).toBe("1分");
  });

  it("90 秒 = 1分", () => {
    expect(formatUptime(90)).toBe("1分");
  });

  it("1 小时整", () => {
    expect(formatUptime(3600)).toBe("1时 0分");
  });

  it("1 小时 30 分", () => {
    expect(formatUptime(3600 + 1800)).toBe("1时 30分");
  });

  it("23 小时 59 分", () => {
    expect(formatUptime(86399)).toBe("23时 59分");
  });

  it("1 天整", () => {
    expect(formatUptime(86400)).toBe("1天 0时 0分");
  });

  it("1 天 2 小时 30 分", () => {
    expect(formatUptime(86400 + 7200 + 1800)).toBe("1天 2时 30分");
  });

  it("负数视为 0", () => {
    expect(formatUptime(-1)).toBe("0分");
  });
});
