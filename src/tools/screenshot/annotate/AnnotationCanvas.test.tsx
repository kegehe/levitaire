import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { createRef } from "react";
import AnnotationCanvas, {
  annotationCursor,
  type AnnotationCanvasHandle,
} from "./AnnotationCanvas";
import { useAnnotations } from "./useAnnotations";
import type { Annotation } from "./types";

// happy-dom 的 canvas.getContext 返回 null，手动 stub 一个记录调用的 ctx
function makeStubCtx() {
  const calls: string[] = [];
  const ctx = {
    canvas: { width: 100, height: 50 },
    clearRect: vi.fn(() => calls.push("clearRect")),
    drawImage: vi.fn(() => calls.push("drawImage")),
    save: vi.fn(() => calls.push("save")),
    restore: vi.fn(() => calls.push("restore")),
    beginPath: vi.fn(() => calls.push("beginPath")),
    moveTo: vi.fn(() => calls.push("moveTo")),
    lineTo: vi.fn(() => calls.push("lineTo")),
    quadraticCurveTo: vi.fn(),
    stroke: vi.fn(() => calls.push("stroke")),
    fill: vi.fn(() => calls.push("fill")),
    strokeRect: vi.fn(() => calls.push("strokeRect")),
    fillRect: vi.fn(),
    fillText: vi.fn(() => calls.push("fillText")),
    arc: vi.fn(),
    closePath: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 }) as TextMetrics),
    getImageData: vi.fn(() => ({ data: [128, 128, 128, 255] }) as unknown as ImageData),
    set strokeStyle(v: string) {
      calls.push(`strokeStyle=${v}`);
    },
    get strokeStyle() {
      return "";
    },
    set fillStyle(v: string) {
      calls.push(`fillStyle=${v}`);
    },
    get fillStyle() {
      return "";
    },
    set lineWidth(_v: number) {},
    get lineWidth() {
      return 0;
    },
    set lineJoin(_v: string) {},
    set lineCap(_v: string) {},
    set font(_v: string) {},
    set textBaseline(_v: string) {},
    set textAlign(_v: string) {},
    set imageSmoothingEnabled(_v: boolean) {},
    getContext: vi.fn(),
  } as unknown as CanvasRenderingContext2D & { calls: string[] };
  (ctx as { calls: string[] }).calls = calls;
  return ctx;
}

const image = { base64: "AAAA", width: 100, height: 50 };
const selection = { left: 10, top: 20, width: 100, height: 50 };
const scale = 1;

// mock Image：src 赋值时同步触发 onload，使底图在 effect 内立即可用
class FakeImage {
  onload: (() => void) | null = null;
  width = 100;
  height = 50;
  private _src = "";
  get src() {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    // 异步触发，让 effect 内 setState 在 act 下完成
    queueMicrotask(() => this.onload?.());
  }
}

function setup() {
  const ctx = makeStubCtx();
  const getCtx = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
  return { ctx, getCtx };
}

/** 从 data URI 里取出真实 SVG 字符串（自检用，只认 annotationCursor 的输出格式） */
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

describe("AnnotationCanvas", () => {
  beforeEach(() => {
    vi.stubGlobal("Image", FakeImage);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("为每个标注工具生成带颜色和点击热点的自定义光标", () => {
    const tools: Annotation["kind"][] = ["rect", "arrow", "brush", "text", "number", "mosaic"];

    for (const tool of tools) {
      const cursor = annotationCursor(tool, "#123456");
      expect(cursor).toMatch(/^url\("data:image\/svg\+xml,/);
      expect(cursor).toContain("%23123456");
      expect(cursor).toMatch(/\) \d+ \d+, auto$/);
    }

    // Invalid persisted values must not be interpolated into the SVG URL.
    expect(annotationCursor("brush", "not-a-color")).toContain("%23E53935");
    expect(annotationCursor("brush", "#12345")).toContain("%23E53935");
    expect(annotationCursor("brush", "#1234567")).toContain("%23E53935");
  });

  // 几何自检：按光标真实生成的 SVG 数字复算，防止「徽章画到十字臂上」「越出 32×32」
  // 「符号被徽章底色盖掉」这类只有在真机上才看得出来的回归。
  it("光标几何自检：四臂齐全、不越界、徽章不压十字臂、符号画在最上层", () => {
    const SVG_SIZE = 32;
    const tools: Annotation["kind"][] = ["rect", "arrow", "brush", "text", "number", "mosaic"];
    const accent = "#E53935";

    for (const tool of tools) {
      const cursor = annotationCursor(tool, accent);
      // 热点统一是十字交点，六个工具一致
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

      // 4) 符号必须排在 accent 通道之后，否则会被徽章底色整块盖掉
      const accentCircle = svg.indexOf(`fill="${accent}"`);
      const glyphHalo = svg.indexOf('transform="translate(');
      expect(accentCircle).toBeGreaterThan(-1);
      expect(glyphHalo).toBeGreaterThan(accentCircle);
      // 符号的深色外描边与白色本体是同一条路径
      expect(groups[4].inner).toBe(groups[3].inner);
    }

    // 六个工具的徽章符号互不相同
    const cursors = tools.map((tool) => annotationCursor(tool, accent));
    expect(new Set(cursors).size).toBe(tools.length);
  });

  // 固定白墨的老实现：画笔色选到白色/浅黄时，白符号压在白底徽章上整块看不见。
  it("徽章内的工具符号按底色亮度取墨：浅色画笔色用深墨、深色画笔色用白墨", () => {
    const inkOf = (color: string) =>
      cursorGroups(decodeCursorSvg(annotationCursor("rect", color)))[4].stroke;

    expect(inkOf("#FFFFFF")).toBe("#101216"); // 白 → 深墨
    expect(inkOf("#FDD835")).toBe("#101216"); // 黄
    expect(inkOf("#43A047")).toBe("#ffffff"); // 绿
    expect(inkOf("#1E88E5")).toBe("#ffffff"); // 蓝
    expect(inkOf("#000000")).toBe("#ffffff"); // 黑 → 白墨
    // cursorColor 允许的简写与带 alpha 写法也要能解析
    expect(inkOf("#fff")).toBe("#101216");
    expect(inkOf("#000000ff")).toBe("#ffffff");
  });

  it("将光标绑定到画布，并在工具或颜色变化时更新", () => {
    setup();
    function Host({ tool, color }: { tool: Annotation["kind"]; color: string }) {
      const annotations = useAnnotations();
      return (
        <AnnotationCanvas
          image={image}
          selection={selection}
          scale={scale}
          tool={tool}
          color={color}
          widthIndex={1}
          annotations={annotations}
        />
      );
    }

    const { container, rerender } = render(<Host tool="rect" color="#123456" />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    const rectCursor = canvas.style.cursor;
    expect(rectCursor).toContain("data:image/svg+xml");
    expect(rectCursor).toContain("%23123456");

    rerender(<Host tool="arrow" color="#0A84FF" />);
    expect(canvas.style.cursor).toContain("%230A84FF");
    expect(canvas.style.cursor).not.toBe(rectCursor);
  });

  it("渲染 canvas 元素，内部尺寸 = image 物理尺寸", () => {
    setup();
    let annotations: ReturnType<typeof useAnnotations>;
    function Host() {
      annotations = useAnnotations();
      return (
        <AnnotationCanvas
          image={image}
          selection={selection}
          scale={scale}
          tool="rect"
          color="#000000"
          widthIndex={1}
          annotations={annotations}
        />
      );
    }
    const { container } = render(<Host />);
    const canvas = container.querySelector("canvas")!;
    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(50);
  });

  it("rect 工具：pointerdown→move→up 提交一个 rect 标注", async () => {
    const { ctx } = setup();
    const ref = createRef<AnnotationCanvasHandle>();
    let annotations!: ReturnType<typeof useAnnotations>;
    function Host() {
      annotations = useAnnotations();
      return (
        <AnnotationCanvas
          ref={ref}
          image={image}
          selection={selection}
          scale={scale}
          tool="rect"
          color="#E53935"
          widthIndex={1}
          annotations={annotations}
        />
      );
    }
    const { container } = render(<Host />);
    // 等底图加载
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    // canvas getBoundingClientRect 在 happy-dom 下返回 0，手动 stub
    canvas.getBoundingClientRect = vi.fn(() => ({
      left: selection.left,
      top: selection.top,
      width: selection.width,
      height: selection.height,
      right: 110,
      bottom: 70,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    })) as never;

    fireEvent.pointerDown(canvas, { clientX: 20, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 50, clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 50, clientY: 60, pointerId: 1 });

    expect(annotations!.committed).toHaveLength(1);
    const a = annotations!.committed[0] as Annotation & { kind: "rect" };
    expect(a.kind).toBe("rect");
    expect(a.w).toBeGreaterThan(0);
    // 至少触发过 drawImage（底图）与 strokeRect
    expect((ctx as { calls: string[] }).calls).toContain("drawImage");
  });

  it("flushBase64 返回非空字符串", async () => {
    setup();
    const ref = createRef<AnnotationCanvasHandle>();
    function Host() {
      const annotations = useAnnotations();
      return (
        <AnnotationCanvas
          ref={ref}
          image={image}
          selection={selection}
          scale={scale}
          tool="rect"
          color="#000000"
          widthIndex={1}
          annotations={annotations}
        />
      );
    }
    const { container } = render(<Host />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // toDataURL stub
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    canvas.toDataURL = vi.fn(() => "data:image/png;base64,QUFBQQ==") as never;
    expect(ref.current!.flushBase64()).toBe("QUFBQQ==");
    expect(ref.current!.isReady()).toBe(true);
  });

  it("text 工具：输入文字后未 Enter 直接 flush，文字被提交且导出包含", async () => {
    setup();
    const ref = createRef<AnnotationCanvasHandle>();
    let annotations!: ReturnType<typeof useAnnotations>;
    function Host() {
      annotations = useAnnotations();
      return (
        <AnnotationCanvas
          ref={ref}
          image={image}
          selection={selection}
          scale={scale}
          tool="text"
          color="#000000"
          widthIndex={1}
          annotations={annotations}
        />
      );
    }
    const { container } = render(<Host />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    canvas.getBoundingClientRect = vi.fn(() => ({
      left: selection.left,
      top: selection.top,
      width: selection.width,
      height: selection.height,
      right: 110,
      bottom: 70,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    })) as never;
    canvas.toDataURL = vi.fn(() => "data:image/png;base64,WITH_TEXT") as never;

    // 点击画布开始文字输入
    fireEvent.pointerDown(canvas, { clientX: 20, clientY: 30, pointerId: 1 });
    // 输入文字（不按 Enter）
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    fireEvent.change(textarea, { target: { value: "标注文字" } });

    // 直接 flush（模拟点导出按钮，未 Enter），包 act 因内部会触发 setState
    let result: string | null = null;
    act(() => {
      result = ref.current!.flushBase64();
    });
    expect(result).toBe("WITH_TEXT");
    // 文字应被 flushBase64 内的 finishText 提交；用 getCommitted 读 ref（state 此刻可能未渲染）
    const committed = annotations.getCommitted();
    expect(committed).toHaveLength(1);
    expect(committed[0].kind).toBe("text");
    expect((committed[0] as { text: string }).text).toBe("标注文字");
  });
});
