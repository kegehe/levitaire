import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TimerTool from "./TimerTool";
import { hourglassOffsets } from "./hourglassGeometry";
import { clearMockListeners, emitMockEvent, mockSetSize, mockStartDragging } from "../../test/tauri-mock";

const mockInvoke = vi.mocked(invoke);

// 组件会持久化页签/样式到 localStorage，逐个用例清空避免互相污染
beforeEach(() => {
  localStorage.clear();
});

/** 读 TimerTool.css 源码（去掉注释、压平空白）：jsdom/happy-dom 都不做布局，
 *  面板宽度这类真值只能对着声明断言，同 UtilityHub.test.tsx 的做法。
 *  用 node:url 的 URL 解析：测试环境里全局 URL 被换掉，fileURLToPath 会认不出来。 */
function readTimerCss(): string {
  const css = readFileSync(fileURLToPath(new NodeURL("./TimerTool.css", import.meta.url)), "utf8");
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
}

/** 取某个选择器**最后一处**规则的声明体（同特异性下靠书写顺序取胜，与 CSS 的用法一致） */
function cssRuleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = [...css.matchAll(new RegExp(`(?:^| )${escaped} \\{([^}]*)\\}`, "g"))];
  expect(found.length, `${selector} 规则缺失`).toBeGreaterThan(0);
  return found[found.length - 1][1];
}

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

  it("marks 休 / 班 on cells of the visible month", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 0, 15));
    try {
      render(<TimerTool />);
      await act(async () => { await Promise.resolve(); });
      fireEvent.click(screen.getByRole("tab", { name: "日历" }));

      // 按「日号」定位当月的格子（42 格会含上下月，用 is-outside 排除同名日号）
      const cellOf = (day: number) =>
        [...document.querySelectorAll<HTMLElement>(".calendar-cell:not(.is-outside)")].find(
          (cell) => cell.querySelector("span")?.textContent === String(day),
        );
      const markOf = (day: number) => cellOf(day)?.querySelector(".calendar-rest")?.textContent ?? null;

      // 2026 年 1 月：1/1–1/3 放假（休）、1/4 调休上班（班）——逐个核对日期，避免标记整体错位仍通过
      expect([1, 2, 3].map(markOf)).toEqual(["休", "休", "休"]);
      expect(markOf(4)).toBe("班");
      // 普通周末（1/10、1/11）与普通工作日（1/8）不应出现角标
      expect([8, 10, 11].map(markOf)).toEqual([null, null, null]);

      // 角标色随类型区分：休为绿、班为橙
      expect(cellOf(1)?.querySelector(".rest-holiday")).not.toBeNull();
      expect(cellOf(4)?.querySelector(".rest-workday")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

describe("TimerTool 倒计时的动态表现", () => {
  const countdown = (remainingSecs: number, running = false) => ({
    id: "timer-1",
    label: "倒计时",
    kind: "countdown" as const,
    durationSecs: 300,
    remainingSecs,
    elapsedSecs: 0,
    running,
    completed: remainingSecs === 0,
    startedUnixMs: null,
    laps: [] as number[],
  });
  const mount = async (timer: ReturnType<typeof countdown>) => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [timer] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
  };
  const view = () => document.querySelector(".timer-countdown-view")!;

  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.setItem("levitaire-timer-display", "ring");
  });

  // 数字跳动动画靠 key={剩余秒数} 重挂元素来重放，这条断言卡住「重挂」这个前提：
  // 一旦有人把 key 去掉（或包一层固定 key 的容器），动画会静默消失而其他测试全绿。
  it("剩余秒数变化时替换数字节点，同一秒内的重复广播不替换", async () => {
    await mount(countdown(95, true));
    const before = document.querySelector(".timer-ring-view strong");
    expect(before).not.toBeNull();

    // 后端 500ms 轮询、整数秒没变也会广播：这种重复更新不能重挂，否则动画每秒抖两次
    act(() => emitMockEvent("timers-changed", { timers: [countdown(95, true)] }));
    expect(document.querySelector(".timer-ring-view strong")).toBe(before);

    act(() => emitMockEvent("timers-changed", { timers: [countdown(94, true)] }));
    const after = document.querySelector(".timer-ring-view strong");
    expect(after).not.toBe(before);
    expect(after!.textContent).toBe("01:34");
  });

  it("运行中带 is-running，最后 10s 带 is-urgent，到点换成 is-complete", async () => {
    await mount(countdown(95, true));
    expect(view().className).toContain("is-running");
    expect(view().className).not.toContain("is-urgent");

    act(() => emitMockEvent("timers-changed", { timers: [countdown(10, true)] }));
    expect(view().className).toContain("is-urgent");
    expect(document.querySelector(".timer-ring-view strong")!.textContent).toBe("00:10");

    act(() => emitMockEvent("timers-changed", { timers: [countdown(0, false)] }));
    expect(view().className).toContain("is-complete");
    expect(view().className).not.toContain("is-urgent");
    expect(view().className).not.toContain("is-running");
  });

  it("暂停时不进入强调态（剩余 8s 也不跳动）", async () => {
    await mount(countdown(8, false));
    expect(view().className).not.toContain("is-urgent");
    expect(view().className).not.toContain("is-running");
  });

  it("环头珠子只在运行时出现，旋转量 = 进度 × 360° + 90°", async () => {
    await mount(countdown(150, true));
    const head = document.querySelector(".timer-ring-head") as SVGGElement | null;
    expect(head).not.toBeNull();
    // 进度 150/300 = 50% → 180 + 90 = 270°（+90° 是为了抵消外层 svg 自己的 rotate(-90deg)）
    expect(head!.style.transform).toContain("270deg");

    act(() => emitMockEvent("timers-changed", { timers: [countdown(150, false)] }));
    expect(document.querySelector(".timer-ring-head")).toBeNull();
  });

  it("紧凑样式同样在数字下方挂进度条，宽度按剩余比例", async () => {
    localStorage.setItem("levitaire-timer-display", "compact");
    await mount(countdown(75, true));
    const fill = document.querySelector(".timer-progress-fill") as HTMLElement | null;
    expect(fill).not.toBeNull();
    // 75/300 = 25%
    expect(fill!.style.transform).toBe("scaleX(0.25)");
  });
});

describe("TimerTool 倒计时沙漏样式", () => {
  const countdown = (remainingSecs: number, running = false) => ({
    id: "timer-1",
    label: "倒计时",
    kind: "countdown" as const,
    durationSecs: 300,
    remainingSecs,
    elapsedSecs: 0,
    running,
    completed: remainingSecs === 0,
    startedUnixMs: null,
    laps: [] as number[],
  });
  const mount = async (timer: ReturnType<typeof countdown>) => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [timer] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.setItem("levitaire-timer-display", "hourglass");
  });

  // 这条只验「组件把几何模块算出来的值原样接到 DOM 上」（接线），映射本身对不对由
  // hourglassGeometry.test.ts 的守恒断言负责——别把这里当成对映射的验证。
  it("沙块位移与几何模块一致（面积等比映射），数字沿用 .timer-primary-value", async () => {
    await mount(countdown(150, true)); // 剩余 50%
    const want = hourglassOffsets(0.5, true);
    expect((document.querySelector(".hg-sand-top") as SVGRectElement).style.transform).toBe(`translateY(${want.sandY}px)`);
    expect((document.querySelector(".hg-sand-bottom") as SVGRectElement).style.transform).toBe(`translateY(${want.pileY}px)`);
    // 凹坑与沙面同步位移，再按沙量缩放（先缩后移，字符串顺序就是执行顺序）；宽度随沙面处的瓶宽收
    expect((document.querySelector(".hg-crater") as SVGElement).style.transform).toBe(`translateY(${want.sandY}px) scale(${want.craterWidth}, ${want.crater})`);
    // 堆沙尖堆跟着堆沙走，且只在堆沙那一层瓶壁内缩放（否则会从瓶壁两侧支出来）
    expect((document.querySelector(".hg-mound") as SVGElement).style.transform).toBe(`translateY(${want.pileY}px) scale(${want.moundScale})`);
    // 数字仍带 timer-primary-value：逐秒跳动、强调态、到点闪烁那套规则全部复用
    expect(document.querySelector(".timer-hg-value")).not.toBeNull();
  });

  // 这条盯的是「裁剪区跟着沙子一起平移」——SVG 的 clip-path 在引用元素自己的坐标系里解析，
  // 一旦把 translateY 写回带 clip-path 的 <g>，沙子会从瓶壁两侧漏出去。
  // jsdom 不做裁剪，只有像素复核能看出渲染事故，所以这里用结构断言把它钉住。
  // 沙色的明暗层同理：它必须挂在**不带 transform** 的元素上，否则渐变坐标系会跟着沙块跑，
  // 沙面越往下越亮（沙子像在发光）。
  it("位移只写在内层沙块上，裁剪分组与明暗层都不带 transform", async () => {
    await mount(countdown(150, true));
    for (const sel of [".hg-sand-top", ".hg-sand-bottom"]) {
      const rect = document.querySelector(sel) as SVGRectElement;
      expect(rect.style.transform).not.toBe("");

      const clipGroup = rect.parentElement!;
      expect(clipGroup.getAttribute("clip-path")).toMatch(/^url\(#timer-hg-clip-/);
      expect(clipGroup.getAttribute("style") ?? "").not.toContain("transform");
      expect((clipGroup as unknown as SVGGElement).style.transform).toBe("");
    }
    const shades = document.querySelectorAll(".hg-shade");
    expect(shades).toHaveLength(2);
    for (const shade of shades) {
      expect((shade as unknown as SVGRectElement).style.transform).toBe("");
      expect(shade.parentElement!.getAttribute("clip-path")).toMatch(/^url\(#timer-hg-clip-/);
    }
  });

  it("流沙只在运行时出现，暂停即断流", async () => {
    await mount(countdown(150, true));
    expect(document.querySelector(".hg-stream")).not.toBeNull();
    // 柱心的「落沙纹」也要在（靠 stroke-dashoffset 循环往下走，是比位移更细的一层动感）
    expect(document.querySelector(".hg-stream-flow")).not.toBeNull();
    act(() => emitMockEvent("timers-changed", { timers: [countdown(150, false)] }));
    expect(document.querySelector(".hg-stream")).toBeNull();
    // 暂停时凹坑收平：深度缩放归零（宽度缩放仍留着，只是被零高度压平）
    const paused = hourglassOffsets(0.5, false);
    expect((document.querySelector(".hg-crater") as SVGElement).style.transform).toBe(`translateY(${paused.sandY}px) scale(${paused.craterWidth}, 0)`);
  });

  it("样式按钮按 数字 → 环形 → 沙漏 → 数字 循环，并把选择写回存储", async () => {
    localStorage.setItem("levitaire-timer-display", "compact");
    await mount(countdown(120, false));
    const toggle = screen.getByRole("button", { name: "切换倒计时样式" });
    // 提示文案要说清「点一下变成什么」，三个样式循环时尤其重要
    expect(toggle.getAttribute("data-tooltip")).toBe("切换为环形");

    fireEvent.click(toggle);
    expect(document.querySelector(".timer-ring-view")).not.toBeNull();
    expect(toggle.getAttribute("data-tooltip")).toBe("切换为沙漏");

    fireEvent.click(toggle);
    // 必须限定 svg：面板自己的显示样式修饰类也叫过 timer-hourglass，不限定就等于在测面板
    expect(document.querySelector("svg.timer-hourglass")).not.toBeNull();
    expect(localStorage.getItem("levitaire-timer-display")).toBe("hourglass");

    fireEvent.click(toggle);
    expect(document.querySelector("svg.timer-hourglass")).toBeNull();
    expect(document.querySelector(".timer-progress")).not.toBeNull();
    expect(localStorage.getItem("levitaire-timer-display")).toBe("compact");
  });

  it("存储里是脏值时回退到数字样式", async () => {
    localStorage.setItem("levitaire-timer-display", "bogus");
    await mount(countdown(120, false));
    expect(document.querySelector("svg.timer-hourglass")).toBeNull();
    expect(document.querySelector(".timer-ring-view")).toBeNull();
    expect(document.querySelector(".timer-progress")).not.toBeNull();
  });

  // `.timer-*` 这个命名空间是面板与图形共用的：面板曾用 `timer-${display}` 作修饰类，
  // 切到沙漏时生成 `timer-hourglass` 与 <svg> 撞名，`.timer-hourglass { width: 112px }`
  // 把面板的 `width: 100%` 覆盖掉 —— 面板被压成 112×112、内容溢出到面板外，且因为修饰类
  // 与页签无关，切到时钟/秒表/日历也一样坏。jsdom 不算布局，这里用「类名集合不相交」把它钉住。
  it("面板修饰类不与图形类撞名（三种样式都不相交）", async () => {
    const cases = [["compact", "timer-display-compact"], ["ring", "timer-display-ring"], ["hourglass", "timer-display-hourglass"]] as const;
    for (const [stored, modifier] of cases) {
      cleanup();
      localStorage.setItem("levitaire-timer-display", stored);
      await mount(countdown(150, false));

      const shell = document.querySelector(".timer-shell")!;
      const shellTokens = [...shell.classList];
      const graphicTokens = new Set<string>();
      shell.querySelectorAll("*").forEach((el) => el.classList.forEach((token) => graphicTokens.add(token)));
      expect(shellTokens.filter((token) => graphicTokens.has(token))).toEqual([]);
      expect(shellTokens).toEqual(["timer-shell", modifier]);
    }
    cleanup();
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
    fireEvent.click(screen.getByRole("button", { name: "关闭时间工具" }));
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

describe("TimerTool 番茄钟页签", () => {
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

  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [baseCountdown] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
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
          JSON.stringify({
            workMinutes: 25,
            shortBreakMinutes: 5,
            longBreakMinutes: 15,
            roundsBeforeLongBreak: 4,
            autoStartNext: false,
            notifySound: true,
          }),
        );
      }
      return Promise.resolve(undefined);
    });
  });

  it("番茄钟作为页签渲染在同一窗口里，不再有独立窗口", async () => {
    const { container } = render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "番茄钟" }));
    expect(await screen.findByText("25:00")).toBeInTheDocument();
    expect(container.querySelector(".timer-pomodoro-view")).not.toBeNull();
    expect(mockInvoke).not.toHaveBeenCalledWith("show_pomodoro_window");
  });

  it("已持久化的番茄钟页签会在重新打开时恢复", async () => {
    localStorage.setItem("levitaire-timer-view", "pomodoro");
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("tab", { name: "番茄钟" })).toHaveAttribute("aria-selected", "true");
  });

  it("收到 timer-focus-pomodoro 事件（待办「开始专注」）后切到番茄钟页签", async () => {
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("tab", { name: "时钟" })).toHaveAttribute("aria-selected", "true");

    act(() => emitMockEvent("timer-focus-pomodoro", undefined));
    // 番茄钟面板挂载后会异步拉取状态，等它落定再断言，避免 act 警告
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("tab", { name: "番茄钟" })).toHaveAttribute("aria-selected", "true");
  });

  it("Esc 隐藏窗口，但在输入框里按 Esc 交给输入框自己处理", async () => {
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("hide_timer_window"));

    mockInvoke.mockClear();
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
    fireEvent.keyDown(screen.getByLabelText("自定义分钟数"), { key: "Escape" });
    expect(mockInvoke).not.toHaveBeenCalledWith("hide_timer_window");
  });
});

describe("TimerTool 面板宽度随内容走", () => {
  /** 组件的 ResizeObserver 回调：happy-dom 不做布局，观察器不会自己触发，测试里手动调 */
  let resizeCallback: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    resizeCallback = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resizeCallback = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // 改版前面板宽度写死 320（日历 380）：时钟/番茄钟这类窄内容左右各留一大块空白。
  // 现在宽度由 CSS 的 width: max-content 按内容算，前端只管量完下发。
  it("窗口宽度按面板实测下发，不再写死 320", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 214.2,
      height: 96.4,
    } as DOMRect);

    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });

    // 向上取整：宁可多 1px 的透明边，也不能让面板被窗口边界裁掉 1px
    expect(mockSetSize).toHaveBeenCalledWith(expect.objectContaining({ width: 215, height: 97 }));
  });

  it("展开工具条（面板被页签行撑宽）后按新尺寸重新下发", async () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ width: 214, height: 96 } as DOMRect);
    const { container } = render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    expect(mockSetSize).toHaveBeenCalledTimes(1);

    // 悬浮展开工具条后浏览器会回调 ResizeObserver：面板宽度变成「能容纳 5 个页签 + 操作按钮」
    rect.mockReturnValue({ width: 304, height: 140 } as DOMRect);
    act(() => {
      fireEvent.mouseEnter(container.querySelector(".timer-shell")!);
      resizeCallback!();
    });

    expect(mockSetSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 304, height: 140 }));
  });

  it("尺寸没变就不再下发（避免同一尺寸反复 setSize）", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 214,
      height: 96,
    } as DOMRect);
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    expect(mockSetSize).toHaveBeenCalledTimes(1);

    // 页签/样式切换会让 resize effect 重跑并再调一次量尺寸，尺寸没变就不该再 setSize
    act(() => resizeCallback!());
    act(() => resizeCallback!());
    expect(mockSetSize).toHaveBeenCalledTimes(1);
  });

  it("CSS：面板按 max-content 取宽、收起的工具条退出宽度计算、长文本逐处限宽", () => {
    const css = readTimerCss();

    // 必须是 max-content：fit-content / 100% 会被「可用空间」（当前窗口宽度）钳制，
    // 于是窗口偏窄时面板被压窄、量到的仍是窄值，窗口再也长不回去（同 UtilityHub.css 的坑）。
    const shell = cssRuleBody(css, ".timer-shell");
    expect(shell).toContain("width: max-content");
    expect(shell).not.toContain("fit-content");
    expect(shell).toContain("max-width: 360px");

    // 收起的工具条必须绝对定位，否则「5 个页签 + 操作按钮」的宽度会继续撑住面板
    expect(cssRuleBody(css, ".timer-shell:not(.is-chrome-open) .timer-header")).toContain(
      "position: absolute",
    );

    // 日历是 7 列网格，列宽按内容算会得到随月份浮动的窄格子，仍固定 380px
    expect(cssRuleBody(css, '.timer-shell[data-view="calendar"]')).toContain("width: 380px");

    // 长度不可控的文本必须逐处限宽，否则一行长文本会把面板整体撑开（实测：秒表名 60 字
    // 会把 179px 的面板撑到 700px+）。改了这些行的高度/换行方式时要连带检查这条不变式。
    for (const selector of [
      ".timer-label",
      ".timer-countdown-label",
      ".timer-countdown-name",
      ".timer-preset-chip > button:first-child",
      ".timer-pomodoro-focus",
      ".timer-my-presets",
    ]) {
      expect(cssRuleBody(css, selector), `${selector} 缺少 max-width`).toMatch(/max-width: \d+px/);
    }

    // 8 个倒计时不能无限撑高面板（窗口只夹位置、不缩放内容）：列表必须限高滚动。
    // 行内控件的提示已改用原生 title，不会被这个 overflow 容器裁掉。
    const listRule = cssRuleBody(css, ".timer-countdown-list ul");
    expect(listRule, "倒计时列表缺少 max-height").toMatch(/max-height: \d+px/);
    expect(listRule).toContain("overflow-y: auto");
  });
});

describe("TimerTool 拖窗区域", () => {
  // 拖窗用例覆盖倒计时视图，需要有计时器存在（预设行才会渲染）
  const dragCountdown = {
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

  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [dragCountdown] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
  });

  // 回归：拖拽原先只挂在顶部工具条上，而工具条左侧被页签占满，
  // 导致「只有右边一小条能拖、左边拖不动」。现在整张卡片都能拖。
  it("在内容显示区按下即可拖动窗口", async () => {
    const { container } = render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    const clockView = container.querySelector(".timer-clock-view");
    expect(clockView).not.toBeNull();
    fireEvent.mouseDown(clockView!, { button: 0 });
    expect(mockStartDragging).toHaveBeenCalledTimes(1);
  });

  it("在页签按钮上按下不触发拖窗（保留点击切换）", async () => {
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "时钟" }), { button: 0 });
    expect(mockStartDragging).not.toHaveBeenCalled();
  });

  // 列表行本身可点击切换当前倒计时。若不把列表加入拖窗豁免，mousedown 会先触发
  // startDragging，真实窗口里随后的 click 不会到达行，切换和滚动都会失效。
  it("在倒计时列表上一次按下不触发拖窗", async () => {
    const { container } = render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));

    fireEvent.mouseDown(container.querySelector(".timer-countdown-item")!, { button: 0 });
    expect(mockStartDragging).not.toHaveBeenCalled();

    fireEvent.mouseDown(container.querySelector(".timer-countdown-time")!, { button: 0 });
    expect(mockStartDragging).not.toHaveBeenCalled();
  });

  it("在输入框上按下不触发拖窗", async () => {
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
    fireEvent.mouseDown(screen.getByLabelText("自定义分钟数"), { button: 0 });
    expect(mockStartDragging).not.toHaveBeenCalled();
  });

  // 图标是 <svg>（SVGElement），不是 HTMLElement：用 HTMLElement 做 instanceof
  // 判断会把落在图标上的按下误判成可拖空白区，这里锁住该边界。
  it("在按钮内的图标上按下不触发拖窗", async () => {
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    const icon = screen.getByRole("button", { name: "关闭时间工具" }).querySelector("svg");
    expect(icon).not.toBeNull();
    fireEvent.mouseDown(icon!, { button: 0 });
    expect(mockStartDragging).not.toHaveBeenCalled();
  });

  it("右键按下不触发拖窗", async () => {
    const { container } = render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.mouseDown(container.querySelector(".timer-clock-view")!, { button: 2 });
    expect(mockStartDragging).not.toHaveBeenCalled();
  });
});

describe("TimerTool 操作失败提示", () => {
  const countdownFixture = {
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

  let consoleError: ReturnType<typeof vi.spyOn>;

  /** 让指定命令失败，其余命令正常返回；timers 为挂载时后端持有的计时器清单 */
  const mountWith = async (timers: unknown[], failCommand?: string) => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      if (command === failCommand) return Promise.reject(new Error("backend failure"));
      return Promise.resolve(undefined);
    });
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    // 失败路径会 console.error 上报，测试里静音以免污染输出
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("倒计时开始失败时给出可见提示", async () => {
    await mountWith([countdownFixture], "start_timer");
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("倒计时开始失败");
  });

  it("倒计时设定失败时给出可见提示（含快捷预设）", async () => {
    await mountWith([countdownFixture], "set_timer_duration");
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
    fireEvent.click(screen.getByRole("button", { name: "10分" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("倒计时设置时长失败");
  });

  it("秒表重置失败时给出可见提示", async () => {
    await mountWith([baseStopwatch], "reset_timer");
    fireEvent.click(screen.getByRole("tab", { name: "秒表" }));
    await screen.findByText("00:23");
    fireEvent.click(screen.getByRole("button", { name: "重置秒表" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("秒表重置失败");
  });

  it("秒表创建失败时给出可见提示", async () => {
    await mountWith([], "create_timer");
    fireEvent.click(screen.getByRole("tab", { name: "秒表" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("创建秒表失败");
  });

  it("重试成功后撤掉上一条错误提示", async () => {
    await mountWith([countdownFixture], "start_timer");
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await screen.findByRole("alert");

    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [countdownFixture] });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("其他操作成功不会误清当前错误提示", async () => {
    await mountWith([countdownFixture], "start_timer");
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await screen.findByRole("alert");

    // 加时成功与「开始」无关，不应把开始失败的提示顺带撤掉
    fireEvent.click(screen.getByRole("button", { name: "增加一分钟" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("add_timer_seconds", { id: "timer-1", seconds: 60 }));
    expect(screen.getByRole("alert")).toHaveTextContent("倒计时开始失败");
  });

  it("提示会自动消失，避免一直占着面板", async () => {
    vi.useFakeTimers();
    try {
      await mountWith([countdownFixture], "start_timer");
      fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
      fireEvent.click(screen.getByRole("button", { name: "开始" }));
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByRole("alert")).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(4000); });
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TimerTool 多倒计时管理", () => {
  const countdown = (overrides: Record<string, unknown> = {}) => ({
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
    ...overrides,
  });
  const study = countdown({ id: "timer-1", label: "学习", remainingSecs: 1500, durationSecs: 1500 });
  const writing = countdown({ id: "timer-2", label: "写作", remainingSecs: 600, durationSecs: 600 });
  const rest = countdown({ id: "timer-3", label: "休息", remainingSecs: 300, durationSecs: 300 });

  /** 挂载并切到倒计时页签；create_timer 默认把新计时器追加在末尾 */
  const mount = async (timers: unknown[], created?: unknown, deleted?: unknown) => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers });
      if (command === "create_timer") return Promise.resolve(created ?? { timers });
      if (command === "delete_timer") return Promise.resolve(deleted ?? undefined);
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("tab", { name: "倒计时" }));
  };
  const activeLabel = () =>
    document.querySelector(".timer-countdown-item.is-active .timer-countdown-name-text")?.textContent;

  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
  });

  it("列出全部倒计时，点击某一行即切换大数字显示的那个", async () => {
    await mount([study, writing]);
    const rows = document.querySelectorAll(".timer-countdown-item");
    expect(rows).toHaveLength(2);
    expect(activeLabel()).toBe("学习");
    // 大数字与列表行同时显示 25:00
    expect(screen.getAllByText("25:00").length).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByRole("button", { name: "写作" }));
    expect(activeLabel()).toBe("写作");
    expect(document.querySelector(".timer-primary-value")!.textContent).toBe("10:00");
  });

  it("新建倒计时后自动聚焦到新计时器", async () => {
    const created = countdown({ id: "timer-3", label: "倒计时 3" });
    await mount([study, writing], { timers: [study, writing, created] });
    fireEvent.click(screen.getByRole("button", { name: "新建倒计时" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("create_timer", {
      input: { kind: "countdown", label: "倒计时 3", durationSecs: 300 },
    }));
    await waitFor(() => expect(activeLabel()).toBe("倒计时 3"));
  });

  it("列表里的开始/暂停只作用于对应计时器", async () => {
    await mount([{ ...study, running: true }, writing]);
    fireEvent.click(screen.getByRole("button", { name: "暂停学习" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("pause_timer", { id: "timer-1" }));

    fireEvent.click(screen.getByRole("button", { name: "开始写作" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("start_timer", { id: "timer-2" }));
  });

  it("双击列表名称可重命名该倒计时", async () => {
    await mount([study, writing]);
    fireEvent.doubleClick(screen.getByRole("button", { name: "写作" }));
    const input = screen.getByRole("textbox", { name: "重命名写作" });
    fireEvent.change(input, { target: { value: "文案" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("rename_timer", { id: "timer-2", label: "文案" }));
  });

  it("删除指定倒计时后行消失，当前项回落到剩余第一条", async () => {
    await mount([study, writing], undefined, { timers: [study] });
    fireEvent.click(screen.getByRole("button", { name: "写作" }));
    expect(activeLabel()).toBe("写作");

    fireEvent.click(screen.getByRole("button", { name: "删除写作" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("delete_timer", { id: "timer-2" }));
    await waitFor(() => expect(document.querySelectorAll(".timer-countdown-item")).toHaveLength(1));
    expect(activeLabel()).toBe("学习");
  });

  it("删除后迟到的旧快照不会让该倒计时复活", async () => {
    await mount([study, writing], undefined, { timers: [study] });
    fireEvent.click(screen.getByRole("button", { name: "删除写作" }));
    await waitFor(() => expect(document.querySelectorAll(".timer-countdown-item")).toHaveLength(1));

    // 调度线程可能在删除前取好快照、删除后才投递：这份快照里还带着写作
    act(() => emitMockEvent("timers-changed", { timers: [study, writing] }));
    expect(document.querySelectorAll(".timer-countdown-item")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "写作" })).toBeNull();
  });

  it("同一删除按钮连点只发一次请求，请求期间按钮禁用", async () => {
    let resolveDelete: (payload: { timers: unknown[] }) => void;
    await mount([study, writing]);
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: [study, writing] });
      if (command === "delete_timer") return new Promise((resolve) => { resolveDelete = resolve; });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    const button = screen.getByRole("button", { name: "删除写作" });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);

    await act(async () => {
      resolveDelete!({ timers: [study] });
      await Promise.resolve();
    });
    const deleteCalls = mockInvoke.mock.calls.filter(([command]) => command === "delete_timer");
    expect(deleteCalls).toHaveLength(1);
  });

  it("删除冷却窗挡住双击落到相邻行造成的误删", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      await mount([study, writing, rest]);
      // 模拟第一下删除后下一行顶到同一坐标：两次点击落在不同行，但间隔为 0
      fireEvent.click(screen.getByRole("button", { name: "删除写作" }));
      fireEvent.click(screen.getByRole("button", { name: "删除休息" }));
      const deleteCalls = mockInvoke.mock.calls.filter(([command]) => command === "delete_timer");
      expect(deleteCalls).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("初始页签是秒表且名额已满时，不自动创建也不再重复弹错", async () => {
    localStorage.setItem("levitaire-timer-view", "stopwatch");
    const eight = Array.from({ length: 8 }, (_, index) =>
      countdown({ id: `timer-${index + 1}`, label: `倒计时 ${index + 1}` }));
    mockInvoke.mockImplementation((command) => {
      if (command === "get_timers") return Promise.resolve({ timers: eight });
      if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    render(<TimerTool />);
    await act(async () => { await Promise.resolve(); });

    expect(mockInvoke).not.toHaveBeenCalledWith("create_timer", expect.anything());
    expect(await screen.findByRole("alert")).toHaveTextContent("最多只能创建 8 个计时器");
    expect(screen.getByText(/秒表尚未创建/)).toBeInTheDocument();
  });

  it("点击整行任意位置都能切换当前倒计时", async () => {
    await mount([study, writing]);
    const time = document.querySelectorAll(".timer-countdown-item")[1].querySelector(".timer-countdown-time")!;
    fireEvent.click(time);
    expect(activeLabel()).toBe("写作");
  });

  it("非当前倒计时的剩余时间随 timers-changed 更新", async () => {
    await mount([study, writing]);
    act(() => emitMockEvent("timers-changed", {
      timers: [study, { ...writing, remainingSecs: 500 }],
    }));
    // 列表行显示 08:20，大数字仍是选中项的 25:00
    expect(screen.getAllByText("08:20")).toHaveLength(1);
    expect(document.querySelector(".timer-primary-value")!.textContent).toBe("25:00");
  });

  it("当前倒计时被删除后自动回落到剩余的第一条", async () => {
    await mount([study, writing]);
    fireEvent.click(screen.getByRole("button", { name: "写作" }));
    expect(activeLabel()).toBe("写作");

    act(() => emitMockEvent("timers-changed", { timers: [study] }));
    expect(activeLabel()).toBe("学习");
    expect(document.querySelector(".timer-primary-value")!.textContent).toBe("25:00");
  });

  it("失焦也会提交重命名", async () => {
    await mount([study, writing]);
    fireEvent.doubleClick(screen.getByRole("button", { name: "写作" }));
    const input = screen.getByRole("textbox", { name: "重命名写作" });
    fireEvent.change(input, { target: { value: "文案" } });
    fireEvent.blur(input);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("rename_timer", { id: "timer-2", label: "文案" }));
  });

  it("输入法组合态下的 Enter/Escape 不提交也不取消重命名", async () => {
    await mount([study, writing]);
    fireEvent.doubleClick(screen.getByRole("button", { name: "写作" }));
    const input = screen.getByRole("textbox", { name: "重命名写作" });
    fireEvent.change(input, { target: { value: "会议" } });

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(mockInvoke).not.toHaveBeenCalledWith("rename_timer", expect.anything());
    expect(screen.getByRole("textbox", { name: "重命名写作" })).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(screen.getByRole("textbox", { name: "重命名写作" })).toBeInTheDocument();

    // 部分输入法结束组合时 isComposing 已是 false，只上报兼容值 229
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(mockInvoke).not.toHaveBeenCalledWith("rename_timer", expect.anything());
    expect(screen.getByRole("textbox", { name: "重命名写作" })).toBeInTheDocument();
  });

  it("重命名为已有名称时拒绝并提示，不会产生两个同名行", async () => {
    await mount([study, writing]);
    fireEvent.doubleClick(screen.getByRole("button", { name: "写作" }));
    const input = screen.getByRole("textbox", { name: "重命名写作" });
    fireEvent.change(input, { target: { value: "学习" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockInvoke).not.toHaveBeenCalledWith("rename_timer", expect.anything());
    expect(await screen.findByRole("alert")).toHaveTextContent("已有同名倒计时");
    // 拒绝时保留编辑器与草稿，用户可以直接改正
    const kept = screen.getByRole("textbox", { name: "重命名写作" }) as HTMLInputElement;
    expect(kept.value).toBe("学习");
  });

  it("重命名请求失败时保留编辑器与草稿，可直接重试", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await mount([study, writing]);
      mockInvoke.mockImplementation((command) => {
        if (command === "get_timers") return Promise.resolve({ timers: [study, writing] });
        if (command === "rename_timer") return Promise.reject(new Error("backend failure"));
        if (command === "get_timer_lunar_enabled") return Promise.resolve(true);
        return Promise.resolve(undefined);
      });
      fireEvent.doubleClick(screen.getByRole("button", { name: "写作" }));
      const input = screen.getByRole("textbox", { name: "重命名写作" });
      fireEvent.change(input, { target: { value: "文案" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(await screen.findByRole("alert")).toHaveTextContent("倒计时重命名失败");
      expect((screen.getByRole("textbox", { name: "重命名写作" }) as HTMLInputElement).value).toBe("文案");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("记住上次选中的倒计时；存储里的 id 失效时回落到第一条", async () => {
    localStorage.setItem("levitaire-timer-active-countdown", "timer-2");
    await mount([study, writing]);
    expect(activeLabel()).toBe("写作");
    cleanup();

    localStorage.setItem("levitaire-timer-active-countdown", "timer-99");
    await mount([study, writing]);
    expect(activeLabel()).toBe("学习");
  });

  it("重命名按 Escape 取消，不调用后端", async () => {
    await mount([study, writing]);
    fireEvent.doubleClick(screen.getByRole("button", { name: "写作" }));
    const input = screen.getByRole("textbox", { name: "重命名写作" });
    fireEvent.change(input, { target: { value: "文案" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(mockInvoke).not.toHaveBeenCalledWith("rename_timer", expect.anything());
    expect(screen.getByRole("button", { name: "写作" })).toBeInTheDocument();
  });

  it("新建名称跳过已占用的序号，避免删除后再建出现重名", async () => {
    const second = countdown({ id: "timer-2", label: "倒计时 2" });
    const third = countdown({ id: "timer-3", label: "倒计时 3" });
    await mount([second, third], { timers: [second, third] });
    fireEvent.click(screen.getByRole("button", { name: "新建倒计时" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("create_timer", {
      input: { kind: "countdown", label: "倒计时 4", durationSecs: 300 },
    }));
  });

  it("名额被倒计时占满时，秒表页显示空态而不是无效控制条", async () => {
    const eight = Array.from({ length: 8 }, (_, index) =>
      countdown({ id: `timer-${index + 1}`, label: `倒计时 ${index + 1}` }));
    await mount(eight);
    fireEvent.click(screen.getByRole("tab", { name: "秒表" }));

    expect(screen.getByText(/秒表尚未创建/)).toHaveTextContent("最多 8 个计时器");
    expect(mockInvoke).not.toHaveBeenCalledWith("create_timer", expect.anything());
    expect(screen.queryByRole("button", { name: "重置秒表" })).toBeNull();

    // 空态给出可操作入口，而不是只留一个 4 秒后消失的提示
    fireEvent.click(screen.getByRole("button", { name: "去倒计时列表管理" }));
    expect(screen.getByRole("tab", { name: "倒计时" })).toHaveAttribute("aria-selected", "true");
  });

  it("没有任何倒计时时不渲染无效的大数字与控制条", async () => {
    const stopwatch = { ...countdown({ id: "timer-9" }), kind: "stopwatch" as const, label: "秒表" };
    await mount([stopwatch]);
    expect(screen.getByText("还没有倒计时")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建倒计时" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重置倒计时" })).toBeNull();
  });

  it("只剩一个计时器时禁用删除，满 8 个时禁用新建", async () => {
    await mount([study]);
    expect(screen.getByRole("button", { name: "删除学习" })).toBeDisabled();
    cleanup();

    const eight = Array.from({ length: 8 }, (_, index) =>
      countdown({ id: `timer-${index + 1}`, label: `倒计时 ${index + 1}` }));
    await mount(eight);
    expect(screen.getByRole("button", { name: "新建倒计时" })).toBeDisabled();
  });
});
