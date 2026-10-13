import { describe, it, expect } from "vitest";
import {
  clampWheelCenter,
  fitText,
  getCapsuleGeometry,
  getHighlightedSector,
  getWheelItemLayout,
  snippetToWheelItem,
  textWidth,
} from "./QuickInputTool";

describe("getHighlightedSector", () => {
  const center = { x: 160, y: 160 };

  it("uses the keyup cursor position to select the matching sector", () => {
    expect(getHighlightedSector(160, 40, center, 1, 4)).toBe(0);
    expect(getHighlightedSector(280, 160, center, 1, 4)).toBe(1);
    expect(getHighlightedSector(160, 280, center, 1, 4)).toBe(2);
    expect(getHighlightedSector(40, 160, center, 1, 4)).toBe(3);
  });

  it("does not select an item inside the DPI-scaled center dead zone", () => {
    expect(getHighlightedSector(190, 160, center, 2, 4)).toBe(-1);
    expect(getHighlightedSector(197, 160, center, 2, 4)).toBe(1);
  });

  it("returns no selection when there are no wheel items", () => {
    expect(getHighlightedSector(160, 40, center, 1, 0)).toBe(-1);
  });
});

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

describe("getWheelItemLayout", () => {
  it("keeps the label ring inside the icon ring for sparse wheels", () => {
    const layout = getWheelItemLayout(2, 0);
    const labelRadius = Math.hypot(layout.cx - 160, layout.cy - 160);
    const iconRadius = Math.hypot(layout.ix - 160, layout.iy - 160);

    expect(labelRadius).toBeCloseTo(80);
    expect(iconRadius).toBeCloseTo(119);
    expect(iconRadius - labelRadius).toBeGreaterThan(30);
    expect(layout.labelMaxWidth).toBeLessThanOrEqual(125);
    expect(layout.iconSize).toBe(12);
    expect(layout.rotate).toBeUndefined();
    expect(getWheelItemLayout(8, 0).rotate).toContain("rotate(");
  });

  it("shrinks available text width as sectors become denser", () => {
    expect(getWheelItemLayout(12, 0).labelMaxWidth).toBeLessThan(
      getWheelItemLayout(4, 0).labelMaxWidth,
    );
    expect(getWheelItemLayout(60, 0).iconSize).toBeLessThan(12);
    expect(getWheelItemLayout(60, 0).iconSize).toBeGreaterThanOrEqual(5);
  });

  it("rejects invalid sector indexes", () => {
    expect(() => getWheelItemLayout(0, 0)).toThrow(RangeError);
    expect(() => getWheelItemLayout(4, 4)).toThrow(RangeError);
    expect(() => getWheelItemLayout(4, 1.5)).toThrow(RangeError);
  });

  it.each([1, 2, 4, 5, 8, 12, 60])("keeps layout coordinates finite for %i sectors", (count) => {
    const layout = getWheelItemLayout(count, count - 1);
    expect(Number.isFinite(layout.cx)).toBe(true);
    expect(Number.isFinite(layout.cy)).toBe(true);
    expect(Number.isFinite(layout.ix)).toBe(true);
    expect(Number.isFinite(layout.iy)).toBe(true);
    expect(layout.labelMaxWidth).toBeGreaterThan(0);
    expect(layout.iconSize).toBeGreaterThanOrEqual(5);
  });

  it("does not collapse labels when the icon is vertically separated", () => {
    expect(getWheelItemLayout(1, 0).labelMaxWidth).toBeGreaterThan(0);
  });

  it("reserves horizontal clearance from the icon for two sectors", () => {
    const layout = getWheelItemLayout(2, 0);
    const labelRadius = Math.hypot(layout.cx - 160, layout.cy - 160);
    const iconRadius = Math.hypot(layout.ix - 160, layout.iy - 160);
    const labelHalfWidth = layout.labelMaxWidth / 2;
    const iconHalfWidth = layout.iconSize / 2 + 2;

    // The reserved width may be conservative, but the nominal text band must
    // remain inside the icon's safe boundary in every sparse layout.
    expect(labelRadius + labelHalfWidth + iconHalfWidth).toBeLessThanOrEqual(
      labelRadius + (iconRadius - labelRadius) - 2,
    );
  });
});

describe("getCapsuleGeometry", () => {
  it("空标签返回 null（不渲染胶囊，由死区圆替代）", () => {
    expect(getCapsuleGeometry("")).toBeNull();
  });

  it("短标签宽度钳制到最小宽度 56", () => {
    const geo = getCapsuleGeometry("ab");
    expect(geo).not.toBeNull();
    expect(geo!.width).toBe(56);
    expect(geo!.text).toBe("ab");
  });

  it("中等标签宽度 = 文本宽度 + 两侧内边距，不截断", () => {
    const label = "公司邮箱正式签名";
    const geo = getCapsuleGeometry(label)!;
    expect(geo.text).toBe(label);
    expect(geo.width).toBe(Math.min(180, textWidth(label, 12) + 26));
    expect(geo.width).toBeGreaterThan(56);
    expect(geo.width).toBeLessThanOrEqual(180);
  });

  it("超长标签按最大内宽截断并追加省略号，宽度钳制到上限 180", () => {
    const label = "这是一个特别特别特别特别特别特别特别特别长的便签内容";
    const geo = getCapsuleGeometry(label)!;
    expect(geo.text.endsWith("…")).toBe(true);
    expect(geo.text).not.toBe(label);
    expect(geo.width).toBeLessThanOrEqual(180);
    // 截断文本的估宽不得超出胶囊内宽，否则文字会溢出胶囊
    expect(textWidth(geo.text, 12)).toBeLessThanOrEqual(180 - 26 + 0.01);
  });

  it("宽度始终落在 [56, 180] 区间（各长度抽样）", () => {
    for (let n = 1; n <= 30; n += 1) {
      const geo = getCapsuleGeometry("标".repeat(n))!;
      expect(geo.width).toBeGreaterThanOrEqual(56);
      expect(geo.width).toBeLessThanOrEqual(180);
    }
  });

  it("maxWidth 参数收窄面包屑等场景的宽度上限", () => {
    const geo = getCapsuleGeometry("‹ 一个相当长的父级分组标签名称", 140)!;
    expect(geo.width).toBeLessThanOrEqual(140);
  });
});

describe("snippetToWheelItem", () => {
  it("纯文本片段映射为叶子条目，无 children 字段", () => {
    const item = snippetToWheelItem({ label: "邮箱", text: "a@b.c" })!;
    expect(item.label).toBe("邮箱");
    expect(item.text).toBe("a@b.c");
    expect(item.isHistory).toBe(false);
    expect(item.children).toBeUndefined();
  });

  it("带 children 的分组条目：子项映射、标签回退到文本前 20 字", () => {
    const item = snippetToWheelItem({
      label: "工作片段",
      children: [
        { label: "签名", text: "sig" },
        { text: "无标签子项文本" },
      ],
    })!;
    expect(item.text).toBe("");
    expect(item.children).toHaveLength(2);
    expect(item.children![0]).toMatchObject({ label: "签名", text: "sig" });
    expect(item.children![1].label).toBe("无标签子项文本");
  });

  it("无 text 且无有效 children 的条目无效", () => {
    expect(snippetToWheelItem({ label: "空" })).toBeNull();
    expect(snippetToWheelItem({ label: "空", children: [{ label: "没文本" }] })).toBeNull();
  });

  it("children 全部无效时视同普通条目（children 为 undefined）", () => {
    const item = snippetToWheelItem({ label: "有文本", text: "hi", children: [{ label: "没文本" }] })!;
    expect(item.text).toBe("hi");
    expect(item.children).toBeUndefined();
  });

  it("分组缺 label 时回退「未命名分组」", () => {
    const item = snippetToWheelItem({ children: [{ text: "x" }] })!;
    expect(item.label).toBe("未命名分组");
  });
});
