import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";

/**
 * 源码级守卫：**凡是会记住位置的窗口，都必须在设置页有「恢复默认位置」入口。**
 *
 * 背景（真 bug，非风格问题）：窗口位置记忆是「前端 `persistWindowPositionOnMove(id)` 挂
 * `onMoved` → 后端 `set_window_position` 落盘 → 下次显示前恢复」这条链路，而**复位入口**
 * 是设置 → 通用 → 悬浮窗位置里那张 `WINDOW_POSITION_TARGETS` 表，两份清单各写各的。
 * 漂移过一次：便利贴管理窗会记位置却**根本没有入口**，用户把窗口拖丢之后没有任何一键复位
 * 的地方；反方向也漂移过：系统清理在前端表里、后端却只复位四扇窗，点一下按钮亮「已恢复」
 * 而窗口纹丝不动（后端那条守卫 `commands::tests::resettable_windows_match_frontend_targets` 管这半边）。
 *
 * 所以这里从**源头**钉住「记位置的窗口清单」：新增一处 `persistWindowPositionOnMove("x")`
 * 就会红，逼人同时补设置页入口（以及后端 `RESETTABLE_WINDOW_IDS` 与 `default_window_position`）。
 *
 * 有意不做入口的窗口（如某种不该被复位的一次性浮层）：加进下面的豁免表并写明理由。
 */
const INTENTIONALLY_NOT_RESETTABLE: Record<string, string> = {};

/** 读取仓库内文件（happy-dom 下 `?raw` 拿不到源码，必须走 node:fs） */
function read(rel: string): string {
  return readFileSync(fileURLToPath(new NodeURL(`../../${rel}`, import.meta.url)), "utf8");
}

/**
 * 剥掉**整行**注释，避免「注释掉的调用」被当成有效调用。
 * 判据与 Rust 侧 `commands/mod.rs::strip_line_comments` 一致：`//` 之前全是空白才算注释行。
 */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const index = line.indexOf("//");
      return index !== -1 && line.slice(0, index).trim() === "" ? "" : line;
    })
    .join("\n");
}

/** 递归列出 `src` 下的生产源码（排除测试与预览桩：它们不参与发货逻辑）。 */
function listSourceFiles(relDir: string): string[] {
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(fileURLToPath(new NodeURL(`../../${rel}`, import.meta.url)), {
      withFileTypes: true,
    })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        // 预览桩跑在 vite dev 里、不是真实窗口组件
        if (entry.name !== "__preview__" && entry.name !== "__real_dom__") walk(child);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        files.push(child);
      }
    }
  };
  walk(relDir);
  return files;
}

/** 从设置页源码里取出「恢复默认位置」表的 id（与 Rust 侧守卫用同一段文本、同一套写法）。 */
function targetIds(): string[] {
  const ts = stripLineComments(read("src/components/Settings.tsx"));
  const start = ts.indexOf("const WINDOW_POSITION_TARGETS = [");
  expect(start, "未找到 WINDOW_POSITION_TARGETS（改名/移动时请同步本守卫）").toBeGreaterThanOrEqual(
    0,
  );
  const rest = ts.slice(start);
  const end = rest.indexOf("] as const;");
  expect(end, "WINDOW_POSITION_TARGETS 未以 `] as const;` 结束").toBeGreaterThanOrEqual(0);
  return [...rest.slice(0, end).matchAll(/\{\s*id:\s*"([^"]+)"/g)].map((match) => match[1]);
}

/** 定义文件：它那行函数声明也是一处 `persistWindowPositionOnMove(`，但不是调用点。 */
const DEFINITION_FILE = "src/utils/windowPosition.ts";

/**
 * 扫描全部生产源码，取出「记位置」的窗口 id，并统计**调用点总数**。
 *
 * 两个数必须相等：写成 `persistWindowPositionOnMove(WINDOW_ID)`（传变量/常量）时 id 解析不出来，
 * 只有数量对不上才暴露 —— 否则新窗口会**静默溜过**本守卫，正是这条守卫要防的那类漂移。
 */
function persistedCallSites(): { ids: string[]; total: number } {
  const callPattern = /persistWindowPositionOnMove\s*\(/g;
  const literalPattern = /persistWindowPositionOnMove\s*\(\s*"([^"]+)"\s*\)/g;
  const ids: string[] = [];
  let total = 0;
  for (const rel of listSourceFiles("src")) {
    if (rel === DEFINITION_FILE) continue;
    const code = stripLineComments(read(rel));
    for (const match of code.matchAll(literalPattern)) ids.push(match[1]);
    total += [...code.matchAll(callPattern)].length;
  }
  return { ids, total };
}

describe("悬浮窗位置记忆 ↔ 恢复入口", () => {
  it("每个会记忆位置的窗口都有「恢复默认位置」入口", () => {
    const { ids, total } = persistedCallSites();
    // 反向断言：扫描面失效（组件换成别的函数、调用被挪走）时不能静默通过
    expect(
      total,
      "没扫到任何 persistWindowPositionOnMove 调用，守卫的解析面已失效",
    ).toBeGreaterThanOrEqual(6);
    expect(
      ids.length,
      `${total} 处调用里只有 ${ids.length} 处写了字面量 id：请统一写成 ` +
        `persistWindowPositionOnMove("窗口label")，传变量时本守卫认不出这个窗口属于谁`,
    ).toBe(total);

    const persisted = [...new Set(ids)].sort();
    const targets = [...new Set(targetIds())].sort();
    // 豁免必须写明理由，否则这条豁免迟早被当成「忘了加」的挡箭牌
    for (const [id, reason] of Object.entries(INTENTIONALLY_NOT_RESETTABLE)) {
      expect(reason.trim().length, `豁免 ${id} 必须写明理由`).toBeGreaterThan(0);
    }
    const missing = persisted.filter(
      (id) => !targets.includes(id) && !(id in INTENTIONALLY_NOT_RESETTABLE),
    );
    expect(
      missing,
      `这些窗口会记住位置却没有恢复入口：${missing.join("、")}。` +
        "请把它们加进 Settings.tsx 的 WINDOW_POSITION_TARGETS（同时补后端 RESETTABLE_WINDOW_IDS " +
        "与 default_window_position），否则用户拖丢之后没有一键复位的地方。",
    ).toEqual([]);
  });

  it("入口表里没有「其实不记位置」的窗口（避免按钮亮「已恢复」却什么都没发生）", () => {
    const persisted = persistedCallSites().ids;
    for (const id of targetIds()) {
      expect(
        persisted.includes(id),
        `WINDOW_POSITION_TARGETS 里的 ${id} 并不记忆位置：后端复位它没有意义，` +
          "请从入口表里删掉（或确认它真的该走位置记忆）",
      ).toBe(true);
    }
  });
});
