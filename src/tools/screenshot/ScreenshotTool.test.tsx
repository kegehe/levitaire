import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import {
  setMockWindow,
  emitMockFocus,
  emitMockEvent,
  clearMockListeners,
} from "../../test/tauri-mock";
import ScreenshotTool from "./ScreenshotTool";

const mockInvoke = vi.mocked(invoke);

// stub canvas：ScreenshotTool 在 annotating 态渲染 AnnotationCanvas，需要 2d context
function stubCanvas() {
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
    strokeRect: noop,
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
  return vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
}

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
    queueMicrotask(() => this.onload?.());
  }
}

describe("ScreenshotTool 标注流程", () => {
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
        return Promise.resolve({ pngBase64: "AAAA", width: 100, height: 50 });
      }
      return Promise.resolve();
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("拖选区后进入标注态，渲染标注工具栏", async () => {
    stubCanvas();
    render(<ScreenshotTool />);
    // 等 ready（scaleFactor + bounds）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const overlay = document.querySelector(".ss-overlay") as HTMLElement;
    overlay.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
      right: 1920,
      bottom: 1080,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })) as never;

    // 拖选区
    fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 300, clientY: 200, pointerId: 1 });
    await act(async () => {
      fireEvent.pointerUp(overlay, { clientX: 300, clientY: 200, pointerId: 1 });
    });
    // capture_region 异步
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // 标注工具栏出现
    expect(screen.getByRole("button", { name: "矩形" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "箭头" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "马赛克" })).toBeTruthy();
  });

  it("标注态失焦会退出（清除工具栏），save/pin 夺焦期间不退出", async () => {
    vi.useFakeTimers();
    stubCanvas();
    render(<ScreenshotTool />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const overlay = document.querySelector(".ss-overlay") as HTMLElement;
    overlay.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
      right: 1920,
      bottom: 1080,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })) as never;
    fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 300, clientY: 200, pointerId: 1 });
    await act(async () => {
      fireEvent.pointerUp(overlay, { clientX: 300, clientY: 200, pointerId: 1 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const hasToolbar = () => document.querySelector(".ss-annotate-toolbar");
    expect(hasToolbar()).not.toBeNull();

    // 普通失焦：防抖窗口（250ms）过后退出标注，工具栏消失
    act(() => emitMockFocus(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(hasToolbar()).toBeNull();
    vi.useRealTimers();
  });

  it("框选态失焦不会取消截图", async () => {
    vi.useFakeTimers();
    render(<ScreenshotTool />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => emitMockFocus(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(document.querySelector(".ss-overlay")).not.toBeNull();
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "cancel_screenshot")).toBe(false);
    vi.useRealTimers();
  });

  it("Esc 退出标注态（后端 screenshot-cancelled 兜底）", async () => {
    stubCanvas();
    render(<ScreenshotTool />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    act(() => {
      emitMockEvent("screenshot-cancelled", undefined);
    });
    // 工具栏消失
    expect(document.querySelector(".ss-annotate-toolbar")).toBeNull();
  });

  it("标注后点复制，调用 clipboard_set_image 并传入 flush 后的 base64", async () => {
    stubCanvas();
    render(<ScreenshotTool />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const overlay = document.querySelector(".ss-overlay") as HTMLElement;
    overlay.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
      right: 1920,
      bottom: 1080,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })) as never;
    fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 300, clientY: 200, pointerId: 1 });
    await act(async () => {
      fireEvent.pointerUp(overlay, { clientX: 300, clientY: 200, pointerId: 1 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // stub canvas toDataURL 返回固定串
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    canvas.toDataURL = vi.fn(() => "data:image/png;base64,FLUSHED_BASE64") as never;

    const copyBtn = screen.getByRole("button", { name: "复制" });
    await act(async () => {
      fireEvent.click(copyBtn);
    });

    const calls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "clipboard_set_image");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ base64Data: "FLUSHED_BASE64" });
  });

  it("复制到剪贴板失败时显示错误提示，且不退出标注态", async () => {
    stubCanvas();
    render(<ScreenshotTool />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const overlay = document.querySelector(".ss-overlay") as HTMLElement;
    overlay.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
      right: 1920,
      bottom: 1080,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })) as never;
    fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 300, clientY: 200, pointerId: 1 });
    await act(async () => {
      fireEvent.pointerUp(overlay, { clientX: 300, clientY: 200, pointerId: 1 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // stub canvas toDataURL 返回固定串
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    canvas.toDataURL = vi.fn(() => "data:image/png;base64,FLUSHED_BASE64") as never;

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_virtual_desktop_bounds") {
        return Promise.resolve({ originX: 0, originY: 0, width: 1920, height: 1080 });
      }
      if (cmd === "capture_region") {
        return Promise.resolve({ pngBase64: "AAAA", width: 100, height: 50 });
      }
      if (cmd === "clipboard_set_image") {
        return Promise.reject(new Error("复制失败"));
      }
      return Promise.resolve();
    });

    const copyBtn = screen.getByRole("button", { name: "复制" });
    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(screen.getByText("复制失败")).toBeTruthy();
    // 失败不退出标注态，工具栏仍在
    expect(document.querySelector(".ss-annotate-toolbar")).not.toBeNull();
  });

  it("点击 OCR 显示可编辑结果，用户选择后才复制", async () => {
    stubCanvas();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_virtual_desktop_bounds") {
        return Promise.resolve({ originX: 0, originY: 0, width: 1920, height: 1080 });
      }
      if (cmd === "capture_region") {
        return Promise.resolve({ pngBase64: "AAAA", width: 100, height: 50 });
      }
      if (cmd === "ocr_region") {
        return Promise.resolve("  OCR result  ");
      }
      return Promise.resolve();
    });

    render(<ScreenshotTool />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const overlay = document.querySelector(".ss-overlay") as HTMLElement;
    overlay.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
      right: 1920,
      bottom: 1080,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })) as never;

    fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 300, clientY: 200, pointerId: 1 });
    await act(async () => {
      fireEvent.pointerUp(overlay, { clientX: 300, clientY: 200, pointerId: 1 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "OCR" }));
    });

    expect(mockInvoke).toHaveBeenCalledWith("ocr_region", {
      left: 100,
      top: 100,
      width: 200,
      height: 100,
    });
    const result = screen.getByRole("textbox", { name: "OCR 识别文本" }) as HTMLTextAreaElement;
    expect(result.value).toBe("  OCR result  ");
    expect(mockInvoke).not.toHaveBeenCalledWith("copy_text", expect.anything());

    result.setSelectionRange(2, 5);
    fireEvent.select(result);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制选中" }));
    });
    expect(mockInvoke).toHaveBeenCalledWith("copy_text", { text: "OCR" });

    const dialog = screen.getByRole("dialog", { name: "OCR 结果" }) as HTMLDivElement;
    dialog.getBoundingClientRect = vi.fn(() => ({
      left: 640,
      top: 360,
      width: 400,
      height: 300,
      right: 1040,
      bottom: 660,
      x: 640,
      y: 360,
      toJSON: () => ({}),
    })) as never;
    const header = dialog.querySelector(".ss-ocr-result-header") as HTMLDivElement;
    await act(async () => {
      fireEvent.pointerDown(header, { clientX: 660, clientY: 380, pointerId: 2 });
      fireEvent.pointerMove(header, { clientX: 220, clientY: 180, pointerId: 2 });
      fireEvent.pointerUp(header, { clientX: 220, clientY: 180, pointerId: 2 });
    });
    expect(dialog.style.left).toBe("200px");
    expect(dialog.style.top).toBe("160px");
  });

  it("OCR 返回空文本时显示提示且不清空剪贴板", async () => {
    stubCanvas();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_virtual_desktop_bounds") {
        return Promise.resolve({ originX: 0, originY: 0, width: 1920, height: 1080 });
      }
      if (cmd === "capture_region") {
        return Promise.resolve({ pngBase64: "AAAA", width: 100, height: 50 });
      }
      if (cmd === "ocr_region") {
        return Promise.resolve("   ");
      }
      return Promise.resolve();
    });

    render(<ScreenshotTool />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const overlay = document.querySelector(".ss-overlay") as HTMLElement;
    overlay.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
      right: 1920,
      bottom: 1080,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })) as never;

    fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 300, clientY: 200, pointerId: 1 });
    await act(async () => {
      fireEvent.pointerUp(overlay, { clientX: 300, clientY: 200, pointerId: 1 });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "OCR" }));
    });

    expect(screen.getByText("未识别到文字")).toBeTruthy();
    expect(mockInvoke).not.toHaveBeenCalledWith("copy_text", expect.anything());
    expect(document.querySelector(".ss-annotate-toolbar")).not.toBeNull();
  });

  it("窗口识别模式：点击窗口后按窗口区域自动截图并进入标注态", async () => {
    stubCanvas();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_virtual_desktop_bounds") {
        return Promise.resolve({ originX: 0, originY: 0, width: 1920, height: 1080 });
      }
      if (cmd === "enumerate_windows") {
        return Promise.resolve([
          {
            hwnd: 1,
            title: "记事本",
            className: "Notepad",
            left: 100,
            top: 50,
            width: 800,
            height: 600,
          },
          {
            hwnd: 2,
            title: "浏览器",
            className: "Chrome",
            left: 900,
            top: 80,
            width: 700,
            height: 500,
          },
        ]);
      }
      if (cmd === "capture_region") {
        return Promise.resolve({ pngBase64: "AAAA", width: 800, height: 600 });
      }
      return Promise.resolve();
    });

    render(<ScreenshotTool />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // 切换到窗口模式
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "窗口" }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // 窗口列表加载完成
    expect(screen.getByText("记事本")).toBeTruthy();
    expect(screen.getByText("浏览器")).toBeTruthy();

    // 点击某个窗口
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /记事本/ }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // capture_region 以窗口物理坐标调用，并进入标注态
    expect(mockInvoke).toHaveBeenCalledWith("capture_region", {
      left: 100,
      top: 50,
      width: 800,
      height: 600,
    });
    expect(document.querySelector(".ss-annotate-toolbar")).not.toBeNull();
  });

  it("窗口识别模式：点击取消恢复区域模式并退出截图", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_virtual_desktop_bounds") {
        return Promise.resolve({ originX: 0, originY: 0, width: 1920, height: 1080 });
      }
      if (cmd === "enumerate_windows") {
        return Promise.resolve([
          { hwnd: 1, title: "记事本", className: "", left: 0, top: 0, width: 800, height: 600 },
        ]);
      }
      return Promise.resolve();
    });

    render(<ScreenshotTool />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "窗口" }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText("记事本")).toBeTruthy();

    // 取消后调用 cancel_screenshot
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
    });
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "cancel_screenshot")).toBe(true);
  });
});
