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
  displayMode: "full",
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

function mockMiniState() {
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
      return Promise.resolve(
        JSON.stringify({ ...JSON.parse(DEFAULT_CONFIG), displayMode: "mini" }),
      );
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

  it("switches stage and round counter on pomodoro-complete", async () => {
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

  it("shows full rounds N/N while in long break after completing a full cycle", async () => {
    mockBaseState();
    const { container } = render(<PomodoroTool />);
    await waitFor(() => expect(screen.getByText("25:00")).toBeTruthy());

    // 第 4 轮专注结束进入长休息：rounds_done=4 为阈值整数倍，圆点应显示 4/4
    act(() =>
      emitMockEvent("pomodoro-complete", {
        stage: "long_break",
        remaining_secs: 900,
        total_secs: 900,
        running: false,
        rounds_done: 4,
      }),
    );
    await waitFor(() => expect(screen.getByText("15:00")).toBeTruthy());
    expect(screen.getByText("长休息")).toBeTruthy();
    expect(screen.getByText("4/4 轮")).toBeTruthy();
    expect(container.querySelectorAll(".pomo-round-dot.is-done")).toHaveLength(4);
  });

  it("resets round counter display to 0/N when focus resumes after long break", async () => {
    mockBaseState();
    const { container } = render(<PomodoroTool />);
    await waitFor(() => expect(screen.getByText("25:00")).toBeTruthy());

    // 长休息结束回到专注：新一轮开始，rounds_done 仍为 4，但应显示 0/4
    act(() =>
      emitMockEvent("pomodoro-complete", {
        stage: "focus",
        remaining_secs: 1500,
        total_secs: 1500,
        running: false,
        rounds_done: 4,
      }),
    );
    await waitFor(() => expect(screen.getByText("专注")).toBeTruthy());
    expect(screen.getByText("0/4 轮")).toBeTruthy();
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

  it("mini mode provides reset and skip actions without switching back to full mode", async () => {
    mockMiniState();
    render(<PomodoroTool />);
    // 等待 config 加载完成、进入 mini 布局（mini 模式独有的 aria-label 开始按钮出现）
    await waitFor(() => expect(screen.getByLabelText("开始")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("重置当前阶段"));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("reset_pomodoro"));

    fireEvent.click(screen.getByLabelText("跳过当前阶段"));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("skip_pomodoro"));
  });

  it("mini mode toggle still starts and pauses the timer", async () => {
    mockMiniState();
    render(<PomodoroTool />);
    await waitFor(() => expect(screen.getByLabelText("开始")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("开始"));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("start_pomodoro"));

    act(() =>
      emitMockEvent("pomodoro-tick", {
        stage: "focus",
        remaining_secs: 1499,
        total_secs: 1500,
        running: true,
        rounds_done: 0,
      }),
    );
    await waitFor(() => expect(screen.getByLabelText("暂停")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("暂停"));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("pause_pomodoro"));
  });
});
