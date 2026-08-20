import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAiOptimize } from "../hooks/useAiOptimize";
import { emitMockEvent, clearMockListeners } from "../test/tauri-mock";
import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

describe("useAiOptimize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockListeners();
  });

  it("初始状态正确", () => {
    const { result } = renderHook(() => useAiOptimize());
    expect(result.current.isLoading).toBe(false);
    expect(result.current.optimizedText).toBeNull();
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.aiConfig).toBeNull();
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
      emitMockEvent("ai-stream", { type: "chunk", data: "你好" });
    });
    expect(result.current.optimizedText).toBe("你好");

    await act(async () => {
      emitMockEvent("ai-stream", { type: "chunk", data: "世界" });
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
      emitMockEvent("ai-stream", { type: "chunk", data: "结果" });
      emitMockEvent("ai-stream", { type: "done" });
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
      emitMockEvent("ai-stream", { type: "error", data: "API 限流" });
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
      emitMockEvent("ai-stream", { type: "chunk", data: "部分" });
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
      emitMockEvent("ai-stream", { type: "chunk", data: "过期数据" });
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
      prompt: "测试文本",
      systemPrompt: "润色提示词",
    });
  });
});
