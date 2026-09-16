import { describe, expect, it } from "vitest";
import {
  HG_BOTTOM,
  HG_CLIP_BOTTOM,
  HG_CLIP_TOP,
  HG_CRATER_FADE_FROM,
  HG_CRATER_FADE_TO,
  HG_GLASS_PATH,
  HG_HALF_NECK,
  HG_HALF_TOP,
  HG_MOUND_HEIGHT,
  HG_NECK,
  HG_SPAN,
  HG_STREAM_BOTTOM_HALF,
  HG_STREAM_TOP_HALF,
  HG_TOP,
  hourglassOffsets,
  levelFraction,
  sandAreaFraction,
  wallHalfWidth,
} from "./hourglassGeometry";

/**
 * 独立（不复用实现公式）的数值积分：把灯泡按半宽函数切成细条累面积。
 * 它只依赖「瓶壁半宽」这一个公开函数，所以实现里换曲率、换反解都不会让它跟着变。
 */
function integrate(from: number, to: number, f: (u: number) => number, steps = 20000): number {
  const h = (to - from) / steps;
  let sum = 0;
  for (let i = 0; i < steps; i += 1) sum += f(from + h * (i + 0.5)) * h;
  return sum;
}

const BULB_AREA = integrate(0, 1, wallHalfWidth);

/**
 * **按 hourglassOffsets 真正画出来的区间**数沙面积——这是这套几何的核心不变量。
 *
 * 关键在于别再另写一份「半个灯泡的面积公式」去自证：上一版测试就是这么写的，
 * 结果辅助函数量的是另一片区域，实现里堆沙写错成 levelFraction(1−p) 也照样全绿，
 * 直到把画出来的区间积分出来才暴露（p=0.875 时堆沙面积是 87.5% 而不是 12.5%）。
 */
function drawnArea(progress: number) {
  const o = hourglassOffsets(progress);
  const topU = 1 - o.sandY / HG_SPAN; // 上沙可见区间 u ∈ [0, topU]
  const pileU = o.pileY / HG_SPAN; // 堆沙可见区间 u ∈ [pileU, 1]
  return {
    top: integrate(0, topU, wallHalfWidth) / BULB_AREA,
    pile: integrate(pileU, 1, wallHalfWidth) / BULB_AREA,
    /** 两个沙面离颈口的距离（上沙 sandY 与下沙 pileY 各自的换算值） */
    topDistance: topU,
    pileDistance: pileU,
  };
}

describe("hourglassGeometry 沙漏几何", () => {
  // 这套几何最要紧的一条：沙子总量守恒。堆沙曾经写成 levelFraction(1−p)，
  // 那样堆沙面积恒等于剩余比例 p，p=0.875 时下半瓶会显出 87.5% 的沙、沙子凭空多出来。
  it("沙量守恒：上沙面积 = 剩余比例、堆沙面积 = 已过比例、两者之和恒为 1", () => {
    for (let p = 0; p <= 1.0001; p += 0.025) {
      const { top, pile } = drawnArea(p);
      expect(top).toBeCloseTo(Math.min(1, p), 6);
      expect(pile).toBeCloseTo(1 - Math.min(1, p), 6);
      expect(top + pile).toBeCloseTo(1, 6);
    }
  });

  it("观感对称：两个沙面离颈口的距离始终相同", () => {
    for (let p = 0; p <= 1.0001; p += 0.025) {
      const { topDistance, pileDistance } = drawnArea(p);
      expect(topDistance).toBeCloseTo(pileDistance, 12);
    }
  });

  it("沙面反解与面积函数互逆（解析式 = 数值积分）", () => {
    for (let f = 0; f <= 1.0001; f += 0.05) {
      const u = levelFraction(f);
      expect(sandAreaFraction(u)).toBeCloseTo(Math.min(1, f), 9);
      expect(integrate(0, u, wallHalfWidth) / BULB_AREA).toBeCloseTo(Math.min(1, f), 5);
    }
  });

  // 高度等比映射下 50% 剩余的沙面在 50% 处；面积等比会明显更低（漏斗下窄上宽，
  // 沙面之上的那团沙要占掉一半面积，沙面必须压到 66% 高度以下）。这条把两者钉开。
  it("面积等比 ≠ 高度等比（50% 剩余的沙面明显更低）", () => {
    const u = levelFraction(0.5);
    expect(u).toBeGreaterThan(0.6);
    expect(u).toBeLessThan(0.7);
  });

  it("端点：满瓶沙面贴端面、空瓶整块移出灯泡", () => {
    expect(levelFraction(1)).toBeCloseTo(1, 9);
    expect(levelFraction(0)).toBeCloseTo(0, 9);

    const full = hourglassOffsets(1);
    expect(full.sandY).toBeCloseTo(0, 9);
    expect(full.pileY).toBeCloseTo(HG_SPAN, 9);

    const empty = hourglassOffsets(0);
    expect(empty.sandY).toBeCloseTo(HG_SPAN, 9);
    expect(empty.pileY).toBeCloseTo(0, 9);
    expect(empty.streamScale).toBeCloseTo(0, 9);
  });

  it("位移随进度单调：沙子只朝一个方向走，不会回头", () => {
    let previous = hourglassOffsets(1);
    for (let p = 0.95; p >= 0; p -= 0.05) {
      const now = hourglassOffsets(p);
      expect(now.sandY).toBeGreaterThanOrEqual(previous.sandY);
      expect(now.pileY).toBeLessThanOrEqual(previous.pileY);
      expect(now.streamScale).toBeLessThanOrEqual(previous.streamScale);
      previous = now;
    }
  });

  it("凹坑：暂停收平，沙面越浅越小、坑口也越窄", () => {
    expect(hourglassOffsets(0.5, false).crater).toBe(0);
    expect(hourglassOffsets(1).crater).toBe(1);
    expect(hourglassOffsets(1).craterWidth).toBeCloseTo(1, 9);
    // 沙面越浅，那一层瓶壁越窄 ⇒ 坑口跟着收
    expect(hourglassOffsets(0.2).craterWidth).toBeLessThan(hourglassOffsets(0.8).craterWidth);
    // 注意要用「面积 → 进度」的反函数取进度：沙面高度不是线性的（面积等比映射），
    // 直接拿 高度/行程 当进度会算错，这条断言正好把这个坑钉住。
    const progressAtHeight = (height: number) => sandAreaFraction(height / HG_SPAN);
    expect(hourglassOffsets(progressAtHeight(HG_CRATER_FADE_FROM)).crater).toBeCloseTo(0, 9);
    expect(hourglassOffsets(progressAtHeight(HG_CRATER_FADE_TO)).crater).toBeCloseTo(1, 6);
    const mid = hourglassOffsets(progressAtHeight((HG_CRATER_FADE_FROM + HG_CRATER_FADE_TO) / 2)).crater;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it("流沙垂到尖堆锥尖、且不悬空也不越过沙面", () => {
    let sawStream = false;
    for (let p = 0.05; p < 1; p += 0.05) {
      const o = hourglassOffsets(p);
      const streamBottomY = HG_NECK + HG_SPAN * o.streamScale;
      const pileSurfaceY = HG_NECK + o.pileY;
      const apexY = pileSurfaceY - HG_MOUND_HEIGHT * o.moundScale;
      // 至少够到锥尖（不能悬在半空），最多多扎进沙面 1 个单位（STREAM_OVERLAP）
      expect(streamBottomY).toBeGreaterThanOrEqual(pileSurfaceY - HG_MOUND_HEIGHT);
      expect(streamBottomY).toBeLessThanOrEqual(pileSurfaceY + 1 + 1e-9);
      if (o.streamScale > 0) {
        sawStream = true;
        expect(streamBottomY).toBeGreaterThan(HG_NECK);
        expect(apexY).toBeLessThan(pileSurfaceY); // 锥尖确实在沙面之上
      }
    }
    expect(sawStream).toBe(true);
  });

  // 尖堆的大小由两个因素相乘：沙面那一层的瓶宽（锥体能占多宽）× 堆沙量（沙够不够）。
  // 于是它**不是**单调的：堆到颈口附近时瓶壁最窄、锥体反而收小；堆沙很多而沙面已到宽处时最大。
  it("尖堆：空瓶为零、满瓶受颈口瓶宽限制、堆到 35% 后只随瓶壁收", () => {
    expect(hourglassOffsets(1).moundScale).toBe(0); // 空瓶不许在瓶底浮着一个锥体
    expect(hourglassOffsets(0).moundScale).toBeCloseTo(HG_HALF_NECK / HG_HALF_TOP, 6);
    for (let p = 0; p <= 1.0001; p += 0.02) {
      const scale = hourglassOffsets(p).moundScale;
      expect(scale).toBeGreaterThanOrEqual(0);
      expect(scale).toBeLessThanOrEqual(1); // 锥体永远不会宽过灯泡
    }
    // 堆沙量不足 35% 的那一段（p ≥ 0.65）只受瓶壁限制 ⇒ 单调收小
    let previous = Infinity;
    for (let p = 0.65; p <= 1.0001; p += 0.01) {
      const now = hourglassOffsets(p).moundScale;
      expect(now).toBeLessThanOrEqual(previous + 1e-12);
      previous = now;
    }
    // 「随堆沙量长出来」：沙少的（p=0.7）必须比沙多的（p=0.5）小
    expect(hourglassOffsets(0.7).moundScale).toBeLessThan(hourglassOffsets(0.5).moundScale);
  });

  it("区间外的进度被夹住，非有限值退化成空瓶而不是 NaN 位移", () => {
    expect(hourglassOffsets(1.4).sandY).toBeCloseTo(0, 9);
    expect(hourglassOffsets(-0.3).sandY).toBeCloseTo(HG_SPAN, 9);
    // NaN 若漏进 inline style 会写成 translateY(NaNpx)，整条 transform 失效
    const nan = hourglassOffsets(Number.NaN);
    for (const value of [nan.sandY, nan.pileY, nan.streamScale, nan.crater, nan.craterWidth, nan.moundScale]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(nan.sandY).toBeCloseTo(HG_SPAN, 9);
    expect(nan.pileY).toBeCloseTo(0, 9);
  });

  it("几何自洽：颈部开口容得下流沙，端面比颈部宽，瓶壁是弧线而非直锥", () => {
    expect(HG_HALF_NECK * 2).toBeGreaterThan(HG_STREAM_TOP_HALF * 2); // 流沙最宽处
    expect(HG_HALF_TOP).toBeGreaterThan(HG_HALF_NECK);
    expect(HG_SPAN).toBeCloseTo(HG_NECK - HG_TOP, 9);
    expect(HG_STREAM_TOP_HALF).toBeGreaterThan(HG_STREAM_BOTTOM_HALF); // 上粗下细
    // 弧线：曲率把剖面压成 S 形——颈部那半段更瘦（收出细喉），端面那半段更胖（甩出喇叭口），
    // 中点是曲线的对称中心、必然落回直锥线上，所以不能拿 0.5 去验曲率。
    const straightAt = (u: number) => HG_HALF_NECK + (HG_HALF_TOP - HG_HALF_NECK) * u;
    expect(wallHalfWidth(0.3)).toBeLessThan(straightAt(0.3) - 0.4);
    expect(wallHalfWidth(0.8)).toBeGreaterThan(straightAt(0.8) + 0.4);
    expect(wallHalfWidth(0.5)).toBeCloseTo(straightAt(0.5), 9);
    // 两端仍然贴合端面/颈口，不能因为加曲率把开口改小
    expect(wallHalfWidth(0)).toBeCloseTo(HG_HALF_NECK, 9);
    expect(wallHalfWidth(1)).toBeCloseTo(HG_HALF_TOP, 9);
  });

  it("玻璃轮廓是一条闭合路径，不在颈线上横切一刀", () => {
    // 分两条路径画会在腰部叠出一条横杠；闭合路径里「颈线那一行」只出现两个端点。
    // 注意路径里的数字是 toFixed(2) 出来的，比对要按同样的格式。
    const onNeck = (path: string) =>
      path.split(/(?=[ML])/).filter((seg) => seg.trim().endsWith(` ${HG_NECK.toFixed(2)}`)).length;
    expect(onNeck(HG_GLASS_PATH)).toBe(2);
    expect(HG_GLASS_PATH.endsWith("Z")).toBe(true);
    expect((HG_GLASS_PATH.match(/M /g) ?? [])).toHaveLength(1);
    // 上下裁剪区共用同一条颈线：两块沙在颈口严丝合缝，不留缝也不叠色
    expect(onNeck(HG_CLIP_TOP)).toBe(2);
    expect(onNeck(HG_CLIP_BOTTOM)).toBe(2);
    expect(HG_GLASS_PATH).toContain(HG_BOTTOM.toFixed(2));
  });
});
