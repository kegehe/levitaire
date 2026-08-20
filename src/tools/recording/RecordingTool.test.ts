import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitMockEvent } from "../../test/tauri-mock";
import { ensureRecordingControlsWindow } from "../../utils/toolWindows";
import RecordingTool, {
  getControlsPosition,
  isEdgeToEdgeRegion,
  resolveControlsPlacement,
} from "./RecordingTool";

// 全屏录制不应创建控制栏窗口（否则会被 BitBlt 截进视频），mock 掉以便断言其未被调用。
vi.mock("../../utils/toolWindows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/toolWindows")>();
  return {
    ...actual,
    ensureRecordingControlsWindow: vi.fn().mockResolvedValue({
      setPosition: vi.fn().mockResolvedValue(undefined),
      show: vi.fn().mockResolvedValue(undefined),
      hide: vi.fn().mockResolvedValue(undefined),
    }),
  };
});

const mockInvoke = vi.mocked(invoke);
const mockEnsureRecordingControls = vi.mocked(ensureRecordingControlsWindow);

describe("getControlsPosition", () => {
  const viewportWidth = 1920;
  const viewportHeight = 1080;

  it("prefers the space to the right of the recorded region", () => {
    expect(
      getControlsPosition(
        { left: 100, top: 200, width: 800, height: 500 },
        viewportWidth,
        viewportHeight,
      ),
    ).toEqual({ left: 908, top: 200 });
  });

  it("uses the left, bottom, then top safe space", () => {
    expect(
      getControlsPosition(
        { left: 1600, top: 200, width: 300, height: 500 },
        viewportWidth,
        viewportHeight,
      ),
    ).toEqual({ left: 1456, top: 200 });
    expect(
      getControlsPosition(
        { left: 0, top: 100, width: 1920, height: 500 },
        viewportWidth,
        viewportHeight,
      ),
    ).toEqual({ left: 8, top: 608 });
    expect(
      getControlsPosition(
        { left: 0, top: 600, width: 1920, height: 400 },
        viewportWidth,
        viewportHeight,
      ),
    ).toEqual({ left: 8, top: 464 });
  });

  it("returns null when a full-screen region leaves no outside space", () => {
    expect(
      getControlsPosition(
        { left: 0, top: 0, width: 1920, height: 1080 },
        viewportWidth,
        viewportHeight,
      ),
    ).toBeNull();
  });
});

describe("resolveControlsPlacement", () => {
  it("keeps the region and places controls outside when space is available", () => {
    expect(
      resolveControlsPlacement({ left: 100, top: 200, width: 800, height: 500 }, 1920, 1080),
    ).toEqual({
      region: { left: 100, top: 200, width: 800, height: 500 },
      controls: { left: 908, top: 200 },
      overlay: false,
    });
  });

  it("keeps the full-screen region and overlays the controls without shrinking it", () => {
    expect(
      resolveControlsPlacement({ left: 0, top: 0, width: 1920, height: 1080 }, 1920, 1080),
    ).toEqual({
      region: { left: 0, top: 0, width: 1920, height: 1080 },
      controls: { left: 8, top: 8 },
      overlay: true,
    });
    // 极小全屏视口同样走 overlay 分支：不收缩、不校验控制栏尺寸（全屏不显示控制栏）
    expect(
      resolveControlsPlacement({ left: 0, top: 0, width: 100, height: 100 }, 100, 100),
    ).toEqual({
      region: { left: 0, top: 0, width: 100, height: 100 },
      controls: { left: 8, top: 8 },
      overlay: true,
    });
  });

  it("shrinks the bottom edge for a near-full-screen region without outside space", () => {
    expect(
      resolveControlsPlacement({ left: 20, top: 20, width: 300, height: 200 }, 400, 300),
    ).toEqual({
      region: { left: 20, top: 20, width: 300, height: 128 },
      controls: { left: 132, top: 156 },
      overlay: false,
    });
  });

  it("returns null when the viewport cannot fit controls even after shrinking", () => {
    // 区域带顶部偏移，收缩后控制栏会越出屏幕底边
    expect(
      resolveControlsPlacement({ left: 50, top: 50, width: 300, height: 200 }, 400, 300),
    ).toBeNull();
  });
});

describe("isEdgeToEdgeRegion", () => {
  it("identifies a full viewport recording region", () => {
    expect(isEdgeToEdgeRegion({ left: 0, top: 0, width: 1920, height: 1080 }, 1920, 1080)).toBe(
      true,
    );
    expect(isEdgeToEdgeRegion({ left: 1, top: 1, width: 1919, height: 1079 }, 1920, 1080)).toBe(
      true,
    );
  });

  it("does not apply the full-screen border to an interior region", () => {
    expect(isEdgeToEdgeRegion({ left: 20, top: 20, width: 1800, height: 1000 }, 1920, 1080)).toBe(
      false,
    );
  });
});

describe("RecordingTool preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockImplementation((command) => {
      if (command === "get_virtual_desktop_bounds") {
        return Promise.resolve({ originX: 0, originY: 0, width: 1920, height: 1080 });
      }
      return Promise.resolve();
    });
  });

  it("restarts GIF recording at area selection instead of closing the overlay", async () => {
    render(createElement(RecordingTool));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(document.querySelector(".rec-mode-gif")!);

    act(() => {
      emitMockEvent("recording-progress", {
        type: "done",
        gifBase64: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      });
    });
    await waitFor(() => expect(screen.getByText("重新录制")).toBeTruthy());

    mockInvoke.mockClear();
    fireEvent.click(screen.getByText("重新录制"));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("start_recording_select"));
    expect(mockInvoke).toHaveBeenCalledWith("cancel_recording");
    expect(mockInvoke).not.toHaveBeenCalledWith("cancel_recording_select");
    expect(document.querySelector(".rec-area-tabs")).toBeTruthy();
  });

  it("GIF 复制到剪贴板失败时在预览面板显示错误提示", async () => {
    render(createElement(RecordingTool));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(document.querySelector(".rec-mode-gif")!);

    act(() => {
      emitMockEvent("recording-progress", {
        type: "done",
        gifBase64: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      });
    });
    await waitFor(() => expect(screen.getByText("重新录制")).toBeTruthy());

    mockInvoke.mockClear();
    mockInvoke.mockImplementation((command) => {
      if (command === "get_virtual_desktop_bounds") {
        return Promise.resolve({ originX: 0, originY: 0, width: 1920, height: 1080 });
      }
      if (command === "clipboard_set_gif") {
        return Promise.reject(new Error("复制失败"));
      }
      return Promise.resolve();
    });

    fireEvent.click(screen.getByText("复制"));
    await waitFor(() => expect(screen.getByText("复制失败")).toBeTruthy());
  });

  it("复制失败后再复制（成功）会清除之前的错误提示", async () => {
    render(createElement(RecordingTool));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(document.querySelector(".rec-mode-gif")!);

    act(() => {
      emitMockEvent("recording-progress", {
        type: "done",
        gifBase64: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      });
    });
    await waitFor(() => expect(screen.getByText("重新录制")).toBeTruthy());

    let copyCount = 0;
    mockInvoke.mockClear();
    mockInvoke.mockImplementation((command) => {
      if (command === "get_virtual_desktop_bounds") {
        return Promise.resolve({ originX: 0, originY: 0, width: 1920, height: 1080 });
      }
      if (command === "clipboard_set_gif") {
        copyCount++;
        if (copyCount === 1) return Promise.reject(new Error("复制失败"));
        return Promise.resolve();
      }
      return Promise.resolve();
    });

    fireEvent.click(screen.getByText("复制"));
    await waitFor(() => expect(screen.getByText("复制失败")).toBeTruthy());

    fireEvent.click(screen.getByText("复制"));
    await waitFor(() => expect(screen.queryByText("复制失败")).toBeNull());
  });

  it("保存 GIF 失败时在预览面板显示错误提示", async () => {
    render(createElement(RecordingTool));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(document.querySelector(".rec-mode-gif")!);

    act(() => {
      emitMockEvent("recording-progress", {
        type: "done",
        gifBase64: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      });
    });
    await waitFor(() => expect(screen.getByText("重新录制")).toBeTruthy());

    mockInvoke.mockClear();
    mockInvoke.mockImplementation((command) => {
      if (command === "get_virtual_desktop_bounds") {
        return Promise.resolve({ originX: 0, originY: 0, width: 1920, height: 1080 });
      }
      if (command === "save_gif") {
        return Promise.reject(new Error("保存失败"));
      }
      return Promise.resolve();
    });

    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(screen.getByText("保存失败")).toBeTruthy());
  });
});

describe("RecordingTool 使用用户配置的帧率/时长", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom 默认窗口为 1024×768，与 mock 的虚拟桌面 1920×1080 不一致会导致
    // cssRegion 未铺满视口、全屏分支不触发。把窗口设为与虚拟桌面一致，使
    // 「全屏」选区恰好铺满视口，走 overlay（不收缩）分支。
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1920,
    });
    Object.defineProperty(window, "innerHeight", {
      writable: true,
      configurable: true,
      value: 1080,
    });
    mockInvoke.mockImplementation((command) => {
      if (command === "get_virtual_desktop_bounds") {
        return Promise.resolve({ originX: 0, originY: 0, width: 1920, height: 1080 });
      }
      if (command === "get_recording_config") {
        return Promise.resolve(JSON.stringify({ gifFps: 5, videoFps: 30, maxDurationSec: 60 }));
      }
      return Promise.resolve();
    });
  });

  /** 进入全屏区域选择并确认，触发 start_recording */
  const startFullscreenRecording = async (modeClass: string) => {
    render(createElement(RecordingTool));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(document.querySelector(modeClass)!);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText("全屏"));
    fireEvent.click(screen.getByText("开始选择"));
  };

  it("GIF 录制使用配置的 gifFps 与 maxDurationSec，全屏录制完整区域且不创建控制栏", async () => {
    await startFullscreenRecording(".rec-mode-gif");
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "start_recording",
        expect.objectContaining({ mode: "gif", fps: 5, maxDurationSec: 60 }),
      ),
    );
    // 全屏录制应使用完整虚拟桌面区域（不再收缩底部 144px），且不显示控制栏
    expect(mockInvoke).toHaveBeenCalledWith(
      "start_recording",
      expect.objectContaining({ left: 0, top: 0, width: 1920, height: 1080 }),
    );
    expect(mockEnsureRecordingControls).not.toHaveBeenCalled();
    // 已进入录制阶段：遮罩出现；全屏录制不渲染选区框（inset 边框会截进视频）
    await waitFor(() => expect(document.querySelector(".rec-rec-mask")).toBeTruthy());
    expect(document.querySelector(".rec-rec-selection")).toBeNull();
  });

  it("视频录制使用配置的 videoFps 与 maxDurationSec，全屏不创建控制栏", async () => {
    await startFullscreenRecording(".rec-mode-video");
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "start_recording",
        expect.objectContaining({ mode: "video", fps: 30, maxDurationSec: 60 }),
      ),
    );
    expect(mockEnsureRecordingControls).not.toHaveBeenCalled();
  });
});
