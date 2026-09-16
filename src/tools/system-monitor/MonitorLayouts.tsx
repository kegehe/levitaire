import { Sparkline } from "./Sparkline";

/** 五个指标槽 —— 顺序即各样式的展示顺序（CPU / 内存 / GPU / 网络 / 磁盘 I/O） */
export type MetricKey = "cpu" | "mem" | "gpu" | "net" | "diskio";

/**
 * 指标 → 图表色。**只在这里映射一次**，五个色相互相区分（蓝 250 / 紫 295 / 品红 340 /
 * 橙 75 / 青 195），且有意不跟随用户强调色（见 tokens.css 的 chart palette 注释）。
 */
export const METRIC_COLOR: Record<MetricKey, string> = {
  cpu: "var(--color-chart-cpu)",
  mem: "var(--color-chart-mem)",
  gpu: "var(--color-chart-gpu)",
  net: "var(--color-chart-net)",
  diskio: "var(--color-chart-disk)",
};

/** 阈值档位：磁盘占用越高越危险，电池余量越低越危险 —— 语义相反，各自判定后再传进来 */
export type Level = "ok" | "warn" | "crit";

export interface MetricView {
  key: MetricKey;
  /** 显示名。CPU / 内存 / GPU 用原文，速率类用简称（见各 layout 的注） */
  label: string;
  /** 主数值的数值部分（大字号渲染） */
  main: string;
  /** 主数值的单位（"%" / " MB/s"），单独拆出来是为了让 hero 区能把单位排小一号 */
  unit: string;
  /**
   * 次要文本。**一律用紧凑写法且不带单位**（"↓1.9 ↑0.5"、"读6.3 写1.8"）——
   * 次要列只有 66px，带上单位必然换行（实测 "↓1.9 ↑0.5 MB/s" 需要 ≈86px）；
   * 单位由主数值给出，读起来不会歧义。守卫：SystemMonitor.test.tsx 的紧凑文本用例。
   */
  tiny: string;
  /** 0–100 的用量百分比；速率类为 null（速率没有"满"的概念，不画用量条） */
  percent: number | null;
  /** 电平条百分比：百分比类 = percent，速率类 = 按窗口峰值归一（仅用于电平条长度） */
  level: number;
  history: number[];
  /** Y 轴上限 */
  max: number;
  color: string;
}

export interface DiskView {
  mount: string;
  percent: number;
  text: string;
  level: Level;
}

export interface BatteryView {
  percent: number;
  text: string;
  level: Level;
}

export interface MonitorView {
  /** 已按 CPU/内存/GPU?/网络/磁盘 I/O 排好序；GPU 缺失时不会出现 */
  metrics: MetricView[];
  disks: DiskView[];
  battery: BatteryView | null;
  uptime: string;
}

/* ─── 共用小件 ─────────────────────────────────────────────── */

function Dot({ color }: { color: string }) {
  return <span className="monitor-dot" style={{ background: color }} aria-hidden />;
}

/** 阈值条：颜色由档位决定，宽度由 percent 决定（磁盘占用 / 电池余量共用） */
function LevelBar({
  percent,
  level,
  color,
  className,
}: {
  percent: number;
  level: Level | null;
  /** 传了就用指标色（"用量条"语义，如 CPU/内存的占比）；不传则按 data-level 取阈值色 */
  color?: string;
  className: string;
}) {
  const width = `${Math.max(0, Math.min(100, percent))}%`;
  return (
    <span className={`${className} monitor-level-bar`}>
      <span
        className="monitor-level-fill"
        data-level={level ?? "none"}
        style={color ? { width, background: color } : { width }}
      />
    </span>
  );
}

function DiskRows({ disks }: { disks: DiskView[] }) {
  return (
    <>
      {disks.map((disk) => (
        <div className="monitor-disk-row" key={disk.mount}>
          <span className="monitor-disk-mount">{disk.mount}</span>
          <LevelBar percent={disk.percent} level={disk.level} className="monitor-disk-bar" />
          <span className="monitor-disk-text">{disk.text}</span>
        </div>
      ))}
    </>
  );
}

/**
 * 底部一行：电池 + 运行时间。
 * 无电池设备时只剩运行时间（电池段整体消失，不留空槽）。
 *
 * 两样都没有时整行不渲染 —— mini 形态是直接渲染 `FootRow` 的（没有 `MonitorFooter`
 * 那层 `hasBody` 兜底），首帧还没收到 stats 时会退化成「运行时间 」这种有标签无数值的残行。
 */
function FootRow({ battery, uptime }: { battery: BatteryView | null; uptime: string }) {
  if (!battery && uptime === "") return null;
  return (
    <div className="monitor-foot-row">
      {battery && (
        <>
          <LevelBar percent={battery.percent} level={battery.level} className="monitor-battery-bar" />
          <span className="monitor-battery-text">电池 {battery.text}</span>
        </>
      )}
      <span className="monitor-foot-spacer" />
      <span className="monitor-uptime">运行时间 {uptime}</span>
    </div>
  );
}

/** 磁盘 + 电池/运行时间 的公共底部块（各 layout 结构不同，但这段完全一致） */
function MonitorFooter({ view }: { view: MonitorView }) {
  const hasBody = view.disks.length > 0 || view.battery !== null || view.uptime !== "";
  if (!hasBody) return null;
  return (
    <div className="monitor-footer">
      <div className="monitor-divider" />
      <DiskRows disks={view.disks} />
      <FootRow battery={view.battery} uptime={view.uptime} />
    </div>
  );
}

/* ─── B：紧凑行式 ──────────────────────────────────────────── */

/** 一行一个指标：标签 / 折线 / 值 / 次要文本同排。四套里最紧凑（300×195） */
export function LayoutRows({ view }: { view: MonitorView }) {
  return (
    <>
      <div className="monitor-rows">
        {view.metrics.map((metric) => (
          <div className="monitor-row" key={metric.key}>
            <span className="monitor-row-label">{metric.label}</span>
            <span className="monitor-row-chart">
              <Sparkline
                data={metric.history}
                max={metric.max}
                color={metric.color}
                height={16}
                fill={false}
              />
            </span>
            <span className="monitor-row-value" style={{ color: metric.color }}>
              {metric.main}
              {metric.unit}
            </span>
            <span className="monitor-row-extra">{metric.tiny}</span>
          </div>
        ))}
      </div>
      <MonitorFooter view={view} />
    </>
  );
}

/* ─── C：双列宫格 ──────────────────────────────────────────── */

/** 2 列卡片 + 卡片内迷你折线。窗口 340 宽（比其它样式宽 40px），换取最大字号 */
export function LayoutGrid({ view }: { view: MonitorView }) {
  // 指标个数为奇数时最后一格跨两列（GPU 缺失时是 4 格，正好 2×2，不会留孤格）；
  // 跨列的那一格同时给折线加面积填充 —— 它是最宽的一张图，有填充才压得住视觉重心，
  // 其余窄格子只留线（20px 高的面积填充在窄格里会糊成一块）。
  const odd = view.metrics.length % 2 === 1;
  const isWide = (index: number) => odd && index === view.metrics.length - 1;
  return (
    <>
      <div className="monitor-grid">
        {view.metrics.map((metric, index) => (
          <div className={`monitor-tile${isWide(index) ? " is-wide" : ""}`} key={metric.key}>
            <div className="monitor-tile-head">
              <Dot color={metric.color} />
              <span className="monitor-tile-label">{metric.label}</span>
              <span className="monitor-tile-extra">{metric.tiny}</span>
            </div>
            <div className="monitor-tile-value" style={{ color: metric.color }}>
              {metric.main}
              {metric.unit}
            </div>
            <div className="monitor-tile-chart">
              <Sparkline
                data={metric.history}
                max={metric.max}
                color={metric.color}
                height={20}
                fill={isWide(index)}
              />
            </div>
          </div>
        ))}
      </div>
      <MonitorFooter view={view} />
    </>
  );
}

/* ─── D：焦点分层 ──────────────────────────────────────────── */

/** CPU 占最大面积（大字号 + 40px 折线 + 100% 参考线），其余指标降级 */
export function LayoutHero({ view }: { view: MonitorView }) {
  const cpu = view.metrics.find((metric) => metric.key === "cpu");
  const side = view.metrics.filter((metric) => metric.key === "mem" || metric.key === "gpu");
  const io = view.metrics.filter((metric) => metric.key === "net" || metric.key === "diskio");
  if (!cpu) return <LayoutRows view={view} />;
  return (
    <>
      <div className="monitor-hero">
        <div className="monitor-hero-head">
          <span className="monitor-hero-label">{cpu.label}</span>
          <span className="monitor-hero-value" style={{ color: cpu.color }}>
            {cpu.main}
            <small>{cpu.unit}</small>
          </span>
        </div>
        <div className="monitor-hero-chart">
          <Sparkline
            data={cpu.history}
            max={cpu.max}
            color={cpu.color}
            height={40}
            baseline
          />
        </div>
        <div className="monitor-hero-foot">
          <span>{cpu.tiny}</span>
          {/* 还没有任何采样点时不要显示"窗口峰值 0%"（那是假的，与旁边的 "--" 打架） */}
          {cpu.history.length > 0 && <span>窗口峰值 {cpuPeak(cpu.history)}%</span>}
        </div>
      </div>
      {side.length > 0 && (
        <div className={`monitor-pair${side.length === 1 ? " is-single" : ""}`}>
          {side.map((metric) => (
            <div className="monitor-mini-card" key={metric.key}>
              <div className="monitor-mini-card-label">{metric.label}</div>
              <div className="monitor-mini-card-value" style={{ color: metric.color }}>
                {metric.main}
                {metric.unit}
              </div>
              <LevelBar
                percent={metric.percent ?? metric.level}
                level={null}
                color={metric.color}
                className="monitor-mini-card-bar"
              />
              <div className="monitor-mini-card-extra">{metric.tiny}</div>
            </div>
          ))}
        </div>
      )}
      {io.map((metric) => (
        <div className="monitor-irow" key={metric.key}>
          <span className="monitor-irow-label">{metric.label}</span>
          <span className="monitor-irow-chart">
            <Sparkline
              data={metric.history}
              max={metric.max}
              color={metric.color}
              height={14}
              fill={false}
            />
          </span>
          <span className="monitor-irow-value" style={{ color: metric.color }}>
            {metric.main}
            {metric.unit}
          </span>
          <span className="monitor-irow-extra">{metric.tiny}</span>
        </div>
      ))}
      <MonitorFooter view={view} />
    </>
  );
}

/** 窗口内（环形缓冲可见段）峰值 —— hero 区的"峰值"必须与折线同源，别去问后端要 */
function cpuPeak(history: number[]): number {
  if (history.length === 0) return 0;
  return Math.round(Math.max(...history));
}

/* ─── E：共享趋势图 ────────────────────────────────────────── */

const TREND_KEYS: MetricKey[] = ["cpu", "mem", "gpu"];

/** 顶部一张全宽多线趋势图 + 下方五个指标的统一电平表 */
export function LayoutTrend({ view }: { view: MonitorView }) {
  const trend = view.metrics.filter((metric) => TREND_KEYS.includes(metric.key));
  return (
    <>
      <div className="monitor-trend">
        <div className="monitor-trend-chart">
          {trend.map((metric) => (
            <span className="monitor-trend-layer" key={metric.key}>
              <Sparkline
                data={metric.history}
                max={metric.max}
                color={metric.color}
                height={52}
                fill={false}
              />
            </span>
          ))}
        </div>
        <div className="monitor-legend">
          {trend.map((metric) => (
            <span className="monitor-legend-item" key={metric.key}>
              <i style={{ background: metric.color }} />
              {metric.label}
              <b>
                {metric.main}
                {metric.unit}
              </b>
            </span>
          ))}
        </div>
      </div>
      <div className="monitor-table">
        {view.metrics.map((metric) => (
          <div className="monitor-trow" key={metric.key}>
            <span className="monitor-trow-label">
              <Dot color={metric.color} />
              {metric.label}
            </span>
            <LevelBar
              percent={metric.level}
              level={null}
              color={metric.color}
              className="monitor-trow-bar"
            />
            <span className="monitor-trow-value">
              {metric.main}
              {metric.unit}
            </span>
            <span className="monitor-trow-extra">{metric.tiny}</span>
          </div>
        ))}
      </div>
      <MonitorFooter view={view} />
    </>
  );
}

/* ─── mini：单行三格 ──────────────────────────────────────── */

const MINI_KEYS: MetricKey[] = ["cpu", "mem", "net"];

/**
 * mini 形态：CPU / 内存 / 网络 三格并排（各带 14px 迷你折线）+ 底部一行电池与运行时间。
 * 旧 mini 是 2×2 网格 + 第 5 张孤卡、且完全不画折线（`showTrend={!isMini}`），只剩数字。
 */
export function LayoutMini({ view }: { view: MonitorView }) {
  const cells = MINI_KEYS.map((key) => view.metrics.find((metric) => metric.key === key)).filter(
    (metric): metric is MetricView => metric !== undefined,
  );
  return (
    <>
      <div className="monitor-ministrip">
        {cells.map((metric) => (
          <div className="monitor-mini-cell" key={metric.key}>
            <div className="monitor-mini-label">
              <Dot color={metric.color} />
              {metric.label}
            </div>
            <div className="monitor-mini-value" style={{ color: metric.color }}>
              {metric.main}
              {metric.unit}
            </div>
            <div className="monitor-mini-chart">
              <Sparkline
                data={metric.history}
                max={metric.max}
                color={metric.color}
                height={14}
                fill={false}
              />
            </div>
          </div>
        ))}
      </div>
      <FootRow battery={view.battery} uptime={view.uptime} />
    </>
  );
}
