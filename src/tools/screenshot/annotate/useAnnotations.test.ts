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

  it("translate 按各 kind 的坐标语义整体平移，且不进入撤销栈", () => {
    const { result } = renderHook(() => useAnnotations());
    const brush: Annotation = {
      id: "brush",
      kind: "brush",
      color: "#000000",
      strokeWidth: 3,
      points: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
    };
    const arrow: Annotation = {
      id: "arrow",
      kind: "arrow",
      color: "#000000",
      strokeWidth: 3,
      x1: 10,
      y1: 20,
      x2: 30,
      y2: 40,
    };
    act(() => result.current.commit(makeRect("r")));
    act(() => result.current.commit(brush));
    act(() => result.current.commit(arrow));

    act(() => result.current.translate(5, -7));

    const [r, b, a] = result.current.committed as [
      Extract<Annotation, { kind: "rect" }>,
      Extract<Annotation, { kind: "brush" }>,
      Extract<Annotation, { kind: "arrow" }>,
    ];
    expect([r.x, r.y]).toEqual([5, -7]);
    expect(b.points).toEqual([
      { x: 6, y: -5 },
      { x: 8, y: -3 },
    ]);
    expect([a.x1, a.y1, a.x2, a.y2]).toEqual([15, 13, 35, 33]);
    // 平移是坐标系换算，不是用户编辑：撤销栈深度不变
    expect(result.current.committed).toHaveLength(3);
    expect(result.current.canUndo).toBe(true);
    act(() => result.current.undo());
    expect(result.current.committed).toHaveLength(2);
  });

  it("translate 也作用于 redo 尾巴，撤销后重做不会跳回旧位置", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.commit(makeRect("a")));
    act(() => result.current.commit(makeRect("b")));
    act(() => result.current.undo());
    act(() => result.current.translate(10, 10));
    act(() => result.current.redo());
    const tail = result.current.committed[1] as Extract<Annotation, { kind: "rect" }>;
    expect([tail.x, tail.y]).toEqual([10, 10]);
  });

  it("translate(0, 0) 不产生新状态对象（避免无谓重渲染）", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.commit(makeRect("a")));
    const before = result.current.state.items;
    act(() => result.current.translate(0, 0));
    expect(result.current.state.items).toBe(before);
  });
});

// 「编辑已有标注」以同一个 id 再 commit 一版实现：committed 按 id 去重。
describe("useAnnotations 标注编辑（同 id 版本日志）", () => {
  it("同 id 再提交后只保留一条，且绘制层序取首次出现的位置", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.commit(makeRect("r", 1)));
    act(() => result.current.commit(makeRect("x", 1)));
    // 编辑 r：同 id 提交一版新的（更宽）
    act(() => result.current.commit(makeRect("r", 3)));

    // items 变成版本日志，但 committed 收敛为两条，且 r 仍在首个槽位（不会被提到最上层）
    expect(result.current.state.items).toHaveLength(3);
    expect(result.current.committed).toHaveLength(2);
    expect(result.current.committed.map((a) => a.id)).toEqual(["r", "x"]);
    expect((result.current.committed[0] as Extract<Annotation, { kind: "rect" }>).w).toBe(30);

    // getCommitted（ref 同步读）与 committed 保持一致，避免导出时重复绘制
    expect(result.current.getCommitted()).toEqual(result.current.committed);
  });

  it("undo 回退到该 id 的上一版，redo 再前进", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.commit(makeRect("r", 1)));
    act(() => result.current.commit(makeRect("x", 1)));
    act(() => result.current.commit(makeRect("r", 3)));

    act(() => result.current.undo());
    expect(result.current.committed).toHaveLength(2);
    expect((result.current.committed[0] as Extract<Annotation, { kind: "rect" }>).w).toBe(10);

    act(() => result.current.redo());
    expect((result.current.committed[0] as Extract<Annotation, { kind: "rect" }>).w).toBe(30);
  });

  it("编辑后丢弃 redo 尾巴", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.commit(makeRect("r", 1)));
    act(() => result.current.commit(makeRect("x", 1)));
    act(() => result.current.undo());
    act(() => result.current.commit(makeRect("r", 5)));
    expect(result.current.canRedo).toBe(false);
    expect(result.current.committed.map((a) => a.id)).toEqual(["r"]);
    expect((result.current.committed[0] as Extract<Annotation, { kind: "rect" }>).w).toBe(50);
  });

  it("编辑序号不改变 nextNumber 语义", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.commit(makeNumber("n1", 1)));
    act(() => result.current.commit(makeNumber("n2", 2)));
    // 编辑 n1（同 id 再提交）：仍是 2 条序号，nextNumber 继续为 3
    act(() => result.current.commit(makeNumber("n1", 1)));
    expect(result.current.committed).toHaveLength(2);
    expect(result.current.nextNumber).toBe(3);
  });
});
