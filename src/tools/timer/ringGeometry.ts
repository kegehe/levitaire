/**
 * 倒计时 / 番茄钟共用的进度环几何与强调阈值。
 *
 * 两个页签的进度环完全等大（同一半径、同一 148px 视口、同一 120×120 viewBox），
 * 只在描边色上区分阶段，因此半径与周长必须只有一处定义——否则改其一会让两个
 * 页签的环错位，或让弧长与周长对不上。
 */

/** 进度环半径（120×120 viewBox 坐标系） */
export const RING_RADIUS = 50;

/** 进度环周长：strokeDasharray / strokeDashoffset 均以它为单位 */
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * 「即将结束」强调阈值（秒）。
 *
 * 剩余时间进入该区间且计时正在运行时，倒计时与番茄钟的数字、进度环统一切到
 * 警示色并逐秒跳动——提示用户即将到点。
 */
export const URGENT_SECONDS = 10;

/**
 * 环头珠子所在层要旋转的角度（度），使珠子正好落在弧尖上。
 *
 * 两处坐标系必须一起算，漏一个珠子就会偏离弧尖（偏差量恰好等于漏掉的角度）：
 *  1. 珠子的本地位置写在 12 点——(cx=60, cy=10)；
 *  2. `.timer-ring-view svg` 自身带 `transform: rotate(-90deg)`（把 dash 弧线的起点
 *     从 3 点挪到 12 点，这是进度环的常规写法），本地 12 点在屏幕上因此落到 **9 点**。
 * 所以顺时针旋转量要在 `进度 × 360°` 之上补回 90°，珠子才与「从 12 点顺时针走
 * progress 圈」的弧尖重合。
 */
export function ringHeadRotation(progress: number): number {
  return progress * 360 + 90;
}
