import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMockListeners, mockStartDragging, setMockWindow } from "../../test/tauri-mock";
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

  // 便利贴窗是无边框窗（decorations:false），拖拽只能靠前端显式 startDragging()。
  // 早前只有顶栏留白能拖，用户在纸色点/正文上按下就以为「便利贴拖不动」，
  // 这里把「哪些地方能拖、哪些地方必须让位给点击与编辑」钉死。
  describe("按住卡片拖动整窗", () => {
    async function renderedCard() {
      mockGetNote(noteWith({ id: "note-1", content: "备忘" }));
      const { container } = render(<StickyNote />);
      // 正文是异步读回来的：等编辑区出现后再取元素
      await screen.findByLabelText("便利贴内容");
      const editor = getEditor(container);
      await waitFor(() => expect(editor.textContent).toContain("备忘"));
      return { container, editor };
    }

    it("抓手、卡片、以及卡片外的透明留白都能拖动", async () => {
      const { container } = await renderedCard();
      const grip = container.querySelector(".sn-grip");
      const card = container.querySelector(".sn-card");
      const windowRoot = container.querySelector(".sn-window");
      expect(grip).toBeTruthy();

      // 顶栏把手：走拖拽分支，并 preventDefault（否则按住顶栏会先开始划选文字）
      expect(fireEvent.mouseDown(grip as HTMLElement)).toBe(false);
      expect(mockStartDragging).toHaveBeenCalledTimes(1);

      // 卡片四周的内边距（命中元素就是卡片自己）
      expect(fireEvent.mouseDown(card as HTMLElement)).toBe(false);
      expect(mockStartDragging).toHaveBeenCalledTimes(2);

      // 卡片外那圈透明留白命中窗口根节点：不覆盖就是吞点击的死区
      expect(fireEvent.mouseDown(windowRoot as HTMLElement)).toBe(false);
      expect(mockStartDragging).toHaveBeenCalledTimes(3);
    });

    it("正文、纸色点、按钮与右键都不抢拖拽", async () => {
      const { container, editor } = await renderedCard();
      const card = container.querySelector(".sn-card") as HTMLElement;

      // 这些按下**不能被 preventDefault**：正文要能落光标/划选文字，按钮要能正常点击。
      // fireEvent 在事件被取消时返回 false，用它把「默认行为仍在」一起钉住——只看
      // startDragging 没被调用是不够的：若哪天把 preventDefault 提到排除判断之前，
      // 编辑与点击会一起失效，而拖拽同样不会触发，那条断言照样是绿的。
      expect(fireEvent.mouseDown(editor)).toBe(true);
      expect(fireEvent.mouseDown(container.querySelector(".sn-color-dot") as HTMLElement)).toBe(true);
      expect(fireEvent.mouseDown(screen.getByLabelText("收起便利贴"))).toBe(true);
      expect(fireEvent.mouseDown(screen.getByLabelText("新建便利贴"))).toBe(true);
      expect(fireEvent.mouseDown(screen.getByLabelText("删除便利贴"))).toBe(true);
      // 右键不进入拖拽
      expect(fireEvent.mouseDown(card, { button: 2 })).toBe(true);

      expect(mockStartDragging).not.toHaveBeenCalled();
    });
  });

  /**
   * 只有「确实已不存在」才允许自毁窗口。以前任何错误都会 `win.destroy()` ——
   * 一次瞬时的 IPC/锁失败就把用户正在看的便签窗销毁掉，而数据里它仍是 visible=true，
   * 管理窗于是显示「已贴在桌面」但桌面没有窗口；同时用户看不到任何提示。
   */
  it("读取便签遇到瞬时错误时不自毁窗口，而是给出可见提示", async () => {
    setMockWindow({ label: "sticky-note-note-1" });
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_sticky_note") return Promise.reject("读取失败：IPC 超时");
      if (command === "get_sticky_note_images_dir") return Promise.resolve("");
      return Promise.resolve();
    });

    render(<StickyNote />);

    expect(await screen.findByText(/读取便利贴失败/)).toBeInTheDocument();
  });
});
