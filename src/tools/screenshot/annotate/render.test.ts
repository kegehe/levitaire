import { describe, it, expect } from "vitest";
import { normalizeRect, arrowHead, renderAll, drawEditHandles } from "./render";
import type { Annotation } from "./types";

/** 计数用的 canvas stub：只关心「画了几次」。 */
function makeCtx() {
  const calls = { drawImage: 0, strokeRect: 0, rect: 0, arc: 0, fill: 0, stroke: 0 };
  const ctx = {
    canvas: { width: 100, height: 100 },
    clearRect() {},
    drawImage() {
      calls.drawImage++;
    },
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    closePath() {},
    arc() {
      calls.arc++;
    },
    stroke() {
      calls.stroke++;
    },
    fill() {
      calls.fill++;
    },
    strokeRect() {
      calls.strokeRect++;
    },
    fillRect() {},
    fillText() {},
    rect() {
      calls.rect++;
    },
    setLineDash() {},
    measureText: () => ({ width: 10 }) as TextMetrics,
    getImageData: () => ({ data: [0, 0, 0, 255] }) as unknown as ImageData,
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    lineJoin: "",
    lineCap: "",
    font: "",
    textBaseline: "",
    textAlign: "",
    imageSmoothingEnabled: false,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const rectAnn: Annotation = {
  id: "r",
  kind: "rect",
  color: "#000000",
  strokeWidth: 3,
  x: 0,
  y: 0,
  w: 10,
  h: 10,
};

describe("renderAll 编辑预览：同 id 用 draft 顶替，不重影", () => {
  it("draft 与已生效标注同 id：只画一次", () => {
    const { ctx, calls } = makeCtx();
    renderAll(ctx, null, [rectAnn], { ...rectAnn, w: 20 });
    expect(calls.strokeRect).toBe(1);
  });

  it("draft 是新 id（新增绘制）：两条都画", () => {
    const { ctx, calls } = makeCtx();
    renderAll(ctx, null, [rectAnn], { ...rectAnn, id: "r2" });
    expect(calls.strokeRect).toBe(2);
  });
});

describe("drawEditHandles", () => {
  it("框类画 8 个手柄方块", () => {
    const { ctx, calls } = makeCtx();
    drawEditHandles(ctx, rectAnn, 2);
    expect(calls.rect).toBe(8);
    expect(calls.arc).toBe(0);
  });

  it("箭头端点画圆点（不是方块）", () => {
    const { ctx, calls } = makeCtx();
    const arrow: Annotation = {
      id: "a",
      kind: "arrow",
      color: "#000000",
      strokeWidth: 3,
      x1: 0,
      y1: 0,
      x2: 10,
      y2: 10,
    };
    drawEditHandles(ctx, arrow, 1);
    expect(calls.arc).toBe(2);
    expect(calls.rect).toBe(0);
  });

  it("移动类（无手柄点）画一次虚线包围盒", () => {
    const { ctx, calls } = makeCtx();
    const brush: Annotation = {
      id: "b",
      kind: "brush",
      color: "#000000",
      strokeWidth: 3,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
    };
    drawEditHandles(ctx, brush, 1);
    expect(calls.strokeRect).toBe(1);
    expect(calls.rect).toBe(0);
  });
});

describe("normalizeRect", () => {
  it("两点任意顺序归一化为左上+正宽高", () => {
    expect(normalizeRect(10, 10, 30, 40)).toEqual({ x: 10, y: 10, w: 20, h: 30 });
    expect(normalizeRect(30, 40, 10, 10)).toEqual({ x: 10, y: 10, w: 20, h: 30 });
  });

  it("同点产生零宽高", () => {
    expect(normalizeRect(5, 5, 5, 5)).toEqual({ x: 5, y: 5, w: 0, h: 0 });
  });
});

describe("arrowHead", () => {
  it("水平向右箭头的两侧翼点位于终点附近", () => {
    const head = arrowHead(0, 0, 100, 0, 10);
    // 终点 (100,0)，头长 10，半张 spread=5
    // 根部 bx=90,by=0；垂直方向 px=0,py=1 → 左翼 (90,5)，右翼 (90,-5)
    expect(head.lx).toBeCloseTo(90);
    expect(head.ly).toBeCloseTo(5);
    expect(head.rx).toBeCloseTo(90);
    expect(head.ry).toBeCloseTo(-5);
  });

  it("零长度向量返回终点本身", () => {
    const head = arrowHead(5, 5, 5, 5, 10);
    expect(head).toEqual({ lx: 5, ly: 5, rx: 5, ry: 5 });
  });
});
