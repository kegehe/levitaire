import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileShelf from "./FileShelf";
import { clearMockListeners } from "../../test/tauri-mock";

const mockInvoke = vi.mocked(invoke);

const items = ["a", "b", "c"].map((id) => ({
  id,
  kind: "reference" as const,
  name: `${id}.txt`,
  path: `D:\\${id}.txt`,
  isDir: false,
  size: 1,
  addedAt: "2026-10-30T00:00:00Z",
  missing: false,
}));

const rect = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

/** happy-dom 不做布局：按两列三行的槽位补上矩形，元素换位后按当前 DOM 索引取。 */
function stubLayout(container: HTMLElement) {
  const panel = container.querySelector(".file-shelf") as HTMLElement;
  const grid = container.querySelector(".file-shelf-grid") as HTMLElement;
  panel.getBoundingClientRect = () => rect(0, 0, 320, 500);
  grid.getBoundingClientRect = () => rect(0, 44, 320, 378);
  for (const child of Array.from(grid.children)) {
    child.getBoundingClientRect = () => {
      const index = Array.from(grid.children).indexOf(child);
      return rect(index % 2 === 0 ? 0 : 160, 44 + Math.floor(index / 2) * 125, 150, 116);
    };
  }
  return grid;
}

/** happy-dom 没有滚动盒模型：给出可滚动高度，并让 scrollTop 可读可写。 */
function stubScroll(grid: HTMLElement) {
  let scrollTop = 0;
  Object.defineProperty(grid, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(grid, "clientHeight", { configurable: true, value: 378 });
  Object.defineProperty(grid, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(500, value));
    },
  });
}

describe("FileShelf 拖拽排序", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((command) => {
      if (command === "shelf_list") {
        return Promise.resolve({ items, collapsed: false, notice: null });
      }
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("在面板内拖动卡片会重排并写回清单", async () => {
    const { container } = render(<FileShelf />);
    await screen.findByText("a.txt");
    stubLayout(container);
    const cards = Array.from(container.querySelectorAll(".file-card"));

    fireEvent.pointerDown(cards[0], { button: 0, pointerId: 1, clientX: 10, clientY: 50 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: 60 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 200, clientY: 60 });

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("shelf_reorder", { ids: ["b", "a", "c"] }),
    );
    expect(mockInvoke).not.toHaveBeenCalledWith("shelf_begin_drag", expect.anything());
  });

  it("从卡片直接拖出面板仍然开始拖出，不提交排序", async () => {
    const { container } = render(<FileShelf />);
    await screen.findByText("a.txt");
    stubLayout(container);
    const cards = Array.from(container.querySelectorAll(".file-card"));

    fireEvent.pointerDown(cards[0], { button: 0, pointerId: 2, clientX: 10, clientY: 50 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 700, clientY: 60 });

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("shelf_begin_drag", { ids: ["a"] }),
    );
    expect(mockInvoke).not.toHaveBeenCalledWith("shelf_reorder", expect.anything());
  });

  it("排序中按 Esc 恢复原顺序且不写回", async () => {
    const { container } = render(<FileShelf />);
    await screen.findByText("a.txt");
    stubLayout(container);
    const cards = Array.from(container.querySelectorAll(".file-card"));

    fireEvent.pointerDown(cards[0], { button: 0, pointerId: 3, clientX: 10, clientY: 50 });
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 200, clientY: 60 });
    expect(container.querySelectorAll(".file-card-name")[0].textContent).toBe("b.txt");

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, { pointerId: 3, clientX: 200, clientY: 60 });

    expect(container.querySelectorAll(".file-card-name")[0].textContent).toBe("a.txt");
    expect(mockInvoke).not.toHaveBeenCalledWith("shelf_reorder", expect.anything());
  });

  it("Shift 点选按当前显示顺序选中区间", async () => {
    const { container } = render(<FileShelf />);
    await screen.findByText("a.txt");
    const cards = Array.from(container.querySelectorAll(".file-card"));

    fireEvent.click(cards[0]);
    expect(container.querySelectorAll(".file-card.is-selected")).toHaveLength(1);
    fireEvent.click(cards[2], { shiftKey: true });
    expect(container.querySelectorAll(".file-card.is-selected")).toHaveLength(3);
  });

  it("点面板空白处取消选择", async () => {
    const { container } = render(<FileShelf />);
    await screen.findByText("a.txt");
    const cards = Array.from(container.querySelectorAll(".file-card"));

    fireEvent.click(cards[1]);
    expect(container.querySelectorAll(".file-card.is-selected")).toHaveLength(1);
    fireEvent.click(container.querySelector(".file-shelf") as HTMLElement);
    expect(container.querySelectorAll(".file-card.is-selected")).toHaveLength(0);
  });

  it("排序结束补发的根节点 click 不清掉选择", async () => {
    const { container } = render(<FileShelf />);
    await screen.findByText("a.txt");
    stubLayout(container);
    const cards = Array.from(container.querySelectorAll(".file-card"));

    fireEvent.click(cards[0]);
    fireEvent.pointerDown(cards[0], { button: 0, pointerId: 5, clientX: 10, clientY: 50 });
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 200, clientY: 60 });
    fireEvent.pointerUp(window, { pointerId: 5, clientX: 200, clientY: 60 });

    // pointer capture 会把紧随排序的 click 目标改成面板根节点，不能当成空白点击
    fireEvent.click(container.querySelector(".file-shelf") as HTMLElement);
    expect(container.querySelectorAll(".file-card.is-selected")).toHaveLength(1);
  });

  it("双击卡片用系统默认程序打开", async () => {
    const { container } = render(<FileShelf />);
    await screen.findByText("a.txt");
    const cards = Array.from(container.querySelectorAll(".file-card"));

    fireEvent.doubleClick(cards[0]);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("shelf_open", { id: "a" }));
  });

  it("双击失效条目不会尝试打开", async () => {
    const broken = [{ ...items[0], id: "dead", name: "dead.txt", missing: true }];
    mockInvoke.mockImplementation((command) =>
      command === "shelf_list"
        ? Promise.resolve({ items: broken, collapsed: false, notice: null })
        : Promise.resolve(undefined),
    );
    const { container } = render(<FileShelf />);
    await screen.findByText("dead.txt");

    fireEvent.doubleClick(container.querySelector(".file-card") as HTMLElement);
    expect(mockInvoke).not.toHaveBeenCalledWith("shelf_open", expect.anything());
  });

  it("tooltip 带文件大小和双击打开提示", async () => {
    const { container } = render(<FileShelf />);
    await screen.findByText("a.txt");
    const name = container.querySelector(".file-card-name");

    expect(name).toHaveAttribute("title", expect.stringContaining("1 B"));
    expect(name).toHaveAttribute("title", expect.stringContaining("双击打开"));
  });

  it("拖到列表下边缘会自动滚动", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const { container } = render(<FileShelf />);
    await screen.findByText("a.txt");
    const grid = stubLayout(container);
    stubScroll(grid);
    const cards = Array.from(container.querySelectorAll(".file-card"));

    fireEvent.pointerDown(cards[0], { button: 0, pointerId: 4, clientX: 10, clientY: 50 });
    // 列表下边缘（grid bottom = 422），进入自动滚动区
    fireEvent.pointerMove(window, { pointerId: 4, clientX: 200, clientY: 420 });
    expect(frames.length).toBeGreaterThan(0);

    act(() => frames[0](16));
    expect(grid.scrollTop).toBeGreaterThan(0);

    fireEvent.pointerUp(window, { pointerId: 4, clientX: 200, clientY: 420 });
  });
});

describe("FileShelf 清空确认", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((command) => {
      if (command === "shelf_list") {
        return Promise.resolve({ items, collapsed: false, notice: null });
      }
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("点清空先弹确认，取消不清空，确认才执行 shelf_clear", async () => {
    render(<FileShelf />);
    await screen.findByText("a.txt");

    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    const dialog = screen.getByRole("alertdialog");
    // 测试数据 3 条全是引用：数量按当前清单实时计算
    expect(within(dialog).getByText(/0 个副本/)).toBeTruthy();
    expect(mockInvoke).not.toHaveBeenCalledWith("shelf_clear");

    // 取消：弹窗关闭，不清空
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalledWith("shelf_clear");

    // 再打开并确认：执行 shelf_clear，弹窗关闭
    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "清空" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("shelf_clear"));
  });
});
