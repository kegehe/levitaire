import { act, render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { clearMockListeners, emitMockEvent, mockSetSize } from "../../test/tauri-mock";
import SystemMonitor from "./SystemMonitor";

const mockInvoke = vi.mocked(invoke);
const mockEmit = vi.mocked(emit);

describe("SystemMonitor theme synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    mockInvoke.mockResolvedValue("");
  });

  it("uses the saved theme when the monitor window opens", () => {
    localStorage.setItem("levitaire-theme", "dark");

    render(<SystemMonitor />);

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("emits a ready event after the monitor window mounts", async () => {
    render(<SystemMonitor />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockEmit).toHaveBeenCalledWith("monitor-window-ready");
  });

  it("updates while open when the settings window emits a theme change", async () => {
    render(<SystemMonitor />);

    await act(async () => {
      await Promise.resolve();
    });
    act(() => emitMockEvent("levitaire-theme-changed", "dark"));

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("levitaire-theme")).toBe("dark");
  });

  it("renders aggregate disk read and write rates without disk names", async () => {
    render(<SystemMonitor />);

    await act(async () => {
      await Promise.resolve();
    });
    act(() =>
      emitMockEvent("monitor-stats", {
        timestamp_ms: 0,
        interval_ms: 1000,
        uptime_secs: 0,
        cpu_usage_total: 10,
        cpu_usage_per_core: [],
        cpu_freq_mhz: [],
        mem_used: 0,
        mem_total: 0,
        mem_available: 0,
        net: [],
        disks: [],
        disk_io: { read_rate: 3 * 1024, write_rate: 1024 },
        battery: { has_battery: false, percent: 0, charging: false },
      }),
    );

    expect(screen.getByText("磁盘 I/O")).toBeInTheDocument();
    expect(screen.getByText("读取 3.0 KB/s · 写入 1.0 KB/s")).toBeInTheDocument();
  });

  it("uses the compact core-metrics layout without trend lines", async () => {
    mockInvoke.mockImplementation((command) =>
      command === "get_system_monitor_config"
        ? Promise.resolve(JSON.stringify({ intervalMs: 1000, displayMode: "mini" }))
        : Promise.resolve(""),
    );

    const { container } = render(<SystemMonitor />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() =>
      emitMockEvent("monitor-stats", {
        timestamp_ms: 0,
        interval_ms: 1000,
        uptime_secs: 0,
        cpu_usage_total: 10,
        cpu_usage_per_core: [],
        cpu_freq_mhz: [],
        mem_used: 0,
        mem_total: 0,
        mem_available: 0,
        net: [],
        disks: [{ mount_point: "C:\\", total: 1, available: 0, kind: "SSD" }],
        disk_io: null,
        battery: { has_battery: true, percent: 50, charging: false },
      }),
    );

    expect(container.querySelector(".monitor-body")).toHaveClass("is-mini");
    expect(container.querySelectorAll(".sparkline")).toHaveLength(0);
    expect(container.querySelectorAll(".section")).toHaveLength(0);
    expect(container.querySelectorAll(".footer")).toHaveLength(0);
  });

  it("applies display-mode changes from the main settings window", async () => {
    const { container } = render(<SystemMonitor />);
    await act(async () => {
      await Promise.resolve();
    });

    act(() =>
      emitMockEvent("levitaire-system-monitor-config-changed", {
        intervalMs: 1000,
        displayMode: "mini",
      }),
    );

    expect(container.querySelector(".monitor-body")).toHaveClass("is-mini");
    expect(mockSetSize).toHaveBeenCalledWith(expect.objectContaining({ width: 300, height: 180 }));
    expect(container.querySelectorAll(".monitor-icon-btn")).toHaveLength(2);
  });

  it("does not provide monitor configuration controls in the floating window", () => {
    const { container } = render(<SystemMonitor />);

    expect(container.querySelector(".monitor-settings")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".monitor-icon-btn")).toHaveLength(2);
  });

  it("toggles display mode when the mode button is clicked", async () => {
    const { container } = render(<SystemMonitor />);
    await act(async () => {
      await Promise.resolve();
    });

    // 默认 full 模式，按钮 aria-label 应为动作描述"切换到迷你模式"
    const toggleBtn = screen.getByLabelText("切换到迷你模式");
    expect(toggleBtn).toBeInTheDocument();
    expect(container.querySelector(".monitor-body")).not.toHaveClass("is-mini");

    await act(async () => {
      fireEvent.click(toggleBtn);
    });

    // saveSystemMonitorConfig 应被调用，displayMode 切换为 mini
    expect(mockInvoke).toHaveBeenCalledWith(
      "set_system_monitor_config",
      expect.objectContaining({
        config: expect.stringContaining('"displayMode":"mini"'),
      }),
    );
    // 应手动 emit 事件以触发本窗口 UI 刷新
    expect(mockEmit).toHaveBeenCalledWith(
      "levitaire-system-monitor-config-changed",
      expect.objectContaining({ displayMode: "mini" }),
    );
  });

  it("shows standard mode label when in mini mode", async () => {
    mockInvoke.mockImplementation((command) =>
      command === "get_system_monitor_config"
        ? Promise.resolve(JSON.stringify({ intervalMs: 1000, displayMode: "mini" }))
        : Promise.resolve(""),
    );

    render(<SystemMonitor />);
    await act(async () => {
      await Promise.resolve();
    });

    const toggleBtn = screen.getByLabelText("切换到标准模式");
    expect(toggleBtn).toBeInTheDocument();
  });
});
