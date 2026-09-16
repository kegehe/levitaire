import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { setMockWindow, emitMockFocus, clearMockListeners } from "../../test/tauri-mock";
import ScreenshotTool, { adjustSelection } from "./ScreenshotTool";

const mockInvoke = vi.mocked(invoke);

/** 选区固定为 (100,100)-(300,200)。底图按 1 CSS px = 1 画布像素返回，便于断言标注坐标。 */
const SEL = { left: 100, top: 100, width: 200, height: 100 };

function stubCanvas() {
  const strokeRects: number[][] = [];
  const noop = () => {};
  const ctx = {
    canvas: { width: 100, height: 50 },
    clearRect: noop,
    drawImage: noop,
    save: noop,
    restore: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    stroke: noop,
    fill: noop,
    // 标注的最终坐标靠这里观察：renderAll 会把每条已提交标注重画一遍
    strokeRect: (...args: number[]) => strokeRects.push(args),
    fillRect: noop,
    fillText: noop,
    arc: noop,
    closePath: noop,
    measureText: () => ({ width: 10 }) as TextMetrics,
    getImageData: () => ({ data: [128, 128, 128, 255] }) as unknown as ImageData,
    set strokeStyle(_v: string) {},
    get strokeStyle() {
      return "";
    },
    set fillStyle(_v: string) {},
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
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
  return strokeRects;
}

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width = 200;
  height = 100;
  private _src = "";
  get src() {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    // deferred：不自动解码，由测试调 flushPendingImages() 手动完成，用来观察「解码未完成」的中间态
    if (FakeImage.deferred) FakeImage.pending.push(this);
    else queueMicrotask(() => this.onload?.());
  }
  static deferred = false;
  static pending: FakeImage[] = [];
}

function flushPendingImages() {
  const list = FakeImage.pending;
  FakeImage.pending = [];
  for (const img of list) img.onload?.();
}

function rect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    left: 0,
    top: 0,
    width: 1920,
    height: 1080,
    right: 1920,
    bottom: 1080,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...overrides,
  } as DOMRect;
}

/** 渲染 → 等 ready → 拖出选区 → 进入标注态 */
async function enterAnnotating() {
  render(<ScreenshotTool />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  const overlay = document.querySelector(".ss-overlay") as HTMLElement;
  overlay.getBoundingClientRect = vi.fn(() => rect()) as never;
  fireEvent.pointerDown(overlay, { clientX: SEL.left, clientY: SEL.top, pointerId: 1 });
  fireEvent.pointerMove(overlay, {
    clientX: SEL.left + SEL.width,
    clientY: SEL.top + SEL.height,
    pointerId: 1,
  });
  await act(async () => {
    fireEvent.pointerUp(overlay, {
      clientX: SEL.left + SEL.width,
      clientY: SEL.top + SEL.height,
      pointerId: 1,
    });
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  // 画布的 CSS 尺寸与物理尺寸在测试里取 1:1，toCanvas 的换算比例才是 1
  const canvas = document.querySelector("canvas") as HTMLCanvasElement;
  canvas.getBoundingClientRect = vi.fn(() => rect(SEL)) as never;
  return overlay;
}

/** 在选区内部画一个矩形标注：屏幕 (150,130) → (200,160) */
async function drawRectAnnotation() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "矩形" }));
  });
  const canvas = document.querySelector("canvas") as HTMLCanvasElement;
  await act(async () => {
    fireEvent.pointerDown(canvas, { clientX: 150, clientY: 130, pointerId: 2 });
    fireEvent.pointerMove(canvas, { clientX: 200, clientY: 160, pointerId: 2 });
    fireEvent.pointerUp(canvas, { clientX: 200, clientY: 160, pointerId: 2 });
    fireEvent.click(screen.getByRole("button", { name: "移动" }));
  });
}

function captureCalls() {
  return mockInvoke.mock.calls.filter(([cmd]) => cmd === "capture_region");
}

describe("adjustSelection", () => {
  const anchor = { left: 100, top: 100, width: 200, height: 100 };
  const bounds = { width: 1000, height: 800 };

  it("移动：尺寸不变，整体平移且被夹在视口内", () => {
    expect(adjustSelection(anchor, "move", 30, -20, bounds)).toEqual({
      left: 130,
      top: 80,
      width: 200,
      height: 100,
    });
    // 左/上越界
    expect(adjustSelection(anchor, "move", -500, -500, bounds)).toEqual({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
    });
    // 右/下越界
    expect(adjustSelection(anchor, "move", 5000, 5000, bounds)).toEqual({
      left: 800,
      top: 700,
      width: 200,
      height: 100,
    });
  });

  it("单边缩放：对侧边固定", () => {
    expect(adjustSelection(anchor, "e", 50, 0, bounds)).toEqual({
      left: 100,
      top: 100,
      width: 250,
      height: 100,
    });
    expect(adjustSelection(anchor, "w", 50, 0, bounds)).toEqual({
      left: 150,
      top: 100,
      width: 150,
      height: 100,
    });
    expect(adjustSelection(anchor, "n", 0, -40, bounds)).toEqual({
      left: 100,
      top: 60,
      width: 200,
      height: 140,
    });
    expect(adjustSelection(anchor, "s", 0, 40, bounds)).toEqual({
      left: 100,
      top: 100,
      width: 200,
      height: 140,
    });
  });

  it("角缩放：只动被拖的两条边", () => {
    expect(adjustSelection(anchor, "se", 20, 30, bounds)).toEqual({
      left: 100,
      top: 100,
      width: 220,
      height: 130,
    });
    expect(adjustSelection(anchor, "nw", -20, -30, bounds)).toEqual({
      left: 80,
      top: 70,
      width: 220,
      height: 130,
    });
  });

  it("被拖过对侧边时停在最小尺寸，不翻转成负宽高", () => {
    const tiny = adjustSelection(anchor, "e", -500, 0, bounds);
    expect(tiny.width).toBe(8);
    expect(tiny.left).toBe(100);
    const tinyH = adjustSelection(anchor, "nw", 500, 500, bounds);
    expect(tinyH.width).toBe(8);
    expect(tinyH.height).toBe(8);
    // 起点仍是固定角
    expect(tinyH.left + tinyH.width).toBe(300);
    expect(tinyH.top + tinyH.height).toBe(200);
  });

  it("缩放同样受视口上界约束", () => {
    expect(adjustSelection(anchor, "e", 5000, 0, bounds)).toEqual({
      left: 100,
      top: 100,
      width: 900,
      height: 100,
    });
    expect(adjustSelection(anchor, "n", 0, -5000, bounds)).toEqual({
      left: 100,
      top: 0,
      width: 200,
      height: 200,
    });
  });

  it("本来就不足最小尺寸的窄选区，原地点击不会被撑大", () => {
    const tiny = { left: 100, top: 100, width: 4, height: 3 };
    expect(adjustSelection(tiny, "e", 0, 0, bounds)).toEqual(tiny);
    expect(adjustSelection(tiny, "s", 0, 0, bounds)).toEqual(tiny);
    // 也拖不小：停在它自己的尺寸上，而不是翻转
    expect(adjustSelection(tiny, "e", -500, -500, bounds)).toEqual(tiny);
  });
});

describe("ScreenshotTool 选区调整", () => {
  beforeEach(() => {
    vi.stubGlobal("Image", FakeImage);
    setMockWindow({ label: "screenshot-overlay", scaleFactor: 1 });
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_virtual_desktop_bounds") {
        return Promise.resolve({ originX: 0, originY: 0, width: 1920, height: 1080 });
      }
      if (cmd === "capture_region") {
        return Promise.resolve({ pngBase64: "AAAA", width: 200, height: 100 });
      }
      return Promise.resolve();
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeImage.deferred = false;
    FakeImage.pending = [];
    document.body.innerHTML = "";
  });

  it("默认选中移动工具，并渲染选区调整层", async () => {
    stubCanvas();
    await enterAnnotating();

    const moveBtn = screen.getByRole("button", { name: "移动" });
    expect(moveBtn.className).toContain("ss-tool-active");
    // 其余标注工具默认不选中
    expect(screen.getByRole("button", { name: "矩形" }).className).not.toContain("ss-tool-active");
    // 整块移动层 + 四边四角共 8 个手柄
    expect(document.querySelector(".ss-adjust-body")).not.toBeNull();
    expect(document.querySelectorAll(".ss-adjust-handle")).toHaveLength(8);
    expect(document.querySelector(".ss-adjust-se")).not.toBeNull();
    expect(document.querySelector(".ss-overlay")?.className).toContain("ss-move-tool");
  });

  it("标记工具下不渲染调整层，且画布仍能接收指针", async () => {
    stubCanvas();
    await enterAnnotating();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "箭头" }));
    });
    expect(document.querySelector(".ss-adjust-body")).toBeNull();
    expect(document.querySelector(".ss-overlay")?.className).not.toContain("ss-move-tool");
  });

  it("拖动选区整体移动：底图重截到新区域，标注跟着屏幕内容一起平移", async () => {
    const strokeRects = stubCanvas();
    await enterAnnotating();
    await drawRectAnnotation();

    // 画完后 canvas 上确实画出了那个矩形（屏幕 150,130→200,160，选区左上为原点）
    expect(strokeRects[strokeRects.length - 1]).toEqual([50, 30, 50, 30]);

    const body = document.querySelector(".ss-adjust-body") as HTMLElement;
    const callsBefore = captureCalls().length;
    await act(async () => {
      fireEvent.pointerDown(body, { clientX: 200, clientY: 150, pointerId: 3 });
      fireEvent.pointerMove(body, { clientX: 250, clientY: 170, pointerId: 3 });
      fireEvent.pointerUp(body, { clientX: 250, clientY: 170, pointerId: 3 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // 选区平移 (+50, +20)，重截新区域
    const calls = captureCalls();
    expect(calls.length).toBe(callsBefore + 1);
    expect(calls[calls.length - 1][1]).toEqual({ left: 150, top: 120, width: 200, height: 100 });

    // 标注锚定在屏幕内容上：底图原点右移 50、下移 20，标注在画布坐标里就要反向平移同样的量
    expect(strokeRects[strokeRects.length - 1]).toEqual([0, 10, 50, 30]);
    // 拖动结束后调整层回到"跟随选区"的静止态
    expect(document.querySelector(".ss-adjust-body")).not.toBeNull();
  });

  it("拖动四角手柄缩放：对侧角固定，重截新尺寸", async () => {
    stubCanvas();
    await enterAnnotating();
    const handle = document.querySelector(".ss-adjust-se") as HTMLElement;
    const callsBefore = captureCalls().length;
    await act(async () => {
      fireEvent.pointerDown(handle, { clientX: 300, clientY: 200, pointerId: 4 });
      fireEvent.pointerMove(handle, { clientX: 340, clientY: 230, pointerId: 4 });
      fireEvent.pointerUp(handle, { clientX: 340, clientY: 230, pointerId: 4 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const calls = captureCalls();
    expect(calls.length).toBe(callsBefore + 1);
    expect(calls[calls.length - 1][1]).toEqual({ left: 100, top: 100, width: 240, height: 130 });
  });

  it("原地点一下不重截，也不改变选区", async () => {
    stubCanvas();
    await enterAnnotating();
    const body = document.querySelector(".ss-adjust-body") as HTMLElement;
    const callsBefore = captureCalls().length;
    await act(async () => {
      fireEvent.pointerDown(body, { clientX: 200, clientY: 150, pointerId: 5 });
      fireEvent.pointerUp(body, { clientX: 200, clientY: 150, pointerId: 5 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(captureCalls().length).toBe(callsBefore);
    expect((document.querySelector(".ss-selection-box") as HTMLElement).style.left).toBe("100px");
  });

  it("重截失败时选区回退到调整前的位置并提示", async () => {
    stubCanvas();
    await enterAnnotating();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "capture_region") return Promise.reject(new Error("截取失败"));
      return Promise.resolve();
    });

    const body = document.querySelector(".ss-adjust-body") as HTMLElement;
    await act(async () => {
      fireEvent.pointerDown(body, { clientX: 200, clientY: 150, pointerId: 6 });
      fireEvent.pointerMove(body, { clientX: 260, clientY: 150, pointerId: 6 });
      fireEvent.pointerUp(body, { clientX: 260, clientY: 150, pointerId: 6 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.getByText("截取失败")).toBeTruthy();
    expect((document.querySelector(".ss-selection-box") as HTMLElement).style.left).toBe("100px");
  });

  it("新底图解码完成前导出按钮保持禁用，解码后才用带标注的合成图导出", async () => {
    stubCanvas();
    await enterAnnotating();
    await drawRectAnnotation();

    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    canvas.toDataURL = vi.fn(() => "data:image/png;base64,FLUSHED") as never;

    // 此后底图不再自动解码，停在「capture_region 已返回、新底图还在解码」的中间态
    FakeImage.deferred = true;
    const body = document.querySelector(".ss-adjust-body") as HTMLElement;
    const callsBefore = captureCalls().length;
    await act(async () => {
      fireEvent.pointerDown(body, { clientX: 200, clientY: 150, pointerId: 8 });
      fireEvent.pointerMove(body, { clientX: 250, clientY: 170, pointerId: 8 });
      fireEvent.pointerUp(body, { clientX: 250, clientY: 170, pointerId: 8 });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(captureCalls().length).toBe(callsBefore + 1);
    // 关键：此时导出必须仍被 busy 挡住，否则会静默导出「没标注的原图」（选区都还是旧的）
    expect(screen.getByRole("button", { name: "复制" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();

    await act(async () => {
      flushPendingImages();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByRole("button", { name: "复制" })).not.toBeDisabled();

    mockInvoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(
      mockInvoke.mock.calls.find(([cmd]) => cmd === "clipboard_set_image")?.[1],
    ).toEqual({ base64Data: "FLUSHED" });
  });

  it("Esc 取消后工具回到移动工具，调整层不残留", async () => {
    stubCanvas();
    await enterAnnotating();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "画笔" }));
    });
    expect(screen.getByRole("button", { name: "画笔" }).className).toContain("ss-tool-active");

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.querySelector(".ss-annotate-toolbar")).toBeNull();

    // 重新截图后默认仍是移动工具（真实流程里由再次唤起遮罩的获焦事件重新就绪）
    await act(async () => {
      emitMockFocus(true);
      await new Promise((r) => setTimeout(r, 0));
    });
    const overlay = document.querySelector(".ss-overlay") as HTMLElement;
    fireEvent.pointerDown(overlay, { clientX: SEL.left, clientY: SEL.top, pointerId: 7 });
    fireEvent.pointerMove(overlay, {
      clientX: SEL.left + SEL.width,
      clientY: SEL.top + SEL.height,
      pointerId: 7,
    });
    await act(async () => {
      fireEvent.pointerUp(overlay, {
        clientX: SEL.left + SEL.width,
        clientY: SEL.top + SEL.height,
        pointerId: 7,
      });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByRole("button", { name: "移动" }).className).toContain("ss-tool-active");
    expect(document.querySelector(".ss-adjust-body")).not.toBeNull();
  });
});
