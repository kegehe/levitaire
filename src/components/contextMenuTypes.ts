export type ContextMenuSource = "orb" | "tray" | "pin";

export interface ContextMenuRequest {
  source: ContextMenuSource;
  x: number;
  y: number;
  pinId?: number;
  /**
   * 打开菜单时后端报的「文件暂存架」开关状态。贴图菜单里的「放入暂存架」按它渲染，
   * 尺寸也按它算 —— 窗口尺寸与真实条目数必须一致，否则靠屏幕下沿时会多留/少留一截。
   * 只由 `showContextMenu` 填充；缺省（测试直接构造请求）按开启处理。
   */
  shelfEnabled?: boolean;
}

// The longest Chinese labels fit comfortably with a 17px icon and standard
// pointer target padding; a compact width keeps the menu close to its anchor.
export const CONTEXT_MENU_WIDTH = 184;

/* ── 菜单几何（逻辑 px）—— 必须与 ContextMenu.css 逐项同步 ─────────────── */
/** `.context-menu-item { min-height }`；也是「隐藏一条菜单项」要扣掉的高度。 */
export const CONTEXT_MENU_ITEM_HEIGHT = 34;
/** `.context-menu-group + .context-menu-group`：margin-top 5 + padding-top 5 + border-top 1 */
const GROUP_SEPARATOR = 11;
/** `.context-menu { padding }`，上下各一份 */
const MENU_PADDING = 6;
/** `.context-menu { border: 1px solid }`，上下各一份（box-sizing: border-box） */
const MENU_BORDER = 1;

/**
 * 各来源菜单的「条目数 / 分组间隔数」。
 *
 * ⚠️ 必须与 `ContextMenu.tsx` 的 `CONTEXT_MENUS` 结构一致 —— `ContextMenu.test.ts`
 * 会直接数那份结构来核对本表，改菜单时不同步就会报红。
 * 托盘菜单会**动态插入**一条更新项（`buildTrayUpdateItem`），它不在 `CONTEXT_MENUS` 里，
 * 所以这里是 6 项 / 2 个间隔。
 */
export const CONTEXT_MENU_SHAPE: Record<
  ContextMenuSource,
  { items: number; separators: number }
> = {
  // 5 + 2 + 2 + 3 + 1 = 13 项，5 个分组 → 4 个间隔
  pin: { items: 13, separators: 4 },
  // 3 + 1 = 4 项，2 个分组 → 1 个间隔
  orb: { items: 4, separators: 1 },
  // 3 + 1（更新项）+ 2 = 6 项，3 个分组 → 2 个间隔
  tray: { items: 6, separators: 2 },
};

/**
 * 菜单本体高度（**不含**四周投影留白，留白由 `panelWindowSize` 另加）。
 *
 * 由结构算出而不是写死数字：早期版本把三个值硬编码在 switch 里，注释又漏算了
 * `.context-menu` 的 2px 上下边框，于是菜单内容比窗口高一截（末项/底边框被撑进
 * 留白区）。改成推导后，改菜单只需改 `CONTEXT_MENU_SHAPE` + JSX，两边由测试对齐。
 *
 * `hiddenItems`：按运行时开关动态隐藏的条目数（目前只有贴图菜单的「放入暂存架」）。
 * 调用方必须传**实际渲染**的条目数，否则窗口尺寸与内容对不上。
 */
export function contextMenuHeight(source: ContextMenuSource, hiddenItems = 0): number {
  const { items, separators } = CONTEXT_MENU_SHAPE[source];
  const visibleItems = Math.max(1, items - Math.max(0, hiddenItems));
  return (
    visibleItems * CONTEXT_MENU_ITEM_HEIGHT +
    separators * GROUP_SEPARATOR +
    2 * MENU_PADDING +
    2 * MENU_BORDER
  );
}
