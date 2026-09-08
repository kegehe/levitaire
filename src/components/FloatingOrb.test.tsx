import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { clearMockListeners, emitMockEvent, menuState, mockStartDragging } from "../test/tauri-mock";
import { ensureScreenshotWindow, showContextMenu } from "../utils/toolWindows";
import FloatingOrb from "./FloatingOrb";

// Mock 依赖模块，聚焦测试右键菜单逻辑
vi.mock("../utils/toolWindows", () => ({
  ensureScreenshotWindow: vi.fn(async () => ({})),
  ensureContextMenuWindow: vi.fn(async () => ({})),
  showContextMenu: vi.fn(async () => undefined),
  openToolWindow: vi.fn(async () => true),
  preloadEnabledToolWindows: vi.fn(async () => undefined),
}));
vi.mock("../utils/windowPosition", () => ({
  saveWindowPosition: vi.fn(),
  persistWindowPositionOnMove: vi.fn(() => () => {}),
}));
vi.mock("../styles/themePreferences", () => ({
  applyThemePreferences: vi.fn(),
  getStoredThemePreferences: vi.fn(() => ({})),
  subscribeThemePreferences: vi.fn(async () => () => {}),
}));
vi.mock("../tools/registry", () => ({
  BACKEND_TOOLS: [],
}));

const mockInvoke = vi.mocked(invoke);
const mockEnsureScreenshotWindow = vi.mocked(ensureScreenshotWindow);
const mockShowContextMenu = vi.mocked(showContextMenu);

async function flush() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

/** 渲染浮球并触发一次右键。 */
async function renderAndOpenContextMenu() {
  render(<FloatingOrb />);
  await act(flush);
  fireEvent.contextMenu(document.querySelector(".orb-container")!);
  await act(flush);
}

describe("FloatingOrb 右键菜单", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    menuState.items.clear();
    menuState.popup.mockClear();
    localStorage.clear();
    mockInvoke.mockResolvedValue(undefined);
  });

  it("右键悬浮球时打开自定义菜单", async () => {
    await renderAndOpenContextMenu();
    expect(mockShowContextMenu).toHaveBeenCalledWith(expect.objectContaining({ source: "orb" }));
  });

  it("右键不直接启动截图或录屏", async () => {
    await renderAndOpenContextMenu();
    expect(mockEnsureScreenshotWindow).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalledWith("start_screenshot");
    expect(mockInvoke).not.toHaveBeenCalledWith("start_recording_select");
    expect(menuState.items.size).toBe(0);
  });

  it("左键拖拽不受右键菜单影响（mousedown 仅响应左键）", async () => {
    render(<FloatingOrb />);
    await act(flush);
    const orb = document.querySelector(".orb-container")!;
    // 右键 mousedown 不应触发拖拽
    fireEvent.mouseDown(orb, { button: 2 });
    await act(flush);
    expect(menuState.popup).not.toHaveBeenCalled();
  });

  it("仅在圆形热区（视觉球）内按下才启动拖拽，球外留白不拖拽", async () => {
    render(<FloatingOrb />);
    await act(flush);
    const orb = document.querySelector(".orb-container")!;
    // 模拟 56×56 的球容器：中心 (28,28)，交互半径 = 56/2 + 2 = 30
    const rectSpy = vi
      .spyOn(orb, "getBoundingClientRect")
      .mockReturnValue({
        left: 0,
        top: 0,
        width: 56,
        height: 56,
        right: 56,
        bottom: 56,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);

    // 球内按下（距圆心约 11px）→ 启动拖拽
    fireEvent.mouseDown(orb, { button: 0, clientX: 20, clientY: 20 });
    await act(flush);
    expect(mockStartDragging).toHaveBeenCalledTimes(1);

    // 球外留白角落按下（距圆心约 37px，超出 30）→ 不启动拖拽
    mockStartDragging.mockClear();
    fireEvent.mouseDown(orb, { button: 0, clientX: 2, clientY: 2 });
    await act(flush);
    expect(mockStartDragging).not.toHaveBeenCalled();

    rectSpy.mockRestore();
  });

  it("点击浮球后在鼠标抬起尾部事件完成后打开面板", async () => {
    vi.useFakeTimers();
    try {
      render(<FloatingOrb />);
      await act(flush);
      mockInvoke.mockClear();

      emitMockEvent("orb-mouseup", true);
      expect(mockInvoke).not.toHaveBeenCalledWith("show_palette");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(80);
      });
      expect(mockInvoke).toHaveBeenCalledWith("show_palette");
    } finally {
      vi.useRealTimers();
    }
  });
});
