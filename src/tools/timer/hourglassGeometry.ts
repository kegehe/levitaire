/**
 * 倒计时「沙漏」显示样式的几何与映射。
 *
 * 与环形样式共用 120×120 坐标系（两个样式切换时沙漏与环等宽等高，面板不跳）。
 * 结构：玻璃轮廓（一条闭合的中心线路径）+ 上下两个灯泡的裁剪区 + 两块沙子 + 堆沙尖堆
 * + 沙面凹坑 + 流沙 + 端板。
 *
 * 沙子怎么动：沙子不是逐点算形状，而是「一块矩形 + clipPath 裁进灯泡」——
 * 横向自动贴合瓶壁，纵向靠 translateY 过渡，于是既能连续下漏、又不用碰贝塞尔数学。
 * 「堆沙尖堆 / 沙面凹坑」这类会改变表面形状的小件单独画，跟着同一段位移走。
 *
 * 沙面位置用的是**面积等比**（真实沙漏的口径），不是高度等比：
 * 上半瓶是下窄上宽的漏斗，若让沙面「高度」等比下降，45% 剩余时上半瓶看着快空了、
 * 下半瓶却已堆满，读感与真实沙漏相反。改成「剩余沙的面积 = 剩余比例」后，
 * 眼见的沙量即剩余时间。
 *
 * 两个灯泡的半宽函数是**同一条** w(u)（u = 离颈口的距离比例）——下半瓶就是上半瓶沿颈线
 * 做的水平镜像，所以「上沙占面积 p」「堆沙占面积 1−p」等价于「两个沙面离颈口一样远」。
 * 于是两侧只要一个映射 `levelFraction`，而且沙量自动守恒（改这条等式会让沙子凭空多出或
 * 少掉，实测见 hourglassOffsets 的注释）。
 */
export const HG_BOX = 120;

/** 端面（上/下）与颈线的 y */
export const HG_TOP = 11.5;
export const HG_NECK = 60;
export const HG_BOTTOM = 108.5;

/** 端面半宽与颈部半宽：颈部留出 13 的开口，流沙（最宽处 3.2）穿得过 */
export const HG_HALF_TOP = 32;
export const HG_HALF_NECK = 6.5;

/** 沙面行程（半个灯泡的高度） */
export const HG_SPAN = HG_NECK - HG_TOP;

/**
 * 瓶壁曲率：0 = 直锥（老版沙漏就是直锥，两片平直的三角形拼成一个「领结」，
 * 棱角很硬、像漏斗不像沙漏），1 = 纯余弦弧。
 * 0.5 是「一眼看得出是弧线、又不至于变成高脚杯」的一档。
 */
export const HG_WALL_CURVE = 0.5;

/** 瓶壁采样点数：轮廓与裁剪区都用折线逼近同一条解析曲线，36 段在 112px 下已看不出折角 */
export const HG_WALL_SAMPLES = 36;

const CENTER = HG_BOX / 2;
/** 中心线 x（= HG_BOX/2）。组件里画沙块/明暗层、CSS 里的 transform-origin 都要与它一致 */
export const HG_CENTER = CENTER;
const LEFT = CENTER - HG_HALF_TOP;
const RIGHT = CENTER + HG_HALF_TOP;
const DELTA = HG_HALF_TOP - HG_HALF_NECK;

/** 一个灯泡的面积（∝ ∫₀¹ 半宽 du）= (端面半宽 + 颈部半宽) / 2，曲率不改变它 */
const HALF_AREA = (HG_HALF_TOP + HG_HALF_NECK) / 2;

/**
 * 瓶壁半宽沿「颈口 → 端面」的归一化剖面：prof(0) = 0（颈口）、prof(1) = 1（端面）。
 * 直线项保证端面/颈口比例不变，余弦项把中段推成弧线。
 */
export function wallProfile(u: number): number {
  const t = Math.min(1, Math.max(0, u));
  return (1 - HG_WALL_CURVE) * t + HG_WALL_CURVE * ((1 - Math.cos(Math.PI * t)) / 2);
}

/** 颈口往上 u（0..1）处的瓶壁半宽 */
export function wallHalfWidth(u: number): number {
  return HG_HALF_NECK + DELTA * wallProfile(u);
}

/** ∫₀ᵘ prof —— 剖面函数的解析原函数（余弦项的积分带 sin(πu)/2π） */
function profileIntegral(u: number): number {
  const t = Math.min(1, Math.max(0, u));
  return (1 - HG_WALL_CURVE) * ((t * t) / 2) + HG_WALL_CURVE * (t / 2 - Math.sin(Math.PI * t) / (2 * Math.PI));
}

/** 从颈口到 u 的沙子面积（未归一）。颈口**往下**同样适用：下半瓶共用同一条半宽函数 */
export function sandAreaFromNeck(u: number): number {
  const t = Math.min(1, Math.max(0, u));
  return HG_HALF_NECK * t + DELTA * profileIntegral(t);
}

/** 沙子占一个灯泡的面积比例（u 从颈口算起，1 = 顶到端面） */
export function sandAreaFraction(u: number): number {
  return sandAreaFromNeck(u) / HALF_AREA;
}

/**
 * 「沙子占灯泡的面积比例 f」→「沙面离颈口的距离比例 u」（1 = 顶到端面、0 = 缩到颈口）。
 *
 * 面积函数单调，故二分反解即可（比解二次方程稳，换曲率不用改公式）。
 * 上沙与堆沙共用**同一个**返回值：上沙=离颈口 u 以内那片（面积 f），
 * 堆沙=离颈口 u 以外那片（面积 1−f），两者的面积和恒等于一个灯泡。
 */
export function levelFraction(fraction: number): number {
  const target = clamp01(fraction) * HALF_AREA;
  if (target <= 0) return 0;
  if (target >= HALF_AREA) return 1;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 48; i += 1) {
    const mid = (low + high) / 2;
    if (sandAreaFromNeck(mid) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** 夹到 [0,1]；非有限值（NaN/Infinity）按 0 处理，避免把 NaNpx 写进 inline style */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 颈口 → 端面的左壁采样点（up = 上半瓶） */
function wallPoints(up: boolean, samples = HG_WALL_SAMPLES): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= samples; i += 1) {
    const u = i / samples;
    const y = up ? HG_NECK - u * HG_SPAN : HG_NECK + u * HG_SPAN;
    points.push([CENTER - wallHalfWidth(u), y]);
  }
  return points;
}

const point = ([x, y]: [number, number]) => `L ${x.toFixed(2)} ${y.toFixed(2)}`;

/** 单个灯泡的闭合轮廓（沿左壁到颈口，镜像回右壁）——沙子就裁在这条轮廓里 */
function bulbPath(up: boolean, samples = HG_WALL_SAMPLES): string {
  const wall = wallPoints(up, samples);
  const segments = [`M ${LEFT} ${up ? HG_TOP : HG_BOTTOM}`];
  for (let i = wall.length - 2; i >= 0; i -= 1) segments.push(point(wall[i]));
  for (let i = 0; i < wall.length; i += 1) segments.push(point([2 * CENTER - wall[i][0], wall[i][1]]));
  segments.push("Z");
  return segments.join(" ");
}

/**
 * 玻璃轮廓：**一条**闭合路径走完两片灯泡，刻意不在颈线上横切一刀——
 * 分两条路径画的话，两条描边会在腰部叠出一条横杠，沙漏看着像被锯成两半。
 */
function glassOutlinePath(samples = HG_WALL_SAMPLES): string {
  const top = wallPoints(true, samples);
  const bottom = wallPoints(false, samples);
  const mirror = ([x, y]: [number, number]): [number, number] => [2 * CENTER - x, y];
  const segments = [`M ${LEFT} ${HG_TOP}`];
  for (let i = top.length - 2; i >= 0; i -= 1) segments.push(point(top[i]));
  for (let i = 1; i < bottom.length; i += 1) segments.push(point(bottom[i]));
  segments.push(`L ${RIGHT} ${HG_BOTTOM}`);
  for (let i = bottom.length - 2; i >= 0; i -= 1) segments.push(point(mirror(bottom[i])));
  for (let i = 1; i < top.length; i += 1) segments.push(point(mirror(top[i])));
  segments.push("Z");
  return segments.join(" ");
}

export const HG_CLIP_TOP = bulbPath(true);
export const HG_CLIP_BOTTOM = bulbPath(false);
export const HG_GLASS_PATH = glassOutlinePath();

/** 上下端板：两端各一条略带外扩的横线，让沙漏读起来像「有骨架的器物」 */
export const HG_CAP_OVERHANG = 5;
export const HG_CAP_PATH =
  `M ${LEFT - HG_CAP_OVERHANG} ${HG_TOP} H ${RIGHT + HG_CAP_OVERHANG} ` +
  `M ${LEFT - HG_CAP_OVERHANG} ${HG_BOTTOM} H ${RIGHT + HG_CAP_OVERHANG}`;

/**
 * 沙面凹坑：真实沙漏漏沙时沙面正中会塌出漏斗形的坑，用空瓶底色「挖」出来。
 * 画成二次贝塞尔（控制点取两倍深度 ⇒ 曲线最低点正好是 HG_CRATER_DEPTH），
 * 比三角形少了两个尖角，才不会看着像沙面上缺了一块。
 * 尺寸刻意压得比「看得清」更小一档：这是玻璃色的缺口，放大过头就从「沙面塌陷」变成「沙上破了个洞」。
 * 路径画在端面那一行（y = HG_TOP）上，靠 translateY 跟着沙面走。
 */
export const HG_CRATER_HALF_WIDTH = 7.5;
export const HG_CRATER_DEPTH = 2.6;
export const HG_CRATER_PATH =
  `M ${CENTER - HG_CRATER_HALF_WIDTH} ${HG_TOP} ` +
  `Q ${CENTER} ${HG_TOP + 2 * HG_CRATER_DEPTH} ${CENTER + HG_CRATER_HALF_WIDTH} ${HG_TOP} Z`;
/** 凹坑在沙面高度低于 HG_CRATER_FADE_FROM 时开始收小、到 HG_CRATER_FADE_TO 完全收平 */
export const HG_CRATER_FADE_FROM = 8;
export const HG_CRATER_FADE_TO = 26;

/**
 * 堆沙尖堆：流沙落在堆沙表面会堆出一个休止角锥体（中间最高），
 * 老版堆沙表面是一刀平的，看着像「水位」而不是「沙堆」。
 * 尺寸按「半宽 : 高 ≈ 1 : 0.55」（≈29° 休止角）取，整体随堆沙面那一层的瓶宽等比缩放——
 * 于是堆得越深锥体越大、堆到颈口时自动收成小小一撮。
 * 画在颈线那一行上，与堆沙矩形共用同一段 translateY；两壁是直线、只把锥尖磨圆。
 */
export const HG_MOUND_HALF_WIDTH = 15;
export const HG_MOUND_HEIGHT = 8;
const MOUND_TIP = 2.2;
export const HG_MOUND_PATH =
  `M ${CENTER - HG_MOUND_HALF_WIDTH} ${HG_NECK} ` +
  `L ${CENTER - MOUND_TIP} ${HG_NECK - HG_MOUND_HEIGHT + 1.4} ` +
  `Q ${CENTER} ${HG_NECK - HG_MOUND_HEIGHT} ${CENTER + MOUND_TIP} ${HG_NECK - HG_MOUND_HEIGHT + 1.4} ` +
  `L ${CENTER + HG_MOUND_HALF_WIDTH} ${HG_NECK} Z`;

/**
 * 流沙：从颈口垂到底部的一段细柱，上粗下细（落下的沙在加速、越落越细）。
 * 用定长路径 + scaleY，长度才能吃到 CSS 过渡，两次每秒广播之间也是连续推进的。
 */
export const HG_STREAM_TOP_HALF = 1.6;
export const HG_STREAM_BOTTOM_HALF = 0.9;
export const HG_STREAM_PATH =
  `M ${CENTER - HG_STREAM_TOP_HALF} ${HG_NECK} ` +
  `L ${CENTER + HG_STREAM_TOP_HALF} ${HG_NECK} ` +
  `L ${CENTER + HG_STREAM_BOTTOM_HALF} ${HG_NECK + HG_SPAN} ` +
  `L ${CENTER - HG_STREAM_BOTTOM_HALF} ${HG_NECK + HG_SPAN} Z`;
/**
 * 流沙上的「落沙纹」：一条沿柱心跳动的虚线，靠 stroke-dashoffset 循环往下走。
 * 实线刻意比空白长（5 : 3）：虚线太长会散成一颗颗「珠子」，太短又整条糊掉。
 */
export const HG_STREAM_FLOW_DASH = "5 3";

/** 流沙末端多扎进尖堆 1 个单位，免得两者之间露出缝隙 */
const STREAM_OVERLAP = 1;

export interface HourglassOffsets {
  /** 上沙整体下移量：沙面 = 矩形上沿 + 位移，1 表示整块移出灯泡（空） */
  sandY: number;
  /** 下沙整体下移量：0 表示堆满灯泡，HG_SPAN 表示整块在瓶外（空） */
  pileY: number;
  /** 流沙纵向缩放：从颈口垂到堆沙表面（尖堆锥尖） */
  streamScale: number;
  /** 沙面凹坑的深度缩放：暂停时为 0（收平），沙面越浅越小 */
  crater: number;
  /** 沙面凹坑的宽度缩放：沙面越浅、那一层瓶壁越窄，坑口也要跟着收 */
  craterWidth: number;
  /** 堆沙尖堆的整体缩放：随堆沙量长出来（空瓶为 0），并按沙面那一层的瓶宽封顶 */
  moundScale: number;
}

/** 尖堆在全尺寸下的高度（HG_MOUND_HEIGHT）相对堆沙量的涨落：堆沙到 35% 就不再长 */
const MOUND_FULL_AT = 0.35;

/**
 * 一个进度（0..1 = 剩余比例）对应的位移与缩放。
 * 位移的基准都是「矩形自身高度 HG_SPAN」，可以直接喂给 translateY / scaleY。
 *
 * ⚠️ 上下两个沙面**到颈口的距离相同**（都等于 level·HG_SPAN），这不是巧合：
 * 两块沙占的面积都是 level，而上下两个灯泡的半宽函数是同一条 w(u)（下半瓶是上半瓶
 * 沿颈线做的水平镜像），所以「面积相同」⟺「离颈口一样远」。这条等式一旦断开，
 * 上下两半的沙量就不再相等（实测过：把堆沙写成 levelFraction(1−p) 会让堆沙面积恒等于
 * 剩余比例 p，p=0.875 时下半瓶显出 87.5% 的沙，沙子凭空多出来）。
 * 守卫：hourglassGeometry.test.ts 直接按**画出来的可见区间**积分数面积。
 */
export function hourglassOffsets(progress: number, running = true): HourglassOffsets {
  const p = clamp01(progress);
  const level = levelFraction(p); // 沙面到颈口的距离比例（上下同值，两侧面积都是 p 与 1−p 的和为 1）
  const widthFactor = wallHalfWidth(level) / HG_HALF_TOP; // 沙面那一层瓶壁的相对宽度
  // 尖堆随堆沙量长出来：空瓶时完全没有（否则会在空瓶底浮着一个锥体），堆到 35% 后按瓶宽封顶
  const moundScale = widthFactor * Math.min(1, (1 - p) / MOUND_FULL_AT);
  // 堆沙表面 + 尖堆锥尖：流沙要正好落在锥尖上，多扎进 STREAM_OVERLAP 一点
  const pileSurfaceY = HG_NECK + HG_SPAN * level;
  const streamBottomY = pileSurfaceY - HG_MOUND_HEIGHT * moundScale + STREAM_OVERLAP;
  return {
    sandY: HG_SPAN * (1 - level),
    pileY: HG_SPAN * level,
    streamScale: clamp01((streamBottomY - HG_NECK) / HG_SPAN),
    crater: running ? clamp01((level * HG_SPAN - HG_CRATER_FADE_FROM) / (HG_CRATER_FADE_TO - HG_CRATER_FADE_FROM)) : 0,
    craterWidth: widthFactor,
    moundScale,
  };
}
