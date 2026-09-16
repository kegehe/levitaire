/**
 * **改造前**的沙漏（临时对照件，不参与产品构建）。
 *
 * 这是把改造前的 Hourglass.tsx / hourglassGeometry.ts 原样搬过来的快照，
 * 只为出「改造前 vs 改造后」的对照图。所有描边/填充都写成内联样式，
 * 因此不依赖已经改过的 `.hg-*` 规则。
 *
 * 对照点（都是观感问题，不是算错）：
 *  1. 瓶壁是**直锥**（两片平三角形拼成领结），棱角很硬；
 *  2. 堆沙表面是**一刀平**的，没有休止角锥体；
 *  3. 流沙是一根定宽细杆，没有落沙纹。
 *
 * ⚠️ 沙量映射两边是一样的：老版的 `pileFraction(f)` 恒等于 `1 − levelFraction(1 − f)`，
 * 换算出来的堆沙面位置与改造后完全相同。当初误判成「老版堆沙体积算错」是因为手推时
 * 拿了下半瓶的半宽函数 HT−Δu（老几何实际是 HN+Δu），别照着那个错误结论去改映射。
 */
const TOP = 11.5;
const NECK = 60;
const BOTTOM = 108.5;
const SPAN = NECK - TOP;
const HALF_TOP = 35;
const HALF_NECK = 6;
const LEFT = 60 - HALF_TOP;
const RIGHT = 60 + HALF_TOP;
const NECK_LEFT = 60 - HALF_NECK;
const NECK_RIGHT = 60 + HALF_NECK;

const GLASS = `M ${LEFT} ${TOP} L ${NECK_LEFT} ${NECK} L ${LEFT} ${BOTTOM} L ${RIGHT} ${BOTTOM} L ${NECK_RIGHT} ${NECK} L ${RIGHT} ${TOP} Z`;
const CAP = `M ${LEFT - 5.5} ${TOP} H ${RIGHT + 5.5} M ${LEFT - 5.5} ${BOTTOM} H ${RIGHT + 5.5}`;
const CLIP_TOP = `M ${LEFT} ${TOP} L ${NECK_LEFT} ${NECK} L ${NECK_RIGHT} ${NECK} L ${RIGHT} ${TOP} Z`;
const CLIP_BOTTOM = `M ${NECK_LEFT} ${NECK} L ${NECK_RIGHT} ${NECK} L ${RIGHT} ${BOTTOM} L ${LEFT} ${BOTTOM} Z`;
const CRATER = `M ${60 - 8} ${TOP} L 60 ${TOP + 3.5} L ${60 + 8} ${TOP} Z`;
const DELTA = HALF_TOP - HALF_NECK;
const SUM = HALF_TOP + HALF_NECK;

const clamp01 = (v: number) => (!Number.isFinite(v) ? 0 : Math.min(1, Math.max(0, v)));
const levelFraction = (f: number) => (-HALF_NECK + Math.sqrt(HALF_NECK * HALF_NECK + DELTA * clamp01(f) * SUM)) / DELTA;
const pileFraction = (f: number) => (HALF_TOP - Math.sqrt(HALF_TOP * HALF_TOP - DELTA * clamp01(f) * SUM)) / DELTA;

interface Props {
  progress: number;
  running: boolean;
}

function LegacyHourglass({ progress, running }: Props) {
  const p = clamp01(progress);
  const level = levelFraction(p);
  const pile = pileFraction(1 - p);
  const sandY = SPAN * (1 - level);
  const pileY = SPAN * (1 - pile);
  const streamScale = 1 - pile;
  const crater = running ? clamp01((level * SPAN - 8) / (26 - 8)) : 0;
  const sand = "#4a9eff";
  const glass = "#191e28";
  const line = "#acb8cc";

  return (
    <svg className="legacy-hourglass" viewBox="0 0 120 120" aria-hidden style={{ display: "block", width: 112, height: 112, overflow: "visible" }}>
      <defs>
        <clipPath id="legacy-clip-top"><path d={CLIP_TOP} /></clipPath>
        <clipPath id="legacy-clip-bottom"><path d={CLIP_BOTTOM} /></clipPath>
      </defs>
      <path d={GLASS} style={{ fill: glass, stroke: line, strokeWidth: 2.6, strokeLinejoin: "round" }} />
      <g clipPath="url(#legacy-clip-top)">
        <rect x={20} y={TOP} width={80} height={SPAN} style={{ fill: sand, transform: `translateY(${sandY}px)` }} />
        <path d={CRATER} style={{ fill: glass, transformBox: "view-box", transformOrigin: "60px 11.5px", transform: `translateY(${sandY}px) scale(${crater})` }} />
      </g>
      <g clipPath="url(#legacy-clip-bottom)">
        <rect x={20} y={NECK} width={80} height={SPAN} style={{ fill: sand, transform: `translateY(${pileY}px)` }} />
      </g>
      {running && <rect x={59} y={NECK} width={2} height={SPAN} style={{ fill: sand, opacity: 0.9, transformBox: "view-box", transformOrigin: "60px 60px", transform: `scaleY(${streamScale})` }} />}
      <path d={GLASS} style={{ fill: "none", stroke: line, strokeWidth: 2.6, strokeLinejoin: "round", strokeLinecap: "round" }} />
      <path d={CAP} style={{ fill: "none", stroke: line, strokeWidth: 2.6, strokeLinecap: "round", opacity: 0.7 }} />
    </svg>
  );
}

export default LegacyHourglass;
