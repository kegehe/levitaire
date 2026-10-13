import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { setMockWindow, emitMockFocus, clearMockListeners } from "../../test/tauri-mock";
import ScreenshotTool, { adjustSelection } from "./ScreenshotTool";

const mockInvoke = vi.mocked(invoke);

/** 选区固定为 (100,100)-(300,200)。底图按 1 CSS px = 1 画布像素返回，便于断言标注坐标。 */
const SEL = { left: 100, top: 100, width: 200, height: 100 };

/**
 * 每次 strokeRect 时的 lineWidth（与 stubCanvas() 返回的 strokeRects 一一对应）。
 * 标注线宽只能靠它观察：drawRect/drawArrow/drawBrush 都是「先设 lineWidth 再 strokeRect」，
 * 而编辑手柄走 rect/arc，不会混进来。stubCanvas() 每次调用都会重置它。
 */
let annotatedStrokeWidths: number[] = [];

function stubCanvas() {
  const strokeRects: number[][] = [];
  annotatedStrokeWidths = [];
  let lineWidth = 0;
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
    strokeRect: (...args: number[]) => {
      strokeRects.push(args);
      annotatedStrokeWidths.push(lineWidth);
    },
    fillRect: noop,
    fillText: noop,
    arc: noop,
    closePath: noop,
    // 选中标注时 drawEditHandles 会用到（框类手柄画方块、移动类画虚线包围盒）
    rect: noop,
    setLineDash: noop,
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
    set lineWidth(v: number) {
      lineWidth = v;
    },
    get lineWidth() {
      return lineWidth;
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
    // 从空白处起拖（(250,180) 不在标注上）：命中标注会进入标注编辑，这里是选区整体移动
    await act(async () => {
      fireEvent.pointerDown(body, { clientX: 250, clientY: 180, pointerId: 3 });
      fireEvent.pointerMove(body, { clientX: 300, clientY: 200, pointerId: 3 });
      fireEvent.pointerUp(body, { clientX: 300, clientY: 200, pointerId: 3 });
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
      fireEvent.pointerDown(body, { clientX: 250, clientY: 180, pointerId: 8 });
      fireEvent.pointerMove(body, { clientX: 300, clientY: 200, pointerId: 8 });
      fireEvent.pointerUp(body, { clientX: 300, clientY: 200, pointerId: 8 });
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

  /**
   * 连续移动后立即松手：必须以**最后一次**移动的坐标重截。
   *
   * 守护「调整会话必须同步记住最新选区」这条契约：第一次移动落地（触发一次渲染）后
   * 紧接着第二次移动并立刻松手，若 endAdjust 读到的是被渲染同步覆盖过的旧值，就会按
   * 中间位置重截，甚至因与 anchor 相等而误判为「原地点击」、直接丢弃整次调整。
   * （这条曾被 rAF 合并提交的改动破坏过，故保留为长期回归。）
   */
  it("连续移动后立即松手：以最后一次移动的坐标重截", async () => {
    stubCanvas();
    await enterAnnotating();
    const body = document.querySelector(".ss-adjust-body") as HTMLElement;
    const callsBefore = captureCalls().length;

    // 第一次移动：等它落地并完成一次渲染（此时 state 与 ref 是一致的）
    await act(async () => {
      fireEvent.pointerDown(body, { clientX: 200, clientY: 150, pointerId: 11 });
      fireEvent.pointerMove(body, { clientX: 260, clientY: 150, pointerId: 11 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // 第二次移动：不等这次更新完成渲染，直接松手
    await act(async () => {
      fireEvent.pointerMove(body, { clientX: 320, clientY: 200, pointerId: 11 });
      fireEvent.pointerUp(body, { clientX: 320, clientY: 200, pointerId: 11 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const calls = captureCalls();
    expect(calls.length).toBe(callsBefore + 1);
    // 起点 (200,150) → 终点 (320,200)：位移 +120 / +50，选区 SEL(100,100,200x100) 整体平移
    expect(calls[calls.length - 1][1]).toEqual({
      left: SEL.left + 120,
      top: SEL.top + 50,
      width: SEL.width,
      height: SEL.height,
    });
  });

  /**
   * 标注「画完之后可调整」：在移动工具下，鼠标落在已提交标注的边缘/内部即进入编辑，
   * 未命中标注时才落回选区整体移动。rect 画在画布物理 (50,30)-(100,60)。
   */
  it("移动工具下悬停标注边缘：光标变为缩放光标", async () => {
    stubCanvas();
    await enterAnnotating();
    await drawRectAnnotation();
    const body = document.querySelector(".ss-adjust-body") as HTMLElement;
    await act(async () => {
      fireEvent.pointerMove(body, { clientX: 200, clientY: 145, pointerId: 30 });
    });
    expect(body.style.cursor).toBe("ew-resize");
  });

  it("移动工具下拖标注右边：缩放该标注（不改选区、不重截），Ctrl+Z 可回退", async () => {
    const strokeRects = stubCanvas();
    await enterAnnotating();
    await drawRectAnnotation();

    const body = document.querySelector(".ss-adjust-body") as HTMLElement;
    const callsBefore = captureCalls().length;
    await act(async () => {
      // 右边中点：物理 (100,45) → client (200,145)
      fireEvent.pointerDown(body, { clientX: 200, clientY: 145, pointerId: 21 });
      fireEvent.pointerMove(body, { clientX: 230, clientY: 145, pointerId: 21 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // 拖动中：draft 顶替原标注，已按新宽度重绘
    expect(strokeRects[strokeRects.length - 1]).toEqual([50, 30, 80, 30]);

    await act(async () => {
      fireEvent.pointerUp(body, { clientX: 230, clientY: 145, pointerId: 21 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // 右边被拖 +30：宽 50 → 80，左边固定不动；且没有触发选区重截
    expect(strokeRects[strokeRects.length - 1]).toEqual([50, 30, 80, 30]);
    expect(captureCalls().length).toBe(callsBefore);

    // 一次拖动算一步撤销：Ctrl+Z 回到拖动前的宽 50
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(strokeRects[strokeRects.length - 1]).toEqual([50, 30, 50, 30]);
  });

  it("移动工具下拖标注内部：整体移动该标注（选区不动）", async () => {
    const strokeRects = stubCanvas();
    await enterAnnotating();
    await drawRectAnnotation();

    const body = document.querySelector(".ss-adjust-body") as HTMLElement;
    const callsBefore = captureCalls().length;
    await act(async () => {
      // 内部点：物理 (75,45) → client (175,145)；拖到 (185,155) 即位移 (10,10)
      fireEvent.pointerDown(body, { clientX: 175, clientY: 145, pointerId: 22 });
      fireEvent.pointerMove(body, { clientX: 185, clientY: 155, pointerId: 22 });
      fireEvent.pointerUp(body, { clientX: 185, clientY: 155, pointerId: 22 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // 标注整体平移 (10,10)；选区未动、也没重截
    expect(strokeRects[strokeRects.length - 1]).toEqual([60, 40, 50, 30]);
    expect(captureCalls().length).toBe(callsBefore);
    expect((document.querySelector(".ss-selection-box") as HTMLElement).style.left).toBe(
      `${SEL.left}px`,
    );
  });

  /**
   * 线宽滚轮：在「移动」工具下选中标注后，鼠标悬停在它上面滚轮即可改线宽。
   * 一次滚轮爆发用空闲定时器收口成**一步撤销**（否则 index 式撤销栈会被几十条同样的编辑塞满）。
   */
  it("选中标注后滚轮调线宽：一次滚轮爆发只算一步撤销", async () => {
    stubCanvas();
    await enterAnnotating();
    await drawRectAnnotation();
    const body = document.querySelector(".ss-adjust-body") as HTMLElement;

    // 点选该标注（右边中点按下抬起，无位移）
    await act(async () => {
      fireEvent.pointerDown(body, { clientX: 200, clientY: 145, pointerId: 41 });
      fireEvent.pointerUp(body, { clientX: 200, clientY: 145, pointerId: 41 });
    });
    expect(annotatedStrokeWidths[annotatedStrokeWidths.length - 1]).toBe(5);

    // 连滚 3 格（上滚 = 加粗）：预览立即生效（draft 顶替显示）
    await act(async () => {
      for (let i = 0; i < 3; i++) {
        fireEvent.wheel(body, { clientX: 200, clientY: 145, deltaY: -100 });
      }
    });
    expect(annotatedStrokeWidths[annotatedStrokeWidths.length - 1]).toBe(8);

    // 等空闲定时器到点：收口成一步（仍是 8）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(annotatedStrokeWidths[annotatedStrokeWidths.length - 1]).toBe(8);

    // 一次 Ctrl+Z 直接回到 5：说明 3 格合并成了一版，而不是逐格回退
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(annotatedStrokeWidths[annotatedStrokeWidths.length - 1]).toBe(5);
  });

  it("未选中标注时滚轮不改任何标注", async () => {
    const strokeRects = stubCanvas();
    await enterAnnotating();
    await drawRectAnnotation();
    const body = document.querySelector(".ss-adjust-body") as HTMLElement;

    await act(async () => {
      fireEvent.wheel(body, { clientX: 200, clientY: 145, deltaY: -100 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    // 线宽没变
    expect(annotatedStrokeWidths[annotatedStrokeWidths.length - 1]).toBe(5);

    // 也没产生编辑版本：第一次 Ctrl+Z 直接撤掉整个矩形（末次渲染不再画它）
    const before = strokeRects.length;
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(strokeRects.length).toBe(before);
  });

  /**
   * 回归（最高危的竞态）：滚轮编辑挂起时去拖选区边角/整体移动 —— 选区手柄是
   * .ss-adjust-body 的兄弟节点，不会走 body 的钩子。若不在 startAdjust 里先收口，
   * commitAdjusted 的 translate 只平移已提交项，随后定时器用「平移前坐标」的 draft 提交，
   * 去重取末次值 → 标注会弹回原位。
   */
  it("滚轮挂起时去移动选区：先落定线宽，标注随屏幕内容一起平移", async () => {
    const strokeRects = stubCanvas();
    await enterAnnotating();
    await drawRectAnnotation();
    const body = document.querySelector(".ss-adjust-body") as HTMLElement;

    // 先点选标注
    await act(async () => {
      fireEvent.pointerDown(body, { clientX: 200, clientY: 145, pointerId: 51 });
      fireEvent.pointerUp(body, { clientX: 200, clientY: 145, pointerId: 51 });
    });

    // 滚一格（线宽 5 → 6），不等空闲定时器：让它保持挂起
    await act(async () => {
      fireEvent.wheel(body, { clientX: 200, clientY: 145, deltaY: -100 });
    });

    // 立刻从空白处拖选区移动 (+50,+20)
    await act(async () => {
      fireEvent.pointerDown(body, { clientX: 250, clientY: 180, pointerId: 52 });
      fireEvent.pointerMove(body, { clientX: 300, clientY: 200, pointerId: 52 });
      fireEvent.pointerUp(body, { clientX: 300, clientY: 200, pointerId: 52 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // 即使挂起的定时器随后到点，也不应把坐标改回去
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });

    // 线宽已落定为 6；标注（原物理 (50,30)-(100,60)）随选区平移 (-50,-20) 到 (0,10)-(50,30)
    expect(annotatedStrokeWidths[annotatedStrokeWidths.length - 1]).toBe(6);
    expect(strokeRects[strokeRects.length - 1]).toEqual([0, 10, 50, 30]);
  });

  /**
   * 回归：工具栏的「撤销」按钮不走键盘钩子 —— 若不在按钮路径上先落定挂起的滚轮编辑，
   * 按钮先撤销（index 回退），随后空闲定时器再 commit 一版，会把刚撤销掉的编辑又推回来。
   */
  it("滚轮挂起时点工具栏「撤销」按钮：先落定再撤销，不会被定时器推回", async () => {
    stubCanvas();
    await enterAnnotating();
    await drawRectAnnotation();
    const body = document.querySelector(".ss-adjust-body") as HTMLElement;

    // 点选标注后滚一格（5 → 6），不等空闲定时器
    await act(async () => {
      fireEvent.pointerDown(body, { clientX: 200, clientY: 145, pointerId: 61 });
      fireEvent.pointerUp(body, { clientX: 200, clientY: 145, pointerId: 61 });
    });
    await act(async () => {
      fireEvent.wheel(body, { clientX: 200, clientY: 145, deltaY: -100 });
    });

    // 点工具栏的「撤销」按钮（不是 Ctrl+Z）
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    });
    // 再等过空闲窗口：即使定时器到点，也不该把宽度改回去
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });

    // 撤销的是「滚轮那一步」，矩形仍在、线宽回到 5
    expect(annotatedStrokeWidths[annotatedStrokeWidths.length - 1]).toBe(5);
  });
});
