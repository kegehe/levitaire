import { useEffect, useLayoutEffect, useMemo, useRef, useState, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "../../components/Icon";
import {
  fetchSystemMonitorConfig,
  type SystemMonitorConfig,
  type SystemMonitorDisplayMode,
} from "../../constants/systemMonitorConfig";
import { formatBytes, formatRate, formatUptime } from "../../utils/formatBytes";
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
  const { points, areaPath, gradId } = useMemo(() => {
    const gradId = `grad-${color.replace("#", "")}`;
    if (data.length < 2 || max <= 0) {
      return { points: "", areaPath: "", gradId };
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
    return { points: pointsStr, areaPath: area, gradId };
  }, [data, max, color, width, height]);

  if (!points) {
    return <svg width={width} height={height} className="sparkline" aria-hidden />;
  }
  return (
    <svg width={width} height={height} className="sparkline" aria-hidden>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
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
  const [config, setConfig] = useState<SystemMonitorConfig>({ intervalMs: 1000, displayMode: "full" });
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
  const miniWindowHeightRef = useRef<number | null>(null);

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
    const theme = localStorage.getItem("floast-theme") || "light";
    document.documentElement.setAttribute("data-theme", theme);
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
    const unlistenTheme = listen<string>("floast-theme-changed", (event) => {
      document.documentElement.setAttribute("data-theme", event.payload);
      localStorage.setItem("floast-theme", event.payload);
    });
    return () => {
      unlistenTheme.then((fn) => fn()).catch(console.error);
    };
  }, []);

  const isMini = config.displayMode === "mini";

  useLayoutEffect(() => {
    if (!isMini) {
      miniWindowHeightRef.current = null;
      return;
    }
    const body = monitorBodyRef.current;
    const titlebar = body?.querySelector<HTMLElement>(".monitor-titlebar");
    const metrics = body?.querySelector<HTMLElement>(".metrics");
    if (!body || !titlebar || !metrics || metrics.offsetHeight === 0) return;

    const styles = getComputedStyle(body);
    const paddingY =
      (Number.parseFloat(styles.paddingTop) || 0) +
      (Number.parseFloat(styles.paddingBottom) || 0);
    const gap = Number.parseFloat(styles.gap) || 0;
    const height = Math.ceil(paddingY + titlebar.offsetHeight + gap + metrics.offsetHeight);
    if (miniWindowHeightRef.current === height) return;

    miniWindowHeightRef.current = height;
    getCurrentWebviewWindow()
      .setSize(new LogicalSize(MONITOR_WINDOW_SIZES.mini.width, height))
      .catch(console.error);
  }, [isMini, stats !== null]);

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

  const resizeMonitorWindow = (displayMode: SystemMonitorDisplayMode) => {
    const size = MONITOR_WINDOW_SIZES[displayMode];
    getCurrentWebviewWindow()
      .setSize(new LogicalSize(size.width, size.height))
      .catch(console.error);
  };

  useEffect(() => {
    const unlisten = listen<SystemMonitorConfig>("floast-system-monitor-config-changed", (event) => {
      configVersionRef.current += 1;
      configRef.current = event.payload;
      setConfig(event.payload);
      resizeMonitorWindow(event.payload.displayMode);
    });
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

  const memPct =
    stats && stats.mem_total > 0 ? (stats.mem_used / stats.mem_total) * 100 : 0;
  const memExtra =
    stats
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
            aria-label="关闭"
            onClick={() => invoke("hide_monitor_window").catch(console.error)}
          >
            <Icon name="X" size={14} />
          </button>
        </div>

        <div className="metrics">
          <MetricCard
            label="CPU"
            value={stats ? `${stats.cpu_usage_total.toFixed(0)}%` : "--"}
            data={cpuHistRef.current}
            max={100}
            color="#4f9dff"
            showTrend={!isMini}
            extra={
              stats
                ? `${stats.cpu_usage_per_core.length} 核${
                    stats.cpu_freq_mhz.length
                      ? ` · ${Math.round(
                          stats.cpu_freq_mhz.reduce((a, b) => a + b, 0) /
                            stats.cpu_freq_mhz.length,
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
            color="#7ec873"
            showTrend={!isMini}
            extra={isMini && stats ? `${formatBytes(stats.mem_used)} / ${formatBytes(stats.mem_total)}` : memExtra}
          />
          <MetricCard
            label="网络"
            value={stats ? formatRate(netHistRef.current[netHistRef.current.length - 1] ?? 0) : "--"}
            data={netHistRef.current}
            max={netMax}
            color="#e0a84a"
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
              stats?.disk_io
                ? formatRate(stats.disk_io.read_rate + stats.disk_io.write_rate)
                : "--"
            }
            data={diskIoHistRef.current}
            max={diskIoMax}
            color="#b779d0"
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
              const usedPct =
                d.total > 0 ? ((d.total - d.available) / d.total) * 100 : 0;
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
                <div
                  className="battery-bar-fill"
                  style={{ width: `${stats.battery.percent}%` }}
                />
              </div>
              <span className="battery-text">
                {stats.battery.percent}%
                {stats.battery.charging ? " · 充电中" : " · 使用中"}
              </span>
            </div>
          </div>
        )}

        {/* 运行时间 */}
        {!isMini && stats && (
          <div className="footer">
            运行时间 {formatUptime(stats.uptime_secs)}
          </div>
        )}
      </div>
    </div>
  );
}

export default SystemMonitor;
