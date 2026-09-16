import type { MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * 把**当前窗口**夹回所在显示器的工作区（Rust 侧 `clamp_window_to_workarea` 的封装）。
 *
 * 落点由后端按光标/选区/记忆位置算出，且只在**首次定位**时夹过；而窗口的最终尺寸是
 * 这里量完内容才下发的。贴屏幕右/下沿的窗口在内容变高变宽后（日历切视图 320→380、
 * 监控切 full、便签加行、面板换页、工具栏弹出二维码预览）会有一部分跑到工作区外 ——
 * 这些窗口都是无边框置顶窗、没有滚动条，内容会直接被裁掉。
 *
 * 用法：每次 `setSize` 之后调用，`width` / `height` 传**刚下发的那组逻辑尺寸**，
 * 不要读 `outerSize()`（setSize 是异步投递的，读到的是旧值）。
 */
export function clampWindowToWorkArea(width: number, height: number): void {
  void invoke("clamp_window_to_workarea", { width, height }).catch(() => {});
}

/**
 * 悬浮面板窗口四周的透明留白（逻辑像素）。
 *
 * 原生窗口 = 面板视觉尺寸 + 2×留白。留白是给面板的 CSS 投影展开用的：窗口尺寸若
 * 等于面板尺寸，投影就没有任何展开空间，只在面板圆角的「缺口」里露出一小块
 * （半径 r 的缺口最深 r×(√2−1)），并被窗口边界硬切成直角 —— 表现为「圆角面板的
 * 四角贴着一块直角阴影」。而缺口正好压在面板边界上，投影在那里接近最大浓度，
 * 所以即使缺口只有 3px，暗化也能到 15% 量级，肉眼可见。
 *
 * ⚠️ 三处必须同步，改一处必须同时改另外两处：
 *   1. CSS：`body.<窗口>-window { padding: … }`，面板四周留出同样宽度的空白；
 *   2. 本常量：前端用 panelWindowSize() 把面板尺寸换算成窗口尺寸；
 *   3. Rust：定位窗口时扣掉留白（否则面板相对锚点整体偏移一个留白）。
 *
 * 另有一条硬约束：投影的「模糊半径/2 + 垂直偏移」不得超过这个留白，否则超出部分
 * 仍会被窗口边界硬切。见 tokens.css / themePreferences 里 --palette-shadow 的注释。
 *
 * 注：ToolPalette 用的是同一思路的另一种写法（.palette-stage 包裹层 + Rust 的
 * PALETTE_SHADOW_MARGIN），因为它的窗口尺寸是按包裹层实测的，不需要前端常量。
 */
export const PANEL_SHADOW_MARGIN = 20;

/**
 * 面板尺寸 → 原生窗口尺寸（四周让出投影留白）。
 *
 * `topGutter`：面板上方额外的透明安全区（例如 tooltip 向上弹出所需的空间）。
 * 它比留白宽时按它算，不再叠加留白，避免顶部多出一条无谓的空白 —— 对应 CSS 里
 * `body.<窗口>-window { padding: <topGutter> <留白> <留白> }` 的写法。
 */
export function panelWindowSize(
  width: number,
  height: number,
  topGutter = 0,
): { width: number; height: number } {
  const top = Math.max(PANEL_SHADOW_MARGIN, Math.ceil(topGutter));
  return {
    width: Math.max(0, Math.ceil(width)) + PANEL_SHADOW_MARGIN * 2,
    height: Math.max(0, Math.ceil(height)) + top + PANEL_SHADOW_MARGIN,
  };
}

/**
 * 这次 mousedown 是否落在窗口的投影留白上（面板之外的透明区域）。
 *
 * 留白仍然属于原生窗口：原生层不会把点击透给桌面，面板也不会因此失焦 —— 不处理
 * 就变成一圈「吞点击」的死区（用户点在面板边上以为点到了桌面，面板却毫无反应）。
 * 各面板应把它当作「点了面板外面」处理，与失焦隐藏保持同一语义。
 */
export function isShadowMarginClick(event: ReactMouseEvent | MouseEvent): boolean {
  if (event.button !== 0) return false;
  const target = event.target as Node | null;
  return target === document.body || target === document.documentElement;
}
