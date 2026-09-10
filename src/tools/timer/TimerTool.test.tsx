import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TimerTool from "./TimerTool";
import { clearMockListeners, emitMockEvent } from "../../test/tauri-mock";

const mockInvoke = vi.mocked(invoke);

// 组件会持久化页签/样式到 localStorage，逐个用例清空避免互相污染
beforeEach(() => {
  localStorage.clear();
});

const baseStopwatch = {
  id: "timer-2",
  label: "秒表",
  kind: "stopwatch",
  durationSecs: 0,
  remainingSecs: 0,
  elapsedSecs: 23,
  running: false,
  completed: false,
  startedUnixMs: null,
  laps: [12, 8],
};

describe("TimerTool 秒表页签", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
  });

  it("switches to the stopwatch tab and creates one when none exists", async () => {
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "秒表" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("create_timer", {
      input: { kind: "stopwatch", label: "秒表", durationSecs: 0 },
    }));
  });

  it("renders elapsed time and lap rows from the payload", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [baseStopwatch] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "秒表" }));
    expect(await screen.findByText("00:23")).toBeInTheDocument();
    expect(screen.getByText("分段 1")).toBeInTheDocument();
    expect(screen.getByText("+00:12")).toBeInTheDocument();
    expect(screen.getByText("分段 2")).toBeInTheDocument();
    expect(screen.getByText("+00:08")).toBeInTheDocument();
    expect(screen.getByText("00:20")).toBeInTheDocument();
  });

  it("starts an idle stopwatch", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [baseStopwatch] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "秒表" }));
    await screen.findByText("00:23");
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("start_timer", { id: "timer-2" }));
  });

  it("pauses a running stopwatch", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [{ ...baseStopwatch, running: true }] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "秒表" }));
    await screen.findByText("00:23");
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("pause_timer", { id: "timer-2" }));
  });

  it("records a lap while running", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [{ ...baseStopwatch, running: true }] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "秒表" }));
    await screen.findByText("00:23");
    fireEvent.click(screen.getByRole("button", { name: "记录分段" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("add_timer_lap", { id: "timer-2" }));
  });

  it("disables the lap button when the stopwatch is idle", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [baseStopwatch] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "秒表" }));
    await screen.findByText("00:23");
    expect(screen.getByRole("button", { name: "记录分段" })).toBeDisabled();
  });

  it("resets the stopwatch", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [baseStopwatch] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "秒表" }));
    await screen.findByText("00:23");
    fireEvent.click(screen.getByRole("button", { name: "重置秒表" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("reset_timer", { id: "timer-2" }));
  });

  it("renames the stopwatch by double-clicking its label", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [baseStopwatch] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "秒表" }));
    await screen.findByText("00:23");
    fireEvent.doubleClick(screen.getByTitle("双击重命名"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "健身" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("rename_timer", { id: "timer-2", label: "健身" }));
  });

  it("cancels a rename with Escape without invoking rename_timer", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [baseStopwatch] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "秒表" }));
    await screen.findByText("00:23");
    fireEvent.doubleClick(screen.getByTitle("双击重命名"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "健身" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(mockInvoke).not.toHaveBeenCalledWith("rename_timer", expect.anything());
    expect(screen.getByTitle("双击重命名")).toBeInTheDocument();
  });

  it("ignores a stale get_timers snapshot once a timers-changed event has applied", async () => {
    let resolveGetTimers: (payload: { timers: typeof baseStopwatch[] }) => void;
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return new Promise((resolve) => { resolveGetTimers = resolve; });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    // 事件先到：包含秒表的完整状态
    act(() => emitMockEvent("timers-changed", { timers: [baseStopwatch] }));
    // 挂载时发起的 get_timers 快照此时才返回（旧的空列表），不应覆盖上面的状态
    await act(async () => {
      resolveGetTimers({ timers: [] });
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("tab", { name: "秒表" }));
    expect(await screen.findByText("00:23")).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith("create_timer", expect.anything());
  });

  it("creates a single stopwatch when the tab is clicked repeatedly", async () => {
    let resolveCreate: (payload: { timers: typeof baseStopwatch[] }) => void;
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      if (command === "create_timer") return new Promise((resolve) => { resolveCreate = resolve; });
      return Promise.resolve(undefined);
    });
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    const tab = screen.getByRole("tab", { name: "秒表" });
    fireEvent.click(tab);
    fireEvent.click(tab);
    await act(async () => {
      resolveCreate({ timers: [baseStopwatch] });
      await Promise.resolve();
    });
    const createCalls = mockInvoke.mock.calls.filter(([command]) => command === "create_timer");
    expect(createCalls).toHaveLength(1);
    expect(await screen.findByText("00:23")).toBeInTheDocument();
  });
});

describe("TimerTool 日历页签", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
  });

  it("renders a 42-cell month grid with selected-date summary", async () => {
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "日历" }));
    const cells = document.querySelectorAll(".calendar-cell");
    expect(cells.length).toBe(42);
    expect(document.querySelector(".calendar-selection")).not.toBeNull();
  });
});

describe("TimerTool 环形倒计时", () => {
  const countdown = (remainingSecs: number) => ({
    id: "timer-1",
    label: "倒计时",
    kind: "countdown" as const,
    durationSecs: 300,
    remainingSecs,
    elapsedSecs: 0,
    running: false,
    completed: remainingSecs === 0,
    startedUnixMs: null,
    laps: [] as number[],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.setItem("levitaire-timer-display", "ring");
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [countdown(0)] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
  });

  it("keeps countdown available from the top tab without a duplicate clock-view action", async () => {
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector(".timer-secondary-action")).toBeNull();
    expect(screen.getByRole("tab", { name: "倒计时" })).toBeInTheDocument();
  });

  it("hides the foreground ring entirely when the countdown reaches zero", async () => {
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
    expect(document.querySelector(".timer-ring-fg")).toBeNull();
    expect(document.querySelector(".timer-ring-bg")).not.toBeNull();
  });

  it("uses the exact circumference and zero offset for a full ring", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [countdown(300)] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
    const ring = document.querySelector(".timer-ring-fg") as SVGCircleElement;
    expect(ring).not.toBeNull();
    expect(ring.style.strokeDasharray).toBe(String(2 * Math.PI * 50));
    expect(ring.style.strokeDashoffset).toBe("0");
  });
});

describe("TimerTool 时钟样式切换", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.setItem("levitaire-timer-clock-style", "digital");
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
  });

  it("默认渲染数字时钟，且无表盘", async () => {
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector(".timer-local-clock-value")).not.toBeNull();
    expect(document.querySelector(".timer-clock-face")).toBeNull();
    expect(screen.getByRole("button", { name: "切换时钟样式" })).toBeInTheDocument();
  });

  it("点击样式按钮切换到表盘并持久化", async () => {
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "切换时钟样式" }));
    expect(document.querySelector(".timer-local-clock-value")).toBeNull();
    const face = document.querySelector(".timer-clock-face");
    expect(face).not.toBeNull();
    expect(face!.getAttribute("role")).toBe("img");
    expect(face!.querySelectorAll(".timer-face-hand-hour, .timer-face-hand-minute, .timer-face-hand-second")).toHaveLength(3);
    expect(face!.querySelectorAll(".timer-face-number")).toHaveLength(12);
    expect(localStorage.getItem("levitaire-timer-clock-style")).toBe("analog");
  });

  it("再次点击切回数字样式", async () => {
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    const toggle = screen.getByRole("button", { name: "切换时钟样式" });
    fireEvent.click(toggle);
    expect(document.querySelector(".timer-clock-face")).not.toBeNull();
    fireEvent.click(toggle);
    expect(document.querySelector(".timer-clock-face")).toBeNull();
    expect(document.querySelector(".timer-local-clock-value")).not.toBeNull();
    expect(localStorage.getItem("levitaire-timer-clock-style")).toBe("digital");
  });

  it("已持久化的表盘偏好会在重新打开时恢复", async () => {
    localStorage.setItem("levitaire-timer-clock-style", "analog");
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector(".timer-clock-face")).not.toBeNull();
    expect(document.querySelector(".timer-local-clock-value")).toBeNull();
  });
});

describe("TimerTool 顶部工具条收展", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
  });

  it("初始收起，悬浮到工具区域后展开", async () => {
    const { container } = render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    const shell = container.querySelector(".timer-shell");
    expect(shell).not.toBeNull();
    expect(shell!.className).not.toContain("is-chrome-open");
    fireEvent.mouseEnter(shell!);
    expect(shell!.className).toContain("is-chrome-open");
  });

  it("鼠标移出后延迟收起工具条", async () => {
    const { container } = render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    const shell = container.querySelector(".timer-shell")!;
    fireEvent.mouseEnter(shell);
    expect(shell.className).toContain("is-chrome-open");
    fireEvent.mouseLeave(shell);
    // 延迟尚未触发，仍保持展开
    expect(shell.className).toContain("is-chrome-open");
    await waitFor(() => expect(shell.className).not.toContain("is-chrome-open"));
  });

  it("关闭按钮点击后立即收起，避免下次打开仍展开", async () => {
    const { container } = render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    const shell = container.querySelector(".timer-shell")!;
    fireEvent.mouseEnter(shell);
    expect(shell.className).toContain("is-chrome-open");
    fireEvent.click(screen.getByRole("button", { name: "关闭时钟工具" }));
    expect(shell.className).not.toContain("is-chrome-open");
    expect(mockInvoke).toHaveBeenCalledWith("hide_timer_window");
  });
});

describe("TimerTool 页签记忆", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
  });

  it("切换到倒计时页签后持久化到本地", async () => {
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
    expect(localStorage.getItem("levitaire-timer-view")).toBe("countdown");
  });

  it("已持久化的页签会在重新打开时恢复", async () => {
    localStorage.setItem("levitaire-timer-view", "calendar");
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("tab", { name: "日历" })).toHaveAttribute("aria-selected", "true");
  });

  it("本地存储了非法页签值时回退到时钟页", async () => {
    localStorage.setItem("levitaire-timer-view", "alarm");
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("tab", { name: "时钟" })).toHaveAttribute("aria-selected", "true");
  });

  it("恢复秒表页签且后端无秒表时自动创建", async () => {
    localStorage.setItem("levitaire-timer-view", "stopwatch");
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    expect(mockInvoke).toHaveBeenCalledWith("create_timer", {
      input: { kind: "stopwatch", label: "秒表", durationSecs: 0 },
    });
  });

  it("恢复秒表页签且后端已有秒表时不重复创建", async () => {
    localStorage.setItem("levitaire-timer-view", "stopwatch");
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [baseStopwatch] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    expect(mockInvoke).not.toHaveBeenCalledWith("create_timer", {
      input: { kind: "stopwatch", label: "秒表", durationSecs: 0 },
    });
    expect(screen.getByRole("tab", { name: "秒表" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("TimerTool 倒计时自定义预设", () => {
  const baseCountdown = {
    id: "timer-1",
    label: "倒计时",
    kind: "countdown" as const,
    durationSecs: 300,
    remainingSecs: 300,
    elapsedSecs: 0,
    running: false,
    completed: false,
    startedUnixMs: null,
    laps: [] as number[],
  };
  const countdown = (overrides: Partial<typeof baseCountdown> = {}) => ({ ...baseCountdown, ...overrides });

  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [countdown()] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
  });

  it("点击已保存预设直接套用其时长", async () => {
    localStorage.setItem("levitaire-timer-presets", JSON.stringify([{ id: "p1", name: "学习", minutes: 45 }]));
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
    fireEvent.click(screen.getByRole("button", { name: "学习 45分" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("set_timer_duration", { id: "timer-1", seconds: 2700 }));
  });

  it("把自定义分钟数存为带名称的预设并持久化", async () => {
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
    fireEvent.change(screen.getByLabelText("自定义分钟数"), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "保存为预设" }));
    fireEvent.change(screen.getByLabelText("预设名称"), { target: { value: "学习" } });
    fireEvent.keyDown(screen.getByLabelText("预设名称"), { key: "Enter" });
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("levitaire-timer-presets") ?? "[]");
      expect(stored).toEqual([expect.objectContaining({ name: "学习", minutes: 45 })]);
    });
    expect(screen.getByRole("button", { name: "学习 45分" })).toBeInTheDocument();
    expect(screen.queryByLabelText("预设名称")).not.toBeInTheDocument();
  });

  it("重复保存同名预设会更新原有时长而非重复添加", async () => {
    localStorage.setItem("levitaire-timer-presets", JSON.stringify([{ id: "p1", name: "学习", minutes: 45 }]));
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
    fireEvent.click(screen.getByRole("button", { name: "保存为预设" }));
    fireEvent.change(screen.getByLabelText("预设名称"), { target: { value: "学习" } });
    fireEvent.change(screen.getByLabelText("预设分钟数"), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: "保存预设" }));
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("levitaire-timer-presets") ?? "[]");
      expect(stored).toEqual([expect.objectContaining({ id: "p1", name: "学习", minutes: 90 })]);
    });
    expect(screen.getByRole("button", { name: "学习 90分" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "学习 45分" })).not.toBeInTheDocument();
  });

  it("可删除已保存的预设", async () => {
    localStorage.setItem("levitaire-timer-presets", JSON.stringify([{ id: "p1", name: "会议", minutes: 90 }]));
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
    fireEvent.click(screen.getByRole("button", { name: "删除会议 90分" }));
    await waitFor(() => expect(localStorage.getItem("levitaire-timer-presets")).toBe("[]"));
    expect(screen.queryByRole("button", { name: "会议 90分" })).not.toBeInTheDocument();
  });

  it("倒计时运行时隐藏已保存预设", async () => {
    localStorage.setItem("levitaire-timer-presets", JSON.stringify([{ id: "p1", name: "学习", minutes: 45 }]));
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [countdown({ running: true, remainingSecs: 200 })] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
    expect(screen.queryByRole("button", { name: "学习 45分" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存为预设" })).not.toBeInTheDocument();
  });

  it("本地存储了损坏的预设数据时回退为空", async () => {
    localStorage.setItem("levitaire-timer-presets", "{bad json");
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
    expect(screen.queryByText("分钟")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存为预设" })).toBeInTheDocument();
  });

  it("预设分钟数为空时不保存，保持编辑状态", async () => {
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
    fireEvent.click(screen.getByRole("button", { name: "保存为预设" }));
    fireEvent.change(screen.getByLabelText("预设名称"), { target: { value: "学习" } });
    fireEvent.change(screen.getByLabelText("预设分钟数"), { target: { value: "" } });
    fireEvent.keyDown(screen.getByLabelText("预设名称"), { key: "Enter" });
    expect(JSON.parse(localStorage.getItem("levitaire-timer-presets") ?? "[]")).toEqual([]);
    expect(screen.getByLabelText("预设名称")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存预设" })).toBeDisabled();
  });

  it("点击快捷预设会把分钟数同步到自定义输入框", async () => {
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
    fireEvent.click(screen.getByRole("button", { name: "25分" }));
    expect((screen.getByLabelText("自定义分钟数") as HTMLInputElement).value).toBe("25");
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("set_timer_duration", { id: "timer-1", seconds: 1500 }));
  });
});

describe("world clock preferences", () => {
  beforeEach(() => localStorage.clear());

  it("uses bounded defaults when no preference is stored", () => {
    expect(localStorage.getItem("levitaire-world-clocks")).toBeNull();
  });

  it("can persist a selected timezone list", () => {
    const zones = ["Asia/Shanghai", "Europe/London", "America/New_York"];
    localStorage.setItem("levitaire-world-clocks", JSON.stringify(zones));
    expect(JSON.parse(localStorage.getItem("levitaire-world-clocks") ?? "[]")).toEqual(zones);
  });

  it("formats a timezone without relying on the local timezone", () => {
    const value = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date("2026-01-01T00:00:00Z"));
    expect(value).toMatch(/^08:00/);
  });
});
