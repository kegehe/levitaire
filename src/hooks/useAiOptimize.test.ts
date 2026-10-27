import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAiOptimize } from "../hooks/useAiOptimize";
import { emitMockEvent, clearMockListeners, setMockWindow } from "../test/tauri-mock";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const mockInvoke = vi.mocked(invoke);
const testMode = {
  id: "polish",
  icon: "Sparkles" as const,
  label: "润色",
  systemPrompt: "润色提示词",
};

function latestRequestScope(): string {
  const call = [...mockInvoke.mock.calls]
    .reverse()
    .find(([command]) => command === "call_ai_stream");
  return (call?.[1] as { requestScope?: string })?.requestScope ?? "";
}

function emitAiStream(payload: Record<string, unknown>, requestScope = latestRequestScope()) {
  emitMockEvent("ai-stream", { requestId: 1, requestScope, ...payload });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useAiOptimize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockReset().mockResolvedValue(undefined);
    clearMockListeners();
    setMockWindow({ label: "toolbar" });
  });

  afterEach(() => {
    vi.useRealTimers();
    setMockWindow({ label: "toolbar" });
  });

  it("同一窗口重新挂载后不会复用旧实例的请求标识或接收旧事件", async () => {
    const old = renderHook(() => useAiOptimize());
    await act(async () => old.result.current.optimize("old", testMode));
    const oldScope = latestRequestScope();
    old.unmount();
    const current = renderHook(() => useAiOptimize());
    await act(async () => current.result.current.optimize("new", testMode));
    expect(latestRequestScope()).not.toBe(oldScope);
    await act(async () => {
      emitAiStream({ type: "chunk", data: "旧结果", requestId: 1 }, oldScope);
      emitAiStream({ type: "done", requestId: 1 }, oldScope);
    });
    expect(current.result.current.optimizedText).toBeNull();
    expect(current.result.current.isLoading).toBe(true);
    await act(async () => {
      emitAiStream({ type: "chunk", data: "新结果", requestId: 1 });
      emitAiStream({ type: "done", requestId: 1 });
    });
    expect(current.result.current.optimizedText).toBe("新结果");
    expect(current.result.current.isLoading).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith("cancel_ai_stream", {
      requestId: 1,
      requestScope: oldScope,
    });
  });

  it("同号并发请求只接收来源窗口的事件", async () => {
    const subscriptions: Array<{
      target: unknown;
      handler: (event: { event: string; id: number; payload: unknown }) => void;
    }> = [];
    const register: typeof listen = async (_event, handler, options) => {
      const subscription = { target: options?.target, handler };
      subscriptions.push(subscription as (typeof subscriptions)[number]);
      return () => {
        const index = subscriptions.indexOf(subscription as (typeof subscriptions)[number]);
        if (index >= 0) subscriptions.splice(index, 1);
      };
    };
    vi.mocked(listen).mockImplementationOnce(register).mockImplementationOnce(register);
    const toolbar = renderHook(() => useAiOptimize());
    await act(async () => toolbar.result.current.optimize("toolbar", testMode));
    setMockWindow({ label: "pin-ocr-result" });
    const ocr = renderHook(() => useAiOptimize());
    await act(async () => ocr.result.current.optimize("ocr", testMode));
    expect(subscriptions.map(({ target }) => target)).toEqual([
      { kind: "WebviewWindow", label: "toolbar" },
      { kind: "WebviewWindow", label: "pin-ocr-result" },
    ]);
    act(() => {
      for (const subscription of [...subscriptions]) {
        const target = subscription.target as { label: string };
        if (target.label === "pin-ocr-result") {
          subscription.handler({
            event: "ai-stream",
            id: 0,
            payload: {
              type: "chunk",
              data: "OCR 结果",
              requestId: 1,
              requestScope: latestRequestScope(),
            },
          });
          subscription.handler({
            event: "ai-stream",
            id: 0,
            payload: { type: "done", requestId: 1, requestScope: latestRequestScope() },
          });
        }
      }
    });
    expect(ocr.result.current.optimizedText).toBe("OCR 结果");
    expect(ocr.result.current.isLoading).toBe(false);
    expect(toolbar.result.current.optimizedText).toBeNull();
    expect(toolbar.result.current.isLoading).toBe(true);
    act(() => toolbar.result.current.cancel());
    expect(ocr.result.current.optimizedText).toBe("OCR 结果");
  });

  it("旧监听注册迟到不会移除取消后新请求的监听", async () => {
    const registration = deferred<() => void>();
    const unlisten = vi.fn();
    vi.mocked(listen).mockReturnValueOnce(registration.promise);
    const { result } = renderHook(() => useAiOptimize());
    let oldRequest!: Promise<void>;
    act(() => {
      oldRequest = result.current.optimize("old", testMode);
    });
    act(() => result.current.cancel());
    await act(async () => result.current.optimize("new", testMode));
    await act(async () => {
      registration.resolve(unlisten);
      await oldRequest;
      emitAiStream({ type: "chunk", data: "新结果", requestId: 3 });
    });
    expect(unlisten).toHaveBeenCalledOnce();
    expect(result.current.optimizedText).toBe("新结果");
    expect(result.current.isLoading).toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith(
      "call_ai_stream",
      expect.objectContaining({ requestId: 3 }),
    );
  });

  it("空闲取消和卸载不向后端发送取消请求", () => {
    const { result, unmount } = renderHook(() => useAiOptimize());
    act(() => {
      result.current.cancel();
      result.current.cancel();
    });
    unmount();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it.each(["done", "error"])("%s 后取消只清理本地状态", async (type) => {
    const { result, unmount } = renderHook(() => useAiOptimize());
    await act(async () => {
      await result.current.optimize("input", testMode);
      emitAiStream({ type: "chunk", data: "结果", requestId: 1 });
      emitAiStream({ type, data: "错误", requestId: 1 });
    });
    act(() => result.current.cancel());
    expect(result.current.optimizedText).toBeNull();
    expect(result.current.errorMessage).toBeNull();
    unmount();
    expect(mockInvoke).not.toHaveBeenCalledWith("cancel_ai_stream", expect.anything());
  });

  it("执行中重复取消只向后端取消当前请求一次", async () => {
    const { result, unmount } = renderHook(() => useAiOptimize());
    await act(async () => {
      await result.current.optimize("input", testMode);
    });
    act(() => {
      result.current.cancel();
      result.current.cancel();
    });
    unmount();
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "cancel_ai_stream")).toEqual([
      ["cancel_ai_stream", { requestId: 1, requestScope: expect.any(String) }],
    ]);
  });

  it("执行中卸载只取消自身请求", async () => {
    const { result, unmount } = renderHook(() => useAiOptimize());
    await act(async () => {
      await result.current.optimize("input", testMode);
    });
    unmount();
    expect(mockInvoke).toHaveBeenCalledWith("cancel_ai_stream", {
      requestId: 1,
      requestScope: expect.any(String),
    });
  });

  it.each(["cancel", "unmount"])("注册监听期间 %s 不启动或取消后端请求", async (action) => {
    const registration = deferred<() => void>();
    const unlisten = vi.fn();
    vi.mocked(listen).mockReturnValueOnce(registration.promise);
    const { result, unmount } = renderHook(() => useAiOptimize());
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.optimize("input", testMode);
    });
    act(() => {
      if (action === "cancel") result.current.cancel();
      else unmount();
    });
    await act(async () => {
      registration.resolve(unlisten);
      await pending;
    });
    expect(unlisten).toHaveBeenCalledOnce();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("注册监听失败后恢复状态并允许重试", async () => {
    vi.mocked(listen).mockRejectedValueOnce(new Error("监听注册失败"));
    const { result } = renderHook(() => useAiOptimize());
    await act(async () => {
      await result.current.optimize("input", testMode);
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.errorMessage).toContain("监听注册失败");
    expect(mockInvoke).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.optimize("retry", testMode);
    });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.errorMessage).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith(
      "call_ai_stream",
      expect.objectContaining({ prompt: "retry" }),
    );
  });

  it("完成事件之后迟到的 IPC 错误不会覆盖成功结果", async () => {
    const invocation = deferred<void>();
    mockInvoke.mockReturnValueOnce(invocation.promise);
    const { result } = renderHook(() => useAiOptimize());
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.optimize("input", testMode);
    });
    await act(async () => {
      emitAiStream({ type: "chunk", data: "完成结果", requestId: 1 });
      emitAiStream({ type: "done", requestId: 1 });
      invocation.reject("迟到的 IPC 错误");
      await pending;
    });
    expect(result.current.optimizedText).toBe("完成结果");
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("取消后重新请求会忽略旧请求事件和 IPC 错误", async () => {
    const invocation = deferred<void>();
    mockInvoke.mockReturnValueOnce(invocation.promise);
    const { result } = renderHook(() => useAiOptimize());
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.optimize("old", testMode);
    });
    act(() => result.current.cancel());
    await act(async () => {
      await result.current.optimize("new", testMode);
      emitAiStream({ type: "chunk", data: "旧结果", requestId: 1 });
      emitAiStream({ type: "done", requestId: 1 });
      invocation.reject("旧错误");
      await pending;
      emitAiStream({ type: "chunk", data: "新结果", requestId: 3 });
    });
    expect(result.current.optimizedText).toBe("新结果");
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });

  it("初始状态正确", () => {
    const { result } = renderHook(() => useAiOptimize());
    expect(result.current.isLoading).toBe(false);
    expect(result.current.optimizedText).toBeNull();
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.aiConfig).toBeNull();
  });

  it("缺少请求 ID 或实例标识的事件不会更新当前请求", async () => {
    const { result } = renderHook(() => useAiOptimize());
    await act(async () => result.current.optimize("input", testMode));
    act(() => {
      emitMockEvent("ai-stream", { type: "chunk", data: "无标识数据" });
      emitMockEvent("ai-stream", { type: "done", requestId: 1 });
      emitMockEvent("ai-stream", { type: "error", requestScope: latestRequestScope() });
    });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.optimizedText).toBeNull();
    expect(result.current.errorMessage).toBeNull();
  });

  it("取消时清除批量刷新定时器，重试后不会出现旧文本", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAiOptimize());
    await act(async () => result.current.optimize("old", testMode));
    act(() => {
      emitAiStream({ type: "chunk", data: "a" });
      emitAiStream({ type: "chunk", data: "b" });
      emitAiStream({ type: "chunk", data: "c" });
    });
    expect(result.current.optimizedText).toBe("ab");
    act(() => result.current.cancel());
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => result.current.optimize("new", testMode));
    act(() => vi.advanceTimersByTime(100));
    expect(result.current.optimizedText).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });

  it("IPC 失败时立即落定批量文本并清除刷新定时器", async () => {
    vi.useFakeTimers();
    const invocation = deferred<void>();
    mockInvoke.mockReturnValueOnce(invocation.promise);
    const { result } = renderHook(() => useAiOptimize());
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.optimize("input", testMode);
    });
    act(() => {
      emitAiStream({ type: "chunk", data: "a" });
      emitAiStream({ type: "chunk", data: "b" });
      emitAiStream({ type: "chunk", data: "c" });
    });
    await act(async () => {
      invocation.reject("连接断开");
      await pending;
    });
    expect(result.current.errorMessage).toBe("连接断开");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.optimizedText).toBe("abc");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("完成时立即刷新最后的批量文本且卸载不残留刷新定时器", async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useAiOptimize());
    await act(async () => result.current.optimize("input", testMode));
    act(() => {
      emitAiStream({ type: "chunk", data: "a" });
      emitAiStream({ type: "chunk", data: "b" });
      emitAiStream({ type: "chunk", data: "c" });
      emitAiStream({ type: "done" });
    });
    expect(result.current.optimizedText).toBe("abc");
    expect(result.current.isLoading).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => result.current.optimize("next", testMode));
    act(() => {
      emitAiStream({ type: "chunk", data: "a", requestId: 2 });
      emitAiStream({ type: "chunk", data: "b", requestId: 2 });
      emitAiStream({ type: "chunk", data: "c", requestId: 2 });
    });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checkAiConfig 返回配置", async () => {
    const config = {
      api_key: "sk-test",
      base_url: "https://api.test",
      model: "m",
      api_type: "anthropic",
    };
    mockInvoke.mockResolvedValueOnce(config);

    const { result } = renderHook(() => useAiOptimize());
    let returned;
    await act(async () => {
      returned = await result.current.checkAiConfig();
    });

    expect(returned).toEqual(config);
    expect(result.current.aiConfig).toEqual(config);
  });

  it("checkAiConfig 失败返回 null", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("fail"));
    const { result } = renderHook(() => useAiOptimize());

    let returned;
    await act(async () => {
      returned = await result.current.checkAiConfig();
    });

    expect(returned).toBeNull();
  });

  it("optimize 设置 loading 状态", async () => {
    // call_ai_stream 不会立即 resolve，模拟长时间运行
    mockInvoke.mockReturnValueOnce(new Promise(() => {}));

    const { result } = renderHook(() => useAiOptimize());

    await act(async () => {
      result.current.optimize("test", {
        id: "p",
        icon: "Sparkles",
        label: "润色",
        systemPrompt: "sp",
      });
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.optimizedText).toBeNull();
    expect(result.current.errorMessage).toBeNull();
  });

  it("optimize 防重复调用", async () => {
    mockInvoke.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useAiOptimize());

    await act(async () => {
      result.current.optimize("test", {
        id: "p",
        icon: "Sparkles",
        label: "润色",
        systemPrompt: "sp",
      });
      result.current.optimize("test2", {
        id: "p",
        icon: "Sparkles",
        label: "润色",
        systemPrompt: "sp",
      });
    });

    // 只应调用一次 invoke
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("流式 chunk 事件累积文本", async () => {
    mockInvoke.mockReturnValueOnce(new Promise(() => {}));

    const { result } = renderHook(() => useAiOptimize());

    await act(async () => {
      result.current.optimize("input", {
        id: "p",
        icon: "Sparkles",
        label: "润色",
        systemPrompt: "sp",
      });
    });

    await act(async () => {
      emitAiStream({ type: "chunk", data: "你好" });
    });
    expect(result.current.optimizedText).toBe("你好");

    await act(async () => {
      emitAiStream({ type: "chunk", data: "世界" });
    });
    expect(result.current.optimizedText).toBe("你好世界");
  });

  it("done 事件结束 loading", async () => {
    mockInvoke.mockReturnValueOnce(new Promise(() => {}));

    const { result } = renderHook(() => useAiOptimize());

    await act(async () => {
      result.current.optimize("input", {
        id: "p",
        icon: "Sparkles",
        label: "润色",
        systemPrompt: "sp",
      });
    });

    await act(async () => {
      emitAiStream({ type: "chunk", data: "结果" });
      emitAiStream({ type: "done" });
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.optimizedText).toBe("结果");
    expect(result.current.errorMessage).toBeNull();
  });

  it("error 事件设置错误信息", async () => {
    mockInvoke.mockReturnValueOnce(new Promise(() => {}));

    const { result } = renderHook(() => useAiOptimize());

    await act(async () => {
      result.current.optimize("input", {
        id: "p",
        icon: "Sparkles",
        label: "润色",
        systemPrompt: "sp",
      });
    });

    await act(async () => {
      emitAiStream({ type: "error", data: "API 限流" });
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.errorMessage).toBe("API 限流");
  });

  it("cancel 重置所有状态", async () => {
    mockInvoke.mockReturnValueOnce(new Promise(() => {}));

    const { result } = renderHook(() => useAiOptimize());

    await act(async () => {
      result.current.optimize("input", {
        id: "p",
        icon: "Sparkles",
        label: "润色",
        systemPrompt: "sp",
      });
    });

    await act(async () => {
      emitAiStream({ type: "chunk", data: "部分" });
    });
    expect(result.current.optimizedText).toBe("部分");

    await act(async () => {
      result.current.cancel();
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.optimizedText).toBeNull();
    expect(result.current.errorMessage).toBeNull();
  });

  it("cancel 后旧 chunk 事件被忽略", async () => {
    mockInvoke.mockReturnValueOnce(new Promise(() => {}));

    const { result } = renderHook(() => useAiOptimize());

    await act(async () => {
      result.current.optimize("input", {
        id: "p",
        icon: "Sparkles",
        label: "润色",
        systemPrompt: "sp",
      });
    });

    await act(async () => {
      result.current.cancel();
    });

    await act(async () => {
      emitAiStream({ type: "chunk", data: "过期数据" });
    });

    expect(result.current.optimizedText).toBeNull();
  });

  it("invoke 错误设置 errorMessage", async () => {
    mockInvoke.mockRejectedValueOnce("连接失败");

    const { result } = renderHook(() => useAiOptimize());

    await act(async () => {
      await result.current.optimize("input", {
        id: "p",
        icon: "Sparkles",
        label: "润色",
        systemPrompt: "sp",
      });
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.errorMessage).toBe("连接失败");
  });

  it("invoke 调用参数正确", async () => {
    mockInvoke.mockReturnValueOnce(new Promise(() => {}));

    const { result } = renderHook(() => useAiOptimize());
    const mode = {
      id: "polish",
      icon: "Sparkles" as const,
      label: "润色",
      systemPrompt: "润色提示词",
    };

    await act(async () => {
      result.current.optimize("测试文本", mode);
    });

    expect(mockInvoke).toHaveBeenCalledWith("call_ai_stream", {
      requestId: 1,
      requestScope: expect.any(String),
      prompt: "测试文本",
      systemPrompt: "润色提示词",
    });
  });
});
