import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { OptimizeMode } from "../constants/optimizeModes";
import { AiConfig } from "../types";

interface UseAiOptimizeReturn {
  /** 调用 AI 优化文本 */
  optimize: (text: string, mode: OptimizeMode) => Promise<void>;
  /** 取消当前优化（重置状态） */
  cancel: () => void;
  /** 是否正在加载 */
  isLoading: boolean;
  /** AI 返回的优化文本 */
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
  // 用递增 ID 标识每次 optimize 调用，cancel 时推进 ID，
  // 这样旧的 invoke 返回后检查 requestId 就知道已过期
  const requestIdRef = useRef(0);
  const loadingRef = useRef(false); // 用 ref 防止重复调用

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

  const optimize = useCallback(async (text: string, mode: OptimizeMode) => {
    // 用 ref 做即时判断，防止同一渲染周期内的重复调用
    if (loadingRef.current) return;
    loadingRef.current = true;

    // 为本次调用分配唯一 ID
    const thisRequestId = ++requestIdRef.current;

    setIsLoading(true);
    setOptimizedText(null);
    setErrorMessage(null);

    try {
      const response = await invoke<{ content: string; model: string }>("call_ai", {
        prompt: text,
        systemPrompt: mode.systemPrompt,
      });

      // 检查是否已被取消或被新调用取代
      if (requestIdRef.current !== thisRequestId) return;

      if (!response.content || response.content.trim().length === 0) {
        setErrorMessage("AI 未返回有效内容");
        setIsLoading(false);
        loadingRef.current = false;
        return;
      }

      const result = response.content.trim();
      // AI 返回内容与输入完全相同时，直接使用原文（避免无意义的"优化"结果）
      if (result === text.trim()) {
        setOptimizedText(text.trim());
      } else {
        setOptimizedText(result);
      }
      setIsLoading(false);
      loadingRef.current = false;
    } catch (err) {
      // 检查是否已被取消或被新调用取代
      if (requestIdRef.current !== thisRequestId) return;
      const msg = typeof err === "string" ? err : String(err);
      setErrorMessage(msg || "AI 调用失败，请检查配置");
      setIsLoading(false);
      loadingRef.current = false;
    }
  }, []);

  const cancel = useCallback(() => {
    // 推进 requestId 使所有进行中的调用结果失效
    requestIdRef.current++;
    loadingRef.current = false;
    setIsLoading(false);
    setOptimizedText(null);
    setErrorMessage(null);
  }, []);

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
