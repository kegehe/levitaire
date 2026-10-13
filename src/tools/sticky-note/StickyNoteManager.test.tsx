import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMockListeners,
  emitMockEvent,
  mockStartDragging,
  setMockWindow,
} from "../../test/tauri-mock";
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

  // 读不到列表 ≠ 没有便签。走空状态分支会说成「还没有便利贴 / 新建第一张」，
  // 用户读了会以为便签被清空了（磁盘上其实还在），必须显示成读取失败。
  it("列表读取失败时显示读取失败与重试，而不是空状态", async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_sticky_notes") return Promise.reject(new Error("数据库被占用"));
      return Promise.resolve();
    });
    // 这条失败是故意的：拦下 console.error，别把栈刷进测试输出（同 TextToolbar.test.tsx）
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<StickyNoteManager />);

    expect(await screen.findByText("读取便利贴列表失败，内容暂未加载")).toBeTruthy();
    expect(screen.getByText(/数据库被占用/)).toBeTruthy();
    // 状态是**说出来**的：屏幕阅读器也要能立刻播报（同单张便签窗的失败卡片）
    expect(screen.getByRole("alert")).toBeTruthy();
    // ★ 断言「不显示空状态」这条本身：只说「显示了失败」时，两个分支同时渲染也照样绿
    expect(screen.queryByText("还没有便利贴")).toBeNull();
    expect(screen.queryByRole("button", { name: "新建第一张" })).toBeNull();
    // 没有任何数据时也不能挂「以下内容可能已过时」——那条提示是给上一轮列表用的，
    // 这里下面什么都没有，挂上去只会让人以为屏幕上还有一份没看到的旧列表
    expect(screen.queryByText(/可能已经过时/)).toBeNull();
    // 界面之外仍要留下日志：报错原文进了 UI，排查时也不能只剩一个空手
    expect(consoleSpy).toHaveBeenCalledWith("读取便利贴列表失败:", expect.anything());
    consoleSpy.mockRestore();
  });

  it("读取失败后点重试：先回到加载态，成功后恢复列表并清掉报错", async () => {
    let attempt = 0;
    // 重试的那次读取挂住不返回，好让「点下去有没有反馈」这一段能被断言到
    // （直接 resolve 的话，加载态可能在同一批微任务里就被列表替掉，断言会飘）。
    let resolveRetry: (notes: unknown) => void = () => {};
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_sticky_notes") {
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error("数据库被占用"));
        return new Promise((resolve) => {
          resolveRetry = resolve;
        });
      }
      return Promise.resolve();
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<StickyNoteManager />);
    await screen.findByText("读取便利贴列表失败，内容暂未加载");

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    // 点下去要立刻有反馈：回到加载态，而不是停在旧报错上一动不动
    expect(screen.getByText("加载中…")).toBeTruthy();
    expect(screen.queryByText("读取便利贴列表失败，内容暂未加载")).toBeNull();

    await act(async () => {
      resolveRetry(NOTES);
    });

    expect(await screen.findByText("买牛奶")).toBeTruthy();
    expect(screen.queryByText("读取便利贴列表失败，内容暂未加载")).toBeNull();
    // ★ 读成功必须把上一轮的报错一并清掉：只清「失败态」不清 loadError 的话，列表回来了
    // 却永远挂着「以下内容可能已经过时」—— 拿新鲜数据说它过时，同样是骗人。
    expect(screen.queryByText(/可能已经过时/)).toBeNull();
    consoleSpy.mockRestore();
  });

  // 手里还有上一轮数据时刷新失败：继续显示旧列表，但要说明它可能过时 ——
  // 静默保留会让人把旧张数当成本轮的事实。
  it("刷新失败但已有列表时保留旧数据并提示可能过时", async () => {
    let failing = false;
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_sticky_notes") {
        return failing ? Promise.reject(new Error("数据库被占用")) : Promise.resolve(NOTES);
      }
      return Promise.resolve();
    });
    render(<StickyNoteManager />);
    await screen.findByText("买牛奶");

    failing = true;
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      emitMockEvent("sticky-notes-changed", null);
    });

    // 旧便签仍在，同时挂出「可能已经过时」的提示
    expect(screen.getByText("买牛奶")).toBeTruthy();
    expect(screen.getByText(/可能已经过时/)).toBeTruthy();
    // 仍有数据时不该退化成整屏失败态
    expect(screen.queryByText("读取便利贴列表失败，内容暂未加载")).toBeNull();
    consoleSpy.mockRestore();
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

  // 「读不到」和「还没有便利贴」必须是两种长得不一样的东西：同形同色的话，这次修好的
  // 文案也会被一眼扫成空状态。声明级真值只能对着 CSS 源码断言（同本文件的高度守卫）。
  it("读取失败态在样式上与空状态分得开", () => {
    const css = readManagerCss();
    // 失败态整块走危险色（选择器是并列的，用正则匹配选择器列表）
    expect(css).toMatch(/\.snm-empty\.is-error[^{]*\{[^}]*--color-danger/);
    // 空状态自身**不能**是危险色：那是「还没有便利贴」，不是出错
    expect(ruleFor(css, ".snm-empty")).not.toMatch(/--color-danger/);
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
