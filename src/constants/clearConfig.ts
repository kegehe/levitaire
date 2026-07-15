import { invoke } from "@tauri-apps/api/core";

/** 清除项 ID（与 src/utils/clearText.ts 的 switch 分支一一对应） */
export type ClearOptionId =
  | "clear-spaces"
  | "clear-tabs"
  | "clear-newlines"
  | "clear-whitespace"
  | "clear-letters"
  | "clear-digits"
  | "clear-chinese";

/** 清除项定义 */
export interface ClearOption {
  id: ClearOptionId;
  label: string;
}

/** 全部清除项（顺序即子菜单展示顺序） */
export const CLEAR_OPTIONS: ReadonlyArray<ClearOption> = [
  { id: "clear-spaces", label: "删除空格" },
  { id: "clear-tabs", label: "删除制表符" },
  { id: "clear-newlines", label: "删除换行符" },
  { id: "clear-whitespace", label: "删除所有空白" },
  { id: "clear-letters", label: "删除所有字母" },
  { id: "clear-digits", label: "删除所有数字" },
  { id: "clear-chinese", label: "删除所有中文" },
];

/** 全部清除项 ID（默认全部启用） */
export const DEFAULT_CLEAR_IDS: string[] = CLEAR_OPTIONS.map((o) => o.id);

/**
 * 从后端配置加载启用的清除项 ID 列表。
 * 配置跨窗口共享（持久化于 config.json），克服各 WebView localStorage 隔离问题。
 * 空列表或含未知 ID 时回退为默认全量；否则原样返回，尊重用户已取消勾选的项。
 */
export async function fetchClearOptions(): Promise<string[]> {
  const allIds = DEFAULT_CLEAR_IDS;
  try {
    const stored = await invoke<string[]>("get_clear_options");
    if (!stored || stored.length === 0) {
      return [...allIds];
    }
    const allIdSet = new Set(allIds);
    // 含已移除的旧 ID：结构已变，重置为默认全量
    if (stored.some((id) => !allIdSet.has(id))) {
      await invoke("set_clear_options", { options: allIds });
      return [...allIds];
    }
    // 原样返回。不自动追加新增项——否则用户主动取消勾选的项会被当作"新增"补回。
    return stored;
  } catch {
    return [...allIds];
  }
}

/** 保存启用的清除项 ID 列表到后端配置 */
export async function saveClearOptions(ids: string[]): Promise<void> {
  await invoke("set_clear_options", { options: ids });
}
