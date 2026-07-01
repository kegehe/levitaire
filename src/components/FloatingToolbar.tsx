import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import ToolbarButton from "./ToolbarButton";
import Icon from "./Icon";
import { SelectionInfo } from "../types";
import { OPTIMIZE_MODES, OptimizeMode } from "../constants/optimizeModes";
import { useAiOptimize } from "../hooks/useAiOptimize";
import "./FloatingToolbar.css";

type ToolbarState = "default" | "mode-select" | "loading" | "preview" | "error";

function FloatingToolbar() {
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [state, setState] = useState<ToolbarState>("default");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 用 ref 追踪 state，避免 useEffect 对 state 的频繁依赖导致 listener 重注册
  const stateRef = useRef<ToolbarState>("default");
  // 防止重复点击优化/模式选择
  const optimizeInProgressRef = useRef(false);

  // 同步设置页选择的主题（toolbar 是独立窗口，需手动读取 localStorage）
  useLayoutEffect(() => {
    const theme = localStorage.getItem("floast-theme") || "light";
    document.documentElement.setAttribute("data-theme", theme);
  }, []);

  const { optimize, cancel, isLoading, optimizedText, errorMessage: aiError, checkAiConfig } = useAiOptimize();

  // 同步 stateRef
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // 隐藏工具栏
  const hideToolbar = useCallback(async () => {
    setIsVisible(false);
    setState("default");
    cancel();
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    try {
      await invoke("hide_toolbar");
    } catch {
      getCurrentWebviewWindow().hide();
    }
  }, [cancel]);

  // 调整工具栏窗口大小
  const resizeToolbar = useCallback((width: number, height: number) => {
    const win = getCurrentWebviewWindow();
    win.setSize(new LogicalSize(width, height)).catch(() => {});
  }, []);

  // 重置到默认态
  const resetToDefault = useCallback(() => {
    setState("default");
    optimizeInProgressRef.current = false;
    cancel();
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    resizeToolbar(200, 50);
  }, [cancel, resizeToolbar]);

  useEffect(() => {
    const win = getCurrentWebviewWindow();

    const unlisten = win.listen<SelectionInfo>("selection-found", (event) => {
      setSelection(event.payload);
      setIsVisible(true);
      setState("default");
      optimizeInProgressRef.current = false;
      cancel(); // 取消可能还在进行中的旧 AI 调用
      if (errorTimerRef.current) {
        clearTimeout(errorTimerRef.current);
        errorTimerRef.current = null;
      }
      resizeToolbar(200, 50);
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const currentState = stateRef.current;
        if (currentState === "mode-select" || currentState === "preview" || currentState === "error") {
          resetToDefault();
        } else {
          hideToolbar();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      unlisten.then((fn) => fn());
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [cancel, hideToolbar, resetToDefault, resizeToolbar]);

  // 监听 AI 状态变化 — 处理 loading → preview/error/default 转换
  useEffect(() => {
    if (!isLoading && state === "loading") {
      if (aiError) {
        setState("error");
        setErrorMessage(aiError);
        resizeToolbar(300, 50);
        // 3 秒后自动回到默认态
        if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
        errorTimerRef.current = setTimeout(() => {
          resetToDefault();
        }, 3000);
      } else if (optimizedText) {
        setState("preview");
        resizeToolbar(400, 200);
      } else {
        // 防御性处理：isLoading 为 false 但既没有错误也没有结果
        // 可能是 cancel() 被调用了，重置到默认态
        resetToDefault();
      }
    }
  }, [isLoading, aiError, optimizedText, state, resetToDefault, resizeToolbar]);

  // 复制
  const handleCopy = async () => {
    if (selection) {
      try {
        await invoke("copy_text", { text: selection.text });
        hideToolbar();
      } catch (err) {
        console.error("Failed to copy:", err);
      }
    }
  };

  // 点击优化按钮
  const handleOptimizeClick = async () => {
    if (optimizeInProgressRef.current) return;
    optimizeInProgressRef.current = true;

    const config = await checkAiConfig();
    if (!config || !config.api_key || config.api_key.trim().length === 0) {
      setState("error");
      setErrorMessage("请先配置 AI");
      resizeToolbar(300, 50);
      optimizeInProgressRef.current = false;
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => {
        resetToDefault();
      }, 5000);
      return;
    }
    setState("mode-select");
    optimizeInProgressRef.current = false; // 进入模式选择后重置，让模式点击能生效
    resizeToolbar(280, 50);
  };

  // 选择优化模式
  const handleModeSelect = async (mode: OptimizeMode) => {
    if (!selection || isLoading) return;
    // 立即切换到 loading 状态，不依赖 useEffect 检测 isLoading 变化
    // 这样即使 AI 调用极快完成，状态机也能正确推进
    setState("loading");
    resizeToolbar(200, 50);
    await optimize(selection.text, mode);
  };

  // 确认替换
  const handleReplace = async () => {
    if (!optimizedText) return;
    try {
      await invoke("replace_selection", { text: optimizedText });
      hideToolbar();
    } catch (err) {
      const msg = err instanceof Error ? err.message
        : typeof err === "string" ? err
        : "无法替换，请重新选中文本";
      setState("error");
      setErrorMessage(msg);
      resizeToolbar(300, 50);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => {
        resetToDefault();
      }, 3000);
    }
  };

  // 跳转设置
  const handleGoSettings = async () => {
    try {
      await invoke("show_settings");
    } catch (err) {
      console.error("Failed to show settings:", err);
    }
    resetToDefault();
  };

  if (!isVisible || !selection) {
    return null;
  }

  // 预览文本限制显示长度
  const previewText = optimizedText && optimizedText.length > 500
    ? optimizedText.slice(0, 500) + "..."
    : optimizedText;

  return (
    <div id="toolbar" className="toolbar-container" role="toolbar" aria-label="文本操作工具栏">
      {state === "default" && (
        <>
          <ToolbarButton icon="Copy" label="复制" onClick={handleCopy} />
          <ToolbarButton icon="Sparkles" label="优化" onClick={handleOptimizeClick} />
        </>
      )}

      {state === "mode-select" && (
        <div className="toolbar-mode-select">
          <ToolbarButton icon="ArrowLeft" label="返回" onClick={resetToDefault} />
          <div className="toolbar-mode-divider" />
          {OPTIMIZE_MODES.map((mode) => (
            <ToolbarButton
              key={mode.id}
              icon={mode.icon}
              label={mode.label}
              onClick={() => handleModeSelect(mode)}
            />
          ))}
        </div>
      )}

      {state === "loading" && (
        <div className="toolbar-loading" aria-busy="true" role="status">
          <ToolbarButton icon="Sparkles" label="优化中..." onClick={() => {}} loading />
          <ToolbarButton icon="X" label="取消" onClick={resetToDefault} variant="danger" />
        </div>
      )}

      {state === "preview" && optimizedText && (
        <div className="toolbar-preview">
          <div className="toolbar-preview-text">{previewText}</div>
          <div className="toolbar-preview-actions">
            <ToolbarButton icon="Check" label="替换" onClick={handleReplace} variant="primary" />
            <ToolbarButton icon="X" label="取消" onClick={resetToDefault} variant="danger" />
          </div>
        </div>
      )}

      {state === "error" && (
        <div className="toolbar-error" role="alert" aria-live="assertive">
          <Icon name="X" size={14} className="toolbar-error-icon" />
          <span className="toolbar-error-text">{errorMessage}</span>
          {errorMessage === "请先配置 AI" ? (
            <ToolbarButton icon="Settings" label="设置" onClick={handleGoSettings} variant="primary" />
          ) : (
            <ToolbarButton icon="Undo2" label="返回" onClick={resetToDefault} />
          )}
        </div>
      )}
    </div>
  );
}

export default FloatingToolbar;
