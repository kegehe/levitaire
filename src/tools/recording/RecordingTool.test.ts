import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitMockEvent } from "../../test/tauri-mock";
import RecordingTool, { getControlsPosition, isEdgeToEdgeRegion } from "./RecordingTool";

const mockInvoke = vi.mocked(invoke);

describe("getControlsPosition", () => {
  const viewportWidth = 1920;
  const viewportHeight = 1080;

  it("prefers the space to the right of the recorded region", () => {
    expect(getControlsPosition({ left: 100, top: 200, width: 800, height: 500 }, viewportWidth, viewportHeight))
      .toEqual({ left: 908, top: 200 });
  });

  it("uses the left, bottom, then top safe space", () => {
    expect(getControlsPosition({ left: 1600, top: 200, width: 300, height: 500 }, viewportWidth, viewportHeight))
      .toEqual({ left: 1456, top: 200 });
    expect(getControlsPosition({ left: 0, top: 100, width: 1920, height: 500 }, viewportWidth, viewportHeight))
      .toEqual({ left: 8, top: 608 });
    expect(getControlsPosition({ left: 0, top: 600, width: 1920, height: 400 }, viewportWidth, viewportHeight))
      .toEqual({ left: 8, top: 464 });
  });

  it("keeps controls visible for a full-screen region", () => {
    expect(getControlsPosition({ left: 0, top: 0, width: 1920, height: 1080 }, viewportWidth, viewportHeight))
      .toEqual({ left: 1776, top: 8 });
  });
});

describe("isEdgeToEdgeRegion", () => {
  it("identifies a full viewport recording region", () => {
    expect(isEdgeToEdgeRegion({ left: 0, top: 0, width: 1920, height: 1080 }, 1920, 1080)).toBe(true);
    expect(isEdgeToEdgeRegion({ left: 1, top: 1, width: 1919, height: 1079 }, 1920, 1080)).toBe(true);
  });

  it("does not apply the full-screen border to an interior region", () => {
    expect(isEdgeToEdgeRegion({ left: 20, top: 20, width: 1800, height: 1000 }, 1920, 1080)).toBe(false);
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
});
