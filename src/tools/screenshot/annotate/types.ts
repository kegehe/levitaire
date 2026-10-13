// 标注数据模型。坐标均为「画布内部物理像素」，与底图 image.width/height 同坐标系。

/** 会产生标注图形的工具（对应 Annotation 的 kind） */
export type ToolKind = "rect" | "arrow" | "brush" | "text" | "number" | "mosaic";

/**
 * 标注工具栏可选项：标注工具 + 移动工具。
 * 移动工具只调整选区（拖动选区移动、拖动四边四角改大小），不产生任何标注，
 * 因此不进 ToolKind / Annotation.kind —— 标注数据模型里不该出现"什么都不画"的 kind。
 */
export type ActiveTool = ToolKind | "move";

export interface BaseAnnotation {
  id: string;
  kind: ToolKind;
  color: string; // "#RRGGBB"，text/number 支持 "auto"（按底色自适应黑白）
  strokeWidth: number; // 物理像素
}

export interface RectAnnotation extends BaseAnnotation {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ArrowAnnotation extends BaseAnnotation {
  kind: "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface BrushAnnotation extends BaseAnnotation {
  kind: "brush";
  points: { x: number; y: number }[]; // 至少 2 点
}

export interface TextAnnotation extends BaseAnnotation {
  kind: "text";
  x: number;
  y: number; // 左上角基线锚点
  fontSize: number; // 物理像素
  text: string;
}

export interface NumberAnnotation extends BaseAnnotation {
  kind: "number";
  x: number;
  y: number; // 圆心
  radius: number;
  fontSize: number;
  n: number;
}

export interface MosaicAnnotation extends BaseAnnotation {
  kind: "mosaic";
  x: number;
  y: number;
  w: number;
  h: number;
  blockSize: number; // 降采样块大小，物理像素
}

export type Annotation =
  | RectAnnotation
  | ArrowAnnotation
  | BrushAnnotation
  | TextAnnotation
  | NumberAnnotation
  | MosaicAnnotation;

// 预设颜色：8 色 + auto（仅 text/number 用）
export const PRESET_COLORS = [
  "#E53935", // 红
  "#FB8C00", // 橙
  "#FDD835", // 黄
  "#43A047", // 绿
  "#1E88E5", // 蓝
  "#8E24AA", // 紫
  "#000000", // 黑
  "#FFFFFF", // 白
];

export const COLOR_AUTO = "auto";

// 默认落在移动工具上：截图完成后的第一诉求通常是微调选区，而不是立刻画图形。
export const DEFAULT_TOOL: ActiveTool = "move";
export const DEFAULT_COLOR = "#E53935";

// 线宽（物理像素）：连续可调（滚轮/方向键每次 ±1），夹在 [MIN, MAX]。
export const MIN_STROKE_WIDTH = 1;
export const MAX_STROKE_WIDTH = 32;
export const DEFAULT_STROKE_WIDTH = 5;

/** 线宽只取整数并夹在允许范围内 */
export function clampStrokeWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_STROKE_WIDTH;
  return Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, Math.round(width)));
}

/**
 * 每种绘图工具（rect/arrow/brush/text/number/mosaic）各自独立的颜色与线宽。
 * 各工具互不影响：切换工具时，画布与工具栏都取该工具自己的设置。
 * 移动工具不产生标注，不进这张表。
 */
export interface ToolStyle {
  color: string;
  strokeWidth: number;
}

export type ToolStyles = Record<ToolKind, ToolStyle>;

export const DEFAULT_TOOL_STYLES: ToolStyles = {
  rect: { color: DEFAULT_COLOR, strokeWidth: DEFAULT_STROKE_WIDTH },
  arrow: { color: DEFAULT_COLOR, strokeWidth: DEFAULT_STROKE_WIDTH },
  brush: { color: DEFAULT_COLOR, strokeWidth: DEFAULT_STROKE_WIDTH },
  text: { color: DEFAULT_COLOR, strokeWidth: DEFAULT_STROKE_WIDTH },
  number: { color: DEFAULT_COLOR, strokeWidth: DEFAULT_STROKE_WIDTH },
  mosaic: { color: DEFAULT_COLOR, strokeWidth: DEFAULT_STROKE_WIDTH },
};

/**
 * 文字字号随线宽放大，保证可读；下限 12 避免线宽很小时文字小到看不清。
 * 原三档 3/5/8 上分别得 18/30/48，与旧的 fontSizeFor 完全一致。
 */
export function fontSizeFor(strokeWidth: number): number {
  return Math.max(12, Math.round(strokeWidth * 6));
}

// 序号的大小随线宽放大。原先内联在 AnnotationCanvas 里，收拢到这里与文字口径一致。
export function numberRadiusFor(strokeWidth: number): number {
  return Math.max(strokeWidth * 2.5, 12);
}

export function numberFontSizeFor(strokeWidth: number): number {
  return Math.max(strokeWidth * 3, 14);
}
