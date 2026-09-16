import { describe, it, expect } from "vitest";
import "../test/tauri-mock";
import {
  CONTEXT_MENU_SHAPE,
  CONTEXT_MENU_WIDTH,
  contextMenuHeight,
} from "./contextMenuTypes";
import { buildTrayUpdateItem, CONTEXT_MENUS } from "./ContextMenu";
import type { UpdateSnapshot } from "../hooks/useUpdater";

/**
 * 托盘菜单「更新」项的文字宽度预算。
 *
 * 为什么需要守卫：菜单窗口宽度取固定的 `CONTEXT_MENU_WIDTH`，而 `.context-menu-item`
 * 是 `white-space: nowrap` —— 文案一旦超宽不会换行、也不会缩略，只会溢出卡片边框、
 * 被窗口边界硬切（截图 / 慢速链路下才出现，肉眼测试很容易漏），且 tsc / eslint / 渲染测试
 * 都看不见。
 *
 * 预算推算（均为逻辑 px）：184 卡片宽 − 1×2 边框 − 6×2 卡片内边距 − 10×2 条目内边距
 * − 17 图标 − 10 间距 = **123**。
 */
const LABEL_BUDGET_PX = CONTEXT_MENU_WIDTH - 2 - 12 - 20 - 17 - 10;
/** 与 ContextMenu.css 的 `.context-menu { font-size: 13px }` 对齐 */
const FONT_SIZE_PX = 13;
/** 13px 字号下典型的半角字符宽（数字/字母在 Segoe UI 里约 7px） */
const HALF_WIDTH_PX = 7;

/** 按「全角 = 字号，半角 = 7px」粗估一行文字宽度 */
function estimateTextWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef…]/.test(char)
      ? FONT_SIZE_PX
      : HALF_WIDTH_PX;
  }
  return width;
}

function snapshotWith(partial: Partial<UpdateSnapshot>): UpdateSnapshot {
  return {
    version: "0.1.6",
    notes: "",
    phase: "idle",
    received: 0,
    total: null,
    error: null,
    ...partial,
  };
}

/** 覆盖 `buildTrayUpdateItem` 的每个分支（新增分支时必须补进来） */
const ALL_STATES: Array<[string, Parameters<typeof buildTrayUpdateItem>]> = [
  [
    "检查更新",
    [snapshotWith({ phase: "idle" }), { checking: false, failed: false, installing: false, upToDate: false }],
  ],
  [
    "正在检查",
    [snapshotWith({ phase: "idle" }), { checking: true, failed: false, installing: false, upToDate: false }],
  ],
  [
    "已是最新",
    [snapshotWith({ phase: "idle" }), { checking: false, failed: false, installing: false, upToDate: true }],
  ],
  [
    "下载中（总量已知）",
    [
      snapshotWith({ phase: "downloading", received: 96_000_000, total: 96_000_000 }),
      { checking: false, failed: false, installing: false, upToDate: false },
    ],
  ],
  [
    "下载中（总量未知）",
    [
      snapshotWith({ phase: "downloading", received: 1_024, total: null }),
      { checking: false, failed: false, installing: false, upToDate: false },
    ],
  ],
  [
    "已就绪",
    [snapshotWith({ phase: "ready" }), { checking: false, failed: false, installing: false, upToDate: false }],
  ],
  [
    "更新失败",
    [
      snapshotWith({ phase: "failed", error: "下载失败: 连接超时" }),
      { checking: false, failed: true, installing: false, upToDate: false },
    ],
  ],
  [
    "安装中",
    [snapshotWith({ phase: "ready" }), { checking: false, failed: false, installing: true, upToDate: false }],
  ],
];

describe("托盘菜单「更新」项文案必须放得下", () => {
  it("预估宽度算了 8 个分支（防止清单过期空跑）", () => {
    expect(ALL_STATES.length).toBe(8);
  });

  it("每个分支的文案都不超过可用宽度", () => {
    for (const [name, [snapshot, flags]] of ALL_STATES) {
      const item = buildTrayUpdateItem(snapshot, flags);
      const width = estimateTextWidth(item.label);
      expect(
        width,
        `「${item.label}」（${name}）约 ${width}px，超出 ${LABEL_BUDGET_PX}px 预算，会被窗口边界裁掉`,
      ).toBeLessThanOrEqual(LABEL_BUDGET_PX);
    }
  });

  it("估算器本身有牙：确实过长的文案会被判超预算", () => {
    // 回归用：这正是改版时差点写进去的那句（12 个全角字 + 省略号 ≈ 169px）
    expect(estimateTextWidth("正在安装，应用即将重启…")).toBeGreaterThan(LABEL_BUDGET_PX);
  });

  it("预算值与菜单几何一致（改动 CONTEXT_MENU_WIDTH 时会提醒复核）", () => {
    expect(LABEL_BUDGET_PX).toBe(123);
  });
});

/**
 * 菜单窗口高度必须与菜单内容一致。
 *
 * 背景：`showContextMenu` 按 `contextMenuHeight(source)` 设窗口高度，而 `.context-menu`
 * 是 `min-height: 100%` —— 窗口高度算小了，菜单内容就会撑出预留格（末项与底边框落进
 * 给投影留的透明区）。三个高度常量过去是硬编码在 switch 里的，注释还漏算了
 * `.context-menu` 的 2px 上下边框，于是三处都少了 2px。现在高度由结构推导，
 * 本用例负责盯住「结构表 ↔ 真实菜单」这一对不会漂移。
 */
describe("菜单窗口高度必须与菜单结构一致", () => {
  it("CONTEXT_MENU_SHAPE 的条目数/分组间隔数与真实菜单结构一致", () => {
    for (const source of ["pin", "orb"] as const) {
      const groups = CONTEXT_MENUS[source];
      expect(CONTEXT_MENU_SHAPE[source].items, `${source} 的条目数`).toBe(groups.flat().length);
      expect(CONTEXT_MENU_SHAPE[source].separators, `${source} 的分组间隔数`).toBe(
        groups.length - 1,
      );
    }
    // 托盘菜单 = 静态两段 + 运行时插入的更新项（单独成组）⇒ 条目 +1、间隔 +1
    const tray = CONTEXT_MENUS.tray;
    expect(CONTEXT_MENU_SHAPE.tray.items).toBe(tray.flat().length + 1);
    expect(CONTEXT_MENU_SHAPE.tray.separators).toBe(tray.length);
  });

  it("高度按几何推导（常量漏算边框就会在这里报红）", () => {
    // 34N + 11G + 2×6 padding + 2×1 border
    expect(contextMenuHeight("orb")).toBe(161);
    expect(contextMenuHeight("tray")).toBe(206);
    expect(contextMenuHeight("pin")).toBe(466);
  });
});
