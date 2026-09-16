import { describe, it, expect, beforeEach } from "vitest";
import {
  FLOATING_TOOLS,
  BACKEND_TOOLS,
  CATEGORY_LABELS,
  backendSetterFor,
  getEnabledTools,
  setEnabledTools,
} from "./registry";

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
  }, 15_000);
});

describe("BACKEND_TOOLS", () => {
  it("覆盖全部悬浮工具：漏登记会让该工具的开关只改前端状态", () => {
    // 通用工具就曾漏登记：面板开关既不持久化，也不会在禁用时收起已打开的浮窗，
    // 于是「全部关闭」关不掉它。这条用例守住这个契约。
    const registered = new Set(BACKEND_TOOLS.map((tool) => tool.id));
    const missing = FLOATING_TOOLS.map((tool) => tool.id).filter((id) => !registered.has(id));
    expect(missing).toEqual([]);
  });

  it("不含已下线工具的残留项", () => {
    const known = new Set(FLOATING_TOOLS.map((tool) => tool.id));
    expect(BACKEND_TOOLS.filter((tool) => !known.has(tool.id))).toEqual([]);
  });

  it("命令名与工具 id 一一对应（防止复制上一行忘了改命令名）", () => {
    // 这张表是手写的，最容易犯的错是「复制上一行、只改了 id、没改命令名」：
    // 那样禁用 A 会去禁 B，前后端都不报错。约定 = <get|set>_<id 连字符转下划线>_enabled
    for (const tool of BACKEND_TOOLS) {
      const suffix = `${tool.id.replace(/-/g, "_")}_enabled`;
      expect(tool.getter).toBe(`get_${suffix}`);
      expect(tool.setter).toBe(`set_${suffix}`);
    }
  });

  it("每个工具的 getter / setter 都能取到", () => {
    for (const tool of BACKEND_TOOLS) {
      expect(tool.getter).toMatch(/^get_.+_enabled$/);
      expect(backendSetterFor(tool.id)).toBe(tool.setter);
    }
  });

  it("未登记的工具取不到 setter（调用方据此跳过后端下发）", () => {
    expect(backendSetterFor("not-a-tool")).toBeUndefined();
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

  it("下线工具别名：pomodoro 映射为 timer，避免并入后用户配置丢失", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["pomodoro", "screenshot"]));
    const result = getEnabledTools();
    expect(result).toEqual(["timer", "screenshot"]);
    // 归一化结果写回，避免每次启动都重复迁移
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(["timer", "screenshot"]);
  });

  it("别名映射后与原 ID 重复时只保留一项", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["timer", "pomodoro"]));
    expect(getEnabledTools()).toEqual(["timer"]);
  });

  it("storage key 存在但 LEGACY_KEY 也存在时，优先用 STORAGE_KEY", () => {
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
