import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMockListeners, setMockWindow } from "../../test/tauri-mock";
import StickyNoteManager from "./StickyNoteManager";

const mockInvoke = vi.mocked(invoke);

const NOTES = [
  {
    id: "note-1",
    content: "买牛奶\n和面包",
    colorId: "yellow",
    visible: true,
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T01:00:00Z",
  },
  {
    id: "note-2",
    content: "",
    colorId: "pink",
    visible: false,
    createdAt: "2026-09-07T02:00:00Z",
    updatedAt: "2026-09-07T02:00:00Z",
  },
];

function mockDefault() {
  mockInvoke.mockImplementation((command: string) => {
    if (command === "get_sticky_notes") return Promise.resolve(NOTES);
    if (command === "restore_pinned_notes") return Promise.resolve(1);
    return Promise.resolve();
  });
}

describe("StickyNoteManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    setMockWindow({ label: "sticky-notes-manager" });
  });

  it("挂载时恢复已钉便签并渲染列表（含已收起占位）", async () => {
    mockDefault();
    render(<StickyNoteManager />);

    expect(await screen.findByText("买牛奶")).toBeTruthy();
    expect(screen.getByText("空白便签")).toBeTruthy();
    // 摘要：桌面 1 张 · 已收起 1 张
    expect(screen.getByText(/桌面 1 张/)).toBeTruthy();
    expect(screen.getByText(/已收起 1 张/)).toBeTruthy();
    // 恢复已钉便签被调用
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("restore_pinned_notes");
    });
  });

  it("无便签时展示空状态并可新建", async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_sticky_notes") return Promise.resolve([]);
      if (command === "restore_pinned_notes") return Promise.resolve(0);
      return Promise.resolve();
    });
    render(<StickyNoteManager />);

    expect(await screen.findByText("还没有便利贴")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "新建第一张" }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("create_sticky_note", { colorId: "yellow" });
    });
  });

  it("底部新建按钮创建新便签", async () => {
    mockDefault();
    render(<StickyNoteManager />);
    await screen.findByText("买牛奶");

    fireEvent.click(screen.getByRole("button", { name: /新建便利贴/ }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("create_sticky_note", { colorId: "yellow" });
    });
  });

  it("点击行唤出已收起的便签", async () => {
    mockDefault();
    render(<StickyNoteManager />);
    await screen.findByText("买牛奶");

    fireEvent.click(screen.getByRole("button", { name: "唤出该便签" }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("show_sticky_note", { id: "note-2" });
    });
  });

  it("收起已钉在桌面的便签", async () => {
    mockDefault();
    render(<StickyNoteManager />);
    await screen.findByText("买牛奶");

    fireEvent.click(screen.getByRole("button", { name: "收起该便签" }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("collect_sticky_note", { id: "note-1" });
    });
  });

  it("删除需二次确认：首击仅进入待确认态，二次点击才彻底删除", async () => {
    mockDefault();
    render(<StickyNoteManager />);
    await screen.findByText("买牛奶");

    // 删除"已收起"的那张（note-2，空白便签所在行）
    const hiddenRow = screen.getByText("空白便签").closest("li");
    expect(hiddenRow).not.toBeNull();

    // 第一次点击：进入待确认态，不触发删除
    fireEvent.click(within(hiddenRow as HTMLElement).getByRole("button", { name: "删除该便签" }));
    expect(mockInvoke).not.toHaveBeenCalledWith("delete_sticky_note", expect.anything());
    expect(within(hiddenRow as HTMLElement).getByText("再点一次确认删除")).toBeTruthy();

    // 超时前再次点击同一行：真正删除
    fireEvent.click(
      within(hiddenRow as HTMLElement).getByRole("button", { name: "确认删除该便签" }),
    );
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("delete_sticky_note", { id: "note-2" });
    });
  });

  it("待确认时点击其他行的删除会切换目标，不会立即删除", async () => {
    mockDefault();
    render(<StickyNoteManager />);
    await screen.findByText("买牛奶");

    const row1 = screen.getByText("买牛奶").closest("li");
    const row2 = screen.getByText("空白便签").closest("li");
    expect(row1).not.toBeNull();
    expect(row2).not.toBeNull();

    // 先对 note-1 进入待确认态
    fireEvent.click(within(row1 as HTMLElement).getByRole("button", { name: "删除该便签" }));
    expect(within(row1 as HTMLElement).getByText("再点一次确认删除")).toBeTruthy();

    // 改对 note-2 进入待确认态：note-1 的提示消失，且尚未删除任何便签
    fireEvent.click(within(row2 as HTMLElement).getByRole("button", { name: "删除该便签" }));
    expect(within(row2 as HTMLElement).getByText("再点一次确认删除")).toBeTruthy();
    expect(mockInvoke).not.toHaveBeenCalledWith("delete_sticky_note", expect.anything());

    // 对 note-2 二次确认才真正删除
    fireEvent.click(within(row2 as HTMLElement).getByRole("button", { name: "确认删除该便签" }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("delete_sticky_note", { id: "note-2" });
    });
  });

  it("确认态 3 秒超时后自动复位，不会误删", async () => {
    mockDefault();
    const { unmount } = render(<StickyNoteManager />);
    await screen.findByText("买牛奶");

    const hiddenRow = screen.getByText("空白便签").closest("li");
    expect(hiddenRow).not.toBeNull();
    const row = hiddenRow as HTMLElement;
    const firstClickDelete = () => within(row).getByRole("button", { name: "删除该便签" });

    vi.useFakeTimers();
    try {
      // 首击进入待确认态
      fireEvent.click(firstClickDelete());
      expect(within(row).getByText("再点一次确认删除")).toBeTruthy();

      // 推进 3 秒：自动退出确认态，且未触发删除
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(within(row).queryByText("再点一次确认删除")).toBeNull();
      expect(mockInvoke).not.toHaveBeenCalledWith("delete_sticky_note", expect.anything());

      // 复位后再点击：仅重新进入确认态，仍未删除（仍需再一次二次确认）
      fireEvent.click(firstClickDelete());
      expect(within(row).getByText("再点一次确认删除")).toBeTruthy();
      expect(mockInvoke).not.toHaveBeenCalledWith("delete_sticky_note", expect.anything());

      // 仍在 fake timers 环境内卸载组件，避免挂起的定时器句柄泄漏给真实环境
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("确认态下点击其他操作会退出确认态且不误删", async () => {
    mockDefault();
    render(<StickyNoteManager />);
    await screen.findByText("买牛奶");

    const row1 = screen.getByText("买牛奶").closest("li");
    expect(row1).not.toBeNull();

    // note-1 进入待确认态
    fireEvent.click(within(row1 as HTMLElement).getByRole("button", { name: "删除该便签" }));
    expect(within(row1 as HTMLElement).getByText("再点一次确认删除")).toBeTruthy();

    // 转而点击该行的「收起」：退出确认态、执行收起，且不触发删除
    fireEvent.click(within(row1 as HTMLElement).getByRole("button", { name: "收起该便签" }));
    expect(within(row1 as HTMLElement).queryByText("再点一次确认删除")).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalledWith("delete_sticky_note", expect.anything());
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("collect_sticky_note", { id: "note-1" });
    });
  });
});
