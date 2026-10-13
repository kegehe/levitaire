import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Annotation, ToolKind } from "./types";

// 单数组 + index 指针实现撤销/重做：
// - items 存全部已提交标注（含 redo 尾巴）；对同一 id 重复提交即形成「版本日志」
// - index 指向「已生效数量」，渲染画 dedupeById(items.slice(0, index))（见 dedupeById）
// - commit 截断 redo 尾巴后 push
// - undo/redo 仅移动 index，不真删，保证 redo 可恢复
// items 与 index 合并为单一 state，commit 用函数式更新保证原子一致，
// 避免同一事件内连续 commit 时两次 setState 读到陈旧 ref 导致后一次覆盖前一次。
// 「编辑已有标注」复用 commit：以同一个 id 再提交一版新数据，撤销即回退到上一版。
export interface AnnotationState {
  items: Annotation[];
  index: number;
  draft: Annotation | null; // 进行中、未提交
}

export interface UseAnnotations {
  state: AnnotationState;
  draft: Annotation | null;
  committed: Annotation[]; // 已生效（dedupeById(items.slice(0,index))）
  setDraft: Dispatch<SetStateAction<Annotation | null>>;
  /** 提交一条标注。编辑已有标注时用**同一个 id** 再提交一版即可（撤销会回退到上一版）。 */
  commit: (a: Annotation) => void;
  commitDraft: () => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
  /**
   * 整体平移全部标注（含 redo 尾巴），用于选区移动/缩放后让标注继续锚定在同一块屏幕内容上。
   * 平移是坐标系换算而非用户编辑动作，**不进撤销栈**（否则一次拖动会塞进一条无法理解的撤销项）。
   */
  translate: (dx: number, dy: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  nextNumber: number;
  /** 同步读取已生效标注（读 ref），供导出 flush 在 commit 后立即拿到最新列表 */
  getCommitted: () => Annotation[];
  /** 同步读取 draft（读 ref） */
  getDraft: () => Annotation | null;
}

interface ItemsState {
  items: Annotation[];
  index: number;
}

/**
 * 按 id 去重：编辑一条已提交标注时，会以**同一个 id** 再 push 一版新数据（见下方注释），
 * 于是 `items` 变成「版本日志」。这里把同一 id 的多个版本收敛成一条：
 * **槽位取首次出现的位置、值取最后一次出现的（最新版本）**。
 *
 * 槽位必须取首次出现的位置 —— 否则一次编辑会把该标注挪到最上层，改变绘制层序。
 * 撤销时 `index` 回退一格，去重后自然退回该 id 的上一版，无需改动 undo/redo。
 * id 唯一时（未编辑过的场景）本函数是恒等变换。
 */
function dedupeById(list: Annotation[]): Annotation[] {
  const order: string[] = [];
  const latest = new Map<string, Annotation>();
  for (const a of list) {
    if (!latest.has(a.id)) order.push(a.id);
    latest.set(a.id, a);
  }
  return order.map((id) => latest.get(id) as Annotation);
}

// 平移单个标注。坐标语义随 kind 而异（矩形是左上角、箭头是两端、序号是圆心……），
// 这里逐个改，而不是给整个数组套一个统一偏移。
function shiftAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  switch (a.kind) {
    case "rect":
    case "mosaic":
      return { ...a, x: a.x + dx, y: a.y + dy };
    case "arrow":
      return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
    case "brush":
      return { ...a, points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    case "text":
    case "number":
      return { ...a, x: a.x + dx, y: a.y + dy };
  }
}

export function useAnnotations(): UseAnnotations {
  const [{ items, index }, setItemsState] = useState<ItemsState>({
    items: [],
    index: 0,
  });
  const [draft, setDraft] = useState<Annotation | null>(null);

  // ref 镜像 items/index/draft，供同步读取（commit 后立即最新，无需等渲染）
  const itemsStateRef = useRef({ items, index });
  itemsStateRef.current = { items, index };
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const commit = useCallback((a: Annotation) => {
    // 同步更新 ref，再触发渲染；这样 flushBase64 在 commit 后立即能读到含 a 的列表
    const cur = itemsStateRef.current;
    const next = cur.items.slice(0, cur.index);
    next.push(a);
    const newState = { items: next, index: next.length };
    itemsStateRef.current = newState;
    setItemsState(newState);
  }, []);

  const commitDraft = useCallback(() => {
    const d = draftRef.current;
    if (!d) return;
    commit(d);
    setDraft(null);
    draftRef.current = null;
  }, [commit]);

  const undo = useCallback(() => {
    const s = itemsStateRef.current;
    const newState = { items: s.items, index: Math.max(0, s.index - 1) };
    itemsStateRef.current = newState;
    setItemsState(newState);
  }, []);

  const redo = useCallback(() => {
    const s = itemsStateRef.current;
    const newState = {
      items: s.items,
      index: Math.min(s.items.length, s.index + 1),
    };
    itemsStateRef.current = newState;
    setItemsState(newState);
  }, []);

  const clear = useCallback(() => {
    const newState = { items: [], index: 0 };
    itemsStateRef.current = newState;
    setItemsState(newState);
    setDraft(null);
    draftRef.current = null;
  }, []);

  const translate = useCallback((dx: number, dy: number) => {
    if (dx === 0 && dy === 0) return;
    const s = itemsStateRef.current;
    const newState = { items: s.items.map((a) => shiftAnnotation(a, dx, dy)), index: s.index };
    itemsStateRef.current = newState;
    setItemsState(newState);
  }, []);

  const getCommitted = useCallback(
    () =>
      dedupeById(itemsStateRef.current.items.slice(0, itemsStateRef.current.index)),
    [],
  );
  const getDraft = useCallback(() => draftRef.current, []);

  const committed = dedupeById(items.slice(0, index));
  const canUndo = index > 0;
  const canRedo = index < items.length;
  // 序号：取已生效 number 标注的最大 n + 1，保证 undo 中间项后不会产生重复编号
  const nextNumber =
    committed.reduce((max, a) => (a.kind === "number" && a.n > max ? a.n : max), 0) + 1;

  return {
    state: { items, index, draft },
    draft,
    committed,
    setDraft,
    commit,
    commitDraft,
    undo,
    redo,
    clear,
    translate,
    canUndo,
    canRedo,
    nextNumber,
    getCommitted,
    getDraft,
  };
}

// 按 tool 类型聚合 committed，便于渲染时无需判 kind 逐个处理
export function countTool(a: Annotation[], kind: ToolKind): number {
  return a.filter((x) => x.kind === kind).length;
}
