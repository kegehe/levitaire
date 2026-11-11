import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";

/**
 * 源码级守卫：**前端源码禁用浏览器原生对话框（window.alert / window.confirm / window.prompt）**。
 *
 * 背景（真问题，非风格偏好）：WebView2 里的原生对话框是无样式的系统弹窗——字体、配色、
 * 明暗主题、圆角全部不受控，和整个应用的视觉语言完全脱节（文件暂存架的「清空」曾因此
 * 在一块精心做过的浮窗上弹出一张系统脸）。
 *
 * 统一替代品：`src/components/ConfirmDialog.tsx`（遮罩 + 居中卡片 + 危险红确认钮，
 * 默认焦点在「取消」，Esc 取消 / Enter 确认，明暗主题走 token）。破坏性操作直接复用它。
 *
 * 判据：剥掉整行注释后（与 Rust 侧 strip_lineComments 同口径），命中
 * `window.(alert|confirm|prompt)(` 或「前面不是标识符/点/`$` 的裸 `alert(/confirm(/prompt(`」即失败。
 * `dialog.confirm(` 这类对象方法调用不误伤。测试文件豁免（测试里 stub 原生 API 是合法的）。
 */

const TEST_FILE = /(\.test\.|\.spec\.|__tests__)/;
const NATIVE_CALL = /\bwindow\s*\.\s*(alert|confirm|prompt)\s*\(/;
const BARE_CALL = /(^|[^\w.$])(alert|confirm|prompt)\s*\(/;

/** 递归收集 src 下的 .ts/.tsx 源码路径 */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectSources(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const SRC_ROOT = fileURLToPath(new NodeURL("..", import.meta.url));

/** 与 commands/mod.rs::strip_line_comments 同口径：`//` 之前全是空白的行才算注释行 */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const index = line.indexOf("//");
      return index !== -1 && line.slice(0, index).trim() === "" ? "" : line;
    })
    .join("\n");
}

describe("原生对话框守卫", () => {
  it("src 下的前端源码不使用 alert / confirm / prompt", () => {
    const offenders: string[] = [];
    for (const file of collectSources(SRC_ROOT)) {
      if (TEST_FILE.test(file)) continue;
      const text = stripLineComments(readFileSync(file, "utf8"));
      if (NATIVE_CALL.test(text) || BARE_CALL.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("判定本身有效（反向断言：判定失效时不能静默通过）", () => {
    // 必须命中的写法
    expect(NATIVE_CALL.test("window.confirm('x')")).toBe(true);
    expect(NATIVE_CALL.test("window . prompt( 'x' )")).toBe(true);
    expect(BARE_CALL.test("const ok = confirm('清空？');")).toBe(true);
    expect(BARE_CALL.test("alert('出错了');")).toBe(true);
    // 不该命中的写法（防误伤）
    expect(BARE_CALL.test("dialog.confirm('x')")).toBe(false);
    expect(BARE_CALL.test("obj.prompt(x)")).toBe(false);
    expect(BARE_CALL.test("confirmClear('x')")).toBe(false);
    expect(BARE_CALL.test(".alerting('x')")).toBe(false);
    // 整行注释不算调用
    const commented = stripLineComments("// window.confirm('x')");
    expect(NATIVE_CALL.test(commented) || BARE_CALL.test(commented)).toBe(false);
  });
});
