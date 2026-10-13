import { describe, it, expect } from "vitest";
import {
  annotationBounds,
  applyEditZone,
  handlePoints,
  hitTestAnnotation,
  toleranceFor,
  withStrokeWidth,
  zoneCursor,
  type HitTolerance,
} from "./edit";
import type { Annotation } from "./types";

const TOL: HitTolerance = { edge: 6, corner: 10 };

function rect(overrides: Partial<Extract<Annotation, { kind: "rect" }>> = {}): Annotation {
  return {
    id: "r",
    kind: "rect",
    color: "#000000",
    strokeWidth: 3,
    x: 10,
    y: 20,
    w: 100,
    h: 50,
    ...overrides,
  };
}

function arrow(): Annotation {
  return { id: "a", kind: "arrow", color: "#000000", strokeWidth: 3, x1: 0, y1: 0, x2: 100, y2: 0 };
}

function brush(): Annotation {
  return {
    id: "b",
    kind: "brush",
    color: "#000000",
    strokeWidth: 4,
    points: [
      { x: 0, y: 0 },
      { x: 50, y: 50 },
    ],
  };
}

function text(): Annotation {
  return {
    id: "t",
    kind: "text",
    color: "#000000",
    strokeWidth: 3,
    x: 0,
    y: 0,
    fontSize: 20,
    text: "hello",
  };
}

function number(): Annotation {
  return {
    id: "n",
    kind: "number",
    color: "#000000",
    strokeWidth: 3,
    x: 100,
    y: 100,
    radius: 12,
    fontSize: 20,
    n: 1,
  };
}

describe("toleranceFor", () => {
  it("随缩放放大，并有下限", () => {
    expect(toleranceFor(1)).toEqual({ edge: 6, corner: 10 });
    expect(toleranceFor(2)).toEqual({ edge: 12, corner: 20 });
    // 低 DPI 也不小于手感下限
    expect(toleranceFor(0.5)).toEqual({ edge: 4, corner: 6 });
  });
});

describe("annotationBounds", () => {
  it("各 kind 的包围盒", () => {
    expect(annotationBounds(rect())).toEqual({ x: 10, y: 20, w: 100, h: 50 });
    expect(annotationBounds(arrow())).toEqual({ x: 0, y: 0, w: 100, h: 0 });
    // 画笔：点包围盒外扩半个线宽（4/2=2）
    expect(annotationBounds(brush())).toEqual({ x: -2, y: -2, w: 54, h: 54 });
    // 文字：宽按字符估算（半角 0.6 em）并与字号取较大者；高=字号×1.2×行数
    expect(annotationBounds(text())).toEqual({ x: 0, y: 0, w: 60, h: 24 });
    // 序号：圆包围盒
    expect(annotationBounds(number())).toEqual({ x: 88, y: 88, w: 24, h: 24 });
  });

  it("文字：中文按全宽（1 em）估算，命中区不会窄于可见文字", () => {
    const cjk: Annotation = {
      id: "t2",
      kind: "text",
      color: "#000000",
      strokeWidth: 3,
      x: 0,
      y: 0,
      fontSize: 20,
      text: "标注文字",
    };
    // 4 个汉字 × 1 em × 20 = 80
    expect(annotationBounds(cjk)).toEqual({ x: 0, y: 0, w: 80, h: 24 });
    // 压在文字右半边应能命中整体移动
    expect(hitTestAnnotation(cjk, 70, 10, TOL)).toBe("body");
  });
});

describe("hitTestAnnotation", () => {
  it("矩形：四角优先于四边，边优先于内部", () => {
    expect(hitTestAnnotation(rect(), 10, 20, TOL)).toBe("nw");
    expect(hitTestAnnotation(rect(), 110, 70, TOL)).toBe("se");
    expect(hitTestAnnotation(rect(), 110, 45, TOL)).toBe("e");
    expect(hitTestAnnotation(rect(), 60, 20, TOL)).toBe("n");
    expect(hitTestAnnotation(rect(), 60, 45, TOL)).toBe("body");
  });

  it("矩形：容差之外不命中", () => {
    // 距右边 8 > edge 6，且已在框外
    expect(hitTestAnnotation(rect(), 118, 45, TOL)).toBeNull();
    expect(hitTestAnnotation(rect(), 300, 300, TOL)).toBeNull();
  });

  it("箭头：两端优先，其次线段附近", () => {
    expect(hitTestAnnotation(arrow(), 0, 0, TOL)).toBe("end1");
    expect(hitTestAnnotation(arrow(), 100, 0, TOL)).toBe("end2");
    // 线段上/近旁（容差 edge + 半线宽 = 6 + 1.5）
    expect(hitTestAnnotation(arrow(), 50, 2, TOL)).toBe("body");
    expect(hitTestAnnotation(arrow(), 50, 20, TOL)).toBeNull();
  });

  // 角/端点容差固定时，小图形会被四角（两端）命中区整块吞掉，只剩缩放、无法整体移动。
  it("小框仍能整体移动：角容差随短边收缩，中间留出 body 区", () => {
    const small = rect({ x: 0, y: 0, w: 16, h: 16 });
    expect(hitTestAnnotation(small, 8, 8, TOL)).toBe("body");
    // 角与边仍然可缩放
    expect(hitTestAnnotation(small, 0, 0, TOL)).toBe("nw");
    expect(hitTestAnnotation(small, 16, 8, TOL)).toBe("e");
  });

  it("短箭头仍能整体移动：端点容差随杆长收缩", () => {
    const shortArrow: Annotation = {
      id: "sa",
      kind: "arrow",
      color: "#000000",
      strokeWidth: 3,
      x1: 0,
      y1: 0,
      x2: 10,
      y2: 0,
    };
    expect(hitTestAnnotation(shortArrow, 5, 0, TOL)).toBe("body");
    expect(hitTestAnnotation(shortArrow, 0, 0, TOL)).toBe("end1");
  });

  it("画笔：折线附近命中整体，远处不命中", () => {
    expect(hitTestAnnotation(brush(), 25, 25, TOL)).toBe("body");
    expect(hitTestAnnotation(brush(), 25, 60, TOL)).toBeNull();
  });

  it("文字/序号：包围盒（含容差）内命中整体", () => {
    expect(hitTestAnnotation(text(), 5, 5, TOL)).toBe("body");
    expect(hitTestAnnotation(text(), 200, 200, TOL)).toBeNull();
    expect(hitTestAnnotation(number(), 100, 100, TOL)).toBe("body");
    // 包围盒 88..112，外加容差 6 → 118 之外不算命中
    expect(hitTestAnnotation(number(), 130, 100, TOL)).toBeNull();
  });
});

describe("applyEditZone", () => {
  it("body：整体平移，尺寸不变", () => {
    expect(applyEditZone(rect(), "body", 5, -3, 4)).toMatchObject({ x: 15, y: 17, w: 100, h: 50 });
    expect(applyEditZone(arrow(), "body", 5, -3, 4)).toMatchObject({
      x1: 5,
      y1: -3,
      x2: 105,
      y2: -3,
    });
    expect(applyEditZone(brush(), "body", 5, -3, 4)).toMatchObject({
      points: [
        { x: 5, y: -3 },
        { x: 55, y: 47 },
      ],
    });
    expect(applyEditZone(text(), "body", 5, -3, 4)).toMatchObject({ x: 5, y: -3 });
    expect(applyEditZone(number(), "body", 5, -3, 4)).toMatchObject({ x: 105, y: 97 });
  });

  it("矩形缩放：对侧边固定", () => {
    expect(applyEditZone(rect(), "e", 20, 0, 4)).toMatchObject({ x: 10, w: 120 });
    expect(applyEditZone(rect(), "w", 20, 0, 4)).toMatchObject({ x: 30, w: 80 });
    expect(applyEditZone(rect(), "n", 0, -10, 4)).toMatchObject({ y: 10, h: 60 });
    expect(applyEditZone(rect(), "se", 20, 10, 4)).toMatchObject({ x: 10, y: 20, w: 120, h: 60 });
    expect(applyEditZone(rect(), "nw", -10, -10, 4)).toMatchObject({ x: 0, y: 10, w: 110, h: 60 });
  });

  it("矩形缩放：最小尺寸钳制（退让被拖的那条边，不翻转）", () => {
    // 拖右边过度向左：右边停在左边 + minSize
    expect(applyEditZone(rect(), "e", -500, 0, 4)).toMatchObject({ x: 10, w: 4 });
    // 拖左边过度向右：左边停在右边 - minSize
    expect(applyEditZone(rect(), "w", 500, 0, 4)).toMatchObject({ x: 106, w: 4 });
  });

  it("箭头：拖端点只改该端点", () => {
    expect(applyEditZone(arrow(), "end2", 10, 10, 4)).toMatchObject({
      x1: 0,
      y1: 0,
      x2: 110,
      y2: 10,
    });
    expect(applyEditZone(arrow(), "end1", 10, 10, 4)).toMatchObject({
      x1: 10,
      y1: 10,
      x2: 100,
      y2: 0,
    });
  });

  it("移动类标注不支持缩放部位：原样返回", () => {
    const t = text();
    expect(applyEditZone(t, "e", 50, 50, 4)).toBe(t);
  });
});

describe("handlePoints / zoneCursor", () => {
  it("矩形 8 个手柄（四边四角），箭头 2 个端点，其它无手柄", () => {
    const rectHandles = handlePoints(rect());
    expect(rectHandles).toHaveLength(8);
    expect(rectHandles[0]).toMatchObject({ zone: "nw", x: 10, y: 20 });
    expect(rectHandles.find((h) => h.zone === "n")).toMatchObject({ x: 60, y: 20 });
    expect(handlePoints(arrow()).map((h) => h.zone)).toEqual(["end1", "end2"]);
    expect(handlePoints(brush())).toEqual([]);
  });

  it("部位 → 光标", () => {
    expect(zoneCursor("body")).toBe("move");
    expect(zoneCursor("e")).toBe("ew-resize");
    expect(zoneCursor("n")).toBe("ns-resize");
    expect(zoneCursor("se")).toBe("nwse-resize");
    expect(zoneCursor("ne")).toBe("nesw-resize");
    expect(zoneCursor("end1")).toBe("crosshair");
  });
});

describe("withStrokeWidth（滚轮调线宽用）", () => {
  it("只改线宽，不动 id 与几何", () => {
    expect(withStrokeWidth(rect(), 12)).toMatchObject({
      id: "r",
      kind: "rect",
      x: 10,
      y: 20,
      w: 100,
      h: 50,
      strokeWidth: 12,
    });
  });

  it("线宽取整并钳制在 [1,32]", () => {
    expect(withStrokeWidth(rect(), 0).strokeWidth).toBe(1);
    expect(withStrokeWidth(rect(), 999).strokeWidth).toBe(32);
    expect(withStrokeWidth(rect(), 7.6).strokeWidth).toBe(8);
  });

  it("文字：字号随线宽重算，与新建口径一致", () => {
    const next = withStrokeWidth(text(), 8) as Extract<Annotation, { kind: "text" }>;
    expect(next.strokeWidth).toBe(8);
    expect(next.fontSize).toBe(48);
    expect(next.text).toBe("hello");
  });

  it("序号：半径与字号随线宽重算", () => {
    const next = withStrokeWidth(number(), 8) as Extract<Annotation, { kind: "number" }>;
    expect(next.radius).toBe(20);
    expect(next.fontSize).toBe(24);
    expect(next.n).toBe(1);
  });

  it("画笔/箭头：只改线宽，points 与端点不动", () => {
    const b = withStrokeWidth(brush(), 6) as Extract<Annotation, { kind: "brush" }>;
    expect(b.strokeWidth).toBe(6);
    expect(b.points).toHaveLength(2);
    const a = withStrokeWidth(arrow(), 6) as Extract<Annotation, { kind: "arrow" }>;
    expect(a).toMatchObject({ x1: 0, y1: 0, x2: 100, y2: 0, strokeWidth: 6 });
  });
});
