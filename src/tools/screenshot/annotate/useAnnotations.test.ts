import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAnnotations } from "./useAnnotations";
import type { Annotation } from "./types";

function makeRect(id: string, n = 1): Annotation {
  return {
    id,
    kind: "rect",
    color: "#000000",
    strokeWidth: 3,
    x: 0,
    y: 0,
    w: n * 10,
    h: n * 10,
  };
}

function makeNumber(id: string, n: number): Annotation {
  return {
    id,
    kind: "number",
    color: "#E53935",
    strokeWidth: 5,
    x: 0,
    y: 0,
    radius: 12,
    fontSize: 16,
    n,
  };
}

describe("useAnnotations", () => {
  it("初始无标注，不可撤销/重做", () => {
    const { result } = renderHook(() => useAnnotations());
    expect(result.current.committed).toEqual([]);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(result.current.nextNumber).toBe(1);
  });

  it("commit 后可见、可撤销", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.commit(makeRect("a")));
    expect(result.current.committed).toHaveLength(1);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it("undo 后 committed 为空，redo 可恢复", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.commit(makeRect("a")));
    act(() => result.current.undo());
    expect(result.current.committed).toEqual([]);
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.redo());
    expect(result.current.committed).toHaveLength(1);
  });

  it("commit 后 undo 再 commit 新标注，丢弃 redo 尾巴", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.commit(makeRect("a")));
    act(() => result.current.undo());
    act(() => result.current.commit(makeRect("b")));
    expect(result.current.committed).toHaveLength(1);
    expect((result.current.committed[0] as { id: string }).id).toBe("b");
    expect(result.current.canRedo).toBe(false);
  });

  it("序号 nextNumber 随已提交 number 标注数递增，且 undo/redo 一致", () => {
    const { result } = renderHook(() => useAnnotations());
    expect(result.current.nextNumber).toBe(1);
    act(() => result.current.commit(makeNumber("n1", 1)));
    expect(result.current.nextNumber).toBe(2);
    act(() => result.current.commit(makeNumber("n2", 2)));
    expect(result.current.nextNumber).toBe(3);
    act(() => result.current.undo());
    expect(result.current.nextNumber).toBe(2);
    act(() => result.current.redo());
    expect(result.current.nextNumber).toBe(3);
  });

  it("undo 后 nextNumber 取已生效最大 n+1，避免简单重复", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.commit(makeNumber("n1", 1)));
    act(() => result.current.commit(makeNumber("n2", 2)));
    act(() => result.current.commit(makeNumber("n3", 3)));
    // undo 撤掉 n3：committed=[n1,n2]，max=2 → nextNumber=3
    act(() => result.current.undo());
    expect(result.current.nextNumber).toBe(3);
  });

  it("clear 清空全部并重置 index", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.commit(makeRect("a")));
    act(() => result.current.commit(makeRect("b")));
    act(() => result.current.undo());
    act(() => result.current.clear());
    expect(result.current.committed).toEqual([]);
    expect(result.current.state.items).toEqual([]);
    expect(result.current.canRedo).toBe(false);
  });

  it("commitDraft 提交 draft 并清空 draft", () => {
    const { result } = renderHook(() => useAnnotations());
    const d = makeRect("draft");
    act(() => result.current.setDraft(d));
    expect(result.current.draft).not.toBeNull();
    act(() => result.current.commitDraft());
    expect(result.current.committed).toHaveLength(1);
    expect(result.current.draft).toBeNull();
  });
});
