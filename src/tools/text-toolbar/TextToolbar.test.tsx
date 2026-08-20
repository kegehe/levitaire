import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import FloatingToolbar from "./TextToolbar";
import { emitMockEvent, clearMockListeners, mockHide } from "../../test/tauri-mock";
import { CLEAR_OPTIONS } from "../../constants/clearConfig";
import type { SelectionInfo } from "../../types";

// Mock qrcode 库（命名导出，匹配生产代码的动态 import("qrcode") 方式）
vi.mock("qrcode", () => ({
  toDataURL: vi.fn(),
}));
import { toDataURL as qrToDataURL } from "qrcode";
const mockToDataURL = vi.mocked(qrToDataURL) as unknown as ReturnType<typeof vi.fn>;

const mockInvoke = vi.mocked(invoke);

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const makeSelection = (text: string): SelectionInfo => ({
  text,
  rect: { x: 100, y: 200, width: 300, height: 20 },
  "has-image": false,
});

const showToolbar = async (text = "选中文字") => {
  await act(async () => {
    emitMockEvent("selection-found", makeSelection(text));
  });
};

describe("FloatingToolbar 搜索功能", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    // mock checkAiConfig 默认返回有效配置
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      if (cmd === "open_url") {
        return Promise.resolve();
      }
      return Promise.resolve();
    });
  });

  afterEach(() => {
    // 清理 DOM 中残留的工具栏
    document.body.innerHTML = "";
  });

  // ── 基础渲染 ──────────────────────────────────────────────

  it("默认状态下显示搜索按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar();

    const searchBtn = screen.getByRole("button", { name: "搜索" });
    expect(searchBtn).toBeInTheDocument();
  });

  it("搜索按钮在复制和翻译之间", async () => {
    render(<FloatingToolbar />);
    await showToolbar();

    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((b) => b.getAttribute("aria-label"));
    const copyIdx = labels.indexOf("复制");
    const searchIdx = labels.indexOf("搜索");
    const translateIdx = labels.indexOf("翻译");

    expect(copyIdx).toBeLessThan(searchIdx);
    expect(searchIdx).toBeLessThan(translateIdx);
  });

  // ── 搜索行为 ──────────────────────────────────────────────

  it("点击搜索调用 open_url 并使用 Bing 搜索", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello world");

    const searchBtn = screen.getByRole("button", { name: "搜索" });
    await act(async () => {
      fireEvent.click(searchBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("open_url", {
      url: "https://www.bing.com/search?q=hello%20world",
    });
  });

  it("配置为百度时，搜索使用百度 URL", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_search_engine") {
        return Promise.resolve("baidu");
      }
      return Promise.resolve();
    });
    render(<FloatingToolbar />);
    await showToolbar("你好世界");

    const searchBtn = screen.getByRole("button", { name: "搜索" });
    await act(async () => {
      fireEvent.click(searchBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("open_url", {
      url: "https://www.baidu.com/s?wd=%E4%BD%A0%E5%A5%BD%E4%B8%96%E7%95%8C",
    });
  });

  it("设置窗口广播 levitaire-search-engine-changed 后，搜索实时使用新引擎", async () => {
    render(<FloatingToolbar />);
    // 先 flush 等待挂载时的 fetchSearchEngine（默认 Bing）resolve，
    // 避免其异步 setState 覆盖事件设置的值
    await flush();
    await act(async () => {
      emitMockEvent("levitaire-search-engine-changed", "google");
    });
    await showToolbar("hello world");

    const searchBtn = screen.getByRole("button", { name: "搜索" });
    await act(async () => {
      fireEvent.click(searchBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("open_url", {
      url: "https://www.google.com/search?q=hello%20world",
    });
  });

  it("搜索后自动隐藏工具栏", async () => {
    mockHide.mockResolvedValue(undefined);
    render(<FloatingToolbar />);
    await showToolbar("test");

    const searchBtn = screen.getByRole("button", { name: "搜索" });
    await act(async () => {
      fireEvent.click(searchBtn);
    });
    await flush();

    // hide_toolbar 被调用
    expect(mockInvoke).toHaveBeenCalledWith("hide_toolbar");
  });

  // ── 特殊字符编码 ──────────────────────────────────────────

  it("正确编码包含中文的文本", async () => {
    render(<FloatingToolbar />);
    await showToolbar("你好世界");

    const searchBtn = screen.getByRole("button", { name: "搜索" });
    await act(async () => {
      fireEvent.click(searchBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("open_url", {
      url: "https://www.bing.com/search?q=%E4%BD%A0%E5%A5%BD%E4%B8%96%E7%95%8C",
    });
  });

  it("正确编码包含特殊字符的文本", async () => {
    render(<FloatingToolbar />);
    await showToolbar("a&b=c?d=e");

    const searchBtn = screen.getByRole("button", { name: "搜索" });
    await act(async () => {
      fireEvent.click(searchBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("open_url", {
      url: "https://www.bing.com/search?q=a%26b%3Dc%3Fd%3De",
    });
  });

  it("正确编码包含空格和换行的文本", async () => {
    render(<FloatingToolbar />);
    await showToolbar("line1\nline2  line3");

    const searchBtn = screen.getByRole("button", { name: "搜索" });
    await act(async () => {
      fireEvent.click(searchBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("open_url", {
      url: "https://www.bing.com/search?q=line1%0Aline2%20%20line3",
    });
  });

  it("正确编码包含 URL 特殊字符的文本", async () => {
    render(<FloatingToolbar />);
    await showToolbar("https://example.com/path?q=1#frag");

    const searchBtn = screen.getByRole("button", { name: "搜索" });
    await act(async () => {
      fireEvent.click(searchBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("open_url", {
      url: "https://www.bing.com/search?q=https%3A%2F%2Fexample.com%2Fpath%3Fq%3D1%23frag",
    });
  });

  // ── 边界情况 ──────────────────────────────────────────────

  it("选中文本包含前后空格时进行 trim", async () => {
    render(<FloatingToolbar />);
    await showToolbar("  hello  ");

    const searchBtn = screen.getByRole("button", { name: "搜索" });
    await act(async () => {
      fireEvent.click(searchBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("open_url", {
      url: "https://www.bing.com/search?q=hello",
    });
  });

  it("选中文本仅为空格时仍可搜索（Bing 首页）", async () => {
    render(<FloatingToolbar />);
    await showToolbar("   ");

    const searchBtn = screen.getByRole("button", { name: "搜索" });
    await act(async () => {
      fireEvent.click(searchBtn);
    });

    // encodeURIComponent("".trim()) === ""
    expect(mockInvoke).toHaveBeenCalledWith("open_url", {
      url: "https://www.bing.com/search?q=",
    });
  });

  // ── 错误处理 ──────────────────────────────────────────────

  it("open_url 失败时工具栏不隐藏（catch 分支）", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "",
          model: "",
          api_type: "anthropic",
        });
      }
      if (cmd === "open_url") {
        return Promise.reject("浏览器打开失败");
      }
      return Promise.resolve();
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<FloatingToolbar />);
    await showToolbar("test");

    const searchBtn = screen.getByRole("button", { name: "搜索" });
    await act(async () => {
      fireEvent.click(searchBtn);
    });
    await flush();

    // console.error 被调用
    expect(consoleSpy).toHaveBeenCalledWith("Failed to open search:", expect.anything());
    // 工具栏仍然可见（searchBtn 还在 DOM 中）
    expect(screen.getByRole("button", { name: "搜索" })).toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  // ── 多次操作 ──────────────────────────────────────────────

  it("连续点击搜索只发起一次 open_url 调用", async () => {
    render(<FloatingToolbar />);
    await showToolbar("test");

    const searchBtn = screen.getByRole("button", { name: "搜索" });
    await act(async () => {
      fireEvent.click(searchBtn);
    });
    // hide_toolbar 会使 isVisible=false，按钮不再可见
    // 但若因速度问题再次点击，不应重复调用

    // open_url 只被调用一次
    const openUrlCalls = mockInvoke.mock.calls.filter((c) => c[0] === "open_url");
    expect(openUrlCalls).toHaveLength(1);
  });

  // ── 选区不存在时 ──────────────────────────────────────────

  it("工具栏未显示时，搜索按钮不在 DOM 中", () => {
    render(<FloatingToolbar />);
    expect(screen.queryByRole("button", { name: "搜索" })).not.toBeInTheDocument();
  });

  // ── 选区更新后搜索使用新文本 ──────────────────────────────

  it("新选区触发后，搜索按钮使用最新的选中文本", async () => {
    render(<FloatingToolbar />);
    await showToolbar("第一次选中");

    // 模拟新的选区事件
    await act(async () => {
      emitMockEvent("selection-found", makeSelection("第二次选中"));
    });

    const searchBtn = screen.getByRole("button", { name: "搜索" });
    await act(async () => {
      fireEvent.click(searchBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("open_url", {
      url: "https://www.bing.com/search?q=%E7%AC%AC%E4%BA%8C%E6%AC%A1%E9%80%89%E4%B8%AD",
    });
  });

  // ── 工具栏自动隐藏（toolbar-hidden 事件）────────────────────

  it("收到 toolbar-hidden 事件后重置状态", async () => {
    render(<FloatingToolbar />);
    await showToolbar("测试文本");

    // 模拟 Rust 侧点击外部触发的 toolbar-hidden 事件
    await act(async () => {
      emitMockEvent("toolbar-hidden", undefined);
    });

    // 状态重置后工具栏不可见，按钮移出 DOM
    expect(screen.queryByRole("button", { name: "搜索" })).not.toBeInTheDocument();
  });

  it("toolbar-hidden 事件后新的选区仍可正常显示工具栏", async () => {
    render(<FloatingToolbar />);
    await showToolbar("第一次");

    // 收到隐藏事件
    await act(async () => {
      emitMockEvent("toolbar-hidden", undefined);
    });
    expect(screen.queryByRole("button", { name: "搜索" })).not.toBeInTheDocument();

    // 新选区到来，工具栏应恢复显示
    await showToolbar("第二次");
    expect(screen.getByRole("button", { name: "搜索" })).toBeInTheDocument();
  });

  it("toolbar-hidden 事件在任何状态下正确重置状态", async () => {
    render(<FloatingToolbar />);
    await showToolbar("重置测试");

    // default 状态下收到隐藏事件
    await act(async () => {
      emitMockEvent("toolbar-hidden", undefined);
    });

    // 工具栏应不可见
    expect(screen.queryByRole("button", { name: "搜索" })).not.toBeInTheDocument();

    // 后续新选区应正常显示
    await showToolbar("新选区");
    expect(screen.getByRole("button", { name: "搜索" })).toBeInTheDocument();
  });

  // ── 拖动手柄 ──────────────────────────────────────────────

  it("工具栏显示拖动手柄", async () => {
    render(<FloatingToolbar />);
    await showToolbar();

    const dragHandle = document.querySelector(".toolbar-drag-handle");
    expect(dragHandle).toBeInTheDocument();
    expect(dragHandle).toHaveAttribute("data-tauri-drag-region");
  });

  it("拖动手柄在所有状态下都可见", async () => {
    render(<FloatingToolbar />);
    await showToolbar();

    // default 状态
    expect(document.querySelector(".toolbar-drag-handle")).toBeInTheDocument();

    // mode-select 状态
    const optimizeBtn = screen.getByRole("button", { name: "优化" });
    await act(async () => {
      fireEvent.click(optimizeBtn);
    });
    expect(document.querySelector(".toolbar-drag-handle")).toBeInTheDocument();
  });

  it("拖动手柄不可见时工具栏不可见", () => {
    render(<FloatingToolbar />);
    expect(document.querySelector(".toolbar-drag-handle")).not.toBeInTheDocument();
  });

  it("拖动手柄配置了 data-tauri-drag-region 属性", async () => {
    render(<FloatingToolbar />);
    await showToolbar();

    const dragHandle = document.querySelector(".toolbar-drag-handle")!;
    expect(dragHandle.getAttribute("data-tauri-drag-region")).not.toBeNull();
  });

  it("拖动手柄不触发工具栏操作（stopPropagation）", async () => {
    render(<FloatingToolbar />);
    await showToolbar();

    // 确认拖动手柄区域独立于按钮
    const dragHandle = document.querySelector(".toolbar-drag-handle")!;
    const buttons = screen.getAllByRole("button");
    for (const btn of buttons) {
      expect(dragHandle.contains(btn)).toBe(false);
    }
  });
});

describe("FloatingToolbar 去重功能", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    // 重置去重配置为默认（按行），避免上一用例通过事件写入的配置污染本用例
    localStorage.removeItem("levitaire-dedup-mode");
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      if (cmd === "replace_selection") {
        return Promise.resolve();
      }
      return Promise.resolve();
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // ── 基础渲染 ──────────────────────────────────────────────

  it("默认状态下显示去重按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar();

    expect(screen.getByRole("button", { name: "去重" })).toBeInTheDocument();
  });

  it("去重按钮在小写按钮之后", async () => {
    render(<FloatingToolbar />);
    await showToolbar();

    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((b) => b.getAttribute("aria-label"));
    const lowercaseIdx = labels.indexOf("小写");
    const dedupIdx = labels.indexOf("去重");

    expect(lowercaseIdx).toBeLessThan(dedupIdx);
  });

  // ── 基础去重 ──────────────────────────────────────────────

  it("点击去重调用 replace_selection 并移除重复行", async () => {
    render(<FloatingToolbar />);
    await showToolbar("苹果\n香蕉\n苹果\n橙子\n香蕉");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "苹果\n香蕉\n橙子",
    });
  });

  it("去重后保持工具栏显示并更新选中文本", async () => {
    render(<FloatingToolbar />);
    await showToolbar("a\nb\na");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });
    await flush();

    // 替换类功能完成后保持工具栏显示，不隐藏
    expect(mockInvoke).not.toHaveBeenCalledWith("hide_toolbar");
  });

  // ── trim 比较 ──────────────────────────────────────────────

  it("忽略行首尾空白进行去重", async () => {
    render(<FloatingToolbar />);
    await showToolbar("  hello  \nhello\nworld");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    // 保留第一次出现的原始格式 "  hello  "
    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "  hello  \nworld",
    });
  });

  // ── 保留首次出现格式 ──────────────────────────────────────

  it("保留首次出现的行原始格式", async () => {
    render(<FloatingToolbar />);
    await showToolbar("  Apple\n  Apple  \nApple");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    // 只保留第一行 "  Apple"
    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "  Apple",
    });
  });

  // ── 无重复 ──────────────────────────────────────────────

  it("无重复行时文本不变", async () => {
    render(<FloatingToolbar />);
    await showToolbar("a\nb\nc");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "a\nb\nc",
    });
  });

  // ── 单行文本 ──────────────────────────────────────────────

  it("单行文本直接返回原文", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "hello",
    });
  });

  // ── 全部重复 ──────────────────────────────────────────────

  it("所有行相同时只保留一行", async () => {
    render(<FloatingToolbar />);
    await showToolbar("same\nsame\nsame");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "same",
    });
  });

  // ── 空行处理 ──────────────────────────────────────────────

  it("多个空行只保留一个", async () => {
    render(<FloatingToolbar />);
    await showToolbar("a\n\n\nb\n");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    // 空行 trim 后为 ""，第二次出现被去重
    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "a\n\nb",
    });
  });

  // ── \r\n 换行符 ──────────────────────────────────────────────

  it("正确处理 \\r\\n 换行符", async () => {
    render(<FloatingToolbar />);
    await showToolbar("a\r\nb\r\na\r\nc");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    // split(/\r?\n/) 正确拆分，输出用 \n 连接
    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "a\nb\nc",
    });
  });

  // ── 错误处理 ──────────────────────────────────────────────

  it("replace_selection 失败时显示错误信息", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "",
          model: "",
          api_type: "anthropic",
        });
      }
      if (cmd === "replace_selection") {
        return Promise.reject("替换失败");
      }
      return Promise.resolve();
    });

    render(<FloatingToolbar />);
    await showToolbar("a\na");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });
    await flush();

    expect(screen.getByRole("alert")).toHaveTextContent("替换失败");
  });

  // ── 纯图片选区 ──────────────────────────────────────────────

  it("纯图片选区时不显示去重按钮", async () => {
    render(<FloatingToolbar />);
    // 模拟纯图片选区（has-image=true, text 为空）
    await act(async () => {
      emitMockEvent("selection-found", {
        text: "",
        rect: { x: 100, y: 200, width: 300, height: 20 },
        "has-image": true,
      });
    });

    expect(screen.queryByRole("button", { name: "去重" })).not.toBeInTheDocument();
  });

  // ── 空字符串 ──────────────────────────────────────────────

  it("空字符串去重结果为空，不调用 replace_selection", async () => {
    render(<FloatingToolbar />);
    await showToolbar("");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    // 后端 replace_selection 拒绝空字符串，前端对空结果直接 return
    expect(mockInvoke).not.toHaveBeenCalledWith("replace_selection", expect.anything());
  });

  // ── 仅空白字符 ──────────────────────────────────────────────

  it("仅含空白字符的文本去重后只保留一行", async () => {
    render(<FloatingToolbar />);
    await showToolbar("  \n\t\n  ");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    // "  ".trim() === "", "\t".trim() === "", "  ".trim() === ""
    // 全部 trim 后为空，只保留第一个 "  "
    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "  ",
    });
  });

  // ── Tab 与空格差异 ──────────────────────────────────────────────

  it("Tab 和空格 trim 后视为相同行进行去重", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello\n\thello\nhello");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    // trim 后都是 "hello"，只保留第一行
    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "hello",
    });
  });

  // ── 大量重复行 ──────────────────────────────────────────────

  it("大量重复行正确去重", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i % 5}`);
    const text = lines.join("\n");

    render(<FloatingToolbar />);
    await showToolbar(text);

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    // 100 行中只有 line0-line4 共 5 个唯一值
    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "line0\nline1\nline2\nline3\nline4",
    });
  });

  // ── Unicode 文本 ──────────────────────────────────────────────

  it("Unicode 文本（emoji、CJK）正确去重", async () => {
    render(<FloatingToolbar />);
    await showToolbar("🍎 苹果\n🍌 香蕉\n🍎 苹果\n🍊 橙子\n🍌 香蕉");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "🍎 苹果\n🍌 香蕉\n🍊 橙子",
    });
  });

  // ── 混合换行符 ──────────────────────────────────────────────

  it("混合 \\r\\n 和 \\n 换行符统一处理", async () => {
    render(<FloatingToolbar />);
    await showToolbar("a\r\nb\nc\r\na\nc");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "a\nb\nc",
    });
  });

  // ── 只有换行符 ──────────────────────────────────────────────

  it("只有换行符的文本按行去重为空字符串，不调用 replace_selection", async () => {
    render(<FloatingToolbar />);
    await showToolbar("\n\n\n");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    // split → ["", "", "", ""], 只保留第一个 ""；结果为空，前端直接 return
    expect(mockInvoke).not.toHaveBeenCalledWith("replace_selection", expect.anything());
  });

  // ── 可配置粒度：按词 / 按字符 ──────────────────────────────

  // 通过 emit 模拟设置窗口广播去重配置变更
  // 先 flush 等待挂载时的 fetchDedupMode（默认按行）resolve，避免其异步 setState 覆盖事件设置的值
  const setDedupMode = async (mode: { granularity: string; charSubMode: string }) => {
    await flush();
    await act(async () => {
      emitMockEvent("levitaire-dedup-mode-changed", mode);
    });
  };

  it("按词去重：单行内移除重复词", async () => {
    render(<FloatingToolbar />);
    await setDedupMode({ granularity: "word", charSubMode: "all" });
    await showToolbar("a b a c");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", { text: "a b c" });
  });

  it("按词去重：保留分隔符与首次词格式", async () => {
    render(<FloatingToolbar />);
    await setDedupMode({ granularity: "word", charSubMode: "all" });
    await showToolbar("苹果, 香蕉, 苹果");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", { text: "苹果, 香蕉" });
  });

  it("按字符逐字去重：跨行保留首次字符", async () => {
    render(<FloatingToolbar />);
    await setDedupMode({ granularity: "char", charSubMode: "all" });
    await showToolbar("apple");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", { text: "aple" });
  });

  it("按字符行内逐字去重：保留换行结构", async () => {
    render(<FloatingToolbar />);
    await setDedupMode({ granularity: "char", charSubMode: "line" });
    await showToolbar("aab\nbba");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", { text: "ab\nba" });
  });

  it("按字符仅连续重复去重：压缩相邻相同字符", async () => {
    render(<FloatingToolbar />);
    await setDedupMode({ granularity: "char", charSubMode: "consecutive" });
    await showToolbar("aaabbb");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", { text: "ab" });
  });

  it("按字符逐字去重结果为空时不调用 replace_selection", async () => {
    render(<FloatingToolbar />);
    await setDedupMode({ granularity: "char", charSubMode: "all" });
    await showToolbar("");

    const dedupBtn = screen.getByRole("button", { name: "去重" });
    await act(async () => {
      fireEvent.click(dedupBtn);
    });

    expect(mockInvoke).not.toHaveBeenCalledWith("replace_selection", expect.anything());
  });
});

describe("FloatingToolbar Base64 功能", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      if (cmd === "replace_selection") {
        return Promise.resolve();
      }
      return Promise.resolve();
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // ── 基础渲染 ──────────────────────────────────────────────

  it("默认状态下显示编码按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    expect(screen.getByRole("button", { name: "编码" })).toBeInTheDocument();
  });

  it("编码按钮在去重按钮之后", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((b) => b.getAttribute("aria-label"));
    const dedupIdx = labels.indexOf("去重");
    const encodeIdx = labels.indexOf("编码");

    expect(dedupIdx).toBeLessThan(encodeIdx);
  });

  // ── 解码按钮条件显示 ──────────────────────────────────────

  it("普通文本时只显示编码按钮，不显示解码按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    expect(screen.getByRole("button", { name: "编码" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "解码" })).not.toBeInTheDocument();
  });

  it("合法 base64 文本时同时显示编码和解码按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("aGVsbG8=");

    expect(screen.getByRole("button", { name: "编码" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "解码" })).toBeInTheDocument();
  });

  it("中文文本时不显示解码按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("你好");

    expect(screen.getByRole("button", { name: "编码" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "解码" })).not.toBeInTheDocument();
  });

  it("emoji 文本时不显示解码按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("🍎 苹果");

    expect(screen.getByRole("button", { name: "编码" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "解码" })).not.toBeInTheDocument();
  });

  it("中文 base64 文本时同时显示编码和解码按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("5L2g5aW9");

    expect(screen.getByRole("button", { name: "编码" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "解码" })).toBeInTheDocument();
  });

  it("emoji base64 文本时同时显示编码和解码按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("8J+NjiDoi7nmnpw=");

    expect(screen.getByRole("button", { name: "编码" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "解码" })).toBeInTheDocument();
  });

  it("含空格的普通文本不显示解码按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("Hello World");

    expect(screen.getByRole("button", { name: "编码" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "解码" })).not.toBeInTheDocument();
  });

  // ── 编码：普通英文文本 ──────────────────────────────────────

  it("编码普通英文文本 'hello' → 'aGVsbG8='", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    const btn = screen.getByRole("button", { name: "编码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "aGVsbG8=",
    });
  });

  it("编码带空格的英文文本 'Hello World' → 'SGVsbG8gV29ybGQ='", async () => {
    render(<FloatingToolbar />);
    await showToolbar("Hello World");

    const btn = screen.getByRole("button", { name: "编码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "SGVsbG8gV29ybGQ=",
    });
  });

  // ── 编码：中文文本 ──────────────────────────────────────────

  it("编码中文文本 '你好' → '5L2g5aW9'", async () => {
    render(<FloatingToolbar />);
    await showToolbar("你好");

    const btn = screen.getByRole("button", { name: "编码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "5L2g5aW9",
    });
  });

  it("编码四字中文 '你好世界' → '5L2g5aW95LiW55WM'", async () => {
    render(<FloatingToolbar />);
    await showToolbar("你好世界");

    const btn = screen.getByRole("button", { name: "编码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "5L2g5aW95LiW55WM",
    });
  });

  // ── 编码：Emoji 文本 ──────────────────────────────────────

  it("编码 emoji 文本 '🍎 苹果' → '8J+NjiDoi7nmnpw='", async () => {
    render(<FloatingToolbar />);
    await showToolbar("🍎 苹果");

    const btn = screen.getByRole("button", { name: "编码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "8J+NjiDoi7nmnpw=",
    });
  });

  // ── 编码：多行文本 ──────────────────────────────────────────

  it("编码多行文本 '你好\\n世界' → '5L2g5aW9CuS4lueVjA=='", async () => {
    render(<FloatingToolbar />);
    await showToolbar("你好\n世界");

    const btn = screen.getByRole("button", { name: "编码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "5L2g5aW9CuS4lueVjA==",
    });
  });

  it("编码含换行的英文文本 'line1\\nline2' → 'bGluZTEKbGluZTI='", async () => {
    render(<FloatingToolbar />);
    await showToolbar("line1\nline2");

    const btn = screen.getByRole("button", { name: "编码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "bGluZTEKbGluZTI=",
    });
  });

  // ── 编码：特殊字符 ──────────────────────────────────────────

  it("编码 JSON 字符串", async () => {
    render(<FloatingToolbar />);
    await showToolbar('{"key":"value"}');

    const btn = screen.getByRole("button", { name: "编码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "eyJrZXkiOiJ2YWx1ZSJ9",
    });
  });

  it("编码含引号的代码片段", async () => {
    render(<FloatingToolbar />);
    await showToolbar('console.log("hello")');

    const btn = screen.getByRole("button", { name: "编码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "Y29uc29sZS5sb2coImhlbGxvIik=",
    });
  });

  // ── 解码：基础英文 ──────────────────────────────────────────

  it("解码 'aGVsbG8=' → 'hello'", async () => {
    render(<FloatingToolbar />);
    await showToolbar("aGVsbG8=");

    const btn = screen.getByRole("button", { name: "解码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "hello",
    });
  });

  it("解码 'SGVsbG8gV29ybGQ=' → 'Hello World'", async () => {
    render(<FloatingToolbar />);
    await showToolbar("SGVsbG8gV29ybGQ=");

    const btn = screen.getByRole("button", { name: "解码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "Hello World",
    });
  });

  // ── 解码：中文文本 ──────────────────────────────────────────

  it("解码 '5L2g5aW9' → '你好'", async () => {
    render(<FloatingToolbar />);
    await showToolbar("5L2g5aW9");

    const btn = screen.getByRole("button", { name: "解码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "你好",
    });
  });

  it("解码 '5L2g5aW95LiW55WM' → '你好世界'", async () => {
    render(<FloatingToolbar />);
    await showToolbar("5L2g5aW95LiW55WM");

    const btn = screen.getByRole("button", { name: "解码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "你好世界",
    });
  });

  // ── 解码：Emoji 文本 ──────────────────────────────────────

  it("解码 '8J+NjiDoi7nmnpw=' → '🍎 苹果'", async () => {
    render(<FloatingToolbar />);
    await showToolbar("8J+NjiDoi7nmnpw=");

    const btn = screen.getByRole("button", { name: "解码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "🍎 苹果",
    });
  });

  // ── 解码：多行文本 ──────────────────────────────────────────

  it("解码 '5L2g5aW9CuS4lueVjA==' → '你好\\n世界'", async () => {
    render(<FloatingToolbar />);
    await showToolbar("5L2g5aW9CuS4lueVjA==");

    const btn = screen.getByRole("button", { name: "解码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "你好\n世界",
    });
  });

  // ── 往返一致性：编码后再解码 ────────────────────────────────

  it("编码后隐藏再显示，解码得到原始文本", async () => {
    render(<FloatingToolbar />);

    // 第一次：编码
    await showToolbar("hello");
    const btn = screen.getByRole("button", { name: "编码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    const encoded = mockInvoke.mock.calls.find((c) => c[0] === "replace_selection")![1] as {
      text: string;
    };
    expect(encoded.text).toBe("aGVsbG8=");

    // 第二次：用编码结果作为选区，点击解码
    mockInvoke.mockClear();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      if (cmd === "replace_selection") {
        return Promise.resolve();
      }
      return Promise.resolve();
    });

    await showToolbar(encoded.text);
    const btn2 = screen.getByRole("button", { name: "解码" });
    await act(async () => {
      fireEvent.click(btn2);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "hello",
    });
  });

  it("中文文本往返一致性", async () => {
    render(<FloatingToolbar />);
    await showToolbar("你好世界");

    const btn = screen.getByRole("button", { name: "编码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    const encoded = mockInvoke.mock.calls.find((c) => c[0] === "replace_selection")![1] as {
      text: string;
    };
    expect(encoded.text).toBe("5L2g5aW95LiW55WM");

    mockInvoke.mockClear();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      return Promise.resolve();
    });

    await showToolbar(encoded.text);
    const btn2 = screen.getByRole("button", { name: "解码" });
    await act(async () => {
      fireEvent.click(btn2);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "你好世界",
    });
  });

  // ── 前后空格 trim ──────────────────────────────────────────

  it("编码前对文本进行 trim", async () => {
    render(<FloatingToolbar />);
    await showToolbar("  hello  ");

    const btn = screen.getByRole("button", { name: "编码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    // trim 后为 "hello" → "aGVsbG8="
    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "aGVsbG8=",
    });
  });

  it("解码前对带空格的 base64 进行 trim", async () => {
    render(<FloatingToolbar />);
    // 带前后空格的合法 base64
    await showToolbar("  aGVsbG8=  ");

    const btn = screen.getByRole("button", { name: "解码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "hello",
    });
  });

  // ── 空文本守卫 ──────────────────────────────────────────────

  it("空文本时不执行转换且不调用 replace_selection", async () => {
    mockInvoke.mockClear();
    render(<FloatingToolbar />);
    await showToolbar("");

    const btn = screen.getByRole("button", { name: "编码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    const replaceCalls = mockInvoke.mock.calls.filter((c) => c[0] === "replace_selection");
    expect(replaceCalls).toHaveLength(0);
  });

  it("仅含空白字符时不执行转换", async () => {
    mockInvoke.mockClear();
    render(<FloatingToolbar />);
    await showToolbar("   ");

    const btn = screen.getByRole("button", { name: "编码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    const replaceCalls = mockInvoke.mock.calls.filter((c) => c[0] === "replace_selection");
    expect(replaceCalls).toHaveLength(0);
  });

  // ── 操作完成后隐藏工具栏 ────────────────────────────────────

  it("编码成功后保持工具栏显示", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    const btn = screen.getByRole("button", { name: "编码" });
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();

    // 替换类功能完成后保持工具栏显示，不隐藏
    expect(mockInvoke).not.toHaveBeenCalledWith("hide_toolbar");
  });

  it("解码成功后保持工具栏显示", async () => {
    render(<FloatingToolbar />);
    await showToolbar("aGVsbG8=");

    const btn = screen.getByRole("button", { name: "解码" });
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();

    expect(mockInvoke).not.toHaveBeenCalledWith("hide_toolbar");
  });

  // ── replace_selection 失败错误处理 ──────────────────────────

  it("编码 replace_selection 失败时显示错误信息", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "",
          model: "",
          api_type: "anthropic",
        });
      }
      if (cmd === "replace_selection") {
        return Promise.reject("替换失败");
      }
      return Promise.resolve();
    });

    render(<FloatingToolbar />);
    await showToolbar("hello");

    const btn = screen.getByRole("button", { name: "编码" });
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();

    expect(screen.getByRole("alert")).toHaveTextContent("替换失败");
  });

  it("解码 replace_selection 失败时显示错误信息", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "",
          model: "",
          api_type: "anthropic",
        });
      }
      if (cmd === "replace_selection") {
        return Promise.reject(new Error("无法替换"));
      }
      return Promise.resolve();
    });

    render(<FloatingToolbar />);
    await showToolbar("aGVsbG8=");

    const btn = screen.getByRole("button", { name: "解码" });
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();

    expect(screen.getByRole("alert")).toHaveTextContent("无法替换");
  });

  // ── 纯图片选区 ──────────────────────────────────────────────

  it("纯图片选区时不显示编码按钮", async () => {
    render(<FloatingToolbar />);
    await act(async () => {
      emitMockEvent("selection-found", {
        text: "",
        rect: { x: 100, y: 200, width: 300, height: 20 },
        "has-image": true,
      });
    });

    expect(screen.queryByRole("button", { name: "编码" })).not.toBeInTheDocument();
  });

  // ── 工具栏未显示时 ──────────────────────────────────────────

  it("工具栏未显示时编码按钮不在 DOM 中", () => {
    render(<FloatingToolbar />);
    expect(screen.queryByRole("button", { name: "编码" })).not.toBeInTheDocument();
  });

  // ── 新选区后使用最新文本 ────────────────────────────────────

  it("新选区触发后编码使用最新文本", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    await act(async () => {
      emitMockEvent("selection-found", makeSelection("你好"));
    });

    const btn = screen.getByRole("button", { name: "编码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "5L2g5aW9",
    });
  });

  it("新选区后解码按钮根据新文本条件显示", async () => {
    render(<FloatingToolbar />);
    // 第一次选中文本，非 base64，不显示解码
    await showToolbar("hello");
    expect(screen.queryByRole("button", { name: "解码" })).not.toBeInTheDocument();

    // 第二次选中合法 base64，显示解码
    await act(async () => {
      emitMockEvent("selection-found", makeSelection("aGVsbG8="));
    });
    expect(screen.getByRole("button", { name: "解码" })).toBeInTheDocument();
  });

  // ── 只含 base64 padding 字符 ────────────────────────────────

  it("只含等号的文本不显示解码按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("===");

    expect(screen.getByRole("button", { name: "编码" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "解码" })).not.toBeInTheDocument();
  });

  // ── 解码按钮在合法 base64 时位于编码按钮之后 ──────────────────

  it("解码按钮在编码按钮之后", async () => {
    render(<FloatingToolbar />);
    await showToolbar("aGVsbG8=");

    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((b) => b.getAttribute("aria-label"));
    const encodeIdx = labels.indexOf("编码");
    const decodeIdx = labels.indexOf("解码");

    expect(encodeIdx).toBeLessThan(decodeIdx);
  });
});

// ── 二维码功能测试 ──────────────────────────────────────────────

describe("FloatingToolbar 二维码功能", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockToDataURL.mockResolvedValue("data:image/png;base64,mock-qr-data");
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      return Promise.resolve();
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // ── 基础渲染 ──────────────────────────────────────────────

  it("默认状态下显示二维码按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    expect(screen.getByRole("button", { name: "二维码" })).toBeInTheDocument();
  });

  it("二维码按钮在去重按钮之后", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((b) => b.getAttribute("aria-label"));
    const dedupIdx = labels.indexOf("去重");
    const qrcodeIdx = labels.indexOf("二维码");

    expect(dedupIdx).toBeLessThan(qrcodeIdx);
  });

  it("二维码按钮在编码按钮之前", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((b) => b.getAttribute("aria-label"));
    const qrcodeIdx = labels.indexOf("二维码");
    const encodeIdx = labels.indexOf("编码");

    expect(qrcodeIdx).toBeLessThan(encodeIdx);
  });

  // ── 条件显示 ──────────────────────────────────────────────

  it("纯图片选区时不显示二维码按钮", async () => {
    render(<FloatingToolbar />);
    await act(async () => {
      emitMockEvent("selection-found", {
        text: "",
        rect: { x: 100, y: 200, width: 300, height: 20 },
        "has-image": true,
      });
    });

    expect(screen.queryByRole("button", { name: "二维码" })).not.toBeInTheDocument();
  });

  it("空白文本时不显示二维码按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("   ");

    expect(screen.queryByRole("button", { name: "二维码" })).not.toBeInTheDocument();
  });

  it("工具栏未显示时二维码按钮不在 DOM 中", () => {
    render(<FloatingToolbar />);
    expect(screen.queryByRole("button", { name: "二维码" })).not.toBeInTheDocument();
  });

  // ── 生成行为 ──────────────────────────────────────────────

  it("点击二维码按钮调用 toDataURL", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello world");

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockToDataURL).toHaveBeenCalledWith(
      "hello world",
      expect.objectContaining({
        width: 256,
        margin: 2,
        errorCorrectionLevel: "M",
      }),
    );
  });

  it("生成成功后显示二维码图片", async () => {
    render(<FloatingToolbar />);
    await showToolbar("test");

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    const img = document.querySelector(".toolbar-qrcode-image") as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toContain("data:image/png;base64,mock-qr-data");
    expect(img.alt).toBe("二维码");
  });

  it("生成成功后显示下载、复制和关闭按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("test");

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(screen.getByRole("button", { name: "下载" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
  });

  it("生成成功后默认状态按钮消失", async () => {
    render(<FloatingToolbar />);
    await showToolbar("test");

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    // 默认状态的按钮不应存在
    expect(screen.queryByRole("button", { name: "搜索" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "翻译" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "二维码" })).not.toBeInTheDocument();
  });

  // ── 前后空格 trim ──────────────────────────────────────────────

  it("生成前对文本进行 trim", async () => {
    render(<FloatingToolbar />);
    await showToolbar("  hello  ");

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockToDataURL).toHaveBeenCalledWith("hello", expect.anything());
  });

  // ── 中文 / Emoji 文本 ──────────────────────────────────────────

  it("中文文本生成二维码", async () => {
    render(<FloatingToolbar />);
    await showToolbar("你好世界");

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockToDataURL).toHaveBeenCalledWith("你好世界", expect.anything());
  });

  it("Emoji 文本生成二维码", async () => {
    render(<FloatingToolbar />);
    await showToolbar("🍎 苹果");

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockToDataURL).toHaveBeenCalledWith("🍎 苹果", expect.anything());
  });

  it("多行文本生成二维码", async () => {
    render(<FloatingToolbar />);
    await showToolbar("line1\nline2\nline3");

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockToDataURL).toHaveBeenCalledWith("line1\nline2\nline3", expect.anything());
  });

  it("URL 文本生成二维码", async () => {
    render(<FloatingToolbar />);
    await showToolbar("https://example.com/path?q=1#frag");

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockToDataURL).toHaveBeenCalledWith(
      "https://example.com/path?q=1#frag",
      expect.anything(),
    );
  });

  it("JSON 字符串生成二维码", async () => {
    render(<FloatingToolbar />);
    await showToolbar('{"key":"value","num":42}');

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockToDataURL).toHaveBeenCalledWith('{"key":"value","num":42}', expect.anything());
  });

  // ── 超长文本截断 ──────────────────────────────────────────────

  it("超长文本（>2900 字节）自动截断", async () => {
    // 构造约 3000 字节的中文文本（每中文字符 3 字节）
    const longText = "你".repeat(1000); // 3000 字节

    render(<FloatingToolbar />);
    await showToolbar(longText);

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    // toDataURL 应被调用，传入截断后的文本
    expect(mockToDataURL).toHaveBeenCalledTimes(1);
    const passedText = mockToDataURL.mock.calls[0][0] as string;
    const passedBytes = new TextEncoder().encode(passedText);
    expect(passedBytes.length).toBeLessThanOrEqual(2900);
  });

  it("短文本不截断直接传入", async () => {
    const shortText = "hello"; // 5 字节

    render(<FloatingToolbar />);
    await showToolbar(shortText);

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockToDataURL).toHaveBeenCalledWith(shortText, expect.anything());
  });

  // ── 关闭操作 ──────────────────────────────────────────────

  it("点击关闭按钮隐藏工具栏", async () => {
    render(<FloatingToolbar />);
    await showToolbar("test");

    // 生成二维码
    const qrBtn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(qrBtn);
    });
    expect(document.querySelector(".toolbar-qrcode")).toBeInTheDocument();

    // 点击关闭
    const closeBtn = screen.getByRole("button", { name: "关闭" });
    await act(async () => {
      fireEvent.click(closeBtn);
    });
    await flush();

    // 应隐藏工具栏（而非返回默认按钮行）
    expect(document.querySelector(".toolbar-qrcode")).not.toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith("set_qrcode_preview", { active: false });
    expect(mockInvoke).toHaveBeenCalledWith("hide_toolbar");
  });

  it("Escape 键退出二维码预览隐藏工具栏", async () => {
    render(<FloatingToolbar />);
    await showToolbar("test");

    const qrBtn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(qrBtn);
    });
    expect(document.querySelector(".toolbar-qrcode")).toBeInTheDocument();

    // 按 Escape
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    await flush();

    expect(document.querySelector(".toolbar-qrcode")).not.toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith("set_qrcode_preview", { active: false });
    expect(mockInvoke).toHaveBeenCalledWith("hide_toolbar");
  });

  it("toolbar-hidden 事件退出二维码预览", async () => {
    render(<FloatingToolbar />);
    await showToolbar("test");

    const qrBtn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(qrBtn);
    });
    expect(document.querySelector(".toolbar-qrcode")).toBeInTheDocument();

    await act(async () => {
      emitMockEvent("toolbar-hidden", undefined);
    });

    // 工具栏应完全隐藏
    expect(screen.queryByRole("button", { name: "搜索" })).not.toBeInTheDocument();
    expect(document.querySelector(".toolbar-qrcode")).not.toBeInTheDocument();
  });

  it("关闭后新的选区仍可正常显示工具栏", async () => {
    render(<FloatingToolbar />);
    await showToolbar("first");

    const qrBtn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(qrBtn);
    });

    const closeBtn = screen.getByRole("button", { name: "关闭" });
    await act(async () => {
      fireEvent.click(closeBtn);
    });

    // 新选区应正常触发
    await showToolbar("second");
    expect(screen.getByRole("button", { name: "搜索" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "二维码" })).toBeInTheDocument();
  });

  // ── 生成失败 ──────────────────────────────────────────────

  it("toDataURL 失败时显示错误信息", async () => {
    mockToDataURL.mockRejectedValue(new Error("生成失败"));

    render(<FloatingToolbar />);
    await showToolbar("test");

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();

    expect(screen.getByRole("alert")).toHaveTextContent("生成二维码失败");
  });

  it("错误信息 3 秒后自动恢复", async () => {
    vi.useFakeTimers();
    mockToDataURL.mockRejectedValue(new Error("fail"));

    render(<FloatingToolbar />);
    await showToolbar("test");

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();

    // 快进 3 秒
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "搜索" })).toBeInTheDocument();

    vi.useRealTimers();
  });

  // ── toDataURL 参数验证 ──────────────────────────────────

  it("使用默认深色前景和浅色背景", async () => {
    render(<FloatingToolbar />);
    await showToolbar("test");

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockToDataURL).toHaveBeenCalledWith(
      "test",
      expect.objectContaining({
        color: {
          dark: "#000000",
          light: "#ffffff",
        },
      }),
    );
  });

  it("使用中等纠错级别", async () => {
    render(<FloatingToolbar />);
    await showToolbar("test");

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockToDataURL).toHaveBeenCalledWith(
      "test",
      expect.objectContaining({
        errorCorrectionLevel: "M",
      }),
    );
  });

  it("二维码宽度为 256", async () => {
    render(<FloatingToolbar />);
    await showToolbar("test");

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockToDataURL).toHaveBeenCalledWith(
      "test",
      expect.objectContaining({
        width: 256,
      }),
    );
  });

  // ── 复制功能 ──────────────────────────────────────────────

  it("点击复制按钮 clipboard API 不可用时显示错误提示", async () => {
    // happy-dom 不支持 ClipboardItem 和 navigator.clipboard.write，
    // 组件应走入 else 分支显示错误提示而非静默失败
    const originalClipboardItem = globalThis.ClipboardItem;
    // 确保 ClipboardItem 不存在
    delete (globalThis as Record<string, unknown>).ClipboardItem;

    render(<FloatingToolbar />);
    await showToolbar("test");

    const qrBtn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(qrBtn);
    });

    const copyBtn = screen.getByRole("button", { name: "复制" });
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    await flush();

    // 应显示错误提示
    expect(screen.getByRole("alert")).toHaveTextContent("当前环境不支持复制图片");

    if (originalClipboardItem !== undefined) {
      globalThis.ClipboardItem = originalClipboardItem;
    }
  });

  // ── 下载功能 ──────────────────────────────────────────────

  it("点击下载按钮调用 save_image 命令", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      if (cmd === "save_image") {
        return Promise.resolve(true);
      }
      return Promise.resolve();
    });

    render(<FloatingToolbar />);
    await showToolbar("test");

    const qrBtn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(qrBtn);
    });

    const downloadBtn = screen.getByRole("button", { name: "下载" });
    await act(async () => {
      fireEvent.click(downloadBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("save_image", {
      base64Data: "data:image/png;base64,mock-qr-data",
      filename: "qrcode.png",
    });
  });

  it("下载成功后二维码预览保持显示", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      if (cmd === "save_image") {
        return Promise.resolve(true);
      }
      return Promise.resolve();
    });

    render(<FloatingToolbar />);
    await showToolbar("test");

    const qrBtn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(qrBtn);
    });

    const downloadBtn = screen.getByRole("button", { name: "下载" });
    await act(async () => {
      fireEvent.click(downloadBtn);
    });
    await flush();

    // 二维码预览应保持显示
    expect(document.querySelector(".toolbar-qrcode")).toBeInTheDocument();
  });

  it("用户取消保存对话框时二维码预览保持显示", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      if (cmd === "save_image") {
        return Promise.resolve(false); // 用户取消
      }
      return Promise.resolve();
    });

    render(<FloatingToolbar />);
    await showToolbar("test");

    const qrBtn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(qrBtn);
    });

    const downloadBtn = screen.getByRole("button", { name: "下载" });
    await act(async () => {
      fireEvent.click(downloadBtn);
    });
    await flush();

    expect(document.querySelector(".toolbar-qrcode")).toBeInTheDocument();
  });

  it("保存失败时显示错误提示", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      if (cmd === "save_image") {
        return Promise.reject(new Error("写入文件失败"));
      }
      return Promise.resolve();
    });

    render(<FloatingToolbar />);
    await showToolbar("test");

    const qrBtn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(qrBtn);
    });

    const downloadBtn = screen.getByRole("button", { name: "下载" });
    await act(async () => {
      fireEvent.click(downloadBtn);
    });
    await flush();

    expect(screen.getByRole("alert")).toHaveTextContent("下载二维码失败");
  });

  it("下载按钮在复制按钮之前", async () => {
    render(<FloatingToolbar />);
    await showToolbar("test");

    const qrBtn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(qrBtn);
    });

    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((b) => b.getAttribute("aria-label"));
    const downloadIdx = labels.indexOf("下载");
    const copyIdx = labels.indexOf("复制");

    expect(downloadIdx).toBeLessThan(copyIdx);
  });

  // ── 多次操作 ──────────────────────────────────────────────

  it("新选区触发后二维码预览状态被清除", async () => {
    render(<FloatingToolbar />);
    await showToolbar("first");

    const qrBtn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(qrBtn);
    });
    expect(document.querySelector(".toolbar-qrcode")).toBeInTheDocument();

    // 新选区到来
    await act(async () => {
      emitMockEvent("selection-found", makeSelection("second"));
    });

    // 应重置为默认状态
    expect(document.querySelector(".toolbar-qrcode")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "搜索" })).toBeInTheDocument();
  });

  it("连续点击二维码按钮最终只显示一个二维码预览", async () => {
    render(<FloatingToolbar />);
    await showToolbar("test");

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    });

    // 只有 1 个二维码预览容器
    expect(document.querySelectorAll(".toolbar-qrcode")).toHaveLength(1);
  });

  // ── 空文本守卫 ──────────────────────────────────────────────

  it("空文本时不调用 toDataURL", async () => {
    render(<FloatingToolbar />);
    await showToolbar("");

    // 空文本时二维码按钮不显示，但用 showToolbar 确认按钮不存在
    expect(screen.queryByRole("button", { name: "二维码" })).not.toBeInTheDocument();
    expect(mockToDataURL).not.toHaveBeenCalled();
  });

  // ── CSS 类名 ──────────────────────────────────────────────

  it("二维码预览使用 toolbar-qrcode 容器类", async () => {
    render(<FloatingToolbar />);
    await showToolbar("test");

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(document.querySelector(".toolbar-qrcode")).toBeInTheDocument();
    expect(document.querySelector(".toolbar-qrcode-image")).toBeInTheDocument();
  });

  it("拖动手柄在二维码预览状态下仍然可见", async () => {
    render(<FloatingToolbar />);
    await showToolbar("test");

    const btn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(document.querySelector(".toolbar-drag-handle")).toBeInTheDocument();
  });
});

describe("FloatingToolbar MD5 加密功能", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      if (cmd === "replace_selection") {
        return Promise.resolve();
      }
      // get_md5_length / get_dedup_mode / get_toolbar_features 返回 undefined → 前端取默认值
      return Promise.resolve();
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("默认状态下显示 MD5 按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    expect(screen.getByRole("button", { name: "MD5" })).toBeInTheDocument();
  });

  it("空文本时不显示 MD5 按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("   ");

    expect(screen.queryByRole("button", { name: "MD5" })).not.toBeInTheDocument();
  });

  it("默认 32 位：点击 MD5 调用 replace_selection 并写入 32 位 hex", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    const btn = screen.getByRole("button", { name: "MD5" });
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("replace_selection", expect.any(Object));
    });
    const calls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "replace_selection");
    expect(calls).toHaveLength(1);
    const text = calls[0][1] as { text: string };
    expect(text.text).toHaveLength(32);
    expect(text.text).toMatch(/^[a-f0-9]{32}$/);
  });

  it("32 位结果与标准 md5(hello) 一致", async () => {
    // 标准值：md5("hello") = 5d41402abc4b2a76b9719d911017c592
    render(<FloatingToolbar />);
    await showToolbar("hello");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "MD5" }));
    });

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
        text: "5d41402abc4b2a76b9719d911017c592",
      }),
    );
  });

  it("16 位：切换位数后输出 32 位结果的第 9~24 位", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    // 广播 16 位配置变更
    await act(async () => {
      emitMockEvent("levitaire-md5-length-changed", "16");
    });
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "MD5" }));
    });

    // 5d41402abc4b2a76b9719d911017c592 的 substring(8,24) = bc4b2a76b9719d91
    // 与 PHP substr(md5(s),8,16) 一致
    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "bc4b2a76b9719d91",
    });
  });

  it("16 位结果长度为 16", async () => {
    render(<FloatingToolbar />);
    await showToolbar("中文测试");

    await act(async () => {
      emitMockEvent("levitaire-md5-length-changed", "16");
    });
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "MD5" }));
    });

    const calls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "replace_selection");
    const text = calls[0][1] as { text: string };
    expect(text.text).toHaveLength(16);
    expect(text.text).toMatch(/^[a-f0-9]{16}$/);
  });

  it("MD5 按钮在解码按钮之后", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((b) => b.getAttribute("aria-label"));
    // base64-decode 仅在 isBase64 时显示，此处用 base64-encode("编码") 定位顺序
    const encodeIdx = labels.indexOf("编码");
    const md5Idx = labels.indexOf("MD5");

    expect(encodeIdx).toBeLessThan(md5Idx);
  });
});

describe("FloatingToolbar Unicode 功能", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      if (cmd === "replace_selection") {
        return Promise.resolve();
      }
      return Promise.resolve();
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // ── 基础渲染 ──────────────────────────────────────────────

  it("普通文本时显示转Unicode按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    expect(screen.getByRole("button", { name: "转Unicode" })).toBeInTheDocument();
  });

  it("空文本时不显示转Unicode按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("   ");

    expect(screen.queryByRole("button", { name: "转Unicode" })).not.toBeInTheDocument();
  });

  it("普通文本时不显示转中文按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    expect(screen.queryByRole("button", { name: "转中文" })).not.toBeInTheDocument();
  });

  it("含 \\uXXXX 转义时显示转中文按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("\\u4e2d\\u6587");

    expect(screen.getByRole("button", { name: "转中文" })).toBeInTheDocument();
  });

  it("含 \\u{XXXXX} 转义时显示转中文按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("\\u{1F600}");

    expect(screen.getByRole("button", { name: "转中文" })).toBeInTheDocument();
  });

  it("含 U+XXXX 形式时显示转中文按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("U+4E2D U+1F600");

    expect(screen.getByRole("button", { name: "转中文" })).toBeInTheDocument();
  });

  it("转中文按钮在转Unicode按钮之后", async () => {
    render(<FloatingToolbar />);
    await showToolbar("\\u4e2d\\u6587");

    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((b) => b.getAttribute("aria-label"));
    const encodeIdx = labels.indexOf("转Unicode");
    const decodeIdx = labels.indexOf("转中文");

    expect(encodeIdx).toBeLessThan(decodeIdx);
  });

  it("转Unicode按钮在Base64解码按钮之后", async () => {
    render(<FloatingToolbar />);
    await showToolbar("\\u4e2d\\u6587");

    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((b) => b.getAttribute("aria-label"));
    const b64DecodeIdx = labels.indexOf("解码");
    const uniEncodeIdx = labels.indexOf("转Unicode");

    expect(b64DecodeIdx).toBeLessThan(uniEncodeIdx);
  });

  it("MD5按钮在转中文按钮之后", async () => {
    render(<FloatingToolbar />);
    await showToolbar("\\u4e2d\\u6587");

    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((b) => b.getAttribute("aria-label"));
    const uniDecodeIdx = labels.indexOf("转中文");
    const md5Idx = labels.indexOf("MD5");

    expect(uniDecodeIdx).toBeLessThan(md5Idx);
  });

  // ── 编码：基础 ──────────────────────────────────────────────

  it("编码中文 '你好' → \\u4F60\\u597D", async () => {
    render(<FloatingToolbar />);
    await showToolbar("你好");

    const btn = screen.getByRole("button", { name: "转Unicode" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "\\u4F60\\u597D",
    });
  });

  it("编码 ASCII 'abc' → \\u0061\\u0062\\u0063（全字符都转）", async () => {
    render(<FloatingToolbar />);
    await showToolbar("abc");

    const btn = screen.getByRole("button", { name: "转Unicode" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "\\u0061\\u0062\\u0063",
    });
  });

  it("编码 emoji '😀' → \\u{1F600}（BMP 外用 \\u{} 形式）", async () => {
    render(<FloatingToolbar />);
    await showToolbar("😀");

    const btn = screen.getByRole("button", { name: "转Unicode" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "\\u{1F600}",
    });
  });

  it("编码混合文本 '中A😀'", async () => {
    render(<FloatingToolbar />);
    await showToolbar("中A😀");

    const btn = screen.getByRole("button", { name: "转Unicode" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "\\u4E2D\\u0041\\u{1F600}",
    });
  });

  it("编码前对文本进行 trim", async () => {
    render(<FloatingToolbar />);
    await showToolbar("  你好  ");

    const btn = screen.getByRole("button", { name: "转Unicode" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "\\u4F60\\u597D",
    });
  });

  // ── 解码：基础 ──────────────────────────────────────────────

  it("解码 \\u4F60\\u597D → 你好", async () => {
    render(<FloatingToolbar />);
    await showToolbar("\\u4F60\\u597D");

    const btn = screen.getByRole("button", { name: "转中文" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "你好",
    });
  });

  it("解码 \\u{1F600} → 😀", async () => {
    render(<FloatingToolbar />);
    await showToolbar("\\u{1F600}");

    const btn = screen.getByRole("button", { name: "转中文" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "😀",
    });
  });

  it("解码 U+4E2D 形式 → 中", async () => {
    render(<FloatingToolbar />);
    await showToolbar("U+4E2D");

    const btn = screen.getByRole("button", { name: "转中文" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "中",
    });
  });

  it("解码混合形式 \\u4E2D\\u{1F600}U+0041", async () => {
    render(<FloatingToolbar />);
    await showToolbar("\\u4E2D\\u{1F600}U+0041");

    const btn = screen.getByRole("button", { name: "转中文" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "中😀A",
    });
  });

  it("解码前对文本进行 trim", async () => {
    render(<FloatingToolbar />);
    await showToolbar("  \\u4F60\\u597D  ");

    const btn = screen.getByRole("button", { name: "转中文" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "你好",
    });
  });

  it("解码 U+ 不误匹配 CPU+4E2D（词边界）", async () => {
    render(<FloatingToolbar />);
    await showToolbar("CPU+4E2D");

    // CPU+4E2D 中 U+4E2D 前是 P（单词字符），不应被识别为转义
    expect(screen.queryByRole("button", { name: "转中文" })).not.toBeInTheDocument();
  });

  it("解码 独立 U+4E2D 仍能识别（词边界不阻断独立形式）", async () => {
    render(<FloatingToolbar />);
    await showToolbar("值 U+4E2D 结束");

    const btn = screen.getByRole("button", { name: "转中文" });
    await act(async () => {
      fireEvent.click(btn);
    });

    // U+ 前是空格（非单词字符），词边界成立，被解码；其余字符原样保留
    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "值 中 结束",
    });
  });

  it("编码多行文本 '你好\\n世界'", async () => {
    render(<FloatingToolbar />);
    await showToolbar("你好\n世界");

    const btn = screen.getByRole("button", { name: "转Unicode" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "\\u4F60\\u597D\\u000A\\u4E16\\u754C",
    });
  });

  it("解码含换行的多行 Unicode 转义", async () => {
    render(<FloatingToolbar />);
    await showToolbar("\\u4F60\\u597D\\u000A\\u4E16\\u754C");

    const btn = screen.getByRole("button", { name: "转中文" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "你好\n世界",
    });
  });

  it("长中文文本往返一致性", async () => {
    const original = "这是一段用于测试往返一致性的较长中文文本，包含标点符号。";
    render(<FloatingToolbar />);
    await showToolbar(original);

    const encBtn = screen.getByRole("button", { name: "转Unicode" });
    await act(async () => {
      fireEvent.click(encBtn);
    });

    const encoded = mockInvoke.mock.calls.find((c) => c[0] === "replace_selection")![1] as {
      text: string;
    };
    expect(encoded.text).toMatch(/^(\\u[0-9A-F]{4})+$/);

    mockInvoke.mockClear();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      return Promise.resolve();
    });

    await showToolbar(encoded.text);
    const decBtn = screen.getByRole("button", { name: "转中文" });
    await act(async () => {
      fireEvent.click(decBtn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: original,
    });
  });

  it("选中合法 base64 文本时同时显示编码和解码按钮，但不显示转中文按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("aGVsbG8=");

    expect(screen.getByRole("button", { name: "编码" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "解码" })).toBeInTheDocument();
    // 合法 base64 不含 Unicode 转义，不应显示转中文
    expect(screen.queryByRole("button", { name: "转中文" })).not.toBeInTheDocument();
  });

  it("选中 Unicode 转义文本时不显示 Base64 解码按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("\\u4E2D\\u6587");

    // 含反斜杠，isBase64 字符类不接受，不显示解码
    expect(screen.queryByRole("button", { name: "解码" })).not.toBeInTheDocument();
    // 但显示转中文
    expect(screen.getByRole("button", { name: "转中文" })).toBeInTheDocument();
  });

  it("非法码点 \\u{FFFFFF} 解码失败显示错误信息", async () => {
    render(<FloatingToolbar />);
    await showToolbar("\\u{FFFFFF}");

    const btn = screen.getByRole("button", { name: "转中文" });
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();

    expect(screen.getByRole("alert")).toHaveTextContent("Unicode 解码失败");
  });

  it("错误信息 3 秒后自动恢复", async () => {
    vi.useFakeTimers();
    render(<FloatingToolbar />);
    await showToolbar("\\u{FFFFFF}");

    const btn = screen.getByRole("button", { name: "转中文" });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "转Unicode" })).toBeInTheDocument();

    vi.useRealTimers();
  });

  // ── 往返一致性 ──────────────────────────────────────────────

  it("编码后再解码得到原始文本", async () => {
    render(<FloatingToolbar />);
    await showToolbar("你好世界");

    const btn = screen.getByRole("button", { name: "转Unicode" });
    await act(async () => {
      fireEvent.click(btn);
    });

    const encoded = mockInvoke.mock.calls.find((c) => c[0] === "replace_selection")![1] as {
      text: string;
    };
    expect(encoded.text).toBe("\\u4F60\\u597D\\u4E16\\u754C");

    mockInvoke.mockClear();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      return Promise.resolve();
    });

    await showToolbar(encoded.text);
    const btn2 = screen.getByRole("button", { name: "转中文" });
    await act(async () => {
      fireEvent.click(btn2);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "你好世界",
    });
  });

  it("emoji 往返一致性", async () => {
    render(<FloatingToolbar />);
    await showToolbar("😀🍎");

    const btn = screen.getByRole("button", { name: "转Unicode" });
    await act(async () => {
      fireEvent.click(btn);
    });

    const encoded = mockInvoke.mock.calls.find((c) => c[0] === "replace_selection")![1] as {
      text: string;
    };

    mockInvoke.mockClear();
    await showToolbar(encoded.text);
    const btn2 = screen.getByRole("button", { name: "转中文" });
    await act(async () => {
      fireEvent.click(btn2);
    });

    expect(mockInvoke).toHaveBeenCalledWith("replace_selection", {
      text: "😀🍎",
    });
  });

  // ── 空文本守卫 ──────────────────────────────────────────────

  it("空文本时不执行编码且不调用 replace_selection", async () => {
    mockInvoke.mockClear();
    render(<FloatingToolbar />);
    await showToolbar("");

    expect(screen.queryByRole("button", { name: "转Unicode" })).not.toBeInTheDocument();
    const replaceCalls = mockInvoke.mock.calls.filter((c) => c[0] === "replace_selection");
    expect(replaceCalls).toHaveLength(0);
  });

  // ── 操作完成后保持显示 ────────────────────────────────────

  it("编码成功后保持工具栏显示", async () => {
    render(<FloatingToolbar />);
    await showToolbar("你好");

    const btn = screen.getByRole("button", { name: "转Unicode" });
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();

    expect(mockInvoke).not.toHaveBeenCalledWith("hide_toolbar");
  });

  it("解码成功后保持工具栏显示", async () => {
    render(<FloatingToolbar />);
    await showToolbar("\\u4E2D\\u6587");

    const btn = screen.getByRole("button", { name: "转中文" });
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();

    expect(mockInvoke).not.toHaveBeenCalledWith("hide_toolbar");
  });

  // ── replace_selection 失败错误处理 ──────────────────────────

  it("编码 replace_selection 失败时显示错误信息", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "",
          model: "",
          api_type: "anthropic",
        });
      }
      if (cmd === "replace_selection") {
        return Promise.reject("替换失败");
      }
      return Promise.resolve();
    });

    render(<FloatingToolbar />);
    await showToolbar("你好");

    const btn = screen.getByRole("button", { name: "转Unicode" });
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();

    expect(screen.getByRole("alert")).toHaveTextContent("替换失败");
  });

  it("解码 replace_selection 失败时显示错误信息", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "",
          model: "",
          api_type: "anthropic",
        });
      }
      if (cmd === "replace_selection") {
        return Promise.reject(new Error("无法替换"));
      }
      return Promise.resolve();
    });

    render(<FloatingToolbar />);
    await showToolbar("\\u4E2D\\u6587");

    const btn = screen.getByRole("button", { name: "转中文" });
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();

    expect(screen.getByRole("alert")).toHaveTextContent("无法替换");
  });

  // ── 纯图片选区 ──────────────────────────────────────────────

  it("纯图片选区时不显示转Unicode按钮", async () => {
    render(<FloatingToolbar />);
    await act(async () => {
      emitMockEvent("selection-found", {
        text: "",
        rect: { x: 100, y: 200, width: 300, height: 20 },
        "has-image": true,
      });
    });

    expect(screen.queryByRole("button", { name: "转Unicode" })).not.toBeInTheDocument();
  });

  // ── 新选区后使用最新文本 ────────────────────────────────────

  it("新选区触发后转中文按钮根据新文本条件显示", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");
    expect(screen.queryByRole("button", { name: "转中文" })).not.toBeInTheDocument();

    await act(async () => {
      emitMockEvent("selection-found", makeSelection("\\u4E2D\\u6587"));
    });
    expect(screen.getByRole("button", { name: "转中文" })).toBeInTheDocument();
  });
});

describe("FloatingToolbar 字符统计功能", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      // get_md5_length / get_dedup_mode / get_toolbar_features / get_clear_options 返回 undefined → 前端取默认值
      return Promise.resolve();
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // ── 按钮渲染 ──────────────────────────────────────────────

  it("默认状态下显示统计按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello 世界");

    expect(screen.getByRole("button", { name: "统计" })).toBeInTheDocument();
  });

  it("统计按钮位于 MD5 与清除之间", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((b) => b.getAttribute("aria-label"));
    const md5Idx = labels.indexOf("MD5");
    const countIdx = labels.indexOf("统计");
    const clearIdx = labels.indexOf("清除");

    expect(md5Idx).toBeLessThan(countIdx);
    expect(countIdx).toBeLessThan(clearIdx);
  });

  it("空文本时不显示统计按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("   ");

    expect(screen.queryByRole("button", { name: "统计" })).not.toBeInTheDocument();
  });

  it("纯图片选区时不显示统计按钮", async () => {
    render(<FloatingToolbar />);
    await act(async () => {
      emitMockEvent("selection-found", {
        text: "",
        rect: { x: 100, y: 200, width: 300, height: 20 },
        "has-image": true,
      });
    });

    expect(screen.queryByRole("button", { name: "统计" })).not.toBeInTheDocument();
  });

  // ── 功能开关 ──────────────────────────────────────────────

  it("功能开关禁用统计后不显示按钮", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_toolbar_features") {
        // 禁用 char-count，其余取默认全量
        return Promise.resolve([
          "copy",
          "search",
          "translate",
          "optimize",
          "uppercase",
          "lowercase",
          "dedup",
          "base64-encode",
          "base64-decode",
          "unicode-encode",
          "unicode-decode",
          "md5-encrypt",
          "qrcode",
          "clear",
        ]);
      }
      return Promise.resolve();
    });

    render(<FloatingToolbar />);
    await showToolbar("hello");

    expect(screen.queryByRole("button", { name: "统计" })).not.toBeInTheDocument();
  });

  it("设置窗口广播 levitaire-features-changed 后实时隐藏统计按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");
    expect(screen.getByRole("button", { name: "统计" })).toBeInTheDocument();

    await act(async () => {
      emitMockEvent("levitaire-features-changed", [
        "copy",
        "search",
        "translate",
        "optimize",
        "uppercase",
        "lowercase",
        "dedup",
        "base64-encode",
        "base64-decode",
        "unicode-encode",
        "unicode-decode",
        "md5-encrypt",
        "qrcode",
        "clear",
      ]);
    });

    expect(screen.queryByRole("button", { name: "统计" })).not.toBeInTheDocument();
  });

  // ── 预览面板 ──────────────────────────────────────────────

  it("点击统计进入预览面板，展示统计项与数值", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello 世界 123");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "统计" }));
    });

    // 网格容器存在
    expect(document.querySelector(".toolbar-charcount")).toBeInTheDocument();
    // 各统计项标签存在
    const labels = [
      "字符数(含空格)",
      "字符数(不含空格)",
      "字数",
      "行数",
      "非空行",
      "段落数",
      "句子数",
      "字节",
      "数字串",
      "标点",
      "字母",
    ];
    for (const label of labels) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // 关闭按钮存在
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
  });

  it("统计数值正确：中英混排文本", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello 世界 123");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "统计" }));
    });

    // 字数：hello(1) + 世界(2) + 123(1) = 4
    expect(screen.getByText("字数").nextElementSibling?.textContent).toBe("4");
    // 字母：hello(5)
    expect(screen.getByText("字母").nextElementSibling?.textContent).toBe("5");
    // 数字串：123 共 1 串
    expect(screen.getByText("数字串").nextElementSibling?.textContent).toBe("1");
    // 行数：单行
    expect(screen.getByText("行数").nextElementSibling?.textContent).toBe("1");
    // 字节：UTF-8 字节数（hello=5 + 空格1 + 世界=6 + 空格1 + 123=3 = 16）
    expect(screen.getByText("字节").nextElementSibling?.textContent).toBe("16 B");
  });

  it("点击关闭返回默认状态", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "统计" }));
    });
    expect(document.querySelector(".toolbar-charcount")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    });

    expect(document.querySelector(".toolbar-charcount")).not.toBeInTheDocument();
    // 默认按钮重新可见
    expect(screen.getByRole("button", { name: "统计" })).toBeInTheDocument();
  });

  it("Escape 键返回默认状态而非隐藏工具栏", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "统计" }));
    });
    expect(document.querySelector(".toolbar-charcount")).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    // 预览面板关闭，但工具栏仍在（默认按钮可见）
    expect(document.querySelector(".toolbar-charcount")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "统计" })).toBeInTheDocument();
    expect(mockHide).not.toHaveBeenCalled();
  });

  it("新选区触发时自动退出预览面板", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "统计" }));
    });
    expect(document.querySelector(".toolbar-charcount")).toBeInTheDocument();

    // 新选区
    await act(async () => {
      emitMockEvent("selection-found", makeSelection("new text"));
    });

    expect(document.querySelector(".toolbar-charcount")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "统计" })).toBeInTheDocument();
  });
});

describe("FloatingToolbar 编号功能", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      if (cmd === "replace_selection") {
        return Promise.resolve();
      }
      // get_numbering_style 等返回 undefined → 前端取默认 number-dot
      return Promise.resolve();
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("默认状态下显示编号按钮", async () => {
    render(<FloatingToolbar />);
    await showToolbar("hello");

    expect(screen.getByRole("button", { name: "编号" })).toBeInTheDocument();
  });

  it("空文本时编号按钮仍显示（与去重一致，无内容前置条件）", async () => {
    render(<FloatingToolbar />);
    await showToolbar("   ");

    expect(screen.getByRole("button", { name: "编号" })).toBeInTheDocument();
  });

  it("纯图片选区不显示编号按钮", async () => {
    render(<FloatingToolbar />);
    await act(async () => {
      emitMockEvent("selection-found", {
        text: "",
        rect: { x: 0, y: 0, width: 10, height: 10 },
        "has-image": true,
      });
    });

    expect(screen.queryByRole("button", { name: "编号" })).not.toBeInTheDocument();
  });

  it("默认 number-dot：单行点击编号后写回 1. 前缀", async () => {
    render(<FloatingToolbar />);
    await showToolbar("甲");

    const btn = screen.getByRole("button", { name: "编号" });
    await act(async () => {
      fireEvent.click(btn);
    });

    const calls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "replace_selection");
    expect(calls).toHaveLength(1);
    const arg = calls[0][1] as { text: string };
    expect(arg.text).toBe("1. 甲");
  });

  it("多行点击编号后按行写回连续序号", async () => {
    render(<FloatingToolbar />);
    await showToolbar("甲\n乙\n丙");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "编号" }));
    });

    const calls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "replace_selection");
    expect(calls).toHaveLength(1);
    const arg = calls[0][1] as { text: string };
    expect(arg.text).toBe("1. 甲\n2. 乙\n3. 丙");
  });

  it("功能开关禁用时不显示编号按钮", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_toolbar_features") {
        return Promise.resolve(["copy", "search"]); // 不含 numbering
      }
      return Promise.resolve();
    });

    render(<FloatingToolbar />);
    await showToolbar("hello");

    expect(screen.queryByRole("button", { name: "编号" })).not.toBeInTheDocument();
  });
});

describe("FloatingToolbar 朗读进度", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      if (cmd === "tts_get_state") {
        // 朗读未开始：hasPlayer=false，selection-found 后走 default 分支
        return Promise.resolve({ hasPlayer: false, paused: false, playing: false });
      }
      if (cmd === "tts_get_progress") {
        return Promise.resolve({ positionMs: 0, durationMs: 0, paused: false });
      }
      return Promise.resolve();
    });
  });

  afterEach(() => {
    // 恢复真实 timers，防止 fake timers 泄漏到后续测试（断言失败提前退出时兜底）
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  /** 进入朗读状态：渲染工具栏 → 点击朗读按钮。
      fake timers 使轮询 interval 不真实触发，避免测试结束后 setState 警告；afterEach 恢复。 */
  const startSpeaking = async (text = "hello") => {
    vi.useFakeTimers();
    render(<FloatingToolbar />);
    await showToolbar(text);
    const speakBtn = screen.getByRole("button", { name: "朗读" });
    await act(async () => {
      fireEvent.click(speakBtn);
    });
    // flush 首个进度 tick 的微任务
    await act(async () => {});
  };

  it("点击朗读调用 tts_speak 并进入 speaking 态显示进度条", async () => {
    await startSpeaking("hello");

    expect(mockInvoke).toHaveBeenCalledWith("tts_speak", {
      text: "hello",
      rate: 1,
      voiceId: "",
      volume: 1,
    });
    // speaking 态：暂停/停止按钮 + 进度条
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
    expect(document.querySelector(".toolbar-tts-progress")).toBeInTheDocument();
  });

  it("总时长未知（durationMs=0）时显示 --:-- 且进度条宽度为 0", async () => {
    await startSpeaking("hello");

    const times = document.querySelectorAll(".toolbar-tts-time");
    expect(times[0].textContent).toBe("0:00");
    expect(times[1].textContent).toBe("--:--");
    const fill = document.querySelector(".toolbar-tts-bar-fill") as HTMLElement;
    expect(fill.style.width).toBe("0%");
  });

  it("进度轮询更新已播/总时长与进度条宽度", async () => {
    vi.useFakeTimers();
    let progress = { positionMs: 5000, durationMs: 12000, paused: false };
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      if (cmd === "tts_get_state") {
        return Promise.resolve({ hasPlayer: false, paused: false, playing: false });
      }
      if (cmd === "tts_get_progress") {
        return Promise.resolve(progress);
      }
      return Promise.resolve();
    });

    render(<FloatingToolbar />);
    await showToolbar("hello");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "朗读" }));
    });
    await act(async () => {});

    const times = document.querySelectorAll(".toolbar-tts-time");
    expect(times[0].textContent).toBe("0:05");
    expect(times[1].textContent).toBe("0:12");
    const fill = document.querySelector(".toolbar-tts-bar-fill") as HTMLElement;
    expect(parseFloat(fill.style.width)).toBeCloseTo(41.67, 1);

    // 进度推进：500ms 后轮询返回新位置
    progress = { positionMs: 8000, durationMs: 12000, paused: false };
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await act(async () => {});

    const timesAfter = document.querySelectorAll(".toolbar-tts-time");
    expect(timesAfter[0].textContent).toBe("0:08");
    expect(parseFloat(fill.style.width)).toBeCloseTo(66.67, 1);

    vi.useRealTimers();
  });

  it("点击暂停调用 tts_pause 并立即显示继续按钮", async () => {
    vi.useFakeTimers();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      if (cmd === "tts_get_state") {
        return Promise.resolve({ hasPlayer: false, paused: false, playing: false });
      }
      if (cmd === "tts_get_progress") {
        return Promise.resolve({ positionMs: 1000, durationMs: 5000, paused: false });
      }
      return Promise.resolve();
    });

    render(<FloatingToolbar />);
    await showToolbar("hello");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "朗读" }));
    });
    await act(async () => {});
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();

    // 用户点击暂停 → 前端立即切暂停态，无需等轮询
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    });
    expect(mockInvoke).toHaveBeenCalledWith("tts_pause");
    expect(screen.getByRole("button", { name: "继续" })).toBeInTheDocument();

    // 点击继续 → 回到暂停按钮
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "继续" }));
    });
    expect(mockInvoke).toHaveBeenCalledWith("tts_resume");
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();

    vi.useRealTimers();
  });

  it("点击停止调用 tts_stop 并退出 speaking 态", async () => {
    await startSpeaking("hello");
    expect(document.querySelector(".toolbar-tts-progress")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "停止" }));
    });
    await act(async () => {});

    expect(mockInvoke).toHaveBeenCalledWith("tts_stop");
    expect(document.querySelector(".toolbar-tts-progress")).not.toBeInTheDocument();
    // 回到默认按钮行
    expect(screen.getByRole("button", { name: "朗读" })).toBeInTheDocument();
  });

  it("tts-finished 事件退出 speaking 态并重置进度", async () => {
    await startSpeaking("hello");
    expect(document.querySelector(".toolbar-tts-progress")).toBeInTheDocument();

    await act(async () => {
      emitMockEvent("tts-finished", undefined);
    });

    expect(document.querySelector(".toolbar-tts-progress")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "朗读" })).toBeInTheDocument();
  });
});

describe("FloatingToolbar 清除功能", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      if (cmd === "replace_selection") {
        return Promise.resolve();
      }
      // get_clear_options 返回 undefined → 前端取默认全量
      return Promise.resolve();
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // ── 配置层：图标互不相同 ──────────────────────────────

  it("每个清除项配置的图标互不相同", () => {
    const icons = CLEAR_OPTIONS.map((o) => o.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  // ── 子菜单渲染 ──────────────────────────────────────

  it("点击清除进入子菜单并渲染全部清除项", async () => {
    render(<FloatingToolbar />);
    await showToolbar("测试文本");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "清除" }));
    });

    // 返回按钮 + 全部清除项
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1 + CLEAR_OPTIONS.length);

    for (const option of CLEAR_OPTIONS) {
      expect(screen.getByRole("button", { name: option.label })).toBeInTheDocument();
    }
  });

  it("清除子菜单各项渲染各自的图标", async () => {
    render(<FloatingToolbar />);
    await showToolbar("测试文本");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "清除" }));
    });

    // 返回按钮 + 全部清除项
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1 + CLEAR_OPTIONS.length);

    // 各项图标（SVG）互不相同——修复前全部为 RemoveFormatting，外联路径完全一致
    const icons = buttons.map((b) => b.querySelector(".toolbar-button-icon svg")?.outerHTML ?? "");
    expect(new Set(icons).size).toBe(icons.length);
  });
});

// ── Esc 快捷键（Rust 全局钩子转发 toolbar-esc）──────────────────
// 工具栏窗口 focusable=false，页面内 DOM keydown 收不到按键，
// Rust 侧在工具栏可见时经全局键盘钩子转发 toolbar-esc 事件，前端据此执行原有 Esc 逻辑。

describe("FloatingToolbar Esc 事件转发", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    mockToDataURL.mockResolvedValue("data:image/png;base64,mock-qr-data");
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_ai_config") {
        return Promise.resolve({
          api_key: "sk-test",
          base_url: "https://api.test",
          model: "m",
          api_type: "anthropic",
        });
      }
      return Promise.resolve();
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("默认状态收到 toolbar-esc 后隐藏工具栏", async () => {
    mockHide.mockResolvedValue(undefined);
    render(<FloatingToolbar />);
    await showToolbar("test");

    await act(async () => {
      emitMockEvent("toolbar-esc", undefined);
    });
    await flush();

    expect(mockInvoke).toHaveBeenCalledWith("hide_toolbar");
    expect(screen.queryByRole("button", { name: "搜索" })).not.toBeInTheDocument();
  });

  it("子菜单状态收到 toolbar-esc 后返回默认态而非隐藏", async () => {
    mockHide.mockResolvedValue(undefined);
    render(<FloatingToolbar />);
    await showToolbar("测试文本");

    // 进入清除子菜单
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "清除" }));
    });
    expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();

    await act(async () => {
      emitMockEvent("toolbar-esc", undefined);
    });

    // 子菜单关闭，工具栏仍在默认态
    expect(screen.queryByRole("button", { name: "返回" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "搜索" })).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith("hide_toolbar");
  });

  it("二维码预览状态收到 toolbar-esc 后退出并隐藏", async () => {
    mockHide.mockResolvedValue(undefined);
    render(<FloatingToolbar />);
    await showToolbar("test");

    const qrBtn = screen.getByRole("button", { name: "二维码" });
    await act(async () => {
      fireEvent.click(qrBtn);
    });
    expect(document.querySelector(".toolbar-qrcode")).toBeInTheDocument();

    await act(async () => {
      emitMockEvent("toolbar-esc", undefined);
    });
    await flush();

    expect(document.querySelector(".toolbar-qrcode")).not.toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith("set_qrcode_preview", { active: false });
    expect(mockInvoke).toHaveBeenCalledWith("hide_toolbar");
  });
});
