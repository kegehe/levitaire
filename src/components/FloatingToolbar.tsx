import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import QRCode from "qrcode";
import ToolbarButton from "./ToolbarButton";
import Icon from "./Icon";
import { SelectionInfo } from "../types";
import { OPTIMIZE_MODES, OptimizeMode } from "../constants/optimizeModes";
import { getEnabledFeatures, setEnabledFeatures } from "../constants/toolbarFeatures";
import { getDedupMode, setDedupMode, type DedupMode } from "../constants/dedupConfig";
import { dedup } from "../utils/dedup";
import { useAiOptimize } from "../hooks/useAiOptimize";
import "./FloatingToolbar.css";

/** 检测字符串是否为合法的 base64 编码 */
function isBase64(str: string): boolean {
  if (!str || str.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+=*$/.test(str)) return false;
  try {
    const decoded = atob(str);
    // 检查解码结果是否为有效的 UTF-8 文本（而非乱码）
    const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

type ToolbarState = "default" | "mode-select" | "loading" | "preview" | "error" | "qrcode-preview";

function FloatingToolbar() {
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [state, setState] = useState<ToolbarState>("default");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef<ToolbarState>("default");
  const optimizeInProgressRef = useRef(false);
  const pendingActionRef = useRef<"translate" | "optimize">("optimize");
  const containerRef = useRef<HTMLDivElement>(null);

  // 工具栏功能配置（响应式，监听设置窗口的变更事件）
  const [enabledFeatureIds, setEnabledFeatureIds] = useState<string[]>(getEnabledFeatures);

  // 去重粒度配置（响应式，监听设置窗口的变更事件）
  const [dedupMode, setDedupModeState] = useState<DedupMode>(getDedupMode);

  useLayoutEffect(() => {
    const theme = localStorage.getItem("floast-theme") || "light";
    document.documentElement.setAttribute("data-theme", theme);
    // 工具栏窗口：上方预留 tooltip 空间
    document.body.classList.add("toolbar-window");
    return () => { document.body.classList.remove("toolbar-window"); };
  }, []);

  // 监听设置窗口的主题和功能配置变更事件
  useEffect(() => {
    const unlistenTheme = listen<string>("floast-theme-changed", (event) => {
      document.documentElement.setAttribute("data-theme", event.payload);
      localStorage.setItem("floast-theme", event.payload);
    });
    const unlistenFeatures = listen<string[]>("floast-features-changed", (event) => {
      setEnabledFeatures(event.payload);
      setEnabledFeatureIds(event.payload);
    });
    const unlistenDedupMode = listen<DedupMode>("floast-dedup-mode-changed", (event) => {
      setDedupMode(event.payload);
      setDedupModeState(event.payload);
    });
    return () => {
      unlistenTheme.then((fn) => fn());
      unlistenFeatures.then((fn) => fn());
      unlistenDedupMode.then((fn) => fn());
    };
  }, []);

  const { optimize, cancel, isLoading, optimizedText, errorMessage: aiError, checkAiConfig } = useAiOptimize();
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);

  // 进入二维码预览时，先用已知最大尺寸扩窗，防止内容被裁切
  // 图片 onLoad 后再精确校准（见 handleQrImageLoad）
  useEffect(() => {
    if (state !== "qrcode-preview" || !qrCodeDataUrl) return;
    const win = getCurrentWebviewWindow();
    win.setSize(new LogicalSize(300, 300)).catch(() => {});
  }, [state, qrCodeDataUrl]);

  /** 图片加载完成后精确校准窗口尺寸（仅在二维码预览状态下有效） */
  const handleQrImageLoad = useCallback(() => {
    if (stateRef.current !== "qrcode-preview") return;
    const el = containerRef.current;
    if (!el) return;
    const PAD_BORDER_X = 18;
    const PAD_BORDER_Y = 14;
    const rect = el.getBoundingClientRect();
    const w = Math.ceil(rect.width + PAD_BORDER_X);
    const h = Math.ceil(rect.height + PAD_BORDER_Y);
    if (w > 0 && h > 0) {
      getCurrentWebviewWindow()
        .setSize(new LogicalSize(w, h))
        .catch(() => {});
    }
  }, []);

  // 状态变化或新选区时主动同步窗口尺寸（解决 ResizeObserver 在 WebView 中不触发的问题）
  // useLayoutEffect 在 DOM 更新后、浏览器绘制前同步执行，用户不会看到闪烁
  // 依赖 isVisible + selection：确保每次选区变化都能触发（state 可能保持 "default" 不变）
  useLayoutEffect(() => {
    if (!isVisible || !selection || state === "qrcode-preview") return;
    // qrcode-preview 状态由专用 useEffect + onLoad 管理
    const el = containerRef.current;
    if (!el) return;
    const PAD_BORDER_X = 18; // padding 8×2 + border 1×2
    const PAD_BORDER_Y = 14; // padding 6×2 + border 1×2
    const bodyPt = parseInt(getComputedStyle(document.body).paddingTop) || 0;
    const w = Math.ceil(el.scrollWidth + PAD_BORDER_X);
    const h = Math.ceil(el.scrollHeight + PAD_BORDER_Y + bodyPt);
    if (w > 0 && h > 0) {
      getCurrentWebviewWindow()
        .setSize(new LogicalSize(w, h))
        .catch(() => {});
    }
  }, [state, isVisible, selection]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const hideToolbar = useCallback(async () => {
    setIsVisible(false);
    setState("default");
    setQrCodeDataUrl(null);
    cancel();
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    invoke("set_qrcode_preview", { active: false }).catch(() => {});
    try {
      await invoke("hide_toolbar");
    } catch {
      getCurrentWebviewWindow().hide();
    }
  }, [cancel]);

  // ResizeObserver：内容尺寸变化时自动同步窗口大小
  // contentRect 是 content-box 尺寸，需加上 padding + border 得到窗口完整渲染尺寸
  // padding/border 是固定值（来自 CSS tokens），用常量避免每次读 getComputedStyle
  // --toolbar-padding-x: 8px, --toolbar-padding-y: 6px, border: 1px
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const win = getCurrentWebviewWindow();
    const PAD_BORDER_X = 18; // padding 8×2 + border 1×2
    const PAD_BORDER_Y = 14; // padding 6×2 + border 1×2
    const ro = new ResizeObserver(([entry]) => {
      // 二维码预览状态由 useEffect(扩窗) + onLoad(精调) 独立管理尺寸
      // 跳过避免 ResizeObserver 测量到图片加载前的瞬时小尺寸，把窗口缩回
      if (stateRef.current === "qrcode-preview") return;
      const bodyPt = parseInt(getComputedStyle(document.body).paddingTop) || 0;
      const w = Math.ceil(entry.contentRect.width + PAD_BORDER_X);
      const h = Math.ceil(entry.contentRect.height + PAD_BORDER_Y + bodyPt);
      if (w > 0 && h > 0) {
        win.setSize(new LogicalSize(w, h)).catch(() => {});
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const resetToDefault = useCallback(() => {
    setState("default");
    setQrCodeDataUrl(null);
    optimizeInProgressRef.current = false;
    cancel();
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
  }, [cancel]);

  useEffect(() => {
    const win = getCurrentWebviewWindow();

    const unlistenSelection = win.listen<SelectionInfo>("selection-found", (event) => {
      setSelection(event.payload);
      setIsVisible(true);
      setState("default");
      setQrCodeDataUrl(null);
      optimizeInProgressRef.current = false;
      cancel();
      if (errorTimerRef.current) {
        clearTimeout(errorTimerRef.current);
        errorTimerRef.current = null;
      }
    });

    // 点击工具栏外部时，Rust 侧隐藏窗口并 emit 此事件，前端同步重置状态
    const unlistenHidden = win.listen("toolbar-hidden", () => {
      setIsVisible(false);
      resetToDefault();
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const currentState = stateRef.current;
        if (currentState === "qrcode-preview") {
          invoke("set_qrcode_preview", { active: false }).catch(() => {});
          hideToolbar();
        } else if (currentState === "mode-select" || currentState === "preview" || currentState === "error") {
          resetToDefault();
        } else {
          hideToolbar();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      unlistenSelection.then((fn) => fn());
      unlistenHidden.then((fn) => fn());
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [cancel, hideToolbar, resetToDefault]);

  useEffect(() => {
    if (!isLoading && state === "loading") {
      if (aiError) {
        setState("error");
        setErrorMessage(aiError);
        if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
        errorTimerRef.current = setTimeout(() => {
          resetToDefault();
        }, 3000);
      } else if (optimizedText) {
        setState("preview");
      } else {
        resetToDefault();
      }
    }
  }, [isLoading, aiError, optimizedText, state, resetToDefault]);

  const handleCopy = async () => {
    if (selection) {
      try {
        // 使用模拟 Ctrl+C 复制，保留富文本和图片格式
        await invoke("copy_selection");
        hideToolbar();
      } catch (err) {
        console.error("Failed to copy:", err);
      }
    }
  };

  const handleSearch = async () => {
    if (selection) {
      const query = encodeURIComponent(selection.text.trim());
      const url = `https://www.bing.com/search?q=${query}`;
      try {
        await invoke("open_url", { url });
        hideToolbar();
      } catch (err) {
        console.error("Failed to open search:", err);
      }
    }
  };

  const handleUppercase = async () => {
    if (!selection) return;
    const result = selection.text.toUpperCase();
    try {
      await invoke("replace_selection", { text: result });
      // 保持工具栏显示，更新选中文本为转换结果，便于继续操作
      setSelection({ ...selection, text: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message
        : typeof err === "string" ? err
        : "替换失败，请重新选中文本";
      setState("error");
      setErrorMessage(msg);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => {
        resetToDefault();
      }, 3000);
    }
  };

  const handleLowercase = async () => {
    if (!selection) return;
    const result = selection.text.toLowerCase();
    try {
      await invoke("replace_selection", { text: result });
      setSelection({ ...selection, text: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message
        : typeof err === "string" ? err
        : "替换失败，请重新选中文本";
      setState("error");
      setErrorMessage(msg);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => {
        resetToDefault();
      }, 3000);
    }
  };

  const handleBase64Encode = async () => {
    if (!selection) return;
    const text = selection.text.trim();
    if (!text) return;
    let result: string;
    try {
      const bytes = new TextEncoder().encode(text);
      const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
      result = btoa(binary);
    } catch {
      setState("error");
      setErrorMessage("Base64 编码失败");
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => {
        resetToDefault();
      }, 3000);
      return;
    }
    try {
      await invoke("replace_selection", { text: result });
      setSelection({ ...selection, text: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message
        : typeof err === "string" ? err
        : "替换失败，请重新选中文本";
      setState("error");
      setErrorMessage(msg);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => {
        resetToDefault();
      }, 3000);
    }
  };

  const handleBase64Decode = async () => {
    if (!selection) return;
    const text = selection.text.trim();
    if (!text) return;
    let result: string;
    try {
      const decoded = atob(text);
      const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
      result = new TextDecoder("utf-8").decode(bytes);
    } catch {
      setState("error");
      setErrorMessage("Base64 解码失败");
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => {
        resetToDefault();
      }, 3000);
      return;
    }
    try {
      await invoke("replace_selection", { text: result });
      setSelection({ ...selection, text: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message
        : typeof err === "string" ? err
        : "替换失败，请重新选中文本";
      setState("error");
      setErrorMessage(msg);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => {
        resetToDefault();
      }, 3000);
    }
  };

  const handleDedup = async () => {
    if (!selection) return;
    const result = dedup(selection.text, dedupMode);
    // 后端 replace_selection 拒绝空字符串，去重结果为空时直接返回
    if (!result) return;
    try {
      await invoke("replace_selection", { text: result });
      setSelection({ ...selection, text: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message
        : typeof err === "string" ? err
        : "替换失败，请重新选中文本";
      setState("error");
      setErrorMessage(msg);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => {
        resetToDefault();
      }, 3000);
    }
  };

  const handleQrCode = async () => {
    if (!selection?.text) return;
    const text = selection.text.trim();
    if (!text) return;
    // QR 码 UTF-8 字节上限约 2953，超出时截断
    const MAX_BYTES = 2900;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(text);
    let content = text;
    if (bytes.length > MAX_BYTES) {
      // 回退到有效 UTF-8 边界：跳过尾部不完整的多字节序列
      let end = MAX_BYTES;
      while (end > 0 && (bytes[end] & 0xC0) === 0x80) {
        end--;
      }
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, end));
    }
    try {
      const dataUrl = await QRCode.toDataURL(content, {
        width: 256,
        margin: 2,
        errorCorrectionLevel: "M",
        color: {
          dark: "#000000",
          light: "#ffffff",
        },
      });
      setQrCodeDataUrl(dataUrl);
      setState("qrcode-preview");
      invoke("set_qrcode_preview", { active: true }).catch(() => {});
    } catch {
      setState("error");
      setErrorMessage("生成二维码失败");
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => {
        resetToDefault();
      }, 3000);
    }
  };

  const handleTranslate = async () => {
    if (!selection || isLoading || optimizeInProgressRef.current) return;
    optimizeInProgressRef.current = true;
    const config = await checkAiConfig();
    if (!config || !config.api_key || config.api_key.trim().length === 0) {
      setState("error");
      setErrorMessage("请先配置 AI");
      optimizeInProgressRef.current = false;
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => {
        resetToDefault();
      }, 5000);
      return;
    }
    pendingActionRef.current = "translate";
    setState("loading");
    optimizeInProgressRef.current = false;
    const translateMode = OPTIMIZE_MODES.find((m) => m.id === "translate")!;
    await optimize(selection.text, translateMode);
  };

  const handleOptimizeClick = async () => {
    if (optimizeInProgressRef.current) return;
    optimizeInProgressRef.current = true;

    const config = await checkAiConfig();
    if (!config || !config.api_key || config.api_key.trim().length === 0) {
      setState("error");
      setErrorMessage("请先配置 AI");
      optimizeInProgressRef.current = false;
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => {
        resetToDefault();
      }, 5000);
      return;
    }
    pendingActionRef.current = "optimize";
    setState("mode-select");
    optimizeInProgressRef.current = false;
  };

  const handleModeSelect = async (mode: OptimizeMode) => {
    if (!selection || isLoading) return;
    pendingActionRef.current = "optimize";
    setState("loading");
    await optimize(selection.text, mode);
  };

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
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => {
        resetToDefault();
      }, 3000);
    }
  };

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

  const previewText = optimizedText && optimizedText.length > 500
    ? optimizedText.slice(0, 500) + "..."
    : optimizedText;

  return (
    <div ref={containerRef} id="toolbar" className="toolbar-container" role="toolbar" aria-label="文本操作工具栏">
      <div className="toolbar-drag-handle" data-tauri-drag-region aria-hidden="true" />
      {state === "default" && (
        <>
          {enabledFeatureIds.includes("copy") && (
            <ToolbarButton icon="Copy" label="复制" onClick={handleCopy} />
          )}
          {/* 纯图片选区时只显示复制按钮 */}
          {!(selection["has-image"] && !selection.text) && (
            <>
              {enabledFeatureIds.includes("search") && (
                <ToolbarButton icon="Search" label="搜索" onClick={handleSearch} />
              )}
              {enabledFeatureIds.includes("translate") && (
                <ToolbarButton icon="Globe" label="翻译" onClick={handleTranslate} />
              )}
              {enabledFeatureIds.includes("optimize") && (
                <ToolbarButton icon="Sparkles" label="优化" onClick={handleOptimizeClick} />
              )}
              {enabledFeatureIds.includes("uppercase") && (
                <ToolbarButton icon="CaseUpper" label="大写" onClick={handleUppercase} />
              )}
              {enabledFeatureIds.includes("lowercase") && (
                <ToolbarButton icon="CaseLower" label="小写" onClick={handleLowercase} />
              )}
              {enabledFeatureIds.includes("dedup") && (
                <ToolbarButton icon="ListFilter" label="去重" onClick={handleDedup} />
              )}
              {enabledFeatureIds.includes("qrcode") && selection.text.trim() && (
                <ToolbarButton icon="QrCode" label="二维码" onClick={handleQrCode} />
              )}
              {enabledFeatureIds.includes("base64-encode") && (
                <ToolbarButton icon="Binary" label="编码" onClick={handleBase64Encode} />
              )}
              {enabledFeatureIds.includes("base64-decode") && isBase64(selection.text.trim()) && (
                <ToolbarButton icon="Binary" label="解码" onClick={handleBase64Decode} />
              )}
            </>
          )}
        </>
      )}

      {state === "mode-select" && (
        <div className="toolbar-mode-select">
          <ToolbarButton icon="ArrowLeft" label="返回" onClick={resetToDefault} />
          <div className="toolbar-mode-divider" />
          {OPTIMIZE_MODES.filter((m) => m.id !== "translate").map((mode) => (
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
          {optimizedText ? (
            <div className="toolbar-preview">
              <div className="toolbar-preview-text streaming">{previewText || optimizedText}</div>
              <div className="toolbar-preview-actions">
                <ToolbarButton icon="X" label="取消" onClick={resetToDefault} variant="danger" />
              </div>
            </div>
          ) : (
            <>
              <ToolbarButton icon={pendingActionRef.current === "translate" ? "Globe" : "Sparkles"} label={pendingActionRef.current === "translate" ? "翻译中..." : "优化中..."} onClick={() => {}} loading />
              <ToolbarButton icon="X" label="取消" onClick={resetToDefault} variant="danger" />
            </>
          )}
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

      {state === "qrcode-preview" && qrCodeDataUrl && (
        <div className="toolbar-qrcode">
          <img src={qrCodeDataUrl} alt="二维码" className="toolbar-qrcode-image" onLoad={handleQrImageLoad} />
          <div className="toolbar-preview-actions">
            <ToolbarButton icon="Download" label="下载" onClick={async () => {
              try {
                await invoke<boolean>("save_image", {
                  base64Data: qrCodeDataUrl,
                  filename: "qrcode.png",
                });
              } catch (err) {
                setState("error");
                setErrorMessage("下载二维码失败");
                if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
                errorTimerRef.current = setTimeout(() => {
                  resetToDefault();
                }, 3000);
              }
            }} />
            <ToolbarButton icon="Copy" label="复制" onClick={async () => {
              try {
                const resp = await fetch(qrCodeDataUrl);
                const blob = await resp.blob();
                if (navigator.clipboard && typeof ClipboardItem !== "undefined") {
                  await navigator.clipboard.write([
                    new ClipboardItem({ "image/png": blob }),
                  ]);
                  hideToolbar();
                } else {
                  setState("error");
                  setErrorMessage("当前环境不支持复制图片");
                  if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
                  errorTimerRef.current = setTimeout(() => {
                    resetToDefault();
                  }, 3000);
                }
              } catch (err) {
                console.error("复制二维码失败:", err);
                setState("error");
                setErrorMessage("复制二维码失败");
                if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
                errorTimerRef.current = setTimeout(() => {
                  resetToDefault();
                }, 3000);
              }
            }} variant="primary" />
            <ToolbarButton icon="X" label="关闭" onClick={() => {
              invoke("set_qrcode_preview", { active: false }).catch(() => {});
              hideToolbar();
            }} variant="danger" />
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
