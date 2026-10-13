import { describe, it, expect } from "vitest";
import {
  clampStrokeWidth,
  DEFAULT_STROKE_WIDTH,
  fontSizeFor,
  MAX_STROKE_WIDTH,
  MIN_STROKE_WIDTH,
  numberFontSizeFor,
  numberRadiusFor,
} from "./types";

describe("clampStrokeWidth", () => {
  it("取整并夹在 [MIN, MAX]", () => {
    expect(MIN_STROKE_WIDTH).toBe(1);
    expect(MAX_STROKE_WIDTH).toBe(32);
    expect(clampStrokeWidth(0)).toBe(1);
    expect(clampStrokeWidth(-5)).toBe(1);
    expect(clampStrokeWidth(1)).toBe(1);
    expect(clampStrokeWidth(7.4)).toBe(7);
    expect(clampStrokeWidth(7.6)).toBe(8);
    expect(clampStrokeWidth(32)).toBe(32);
    expect(clampStrokeWidth(999)).toBe(32);
  });

  it("非法值回落到默认线宽", () => {
    expect(clampStrokeWidth(Number.NaN)).toBe(DEFAULT_STROKE_WIDTH);
    expect(clampStrokeWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_STROKE_WIDTH);
    expect(clampStrokeWidth(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_STROKE_WIDTH);
  });
});

describe("由线宽派生的尺寸（必须与原三档 3/5/8 完全一致）", () => {
  it("文字字号：3/5/8 → 18/30/48", () => {
    expect(fontSizeFor(3)).toBe(18);
    expect(fontSizeFor(5)).toBe(30);
    expect(fontSizeFor(8)).toBe(48);
  });

  it("文字字号下限 12（线宽很小时文字不至于看不清）", () => {
    expect(fontSizeFor(1)).toBe(12);
    expect(fontSizeFor(2)).toBe(12);
  });

  it("序号半径/字号随线宽放大，并有下限", () => {
    expect(numberRadiusFor(5)).toBe(12.5);
    expect(numberFontSizeFor(5)).toBe(15);
    // 下限：1*2.5=2.5 → 12；1*3=3 → 14
    expect(numberRadiusFor(1)).toBe(12);
    expect(numberFontSizeFor(1)).toBe(14);
  });
});
