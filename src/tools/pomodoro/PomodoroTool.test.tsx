import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitMockEvent } from "../../test/tauri-mock";
import PomodoroTool from "./PomodoroTool";

const mockInvoke = vi.mocked(invoke);

const DEFAULT_CONFIG = JSON.stringify({
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  roundsBeforeLongBreak: 4,
  autoStartNext: false,
  notifySound: true,
});

function mockBaseState() {
  mockInvoke.mockImplementation((command) => {
    if (command === "get_pomodoro_state") {
      return Promise.resolve({
        stage: "focus",
        remaining_secs: 1500,
        total_secs: 1500,
        running: false,
        rounds_done: 0,
      });
    }
    if (command === "get_pomodoro_config") {
      return Promise.resolve(DEFAULT_CONFIG);
    }
    return Promise.resolve();
  });
}

describe("PomodoroTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders initial remaining time from backend state", async () => {
    mockBaseState();
    render(<PomodoroTool />);
    await waitFor(() => expect(screen.getByText("25:00")).toBeTruthy());
    expect(screen.getByText("专注")).toBeTruthy();
    expect(screen.getByText("开始")).toBeTruthy();
  });

  it("uses the saved work duration when backend state is unavailable", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_pomodoro_state") {
        return Promise.reject(new Error("state unavailable"));
      }
      if (command === "get_pomodoro_config") {
        return Promise.resolve(JSON.stringify({ ...JSON.parse(DEFAULT_CONFIG), workMinutes: 45 }));
      }
      return Promise.resolve();
    });

    render(<PomodoroTool />);
    await waitFor(() => expect(screen.getByText("45:00")).toBeTruthy());
  });

  it("updates the time and running state on pomodoro-tick", async () => {
    mockBaseState();
    render(<PomodoroTool />);
    await waitFor(() => expect(screen.getByText("25:00")).toBeTruthy());

    act(() =>
      emitMockEvent("pomodoro-tick", {
        stage: "focus",
        remaining_secs: 1495,
        total_secs: 1500,
        running: true,
        rounds_done: 0,
      }),
    );
    await waitFor(() => expect(screen.getByText("24:55")).toBeTruthy());
    expect(screen.getByText("暂停")).toBeTruthy();
  });

  it("updates the stage and round indicator on pomodoro-complete", async () => {
    mockBaseState();
    render(<PomodoroTool />);
    await waitFor(() => expect(screen.getByText("25:00")).toBeTruthy());

    act(() =>
      emitMockEvent("pomodoro-complete", {
        stage: "short_break",
        remaining_secs: 300,
        total_secs: 300,
        running: false,
        rounds_done: 1,
      }),
    );
    await waitFor(() => expect(screen.getByText("05:00")).toBeTruthy());
    expect(screen.getByText("短休息")).toBeTruthy();
    expect(screen.getByText("1/4 轮")).toBeTruthy();
  });

  it("shows a complete round indicator during a long break", async () => {
    mockBaseState();
    const { container } = render(<PomodoroTool />);
    await waitFor(() => expect(screen.getByText("25:00")).toBeTruthy());

    act(() =>
      emitMockEvent("pomodoro-complete", {
        stage: "long_break",
        remaining_secs: 900,
        total_secs: 900,
        running: false,
        rounds_done: 4,
      }),
    );

    await waitFor(() => expect(screen.getByText("4/4 轮")).toBeTruthy());
    expect(container.querySelectorAll(".pomo-round-dot.is-done")).toHaveLength(4);
  });

  it("resets the round indicator when focus resumes after a long break", async () => {
    mockBaseState();
    const { container } = render(<PomodoroTool />);
    await waitFor(() => expect(screen.getByText("25:00")).toBeTruthy());

    act(() =>
      emitMockEvent("pomodoro-complete", {
        stage: "focus",
        remaining_secs: 1500,
        total_secs: 1500,
        running: false,
        rounds_done: 4,
      }),
    );

    await waitFor(() => expect(screen.getByText("0/4 轮")).toBeTruthy());
    expect(container.querySelectorAll(".pomo-round-dot.is-done")).toHaveLength(0);
  });

  it("starts the timer via start_pomodoro", async () => {
    mockBaseState();
    render(<PomodoroTool />);
    await waitFor(() => expect(screen.getByText("开始")).toBeTruthy());

    fireEvent.click(screen.getByText("开始"));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("start_pomodoro"));
  });

  it("pauses a running timer via pause_pomodoro", async () => {
    mockBaseState();
    render(<PomodoroTool />);
    await waitFor(() => expect(screen.getByText("开始")).toBeTruthy());

    act(() =>
      emitMockEvent("pomodoro-tick", {
        stage: "focus",
        remaining_secs: 1000,
        total_secs: 1500,
        running: true,
        rounds_done: 0,
      }),
    );
    await waitFor(() => expect(screen.getByText("暂停")).toBeTruthy());

    fireEvent.click(screen.getByText("暂停"));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("pause_pomodoro"));
  });
});
