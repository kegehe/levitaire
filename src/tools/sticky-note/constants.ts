/** 便利贴纸色（与后端 sticky_note::VALID_COLORS 顺序/ id 保持一致） */
export interface StickyNoteColor {
  id: string;
  label: string;
  /** 纸面主色（卡片背景） */
  swatch: string;
  /** 深一级折痕色（视觉折角/阴影） */
  fold: string;
}

export const NOTE_COLORS: StickyNoteColor[] = [
  { id: "yellow", label: "鹅黄", swatch: "#f6e7a1", fold: "#e6d37f" },
  { id: "pink", label: "樱花粉", swatch: "#f8cfd4", fold: "#ecb4bd" },
  { id: "mint", label: "薄荷", swatch: "#cbead9", fold: "#aedcc0" },
  { id: "blue", label: "晴空蓝", swatch: "#c9e0f5", fold: "#aacdf0" },
  { id: "lavender", label: "丁香紫", swatch: "#dfd6f2", fold: "#c7b9ea" },
  { id: "peach", label: "蜜桃", swatch: "#fadcc9", fold: "#f2c6a8" },
];

export function getNoteColor(id?: string | null): StickyNoteColor {
  return NOTE_COLORS.find((c) => c.id === id) ?? NOTE_COLORS[0];
}

/** 从窗口 label（sticky-note-<noteId>）解析出便签 id */
export function parseNoteIdFromLabel(label: string): string {
  const prefix = "sticky-note-";
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

/**
 * 便签正文中图片令牌的正则源（捕获组 = 图片相对路径，形如 sticky-images/<noteId>/img_*.png）。
 * 后端以 `[[img:<相对路径>]]` 令牌落盘，渲染时前端替换为 <img>。用源串而非共享
 * 全局正则对象，避免 exec/test 的 lastIndex 跨处污染；调用处各自 new RegExp。
 */
export const IMG_TOKEN_PATTERN = "\\[\\[img:([^\\]]+)\\]\\]";

/** 把图片令牌替换为普通文本（管理窗预览用） */
export function stripImgTokens(text: string, replacement = "[图片]"): string {
  return text.replace(new RegExp(IMG_TOKEN_PATTERN, "g"), replacement);
}

/**
 * 后端生成的图片相对路径格式（与 sticky_note::save_image 的文件名保持一致）：
 * <noteId>/img_<millis>_<seq>.<ext>，noteId 为 note-<millis>-<seq>。
 * 水合时仅把符合该格式的令牌还原为图片，其余按普通文本渲染——
 * 避免用户字面输入的 `[[img:...]]` 被改写成无法还原的破图。
 */
export const IMG_REL_PATTERN =
  "^note-\\d+-\\d+/img_\\d+_\\d+\\.(png|jpg|jpeg|gif|webp|bmp)$";

export function isNoteImgRel(rel: string): boolean {
  return new RegExp(IMG_REL_PATTERN).test(rel);
}
