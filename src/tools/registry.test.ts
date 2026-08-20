import { describe, it, expect, beforeEach } from "vitest";
import { FLOATING_TOOLS, CATEGORY_LABELS, getEnabledTools, setEnabledTools } from "./registry";

const STORAGE_KEY = "levitaire-tools-enabled";
const LEGACY_KEY = "floatory-toolbar-features";
const LEGACY_STORAGE_KEYS = ["floatory-tools-enabled", "floast-tools-enabled"];

beforeEach(() => {
  localStorage.clear();
});

describe("registry FLOATING_TOOLS", () => {
  it("每个工具有完整字段", () => {
    for (const t of FLOATING_TOOLS) {
      expect(typeof t.id).toBe("string");
      expect(t.id.length).toBeGreaterThan(0);
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(["text", "screen", "system"]).toContain(t.category);
      expect(["selection", "immediate"]).toContain(t.activation);
      expect(typeof t.defaultEnabled).toBe("boolean");
      expect(typeof t.loader).toBe("function");
    }
  });

  it("工具 ID 唯一", () => {
    const ids = FLOATING_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("loader 返回 Promise（可动态 import）", async () => {
    for (const t of FLOATING_TOOLS) {
      const mod = await t.loader();
      expect(mod.default).toBeDefined();
    }
  });
});

describe("CATEGORY_LABELS", () => {
  it("覆盖所有类别", () => {
    expect(CATEGORY_LABELS.text).toBeTruthy();
    expect(CATEGORY_LABELS.screen).toBeTruthy();
    expect(CATEGORY_LABELS.system).toBeTruthy();
  });
});

describe("getEnabledTools", () => {
  it("首次使用：返回所有 defaultEnabled 为 true 的工具", () => {
    const result = getEnabledTools();
    const expected = FLOATING_TOOLS.filter((t) => t.defaultEnabled).map((t) => t.id);
    expect(result.sort()).toEqual(expected.sort());
    // 同时持久化
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).sort()).toEqual(expected.sort());
  });

  it("旧版迁移：有 LEGACY_KEY 无 STORAGE_KEY 时按 defaults 初始化", () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(["copy", "search"]));
    const result = getEnabledTools();
    const expected = FLOATING_TOOLS.filter((t) => t.defaultEnabled).map((t) => t.id);
    expect(result.sort()).toEqual(expected.sort());
    // 迁移后写入 STORAGE_KEY
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("旧版迁移：Floatory STORAGE_KEY 作为真值迁入当前 key", () => {
    const stored = ["text-toolbar"]; // 用户曾禁用 screenshot
    localStorage.setItem(LEGACY_STORAGE_KEYS[0], JSON.stringify(stored));
    const result = getEnabledTools();
    expect(result).toEqual(["text-toolbar"]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(["text-toolbar"]);
  });

  it("旧版迁移：Floast STORAGE_KEY 作为真值迁入当前 key", () => {
    const stored = ["screenshot"];
    localStorage.setItem(LEGACY_STORAGE_KEYS[1], JSON.stringify(stored));
    const result = getEnabledTools();
    expect(result).toEqual(["screenshot"]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(["screenshot"]);
  });

  it("旧版迁移：多代旧 STORAGE_KEY 并存时按顺序优先 floatory", () => {
    localStorage.setItem(LEGACY_STORAGE_KEYS[1], JSON.stringify(["screenshot"]));
    localStorage.setItem(LEGACY_STORAGE_KEYS[0], JSON.stringify(["text-toolbar"]));
    const result = getEnabledTools();
    // 按迁移顺序 floatory 优先于 floast
    expect(result).toEqual(["text-toolbar"]);
  });

  it("有 STORAGE_KEY 时返回存储值，不自动补全 defaultEnabled 工具", () => {
    const stored = ["text-toolbar"];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    const result = getEnabledTools();
    // screenshot 虽 defaultEnabled=true 但不在 stored，保持禁用（真值由后端同步）
    expect(result).toEqual(["text-toolbar"]);
  });

  it("过滤已移除工具的残留 ID，保留有效项", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(["text-toolbar", "removed-tool", "screenshot"]),
    );
    const result = getEnabledTools();
    expect(result).toContain("text-toolbar");
    expect(result).toContain("screenshot");
    expect(result).not.toContain("removed-tool");
  });

  it("STORAGE_KEY 存在但 LEGACY_KEY 也存在时，优先用 STORAGE_KEY", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["text-toolbar"]));
    localStorage.setItem(LEGACY_KEY, JSON.stringify(["copy"]));
    const result = getEnabledTools();
    expect(result).toEqual(["text-toolbar"]);
    // 不应因 LEGACY_KEY 重置
  });

  it("STORAGE_KEY 损坏（非法 JSON）时回退到 defaults", () => {
    localStorage.setItem(STORAGE_KEY, "not-json{{{");
    const result = getEnabledTools();
    const expected = FLOATING_TOOLS.filter((t) => t.defaultEnabled).map((t) => t.id);
    expect(result.sort()).toEqual(expected.sort());
  });

  it("用户手动禁用某 defaultEnabled 工具后保持禁用", () => {
    // 模拟用户只启用 text-toolbar（禁用 screenshot）
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["text-toolbar"]));
    const result = getEnabledTools();
    // screenshot 是 defaultEnabled=true 但不在 stored，应保持禁用
    expect(result).toEqual(["text-toolbar"]);
    expect(result).not.toContain("screenshot");
  });

  it("用户全部禁用（stored 为空数组）后保持空，不被重置为默认", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
    const result = getEnabledTools();
    expect(result).toEqual([]);
  });
});

describe("setEnabledTools", () => {
  it("持久化到 localStorage", () => {
    setEnabledTools(["a", "b"]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(["a", "b"]);
  });
});
