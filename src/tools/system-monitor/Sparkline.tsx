import { memo, useMemo } from "react";

/**
 * 环形缓冲容量（采样点数）。
 *
 * ⚠️ 这是「60 个采样点」而**不是**「60 秒」：切到 2 秒 / 5 秒档后时间窗会变成 2 / 5 分钟。
 * 曲线本身仍然逐点左移，所以视觉上是连续的；只是横轴的时间尺度随刷新间隔变。
 * （已知遗留，未在本轮处理：要真做时间轴得把 intervalMs 也纳入宽度换算。）
 */
export const MONITOR_HISTORY_LEN = 60;

/** 视口宽度 = 采样点数 − 1，于是「1 个 viewBox 单位 = 1 个采样间隔」 */
const VIEW_WIDTH = MONITOR_HISTORY_LEN - 1;

export interface SparklineProps {
  data: number[];
  /** Y 轴上限；<=0 时不画（避免除零后整条线贴顶） */
  max: number;
  /** 线条/渐变颜色，形如 `var(--color-chart-cpu)` */
  color: string;
  /** 视口高度（CSS px）。**宽度一律跟随容器**，不再写死像素值 */
  height: number;
  /** 顶部 100% 参考线：0–100% 的指标靠它才能看出"离满还有多远" */
  baseline?: boolean;
  /** 面积渐变填充（默认开）；行式里 16px 高的细折线可以关掉，免得糊成一片 */
  fill?: boolean;
  className?: string;
}

let gradientSeq = 0;

/**
 * 0 依赖的迷你折线。
 *
 * 宽度用 `width: 100%` + `viewBox` + `preserveAspectRatio="none"` 拉伸，配合
 * `vector-effect="non-scaling-stroke"` 让线宽保持 1.5 屏幕像素 —— 于是窗口改宽、
 * 换成 340 宽的双列宫格样式时都不需要改任何 JS 常量。
 * （旧实现把宽度写死 264，而可用宽度是 278，右侧永远空 14px，曲线像"没画完"。）
 */
function SparklineBase({
  data,
  max,
  color,
  height,
  baseline = false,
  fill = true,
  className,
}: SparklineProps) {
  const { points, areaPath, gradientId } = useMemo(() => {
    const id = `spark-g${(gradientSeq += 1)}`;
    if (data.length < 2 || max <= 0) {
      return { points: "", areaPath: "", gradientId: id };
    }
    const coords = data.map((value, index) => {
      const x = index; // 1 单位 = 1 个采样间隔
      const y = height - Math.min(Math.max(value, 0) / max, 1) * height;
      return `${x},${y.toFixed(2)}`;
    });
    const lastX = data.length - 1;
    return {
      points: coords.join(" "),
      areaPath: `M0,${height} L ${coords.join(" L ")} L${lastX},${height} Z`,
      gradientId: id,
    };
  }, [data, max, height]);

  return (
    <svg
      className={`monitor-spark${className ? ` ${className}` : ""}`}
      width="100%"
      height={height}
      viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
      focusable="false"
    >
      {points ? (
        <>
          {fill && (
            <>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" style={{ stopColor: color }} stopOpacity="0.32" />
                  <stop offset="100%" style={{ stopColor: color }} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={areaPath} fill={`url(#${gradientId})`} />
            </>
          )}
          {baseline && (
            <line
              x1="0"
              y1="0.5"
              x2={VIEW_WIDTH}
              y2="0.5"
              stroke="var(--color-border-strong)"
              strokeWidth="1"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          <polyline
            points={points}
            fill="none"
            style={{ stroke: color }}
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </>
      ) : null}
    </svg>
  );
}

export const Sparkline = memo(SparklineBase);
