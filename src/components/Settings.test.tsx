import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { clearMockListeners, emitMockEvent, emitMockFocus } from "../test/tauri-mock";
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

  it("渲染悬浮窗位置恢复分区及悬浮窗入口", async () => {
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("悬浮窗位置")).toBeInTheDocument();
    expect(screen.getByText("悬浮球")).toBeInTheDocument();
    expect(screen.getAllByText("系统监控").length).toBeGreaterThanOrEqual(1);
    // 番茄钟已并入时间工具，不再有独立的窗口位置入口
    expect(screen.getAllByText("时间工具").length).toBeGreaterThanOrEqual(1);
    // 悬浮球 / 系统监控 / 时间工具 / 待办清单 / 系统清理 / 便利贴
    expect(screen.getAllByText("系统清理").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("便利贴").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("button", { name: "恢复默认位置" })).toHaveLength(6);
    expect(screen.getByRole("button", { name: "全部恢复默认位置" })).toBeInTheDocument();
  });

  it("悬浮窗位置的说明文案与下方入口逐项一致，不再提及已并入的番茄钟", async () => {
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });

    const hint = screen.getByText(/会记住上次拖拽的位置/);
    // 文案由 WINDOW_POSITION_TARGETS 派生，顺序、顿号分隔与名称都应与下方入口一致
    expect(hint.textContent).toMatch(
      /^悬浮球、系统监控、时间工具、待办清单、系统清理、便利贴会记住/,
    );
    expect(hint.textContent).not.toContain("番茄钟");
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
    expect(mockInvoke).toHaveBeenCalledWith("reset_window_position", { id: "time-overlay" });
    expect(mockInvoke).toHaveBeenCalledWith("reset_window_position", { id: "todo-overlay" });
    expect(mockInvoke).toHaveBeenCalledWith("reset_window_position", {
      id: "system-cleaner-overlay",
    });
    expect(mockInvoke).toHaveBeenCalledWith("reset_window_position", {
      id: "sticky-notes-manager",
    });
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

describe("Settings 快速输入音效反馈", () => {
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

  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.clear();
    mockInvoke.mockImplementation((command) => {
      if (command === "get_quick_input_history") return Promise.resolve([]);
      if (command === "get_quick_input_sound_enabled") return Promise.resolve(true);
      if (command === "get_quick_input_sound_style") return Promise.resolve("standard");
      if (command === "get_quick_input_sound_volume") return Promise.resolve(45);
      return Promise.resolve("");
    });
  });

  it("渲染开关与三档参数，默认从后端读取", async () => {
    await openQuickInputTab();
    expect(screen.getByRole("switch", { name: "音效反馈" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // 风格下拉只有 minimal / standard 两档（none 不对外暴露）
    const style = screen.getByLabelText("音效风格") as HTMLSelectElement;
    expect(Array.from(style.options).map((o) => o.value)).toEqual(["standard", "minimal"]);
    expect(style.value).toBe("standard");
    expect((screen.getByLabelText("音量") as HTMLInputElement).value).toBe("45");
  });

  it("关闭音效时参数控件随之禁用", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_quick_input_history") return Promise.resolve([]);
      if (command === "get_quick_input_sound_enabled") return Promise.resolve(false);
      if (command === "get_quick_input_sound_style") return Promise.resolve("standard");
      if (command === "get_quick_input_sound_volume") return Promise.resolve(45);
      return Promise.resolve("");
    });
    await openQuickInputTab();
    expect(screen.getByLabelText("音效风格")).toBeDisabled();
    expect(screen.getByLabelText("音量")).toBeDisabled();
    // 试听按钮也应禁用（关闭状态下不该能试听）
    expect(screen.getByRole("button", { name: /试听「唤出」/ })).toBeDisabled();
  });

  it("切换开关时保存启用状态", async () => {
    await openQuickInputTab();
    const toggle = screen.getByRole("switch", { name: "音效反馈" });
    await act(async () => {
      fireEvent.click(toggle);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_quick_input_sound_enabled", { enabled: false });
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("切换风格时保存并试听该风格的样本音", async () => {
    await openQuickInputTab();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("音效风格"), { target: { value: "minimal" } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_quick_input_sound_style", { style: "minimal" });
    // 极简风格没有刻度音，用「确认」当样本
    expect(mockInvoke).toHaveBeenCalledWith("preview_quick_input_sound", { cue: "confirm" });
  });

  it("拖动音量时保存并夹取到 0-100", async () => {
    await openQuickInputTab();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("音量"), { target: { value: "70" } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_quick_input_sound_volume", { volume: 70 });
  });

  it("音量拖到 0 时不再试听（否则用户按了没反应会以为试听坏了）", async () => {
    await openQuickInputTab();
    const volume = screen.getByLabelText("音量");
    await act(async () => {
      fireEvent.change(volume, { target: { value: "0" } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    mockInvoke.mockClear();
    await act(async () => {
      fireEvent.mouseUp(volume);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("preview_quick_input_sound", {
      cue: "confirm",
    });
  });

  it("极简风格下禁用「划过」试听按钮", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "get_quick_input_history") return Promise.resolve([]);
      if (command === "get_quick_input_sound_enabled") return Promise.resolve(true);
      if (command === "get_quick_input_sound_style") return Promise.resolve("minimal");
      if (command === "get_quick_input_sound_volume") return Promise.resolve(45);
      return Promise.resolve("");
    });
    await openQuickInputTab();
    expect(screen.getByRole("button", { name: /试听「划过」/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /试听「确认」/ })).not.toBeDisabled();
  });

  it("迟到的初始读取不得覆盖用户刚改的风格", async () => {
    let resolveStyle!: (value: string) => void;
    const styleRead = new Promise<string>((resolve) => {
      resolveStyle = resolve;
    });
    mockInvoke.mockImplementation((command) => {
      if (command === "get_quick_input_history") return Promise.resolve([]);
      if (command === "get_quick_input_sound_enabled") return Promise.resolve(true);
      if (command === "get_quick_input_sound_style") return styleRead;
      if (command === "get_quick_input_sound_volume") return Promise.resolve(45);
      return Promise.resolve("");
    });
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "快速输入" }));

    const style = screen.getByLabelText("音效风格") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(style, { target: { value: "minimal" } });
      await Promise.resolve();
    });
    await act(async () => {
      resolveStyle("standard");
      await styleRead;
    });
    expect(style.value).toBe("minimal");
  });
});

describe("Settings 时间工具页签（番茄钟已并入）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.clear();
    mockInvoke.mockImplementation((command) => {
      switch (command) {
        case "get_pomodoro_config":
          return Promise.resolve(
            JSON.stringify({
              workMinutes: 45,
              shortBreakMinutes: 10,
              longBreakMinutes: 20,
              roundsBeforeLongBreak: 2,
              autoStartNext: true,
              notifySoundType: "tone",
            }),
          );
        // 真实契约是 Vec<String>；不写这一支会落到下面的 default 返回字符串，
        // 让「启动时自动打开」的快照同步拿到一个非数组（与后端行为不符）。
        case "get_tools_autostart":
          return Promise.resolve([]);
        default:
          return Promise.resolve("");
      }
    });
  });

  it("不再有独立的「番茄钟」页签，配置随「时间工具」页签一起载入", async () => {
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });

    // 独立页签必须消失，否则用户会在两处看到同一份番茄钟配置
    expect(screen.queryByRole("button", { name: "番茄钟" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "时间工具" }));
    await act(async () => {
      await Promise.resolve();
    });

    // 番茄钟配置与时间工具自身的开关在同一页签，且取后端真值（非默认 25）
    await waitFor(() => expect(screen.getByLabelText("专注时长")).toHaveValue("45"));
    expect(screen.getByLabelText("短休息")).toHaveValue("10");
    expect(screen.getByLabelText("长休息")).toHaveValue("20");
    expect(screen.getByLabelText("长休息间隔")).toHaveValue("2");
    expect(screen.getByLabelText("到点自动开始下一阶段")).toBeChecked();
    expect(screen.getByLabelText("到点提醒")).toHaveValue("tone");
  });

  it("时间工具页签仍带自身的开关与「启动时自动打开」，且没有番茄钟的独立自启项", async () => {
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "时间工具" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByLabelText("启用倒计时提醒")).toBeInTheDocument();
    expect(screen.getByLabelText("显示农历日期")).toBeInTheDocument();
    // 只保留一个「启动时自动打开」（归属时间工具整体），不再有番茄钟独立勾选框
    expect(screen.getAllByLabelText("启动时自动打开")).toHaveLength(1);
  });

  it("老配置里的 pomodoro 自启项会归一化成 timer（勾选态正确，且能被 UI 关掉）", async () => {
    mockInvoke.mockImplementation((command) => {
      switch (command) {
        case "get_system_monitor_enabled":
          return Promise.resolve(false);
        case "get_todo_enabled":
          return Promise.resolve(false);
        case "get_timer_enabled":
          return Promise.resolve(true);
        case "get_tools_autostart":
          // 升级前勾过「番茄钟」自启：后端存的是旧 ID，且 set_tools_autostart 不做迁移
          return Promise.resolve(["pomodoro"]);
        default:
          return Promise.resolve("");
      }
    });

    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "时间工具" }));
    await act(async () => {
      await Promise.resolve();
    });

    const checkbox = screen.getByRole("checkbox", {
      name: "启动时自动打开",
    }) as HTMLInputElement;
    // 不归一化时这里会是**未勾选**（勾选框只认 "timer"），而 FloatingOrb 又会把
    // "pomodoro" 别名成 "timer" 照常自动打开 —— 用户永远关不掉。
    expect(checkbox).toBeChecked();

    // 取消勾选后写回后端的数组里不应再残留 "pomodoro"（否则下次启动照旧打开）
    fireEvent.click(checkbox);
    await act(async () => {
      await Promise.resolve();
    });
    const saved = mockInvoke.mock.calls.filter(([c]) => c === "set_tools_autostart").pop();
    expect(saved?.[1]).toEqual({ ids: [] });
  });
});

describe("Settings 自启动勾选框的加载闸门", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.clear();
    mockInvoke.mockResolvedValue("");
  });

  it("自启列表读到之前勾选框不可点（否则全量写入会抹掉已有配置）", async () => {
    let resolveAutostart: ((value: string[]) => void) | undefined;
    mockInvoke.mockImplementation((command) => {
      if (command === "get_system_monitor_enabled") return Promise.resolve(true);
      if (command === "get_tools_autostart") {
        // 悬着不 resolve：模拟后端快照还没回来
        return new Promise<string[]>((resolve) => {
          resolveAutostart = resolve;
        });
      }
      return Promise.resolve("");
    });

    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "系统监控" }));
    await act(async () => {
      await Promise.resolve();
    });

    const checkbox = screen.getByRole("checkbox", { name: "启动时自动打开" });
    // autostartIds 初值是 []，而 set_tools_autostart 是全量覆盖语义：
    // 此时允许点击 ⇒ 一次点击就把原有的自启项（待办 / 时间工具）整份抹掉。
    expect(checkbox).toBeDisabled();
    expect(screen.getByText("正在读取配置…")).toBeInTheDocument();

    fireEvent.click(checkbox);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("set_tools_autostart", expect.anything());

    // 快照回来（这里模拟用户之前勾过「待办」）之后才允许改
    await act(async () => {
      resolveAutostart?.(["todo"]);
      await Promise.resolve();
    });
    expect(checkbox).not.toBeDisabled();
    expect(screen.queryByText("正在读取配置…")).toBeNull();
  });
});

describe("Settings 系统监控配置必须跟随浮窗改动", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.clear();
    mockInvoke.mockResolvedValue("");
  });

  const lastSavedMonitorConfig = () =>
    JSON.parse(
      String(
        (
          mockInvoke.mock.calls
            .filter(([command]) => command === "set_system_monitor_config")
            .pop()?.[1] as { config: string } | undefined
        )?.config,
      ),
    );

  const mockStoredMonitorConfig = (stored: Record<string, unknown>) =>
    mockInvoke.mockImplementation((command) => {
      if (command === "get_system_monitor_enabled") return Promise.resolve(true);
      if (command === "get_tools_autostart") return Promise.resolve<string[]>([]);
      if (command === "get_system_monitor_config") return Promise.resolve(JSON.stringify(stored));
      return Promise.resolve("");
    });

  const openMonitorTab = async () => {
    render(<Settings />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "系统监控" }));
    await act(async () => {
      await Promise.resolve();
    });
  };

  it("浮窗里改了显示模式后，本窗口改刷新间隔不得把它写回旧值", async () => {
    mockStoredMonitorConfig({ intervalMs: 1000, displayMode: "full", layout: "e" });
    await openMonitorTab();

    // 用户在监控浮窗里点了标题栏切到「迷你」：该窗口会广播这条事件。
    // 本窗口若不订阅，就会一直抱着 displayMode="full" 的陈旧副本，
    // 之后改「刷新间隔」时整份回写，把用户的显示模式静默改回去。
    await act(async () => {
      emitMockEvent("levitaire-system-monitor-config-changed", {
        intervalMs: 1000,
        displayMode: "mini",
        layout: "e",
      });
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText("刷新间隔"), { target: { value: "2000" } });
      await Promise.resolve();
    });

    expect(lastSavedMonitorConfig()).toEqual({
      intervalMs: 2000,
      displayMode: "mini",
      layout: "e",
    });
  });

  /**
   * 与上一条同类、但漏点更隐蔽：广播比较函数里漏掉 `layout` 时，"只在浮窗里换了样式"
   * 会被当成自己发出的回声而跳过，设置页于是抱着旧样式；随后任何一次改动都会把它整份
   * 写回去 —— 用户在浮窗里选的样式被静默改回。
   */
  it("浮窗里换了显示样式后，本窗口改刷新间隔不得把它写回旧样式", async () => {
    mockStoredMonitorConfig({ intervalMs: 1000, displayMode: "full", layout: "e" });
    await openMonitorTab();

    await act(async () => {
      emitMockEvent("levitaire-system-monitor-config-changed", {
        intervalMs: 1000,
        displayMode: "full",
        layout: "b",
      });
      await Promise.resolve();
    });

    // 设置页里的样式下拉也要跟着切到 b（否则显示的是旧样式，用户看不到真实值）
    expect((screen.getByLabelText("显示样式") as HTMLSelectElement).value).toBe("b");

    await act(async () => {
      fireEvent.change(screen.getByLabelText("刷新间隔"), { target: { value: "5000" } });
      await Promise.resolve();
    });

    expect(lastSavedMonitorConfig()).toEqual({
      intervalMs: 5000,
      displayMode: "full",
      layout: "b",
    });
  });

  it("设置页切换显示样式时把 layout 一起写进配置", async () => {
    mockStoredMonitorConfig({ intervalMs: 1000, displayMode: "full", layout: "e" });
    await openMonitorTab();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("显示样式"), { target: { value: "d" } });
      await Promise.resolve();
    });

    expect(lastSavedMonitorConfig()).toEqual({
      intervalMs: 1000,
      displayMode: "full",
      layout: "d",
    });
  });

  it("迷你模式下显示样式下拉不可用（mini 形态固定）", async () => {
    mockStoredMonitorConfig({ intervalMs: 1000, displayMode: "mini", layout: "e" });
    await openMonitorTab();

    expect(screen.getByLabelText("显示样式")).toBeDisabled();
    expect(screen.getByText("迷你模式形态固定，切回标准后生效")).toBeInTheDocument();
  });
});
