import { act, render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { clearMockListeners, emitMockFocus } from "../test/tauri-mock";
import Settings from "./Settings";
import { DEFAULT_FEATURE_IDS, DEFAULT_FEATURE_ORDER } from "../constants/toolbarFeatures";

const mockInvoke = vi.mocked(invoke);

/** happy-dom 的 DragEvent 构造不传递 clientY，改用 MouseEvent 模拟拖拽（事件名一致，React 按事件名委托，效果一致） */
function dispatchDrag(el: Element, type: string, clientY: number) {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientY }));
}

describe("Settings 悬浮窗位置恢复", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.clear();
    mockInvoke.mockResolvedValue("");
  });

  it("渲染悬浮窗位置恢复分区及三个悬浮窗入口", async () => {
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("悬浮窗位置")).toBeInTheDocument();
    expect(screen.getByText("悬浮球")).toBeInTheDocument();
    expect(screen.getAllByText("系统监控").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("番茄钟").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("button", { name: "恢复默认位置" })).toHaveLength(5);
    expect(screen.getByRole("button", { name: "全部恢复默认位置" })).toBeInTheDocument();
  });

  it("点击单个悬浮窗的恢复按钮时调用后端清除记忆", async () => {
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });

    const resetButtons = screen.getAllByRole("button", { name: "恢复默认位置" });
    await act(async () => {
      fireEvent.click(resetButtons[0]);
      await Promise.resolve();
    });

    expect(mockInvoke).toHaveBeenCalledWith("reset_window_position", { id: "orb" });
  });

  it("切换剪贴板历史开关时保存独立的启用状态", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_quick_input_history_enabled") return Promise.resolve(true);
      if (command === "get_quick_input_history_limit") return Promise.resolve(5);
      if (command === "get_quick_input_history") return Promise.resolve([]);
      if (command === "get_quick_input_snippets_enabled") return Promise.resolve(true);
      return Promise.resolve("");
    });
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "快速输入" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "剪贴板历史" }));
      await Promise.resolve();
    });

    expect(mockInvoke).toHaveBeenCalledWith("set_quick_input_history_enabled", {
      enabled: false,
    });
  });

  it("拖拽整行调整预设词顺序并保存", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_quick_input_history_enabled") return Promise.resolve(true);
      if (command === "get_quick_input_history_limit") return Promise.resolve(5);
      if (command === "get_quick_input_history") return Promise.resolve([]);
      if (command === "get_quick_input_snippets_enabled") return Promise.resolve(true);
      if (command === "get_quick_input_snippets")
        return Promise.resolve(
          JSON.stringify([
            { label: "第一条", text: "first" },
            { label: "第二条", text: "second" },
          ]),
        );
      return Promise.resolve("");
    });
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "快速输入" }));
    await act(async () => {
      await Promise.resolve();
    });

    const rows = document.querySelectorAll(".qi-snippet-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("第一条");
    expect(rows[1]).toHaveTextContent("第二条");

    await act(async () => {
      // 把「第一条」拖到「第二条」行后半区，应插入到其后
      dispatchDrag(rows[0], "dragstart", 0);
      dispatchDrag(rows[1], "dragover", 100);
      dispatchDrag(rows[0], "dragend", 0);
      await Promise.resolve();
    });

    const reordered = document.querySelectorAll(".qi-snippet-row");
    expect(reordered[0]).toHaveTextContent("第二条");
    expect(reordered[1]).toHaveTextContent("第一条");
    expect(mockInvoke).toHaveBeenCalledWith("set_quick_input_snippets", {
      snippets: JSON.stringify([
        { label: "第二条", text: "second" },
        { label: "第一条", text: "first" },
      ]),
    });
  });

  it("拖到行上半区时插入到该行之前；未移动时不落库", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_quick_input_history_enabled") return Promise.resolve(true);
      if (command === "get_quick_input_history_limit") return Promise.resolve(5);
      if (command === "get_quick_input_history") return Promise.resolve([]);
      if (command === "get_quick_input_snippets_enabled") return Promise.resolve(true);
      if (command === "get_quick_input_snippets")
        return Promise.resolve(
          JSON.stringify([
            { label: "第一条", text: "first" },
            { label: "第二条", text: "second" },
          ]),
        );
      return Promise.resolve("");
    });
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "快速输入" }));
    await act(async () => {
      await Promise.resolve();
    });

    // 按下即松开（无 dragover）：不应调用保存
    const row = document.querySelectorAll(".qi-snippet-row")[0];
    await act(async () => {
      dispatchDrag(row, "dragstart", 0);
      dispatchDrag(row, "dragend", 0);
      await Promise.resolve();
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("set_quick_input_snippets", expect.anything());

    // 把「第二条」拖到「第一条」行上半区，应插入到其前
    const firstRow = document.querySelectorAll(".qi-snippet-row")[0];
    const secondRow = document.querySelectorAll(".qi-snippet-row")[1];
    await act(async () => {
      dispatchDrag(secondRow, "dragstart", 0);
      dispatchDrag(firstRow, "dragover", -100);
      dispatchDrag(secondRow, "dragend", 0);
      await Promise.resolve();
    });

    const reordered = document.querySelectorAll(".qi-snippet-row");
    expect(reordered[0]).toHaveTextContent("第二条");
    expect(reordered[1]).toHaveTextContent("第一条");
    expect(mockInvoke).toHaveBeenCalledWith("set_quick_input_snippets", {
      snippets: JSON.stringify([
        { label: "第二条", text: "second" },
        { label: "第一条", text: "first" },
      ]),
    });
  });

  it("点击全部恢复按钮时逐个恢复所有悬浮窗", async () => {
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "全部恢复默认位置" }));
      await Promise.resolve();
    });

    expect(mockInvoke).toHaveBeenCalledWith("reset_window_position", { id: "orb" });
    expect(mockInvoke).toHaveBeenCalledWith("reset_window_position", { id: "monitor-overlay" });
    expect(mockInvoke).toHaveBeenCalledWith("reset_window_position", { id: "pomodoro-overlay" });
    expect(mockInvoke).toHaveBeenCalledWith("reset_window_position", { id: "time-overlay" });
    expect(mockInvoke).toHaveBeenCalledWith("reset_window_position", { id: "todo-overlay" });
  });

  it("恢复失败时按钮显示失败反馈", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "reset_window_position") {
        return Promise.reject(new Error("reset failed"));
      }
      return Promise.resolve("");
    });
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });

    const resetButtons = screen.getAllByRole("button", { name: "恢复默认位置" });
    await act(async () => {
      fireEvent.click(resetButtons[0]);
      await Promise.resolve();
    });

    expect(screen.getByText("恢复失败")).toBeInTheDocument();
  });

  it("加载并保存贴图边框颜色和粗细", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_pin_border_color") return Promise.resolve("#12abEF");
      if (command === "get_pin_border_width") return Promise.resolve(4);
      return Promise.resolve("");
    });
    render(<Settings />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // 配置按页签懒加载：进入截图页后等待该页配置读取完成
    fireEvent.click(screen.getByRole("button", { name: "截图/录屏" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const color = screen.getByLabelText("贴图边框颜色") as HTMLInputElement;
    const width = screen.getByRole("combobox", { name: "贴图边框粗细" }) as HTMLSelectElement;
    expect(color.value).toBe("#12abef");
    expect(width.value).toBe("4");

    await act(async () => {
      fireEvent.change(color, { target: { value: "#abcdef" } });
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_pin_border_color", { color: "#ABCDEF" });

    await act(async () => {
      fireEvent.change(width, { target: { value: "2" } });
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_pin_border_width", { width: 2 });
  });

  it("does not let a late initial read overwrite a border edit", async () => {
    let resolveColor!: (value: string) => void;
    const colorRead = new Promise<string>((resolve) => {
      resolveColor = resolve;
    });
    mockInvoke.mockImplementation((command) => {
      if (command === "get_pin_border_color") return colorRead;
      if (command === "get_pin_border_width") return Promise.resolve(1);
      return Promise.resolve("");
    });

    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "截图/录屏" }));

    const color = screen.getByLabelText("贴图边框颜色") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(color, { target: { value: "#abcdef" } });
      await Promise.resolve();
    });

    await act(async () => {
      resolveColor("#123456");
      await colorRead;
    });

    expect(color.value).toBe("#abcdef");
    expect(mockInvoke).toHaveBeenCalledWith("set_pin_border_color", { color: "#ABCDEF" });
  });

  it("rolls back to the loaded value when an early border save fails", async () => {
    let resolveColor!: (value: string) => void;
    const colorRead = new Promise<string>((resolve) => {
      resolveColor = resolve;
    });
    let rejectSave!: (reason?: unknown) => void;
    const colorSave = new Promise<void>((_, reject) => {
      rejectSave = reject;
    });
    mockInvoke.mockImplementation((command) => {
      if (command === "get_pin_border_color") return colorRead;
      if (command === "get_pin_border_width") return Promise.resolve(1);
      if (command === "set_pin_border_color") return colorSave;
      return Promise.resolve("");
    });

    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "截图/录屏" }));
    const color = screen.getByLabelText("贴图边框颜色") as HTMLInputElement;
    fireEvent.change(color, { target: { value: "#abcdef" } });

    await act(async () => {
      rejectSave(new Error("save failed"));
      await Promise.resolve();
    });
    expect(color.value).toBe("#abcdef");

    await act(async () => {
      resolveColor("#123456");
      await colorRead;
    });
    expect(color.value).toBe("#123456");
  });

  it("主题下拉框提供浅色、深色与跟随系统选项", async () => {
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });

    const select = screen.getByLabelText("主题") as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "浅色" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "深色" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "跟随系统" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(select, { target: { value: "system" } });
    });
    expect(select).toHaveValue("system");
  });
});

describe("Settings 窗口重新聚焦时同步工具启停状态", () => {
  it("悬浮球面板禁用系统监控后，重新聚焦设置页使「启动时自动打开」勾选框随之后置为禁用", async () => {
    let systemMonitorEnabled = true;
    mockInvoke.mockImplementation((command) => {
      switch (command) {
        case "get_system_monitor_enabled":
          return Promise.resolve(systemMonitorEnabled);
        case "get_pomodoro_enabled":
          return Promise.resolve(true);
        case "get_todo_enabled":
          return Promise.resolve(true);
        case "get_timer_enabled":
          return Promise.resolve(true);
        case "get_tools_autostart":
          return Promise.resolve(["system-monitor"]);
        default:
          return Promise.resolve("");
      }
    });

    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "系统监控" }));
    await act(async () => {
      await Promise.resolve();
    });

    const checkbox = () =>
      screen.getByRole("checkbox", {
        name: "启动时自动打开",
      }) as HTMLInputElement;
    // 挂载快照为“已启用 + 已在自动打开列表” → 勾选框可用且勾选
    expect(checkbox()).toBeEnabled();
    expect(checkbox()).toBeChecked();

    // 模拟在悬浮球面板中禁用该系统监控工具
    systemMonitorEnabled = false;
    await act(async () => {
      emitMockFocus(false);
      emitMockFocus(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    // 重新聚焦后应读取到最新启停状态：勾选框被禁用并提示先启用工具
    expect(checkbox()).toBeDisabled();
    expect(checkbox()).toBeChecked();
    expect(screen.getByText("该工具未启用，需先在悬浮球面板中启用")).toBeInTheDocument();
  });
});

describe("Settings 文字工具栏按钮顺序", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.clear();
  });

  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("按默认顺序渲染功能行；禁用/启用与拖拽排序均持久化", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_toolbar_features") return Promise.resolve([...DEFAULT_FEATURE_IDS]);
      if (command === "get_toolbar_feature_order") {
        return Promise.resolve([...DEFAULT_FEATURE_ORDER]);
      }
      if (command === "tts_get_voices") return Promise.resolve([]);
      return Promise.resolve("");
    });

    render(<Settings />);
    await act(async () => {
      await flush();
    });

    fireEvent.click(screen.getByRole("button", { name: "文字工具栏" }));
    await act(async () => {
      await flush();
    });

    const rows = document.querySelectorAll(".toolbar-order-row");
    expect(rows).toHaveLength(DEFAULT_FEATURE_ORDER.length);
    expect(rows[0]).toHaveTextContent("复制");
    expect(rows[1]).toHaveTextContent("搜索");

    // 关掉「复制」：调用 set_toolbar_features 持久化，行保留但开关置灰
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "禁用复制" }));
      await flush();
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_toolbar_features", {
      features: expect.not.arrayContaining(["copy"]),
    });

    // 拖拽将「复制」移到「搜索」之后：调用 set_toolbar_feature_order 持久化新顺序
    await act(async () => {
      const firstRow = document.querySelectorAll(".toolbar-order-row")[0];
      const secondRow = document.querySelectorAll(".toolbar-order-row")[1];
      dispatchDrag(firstRow, "dragstart", 0);
      dispatchDrag(secondRow, "dragover", 100);
      dispatchDrag(firstRow, "dragend", 0);
      await flush();
    });

    const orderCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "set_toolbar_feature_order");
    expect(orderCalls).toHaveLength(1);
    const savedOrder = orderCalls[0][1] as { order: string[] };
    expect(savedOrder.order[0]).toBe("search");
    expect(savedOrder.order[1]).toBe("copy");
  });
});

describe("Settings 快速输入剪贴板历史管理", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.clear();
  });

  /** 提供一条收藏 + 一条普通历史记录的后端响应 */
  const mockHistoryData = (
    history: Array<{ preview: string; text: string; favorite?: boolean }>,
  ) => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_quick_input_history") return Promise.resolve(history);
      if (command === "get_quick_input_history_enabled") return Promise.resolve(true);
      if (command === "get_quick_input_history_limit") return Promise.resolve(5);
      if (command === "get_quick_input_snippets_enabled") return Promise.resolve(true);
      if (command === "get_quick_input_snippets") return Promise.resolve("");
      return Promise.resolve("");
    });
  };

  const openQuickInputTab = async () => {
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "快速输入" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  it("渲染收藏星标与单条删除操作，点击收藏调用后端并切换状态", async () => {
    mockHistoryData([
      { preview: "固定片段", text: "pinned", favorite: true },
      { preview: "普通片段", text: "normal", favorite: false },
    ]);
    await openQuickInputTab();

    const rows = document.querySelectorAll(".qi-history-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByRole("button", { name: "取消收藏" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收藏" })).toBeInTheDocument();

    // 收藏普通片段
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "收藏" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_quick_input_history_favorite", {
      text: "normal",
      favorite: true,
    });
    // 后端返回后应重新拉取列表（即使 mock 返回相同数据，也证明走了刷新路径）
    expect(mockInvoke).toHaveBeenCalledWith("get_quick_input_history");

    // 取消收藏固定片段
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "取消收藏" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_quick_input_history_favorite", {
      text: "pinned",
      favorite: false,
    });
  });

  it("点击单条删除按钮时按文本调用后端", async () => {
    mockHistoryData([
      { preview: "敏感记录", text: "secret", favorite: false },
      { preview: "普通记录", text: "normal", favorite: false },
    ]);
    await openQuickInputTab();

    const secretRow = Array.from(document.querySelectorAll(".qi-history-row")).find((row) =>
      row.textContent?.includes("敏感记录"),
    ) as HTMLElement;
    const deleteButton = secretRow.querySelector('button[aria-label="删除"]') as HTMLButtonElement;
    expect(deleteButton).toBeTruthy();

    await act(async () => {
      fireEvent.click(deleteButton);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockInvoke).toHaveBeenCalledWith("remove_quick_input_history_item", {
      text: "secret",
    });
  });
});
