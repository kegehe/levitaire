import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { OptimizeMode } from "../constants/optimizeModes";
import { AiConfig } from "../types";

interface UseAiOptimizeReturn {
  /** 调用 AI 优化文本（流式） */
  optimize: (text: string, mode: OptimizeMode) => Promise<void>;
  /** 取消当前优化（重置状态） */
  cancel: () => void;
  /** 是否正在加载 */
  isLoading: boolean;
  /** AI 返回的优化文本（流式过程中实时更新） */
  optimizedText: string | null;
  /** 错误信息 */
  errorMessage: string | null;
  /** 当前 AI 配置 */
  aiConfig: AiConfig | null;
  /** 检查 AI 是否已配置 */
  checkAiConfig: () => Promise<AiConfig | null>;
}

export function useAiOptimize(): UseAiOptimizeReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [optimizedText, setOptimizedText] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [aiConfig, setAiConfig] = useState<AiConfig | null>(null);
  // Local counters restart after a remount or reload. Scope them to this Hook
  // instance so a late result/cancellation cannot affect a replacement instance.
  const [requestScope] = useState(() => crypto.randomUUID());
  // 用递增 ID 标识每次 optimize 调用，cancel 时推进 ID，
  // 这样旧的事件回调检查 requestId 就知道已过期
  const requestIdRef = useRef(0);
  const loadingRef = useRef(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const activeRequestIdRef = useRef<number | null>(null);
  const disposedRef = useRef(false);
  const streamedTextRef = useRef("");
  const streamedChunkCountRef = useRef(0);
  const textFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushStreamedText = useCallback(() => {
    if (textFlushTimerRef.current !== null) {
      clearTimeout(textFlushTimerRef.current);
      textFlushTimerRef.current = null;
    }
    setOptimizedText(streamedTextRef.current);
  }, []);

  // 组件卸载时清理监听器
  useEffect(() => {
    // StrictMode may re-run effects after their cleanup during development.
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      requestIdRef.current++;
      const requestId = activeRequestIdRef.current;
      activeRequestIdRef.current = null;
      if (requestId !== null) {
        void Promise.resolve(invoke("cancel_ai_stream", { requestId, requestScope })).catch((err) =>
          console.error("Failed to cancel AI stream on unmount:", err),
        );
      }
      loadingRef.current = false;
      if (textFlushTimerRef.current !== null) {
        clearTimeout(textFlushTimerRef.current);
        textFlushTimerRef.current = null;
      }
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [requestScope]);

  const checkAiConfig = useCallback(async (): Promise<AiConfig | null> => {
    try {
      const config = await invoke<AiConfig>("get_ai_config");
      setAiConfig(config);
      return config;
    } catch (err) {
      console.error("Failed to get AI config:", err);
      return null;
    }
  }, []);

  const optimize = useCallback(
    async (text: string, mode: OptimizeMode) => {
      if (disposedRef.current || loadingRef.current) return;
      loadingRef.current = true;

      const thisRequestId = ++requestIdRef.current;

      setIsLoading(true);
      if (textFlushTimerRef.current !== null) {
        clearTimeout(textFlushTimerRef.current);
        textFlushTimerRef.current = null;
      }
      streamedTextRef.current = "";
      streamedChunkCountRef.current = 0;
      setOptimizedText(null);
      setErrorMessage(null);

      // 清理旧的监听器
      unlistenRef.current?.();
      unlistenRef.current = null;

      // 先注册事件监听器，再发起 invoke
      const accumulatedRef = { current: "" };

      try {
        const unlisten = await listen<{
          type: string;
          data?: string;
          requestId: number;
          requestScope: string;
        }>(
          "ai-stream",
          (event) => {
            // 检查是否已被取消或被新调用取代
            if (
              disposedRef.current ||
              requestIdRef.current !== thisRequestId ||
              !loadingRef.current
            )
              return;
            if (
              event.payload.requestId !== thisRequestId ||
              event.payload.requestScope !== requestScope
            )
              return;

            const { type, data } = event.payload;

            switch (type) {
              case "chunk":
                if (data) {
                  accumulatedRef.current += data;
                  streamedTextRef.current = accumulatedRef.current;
                  streamedChunkCountRef.current += 1;
                  if (streamedChunkCountRef.current <= 2) {
                    // Keep short responses immediately responsive; longer streams
                    // are coalesced to keep React rendering below the network rate.
                    setOptimizedText(streamedTextRef.current);
                  } else if (textFlushTimerRef.current === null) {
                    textFlushTimerRef.current = setTimeout(flushStreamedText, 50);
                  }
                }
                break;
              case "done":
                flushStreamedText();
                setIsLoading(false);
                loadingRef.current = false;
                activeRequestIdRef.current = null;
                unlistenRef.current?.();
                unlistenRef.current = null;
                break;
              case "error":
                flushStreamedText();
                setErrorMessage(data || "AI 调用失败");
                setIsLoading(false);
                loadingRef.current = false;
                activeRequestIdRef.current = null;
                unlistenRef.current?.();
                unlistenRef.current = null;
                break;
            }
          },
          { target: { kind: "WebviewWindow", label: getCurrentWebviewWindow().label } },
        );
        // The component may unmount while listen() is resolving. In that case the
        // just-created listener must be released immediately instead of being
        // stored in a ref that no cleanup will observe.
        if (disposedRef.current || requestIdRef.current !== thisRequestId || !loadingRef.current) {
          unlisten();
          return;
        }
        unlistenRef.current = unlisten;

        // Only dispatched requests need backend cancellation. If registration is
        // still pending, cancel/unmount invalidates the local generation instead.
        activeRequestIdRef.current = thisRequestId;
        await invoke("call_ai_stream", {
          requestId: thisRequestId,
          requestScope,
          prompt: text,
          systemPrompt: mode.systemPrompt,
        });
      } catch (err) {
        if (disposedRef.current || requestIdRef.current !== thisRequestId || !loadingRef.current)
          return;
        const msg = typeof err === "string" ? err : String(err);
        flushStreamedText();
        // 仅在尚未通过事件收到错误时设置
        setErrorMessage((prev) => prev || msg || "AI 调用失败，请检查配置");
        setIsLoading(false);
        loadingRef.current = false;
        activeRequestIdRef.current = null;
        unlistenRef.current?.();
        unlistenRef.current = null;
      }
    },
    [flushStreamedText, requestScope],
  );

  const cancel = useCallback(() => {
    const requestId = activeRequestIdRef.current;
    requestIdRef.current++;
    activeRequestIdRef.current = null;
    loadingRef.current = false;
    if (textFlushTimerRef.current !== null) {
      clearTimeout(textFlushTimerRef.current);
      textFlushTimerRef.current = null;
    }
    streamedTextRef.current = "";
    streamedChunkCountRef.current = 0;
    setIsLoading(false);
    setOptimizedText(null);
    setErrorMessage(null);
    unlistenRef.current?.();
    unlistenRef.current = null;
    // 通知后端中止当前流式请求：避免取消后后端仍把整段结果继续生成并发给
    // 已无人监听的 IPC（白耗 token、浪费网络/CPU，并让取消的文本继续外传）。
    if (requestId !== null) {
      invoke("cancel_ai_stream", { requestId, requestScope }).catch((err) =>
        console.error("Failed to cancel AI stream:", err),
      );
    }
  }, [requestScope]);

  return {
    optimize,
    cancel,
    isLoading,
    optimizedText,
    errorMessage,
    aiConfig,
    checkAiConfig,
  };
}
