import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { clearMockListeners, menuState, mockHide, triggerMenuAction } from "../test/tauri-mock";
import { ensureScreenshotWindow } from "../utils/toolWindows";
import FloatingOrb from "./FloatingOrb";

// Mock 依赖模块，聚焦测试右键菜单逻辑
vi.mock("../utils/toolWindows", () => ({
  ensureScreenshotWindow: vi.fn(async () => ({})),
  openToolWindow: vi.fn(async () => true),
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

async function flush() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

/** 渲染浮球并触发一次右键（构建菜单） */
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

  it("右键悬浮球时弹出原生菜单", async () => {
    await renderAndOpenContextMenu();
    expect(menuState.popup).toHaveBeenCalledTimes(1);
  });

  it("菜单项 id 与托盘菜单隔离，避免全局事件交叉触发", async () => {
    await renderAndOpenContextMenu();
    const ids = Array.from(menuState.items.keys());
    expect(ids).toEqual(["screenshot", "recording", "open-settings", "hide-orb", "quit-app"]);
    // 托盘菜单使用 quit / show_settings / toggle_orb，前端菜单不得复用
    expect(ids).not.toContain("quit");
    expect(ids).not.toContain("show_settings");
    expect(ids).not.toContain("toggle_orb");
  });

  it("「屏幕截图」进入截图流程", async () => {
    await renderAndOpenContextMenu();
    await act(async () => {
      triggerMenuAction("screenshot");
      await flush();
    });
    expect(mockEnsureScreenshotWindow).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("start_screenshot");
  });

  it("「GIF/录屏」进入录屏流程", async () => {
    await renderAndOpenContextMenu();
    await act(async () => {
      triggerMenuAction("recording");
      await flush();
    });
    expect(mockEnsureScreenshotWindow).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("start_recording_select");
  });

  it("「设置」打开设置窗口", async () => {
    await renderAndOpenContextMenu();
    await act(async () => {
      triggerMenuAction("open-settings");
      await flush();
    });
    expect(mockInvoke).toHaveBeenCalledWith("show_settings");
  });

  it("「隐藏悬浮球」隐藏 orb 窗口", async () => {
    await renderAndOpenContextMenu();
    await act(async () => {
      triggerMenuAction("hide-orb");
      await flush();
    });
    expect(mockHide).toHaveBeenCalledTimes(1);
  });

  it("「退出」调用 exit_app 命令", async () => {
    await renderAndOpenContextMenu();
    await act(async () => {
      triggerMenuAction("quit-app");
      await flush();
    });
    expect(mockInvoke).toHaveBeenCalledWith("exit_app");
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
});
