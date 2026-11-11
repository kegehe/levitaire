import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { clearMockListeners, emitMockEvent } from "../test/tauri-mock";
import { useFileShelfEnabled } from "./useFileShelfEnabled";

const mockInvoke = vi.mocked(invoke);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 让 listen 注册与初始读取的微任务全部跑完 */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useFileShelfEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
  });
  afterEach(() => {
    clearMockListeners();
  });

  it("挂载时读取当前开关", async () => {
    mockInvoke.mockImplementation((command: string) =>
      command === "get_file_shelf_enabled" ? Promise.resolve(true) : Promise.resolve(undefined),
    );
    const { result } = renderHook(() => useFileShelfEnabled());
    await flush();
    expect(result.current).toBe(true);
  });

  it("收到广播后立即更新", async () => {
    mockInvoke.mockResolvedValue(undefined);
    const { result } = renderHook(() => useFileShelfEnabled());
    await flush();
    expect(result.current).toBe(false);

    act(() => emitMockEvent("file-shelf-enabled-changed", true));
    expect(result.current).toBe(true);
    act(() => emitMockEvent("file-shelf-enabled-changed", false));
    expect(result.current).toBe(false);
  });

  it("初始读取的过期结果不会覆盖广播值", async () => {
    const read = deferred<boolean>();
    mockInvoke.mockImplementation((command: string) =>
      command === "get_file_shelf_enabled" ? read.promise : Promise.resolve(undefined),
    );
    const { result } = renderHook(() => useFileShelfEnabled());
    await flush();

    // 读取尚未返回时开关被打开
    act(() => emitMockEvent("file-shelf-enabled-changed", true));
    expect(result.current).toBe(true);

    // 旧读取结果（关闭）晚到，不能把状态改回去
    await act(async () => {
      read.resolve(false);
      await read.promise;
    });
    expect(result.current).toBe(true);
  });

  it("卸载后不再响应广播", async () => {
    mockInvoke.mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useFileShelfEnabled());
    await flush();
    unmount();

    act(() => emitMockEvent("file-shelf-enabled-changed", true));
    expect(result.current).toBe(false);
  });
});
