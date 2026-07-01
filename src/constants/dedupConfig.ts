/** 去重粒度 */
export type DedupGranularity = "line" | "word" | "char";

/** 按字符去重时的子模式 */
export type CharSubMode = "all" | "line" | "consecutive";

/** 去重配置 */
export interface DedupMode {
  /** 去重粒度 */
  granularity: DedupGranularity;
  /** 按字符去重的子模式（仅 granularity === "char" 时生效） */
  charSubMode: CharSubMode;
}

const STORAGE_KEY = "floast-dedup-mode";

/** 默认去重配置：按行去重（保持历史行为） */
export const DEFAULT_DEDUP_MODE: DedupMode = {
  granularity: "line",
  charSubMode: "all",
};

const GRANULARITY_SET: ReadonlySet<DedupGranularity> = new Set([
  "line",
  "word",
  "char",
]);
const CHAR_SUB_MODE_SET: ReadonlySet<CharSubMode> = new Set([
  "all",
  "line",
  "consecutive",
]);

/** 判定并归一化存储中的去重配置，脏数据回退到默认值 */
function normalize(raw: unknown): DedupMode {
  if (typeof raw !== "object" || raw === null) {
    return { ...DEFAULT_DEDUP_MODE };
  }
  const obj = raw as Record<string, unknown>;
  const granularity = obj.granularity;
  const charSubMode = obj.charSubMode;
  return {
    granularity:
      typeof granularity === "string" && GRANULARITY_SET.has(granularity as DedupGranularity)
        ? (granularity as DedupGranularity)
        : DEFAULT_DEDUP_MODE.granularity,
    charSubMode:
      typeof charSubMode === "string" && CHAR_SUB_MODE_SET.has(charSubMode as CharSubMode)
        ? (charSubMode as CharSubMode)
        : DEFAULT_DEDUP_MODE.charSubMode,
  };
}

/** 读取去重配置（默认按行） */
export function getDedupMode(): DedupMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      return normalize(JSON.parse(stored));
    } catch {
      // fallthrough
    }
  }
  return { ...DEFAULT_DEDUP_MODE };
}

/** 保存去重配置 */
export function setDedupMode(mode: DedupMode): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(mode));
}

/** 顶层粒度选项（供设置页下拉渲染） */
export const DEDUP_GRANULARITY_OPTIONS: ReadonlyArray<{
  value: DedupGranularity;
  label: string;
}> = [
  { value: "line", label: "按行" },
  { value: "word", label: "按词" },
  { value: "char", label: "按字符" },
];

/** 按字符去重的子模式选项 */
export const DEDUP_CHAR_SUBMODE_OPTIONS: ReadonlyArray<{
  value: CharSubMode;
  label: string;
}> = [
  { value: "all", label: "逐字去重" },
  { value: "line", label: "行内逐字" },
  { value: "consecutive", label: "仅连续重复" },
];
