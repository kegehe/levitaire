import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMockListeners, mockStartDragging, setMockWindow } from "../../test/tauri-mock";
import StickyNoteManager from "./StickyNoteManager";

const mockInvoke = vi.mocked(invoke);

/**
 * 声明级真值：测试环境（happy-dom）不做布局，量不到面板实际高度、也判断不出按钮是不是
 * 整宽，只能对着 CSS 源码断言（同 UtilityHub.test.tsx / tooltipDirection.test.ts 的思路）。
 * 用 node:url 的 URL 解析：测试环境里全局 URL 被换掉，fileURLToPath 会认不出来。
 */
function readManagerCss(): string {
  const css = readFileSync(
    fileURLToPath(new NodeURL("./StickyNoteManager.css", import.meta.url)),
    "utf8",
  );
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
}

function ruleFor(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  return start === -1 ? "" : css.slice(start, css.indexOf("}", start));
}

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

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("标题栏新建按钮创建新便签", async () => {
    mockDefault();
    render(<StickyNoteManager />);
    await screen.findByText("买牛奶");

    fireEvent.click(screen.getByRole("button", { name: /新建便利贴/ }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("create_sticky_note", { colorId: "yellow" });
    });
  });

  // 窗口不是固定尺寸：高度由面板实测高度 + 上下投影留白算出并下发给原生窗。
  // 少了这一步，空状态（内容只有一百多像素）也会被撑成一大片空白 —— 用户看到的
  // 就是「按钮孤零零悬在面板中央」。
  it("按面板实测高度下发窗口尺寸（含上下投影留白）", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 332,
      height: 157,
    } as DOMRect);
    mockDefault();

    render(<StickyNoteManager />);
    await screen.findByText("买牛奶");

    const window = (await import("@tauri-apps/api/webviewWindow")).getCurrentWebviewWindow();
    await waitFor(() => {
      // 面板 157 + 顶部留白 14 + 底部留白 28；宽度固定 360（面板 332 + 左右各 14）
      expect(window.setSize).toHaveBeenCalledWith(
        expect.objectContaining({ width: 360, height: 199 }),
      );
    });
    // 只下发一次：面板没变就不再 setSize（ResizeObserver 首次回调、notes 变化重跑都必须
    // 被尺寸去重吃掉），否则窗口会被反复重排。
    expect(window.setSize).toHaveBeenCalledTimes(1);
  });

  it("面板高度由内容决定（窗口自适应成立的前提）", () => {
    const css = readManagerCss();

    // 面板/外框一旦撑满窗口，实测高度就等于窗口高度，窗口只会越调越大（反馈环）
    expect(ruleFor(css, ".snm-window")).not.toMatch(/height: 100vh/);
    expect(ruleFor(css, ".snm-panel")).not.toMatch(/height: 100%/);
    // 空状态同理：撑满面板就把窗口拉回固定高度，又变成一大片空白
    expect(ruleFor(css, ".snm-empty")).not.toMatch(/flex: 1/);
    // 便签多时靠 max-height 收口，不能让列表无限撑高窗口
    expect(ruleFor(css, ".snm-list")).toMatch(/max-height: \d+px/);
    // 空状态的新建按钮是自撑宽的胶囊，不是整宽主按钮
    expect(ruleFor(css, ".snm-add-btn")).toMatch(/display: inline-flex/);
    expect(ruleFor(css, ".snm-add-btn")).not.toMatch(/width: 100%/);
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

  // 「全部唤出」是「全部收起」的逆操作：批量把已收起的便签贴回桌面。
  it("全部唤出按钮把所有已收起的便签贴回桌面", async () => {
    mockDefault();
    render(<StickyNoteManager />);
    await screen.findByText("买牛奶");

    const showAllBtn = screen.getByLabelText("唤出全部便利贴");
    // 有 1 张已收起 → 可点
    expect(showAllBtn).not.toBeDisabled();
    fireEvent.click(showAllBtn);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("show_all_notes");
    });
  });

  // 两个批量按钮各自按「有没有对应目标的便签」置灰：没有已收起的便签时「全部唤出」
  // 是空操作，没有已贴桌面的便签时「全部收起」是空操作。**两个方向都钉住**——只断言
  // 一边的话，把判定条件写反（例如两边都拿 pinnedCount）在另一边仍然是绿的。
  it("批量按钮按各自的目标数量置灰", async () => {
    const renderWith = async (notes: unknown[]) => {
      mockInvoke.mockImplementation((command: string) => {
        if (command === "get_sticky_notes") return Promise.resolve(notes);
        return Promise.resolve();
      });
      const view = render(<StickyNoteManager />);
      await waitFor(() => {
        expect(view.container.querySelectorAll(".snm-item").length).toBe(notes.length);
      });
      return view;
    };

    // 全部已贴在桌面：能收起、不能唤出
    const pinnedOnly = await renderWith([NOTES[0]]);
    expect(screen.getByLabelText("唤出全部便利贴")).toBeDisabled();
    expect(screen.getByLabelText("收起全部便利贴")).not.toBeDisabled();
    pinnedOnly.unmount();

    // 全部已收起：能唤出、不能收起
    const hiddenOnly = await renderWith([{ ...NOTES[1] }]);
    expect(screen.getByLabelText("唤出全部便利贴")).not.toBeDisabled();
    expect(screen.getByLabelText("收起全部便利贴")).toBeDisabled();
    hiddenOnly.unmount();
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

  // 管理窗同样是无边框窗（decorations:false），没有原生标题栏。
  // 标题栏缺拖拽面时整窗完全无法移动（位置记忆也就永远只记得创建坐标），
  // 这里钉住：标题栏任意非按钮处都能拖，按钮仍然是点击目标。
  it("标题栏可拖动整窗，按钮不抢拖拽", async () => {
    mockDefault();
    render(<StickyNoteManager />);
    await screen.findByText("买牛奶");

    const header = document.querySelector(".snm-header") as HTMLElement;
    expect(header).toBeTruthy();

    // 标题文字是子元素，命中元素不是按钮 → 可拖
    fireEvent.mouseDown(within(header).getByText("便利贴"));
    expect(mockStartDragging).toHaveBeenCalledTimes(1);

    // 标题栏自身（左右两端的留白）→ 可拖
    fireEvent.mouseDown(header);
    expect(mockStartDragging).toHaveBeenCalledTimes(2);

    // 「新建 / 唤出全部 / 收起全部 / 隐藏」是点击目标，不能被拖拽吃掉
    fireEvent.mouseDown(screen.getByLabelText("新建便利贴"));
    fireEvent.mouseDown(screen.getByLabelText("唤出全部便利贴"));
    fireEvent.mouseDown(screen.getByLabelText("收起全部便利贴"));
    fireEvent.mouseDown(screen.getByLabelText("隐藏管理窗"));
    expect(mockStartDragging).toHaveBeenCalledTimes(2);

    // 右键不进入拖拽
    fireEvent.mouseDown(header, { button: 2 });
    expect(mockStartDragging).toHaveBeenCalledTimes(2);
  });
});
