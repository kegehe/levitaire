import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AreaSelector from "./AreaSelector";
import type { WindowInfo } from "./recordingConfig";

const mockInvoke = vi.mocked(invoke);

/** 一块 1920×1080 的虚拟桌面，测试按需覆盖 innerWidth 以验证 DPI 换算 */
const DESKTOP = { originX: 0, originY: 0, width: 1920, height: 1080 };

function makeWindow(overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    hwnd: 1,
    title: "记事本",
    className: "Notepad",
    left: 100,
    top: 200,
    width: 800,
    height: 600,
    ...overrides,
  };
}

/** overlay 的视口宽度决定 scale = 桌面宽度 / innerWidth */
function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
}

async function renderWindowMode(windows: WindowInfo[]) {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_virtual_desktop_bounds") return DESKTOP;
    if (cmd === "enumerate_windows") return windows;
    return undefined;
  });

  const onAreaSelected = vi.fn();
  const onCancel = vi.fn();
  render(<AreaSelector onAreaSelected={onAreaSelected} onCancel={onCancel} />);

  fireEvent.click(screen.getByRole("button", { name: /窗口/ }));
  await waitFor(() => {
    if (windows.length === 0) {
      expect(screen.getByText("未检测到可录制的窗口")).toBeInTheDocument();
    } else {
      expect(screen.getByText(windows[0].title)).toBeInTheDocument();
    }
  });
  return { onAreaSelected, onCancel };
}

describe("AreaSelector 窗口模式", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    setViewportWidth(1920);
  });

  it("未悬停时不显示呼吸预览框", async () => {
    await renderWindowMode([makeWindow()]);
    expect(document.querySelector(".rec-window-hint")).toBeNull();
  });

  it("悬停列表项时在窗口真实位置显示呼吸预览框", async () => {
    await renderWindowMode([
      makeWindow(),
      makeWindow({ hwnd: 2, title: "浏览器", left: 400, top: 100, width: 500, height: 400 }),
    ]);

    fireEvent.mouseEnter(screen.getByRole("button", { name: /记事本/ }));

    const hint = document.querySelector<HTMLElement>(".rec-window-hint");
    expect(hint).not.toBeNull();
    expect(hint!.style.left).toBe("100px");
    expect(hint!.style.top).toBe("200px");
    expect(hint!.style.width).toBe("800px");
    expect(hint!.style.height).toBe("600px");
    expect(hint!.textContent).toContain("记事本 · 800×600");

    // 换到另一个窗口时预览框跟随移动
    fireEvent.mouseEnter(screen.getByRole("button", { name: /浏览器/ }));
    const moved = document.querySelector<HTMLElement>(".rec-window-hint");
    expect(moved!.style.left).toBe("400px");
    expect(moved!.style.width).toBe("500px");
  });

  it("按 DPI 缩放把物理像素换算成 overlay 的 CSS 像素", async () => {
    setViewportWidth(960); // scale = 1920 / 960 = 2
    await renderWindowMode([makeWindow()]);

    fireEvent.mouseEnter(screen.getByRole("button", { name: /记事本/ }));

    const hint = document.querySelector<HTMLElement>(".rec-window-hint");
    expect(hint!.style.left).toBe("50px");
    expect(hint!.style.top).toBe("100px");
    expect(hint!.style.width).toBe("400px");
    expect(hint!.style.height).toBe("300px");
  });

  it("鼠标移出列表项后预览框消失", async () => {
    await renderWindowMode([makeWindow()]);

    const item = screen.getByRole("button", { name: /记事本/ });
    fireEvent.mouseEnter(item);
    expect(document.querySelector(".rec-window-hint")).not.toBeNull();

    // 移到列表空白处（滚动后光标不再落在项上也是这条路径）同样要收起
    fireEvent.mouseLeave(item);
    expect(document.querySelector(".rec-window-hint")).toBeNull();
  });

  it("在列表项之间移动时预览框跟随切换到新窗口", async () => {
    await renderWindowMode([
      makeWindow(),
      makeWindow({ hwnd: 2, title: "浏览器", left: 400, top: 100, width: 500, height: 400 }),
    ]);
    const noteItem = screen.getByRole("button", { name: /记事本/ });
    const browserItem = screen.getByRole("button", { name: /浏览器/ });

    fireEvent.mouseEnter(noteItem);
    fireEvent.mouseLeave(noteItem, { relatedTarget: browserItem });
    fireEvent.mouseEnter(browserItem);

    const hint = document.querySelector<HTMLElement>(".rec-window-hint")!;
    expect(hint.style.left).toBe("400px");
    expect(hint.style.width).toBe("500px");
  });

  it("点击列表项立即回调窗口物理矩形并收起预览框", async () => {
    const { onAreaSelected } = await renderWindowMode([makeWindow()]);

    fireEvent.mouseEnter(screen.getByRole("button", { name: /记事本/ }));
    fireEvent.click(screen.getByRole("button", { name: /记事本/ }));

    expect(onAreaSelected).toHaveBeenCalledWith({ left: 100, top: 200, width: 800, height: 600 });
    // 录制即将开始，预览框不能残留在画面里被首帧截到
    expect(document.querySelector(".rec-window-hint")).toBeNull();
  });

  it("没有可录制窗口时不渲染列表项与预览框", async () => {
    await renderWindowMode([]);
    expect(document.querySelectorAll(".rec-window-item")).toHaveLength(0);
    expect(document.querySelector(".rec-window-hint")).toBeNull();
  });
});
