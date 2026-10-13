/**
 * 系统清理面板的**真机渲染核对**页（临时工具，不参与产品构建）。
 *
 * 同 `system-monitor/__preview__` 的套路：Tauri 的 JS API 全部走
 * `window.__TAURI_INTERNALS__`，导入组件前把这个对象与
 * `__TAURI_EVENT_PLUGIN_INTERNALS__` 打桩，组件本身一行都不用改。
 *
 * 用法：
 *   npx vite --port 5199
 *   打开 http://localhost:5199/cleaner-preview.html?theme=dark
 *   ?panel=discover|quarantine|audit —— 挂载后自动展开对应折叠区
 *   ?probe=1 —— 在页面上打出实测信息，便于 grep
 */
import { createRoot } from "react-dom/client";
// ⚠️ 必须把仓库的全局样式一起加载：global.css 里有 reset 与 tokens.css。
// 漏了它，量出来的宽高是错的（子元素按 content-box 算）。
import "../../../styles/global.css";
import SystemCleanerTool from "../SystemCleanerTool";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";

localStorage.setItem("levitaire-theme", theme);
localStorage.setItem("levitaire-theme-accent", "blue");
localStorage.setItem("levitaire-theme-scheme", "cloud");

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

/* ── 与设计稿同源的确定性数据 ─────────────────────────────────── */

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const RULES = [
  {
    id: "temp-user",
    name: "用户临时文件",
    group: "cache",
    tier: "L1",
    requiresAdmin: false,
    defaultChecked: true,
    consequence: "只删除 7 天前、且当前未被占用的临时文件。",
    undo: "none",
    guard: [],
    strategy: { kind: "purgeContents", olderThanDays: 7 },
  },
  {
    id: "browser-cache",
    name: "浏览器缓存",
    group: "cache",
    tier: "L1",
    requiresAdmin: false,
    defaultChecked: true,
    consequence: "删除各浏览器的磁盘缓存，浏览器下次启动会重新.build。",
    undo: "none",
    guard: [],
    strategy: { kind: "purgeContents" },
  },
  {
    id: "thumb-cache",
    name: "缩略图缓存",
    group: "cache",
    tier: "L1",
    requiresAdmin: false,
    defaultChecked: true,
    consequence: "删除资源管理器缩略图缓存，首次打开文件夹会稍慢。",
    undo: "none",
    guard: [],
    strategy: { kind: "purgeContents" },
  },
  {
    id: "crash-dumps",
    name: "错误报告与崩溃转储",
    group: "system",
    tier: "L1",
    requiresAdmin: false,
    defaultChecked: true,
    consequence: "只删除 30 天前的崩溃转储与错误报告，事后排查需要重新复现。",
    undo: "none",
    guard: [],
    strategy: { kind: "purgeContents", olderThanDays: 30 },
  },
  {
    id: "recycle-bin",
    name: "回收站",
    group: "system",
    tier: "L1",
    requiresAdmin: false,
    defaultChecked: false,
    consequence: "永久删除所有固定磁盘回收站内的全部内容，不可撤销。",
    undo: "none",
    guard: [{ kind: "confirmUnrecoverable" }],
    strategy: { kind: "shellEmptyRecycleBin" },
  },
  {
    id: "update-cache",
    name: "Windows 更新缓存",
    group: "system",
    tier: "L2",
    requiresAdmin: true,
    defaultChecked: false,
    consequence: "删除已安装更新的安装源，回滚补丁需要重新下载。",
    undo: "none",
    guard: [],
    strategy: { kind: "purgeContents" },
  },
  {
    id: "defender-logs",
    name: "Defender 诊断日志",
    group: "system",
    tier: "L3",
    requiresAdmin: true,
    defaultChecked: false,
    consequence: "删除安全软件的诊断日志，影响事后排查。",
    undo: "none",
    guard: [],
    strategy: { kind: "purgeContents", olderThanDays: 30 },
  },
];

const VOLUMES = [
  { mountPoint: "C:\\", totalBytes: 400 * GB, freeBytes: 88 * GB, isSystem: true },
  { mountPoint: "D:\\", totalBytes: 2 * 1024 * GB, freeBytes: 400 * GB, isSystem: false },
];

const REPORTS = [
  { ruleId: "temp-user", ruleName: "用户临时文件", tier: "L1", status: "ok", targetDisplay: "%TEMP%", files: 1204, dirs: 36, bytesDeleted: 1.4 * GB, bytesQuarantined: 0, samplePaths: [] },
  { ruleId: "browser-cache", ruleName: "浏览器缓存", tier: "L1", status: "ok", targetDisplay: "各浏览器 Cache 目录", files: 8930, dirs: 120, bytesDeleted: 812 * MB, bytesQuarantined: 0, samplePaths: [] },
  { ruleId: "thumb-cache", ruleName: "缩略图缓存", tier: "L1", status: "ok", targetDisplay: "thumbcache_*.db", files: 8, dirs: 0, bytesDeleted: 156 * MB, bytesQuarantined: 0, samplePaths: [] },
  // 扫过但确实没东西可清：体积要显示成「0 B」，不能和"还没扫描"共用同一个符号。
  // 这一条必须挂在**会显示出来的规则**上（`requiresAdmin` 的行不进 clear 列表），
  // 否则夹具是死的、预览里根本看不到这个状态。条目全为 0，totals 不受影响。
  { ruleId: "crash-dumps", ruleName: "错误报告与崩溃转储", tier: "L1", status: "ok", targetDisplay: "错误报告目录（本机没有可清理的内容）", files: 0, dirs: 0, bytesDeleted: 0, bytesQuarantined: 0, samplePaths: [] },
];

const STATUS = {
  jobId: "job-preview-1",
  phase: "ready",
  dryRun: true,
  currentRule: null,
  progress: null,
  reports: REPORTS,
  totals: {
    files: 10142, dirs: 156, bytesDeleted: 2.3 * GB, quarantined: 2,
    bytesQuarantined: 0.9 * GB, skippedInUse: 3, skippedTooRecent: 11,
    readonlySkipped: 0, reparseSkipped: 2, vanished: 0, bytesVanished: 0, failures: 0,
  },
  advice: [
    { label: "页面文件 pagefile.sys", reason: "系统正在使用，删除会导致虚拟内存失效。" },
  ],
  ledger: {
    immediateBytes: 3.2 * GB - 0.9 * GB,
    pendingQuarantineBytes: 0.9 * GB,
    quarantineBytes: 1.1 * GB,
    quarantineUserDataBytes: 64 * MB,
    quarantineError: null,
    needsConfirmBytes: 620 * MB,
  },
  freeBefore: 85.2 * GB,
  freeAfter: null,
  discoveries: [],
  error: null,
  rulesError: null,
};

const QUARANTINE_LIST = [
  { id: "q-1", jobId: "job-0", seq: 1, originalPath: "D:\\OldProjects\\build_cache", size: 0.7 * GB, movedAt: "2026-10-06 14:20", source: "discovery", isUserData: false, isDir: true, partial: false },
  { id: "q-2", jobId: "job-0", seq: 2, originalPath: "C:\\Users\\me\\Downloads\\installer_tmp", size: 0.3 * GB, movedAt: "2026-10-06 14:22", source: "discovery", isUserData: true, isDir: true, partial: false },
  { id: "q-3", jobId: "job-0", seq: 3, originalPath: "C:\\ProgramData\\Package Cache\\stub", size: 0.1 * GB, movedAt: "2026-10-05 09:10", source: "discovery", isUserData: false, isDir: false, partial: true },
];

const internals: TauriInternals = {
  metadata: {
    currentWindow: { label: "system-cleaner-overlay" },
    currentWebview: { label: "system-cleaner-overlay" },
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
        // 与 monitor 预览同款：把 handler 登记进来，pushEvent 才能真正把事件送达组件
        const event = String(args?.event);
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(Number(args?.handler));
        return args?.handler ?? 0;
      }
      case "plugin:event|unlisten":
        listeners.get(String(args?.event))?.delete(Number(args?.eventId));
        return null;
      case "get_theme_preferences":
        // subscribeThemePreferences 会从后端读一次权威主题并重新 apply，
        // 必须回同一个人造主题，否则明暗两版渲染成一模一样。
        return { theme, accent: "blue", scheme: "cloud" };
      case "disk_cleanup_rules":
        return { rules: RULES, rulesError: null };
      case "disk_cleanup_volumes":
        return VOLUMES;
      case "get_system_cleaner_quarantine_days":
        return 7;
      case "disk_cleanup_quarantine_list":
        return QUARANTINE_LIST;
      case "disk_cleanup_quarantine_summary":
        return [1.1 * GB, 64 * MB];
      case "disk_cleanup_status":
        return STATUS;
      case "disk_cleanup_audit_list":
        return [];
      case "disk_cleanup_audit_read":
        return [];
      default:
        // discover/watch 的历史快照：预览页一律空着
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

/* ── 挂载 ───────────────────────────────────────────────────── */

const root = document.getElementById("root")!;
const holder = document.createElement("div");
holder.style.width = "420px";
holder.style.height = "460px";
root.appendChild(holder);

createRoot(holder).render(<SystemCleanerTool />);

/**
 * 等入场动画（cleaner-window-enter 180ms）走完再操作 ——
 * getBoundingClientRect 会把 scale 算进去；截图也等动画结束再拍。
 */
const SETTLE_MS = 500;

setTimeout(() => {
  // 事件监听是异步注册的；把快照再灌一遍，确保进度事件被收到
  pushEvent("disk-cleanup-status", STATUS);

  // ?panel=…：自动展开对应折叠区
  const panel = params.get("panel");
  if (panel === "discover" || panel === "quarantine" || panel === "audit") {
    const folds = Array.from(holder.querySelectorAll<HTMLButtonElement>(".cleaner-fold"));
    const target = folds.find((button) =>
      button.textContent?.includes(
        panel === "discover" ? "空间分析" : panel === "quarantine" ? "隔离区" : "审计日志",
      ),
    );
    target?.click();
  }

  setTimeout(() => {
    const body = holder.querySelector<HTMLElement>(".cleaner-body");
    document.documentElement.setAttribute(
      "data-heights",
      JSON.stringify({
        theme,
        resolvedTheme: document.documentElement.dataset.theme ?? "(none)",
        width: body?.offsetWidth ?? 0,
        height: body?.offsetHeight ?? 0,
        scroll: (() => {
          const scroll = holder.querySelector<HTMLElement>(".cleaner-scroll");
          if (!scroll) return null;
          return {
            overflowY: getComputedStyle(scroll).overflowY,
            scrollable: (() => {
              const before = scroll.scrollTop;
              scroll.scrollTop = 99999;
              const reached = scroll.scrollTop > 0;
              scroll.scrollTop = before;
              return reached;
            })(),
          };
        })(),
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
