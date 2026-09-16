import { act, render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { clearMockListeners, emitMockEvent, mockSetSize } from "../../test/tauri-mock";
import {
  MONITOR_MINI_SIZE,
  monitorLayoutOption,
  type SystemMonitorConfig,
} from "../../constants/systemMonitorConfig";
import SystemMonitor from "./SystemMonitor";

const mockInvoke = vi.mocked(invoke);
const mockEmit = vi.mocked(emit);

/** 一帧完整的 monitor-stats（字段与 Rust MonitorStats 对应） */
const FULL_STATS = {
  timestamp_ms: 0,
  interval_ms: 1000,
  uptime_secs: 0,
  cpu_usage_total: 10,
  cpu_usage_per_core: [10, 20, 30, 40, 50, 60, 70, 80],
  cpu_freq_mhz: [3400, 3400, 3400, 3400, 3400, 3400, 3400, 3400],
  mem_used: 10.2 * 1024 ** 3,
  mem_total: 16.4 * 1024 ** 3,
  mem_available: 6.2 * 1024 ** 3,
  net: [{ name: "eth0", rx_rate: 1900 * 1024, tx_rate: 512 * 1024 }],
  disks: [{ mount_point: "C:\\", total: 1024 ** 4, available: 512 * 1024 ** 3, kind: "SSD" }],
  disk_io: { read_rate: 3 * 1024, write_rate: 1024 },
  gpu: { has_gpu: false, usage: 0, memory_used: 0, memory_total: 0 },
  battery: { has_battery: false, percent: 0, charging: false },
};

function emitStats(overrides: Partial<typeof FULL_STATS> = {}) {
  act(() => emitMockEvent("monitor-stats", { ...FULL_STATS, ...overrides }));
}

function mockMonitorConfig(config: Partial<SystemMonitorConfig>) {
  mockInvoke.mockImplementation((command) =>
    command === "get_system_monitor_config"
      ? Promise.resolve(JSON.stringify({ intervalMs: 1000, displayMode: "full", ...config }))
      : Promise.resolve(""),
  );
}

/** 最近一次下发的窗口尺寸（mockSetSize 的最后一个调用参数） */
function lastSetSize(): { width: number; height: number } {
  const calls = mockSetSize.mock.calls;
  return calls[calls.length - 1]?.[0] as { width: number; height: number };
}

/** 挂载 + 等配置读完 + 收到一帧 stats（多数用例的公共前置） */
async function renderMonitor(config: Partial<SystemMonitorConfig> = {}) {
  if (Object.keys(config).length > 0) mockMonitorConfig(config);
  const result = render(<SystemMonitor />);
  await act(async () => {
    await Promise.resolve();
  });
  return result;
}

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
});

describe("系统监控 显示样式", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.clear();
    mockInvoke.mockResolvedValue("");
  });

  it("四套样式各自渲染自己的结构（不是同一套结构换皮）", async () => {
    const structureOf: Record<string, string> = {
      b: ".monitor-row",
      c: ".monitor-tile",
      d: ".monitor-hero",
      e: ".monitor-trend",
    };
    for (const [layout, selector] of Object.entries(structureOf)) {
      const { container, unmount } = await renderMonitor({ layout: layout as "b" });
      emitStats();
      expect(container.querySelectorAll(selector).length, layout).toBeGreaterThan(0);
      expect(container.querySelector(".monitor-body")?.className).toContain(`is-layout-${layout}`);
      unmount();
      clearMockListeners();
    }
  });

  it("四套样式都完整渲染全部指标（丢一个指标不会被任何现有断言发现）", async () => {
    // 「结构存在」不等于「内容齐全」：`.monitor-tile` 数量从 4 变成 3 时，
    // 上面那条 `toBeGreaterThan(0)` 照样绿 —— 而用户看到的是少了一个指标。
    // 这里直接按**文案**断言（与布局结构无关，四套样式共用同一份视图模型）。
    const required = ["CPU", "内存", "网络", "磁盘 I/O"];
    for (const layout of ["b", "c", "d", "e"] as const) {
      const { container, unmount } = await renderMonitor({ layout });
      emitStats();
      const text = container.textContent ?? "";
      for (const label of required) {
        expect(text, `样式 ${layout} 里没有渲染「${label}」`).toContain(label);
      }
      unmount();
      clearMockListeners();
    }
  });

  it("mini 形态按设计只显示 CPU / 内存 / 网络（故意不含磁盘 I/O 与 GPU）", async () => {
    const { container } = await renderMonitor({ displayMode: "mini" });
    emitStats();

    const text = container.textContent ?? "";
    expect(text).toContain("CPU");
    expect(text).toContain("内存");
    expect(text).toContain("网络");
    expect(text).not.toContain("磁盘 I/O");
  });

  it("磁盘 I/O 用紧凑的次要文本（带单位会撑破 66px 的次要列被省略号吃掉）", async () => {
    await renderMonitor({ layout: "b" });
    emitStats();

    expect(screen.getByText("磁盘 I/O")).toBeInTheDocument();
    expect(screen.getByText("读3.0 写1.0")).toBeInTheDocument();
    expect(screen.getByText("4.0 KB/s")).toBeInTheDocument();
    // 旧版把单位写进次要列（"读取 3.0 KB/s · 写入 1.0 KB/s"），新样式一律不带单位
    expect(screen.queryByText(/读取 3\.0 KB\/s/)).not.toBeInTheDocument();
  });

  it("缺 layout 的旧配置不崩，落回默认样式", async () => {
    mockInvoke.mockImplementation((command) =>
      command === "get_system_monitor_config"
        ? Promise.resolve(JSON.stringify({ intervalMs: 1000, displayMode: "full" }))
        : Promise.resolve(""),
    );
    const { container } = render(<SystemMonitor />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector(".monitor-body")?.className).toContain("is-layout-e");
  });

  it("标题栏样式按钮显示当前样式名，点击轮换到下一个并写进配置", async () => {
    const { container } = await renderMonitor({ layout: "e" });

    const button = screen.getByLabelText("切换显示样式（当前：共享趋势图）");
    expect(button).toHaveAttribute("data-tooltip", "切换样式 → 紧凑行式");
    expect(button.textContent).toContain("共享趋势图");

    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "set_system_monitor_config",
      expect.objectContaining({ config: expect.stringContaining('"layout":"b"') }),
    );
    expect(mockEmit).toHaveBeenCalledWith(
      "levitaire-system-monitor-config-changed",
      expect.objectContaining({ layout: "b" }),
    );
    expect(container.querySelector(".monitor-body")?.className).toContain("is-layout-b");
  });

  it("设置页改了样式后本窗口跟着换结构（订阅广播）", async () => {
    const { container } = await renderMonitor({ layout: "e" });

    await act(async () => {
      emitMockEvent("levitaire-system-monitor-config-changed", {
        intervalMs: 1000,
        displayMode: "full",
        layout: "d",
      });
      await Promise.resolve();
    });

    expect(container.querySelector(".monitor-body")?.className).toContain("is-layout-d");
    expect(screen.getByLabelText("切换显示样式（当前：焦点分层）")).toBeInTheDocument();
  });

  it("切样式时立刻重设窗口宽度（双列宫格是 340，其余 300）", async () => {
    await renderMonitor({ layout: "b" });
    mockSetSize.mockClear();

    await act(async () => {
      emitMockEvent("levitaire-system-monitor-config-changed", {
        intervalMs: 1000,
        displayMode: "full",
        layout: "c",
      });
      await Promise.resolve();
    });

    const size = lastSetSize();
    expect(size.width).toBe(340);
    expect(size.height).toBe(monitorLayoutOption("c").placeholderHeight);

    mockSetSize.mockClear();
    await act(async () => {
      emitMockEvent("levitaire-system-monitor-config-changed", {
        intervalMs: 1000,
        displayMode: "full",
        layout: "e",
      });
      await Promise.resolve();
    });
    expect(lastSetSize().width).toBe(300);
  });

  it("只改刷新间隔时不重设窗口尺寸（否则窗口会在改间隔时莫名跳一下）", async () => {
    await renderMonitor({ layout: "e" });
    mockSetSize.mockClear();

    await act(async () => {
      emitMockEvent("levitaire-system-monitor-config-changed", {
        intervalMs: 2000,
        displayMode: "full",
        layout: "e",
      });
      await Promise.resolve();
    });

    expect(mockSetSize).not.toHaveBeenCalled();
  });

  it("显示模式切换仍然重设尺寸，且切到 mini 时不再显示样式按钮", async () => {
    const { container } = await renderMonitor({ layout: "e" });
    mockSetSize.mockClear();

    await act(async () => {
      emitMockEvent("levitaire-system-monitor-config-changed", {
        intervalMs: 1000,
        displayMode: "mini",
        layout: "e",
      });
      await Promise.resolve();
    });

    expect(container.querySelector(".monitor-body")).toHaveClass("is-mini");
    const size = lastSetSize();
    expect(size.width).toBe(MONITOR_MINI_SIZE.width);
    expect(size.height).toBe(MONITOR_MINI_SIZE.placeholderHeight);
    // mini 形态与 layout 无关，按钮不该出现（点了也没有任何效果）
    expect(container.querySelector(".monitor-style-btn")).toBeNull();
  });
});

describe("系统监控 mini 形态", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.clear();
    mockInvoke.mockResolvedValue("");
  });

  it("是单行三格（CPU / 内存 / 网络）且都带折线，不再有孤卡", async () => {
    const { container } = await renderMonitor({ displayMode: "mini" });
    emitStats();

    expect(container.querySelector(".monitor-body")).toHaveClass("is-mini");
    const cells = container.querySelectorAll(".monitor-mini-cell");
    expect(cells).toHaveLength(3);
    // 旧 mini 是 2×2 网格 + 第 5 张孤卡、且完全不画折线（showTrend={!isMini}）
    expect(container.querySelectorAll(".monitor-spark")).toHaveLength(3);
    expect(container.querySelector(".monitor-rows")).toBeNull();
    expect(container.querySelector(".monitor-tile")).toBeNull();
    // mini 里不显示磁盘容量行
    expect(container.querySelector(".monitor-disk-row")).toBeNull();
    expect(Array.from(cells).map((cell) => cell.textContent)).toEqual([
      expect.stringContaining("CPU"),
      expect.stringContaining("内存"),
      expect.stringContaining("网络"),
    ]);
  });

  it("mini 下无电池时不渲染电池段，只留运行时间", async () => {
    const { container } = await renderMonitor({ displayMode: "mini" });
    emitStats({ uptime_secs: 3 * 86400 + 7 * 3600 + 42 * 60 });

    expect(container.querySelector(".monitor-battery-bar")).toBeNull();
    expect(screen.getByText("运行时间 3天 7时 42分")).toBeInTheDocument();
  });

  it("首帧占位（还没收到第一帧 stats）不留「运行时间 」这种有标签无数值的残行", async () => {
    // mini 直接渲染 FootRow，没有全量样式的 MonitorFooter 那层 hasBody 兜底 ——
    // 所以这个兜底必须落在 FootRow 自己身上。
    const { container } = await renderMonitor({ displayMode: "mini" });

    expect(container.querySelectorAll(".monitor-mini-cell")).toHaveLength(3);
    expect(container.querySelector(".monitor-uptime")).toBeNull();
  });

  it("有电池且充电中：电池条按 ok 档（充电即安全），文案带「充电中」", async () => {
    const { container } = await renderMonitor({ displayMode: "mini" });
    emitStats({ battery: { has_battery: true, percent: 78, charging: true } });

    expect(container.querySelector(".monitor-battery-bar .monitor-level-fill")).toHaveAttribute(
      "data-level",
      "ok",
    );
    expect(screen.getByText("电池 78% · 充电中")).toBeInTheDocument();
  });

  it("放电到 15% 时电池条转 crit（电池与磁盘的阈值方向相反）", async () => {
    const { container } = await renderMonitor({ displayMode: "mini" });
    emitStats({ battery: { has_battery: true, percent: 15, charging: false } });

    expect(container.querySelector(".monitor-battery-bar .monitor-level-fill")).toHaveAttribute(
      "data-level",
      "crit",
    );
  });
});

describe("系统监控 磁盘阈值", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.clear();
    mockInvoke.mockResolvedValue("");
  });

  const diskAt = (usedPercent: number) => ({
    mount_point: "D:\\",
    total: 1000 * 1024 ** 3,
    available: ((100 - usedPercent) / 100) * 1000 * 1024 ** 3,
    kind: "HDD",
  });

  it.each([
    [50, "ok"],
    [85, "warn"],
    [96, "crit"],
  ])("占用 %i%% 的盘渲染成 %s 档", async (usedPercent, level) => {
    const { container } = await renderMonitor({ layout: "e" });
    emitStats({ disks: [diskAt(usedPercent)] });

    const fill = container.querySelector(".monitor-disk-row .monitor-level-fill");
    expect(fill).toHaveAttribute("data-level", level);
    expect(fill).toHaveAttribute("style", expect.stringContaining(`width: ${usedPercent}%`));
  });
});

describe("系统监控 浮窗控件", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.clear();
    mockInvoke.mockResolvedValue("");
  });

  it("浮窗只提供三个视图控件（样式 / 迷你 / 关闭），没有任何配置表单", async () => {
    const { container } = await renderMonitor();

    expect(container.querySelector(".monitor-settings")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".monitor-icon-btn")).toHaveLength(2);
    expect(container.querySelectorAll(".monitor-style-btn")).toHaveLength(1);
    expect(screen.getByLabelText("切换到迷你模式")).toBeInTheDocument();
    expect(screen.getByLabelText("关闭系统监控")).toBeInTheDocument();
  });

  it("只有悬停（或聚焦）时才展开操作按钮，未展开时不可 Tab 到", async () => {
    const { container } = await renderMonitor();
    const monitor = container.querySelector<HTMLElement>(".monitor-body");

    expect(monitor).not.toHaveClass("is-controls-visible");
    expect(screen.getByLabelText("切换到迷你模式")).toHaveAttribute("tabindex", "-1");

    fireEvent.mouseEnter(monitor!);
    expect(monitor).toHaveClass("is-controls-visible");
    expect(screen.getByLabelText("切换到迷你模式")).toHaveAttribute("tabindex", "0");

    fireEvent.mouseLeave(monitor!);
    expect(monitor).not.toHaveClass("is-controls-visible");
  });

  it("样式按钮常驻可见（不跟着悬停出现/消失）", async () => {
    await renderMonitor();
    expect(screen.getByLabelText(/切换显示样式/)).toBeInTheDocument();
  });

  it("迷你模式下悬停控件仍可用", async () => {
    const { container } = await renderMonitor({ displayMode: "mini" });
    const monitor = container.querySelector<HTMLElement>(".monitor-body");

    fireEvent.mouseEnter(monitor!);

    expect(monitor).toHaveClass("is-mini", "is-controls-visible");
    expect(screen.getByLabelText("切换到标准模式")).toHaveAttribute("tabindex", "0");
  });

  it("连点样式按钮时保存串行 —— 否则并发 IPC 顺序不保证，落盘的可能是上一套", async () => {
    const resolvers: Array<() => void> = [];
    mockInvoke.mockImplementation((command) => {
      if (command === "get_system_monitor_config") {
        return Promise.resolve(
          JSON.stringify({ intervalMs: 1000, displayMode: "full", layout: "e" }),
        );
      }
      if (command === "set_system_monitor_config") {
        return new Promise<void>((resolve) => resolvers.push(resolve));
      }
      return Promise.resolve("");
    });

    const { container } = await renderMonitor();
    const button = screen.getByLabelText(/切换显示样式/);
    const savedLayouts = () =>
      mockInvoke.mock.calls
        .filter(([command]) => command === "set_system_monitor_config")
        .map(([, args]) => JSON.parse(String((args as { config: string }).config)).layout as string);

    act(() => {
      fireEvent.click(button);
    });
    act(() => {
      fireEvent.click(button);
    });
    // 队列挂在已 resolve 的 promise 上，`.then` 走微任务 —— 先冲一次微任务让**第一次**
    // 真正发出去。（同步 act 不冲微任务，直接断言会看到 0 次调用。）
    await act(async () => {
      await Promise.resolve();
    });
    // 串行的证据：第一次还没落盘时，第二次**不该**已经发出去
    // （不串行时这里会是 ["b","c"] —— 两次 IPC 同时在飞，谁先落盘不确定）
    expect(savedLayouts()).toEqual(["b"]);
    expect(container.querySelector(".monitor-body")?.className).toContain("is-layout-c");

    await act(async () => {
      resolvers.shift()?.();
      await Promise.resolve();
    });
    await act(async () => {
      resolvers.shift()?.();
      await Promise.resolve();
    });
    expect(savedLayouts()).toEqual(["b", "c"]);
  });

  it("自己发出的中间态回声不得把更新的本地状态打回去（连点时会来回跳）", async () => {
    // applyConfig 的时序是「先乐观更新本地 → 落盘成功后才广播」，于是连点两次时
    // **第一次的广播（b）到达时，本地已经推进到 c**。若把这条回声当成"别的窗口改的"
    // 照单全收，窗口会先跳回 b（连窗口尺寸都跟着重设一次），再被下一条广播拉回 c ——
    // 用户看到的是快速连点时界面来回跳。判定必须基于"这是我自己发过的值"，
    // 而不能只比较"是否等于当前值"。
    const resolvers: Array<() => void> = [];
    mockInvoke.mockImplementation((command) => {
      if (command === "get_system_monitor_config") {
        return Promise.resolve(
          JSON.stringify({ intervalMs: 1000, displayMode: "full", layout: "e" }),
        );
      }
      if (command === "set_system_monitor_config") {
        return new Promise<void>((resolve) => resolvers.push(resolve));
      }
      return Promise.resolve("");
    });

    const { container } = await renderMonitor();
    const button = screen.getByLabelText(/切换显示样式/);
    const bodyClass = () => container.querySelector(".monitor-body")?.className ?? "";

    act(() => {
      fireEvent.click(button);
    });
    act(() => {
      fireEvent.click(button);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(bodyClass()).toContain("is-layout-c");

    // 第一次落盘成功 → 广播出中间态 b（这条回声会转回本窗口）
    await act(async () => {
      resolvers.shift()?.();
      await Promise.resolve();
    });
    expect(bodyClass()).toContain("is-layout-c");

    // 第二次落盘成功 → 广播出最终态 c
    await act(async () => {
      resolvers.shift()?.();
      await Promise.resolve();
    });
    expect(bodyClass()).toContain("is-layout-c");
  });

  it("别的窗口广播了未知样式也不崩（按默认样式落回，而不是渲染一个 undefined 组件）", async () => {
    // 设置页那边对广播 payload 做了归一化，本窗口没有 —— 两边不一致。广播是跨窗口来的，
    // 这里若直接采信 `layout: "z"`，`LAYOUT_COMPONENTS["z"]` 就是 undefined，
    // React 渲染 <undefined/> 会直接抛错（整扇浮窗白屏），且报错发生在事件回调里、不易归因。
    const { container } = await renderMonitor({ layout: "c" });
    await act(async () => {
      emitMockEvent("levitaire-system-monitor-config-changed", {
        intervalMs: 1000,
        displayMode: "full",
        layout: "z",
      });
      await Promise.resolve();
    });
    expect(container.querySelector(".monitor-body")?.className).toContain("is-layout-e");
  });

  it("落盘失败时本地回滚**并广播回滚值**（否则别的窗口会一直留着没落盘的那份）", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_system_monitor_config") {
        return Promise.resolve(
          JSON.stringify({ intervalMs: 1000, displayMode: "full", layout: "e" }),
        );
      }
      if (command === "set_system_monitor_config") {
        return Promise.reject(new Error("ipc down"));
      }
      return Promise.resolve("");
    });

    const { container } = await renderMonitor();
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/切换显示样式/));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector(".monitor-body")?.className).toContain("is-layout-e");
    expect(mockEmit).toHaveBeenCalledWith(
      "levitaire-system-monitor-config-changed",
      expect.objectContaining({ layout: "e" }),
    );
  });

  it("点迷你按钮切换显示模式并广播（不动 layout）", async () => {
    const { container } = await renderMonitor({ layout: "c" });
    fireEvent.mouseEnter(container.querySelector<HTMLElement>(".monitor-body")!);

    const toggleBtn = screen.getByLabelText("切换到迷你模式");
    await act(async () => {
      fireEvent.click(toggleBtn);
      await Promise.resolve();
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "set_system_monitor_config",
      expect.objectContaining({ config: expect.stringContaining('"displayMode":"mini"') }),
    );
    // 切显示模式不得把样式改掉
    expect(mockInvoke).toHaveBeenCalledWith(
      "set_system_monitor_config",
      expect.objectContaining({ config: expect.stringContaining('"layout":"c"') }),
    );
    expect(mockEmit).toHaveBeenCalledWith(
      "levitaire-system-monitor-config-changed",
      expect.objectContaining({ displayMode: "mini", layout: "c" }),
    );
  });

  it("mini 模式下按钮文案是「切换到标准模式」", async () => {
    await renderMonitor({ displayMode: "mini" });
    fireEvent.mouseEnter(screen.getByText("系统监控").closest(".monitor-body")!);

    expect(screen.getByLabelText("切换到标准模式")).toBeInTheDocument();
  });
});
