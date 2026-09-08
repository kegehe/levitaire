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
