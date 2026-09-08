import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("彻底删除某张便签", async () => {
    mockDefault();
    render(<StickyNoteManager />);
    await screen.findByText("买牛奶");

    // 删除"已收起"的那张（note-2，空白便签所在行）
    const hiddenRow = screen.getByText("空白便签").closest("li");
    expect(hiddenRow).not.toBeNull();
    fireEvent.click(within(hiddenRow as HTMLElement).getByRole("button", { name: "删除该便签" }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("delete_sticky_note", { id: "note-2" });
    });
  });
});
