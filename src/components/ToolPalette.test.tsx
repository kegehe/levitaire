import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ensurePomodoroWindow } from "../utils/toolWindows";
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
});
