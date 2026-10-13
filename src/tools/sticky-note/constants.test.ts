import { describe, it, expect } from "vitest";
import {
  clampWindowSize,
  IMAGE_FILE_PATTERN,
  IMG_TOKEN_PATTERN,
  manualSizeOf,
  NOTE_COLORS,
  NOTE_MIN_WINDOW_HEIGHT,
  NOTE_MIN_WINDOW_WIDTH,
  getNoteColor,
  isNoteImgRel,
  parseNoteIdFromLabel,
  stripImgTokens,
} from "./constants";

describe("sticky-note constants", () => {
  it("parseNoteIdFromLabel 解析窗口 label", () => {
    expect(parseNoteIdFromLabel("sticky-note-note-1750000000000-1")).toBe("note-1750000000000-1");
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
    // 扩展名清单必须与后端 IMAGE_SOURCE_EXTS / is_generated_image_file 同步：
    // 前端认、后端不认的令牌会渲染成图片，但「复制 / 删除图片」两条命令会被挡下
    for (const ext of ["png", "jpg", "jpeg", "gif", "bmp"]) {
      expect(isNoteImgRel(`note-1750000000000-1/img_1_2.${ext}`), ext).toBe(true);
    }
    // webp 不在后端白名单（Cargo.toml 的 image 没开 webp 特性）
    expect(isNoteImgRel("note-1750000000000-1/img_1_2.webp")).toBe(false);
    // 用户字面文本/异常路径不应被当作图片
    expect(isNoteImgRel("note-1/img_1.png")).toBe(false); // note id 缺第二段数字
    expect(isNoteImgRel("手动内容")).toBe(false);
    expect(isNoteImgRel("../evil/../../img_1_0.png")).toBe(false);
    expect(isNoteImgRel("")).toBe(false);
  });

  /**
   * 手动尺寸只有两种语义：0 / 缺省 = 自动（宽 264、高随内容），> 0 = 用户拖出来的固定尺寸。
   * 脏数据（负数、NaN、跨屏残留的小值）必须落回「自动」或夹到下限 —— 否则便签会变成
   * 一个 1×1 的窗口，用户既看不见也点不到。
   */
  it("manualSizeOf 把 0 / 非法值当自动，越界值夹到下限", () => {
    expect(manualSizeOf(0, 0)).toBeNull();
    expect(manualSizeOf(undefined, undefined)).toBeNull();
    expect(manualSizeOf(-10, 300)).toBeNull();
    expect(manualSizeOf(Number.NaN, 300)).toBeNull();
    expect(manualSizeOf(320, 420)).toEqual({ width: 320, height: 420 });
    expect(manualSizeOf(10, 10)).toEqual({
      width: NOTE_MIN_WINDOW_WIDTH,
      height: NOTE_MIN_WINDOW_HEIGHT,
    });
  });

  it("clampWindowSize 夹住原生 resize 报回来的越界尺寸", () => {
    expect(clampWindowSize(300.4, 420.6)).toEqual({ width: 300, height: 421 });
    expect(clampWindowSize(1, 1)).toEqual({
      width: NOTE_MIN_WINDOW_WIDTH,
      height: NOTE_MIN_WINDOW_HEIGHT,
    });
    // 大屏用户合法拖得到的大尺寸不能被压小（压小会与后端存的值不一致，下次开窗静默回缩）
    expect(clampWindowSize(2400, 3000)).toEqual({ width: 2400, height: 3000 });
    // 脏值（NaN / Infinity）落回下限，而不是把窗口撑成 NaN
    expect(clampWindowSize(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({
      width: NOTE_MIN_WINDOW_WIDTH,
      height: NOTE_MIN_WINDOW_HEIGHT,
    });
  });

  /** 拖入文件的扩展名预筛：与后端 IMAGE_SOURCE_EXTS 是同一份清单 */
  it("IMAGE_FILE_PATTERN 放行图片、拦住其它文件", () => {
    for (const ok of ["C:/a/b.png", "a.JPG", "a.jpeg", "a.GIF", "shot.bmp"]) {
      expect(IMAGE_FILE_PATTERN.test(ok), ok).toBe(true);
    }
    for (const no of ["a.webp", "a.txt", "a.png.exe", "a"]) {
      expect(IMAGE_FILE_PATTERN.test(no), no).toBe(false);
    }
  });
});
