import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WindowPinPanel from "./WindowPinPanel";
import { clearMockListeners, emitMockEvent } from "../../test/tauri-mock";

const mockInvoke = vi.mocked(invoke);

interface PinnedWindow {
  hwnd: number;
  title: string;
}

/** 后端一次推送的完整载荷（清单 + 提示 + 提示级别 + 点选模式状态）。 */
function pinUpdate(
  windows: PinnedWindow[],
  message: string | null = null,
  picking = false,
  error = false,
) {
  return { windows, message, picking, error };
}

function respondWith(windows: unknown) {
  mockInvoke.mockImplementation((command) => {
    if (command === "get_pinned_windows") return Promise.resolve(windows);
    return Promise.resolve(undefined);
  });
}

describe("WindowPinPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    respondWith([]);
  });

  it("reads the pinned list on mount instead of assuming an empty state", async () => {
    respondWith([{ hwnd: 100, title: "记事本" }]);
    render(<WindowPinPanel />);

    expect(await screen.findByText("记事本")).toBeInTheDocument();
    expect(screen.queryByText("尚未置顶任何窗口")).toBeNull();
  });

  it("shows the empty hint when nothing is pinned", async () => {
    render(<WindowPinPanel />);
    expect(await screen.findByText("尚未置顶任何窗口")).toBeInTheDocument();
  });

  it("enters native pick mode from the panel button", async () => {
    render(<WindowPinPanel />);
    fireEvent.click(screen.getByRole("button", { name: /点选目标窗口/ }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("start_window_pin_pick"));
    expect(screen.getByRole("button", { name: /退出点选/ })).toBeInTheDocument();
  });

  it("mirrors the picking state the backend pushes", async () => {
    render(<WindowPinPanel />);
    // 点选成功后后端会自行退出该模式，并推一条 picking=false 的状态过来：
    // 前端必须以推送为准，否则按钮会一直停在「退出点选」。
    emitMockEvent(
      "window-pin-updated",
      pinUpdate([{ hwnd: 100, title: "记事本" }], "已置顶：记事本"),
    );

    expect(await screen.findByRole("button", { name: /点选目标窗口/ })).toBeInTheDocument();
    expect(screen.getByText("记事本")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已置顶：记事本");
  });

  it("keeps the picking button active while the native mode is armed", async () => {
    render(<WindowPinPanel />);
    emitMockEvent("window-pin-updated", pinUpdate([], null, true));
    expect(await screen.findByRole("button", { name: /退出点选/ })).toBeInTheDocument();
  });

  it("unpins a single window from the list", async () => {
    respondWith([{ hwnd: 100, title: "记事本" }]);
    render(<WindowPinPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "取消置顶 记事本" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("unpin_window", { hwnd: 100 }));
  });

  it("offers a bulk clear only when more than one window is pinned", async () => {
    respondWith([
      { hwnd: 1, title: "A" },
      { hwnd: 2, title: "B" },
    ]);
    render(<WindowPinPanel />);

    // 只有一条时逐条取消已够用，多一个「全部取消」只是噪声。
    const clear = await screen.findByRole("button", { name: /全部取消/ });
    expect(clear).toHaveTextContent("全部取消（2）");

    fireEvent.click(clear);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("unpin_all_windows"));
  });

  it("hides the bulk clear when a single window is pinned", async () => {
    respondWith([{ hwnd: 100, title: "记事本" }]);
    render(<WindowPinPanel />);

    await screen.findByText("记事本");
    expect(screen.queryByRole("button", { name: /全部取消/ })).toBeNull();
  });

  it("does not stay stuck in picking when the native start fails", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_pinned_windows") return Promise.resolve([]);
      if (command === "start_window_pin_pick") return Promise.reject("无法创建准星光标");
      return Promise.resolve(undefined);
    });
    render(<WindowPinPanel />);

    fireEvent.click(screen.getByRole("button", { name: /点选目标窗口/ }));

    expect(await screen.findByText("无法创建准星光标")).toBeInTheDocument();
    // 回到「点选」态：停在「退出点选」会让用户以为模式开着，从而一直等一个不会出现的准星。
    expect(screen.getByRole("button", { name: /点选目标窗口/ })).toBeInTheDocument();
  });

  it("survives a malformed list from the backend instead of blanking the panel", async () => {
    // 命令契约被破坏（返回 undefined）时，面板必须照常渲染 —— 它常驻在悬浮窗里，
    // 一次 `list.length` 抛错就等于整个通用工具白屏。
    respondWith(undefined as unknown as PinnedWindow[]);
    render(<WindowPinPanel />);

    expect(await screen.findByText("尚未置顶任何窗口")).toBeInTheDocument();
  });

  it("ignores malformed entries inside an otherwise valid list", async () => {
    respondWith([{ hwnd: 100, title: "记事本" }, { hwnd: "bad" }, null]);
    render(<WindowPinPanel />);

    expect(await screen.findByText("记事本")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("lets a later success notice replace a stale failure", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_pinned_windows") return Promise.resolve([]);
      if (command === "start_window_pin_pick") return Promise.reject("无法创建准星光标");
      return Promise.resolve(undefined);
    });
    render(<WindowPinPanel />);
    fireEvent.click(screen.getByRole("button", { name: /点选目标窗口/ }));
    expect(await screen.findByText("无法创建准星光标")).toBeInTheDocument();

    // 失败提示不会常驻：下一次成功的推送必须能把它顶掉，否则面板会一直挂着
    // 一句早就过期的报错，用户读成本次操作也说它失败。
    emitMockEvent("window-pin-updated", pinUpdate([], "已置顶：记事本"));
    expect(await screen.findByText("已置顶：记事本")).toBeInTheDocument();
    expect(screen.queryByText("无法创建准星光标")).toBeNull();
  });

  it("dismisses a finished notice on its own", async () => {
    render(<WindowPinPanel />);
    emitMockEvent("window-pin-updated", pinUpdate([], "已置顶：记事本"));
    expect(await screen.findByText("已置顶：记事本")).toBeInTheDocument();

    // 面板在隐藏/显示之间不卸载，提示必须自己到期，不能攒在面板上。
    await waitFor(() => expect(screen.queryByText("已置顶：记事本")).toBeNull(), {
      timeout: 5000,
    });
  });

  it("marks a failure push differently from a success one", async () => {
    render(<WindowPinPanel />);

    // 「无法置顶：X（权限不足）」和「已置顶：X」用的是同一条推送通道，
    // 不带级别标记的话在面板上长得一模一样，用户会把失败读成做成了。
    emitMockEvent(
      "window-pin-updated",
      pinUpdate([], "无法置顶：任务管理器（权限不足）", false, true),
    );
    expect(await screen.findByRole("status")).toHaveClass("is-error");

    emitMockEvent("window-pin-updated", pinUpdate([], "已置顶：记事本"));
    await waitFor(() => expect(screen.getByRole("status")).not.toHaveClass("is-error"));
  });
});
