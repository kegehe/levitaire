import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../../styles/themePreferences";
import { persistWindowPositionOnMove } from "../../utils/windowPosition";
import Icon from "../../components/Icon";
import {
  CLEAN_TIER_META,
  CLEAN_TIER_ORDER,
  DEFAULT_QUARANTINE_RETENTION_DAYS,
  DISCOVERY_DEPTH_OPTIONS,
  QUARANTINE_RETENTION_OPTIONS,
  formatBytes,
  statusMeta,
  type CleanTier,
} from "../../constants/diskCleanupConfig";
import "./SystemCleanerTool.css";

/** 与 Rust 侧 `disk_cleanup::rules::CleanRule` 的 serde 形状对应。 */
interface CleanRule {
  id: string;
  name: string;
  group: "cache" | "system" | "user-adjacent";
  tier: CleanTier;
  requiresAdmin: boolean;
  defaultChecked: boolean;
  consequence: string;
  undo: "none" | "quarantine";
  /** `{ kind: "notInstalling" | "confirmUnrecoverable" }` */
  guard: Array<{ kind: string }>;
  strategy: { kind: string; olderThanDays?: number };
}

interface RuleReport {
  ruleId: string;
  ruleName: string;
  tier: CleanTier;
  status: string;
  targetDisplay: string;
  files: number;
  dirs: number;
  bytesDeleted: number;
  quarantined: number;
  bytesQuarantined: number;
  skippedInUse: number;
  skippedTooRecent: number;
  readonlySkipped: number;
  reparseSkipped: number;
  /** 枚举之后、删除之前已被别的进程删掉的条目。**不计进 bytesDeleted** */
  vanished: number;
  bytesVanished: number;
  failures: number;
  samplePaths: string[];
  error: string | null;
}

interface JobTotals {
  files: number;
  dirs: number;
  bytesDeleted: number;
  quarantined: number;
  bytesQuarantined: number;
  skippedInUse: number;
  skippedTooRecent: number;
  readonlySkipped: number;
  reparseSkipped: number;
  vanished: number;
  bytesVanished: number;
  failures: number;
}

/**
 * 「清理项」右侧的体积数字。
 *
 * **必须让"扫过了确实没东西"和"压根没扫"一眼可分**。`formatBytes` 对 0 返回「——」，
 * 而「——」在本工具里到处都表示"读不出来 / 不可知" —— 两种含义挤在同一个符号上，
 * 用户只能逐条点开详情才知道自己没扫过。所以这里改成：
 *   1. 没有 report → 这一项没有本轮扫描结果，写「未扫描」；
 *   2. `no-target` → 目标是空的（规则未命中），保留原有措辞「未安装」；
 *   3. 扫完且状态是 `ok`、产出为 0 → 明确写「0 B」，不再退回「——」。
 *
 * 非 `ok` 的状态（跳过 / 被拒 / 不适用 / 失败 / 取消）**不能跟 `ok` 一样写「0 B」**：
 * 取消与失败路径上的 stats 只统计到中断那一刻（见 `scan::run_rule`），那个 0 是
 * "没量到"，不是"没有"。真删掉了东西就照实显示 —— 宁可少报，不可多报。
 *
 * 「未扫描」和「0 B」会**同屏出现**：扫描只覆盖勾选项（`disk_cleanup_scan` 只收
 * `ruleIds`），所以标题写着"扫描完成"时，没勾上的那些行本来就没有本轮结果。
 */
function ruleSizeLabel(report: RuleReport | undefined): string {
  if (!report) return "未扫描";
  if (report.status === "no-target") return "未安装";
  const bytes = report.bytesDeleted + report.bytesQuarantined;
  if (bytes > 0) return formatBytes(bytes);
  return report.status === "ok" ? "0 B" : "——";
}

/**
 * 把「1.2 GB」拆成数值与单位两段。
 *
 * 编辑索引版的数字列用「大数值 + 小单位」排版：数值是行内第二重的字，
 * 单位退到辅助层级。`textContent` 必须与 `ruleSizeLabel` 完全一致
 * （守卫测试逐字比对「0 B」「未扫描」「——」），所以单位段自带前导空格。
 */
function ruleSizeParts(label: string): { n: string; u: string | null } {
  const index = label.lastIndexOf(" ");
  if (index > 0 && index < label.length - 1) {
    return { n: label.slice(0, index), u: label.slice(index + 1) };
  }
  return { n: label, u: null };
}

/**
 * 规则详情里的「目标」。
 *
 * 同样不能靠 `targetDisplay` 空不空来推断有没有扫过 —— 扫过但没命中目标
 * （未安装 / 被安全闸拒绝 / 本次跳过…）时它也是空的，此时退回「未扫描」就是说谎。
 */
function ruleTargetLabel(report: RuleReport | undefined): string {
  if (!report) return "未扫描";
  return report.targetDisplay || "本次没有可列出的目标";
}

/** 空间账目（§10.2）。**分栏**：隔离区的空间是延迟释放的，不能并进「可立即释放」。 */
interface Ledger {
  immediateBytes: number;
  pendingQuarantineBytes: number;
  quarantineBytes: number;
  quarantineUserDataBytes: number;
  /** 隔离区读不出来时的原因。**非空时上面两个数没有意义**，界面要说"读取失败"而不是 0 */
  quarantineError: string | null;
  needsConfirmBytes: number;
}

interface Advice {
  label: string;
  reason: string;
}

/** 后端签发的发现目标（§8.5）。前端只持有 id，**永远不回传 displayPath**。 */
interface DiscoveryEntry {
  id: string;
  displayPath: string;
  bytes: number;
  files: number;
  isUserData: boolean;
}

interface QuarantineEntry {
  id: string;
  jobId: string;
  seq: number;
  originalPath: string;
  size: number;
  movedAt: string;
  source: string;
  isUserData: boolean;
  isDir: boolean;
  /**
   * 跨卷搬运时"副本完整、但原位置还留着东西"（只读或占用的文件按纪律跳过）。
   *
   * 后端一直在写这个标记，而**全仓库没有任何地方读它** —— 设计里那句提醒
   * 从来没到达过用户，恢复时只会撞一句"原位置已被占用"。现在如实显示出来。
   */
  partial: boolean;
}

type CleanPhase = "idle" | "scanning" | "ready" | "cleaning" | "done" | "failed";

interface CleanStatus {
  jobId: string | null;
  phase: CleanPhase;
  dryRun: boolean;
  currentRule: string | null;
  progress: { done: number; total: number } | null;
  reports: RuleReport[];
  totals: JobTotals;
  advice: Advice[];
  ledger: Ledger;
  /** 任务开始/结束时系统卷的可用空间（§12.2 的"前后对照"） */
  freeBefore: number | null;
  freeAfter: number | null;
  discoveries: DiscoveryEntry[];
  error: string | null;
  rulesError: string | null;
}

interface RulesView {
  rules: CleanRule[];
  rulesError: string | null;
}

interface VolumeView {
  mountPoint: string;
  totalBytes: number;
  freeBytes: number;
  isSystem: boolean;
}

/** 占用发现的一个候选目录（§8）。**只有带 id 的才能清理**（I1）。 */
interface DiscoveredDir {
  /** 后端签发的 discovery_id。`null` = 这一条没能通过闸一，不能清理 */
  id: string | null;
  path: string;
  bytes: number;
  files: number;
  /** 相对基准快照的增量。`null` = 还没有历史可比，**不代表没有增长** */
  deltaBytes: number | null;
  deltaDays: number | null;
  isUserData: boolean;
  newestMtime: number;
}

interface DiscoveryStatus {
  jobId: string | null;
  phase: CleanPhase;
  volume: string | null;
  reportDepth: number;
  dirsVisited: number;
  current: string | null;
  unreadableDirs: number;
  entries: DiscoveredDir[];
  baselineAt: string | null;
  baselineDays: number | null;
  lastSnapshotAt: string | null;
  error: string | null;
}

/** 审计日志的明细行（与 Rust 侧 `audit::AuditLine` 对应）。 */
type AuditLine =
  | { kind: "header"; ts: string; jobId: string; ruleIds: string[] }
  | {
      kind: "entry";
      ts: string;
      ruleId: string;
      action: string;
      path: string;
      bytes: number;
      reason?: { kind: string; message?: string; code?: number };
    }
  | {
      kind: "summary";
      ts: string;
      jobId: string;
      totals: Record<string, number>;
      perRule: unknown[];
    };

interface AuditJobInfo {
  jobId: string;
  modifiedAt: string;
  sizeBytes: number;
}

/** 看门狗的一条告警（§11.1）：某个目录**同时**满足"够大"与"长得够快"。 */ interface WatchAlert {
  path: string;
  bytes: number;
  deltaBytes: number;
  deltaDays: number;
  discoveryId: string | null;
  isUserData: boolean;
}

interface WatchStatus {
  enabled: boolean;
  intervalHours: number;
  minBytes: number;
  minDeltaBytes: number;
  minAgeDays: number;
  targets: string[];
  lastRunAt: string | null;
  lastError: string | null;
  current: string | null;
  dirsVisited: number;
  alerts: WatchAlert[];
}

/** 放进隔离区的目标：手工挑选的发现目标与扫描结果共用这一个形状。 */
interface QuarantineCandidate {
  id: string;
  displayPath: string;
  isUserData: boolean;
}

const EMPTY_LEDGER: Ledger = {
  immediateBytes: 0,
  pendingQuarantineBytes: 0,
  quarantineBytes: 0,
  quarantineUserDataBytes: 0,
  quarantineError: null,
  needsConfirmBytes: 0,
};

function SystemCleanerTool() {
  // 本组件**刻意不取窗口实例**：面板尺寸固定且不随内容变化，也不主动 hide/destroy，
  // 因此不进 windowInstanceGuard 的清单。拖动由 header 上的 `data-tauri-drag-region`
  // 交给系统处理，无需 JS。哪天要加「按内容自适应高度」，就得先补 window 实例 + memo，
  // 再给每条 setSize 路径配上 clamp。
  const [rules, setRules] = useState<CleanRule[]>([]);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [status, setStatus] = useState<CleanStatus | null>(null);
  const [volumes, setVolumes] = useState<VolumeView[]>([]);
  const [quarantine, setQuarantine] = useState<QuarantineEntry[]>([]);
  /** 隔离区清单读不出来的原因。**读不到就说读不到**，不能让它看着像"隔离区是空的" */
  const [quarantineError, setQuarantineError] = useState<string | null>(null);
  const [retentionDays, setRetentionDays] = useState<number>(DEFAULT_QUARANTINE_RETENTION_DAYS);
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);
  /**
   * 有一次性操作（隔离/恢复/彻底删除/立即检查…）正在飞。
   *
   * 与 `phase` 分开：那些操作**不改变清理任务的阶段**，`busy` 因此看不到它们。
   * 没有这个的话按钮在请求飞行期间仍然可点，用户双击就会拿到后端的
   * "已有一个任务在进行中" —— 那不是出错，却被弹成红字。
   */
  const [actionBusy, setActionBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  /** 待确认的「不可恢复」操作：确认后才带 confirmedUnrecoverable 再发一次 */
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);
  const [pendingQuarantine, setPendingQuarantine] = useState<QuarantineCandidate | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryStatus | null>(null);
  const [watch, setWatch] = useState<WatchStatus | null>(null);
  // 审计日志（§12.2）：按需展开与拉取，不在挂载时就读一堆用户路径。
  // 三个高级分区（空间分析 / 隔离区 / 审计日志）共用一个手风琴状态，一次只摊开一个。
  const [openPanel, setOpenPanel] = useState<null | "discover" | "quarantine" | "audit">(null);
  const [auditJobs, setAuditJobs] = useState<AuditJobInfo[]>([]);
  const [auditJobId, setAuditJobId] = useState<string | null>(null);
  const [auditLines, setAuditLines] = useState<AuditLine[]>([]);
  const [auditFilter, setAuditFilter] = useState("");
  const [discoverVolume, setDiscoverVolume] = useState<string>("");
  const [discoverDepth, setDiscoverDepth] = useState<number>(4);

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
    const unlistenTheme = subscribeThemePreferences();
    return () => {
      unlistenTheme.then((fn) => fn()).catch(console.error);
    };
  }, []);

  useEffect(() => {
    const unlistenReadyRequest = listen("system-cleaner-window-ready-request", () => {
      void emit("system-cleaner-window-ready");
    });
    void emit("system-cleaner-window-ready");
    return () => {
      unlistenReadyRequest.then((fn) => fn());
    };
  }, []);

  useEffect(() => persistWindowPositionOnMove("system-cleaner-overlay"), []);

  const refreshQuarantine = useCallback(async () => {
    // ★ 读不到**不能静默降级**。原来整个 catch 是空的：隔离区读不出来时，
    //   列表看着是空的、账目还留着上一次的旧数字，用户会以为"隔离区里什么都没有"，
    //   而磁盘上可能躺着几个 GB 等着恢复或彻底删除。失败必须说出来。
    // ★ 两段**各自独立**地报告失败，第一段失败不能跳过第二段。
    //   `disk_cleanup_status` 给的是后端当前快照，而隔离区读不出来时那个快照里的
    //   账目是 0（`Ledger::default()`）—— "隔离区暂存 0 B" 正是这里最不该出现的东西。
    //   账目那一栏的"读取失败"标记就是靠第二段设上的，跳过它等于把读失败继续显示成 0。
    try {
      const list = await invoke<QuarantineEntry[]>("disk_cleanup_quarantine_list");
      setQuarantine(list);
      setQuarantineError(null);
    } catch (error) {
      setQuarantineError(String(error));
    }
    try {
      // 账目里"隔离区暂存"那一栏也要跟着变：否则用户把目录搬进隔离区之后，
      // 那个数字要等下一次状态事件才对得上。
      const [total, userData] = await invoke<[number, number]>("disk_cleanup_quarantine_summary");
      setStatus((previous) =>
        previous
          ? {
              ...previous,
              ledger: {
                ...previous.ledger,
                quarantineBytes: total,
                quarantineUserDataBytes: userData,
                quarantineError: null,
              },
            }
          : previous,
      );
    } catch (error) {
      setStatus((previous) =>
        previous
          ? {
              ...previous,
              ledger: { ...previous.ledger, quarantineError: String(error) },
            }
          : previous,
      );
    }
  }, []);

  // 规则表、磁盘总览、隔离区、保留期：挂载时各拉一次
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const view = await invoke<RulesView>("disk_cleanup_rules");
        if (cancelled) return;
        setRules(view.rules);
        setRulesError(view.rulesError);
        // 默认勾选与后端规则表一致：不可逆（L3）、需要管理员、以及回收站这类带
        // 「需确认」护栏的项，一律不默认勾选
        setSelected(
          view.rules
            .filter(
              (rule) =>
                rule.defaultChecked &&
                !rule.requiresAdmin &&
                !rule.guard.some((guard) => guard.kind === "confirmUnrecoverable"),
            )
            .map((rule) => rule.id),
        );
      } catch (error) {
        if (!cancelled) setRulesError(String(error));
      }
      try {
        const list = await invoke<VolumeView[]>("disk_cleanup_volumes");
        if (!cancelled) {
          setVolumes(list);
          // 默认选系统盘：绝大多数人的问题都在那儿
          const preferred = list.find((volume) => volume.isSystem) ?? list[0];
          if (preferred) setDiscoverVolume((current) => current || preferred.mountPoint);
        }
      } catch {
        // 总览拉不到不影响清理，静默降级为不显示
      }
      try {
        const days = await invoke<number>("get_system_cleaner_quarantine_days");
        if (!cancelled) setRetentionDays(days);
      } catch {
        // 用默认值
      }
      try {
        const seen = await invoke<DiscoveryStatus>("disk_cleanup_discover_status");
        if (!cancelled) setDiscovery(seen);
      } catch {
        // 没有上一轮结果就空着
      }
      try {
        const seen = await invoke<WatchStatus>("disk_cleanup_watch_status");
        if (!cancelled) setWatch(seen);
      } catch {
        // 看门狗没启用时也可能读不到，空着即可
      }
      try {
        // 主动拉一次当前状态：不能只靠事件 —— webview 重新加载（或窗口被重建）时
        // 上一份快照不会重放，那样「空间账目」「不建议清理」会是空的。
        const current = await invoke<CleanStatus>("disk_cleanup_status");
        if (!cancelled) {
          setStatus(current);
          if (current.phase === "ready") setScanned(true);
        }
      } catch {
        // 拉不到就等下一次事件
      }
      await refreshQuarantine();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshQuarantine]);

  // 进度：单一事件 + 全量快照（后端只发这一条）
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    listen<CleanStatus>("disk-cleanup-status", (event) => {
      setStatus(event.payload);
      if (event.payload.phase === "ready") setScanned(true);
    }).then((fn) => {
      if (cancelled) fn();
      else un = fn;
    });
    return () => {
      cancelled = true;
      if (un) un();
    };
  }, []);

  // 占用发现的进度走自己的事件（它是只读的长任务，与清理的进度不是一回事）
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    listen<DiscoveryStatus>("disk-cleanup-discovery", (event) => {
      setDiscovery(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else un = fn;
    });
    return () => {
      cancelled = true;
      if (un) un();
    };
  }, []);

  // 看门狗的告警走第三条事件：它由后台周期任务产生，与用户发起的任何操作都无关
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    listen<WatchStatus>("disk-cleanup-watchdog", (event) => {
      setWatch(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else un = fn;
    });
    return () => {
      cancelled = true;
      if (un) un();
    };
  }, []);

  const phase: CleanPhase = status?.phase ?? "idle";
  const discoveryPhase: CleanPhase = discovery?.phase ?? "idle";
  const busy =
    actionBusy || phase === "scanning" || phase === "cleaning" || discoveryPhase === "scanning";

  /** 增长榜：只列真的在长的，按增量降序 */
  const growthBoard = useMemo(
    () =>
      (discovery?.entries ?? [])
        .filter((entry) => (entry.deltaBytes ?? 0) > 0)
        .sort((a, b) => (b.deltaBytes ?? 0) - (a.deltaBytes ?? 0)),
    [discovery],
  );
  /** 占用榜：按绝对大小降序 */
  const sizeBoard = useMemo(
    () => [...(discovery?.entries ?? [])].sort((a, b) => b.bytes - a.bytes),
    [discovery],
  );

  const runScan = useCallback(async () => {
    setActionError(null);
    // ★ 必须置 actionBusy：后端 `start()` 在把 phase 改成 scanning **之前**要先
    //   遍历一遍隔离区目录树算账目，隔离区大时是秒级。那段窗口里 `busy` 仍然是
    //   false，按钮照常可点 —— 用户连点两下就会拿到"已有一个任务在进行中"的红字，
    //   而那根本不是出错。
    setActionBusy(true);
    try {
      const snapshot = await invoke<CleanStatus>("disk_cleanup_scan", { ruleIds: selected });
      setStatus(snapshot);
    } catch (error) {
      setActionError(String(error));
    } finally {
      setActionBusy(false);
    }
  }, [selected]);

  const doQuarantine = useCallback(
    async (entry: QuarantineCandidate, confirmUserData: boolean) => {
      setActionBusy(true);
      try {
        await invoke("disk_cleanup_quarantine_discovery", {
          discoveryId: entry.id,
          confirmUserData,
        });
        setPendingQuarantine(null);
        await refreshQuarantine();
      } catch (error) {
        // 后端把「落在用户数据目录里」当成错误返回。它是**最终裁决**：前端对
        // `isUserData` 的判断可能已经过时（签发之后目标被换成别处）。这里把它
        // 转成确认条，而不是当失败弹红字 —— 用户要的是"确认一下"，不是"出错了"。
        const message = String(error);
        if (!confirmUserData && message.includes("落在用户数据目录之内")) {
          setPendingQuarantine(entry);
          return;
        }
        setActionError(message);
      } finally {
        setActionBusy(false);
      }
    },
    [refreshQuarantine],
  );

  const runClean = useCallback(
    async (confirmedUnrecoverable: boolean) => {
      setActionError(null);
      setActionBusy(true);
      try {
        const snapshot = await invoke<CleanStatus>("disk_cleanup_start", {
          ruleIds: selected,
          confirmedUnrecoverable,
        });
        setStatus(snapshot);
        setPendingConfirm(null);
        void refreshQuarantine();
      } catch (error) {
        // 后端把「需要确认」当成错误返回；这里把它转成确认条，而不是当失败弹红字。
        // 注意确认动作本身仍由后端裁决 —— 前端只是把话转述给用户。
        const message = String(error);
        if (!confirmedUnrecoverable && message.includes("需要你确认")) {
          setPendingConfirm(message);
          return;
        }
        setActionError(message);
      } finally {
        setActionBusy(false);
      }
    },
    [selected, refreshQuarantine],
  );

  const cancel = useCallback(async () => {
    try {
      await invoke<boolean>("disk_cleanup_cancel");
    } catch (error) {
      setActionError(String(error));
    }
  }, []);

  const pickDirectory = useCallback(async () => {
    setActionError(null);
    // ★ 必须置 actionBusy：后端签发前要**递归 stat 整棵树**（几十万文件的目录是秒级，
    //   见 `issue_discovery`）。那段窗口里 `busy` 仍是 false、按钮照常可点 ——
    //   用户只会以为"点了没反应"，再点一下就是第二次全树遍历。同 `runScan` 的理由。
    setActionBusy(true);
    try {
      // 只**签发**一个发现目标，不搬运：目录会出现在下面的列表里等用户确认。
      // 方案 §8.5 要求「删除必须用户显式确认」，悄悄搬走不算确认。
      await invoke<DiscoveryEntry | null>("disk_cleanup_pick_directory");
      // 列表由后端 publish 的状态事件刷新（见 show/issue 的 publish 调用）
    } catch (error) {
      setActionError(String(error));
    } finally {
      setActionBusy(false);
    }
  }, []);

  /** 放弃一个已挑选、但还没决定处理的目录。 */
  const forgetDiscovery = useCallback(async (discoveryId: string) => {
    setActionError(null);
    try {
      await invoke("disk_cleanup_forget_discovery", { discoveryId });
    } catch (error) {
      setActionError(String(error));
    }
  }, []);

  const startDiscovery = useCallback(async () => {
    setActionError(null);
    setActionBusy(true);
    try {
      const snapshot = await invoke<DiscoveryStatus>("disk_cleanup_discover_start", {
        volume: discoverVolume,
        reportDepth: discoverDepth,
      });
      setDiscovery(snapshot);
    } catch (error) {
      setActionError(String(error));
    } finally {
      setActionBusy(false);
    }
  }, [discoverVolume, discoverDepth]);

  const cancelDiscovery = useCallback(async () => {
    try {
      await invoke<boolean>("disk_cleanup_discover_cancel");
    } catch (error) {
      setActionError(String(error));
    }
  }, []);

  const restoreEntry = useCallback(
    async (entryId: string) => {
      setActionError(null);
      setActionBusy(true);
      try {
        await invoke("disk_cleanup_quarantine_restore", { entryId });
      } catch (error) {
        setActionError(String(error));
      } finally {
        setActionBusy(false);
        // ★ 放在 finally：后端支持**部分成功**（内容已恢复、但清单没写完就报错），
        //   只在成功分支刷新的话，界面会一直留着那些其实已经不在隔离区里的条目。
        await refreshQuarantine();
      }
    },
    [refreshQuarantine],
  );

  const purgeEntry = useCallback(
    async (entryId: string) => {
      setActionError(null);
      setActionBusy(true);
      try {
        await invoke("disk_cleanup_quarantine_purge", { entryId });
      } catch (error) {
        setActionError(String(error));
      } finally {
        setActionBusy(false);
        // 同上：`purge` 可能已经删掉了内容才报错，界面必须重读
        await refreshQuarantine();
      }
    },
    [refreshQuarantine],
  );

  const purgeAll = useCallback(async () => {
    setActionError(null);
    setActionBusy(true);
    try {
      await invoke<number>("disk_cleanup_quarantine_purge_all");
    } catch (error) {
      setActionError(String(error));
    } finally {
      setActionBusy(false);
      // `purge_all` 会"删掉一部分之后仍然返回 Err"，所以失败路径更需要重读
      await refreshQuarantine();
    }
  }, [refreshQuarantine]);

  /** 展开审计日志时拉一次任务列表。 */
  const loadAuditJobs = useCallback(async () => {
    try {
      const jobs = await invoke<AuditJobInfo[]>("disk_cleanup_audit_list");
      setAuditJobs(jobs);
      // 默认打开最近一次
      const newest = jobs[0]?.jobId ?? null;
      setAuditJobId(newest);
      if (newest) {
        setAuditLines(await invoke<AuditLine[]>("disk_cleanup_audit_read", { jobId: newest }));
      } else {
        setAuditLines([]);
      }
    } catch (error) {
      setActionError(String(error));
    }
  }, []);

  const selectAuditJob = useCallback(async (jobId: string) => {
    setAuditJobId(jobId);
    try {
      setAuditLines(await invoke<AuditLine[]>("disk_cleanup_audit_read", { jobId }));
    } catch (error) {
      setActionError(String(error));
    }
  }, []);

  const exportAudit = useCallback(async () => {
    if (!auditJobId) return;
    try {
      await invoke("disk_cleanup_audit_export", { jobId: auditJobId });
    } catch (error) {
      setActionError(String(error));
    }
  }, [auditJobId]);

  const changeRetention = useCallback(async (days: number) => {
    setActionError(null);
    try {
      await invoke("set_system_cleaner_quarantine_days", { days });
      setRetentionDays(days);
    } catch (error) {
      setActionError(String(error));
    }
  }, []);

  /**
   * 勾选一变，就把「不可恢复」确认条作废。
   *
   * 确认条上那句话是后端**针对当时那份清单**说的，而「确认执行」发出去的是**此刻**的
   * `selected`（见 `runClean`）。不作废的话就能绕过"清理前必须看到会删哪些东西"：
   * 确认条挂在那儿时再勾上一个从没扫描过的项，点「确认执行」照样把它删掉 ——
   * 界面上从没展示过它会删掉什么，主按钮那边的拦截等于白设。
   */
  const toggle = useCallback((id: string) => {
    setPendingConfirm(null);
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  }, []);

  /**
   * 「全选 / 全不选」。
   *
   * ★ 与 `toggle` 同一个理由：**必须作废确认条**。确认条上那句话是后端针对"当时那份
   *   清单"说的，而「确认执行」发出去的是此刻的 `selected`。全选比单项更危险 ——
   *   它一次性把从没扫描过的项也带上，不作废就等于借那条确认把没预览过的项删掉。
   *
   * ★ 范围是**面板里列出的全部项**（非管理员项），包含带 `confirmUnrecoverable`
   *   护栏的回收站：按钮写着「全选」就该选全部，少勾一项会让 `n/N 项` 对不上，
   *   用户只能读成"按钮坏了"。不可逆的那道闸不在这里 —— 它由后端在 `start` 时裁决，
   *   界面上还有一次独立确认（见 `runClean`），全选本身不会删掉任何东西。
   *
   *   这里用 `rules.filter(!requiresAdmin)` 而不是 `visibleRules`：两者是**同一个集合**
   *   （校验器要求非 L1 必须带 `requiresAdmin`，见 `rules.rs` 的 `TierAuthMismatch`，
   *   因此本节里的 `rules` 不含渲染不出来的项），写在 `visibleRules` 之前是为了避开
   *   TDZ —— 依赖数组在渲染期求值，那时 `visibleRules` 还没初始化。
   *
   * ★ 勾选状态用函数式更新取：这里要判断"是否已经全选"来决定翻面方向，而 `selected`
   *   可能是上一次渲染的值。
   */
  const toggleAll = useCallback(() => {
    setPendingConfirm(null);
    setSelected((previous) => {
      const ids = rules.filter((rule) => !rule.requiresAdmin).map((rule) => rule.id);
      return ids.length > 0 && ids.every((id) => previous.includes(id)) ? [] : ids;
    });
  }, [rules]);

  /** 发现结果的一行。「放入隔离区」只在后端签发了 id 时可用 —— 没有 id 就没有清理入口。 */
  const renderDiscovered = (entry: DiscoveredDir) => (
    <div key={entry.path} className="cleaner-quarantine-row">
      <div className="cleaner-quarantine-path">
        {entry.path}
        {entry.isUserData && <span className="cleaner-tag-warn">用户数据</span>}
      </div>
      <div className="cleaner-muted">
        {formatBytes(entry.bytes)} · {entry.files} 个文件
        {entry.deltaBytes !== null &&
          entry.deltaDays !== null &&
          entry.deltaBytes > 0 &&
          ` · ${entry.deltaDays} 天内 +${formatBytes(entry.deltaBytes)}`}
      </div>
      <div className="cleaner-quarantine-actions">
        <button
          type="button"
          className="cleaner-btn"
          disabled={busy || !entry.id}
          title={
            entry.id ? undefined : "这一条没能通过安全闸（红线 / 非固定卷 / 被重定向），不能清理"
          }
          onClick={() => {
            if (!entry.id) return;
            const candidate: QuarantineCandidate = {
              id: entry.id,
              displayPath: entry.path,
              isUserData: entry.isUserData,
            };
            if (candidate.isUserData) setPendingQuarantine(candidate);
            else void doQuarantine(candidate, false);
          }}
        >
          放入隔离区
        </button>
      </div>
    </div>
  );

  const byTier = useMemo(() => {
    const map = new Map<CleanTier, CleanRule[]>();
    for (const rule of rules) {
      const list = map.get(rule.tier) ?? [];
      list.push(rule);
      map.set(rule.tier, list);
    }
    return map;
  }, [rules]);

  const reportById = useMemo(() => {
    const map = new Map<string, RuleReport>();
    for (const report of status?.reports ?? []) map.set(report.ruleId, report);
    return map;
  }, [status]);

  /** 审计明细里的删除/跳过/失败条目（表头与汇总行不在这里展示），按筛选词过滤。 */
  const auditFiltered = useMemo<AuditEntryLine[]>(() => {
    const entries = auditLines.filter((line): line is AuditEntryLine => line.kind === "entry");
    const needle = auditFilter.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter(
      (line) =>
        line.path.toLowerCase().includes(needle) || line.ruleId.toLowerCase().includes(needle),
    );
  }, [auditLines, auditFilter]);

  const ledger = status?.ledger ?? EMPTY_LEDGER;
  const hasResult = scanned && (status?.reports.length ?? 0) > 0;
  const selectedRules = rules.filter((rule) => selected.includes(rule.id));
  /**
   * 勾了、但最近一次扫描结果里没有的项。
   *
   * ★ 判据是**这一项有没有本轮报告**，不是"扫过没有"（`scanned` 只是个布尔）。
   *   扫描只覆盖那一次勾选的项（`disk_cleanup_scan` 只收 `ruleIds`），所以
   *   "先扫 A、再勾上从没扫过的 B"完全可能：此时 B 没有报告，界面从没展示过它
   *   会删掉什么，可按钮却亮着 —— 一点下去 B 就被真的删了，正好和按钮自己那句
   *   "清理前必须看到会删哪些东西"相反。
   */
  const unscannedSelected = selectedRules.filter((rule) => !reportById.has(rule.id));
  /** 「清理所选项目」的可用条件：当前勾选项**全部**在最近一次扫描结果里。 */
  const canClean = selectedRules.length > 0 && unscannedSelected.length === 0;
  /** 不可用时说清卡在哪一步；可用时不显示 title。 */
  const cleanBlockedTitle = !selectedRules.length
    ? undefined
    : (status?.reports.length ?? 0) === 0
      ? "请先扫描一次：清理前必须看到会删哪些东西"
      : `还没有扫描结果：${unscannedSelected
          .map((rule) => rule.name)
          .join("、")}。勾着它们重扫一次，先看清会删掉哪些东西`;
  /**
   * footer 中间那句「为什么现在不能清理」。
   *
   * ★ **必须是可见文本，不能只挂在按钮的 `title` 上**：`disabled` 的按钮在
   *   Chromium（含 Tauri 的 WebView2）下收不到鼠标事件，title 永远弹不出来 ——
   *   用户只会看到一个莫名变灰的按钮。面板宽 420px，这里就短说；具体是哪几项
   *   交给 `cleanBlockedTitle` 与行内的「未扫描」。
   */
  const footerHint = (() => {
    if (selectedRules.length === 0) {
      return rules.some((rule) => rule.requiresAdmin)
        ? "当前版本只能执行用户级清理项"
        : "请先勾选清理项";
    }
    if (canClean) return null;
    return (status?.reports.length ?? 0) === 0
      ? "请先扫描一次：看清会删哪些东西"
      : `还有 ${unscannedSelected.length} 项未扫描：重扫一次即可清理`;
  })();
  /**
   * 确认条上的说明：有任务在跑时不能确认（后端重入闸门会直接拒），**先把话说在前面**，
   * 而不是让用户点完收到一句红字。
   */
  const confirmBusyNote = busy ? "当前有任务在进行中：等它结束再确认。" : null;
  const selectableCount = rules.filter((rule) => !rule.requiresAdmin).length;
  const discoveries = status?.discoveries ?? [];

  // 三格统计头的第三格：系统盘（没有系统盘就退回第一个卷，再没有就显示 ——）
  const systemVolume = useMemo(
    () => volumes.find((volume) => volume.isSystem) ?? volumes[0] ?? null,
    [volumes],
  );
  // totalBytes 为 0（或读出脏数据）时除法会得 NaN，width:"NaN%" 是非法样式 —— 按不可知处理
  const systemUsedPct =
    systemVolume && systemVolume.totalBytes > 0
      ? Math.min(
          100,
          Math.max(
            0,
            Math.round(
              ((systemVolume.totalBytes - systemVolume.freeBytes) / systemVolume.totalBytes) * 100,
            ),
          ),
        )
      : 0;
  /**
   * 构成条的切片：与 headline **同源**，统计上一轮扫描 / 清理的报告。
   *
   * headline 的 ledger.immediateBytes 是上一轮任务的 totals.bytes_deleted（dry-run
   * 时是预估）。如果这里按当前 selected 现算，扫描后取消勾选就会出现「2.3 GB 的标题
   * 下面只剩 200 MB 的条」—— 用户会以为剩下的空间凭空消失了。
   *
   * 所以：
   * - 只统计 bytesDeleted（隔离量不算「立即释放」，见 §10.2）；
   * - 取前 4 项 + 「其他 N 项」，保证条的总量始终等于 headline；
   * - hasResult 为假时整条隐藏，构成卡退化为纯账目行。
   */
  const composeSegments = useMemo(() => {
    if (!hasResult) return [];
    const reported = (status?.reports ?? [])
      .map((report) => ({
        id: report.ruleId,
        name: report.ruleName,
        bytes: report.bytesDeleted,
      }))
      .filter((segment) => segment.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes);
    if (reported.length <= 4) return reported;
    const rest = reported.slice(4);
    return [
      ...reported.slice(0, 4),
      {
        id: "__rest__",
        name: `其他 ${rest.length} 项`,
        bytes: rest.reduce((sum, segment) => sum + segment.bytes, 0),
      },
    ];
  }, [hasResult, status]);
  /**
   * 管理员项完全不进主视图（勾了也执行不了，展示了只是噪音）；
   * 执行摘要只在清理完成的那一刻出现（§12.2 的前后对照），平时不占一行。
   */
  const visibleRules = CLEAN_TIER_ORDER.flatMap((tier) => byTier.get(tier) ?? []).filter(
    (rule) => !rule.requiresAdmin,
  );
  /**
   * 面板里列出的项是否**全部**勾着 —— 决定标题行上那个按钮是「全选」还是「全不选」。
   *
   * 判据跟着 `visibleRules`（用户实际看到、能点的那几行）走，不跟着 `rules` 走：
   * 管理员项被过滤掉了，若把它们算进来，"全不选"会永远触发不了。
   */
  const allSelected =
    visibleRules.length > 0 && visibleRules.every((rule) => selected.includes(rule.id));
  const resultSummary = (() => {
    if (!hasResult || !status || status.phase !== "done") return null;
    const bits: string[] = [];
    if (status.totals.skippedInUse > 0) bits.push(`跳过占用文件 ${status.totals.skippedInUse} 个`);
    if (status.totals.quarantined > 0) bits.push(`移入隔离区 ${status.totals.quarantined} 个`);
    // "已经不在了"单列，**不加进"已释放"**：目标达成了，但这份空间是别的进程释放的。
    // 混进去，用户对不上磁盘多出来的空间。
    if (status.totals.vanished > 0)
      bits.push(`已被别的程序删掉 ${status.totals.vanished} 个（未计入释放量）`);
    if (status.totals.failures > 0) bits.push(`失败 ${status.totals.failures} 个`);
    if (status.freeBefore != null && status.freeAfter != null)
      bits.push(`系统卷可用 ${formatBytes(status.freeBefore)} → ${formatBytes(status.freeAfter)}`);
    if (bits.length === 0) return "本次执行完成";
    return `本次执行：${bits.join(" · ")}`;
  })();

  return (
    <div className="cleaner-container">
      <div className="cleaner-body">
        <header className="cleaner-header" data-tauri-drag-region="">
          <span className="cleaner-title" data-tauri-drag-region="">
            系统清理
          </span>
          <span className="cleaner-phase" data-tauri-drag-region="">
            {phaseLabel(phase)}
          </span>
          {/* 窗口是无边框的（`decorations: false`），没有系统标题栏 ——
              关闭入口必须自己给。与 monitor / timer 同一形态：调 hide 命令，
              窗口只是藏起来（后端注册的关闭拦截也是 hide 而不是销毁）。 */}
          <button
            type="button"
            className="cleaner-icon-btn"
            aria-label="关闭系统清理"
            title="关闭"
            onClick={() => void invoke("hide_system_cleaner_window").catch(console.error)}
          >
            <Icon name="X" size={14} />
          </button>
        </header>

        <div className="cleaner-scroll">
          {loading ? (
            <div className="cleaner-empty">正在读取清理项…</div>
          ) : rulesError ? (
            <div className="cleaner-blocked">
              <div className="cleaner-blocked-title">清理功能不可用</div>
              <p className="cleaner-blocked-reason">{rulesError}</p>
              <p className="cleaner-blocked-note">
                规则表没有通过校验，因此<b>不会执行任何删除</b>
                。这是故障保护：宁可功能不可用，也不在规则不可信的情况下动文件。
              </p>
            </div>
          ) : (
            <>
              {/* ── 构成卡（布局 E「编辑索引」）：结论数字当主角，
                  右侧两行账目（§10.2 分栏保留：隔离区单独一行），
                  有扫描结果时下面跟着构成条与图例 ── */}
              <section className="cleaner-compose">
                <div className="cleaner-compose-main">
                  <div className="cleaner-compose-num">
                    {formatBytes(ledger.immediateBytes)}
                  </div>
                  <div className="cleaner-compose-cap">可立即释放</div>
                </div>
                <div className="cleaner-compose-side">
                  <div className="cleaner-compose-row">
                    <span>隔离区暂存</span>
                    {/* 读不出来时**显示"读取失败"，不显示 0** —— 0 会被读成
                        "隔离区是空的"，而磁盘上可能躺着几个 GB */}
                    {ledger.quarantineError ? (
                      <b className="cleaner-danger" title={ledger.quarantineError}>
                        读取失败
                      </b>
                    ) : (
                      <b>{formatBytes(ledger.quarantineBytes)}</b>
                    )}
                  </div>
                  <div className="cleaner-compose-row">
                    {systemVolume ? (
                      <>
                        <span>{`${systemVolume.mountPoint} 可用`}</span>
                        <b>{formatBytes(systemVolume.freeBytes)}</b>
                        <span className="cleaner-compose-pct">已用 {systemUsedPct}%</span>
                      </>
                    ) : (
                      // 读不到卷信息时不能写「磁盘信息 ——」：这与本文件「读不到就说
                      // 读不到、不伪装成空/0」的规矩相反（对照隔离区那一行）。
                      <span>未能读取磁盘信息</span>
                    )}
                  </div>
                </div>
                {composeSegments.length > 0 && (
                  <div className="cleaner-compose-bar" aria-hidden="true">
                    {composeSegments.map((segment) => (
                      <i key={segment.id} style={{ flex: `${segment.bytes} 1 0%` }} />
                    ))}
                  </div>
                )}
                {composeSegments.length > 0 && (
                  <div className="cleaner-compose-legend">
                    {composeSegments.map((segment) => (
                      <span key={segment.id} className="cleaner-compose-li">
                        <i aria-hidden="true" />
                        <span className="cleaner-compose-nm">{segment.name}</span>
                        <b>{formatBytes(segment.bytes)}</b>
                      </span>
                    ))}
                  </div>
                )}
              </section>

              <section className="cleaner-section cleaner-rules">
                <div className="cleaner-section-title">
                  清理项
                  <span className="cleaner-estimate">
                    {selected.length}/{selectableCount} 项
                  </span>
                  {/* 一次性勾选/取消全部：规则表有十来条，逐条点是十几下。
                      文案随状态翻面，所以它永远说清"点下去会发生什么"。 */}
                  <button
                    type="button"
                    className="cleaner-select-all"
                    disabled={busy || visibleRules.length === 0}
                    title={
                      allSelected
                        ? "取消勾选全部清理项"
                        : `勾选全部 ${visibleRules.length} 项。含标着「需确认」的项 —— 它们执行前仍会单独问你一次`
                    }
                    onClick={toggleAll}
                  >
                    {allSelected ? "全不选" : "全选"}
                  </button>
                </div>
                {visibleRules.map((rule) => {
                  const report = reportById.get(rule.id);
                  const meta2 = statusMeta(report?.status ?? "ok");
                  const isOpen = expanded === rule.id;
                  const needsConfirm = rule.guard.some(
                    (guard) => guard.kind === "confirmUnrecoverable",
                  );
                  const tierMeta = CLEAN_TIER_META[rule.tier];
                  const sizeLabel = ruleSizeLabel(report);
                  const sizeParts = ruleSizeParts(sizeLabel);
                  const sizeTone = !report
                    ? " is-unscanned"
                    : report.status === "no-target"
                      ? " is-na"
                      : sizeLabel === "——"
                        ? " is-unknown"
                        : "";
                  return (
                    <div
                      key={rule.id}
                      className={`cleaner-rule${selected.includes(rule.id) ? " is-checked" : ""}`}
                    >
                      <label className="cleaner-rule-head">
                        <input
                          type="checkbox"
                          checked={selected.includes(rule.id)}
                          disabled={busy}
                          onChange={() => toggle(rule.id)}
                        />
                        <span className="cleaner-rule-lead" aria-hidden="true" />
                        <span className="cleaner-rule-name">{rule.name}</span>
                        {rule.tier !== "L1" && (
                          <span
                            className={`cleaner-tier cleaner-tier-${rule.tier.toLowerCase()}`}
                            title={`${tierMeta.label} · ${tierMeta.hint}`}
                          >
                            {rule.tier === "L2" ? "谨慎" : "专家"}
                          </span>
                        )}
                        {needsConfirm && <span className="cleaner-tag-warn">需确认</span>}
                        <span className="cleaner-rule-dots" aria-hidden="true" />
                        <span
                          className={`cleaner-rule-size${sizeTone}`}
                          title={
                            report
                              ? undefined
                              : "这一项没有扫描结果（扫描只覆盖勾选项）：勾上它重新扫一次，才知道能清出多少"
                          }
                        >
                          <span className="cleaner-rule-size-n">{sizeParts.n}</span>
                          {sizeParts.u && (
                            <span className="cleaner-rule-size-u"> {sizeParts.u}</span>
                          )}
                        </span>
                        <button
                          type="button"
                          className="cleaner-info"
                          aria-expanded={isOpen}
                          title="查看这一项会删掉什么"
                          onClick={() => setExpanded(isOpen ? null : rule.id)}
                        >
                          ⓘ
                        </button>
                      </label>
                      {report && report.status !== "ok" && (
                        <div className={`cleaner-rule-status cleaner-${meta2.tone}`}>
                          {meta2.label}
                          {report.error ? `：${report.error}` : ""}
                        </div>
                      )}
                      {report && report.status === "ok" && report.error && (
                        <div className="cleaner-rule-status cleaner-warn">{report.error}</div>
                      )}
                      {isOpen && (
                        <div className="cleaner-rule-detail">
                          <p className="cleaner-consequence">{rule.consequence}</p>
                          <p className="cleaner-muted">目标：{ruleTargetLabel(report)}</p>
                          <p className="cleaner-muted">
                            {rule.strategy.olderThanDays
                              ? `仅清理 ${rule.strategy.olderThanDays} 天前的条目`
                              : "不设保留期"}
                            {rule.undo === "quarantine" ? " · 可隔离恢复" : " · 永久删除"}
                          </p>
                          {report && report.samplePaths.length > 0 && (
                            <div className="cleaner-samples">
                              <div className="cleaner-muted">
                                抽样（{report.files} 个文件 / {report.dirs} 个目录）：
                              </div>
                              {report.samplePaths.map((sample) => (
                                <div key={sample} className="cleaner-sample">
                                  {sample}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {resultSummary && (
                  <div className="cleaner-adm">{resultSummary}</div>
                )}
              </section>

              {/* ── 高级分区：手风琴折叠，一次只摊开一个 ─────────────────── */}
              <button
                type="button"
                className="cleaner-fold"
                aria-expanded={openPanel === "discover"}
                onClick={() => setOpenPanel(openPanel === "discover" ? null : "discover")}
              >
                <span className="cleaner-fold-nm">空间分析</span>
                <span className="cleaner-fold-sub">占用发现 · 失控告警 · 不建议清理</span>
                <span className="cleaner-fold-chev" aria-hidden="true">›</span>
              </button>
              {openPanel === "discover" && (
              <div className="cleaner-fold-content">

              {/* ── 占用发现 ───────────────────────────────── */}
              <section className="cleaner-section">
                <div className="cleaner-section-title">
                  占用发现
                  <span className="cleaner-estimate">
                    {discovery?.lastSnapshotAt
                      ? `上次快照 ${shortTime(discovery.lastSnapshotAt)}`
                      : "还没有快照"}
                  </span>
                </div>
                <p className="cleaner-muted cleaner-advice-intro">
                  扫一遍整个卷，把「大」和「在长」分开报出来。<b>只读</b>
                  {"，不删任何东西；看中的目录只能放进隔离区（可恢复），不会被永久删除。"}
                </p>

                <div className="cleaner-quarantine-bar">
                  <label className="cleaner-inline">
                    <span className="cleaner-muted">卷</span>
                    <select
                      value={discoverVolume}
                      onChange={(event) => setDiscoverVolume(event.target.value)}
                      className="cleaner-select"
                    >
                      {volumes.map((volume) => (
                        <option key={volume.mountPoint} value={volume.mountPoint}>
                          {volume.mountPoint}
                          {volume.isSystem ? "（系统盘）" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="cleaner-inline">
                    <span className="cleaner-muted">报告深度</span>
                    <select
                      value={discoverDepth}
                      onChange={(event) => setDiscoverDepth(Number(event.target.value))}
                      className="cleaner-select"
                    >
                      {DISCOVERY_DEPTH_OPTIONS.map((depth) => (
                        <option key={depth} value={depth}>
                          {depth} 层
                        </option>
                      ))}
                    </select>
                  </label>
                  {discoveryPhase === "scanning" ? (
                    <button
                      type="button"
                      className="cleaner-btn"
                      onClick={() => void cancelDiscovery()}
                    >
                      取消扫描
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="cleaner-btn"
                      disabled={!discoverVolume || busy}
                      onClick={() => void startDiscovery()}
                    >
                      开始扫描
                    </button>
                  )}
                </div>

                {discoveryPhase === "scanning" && (
                  <div className="cleaner-muted">
                    已访问 {discovery?.dirsVisited ?? 0} 个目录
                    {discovery?.current ? ` · ${discovery.current}` : ""}
                    <br />
                    扫完整个卷可能要几分钟。期间不会抢磁盘（后台优先级），可以随时取消。
                  </div>
                )}

                {discovery?.error && (
                  <div className="cleaner-rule-status cleaner-warn">{discovery.error}</div>
                )}

                {discovery && discovery.phase === "done" && (
                  <>
                    <div className="cleaner-muted">
                      {discovery.baselineAt && discovery.baselineDays !== null
                        ? `增量基准：${shortTime(discovery.baselineAt)}（${discovery.baselineDays} 天前）`
                        : "还没有更早的快照，因此没有增量数据 —— 这不代表没有问题"}
                      {discovery.unreadableDirs > 0 &&
                        ` · ${discovery.unreadableDirs} 个目录读不到，未计入统计`}
                    </div>

                    {growthBoard.length > 0 && (
                      <>
                        <div className="cleaner-group-head">
                          <span className="cleaner-tier cleaner-tier-l2">在增长</span>
                          <span className="cleaner-muted">正在失控的，优先看这一栏</span>
                        </div>
                        {growthBoard.slice(0, 20).map(renderDiscovered)}
                      </>
                    )}

                    {sizeBoard.length > 0 && (
                      <>
                        <div className="cleaner-group-head">
                          <span className="cleaner-tier cleaner-tier-l1">占用最大</span>
                          <span className="cleaner-muted">大不等于有问题，但值得看一眼</span>
                        </div>
                        {sizeBoard.slice(0, 20).map(renderDiscovered)}
                      </>
                    )}

                    {discovery.entries.length === 0 && (
                      <div className="cleaner-muted">没有发现值得注意的目录。</div>
                    )}
                  </>
                )}
              </section>

              {/* ── 看门狗告警 ───────────────────────────────── */}
              {/* ★ 上一轮失败也要报出来。原来整个分区只在「有告警」时才渲染，
                  于是一次失败（目标卷解析不出来、盘读不到…）的表现是**这个分区根本不出现**，
                  用户把它读成"没问题"。失败与"没发现问题"必须长得不一样。 */}
              {watch && watch.lastError && (
                <section className="cleaner-section">
                  <div className="cleaner-section-title">失控告警</div>
                  <div className="cleaner-danger">
                    最近一次检查没能完成：{watch.lastError}
                  </div>
                  <div className="cleaner-muted">
                    这不代表没有目录在变大 —— 只代表这一轮没查出来，下一轮会重试。
                  </div>
                </section>
              )}

              {watch && !watch.lastError && watch.alerts.length > 0 && (
                <section className="cleaner-section">
                  <div className="cleaner-section-title">
                    失控告警
                    <span className="cleaner-estimate">
                      {watch.lastRunAt ? `检查于 ${shortTime(watch.lastRunAt)}` : "最近一次检查"}
                    </span>
                  </div>
                  <p className="cleaner-muted cleaner-advice-intro">
                    这些目录<b>同时</b>满足「超过 {formatBytes(watch.minBytes)}」与「
                    {watch.minAgeDays} 天内增长超过 {formatBytes(watch.minDeltaBytes)}」
                    {"。一直很大但没变的不算问题，所以这里只列正在失控的。"}
                  </p>
                  {watch.alerts.map((alert) => (
                    <div key={alert.path} className="cleaner-quarantine-row">
                      <div className="cleaner-quarantine-path">
                        {alert.path}
                        {alert.isUserData && <span className="cleaner-tag-warn">用户数据</span>}
                      </div>
                      <div className="cleaner-muted">
                        {formatBytes(alert.bytes)} · {alert.deltaDays} 天内 +
                        {formatBytes(alert.deltaBytes)}
                      </div>
                      <div className="cleaner-quarantine-actions">
                        <button
                          type="button"
                          className="cleaner-btn"
                          disabled={busy || !alert.discoveryId}
                          title={alert.discoveryId ? undefined : "这一条没能通过安全闸，不能清理"}
                          onClick={() => {
                            if (!alert.discoveryId) return;
                            const candidate: QuarantineCandidate = {
                              id: alert.discoveryId,
                              displayPath: alert.path,
                              isUserData: alert.isUserData,
                            };
                            if (candidate.isUserData) setPendingQuarantine(candidate);
                            else void doQuarantine(candidate, false);
                          }}
                        >
                          放入隔离区
                        </button>
                      </div>
                    </div>
                  ))}
                </section>
              )}

              </div>
              )}

              {/* ── 隔离区折叠区 ───────────────────────────────────────── */}
              <button
                type="button"
                className="cleaner-fold"
                aria-expanded={openPanel === "quarantine"}
                onClick={() => setOpenPanel(openPanel === "quarantine" ? null : "quarantine")}
              >
                <span className="cleaner-fold-nm">隔离区</span>
                <span className="cleaner-fold-badge">
                  {quarantineError
                    ? "读取失败"
                    : `${quarantine.length} 条 · ${formatBytes(ledger.quarantineBytes)}`}
                </span>
                <span className="cleaner-fold-chev" aria-hidden="true">›</span>
              </button>
              {openPanel === "quarantine" && (
              <div className="cleaner-fold-content">
              <section className="cleaner-section">
                <p className="cleaner-muted cleaner-advice-intro">
                  搬进隔离区的内容还在磁盘上，可以随时恢复；保留期到期后才真正释放，因此
                  <strong>不计入「可立即释放」</strong>。
                </p>
                {/* 账目的两条细分（§10.2）只在隔离区分区里有意义，不占主视图 */}
                {ledger.pendingQuarantineBytes > 0 && (
                  <div className="cleaner-muted cleaner-ledger-line">
                    本次清理将新增到隔离区：{formatBytes(ledger.pendingQuarantineBytes)}
                  </div>
                )}
                {ledger.quarantineUserDataBytes > 0 && (
                  <div className="cleaner-muted cleaner-ledger-line">
                    其中属于用户数据，不会被自动删除：{formatBytes(ledger.quarantineUserDataBytes)}
                  </div>
                )}

                <div className="cleaner-quarantine-bar">
                  <label className="cleaner-inline">
                    <span className="cleaner-muted">保留期</span>
                    <select
                      value={retentionDays}
                      onChange={(event) => void changeRetention(Number(event.target.value))}
                      className="cleaner-select"
                    >
                      {QUARANTINE_RETENTION_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="cleaner-btn"
                    disabled={busy}
                    onClick={() => void pickDirectory()}
                  >
                    添加目录…
                  </button>
                  {quarantine.length > 0 && (
                    <button
                      type="button"
                      className="cleaner-btn cleaner-btn-danger"
                      disabled={busy}
                      onClick={() => void purgeAll()}
                    >
                      清空隔离区
                    </button>
                  )}
                </div>

                {discoveries.map((entry) => (
                  <div key={entry.id} className="cleaner-quarantine-row">
                    <div className="cleaner-quarantine-path">
                      {entry.displayPath}
                      {entry.isUserData && <span className="cleaner-tag-warn">用户数据</span>}
                    </div>
                    <div className="cleaner-muted">
                      {formatBytes(entry.bytes)} · {entry.files} 个文件 · 不在规则库中，只有你能判断
                    </div>
                    <div className="cleaner-quarantine-actions">
                      <button
                        type="button"
                        className="cleaner-btn"
                        disabled={busy}
                        onClick={() => {
                          // ★ 这里原来传的是 `entry.isUserData` 当确认位 —— 等于
                          //   "是用户数据就自动算已确认"，把后端那道二次确认整个绕过去。
                          //   与另外两处入口保持一致：先挂起，由用户点确认。
                          const candidate: QuarantineCandidate = {
                            id: entry.id,
                            displayPath: entry.displayPath,
                            isUserData: entry.isUserData,
                          };
                          if (candidate.isUserData) setPendingQuarantine(candidate);
                          else void doQuarantine(candidate, false);
                        }}
                      >
                        放入隔离区
                      </button>
                      <button
                        type="button"
                        className="cleaner-btn"
                        disabled={busy}
                        onClick={() => void forgetDiscovery(entry.id)}
                      >
                        取消选择
                      </button>
                    </div>
                  </div>
                ))}

                {/* ★ 读不到清单时说"读不到"，不能说"是空的" ——
                    后者会让用户以为隔离区里什么都没有，而磁盘上可能躺着几个 GB
                    等着恢复或彻底删除。 */}
                {quarantineError ? (
                  <div className="cleaner-muted cleaner-danger">
                    隔离区清单读取失败，下面显示的内容可能已经过时：{quarantineError}
                  </div>
                ) : quarantine.length === 0 && discoveries.length === 0 ? (
                  <div className="cleaner-muted">
                    隔离区是空的。用「添加目录…」可以把规则库没覆盖到的目录先搬进来再决定 ——
                    这类目录只能隔离，不会被永久删除。
                  </div>
                ) : (
                  quarantine.slice(0, 20).map((entry) => (
                    <div key={entry.id} className="cleaner-quarantine-row">
                      <div className="cleaner-quarantine-path">
                        {entry.originalPath}
                        {entry.isUserData && <span className="cleaner-tag-warn">用户数据</span>}
                        {entry.partial && <span className="cleaner-tag-warn">原位置未清空</span>}
                      </div>
                      <div className="cleaner-muted">
                        {formatBytes(entry.size)} · {entry.movedAt}
                      </div>
                      {/* ★ 跨卷搬运时"副本完整、但原位置还留着东西"（只读/占用的文件
                          按纪律跳过）。不提示的话，用户点「恢复」只会撞一句
                          "原位置已被占用"，完全看不出是上一次搬运留下的。 */}
                      {entry.partial && (
                        <div className="cleaner-muted cleaner-warn">
                          {"搬进隔离区时原位置没能清干净（那里还有只读或被占用的文件）。" +
                            '恢复之前请先手动处理它们，否则恢复会被"原位置已被占用"挡住。'}
                        </div>
                      )}
                      <div className="cleaner-quarantine-actions">
                        <button
                          type="button"
                          className="cleaner-btn"
                          disabled={busy}
                          onClick={() => void restoreEntry(entry.id)}
                        >
                          恢复
                        </button>
                        <button
                          type="button"
                          className="cleaner-btn cleaner-btn-danger"
                          disabled={busy}
                          onClick={() => void purgeEntry(entry.id)}
                        >
                          彻底删除
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </section>

              {(status?.advice.length ?? 0) > 0 && (
                <section className="cleaner-section">
                  <div className="cleaner-section-title">不建议清理</div>
                  <p className="cleaner-muted cleaner-advice-intro">
                    下面这些目录看起来很大，但删了会出问题。这里只说明原因，不给清理入口。
                  </p>
                  {status?.advice.map((item) => (
                    <div key={item.label} className="cleaner-advice">
                      <div className="cleaner-advice-label">{item.label}</div>
                      <div className="cleaner-muted">{item.reason}</div>
                    </div>
                  ))}
                </section>
              )}
              </div>
              )}

              {/* ── 审计日志折叠区：刻意放在规则表加载失败的分支之外 ——
                  规则表坏掉时用户更需要看到"上一次到底删了什么"。 ── */}
              <button
                type="button"
                className="cleaner-fold"
                aria-expanded={openPanel === "audit"}
                onClick={() => {
                  const next = openPanel !== "audit";
                  setOpenPanel(next ? "audit" : null);
                  if (next) void loadAuditJobs();
                }}
              >
                <span className="cleaner-fold-nm">审计日志</span>
                <span className="cleaner-fold-sub">只存本机，绝不上传</span>
                <span className="cleaner-fold-chev" aria-hidden="true">›</span>
              </button>
              {openPanel === "audit" && (
                <div className="cleaner-fold-content">
                  <AuditSection
                    jobs={auditJobs}
                    jobId={auditJobId}
                    lines={auditFiltered}
                    filter={auditFilter}
                    onSelectJob={(id) => void selectAuditJob(id)}
                    onFilter={setAuditFilter}
                    onExport={() => void exportAudit()}
                  />
                </div>
              )}
            </>
          )}

          {pendingQuarantine && (
            <div className="cleaner-confirm">
              <div className="cleaner-confirm-title">这是用户数据目录</div>
              <p>{pendingQuarantine.displayPath}</p>
              <p className="cleaner-muted">
                它落在你的用户数据目录之内。本工具不会永久删除它，但搬进隔离区同样会改变它的位置 ——
                请确认这确实是你想清理的东西。
              </p>
              {confirmBusyNote && <p className="cleaner-muted">{confirmBusyNote}</p>}
              <div className="cleaner-confirm-actions">
                <button
                  type="button"
                  className="cleaner-btn"
                  onClick={() => setPendingQuarantine(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="cleaner-btn cleaner-btn-primary"
                  disabled={busy}
                  onClick={() => void doQuarantine(pendingQuarantine, true)}
                >
                  确认放入隔离区
                </button>
              </div>
            </div>
          )}

          {pendingConfirm && (
            <div className="cleaner-confirm cleaner-confirm-danger">
              <div className="cleaner-confirm-title">内容不可恢复</div>
              <p>{pendingConfirm}</p>
              <p className="cleaner-muted">
                这些内容不会被放进隔离区，删掉之后无法通过本工具找回。
              </p>
              {confirmBusyNote && <p className="cleaner-muted">{confirmBusyNote}</p>}
              <div className="cleaner-confirm-actions">
                <button
                  type="button"
                  className="cleaner-btn"
                  onClick={() => setPendingConfirm(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="cleaner-btn cleaner-btn-primary"
                  disabled={busy}
                  onClick={() => void runClean(true)}
                >
                  确认执行
                </button>
              </div>
            </div>
          )}

          {(actionError || status?.error) && (
            <div className="cleaner-alert">{actionError ?? status?.error}</div>
          )}
        </div>

        <footer className="cleaner-footer">
          {busy ? (
            <>
              <span className="cleaner-muted">
                {phase === "scanning" ? "正在扫描" : "正在清理"}
                {status?.progress ? ` ${status.progress.done}/${status.progress.total}` : ""}
                {status?.currentRule ? ` · ${status.currentRule}` : ""}
              </span>
              <button type="button" className="cleaner-btn" onClick={() => void cancel()}>
                取消
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="cleaner-btn"
                disabled={selected.length === 0}
                onClick={() => void runScan()}
              >
                重新扫描
              </button>
              {footerHint && <span className="cleaner-muted">{footerHint}</span>}
              <button
                type="button"
                className="cleaner-btn cleaner-btn-primary"
                disabled={!canClean}
                title={cleanBlockedTitle}
                onClick={() => void runClean(false)}
              >
                清理所选项目
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

/** 审计明细里的一次动作。 */
type AuditEntryLine = Extract<AuditLine, { kind: "entry" }>;

/** 一次最多列这么多条：审计日志可能有几万条，全渲染会把面板拖死。 */
const AUDIT_ROWS_MAX = 200;

const AUDIT_ACTION_LABELS: Record<string, string> = {
  deleted: "已删除",
  quarantined: "已隔离",
  skipped: "已跳过",
  "readonly-skipped": "只读跳过",
  failed: "失败",
  "reparse-skipped": "链接",
  vanished: "已被别处删除",
};

function auditTone(action: string): "ok" | "warn" | "danger" {
  if (action === "deleted" || action === "quarantined") return "ok";
  if (action === "failed") return "danger";
  return "warn";
}

interface AuditSectionProps {
  jobs: AuditJobInfo[];
  jobId: string | null;
  lines: AuditEntryLine[];
  filter: string;
  onSelectJob: (jobId: string) => void;
  onFilter: (text: string) => void;
  onExport: () => void;
}

/**
 * 审计日志分区的内容（I8 / §12）。
 *
 * 外层的折叠行（展开即拉取任务列表）由主组件承担 —— 折叠行刻意**放在规则表
 * 加载失败的分支之外**：规则表坏掉时用户更需要看到"上一次到底删了什么"，
 * 把它关在"功能不可用"的提示框后面是本末倒置。
 */
function AuditSection({
  jobs,
  jobId,
  lines,
  filter,
  onSelectJob,
  onFilter,
  onExport,
}: AuditSectionProps) {
  return (
    <section className="cleaner-section">
      <p className="cleaner-muted cleaner-advice-intro">
        「删了什么、跳过了什么、为什么跳过」都在这里。记录的是文件路径全文，属隐私数据 ——
        导出前请留意这一点。
      </p>
      {jobs.length === 0 ? (
        <div className="cleaner-muted">还没有任何清理记录（扫描不写日志）。</div>
      ) : (
        <>
          <div className="cleaner-quarantine-bar">
            <label className="cleaner-inline">
              <span className="cleaner-muted">任务</span>
              <select
                value={jobId ?? ""}
                onChange={(event) => onSelectJob(event.target.value)}
                className="cleaner-select"
              >
                {jobs.map((job) => (
                  <option key={job.jobId} value={job.jobId}>
                    {shortTime(job.modifiedAt)} · {formatBytes(job.sizeBytes)}
                  </option>
                ))}
              </select>
            </label>
            <label className="cleaner-inline">
              <span className="cleaner-muted">筛选</span>
              <input
                value={filter}
                onChange={(event) => onFilter(event.target.value)}
                placeholder="规则 id 或路径片段"
                className="cleaner-input"
              />
            </label>
            <button type="button" className="cleaner-btn" onClick={onExport}>
              导出…
            </button>
          </div>
          <div className="cleaner-muted">
            共 {lines.length} 条
            {lines.length > AUDIT_ROWS_MAX && `（只显示前 ${AUDIT_ROWS_MAX} 条）`}
          </div>
          {lines.slice(0, AUDIT_ROWS_MAX).map((line, index) => (
            <div key={`${line.ts}-${index}`} className="cleaner-audit-row">
              <span className={`cleaner-audit-action cleaner-${auditTone(line.action)}`}>
                {AUDIT_ACTION_LABELS[line.action] ?? line.action}
              </span>
              <span className="cleaner-audit-path">{line.path}</span>
              {line.bytes > 0 && <span className="cleaner-muted">{formatBytes(line.bytes)}</span>}
            </div>
          ))}
        </>
      )}
    </section>
  );
}

/** 把 RFC3339 时间戳压成紧凑展示。解析不了就原样返回，不编造。 */
function shortTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function phaseLabel(phase: CleanPhase): string {
  switch (phase) {
    case "scanning":
      return "扫描中";
    case "cleaning":
      return "清理中";
    case "ready":
      return "扫描完成";
    case "done":
      return "清理完成";
    case "failed":
      return "已中止";
    default:
      return "就绪";
  }
}

export default SystemCleanerTool;
