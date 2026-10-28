import { act, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMockListeners,
  emitMockEvent,
  mockSetSize,
  setMockWindow,
} from "../../test/tauri-mock";
import LongCaptureControls from "./LongCaptureControls";

const mockInvoke = vi.mocked(invoke);

/** 声明级真值：happy-dom 不做布局，换行与否只能对着 CSS 源码断言。 */
function readControlsCss(): string {
  const css = readFileSync(
    fileURLToPath(new NodeURL("./LongCaptureControls.css", import.meta.url)),
    "utf8",
  );
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
}

function ruleFor(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  return start === -1 ? "" : css.slice(start, css.indexOf("}", start));
}

const STARTED = {
  resultId: 7,
  width: 800,
  height: 1200,
  frameCount: 3,
  status: "capturing" as const,
  message: null,
};

// 面板实测高度（逻辑像素）。警告出现时面板会多一行，这里用可变值模拟。
let panelHeight = 71;
// 布局高度（offsetHeight）：默认 0，走 rect 兜底；用一个用例模拟"rect 被入场动画缩小"。
let layoutHeight = 0;

beforeEach(() => {
  panelHeight = 71;
  layoutHeight = 0;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => layoutHeight,
  });
  setMockWindow({ label: "long-capture-controls" });
  clearMockListeners();
  mockSetSize.mockClear();
  // restoreAllMocks 可能把共享 mock 的实现一起清掉，setSize 返回 undefined 会让
  // 组件里的 .catch 直接炸，这里补回来
  mockSetSize.mockResolvedValue(undefined);
  mockInvoke.mockImplementation((command: string) => {
    // 轮询拿到 undefined 会把 view.result 覆盖成空，组件再渲染就炸
    if (command === "get_long_capture_status") return Promise.resolve(STARTED);
    if (command === "get_long_capture_preview") return Promise.resolve("");
    return Promise.resolve();
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ width: 300, height: panelHeight }) as DOMRect,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  clearMockListeners();
});

describe("长截图进行中控制条", () => {
  it("窗口高度按实测内容下发，警告出现后跟着变高", async () => {
    render(<LongCaptureControls />);
    act(() => emitMockEvent("long-capture-started", STARTED));
    await screen.findByText("正在截长图");

    const win = (await import("@tauri-apps/api/webviewWindow")).getCurrentWebviewWindow();
    await waitFor(() => {
      expect(win.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 300, height: 71 }));
    });

    // 第四行（警告）出现：窗口若停在 71 就会被下沿裁掉
    panelHeight = 96;
    act(() =>
      emitMockEvent("long-capture-warning", {
        resultId: STARTED.resultId,
        message: "滚动过快，未能识别相邻画面的重叠区域；请放慢滚动速度",
      }),
    );
    await screen.findByText(/滚动过快/);
    await waitFor(() => {
      expect(win.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 300, height: 96 }));
    });
    // 变高后请后端按选区重新摆位：控制条压在选区上会被长截图的 BitBlt 抓进后续帧
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("reposition_long_capture_controls", { height: 96 });
    });
  });

  it("警告独占一行，不塞进标题/说明/进度那一列", async () => {
    render(<LongCaptureControls />);
    act(() => emitMockEvent("long-capture-started", STARTED));
    act(() =>
      emitMockEvent("long-capture-warning", {
        resultId: STARTED.resultId,
        message: "已达到长截图 30MP 上限，结果已保留",
      }),
    );

    const warning = await screen.findByText(/30MP 上限/);
    const toolbar = screen.getByRole("toolbar");
    // 与三行文案同一列时，它必然是第四行 —— 就是会被窗口下沿裁掉的那个位置
    expect(warning.closest(".long-capture-count")).toBeNull();
    expect(toolbar?.lastElementChild).toBe(warning);
    // 警告要能换行完整显示，不能沿用单行省略号
    const rule = ruleFor(readControlsCss(), ".long-capture-warning");
    expect(rule).toContain("white-space: normal");
    expect(rule).not.toContain("ellipsis");
  });

  it("入场动画期间按布局高度量，不按被 scale 缩小的 rect", async () => {
    // long-capture-enter 从 scale(0.985) 起，rect 会比布局高度小 1~2px；
    // 只信 rect 就会把窗口设小，警告行照样被裁。
    layoutHeight = 71;
    panelHeight = 70;

    render(<LongCaptureControls />);
    act(() => emitMockEvent("long-capture-started", STARTED));
    await screen.findByText("正在截长图");

    const win = (await import("@tauri-apps/api/webviewWindow")).getCurrentWebviewWindow();
    await waitFor(() => {
      expect(win.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 300, height: 71 }));
    });
  });

  it("尺寸没变就只下发一次（ResizeObserver / warning 重跑都不重复重排）", async () => {
    render(<LongCaptureControls />);
    act(() => emitMockEvent("long-capture-started", STARTED));
    await screen.findByText("正在截长图");

    const win = (await import("@tauri-apps/api/webviewWindow")).getCurrentWebviewWindow();
    await waitFor(() => expect(win.setSize).toHaveBeenCalledTimes(1));

    // warning 变化会让量高 effect 整体重跑一次；面板高度没变时不能再来一次 setSize
    act(() =>
      emitMockEvent("long-capture-warning", {
        resultId: STARTED.resultId,
        message: "滚动过快，未能识别相邻画面的重叠区域；请放慢滚动速度",
      }),
    );
    await screen.findByText(/滚动过快/);
    expect(win.setSize).toHaveBeenCalledTimes(1);
  });
});
