import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 面板的滚动容器是**承重**的。
 *
 * 清理面板的窗口是固定尺寸且 `resizable: false`，内容（十来个清理项 + 每项展开的后果
 * 文案 + 报告 + 「不建议清理」）必然超出窗口高度。一旦中段没有 `overflow-y: auto`，
 * 超出部分会被 `.cleaner-body` 的 `overflow: hidden` 永久裁掉 —— 用户既看不到、
 * 也够不着，而窗口又拉不大。`system-monitor` 踩过同一个坑（见其 layout 用例）。
 *
 * 与 `windowInstanceGuard` 一样走 `readFileSync` 读源码而不是 `?raw`：
 * happy-dom 下 `?raw` 拿不到仓库源码。
 */
const NEWLINE = String.fromCharCode(10);

/** 剥掉整行注释。说明文字里也会出现 `getCurrentWebviewWindow()` 这样的字样，
 *  不剥的话"禁止裸取窗口实例"这条会被自己的注释绊倒。 */
function stripLineComments(text: string): string {
  return text
    .split(NEWLINE)
    .map((line) => {
      const index = line.indexOf("//");
      return index >= 0 && line.slice(0, index).trim() === "" ? "" : line;
    })
    .join(NEWLINE);
}

/** 剥掉块注释，避免 CSS 注释里的 `overflow-y: auto` 被当成真实规则。 */
function stripBlockComments(text: string): string {
  const start = "/*";
  const end = "*/";
  let out = text;
  for (;;) {
    const from = out.indexOf(start);
    if (from < 0) return out;
    const to = out.indexOf(end, from + start.length);
    if (to < 0) return out.slice(0, from);
    out = out.slice(0, from) + out.slice(to + end.length);
  }
}

const source = stripLineComments(
  readFileSync(join(process.cwd(), "src/tools/system-cleaner/SystemCleanerTool.tsx"), "utf8"),
);
const css = stripBlockComments(
  readFileSync(join(process.cwd(), "src/tools/system-cleaner/SystemCleanerTool.css"), "utf8"),
);

describe("系统清理面板的布局约束", () => {
  it("中段有滚动容器，且它是 flex 里可压缩的那一段", () => {
    expect(source).toContain('className="cleaner-scroll"');
    expect(css).toMatch(/\.cleaner-scroll\s*\{[^}]*overflow-y:\s*auto/);
    // min-height: 0 不能省：flex 子项默认 min-height: auto，内容再高也不会收缩，
    // 结果是滚动条不出现、整段被祖先的 overflow: hidden 裁掉。
    expect(css).toMatch(/\.cleaner-scroll\s*\{[^}]*min-height:\s*0/);
  });

  it("外壳用 overflow: hidden 收圆角，滚动只由中段承担", () => {
    expect(css).toMatch(/\.cleaner-body\s*\{[^}]*overflow:\s*hidden/);
    // 两层滚动条会让用户不知道在滚哪一层
    const autoScrolls = css.match(/overflow-y:\s*auto/g) ?? [];
    expect(autoScrolls).toHaveLength(1);
  });

  it("面板不做尺寸自适应 —— 没有 setSize 就不需要配 clamp", () => {
    // 与 windowInstanceGuard 的第二组用例对账：本组件刻意不进 CLAMPED_WINDOW_COMPONENTS，
    // 前提就是它从不 setSize。哪天加了自适应尺寸，这条会红，提醒去补 clamp。
    expect(source).not.toContain(".setSize(");
    expect(source).not.toContain("clampWindowToWorkArea(");
  });

  it("不取窗口实例 —— 固定尺寸面板不需要它", () => {
    // 需要 window 实例的浮窗必须 memo 成稳定引用（否则自激渲染循环，见
    // windowInstanceGuard）；本组件既然用不到，就干脆不取，免得留下一个裸取的坏样例。
    expect(source).not.toContain("getCurrentWebviewWindow(");
  });

  it("标题栏可以拖动窗口（整扇窗都靠它移动）", () => {
    expect(source).toContain("data-tauri-drag-region");
  });

  it("ready 握手双向都在：挂载即广播，收到 request 再广播", () => {
    // 建窗侧有 5s 超时 + 100ms 重发，少任何一半都会让窗口「建了却永远不 ready」
    expect(source).toContain('emit("system-cleaner-window-ready")');
    expect(source).toContain('listen("system-cleaner-window-ready-request"');
  });
});
