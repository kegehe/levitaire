/**
 * 「启用项列表」在空列表上的歧义，与本仓库的解法。
 *
 * 后端 `clear_options` / `toolbar_features` 两个字段存的都是「**启用的** ID 列表」，
 * 而**空列表**同时能表达两件互斥的事：
 *   ① 用户从未设置过 → 应回退到默认全量；
 *   ② 用户主动把**每一项**都关掉了 → 应保持为空。
 * 老实现一律按 ① 处理，于是「全部取消勾选」存不住：重开（或重启）就全选回来了 ——
 * 和「老配置里的 pomodoro 自启项关不掉」是同一类"关不掉"缺陷。
 *
 * 解法：用户把列表清空时**实际存一个哨兵元素**；读取时先认哨兵。
 * - 老配置里没有哨兵 ⇒ 语义完全不变（空列表仍是"从未设置"）；
 * - 也不可能出现"用户真的想启用一个叫哨兵的东西"，因为哨兵不是合法 ID，
 *   且在所有「未知 ID → 重置默认」的判断之前就被拦下。
 *
 * ⚠️ 新增这类「可全禁」的列表配置时请复用本模块，别各自造一套哨兵。
 */
export const NONE_SELECTED_SENTINEL = "__levitaire_none__";

/** 把用户选择编码成后端存储值：空选择编码成哨兵，其余原样。 */
export function encodeSelection(ids: readonly string[]): string[] {
  return ids.length > 0 ? [...ids] : [NONE_SELECTED_SENTINEL];
}

/**
 * 把后端存储值解码成用户选择。
 * 返回 `null` 表示**从未设置过**（调用方回退默认全量），`[]` 表示用户主动全关。
 */
export function decodeSelection(stored: readonly string[] | null | undefined): string[] | null {
  if (!stored || stored.length === 0) return null;
  if (stored.length === 1 && stored[0] === NONE_SELECTED_SENTINEL) return [];
  return [...stored];
}
