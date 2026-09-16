import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SYSTEM_MONITOR_LAYOUTS } from "../../constants/systemMonitorConfig";

/**
 * 系统监控浮窗的**布局不变量**（源码级守卫）。
 *
 * 为什么读 CSS 文本而不是渲染后断言：jsdom/happy-dom 不做布局，flex 收缩、grid 溢出、
 * 文本截断这些事在单测里量不到（`SystemMonitor.test.tsx` 只能断言结构与文案）。
 * 真值只能靠无头 Chrome 量：`monitor-preview.html`（vite dev + 打桩 `__TAURI_INTERNALS__`
 * 跑**真实组件**），本文件的每一条都注明了对应的实测证据。
 *
 * ⚠️ 立规矩：这里只钉**验证过是承重的**或**有意选择的结构形态**。本次改版我一度加过
 * `.monitor-content > * { flex-shrink: 0 }`（以为"内容偏高会把行压扁"），用变异测试
 *（去掉它、跑 150/100/60px 三档 + GB/s 极端数据）发现行为完全一致 —— 行高是定值，
 * 这些块的最小尺寸就等于内容高度，根本压不动。那条守卫连同 CSS 一起撤掉了。
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const css = read("./SystemMonitor.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** 取某选择器规则块里的声明（同一选择器出现多条规则时按书写顺序合并） */
function declarationsFor(source: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let match = blockRe.exec(source);
  while (match) {
    const selectors = match[1]
      .split(",")
      .map((item) => item.trim().replace(/\s+/g, " "));
    if (selectors.includes(selector)) {
      for (const declaration of match[2].split(";")) {
        const colon = declaration.indexOf(":");
        if (colon > 0) {
          out[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
        }
      }
    }
    match = blockRe.exec(source);
  }
  return out;
}

describe("系统监控浮窗布局不变量", () => {
  it("内容比窗口高时靠滚动兜底（窗口不能拉大，裁掉的部分就再也拿不到）", () => {
    // 实测：?forceHeight=60 时 scrollHeight=246 / clientHeight=13、行高仍 19px、可滚。
    // overflow-y:auto 是承重项；行高是定值则保证"溢出"而不是"被压扁"。
    const content = declarationsFor(css, ".monitor-content");
    expect(content["overflow-y"]).toBe("auto");
    expect(content["flex"]).toBe("1");
    expect(declarationsFor(css, ".monitor-row").height).toBe("19px");
    expect(declarationsFor(css, ".monitor-trow").height).toBe("19px");
  });

  it("数值列装得下最坏取值「1023 MB/s」（变异验证：退回 56px 就被截断 2px）", () => {
    // formatBytes 会一直除到 <1024，所以最坏文本是 9 字符的 "1023 MB/s"（12px 下 ≈59px）。
    // 实测：?layout=e&rateKBs=1047850 → 62px 无截断；把宽度改回 56px 则两行各截断 2px
    // （没有 ellipsis 时会直接压到隔壁次要列上）。
    for (const selector of [".monitor-row-value", ".monitor-trow-value", ".monitor-irow-value"]) {
      const decls = declarationsFor(css, selector);
      expect(Number.parseFloat(decls.width ?? "0"), selector).toBeGreaterThanOrEqual(62);
      expect(decls["white-space"], selector).toBe("nowrap");
      expect(decls["text-overflow"], selector).toBe("ellipsis");
    }
  });

  it("样式类名只能来自样式清单（写错名字不会静默退化成默认间距）", () => {
    const ids = Array.from(css.matchAll(/is-layout-([a-z0-9-]+)/g), (match) => match[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(SYSTEM_MONITOR_LAYOUTS, `CSS 里的 is-layout-${id} 不是合法样式 id`).toContain(id);
    }
  });

  it("双列宫格用 minmax(0, 1fr)（结构性防御：实测 GB/s 极端数据下未触发撑破）", () => {
    // grid 轨道的 `1fr` 隐含最小 auto，长内容会撑破格子。当前内容都有 ellipsis/overflow
    // 兜底，实测（?layout=c&huge=1）没有撑破 —— 这条是防将来内容变化的形态约束，非实测缺陷。
    expect(declarationsFor(css, ".monitor-grid")["grid-template-columns"]).toContain(
      "minmax(0, 1fr)",
    );
  });
});
