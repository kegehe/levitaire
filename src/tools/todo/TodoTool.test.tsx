import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TodoTool from "./TodoTool";
import { clearMockListeners, emitMockEvent } from "../../test/tauri-mock";

const mockInvoke = vi.mocked(invoke);
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

  it("labels the default inbox and removes the list filter in trash", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve([]);
      if (command === "get_todo_lists") return Promise.resolve([{ id: "inbox", name: "Inbox", createdAt: "", updatedAt: "" }]);
      return Promise.resolve(undefined);
    });
    render(<TodoTool />);
    await waitFor(() => expect(screen.getByRole("option", { name: "收件箱" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "回收站" }));
    expect(screen.queryByRole("combobox", { name: "Todo list" })).not.toBeInTheDocument();
    expect(screen.getByText("回收站")).toBeInTheDocument();
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
      if (command === "get_todo_lists") return Promise.resolve([{ id: "inbox", name: "Inbox", createdAt: "", updatedAt: "" }]);
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
      if (command === "get_todo_lists") return Promise.resolve([{ id: "inbox", name: "Inbox", createdAt: "", updatedAt: "" }]);
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

  it("defaults to manual sort mode and reorders a row upward via drag", async () => {
    const three = [
      { ...item, id: "todo-1", title: "任务一", sortOrder: 1 },
      { ...item, id: "todo-2", title: "任务二", sortOrder: 2 },
      { ...item, id: "todo-3", title: "任务三", sortOrder: 3 },
    ];
    mockInvoke.mockImplementation((command) => {
      if (command === "get_todos") return Promise.resolve(three);
      if (command === "get_todo_lists") return Promise.resolve([{ id: "inbox", name: "Inbox", createdAt: "", updatedAt: "" }]);
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
      if (command === "get_todo_lists") return Promise.resolve([{ id: "inbox", name: "Inbox", createdAt: "", updatedAt: "" }]);
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
      if (command === "get_todo_lists") return Promise.resolve([{ id: "inbox", name: "Inbox", createdAt: "", updatedAt: "" }]);
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
      if (command === "get_todo_lists") return Promise.resolve([{ id: "inbox", name: "Inbox", createdAt: "", updatedAt: "" }]);
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
});
