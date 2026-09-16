import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { CLEAR_OPTIONS, DEFAULT_CLEAR_IDS, fetchClearOptions, saveClearOptions } from "./clearConfig";
import { NONE_SELECTED_SENTINEL } from "./selectionPersistence";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("clearConfig", () => {
  it("默认清单覆盖全部清除项", () => {
    expect(DEFAULT_CLEAR_IDS).toEqual(CLEAR_OPTIONS.map((option) => option.id));
  });

  it("从未设置（空列表）时回退默认全量", async () => {
    mockInvoke.mockResolvedValueOnce([]);
    expect(await fetchClearOptions()).toEqual(DEFAULT_CLEAR_IDS);
  });

  /**
   * 「全部取消勾选」存不住的老缺陷：后端存的是**启用**列表，空列表既可能表示
   * "从没设置过"（回退默认全量），也可能表示"用户把每一项都关掉了"（保持为空）。
   * 老实现一律按前者处理 ⇒ 全关之后重开又全选回来，用户永远关不掉。
   */
  it("保存空选择时写入哨兵；读回仍是空（全部取消勾选必须存得住）", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveClearOptions([]);
    expect(mockInvoke).toHaveBeenCalledWith("set_clear_options", {
      options: [NONE_SELECTED_SENTINEL],
    });

    mockInvoke.mockResolvedValueOnce([NONE_SELECTED_SENTINEL]);
    expect(await fetchClearOptions()).toEqual([]);
  });

  it("哨兵不会被当成「已移除的旧 ID」而触发重置写回", async () => {
    mockInvoke.mockResolvedValueOnce([NONE_SELECTED_SENTINEL]);
    await fetchClearOptions();
    expect(mockInvoke).not.toHaveBeenCalledWith("set_clear_options", expect.anything());
  });

  it("含已移除的旧 ID 时重置为默认全量并写回", async () => {
    mockInvoke.mockResolvedValueOnce(["clear-spaces", "removed-old-option"]);
    mockInvoke.mockResolvedValueOnce(undefined);

    const result = await fetchClearOptions();

    expect(result).toEqual(DEFAULT_CLEAR_IDS);
    expect(result).not.toContain("removed-old-option");
    expect(mockInvoke).toHaveBeenCalledWith("set_clear_options", { options: DEFAULT_CLEAR_IDS });
  });

  it("有效子集原样返回（尊重用户已取消勾选的项）", async () => {
    const stored = ["clear-spaces", "clear-digits"];
    mockInvoke.mockResolvedValueOnce(stored);
    expect(await fetchClearOptions()).toEqual(stored);
  });

  it("invoke 抛错时回退默认全量", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("config read failed"));
    expect(await fetchClearOptions()).toEqual(DEFAULT_CLEAR_IDS);
  });
});
