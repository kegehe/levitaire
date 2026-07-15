import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitMockEvent } from "../../test/tauri-mock";
import RecordingControls from "./RecordingControls";

const mockInvoke = vi.mocked(invoke);

describe("RecordingControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes its state whenever a new recording starts", async () => {
    let state = { paused: true, elapsedMs: 12_000, frameCount: 42 };
    mockInvoke.mockImplementation((command) => {
      if (command === "get_recording_state") return Promise.resolve(state);
      return Promise.resolve();
    });

    render(<RecordingControls />);
    await waitFor(() => expect(screen.getByTitle("继续录制")).toBeTruthy());
    await act(async () => {
      await Promise.resolve();
    });
    const syncsBeforeStart = mockInvoke.mock.calls.filter(([command]) => command === "get_recording_state").length;

    state = { paused: false, elapsedMs: 0, frameCount: 0 };
    act(() => emitMockEvent("recording-controls-started", undefined));

    await waitFor(() => {
      expect(mockInvoke.mock.calls.filter(([command]) => command === "get_recording_state").length)
        .toBeGreaterThan(syncsBeforeStart);
      expect(screen.getByTitle("暂停录制")).toBeTruthy();
      expect(screen.getByText("0 帧")).toBeTruthy();
    });
  });

  it("does not issue duplicate pause requests while an action is pending", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_recording_state") {
        return Promise.resolve({ paused: false, elapsedMs: 0, frameCount: 0 });
      }
      return Promise.resolve();
    });

    render(<RecordingControls />);
    await waitFor(() => expect(screen.getByTitle("暂停录制")).toBeTruthy());

    const pause = screen.getByTitle("暂停录制");
    fireEvent.click(pause);
    fireEvent.click(pause);

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("pause_recording"));
    expect(mockInvoke.mock.calls.filter(([command]) => command === "pause_recording")).toHaveLength(1);
  });
});
