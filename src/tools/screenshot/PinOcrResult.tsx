import { useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Copy, Globe, Search, X } from "lucide-react";

import { OPTIMIZE_MODES } from "../../constants/optimizeModes";
import {
  buildSearchUrl,
  DEFAULT_SEARCH_ENGINE,
  fetchSearchEngine,
  type SearchEngineId,
} from "../../constants/searchEngineConfig";
import { useAiOptimize } from "../../hooks/useAiOptimize";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../../styles/themePreferences";

import "./PinOcrResult.css";

interface Payload {
  pinId: number;
  text?: string;
  error?: string;
}

const TRANSLATE_MODE = OPTIMIZE_MODES.find((m) => m.id === "translate")!;

export default function PinOcrResult() {
  // getCurrentWebviewWindow() 每次调用都返回新对象，必须 memo 化（它是 effect 的依赖）
  const win = useMemo(() => getCurrentWebviewWindow(), []);
  const [text, setText] = useState("");
  // ocrError：OCR 识别失败（结果窗口无文本可看，直接覆盖内容区）
  const [ocrError, setOcrError] = useState("");
  // actionError：翻译/搜索等后续操作的提示（保留文本区，可关闭）
  const [actionError, setActionError] = useState("");
  const [searchEngine, setSearchEngine] = useState<SearchEngineId>(DEFAULT_SEARCH_ENGINE);
  const [translating, setTranslating] = useState(false);
  const translatingRef = useRef(false);
  const textBeforeTranslateRef = useRef("");

  // 主题接入：OCR 结果窗为常驻窗口，需在挂载时着色并订阅广播，
  // 否则主题在窗口创建后变更时不会刷新。
  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
  }, []);

  useEffect(() => {
    const unlistenTheme = subscribeThemePreferences();
    return () => {
      unlistenTheme.then((fn) => fn());
    };
  }, []);

  const { optimize, cancel, isLoading, optimizedText, errorMessage, checkAiConfig } =
    useAiOptimize();

  // 读取已配置的搜索引擎，并跟随设置窗口的变更（与文字工具栏保持一致）
  useEffect(() => {
    let disposed = false;
    fetchSearchEngine().then((e) => {
      if (!disposed) setSearchEngine(e);
    });
    const un = listen<SearchEngineId>("levitaire-search-engine-changed", (ev) => {
      if (!disposed) setSearchEngine(ev.payload);
    });
    return () => {
      disposed = true;
      un.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const show = listen<Payload>("pin-ocr-show", ({ payload }) => {
      // 新 OCR 结果到来时若有翻译仍在进行，先取消并复位其状态：
      // 否则旧请求完成时的 effect 会把刚展示的新 OCR 文本覆盖成旧翻译结果/旧原文。
      if (translatingRef.current) {
        translatingRef.current = false;
        setTranslating(false);
        cancel();
      }
      setText(payload.text ?? "");
      setOcrError(payload.error ?? "");
      setActionError("");
    });
    const ready = listen("pin-ocr-ready-request", () => void emit("pin-ocr-ready"));
    void emit("pin-ocr-ready");
    return () => {
      show.then((fn) => fn());
      ready.then((fn) => fn());
    };
  }, [cancel]);

  // 监听翻译进度与结果：流式过程实时更新 text，结束后落定最终结果或报错
  useEffect(() => {
    if (!translatingRef.current) return;
    if (optimizedText !== null && isLoading) {
      setText(optimizedText);
    } else if (!isLoading) {
      translatingRef.current = false;
      setTranslating(false);
      if (errorMessage) {
        // 失败时恢复原文，避免流式翻译的残留片段留在文本框
        setText(textBeforeTranslateRef.current);
        setActionError(errorMessage);
      } else if (optimizedText !== null) {
        setText(optimizedText);
        setActionError("");
      }
    }
  }, [isLoading, optimizedText, errorMessage]);

  const copy = async () => {
    if (!text) return;
    await invoke("copy_text", { text });
  };

  const handleSearch = async () => {
    if (!text.trim()) return;
    const url = buildSearchUrl(searchEngine, text.trim());
    try {
      await invoke("open_url", { url });
    } catch (err) {
      console.error("Failed to open search:", err);
      setActionError("打开搜索链接失败");
    }
  };

  const handleTranslate = async () => {
    // 翻译进行中再次点击 → 取消并恢复原文
    if (translatingRef.current) {
      translatingRef.current = false;
      setTranslating(false);
      cancel();
      setText(textBeforeTranslateRef.current);
      return;
    }
    if (isLoading || !text.trim()) return;
    setActionError("");
    const config = await checkAiConfig();
    if (!config || !config.api_key || !config.api_key.trim()) {
      setActionError("请先配置 AI 再进行翻译");
      return;
    }
    textBeforeTranslateRef.current = text;
    translatingRef.current = true;
    setTranslating(true);
    // 结束/取消/报错均由完成 effect（isLoading 回落）统一落定，这里无需处理
    await optimize(text, TRANSLATE_MODE).catch(() => {});
  };

  return (
    <main className="pin-ocr-result" role="dialog" aria-label="OCR 结果">
      <header>
        <strong>OCR 结果</strong>
        <button type="button" aria-label="关闭" onClick={() => void win.hide()}>
          <X size={16} />
        </button>
      </header>
      {ocrError ? (
        <p className="pin-ocr-error">{ocrError}</p>
      ) : (
        <textarea
          aria-label="OCR 识别文本"
          value={text}
          onChange={(e) => setText(e.target.value)}
          readOnly={translating}
          placeholder={translating ? "翻译中..." : ""}
        />
      )}
      {actionError && (
        <div className="pin-ocr-action-error" role="alert">
          <span>{actionError}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setActionError("")}>
            <X size={13} />
          </button>
        </div>
      )}
      <footer>
        <button type="button" onClick={() => void copy()} disabled={!text || translating}>
          <Copy size={15} />
          复制
        </button>
        <button
          type="button"
          onClick={() => void handleSearch()}
          disabled={!text.trim() || translating}
        >
          <Search size={15} />
          搜索
        </button>
        <button
          type="button"
          onClick={() => void handleTranslate()}
          disabled={!text.trim()}
          title={translating ? "取消翻译" : "翻译"}
        >
          <Globe size={15} />
          {translating ? "取消" : "翻译"}
        </button>
      </footer>
    </main>
  );
}
