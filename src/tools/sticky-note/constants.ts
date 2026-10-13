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

/* ── 窗口尺寸（逻辑 px）─────────────────────────────────────────────────────
   三处必须保持一致，改一处要同时改另外两处：
     1. 本文件（前端下发 setSize / 手柄下限）；
     2. `StickyNote.css` 的 `.sn-window` padding（左右 16+16、上 16 下 22）；
     3. `sticky_note/mod.rs` 的 NOTE_WIDTH_LOGICAL / NOTE_MIN_* / min_inner_size。

   尺寸口径一律是**原生窗口**（含四周透明留白），不是卡片视觉尺寸。 */

/** 自动模式下的窗口宽度（后端 NOTE_WIDTH_LOGICAL） */
export const NOTE_WIDTH = 264;
/** 手动尺寸下限：再窄卡片上的按钮就排不下一行（后端 min_inner_size 同一组值） */
export const NOTE_MIN_WINDOW_WIDTH = 200;
export const NOTE_MIN_WINDOW_HEIGHT = 146;
/**
 * 手动尺寸上限：只是**防脏数据的理智上限**，与后端 `NOTE_MAX_*_LOGICAL` 同值。
 * 别压低它 —— 前端存进去的尺寸一旦超过后端上限，会被后端改小，下次开窗就对不上。
 */
export const NOTE_MAX_WINDOW_WIDTH = 10_000;
export const NOTE_MAX_WINDOW_HEIGHT = 10_000;

export interface NoteWindowSize {
  width: number;
  height: number;
}

/** 尺寸夹到合法区间（下限见 min_inner_size，上限只为挡脏数据） */
function clampSize(width: number, height: number): NoteWindowSize {
  return {
    width: Math.min(NOTE_MAX_WINDOW_WIDTH, Math.max(NOTE_MIN_WINDOW_WIDTH, Math.round(width))),
    height: Math.min(NOTE_MAX_WINDOW_HEIGHT, Math.max(NOTE_MIN_WINDOW_HEIGHT, Math.round(height))),
  };
}

/**
 * 便签数据里的手动尺寸 → 前端可用尺寸（已夹到合法区间）。0 / 缺省 / 非法值都表示「自动」，
 * 返回 null —— 这一位就是「自动高度还是手动尺寸」的**唯一判据**（`StickyNote.tsx` 启动时用它
 * 决定是否进手动模式；手动模式的布局靠 `height: 100%` 跟着窗口走，不直接消费这里返回的数值，
 * 数值口径只在落盘时用得上）。
 */
export function manualSizeOf(width?: number, height?: number): NoteWindowSize | null {
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return clampSize(width, height);
}

/** 把一次原生 resize 报出来的尺寸夹到合法区间（手柄拖过界时用） */
export function clampWindowSize(width: number, height: number): NoteWindowSize {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return { width: NOTE_MIN_WINDOW_WIDTH, height: NOTE_MIN_WINDOW_HEIGHT };
  }
  return clampSize(width, height);
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
 * 后端生成的图片相对路径格式（与 `sticky_note::save_image` 的文件名保持一致）：
 * <noteId>/img_<millis>_<seq>.<ext>，noteId 为 note-<millis>-<seq>。
 * 水合时仅把符合该格式的令牌还原为图片，其余按普通文本渲染——
 * 避免用户字面输入的 `[[img:...]]` 被改写成无法还原的破图。
 *
 * 扩展名清单必须与后端两份一起改（少一处就会分成两套口径：前端认、后端不认的令牌
 * 会渲染成图片，但「复制 / 删除图片」两条命令会被 `validated_image_rel` 拒绝）：
 *   - `sticky_note::IMAGE_SOURCE_EXTS`（落盘白名单，也是 `image` 依赖开启的特性清单）
 *   - 后端 `is_generated_image_file`（`validated_image_rel` 用它挡越界路径）
 * 三处目前都是 png / jpg / jpeg / gif / bmp —— 没有 webp：`Cargo.toml` 的 `image`
 * 没开 `webp` 特性，放进来只会得到一句「图片解码失败」。
 */
export const IMG_REL_PATTERN = "^note-\\d+-\\d+/img_\\d+_\\d+\\.(png|jpg|jpeg|gif|bmp)$";

export function isNoteImgRel(rel: string): boolean {
  return new RegExp(IMG_REL_PATTERN).test(rel);
}

/**
 * 拖入图片文件的扩展名**预筛**（真正的大小 / 可解码性校验在后端
 * `sticky_note::import_image_file`，与它的 IMAGE_SOURCE_EXTS 同一份清单：
 * 后端能解码的格式才允许进来，非 PNG 会统一转码成 PNG 落盘）。
 */
export const IMAGE_FILE_PATTERN = /\.(png|jpe?g|gif|bmp)$/i;
