import { describe, expect, it } from "vitest";
import { annotationCursor } from "../tools/screenshot/annotate/AnnotationCanvas";
import { sketchCursor } from "../tools/sketch/SketchTool";
import {
  BADGE_GLYPH_HALO,
  BADGE_GLYPH_SCALE,
  BADGE_GLYPH_STROKE,
  BADGE_R_DISC,
  BADGE_R_OUTER,
  CROSSHAIR_STROKE,
  HALO_KEYLINE,
  HALO_OUTER,
} from "./cursorSkin";

/** 从 data URI 里取出真实 SVG 字符串（只认 buildCursorSkin 的输出格式） */
function decodeCursorSvg(cursor: string): string {
  const match = /^url\("data:image\/svg\+xml,(.*)"\) \d+ \d+, auto$/.exec(cursor);
  if (!match) throw new Error(`无法解析光标: ${cursor}`);
  return decodeURIComponent(match[1]);
}

/** 取光标的热点，形如 "16 16" */
function hotspotOf(cursor: string): string {
  const match = /\) (\d+ \d+), auto$/.exec(cursor);
  if (!match) throw new Error(`无法解析热点: ${cursor}`);
  return match[1];
}

interface CursorGroup {
  stroke: string;
  width: number;
  inner: string;
}

/** 拆出光标的 5 个绘制层：深色外圈 / 白键线 / 内芯 / 符号反色细边 / 符号墨色 */
function cursorGroups(svg: string): CursorGroup[] {
  return [
    ...svg.matchAll(
      /<g fill="none" stroke="([^"]+)" stroke-width="([\d.]+)"[^>]*>([\s\S]*?)<\/g>/g,
    ),
  ].map(([, stroke, width, inner]) => ({ stroke, width: Number(width), inner }));
}

describe("cursorSkin", () => {
  // 这条防的是「谁哪天又抄一份副本走」：光标外壳（十字、徽章、三层叠色、热点）必须两个工具同源。
  // 抄副本的后果不是立刻报错，而是有人只调了其中一边的数值，两块画布的光标悄悄长得不一样。
  it("标注光标与草稿光标共用同一套外壳：十字 / 徽章 / 三层叠色 / 热点逐字一致", () => {
    const accent = "#E53935";
    const a = cursorGroups(decodeCursorSvg(annotationCursor("rect", accent)));
    const b = cursorGroups(decodeCursorSvg(sketchCursor("rect", accent)));

    expect(a).toHaveLength(5);
    expect(b).toHaveLength(5);

    // 三条描边通道（十字 + 徽章底色圆）连同线宽必须完全一致
    for (let index = 0; index < 3; index += 1) {
      expect(b[index].stroke).toBe(a[index].stroke);
      expect(b[index].width).toBe(a[index].width);
      expect(b[index].inner).toBe(a[index].inner);
    }
    // 符号两层的描边色与线宽由外壳决定，也必须一致（符号形状本身各工具不同，不在这里比）
    expect(b[3].stroke).toBe(a[3].stroke);
    expect(b[4].stroke).toBe(a[4].stroke);
    expect(b[3].width).toBe(a[3].width);
    expect(b[4].width).toBe(a[4].width);

    // 落笔点：两边都是十字交点
    expect(hotspotOf(sketchCursor("rect", accent))).toBe(hotspotOf(annotationCursor("rect", accent)));
    expect(hotspotOf(sketchCursor("rect", accent))).toBe("16 16");
  });

  it("徽章几何自洽：底色圆半径按外圈半宽内缩、符号缩放后不顶到圆环", () => {
    expect(BADGE_R_DISC).toBe(BADGE_R_OUTER - (1.4 + HALO_OUTER) / 2);
    expect(BADGE_R_DISC).toBeLessThan(BADGE_R_OUTER);
    // 符号反色外描边共 2.9 宽，缩放后仍要留在底色圆里
    expect(BADGE_GLYPH_SCALE * (5 + BADGE_GLYPH_STROKE / 2)).toBeLessThan(BADGE_R_DISC);
    expect(BADGE_GLYPH_SCALE * (5 + (BADGE_GLYPH_STROKE + BADGE_GLYPH_HALO) / 2)).toBeLessThan(
      BADGE_R_DISC,
    );
    // 三层必须「外圈 > 键线 > 内芯」，且白键线只比内芯粗一点（粗一倍就把画笔色盖没了）
    expect(CROSSHAIR_STROKE + HALO_OUTER).toBeGreaterThan(CROSSHAIR_STROKE + HALO_KEYLINE);
    expect(CROSSHAIR_STROKE + HALO_KEYLINE).toBeGreaterThan(CROSSHAIR_STROKE);
    expect(HALO_KEYLINE).toBeLessThan(HALO_OUTER);
  });

  // 兜底色是每个工具自己的口径，别顺手"统一"掉
  it("脏色值的兜底按工具各自给：标注用 DEFAULT_COLOR、草稿用调色板首色", () => {
    expect(annotationCursor("rect", "not-a-color")).toContain(encodeURIComponent("#E53935"));
    expect(sketchCursor("rect", "not-a-color")).toContain(encodeURIComponent("#ff3b30"));
  });
});
