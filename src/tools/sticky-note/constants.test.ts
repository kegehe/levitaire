import { describe, it, expect } from "vitest";
import { NOTE_COLORS, getNoteColor, parseNoteIdFromLabel } from "./constants";

describe("sticky-note constants", () => {
  it("parseNoteIdFromLabel 解析窗口 label", () => {
    expect(parseNoteIdFromLabel("sticky-note-note-1750000000000-1")).toBe(
      "note-1750000000000-1",
    );
    // 不含前缀时原样返回（防御）
    expect(parseNoteIdFromLabel("note-1")).toBe("note-1");
  });

  it("纸色清单唯一且与后端 VALID_COLORS 数量一致", () => {
    const ids = NOTE_COLORS.map((color) => color.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 后端 sticky_note::VALID_COLORS 共 6 色，id 顺序须保持一致
    expect(ids).toEqual(["yellow", "pink", "mint", "blue", "lavender", "peach"]);
  });

  it("getNoteColor 对未知 id 回退默认黄", () => {
    expect(getNoteColor("mint").id).toBe("mint");
    expect(getNoteColor("unknown").id).toBe("yellow");
    expect(getNoteColor(undefined).id).toBe("yellow");
  });
});
