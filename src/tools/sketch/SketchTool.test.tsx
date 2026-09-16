import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { currentMonitor } from "@tauri-apps/api/window";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMockListeners, emitMockEvent } from "../../test/tauri-mock";
import { scaleStrokes, sketchCursor, SKETCH_MODES } from "./SketchTool";
import SketchTool from "./SketchTool";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(true) }));
vi.mock("@tauri-apps/api/window", () => ({ currentMonitor: vi.fn().mockResolvedValue(null) }));

describe("scaleStrokes", () => {
  it("scales points and text metrics when restoring to another viewport", () => {
    const strokes = [{
      points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
      color: "#fff",
      width: 4,
      mode: "text" as const,
      text: "note",
      fontSize: 20,
    }];

    expect(scaleStrokes(strokes, { width: 100, height: 200, dpr: 1 }, { width: 200, height: 400, dpr: 2 })).toEqual([{
      ...strokes[0],
      points: [{ x: 20, y: 40 }, { x: 60, y: 80 }],
      width: 8,
      fontSize: 40,
    }]);
  });

  it("keeps stroke values unchanged when the viewport is unavailable or equal", () => {
    const strokes = [{ points: [{ x: 1, y: 2 }], color: "#fff", width: 2, mode: "pen" as const }];
    expect(scaleStrokes(strokes, undefined, { width: 100, height: 100, dpr: 1 })).toEqual(strokes);
    expect(scaleStrokes(strokes, { width: 100, height: 100, dpr: 1 }, { width: 100, height: 100, dpr: 2 })).toEqual(strokes);
  });
});

/** 从 data URI 里取出真实 SVG 字符串（自检用，只认 sketchCursor 的输出格式） */
function decodeCursorSvg(cursor: string): string {
  const match = /^url\("data:image\/svg\+xml,(.*)"\) \d+ \d+, auto$/.exec(cursor);
  if (!match) throw new Error(`无法解析光标: ${cursor}`);
  return decodeURIComponent(match[1]);
}

interface CursorSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 把 "M16 2.2v8.8M16 21v8.8M2.2 16h8.8M21 16h8.8" 拆成轴对齐线段 */
function cursorArms(svg: string): CursorSegment[] {
  const d = /<path d="([^"]+)"/.exec(svg)?.[1] ?? "";
  return [...d.matchAll(/M([\d.]+) ([\d.]+)([vh])([\d.]+)/g)].map(([, x, y, axis, length]) => {
    const x0 = Number(x);
    const y0 = Number(y);
    const len = Number(length);
    return axis === "v" ? { x0, y0, x1: x0, y1: y0 + len } : { x0, y0, x1: x0 + len, y1: y0 };
  });
}

/** 取通道里的徽章底色圆 */
function cursorBadge(svg: string): { cx: number; cy: number; r: number } | null {
  const match = /<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/.exec(svg);
  return match ? { cx: Number(match[1]), cy: Number(match[2]), r: Number(match[3]) } : null;
}

interface CursorGroup {
  stroke: string;
  width: number;
  inner: string;
}

/** 拆出光标的 5 个绘制层：深色外圈 / 白键线 / 内芯 / 符号反色细边 / 符号墨色 */
function cursorGroups(svg: string): CursorGroup[] {
  return [
    ...svg.matchAll(
      /<g fill="none" stroke="([^"]+)" stroke-width="([\d.]+)"[^>]*>([\s\S]*?)<\/g>/g,
    ),
  ].map(([, stroke, width, inner]) => ({ stroke, width: Number(width), inner }));
}

/** 点到线段的距离 */
function distanceToSegment(px: number, py: number, seg: CursorSegment): number {
  const dx = seg.x1 - seg.x0;
  const dy = seg.y1 - seg.y0;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - seg.x0) * dx + (py - seg.y0) * dy) / lengthSq));
  return Math.hypot(px - seg.x0 - t * dx, py - seg.y0 - t * dy);
}

describe("sketchCursor", () => {
  it("为七个工具生成带颜色、统一热点的自定义光标，并挡掉脏色值", () => {
    for (const tool of SKETCH_MODES) {
      const cursor = sketchCursor(tool, "#123456");
      expect(cursor).toMatch(/^url\("data:image\/svg\+xml,/);
      expect(cursor).toContain("%23123456");
      // 热点统一是十字交点：七个工具的落笔点都正好是点击处
      expect(cursor).toMatch(/\) 16 16, auto$/);
    }

    // 旧实现直接把值插进 SVG URL，脏值会让整条光标失效
    const fallback = encodeURIComponent("#ff3b30");
    expect(sketchCursor("pen", "not-a-color")).toContain(fallback);
    expect(sketchCursor("pen", "#12345")).toContain(fallback);
    expect(sketchCursor("pen", "#1234567")).toContain(fallback);
  });

  // 几何自检：按光标真实生成的 SVG 数字复算，防止「徽章画到十字臂上」「越出 32×32」
  // 「符号被徽章底色盖掉」这类只有在真机上才看得出来的回归。
  it("光标几何自检：四臂齐全、不越界、徽章不压十字臂、符号画在最上层", () => {
    const SVG_SIZE = 32;
    const accent = "#E53935";

    for (const tool of SKETCH_MODES) {
      const cursor = sketchCursor(tool, accent);
      expect(cursor).toMatch(/\) 16 16, auto$/);

      const svg = decodeCursorSvg(cursor);
      const groups = cursorGroups(svg);

      // 三层描边通道 + 徽章符号的反色细边 / 墨色两层
      expect(groups).toHaveLength(5);
      expect(groups.slice(0, 3).map((group) => group.stroke)).toEqual([
        "#101216",
        "#ffffff",
        accent,
      ]);
      // 深色外圈 > 白色键线 > 内芯：内芯要够粗，1× 下颜色才看得见
      expect(groups[0].width).toBeGreaterThan(groups[1].width);
      expect(groups[1].width).toBeGreaterThan(groups[2].width);
      // 符号那两层必须是「一深一白」的反色关系，且墨色不能细于 1.7（1× 下会糊成一团）
      expect(new Set([groups[3].stroke, groups[4].stroke])).toEqual(
        new Set(["#101216", "#ffffff"]),
      );
      expect(groups[3].width).toBeGreaterThan(groups[4].width);
      expect(groups[4].width).toBeGreaterThanOrEqual(1.7);

      // 1) 三条通道的十字形状必须完全一致，且各是四臂
      const armsPerPass = groups.slice(0, 3).map((group) => cursorArms(group.inner));
      for (const arms of armsPerPass) expect(arms).toHaveLength(4);
      expect(armsPerPass[1]).toEqual(armsPerPass[0]);
      expect(armsPerPass[2]).toEqual(armsPerPass[0]);

      // 2) 含线宽的包围盒不越出 0..32
      const outerHalf = groups[0].width / 2;
      for (const seg of armsPerPass[0]) {
        expect(Math.min(seg.x0, seg.x1) - outerHalf).toBeGreaterThanOrEqual(0);
        expect(Math.max(seg.x0, seg.x1) + outerHalf).toBeLessThanOrEqual(SVG_SIZE);
        expect(Math.min(seg.y0, seg.y1) - outerHalf).toBeGreaterThanOrEqual(0);
        expect(Math.max(seg.y0, seg.y1) + outerHalf).toBeLessThanOrEqual(SVG_SIZE);
      }
      const badge = cursorBadge(groups[0].inner);
      expect(badge).not.toBeNull();
      expect(badge!.cx - badge!.r - outerHalf).toBeGreaterThanOrEqual(0);
      expect(badge!.cy - badge!.r - outerHalf).toBeGreaterThanOrEqual(0);
      expect(badge!.cx + badge!.r + outerHalf).toBeLessThanOrEqual(SVG_SIZE);
      expect(badge!.cy + badge!.r + outerHalf).toBeLessThanOrEqual(SVG_SIZE);

      // 3) 徽章（含外圈）与十字臂之间要留出可辨识间隙
      for (const seg of armsPerPass[0]) {
        const gap =
          distanceToSegment(badge!.cx, badge!.cy, seg) - (badge!.r + outerHalf) - outerHalf;
        expect(gap).toBeGreaterThanOrEqual(0.45);
      }

      // 4) 徽章必须整个落在热点之外，否则交点被压住就看不出落笔位置了
      expect(Math.hypot(badge!.cx - 16, badge!.cy - 16)).toBeGreaterThan(badge!.r + outerHalf);

      // 5) 十字中心必须留出空档：任何一条臂都不能压到热点上
      for (const seg of armsPerPass[0]) {
        expect(distanceToSegment(16, 16, seg)).toBeGreaterThan(outerHalf);
      }

      // 6) 徽章里的符号（连反色外描边一起算）不能顶到徽章圆环上，否则符号像从环里长出来
      const glyphTransform = /translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)/.exec(svg);
      expect(glyphTransform).not.toBeNull();
      // 符号统一画在 10×10 单位框内 ⇒ 离符号框中心最远 5 个单位；换算回 32 空间再比半径。
      // 注意这条依赖「10 单位框」这个约定：真把坐标写到框外，它抓不到（那种只能靠看 1× 实图）。
      const glyphReach = (5 + groups[3].width / 2) * Number(glyphTransform![3]);
      expect(glyphReach).toBeLessThan(badge!.r);

      // 7) 符号必须排在 accent 通道之后，否则会被徽章底色整块盖掉
      const accentCircle = svg.indexOf(`fill="${accent}"`);
      const glyphHalo = svg.indexOf('transform="translate(');
      expect(accentCircle).toBeGreaterThan(-1);
      expect(glyphHalo).toBeGreaterThan(accentCircle);
      // 符号的深色外描边与白色本体是同一条路径
      expect(groups[4].inner).toBe(groups[3].inner);
    }

    // 七个工具的徽章符号互不相同
    const cursors = SKETCH_MODES.map((tool) => sketchCursor(tool, accent));
    expect(new Set(cursors).size).toBe(SKETCH_MODES.length);
  });

  // 固定白墨的老实现：画笔色选到白色/浅黄（橡皮擦本身就是浅色）时，白符号压在白底徽章上整块看不见。
  it("徽章内的工具符号按底色亮度取墨：浅色画笔色用深墨、深色画笔色用白墨", () => {
    const inkOf = (color: string) =>
      cursorGroups(decodeCursorSvg(sketchCursor("pen", color)))[4].stroke;

    expect(inkOf("#ffffff")).toBe("#101216"); // 白 → 深墨
    expect(inkOf("#f4f5f7")).toBe("#101216"); // 橡皮擦的浅色 → 深墨
    expect(inkOf("#ffcc00")).toBe("#101216"); // 黄
    expect(inkOf("#34c759")).toBe("#ffffff"); // 绿
    expect(inkOf("#111111")).toBe("#ffffff"); // 黑
  });
});

describe("SketchTool drawing lifecycle", () => {
  it("keeps the overlay mounted after a normal stroke", () => {
    const { container } = render(<SketchTool />);
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();
    fireEvent.pointerDown(canvas!, { clientX: 40, clientY: 40, pointerId: 1 });
    fireEvent.pointerMove(canvas!, { clientX: 140, clientY: 120, pointerId: 1 });
    fireEvent.pointerUp(canvas!, { clientX: 140, clientY: 120, pointerId: 1 });
    expect(container.querySelector(".sketch-root")).toBeTruthy();
    expect(container.querySelector(".sketch-close")).toBeTruthy();
  });

  it("renders save as an icon-only toolbar action", () => {
    const { container } = render(<SketchTool />);
    const saveButton = container.querySelector<HTMLButtonElement>(".sketch-save")!;
    expect(saveButton).toHaveAttribute("aria-label", "保存草稿");
    expect(saveButton.querySelector("svg")).toBeTruthy();
    expect(saveButton.textContent).toBe("");
  });

  it("shows a tooltip when hovering a toolbar action", () => {
    const { container } = render(<SketchTool />);
    const penButton = container.querySelector<HTMLButtonElement>(".sketch-tool-group .sketch-icon-button")!;
    const tooltipText = penButton.title;
    fireEvent.pointerOver(penButton);
    expect(container.querySelector(".sketch-tooltip")).toHaveTextContent(tooltipText);
    fireEvent.pointerOut(penButton, { relatedTarget: container.querySelector("canvas") });
    expect(container.querySelector(".sketch-tooltip")).toBeNull();
  });

  it("keeps the tooltip while moving across an icon's SVG child", () => {
    const { container } = render(<SketchTool />);
    const penButton = container.querySelector<HTMLButtonElement>(".sketch-tool-group .sketch-icon-button")!;
    const icon = penButton.querySelector("svg")!;
    fireEvent.pointerOver(penButton);
    fireEvent.pointerOut(penButton, { relatedTarget: icon });
    expect(container.querySelector(".sketch-tooltip")).toHaveTextContent("画笔");
    expect(penButton).not.toHaveAttribute("title");
    expect(penButton).toHaveAttribute("data-tooltip", "画笔");
  });

  /** jsdom 不做布局，getBoundingClientRect 恒为 0，故按用例需要钉住按钮的位置 */
  function stubRect(
    element: Element,
    rect: { top: number; bottom: number; left: number; width: number },
  ) {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      ...rect,
      right: rect.left + rect.width,
      height: rect.bottom - rect.top,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    } as DOMRect);
  }

  it("按钮上方放不下时把浮层翻到按钮下方（否则整个浮层会被窗口上沿裁掉）", () => {
    const { container } = render(<SketchTool />);
    const penButton = container.querySelector<HTMLButtonElement>(".sketch-tool-group .sketch-icon-button")!;
    // 标注文字编辑器的确认/取消按钮会被钳到 top: 8px，上方只剩十几像素
    stubRect(penButton, { top: 8, bottom: 36, left: 100, width: 28 });

    fireEvent.pointerOver(penButton);

    const tooltip = container.querySelector<HTMLElement>(".sketch-tooltip")!;
    expect(tooltip).toHaveClass("sketch-tooltip--below");
    expect(tooltip.style.top).toBe("43px"); // 按钮下沿 36 + 7px 间距
  });

  it("按钮上方空间充足时仍向上弹", () => {
    const { container } = render(<SketchTool />);
    const penButton = container.querySelector<HTMLButtonElement>(".sketch-tool-group .sketch-icon-button")!;
    stubRect(penButton, { top: 300, bottom: 328, left: 100, width: 28 });

    fireEvent.pointerOver(penButton);

    const tooltip = container.querySelector<HTMLElement>(".sketch-tooltip")!;
    expect(tooltip).not.toHaveClass("sketch-tooltip--below");
    expect(tooltip.style.top).toBe("293px"); // 按钮上沿 300 - 7px 间距
  });

  it("uses a distinct custom cursor for each drawing tool", () => {
    const { container } = render(<SketchTool />);
    const canvas = container.querySelector("canvas")!;
    const toolButtons = container.querySelectorAll<HTMLButtonElement>(".sketch-tool-group .sketch-icon-button");

    expect(canvas.style.cursor).toContain("data:image/svg+xml");
    const penCursor = canvas.style.cursor;

    fireEvent.click(toolButtons[1]);
    expect(canvas.style.cursor).toContain("data:image/svg+xml");
    expect(canvas.style.cursor).not.toBe(penCursor);
    fireEvent.click(toolButtons[6]);
    expect(canvas.style.cursor).toContain("data:image/svg+xml");
  });

  it("changes color without switching away from the active drawing tool", () => {
    const { container } = render(<SketchTool />);
    const toolButtons = container.querySelectorAll<HTMLButtonElement>(".sketch-tool-group .sketch-icon-button");

    fireEvent.click(toolButtons[1]);
    const lineCursor = container.querySelector("canvas")!.getAttribute("style");
    const colorIndicator = container.querySelector<HTMLSpanElement>(".sketch-color-trigger span")!;
    const initialColor = colorIndicator.style.backgroundColor;
    fireEvent.click(container.querySelector<HTMLButtonElement>(".sketch-color-trigger")!);
    const colors = container.querySelectorAll<HTMLButtonElement>(".sketch-color");

    expect(colors).toHaveLength(7);
    expect(colors[0]).toHaveAttribute("data-selected", "true");
    fireEvent.pointerDown(colors[2]);

    expect(toolButtons[1].className).toContain("active");
    expect(toolButtons[0].className).not.toContain("active");
    expect(container.querySelector(".sketch-picker-panel")).toBeNull();
    expect(colorIndicator.style.backgroundColor).not.toBe(initialColor);
    expect(container.querySelector("canvas")!.getAttribute("style")).not.toBe(lineCursor);
  });

  it("opens compact secondary pickers and closes them with Escape", () => {
    const { container } = render(<SketchTool />);
    const colorTrigger = container.querySelector<HTMLButtonElement>(".sketch-color-trigger")!;
    const widthTrigger = container.querySelector<HTMLButtonElement>(".sketch-width-trigger")!;

    expect(container.querySelector(".sketch-picker-panel")).toBeNull();
    fireEvent.click(colorTrigger);
    expect(colorTrigger).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".sketch-picker-colors")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".sketch-picker-panel")).toBeNull();

    fireEvent.click(widthTrigger);
    expect(container.querySelectorAll(".sketch-picker-widths .sketch-width")).toHaveLength(4);
    fireEvent.pointerDown(container.querySelectorAll<HTMLButtonElement>(".sketch-picker-widths .sketch-width")[3]);
    expect(container.querySelector(".sketch-picker-panel")).toBeNull();
    expect(container.querySelector<HTMLSpanElement>(".sketch-width-trigger span")).toHaveStyle({ width: "17px", height: "17px" });
  });

  it("supports a custom color and wheel-adjusted custom width", () => {
    const { container } = render(<SketchTool />);
    const colorTrigger = container.querySelector<HTMLButtonElement>(".sketch-color-trigger")!;
    const widthTrigger = container.querySelector<HTMLButtonElement>(".sketch-width-trigger")!;
    const colorIndicator = colorTrigger.querySelector("span")!;
    const initialColor = (colorIndicator as HTMLElement).style.backgroundColor;

    fireEvent.click(colorTrigger);
    fireEvent.pointerDown(container.querySelectorAll<HTMLButtonElement>(".sketch-color")[5]);
    fireEvent.click(colorTrigger);
    const colorInput = container.querySelector<HTMLInputElement>(".sketch-custom-color input")!;
    expect(colorInput.value).toBe("#ffffff");
    fireEvent.change(colorInput, { target: { value: "#123456" } });
    expect(container.querySelector(".sketch-picker-panel")).toBeNull();
    expect((colorIndicator as HTMLElement).style.backgroundColor).not.toBe(initialColor);

    fireEvent.click(widthTrigger);
    const customWidth = container.querySelector<HTMLElement>(".sketch-custom-width")!;
    expect(customWidth).toHaveAttribute("aria-valuenow", "4");
    fireEvent.wheel(customWidth, { deltaY: -100 });
    expect(customWidth).toHaveAttribute("aria-valuenow", "5");
    fireEvent.keyDown(customWidth, { key: "ArrowDown" });
    expect(customWidth).toHaveAttribute("aria-valuenow", "4");
  });

  it("uses an inline text editor instead of the browser prompt", () => {
    const prompt = vi.fn();
    window.prompt = prompt;
    const { container } = render(<SketchTool />);
    const canvas = container.querySelector("canvas")!;
    const toolButtons = container.querySelectorAll<HTMLButtonElement>(".sketch-tool-group .sketch-icon-button");

    fireEvent.click(toolButtons[5]);
    fireEvent.pointerDown(canvas, { clientX: 120, clientY: 140, pointerId: 6 });

    const input = container.querySelector<HTMLInputElement>(".sketch-text-input");
    expect(input).toBeTruthy();
    expect(prompt).not.toHaveBeenCalled();
    fireEvent.change(input!, { target: { value: "重点内容" } });
    fireEvent.keyDown(input!, { key: "Enter" });

    expect(container.querySelector(".sketch-text-input")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".sketch-save")).not.toBeDisabled();
  });

  it("cancels inline text entry with Escape without adding a stroke", () => {
    localStorage.removeItem("levitaire-sketch-state-v1");
    const { container } = render(<SketchTool />);
    const canvas = container.querySelector("canvas")!;
    const toolButtons = container.querySelectorAll<HTMLButtonElement>(".sketch-tool-group .sketch-icon-button");

    fireEvent.click(toolButtons[5]);
    fireEvent.pointerDown(canvas, { clientX: 120, clientY: 140, pointerId: 7 });
    const input = container.querySelector<HTMLInputElement>(".sketch-text-input")!;
    fireEvent.change(input, { target: { value: "取消内容" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(container.querySelector(".sketch-text-input")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".sketch-save")).toBeDisabled();
  });

  it("discards the current draft without a confirmation prompt", () => {
    const confirm = vi.fn();
    window.confirm = confirm;
    const { container } = render(<SketchTool />);
    const canvas = container.querySelector("canvas")!;
    fireEvent.pointerDown(canvas, { clientX: 40, clientY: 40, pointerId: 2 });
    fireEvent.pointerMove(canvas, { clientX: 140, clientY: 120, pointerId: 2 });
    fireEvent.pointerUp(canvas, { clientX: 140, clientY: 120, pointerId: 2 });
    const closeButton = container.querySelector(".sketch-close")!;
    fireEvent.click(closeButton);
    expect(confirm).not.toHaveBeenCalled();
    expect(localStorage.getItem("levitaire-sketch-state-v1")).toBeNull();
  });

  it("shows a preview before saving and exits after confirmation", async () => {
    const toDataUrl = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,preview");
    const { container } = render(<SketchTool />);
    const canvas = container.querySelector("canvas")!;
    fireEvent.pointerDown(canvas, { clientX: 40, clientY: 40, pointerId: 3 });
    fireEvent.pointerMove(canvas, { clientX: 140, clientY: 120, pointerId: 3 });
    fireEvent.pointerUp(canvas, { clientX: 140, clientY: 120, pointerId: 3 });
    fireEvent.click(container.querySelector(".sketch-save")!);
    expect(container.querySelector(".sketch-preview")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("save_image", expect.anything());
    const previewButtons = Array.from(container.querySelectorAll(".sketch-preview-actions button"));
    expect(previewButtons.map((button) => button.className)).toEqual(["sketch-preview-confirm", "sketch-preview-cancel"]);
    const imageWrap = container.querySelector<HTMLElement>(".sketch-preview-image-wrap")!;
    fireEvent.wheel(imageWrap, { deltaY: -100 });
    expect(container.querySelector<HTMLElement>(".sketch-preview-image")?.style.transform).toContain("scale(1.12)");
    fireEvent.click(container.querySelector(".sketch-preview-confirm")!);
    await waitFor(() => expect(container.querySelector(".sketch-preview")).toBeNull());
    expect(invoke).toHaveBeenCalledWith("save_image", expect.objectContaining({ filename: "sketch.png" }));
    toDataUrl.mockRestore();
  });

  it("closes the preview with Escape without discarding the draft", () => {
    const toDataUrl = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,preview");
    const { container } = render(<SketchTool />);
    const canvas = container.querySelector("canvas")!;
    fireEvent.pointerDown(canvas, { clientX: 40, clientY: 40, pointerId: 4 });
    fireEvent.pointerMove(canvas, { clientX: 140, clientY: 120, pointerId: 4 });
    fireEvent.pointerUp(canvas, { clientX: 140, clientY: 120, pointerId: 4 });
    fireEvent.click(container.querySelector(".sketch-save")!);
    expect(container.querySelector(".sketch-preview")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".sketch-preview")).toBeNull();
    expect(container.querySelector(".sketch-root")).toBeTruthy();
    toDataUrl.mockRestore();
  });

  it("disables preview cancellation while saving", async () => {
    let resolveSave: ((value: boolean) => void) | undefined;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveSave = resolve; }));
    const toDataUrl = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,preview");
    const { container } = render(<SketchTool />);
    const canvas = container.querySelector("canvas")!;
    fireEvent.pointerDown(canvas, { clientX: 40, clientY: 40, pointerId: 5 });
    fireEvent.pointerMove(canvas, { clientX: 140, clientY: 120, pointerId: 5 });
    fireEvent.pointerUp(canvas, { clientX: 140, clientY: 120, pointerId: 5 });
    fireEvent.click(container.querySelector(".sketch-save")!);
    fireEvent.click(container.querySelector(".sketch-preview-confirm")!);
    await waitFor(() => expect(container.querySelector(".sketch-preview-cancel")).toHaveAttribute("disabled"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".sketch-preview")).toBeTruthy();
    resolveSave?.(false);
    toDataUrl.mockRestore();
  });

  it("blocks closing while a background capture is in flight", async () => {
    let resolveBackground: ((value: string) => void) | undefined;
    vi.mocked(currentMonitor).mockResolvedValueOnce({ position: { x: 0, y: 0 }, size: { width: 100, height: 100 } } as never);
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<string>((resolve) => { resolveBackground = resolve; }));
    const { container } = render(<SketchTool />);
    const canvas = container.querySelector("canvas")!;
    fireEvent.pointerDown(canvas, { clientX: 40, clientY: 40, pointerId: 8 });
    fireEvent.pointerMove(canvas, { clientX: 140, clientY: 120, pointerId: 8 });
    fireEvent.pointerUp(canvas, { clientX: 140, clientY: 120, pointerId: 8 });
    fireEvent.click(container.querySelector<HTMLButtonElement>(".sketch-save-with-background")!);
    await waitFor(() => expect(container.querySelector<HTMLButtonElement>(".sketch-close")).toBeDisabled());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".sketch-root")).toBeTruthy();
    resolveBackground?.("background");
  });
});

describe("SketchTool theme synchronization", () => {
  beforeEach(() => {
    clearMockListeners();
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("uses the saved theme when the sketch overlay opens", () => {
    localStorage.setItem("levitaire-theme", "dark");

    render(<SketchTool />);

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("follows the settings window while the sketch overlay stays open", async () => {
    render(<SketchTool />);

    await act(async () => {
      await Promise.resolve();
    });
    act(() =>
      emitMockEvent("levitaire-theme-changed", {
        theme: "dark",
        accent: "blue",
        scheme: "cloud",
      }),
    );

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("levitaire-theme")).toBe("dark");
  });
});
