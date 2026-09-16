/**
 * 系统监控浮窗的**真机渲染核对**页（临时工具，不参与产品构建）。
 *
 * 为什么要它：设计稿是手写的 mock，CSS 改了之后 mock 不会跟着变 —— 只有把**真实组件**
 * 放进真实浏览器渲染，量的高度、看的换行才是可信的。Tauri 的 JS API 全部走
 * `window.__TAURI_INTERNALS__`，所以只要在导入组件前把这个对象与
 * `__TAURI_EVENT_PLUGIN_INTERNALS__` 打桩，组件本身一行都不用改。
 *
 * 用法：
 *   npx vite --port 5199
 *   打开 http://localhost:5199/monitor-preview.html?layout=e&theme=dark
 *   （?probe=1 额外在页面上打出实测宽高，便于 grep）
 */
import { createRoot } from "react-dom/client";
// ⚠️ 必须把仓库的全局样式一起加载：`global.css` 里有 reset（`* { margin:0; padding:0;
// box-sizing:border-box; border:0 solid }`）和 tokens.css。漏了它，量出来的宽高是错的
// （子元素按 content-box 算），首帧尺寸也就跟着错。
import "../../../styles/global.css";
import SystemMonitor from "../SystemMonitor";
import { MONITOR_MINI_SIZE, monitorLayoutOption } from "../../../constants/systemMonitorConfig";
import type { SystemMonitorLayout } from "../../../constants/systemMonitorConfig";

/* ── Tauri IPC 打桩 ─────────────────────────────────────────── */

const params = new URLSearchParams(location.search);
// `mini` 不是 layout（mini 形态与样式无关），故先判掉再收窄类型
const layoutParam = params.get("layout") ?? "e";
const isMini = layoutParam === "mini";
const layout = (isMini ? "e" : layoutParam) as SystemMonitorLayout;
const theme = params.get("theme") === "light" ? "light" : "dark";

localStorage.setItem("levitaire-theme", theme);
localStorage.setItem("levitaire-theme-accent", "blue");
localStorage.setItem("levitaire-theme-scheme", "cloud");

const storedConfig = JSON.stringify({
  intervalMs: 1000,
  displayMode: isMini ? "mini" : "full",
  layout: isMini ? "e" : layout,
});

let seq = 0;
const callbacks = new Map<number, { fn: (event: unknown) => void; once: boolean }>();
const listeners = new Map<string, Set<number>>();

interface TauriInternals {
  metadata: { currentWindow: { label: string }; currentWebview: { label: string } };
  transformCallback: (callback: (event: unknown) => void, once?: boolean) => number;
  unregisterCallback: (id: number) => void;
  convertFileSrc: (path: string) => string;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

const internals: TauriInternals = {
  metadata: {
    currentWindow: { label: "monitor-overlay" },
    currentWebview: { label: "monitor-overlay" },
  },
  transformCallback(callback, once = false) {
    seq += 1;
    callbacks.set(seq, { fn: callback, once });
    return seq;
  },
  unregisterCallback(id) {
    callbacks.delete(id);
  },
  convertFileSrc: (path) => path,
  async invoke(cmd, args) {
    switch (cmd) {
      case "plugin:event|listen": {
        const event = String(args?.event);
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(Number(args?.handler));
        return args?.handler ?? 0;
      }
      case "plugin:event|unlisten":
        listeners.get(String(args?.event))?.delete(Number(args?.eventId));
        return null;
      case "get_system_monitor_config":
        return storedConfig;
      // subscribeThemePreferences 会**从后端**读一次权威主题并重新 apply，覆盖掉 localStorage。
      // 这里必须回同一个人造主题，否则深色会被后端的 light 覆盖（明暗两版渲染成一模一样）。
      case "get_theme_preferences":
        return { theme, accent: "blue", scheme: "cloud" };
      default:
        // hide_monitor_window / set_system_monitor_config / plugin:window|set_size …
        return null;
    }
  },
};

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = internals;
(window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener(event: string, id: number) {
    listeners.get(event)?.delete(id);
  },
};

function pushEvent(event: string, payload: unknown) {
  for (const id of listeners.get(event) ?? []) {
    const entry = callbacks.get(id);
    if (!entry) continue;
    entry.fn({ event, id, payload });
    if (entry.once) callbacks.delete(id);
  }
}

/* ── 与设计稿同源的确定性数据（曲线形状与已确认的 mock 一致） ── */

const SAMPLES = 60;
function series(seed: number, base: number, amp: number, lo: number, hi: number) {
  let state = seed >>> 0;
  let value = base;
  const out: number[] = [];
  const rnd = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let i = 0; i < SAMPLES; i += 1) {
    value += (rnd() - 0.5) * amp;
    value = Math.max(lo, Math.min(hi, value));
    out.push(value);
  }
  return out;
}

/**
 * ?huge=1：把速率放大到 GB/s 量级（1000 MB/s 级别），用来验"最坏取值"下
 * 数值列够不够宽、双列宫格会不会被撑破 —— 正常数据永远测不到这条路径。
 *
 * ?rateKBs=N：把收发/读写速率钉成固定值（KB/s），用于精确命中某个格式化结果。
 * `formatBytes` 会一直除到 < 1024，所以数值列的最坏文本是 **"1023 MB/s"（9 字符）**：
 * 取 rateKBs ≈ 1047850（合计 ≈ 1023.6 MB/s）就能复现。
 */
const HUGE = params.get("huge") === "1" ? 400 : 1;
const FIXED_RATE_KBS = Number(params.get("rateKBs") ?? 0);

const CPU = series(7, 34, 26, 4, 96);
const MEM = series(23, 62, 7, 20, 92);
const GPU = series(51, 47, 34, 2, 97);
const netSeries = series(88, 900, 1500, 40, 3000).map((v) => v * HUGE); // KB/s（收+发合计）
const diskSeries = series(131, 800, 1700, 20, 3400).map((v) => v * HUGE); // KB/s（读+写合计）
const NET = FIXED_RATE_KBS > 0 ? netSeries.map(() => FIXED_RATE_KBS) : netSeries;
const DISKIO = FIXED_RATE_KBS > 0 ? diskSeries.map(() => FIXED_RATE_KBS) : diskSeries;

const MEM_TOTAL = 16.4 * 1024 ** 3;
const DISK_TOTAL = 2 * 1024 ** 4;

function frameAt(index: number) {
  const readWrite = DISKIO[index];
  const rxTx = NET[index];
  return {
    timestamp_ms: index * 1000,
    interval_ms: 1000,
    uptime_secs: 3 * 86400 + 7 * 3600 + 42 * 60,
    cpu_usage_total: CPU[index],
    cpu_usage_per_core: Array.from({ length: 8 }, (_, core) => CPU[index] * (1 - core * 0.03)),
    cpu_freq_mhz: Array.from({ length: 8 }, () => 3400),
    mem_used: (MEM[index] / 100) * MEM_TOTAL,
    mem_total: MEM_TOTAL,
    mem_available: MEM_TOTAL * (1 - MEM[index] / 100),
    net: [{ name: "eth0", rx_rate: rxTx * 0.78 * 1024, tx_rate: rxTx * 0.22 * 1024 }],
    disks: [
      { mount_point: "C:\\", total: 1024 ** 4, available: 0.49 * 1024 ** 4, kind: "SSD" },
      { mount_point: "D:\\", total: DISK_TOTAL, available: 0.08 * DISK_TOTAL, kind: "HDD" },
    ],
    disk_io: { read_rate: readWrite * 0.78 * 1024, write_rate: readWrite * 0.22 * 1024 },
    gpu: { has_gpu: true, usage: GPU[index], memory_used: 3.1 * 1024 ** 3, memory_total: 8 * 1024 ** 3 },
    battery: { has_battery: true, percent: 78, charging: true },
  };
}

function pump() {
  for (let i = 0; i < SAMPLES; i += 1) pushEvent("monitor-stats", frameAt(i));
}

/* ── 挂载 ───────────────────────────────────────────────────── */

const size = isMini ? MONITOR_MINI_SIZE : monitorLayoutOption(layout);

const root = document.getElementById("root")!;
const holder = document.createElement("div");
holder.style.width = `${size.width}px`;
// ?forceHeight=N：把承载盒压到 N px（=.monitor-body 的 height:100% 变成 Npx），
// 用来验证「内容比窗口高时只出滚动条、不把行压扁」这条不变量。
const forceHeight = Number(params.get("forceHeight") ?? 0);
if (Number.isFinite(forceHeight) && forceHeight > 0) {
  holder.style.height = `${forceHeight}px`;
}
root.appendChild(holder);

// ?tooltip=1：强制展开悬停才出现的按钮与 CSS tooltip，用来验证浮层没被祖先裁掉
// （历史上被标题栏自己的 overflow:hidden 裁掉过 100%）。组件在预览页里渲染在**光 DOM**
// 里（不是 shadow root），所以普通全局样式就能覆盖。
if (params.get("tooltip") === "1") {
  const style = document.createElement("style");
  style.textContent = `
    .monitor-actions { opacity: 1 !important; pointer-events: auto !important; }
    .monitor-icon-btn[data-tooltip]::after,
    .monitor-style-btn[data-tooltip]::after { opacity: 1 !important; }
  `;
  document.head.appendChild(style);
}

createRoot(holder).render(<SystemMonitor />);

// 等配置/监听器注册完再灌数据，随后把实测尺寸暴露出来供脚本读取
/**
 * 等入场动画（`monitor-window-enter` 180ms，带 scale(0.99)）走完再量尺寸 ——
 * 否则 getBoundingClientRect 会把 scale 算进去（300 → 297、293 → 290），
 * 量出来的"自然高度"整体偏小 1%。
 */
const SETTLE_MS = 500;

setTimeout(() => {
  pump();
  setTimeout(() => {
    const body = holder.querySelector<HTMLElement>(".monitor-body");
    const content = holder.querySelector<HTMLElement>(".monitor-content");
    document.documentElement.setAttribute(
      "data-heights",
      JSON.stringify({
        label: isMini ? "mini" : layout,
        theme,
        // 用 offsetWidth/offsetHeight（布局盒，**不受 transform 影响**）而不是
        // getBoundingClientRect：入场动画的 scale(0.99) 会让后者量出 297×290 这种偏小 1% 的值。
        width: body?.offsetWidth ?? 0,
        height: body?.offsetHeight ?? 0,
        styleLabel: holder.querySelector(".monitor-style-btn")?.textContent ?? "(mini)",
        // 自检：主题真的生效了吗（否则明暗两版会渲染成一模一样）
        resolvedTheme: document.documentElement.dataset.theme ?? "(none)",
        cardBg: body ? getComputedStyle(body).backgroundColor : "(no body)",
        fg: body ? getComputedStyle(body).color : "(no body)",
        // 自检：盒子几何。内容比窗口宽时（列宽写死 + nowrap）会横向溢出被裁，
        // 光看 body 的 offsetWidth 发现不了 —— 必须比 scrollWidth 与窗口宽度。
        win: [window.innerWidth, window.innerHeight],
        holder: [holder.offsetWidth, holder.offsetHeight],
        container: holder.firstElementChild
          ? [(holder.firstElementChild as HTMLElement).offsetWidth, (holder.firstElementChild as HTMLElement).offsetHeight]
          : null,
        bodyLeft: body ? Math.round(body.getBoundingClientRect().left) : null,
        bodyScrollW: body?.scrollWidth ?? null,
        docScrollW: document.documentElement.scrollWidth,
        // 自检：把每行的"值 / 次要文本"原样带出来，核对格式与换行（截图里读小字容易看错）
        rows: Array.from(
          holder.querySelectorAll(".monitor-row, .monitor-trow, .monitor-irow"),
        ).map((row) => row.textContent),
        // 自检：内容溢出的处置 —— 溢出量（scrollHeight > clientHeight）本身不算数，
        // 必须同时 `overflow-y: auto` 且**真的能滚**（scrollTop 能被设上去）。
        // 窗口是无边框置顶窗、不能拉大，滚不动就等于那段内容永远看不到。
        contentOverflowY: content ? getComputedStyle(content).overflowY : null,
        contentScrollH: content?.scrollHeight ?? null,
        contentClientH: content?.clientHeight ?? null,
        contentScrollable: (() => {
          if (!content) return null;
          const before = content.scrollTop;
          content.scrollTop = 99999;
          const reached = content.scrollTop > 0;
          content.scrollTop = before;
          return reached;
        })(),
        firstRowH: holder.querySelector<HTMLElement>(".monitor-row, .monitor-trow")?.offsetHeight ?? null,
        // 自检：宫格是否被内容撑破（grid blowout）
        gridOverflow: (() => {
          const grid = holder.querySelector<HTMLElement>(".monitor-grid");
          return grid ? grid.scrollWidth - grid.clientWidth : null;
        })(),
        // 自检：数值列里文字有没有被截断（0 = 放得下；>0 = 触发了 ellipsis 兜底）
        valueOverflow: Array.from(
          holder.querySelectorAll<HTMLElement>(
            ".monitor-row-value, .monitor-trow-value, .monitor-irow-value, .monitor-mini-value",
          ),
        ).map((el) => el.scrollWidth - el.clientWidth),
        valueTexts: Array.from(
          holder.querySelectorAll<HTMLElement>(
            ".monitor-row-value, .monitor-trow-value, .monitor-irow-value, .monitor-mini-value",
          ),
        ).map((el) => el.textContent),
      }),
    );
    document.documentElement.setAttribute("data-ready", "1");
    if (params.get("probe") === "1") {
      const probe = document.createElement("div");
      probe.className = "probe";
      probe.textContent = document.documentElement.getAttribute("data-heights") ?? "";
      document.body.appendChild(probe);
    }
  }, SETTLE_MS);
}, SETTLE_MS);
