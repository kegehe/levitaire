import { invoke } from "@tauri-apps/api/core";

/** 编号样式 */
export type NumberingStyle = "number-dot" | "letter-dot" | "paren" | "cn-ordinal";

/** 默认编号样式：数字 1. 2. 3. */
export const DEFAULT_NUMBERING_STYLE: NumberingStyle = "number-dot";

const STYLE_SET: ReadonlySet<NumberingStyle> = new Set([
  "number-dot",
  "letter-dot",
  "paren",
  "cn-ordinal",
]);

/** 判定并归一化存储中的编号样式，脏数据回退到默认值 */
export function normalizeNumberingStyle(raw: unknown): NumberingStyle {
  if (typeof raw !== "string") {
    return DEFAULT_NUMBERING_STYLE;
  }
  return STYLE_SET.has(raw as NumberingStyle) ? (raw as NumberingStyle) : DEFAULT_NUMBERING_STYLE;
}

/**
 * 从后端配置加载编号样式。
 * 配置跨窗口共享（持久化于 config.json），克服各 WebView localStorage 隔离问题。
 */
export async function fetchNumberingStyle(): Promise<NumberingStyle> {
  try {
    const stored = await invoke<string>("get_numbering_style");
    if (stored) {
      return normalizeNumberingStyle(JSON.parse(stored));
    }
  } catch {
    // fallthrough
  }
  return DEFAULT_NUMBERING_STYLE;
}

/** 保存编号样式到后端 */
export async function saveNumberingStyle(style: NumberingStyle): Promise<void> {
  await invoke("set_numbering_style", { style: JSON.stringify(style) });
}

/** 编号样式选项（供设置页下拉与工具栏子菜单共用） */
export const NUMBERING_STYLE_OPTIONS: ReadonlyArray<{
  value: NumberingStyle;
  label: string;
}> = [
  { value: "number-dot", label: "数字 1. 2. 3." },
  { value: "letter-dot", label: "字母 a. b. c." },
  { value: "paren", label: "括号 1) 2) 3)" },
  { value: "cn-ordinal", label: "中文 一、二、" },
];
