import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ScrollNavigator from "./ScrollNavigator";

const mockInvoke = vi.mocked(invoke);

const preciseState = { precise: true, percent: 42, fallbackAvailable: true };
const relativeState = { precise: false, percent: null, fallbackAvailable: true };
const orphanState = { precise: false, percent: null, fallbackAvailable: false };

describe("ScrollNavigator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockImplementation((command) => {
      if (command === "get_scroll_navigation_state") return Promise.resolve(preciseState);
      return Promise.resolve(preciseState);
    });
  });

  it("renders the precise position and sends preset commands", async () => {
    render(<ScrollNavigator />);
    expect(await screen.findByText("42%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("set_scroll_navigation_percent", { percent: 50 }),
    );
  });

  it("commits a slider value on pointer release", async () => {
    render(<ScrollNavigator />);
    const slider = await screen.findByRole("slider", { name: "滚动位置" });

    fireEvent.change(slider, { target: { value: "75" } });
    fireEvent.pointerUp(slider);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("set_scroll_navigation_percent", { percent: 75 }),
    );
  });

  it("keeps relative scrolling usable when the target has no precise scrollbar", async () => {
    // 关键回归：实测浏览器 / Electron / 资源管理器都拿不到 UIA 滚动器（precise=false），
    // 旧版在这里把百分比 / 滑杆 / 预设整块 disabled + opacity .45 —— 等于对它们彻底不可用。
    // 现在中间区换成「相对滚动」，只依赖「存在目标窗口」。
    mockInvoke.mockImplementation((command) => {
      if (command === "get_scroll_navigation_state") return Promise.resolve(relativeState);
      if (command === "navigate_scroll") return Promise.resolve(relativeState);
      return Promise.resolve(undefined);
    });
    render(<ScrollNavigator />);

    expect(await screen.findByRole("button", { name: "到达顶部" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "向上翻页" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "向下翻页" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "到达底部" })).toBeEnabled();

    // 精确区让位给滚轮微调，而且真的可以点（不是灰掉的死块）
    expect(screen.queryByRole("slider", { name: "滚动位置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "滚动百分比" })).not.toBeInTheDocument();

    const stepDown = screen.getByRole("button", { name: /下滚 3 格/ });
    expect(stepDown).toBeEnabled();
    fireEvent.click(stepDown);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("navigate_scroll", { action: "line-down" }),
    );
  });

  it("resyncs the real state after a failed precise set", async () => {
    // 回归：失败后的回读不能走 refresh() —— 那时 busy 还没解除，会被 busy 守卫挡掉，
    // 于是 UI 停在过期数值上。
    let stateCalls = 0;
    mockInvoke.mockImplementation((command) => {
      if (command === "get_scroll_navigation_state") {
        stateCalls += 1;
        return Promise.resolve(
          stateCalls === 1 ? preciseState : { precise: true, percent: 7, fallbackAvailable: true },
        );
      }
      if (command === "set_scroll_navigation_percent") {
        return Promise.reject("目标窗口未提供可精确控制的垂直滚动条");
      }
      return Promise.resolve(undefined);
    });
    render(<ScrollNavigator />);
    expect(await screen.findByText("42%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "75%" }));

    expect(await screen.findByText("目标窗口未提供可精确控制的垂直滚动条")).toBeInTheDocument();
    // 回读到真值（7%）而不是停在点击时的 75%
    expect(await screen.findByText("7%")).toBeInTheDocument();
    expect(stateCalls).toBeGreaterThanOrEqual(2);
  });

  it("offers a one-click retarget instead of a dead panel when no target is bound", async () => {
    // 目标窗口被关掉后旧实现是「整块永久禁用」，只能靠关掉面板重开。
    mockInvoke.mockImplementation((command) => {
      if (command === "get_scroll_navigation_state") return Promise.resolve(orphanState);
      if (command === "recapture_scroll_target") return Promise.resolve(relativeState);
      return Promise.resolve(undefined);
    });
    render(<ScrollNavigator />);

    expect(await screen.findByRole("button", { name: "到达顶部" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /下滚 3 格/ })).toBeDisabled();
    expect(screen.getByText("尚未绑定目标窗口")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新选择目标" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("recapture_scroll_target"));
    expect(await screen.findByRole("button", { name: "到达顶部" })).toBeEnabled();
  });
});
