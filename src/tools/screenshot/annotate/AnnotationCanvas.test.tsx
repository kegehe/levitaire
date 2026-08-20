import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { createRef } from "react";
import AnnotationCanvas, { type AnnotationCanvasHandle } from "./AnnotationCanvas";
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

describe("AnnotationCanvas", () => {
  beforeEach(() => {
    vi.stubGlobal("Image", FakeImage);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
