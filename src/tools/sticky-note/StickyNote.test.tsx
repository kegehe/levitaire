import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMockListeners,
  clearMockWindowEventHandlers,
  emitMockDragDrop,
  emitMockResize,
  emitMockScaleChanged,
  mockInnerSize,
  mockSetSize,
  mockStartDragging,
  mockStartResizeDragging,
  setMockInnerSize,
  setMockWindow,
} from "../../test/tauri-mock";
import { installDesktopShell } from "../../utils/desktopShell";
import StickyNote, {
  PROGRAMMATIC_RESIZE_SUPPRESS_MS,
  caretAdjacentImage,
  caretBarGeometry,
  isAutoSizeEcho,
} from "./StickyNote";

const mockInvoke = vi.mocked(invoke);

function noteWith(
  overrides: Partial<{
    id: string;
    content: string;
    colorId: string;
    width: number;
    height: number;
  }>,
) {
  return {
    id: overrides.id ?? "note-1",
    content: overrides.content ?? "",
    colorId: overrides.colorId ?? "yellow",
    visible: true,
    width: overrides.width ?? 0,
    height: overrides.height ?? 0,
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
  };
}

/** 图片令牌的固定 rel（与后端命名格式一致，水合时才会渲染成 <img>） */
const IMG_REL = "note-1750000000000-1/img_1_0.png";

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

/** 渲染一张含图片的便签，返回 editor 与那张 <img> */
async function renderNoteWithImage() {
  setMockWindow({ label: "sticky-note-note-1750000000000-1" });
  mockGetNote(
    noteWith({
      id: "note-1750000000000-1",
      content: `[[img:${IMG_REL}]]\n说明文字`,
      colorId: "yellow",
    }),
  );
  const { container } = render(<StickyNote />);
  const editor = await screen.findByLabelText("便利贴内容");
  const img = (await waitFor(() => {
    const found = editor.querySelector(`img[data-note-img="${IMG_REL}"]`);
    expect(found).toBeTruthy();
    return found as HTMLImageElement;
  })) as HTMLImageElement;
  return { container, editor, img };
}

describe("StickyNote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    clearMockWindowEventHandlers();
    setMockInnerSize({ width: 400, height: 50 });
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
    expect(container.querySelector(".sn-color-dot.is-active")?.getAttribute("title")).toBe("薄荷");
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
      const img = editor.querySelector('img[data-note-img="note-1750000000000-1/img_1_0.png"]');
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
    expect(container.querySelector("img[data-note-img]")).toBeNull();
  });

  it("粘贴图片先落盘再插入令牌式 <img>", async () => {
    setMockWindow({ label: "sticky-note-note-1750000000000-1" });
    mockGetNote(noteWith({ id: "note-1750000000000-1", content: "", colorId: "yellow" }));
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
      expect(fireEvent.mouseDown(container.querySelector(".sn-color-dot") as HTMLElement)).toBe(
        true,
      );
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

    const { container } = render(<StickyNote />);

    expect(await screen.findByText(/读取便利贴失败/)).toBeInTheDocument();
    // 失败态也要认下当前窗口尺寸（数据读不到，窗口尺寸就是唯一真相），
    // 否则手动尺寸的便签会渲染成一窄条卡片 + 一大片透明
    await waitFor(() => {
      expect(container.querySelector(".sn-window")?.getAttribute("data-manual")).toBe("true");
    });
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * 便利贴窗也要能改大小：右下角纸角是手柄（原生 startResizeDragging），拖完落盘、
   * 下次开窗按记忆尺寸显示；双击手柄回到「宽 264 + 高度随内容」。
   */
  describe("拖拽调整便利贴大小", () => {
    it("右下角手柄按下走原生缩放，不会被当成拖动整窗", async () => {
      mockGetNote(noteWith({ id: "note-1", content: "备忘" }));
      const { container } = render(<StickyNote />);
      await screen.findByLabelText("便利贴内容");

      const grip = container.querySelector(".sn-resize") as HTMLElement;
      expect(grip).toBeTruthy();
      // fireEvent 返回 false = 该事件被 preventDefault（按下即开始缩放，不该有别的默认行为）
      expect(fireEvent.mouseDown(grip)).toBe(false);

      expect(mockStartResizeDragging).toHaveBeenCalledWith("SouthEast");
      // 手柄不能同时把整窗拖走
      expect(mockStartDragging).not.toHaveBeenCalled();
    });

    /**
     * 手柄上还有「双击回自动高度」这个语义。若双击的第二下也去开原生缩放模态循环，
     * dblclick 有可能收不到 —— 手柄就会变成「双击没反应」。
     */
    it("双击的第二下不再开原生缩放", async () => {
      mockGetNote(noteWith({ id: "note-1", content: "备忘" }));
      const { container } = render(<StickyNote />);
      await screen.findByLabelText("便利贴内容");
      const grip = container.querySelector(".sn-resize") as HTMLElement;

      fireEvent.mouseDown(grip, { detail: 1 });
      fireEvent.mouseDown(grip, { detail: 2 });

      expect(mockStartResizeDragging).toHaveBeenCalledTimes(1);
    });

    it("用户拖出尺寸后切成手动尺寸并落盘（拖拽期间不回读窗口尺寸）", async () => {
      mockGetNote(noteWith({ id: "note-1", content: "备忘" }));
      const { container } = render(<StickyNote />);
      const editor = await screen.findByLabelText("便利贴内容");
      await waitFor(() => expect(editor.textContent).toContain("备忘"));

      mockInnerSize.mockClear();
      // payload 是原生报的物理尺寸（scaleFactor=1 ⇒ 逻辑尺寸同值）；连发三次模拟拖拽过程
      emitMockResize({ width: 360, height: 480 });
      emitMockResize({ width: 361, height: 481 });
      emitMockResize({ width: 362, height: 482 });

      await waitFor(() => {
        expect(container.querySelector(".sn-window")?.getAttribute("data-manual")).toBe("true");
      });
      // 防抖后落盘的是**最后一次**读数，不是中途的中间值
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("set_sticky_note_size", {
          id: "note-1",
          width: 362,
          height: 482,
        });
      });
      // 尺寸来自事件 payload ⇒ 热路径上一次 `innerSize()` 都不该有
      // （早期写法每个 resize 事件读两次 IPC，60 次/秒的窗口事件就是 IPC 洪泛）
      expect(mockInnerSize).not.toHaveBeenCalled();
    });

    /**
     * 自动高度每次内容变高都会 `setSize`，而产生的 resize 事件与「用户拖窗口边」完全一样。
     * 不排除这个回声的话，用户只是多打了两行字，便签就永久切进手动尺寸、再也回不到自动高度。
     */
    it("程序性 setSize 的回声不会被误当成用户改尺寸", async () => {
      // happy-dom 量不出布局高度（offsetHeight 恒 0），自动高度压根不会下发 setSize，
      // 也就没有回声可测。这里把高度固定成一个值，让「量内容 → setSize」这条路真的跑起来。
      const heightSpy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(180);
      try {
        mockGetNote(noteWith({ id: "note-1", content: "备忘" }));
        const { container } = render(<StickyNote />);
        await screen.findByLabelText("便利贴内容");
        await waitFor(() => expect(mockSetSize).toHaveBeenCalled());

        // 紧随其后的 resize 就是这个 setSize 的回声（payload 与下发值一致）
        emitMockResize({ width: 264, height: 180 });
        await sleep(80);

        expect(container.querySelector(".sn-window")?.getAttribute("data-manual")).toBeNull();
        expect(mockInvoke).not.toHaveBeenCalledWith("set_sticky_note_size", expect.anything());
      } finally {
        heightSpy.mockRestore();
      }
    });

    /**
     * ★ 把便签拖到另一台缩放不同的显示器上：系统按「**逻辑尺寸不变、物理尺寸按新缩放重排**」
     * 重算窗口（tao 的 WM_DPICHANGED 就是这么做的）。此刻若缩放缓存还是旧值，
     * 528 会被读成"用户把宽度拖到了 528" ⇒ 静默切进手动尺寸并落盘 —— 用户只是换了块屏幕，
     * 自动高度就没了，且没有任何提示。
     *
     * 这里**先等抑制窗口过期**再发 resize，为的是单独钉住"按新缩放换算"这条路径：
     * 抑制窗口那道保险是另一条（若只靠它，缓存落后时照样漏）。
     */
    it("换显示器导致的系统重排不会被误当成用户改尺寸", async () => {
      const heightSpy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(180);
      try {
        mockGetNote(noteWith({ id: "note-1", content: "备忘" }));
        const { container } = render(<StickyNote />);
        await screen.findByLabelText("便利贴内容");
        await waitFor(() => expect(mockSetSize).toHaveBeenCalled());
        await sleep(PROGRAMMATIC_RESIZE_SUPPRESS_MS + 40);

        // 拖到 2× 缩放的显示器：逻辑尺寸不变（264×180），物理尺寸翻倍
        emitMockScaleChanged(2);
        await sleep(PROGRAMMATIC_RESIZE_SUPPRESS_MS + 40);
        emitMockResize({ width: 528, height: 360 });
        await sleep(80);

        expect(container.querySelector(".sn-window")?.getAttribute("data-manual")).toBeNull();
        expect(mockInvoke).not.toHaveBeenCalledWith("set_sticky_note_size", expect.anything());
      } finally {
        heightSpy.mockRestore();
      }
    });

    /**
     * 抑制窗口只有 400ms：系统慢一拍、或窗口在隐藏状态下被后端按记忆尺寸摆位时，回声会晚到。
     * 另外把便签拖到另一台缩放不同的显示器上时，系统按新缩放重排窗口 —— 物理尺寸变了、
     * 逻辑尺寸没变，只看物理值同样分不出来。两种情况都由 isAutoSizeEcho 兜住。
     */
    it("isAutoSizeEcho 只认「逻辑尺寸等于自动目标」的事件", () => {
      // 我们刚下发过 264×568 的自动高度（expectedHeight = 上次量到的高度）
      expect(isAutoSizeEcho(264, 568, 568)).toBe(true);
      // 系统换算的取整误差（1px 以内）仍算回声
      expect(isAutoSizeEcho(264, 568.6, 568.2)).toBe(true);
      // 换到 1.5× 缩放的显示器：物理 (396, 852) 换算成逻辑还是 (264, 568)
      expect(isAutoSizeEcho(396 / 1.5, 852 / 1.5, 568)).toBe(true);
      // 用户真拖了：宽或高真的变了
      expect(isAutoSizeEcho(360, 568, 568)).toBe(false);
      expect(isAutoSizeEcho(264, 620, 568)).toBe(false);
      // 还没量过内容（目标高度未知）：不能把用户的操作吞掉
      expect(isAutoSizeEcho(264, 180, 0)).toBe(false);
    });

    it("双击手柄恢复自动高度", async () => {
      mockGetNote(noteWith({ id: "note-1", content: "备忘", width: 360, height: 480 }));
      const { container } = render(<StickyNote />);
      await screen.findByLabelText("便利贴内容");
      expect(container.querySelector(".sn-window")?.getAttribute("data-manual")).toBe("true");

      fireEvent.doubleClick(container.querySelector(".sn-resize") as HTMLElement);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("reset_sticky_note_size", { id: "note-1" });
      });
      await waitFor(() => {
        expect(container.querySelector(".sn-window")?.getAttribute("data-manual")).toBeNull();
      });
    });

    it("手动尺寸下内容变化不再自动改窗口高度", async () => {
      mockGetNote(noteWith({ id: "note-1", content: "备忘", width: 360, height: 480 }));
      const { container } = render(<StickyNote />);
      const editor = await screen.findByLabelText("便利贴内容");
      await waitFor(() => expect(editor.textContent).toContain("备忘"));

      mockSetSize.mockClear();
      getEditor(container).textContent = "又写了很多字，多到足够换好几行";
      fireEvent.input(getEditor(container));
      await sleep(120); // 越过 scheduleResize 的 40ms 防抖

      expect(mockSetSize).not.toHaveBeenCalled();
    });
  });

  describe("图片行：光标、选区与右键菜单", () => {
    it("点图片把光标放到图片之后（不需要先选中图片）", async () => {
      const { editor, img } = await renderNoteWithImage();

      // preventDefault：不让浏览器按点击坐标在图片内部/下一行猜落点
      expect(fireEvent.mouseDown(img)).toBe(false);

      const selection = document.getSelection();
      expect(selection).toBeTruthy();
      // 正文结构 = [<img>, 文本]，所以「图片之后」= 下标 1
      expect(selection!.anchorNode).toBe(editor);
      expect(selection!.anchorOffset).toBe(1);
    });

    /**
     * 光标条的几何是纯函数算的（happy-dom 量不出布局，只能在纯函数这一层钉）：
     * 位置/高度一旦算错，表现就是「那根条飘到别处」，而肉眼很难在开发时发现。
     * 第一组数字直接取自预览页真实渲染量到的值（图片 208 宽 116 高、右缘 +3）。
     */
    it("caretBarGeometry 夹到可视区、完全不可见时返回 null", () => {
      const viewport = { top: 100, bottom: 580, left: 0 };
      // 完整可见：贴右缘外侧 3px，高度=图片高度
      expect(caretBarGeometry({ top: 123, bottom: 239, right: 208 }, viewport)).toEqual({
        left: 211,
        top: 23,
        height: 116,
      });
      // 上缘被裁：只画可见的一段，且从可视区顶边开始
      expect(caretBarGeometry({ top: 80, bottom: 196, right: 208 }, viewport)).toEqual({
        left: 211,
        top: 0,
        height: 96,
      });
      // 下缘被裁
      expect(caretBarGeometry({ top: 500, bottom: 616, right: 208 }, viewport)).toEqual({
        left: 211,
        top: 400,
        height: 80,
      });
      // 只从可视区顶边露出一截（不是 0，所以照样要画）
      expect(caretBarGeometry({ top: 0, bottom: 116, right: 208 }, viewport)).toEqual({
        left: 211,
        top: 0,
        height: 16,
      });
      // 完全在可视区上方/下方：不画（否则会画到编辑器外面，压在卡片顶栏上）
      expect(caretBarGeometry({ top: 0, bottom: 100, right: 208 }, viewport)).toBeNull();
      expect(caretBarGeometry({ top: 600, bottom: 716, right: 208 }, viewport)).toBeNull();
      // 只露 1px 也算不可见（阈值边界）
      expect(caretBarGeometry({ top: 90, bottom: 101, right: 208 }, viewport)).toBeNull();
    });

    it("caretAdjacentImage 只认图片前后的落点", async () => {
      const editor = document.createElement("div");
      editor.contentEditable = "true";
      const img = document.createElement("img");
      img.setAttribute("data-note-img", IMG_REL);
      const text = document.createTextNode("abc");
      editor.append(img, text);
      document.body.appendChild(editor);

      const selection = document.getSelection()!;
      const range = document.createRange();
      range.setStartAfter(img);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      expect(caretAdjacentImage(editor)).toBe(img);

      // 文本中间的位置不算「图片行」
      const middle = document.createRange();
      middle.setStart(text, 1);
      middle.collapse(true);
      selection.removeAllRanges();
      selection.addRange(middle);
      expect(caretAdjacentImage(editor)).toBeNull();

      editor.remove();
    });

    it("右键图片给出「复制图片 / 删除图片」，复制不需要先选中", async () => {
      const { img } = await renderNoteWithImage();
      const dispose = installDesktopShell();
      try {
        fireEvent.contextMenu(img, { clientX: 40, clientY: 30 });

        expect(
          Array.from(document.querySelectorAll(".app-text-menu__item")).map((el) => el.textContent),
        ).toEqual(["复制图片", "删除图片"]);
        // 关键前提：此刻没有任何文字选区。通用文本菜单在这种情况下「复制」是灰的，
        // 而图片又选不中 —— 这正是「必须先框选图片才能复制」的根因。
        expect(document.getSelection()?.isCollapsed ?? true).toBe(true);

        fireEvent.click(document.querySelector('.app-text-menu__item[data-action="copyImage"]')!);

        await waitFor(() => {
          expect(mockInvoke).toHaveBeenCalledWith("copy_sticky_note_image", {
            id: "note-1750000000000-1",
            rel: IMG_REL,
          });
        });
        expect(document.querySelector(".app-text-menu")).toBeNull(); // 点完收起
        expect(await screen.findByText("已复制图片")).toBeInTheDocument();
      } finally {
        dispose();
      }
    });

    it("右键图片可以删除：正文节点与磁盘文件一起清掉", async () => {
      const { container, img } = await renderNoteWithImage();
      const dispose = installDesktopShell();
      try {
        fireEvent.contextMenu(img, { clientX: 40, clientY: 30 });
        fireEvent.click(document.querySelector('.app-text-menu__item[data-action="deleteImage"]')!);

        await waitFor(() => {
          expect(container.querySelector(`img[data-note-img="${IMG_REL}"]`)).toBeNull();
        });
        expect(mockInvoke).toHaveBeenCalledWith("delete_sticky_note_image", {
          id: "note-1750000000000-1",
          rel: IMG_REL,
        });
      } finally {
        dispose();
      }
    });

    it("图片以外的地方右键仍走通用文本菜单", async () => {
      const { editor } = await renderNoteWithImage();
      const dispose = installDesktopShell();
      try {
        fireEvent.contextMenu(editor, { clientX: 10, clientY: 10 });
        expect(
          Array.from(document.querySelectorAll(".app-text-menu__item")).map((el) => el.textContent),
        ).toEqual(["剪切", "复制", "粘贴", "全选"]);
      } finally {
        dispose();
      }
    });

    it("把图片文件拖进便签：落盘后插到正文里", async () => {
      const { container } = await renderNoteWithImage();
      const droppedRel = "note-1750000000000-1/img_dropped.png";
      mockInvoke.mockImplementation((command: string) => {
        if (command === "import_sticky_note_image") return Promise.resolve(droppedRel);
        return Promise.resolve();
      });

      emitMockDragDrop({
        type: "drop",
        paths: ["C:/pics/a.png"],
        position: { x: 0, y: 0 },
      });

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("import_sticky_note_image", {
          noteId: "note-1750000000000-1",
          path: "C:/pics/a.png",
        });
      });
      await waitFor(() => {
        expect(container.querySelector(`img[data-note-img="${droppedRel}"]`)).toBeTruthy();
      });
    });

    it("拖入非图片文件不触发导入", async () => {
      await renderNoteWithImage();
      mockInvoke.mockClear();

      emitMockDragDrop({ type: "drop", paths: ["C:/pics/a.txt"], position: { x: 0, y: 0 } });
      await sleep(30);

      expect(mockInvoke).not.toHaveBeenCalledWith("import_sticky_note_image", expect.anything());
    });

    /**
     * 读取失败态下拖入图片：正文还没挂载，**不能**先把图落盘 —— 插不进去它就是孤儿文件
     * （要等整张便签删除才清），而用户以为贴成功了。命令不发，提示要给（失败卡片里也要显示）。
     */
    it("正文还没挂载时拖入图片：不落盘，只提示", async () => {
      mockInvoke.mockImplementation((command: string) => {
        if (command === "get_sticky_note") return Promise.reject("读取失败：IPC 超时");
        if (command === "get_sticky_note_images_dir") return Promise.resolve("");
        return Promise.resolve();
      });
      render(<StickyNote />);
      await screen.findByText(/读取便利贴失败/);

      emitMockDragDrop({ type: "drop", paths: ["C:/pics/a.png"], position: { x: 0, y: 0 } });
      await sleep(30);

      expect(mockInvoke).not.toHaveBeenCalledWith("import_sticky_note_image", expect.anything());
      expect(await screen.findByText(/正文还没准备好/)).toBeInTheDocument();
    });
  });

  /**
   * 落不下来的图片类型（SVG / 未开特性的 webp）**也必须接管**。
   *
   * 放给浏览器默认行为的话，它会插一张靠 `blob:` / `data:` 的 `<img>` —— 那种图片在正文里
   * 不落任何令牌（`serializeEditorText` 只认 `data-note-img`），用户看着图贴进来了、重新打开
   * 便签却没有，比「什么都不发生」更糟。接管 + 说明原因才是可解释的行为；随图文字也不能因为
   * 接管而丢（我们自己把它补回去）。
   */
  it("不支持的图片格式：接管并说明原因，不放给浏览器插一张存不下的图", async () => {
    mockGetNote(noteWith({ id: "note-1", content: "" }));
    const { container } = render(<StickyNote />);
    const editor = await screen.findByLabelText("便利贴内容");

    const svg = new File([new Uint8Array([0x3c, 0x73])], "icon.svg", { type: "image/svg+xml" });
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", "随图文字");
    dataTransfer.items.add(svg);

    // fireEvent 返回 false = 事件被 preventDefault（这次粘贴由我们接管，不再交给浏览器）
    expect(fireEvent.paste(editor, { clipboardData: dataTransfer })).toBe(false);

    expect(await screen.findByText(/不支持的图片格式：SVG\+XML/)).toBeInTheDocument();
    // 接管不能把随图文字一起吃
    expect(getEditor(container).textContent).toContain("随图文字");
    expect(mockInvoke).not.toHaveBeenCalledWith("save_sticky_note_image", expect.anything());
    expect(container.querySelector("img[data-note-img]")).toBeNull();
  });
});
