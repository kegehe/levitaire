import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UtilityHub from "./UtilityHub";
import { clearMockListeners, emitMockEvent } from "../../test/tauri-mock";

const mockInvoke = vi.mocked(invoke);

/**
 * 标题栏拖拽手柄的「声明级」真值：jsdom 不做布局，量不到 flex 撑开后手柄/工具按钮的
 * 实际落点，只能对着 CSS 源码断言（同 src/styles/tooltipDirection.test.ts 的思路）。
 * 用 node:url 的 URL 解析：jsdom 环境里全局 URL 被换掉，fileURLToPath 会认不出来。
 */
function readHubCss(): string {
  const css = readFileSync(fileURLToPath(new NodeURL("./UtilityHub.css", import.meta.url)), "utf8");
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
}

describe("UtilityHub", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
    localStorage.removeItem("levitaire-utility-recent-colors");
    mockInvoke.mockImplementation((command) => {
      if (command === "get_scroll_navigation_state") {
        return Promise.resolve({ precise: false, percent: null, fallbackAvailable: true });
      }
      return Promise.resolve(undefined);
    });
  });

  it("shows the small-tool row and opens scroll navigation in place", async () => {
    render(<UtilityHub />);
    expect(screen.getByRole("button", { name: /取色/ })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: /滚动/ }));
    expect(screen.getByRole("button", { name: /滚动/ })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("button", { name: "到达顶部" })).toBeEnabled();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("get_scroll_navigation_state"));
  });

  it("reserves native window space above the compact content for tooltips", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 120,
      height: 36,
    } as DOMRect);

    render(<UtilityHub />);

    expect(document.body).toHaveClass("utility-hub-window");
    // 留白区同时是拖拽面（Tauri 的 drag region 只认命中元素自身，挂 body 上正好
    // 只覆盖留白），否则那圈透明留白会变成吞点击的死区。
    expect(document.body).toHaveAttribute("data-tauri-drag-region");

    const window = (await import("@tauri-apps/api/webviewWindow")).getCurrentWebviewWindow();
    await waitFor(() => {
      // 面板 120×36 + 顶部 26px tooltip 安全区 + 底部 20px 投影留白，宽 120 + 2×20。
      // 窗口尺寸必须大于面板尺寸：等于时投影没有展开空间，会被窗口边界硬切成
      // 四角的直角残影。
      expect(window.setSize).toHaveBeenCalledWith(
        expect.objectContaining({ width: 160, height: 82 }),
      );
    });
  });

  it("starts native color sampling and displays its returned pixel", async () => {
    render(<UtilityHub />);
    fireEvent.click(screen.getByRole("button", { name: /取色/ }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("start_utility_color_pick"));
    expect(screen.getByRole("button", { name: /取色/ }).querySelector("svg")).toHaveClass(
      "lucide-pipette",
    );

    emitMockEvent("utility-color-picked", "#123ABC");
    expect(await screen.findByDisplayValue("#123ABC")).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith("show_utility_hub");
  });

  it("keeps native sampling armed for repeated color picks", async () => {
    render(<UtilityHub />);
    fireEvent.click(screen.getByRole("button", { name: /取色/ }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("start_utility_color_pick"));

    emitMockEvent("utility-color-picked", "#123ABC");
    emitMockEvent("utility-color-picked", "#FEDCBA");

    expect(await screen.findByDisplayValue("#FEDCBA")).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith("stop_utility_color_pick");
  });

  it("stops sampling through the native cleanup paths when switching tools or closing", () => {
    render(<UtilityHub />);

    fireEvent.click(screen.getByRole("button", { name: /滚动/ }));
    expect(mockInvoke).toHaveBeenCalledWith("stop_utility_color_pick");

    fireEvent.click(screen.getByRole("button", { name: /关闭/ }));
    expect(mockInvoke).toHaveBeenCalledWith("hide_utility_hub");
  });

  it("shows the picked color as rgb and copies that value", async () => {
    render(<UtilityHub />);
    fireEvent.click(screen.getByRole("button", { name: /取色/ }));
    emitMockEvent("utility-color-picked", "#123ABC");
    await screen.findByDisplayValue("#123ABC");

    const rgbButton = screen.getByRole("button", { name: "复制 RGB 值" });
    expect(rgbButton).toHaveTextContent("rgb(18, 58, 188)");

    fireEvent.click(rgbButton);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("copy_text", { text: "rgb(18, 58, 188)" }),
    );
  });

  it("persists picked colors so the history survives a remount", async () => {
    const first = render(<UtilityHub />);
    fireEvent.click(screen.getByRole("button", { name: /取色/ }));
    emitMockEvent("utility-color-picked", "#123ABC");
    await screen.findByDisplayValue("#123ABC");

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem("levitaire-utility-recent-colors") ?? "null")).toEqual(
        ["#123ABC"],
      );
    });
    first.unmount();

    // 重挂载后历史仍在，切到取色面板即可看到色块
    render(<UtilityHub />);
    fireEvent.click(screen.getByRole("button", { name: /取色/ }));
    expect(await screen.findByRole("button", { name: "选择 #123ABC" })).toBeInTheDocument();
  });

  it("ignores a corrupted color history instead of crashing", () => {
    localStorage.setItem("levitaire-utility-recent-colors", "{not json");
    render(<UtilityHub />);
    fireEvent.click(screen.getByRole("button", { name: /取色/ }));
    expect(screen.queryByRole("button", { name: /^选择 #/ })).toBeNull();
  });

  it("keeps the header grip at a fixed width instead of a stretchy blank", () => {
    // 旧实现 `.utility-hub-drag-space { flex: 1 }` 是纯空白条：取色 / 滚动导航面板
    // （220 / 216px）比标题栏内容宽得多，空白被撑成一大片空场，按钮前一片空。
    const hubCss = readHubCss();
    expect(hubCss).not.toMatch(/\.utility-hub-drag-space\s*\{/);

    const grip = /\.utility-hub-grip\s*\{([^}]*)\}/.exec(hubCss);
    expect(grip).not.toBeNull();
    const decls = grip![1].trim();
    expect(decls).toContain("flex: 0 0 auto");
    expect(decls).toContain("width: 16px");
  });

  it("keeps the tool buttons packed against the close button instead of spread apart", () => {
    // 面板宽度跟着标题栏内容走：有几个工具按钮就并排几个，工具按钮与关闭按钮之间不留
    // 空档。旧实现写死 120px 再给关闭按钮 `margin-left: auto`，两者之间会空出一截。
    const hubCss = readHubCss();
    const ruleOf = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const found = new RegExp(`(?:^| )${escaped} \\{([^}]*)\\}`).exec(hubCss);
      expect(found, `${selector} 规则缺失`).not.toBeNull();
      return found![1];
    };

    // 必须是 max-content 而不是 fit-content：面板宽度是「量完拿去 setSize 定窗口」的输入
    //（见 UtilityHub.tsx 的 resizeToContent），一旦被可用空间钳制就成了反馈环 —— 窗口偏窄
    // 时面板被压窄、量到的仍是窄值，窗口再也长不回去，关闭按钮会永久卡在面板边框外。
    expect(ruleOf(".utility-hub")).toContain("width: max-content");
    // 按钮组整体靠右：关闭按钮留在右上角，工具按钮紧挨其左。
    expect(ruleOf(".utility-hub-actions")).toContain("justify-content: flex-end");
    expect(hubCss).not.toContain("margin-left: auto");
  });

  it("keeps the added scroll-nav controls on the hub's compact scale", () => {
    // 通用工具是滚动导航唯一的使用场景，面板宽 216px；而 ScrollNavigator.css 里那套尺寸
    // 是给独立窗口（248px）写的。新增的滚动导航控件必须在 UtilityHub.css 补一份紧凑覆盖，
    // 漏补就会在这里按大一号渲染（旧实现只覆盖了原有的百分比 / 预设那几块）。
    const hubCss = readHubCss();
    const declsOf = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const found = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(hubCss);
      expect(found, `${selector} 缺少紧凑覆盖`).not.toBeNull();
      return found![1];
    };

    expect(declsOf(".utility-hub .scroll-nav-hint")).toContain("font-size: 10px");
    expect(declsOf(".utility-hub .scroll-nav-steps button")).toContain("min-height: 23px");
    expect(declsOf(".utility-hub .scroll-nav-recover button")).toContain("min-height: 20px");
    expect(declsOf(".utility-hub .scroll-nav-error")).toContain("font-size: 10px");
  });

  it("puts the grip first and marks the whole titlebar as a drag region", () => {
    render(<UtilityHub />);
    const header = document.querySelector(".utility-hub-header");
    expect(header).not.toBeNull();

    // 必须是 "deep"：裸属性只在「该元素自己就是命中元素」时生效
    // （tauri 2.11.3 window/scripts/drag.js: `return el === composedPath[0]`，不向上传播）。
    // 中段留白的命中元素是 flex:1 的 .utility-hub-actions，裸属性到不了它，
    // 那段留白就会变成拖不动的死区；按钮不受影响——drag.js 对「可点击元素 + 无属性」
    // 会直接 return false，所以按钮照旧可点。
    expect(header).toHaveAttribute("data-tauri-drag-region", "deep");

    const grip = header!.firstElementChild;
    expect(grip).toHaveClass("utility-hub-grip");
    // 手柄只做视觉指示（六个点由 mask 画在元素自身上），不留子节点
    expect(grip!.childElementCount).toBe(0);
    // 手柄后紧跟工具按钮组，中间不再夹着可撑开的空白
    expect(grip!.nextElementSibling?.contains(screen.getByRole("button", { name: "取色" }))).toBe(
      true,
    );
  });

  it("opens the window-pin panel from the titlebar and stops the colour picker", async () => {
    render(<UtilityHub />);
    fireEvent.click(screen.getByRole("button", { name: "窗口置顶" }));

    expect(screen.getByRole("button", { name: "窗口置顶" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // 取色与窗口置顶都要接管系统光标，切过去必须先停掉取色。
    expect(mockInvoke).toHaveBeenCalledWith("stop_utility_color_pick");
    expect(await screen.findByRole("button", { name: /点选目标窗口/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "窗口置顶" }).querySelector("svg")).toHaveClass(
      "lucide-app-window",
    );
  });

  it("leaves window-pin picking when the user switches back to the colour picker", async () => {
    render(<UtilityHub />);
    fireEvent.click(screen.getByRole("button", { name: "窗口置顶" }));
    fireEvent.click(screen.getByRole("button", { name: /取色/ }));

    // 不退出置顶点选的话，退出取色时恢复出来的是准星，而准星那套模式已经不在跑了。
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("stop_window_pin_pick"));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("start_utility_color_pick"));
  });

  it("leaves window-pin picking when the user switches to scroll navigation", async () => {
    render(<UtilityHub />);
    fireEvent.click(screen.getByRole("button", { name: "窗口置顶" }));
    fireEvent.click(screen.getByRole("button", { name: /滚动/ }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("stop_window_pin_pick"));
    expect(screen.getByRole("button", { name: /滚动/ })).toHaveAttribute("aria-pressed", "true");
  });
});
