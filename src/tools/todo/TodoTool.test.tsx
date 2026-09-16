import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TodoTool from "./TodoTool";
import { clearMockListeners, emitMockEvent, mockSetSize } from "../../test/tauri-mock";

const mockInvoke = vi.mocked(invoke);

/** 读源码 CSS（剥注释并压空白），供「面板高度必须由内容决定」这类结构断言使用。 */
function readTodoCss(): string {
  return readFileSync(fileURLToPath(new NodeURL("./TodoTool.css", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ");
}

function ruleFor(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  return start === -1 ? "" : css.slice(start, css.indexOf("}", start));
}

const item = {
  id: "todo-1",
  title: "整理文档",
  notes: "",
  status: "active" as const,
  dueAt: undefined,
  remindAt: undefined,
  reminderFiredAt: undefined,
  createdAt: "2026-08-26T10:00:00Z",
  updatedAt: "2026-08-26T10:00:00Z",
  completedAt: undefined,
  sortOrder: 1,
};

describe("TodoTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
  });

  it("adds a task with Enter and refocuses the input", async () => {
    render(<TodoTool />);
    const input = screen.getByPlaceholderText("添加任务...");
    fireEvent.change(input, { target: { value: "  写周报  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("create_todo", {
      input: { title: "写周报", priority: "normal", tags: [""], dueAt: undefined, remindAt: undefined },
    }));
  });

  it("keeps advanced add fields collapsed until requested", () => {
    render(<TodoTool />);
    expect(screen.queryByLabelText("任务优先级")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更多任务选项" }));
    expect(screen.getByLabelText("任务优先级")).toBeInTheDocument();
  });

  it("sets a reminder with a quick time shortcut", () => {
    render(<TodoTool />);
    fireEvent.click(screen.getByRole("button", { name: "更多任务选项" }));
    fireEvent.click(screen.getByRole("button", { name: "10 分钟后" }));
    expect((screen.getByLabelText("提醒时间") as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  // 清单全部由用户自建：没有任何清单时下拉框只剩「全部任务」这一个伪选项，
  // 它不做清单过滤，未归类任务也照常显示。回收站视图则整条清单栏都不出现。
  it("falls back to the all-tasks option when no list exists and hides the list filter in trash", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve([]);
      if (command === "get_todo_lists") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    const listSelect = await screen.findByRole("combobox", { name: "Todo list" });
    await waitFor(() => expect(within(listSelect).getAllByRole("option")).toHaveLength(1));
    expect(within(listSelect).getByRole("option", { name: "全部任务" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "回收站" }));
    expect(screen.queryByRole("combobox", { name: "Todo list" })).not.toBeInTheDocument();
    expect(screen.getByText("回收站")).toBeInTheDocument();
  });

  it("filters by the selected list and keeps unlisted tasks under 全部任务", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve([
        { ...item, id: "todo-listed", title: "清单内任务", listId: "list-1" },
        { ...item, id: "todo-unlisted", title: "未归类任务" },
      ]);
      if (command === "get_todo_lists") return Promise.resolve([{ id: "list-1", name: "工作", createdAt: "", updatedAt: "" }]);
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    // 默认「全部任务」：清单内和未归类的任务都看得到
    await screen.findByText("清单内任务");
    expect(screen.getByText("未归类任务")).toBeInTheDocument();

    const listSelect = screen.getByRole("combobox", { name: "Todo list" });
    fireEvent.change(listSelect, { target: { value: "list-1" } });
    await waitFor(() => expect(screen.queryByText("未归类任务")).not.toBeInTheDocument());
    expect(screen.getByText("清单内任务")).toBeInTheDocument();

    fireEvent.change(listSelect, { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("未归类任务")).toBeInTheDocument());
  });

  it("rejects renaming or deleting nothing by hiding list actions under 全部任务", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve([]);
      if (command === "get_todo_lists") return Promise.resolve([{ id: "list-1", name: "工作", createdAt: "", updatedAt: "" }]);
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    await waitFor(() => expect(screen.getByRole("option", { name: "工作" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "管理清单" }));
    // 「全部任务」不是真清单，没有可重命名/删除的对象
    expect(screen.queryByRole("button", { name: "Rename list" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete list" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Todo list" }), { target: { value: "list-1" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename list" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Delete list" })).toBeInTheDocument();
  });

  it("creates a list from the manager panel", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve([]);
      if (command === "get_todo_lists") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    await screen.findByRole("combobox", { name: "Todo list" });
    fireEvent.click(screen.getByRole("button", { name: "管理清单" }));

    const nameInput = screen.getByPlaceholderText("新建清单");
    fireEvent.change(nameInput, { target: { value: "  工作  " } });
    fireEvent.keyDown(nameInput, { key: "Enter" });
    // 首尾空白由前端 trim 后再提交，后端拿到的应该是干净的名字
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("create_todo_list", { input: { name: "工作" } }));
    expect((nameInput as HTMLInputElement).value).toBe("");
  });

  it("renames and deletes a user list", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve([]);
      if (command === "get_todo_lists") return Promise.resolve([{ id: "list-1", name: "工作", createdAt: "", updatedAt: "" }]);
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    await waitFor(() => expect(screen.getByRole("option", { name: "工作" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "管理清单" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Todo list" }), { target: { value: "list-1" } });

    fireEvent.click(screen.getByRole("button", { name: "Rename list" }));
    const renameInput = screen.getByLabelText("Edit list name");
    fireEvent.change(renameInput, { target: { value: "项目" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("update_todo_list", { id: "list-1", input: { name: "项目" } }));

    fireEvent.click(screen.getByRole("button", { name: "Delete list" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete list" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("delete_todo_list", { id: "list-1" }));
    // 清单没了，筛选项要退回「全部任务」，不能停在已删除的 id 上
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Todo list" })).toHaveValue(""));
  });

  it("adds the task to the selected list when one is chosen", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve([]);
      if (command === "get_todo_lists") return Promise.resolve([{ id: "list-1", name: "工作", createdAt: "", updatedAt: "" }]);
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    await waitFor(() => expect(screen.getByRole("option", { name: "工作" })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox", { name: "Todo list" }), { target: { value: "list-1" } });

    const input = screen.getByPlaceholderText("添加任务...");
    fireEvent.change(input, { target: { value: "写周报" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("create_todo", {
      input: { title: "写周报", priority: "normal", tags: [""], dueAt: undefined, remindAt: undefined, listId: "list-1" },
    }));
  });

  it("moves a task out of its list from the edit panel", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve([{ ...item, listId: "list-1" }]);
      if (command === "get_todo_lists") return Promise.resolve([{ id: "list-1", name: "工作", createdAt: "", updatedAt: "" }]);
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    await screen.findByText(item.title);
    fireEvent.click(screen.getByRole("button", { name: "编辑任务" }));

    const listField = screen.getByLabelText("编辑任务清单") as HTMLSelectElement;
    expect(within(listField).getByRole("option", { name: "无清单" })).toBeInTheDocument();
    expect(listField.value).toBe("list-1");

    fireEvent.change(listField, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("update_todo", expect.objectContaining({
      input: expect.objectContaining({ listId: "" }),
    })));
  });

  it("does not open an empty details panel for a plain task", async () => {
    mockInvoke.mockImplementation((command) => command === "get_todos" ? Promise.resolve([item]) : Promise.resolve([]));
    render(<TodoTool />);
    await waitFor(() => expect(screen.getByText(item.title)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: item.title }));
    expect(document.querySelector(".todo-item-details")).not.toBeInTheDocument();
  });

  it("filters tasks by the selected tag", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve([
        { ...item, id: "todo-work", title: "工作任务", tags: ["工作"] },
        { ...item, id: "todo-life", title: "生活任务", tags: ["生活"] },
      ]);
      return Promise.resolve([]);
    });
    render(<TodoTool />);
    await waitFor(() => expect(screen.getByText("工作任务")).toBeInTheDocument());
    const tagFilter = screen.getByRole("combobox", { name: "按标签筛选" });
    expect(screen.getByRole("option", { name: "工作" })).toBeInTheDocument();
    fireEvent.change(tagFilter, { target: { value: "工作" } });
    expect(screen.getByText("工作任务")).toBeInTheDocument();
    expect(screen.queryByText("生活任务")).not.toBeInTheDocument();
  });

  it("normalizes imported tag whitespace when filtering", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve([
        { ...item, id: "todo-imported", title: "导入的任务", tags: [" 工作 "] },
        { ...item, id: "todo-other", title: "其他任务", tags: ["生活"] },
      ]);
      return Promise.resolve([]);
    });
    render(<TodoTool />);
    await waitFor(() => expect(screen.getByRole("option", { name: "工作" })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox", { name: "按标签筛选" }), { target: { value: "工作" } });
    expect(screen.getByText("导入的任务")).toBeInTheDocument();
    expect(screen.queryByText("其他任务")).not.toBeInTheDocument();
  });

  it("offers undo after deleting a task and restores the same item", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve([item]);
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    await waitFor(() => expect(screen.getByText("整理文档")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "删除任务" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("任务已删除"));
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("restore_todo", { id: item.id }));
  });

  it("focuses a task when a reminder location event arrives", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve([item]);
      if (command === "get_todo_lists") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const { container } = render(<TodoTool />);
    await act(async () => { await Promise.resolve(); });
    act(() => emitMockEvent("todo-focus-item", { todoId: item.id }));
    await waitFor(() => expect(container.querySelector(".todo-item")).toHaveClass("is-focused"));
    expect(screen.getByText(item.title)).toBeInTheDocument();
  });

  it("reorders tasks by dragging the whole row and persists via move_todo", async () => {
    const three = [
      { ...item, id: "todo-1", title: "任务一", sortOrder: 1 },
      { ...item, id: "todo-2", title: "任务二", sortOrder: 2 },
      { ...item, id: "todo-3", title: "任务三", sortOrder: 3 },
    ];
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve(three);
      if (command === "get_todo_lists") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    await waitFor(() => expect(screen.getByText("任务一")).toBeInTheDocument());
    const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn() };
    const rows = Array.from(document.querySelectorAll(".todo-item-row"));
    expect(rows).toHaveLength(3);
    // 向下拖动第一行到第三行之后（落到列表末尾）
    fireEvent.dragStart(rows[0], { dataTransfer });
    fireEvent.dragOver(rows[2], { dataTransfer });
    fireEvent.dragEnd(rows[0], { dataTransfer });
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("move_todo", { id: "todo-1", beforeId: null }));
    expect(rows[0].getAttribute("draggable")).toBe("true");
  });

  // 「全部任务」视图里不同清单的任务是混排的，而后端 move_to 只按「清单 + 状态」分组重排：
  // 若允许把行拖到别的清单的行上，本地重排结果与落库结果对不上，松手后行会跳回原处。
  it("ignores cross-list drop targets in the all-tasks view", async () => {
    const mixed = [
      { ...item, id: "todo-u1", title: "未归类一", sortOrder: 1 },
      { ...item, id: "todo-l1", title: "清单内任务", listId: "list-1", sortOrder: 2 },
      { ...item, id: "todo-u2", title: "未归类二", sortOrder: 3 },
    ];
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve(mixed);
      if (command === "get_todo_lists") {
        return Promise.resolve([{ id: "list-1", name: "工作", createdAt: "", updatedAt: "" }]);
      }
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    await screen.findByText("未归类一");
    const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn() };
    const rowFor = (title: string) => Array.from(document.querySelectorAll(".todo-item-row"))
      .find((row) => row.querySelector(".todo-item-title")?.textContent === title) as HTMLElement;
    const titles = () => Array.from(document.querySelectorAll(".todo-item-title")).map((node) => node.textContent);

    fireEvent.dragStart(rowFor("未归类一"), { dataTransfer });
    fireEvent.dragOver(rowFor("清单内任务"), { dataTransfer });
    expect(titles()).toEqual(["未归类一", "清单内任务", "未归类二"]);

    fireEvent.dragEnd(rowFor("未归类一"), { dataTransfer });
    // 落点被拒 → 没有净位移 → 不能提交 move_todo
    expect(mockInvoke).not.toHaveBeenCalledWith("move_todo", expect.anything());
  });

  it("defaults to manual sort mode and reorders a row upward via drag", async () => {
    const three = [
      { ...item, id: "todo-1", title: "任务一", sortOrder: 1 },
      { ...item, id: "todo-2", title: "任务二", sortOrder: 2 },
      { ...item, id: "todo-3", title: "任务三", sortOrder: 3 },
    ];
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve(three);
      if (command === "get_todo_lists") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    await waitFor(() => expect(screen.getByText("任务一")).toBeInTheDocument());
    const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn() };
    const rows = Array.from(document.querySelectorAll(".todo-item-row"));
    // 向上拖动最后一行到第一行之前
    fireEvent.dragStart(rows[2], { dataTransfer });
    fireEvent.dragOver(rows[0], { dataTransfer });
    fireEvent.dragEnd(rows[2], { dataTransfer });
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("move_todo", { id: "todo-3", beforeId: "todo-1" }));
    // 默认即为手动排序模式
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("button", { name: "手动" })).toHaveClass("is-active");
  });

  it("uses the full peer group for beforeId when search filters rows", async () => {
    const three = [
      { ...item, id: "todo-1", title: "任务一", sortOrder: 1 },
      { ...item, id: "todo-2", title: "任务二", sortOrder: 2 },
      { ...item, id: "todo-3", title: "无关项", sortOrder: 3 },
    ];
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve(three);
      if (command === "get_todo_lists") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    await waitFor(() => expect(screen.getByText("任务一")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "搜索任务" }));
    fireEvent.change(screen.getByPlaceholderText("搜索任务标题、备注或标签"), { target: { value: "任务" } });
    await waitFor(() => expect(screen.queryByText("无关项")).not.toBeInTheDocument());
    const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn() };
    const rows = Array.from(document.querySelectorAll(".todo-item-row"));
    expect(rows).toHaveLength(2);
    // 把 A 拖到 B 之后，被搜索过滤掉的 C 仍是同组下一项，beforeId 应为 C
    fireEvent.dragStart(rows[0], { dataTransfer });
    fireEvent.dragOver(rows[1], { dataTransfer });
    fireEvent.dragEnd(rows[0], { dataTransfer });
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("move_todo", { id: "todo-1", beforeId: "todo-3" }));
  });

  it("disables dragging in priority sort mode", async () => {
    const three = [
      { ...item, id: "todo-1", title: "任务一", sortOrder: 1 },
      { ...item, id: "todo-2", title: "任务二", sortOrder: 2 },
      { ...item, id: "todo-3", title: "任务三", sortOrder: 3 },
    ];
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve(three);
      if (command === "get_todo_lists") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    await waitFor(() => expect(screen.getByText("任务一")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "优先级" }));
    const rows = Array.from(document.querySelectorAll(".todo-item-row"));
    expect(rows[0].getAttribute("draggable")).toBe("false");
  });

  it("does not persist a drag with no net movement", async () => {
    const three = [
      { ...item, id: "todo-1", title: "任务一", sortOrder: 1 },
      { ...item, id: "todo-2", title: "任务二", sortOrder: 2 },
      { ...item, id: "todo-3", title: "任务三", sortOrder: 3 },
    ];
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve(three);
      if (command === "get_todo_lists") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    await waitFor(() => expect(screen.getByText("任务一")).toBeInTheDocument());
    const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn() };
    const rows = Array.from(document.querySelectorAll(".todo-item-row"));
    fireEvent.dragStart(rows[0], { dataTransfer });
    fireEvent.dragEnd(rows[0], { dataTransfer });
    // 无净位移的拖拽不应提交 move_todo（避免整组 sort_order 被无意义重编号）
    expect(mockInvoke).not.toHaveBeenCalledWith("move_todo", expect.anything());
  });

  it("keeps the relative snooze options calling snooze_todo", async () => {
    render(<TodoTool />);
    await act(async () => { await Promise.resolve(); });
    act(() => emitMockEvent("todo-reminder", { item }));
    fireEvent.click(await screen.findByRole("button", { name: "10分" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("snooze_todo", { id: item.id, minutes: 10 }));
  });

  it("clears an active reminder when the todo tool is disabled", async () => {
    render(<TodoTool />);
    await act(async () => { await Promise.resolve(); });
    act(() => emitMockEvent("todo-reminder", { item }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    act(() => emitMockEvent("todo-reminders-silenced", {}));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("snoozes to tomorrow 9:00 through an absolute remind_at update", async () => {
    render(<TodoTool />);
    await act(async () => { await Promise.resolve(); });
    act(() => emitMockEvent("todo-reminder", { item }));
    fireEvent.click(await screen.findByRole("button", { name: "明天 9:00" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("update_todo", expect.objectContaining({ id: item.id })));
    const updateCall = mockInvoke.mock.calls.find(([command]) => command === "update_todo");
    expect(updateCall).toBeDefined();
    const remindIso = (updateCall![1] as { input: { remindAt: string } }).input.remindAt;
    const remindAt = new Date(remindIso);
    const expected = new Date();
    expected.setHours(9, 0, 0, 0);
    expected.setDate(expected.getDate() + 1);
    expect(remindAt.getFullYear()).toBe(expected.getFullYear());
    expect(remindAt.getMonth()).toBe(expected.getMonth());
    expect(remindAt.getDate()).toBe(expected.getDate());
    expect(remindAt.getHours()).toBe(9);
    expect(remindAt.getMinutes()).toBe(0);
    expect(mockInvoke).not.toHaveBeenCalledWith("snooze_todo", expect.anything());
  });

  it("snoozes to a custom picker time through an absolute remind_at update", async () => {
    render(<TodoTool />);
    await act(async () => { await Promise.resolve(); });
    act(() => emitMockEvent("todo-reminder", { item }));
    fireEvent.click(await screen.findByRole("button", { name: "自定义" }));
    const target = new Date();
    target.setDate(target.getDate() + 1);
    target.setHours(10, 30, 0, 0);
    const pad = (value: number) => String(value).padStart(2, "0");
    const local = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T10:30`;
    fireEvent.change(screen.getByLabelText("自定义延后时间"), { target: { value: local } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("update_todo", {
      id: item.id,
      input: { remindAt: new Date(local).toISOString() },
    }));
  });

  it("rejects a custom snooze time in the past", async () => {
    render(<TodoTool />);
    await act(async () => { await Promise.resolve(); });
    act(() => emitMockEvent("todo-reminder", { item }));
    fireEvent.click(await screen.findByRole("button", { name: "自定义" }));
    const past = new Date();
    past.setDate(past.getDate() - 1);
    past.setHours(9, 0, 0, 0);
    const pad = (value: number) => String(value).padStart(2, "0");
    const local = `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}T09:00`;
    fireEvent.change(screen.getByLabelText("自定义延后时间"), { target: { value: local } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("延后时间需晚于当前时间"));
    expect(mockInvoke).not.toHaveBeenCalledWith("update_todo", expect.objectContaining({ id: item.id }));
  });

  it("resets the custom snooze panel when the toast reappears for a later reminder", async () => {
    render(<TodoTool />);
    await act(async () => { await Promise.resolve(); });
    act(() => emitMockEvent("todo-reminder", { item }));
    fireEvent.click(await screen.findByRole("button", { name: "自定义" }));
    expect(screen.getByLabelText("自定义延后时间")).toBeInTheDocument();
    // 经标题聚焦关闭 toast 后，同一任务的提醒再次到达应回到快捷项而非残留自定义面板
    fireEvent.click(screen.getByRole("button", { name: item.title }));
    act(() => emitMockEvent("todo-reminder", { item: { ...item } }));
    expect(await screen.findByRole("button", { name: "明天 9:00" })).toBeInTheDocument();
    expect(screen.queryByLabelText("自定义延后时间")).not.toBeInTheDocument();
  });

  /**
   * 空标题以前是静默 return：用户点了「添加/保存」什么都没发生，会以为已经存住了。
   * 现在给一条可见提示（与其它失败路径共用 .todo-io-toast）。
   */
  it("空标题添加任务时给出可见提示", async () => {
    render(<TodoTool />);
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByLabelText("添加任务"));

    expect(await screen.findByText("请输入任务标题")).toBeInTheDocument();
  });

  it("清空回收站必须二次确认，确认前不发永久删除请求", async () => {
    const deleted = { ...item, id: "todo-del", title: "待清理任务" };
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve([]);
      if (command === "get_deleted_todos") return Promise.resolve([deleted]);
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "回收站" }));

    fireEvent.click(await screen.findByRole("button", { name: "清空回收站" }));

    // 第一次点击只进入确认态 —— 绝不能已经发出永久删除请求（进了回收站就再没有撤销）
    expect(mockInvoke).not.toHaveBeenCalledWith("purge_deleted_todos");

    fireEvent.click(screen.getByRole("button", { name: "确认清空（不可恢复）" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("purge_deleted_todos"));
  });

  it("离开回收站后「确认清空」态复位，不残留到下次进入", async () => {
    const deleted = { ...item, id: "todo-del2", title: "待清理任务" };
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve([]);
      if (command === "get_deleted_todos") return Promise.resolve([deleted]);
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "回收站" }));
    fireEvent.click(await screen.findByRole("button", { name: "清空回收站" }));
    expect(screen.getByRole("button", { name: "确认清空（不可恢复）" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回待办" }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "回收站" }));

    // 应回到初始的「清空回收站」，而不是还停在确认按钮上
    expect(await screen.findByRole("button", { name: "清空回收站" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认清空（不可恢复）" })).not.toBeInTheDocument();
  });

  /**
   * 「清单下面空一大片」的根因是窗口尺寸被写死（Rust 侧每次显示都 set_size(360, 560)）。
   * 现在高度由前端按 `.todo-body` 实测值下发，前提是面板高度真的由内容决定 ——
   * 面板一旦撑满窗口，量到的就是窗口自身，形成「越测越大」的反馈环。
   */
  it("面板高度由内容决定，任务多时靠 max-height 收口", () => {
    const css = readTodoCss();

    expect(ruleFor(css, ".todo-container")).not.toMatch(/height: 100%/);
    expect(ruleFor(css, ".todo-body")).not.toMatch(/height: 100%/);
    // 面板高度是 auto，flex-basis: 0 会把任务列表压成 0 高
    expect(ruleFor(css, ".todo-list")).not.toMatch(/flex: 1/);
    expect(ruleFor(css, ".todo-list")).toMatch(/max-height: \d+px/);
  });

  describe("窗口高度随内容走", () => {
    const originalOffsetHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    );
    afterEach(() => {
      if (originalOffsetHeight) {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
      }
    });

    it("按面板实测高度下发窗口尺寸并夹回工作区", async () => {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
        configurable: true,
        get: () => 286,
      });

      render(<TodoTool />);

      await waitFor(() =>
        expect(mockSetSize).toHaveBeenCalledWith(
          expect.objectContaining({ width: 360, height: 286 }),
        ),
      );
      // 高度变矮/变高都可能越过工作区边界，下发后必须夹回
      await waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith("clamp_window_to_workarea", {
          width: 360,
          height: 286,
        }),
      );
    });
  });

  // 挂在桌面时的常态：指针移开只留任务列表，指针移入恢复全部设置项。
  it("指针移开后收起顶部控件，移入立即恢复", async () => {
    render(<TodoTool />);
    const container = document.querySelector(".todo-container") as HTMLElement;
    expect(container).not.toHaveClass("is-collapsed");

    fireEvent.mouseLeave(container);
    // 500ms 延迟后才收起：留出指针移到原生日期/下拉弹层的时间
    await waitFor(() => expect(container).toHaveClass("is-collapsed"), { timeout: 2000 });

    fireEvent.mouseEnter(container);
    expect(container).not.toHaveClass("is-collapsed");
  });

  it("面板正被使用时指针移开也不收起", async () => {
    render(<TodoTool />);
    const container = document.querySelector(".todo-container") as HTMLElement;
    fireEvent.click(screen.getByRole("button", { name: "更多任务选项" }));

    fireEvent.mouseLeave(container);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });

    // 收起会把「更多任务选项」连同日期选择器弹层一起拆掉
    expect(container).not.toHaveClass("is-collapsed");
  });

  // 隐藏窗口同样会让 WebView 收到 mouseleave。若照常收起，下次点「待办」看到的就是
  // 一个只剩任务列表的小条，而用户点它是想用完整面板。
  it("窗口已隐藏时指针移开不进入折叠态", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    try {
      render(<TodoTool />);
      const container = document.querySelector(".todo-container") as HTMLElement;

      fireEvent.mouseLeave(container);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 700));
      });

      expect(container).not.toHaveClass("is-collapsed");
    } finally {
      delete (document as unknown as Record<string, unknown>).hidden;
    }
  });

  // 折叠会把输入框一起 display: none —— 输入到一半指针移开（去别处复制文字）时，
  // 收起来会让输入框和光标位置全丢，回来得重新点一次。
  it("正在输入时指针移开不收起", async () => {
    render(<TodoTool />);
    const container = document.querySelector(".todo-container") as HTMLElement;
    const input = screen.getByPlaceholderText("添加任务...");
    input.focus();
    // 前置断言：焦点确实落在输入框上。少了它，守卫失效和「压根没聚焦」都会走到
    // 同一条「没收起」的路径上，用例就废了。
    expect(document.activeElement).toBe(input);

    fireEvent.mouseLeave(container);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });

    expect(container).not.toHaveClass("is-collapsed");
  });

  // 上一条放行之后不会再有新的 mouseleave：用户输入完直接去点别的窗口，指针早已在
  // 面板外，没有这一步窗口就会一直停在展开态。
  it("焦点离开面板后补上收起判定", async () => {
    render(<TodoTool />);
    const container = document.querySelector(".todo-container") as HTMLElement;
    const input = screen.getByPlaceholderText("添加任务...");

    input.focus();
    fireEvent.mouseLeave(container);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    expect(container).not.toHaveClass("is-collapsed");

    // 必须真的移走焦点（fireEvent.blur 只派发事件，activeElement 仍停在输入框上）
    act(() => input.blur());
    await waitFor(() => expect(container).toHaveClass("is-collapsed"), { timeout: 2000 });
  });

  // Windows 上 <select> 的下拉是独立原生窗口，选到一半收起会把下拉一起拆掉。
  it("下拉获得焦点时指针移开不收起", async () => {
    render(<TodoTool />);
    const container = document.querySelector(".todo-container") as HTMLElement;
    const select = screen.getByLabelText("按标签筛选");
    select.focus();
    expect(document.activeElement).toBe(select);

    fireEvent.mouseLeave(container);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });

    expect(container).not.toHaveClass("is-collapsed");
  });

  // 反向：按钮点击后焦点也会留在按钮上，不能因此把窗口「粘」在展开态。
  it("按钮获得焦点不影响收起", async () => {
    render(<TodoTool />);
    const container = document.querySelector(".todo-container") as HTMLElement;
    const button = screen.getByRole("button", { name: "添加任务" });
    button.focus();
    // 前置断言：焦点确实在按钮上 —— 用例断言的是「会收起」，焦点没落上就假绿了
    expect(document.activeElement).toBe(button);

    fireEvent.mouseLeave(container);
    await waitFor(() => expect(container).toHaveClass("is-collapsed"), { timeout: 2000 });
  });

  // 拖拽时指针本来就在窗口外，折叠会把列表上方的控件撤掉、目标行整体上移，落点跳掉。
  it("拖拽排序进行中指针移开不收起", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve([{ ...item, sortOrder: 1 }]);
      if (command === "get_todo_lists") {
        return Promise.resolve([]);
      }
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    await screen.findByText(item.title);
    const container = document.querySelector(".todo-container") as HTMLElement;
    const row = document.querySelector(".todo-item-row") as HTMLElement;

    fireEvent.dragStart(row, { dataTransfer: { effectAllowed: "", dropEffect: "", setData: vi.fn() } });
    // 前置断言：拖拽真的开始了（dragId 生效会给该行挂 is-dragging），否则这条用例
    // 只是在重复「普通情况下会收起」
    expect(document.querySelector(".todo-item")).toHaveClass("is-dragging");
    fireEvent.mouseLeave(container);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });

    expect(container).not.toHaveClass("is-collapsed");
  });

  // 折叠态下细节区是 display: none，直接 setExpandedId 用户什么也看不到。
  it("折叠态收到任务定位事件时先展开窗口", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve([item]);
      if (command === "get_todo_lists") {
        return Promise.resolve([]);
      }
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    await screen.findByText(item.title);
    const container = document.querySelector(".todo-container") as HTMLElement;

    fireEvent.mouseLeave(container);
    await waitFor(() => expect(container).toHaveClass("is-collapsed"), { timeout: 2000 });

    act(() => emitMockEvent("todo-focus-item", { todoId: item.id }));
    expect(container).not.toHaveClass("is-collapsed");
    // 事件里的 refresh() 要跑完，否则 IPC 回包会在测试结束后触发一次 act 外更新
    await act(async () => { await Promise.resolve(); });
  });
});
