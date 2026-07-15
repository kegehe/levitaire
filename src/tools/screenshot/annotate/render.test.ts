import { describe, it, expect } from "vitest";
import { normalizeRect, arrowHead } from "./render";

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
