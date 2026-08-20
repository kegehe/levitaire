import { useEffect, useLayoutEffect, useMemo, useRef, useState, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "../../components/Icon";
import {
  fetchSystemMonitorConfig,
  saveSystemMonitorConfig,
  type SystemMonitorConfig,
  type SystemMonitorDisplayMode,
} from "../../constants/systemMonitorConfig";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../../styles/themePreferences";
import { formatBytes, formatRate, formatUptime } from "../../utils/formatBytes";
import { persistWindowPositionOnMove } from "../../utils/windowPosition";
import "./SystemMonitor.css";

/** 后端 monitor-stats 事件 payload（与 Rust MonitorStats 对应） */
interface MonitorStats {
  timestamp_ms: number;
  interval_ms: number;
  uptime_secs: number;
  cpu_usage_total: number;
  cpu_usage_per_core: number[];
  cpu_freq_mhz: number[];
  mem_used: number;
  mem_total: number;
  mem_available: number;
  net: { name: string; rx_rate: number; tx_rate: number }[];
  disks: { mount_point: string; total: number; available: number; kind: string }[];
  disk_io: { read_rate: number; write_rate: number } | null;
  battery: { has_battery: boolean; percent: number; charging: boolean };
}

/** 环形缓冲历史点数（默认 1s 下约 60 秒窗口） */
const HISTORY_LEN = 60;
const MONITOR_WINDOW_SIZES: Record<SystemMonitorDisplayMode, { width: number; height: number }> = {
  full: { width: 300, height: 520 },
  mini: { width: 300, height: 180 },
};

// ─── SVG Sparkline（0 依赖，React.memo 分区） ───────────────────

interface SparklineProps {
  data: number[];
  max: number;
  color: string;
  width?: number;
  height?: number;
}

function SparklineBase({ data, max, color, width = 264, height = 28 }: SparklineProps) {
  // 坐标计算用 useMemo，依赖 data 引用（pushSample 每次产生新数组）与 max
  // color 为 var(--color-chart-xxx) 形式的 CSS 变量，需通过内联 style（非 SVG 表现属性）注入，
  // 否则 var() 不会在表现属性中被解析，线条/渐变将不可见。
  const { points, areaPath, safeId } = useMemo(() => {
    // id 不能含 "#"（linearGradient id 选择器限制），去除 var() 前缀仅做稳定 key
    const safeId = `grad-${color.replace(/[^a-z0-9]/gi, "")}`;
    if (data.length < 2 || max <= 0) {
      return { points: "", areaPath: "", safeId };
    }
    const stepX = width / (HISTORY_LEN - 1);
    const coords = data.map((v, i) => {
      const x = i * stepX;
      const y = height - Math.min(v / max, 1) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const pointsStr = coords.join(" ");
    const lastX = (data.length - 1) * stepX;
    // 填充区：从左下角 → 各点 → 右下角 → 闭合
    const area = `M0,${height} L ${coords.join(" L ")} L${lastX.toFixed(1)},${height} Z`;
    return { points: pointsStr, areaPath: area, safeId };
  }, [data, max, color, width, height]);

  if (!points) {
    return <svg width={width} height={height} className="sparkline" aria-hidden />;
  }
  return (
    <svg width={width} height={height} className="sparkline" aria-hidden>
      <defs>
        <linearGradient id={safeId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: color }} stopOpacity="0.35" />
          <stop offset="100%" style={{ stopColor: color }} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${safeId})`} />
      <polyline
        points={points}
        fill="none"
        style={{ stroke: color }}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const Sparkline = memo(SparklineBase);

// ─── 指标卡片 ───────────────────────────────────────────────────

interface MetricCardProps {
  label: string;
  value: string;
  data: number[];
  max: number;
  color: string;
  extra?: string;
  showTrend: boolean;
}

function MetricCardBase({ label, value, data, max, color, extra, showTrend }: MetricCardProps) {
  return (
    <div className="metric-card">
      <div className="metric-head">
        <span className="metric-label">{label}</span>
        <span className="metric-value">{value}</span>
      </div>
      {showTrend && <Sparkline data={data} max={max} color={color} />}
      {extra && <div className="metric-extra">{extra}</div>}
    </div>
  );
}

const MetricCard = memo(MetricCardBase);

// ─── 主组件 ─────────────────────────────────────────────────────

function SystemMonitor() {
  const [stats, setStats] = useState<MonitorStats | null>(null);
  const [config, setConfig] = useState<SystemMonitorConfig>({
    intervalMs: 1000,
    displayMode: "full",
  });
  const [, setTick] = useState(0);
  const configRef = useRef<SystemMonitorConfig>({ intervalMs: 1000, displayMode: "full" });
  const configVersionRef = useRef(0);

  // 各指标历史环形缓冲（用 ref 避免每秒全量 re-render，配合 rAF 批量触发）
  const cpuHistRef = useRef<number[]>([]);
  const memHistRef = useRef<number[]>([]);
  const netHistRef = useRef<number[]>([]);
  const diskIoHistRef = useRef<number[]>([]);
  const rafRef = useRef<number | null>(null);
  const monitorBodyRef = useRef<HTMLDivElement>(null);

  const pushSample = (s: MonitorStats) => {
    // 返回新数组（不可变），让 Sparkline/memo 的浅比较能检测到变化并重绘
    const push = (arr: number[], v: number): number[] => {
      const next = arr.length >= HISTORY_LEN ? arr.slice(1) : arr.slice();
      next.push(v);
      return next;
    };
    cpuHistRef.current = push(cpuHistRef.current, s.cpu_usage_total);
    // 内存使用百分比
    const memPct = s.mem_total > 0 ? (s.mem_used / s.mem_total) * 100 : 0;
    memHistRef.current = push(memHistRef.current, memPct);
    // 网络总速率（rx+tx）
    const totalNet = s.net.reduce((acc, n) => acc + n.rx_rate + n.tx_rate, 0);
    netHistRef.current = push(netHistRef.current, totalNet);
    const totalDiskIo = s.disk_io ? s.disk_io.read_rate + s.disk_io.write_rate : 0;
    diskIoHistRef.current = push(diskIoHistRef.current, totalDiskIo);
  };

  const scheduleFrame = () => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setTick((t) => (t + 1) & 0xffff);
    });
  };

  // 独立 WebView 需要自行初始化主题和透明背景，避免首帧闪烁。
  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const root = document.getElementById("root");
    if (root) {
      root.style.background = "transparent";
      root.style.margin = "0";
      root.style.height = "100%";
    }
  }, []);

  useEffect(() => {
    emit("monitor-window-ready").catch(console.error);
  }, []);

  // 设置窗口的 localStorage 不应作为运行中跨窗口同步机制。
  useEffect(() => {
    const unlistenTheme = subscribeThemePreferences();
    return () => {
      unlistenTheme.then((fn) => fn()).catch(console.error);
    };
  }, []);

  const isMini = config.displayMode === "mini";

  useLayoutEffect(() => {
    const body = monitorBodyRef.current;
    const titlebar = body?.querySelector<HTMLElement>(".monitor-titlebar");
    if (!body || !titlebar || titlebar.offsetHeight === 0) return;

    const styles = getComputedStyle(body);
    const paddingY =
      (Number.parseFloat(styles.paddingTop) || 0) + (Number.parseFloat(styles.paddingBottom) || 0);
    const borderY =
      (Number.parseFloat(styles.borderTopWidth) || 0) +
      (Number.parseFloat(styles.borderBottomWidth) || 0);
    const gap = Number.parseFloat(styles.gap) || 0;

    if (isMini) {
      // mini 模式：标题栏 + 2×2 指标卡，无 sections/footer
      const metrics = body?.querySelector<HTMLElement>(".metrics");
      if (!metrics || metrics.offsetHeight === 0) return;
      const height = Math.ceil(
        paddingY + borderY + titlebar.offsetHeight + gap + metrics.offsetHeight,
      );
      // 与窗口当前高度比较（而非上次 fit 的历史高度）：窗口被外部 setSize
      // 重置默认尺寸后，仅当实际高度不匹配时才重新 fit，匹配时自然防抖。
      if (Math.abs(window.innerHeight - height) < 1) return;
      getCurrentWebviewWindow()
        .setSize(new LogicalSize(MONITOR_WINDOW_SIZES.mini.width, height))
        .catch(console.error);
      return;
    }

    // full 模式：标题栏 + 内容(metrics+sections) + footer 的自然总高。
    // 需要等 stats 就绪（磁盘/电池/footer 等 section 才会渲染）再定高，
    // 否则会在窗口刚打开时就缩成只剩标题+指标卡的矮窗；stats 到达前的
    // 初始高度沿用后端 show 时设置的 520，待内容齐备后再贴齐。
    // 直接把 body 置为 height:auto 测一次 offsetHeight，得到不滚动、无空区的
    // 精确目标高度（content 为 flex:1 + overflow-y:auto，逐个量子元素会
    // 因 flex 拉伸/收缩而双重计数，用整段自然高最稳）。同步还原避免闪帧。
    // 依赖 stats（而非 stats !== null）：窗口复用后组件不重新挂载，
    // 仅凭「首次 stats」不会再次 fit；而采集线程只在窗口显示期间运行
    // （hide 时 stop），每次重新打开后收到的第一条 stats 恰好代表「窗口
    // 重新显示」，此时重新测量 fit，覆盖 show_monitor_window 设置的默认
    // 520 高度，避免底部留白/截断。
    if (!stats) return;
    const prevHeight = body.style.height;
    body.style.height = "auto";
    const natural = body.offsetHeight;
    body.style.height = prevHeight;
    const height = Math.ceil(natural);
    // 与窗口当前高度比较（而非上次 fit 的历史高度）：窗口复用后每次打开都会被
    // show_monitor_window 重置为默认 520，若仅与历史 fit 高度比较，窗口被强制
    // 改高后不会缩回内容高度（历史高度 == 内容自然高度 → 防抖误拦截）。
    // 窗口实际高度匹配目标时自然防抖，不重复 setSize。
    if (Math.abs(window.innerHeight - height) < 1) return;
    getCurrentWebviewWindow()
      .setSize(new LogicalSize(MONITOR_WINDOW_SIZES.full.width, height))
      .catch(console.error);
  }, [isMini, stats]);

  // 加载配置
  useEffect(() => {
    let cancelled = false;
    fetchSystemMonitorConfig().then((stored) => {
      if (!cancelled && configVersionRef.current === 0) {
        configRef.current = stored;
        setConfig(stored);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 订阅 monitor-stats + rAF 节流
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let cancelled = false;
    listen<MonitorStats>("monitor-stats", (e) => {
      setStats(e.payload);
      pushSample(e.payload);
      scheduleFrame();
    }).then((fn) => {
      // 若组件在 listen resolve 前已卸载，立即取消刚拿到的监听器，避免泄漏
      if (cancelled) {
        fn();
      } else {
        un = fn;
      }
    });
    return () => {
      cancelled = true;
      if (un) un();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Esc 关窗
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        invoke("hide_monitor_window").catch(console.error);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 记忆窗口位置：拖动结束后持久化，下次打开恢复上次位置
  useEffect(() => persistWindowPositionOnMove("monitor-overlay"), []);

  const toggleDisplayMode = async () => {
    const nextMode: SystemMonitorDisplayMode = isMini ? "full" : "mini";
    const newConfig = { ...configRef.current, displayMode: nextMode };
    try {
      await saveSystemMonitorConfig(newConfig);
      // 后端只做持久化，不会 emit 事件；需自行通知本窗口监听器刷新 UI + 窗口尺寸
      emit("levitaire-system-monitor-config-changed", newConfig).catch(console.error);
    } catch (e) {
      console.error("Failed to save monitor config:", e);
    }
  };

  const resizeMonitorWindow = (displayMode: SystemMonitorDisplayMode) => {
    const size = MONITOR_WINDOW_SIZES[displayMode];
    getCurrentWebviewWindow()
      .setSize(new LogicalSize(size.width, size.height))
      .catch(console.error);
  };

  useEffect(() => {
    const unlisten = listen<SystemMonitorConfig>(
      "levitaire-system-monitor-config-changed",
      (event) => {
        configVersionRef.current += 1;
        configRef.current = event.payload;
        setConfig(event.payload);
        resizeMonitorWindow(event.payload.displayMode);
      },
    );
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, []);

  // 网络最大速率（用于 sparkline max 自适应，取历史峰值与当前值的较大者）。
  // 直接每次渲染计算（hist 最长 HISTORY_LEN，开销可忽略），避免 useMemo 依赖 [stats]
  // 却读取可变 ref 导致 max 与 data 取自不同帧的不一致。
  const hist = netHistRef.current;
  const netMax = hist.length ? Math.max(...hist, 1024) : 1024; // 至少 1KB/s 基线
  const diskIoHist = diskIoHistRef.current;
  const diskIoMax = diskIoHist.length ? Math.max(...diskIoHist, 1024) : 1024;

  const memPct = stats && stats.mem_total > 0 ? (stats.mem_used / stats.mem_total) * 100 : 0;
  const memExtra = stats
    ? `${formatBytes(stats.mem_used)} / ${formatBytes(stats.mem_total)}（可用 ${formatBytes(
        stats.mem_available,
      )}）`
    : "";
  return (
    <div className="monitor-container">
      <div
        ref={monitorBodyRef}
        className={`monitor-body${isMini ? " is-mini" : ""}`}
        data-tauri-drag-region=""
      >
        <div className="monitor-titlebar" data-tauri-drag-region="">
          <span className="monitor-title" data-tauri-drag-region="">
            系统监控
          </span>
          <button
            className="monitor-icon-btn"
            aria-label={isMini ? "切换到标准模式" : "切换到迷你模式"}
            data-tooltip={isMini ? "切换到标准模式" : "切换到迷你模式"}
            onClick={toggleDisplayMode}
          >
            <Icon name={isMini ? "Maximize2" : "Minimize2"} size={14} />
          </button>
          <button
            className="monitor-icon-btn"
            aria-label="关闭系统监控"
            data-tooltip="关闭系统监控"
            onClick={() => invoke("hide_monitor_window").catch(console.error)}
          >
            <Icon name="X" size={14} />
          </button>
        </div>

        <div className="monitor-content">
          <div className="metrics">
          <MetricCard
            label="CPU"
            value={stats ? `${stats.cpu_usage_total.toFixed(0)}%` : "--"}
            data={cpuHistRef.current}
            max={100}
            color="var(--color-chart-cpu)"
            showTrend={!isMini}
            extra={
              stats
                ? `${stats.cpu_usage_per_core.length} 核${
                    stats.cpu_freq_mhz.length
                      ? ` · ${Math.round(
                          stats.cpu_freq_mhz.reduce((a, b) => a + b, 0) / stats.cpu_freq_mhz.length,
                        )} MHz`
                      : ""
                  }`
                : ""
            }
          />
          <MetricCard
            label="内存"
            value={stats ? `${memPct.toFixed(0)}%` : "--"}
            data={memHistRef.current}
            max={100}
            color="var(--color-chart-mem)"
            showTrend={!isMini}
            extra={
              isMini && stats
                ? `${formatBytes(stats.mem_used)} / ${formatBytes(stats.mem_total)}`
                : memExtra
            }
          />
          <MetricCard
            label="网络"
            value={
              stats ? formatRate(netHistRef.current[netHistRef.current.length - 1] ?? 0) : "--"
            }
            data={netHistRef.current}
            max={netMax}
            color="var(--color-chart-net)"
            showTrend={!isMini}
            extra={
              stats
                ? `下载 ${formatRate(stats.net.reduce((total, item) => total + item.rx_rate, 0))} · 上传 ${formatRate(
                    stats.net.reduce((total, item) => total + item.tx_rate, 0),
                  )}`
                : undefined
            }
          />
          <MetricCard
            label="磁盘 I/O"
            value={
              stats?.disk_io ? formatRate(stats.disk_io.read_rate + stats.disk_io.write_rate) : "--"
            }
            data={diskIoHistRef.current}
            max={diskIoMax}
            color="var(--color-chart-disk)"
            showTrend={!isMini}
            extra={
              stats?.disk_io
                ? `读取 ${formatRate(stats.disk_io.read_rate)} · 写入 ${formatRate(stats.disk_io.write_rate)}`
                : undefined
            }
          />
        </div>

        {/* 磁盘 */}
        {!isMini && stats && stats.disks.length > 0 && (
          <div className="section">
            <div className="section-label">磁盘</div>
            {stats.disks.map((d) => {
              const usedPct = d.total > 0 ? ((d.total - d.available) / d.total) * 100 : 0;
              return (
                <div className="disk-row" key={d.mount_point}>
                  <span className="disk-mount">{d.mount_point}</span>
                  <div className="disk-bar">
                    <div className="disk-bar-fill" style={{ width: `${usedPct}%` }} />
                  </div>
                  <span className="disk-text">
                    {formatBytes(d.total - d.available)} / {formatBytes(d.total)} · {d.kind}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* 电池 */}
        {!isMini && stats && stats.battery.has_battery && (
          <div className="section">
            <div className="section-label">电池</div>
            <div className="battery-row">
              <div className="battery-bar">
                <div className="battery-bar-fill" style={{ width: `${stats.battery.percent}%` }} />
              </div>
              <span className="battery-text">
                {stats.battery.percent}%{stats.battery.charging ? " · 充电中" : " · 使用中"}
              </span>
            </div>
          </div>
        )}

        </div>

        {/* 运行时间 */}
        {!isMini && stats && (
          <div className="footer">运行时间 {formatUptime(stats.uptime_secs)}</div>
        )}
      </div>
    </div>
  );
}

export default SystemMonitor;
