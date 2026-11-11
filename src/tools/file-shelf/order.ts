/** 把 `id` 对应的一项移动到 `index` 这个槽位，返回新数组；没有净位移时返回 null。 */
export function moveItemToIndex<T extends { id: string }>(
  items: readonly T[],
  id: string,
  index: number,
): T[] | null {
  const from = items.findIndex((item) => item.id === id);
  if (from < 0) return null;
  const to = Math.max(0, Math.min(index, items.length - 1));
  if (from === to) return null;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
