import type { Annotation, NumberAnnotation, TextAnnotation } from "./types";
import { COLOR_AUTO, DEFAULT_COLOR } from "./types";

// 马赛克降采样用临时 1×1 canvas，模块级复用避免每块新建
let mosaicTmpCanvas: HTMLCanvasElement | null = null;

// 把 "auto" 解析为实际颜色：采样底图指定区域平均亮度，亮→黑、暗→白。
// 非 auto 直接返回原值。底图不可用时 fallback 到默认色。
function resolveColor(
  color: string,
  baseImg: HTMLImageElement | null,
  x: number,
  y: number,
  w: number,
  h: number,
): string {
  if (color !== COLOR_AUTO) return color;
  if (!baseImg) return DEFAULT_COLOR;
  if (!mosaicTmpCanvas) mosaicTmpCanvas = document.createElement("canvas");
  const tmp = mosaicTmpCanvas;
  tmp.width = 1;
  tmp.height = 1;
  const tctx = tmp.getContext("2d");
  if (!tctx) return DEFAULT_COLOR;
  tctx.clearRect(0, 0, 1, 1);
  tctx.drawImage(baseImg, x, y, Math.max(1, w), Math.max(1, h), 0, 0, 1, 1);
  const data = tctx.getImageData(0, 0, 1, 1).data;
  // 标准 ITU-R 亮度
  const brightness = 0.299 * data[0] + 0.587 * data[1] + 0.114 * data[2];
  return brightness > 140 ? "#000000" : "#FFFFFF";
}

// 纯几何：把任意两点归一化为左上+右下（正矩形）
export function normalizeRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

// 箭头头两点（返回两侧翼端点），headLen 为头长、angle 为半张角
export function arrowHead(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  headLen: number,
): { lx: number; ly: number; rx: number; ry: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) return { lx: x2, ly: y2, rx: x2, ry: y2 };
  const ux = dx / len;
  const uy = dy / len;
  // 头根部从终点向起点回退 headLen
  const bx = x2 - ux * headLen;
  const by = y2 - uy * headLen;
  // 垂直方向
  const px = -uy;
  const py = ux;
  const spread = headLen * 0.5;
  return {
    lx: bx + px * spread,
    ly: by + py * spread,
    rx: bx - px * spread,
    ry: by - py * spread,
  };
}

// 自适应文字颜色已由 resolveColor 实现于绘制时采样底图。

function drawRect(ctx: CanvasRenderingContext2D, a: Annotation) {
  if (a.kind !== "rect") return;
  // 描边类工具不支持 auto，fallback 到默认色
  const c = a.color === COLOR_AUTO ? DEFAULT_COLOR : a.color;
  ctx.save();
  ctx.strokeStyle = c;
  ctx.lineWidth = a.strokeWidth;
  ctx.lineJoin = "miter";
  ctx.strokeRect(a.x, a.y, a.w, a.h);
  ctx.restore();
}

function drawArrow(ctx: CanvasRenderingContext2D, a: Annotation) {
  if (a.kind !== "arrow") return;
  const len = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
  if (len < 1) return;
  const c = a.color === COLOR_AUTO ? DEFAULT_COLOR : a.color;
  const headLen = Math.max(a.strokeWidth * 4, 14);
  const head = arrowHead(a.x1, a.y1, a.x2, a.y2, headLen);
  ctx.save();
  ctx.strokeStyle = c;
  ctx.fillStyle = c;
  ctx.lineWidth = a.strokeWidth;
  ctx.lineCap = "round";
  // 主线缩短到头部根部，与箭头三角无缝衔接
  const ux = (a.x2 - a.x1) / len;
  const uy = (a.y2 - a.y1) / len;
  ctx.beginPath();
  ctx.moveTo(a.x1, a.y1);
  ctx.lineTo(a.x2 - ux * headLen, a.y2 - uy * headLen);
  ctx.stroke();
  // 箭头三角
  ctx.beginPath();
  ctx.moveTo(a.x2, a.y2);
  ctx.lineTo(head.lx, head.ly);
  ctx.lineTo(head.rx, head.ry);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBrush(ctx: CanvasRenderingContext2D, a: Annotation) {
  if (a.kind !== "brush" || a.points.length < 2) return;
  const c = a.color === COLOR_AUTO ? DEFAULT_COLOR : a.color;
  ctx.save();
  ctx.strokeStyle = c;
  ctx.lineWidth = a.strokeWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  const pts = a.points;
  ctx.moveTo(pts[0].x, pts[0].y);
  // 用相邻点中点 + quadraticCurveTo 平滑
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const prev = pts[i - 1];
    const mx = (prev.x + p.x) / 2;
    const my = (prev.y + p.y) / 2;
    ctx.quadraticCurveTo(prev.x, prev.y, mx, my);
  }
  // 最后一段直线收尾
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
  ctx.restore();
}

function drawText(ctx: CanvasRenderingContext2D, a: Annotation, baseImg: HTMLImageElement | null) {
  if (a.kind !== "text" || !a.text) return;
  const t = a as TextAnnotation;
  // 估算文字包围盒宽高用于采样底色
  ctx.save();
  ctx.font = `${t.fontSize}px sans-serif`;
  const approxW = Math.max(t.fontSize, ctx.measureText(t.text).width);
  const approxH = t.fontSize * 1.2 * t.text.split("\n").length;
  const c = resolveColor(t.color, baseImg, t.x, t.y, approxW, approxH);
  ctx.fillStyle = c;
  ctx.textBaseline = "top";
  // 多行支持
  const lines = t.text.split("\n");
  lines.forEach((line, i) => {
    ctx.fillText(line, t.x, t.y + i * t.fontSize * 1.2);
  });
  ctx.restore();
}

function drawNumber(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  baseImg: HTMLImageElement | null,
) {
  if (a.kind !== "number") return;
  const n = a as NumberAnnotation;
  // auto 时采样圆心区域底色，否则用标注色；数字用反色保证可读
  const bg = resolveColor(
    n.color,
    baseImg,
    n.x - n.radius,
    n.y - n.radius,
    n.radius * 2,
    n.radius * 2,
  );
  const fill = n.color === COLOR_AUTO ? bg : n.color;
  const numColor = fill === "#FFFFFF" ? "#000000" : "#FFFFFF";
  ctx.save();
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = numColor;
  ctx.font = `bold ${n.fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(n.n), n.x, n.y);
  ctx.restore();
}

function drawMosaic(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  baseImg: HTMLImageElement | null,
) {
  if (a.kind !== "mosaic") return;
  if (!baseImg) return;
  const { x, y, w, h, blockSize } = a;
  if (w < 1 || h < 1) return;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  // 逐块降采样：每块从底图缩到 1×1 像素，再放大回块尺寸，形成马赛克色块。
  // 用临时 canvas 中转，避免 drawImage 把大块直接缩 1px 时的插值差异。
  if (!mosaicTmpCanvas) mosaicTmpCanvas = document.createElement("canvas");
  const tmp = mosaicTmpCanvas;
  tmp.width = 1;
  tmp.height = 1;
  const tctx = tmp.getContext("2d");
  if (!tctx) {
    ctx.restore();
    return;
  }
  for (let by = 0; by < h; by += blockSize) {
    for (let bx = 0; bx < w; bx += blockSize) {
      const sw = Math.min(blockSize, w - bx);
      const sh = Math.min(blockSize, h - by);
      tctx.clearRect(0, 0, 1, 1);
      tctx.drawImage(baseImg, x + bx, y + by, sw, sh, 0, 0, 1, 1);
      ctx.drawImage(tmp, 0, 0, 1, 1, x + bx, y + by, sw, sh);
    }
  }
  ctx.restore();
}

export function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  baseImg: HTMLImageElement | null,
) {
  switch (a.kind) {
    case "rect":
      drawRect(ctx, a);
      break;
    case "arrow":
      drawArrow(ctx, a);
      break;
    case "brush":
      drawBrush(ctx, a);
      break;
    case "text":
      drawText(ctx, a, baseImg);
      break;
    case "number":
      drawNumber(ctx, a, baseImg);
      break;
    case "mosaic":
      drawMosaic(ctx, a, baseImg);
      break;
  }
}

// 整体重绘：清空→底图→已生效标注→draft
export function renderAll(
  ctx: CanvasRenderingContext2D,
  baseImg: HTMLImageElement | null,
  committed: Annotation[],
  draft: Annotation | null,
) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (baseImg) {
    ctx.drawImage(baseImg, 0, 0);
  }
  for (const a of committed) drawAnnotation(ctx, a, baseImg);
  if (draft) drawAnnotation(ctx, draft, baseImg);
}
