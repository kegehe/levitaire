import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMockListeners, setMockWindow } from "../../test/tauri-mock";
import StickyNote from "./StickyNote";

const mockInvoke = vi.mocked(invoke);

function noteWith(overrides: Partial<{ id: string; content: string; colorId: string }>) {
  return {
    id: overrides.id ?? "note-1",
    content: overrides.content ?? "",
    colorId: overrides.colorId ?? "yellow",
    visible: true,
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
  };
}

function mockGetNote(note: ReturnType<typeof noteWith>) {
  mockInvoke.mockImplementation((command: string) => {
    if (command === "get_sticky_note") return Promise.resolve(note);
    return Promise.resolve();
  });
}

function getEditor(container: HTMLElement): HTMLElement {
  const editor = container.querySelector(".sn-editor");
  if (!editor) throw new Error(".sn-editor 不存在");
  return editor as HTMLElement;
}

describe("StickyNote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    setMockWindow({ label: "sticky-note-note-1" });
  });

  it("按 label 解析 note id 并展示正文", async () => {
    mockGetNote(noteWith({ id: "note-1", content: "备忘：买牛奶\n下午开会", colorId: "mint" }));
    const { container } = render(<StickyNote />);

    const editor = await screen.findByLabelText("便利贴内容");
    await waitFor(() => {
      expect(editor.textContent).toContain("买牛奶");
      expect(editor.textContent).toContain("下午开会");
    });
    // 颜色回显为薄荷色（活跃色点提示）
    expect(
      container.querySelector(".sn-color-dot.is-active")?.getAttribute("title"),
    ).toBe("薄荷");
  });

  it("空内容时显示空态与占位", async () => {
    mockGetNote(noteWith({ id: "note-1", content: "" }));
    const { container } = render(<StickyNote />);

    await waitFor(() => {
      expect(container.querySelector(".sn-card.is-empty")).toBeTruthy();
    });
  });

  it("Esc 收起时携带最新正文落盘", async () => {
    mockGetNote(noteWith({ id: "note-1", content: "旧文字" }));
    const { container } = render(<StickyNote />);

    const editor = await screen.findByLabelText("便利贴内容");
    await waitFor(() => expect(editor.textContent).toContain("旧文字"));

    getEditor(container).textContent = "最新备忘";
    fireEvent.input(getEditor(container));
    fireEvent.keyDown(getEditor(container), { key: "Escape" });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("collect_sticky_note", {
        id: "note-1",
        content: "最新备忘",
      });
    });
  });

  it("点击纸色圆点更新颜色", async () => {
    mockGetNote(noteWith({ id: "note-1", content: "hi", colorId: "yellow" }));
    render(<StickyNote />);
    await screen.findByLabelText("便利贴内容");

    fireEvent.click(screen.getByRole("button", { name: "纸色：丁香紫" }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("update_sticky_note_color", {
        id: "note-1",
        colorId: "lavender",
      });
    });
  });

  it("底部 + 按钮在附近新建便签", async () => {
    mockGetNote(noteWith({ id: "note-1", content: "hi", colorId: "yellow" }));
    render(<StickyNote />);
    await screen.findByLabelText("便利贴内容");

    fireEvent.click(screen.getByRole("button", { name: "新建便利贴" }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "create_sticky_note",
        expect.objectContaining({ colorId: "yellow" }),
      );
    });
  });
});
