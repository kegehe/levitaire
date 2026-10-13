// 截图标注「画完之后可调整」的几何与变换：纯函数，便于单测。
// 坐标一律是画布内部物理像素（与底图 image.width/height 同坐标系）。

import {
  clampStrokeWidth,
  fontSizeFor,
  numberFontSizeFor,
  numberRadiusFor,
  type Annotation,
} from "./types";

/**
 * 可拖动的部位：
 * - `body`：整体移动；
 * - `n|s|e|w|ne|nw|se|sw`：框类（矩形/马赛克）四边四角缩放；
 * - `end1|end2`：箭头两端。
 */
export type EditZone = "body" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "end1" | "end2";

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HitTolerance {
  /** 边/线的命中半径（物理像素） */
  edge: number;
  /** 角/端点的命中半径（物理像素） */
  corner: number;
}

export interface EditHit {
  annotation: Annotation;
  zone: EditZone;
}

export interface HandlePoint {
  zone: EditZone;
  x: number;
  y: number;
}

/** 命中容差随屏幕缩放放大，保证 1× 与高 DPI 下「手感」一致（单位：物理像素） */
export function toleranceFor(scale: number): HitTolerance {
  return { edge: Math.max(4, 6 * scale), corner: Math.max(6, 10 * scale) };
}

/**
 * 文字的近似包围盒。本模块是纯函数、拿不到 `ctx.measureText`，故按字符宽度估算：
 * 半角约 0.6 em、CJK 等宽字符约 1 em（若不区分，中文输入的命中区会明显窄于可见文字，
 * 导致鼠标压在文字右半边却抓不住）。命中测试只要够大能抓住即可，不要求像素级精确。
 */
function textWidth(line: string, fontSize: number): number {
  let units = 0;
  for (const ch of line) units += (ch.codePointAt(0) ?? 0) > 0x2e80 ? 1 : 0.6;
  return units * fontSize;
}

function textBounds(a: Extract<Annotation, { kind: "text" }>): Bounds {
  const lines = a.text.split("\n");
  let w = a.fontSize;
  for (const line of lines) w = Math.max(w, textWidth(line, a.fontSize));
  return { x: a.x, y: a.y, w, h: a.fontSize * 1.2 * lines.length };
}

export function annotationBounds(a: Annotation): Bounds {
  switch (a.kind) {
    case "rect":
    case "mosaic":
      return { x: a.x, y: a.y, w: a.w, h: a.h };
    case "arrow":
      return {
        x: Math.min(a.x1, a.x2),
        y: Math.min(a.y1, a.y2),
        w: Math.abs(a.x2 - a.x1),
        h: Math.abs(a.y2 - a.y1),
      };
    case "brush": {
      if (a.points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
      const pad = a.strokeWidth / 2;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of a.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
    }
    case "text":
      return textBounds(a);
    case "number":
      return { x: a.x - a.radius, y: a.y - a.radius, w: a.radius * 2, h: a.radius * 2 };
  }
}

function within(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/** 点到线段的距离 */
export function distanceToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
}

/** 框类（矩形/马赛克）的命中：四角 → 四边 → 内部 */
function hitBox(b: Bounds, px: number, py: number, tol: HitTolerance): EditZone | null {
  const x2 = b.x + b.w;
  const y2 = b.y + b.h;
  // 角容差随短边收缩：小框（短边 ≤ 3×角容差）若仍用固定角容差，整块都落在四角的命中区里、
  // 中间没有 body 区，就会「只能缩放、无法整体移动」。取 min(短边/3) 保证中间始终留出可移动区。
  const corner = Math.min(tol.corner, Math.min(b.w, b.h) / 3);
  const corners: [EditZone, number, number][] = [
    ["nw", b.x, b.y],
    ["ne", x2, b.y],
    ["sw", b.x, y2],
    ["se", x2, y2],
  ];
  for (const [zone, cx, cy] of corners) {
    if (Math.abs(px - cx) <= corner && Math.abs(py - cy) <= corner) return zone;
  }
  if (within(py, b.y - tol.edge, y2 + tol.edge)) {
    if (Math.abs(px - b.x) <= tol.edge) return "w";
    if (Math.abs(px - x2) <= tol.edge) return "e";
  }
  if (within(px, b.x - tol.edge, x2 + tol.edge)) {
    if (Math.abs(py - b.y) <= tol.edge) return "n";
    if (Math.abs(py - y2) <= tol.edge) return "s";
  }
  if (within(px, b.x, x2) && within(py, b.y, y2)) return "body";
  return null;
}

/** 命中测试：返回该标注被命中的部位，未命中返回 null */
export function hitTestAnnotation(
  a: Annotation,
  px: number,
  py: number,
  tol: HitTolerance,
): EditZone | null {
  if (a.kind === "arrow") {
    // 端点容差随杆长收缩：短箭若用固定角容差，两端命中区会盖满整条，同样会「只能改端点、无法整体移动」。
    const len = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
    const corner = Math.min(tol.corner, len / 3);
    if (Math.abs(px - a.x1) <= corner && Math.abs(py - a.y1) <= corner) return "end1";
    if (Math.abs(px - a.x2) <= corner && Math.abs(py - a.y2) <= corner) return "end2";
    return distanceToSegment(px, py, a.x1, a.y1, a.x2, a.y2) <= tol.edge + a.strokeWidth / 2
      ? "body"
      : null;
  }
  if (a.kind === "brush") {
    const pts = a.points;
    if (pts.length === 0) return null;
    if (pts.length === 1) {
      return Math.hypot(px - pts[0].x, py - pts[0].y) <= tol.edge + a.strokeWidth / 2
        ? "body"
        : null;
    }
    let best = Infinity;
    for (let i = 1; i < pts.length; i++) {
      best = Math.min(
        best,
        distanceToSegment(px, py, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y),
      );
    }
    return best <= tol.edge + a.strokeWidth / 2 ? "body" : null;
  }
  if (a.kind === "text" || a.kind === "number") {
    const b = annotationBounds(a);
    return within(px, b.x - tol.edge, b.x + b.w + tol.edge) &&
      within(py, b.y - tol.edge, b.y + b.h + tol.edge)
      ? "body"
      : null;
  }
  return hitBox(annotationBounds(a), px, py, tol);
}

/** 保证 [start, end] 至少有 minSize：退让正在被拖动的那一侧；两侧都在拖（角）则退 end */
function shrinkToMin(
  start: number,
  end: number,
  dragStart: boolean,
  dragEnd: boolean,
  minSize: number,
): { start: number; end: number } {
  if (end - start >= minSize) return { start, end };
  if (dragStart && !dragEnd) return { start: end - minSize, end };
  return { start, end: start + minSize };
}

/**
 * 按命中部位应用一次位移，返回新的标注（不修改原对象）。
 * 缩放时**对侧边固定**，并做最小尺寸钳制 —— 与选区调整的语义一致（见 ScreenshotTool.adjustSelection）。
 */
export function applyEditZone(
  a: Annotation,
  zone: EditZone,
  dx: number,
  dy: number,
  minSize: number,
): Annotation {
  if (zone === "body") {
    switch (a.kind) {
      case "rect":
      case "mosaic":
        return { ...a, x: a.x + dx, y: a.y + dy };
      case "arrow":
        return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
      case "brush":
        return { ...a, points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
      case "text":
      case "number":
        return { ...a, x: a.x + dx, y: a.y + dy };
    }
  }

  if (a.kind === "arrow") {
    if (zone === "end1") return { ...a, x1: a.x1 + dx, y1: a.y1 + dy };
    if (zone === "end2") return { ...a, x2: a.x2 + dx, y2: a.y2 + dy };
    return a;
  }

  if (a.kind !== "rect" && a.kind !== "mosaic") return a;

  const right0 = a.x + a.w;
  const bottom0 = a.y + a.h;
  const left = zone.includes("w") ? a.x + dx : a.x;
  const right = zone.includes("e") ? right0 + dx : right0;
  const top = zone.includes("n") ? a.y + dy : a.y;
  const bottom = zone.includes("s") ? bottom0 + dy : bottom0;
  const width = shrinkToMin(left, right, zone.includes("w"), zone.includes("e"), minSize);
  const height = shrinkToMin(top, bottom, zone.includes("n"), zone.includes("s"), minSize);
  return {
    ...a,
    x: width.start,
    y: height.start,
    w: width.end - width.start,
    h: height.end - height.start,
  };
}

/** 选中标注需要绘制的手柄点：框类 8 个（四边四角），箭头 2 个（两端）。其余返回空数组（只画虚线包围盒）。 */
export function handlePoints(a: Annotation): HandlePoint[] {
  if (a.kind === "rect" || a.kind === "mosaic") {
    const b = annotationBounds(a);
    const x2 = b.x + b.w;
    const y2 = b.y + b.h;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    return [
      { zone: "nw", x: b.x, y: b.y },
      { zone: "n", x: cx, y: b.y },
      { zone: "ne", x: x2, y: b.y },
      { zone: "e", x: x2, y: cy },
      { zone: "se", x: x2, y: y2 },
      { zone: "s", x: cx, y: y2 },
      { zone: "sw", x: b.x, y: y2 },
      { zone: "w", x: b.x, y: cy },
    ];
  }
  if (a.kind === "arrow") {
    return [
      { zone: "end1", x: a.x1, y: a.y1 },
      { zone: "end2", x: a.x2, y: a.y2 },
    ];
  }
  return [];
}

const ZONE_CURSORS: Record<EditZone, string> = {
  body: "move",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
  end1: "crosshair",
  end2: "crosshair",
};

export function zoneCursor(zone: EditZone): string {
  return ZONE_CURSORS[zone];
}

/**
 * 返回一个线宽改为 `strokeWidth` 的新标注（不修改原对象，也不动几何）。
 * 文字/序号的字号（以及序号的半径）是由线宽派生的，这里一并重算，与新建时的口径完全一致，
 * 否则滚轮只改 strokeWidth 时文字的 fontSize 会与线宽脱节。
 * 马赛克本来就不使用 strokeWidth（见 render.ts 的 drawMosaic），改它没有视觉变化。
 */
export function withStrokeWidth(a: Annotation, strokeWidth: number): Annotation {
  const w = clampStrokeWidth(strokeWidth);
  switch (a.kind) {
    case "text":
      return { ...a, strokeWidth: w, fontSize: fontSizeFor(w) };
    case "number":
      return { ...a, strokeWidth: w, radius: numberRadiusFor(w), fontSize: numberFontSizeFor(w) };
    default:
      return { ...a, strokeWidth: w };
  }
}
