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
    expect(screen.getAllByRole("button", { name: "恢复默认位置" })).toHaveLength(5);
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

  it("切换剪贴板历史开关时保存独立的启用状态", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_quick_input_history_enabled") return Promise.resolve(true);
      if (command === "get_quick_input_history_limit") return Promise.resolve(5);
      if (command === "get_quick_input_history") return Promise.resolve([]);
      return Promise.resolve("");
    });
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "快速输入" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "使用剪贴板历史" }));
      await Promise.resolve();
    });

    expect(mockInvoke).toHaveBeenCalledWith("set_quick_input_history_enabled", {
      enabled: false,
    });
    expect(screen.getByText(/已关闭.*保留条数设置将在重新开启后生效/)).toBeInTheDocument();
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
    expect(mockInvoke).toHaveBeenCalledWith("reset_window_position", { id: "time-overlay" });
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

  it("加载并保存贴图边框颜色和粗细", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_pin_border_color") return Promise.resolve("#12abEF");
      if (command === "get_pin_border_width") return Promise.resolve(4);
      return Promise.resolve("");
    });
    render(<Settings />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    fireEvent.click(screen.getByRole("button", { name: "截图/录屏" }));
    const color = screen.getByLabelText("贴图边框颜色") as HTMLInputElement;
    const width = screen.getByRole("combobox", { name: "贴图边框粗细" }) as HTMLSelectElement;
    expect(color.value).toBe("#12abef");
    expect(width.value).toBe("4");

    await act(async () => {
      fireEvent.change(color, { target: { value: "#abcdef" } });
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_pin_border_color", { color: "#ABCDEF" });

    await act(async () => {
      fireEvent.change(width, { target: { value: "2" } });
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_pin_border_width", { width: 2 });
  });

  it("does not let a late initial read overwrite a border edit", async () => {
    let resolveColor!: (value: string) => void;
    const colorRead = new Promise<string>((resolve) => {
      resolveColor = resolve;
    });
    mockInvoke.mockImplementation((command) => {
      if (command === "get_pin_border_color") return colorRead;
      if (command === "get_pin_border_width") return Promise.resolve(1);
      return Promise.resolve("");
    });

    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "截图/录屏" }));

    const color = screen.getByLabelText("贴图边框颜色") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(color, { target: { value: "#abcdef" } });
      await Promise.resolve();
    });

    await act(async () => {
      resolveColor("#123456");
      await colorRead;
    });

    expect(color.value).toBe("#abcdef");
    expect(mockInvoke).toHaveBeenCalledWith("set_pin_border_color", { color: "#ABCDEF" });
  });

  it("rolls back to the loaded value when an early border save fails", async () => {
    let resolveColor!: (value: string) => void;
    const colorRead = new Promise<string>((resolve) => {
      resolveColor = resolve;
    });
    let rejectSave!: (reason?: unknown) => void;
    const colorSave = new Promise<void>((_, reject) => {
      rejectSave = reject;
    });
    mockInvoke.mockImplementation((command) => {
      if (command === "get_pin_border_color") return colorRead;
      if (command === "get_pin_border_width") return Promise.resolve(1);
      if (command === "set_pin_border_color") return colorSave;
      return Promise.resolve("");
    });

    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "截图/录屏" }));
    const color = screen.getByLabelText("贴图边框颜色") as HTMLInputElement;
    fireEvent.change(color, { target: { value: "#abcdef" } });

    await act(async () => {
      rejectSave(new Error("save failed"));
      await Promise.resolve();
    });
    expect(color.value).toBe("#abcdef");

    await act(async () => {
      resolveColor("#123456");
      await colorRead;
    });
    expect(color.value).toBe("#123456");
  });
});
