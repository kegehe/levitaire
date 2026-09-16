import { describe, expect, it } from "vitest";
import { RING_CIRCUMFERENCE, RING_RADIUS, URGENT_SECONDS, ringHeadRotation } from "./ringGeometry";

/** 屏幕角（从 12 点起、顺时针为正）→ 归一化到 [0, 360) */
function normalize(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * 珠子的屏幕角 = 本地角 + 旋转角 + 外层 svg 的 -90°。
 * 本地角固定为 0：珠子写在 (cx=60, cy=10)，即本地 12 点。
 */
function headScreenAngle(progress: number): number {
  return normalize(0 + ringHeadRotation(progress) - 90);
}

describe("ringGeometry 进度环几何", () => {
  it("周长按 2πr 计算，与 strokeDasharray/offset 的取值一致", () => {
    expect(RING_CIRCUMFERENCE).toBeCloseTo(2 * Math.PI * RING_RADIUS, 6);
    expect(RING_CIRCUMFERENCE).toBeCloseTo(314.159, 3);
  });

  it("环头珠子落在弧尖上：屏幕角 = 进度 × 360°（从 12 点顺时针）", () => {
    // 漏掉外层 svg 自己的 -90° 时珠子会整体落后 90°，这几个断言正好卡住那种回归
    expect(headScreenAngle(0)).toBeCloseTo(0);
    expect(headScreenAngle(0.25)).toBeCloseTo(90);
    expect(headScreenAngle(0.5)).toBeCloseTo(180);
    expect(headScreenAngle(0.75)).toBeCloseTo(270);
    expect(headScreenAngle(1)).toBeCloseTo(0);
  });

  it("旋转角随进度单调递增（递减动画里珠子才会回走而不是绕远路）", () => {
    for (let progress = 0; progress < 1; progress += 0.1) {
      expect(ringHeadRotation(progress + 0.1)).toBeGreaterThan(ringHeadRotation(progress));
      expect(ringHeadRotation(progress + 0.1) - ringHeadRotation(progress)).toBeCloseTo(36, 6);
    }
  });

  it("强调阈值取正数且落在「最后一分钟」内", () => {
    expect(URGENT_SECONDS).toBeGreaterThan(0);
    expect(URGENT_SECONDS).toBeLessThanOrEqual(60);
  });
});
