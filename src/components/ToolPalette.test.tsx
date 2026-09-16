import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { ensureTimerWindow } from "../utils/toolWindows";
import { FLOATING_TOOLS } from "../tools/registry";
import { emitMockEvent, emitMockFocus, mockIsVisible, mockSetSize } from "../test/tauri-mock";
import ToolPalette from "./ToolPalette";

vi.mock("../utils/toolWindows", () => ({
  ensureScreenshotWindow: vi.fn(async () => ({})),
  ensureSketchWindow: vi.fn(async () => ({})),
  ensureMonitorWindow: vi.fn(async () => ({ window: {}, created: false })),
  ensureTimerWindow: vi.fn(async () => ({})),
  ensureTodoWindow: vi.fn(async () => ({})),
  ensureUtilityHubWindow: vi.fn(async () => ({})),
  waitForNewMonitorWindowReady: vi.fn(async () => undefined),
}));

vi.mock("../styles/themePreferences", () => ({
  applyThemePreferences: vi.fn(),
  getStoredThemePreferences: vi.fn(() => ({})),
  subscribeThemePreferences: vi.fn(async () => () => {}),
}));

const mockInvoke = vi.mocked(invoke);
const mockEnsureTimerWindow = vi.mocked(ensureTimerWindow);

async function flush() {
  // 「全部开启 / 全部关闭」是串行下发（逐项 await invoke），需要足够多的微任务轮次
  // 才能把整个批次跑完；轮次不够会让计数断言读到中间态。
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

describe("ToolPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem("levitaire-tools-enabled", JSON.stringify(["timer"]));
    mockInvoke.mockResolvedValue(true);
  });

  it("keeps the palette available when an enabled tool cannot start", async () => {
    mockEnsureTimerWindow.mockRejectedValueOnce(new Error("window is not ready"));
    const { container } = render(<ToolPalette />);
    await act(flush);

    fireEvent.click(container.querySelector('[data-tool-id="timer"]')!);
    await act(flush);

    expect(mockInvoke).not.toHaveBeenCalledWith("hide_palette");
  });

  it("从部分启用状态可一键全部关闭", async () => {
    const { container } = render(<ToolPalette />);
    await act(flush);
    // 挂载后端同步后所有 getter 都为 true → 10/10 全启用
    expect(container.querySelector(".palette-count")!.textContent).toContain("10/10");

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".palette-all-group button"),
    );
    const enableAllBtn = buttons.find((b) => b.textContent === "全部开启")!;
    const disableAllBtn = buttons.find((b) => b.textContent === "全部关闭")!;

    // 部分启用时必须能直接一键全部关闭（原单按钮在部分启用态只能“全部开启”）
    fireEvent.click(disableAllBtn);
    await act(flush);

    expect(container.querySelector(".palette-count")!.textContent).toContain("0/10");
    expect(disableAllBtn).toBeDisabled();
    expect(enableAllBtn).not.toBeDisabled();
    expect(mockInvoke).toHaveBeenCalledWith("set_timer_enabled", { enabled: false });
    expect(mockInvoke).toHaveBeenCalledWith("set_screenshot_enabled", { enabled: false });
    // 通用工具必须也被下发：它曾是唯一没有后端开关的工具，于是「全部关闭」只改了
    // 前端勾选，已经打开的通用工具浮窗留在桌面上。
    expect(mockInvoke).toHaveBeenCalledWith("set_utility_hub_enabled", { enabled: false });
  });

  it("从全关状态可一键全部开启", async () => {
    const { container } = render(<ToolPalette />);
    await act(flush);

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".palette-all-group button"),
    );
    const enableAllBtn = buttons.find((b) => b.textContent === "全部开启")!;
    const disableAllBtn = buttons.find((b) => b.textContent === "全部关闭")!;

    fireEvent.click(disableAllBtn);
    await act(flush);
    expect(container.querySelector(".palette-count")!.textContent).toContain("0/10");

    fireEvent.click(enableAllBtn);
    await act(flush);

    expect(container.querySelector(".palette-count")!.textContent).toContain("10/10");
    expect(mockInvoke).toHaveBeenCalledWith("set_timer_enabled", { enabled: true });
    expect(mockInvoke).toHaveBeenCalledWith("set_utility_hub_enabled", { enabled: true });
    expect(
      container.querySelector('[data-tool-id="utility-hub"]')!.classList.contains("is-enabled"),
    ).toBe(true);
  });

  it("通用工具的卡片开关与卡片点击都会下发后端命令", async () => {
    const { container } = render(<ToolPalette />);
    await act(flush);
    const card = container.querySelector<HTMLElement>('[data-tool-id="utility-hub"]')!;

    // 点开关关闭：必须下发后端命令（原来这里什么都不发，浮窗因此关不掉）
    fireEvent.click(card.querySelector(".palette-toggle")!);
    await act(flush);
    expect(mockInvoke).toHaveBeenCalledWith("set_utility_hub_enabled", { enabled: false });

    // 再点卡片：走与其它工具相同的「启用 + 激活」路径，而不是只改前端勾选
    mockInvoke.mockClear();
    fireEvent.click(card);
    await act(flush);

    expect(mockInvoke).toHaveBeenCalledWith("set_utility_hub_enabled", { enabled: true });
    expect(mockInvoke).toHaveBeenCalledWith("start_utility_hub");
    expect(card.classList.contains("is-enabled")).toBe(true);
  });

  it("「全部关闭」逐项串行下发：上一项未完成前不发下一项", async () => {
    // 并发下发会让后端窗口清理互相打架：set_screenshot_enabled(false) 的会话清理会按
    // `*_VISIBLE_BEFORE_SESSION` 标记把刚被 hide 的时钟/待办重新 show 回来。
    // 这条用例锁住「串行」这个机制本身（改回 forEach + void 会立刻变红）。
    const pending: Array<(value: boolean) => void> = [];
    mockInvoke.mockImplementation(((cmd: string) =>
      typeof cmd === "string" && cmd.startsWith("set_")
        ? new Promise<boolean>((resolve) => pending.push(resolve))
        : Promise.resolve(true)) as never);
    const setCallCount = () =>
      mockInvoke.mock.calls.filter(([cmd]) => String(cmd).startsWith("set_")).length;

    const { container } = render(<ToolPalette />);
    await act(flush);

    const disableAllBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".palette-all-group button"),
    ).find((b) => b.textContent === "全部关闭")!;
    fireEvent.click(disableAllBtn);
    await act(flush);

    // 第一项还挂在 pending 上，第二次 set_* 就不该发出去
    expect(setCallCount()).toBe(1);

    // 逐项放行，直到全部下发完
    for (let i = 0; i < 20 && setCallCount() < 10; i += 1) {
      while (pending.length) pending.shift()!(true);
      await act(flush);
    }
    expect(setCallCount()).toBe(10);
  });

  it("按类别分组渲染，且不丢任何工具", async () => {
    const { container } = render(<ToolPalette />);
    await act(flush);

    const headings = Array.from(container.querySelectorAll(".palette-group-heading")).map(
      (node) => node.textContent,
    );
    expect(headings).toEqual(["文字工具", "屏幕工具", "系统工具"]);

    // 分组渲染后卡片总数必须仍等于注册表项数，避免工具被漏渲染
    expect(container.querySelectorAll("[data-tool-id]")).toHaveLength(FLOATING_TOOLS.length);

    // 分组归属正确：第一组是文字工具，不该混入屏幕工具
    const textSection = container.querySelector(".palette-section")!;
    expect(textSection.querySelector('[data-tool-id="text-toolbar"]')).not.toBeNull();
    expect(textSection.querySelector('[data-tool-id="screenshot"]')).toBeNull();
  });

  it("把 registry 中的 description 渲染为卡片提示", async () => {
    const { container } = render(<ToolPalette />);
    await act(flush);

    for (const tool of FLOATING_TOOLS) {
      const card = container.querySelector(`[data-tool-id="${tool.id}"]`);
      expect(card?.getAttribute("title")).toBe(`${tool.name}：${tool.description}`);
    }
  });

  it("标题用悬浮球当前角色图标，并跟随 levitaire-orb-icon-changed 切换", async () => {
    const { container } = render(<ToolPalette />);
    await act(flush);

    // 默认角色是水母；角色 markup 里的动画类名是判别身份的稳定锚点
    expect(container.querySelector(".palette-title .an-jelly")).not.toBeNull();
    expect(container.querySelector(".palette-title")!.textContent).toBe("Levitaire");
    // 字标换成品牌后，面板的中文名仍要可达（视觉上不可见）
    expect(container.querySelector(".palette-sr-only")!.textContent).toBe("悬浮工具");

    act(() => emitMockEvent("levitaire-orb-icon-changed", { id: "rocket" }));
    await act(flush);

    expect(container.querySelector(".palette-title .an-rocket")).not.toBeNull();
    expect(container.querySelector(".palette-title .an-jelly")).toBeNull();
  });

  it("关闭按钮与 Esc 都走完整的隐藏流程：重置 is-visible 并广播可见性", async () => {
    const { container } = render(<ToolPalette />);
    await act(flush);
    const panel = container.querySelector(".palette-container")!;
    expect(panel.className).toContain("is-visible");

    fireEvent.click(container.querySelector(".palette-close")!);
    await act(flush);

    expect(mockInvoke).toHaveBeenCalledWith("hide_palette");
    // 只调 invoke("hide_palette") 会漏掉这两件事：状态不重置 → 下次打开不播入场动画，
    // 悬浮球也会停在「已展开」态
    expect(panel.className).not.toContain("is-visible");
    expect(vi.mocked(emit)).toHaveBeenCalledWith("levitaire-palette-visibility", false);

    // 重新获焦 → 面板再次可见，再按 Esc 必须同样走完整流程
    act(() => emitMockFocus(true));
    await act(flush);
    expect(panel.className).toContain("is-visible");

    vi.mocked(emit).mockClear();
    fireEvent.keyDown(window, { key: "Escape" });
    await act(flush);

    expect(panel.className).not.toContain("is-visible");
    expect(vi.mocked(emit)).toHaveBeenCalledWith("levitaire-palette-visibility", false);
  });

  it("收到「点悬浮球开合」广播：按**原生可见性**裁决，开着的走完整隐藏流程", async () => {
    const { container } = render(<ToolPalette />);
    await act(flush);
    const panel = container.querySelector(".palette-container")!;
    expect(panel.className).toContain("is-visible");

    mockIsVisible.mockResolvedValueOnce(true);
    vi.mocked(emit).mockClear();
    act(() => emitMockEvent("palette-toggle-requested", null));
    await act(flush);

    // 悬浮球是 focusable(false) 窗，点它不会让本窗口失焦，因此「失焦自动隐藏」不适用：
    // 这条广播是面板唯一能被球收起的路径，必须和 Esc / 关闭按钮走同一套状态复位。
    expect(mockInvoke).toHaveBeenCalledWith("hide_palette");
    expect(panel.className).not.toContain("is-visible");
    expect(vi.mocked(emit)).toHaveBeenCalledWith("levitaire-palette-visibility", false);
  });

  it("原生已收起（截图/长截图流程直接 hide 过）时，同样一下点击应当**打开**面板", async () => {
    // 这条盯的是"状态过期"：那些原生流程不经前端就 hide 了面板，前端那份「已展开」
    // 会残留成 true；若按它判断，这一下点击会被当成「收起」，用户点一次没反应。
    // 所以裁决必须看原生 is_visible 真值。
    const { container } = render(<ToolPalette />);
    await act(flush);
    mockInvoke.mockClear();
    vi.mocked(emit).mockClear();
    mockIsVisible.mockResolvedValueOnce(false);

    act(() => emitMockEvent("palette-toggle-requested", null));
    await act(flush);

    expect(mockInvoke).toHaveBeenCalledWith("show_palette");
    expect(mockInvoke).not.toHaveBeenCalledWith("hide_palette");
    // 也不能把面板前端状态置成"已收起"（那会让下次打开不播入场动画、悬浮球停在收起态）
    expect(vi.mocked(emit)).not.toHaveBeenCalledWith("levitaire-palette-visibility", false);
    expect(container.querySelector(".palette-container")!.className).toContain("is-visible");
  });

  it("激活工具后收起面板同样重置 is-visible", async () => {
    const { container } = render(<ToolPalette />);
    await act(flush);

    fireEvent.click(container.querySelector('[data-tool-id="timer"]')!);
    await act(flush);

    expect(mockInvoke).toHaveBeenCalledWith("hide_palette");
    expect(container.querySelector(".palette-container")!.className).not.toContain("is-visible");
  });

  it("激活 selection 类工具（文字工具栏）走的是同一条隐藏流程", async () => {
    // 这条分支曾经绕开 hidePalette（只调 invoke），单独锁一下
    const tool = FLOATING_TOOLS.find((item) => item.id === "text-toolbar")!;
    const loaderSpy = vi.spyOn(tool, "loader").mockResolvedValue({ default: () => null });
    try {
      const { container } = render(<ToolPalette />);
      await act(flush);

      fireEvent.click(container.querySelector('[data-tool-id="text-toolbar"]')!);
      await act(flush);

      expect(mockInvoke).toHaveBeenCalledWith("hide_palette");
      expect(container.querySelector(".palette-container")!.className).not.toContain("is-visible");
      expect(vi.mocked(emit)).toHaveBeenCalledWith("levitaire-palette-visibility", false);
    } finally {
      loaderSpy.mockRestore();
    }
  });

  it("窗口尺寸取「面板 + 投影留白」的外框，而不是面板自身的宽度", async () => {
    // happy-dom 不做布局，offsetWidth/offsetHeight 恒为 0（组件会跳过 setSize），
    // 因此打桩成真实外框值：面板 436×486 + 四周 20px 留白（10 个工具 → 分组 3 行）。
    // 这条用例锁的是「窗口宽度必须含左右留白」——写死面板宽度会让面板右侧的
    // 投影没有展开空间，重新被窗口边界裁出直角残影。
    const widthSpy = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(476);
    const heightSpy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(526);
    try {
      const { container } = render(<ToolPalette />);
      await act(flush);

      expect(container.querySelector(".palette-stage")).not.toBeNull();
      const calls = mockSetSize.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const size = calls[calls.length - 1][0] as unknown as { width: number; height: number };
      expect([size.width, size.height]).toEqual([476, 526]);
    } finally {
      widthSpy.mockRestore();
      heightSpy.mockRestore();
    }
  });

  it("点击面板外的投影留白等同于点击面板外部（隐藏）；点击面板内部不隐藏", async () => {
    const { container } = render(<ToolPalette />);
    await act(flush);

    const stage = container.querySelector<HTMLElement>(".palette-stage")!;
    // 面板内元素的 mousedown 会冒泡到 stage，但 target ≠ currentTarget，不得触发隐藏
    fireEvent.mouseDown(container.querySelector('[data-tool-id="todo"]')!, { button: 0 });
    await act(flush);
    expect(mockInvoke).not.toHaveBeenCalledWith("hide_palette");

    // 留白区命中 stage 自身 → 与失焦隐藏同语义（窗口不会因点留白而失焦，必须自己处理）
    fireEvent.mouseDown(stage, { button: 0 });
    await act(flush);
    expect(mockInvoke).toHaveBeenCalledWith("hide_palette");
    expect(container.querySelector(".palette-container")!.className).not.toContain("is-visible");
  });
});
