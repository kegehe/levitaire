import { act, render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { clearMockListeners } from "../test/tauri-mock";
import Settings from "./Settings";

const mockInvoke = vi.mocked(invoke);

describe("Settings 悬浮窗位置恢复", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.clear();
    mockInvoke.mockResolvedValue("");
  });

  it("渲染悬浮窗位置恢复分区及三个悬浮窗入口", async () => {
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("悬浮窗位置")).toBeInTheDocument();
    expect(screen.getByText("悬浮球")).toBeInTheDocument();
    expect(screen.getAllByText("系统监控").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("番茄钟").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("button", { name: "恢复默认位置" })).toHaveLength(3);
    expect(screen.getByRole("button", { name: "全部恢复默认位置" })).toBeInTheDocument();
  });

  it("点击单个悬浮窗的恢复按钮时调用后端清除记忆", async () => {
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });

    const resetButtons = screen.getAllByRole("button", { name: "恢复默认位置" });
    await act(async () => {
      fireEvent.click(resetButtons[0]);
      await Promise.resolve();
    });

    expect(mockInvoke).toHaveBeenCalledWith("reset_window_position", { id: "orb" });
  });

  it("点击全部恢复按钮时逐个恢复所有悬浮窗", async () => {
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "全部恢复默认位置" }));
      await Promise.resolve();
    });

    expect(mockInvoke).toHaveBeenCalledWith("reset_window_position", { id: "orb" });
    expect(mockInvoke).toHaveBeenCalledWith("reset_window_position", { id: "monitor-overlay" });
    expect(mockInvoke).toHaveBeenCalledWith("reset_window_position", { id: "pomodoro-overlay" });
  });

  it("恢复失败时按钮显示失败反馈", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "reset_window_position") {
        return Promise.reject(new Error("reset failed"));
      }
      return Promise.resolve("");
    });
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });

    const resetButtons = screen.getAllByRole("button", { name: "恢复默认位置" });
    await act(async () => {
      fireEvent.click(resetButtons[0]);
      await Promise.resolve();
    });

    expect(screen.getByText("恢复失败")).toBeInTheDocument();
  });
});
