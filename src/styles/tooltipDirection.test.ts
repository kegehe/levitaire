import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * CSS tooltip 的「弹出方向」与「是否会被祖先裁掉」回归守卫。
 *
 * 为什么读 CSS 文本、而不是渲染后断言计算值：tooltip 是 `[data-tooltip]::after`，
 * 方向完全由它自身声明的 top / bottom 决定，而 jsdom / happy-dom 都不做布局，
 * 读不到 `::after` 的真实矩形；真值只能靠无头 Chrome 量（手法与实测数据见
 * `D:\tmp\tooltip-audit\`：回读 `getComputedStyle(el, "::after")` 的 used 值，
 * 与最近的 overflow 裁剪祖先求交）。
 * 所以这里退化为一层「声明级」守卫：对每个已知会踩坑的选择器，取源码里**最后**
 * 一处声明（这些覆盖规则与基础规则同特异性、靠书写顺序取胜），断言方向是预期值。
 *
 * 历史坑（两条都真的出现过，且都是「浮层在鼠标下方、下面已经到底 → 完全看不到」）：
 *   1. `.timer-controls` 是每个视图的最后一行，向下弹会被 `.timer-shell { overflow: hidden }`
 *      沿面板底边裁掉 100%（倒计时「+1 分钟」/ 重置、秒表分段、番茄钟跳过）。
 *   2. `.monitor-titlebar` 展开态只有 27px 高、且自身 `overflow: hidden`，
 *      向下弹的标题栏 tooltip 被它自己裁掉 100% —— 监控窗标题栏按钮悬停毫无提示。
 *      该标题栏已在「显示样式」改版中改为**常驻 22px 的 `.monitor-head`**（不再折叠、
 *      不再设 overflow），但**不得再把 overflow 加回来**：它就是下面那条守卫钉住的事。
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** 去掉注释与 @media / @keyframes（含嵌套块），只保留普通规则 —— 方向只在这些规则里 */
function stripAtRules(css: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "";
  let index = 0;
  while (index < source.length) {
    const at = source.indexOf("@", index);
    if (at < 0) {
      out += source.slice(index);
      break;
    }
    out += source.slice(index, at);
    const brace = source.indexOf("{", at);
    if (brace < 0) break;
    let depth = 0;
    let cursor = brace;
    for (; cursor < source.length; cursor += 1) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") {
        depth -= 1;
        if (depth === 0) {
          cursor += 1;
          break;
        }
      }
    }
    index = cursor;
  }
  return out;
}

interface Rule {
  selectors: string[];
  decls: Map<string, string>;
}

function parseRules(css: string): Rule[] {
  const stripped = stripAtRules(css);
  const rules: Rule[] = [];
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let match = blockRe.exec(stripped);
  while (match) {
    const selectors = match[1]
      .split(",")
      .map((selector) => selector.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    const decls = new Map<string, string>();
    for (const declaration of match[2].split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      decls.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
    rules.push({ selectors, decls });
    match = blockRe.exec(stripped);
  }
  return rules;
}

/** 以书写顺序折叠同一选择器的声明（同特异性 → 后者胜，与本文件的用法一致） */
function declarationsFor(rules: Rule[], selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rules) {
    if (!rule.selectors.includes(selector)) continue;
    for (const [prop, value] of rule.decls) out[prop] = value;
  }
  return out;
}

function directionOf(rules: Rule[], selector: string): "up" | "down" | "unknown" {
  const decls = declarationsFor(rules, selector);
  const top = decls.top ?? "auto";
  const bottom = decls.bottom ?? "auto";
  if (top === "auto" && bottom !== "auto") return "up";
  if (bottom === "auto" && top !== "auto") return "down";
  return "unknown";
}

const timerRules = parseRules(read("../tools/timer/TimerTool.css"));
const monitorRules = parseRules(read("../tools/system-monitor/SystemMonitor.css"));
const screenshotRules = parseRules(read("../tools/screenshot/ScreenshotTool.css"));
const sketchRules = parseRules(read("../tools/sketch/SketchTool.css"));

describe("时间工具 tooltip 方向", () => {
  it("底部控制区一律向上弹（面板底边会裁掉向下弹的浮层）", () => {
    // 三个视图共用的控制条 + 倒计时页签的预设行 / 预设编辑行
    for (const selector of [
      ".timer-controls button[data-tooltip]::after",
      ".timer-presets button[data-tooltip]::after",
      ".timer-preset-editor button[data-tooltip]::after",
    ]) {
      expect(directionOf(timerRules, selector), selector).toBe("up");
    }
  });

  it("顶部工具条与日历工具条仍向下弹（下方是内容区，不会被裁）", () => {
    for (const selector of [
      ".timer-actions button[data-tooltip]::after",
      ".calendar-toolbar button[data-tooltip]::after",
    ]) {
      expect(directionOf(timerRules, selector), selector).toBe("down");
    }
  });
});

describe("系统监控头部：浮层不被裁 + 高度恒定", () => {
  it("头部与按钮组都不得成为裁剪祖先", () => {
    // 头部只有 22px 高，一旦给它 overflow，向下弹的浮层会被它整块裁掉（历史坑 2）。
    // 最近的裁剪祖先只能是 .monitor-body（窗口整块，padding box 足够高，不裁浮层）。
    expect(declarationsFor(monitorRules, ".monitor-head").overflow).toBeUndefined();
    expect(declarationsFor(monitorRules, ".monitor-actions").overflow).toBeUndefined();
  });

  it("头部高度常驻 22px：悬停只能改颜色/透明度，不得改任何尺寸", () => {
    const head = declarationsFor(monitorRules, ".monitor-head");
    expect(head.height).toBe("22px");
    expect(head["max-height"]).toBeUndefined();

    // 取代旧「hover 展开 27px 标题栏」的机制：只把按钮组的透明度从 0 提到 1
    const revealed = declarationsFor(
      monitorRules,
      ".monitor-body.is-controls-visible .monitor-actions",
    );
    expect(revealed.opacity).toBe("1");

    // 旧实现靠 :hover 把标题栏从 max-height:0 展开到 27px，而窗口高度自适应 effect 又跟着
    // 悬停重算 ⇒ 鼠标一进窗口就 setSize 长高 43px（实测 579 → 622）。
    // 因此这张样式表里**任何** hover 规则都不许声明尺寸类属性 —— 守卫面是整个文件，
    // 这样将来在别的选择器上再引入"悬停长高"也会被拦住。
    const forbidden = [
      "height",
      "max-height",
      "min-height",
      "padding",
      "padding-top",
      "padding-bottom",
      "margin",
      "margin-top",
      "margin-bottom",
      "gap",
    ];
    for (const rule of monitorRules) {
      for (const selector of rule.selectors) {
        // `is-controls-visible` 是由鼠标进入/离开驱动的状态类，与 :hover 同性质
        if (!selector.includes(":hover") && !selector.includes("is-controls-visible")) continue;
        for (const property of forbidden) {
          expect(
            rule.decls.has(property),
            `${selector} 在悬停时声明了 ${property}：悬停不得改变任何尺寸（窗口会跟着 setSize）`,
          ).toBe(false);
        }
      }
    }
  });

  it("头部按钮的浮层仍是向下弹（头部在窗口顶部，向上会掉出窗口）", () => {
    expect(directionOf(monitorRules, ".monitor-icon-btn[data-tooltip]::after")).toBe("down");
    expect(directionOf(monitorRules, ".monitor-style-btn[data-tooltip]::after")).toBe("down");
  });
});

describe("截图工具 tooltip 不越出窗口上边界", () => {
  it("标注工具栏翻到选区上方时改为向下弹", () => {
    expect(
      directionOf(
        screenshotRules,
        ".ss-toolbar-wrap.ss-toolbar-above .ss-btn[data-tooltip]::after",
      ),
    ).toBe("down");
    // 默认（工具栏在选区下方）保持向上弹
    expect(directionOf(screenshotRules, ".ss-btn[data-tooltip]::after")).toBe("up");
  });

  it("OCR 结果面板的头按钮改为向下弹（面板可能贴着屏幕顶边）", () => {
    expect(directionOf(screenshotRules, ".ss-ocr-result-header .ss-btn[data-tooltip]::after")).toBe(
      "down",
    );
  });
});

describe("素描工具浮层不越出窗口上边界", () => {
  // 素描工具不用 ::after，而是由 JS 定位一个真实元素（.sketch-tooltip），方向靠 transform 决定：
  // 默认 translate(-50%, -100%) → top 指到按钮上方；按钮上方净空不足时加 --below 去掉 -100%。
  it("默认向上弹，--below 修饰类向下弹", () => {
    expect(declarationsFor(sketchRules, ".sketch-tooltip").transform).toBe(
      "translate(-50%, -100%)",
    );
    expect(declarationsFor(sketchRules, ".sketch-tooltip.sketch-tooltip--below").transform).toBe(
      "translate(-50%, 0)",
    );
  });
});
