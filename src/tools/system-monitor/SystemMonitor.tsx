import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "../../components/Icon";
import {
  DEFAULT_SYSTEM_MONITOR_LAYOUT,
  MONITOR_MINI_SIZE,
  fetchSystemMonitorConfig,
  monitorLayoutOption,
  nextSystemMonitorLayout,
  normalizeSystemMonitorConfig,
  saveSystemMonitorConfig,
  type SystemMonitorConfig,
  type SystemMonitorDisplayMode,
  type SystemMonitorLayout,
} from "../../constants/systemMonitorConfig";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../../styles/themePreferences";
import { formatBytes, formatRate, formatUptime } from "../../utils/formatBytes";
import { persistWindowPositionOnMove } from "../../utils/windowPosition";
import { clampWindowToWorkArea } from "../../utils/panelWindow";
import { MONITOR_HISTORY_LEN } from "./Sparkline";
import {
  METRIC_COLOR,
  LayoutGrid,
  LayoutHero,
  LayoutMini,
  LayoutRows,
  LayoutTrend,
  type Level,
  type MetricView,
  type MonitorView,
} from "./MonitorLayouts";
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
  gpu: { has_gpu: boolean; usage: number; memory_used: number; memory_total: number };
  battery: { has_battery: boolean; percent: number; charging: boolean };
}

/** 标准模式的四套结构（`SystemMonitorLayout` → 组件）。新增样式时在这里补一行 */
const LAYOUT_COMPONENTS: Record<SystemMonitorLayout, ComponentType<{ view: MonitorView }>> = {
  b: LayoutRows,
  c: LayoutGrid,
  d: LayoutHero,
  e: LayoutTrend,
};

/**
 * 阈值：磁盘占用越高越危险（85% 起提示、95% 起告警）。
 * 电池语义相反（余量越低越危险），见 `batteryLevel`。
 */
function diskLevel(percent: number): Level {
  if (percent >= 95) return "crit";
  if (percent >= 85) return "warn";
  return "ok";
}

/** 充电中一律绿（正在补电），放电时按余量分档 —— 与磁盘"越高越危险"方向相反 */
function batteryLevel(percent: number, charging: boolean): Level {
  if (charging) return "ok";
  if (percent <= 20) return "crit";
  if (percent <= 40) return "warn";
  return "ok";
}

/** 平均主频 → "3.4 GHz" / "800 MHz"（后端给的是 MHz 数组） */
function formatCpuFreq(mhz: number[]): string {
  if (mhz.length === 0) return "";
  const avg = mhz.reduce((total, value) => total + value, 0) / mhz.length;
  return avg >= 1000 ? `${(avg / 1000).toFixed(1)} GHz` : `${Math.round(avg)} MHz`;
}

/** 去掉 formatBytes 单位前的空格（"10.2 GB" → "10.2GB"）：次要列只有 66px，数值口径不变 */
function compact(bytes: number): string {
  return formatBytes(bytes).replace(" ", "");
}

/**
 * 配置指纹：用来判断"这条广播是不是我自己发出去的回声"。
 *
 * ⚠️ 不要用 `JSON.stringify` 拼 —— 它依赖**键的书写顺序**，一旦某一侧的键序变了
 * （比如别处先构造 `{displayMode, intervalMs}` 再补齐 layout），同一份配置会得到不同
 * 字符串，回声就认不出来，于是又退化成"把中间态打回本地"。这里显式点名三个字段。
 */
function configStamp(config: SystemMonitorConfig): string {
  return `${config.intervalMs}:${config.displayMode}:${config.layout}`;
}

/** "2.4 MB/s" → { main: "2.4", unit: " MB/s" }：hero 区要把单位排小一号 */
function rateParts(rate: number): { main: string; unit: string } {
  const text = formatRate(rate);
  const space = text.indexOf(" ");
  return space < 0
    ? { main: text, unit: "" }
    : { main: text.slice(0, space), unit: text.slice(space) };
}

/** 各指标历史（环形缓冲） */
interface HistoryRefs {
  cpu: number[];
  mem: number[];
  gpu: number[];
  net: number[];
  diskio: number[];
}

/**
 * 把一帧 stats + 历史缓冲整理成各样式的公共视图模型。
 *
 * **这是唯一的格式化入口**：四套布局只负责摆位置，不再各算一遍数值 ——
 * 否则「同一台机器在不同样式下显示不同的数字」这类漂移极难发现。
 */
function buildView(stats: MonitorStats, history: HistoryRefs): MonitorView {
  const memPercent = stats.mem_total > 0 ? (stats.mem_used / stats.mem_total) * 100 : 0;
  const cpuPercent = Math.round(stats.cpu_usage_total);
  const coreCount = stats.cpu_usage_per_core.length;
  const cpuFreq = formatCpuFreq(stats.cpu_freq_mhz);
  const netRx = stats.net.reduce((total, item) => total + item.rx_rate, 0);
  const netTx = stats.net.reduce((total, item) => total + item.tx_rate, 0);
  const diskRead = stats.disk_io?.read_rate ?? 0;
  const diskWrite = stats.disk_io?.write_rate ?? 0;

  // 速率类没有"满"的概念：Y 轴取本窗口峰值（≥1KB/s 基线），电平条按峰值归一。
  // 峰值滚出窗口后曲线会重新铺满高度 —— 已知遗留，不在本轮处理范围。
  const rateScale = (data: number[]) => {
    const max = data.length > 0 ? Math.max(...data, 1024) : 1024;
    const latest = data.length > 0 ? data[data.length - 1] : 0;
    return { max, level: Math.round((latest / max) * 100) };
  };

  const metrics: MetricView[] = [
    {
      key: "cpu",
      label: "CPU",
      main: `${cpuPercent}`,
      unit: "%",
      tiny: [coreCount > 0 ? `${coreCount} 核` : "", cpuFreq].filter(Boolean).join(" · "),
      percent: cpuPercent,
      level: cpuPercent,
      history: history.cpu,
      max: 100,
      color: METRIC_COLOR.cpu,
    },
    {
      key: "mem",
      label: "内存",
      main: `${Math.round(memPercent)}`,
      unit: "%",
      tiny: `${compact(stats.mem_used)}/${compact(stats.mem_total)}`,
      percent: Math.round(memPercent),
      level: Math.round(memPercent),
      history: history.mem,
      max: 100,
      color: METRIC_COLOR.mem,
    },
  ];

  if (stats.gpu?.has_gpu) {
    metrics.push({
      key: "gpu",
      label: "GPU",
      main: `${Math.round(stats.gpu.usage)}`,
      unit: "%",
      tiny:
        stats.gpu.memory_total > 0
          ? `${compact(stats.gpu.memory_used)}/${compact(stats.gpu.memory_total)}`
          : `显存 ${compact(stats.gpu.memory_used)}`,
      percent: Math.round(stats.gpu.usage),
      level: Math.round(stats.gpu.usage),
      history: history.gpu,
      max: 100,
      color: METRIC_COLOR.gpu,
    });
  }

  // 网络 / 磁盘 I/O：主数值与折线同为「合计」（收+发 / 读+写），方向明细放次要列。
  // 次要列不带单位（"↓1.9 ↑0.5"）：66px 装不下 "↓1.9 ↑0.5 MB/s"（实测需 ≈86px），
  // 单位由主数值给出；混合单位时也能靠主数值判断量级。
  const netTotal = rateParts(netRx + netTx);
  const netScale = rateScale(history.net);
  metrics.push({
    key: "net",
    label: "网络",
    main: netTotal.main,
    unit: netTotal.unit,
    tiny: `↓${rateParts(netRx).main} ↑${rateParts(netTx).main}`,
    percent: null,
    level: netScale.level,
    history: history.net,
    max: netScale.max,
    color: METRIC_COLOR.net,
  });

  if (stats.disk_io) {
    const diskTotal = rateParts(diskRead + diskWrite);
    const diskScale = rateScale(history.diskio);
    metrics.push({
      key: "diskio",
      label: "磁盘 I/O",
      main: diskTotal.main,
      unit: diskTotal.unit,
      tiny: `读${rateParts(diskRead).main} 写${rateParts(diskWrite).main}`,
      percent: null,
      level: diskScale.level,
      history: history.diskio,
      max: diskScale.max,
      color: METRIC_COLOR.diskio,
    });
  }

  return {
    metrics,
    // 磁盘行不再带 "· SSD/HDD"：它是几乎不变的静态属性，却要在 278px 里跟
    // 「挂载点 + 占用条 + 容量」抢宽度（旧实现的容量文字因此常年被省略号吃掉）。
    disks: stats.disks.map((disk) => {
      const used = Math.max(0, disk.total - disk.available);
      const percent = disk.total > 0 ? (used / disk.total) * 100 : 0;
      return {
        mount: disk.mount_point,
        percent,
        text: `${formatBytes(used)} / ${formatBytes(disk.total)}`,
        level: diskLevel(percent),
      };
    }),
    battery: stats.battery?.has_battery
      ? {
          percent: stats.battery.percent,
          text: `${stats.battery.percent}%${stats.battery.charging ? " · 充电中" : " · 使用中"}`,
          level: batteryLevel(stats.battery.percent, stats.battery.charging),
        }
      : null,
    uptime: formatUptime(stats.uptime_secs),
  };
}

/**
 * 首帧占位视图（还没收到第一帧 stats 时用）。
 * 结构先就位、数值是 "--"，比"空卡片闪一下再长出内容"稳定；它不参与高度测量（量高依赖 stats）。
 */
const PLACEHOLDER_VIEW: MonitorView = {
  metrics: (["cpu", "mem", "net"] as const).map((key) => ({
    key,
    label: key === "cpu" ? "CPU" : key === "mem" ? "内存" : "网络",
    main: "--",
    unit: "",
    tiny: "",
    percent: null,
    level: 0,
    history: [],
    max: 100,
    color: METRIC_COLOR[key],
  })),
  disks: [],
  battery: null,
  uptime: "",
};

function SystemMonitor() {
  const [stats, setStats] = useState<MonitorStats | null>(null);
  const [config, setConfig] = useState<SystemMonitorConfig | null>(null);
  const [isControlsVisible, setIsControlsVisible] = useState(false);
  const configRef = useRef<SystemMonitorConfig | null>(null);
  const configVersionRef = useRef(0);

  const historyRef = useRef<HistoryRefs>({ cpu: [], mem: [], gpu: [], net: [], diskio: [] });
  const monitorBodyRef = useRef<HTMLDivElement>(null);
  /** 配置写入队列（串行落盘，见 applyConfig） */
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  /**
   * 本窗口**自己广播出去**的配置指纹。回声回收时用它精确跳过。
   *
   * 为什么不能只比较"是否等于当前值"：广播发生在**落盘成功之后**，所以连点样式按钮时
   * 第一条回声（b）到达时本地已经推进到 c —— 值不相等，于是被当成"别的窗口改的"照单全收，
   * 界面先跳回 b（连窗口尺寸都跟着重设一次）再被下一条拉回 c。
   * 只留最近几条：超过这个量的连点已属极端，而且下一条广播总会收敛。
   */
  const publishedRef = useRef<string[]>([]);

  /**
   * 配置的**唯一写入点**：ref 与 state 必须成对更新。
   * 项目约定（`MEMORY.md`）：同一份数据的 ref + state 双轨不得各写一半 —— 曾有过
   * "某条重置路径只写 state"，导致两处失同步、判断"值没变"时误跳过。
   * 当前只有三条路径会改配置：初次加载、本窗口操作（applyConfig）、别的窗口广播。
   * 三条都走这里，就不会再出现只更新一半的情况。
   */
  const commitConfig = (next: SystemMonitorConfig) => {
    configRef.current = next;
    setConfig(next);
  };

  // ⚠️ 窗口实例每次调用都返回新对象：必须 memo 成稳定引用，否则依赖它的 effect
  //（含下面的量高 → setSize）每次渲染都会重跑。守卫：src/test/windowInstanceGuard.test.ts
  const win = useMemo(() => getCurrentWebviewWindow(), []);

  const pushSample = (sample: MonitorStats) => {
    // 返回新数组（不可变），让 Sparkline/memo 的浅比较能检测到变化并重绘
    const push = (arr: number[], value: number): number[] => {
      const next = arr.length >= MONITOR_HISTORY_LEN ? arr.slice(1) : arr.slice();
      next.push(value);
      return next;
    };
    const history = historyRef.current;
    history.cpu = push(history.cpu, sample.cpu_usage_total);
    history.mem = push(
      history.mem,
      sample.mem_total > 0 ? (sample.mem_used / sample.mem_total) * 100 : 0,
    );
    history.gpu = push(history.gpu, sample.gpu?.usage ?? 0);
    history.net = push(
      history.net,
      sample.net.reduce((total, item) => total + item.rx_rate + item.tx_rate, 0),
    );
    history.diskio = push(
      history.diskio,
      sample.disk_io ? sample.disk_io.read_rate + sample.disk_io.write_rate : 0,
    );
  };

  const isMini = config?.displayMode === "mini";
  // 配置还没读回来时先按默认样式画（窗口通常在隐藏状态下挂载，用户看不到这一帧）
  const layout: SystemMonitorLayout = config?.layout ?? DEFAULT_SYSTEM_MONITOR_LAYOUT;

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
    const unlistenReadyRequest = listen("monitor-window-ready-request", () => {
      void emit("monitor-window-ready");
    });
    void emit("monitor-window-ready");
    return () => {
      unlistenReadyRequest.then((fn) => fn());
    };
  }, []);

  // 设置窗口的 localStorage 不应作为运行中跨窗口同步机制。
  useEffect(() => {
    const unlistenTheme = subscribeThemePreferences();
    return () => {
      unlistenTheme.then((fn) => fn()).catch(console.error);
    };
  }, []);

  /**
   * 立即把窗口摆到目标样式的大小（宽度精确、高度先用该样式的占位值），
   * 随后由下面的量高 effect 按真实内容贴齐。
   *
   * 为什么不能只靠量高 effect：它依赖 `stats`，而 stats 只在采样帧更新 —— 刷新间隔
   * 设成 5 秒时，"切了样式窗口却要等 5 秒才变"会很明显。宽度尤其不能等（只有双列宫格是 340）。
   */
  const applyWindowSize = (mode: SystemMonitorDisplayMode, target: SystemMonitorLayout) => {
    const size = mode === "mini" ? MONITOR_MINI_SIZE : monitorLayoutOption(target);
    win.setSize(new LogicalSize(size.width, size.placeholderHeight)).catch(console.error);
    // 尺寸是前端下发的，贴屏幕右/下沿时的窗口必须夹回工作区
    clampWindowToWorkArea(size.width, size.placeholderHeight);
  };

  const sizeKeyRef = useRef<string | null>(null);
  // 声明顺序有意义：先按占位尺寸摆好，紧随其后的量高 effect 再用实测高度覆盖它。
  useLayoutEffect(() => {
    if (!config) return;
    const key = `${config.displayMode}:${config.layout}`;
    if (sizeKeyRef.current === key) return;
    const isFirstSync = sizeKeyRef.current === null;
    sizeKeyRef.current = key;
    // 首次同步不做任何事：窗口在 show_monitor_window 里已按存储的样式摆好尺寸，
    // 这里再 setSize 只会白抖一下。之后的模式/样式变化都要立刻摆位。
    if (isFirstSync) return;
    applyWindowSize(config.displayMode, config.layout);
  }, [config]);

  /**
   * 窗口尺寸自适应：把 body 置为 height:auto 量一次自然高，再把宽高一起贴齐。
   *
   * 依赖 `stats`（而不是 `stats !== null`）：窗口复用后组件不重新挂载，仅凭「首次 stats」
   * 不会再次 fit；而采集线程只在窗口显示期间运行（hide 时 stop），每次重新打开后收到的
   * 第一条 stats 恰好代表「窗口重新显示」，此时重新测量即可覆盖后端 show 时设的初始尺寸。
   *
   * 宽度也在这里下发（各样式的窗口宽度不同，只有双列宫格是 340）。**这里不再依赖悬停状态**：
   * 旧实现的标题栏常态 max-height:0、悬停才展开 27px，而本 effect 依赖 isControlsVisible，
   * 于是鼠标一进窗口就 setSize 长高 43px（实测 579 → 622）。
   */
  useLayoutEffect(() => {
    const body = monitorBodyRef.current;
    if (!body || !stats) return;
    const previousHeight = body.style.height;
    body.style.height = "auto";
    const natural = body.offsetHeight;
    body.style.height = previousHeight;

    const height = Math.ceil(natural);
    const width = isMini ? MONITOR_MINI_SIZE.width : monitorLayoutOption(layout).width;
    // 与窗口当前尺寸比较（而不是上次 fit 的历史值）：窗口被外部重置后仅当不匹配才重新下发，
    // 匹配时天然防抖，不会每个采样周期都 setSize。
    if (Math.abs(window.innerHeight - height) < 1 && Math.abs(window.innerWidth - width) < 1) return;
    win.setSize(new LogicalSize(width, height)).catch(console.error);
    // 尺寸是前端量完内容才下发的，贴屏幕右/下沿时的窗口必须夹回工作区
    clampWindowToWorkArea(width, height);
  }, [win, isMini, layout, stats]);

  // 加载配置
  useEffect(() => {
    let cancelled = false;
    fetchSystemMonitorConfig().then((stored) => {
      if (!cancelled && configVersionRef.current === 0) {
        commitConfig(stored);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 订阅 monitor-stats。每个采样只触发一次渲染，避免重复刷新造成闪烁。
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let cancelled = false;
    listen<MonitorStats>("monitor-stats", (event) => {
      setStats(event.payload);
      pushSample(event.payload);
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
    };
  }, []);

  // Esc 关窗
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        invoke("hide_monitor_window").catch(console.error);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 记忆窗口位置：拖动结束后持久化，下次打开恢复上次位置
  useEffect(() => persistWindowPositionOnMove("monitor-overlay"), []);

  /**
   * 所有配置写入的唯一出口：乐观更新本窗口 → 串行落盘 → 广播给其它窗口。
   *
   * ⚠️ 保存必须**串行**：连点样式按钮（或快速"切样式 + 切迷你"）会在同一秒里发出多次
   * `set_system_monitor_config`，IPC 的**处理顺序不保证**，落盘的可能是前一次的值 ——
   * 重启后样式悄悄回退成上一套。队列保证"最后一次写入最后落盘"，与设置页的做法一致。
   */
  const applyConfig = (partial: Partial<SystemMonitorConfig>) => {
    const previous = configRef.current;
    if (!previous) return;
    const next = { ...previous, ...partial };
    commitConfig(next);
    const save = saveQueueRef.current
      .catch(() => undefined)
      .then(() => saveSystemMonitorConfig(next));
    saveQueueRef.current = save;
    void save
      .then(() => {
        // 先把指纹记进"自己发过"的名单**再**广播：回声可能同步回到本窗口的监听器，
        // 顺序反了就会漏掉这一条。
        const published = publishedRef.current;
        published.push(configStamp(next));
        if (published.length > 8) published.shift();
        // 后端只做持久化，不会 emit 事件；需自行广播，通知本窗口与设置窗刷新
        emit("levitaire-system-monitor-config-changed", next).catch(console.error);
      })
      .catch((error) => {
        console.error("Failed to save monitor config:", error);
        // 只有"这次写入仍是最新一次"才回滚，避免把用户随后改的字段一起打回去
        if (configRef.current === next) {
          commitConfig(previous);
          // 还要广播回滚：后端这次没写成功，磁盘上仍是 previous，别的窗口（设置页）手里
          // 不能留着这个没落盘的值 —— 否则它们下次整份回写时又会把它复活。
          // 与设置页在失败分支 emit(previous) 的做法一致（那边也不会再回弹成本窗口广播）。
          emit("levitaire-system-monitor-config-changed", previous).catch(console.error);
        }
      });
  };

  useEffect(() => {
    const unlisten = listen<SystemMonitorConfig>(
      "levitaire-system-monitor-config-changed",
      (event) => {
        // 广播是**跨窗口输入**，先归一化再用：设置页那边一直是这么做的，本窗口漏了。
        // 直接采信 `layout: "z"` 会让 `LAYOUT_COMPONENTS[layout]` 变成 undefined，
        // 渲染 `<undefined/>` 当场抛 "Element type is invalid" —— 整扇浮窗白屏，
        // 而且报错发生在事件回调里，排查时很难联想到是一条广播 payload 引起的。
        const incoming = normalizeSystemMonitorConfig(event.payload);
        // 自己发出去的回声直接跳过（值可能是**中间态**，见 publishedRef 的说明）
        const published = publishedRef.current;
        const echo = published.indexOf(configStamp(incoming));
        if (echo >= 0) {
          published.splice(echo, 1);
          return;
        }
        const current = configRef.current;
        // 其余情况：与本地相同则跳过（别把乐观写入再 setState 一遍）
        if (
          current &&
          current.intervalMs === incoming.intervalMs &&
          current.displayMode === incoming.displayMode &&
          current.layout === incoming.layout
        ) {
          return;
        }
        configVersionRef.current += 1;
        commitConfig(incoming);
      },
    );
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, []);

  // 视图模型只在采样帧重建（悬停等无关渲染不会重算）。历史数组在 pushSample 里同帧替换
  // 引用，所以这里读 ref.current 与 stats 属于同一条帧，不会错位。
  const view = useMemo<MonitorView>(
    () => (stats ? buildView(stats, historyRef.current) : PLACEHOLDER_VIEW),
    [stats],
  );

  const layoutOption = monitorLayoutOption(layout);
  const nextLayout = monitorLayoutOption(nextSystemMonitorLayout(layout));
  const CurrentLayout = isMini ? LayoutMini : LAYOUT_COMPONENTS[layout];

  return (
    <div className="monitor-container">
      <div
        ref={monitorBodyRef}
        className={`monitor-body${isMini ? " is-mini" : ` is-layout-${layout}`}${
          isControlsVisible ? " is-controls-visible" : ""
        }`}
        data-tauri-drag-region=""
        onMouseEnter={() => setIsControlsVisible(true)}
        onMouseLeave={() => setIsControlsVisible(false)}
        onFocusCapture={() => setIsControlsVisible(true)}
        onBlurCapture={(event) => {
          const nextFocus = event.relatedTarget;
          if (!(nextFocus instanceof Node) || !event.currentTarget.contains(nextFocus)) {
            setIsControlsVisible(false);
          }
        }}
      >
        <div className="monitor-head" data-tauri-drag-region="">
          <span className="monitor-title" data-tauri-drag-region="">
            系统监控
          </span>
          {/* 样式切换按钮常驻可见（按钮上写着当前样式名）。不跟着悬停出现/消失 ——
              否则用户得先想到"鼠标移上去"才能发现换样式的入口。 */}
          {!isMini && (
            <button
              type="button"
              className="monitor-style-btn"
              aria-label={`切换显示样式（当前：${layoutOption.label}）`}
              data-tooltip={`切换样式 → ${nextLayout.label}`}
              onClick={() => applyConfig({ layout: nextLayout.value })}
            >
              <Icon name="LayoutGrid" size={11} />
              {layoutOption.label}
            </button>
          )}
          <div className="monitor-actions">
            <button
              type="button"
              className="monitor-icon-btn"
              aria-label={isMini ? "切换到标准模式" : "切换到迷你模式"}
              data-tooltip={isMini ? "切换到标准模式" : "切换到迷你模式"}
              tabIndex={isControlsVisible ? 0 : -1}
              onClick={() => applyConfig({ displayMode: isMini ? "full" : "mini" })}
            >
              <Icon name={isMini ? "Maximize2" : "Minimize2"} size={14} />
            </button>
            <button
              type="button"
              className="monitor-icon-btn"
              aria-label="关闭系统监控"
              data-tooltip="关闭系统监控"
              tabIndex={isControlsVisible ? 0 : -1}
              onClick={() => invoke("hide_monitor_window").catch(console.error)}
            >
              <Icon name="X" size={14} />
            </button>
          </div>
        </div>

        <div className="monitor-content">
          <CurrentLayout view={view} />
        </div>
      </div>
    </div>
  );
}

export default SystemMonitor;
