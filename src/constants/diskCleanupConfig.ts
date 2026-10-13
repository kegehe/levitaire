/**
 * 系统清理工具的前端常量。
 *
 * ⚠️ **这里不得出现任何清理目标路径**（`C:\...`、`%TEMP%`、`Program Files` …）。
 * 前端永远不持有路径，只持有后端签发的 `rule_id`（不变量 I1）；一旦这里出现路径，
 * 就等于给"删任意文件"开了第二个人口。守卫：`disk_cleanup::source_guards` 的
 * `frontend_holds_no_cleanup_paths`。
 *
 * 窗口尺寸放在这里而不是 `utils/toolWindows.ts`：与 `systemMonitorConfig` 同一约定，
 * 尺寸是"打开窗口时先画一帧"的依据，抄成两份会让窗口先按错的尺寸闪一下。
 */

/** 清理面板的初始窗口尺寸。
 *  高度按「三格统计头 + 4~5 条清理项 + 三个折叠行 + 底栏」的自然高度取值（实测 ≈410），
 *  留一档余量；规则更多时中段滚动兜底（`SystemCleanerTool.layout.test.ts` 承重约定）。 */
export const DEFAULT_CLEANER_WIDTH = 420;
export const DEFAULT_CLEANER_HEIGHT = 460;

// ── 分级 ────────────────────────────────────────────────────────────────

export type CleanTier = "L0" | "L1" | "L2" | "L3";

export interface CleanTierMeta {
  label: string;
  hint: string;
  /** 需要管理员权限 */
  needsAdmin: boolean;
  /** 不可逆：删除后无法恢复，也无法通过重装找回 */
  irreversible: boolean;
}

/** 面板里的分组顺序 */
export const CLEAN_TIER_ORDER: readonly CleanTier[] = ["L1", "L2", "L3"];

export const CLEAN_TIER_META: Record<CleanTier, CleanTierMeta> = {
  L0: {
    label: "仅扫描",
    hint: "只看不删",
    needsAdmin: false,
    irreversible: false,
  },
  L1: {
    label: "安全",
    hint: "删除后系统无副作用",
    needsAdmin: false,
    irreversible: false,
  },
  L2: {
    label: "谨慎 · 需要管理员",
    hint: "删除后会有可感知的功能性后果",
    needsAdmin: true,
    irreversible: false,
  },
  L3: {
    label: "专家 · 默认折叠",
    hint: "不可逆，或会移除系统的恢复能力",
    needsAdmin: true,
    irreversible: true,
  },
};

// ── 单条规则的扫描/执行结果 ──────────────────────────────────────────────

export type CleanRuleStatus =
  "ok" | "no-target" | "blocked" | "guarded" | "not-a-directory" | "failed" | "cancelled";

export type CleanTone = "ok" | "muted" | "warn" | "danger";

export const CLEAN_STATUS_META: Record<CleanRuleStatus, { label: string; tone: CleanTone }> = {
  ok: { label: "可清理", tone: "ok" },
  "no-target": { label: "未安装", tone: "muted" },
  blocked: { label: "已被安全闸拒绝", tone: "danger" },
  guarded: { label: "本次跳过", tone: "warn" },
  "not-a-directory": { label: "不适用", tone: "warn" },
  failed: { label: "失败", tone: "danger" },
  cancelled: { label: "已取消", tone: "muted" },
};

/** 未知状态一律按"需要注意"渲染，不假设它是正常的。 */
export function statusMeta(status: string): { label: string; tone: CleanTone } {
  return (
    CLEAN_STATUS_META[status as CleanRuleStatus] ?? { label: `未知状态（${status}）`, tone: "warn" }
  );
}

// ── 隔离区 ──────────────────────────────────────────────────────────────

/**
 * 隔离区保留期档位。
 *
 * ⚠️ 必须与 Rust 侧 `disk_cleanup::quarantine::RETENTION_CHOICES` 一致 ——
 * 后端会拒绝不在清单里的值（`update_system_cleaner_quarantine_days`），
 * 守卫：`source_guards::quarantine_retention_options_match_backend`。
 *
 * `0` 的语义是**不自动清理**（由用户显式彻底删除），不是"立即删除"。
 * 用户数据条目在任何保留期下都只能隔离。
 */
export const QUARANTINE_RETENTION_OPTIONS = [
  { value: 0, label: "不自动清理（由我手动彻底删除）" },
  { value: 7, label: "7 天后自动彻底删除（默认）" },
  { value: 14, label: "14 天后自动彻底删除" },
  { value: 30, label: "30 天后自动彻底删除" },
] as const;

export const DEFAULT_QUARANTINE_RETENTION_DAYS = 7;

// ── 展示 ────────────────────────────────────────────────────────────────

/**
 * 字节数的展示格式。
 *
 * `bytes` 一律是**扫描时的估算**：扫描与执行之间文件系统必然变化，
 * 调用方不得把它呈现为承诺（§17 验收第 14 条）。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "——";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

// ── 占用发现 ────────────────────────────────────────────────────────────

/**
 * 报告深度档位。
 *
 * ⚠️ 必须与 Rust 侧 `discover::DEPTH_CHOICES` 一致（后端对不认识的值会退回默认深度，
 * 症状是"选了没反应"）。守卫：`source_guards::discovery_depth_options_match_backend`。
 *
 * 注意这是**报告深度**，不是遍历深度 —— 遍历一律到底，否则浅层目录的大小会是错的。
 */
export const DISCOVERY_DEPTH_OPTIONS = [2, 3, 4, 5, 6] as const;

export const DEFAULT_DISCOVERY_DEPTH = 4;

// ── 看门狗 ──────────────────────────────────────────────────────────────

/**
 * 看门狗的检查间隔档位（小时）。
 *
 * ⚠️ 必须与 Rust 侧 `watchdog::INTERVAL_CHOICES` 一致。后端会把低于下限的值
 * **抬到下限**（看门狗必须低频），档位写小了症状是"选了 1 分钟、实际还是 1 小时"。
 * 守卫：`source_guards::watchdog_interval_choices_match_the_backend`。
 */
export const WATCHDOG_INTERVAL_OPTIONS = [1, 6, 24, 72, 168] as const;

export const DEFAULT_WATCHDOG_INTERVAL_HOURS = 24;

/** 告警阈值的默认值（与后端 `watchdog` 的默认值一致，仅用于表单初值）。 */
export const DEFAULT_WATCHDOG_MIN_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_WATCHDOG_MIN_DELTA_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_WATCHDOG_MIN_AGE_DAYS = 7;

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/**
 * 告警阈值档位。**用下拉而不是自由输入**：自由输入要么做成"打一半就存一次"，
 * 要么得配防抖，而这两个值的合理范围本来就窄。
 *
 * 只需保证每一项都高于后端的下限（64 MB / 16 MB / 1 天）—— 低于下限时后端会夹住，
 * 症状是"填了 1 MB、实际按 64 MB 跑"。
 */
export const WATCHDOG_MIN_BYTES_OPTIONS = [
  { value: 1 * GB, label: "1 GB" },
  { value: 2 * GB, label: "2 GB（默认）" },
  { value: 5 * GB, label: "5 GB" },
  { value: 10 * GB, label: "10 GB" },
] as const;

export const WATCHDOG_MIN_DELTA_OPTIONS = [
  { value: 512 * MB, label: "512 MB" },
  { value: 1 * GB, label: "1 GB（默认）" },
  { value: 2 * GB, label: "2 GB" },
  { value: 5 * GB, label: "5 GB" },
] as const;

export const WATCHDOG_MIN_AGE_OPTIONS = [
  { value: 3, label: "3 天" },
  { value: 7, label: "7 天（默认）" },
  { value: 14, label: "14 天" },
  { value: 30, label: "30 天" },
] as const;
