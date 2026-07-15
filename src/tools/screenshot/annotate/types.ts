// 标注数据模型。坐标均为「画布内部物理像素」，与底图 image.width/height 同坐标系。

export type ToolKind = "rect" | "arrow" | "brush" | "text" | "number" | "mosaic";

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

// 粗细三档（物理像素），0/1/2 对应细/中/粗
export const STROKE_WIDTHS = [3, 5, 8];

export const DEFAULT_TOOL: ToolKind = "rect";
export const DEFAULT_COLOR = "#E53935";
export const DEFAULT_WIDTH_INDEX = 1;

export function strokeWidthFor(index: number): number {
  return STROKE_WIDTHS[index] ?? STROKE_WIDTHS[1];
}

// 文字字号随粗细档位放大，保证可读
export function fontSizeFor(index: number): number {
  return (STROKE_WIDTHS[index] ?? STROKE_WIDTHS[1]) * 6;
}
