import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Annotation, ToolKind } from "./types";

// 单数组 + index 指针实现撤销/重做：
// - items 存全部已提交标注（含 redo 尾巴）
// - index 指向「已生效数量」，渲染只画 items.slice(0, index)
// - commit 截断 redo 尾巴后 push
// - undo/redo 仅移动 index，不真删，保证 redo 可恢复
// items 与 index 合并为单一 state，commit 用函数式更新保证原子一致，
// 避免同一事件内连续 commit 时两次 setState 读到陈旧 ref 导致后一次覆盖前一次。
export interface AnnotationState {
  items: Annotation[];
  index: number;
  draft: Annotation | null; // 进行中、未提交
}

export interface UseAnnotations {
  state: AnnotationState;
  draft: Annotation | null;
  committed: Annotation[]; // 已生效（items.slice(0,index)）
  setDraft: Dispatch<SetStateAction<Annotation | null>>;
  commit: (a: Annotation) => void;
  commitDraft: () => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
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

  const getCommitted = useCallback(
    () => itemsStateRef.current.items.slice(0, itemsStateRef.current.index),
    [],
  );
  const getDraft = useCallback(() => draftRef.current, []);

  const committed = items.slice(0, index);
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
