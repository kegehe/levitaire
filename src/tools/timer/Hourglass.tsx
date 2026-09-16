import {
  HG_BOTTOM,
  HG_BOX,
  HG_CAP_PATH,
  HG_CENTER,
  HG_CLIP_BOTTOM,
  HG_CLIP_TOP,
  HG_CRATER_PATH,
  HG_GLASS_PATH,
  HG_HALF_TOP,
  HG_MOUND_PATH,
  HG_NECK,
  HG_SPAN,
  HG_STREAM_FLOW_DASH,
  HG_STREAM_PATH,
  HG_TOP,
  hourglassOffsets,
} from "./hourglassGeometry";

interface HourglassProps {
  /** 剩余比例 0..1 */
  progress: number;
  /** 是否计时中（暂停即断流、凹坑收平） */
  running: boolean;
}

/** 流沙缩放小于这一档时不再画「落沙纹」：虚线被压成一个点，反而像卡了颗沙 */
const STREAM_FLOW_MIN_SCALE = 0.12;

/**
 * 倒计时「沙漏」显示样式。
 *
 * 图层顺序（先画在下）：玻璃底色 → 上沙（沙面凹坑）→ 堆沙（尖堆）→ 流沙 → 沙色明暗层 → 轮廓/端板。
 * 沙子用「矩形 + clipPath」而不是逐点算形状：横向由裁剪区贴合瓶壁，纵向只改 translateY，
 * 于是既能连续下漏，又不用碰贝塞尔数学（见 hourglassGeometry 的面积等比映射）。
 *
 * clipPath 的 id 写死是安全的：几何对每个实例都一样，即使同页出现两个沙漏，
 * 引用到彼此的形状也完全等价。
 */
function Hourglass({ progress, running }: HourglassProps) {
  const { sandY, pileY, streamScale, crater, craterWidth, moundScale } = hourglassOffsets(progress, running);

  return (
    <svg className="timer-hourglass" viewBox="0 0 120 120" aria-hidden>
      <defs>
        <clipPath id="timer-hg-clip-top"><path d={HG_CLIP_TOP} /></clipPath>
        <clipPath id="timer-hg-clip-bottom"><path d={HG_CLIP_BOTTOM} /></clipPath>
        {/* 沙色的竖向明暗（上亮下深）用**静态**渐变层压：渐变层的 rect 不带任何 transform，
            坐标系就钉在 viewBox 上，沙面移动时颜色不会跟着跑。
            （改成把渐变挂在沙块自己头上会「沙面越往下越亮」——沙子像在发光。） */}
        <linearGradient id="timer-hg-shade-gradient" gradientUnits="userSpaceOnUse" x1="0" y1={HG_TOP} x2="0" y2={HG_BOTTOM}>
          <stop offset="0" className="hg-shade-stop-top" />
          <stop offset="0.55" className="hg-shade-stop-mid" />
          <stop offset="1" className="hg-shade-stop-bottom" />
        </linearGradient>
      </defs>

      {/* 空瓶底色：沙漏的「没沙的部分」在本样式里是可见的，否则只剩两团沙子看不出是沙漏 */}
      <path className="hg-glass" d={HG_GLASS_PATH} />

      {/* 上沙：随剩余时间整体下移，沙面 = 矩形上沿 + 位移。
          注意位移必须写在**内层 rect** 上：SVG 的 clip-path 在引用元素自己的坐标系里解析，
          挂在带 transform 的 <g> 上会让裁剪区跟着一起平移，沙子就会从瓶壁两侧漏出去。 */}
      <g clipPath="url(#timer-hg-clip-top)">
        <rect className="hg-sand hg-sand-top" x={HG_CENTER - HG_HALF_TOP} y={HG_TOP} width={HG_HALF_TOP * 2} height={HG_SPAN} style={{ transform: `translateY(${sandY}px)` }} />
        {/* 凹坑与沙面同步位移，再按沙量与瓶宽缩放（先缩后移，原点在沙面正中） */}
        <path className="hg-crater" d={HG_CRATER_PATH} style={{ transform: `translateY(${sandY}px) scale(${craterWidth}, ${crater})` }} />
      </g>

      {/* 堆沙：随已过时间上移，沙面离颈口的距离与上沙完全相同（面积等比 ⇒ 沙量守恒）；
          尖堆跟着同一段位移，大小按堆沙量与那一层的瓶宽缩放 */}
      <g clipPath="url(#timer-hg-clip-bottom)">
        <rect className="hg-sand hg-sand-bottom" x={HG_CENTER - HG_HALF_TOP} y={HG_NECK} width={HG_HALF_TOP * 2} height={HG_SPAN} style={{ transform: `translateY(${pileY}px)` }} />
        <path className="hg-mound" d={HG_MOUND_PATH} style={{ transform: `translateY(${pileY}px) scale(${moundScale})` }} />
      </g>

      {/* 流沙：从颈口垂到堆沙锥尖，只在运行时出现（暂停即断流，兼作运行指示）。
          柱心那条虚线用 stroke-dashoffset 循环下走，静止画面里也有「正在漏」的动感。 */}
      {running && (
        <g className="hg-stream" style={{ transform: `scaleY(${streamScale})` }}>
          <path className="hg-stream-body" d={HG_STREAM_PATH} />
          {streamScale > STREAM_FLOW_MIN_SCALE && (
            <line className="hg-stream-flow" x1={HG_CENTER} y1={HG_NECK} x2={HG_CENTER} y2={HG_NECK + HG_SPAN} strokeDasharray={HG_STREAM_FLOW_DASH} />
          )}
        </g>
      )}

      {/* 明暗层：压在沙与空瓶之上、轮廓之下，只落在瓶内 */}
      <g clipPath="url(#timer-hg-clip-top)"><rect className="hg-shade" x="0" y="0" width={HG_BOX} height={HG_BOX} /></g>
      <g clipPath="url(#timer-hg-clip-bottom)"><rect className="hg-shade" x="0" y="0" width={HG_BOX} height={HG_BOX} /></g>

      {/* 轮廓与端板最后画：压在沙子上，沙子看起来就是「在瓶子里」 */}
      <path className="hg-outline" d={HG_GLASS_PATH} />
      <path className="hg-cap" d={HG_CAP_PATH} />
    </svg>
  );
}

export default Hourglass;
