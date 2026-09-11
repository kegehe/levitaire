import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ensurePomodoroWindow } from "../utils/toolWindows";
import { FLOATING_TOOLS } from "../tools/registry";
import ToolPalette from "./ToolPalette";

vi.mock("../utils/toolWindows", () => ({
  ensureScreenshotWindow: vi.fn(async () => ({})),
  ensureSketchWindow: vi.fn(async () => ({})),
  ensureMonitorWindow: vi.fn(async () => ({ window: {}, created: false })),
  ensurePomodoroWindow: vi.fn(async () => ({})),
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
const mockEnsurePomodoroWindow = vi.mocked(ensurePomodoroWindow);

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("ToolPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem("levitaire-tools-enabled", JSON.stringify(["pomodoro"]));
    mockInvoke.mockResolvedValue(true);
  });

  it("keeps the palette available when an enabled tool cannot start", async () => {
    mockEnsurePomodoroWindow.mockRejectedValueOnce(new Error("window is not ready"));
    const { container } = render(<ToolPalette />);
    await act(flush);

    fireEvent.click(container.querySelector('[data-tool-id="pomodoro"]')!);
    await act(flush);

    expect(mockInvoke).not.toHaveBeenCalledWith("hide_palette");
  });

  it("从部分启用状态可一键全部关闭", async () => {
    const { container } = render(<ToolPalette />);
    await act(flush);
    // 挂载后端同步后默认 getter 全部为 true → 10/11 部分启用（utility-hub 无后端配置）
    expect(container.querySelector(".palette-count")!.textContent).toContain("10/11");

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
    expect(mockInvoke).toHaveBeenCalledWith("set_pomodoro_enabled", { enabled: false });
    expect(mockInvoke).toHaveBeenCalledWith("set_timer_enabled", { enabled: false });
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
    expect(mockInvoke).toHaveBeenCalledWith("set_pomodoro_enabled", { enabled: true });
    // utility-hub 无后端命令，仅在本地启用
    expect(
      container.querySelector('[data-tool-id="utility-hub"]')!.classList.contains("is-enabled"),
    ).toBe(true);
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
});
