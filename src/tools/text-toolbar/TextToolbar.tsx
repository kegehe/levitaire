import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import ToolbarButton from "../../components/ToolbarButton";
import Icon from "../../components/Icon";
import { SelectionInfo } from "../../types";
import { OPTIMIZE_MODES, OptimizeMode } from "../../constants/optimizeModes";
import { DEFAULT_FEATURE_IDS, fetchEnabledFeatures } from "../../constants/toolbarFeatures";
import { DEFAULT_DEDUP_MODE, fetchDedupMode, type DedupMode } from "../../constants/dedupConfig";
import { DEFAULT_MD5_LENGTH, fetchMd5Length, type Md5Length } from "../../constants/md5Config";
import {
  DEFAULT_NUMBERING_STYLE,
  fetchNumberingStyle,
  type NumberingStyle,
} from "../../constants/numberingConfig";
import {
  DEFAULT_TTS_CONFIG,
  fetchTtsConfig,
  rateToSpeakingRate,
  type TtsConfig,
} from "../../constants/ttsConfig";
import { CLEAR_OPTIONS, DEFAULT_CLEAR_IDS, fetchClearOptions } from "../../constants/clearConfig";
import {
  DEFAULT_SEARCH_ENGINE,
  fetchSearchEngine,
  buildSearchUrl,
  type SearchEngineId,
} from "../../constants/searchEngineConfig";
import { dedup } from "../../utils/dedup";
import { clearText } from "../../utils/clearText";
import { charCount } from "../../utils/charCount";
import { numbering } from "../../utils/numbering";
import { useAiOptimize } from "../../hooks/useAiOptimize";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../../styles/themePreferences";
import "./TextToolbar.css";

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

/** 检测字符串是否包含合法的 Unicode 转义序列（\uXXXX / \u{XXXXX} / U+XXXX） */
function isUnicodeEscaped(str: string): boolean {
  // U+ 前加 \b 词边界，避免匹配 "CPU+4E2D" 中的 U+4E2D
  return /\\u\{[0-9a-fA-F]{1,6}\}|\\u[0-9a-fA-F]{4}|\bU\+[0-9a-fA-F]{4,6}/.test(str);
}

/** 将 invoke 抛出的错误规整为可展示的字符串 */
function toErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : typeof err === "string" ? err : fallback;
}

/** 毫秒数格式化为 m:ss（非法值显示 0:00） */
function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type ToolbarState =
  | "default"
  | "mode-select"
  | "clear-select"
  | "loading"
  | "preview"
  | "error"
  | "qrcode-preview"
  | "charcount-preview"
  | "speaking";

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

  // 工具栏功能配置（默认全量，挂载后从后端异步加载；监听设置窗口的变更事件）
  const [enabledFeatureIds, setEnabledFeatureIds] = useState<string[]>(DEFAULT_FEATURE_IDS);

  // 去重粒度配置（默认按行，挂载后从后端异步加载；监听设置窗口的变更事件）
  const [dedupMode, setDedupModeState] = useState<DedupMode>(DEFAULT_DEDUP_MODE);

  // MD5 位数配置（默认 32 位，挂载后从后端异步加载；监听设置窗口的变更事件）
  const [md5Length, setMd5LengthState] = useState<Md5Length>(DEFAULT_MD5_LENGTH);

  // 编号样式配置（默认数字 1. 2. 3.，挂载后从后端异步加载；监听设置窗口的变更事件）
  const [numberingStyle, setNumberingStyleState] =
    useState<NumberingStyle>(DEFAULT_NUMBERING_STYLE);

  // 朗读配置（默认正常语速/系统默认语音/满音量，挂载后从后端异步加载；监听设置窗口的变更事件）
  const [ttsConfig, setTtsConfigState] = useState<TtsConfig>(DEFAULT_TTS_CONFIG);
  // 朗读运行态：ttsPlaying=有播放任务在跑，ttsPaused=当前暂停
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const [ttsPaused, setTtsPaused] = useState(false);
  // 朗读进度（毫秒）；ttsDurationMs 为 0 表示总时长未知
  const [ttsPositionMs, setTtsPositionMs] = useState(0);
  const [ttsDurationMs, setTtsDurationMs] = useState(0);

  // 清除功能启用的清除项 ID 列表（默认全量，挂载后从后端异步加载；监听设置窗口的变更事件）
  const [enabledClearIds, setEnabledClearIds] = useState<string[]>(DEFAULT_CLEAR_IDS);

  // 搜索引擎配置（默认必应，挂载后从后端异步加载；监听设置窗口的变更事件）
  const [searchEngine, setSearchEngine] = useState<SearchEngineId>(DEFAULT_SEARCH_ENGINE);

  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
    // 工具栏窗口：上方预留 tooltip 空间
    document.body.classList.add("toolbar-window");
    return () => {
      document.body.classList.remove("toolbar-window");
    };
  }, []);

  // 监听设置窗口的主题和功能配置变更事件
  useEffect(() => {
    // 并行加载跨窗口持久化配置（减少串行 IPC 往返延迟）
    Promise.allSettled([
      fetchEnabledFeatures(),
      fetchDedupMode(),
      fetchMd5Length(),
      fetchNumberingStyle(),
      fetchTtsConfig(),
      fetchClearOptions(),
      fetchSearchEngine(),
    ]).then(([features, dedup, md5, numbering, tts, clear, search]) => {
      if (features.status === "fulfilled") setEnabledFeatureIds(features.value);
      if (dedup.status === "fulfilled") setDedupModeState(dedup.value);
      if (md5.status === "fulfilled") setMd5LengthState(md5.value);
      if (numbering.status === "fulfilled") setNumberingStyleState(numbering.value);
      if (tts.status === "fulfilled") setTtsConfigState(tts.value);
      if (clear.status === "fulfilled") setEnabledClearIds(clear.value);
      if (search.status === "fulfilled") setSearchEngine(search.value);
    });

    const unlistenTheme = subscribeThemePreferences();
    const unlistenFeatures = listen<string[]>("levitaire-features-changed", (event) => {
      setEnabledFeatureIds(event.payload);
    });
    const unlistenDedupMode = listen<DedupMode>("levitaire-dedup-mode-changed", (event) => {
      setDedupModeState(event.payload);
    });
    const unlistenMd5Length = listen<Md5Length>("levitaire-md5-length-changed", (event) => {
      setMd5LengthState(event.payload);
    });
    const unlistenNumberingStyle = listen<NumberingStyle>(
      "levitaire-numbering-style-changed",
      (event) => {
        setNumberingStyleState(event.payload);
      },
    );
    const unlistenTtsConfig = listen<TtsConfig>("levitaire-tts-config-changed", (event) => {
      setTtsConfigState(event.payload);
    });
    const unlistenClearOptions = listen<string[]>("levitaire-clear-options-changed", (event) => {
      setEnabledClearIds(event.payload);
    });
    const unlistenSearchEngine = listen<SearchEngineId>(
      "levitaire-search-engine-changed",
      (event) => {
        setSearchEngine(event.payload);
      },
    );
    return () => {
      unlistenTheme.then((fn) => fn());
      unlistenFeatures.then((fn) => fn());
      unlistenDedupMode.then((fn) => fn());
      unlistenMd5Length.then((fn) => fn());
      unlistenNumberingStyle.then((fn) => fn());
      unlistenTtsConfig.then((fn) => fn());
      unlistenClearOptions.then((fn) => fn());
      unlistenSearchEngine.then((fn) => fn());
    };
  }, []);

  const {
    optimize,
    cancel,
    isLoading,
    optimizedText,
    errorMessage: aiError,
    checkAiConfig,
  } = useAiOptimize();
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
    const PAD_BORDER_X = 22; // padding 8×2 + border 1×2 + 拖拽手柄净增(width 14→16 + margin-right 0→2 = 4)
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
    const PAD_BORDER_X = 22; // padding 8×2 + border 1×2 + 拖拽手柄净增(width 14→16 + margin-right 0→2 = 4)
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
    setTtsPositionMs(0);
    setTtsDurationMs(0);
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
  }, [cancel]);

  // Esc 关闭逻辑：默认态隐藏工具栏；子菜单/预览/朗读等态返回默认态；二维码预览态退出并隐藏。
  // 工具栏窗口 focusable=false，页面内 DOM keydown 收不到按键，该逻辑实际由
  // Rust 全局键盘钩子转发的 toolbar-esc 事件驱动（DOM 监听保留，窗口未来可聚焦时同样生效）。
  const handleEscape = useCallback(() => {
    const currentState = stateRef.current;
    if (currentState === "qrcode-preview") {
      invoke("set_qrcode_preview", { active: false }).catch(() => {});
      hideToolbar();
    } else if (
      currentState === "mode-select" ||
      currentState === "clear-select" ||
      currentState === "preview" ||
      currentState === "charcount-preview" ||
      currentState === "error" ||
      currentState === "speaking"
    ) {
      resetToDefault();
    } else {
      hideToolbar();
    }
  }, [hideToolbar, resetToDefault]);

  // 错误提示：进入 error 态并安排定时器自动恢复默认状态
  const showError = useCallback(
    (message: string, duration = 3000) => {
      setState("error");
      setErrorMessage(message);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => {
        resetToDefault();
      }, duration);
    },
    [resetToDefault],
  );

  // 写回选区：成功后同步选中文本，失败时统一进入错误提示
  const replaceSelectionText = useCallback(
    async (text: string, fallback = "替换失败，请重新选中文本") => {
      if (!selection) return false;
      try {
        await invoke("replace_selection", { text });
        setSelection({ ...selection, text });
        return true;
      } catch (err) {
        showError(toErrorMessage(err, fallback));
        return false;
      }
    },
    [selection, showError],
  );

  useEffect(() => {
    const win = getCurrentWebviewWindow();

    const unlistenSelection = win.listen<SelectionInfo>("selection-found", async (event) => {
      setSelection(event.payload);
      setIsVisible(true);
      setQrCodeDataUrl(null);
      optimizeInProgressRef.current = false;
      cancel();
      if (errorTimerRef.current) {
        clearTimeout(errorTimerRef.current);
        errorTimerRef.current = null;
      }
      // 状态恢复：工具栏隐藏期间朗读可能仍在进行，按后端真值恢复 speaking 态
      // （朗读生命周期与工具栏窗口解耦——hideToolbar 不停止朗读）
      try {
        const st = await invoke<{ hasPlayer: boolean; paused: boolean; playing: boolean }>(
          "tts_get_state",
        );
        if (st.hasPlayer) {
          setState("speaking");
          setTtsPlaying(true);
          setTtsPaused(st.paused);
          // 进度由 speaking 态轮询即时获取，先清零避免展示上一轮的残留值
          setTtsPositionMs(0);
          setTtsDurationMs(0);
        } else {
          setTtsPlaying(false);
          setTtsPaused(false);
          setState("default");
        }
      } catch {
        setTtsPlaying(false);
        setTtsPaused(false);
        setState("default");
      }
    });

    // 点击工具栏外部时，Rust 侧隐藏窗口并 emit 此事件，前端同步重置状态
    const unlistenHidden = win.listen("toolbar-hidden", () => {
      setIsVisible(false);
      resetToDefault();
    });

    // 朗读自然结束（MediaEnded）→ 退出 speaking 态（幂等：停止/手动结束都会触发）
    const unlistenTtsFinished = win.listen("tts-finished", () => {
      setTtsPlaying(false);
      setTtsPaused(false);
      if (stateRef.current === "speaking") {
        resetToDefault();
      }
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleEscape();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    // 工具栏窗口 focusable=false，DOM keydown 收不到按键；
    // 由 Rust 全局键盘钩子在工具栏可见时转发 toolbar-esc 事件。
    const unlistenEsc = win.listen("toolbar-esc", handleEscape);

    return () => {
      unlistenSelection.then((fn) => fn());
      unlistenHidden.then((fn) => fn());
      unlistenTtsFinished.then((fn) => fn());
      unlistenEsc.then((fn) => fn());
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [cancel, hideToolbar, resetToDefault, handleEscape]);

  useEffect(() => {
    if (!isLoading && state === "loading") {
      if (aiError) {
        showError(aiError);
      } else if (optimizedText) {
        setState("preview");
      } else {
        resetToDefault();
      }
    }
  }, [isLoading, aiError, optimizedText, state, resetToDefault, showError]);

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
      const url = buildSearchUrl(searchEngine, selection.text.trim());
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
    await replaceSelectionText(selection.text.toUpperCase());
  };

  const handleLowercase = async () => {
    if (!selection) return;
    await replaceSelectionText(selection.text.toLowerCase());
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
      showError("Base64 编码失败");
      return;
    }
    await replaceSelectionText(result);
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
      showError("Base64 解码失败");
      return;
    }
    await replaceSelectionText(result);
  };

  const handleUnicodeEncode = async () => {
    if (!selection) return;
    const text = selection.text.trim();
    if (!text) return;
    // 按码点迭代以正确处理 BMP 外字符（如 emoji 的代理对）
    // BMP 内字符输出 \uXXXX；BMP 外字符输出 \u{XXXXX}（4~6 位 hex）
    const result = Array.from(text)
      .map((ch) => {
        const cp = ch.codePointAt(0)!;
        if (cp > 0xffff) {
          return `\\u{${cp.toString(16).toUpperCase()}}`;
        }
        return `\\u${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      })
      .join("");
    await replaceSelectionText(result);
  };

  const handleUnicodeDecode = async () => {
    if (!selection) return;
    const text = selection.text.trim();
    if (!text) return;
    let result: string;
    try {
      result = text
        // \u{XXXXX}（含 BMP 外）
        .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, h: string) =>
          String.fromCodePoint(parseInt(h, 16)),
        )
        // \uXXXX（BMP）
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
        // U+XXXX / U+XXXXX 形式（\b 防止 "CPU+4E2D" 被误匹配）
        .replace(/\bU\+([0-9a-fA-F]{4,6})/g, (_, h: string) =>
          String.fromCodePoint(parseInt(h, 16)),
        );
    } catch {
      showError("Unicode 解码失败");
      return;
    }
    await replaceSelectionText(result);
  };

  const handleMd5Encrypt = async () => {
    if (!selection) return;
    const text = selection.text.trim();
    if (!text) return;
    try {
      // 32 位 hex：md5 全量输出；16 位 hex：取 32 位结果的 substring(8,24)
      // （第 9~24 字符，共 16 位），与 PHP substr(md5(s),8,16) 一致
      const { md5 } = await import("js-md5");
      const full = md5(text);
      const result = md5Length === "32" ? full : full.substring(8, 24);
      await replaceSelectionText(result, "MD5 加密失败，请重试");
    } catch (err) {
      // 仅动态 import 失败会走到这里（写回失败已在 replaceSelectionText 内处理）
      showError(toErrorMessage(err, "MD5 加密失败，请重试"));
    }
  };

  const handleDedup = async () => {
    if (!selection) return;
    const result = dedup(selection.text, dedupMode);
    // 后端 replace_selection 拒绝空字符串，去重结果为空时直接返回
    if (!result) return;
    await replaceSelectionText(result);
  };

  // 按当前样式对选中文本编号后写回选区，保持工具栏显示便于连续操作
  const handleNumbering = async () => {
    if (!selection) return;
    const result = numbering(selection.text, numberingStyle);
    // 后端 replace_selection 拒绝空字符串，结果为空时直接返回
    if (!result) return;
    await replaceSelectionText(result);
  };

  // 朗读选中文本：合成在后端 MTA 子线程执行，成功后切 speaking 态
  const handleSpeak = async () => {
    if (!selection?.text?.trim()) return;
    try {
      await invoke("tts_speak", {
        text: selection.text,
        rate: rateToSpeakingRate(ttsConfig.rate),
        voiceId: ttsConfig.voiceId,
        volume: ttsConfig.volume,
      });
      setTtsPlaying(true);
      setTtsPaused(false);
      setTtsPositionMs(0);
      setTtsDurationMs(0);
      setState("speaking");
    } catch (err) {
      showError(toErrorMessage(err, "朗读失败"));
    }
  };

  const handleTtsPause = async () => {
    try {
      await invoke("tts_pause");
      setTtsPaused(true);
    } catch (err) {
      console.error("Failed to pause tts:", err);
    }
  };

  const handleTtsResume = async () => {
    try {
      await invoke("tts_resume");
      setTtsPaused(false);
    } catch (err) {
      console.error("Failed to resume tts:", err);
    }
  };

  // 停止朗读：后端 Close 销毁 player，前端退出 speaking 态
  const handleTtsStop = async () => {
    try {
      await invoke("tts_stop");
    } catch (err) {
      console.error("Failed to stop tts:", err);
    }
    setTtsPlaying(false);
    setTtsPaused(false);
    resetToDefault();
  };

  // 朗读进度轮询：speaking 态下每 500ms 查询后端进度刷新进度条与时长显示。
  // 注意：不在轮询中同步 paused——前端暂停/继续由用户操作驱动，
  // 轮询读到的 paused 可能与点击瞬间的在途请求竞态，导致按钮短暂闪烁；
  // 暂停态恢复由 selection-found 时的 tts_get_state 负责。
  useEffect(() => {
    if (state !== "speaking" || !ttsPlaying) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const p = await invoke<{ positionMs: number; durationMs: number; paused: boolean }>(
          "tts_get_progress",
        );
        if (cancelled) return;
        setTtsPositionMs(p.positionMs);
        setTtsDurationMs(p.durationMs);
      } catch {
        // 无朗读进度（可能刚结束/暂无 player），保持现有显示
      }
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state, ttsPlaying]);

  // 进入清除子菜单（与"优化"的 mode-select 同构，无需 AI 配置检查）
  const handleClearClick = () => {
    setState("clear-select");
  };

  // 执行具体清除项：按 optionId 正则替换后写回选区，保持工具栏显示便于连续操作
  const handleClearSelect = async (optionId: string) => {
    if (!selection) return;
    const result = clearText(selection.text, optionId as Parameters<typeof clearText>[1]);
    // 后端 replace_selection 拒绝空字符串，清除结果为空时直接返回
    if (!result) {
      resetToDefault();
      return;
    }
    const ok = await replaceSelectionText(result);
    if (ok) setState("default");
  };

  // 进入字符统计预览：纯前端展示，不修改原文本
  const handleCharCount = () => {
    if (!selection?.text?.trim()) return;
    setState("charcount-preview");
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
      while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
        end--;
      }
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, end));
    }
    try {
      const { toDataURL } = await import("qrcode");
      const dataUrl = await toDataURL(content, {
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
      showError("生成二维码失败");
    }
  };

  const handleTranslate = async () => {
    if (!selection || isLoading || optimizeInProgressRef.current) return;
    optimizeInProgressRef.current = true;
    const config = await checkAiConfig();
    if (!config || !config.api_key || config.api_key.trim().length === 0) {
      showError("请先配置 AI", 5000);
      optimizeInProgressRef.current = false;
      return;
    }
    pendingActionRef.current = "translate";
    setState("loading");
    const translateMode = OPTIMIZE_MODES.find((m) => m.id === "translate")!;
    try {
      await optimize(selection.text, translateMode);
    } finally {
      // 仅在 optimize 真正结束后释放守卫；此前 await 期间二次点击会被拦截，
      // 避免 loadingRef 尚未置 true 的窗口期被穿透发起第二个 call_ai_stream。
      optimizeInProgressRef.current = false;
    }
  };

  const handleOptimizeClick = async () => {
    if (optimizeInProgressRef.current) return;
    optimizeInProgressRef.current = true;

    const config = await checkAiConfig();
    if (!config || !config.api_key || config.api_key.trim().length === 0) {
      showError("请先配置 AI", 5000);
      optimizeInProgressRef.current = false;
      return;
    }
    pendingActionRef.current = "optimize";
    setState("mode-select");
    optimizeInProgressRef.current = false;
  };

  const handleModeSelect = async (mode: OptimizeMode) => {
    if (!selection || isLoading || optimizeInProgressRef.current) return;
    optimizeInProgressRef.current = true;
    pendingActionRef.current = "optimize";
    setState("loading");
    try {
      await optimize(selection.text, mode);
    } finally {
      optimizeInProgressRef.current = false;
    }
  };

  const handleReplace = async () => {
    if (!optimizedText) return;
    const ok = await replaceSelectionText(optimizedText, "无法替换，请重新选中文本");
    if (ok) hideToolbar();
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

  const previewText =
    optimizedText && optimizedText.length > 500
      ? optimizedText.slice(0, 500) + "..."
      : optimizedText;

  return (
    <div
      ref={containerRef}
      id="toolbar"
      className="toolbar-container"
      role="toolbar"
      aria-label="文本操作工具栏"
    >
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
              {enabledFeatureIds.includes("numbering") && (
                <ToolbarButton icon="ListOrdered" label="编号" onClick={handleNumbering} />
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
              {enabledFeatureIds.includes("unicode-encode") && selection.text.trim() && (
                <ToolbarButton icon="Type" label="转Unicode" onClick={handleUnicodeEncode} />
              )}
              {enabledFeatureIds.includes("unicode-decode") &&
                isUnicodeEscaped(selection.text.trim()) && (
                  <ToolbarButton icon="Type" label="转中文" onClick={handleUnicodeDecode} />
                )}
              {enabledFeatureIds.includes("md5-encrypt") && selection.text.trim() && (
                <ToolbarButton icon="Hash" label="MD5" onClick={handleMd5Encrypt} />
              )}
              {enabledFeatureIds.includes("char-count") && selection.text.trim() && (
                <ToolbarButton icon="Calculator" label="统计" onClick={handleCharCount} />
              )}
              {enabledFeatureIds.includes("tts") && selection.text.trim() && (
                <ToolbarButton icon="Volume2" label="朗读" onClick={handleSpeak} />
              )}
              {enabledFeatureIds.includes("clear") && (
                <ToolbarButton icon="RemoveFormatting" label="清除" onClick={handleClearClick} />
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

      {state === "clear-select" && (
        <div className="toolbar-mode-select">
          <ToolbarButton icon="ArrowLeft" label="返回" onClick={resetToDefault} />
          <div className="toolbar-mode-divider" />
          {CLEAR_OPTIONS.filter((o) => enabledClearIds.includes(o.id)).map((option) => (
            <ToolbarButton
              key={option.id}
              icon={option.icon}
              label={option.label}
              onClick={() => handleClearSelect(option.id)}
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
              <ToolbarButton
                icon={pendingActionRef.current === "translate" ? "Globe" : "Sparkles"}
                label={pendingActionRef.current === "translate" ? "翻译中..." : "优化中..."}
                onClick={() => {}}
                loading
              />
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
          <img
            src={qrCodeDataUrl}
            alt="二维码"
            className="toolbar-qrcode-image"
            onLoad={handleQrImageLoad}
          />
          <div className="toolbar-preview-actions">
            <ToolbarButton
              icon="Download"
              label="下载"
              onClick={async () => {
                try {
                  await invoke<boolean>("save_image", {
                    base64Data: qrCodeDataUrl,
                    filename: "qrcode.png",
                  });
                } catch (_err) {
                  showError("下载二维码失败");
                }
              }}
            />
            <ToolbarButton
              icon="Copy"
              label="复制"
              onClick={async () => {
                try {
                  const resp = await fetch(qrCodeDataUrl);
                  const blob = await resp.blob();
                  if (navigator.clipboard && typeof ClipboardItem !== "undefined") {
                    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
                    hideToolbar();
                  } else {
                    showError("当前环境不支持复制图片");
                  }
                } catch (err) {
                  console.error("复制二维码失败:", err);
                  showError("复制二维码失败");
                }
              }}
              variant="primary"
            />
            <ToolbarButton
              icon="X"
              label="关闭"
              onClick={() => {
                invoke("set_qrcode_preview", { active: false }).catch(() => {});
                hideToolbar();
              }}
              variant="danger"
            />
          </div>
        </div>
      )}

      {state === "charcount-preview" &&
        selection?.text &&
        (() => {
          const stats = charCount(selection.text);
          const bytesDisplay =
            stats.bytes >= 1024 ? `${(stats.bytes / 1024).toFixed(2)} KB` : `${stats.bytes} B`;
          const items: { label: string; value: string | number; primary?: boolean }[] = [
            { label: "字符数(含空格)", value: stats.charsWithSpaces, primary: true },
            { label: "字符数(不含空格)", value: stats.charsNoSpaces },
            { label: "字数", value: stats.words },
            { label: "行数", value: stats.lines },
            { label: "非空行", value: stats.nonEmptyLines },
            { label: "段落数", value: stats.paragraphs },
            { label: "句子数", value: stats.sentences },
            { label: "字节", value: bytesDisplay },
            { label: "数字串", value: stats.digits },
            { label: "标点", value: stats.punctuation },
            { label: "字母", value: stats.letters },
          ];
          return (
            <div className="toolbar-charcount" role="group" aria-label="文本统计">
              <div className="toolbar-charcount-grid">
                {items.map((it) => (
                  <div
                    className={
                      "toolbar-charcount-item" +
                      (it.primary ? " toolbar-charcount-item--primary" : "")
                    }
                    key={it.label}
                  >
                    <span className="toolbar-charcount-label">{it.label}</span>
                    <span className="toolbar-charcount-value">{it.value}</span>
                  </div>
                ))}
              </div>
              <div className="toolbar-preview-actions">
                <ToolbarButton icon="X" label="关闭" onClick={resetToDefault} variant="danger" />
              </div>
            </div>
          );
        })()}

      {state === "speaking" && ttsPlaying && (
        <div className="toolbar-tts">
          <div className="toolbar-tts-controls">
            {ttsPaused ? (
              <ToolbarButton icon="Play" label="继续" onClick={handleTtsResume} variant="primary" />
            ) : (
              <ToolbarButton icon="Pause" label="暂停" onClick={handleTtsPause} />
            )}
            <ToolbarButton icon="Square" label="停止" onClick={handleTtsStop} variant="danger" />
          </div>
          <div className="toolbar-tts-progress" role="group" aria-label="朗读进度">
            <span className="toolbar-tts-time">{formatTime(ttsPositionMs)}</span>
            <div
              className="toolbar-tts-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={ttsDurationMs > 0 ? ttsDurationMs : undefined}
              aria-valuenow={ttsDurationMs > 0 ? Math.min(ttsPositionMs, ttsDurationMs) : undefined}
            >
              <div
                className="toolbar-tts-bar-fill"
                style={{
                  width:
                    ttsDurationMs > 0
                      ? `${Math.min((ttsPositionMs / ttsDurationMs) * 100, 100)}%`
                      : "0%",
                }}
              />
            </div>
            <span className="toolbar-tts-time">
              {ttsDurationMs > 0 ? formatTime(ttsDurationMs) : "--:--"}
            </span>
          </div>
        </div>
      )}

      {state === "error" && (
        <div className="toolbar-error" role="alert" aria-live="assertive">
          <Icon name="X" size={14} className="toolbar-error-icon" />
          <span className="toolbar-error-text">{errorMessage}</span>
          {errorMessage === "请先配置 AI" ? (
            <ToolbarButton
              icon="Settings"
              label="设置"
              onClick={handleGoSettings}
              variant="primary"
            />
          ) : (
            <ToolbarButton icon="Undo2" label="返回" onClick={resetToDefault} />
          )}
        </div>
      )}
    </div>
  );
}

export default FloatingToolbar;
