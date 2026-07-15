import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  TOOLBAR_FEATURES,
  DEFAULT_FEATURE_IDS,
  fetchEnabledFeatures,
  saveEnabledFeatures,
} from "./toolbarFeatures";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TOOLBAR_FEATURES 完整性", () => {
  it("每个功能有完整字段", () => {
    for (const f of TOOLBAR_FEATURES) {
      expect(typeof f.id).toBe("string");
      expect(f.id.length).toBeGreaterThan(0);
      expect(typeof f.label).toBe("string");
      expect(typeof f.icon).toBe("string");
    }
  });

  it("功能 ID 唯一", () => {
    const ids = TOOLBAR_FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("包含新增的 Unicode 两个功能", () => {
    expect(TOOLBAR_FEATURES.some((f) => f.id === "unicode-encode")).toBe(true);
    expect(TOOLBAR_FEATURES.some((f) => f.id === "unicode-decode")).toBe(true);
  });

  it("Unicode 功能图标为 Type", () => {
    const enc = TOOLBAR_FEATURES.find((f) => f.id === "unicode-encode");
    const dec = TOOLBAR_FEATURES.find((f) => f.id === "unicode-decode");
    expect(enc?.icon).toBe("Type");
    expect(dec?.icon).toBe("Type");
  });

  it("Unicode 功能位于 base64 与 md5 之间", () => {
    const ids = TOOLBAR_FEATURES.map((f) => f.id);
    const b64DecIdx = ids.indexOf("base64-decode");
    const uniEncIdx = ids.indexOf("unicode-encode");
    const uniDecIdx = ids.indexOf("unicode-decode");
    const md5Idx = ids.indexOf("md5-encrypt");

    expect(b64DecIdx).toBeLessThan(uniEncIdx);
    expect(uniEncIdx).toBeLessThan(uniDecIdx);
    expect(uniDecIdx).toBeLessThan(md5Idx);
  });

  it("包含字符统计功能", () => {
    expect(TOOLBAR_FEATURES.some((f) => f.id === "char-count")).toBe(true);
  });

  it("字符统计图标为 Calculator", () => {
    const f = TOOLBAR_FEATURES.find((f) => f.id === "char-count");
    expect(f?.icon).toBe("Calculator");
  });

  it("字符统计位于 clear 之后", () => {
    const ids = TOOLBAR_FEATURES.map((f) => f.id);
    const clearIdx = ids.indexOf("clear");
    const charCountIdx = ids.indexOf("char-count");
    expect(clearIdx).toBeLessThan(charCountIdx);
  });

  it("包含朗读功能", () => {
    expect(TOOLBAR_FEATURES.some((f) => f.id === "tts")).toBe(true);
  });

  it("朗读图标为 Volume2", () => {
    const f = TOOLBAR_FEATURES.find((f) => f.id === "tts");
    expect(f?.icon).toBe("Volume2");
  });

  it("朗读位于字符统计之后（数组末尾）", () => {
    const ids = TOOLBAR_FEATURES.map((f) => f.id);
    const charCountIdx = ids.indexOf("char-count");
    const ttsIdx = ids.indexOf("tts");
    expect(charCountIdx).toBeLessThan(ttsIdx);
    expect(ttsIdx).toBe(ids.length - 1);
  });

  it("包含编号功能", () => {
    expect(TOOLBAR_FEATURES.some((f) => f.id === "numbering")).toBe(true);
  });

  it("编号图标为 ListOrdered", () => {
    const f = TOOLBAR_FEATURES.find((f) => f.id === "numbering");
    expect(f?.icon).toBe("ListOrdered");
  });

  it("编号位于去重之后、Base64 编码之前", () => {
    const ids = TOOLBAR_FEATURES.map((f) => f.id);
    const dedupIdx = ids.indexOf("dedup");
    const numberingIdx = ids.indexOf("numbering");
    const b64EncIdx = ids.indexOf("base64-encode");
    expect(dedupIdx).toBeLessThan(numberingIdx);
    expect(numberingIdx).toBeLessThan(b64EncIdx);
  });
});

describe("DEFAULT_FEATURE_IDS", () => {
  it("包含所有功能 id（新功能默认启用）", () => {
    for (const f of TOOLBAR_FEATURES) {
      expect(DEFAULT_FEATURE_IDS).toContain(f.id);
    }
    expect(DEFAULT_FEATURE_IDS).toContain("unicode-encode");
    expect(DEFAULT_FEATURE_IDS).toContain("unicode-decode");
  });
});

describe("fetchEnabledFeatures", () => {
  it("后端返回空列表时回退为默认全量", async () => {
    mockInvoke.mockResolvedValueOnce([]);
    const result = await fetchEnabledFeatures();
    expect(result).toEqual(expect.arrayContaining(DEFAULT_FEATURE_IDS));
    expect(result).toHaveLength(DEFAULT_FEATURE_IDS.length);
  });

  it("后端返回 null 时回退为默认全量", async () => {
    mockInvoke.mockResolvedValueOnce(null as unknown as string[]);
    const result = await fetchEnabledFeatures();
    expect(result).toEqual(expect.arrayContaining(DEFAULT_FEATURE_IDS));
  });

  it("后端返回有效子集时原样返回（尊重用户禁用）", async () => {
    const stored = ["copy", "search", "unicode-encode"];
    mockInvoke.mockResolvedValueOnce(stored);
    const result = await fetchEnabledFeatures();
    expect(result).toEqual(stored);
  });

  it("含已移除的旧 ID 时重置为默认全量并写回", async () => {
    const stored = ["copy", "removed-old-feature", "unicode-decode"];
    mockInvoke.mockResolvedValueOnce(stored);
    mockInvoke.mockResolvedValueOnce(undefined); // set_toolbar_features

    const result = await fetchEnabledFeatures();

    expect(result).toEqual(expect.arrayContaining(DEFAULT_FEATURE_IDS));
    expect(result).not.toContain("removed-old-feature");
    // 重置时调用 set_toolbar_features 写回全量
    expect(mockInvoke).toHaveBeenCalledWith("set_toolbar_features", {
      features: expect.arrayContaining(DEFAULT_FEATURE_IDS),
    });
  });

  it("旧用户配置不含新 Unicode 功能时不自动补全（保持原样）", async () => {
    // 模拟真实升级场景：用户在新增 Unicode 功能前已禁用部分功能，
    // 存储值都是旧版本就存在的有效 id，但缺少新增的 unicode-encode/decode
    const stored = ["copy", "search", "translate", "optimize"];
    mockInvoke.mockResolvedValueOnce(stored);

    const result = await fetchEnabledFeatures();

    // 原样返回，不自动追加新功能
    expect(result).toEqual(stored);
    expect(result).not.toContain("unicode-encode");
    expect(result).not.toContain("unicode-decode");
    // 不触发重置写回
    expect(mockInvoke).not.toHaveBeenCalledWith("set_toolbar_features", expect.anything());
  });

  it("invoke 抛错时回退为默认全量", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("config read failed"));
    const result = await fetchEnabledFeatures();
    expect(result).toEqual(expect.arrayContaining(DEFAULT_FEATURE_IDS));
  });
});

describe("saveEnabledFeatures", () => {
  it("调用 set_toolbar_features 持久化", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveEnabledFeatures(["copy", "unicode-encode"]);
    expect(mockInvoke).toHaveBeenCalledWith("set_toolbar_features", {
      features: ["copy", "unicode-encode"],
    });
  });
});
