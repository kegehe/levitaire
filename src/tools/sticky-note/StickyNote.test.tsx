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
    if (command === "get_sticky_note_images_dir")
      return Promise.resolve("C:/data/levitaire/sticky-images");
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

  it("正文中的图片令牌渲染为 <img>，序列化时还原为令牌", async () => {
    setMockWindow({ label: "sticky-note-note-1750000000000-1" });
    mockGetNote(
      noteWith({
        id: "note-1750000000000-1",
        content: "看下图\n[[img:note-1750000000000-1/img_1_0.png]]\n说明文字",
        colorId: "yellow",
      }),
    );
    const { container } = render(<StickyNote />);

    const editor = await screen.findByLabelText("便利贴内容");
    await waitFor(() => {
      const img = editor.querySelector(
        'img[data-note-img="note-1750000000000-1/img_1_0.png"]',
      );
      expect(img).toBeTruthy();
      expect((img as HTMLImageElement).src).toContain("note-1750000000000-1/img_1_0.png");
    });

    // contenteditable 的 DOM 再序列化应还原为原令牌（图片不回退文本数据丢失）
    fireEvent.input(getEditor(container));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("update_sticky_note_content", {
        id: "note-1750000000000-1",
        content: expect.stringContaining("[[img:note-1750000000000-1/img_1_0.png]]"),
      });
    });
  });

  it("字面输入的 [[img:...]] 不匹配后端命名格式时按普通文本保留", async () => {
    mockGetNote(
      noteWith({
        id: "note-1",
        content: "用法：[[img:手动内容]] 不会变成图片",
        colorId: "yellow",
      }),
    );
    const { container } = render(<StickyNote />);

    const editor = await screen.findByLabelText("便利贴内容");
    await waitFor(() => {
      expect(editor.textContent).toContain("[[img:手动内容]]");
    });
    expect(container.querySelector('img[data-note-img]')).toBeNull();
  });

  it("粘贴图片先落盘再插入令牌式 <img>", async () => {
    setMockWindow({ label: "sticky-note-note-1750000000000-1" });
    mockGetNote(
      noteWith({ id: "note-1750000000000-1", content: "", colorId: "yellow" }),
    );
    const { container } = render(<StickyNote />);
    const editor = await screen.findByLabelText("便利贴内容");
    await waitFor(() => expect(editor).toBeTruthy());

    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_sticky_note") return Promise.resolve(noteWith({ content: "" }));
      if (command === "get_sticky_note_images_dir")
        return Promise.resolve("C:/data/levitaire/sticky-images");
      if (command === "save_sticky_note_image")
        return Promise.resolve("note-1750000000000-1/img_pasted_1.png");
      return Promise.resolve();
    });

    const img = new File([new Uint8Array([0xff, 0xd8, 0xff])], "pasted.png", {
      type: "image/png",
    });
    const clipboardData = {
      items: [
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => img,
        },
      ],
    };
    fireEvent.paste(editor, { clipboardData });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "save_sticky_note_image",
        expect.objectContaining({ noteId: "note-1750000000000-1" }),
      );
    });
    await waitFor(() => {
      const pasted = container.querySelector(
        'img[data-note-img="note-1750000000000-1/img_pasted_1.png"]',
      );
      expect(pasted).toBeTruthy();
    });
  });
});
