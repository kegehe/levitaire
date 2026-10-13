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
  ensureSystemCleanerWindow: vi.fn(async () => ({})),
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

/** 感知色差（CIEDE2000），用来判「两张卡片是不是看着一个色」。
 *
 * ΔE 的量级：0 = 完全同色，1 上下是刚能辨出的差别，10 以上才算两个明确不同的颜色
 * （通行解读）。面板的下限取 10，理由见 ToolPalette.tsx 的 TOOL_COLORS 注释。
 * 公式与换算是标准实现，正确性由下面「色差实现与参考值一致」那条用例钉住——
 * 否则公式被改坏时（比如恒返回大值）色差守卫会静默失效。 */
function hexToLab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  // sRGB → XYZ 用 IEC 61966-2-1 的精确矩阵（四位小数版本会把标准 Lab 值带偏 0.02）
  const [fx, fy, fz] = [
    (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047,
    0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883,
  ].map(f);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE2000([L1, a1, b1]: number[], [L2, a2, b2]: number[]): number {
  const [C1, C2] = [Math.hypot(a1, b1), Math.hypot(a2, b2)];
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const [A1, A2] = [(1 + G) * a1, (1 + G) * a2];
  const [c1, c2] = [Math.hypot(A1, b1), Math.hypot(A2, b2)];
  // 色相角（度，0–360）；无彩度（a=b=0）时按 0 处理
  const angle = (x: number, y: number) =>
    x === 0 && y === 0 ? 0 : ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  const [H1, H2] = [angle(A1, b1), angle(A2, b2)];
  const dL = L2 - L1;
  const dC = c2 - c1;
  let dH = 0;
  if (c1 * c2 !== 0) {
    // 色相差取最短方向（±180° 内）
    let dh = H2 - H1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
    dH = 2 * Math.sqrt(c1 * c2) * Math.sin((dh * Math.PI) / 360);
  }
  const [Lb, Cp] = [(L1 + L2) / 2, (c1 + c2) / 2];
  // 色相角均值要把跨 0/360 的两角绕到同一侧再平均
  const Hp =
    c1 * c2 === 0
      ? H1 + H2
      : (H1 + H2) / 2 + (Math.abs(H1 - H2) > 180 ? (H1 + H2 < 360 ? 180 : -180) : 0);
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const T =
    1 -
    0.17 * Math.cos(rad(Hp - 30)) +
    0.24 * Math.cos(rad(2 * Hp)) +
    0.32 * Math.cos(rad(3 * Hp + 6)) -
    0.2 * Math.cos(rad(4 * Hp - 63));
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const Sc = 1 + 0.045 * Cp;
  const Sh = 1 + 0.015 * Cp * T;
  const Rc = 2 * Math.sqrt(Cp ** 7 / (Cp ** 7 + 25 ** 7));
  // 蓝紫区（Hp≈275°）的旋转项
  const dTheta = 30 * Math.exp(-(((Hp - 275) / 25) ** 2));
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
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
    // 挂载后端同步后所有 getter 都为 true → 11/11 全启用
    expect(container.querySelector(".palette-count")!.textContent).toContain("11/11");

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".palette-all-group button"),
    );
    const enableAllBtn = buttons.find((b) => b.textContent === "全部开启")!;
    const disableAllBtn = buttons.find((b) => b.textContent === "全部关闭")!;

    // 部分启用时必须能直接一键全部关闭（原单按钮在部分启用态只能“全部开启”）
    fireEvent.click(disableAllBtn);
    await act(flush);

    expect(container.querySelector(".palette-count")!.textContent).toContain("0/11");
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
    expect(container.querySelector(".palette-count")!.textContent).toContain("0/11");

    fireEvent.click(enableAllBtn);
    await act(flush);

    expect(container.querySelector(".palette-count")!.textContent).toContain("11/11");
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
    for (let i = 0; i < 22 && setCallCount() < 11; i += 1) {
      while (pending.length) pending.shift()!(true);
      await act(flush);
    }
    expect(setCallCount()).toBe(11);
  });

  it("「全部关闭」部分失败时汇总提示失败项，失败项回滚为启用且不影响其余项", async () => {
    // 逐项下发时某一条失败原来只回滚那一条并在控制台记一行日志，界面既不提示也不
    // 指出是哪一项 —— 用户看到的是"点了全部关闭还有几个开着"。这里锁住「汇总提示」。
    mockInvoke.mockImplementation(((cmd: string, args?: { enabled?: boolean }) => {
      if (cmd === "set_screenshot_enabled" && args?.enabled === false) {
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve(true);
    }) as never);

    const { container } = render(<ToolPalette />);
    await act(flush);
    expect(container.querySelector(".palette-count")!.textContent).toContain("11/11");

    const disableAllBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".palette-all-group button"),
    ).find((b) => b.textContent === "全部关闭")!;
    fireEvent.click(disableAllBtn);
    await act(flush);

    const banner = container.querySelector<HTMLButtonElement>(".palette-error")!;
    expect(banner.textContent).toBe("全部关闭有 1 项未生效：屏幕截图");
    // 失败项回滚为启用，其余项照常关闭（整批不因一项失败而中断）
    expect(
      container.querySelector('[data-tool-id="screenshot"]')!.classList.contains("is-enabled"),
    ).toBe(true);
    expect(
      container.querySelector('[data-tool-id="timer"]')!.classList.contains("is-enabled"),
    ).toBe(false);
    expect(container.querySelector(".palette-count")!.textContent).toContain("1/11");

    // 提示可点击消除；重试成功后不再出现
    fireEvent.click(banner);
    await act(flush);
    expect(container.querySelector(".palette-error")).toBeNull();

    mockInvoke.mockResolvedValue(true);
    fireEvent.click(disableAllBtn);
    await act(flush);
    expect(container.querySelector(".palette-error")).toBeNull();
    expect(container.querySelector(".palette-count")!.textContent).toContain("0/11");
  });

  it("「全部开启 / 全部关闭」全部成功时不显示任何提示", async () => {
    const { container } = render(<ToolPalette />);
    await act(flush);

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".palette-all-group button"),
    );
    fireEvent.click(buttons.find((b) => b.textContent === "全部关闭")!);
    await act(flush);

    expect(container.querySelector(".palette-error")).toBeNull();
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

  it("色差实现与参考值一致（下面那条色差守卫的前提）", () => {
    // Sharma 等《The CIEDE2000 Color-Difference Formula》附录的参考数据，含色相跨 0°/360°
    // 与近中性色这些最容易写错的算例。公式本身若被改坏（比如恒返回大值），色差守卫会静默
    // 通过，所以这里单独把公式钉在参考数据上。
    const refs: Array<[number[], number[], number]> = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
      [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
      [[50, -1.1848, -84.8006], [50, 0, -82.7485], 1.0],
      [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
      [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
    ];
    for (const [labA, labB, expected] of refs) {
      expect(deltaE2000(labA, labB)).toBeCloseTo(expected, 3);
    }

    // hex → Lab 的换算按 sRGB/D65 下的公认 Lab 值核对
    const red = hexToLab("#ff0000");
    expect(red[0]).toBeCloseTo(53.2408, 3);
    expect(red[1]).toBeCloseTo(80.0925, 3);
    expect(red[2]).toBeCloseTo(67.2032, 3);
    const gray = hexToLab("#808080");
    expect(gray[0]).toBeCloseTo(53.585, 3);
    expect(gray[1]).toBeCloseTo(0, 3);
    expect(gray[2]).toBeCloseTo(0, 3);
  });

  it("每张卡片的强调色都各自登记、且两两色差大到能一眼分辨", async () => {
    const { container } = render(<ToolPalette />);
    await act(flush);

    const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-tool-id]"));
    const colors = cards.map((card) => card.style.getPropertyValue("--tool-color").trim());
    expect(colors).toHaveLength(FLOATING_TOOLS.length);

    // 每个工具都要登记一个十六进制色值：漏登记的工具会拿到兜底的 var(--color-accent)
    // （见 ToolPalette.tsx），既不是它自己的身份，也会让下面的色差算成 NaN 而被放过。
    expect(colors.filter((color) => !/^#[0-9a-f]{6}$/i.test(color))).toEqual([]);

    // 「十六进制不同」不等于「看着不同」：utility-hub(#2f9e78) 与 todo(#1d9e75) 就是两个
    // 不同的色值，色差却只有 ΔE 1.2，面板上仍是同一个色。所以按感知色差判，下限取 10。
    const MIN_DELTA_E = 10;
    const tooClose: string[] = [];
    for (let i = 0; i < colors.length; i += 1)
      for (let j = i + 1; j < colors.length; j += 1) {
        const delta = deltaE2000(hexToLab(colors[i]), hexToLab(colors[j]));
        if (delta < MIN_DELTA_E) {
          tooClose.push(
            `${cards[i].dataset.toolId} × ${cards[j].dataset.toolId}：ΔE ${delta.toFixed(1)}`,
          );
        }
      }
    expect(tooClose).toEqual([]);
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
