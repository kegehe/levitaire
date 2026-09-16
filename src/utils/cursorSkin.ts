/**
 * 画布类工具的光标外壳：四臂十字准星 + 右下角圆形工具徽章。
 *
 * 截图标注（AnnotationCanvas）和屏幕草稿（SketchTool）两块画布盖的都是「用户自己的屏幕内容」，
 * 系统十字光标在花哨画面里容易看丢，所以两边都自绘 32×32 的 SVG 光标，且必须是同一套外观 ——
 * 从一块画布切到另一块时，光标不该突然换一种语言。
 *
 * 结构（由下往上的绘制顺序）：
 *   1. 四臂细十字（中心留 10px 空档，长距离对齐用）—— 交点就是热点；
 *   2. 右下角圆徽章 —— 底 = 当前画笔色，里面是当前工具图形（墨色按底色亮度取深/白）。
 * 三层描边保证亮色、深色、花哨照片上都看得见：深色外圈(+2.0) → 白色键线(+0.9) → 当前色内芯。
 * 白色键线只比内芯粗 0.9，内芯占到接近一半，1× 下才看得出画笔颜色
 * （旧实现是 2.6 / 1.35，白线比内芯粗一倍，画出来的颜色基本看不见）。
 *
 * 三条硬约束（改几何前先看这里）：
 *   1. 徽章必须排在 accent 通道之后 —— 徽章底是一整块填充，排在前面会把里面的符号整块盖掉；
 *   2. 徽章含外圈的可见半径不能碰到十字臂，否则右下两条臂会像从徽章里长出来；
 *   3. 徽章内的符号只有 6px 上下，**笔画不能细于 1.9、特征不能再多** ——
 *      验收必须看 1× 的真实像素（放大了看好不好看是很骗人的）。
 *
 * 两个工具各自的 `*.test.tsx` 里都有「光标几何自检」按真实 SVG 数字复算这几条，
 * `cursorSkin.test.ts` 再钉一条「两边在用的是同一套外壳」，防止谁哪天又抄一份副本走。
 *
 * ⚠️ 这里只放**共用外壳**。每隔工具的差异（工具符号、颜色兜底值）留在各自的模块里：
 * 抄一份副本改数字，是这块最容易被做坏的事。
 */

/** Windows 上光标的物理上限就是 32×32 */
export const CURSOR_SIZE = 32;
/** 十字交点 = 热点，两个工具的落笔点都正好是点击处（矩形/椭圆左上角、箭头/画笔起点、文字基线左端） */
export const CURSOR_HOTSPOT: readonly [number, number] = [16, 16];
export const CURSOR_DARK = "#101216";
export const CURSOR_LIGHT = "#ffffff";

/** 四臂十字：外端 2.2、内端 21（中心留 10px 空档，热点不被压住） */
export const CROSSHAIR_PATH = "M16 2.2v8.8M16 21v8.8M2.2 16h8.8M21 16h8.8";
export const CROSSHAIR_STROKE = 1.4;
/** 深色外圈 / 白色键线相对内芯的加粗量 */
export const HALO_OUTER = 2.0;
export const HALO_KEYLINE = 0.9;

/** 徽章：含深色外圈的最终可见半径（越小则里面的符号越小，越大越容易碰到十字臂） */
export const BADGE_CX = 25.3;
export const BADGE_CY = 25.3;
export const BADGE_R_OUTER = 6.6;
export const BADGE_STROKE = 1.4;
/** 徽章底色圆的半径 = 可见外半径 - 外圈半宽 */
export const BADGE_R_DISC = BADGE_R_OUTER - (BADGE_STROKE + HALO_OUTER) / 2;
/** 徽章内符号画在一个 10×10 的单位框里，整体缩放到填满底色圆（留出约 1px 边距，别顶到圆环） */
export const BADGE_GLYPH_SCALE = (BADGE_R_DISC * 1.25) / 10;
/**
 * 符号笔画粗细。**不能再细**：32px 下符号整体只有 6px 左右，再细一点（1.3 上下）配上反色外描边
 * 就会在 1× 下糊成一团。所以每个符号只保留最少、最粗的特征。
 */
export const BADGE_GLYPH_STROKE = 1.9;
/** 符号外一层的反色细边（1× 下约 0.5px），只用来把符号与底色分开一点，对比度靠墨色本身 */
export const BADGE_GLYPH_HALO = 1.0;
/** 符号统一画在这个 10×10 单位框里，再缩放居中到徽章上 */
export const BADGE_GLYPH_TRANSFORM = `translate(${BADGE_CX} ${BADGE_CY}) scale(${round2(BADGE_GLYPH_SCALE)}) translate(-5 -5)`;

/** 数字统一保留两位小数再写进 SVG（避免 0.30000000000000004 之类的浮点尾巴） */
export function round2(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * 徽章内符号的墨色 = 按底色亮度取深色或白色。
 * 固定用白色是不行的：画笔色选到白色/浅黄时，白符号压在白底徽章上会整块糊掉。
 * 入参是 normalizeCursorColor() 的输出，只会是 #RGB / #RGBA / #RRGGBB / #RRGGBBAA。
 */
export function glyphInk(color: string): string {
  const body = color.slice(1);
  const short = body.length <= 4;
  const channel = (offset: number): number => {
    const raw = short ? body[offset] : body.slice(offset * 2, offset * 2 + 2);
    return Number.parseInt(raw.length === 1 ? raw + raw : raw, 16);
  };
  const luminance = 0.299 * channel(0) + 0.587 * channel(1) + 0.114 * channel(2);
  return luminance > 150 ? CURSOR_DARK : CURSOR_LIGHT;
}

/**
 * 色值只接受十六进制，否则整条光标 URL 会失效（脏值可能是旧版本持久化下来的设置，或拾色器之外写入的）。
 * 兜底色由调用方给：标注工具用 DEFAULT_COLOR，草稿工具用调色板首色。
 */
export function normalizeCursorColor(color: string, fallback: string): string {
  return /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color) ? color : fallback;
}

/**
 * 一条描边通道：四臂十字（不填充）+ 徽章底色圆。
 * 底色圆的 fill 跟随本通道颜色，三层叠出「深色外圈 / 白色键线 / 画笔色内芯」。
 */
function cursorPass(stroke: string, width: number, fill: string): string {
  return (
    `<g fill="none" stroke="${stroke}" stroke-width="${round2(width)}"` +
    ` stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${CROSSHAIR_PATH}"/>` +
    `<circle cx="${BADGE_CX}" cy="${BADGE_CY}" r="${round2(BADGE_R_DISC)}" fill="${fill}"/>` +
    `</g>`
  );
}

/**
 * 组装整条 CSS `cursor` 值。
 * @param accent 已归一化的画笔色（先过 normalizeCursorColor）
 * @param glyphTemplate 10×10 单位框内的工具符号；`fill="__INK__"` 会按底色亮度替换成墨色，
 *   用于实心符号（画笔笔尖、橡皮擦斜块这类）
 */
export function buildCursorSkin(accent: string, glyphTemplate: string): string {
  const ink = glyphInk(accent);
  const inkHalo = ink === CURSOR_DARK ? CURSOR_LIGHT : CURSOR_DARK;
  const glyph = glyphTemplate.replace(/__INK__/g, ink);

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CURSOR_SIZE}" height="${CURSOR_SIZE}"`,
    ` viewBox="0 0 ${CURSOR_SIZE} ${CURSOR_SIZE}">`,
    cursorPass(CURSOR_DARK, CROSSHAIR_STROKE + HALO_OUTER, CURSOR_DARK),
    cursorPass(CURSOR_LIGHT, CROSSHAIR_STROKE + HALO_KEYLINE, CURSOR_LIGHT),
    cursorPass(accent, CROSSHAIR_STROKE, accent),
    // 符号必须排在三个通道之后，否则会被徽章底色整块盖掉。
    `<g fill="none" stroke="${inkHalo}" stroke-width="${round2(BADGE_GLYPH_STROKE + BADGE_GLYPH_HALO)}"`,
    ` stroke-linecap="round" stroke-linejoin="round" transform="${BADGE_GLYPH_TRANSFORM}">${glyph}</g>`,
    `<g fill="none" stroke="${ink}" stroke-width="${round2(BADGE_GLYPH_STROKE)}"`,
    ` stroke-linecap="round" stroke-linejoin="round" transform="${BADGE_GLYPH_TRANSFORM}">${glyph}</g>`,
    "</svg>",
  ].join("");

  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${CURSOR_HOTSPOT[0]} ${CURSOR_HOTSPOT[1]}, auto`;
}
