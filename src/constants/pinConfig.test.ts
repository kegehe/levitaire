import { describe, expect, it } from "vitest";
import {
  DEFAULT_PIN_BORDER_COLOR,
  normalizePinBorderColor,
  normalizePinBorderWidth,
} from "./pinConfig";

describe("pin border config", () => {
  it("normalizes valid colors and rejects malformed values", () => {
    expect(normalizePinBorderColor("#12abEF")).toBe("#12ABEF");
    expect(normalizePinBorderColor("#12345")).toBe(DEFAULT_PIN_BORDER_COLOR);
    expect(normalizePinBorderColor("rgb(1, 2, 3)")).toBe(DEFAULT_PIN_BORDER_COLOR);
  });

  it("only accepts the configured width options", () => {
    expect(normalizePinBorderWidth(1)).toBe(1);
    expect(normalizePinBorderWidth(8)).toBe(8);
    expect(normalizePinBorderWidth(0)).toBe(1);
    expect(normalizePinBorderWidth(2.5)).toBe(1);
  });
});
