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
});
