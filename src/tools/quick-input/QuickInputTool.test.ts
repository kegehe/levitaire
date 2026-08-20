import { describe, it, expect } from "vitest";
import { clampWheelCenter, fitText, textWidth } from "./QuickInputTool";

describe("clampWheelCenter", () => {
  // 参照场景：1080p 主屏，任务栏占底部 40px，窗口半宽高 160
  const workArea = { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } };
  const half = 160;

  it("光标在屏幕中间时不发生位移", () => {
    expect(clampWheelCenter(960, 520, half, workArea)).toEqual({ x: 960, y: 520 });
  });

  it("贴近左缘时回弹，保证窗口完整落在工作区内", () => {
    expect(clampWheelCenter(10, 520, half, workArea)).toEqual({ x: 160, y: 520 });
  });

  it("贴近右缘时回弹", () => {
    expect(clampWheelCenter(1919, 520, half, workArea)).toEqual({ x: 1920 - 160, y: 520 });
  });

  it("贴近上缘时回弹", () => {
    expect(clampWheelCenter(960, 5, half, workArea)).toEqual({ x: 960, y: 160 });
  });

  it("贴近下缘（任务栏上方）时回弹", () => {
    expect(clampWheelCenter(960, 1039, half, workArea)).toEqual({ x: 960, y: 1040 - 160 });
  });

  it("工作区信息缺失时保持原坐标（回退旧行为）", () => {
    expect(clampWheelCenter(10, 1039, half, null)).toEqual({ x: 10, y: 1039 });
  });

  it("工作区小于窗口时范围反转，不做钳制保留原坐标", () => {
    const tiny = { position: { x: 0, y: 0 }, size: { width: 200, height: 200 } };
    expect(clampWheelCenter(100, 100, 160, tiny)).toEqual({ x: 100, y: 100 });
  });

  it("多显示器：工作区原点为负（主屏左侧的副屏）时仍正确回弹", () => {
    const leftMonitor = { position: { x: -1920, y: 0 }, size: { width: 1920, height: 1080 } };
    // 副屏左缘（虚拟桌面最左，x=-1920），钳制后中心距左缘 half
    expect(clampWheelCenter(-1920, 540, half, leftMonitor)).toEqual({
      x: -1920 + half,
      y: 540,
    });
  });
});

describe("textWidth", () => {
  it("全宽（CJK）字符按 1em 计，其余按 0.55em 计", () => {
    // 一个汉字 + 一个半宽字母
    expect(textWidth("中文ab", 10)).toBeCloseTo(10 + 10 + 5.5 + 5.5);
  });

  it("空字符串宽度为 0", () => {
    expect(textWidth("", 12)).toBe(0);
  });

  it("省略号按半宽字符估算", () => {
    expect(textWidth("…", 10)).toBeCloseTo(5.5);
  });
});

describe("fitText", () => {
  it("宽度未超限时原样返回", () => {
    expect(fitText("短文本", 100, 12)).toBe("短文本");
  });

  it("宽度超限时按宽度截断并追加省略号，且截断后宽度不超过上限", () => {
    const label = "剪贴板历史记录";
    const out = fitText(label, 60, 12);
    expect(out.endsWith("…")).toBe(true);
    expect(textWidth(out, 12)).toBeLessThanOrEqual(60);
    expect(out.length).toBeLessThan(label.length);
  });

  it("英文长文本同样按宽度截断", () => {
    const out = fitText("https://github.com/example/repo", 50, 12);
    expect(out.endsWith("…")).toBe(true);
    expect(textWidth(out, 12)).toBeLessThanOrEqual(50);
  });

  it("上限过窄时至少保留省略号", () => {
    const out = fitText("文本", 3, 12);
    expect(out.endsWith("…")).toBe(true);
  });
});
