import { describe, it, expect } from "vitest";
import {
  IMG_TOKEN_PATTERN,
  NOTE_COLORS,
  getNoteColor,
  isNoteImgRel,
  parseNoteIdFromLabel,
  stripImgTokens,
} from "./constants";

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

  it("stripImgTokens 将令牌替换为可读占位（管理窗预览用）", () => {
    expect(stripImgTokens("看[[img:sticky-images/n/i.png]]图")).toBe("看[图片]图");
    // 空图片列表不影响文本
    expect(stripImgTokens("纯文本")).toBe("纯文本");
    expect(stripImgTokens("")).toBe("");
    // 仅图片：strip 后仍非空，便于上层判断"非空白便签"
    expect(stripImgTokens("[[img:a.png]][[img:b.png]]")).toBe("[图片][图片]");
  });

  it("IMG_TOKEN_PATTERN 是合法、可匹配多段的正则源", () => {
    const re = new RegExp(IMG_TOKEN_PATTERN, "g");
    expect("x[[img:path/a.png]]y".split(re).length).toBe(3);
    expect(re.test("[[img:path/a.png]]")).toBe(true);
  });

  it("isNoteImgRel 只认后端生成的相对路径格式", () => {
    // 后端真实命名：note-<millis>-<seq>/img_<millis>_<seq>.png
    expect(isNoteImgRel("note-1750000000000-1/img_1_0.png")).toBe(true);
    expect(isNoteImgRel("note-1750000000000-1/img_9_3.jpeg")).toBe(true);
    // 用户字面文本/异常路径不应被当作图片
    expect(isNoteImgRel("note-1/img_1.png")).toBe(false); // note id 缺第二段数字
    expect(isNoteImgRel("手动内容")).toBe(false);
    expect(isNoteImgRel("../evil/../../img_1_0.png")).toBe(false);
    expect(isNoteImgRel("")).toBe(false);
  });
});
