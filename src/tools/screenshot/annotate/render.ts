import type { Annotation, NumberAnnotation, TextAnnotation } from "./types";
import { COLOR_AUTO, DEFAULT_COLOR } from "./types";
import { annotationBounds, handlePoints } from "./edit";

// 自动配色采样用临时 1×1 canvas，模块级复用避免每次新建
// （与马赛克无关：马赛克只需要一张降采样小图，见下方 pixelatedSource）
let colorSampleCanvas: HTMLCanvasElement | null = null;

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
  if (!colorSampleCanvas) colorSampleCanvas = document.createElement("canvas");
  const tmp = colorSampleCanvas;
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

/**
 * 彩色画笔的平滑路径：相邻点中点 + quadraticCurveTo。
 * 马赛克不共用这一段 —— 它要的是「以路径为中心的带子」而不是一条细线，见 traceBandPath。
 */
function traceBrushPath(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[]) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
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
}

function drawBrush(ctx: CanvasRenderingContext2D, a: Annotation) {
  if (a.kind !== "brush" || a.points.length < 2) return;
  const c = a.color === COLOR_AUTO ? DEFAULT_COLOR : a.color;
  ctx.save();
  ctx.strokeStyle = c;
  ctx.lineWidth = a.strokeWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  traceBrushPath(ctx, a.points);
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

// 整张底图降采样后的缓存：同一张底图只算一次，之后每帧只做一次 drawImage。
// 缓存的是「小图」而不是放大的马赛克图：小图只有 (w/块, h/块) 大小（4K 图 + 10px 块 ≈ 384×216），
// 放大交给 GPU 做最近邻插值；否则每个标注都得存一份全尺寸位图，一次涂抹就是几十 MB。
// 键用 WeakMap（底图对象）：截图工具关掉后，缓存不会把上一张截图（解码后几十 MB）一直攥在模块里。
const mosaicSources = new WeakMap<HTMLImageElement, Map<number, HTMLCanvasElement>>();

/** 取（或重建）底图的降采样小图。缩小过程开启平滑，等价于对每个块取平均色。 */
function pixelatedSource(img: HTMLImageElement, blockSize: number): HTMLCanvasElement | null {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return null;
  const cached = mosaicSources.get(img)?.get(blockSize);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(w / blockSize));
  canvas.height = Math.max(1, Math.ceil(h / blockSize));
  const c = canvas.getContext("2d");
  if (!c) return null;
  // 缩小一个数量级，默认的双线性只采到极少数像素、块色会忽深忽浅；
  // 高质量滤波才接近「块内平均色」，马赛克块之间才不会花。
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = "high";
  c.drawImage(img, 0, 0, canvas.width, canvas.height);
  let bySize = mosaicSources.get(img);
  if (!bySize) {
    bySize = new Map();
    mosaicSources.set(img, bySize);
  }
  bySize.set(blockSize, canvas);
  return canvas;
}

/**
 * 笔迹带：以路径为中心、半径 r 的「粗线」轮廓。
 *
 * 不能直接 `ctx.stroke()` 后当剪裁区用 —— clip() 只认**填充区域**，描边的线宽不算在内。
 * 所以这里把每一段折线摊成矩形、每个顶点与端点补上圆，合成一条路径：
 * 这几个子路径互相重叠，按非零填充规则自然并成一条圆头圆角的带子，正好等于画笔描出来的形状。
 * 相邻采样点间距只有 2px，直接用折线不会有可见的棱角（彩色画笔那条用二次曲线平滑是为了笔锋，
 * 马赛克按块打码，边界本来就会被块网格吃掉）。
 */
function traceBandPath(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[],
  radius: number,
) {
  ctx.beginPath();
  if (pts.length === 1) {
    ctx.arc(pts[0].x, pts[0].y, radius, 0, Math.PI * 2);
    return;
  }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) continue;
    const nx = (-dy / len) * radius;
    const ny = (dx / len) * radius;
    // 四边形顶点：按带号面积统一成同一绕向。非零填充下绕向相反的区块会互相抵消，
    // 来回涂抹时（笔迹自己压自己）就会在交叠处挖出透明的洞，必须先把绕向归一。
    const quad: [number, number][] = [
      [a.x + nx, a.y + ny],
      [b.x + nx, b.y + ny],
      [b.x - nx, b.y - ny],
      [a.x - nx, a.y - ny],
    ];
    const area =
      quad[0][0] * quad[1][1] -
      quad[1][0] * quad[0][1] +
      (quad[1][0] * quad[2][1] - quad[2][0] * quad[1][1]) +
      (quad[2][0] * quad[3][1] - quad[3][0] * quad[2][1]) +
      (quad[3][0] * quad[0][1] - quad[0][0] * quad[3][1]);
    const ordered = area >= 0 ? quad : quad.slice().reverse();
    ctx.moveTo(ordered[0][0], ordered[0][1]);
    for (let k = 1; k < ordered.length; k++) ctx.lineTo(ordered[k][0], ordered[k][1]);
    ctx.closePath();
  }
  // 关节与两端圆头（圆头画笔的形状）。arc 从 0 画到 2π 的绕向与上面的四边形一致。
  for (const p of pts) {
    ctx.moveTo(p.x + radius, p.y);
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  }
}

/**
 * 马赛克：把「笔迹覆盖到的」底图换成马赛克，其余像素保持原样。
 *
 * 做法是拿笔迹带当剪裁区，把降采样小图最近邻放大后贴在笔迹包围盒上：
 * - 小图每个像素正好是一个马赛克块，放大后块网格对齐底图原点，跨笔画的块也严丝合缝；
 * - 每帧只有一次 drawImage，且面积只有笔迹那块，不像原先逐块循环那样几千次调用；
 * - 不需要任何离屏画布，涂抹过程中没有每帧新建/清空全尺寸位图的开销。
 */
function drawMosaic(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  baseImg: HTMLImageElement | null,
) {
  if (a.kind !== "mosaic") return;
  if (!baseImg) return;
  const pts = a.points;
  if (pts.length === 0) return;
  const bs = Math.max(1, Math.round(a.blockSize));
  const small = pixelatedSource(baseImg, bs);
  if (!small) return;

  // 只贴笔迹包围盒那一块（对齐到块网格），不把整张底图缩放着画一遍：
  // 源矩形与目标矩形都落在块网格上，块的位置和「整图铺满」逐像素一致。
  const radius = a.strokeWidth / 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  // 小图铺满后覆盖的实际范围：末尾那个块可能越过底图边缘，按它来夹取
  const gridW = small.width * bs;
  const gridH = small.height * bs;
  const bx = Math.max(0, Math.min(gridW, Math.floor((minX - radius) / bs) * bs));
  const by = Math.max(0, Math.min(gridH, Math.floor((minY - radius) / bs) * bs));
  const bx2 = Math.max(0, Math.min(gridW, Math.ceil((maxX + radius) / bs) * bs));
  const by2 = Math.max(0, Math.min(gridH, Math.ceil((maxY + radius) / bs) * bs));
  const bw = bx2 - bx;
  const bh = by2 - by;
  if (bw <= 0 || bh <= 0) return;

  ctx.save();
  traceBandPath(ctx, pts, radius);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, bx / bs, by / bs, bw / bs, bh / bs, bx, by, bw, bh);
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

// 编辑手柄颜色接近品牌蓝；canvas 里读不到 CSS 变量，故与 cursorSkin 一样写死常量。
const HANDLE_COLOR = "#1E88E5";

/**
 * 选中标注的编辑手柄：矩形画 8 个方块（四边四角），箭头画两个端点圆点，
 * 只能整体移动的（画笔/马赛克/文字/序号）画虚线包围盒。尺寸随 scale 放大，1× 与高 DPI 下手感一致。
 */
export function drawEditHandles(ctx: CanvasRenderingContext2D, a: Annotation, scale: number) {
  const points = handlePoints(a);
  const line = Math.max(1, 1.5 * scale);
  ctx.save();
  ctx.strokeStyle = HANDLE_COLOR;
  ctx.lineWidth = line;

  if (points.length === 0) {
    const b = annotationBounds(a);
    ctx.setLineDash([6 * scale, 4 * scale]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.restore();
    return;
  }

  const size = 8 * scale;
  const half = size / 2;
  ctx.setLineDash([]);
  for (const p of points) {
    ctx.beginPath();
    // 箭头端点是「点」，画圆点；框类的边/角是「拉伸点」，画方块。
    if (p.zone === "end1" || p.zone === "end2") {
      ctx.arc(p.x, p.y, half, 0, Math.PI * 2);
    } else {
      ctx.rect(p.x - half, p.y - half, size, size);
    }
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

// 整体重绘：清空→底图→已生效标注→draft→选中手柄。
// draft 与某条已生效标注同 id 时（编辑预览），跳过已生效那条、用 draft 顶替，避免重影；
// 新增绘制时 draft.id 是新的，该跳过完全惰性。
export function renderAll(
  ctx: CanvasRenderingContext2D,
  baseImg: HTMLImageElement | null,
  committed: Annotation[],
  draft: Annotation | null,
  selected: Annotation | null = null,
  scale = 1,
) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (baseImg) {
    ctx.drawImage(baseImg, 0, 0);
  }
  for (const a of committed) {
    if (draft && a.id === draft.id) continue;
    drawAnnotation(ctx, a, baseImg);
  }
  if (draft) drawAnnotation(ctx, draft, baseImg);
  if (selected) drawEditHandles(ctx, selected, scale);
}
