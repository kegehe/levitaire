import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import Icon from "./Icon";
import type { IconName } from "./Icon";
import { AiConfig } from "../types";
import {
  TOOLBAR_FEATURES,
  DEFAULT_FEATURE_IDS,
  fetchEnabledFeatures,
  saveEnabledFeatures,
} from "../constants/toolbarFeatures";
import {
  DEFAULT_DEDUP_MODE,
  fetchDedupMode,
  saveDedupMode,
  DEDUP_GRANULARITY_OPTIONS,
  DEDUP_CHAR_SUBMODE_OPTIONS,
  type DedupMode,
  type DedupGranularity,
  type CharSubMode,
} from "../constants/dedupConfig";
import {
  DEFAULT_MD5_LENGTH,
  fetchMd5Length,
  saveMd5Length,
  MD5_LENGTH_OPTIONS,
  type Md5Length,
} from "../constants/md5Config";
import {
  DEFAULT_NUMBERING_STYLE,
  fetchNumberingStyle,
  saveNumberingStyle,
  NUMBERING_STYLE_OPTIONS,
  type NumberingStyle,
} from "../constants/numberingConfig";
import {
  DEFAULT_SEARCH_ENGINE,
  fetchSearchEngine,
  saveSearchEngine,
  SEARCH_ENGINE_OPTIONS,
  type SearchEngineId,
} from "../constants/searchEngineConfig";
import {
  CLEAR_OPTIONS,
  DEFAULT_CLEAR_IDS,
  fetchClearOptions,
  saveClearOptions,
} from "../constants/clearConfig";
import { OCR_ENGINE_LABELS } from "../constants/ocrEngineConfig";
import {
  DEFAULT_TTS_CONFIG,
  fetchTtsConfig,
  saveTtsConfig,
  TTS_RATE_OPTIONS,
  TTS_VOLUME_OPTIONS,
  type TtsConfig,
  type VoiceInfo,
} from "../constants/ttsConfig";
import {
  DEFAULT_SYSTEM_MONITOR_CONFIG,
  MONITOR_INTERVAL_OPTIONS,
  fetchSystemMonitorConfig,
  saveSystemMonitorConfig,
  type SystemMonitorConfig,
  type SystemMonitorDisplayMode,
} from "../constants/systemMonitorConfig";
import {
  DEFAULT_POMODORO_CONFIG,
  POMODORO_WORK_OPTIONS,
  POMODORO_SHORT_BREAK_OPTIONS,
  POMODORO_LONG_BREAK_OPTIONS,
  POMODORO_ROUNDS_OPTIONS,
  POMODORO_NOTIFY_SOUND_OPTIONS,
  fetchPomodoroConfig,
  savePomodoroConfig,
  type PomodoroConfig,
  type PomodoroNotifySound,
} from "../constants/pomodoroConfig";
import {
  DEFAULT_RECORDING_CONFIG,
  GIF_FPS_OPTION_ITEMS,
  VIDEO_FPS_OPTION_ITEMS,
  MAX_DURATION_OPTION_ITEMS,
  fetchRecordingConfig,
  saveRecordingConfig,
  type RecordingConfig,
} from "../tools/recording/recordingConfig";
import {
  THEME_ACCENTS,
  THEME_SCHEMES,
  applyThemePreferences,
  getStoredThemePreferences,
  loadThemePreferences,
  type ThemeAccentId,
  type ThemePreferences,
  type ThemeSchemeId,
} from "../styles/themePreferences";
import "./Settings.css";
import TitleBar from "./TitleBar";

/** 设置页左侧菜单项定义 */
const SETTINGS_TABS = [
  { id: "general", label: "通用", icon: "Settings" as IconName },
  { id: "capture", label: "截图/录屏", icon: "Camera" as IconName },
  { id: "quick-input", label: "快速输入", icon: "Compass" as IconName },
  { id: "monitor", label: "系统监控", icon: "Activity" as IconName },
  { id: "pomodoro", label: "番茄钟", icon: "Timer" as IconName },
  { id: "toolbar", label: "文字工具", icon: "Grid3x3" as IconName },
  { id: "ai", label: "AI 配置", icon: "Sparkles" as IconName },
] as const;

type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

/** 支持一键恢复默认位置的悬浮窗（与后端 window_positions 的窗口 id 对应） */
const WINDOW_POSITION_TARGETS = [
  { id: "orb", label: "悬浮球", icon: "GripVertical" as IconName },
  { id: "monitor-overlay", label: "系统监控", icon: "Activity" as IconName },
  { id: "pomodoro-overlay", label: "番茄钟", icon: "Timer" as IconName },
] as const;

function Settings() {
  const [activeTab, setActiveTab] = useState<SettingsTabId>("general");
  const [autoStart, setAutoStart] = useState(false);
  const [autoStartError, setAutoStartError] = useState(false);
  const persistedThemePreferencesRef = useRef<ThemePreferences>(getStoredThemePreferences());
  const themeSaveVersionRef = useRef(0);
  const themeSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const accentOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [theme, setTheme] = useState<"light" | "dark">(
    () => persistedThemePreferencesRef.current.theme,
  );
  const [themeAccent, setThemeAccent] = useState<ThemeAccentId>(
    () => persistedThemePreferencesRef.current.accent,
  );
  const [themeScheme, setThemeScheme] = useState<ThemeSchemeId>(
    () => persistedThemePreferencesRef.current.scheme,
  );
  const [themePreferencesReady, setThemePreferencesReady] = useState(false);
  const [themePreferencesError, setThemePreferencesError] = useState(false);

  // AI 配置
  const [aiConfig, setAiConfig] = useState<AiConfig>({
    api_key: "",
    base_url: "https://api.anthropic.com",
    model: "claude-sonnet-5",
    api_type: "anthropic",
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [aiSaveStatus, setAiSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  // 工具栏功能配置（默认全量，挂载后从后端异步加载）
  const [enabledFeatures, setEnabledFeaturesState] = useState<string[]>(DEFAULT_FEATURE_IDS);
  const [featuresStatus, setFeaturesStatus] = useState<"idle" | "saved" | "error">("idle");

  // 去重粒度配置（默认按行，挂载后从后端异步加载）
  const [dedupMode, setDedupModeState] = useState<DedupMode>(DEFAULT_DEDUP_MODE);
  const [dedupStatus, setDedupStatus] = useState<"idle" | "saved" | "error">("idle");

  // MD5 位数配置（默认 32 位，挂载后从后端异步加载）
  const [md5Length, setMd5LengthState] = useState<Md5Length>(DEFAULT_MD5_LENGTH);
  const [md5Status, setMd5Status] = useState<"idle" | "saved" | "error">("idle");

  // 编号样式配置（默认数字 1. 2. 3.，挂载后从后端异步加载）
  const [numberingStyle, setNumberingStyleState] =
    useState<NumberingStyle>(DEFAULT_NUMBERING_STYLE);
  const [numberingStatus, setNumberingStatus] = useState<"idle" | "saved" | "error">("idle");

  // 搜索引擎配置（默认必应，挂载后从后端异步加载）
  const [searchEngine, setSearchEngineState] = useState<SearchEngineId>(DEFAULT_SEARCH_ENGINE);
  const [searchEngineStatus, setSearchEngineStatus] = useState<"idle" | "saved" | "error">("idle");

  // 清除功能启用的清除项（默认全量，挂载后从后端异步加载）
  const [enabledClearIds, setEnabledClearIdsState] = useState<string[]>(DEFAULT_CLEAR_IDS);
  const [clearStatus, setClearStatus] = useState<"idle" | "saved" | "error">("idle");

  // 朗读配置（默认正常语速/系统默认语音/满音量，挂载后从后端异步加载）
  const [ttsConfig, setTtsConfigState] = useState<TtsConfig>(DEFAULT_TTS_CONFIG);
  const [ttsStatus, setTtsStatus] = useState<"idle" | "saved" | "error">("idle");
  const [ttsVoices, setTtsVoices] = useState<VoiceInfo[]>([]);

  // 截图快捷键
  const [screenshotHotkey, setScreenshotHotkey] = useState("");
  const [hotkeyRecording, setHotkeyRecording] = useState(false);
  const [hotkeyStatus, setHotkeyStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [hotkeyError, setHotkeyError] = useState("");

  // 系统监控配置
  const [systemMonitorConfig, setSystemMonitorConfig] = useState<SystemMonitorConfig>(
    DEFAULT_SYSTEM_MONITOR_CONFIG,
  );
  const [systemMonitorStatus, setSystemMonitorStatus] = useState<"idle" | "saved" | "error">(
    "idle",
  );
  const systemMonitorConfigRef = useRef<SystemMonitorConfig>(DEFAULT_SYSTEM_MONITOR_CONFIG);
  const systemMonitorSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const systemMonitorSaveVersionRef = useRef(0);

  // 番茄钟配置
  const [pomodoroConfig, setPomodoroConfig] = useState<PomodoroConfig>(DEFAULT_POMODORO_CONFIG);
  const [pomodoroStatus, setPomodoroStatus] = useState<"idle" | "saved" | "error">("idle");
  const pomodoroConfigRef = useRef<PomodoroConfig>(DEFAULT_POMODORO_CONFIG);
  const pomodoroSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pomodoroSaveVersionRef = useRef(0);

  // 录屏快捷键
  const [recordingHotkey, setRecordingHotkey] = useState("");
  const [recordingHotkeyRecording, setRecordingHotkeyRecording] = useState(false);
  const [recordingHotkeyStatus, setRecordingHotkeyStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [recordingHotkeyError, setRecordingHotkeyError] = useState("");

  // 录屏保存路径
  const [recordingSavePath, setRecordingSavePath] = useState("");
  const [recordingSavePathStatus, setRecordingSavePathStatus] = useState<
    "idle" | "saved" | "error"
  >("idle");

  // 录屏帧率/最长时长配置
  const [recordingConfig, setRecordingConfig] = useState<RecordingConfig>(DEFAULT_RECORDING_CONFIG);
  const [recordingConfigStatus, setRecordingConfigStatus] = useState<"idle" | "saved" | "error">(
    "idle",
  );
  const recordingConfigRef = useRef<RecordingConfig>(DEFAULT_RECORDING_CONFIG);
  const recordingConfigSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const recordingConfigSaveVersionRef = useRef(0);

  // ── 快速输入转盘 ──
  interface QuickInputSnippet {
    label: string;
    text: string;
  }
  const [qiTriggerKey, setQiTriggerKey] = useState("CapsLock");
  const [qiTriggerKeyStatus, setQiTriggerKeyStatus] = useState<"idle" | "saved" | "error">("idle");
  const [qiMode, setQiMode] = useState("click");
  const [qiModeStatus, setQiModeStatus] = useState<"idle" | "saved" | "error">("idle");
  const [qiSnippets, setQiSnippets] = useState<QuickInputSnippet[]>([]);
  const [qiSnippetsStatus, setQiSnippetsStatus] = useState<"idle" | "saved" | "error">("idle");
  const [qiNewLabel, setQiNewLabel] = useState("");
  const [qiNewText, setQiNewText] = useState("");
  // 剪贴板历史（后端内存环形缓冲，不持久化，最多 20 条）
  const [qiHistory, setQiHistory] = useState<Array<{ preview: string; text: string }>>([]);
  const [qiHistoryStatus, setQiHistoryStatus] = useState<"idle" | "cleared" | "error">("idle");
  // 正在编辑的预设词下标（null 表示未处于编辑状态）
  const [qiEditingIndex, setQiEditingIndex] = useState<number | null>(null);
  const [qiEditLabel, setQiEditLabel] = useState("");
  const [qiEditText, setQiEditText] = useState("");

  // 触发键采集状态（true 表示正在监听用户按下的单键）
  const [qiTriggerRecording, setQiTriggerRecording] = useState(false);
  // 触发键保存/校验错误提示文案
  const [qiTriggerError, setQiTriggerError] = useState("");

  // 截图保存路径
  const [screenshotSavePath, setScreenshotSavePath] = useState("");
  const [screenshotSavePathStatus, setScreenshotSavePathStatus] = useState<
    "idle" | "saved" | "error"
  >("idle");

  // OCR 识别引擎（可用列表与当前激活引擎由后端 get_ocr_engines 返回）
  const [ocrAvailableEngines, setOcrAvailableEngines] = useState<string[]>([]);
  const [ocrActiveEngine, setOcrActiveEngine] = useState("");
  const [ocrStatus, setOcrStatus] = useState<"idle" | "saved" | "error">("idle");
  // 切换序号：快速连续切换时仅最后一次的结果生效，避免乱序返回覆盖新选择
  const ocrSaveVersionRef = useRef(0);

  // 悬浮工具「启动时自动打开」配置（默认关闭，真值在后端 config.json）
  const [autostartIds, setAutostartIdsState] = useState<string[]>([]);
  // 保存失败时显示错误提示
  const [autostartError, setAutostartError] = useState(false);
  // 系统监控工具是否启用（自启动仅对已启用工具生效，未加载到后端状态前按启用处理）
  const [systemMonitorEnabled, setSystemMonitorEnabled] = useState(true);
  // 番茄钟工具是否启用（自启动仅对已启用工具生效，未加载到后端状态前按启用处理）
  const [pomodoroEnabled, setPomodoroEnabled] = useState(true);

  // 悬浮窗默认位置恢复状态（key 为窗口 id：orb / monitor-overlay / pomodoro-overlay）
  const [resetPosStatus, setResetPosStatus] = useState<
    Record<string, "idle" | "saving" | "saved" | "error">
  >({});
  const [resetAllStatus, setResetAllStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );

  const handleChangeDedupMode = (next: DedupMode) => {
    const previous = dedupMode;
    setDedupModeState(next);
    saveDedupMode(next)
      .then(() => {
        setDedupStatus("saved");
        setTimeout(() => setDedupStatus("idle"), 1500);
      })
      .catch((err) => {
        console.error("Failed to save dedup mode:", err);
        setDedupStatus("error");
        setTimeout(() => setDedupStatus("idle"), 3000);
        setDedupModeState(previous);
        emit("levitaire-dedup-mode-changed", previous);
      });
    emit("levitaire-dedup-mode-changed", next);
  };

  const handleChangeMd5Length = (next: Md5Length) => {
    const previous = md5Length;
    setMd5LengthState(next);
    saveMd5Length(next)
      .then(() => {
        setMd5Status("saved");
        setTimeout(() => setMd5Status("idle"), 1500);
      })
      .catch((err) => {
        console.error("Failed to save md5 length:", err);
        setMd5Status("error");
        setTimeout(() => setMd5Status("idle"), 3000);
        setMd5LengthState(previous);
        emit("levitaire-md5-length-changed", previous);
      });
    emit("levitaire-md5-length-changed", next);
  };

  const handleChangeNumberingStyle = (next: NumberingStyle) => {
    const previous = numberingStyle;
    setNumberingStyleState(next);
    saveNumberingStyle(next)
      .then(() => {
        setNumberingStatus("saved");
        setTimeout(() => setNumberingStatus("idle"), 1500);
      })
      .catch((err) => {
        console.error("Failed to save numbering style:", err);
        setNumberingStatus("error");
        setTimeout(() => setNumberingStatus("idle"), 3000);
        setNumberingStyleState(previous);
        emit("levitaire-numbering-style-changed", previous);
      });
    emit("levitaire-numbering-style-changed", next);
  };

  const handleChangeSearchEngine = (next: SearchEngineId) => {
    const previous = searchEngine;
    setSearchEngineState(next);
    saveSearchEngine(next)
      .then(() => {
        setSearchEngineStatus("saved");
        setTimeout(() => setSearchEngineStatus("idle"), 1500);
      })
      .catch((err) => {
        console.error("Failed to save search engine:", err);
        setSearchEngineStatus("error");
        setTimeout(() => setSearchEngineStatus("idle"), 3000);
        setSearchEngineState(previous);
        emit("levitaire-search-engine-changed", previous);
      });
    emit("levitaire-search-engine-changed", next);
  };

  const handleChangeTtsConfig = (partial: Partial<TtsConfig>) => {
    const previous = ttsConfig;
    const next = { ...ttsConfig, ...partial };
    setTtsConfigState(next);
    saveTtsConfig(next)
      .then(() => {
        setTtsStatus("saved");
        setTimeout(() => setTtsStatus("idle"), 1500);
      })
      .catch((err) => {
        console.error("Failed to save tts config:", err);
        setTtsStatus("error");
        setTimeout(() => setTtsStatus("idle"), 3000);
        setTtsConfigState(previous);
        emit("levitaire-tts-config-changed", previous);
      });
    emit("levitaire-tts-config-changed", next);
  };

  const handleToggleFeature = (id: string) => {
    const previous = enabledFeatures;
    const next = previous.includes(id) ? previous.filter((f) => f !== id) : [...previous, id];
    setEnabledFeaturesState(next);
    emit("levitaire-features-changed", next);
    saveEnabledFeatures(next)
      .then(() => {
        setFeaturesStatus("saved");
        setTimeout(() => setFeaturesStatus("idle"), 1500);
      })
      .catch((err) => {
        console.error("Failed to save toolbar features:", err);
        setFeaturesStatus("error");
        setTimeout(() => setFeaturesStatus("idle"), 3000);
        setEnabledFeaturesState(previous);
        emit("levitaire-features-changed", previous);
      });
  };

  const handleToggleClearOption = (id: string) => {
    const previous = enabledClearIds;
    const next = previous.includes(id) ? previous.filter((f) => f !== id) : [...previous, id];
    setEnabledClearIdsState(next);
    emit("levitaire-clear-options-changed", next);
    saveClearOptions(next)
      .then(() => {
        setClearStatus("saved");
        setTimeout(() => setClearStatus("idle"), 1500);
      })
      .catch((err) => {
        console.error("Failed to save clear options:", err);
        setClearStatus("error");
        setTimeout(() => setClearStatus("idle"), 3000);
        setEnabledClearIdsState(previous);
        emit("levitaire-clear-options-changed", previous);
      });
  };

  const handleToggleToolAutostart = (id: string) => {
    const previous = autostartIds;
    const next = previous.includes(id) ? previous.filter((x) => x !== id) : [...previous, id];
    setAutostartIdsState(next);
    setAutostartError(false);
    invoke("set_tools_autostart", { ids: next }).catch((err) => {
      console.error("Failed to save tools autostart:", err);
      setAutostartIdsState(previous);
      setAutostartError(true);
    });
  };

  /** 恢复单个悬浮窗的默认位置（清除记忆并移动窗口到默认定位） */
  const handleResetWindowPosition = async (windowId: string) => {
    if (resetPosStatus[windowId] === "saving") return;
    setResetPosStatus((prev) => ({ ...prev, [windowId]: "saving" }));
    try {
      await invoke("reset_window_position", { id: windowId });
      setResetPosStatus((prev) => ({ ...prev, [windowId]: "saved" }));
      setTimeout(() => {
        setResetPosStatus((prev) => ({ ...prev, [windowId]: "idle" }));
      }, 1500);
    } catch (err) {
      console.error(`Failed to reset window position (${windowId}):`, err);
      setResetPosStatus((prev) => ({ ...prev, [windowId]: "error" }));
      setTimeout(() => {
        setResetPosStatus((prev) => ({ ...prev, [windowId]: "idle" }));
      }, 3000);
    }
  };

  /** 恢复所有悬浮窗的默认位置 */
  const handleResetAllWindowPositions = async () => {
    if (resetAllStatus === "saving") return;
    setResetAllStatus("saving");
    const ids = WINDOW_POSITION_TARGETS.map((target) => target.id);
    const results = await Promise.allSettled(
      ids.map((id) => invoke("reset_window_position", { id })),
    );
    const failed = results.some((r) => r.status === "rejected");
    if (failed) {
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          console.error(`Failed to reset window position (${ids[i]}):`, r.reason);
        }
      });
    }
    setResetAllStatus(failed ? "error" : "saved");
    setTimeout(() => setResetAllStatus("idle"), failed ? 3000 : 1500);
  };

  const handleChangeOcrEngine = async (engine: string) => {
    const version = ++ocrSaveVersionRef.current;
    const previous = ocrActiveEngine;
    setOcrActiveEngine(engine);
    setOcrStatus("idle");
    try {
      await invoke("set_ocr_engine", { engine });
      if (version !== ocrSaveVersionRef.current) return; // 已有更新的切换，忽略本次过期结果
      setOcrStatus("saved");
      setTimeout(() => setOcrStatus("idle"), 1500);
    } catch (err) {
      if (version !== ocrSaveVersionRef.current) return;
      console.error("Failed to set OCR engine:", err);
      setOcrActiveEngine(previous);
      setOcrStatus("error");
      setTimeout(() => setOcrStatus("idle"), 3000);
    }
  };

  const updateSystemMonitorConfig = (partial: Partial<SystemMonitorConfig>) => {
    const previous = systemMonitorConfigRef.current;
    const next = { ...previous, ...partial };
    const version = ++systemMonitorSaveVersionRef.current;
    systemMonitorConfigRef.current = next;
    setSystemMonitorConfig(next);
    emit("levitaire-system-monitor-config-changed", next);

    const save = systemMonitorSaveQueueRef.current
      .catch(() => undefined)
      .then(() => saveSystemMonitorConfig(next));
    systemMonitorSaveQueueRef.current = save;
    void save
      .then(() => {
        if (version !== systemMonitorSaveVersionRef.current) return;
        setSystemMonitorStatus("saved");
        setTimeout(() => setSystemMonitorStatus("idle"), 1500);
      })
      .catch((err) => {
        if (version !== systemMonitorSaveVersionRef.current) return;
        console.error("Failed to save system monitor config:", err);
        systemMonitorConfigRef.current = previous;
        setSystemMonitorConfig(previous);
        emit("levitaire-system-monitor-config-changed", previous);
        setSystemMonitorStatus("error");
        setTimeout(() => setSystemMonitorStatus("idle"), 3000);
      });
  };

  const updatePomodoroConfig = (partial: Partial<PomodoroConfig>) => {
    const previous = pomodoroConfigRef.current;
    const next = { ...previous, ...partial };
    // 提醒方式变更时同步兼容布尔字段（notifySound），保持两者一致
    if (partial.notifySoundType !== undefined) {
      next.notifySound = partial.notifySoundType !== "none";
    }
    const version = ++pomodoroSaveVersionRef.current;
    pomodoroConfigRef.current = next;
    setPomodoroConfig(next);
    emit("levitaire-pomodoro-config-changed", next);

    const save = pomodoroSaveQueueRef.current
      .catch(() => undefined)
      .then(() => savePomodoroConfig(next));
    pomodoroSaveQueueRef.current = save;
    void save
      .then(() => {
        if (version !== pomodoroSaveVersionRef.current) return;
        setPomodoroStatus("saved");
        setTimeout(() => setPomodoroStatus("idle"), 1500);
      })
      .catch((err) => {
        if (version !== pomodoroSaveVersionRef.current) return;
        console.error("Failed to save pomodoro config:", err);
        pomodoroConfigRef.current = previous;
        setPomodoroConfig(previous);
        emit("levitaire-pomodoro-config-changed", previous);
        setPomodoroStatus("error");
        setTimeout(() => setPomodoroStatus("idle"), 3000);
      });
  };

  useEffect(() => {
    let cancelled = false;
    loadThemePreferences().then((preferences) => {
      if (cancelled) return;
      persistedThemePreferencesRef.current = preferences;
      setTheme(preferences.theme);
      setThemeAccent(preferences.accent);
      setThemeScheme(preferences.scheme);
      setThemePreferencesReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const preferences = applyThemePreferences({ theme, accent: themeAccent, scheme: themeScheme });
    if (!themePreferencesReady) return;

    const version = ++themeSaveVersionRef.current;
    const timer = window.setTimeout(() => {
      themeSaveQueueRef.current = themeSaveQueueRef.current
        .catch(() => {})
        .then(async () => {
          await invoke("set_theme_preferences", { preferences });
          if (version !== themeSaveVersionRef.current) return;
          // 仅在本次保存仍是“最新”时才更新回滚基准，避免过期任务污染
          // persistedThemePreferencesRef，导致后续失败回滚到错误的主题。
          persistedThemePreferencesRef.current = preferences;
          await emit("levitaire-theme-changed", preferences);
        })
        .catch((err) => {
          if (version !== themeSaveVersionRef.current) return;
          console.error("Failed to save theme preferences:", err);
          const previous = persistedThemePreferencesRef.current;
          applyThemePreferences(previous);
          setTheme(previous.theme);
          setThemeAccent(previous.accent);
          setThemeScheme(previous.scheme);
          setThemePreferencesError(true);
          void emit("levitaire-theme-changed", previous);
        });
    }, 120);

    return () => window.clearTimeout(timer);
  }, [theme, themeAccent, themeScheme, themePreferencesReady]);

  useEffect(() => {
    document.body.classList.add("settings-window");
    return () => {
      document.body.classList.remove("settings-window");
    };
  }, []);

  useEffect(() => {
    invoke<boolean>("get_auto_start")
      .then((enabled) => setAutoStart(enabled))
      .catch((err) => console.error("Failed to get auto start status:", err));
  }, []);

  useEffect(() => {
    invoke<AiConfig>("get_ai_config")
      .then((config) => setAiConfig(config))
      .catch((err) => console.error("Failed to load AI config:", err));
  }, []);

  useEffect(() => {
    invoke<string>("get_screenshot_hotkey")
      .then((hk) => setScreenshotHotkey(hk))
      .catch((err) => console.error("Failed to load screenshot hotkey:", err));
  }, []);

  useEffect(() => {
    Promise.allSettled([
      fetchEnabledFeatures(),
      fetchDedupMode(),
      fetchMd5Length(),
      fetchNumberingStyle(),
      fetchClearOptions(),
      fetchTtsConfig(),
      fetchSearchEngine(),
      invoke<VoiceInfo[]>("tts_get_voices"),
      fetchSystemMonitorConfig(),
      fetchPomodoroConfig(),
      fetchRecordingConfig(),
      invoke<string>("get_recording_hotkey"),
      invoke<string>("get_recording_save_path"),
      invoke<string>("get_screenshot_save_path"),
      invoke<{ active: string; available: string[] }>("get_ocr_engines"),
      invoke<string>("get_quick_input_trigger_key"),
      invoke<string>("get_quick_input_mode"),
      invoke<string>("get_quick_input_snippets"),
      invoke<string[]>("get_tools_autostart"),
      invoke<Array<{ preview: string; text: string }>>("get_quick_input_history"),
    ]).then(
      ([
        features,
        dedup,
        md5,
        numbering,
        clear,
        tts,
        search,
        voices,
        sysMon,
        pomodoro,
        recCfg,
        recHk,
        recSavePath,
        ssSavePath,
        ocrEngines,
        qiKey,
        qiMode,
        qiSnips,
        autostart,
        qiHist,
      ]) => {
        if (features.status === "fulfilled") setEnabledFeaturesState(features.value);
        if (dedup.status === "fulfilled") setDedupModeState(dedup.value);
        if (md5.status === "fulfilled") setMd5LengthState(md5.value);
        if (numbering.status === "fulfilled") setNumberingStyleState(numbering.value);
        if (clear.status === "fulfilled") setEnabledClearIdsState(clear.value);
        if (tts.status === "fulfilled") setTtsConfigState(tts.value);
        if (search.status === "fulfilled") setSearchEngineState(search.value);
        if (voices.status === "fulfilled") setTtsVoices(voices.value);
        if (sysMon.status === "fulfilled") {
          if (systemMonitorSaveVersionRef.current === 0) {
            systemMonitorConfigRef.current = sysMon.value;
            setSystemMonitorConfig(sysMon.value);
          }
        }
        if (pomodoro.status === "fulfilled") {
          if (pomodoroSaveVersionRef.current === 0) {
            pomodoroConfigRef.current = pomodoro.value;
            setPomodoroConfig(pomodoro.value);
          }
        }
        if (recCfg.status === "fulfilled") {
          if (recordingConfigSaveVersionRef.current === 0) {
            recordingConfigRef.current = recCfg.value;
            setRecordingConfig(recCfg.value);
          }
        }
        if (recHk.status === "fulfilled") setRecordingHotkey(recHk.value);
        if (recSavePath.status === "fulfilled") setRecordingSavePath(recSavePath.value);
        if (ssSavePath.status === "fulfilled") setScreenshotSavePath(ssSavePath.value);
        if (ocrEngines.status === "fulfilled") {
          setOcrAvailableEngines(ocrEngines.value.available);
          setOcrActiveEngine(ocrEngines.value.active);
        }
        if (qiKey.status === "fulfilled") setQiTriggerKey(qiKey.value || "CapsLock");
        if (qiMode.status === "fulfilled") setQiMode(qiMode.value === "hold" ? "hold" : "click");
        if (qiSnips.status === "fulfilled" && qiSnips.value) {
          try {
            setQiSnippets(JSON.parse(qiSnips.value) as QuickInputSnippet[]);
          } catch {
            /* 忽略解析错误 */
          }
        }
        if (autostart.status === "fulfilled") setAutostartIdsState(autostart.value);
        if (qiHist.status === "fulfilled") setQiHistory(qiHist.value);
      },
    );
  }, []);

  // 加载系统监控的启用状态（「启动时自动打开」仅对已启用工具生效）
  useEffect(() => {
    let cancelled = false;
    invoke<boolean>("get_system_monitor_enabled")
      .then((enabled) => {
        if (!cancelled) setSystemMonitorEnabled(enabled);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 加载番茄钟的启用状态（「启动时自动打开」仅对已启用工具生效）
  useEffect(() => {
    let cancelled = false;
    invoke<boolean>("get_pomodoro_enabled")
      .then((enabled) => {
        if (!cancelled) setPomodoroEnabled(enabled);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 快捷键录入：聚焦时捕获按键组合
  const handleHotkeyKeyDown = (e: React.KeyboardEvent) => {
    if (!hotkeyRecording) return;
    e.preventDefault();
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Win");
    const isModifierKey = ["Control", "Alt", "Shift", "Meta"].includes(e.key);
    if (isModifierKey) return;
    if (e.key === "Escape") {
      setHotkeyRecording(false);
      return;
    }
    const isFKey = e.key.startsWith("F") && /^F([1-9]|1[0-2])$/.test(e.key);
    if (mods.length === 0 && !isFKey) {
      setHotkeyError("快捷键需包含修饰键（Ctrl/Alt/Shift/Win），或使用 F1-F12 单键");
      return;
    }
    let mainKey: string;
    if (isFKey) {
      mainKey = e.key;
    } else if (e.key.length === 1) {
      mainKey = e.key.toUpperCase();
    } else {
      setHotkeyError("不支持的按键");
      return;
    }
    const combo = [...mods, mainKey].join("+");
    setHotkeyError("");
    setHotkeyRecording(false);
    saveHotkey(combo);
  };

  const saveHotkey = async (combo: string) => {
    const previous = screenshotHotkey;
    setScreenshotHotkey(combo);
    setHotkeyStatus("saving");
    try {
      await invoke("set_screenshot_hotkey", { hotkey: combo });
      setHotkeyStatus("saved");
      setHotkeyError("");
      setTimeout(() => setHotkeyStatus("idle"), 2000);
    } catch (err) {
      setScreenshotHotkey(previous);
      setHotkeyStatus("error");
      setHotkeyError(String(err));
      setTimeout(() => setHotkeyStatus("idle"), 3000);
    }
  };

  const clearHotkey = async () => {
    setHotkeyStatus("saving");
    try {
      await invoke("set_screenshot_hotkey", { hotkey: "" });
      setScreenshotHotkey("");
      setHotkeyStatus("idle");
      setHotkeyError("");
    } catch (err) {
      setHotkeyStatus("error");
      setHotkeyError(String(err));
      setTimeout(() => setHotkeyStatus("idle"), 3000);
    }
  };

  const handleRecordingHotkeyKeyDown = (e: React.KeyboardEvent) => {
    if (!recordingHotkeyRecording) return;
    e.preventDefault();
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Win");
    const isModifierKey = ["Control", "Alt", "Shift", "Meta"].includes(e.key);
    if (isModifierKey) return;
    if (e.key === "Escape") {
      setRecordingHotkeyRecording(false);
      return;
    }
    const isFKey = e.key.startsWith("F") && /^F([1-9]|1[0-2])$/.test(e.key);
    if (mods.length === 0 && !isFKey) {
      setRecordingHotkeyError("快捷键需包含修饰键（Ctrl/Alt/Shift/Win），或使用 F1-F12 单键");
      return;
    }
    let mainKey: string;
    if (isFKey) {
      mainKey = e.key;
    } else if (e.key.length === 1) {
      mainKey = e.key.toUpperCase();
    } else {
      setRecordingHotkeyError("不支持的按键");
      return;
    }
    const combo = [...mods, mainKey].join("+");
    setRecordingHotkeyError("");
    setRecordingHotkeyRecording(false);
    saveRecordingHotkey(combo);
  };

  const saveRecordingHotkey = async (combo: string) => {
    const previous = recordingHotkey;
    setRecordingHotkey(combo);
    setRecordingHotkeyStatus("saving");
    try {
      await invoke("set_recording_hotkey", { hotkey: combo });
      setRecordingHotkeyStatus("saved");
      setRecordingHotkeyError("");
      setTimeout(() => setRecordingHotkeyStatus("idle"), 2000);
    } catch (err) {
      setRecordingHotkey(previous);
      setRecordingHotkeyStatus("error");
      setRecordingHotkeyError(String(err));
      setTimeout(() => setRecordingHotkeyStatus("idle"), 3000);
    }
  };

  const clearRecordingHotkey = async () => {
    setRecordingHotkeyStatus("saving");
    try {
      await invoke("set_recording_hotkey", { hotkey: "" });
      setRecordingHotkey("");
      setRecordingHotkeyStatus("idle");
      setRecordingHotkeyError("");
    } catch (err) {
      setRecordingHotkeyStatus("error");
      setRecordingHotkeyError(String(err));
      setTimeout(() => setRecordingHotkeyStatus("idle"), 3000);
    }
  };

  const pickRecordingSavePath = async () => {
    try {
      const folder = await invoke<string | null>("pick_folder");
      if (folder) {
        const previous = recordingSavePath;
        setRecordingSavePath(folder);
        try {
          await invoke("set_recording_save_path", { path: folder });
          setRecordingSavePathStatus("saved");
          setTimeout(() => setRecordingSavePathStatus("idle"), 1500);
        } catch {
          setRecordingSavePath(previous);
          setRecordingSavePathStatus("error");
          setTimeout(() => setRecordingSavePathStatus("idle"), 3000);
        }
      }
    } catch (err) {
      console.error("Failed to pick recording save path:", err);
      setRecordingSavePathStatus("error");
      setTimeout(() => setRecordingSavePathStatus("idle"), 3000);
    }
  };

  const clearRecordingSavePath = async () => {
    try {
      await invoke("set_recording_save_path", { path: "" });
      setRecordingSavePath("");
      setRecordingSavePathStatus("idle");
    } catch (err) {
      console.error("Failed to clear recording save path:", err);
      setRecordingSavePathStatus("error");
      setTimeout(() => setRecordingSavePathStatus("idle"), 3000);
    }
  };

  const updateRecordingConfig = (partial: Partial<RecordingConfig>) => {
    const previous = recordingConfigRef.current;
    const next = { ...previous, ...partial };
    const version = ++recordingConfigSaveVersionRef.current;
    recordingConfigRef.current = next;
    setRecordingConfig(next);

    const save = recordingConfigSaveQueueRef.current
      .catch(() => undefined)
      .then(() => saveRecordingConfig(next));
    recordingConfigSaveQueueRef.current = save;
    void save
      .then(() => {
        if (version !== recordingConfigSaveVersionRef.current) return;
        setRecordingConfigStatus("saved");
        setTimeout(() => setRecordingConfigStatus("idle"), 1500);
      })
      .catch((err) => {
        if (version !== recordingConfigSaveVersionRef.current) return;
        console.error("Failed to save recording config:", err);
        recordingConfigRef.current = previous;
        setRecordingConfig(previous);
        setRecordingConfigStatus("error");
        setTimeout(() => setRecordingConfigStatus("idle"), 3000);
      });
  };

  // ── 快速输入转盘 handler ──

  // 把浏览器按键的 key 值映射为后端可解析的触发键名（对应 quick_input::parse_trigger_key）
  const qiKeyFromEvent = (key: string): string | null => {
    if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase(); // 字母键 → "A".."Z"
    if (/^[0-9]$/.test(key)) return key; // 数字键 → "0".."9"
    if (/^F([1-9]|1[0-2])$/.test(key)) return key; // F1..F12
    const named: Record<string, string> = {
      CapsLock: "CapsLock",
      ScrollLock: "ScrollLock",
      NumLock: "NumLock",
      Pause: "Pause",
      " ": "Space",
      Spacebar: "Space",
      Enter: "Enter",
      Tab: "Tab",
      Backspace: "Backspace",
      Escape: "Esc",
      Insert: "Insert",
      Delete: "Delete",
      Home: "Home",
      End: "End",
      PageUp: "PageUp",
      PageDown: "PageDown",
      ArrowLeft: "Left",
      ArrowUp: "Up",
      ArrowRight: "Right",
      ArrowDown: "Down",
    };
    return named[key] ?? null;
  };

  // 触发键采集：监听用户按下的单键后保存
  const handleQiTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (!qiTriggerRecording) return;
    e.preventDefault();
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return; // 忽略纯修饰键
    if (e.key === "Escape") {
      setQiTriggerRecording(false);
      return;
    }
    const name = qiKeyFromEvent(e.key);
    if (!name) return; // 不支持的按键，保持监听
    // 前端即时拦截会干扰日常输入的键（与后端 is_dangerous_trigger_vk 保持一致）
    if (
      /^[A-Z0-9]$/.test(name) ||
      /^(Space|Enter|Tab|Backspace|Esc|Insert|Delete|Home|End|PageUp|PageDown|Left|Right|Up|Down)$/.test(
        name,
      )
    ) {
      setQiTriggerError(
        "该键在日常输入中经常用到，设为触发键会中断打字。请选择 CapsLock、ScrollLock 等锁定键或功能键。",
      );
      setQiTriggerKeyStatus("error");
      return; // 保持采集/焦点，允许用户换键
    }
    setQiTriggerError("");
    setQiTriggerRecording(false);
    changeQiTriggerKey(name);
  };

  const changeQiTriggerKey = async (key: string) => {
    const previous = qiTriggerKey;
    setQiTriggerKey(key);
    setQiTriggerKeyStatus("idle");
    try {
      await invoke("set_quick_input_trigger_key", { key });
      setQiTriggerError("");
      setQiTriggerKeyStatus("saved");
      setTimeout(() => setQiTriggerKeyStatus("idle"), 2000);
    } catch (err) {
      console.error("Failed to set quick input trigger key:", err);
      setQiTriggerKey(previous); // 保存失败回滚显示
      setQiTriggerError(String(err));
      setQiTriggerKeyStatus("error");
      setTimeout(() => setQiTriggerKeyStatus("idle"), 3000);
    }
  };

  const changeQiMode = async (mode: string) => {
    setQiMode(mode);
    setQiModeStatus("idle");
    try {
      await invoke("set_quick_input_mode", { mode });
      setQiModeStatus("saved");
      setTimeout(() => setQiModeStatus("idle"), 2000);
    } catch (err) {
      console.error("Failed to set quick input mode:", err);
      setQiModeStatus("error");
      setTimeout(() => setQiModeStatus("idle"), 3000);
    }
  };

  const saveQiSnippets = async (next: QuickInputSnippet[]) => {
    setQiSnippets(next);
    setQiSnippetsStatus("idle");
    try {
      await invoke("set_quick_input_snippets", { snippets: JSON.stringify(next) });
      setQiSnippetsStatus("saved");
      setTimeout(() => setQiSnippetsStatus("idle"), 2000);
    } catch (err) {
      console.error("Failed to save quick input snippets:", err);
      setQiSnippetsStatus("error");
      setTimeout(() => setQiSnippetsStatus("idle"), 3000);
    }
  };

  const addQiSnippet = () => {
    if (!qiNewText.trim()) return;
    const next = [
      ...qiSnippets,
      { label: qiNewLabel.trim() || qiNewText.slice(0, 20), text: qiNewText },
    ];
    setQiNewLabel("");
    setQiNewText("");
    void saveQiSnippets(next);
  };

  const removeQiSnippet = (idx: number) => {
    const next = qiSnippets.filter((_, i) => i !== idx);
    // 删除的是编辑行则退出编辑；删除的是编辑行之前的行，编辑索引需前移跟随，避免编辑内容错位
    if (qiEditingIndex !== null) {
      if (qiEditingIndex === idx) setQiEditingIndex(null);
      else if (qiEditingIndex > idx) setQiEditingIndex(qiEditingIndex - 1);
    }
    void saveQiSnippets(next);
  };

  /** 上移/下移预设词，调整其在转盘中的排列位置 */
  const moveQiSnippet = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= qiSnippets.length) return;
    const next = [...qiSnippets];
    [next[idx], next[target]] = [next[target], next[idx]];
    // 正在编辑的行若随移动变更索引，同步更新，避免编辑内容错位
    if (qiEditingIndex === idx) {
      setQiEditingIndex(target);
    } else if (qiEditingIndex === target) {
      setQiEditingIndex(idx);
    }
    void saveQiSnippets(next);
  };

  /** 进入编辑模式，用当前值填充编辑框 */
  const startEditQiSnippet = (idx: number) => {
    const snippet = qiSnippets[idx];
    if (!snippet) return;
    setQiEditingIndex(idx);
    setQiEditLabel(snippet.label);
    setQiEditText(snippet.text);
  };

  /** 保存当前编辑结果，落库并退出编辑模式 */
  const saveEditQiSnippet = () => {
    if (qiEditingIndex === null) return;
    // 文本为空则不保存
    if (!qiEditText.trim()) {
      setQiEditingIndex(null);
      return;
    }
    const next = qiSnippets.map((s, i) =>
      i === qiEditingIndex
        ? { label: qiEditLabel.trim() || qiEditText.slice(0, 20), text: qiEditText }
        : s,
    );
    setQiEditingIndex(null);
    void saveQiSnippets(next);
  };

  const cancelEditQiSnippet = () => setQiEditingIndex(null);

  /** 清空剪贴板历史（后端内存缓冲区） */
  const clearQiHistory = async () => {
    setQiHistoryStatus("idle");
    try {
      await invoke("clear_quick_input_history");
      setQiHistory([]);
      setQiHistoryStatus("cleared");
      setTimeout(() => setQiHistoryStatus("idle"), 2000);
    } catch (err) {
      console.error("Failed to clear quick input history:", err);
      setQiHistoryStatus("error");
      setTimeout(() => setQiHistoryStatus("idle"), 3000);
    }
  };

  const pickScreenshotSavePath = async () => {
    try {
      const folder = await invoke<string | null>("pick_folder");
      if (folder) {
        const previous = screenshotSavePath;
        setScreenshotSavePath(folder);
        try {
          await invoke("set_screenshot_save_path", { path: folder });
          setScreenshotSavePathStatus("saved");
          setTimeout(() => setScreenshotSavePathStatus("idle"), 1500);
        } catch {
          setScreenshotSavePath(previous);
          setScreenshotSavePathStatus("error");
          setTimeout(() => setScreenshotSavePathStatus("idle"), 3000);
        }
      }
    } catch (err) {
      console.error("Failed to pick screenshot save path:", err);
      setScreenshotSavePathStatus("error");
      setTimeout(() => setScreenshotSavePathStatus("idle"), 3000);
    }
  };

  const clearScreenshotSavePath = async () => {
    try {
      await invoke("set_screenshot_save_path", { path: "" });
      setScreenshotSavePath("");
      setScreenshotSavePathStatus("idle");
    } catch (err) {
      console.error("Failed to clear screenshot save path:", err);
      setScreenshotSavePathStatus("error");
      setTimeout(() => setScreenshotSavePathStatus("idle"), 3000);
    }
  };

  const handleSaveAiConfig = async () => {
    setAiSaveStatus("saving");
    try {
      await invoke("update_ai_config", { newConfig: aiConfig });
      setAiSaveStatus("saved");
      setTimeout(() => setAiSaveStatus("idle"), 2000);
    } catch (err) {
      console.error("Failed to save AI config:", err);
      setAiSaveStatus("error");
      setTimeout(() => setAiSaveStatus("idle"), 3000);
    }
  };

  return (
    <div className="settings-shell">
      <TitleBar />
      <div className="settings-layout">
        <nav className="settings-sidebar">
          <div className="settings-sidebar-title">设置</div>
          {SETTINGS_TABS.map((tab) => (
            <button
              key={tab.id}
              className={`settings-nav-item${activeTab === tab.id ? " is-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon name={tab.icon} size={18} />
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
        <main className="settings-content">
          {/* ── 通用 ──────────────────────────────────────── */}
          {activeTab === "general" && (
            <>
              <h2 className="settings-panel-title">通用设置</h2>
              <div className="settings-item">
                <label className="settings-checkbox-label">
                  <input
                    type="checkbox"
                    checked={autoStart}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      setAutoStart(enabled);
                      setAutoStartError(false);
                      invoke("set_auto_start", { enable: enabled }).catch((err) => {
                        console.error("Failed to set auto start:", err);
                        setAutoStart(!enabled);
                        setAutoStartError(true);
                      });
                    }}
                  />
                  <span>开机自启动</span>
                </label>
                {autoStartError && (
                  <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    设置失败
                  </span>
                )}
              </div>
              <div className="settings-item">
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-theme">
                    主题
                  </label>
                  <select
                    id="settings-theme"
                    value={theme}
                    onChange={(e) => {
                      setTheme(e.target.value as "light" | "dark");
                      setThemePreferencesError(false);
                    }}
                    className="settings-select"
                  >
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                  </select>
                </div>
              </div>
              <div className="settings-item">
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-theme-scheme">
                    界面风格
                  </label>
                  <select
                    id="settings-theme-scheme"
                    value={themeScheme}
                    onChange={(e) => {
                      setThemeScheme(e.target.value as ThemeSchemeId);
                      setThemePreferencesError(false);
                    }}
                    className="settings-select"
                  >
                    {THEME_SCHEMES.map((scheme) => (
                      <option key={scheme.id} value={scheme.id}>
                        {scheme.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="settings-item">
                <span className="settings-label" id="settings-theme-accent-label">
                  主题色
                </span>
                <div
                  className="settings-color-options"
                  role="radiogroup"
                  aria-labelledby="settings-theme-accent-label"
                >
                  {THEME_ACCENTS.map((accent, index) => (
                    <button
                      key={accent.id}
                      type="button"
                      className={`settings-color-option ${themeAccent === accent.id ? "is-selected" : ""}`}
                      style={{ "--swatch-color": accent[theme].swatch } as React.CSSProperties}
                      onClick={() => {
                        setThemeAccent(accent.id);
                        setThemePreferencesError(false);
                      }}
                      onKeyDown={(event) => {
                        if (
                          ![
                            "ArrowRight",
                            "ArrowDown",
                            "ArrowLeft",
                            "ArrowUp",
                            "Home",
                            "End",
                          ].includes(event.key)
                        ) {
                          return;
                        }
                        event.preventDefault();
                        const direction =
                          event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
                        const nextIndex =
                          event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? THEME_ACCENTS.length - 1
                              : (index + direction + THEME_ACCENTS.length) % THEME_ACCENTS.length;
                        setThemeAccent(THEME_ACCENTS[nextIndex].id);
                        setThemePreferencesError(false);
                        accentOptionRefs.current[nextIndex]?.focus();
                      }}
                      ref={(element) => {
                        accentOptionRefs.current[index] = element;
                      }}
                      role="radio"
                      aria-checked={themeAccent === accent.id}
                      aria-label={`${accent.label}主题色`}
                      title={accent.label}
                      tabIndex={themeAccent === accent.id ? 0 : -1}
                    >
                      <span className="settings-color-swatch" />
                      {themeAccent === accent.id && (
                        <Icon name="Check" size={13} aria-hidden="true" />
                      )}
                    </button>
                  ))}
                </div>
                {themePreferencesError && (
                  <span className="settings-hint settings-theme-error">
                    主题设置保存失败，已恢复为上一次设置
                  </span>
                )}
              </div>

              <hr className="settings-divider" />
              <h3 className="settings-subsection-title">悬浮窗位置</h3>
              <p className="settings-hint">
                悬浮球、系统监控、番茄钟会记住上次拖拽的位置；窗口被拖到角落或屏幕布局变化后可在此一键恢复默认位置。
              </p>
              <div className="settings-pos-list">
                {WINDOW_POSITION_TARGETS.map((target) => {
                  const status = resetPosStatus[target.id] ?? "idle";
                  return (
                    <div className="settings-pos-row" key={target.id}>
                      <span className="settings-pos-label">
                        <Icon name={target.icon} size={16} aria-hidden="true" />
                        {target.label}
                      </span>
                      <button
                        className="settings-reset-pos-btn"
                        onClick={() => handleResetWindowPosition(target.id)}
                        disabled={status === "saving"}
                      >
                        {status === "saved" ? (
                          <>
                            <Icon name="Check" size={14} /> 已恢复
                          </>
                        ) : status === "error" ? (
                          <>
                            <Icon name="X" size={14} /> 恢复失败
                          </>
                        ) : status === "saving" ? (
                          <>恢复中…</>
                        ) : (
                          <>
                            <Icon name="Undo2" size={14} /> 恢复默认位置
                          </>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="settings-pos-actions">
                <button
                  className="settings-reset-pos-btn"
                  onClick={handleResetAllWindowPositions}
                  disabled={resetAllStatus === "saving"}
                >
                  {resetAllStatus === "saving" ? (
                    <>恢复中…</>
                  ) : (
                    <>
                      <Icon name="RotateCcw" size={14} /> 全部恢复默认位置
                    </>
                  )}
                </button>
                {resetAllStatus === "saved" && <span className="settings-hint">已恢复</span>}
                {resetAllStatus === "error" && (
                  <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    恢复失败
                  </span>
                )}
              </div>
            </>
          )}

          {/* ── 截图 ──────────────────────────────────────── */}
          {activeTab === "capture" && (
            <>
              <h2 className="settings-panel-title">截图/录屏</h2>
              <h3 className="settings-subsection-title">截图</h3>
              <div className="settings-item">
                <label className="settings-label" htmlFor="settings-hotkey">
                  截图快捷键
                </label>
                <div className="settings-inline-group">
                  <input
                    id="settings-hotkey"
                    type="text"
                    value={hotkeyRecording ? "按下组合键…" : screenshotHotkey}
                    readOnly
                    placeholder="点击设置快捷键"
                    onFocus={() => {
                      setHotkeyRecording(true);
                      setHotkeyError("");
                    }}
                    onBlur={() => setHotkeyRecording(false)}
                    onKeyDown={handleHotkeyKeyDown}
                    className="settings-input"
                    style={{ width: 180 }}
                  />
                  {screenshotHotkey && (
                    <button
                      className="settings-toggle-btn"
                      onClick={clearHotkey}
                      title="清除快捷键"
                      aria-label="清除快捷键"
                    >
                      <Icon name="X" size={16} />
                    </button>
                  )}
                </div>
                {hotkeyStatus === "saving" && <span className="settings-hint">保存中…</span>}
                {hotkeyStatus === "saved" && <span className="settings-hint">已保存</span>}
                {hotkeyStatus === "error" && (
                  <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    保存失败
                  </span>
                )}
                {hotkeyError && (
                  <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    {hotkeyError}
                  </p>
                )}
              </div>
              <div className="settings-item">
                <label className="settings-label">保存路径</label>
                <div className="settings-inline-group">
                  <input
                    type="text"
                    value={screenshotSavePath}
                    readOnly
                    placeholder="未设置，保存时将弹出对话框"
                    className="settings-input"
                    style={{ flex: 1 }}
                  />
                  <button
                    className="settings-toggle-btn"
                    onClick={pickScreenshotSavePath}
                    title="选择文件夹"
                    aria-label="选择文件夹"
                  >
                    <Icon name="FolderOpen" size={16} />
                  </button>
                  {screenshotSavePath && (
                    <button
                      className="settings-toggle-btn"
                      onClick={clearScreenshotSavePath}
                      title="清除路径"
                      aria-label="清除路径"
                    >
                      <Icon name="X" size={16} />
                    </button>
                  )}
                </div>
                {screenshotSavePathStatus === "saved" && (
                  <span className="settings-hint">已保存</span>
                )}
                {screenshotSavePathStatus === "error" && (
                  <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    保存失败
                  </span>
                )}
              </div>
              <div className="settings-item">
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-ocr-engine">
                    识别引擎
                  </label>
                  <select
                    id="settings-ocr-engine"
                    value={ocrAvailableEngines.includes(ocrActiveEngine) ? ocrActiveEngine : ""}
                    onChange={(e) => handleChangeOcrEngine(e.target.value)}
                    className="settings-select"
                    disabled={ocrAvailableEngines.length <= 1}
                  >
                    {ocrAvailableEngines.map((id) => (
                      <option key={id} value={id}>
                        {OCR_ENGINE_LABELS[id] ?? id}
                      </option>
                    ))}
                  </select>
                </div>
                {ocrAvailableEngines.length === 0 && (
                  <span className="settings-hint">未检测到可用 OCR 引擎</span>
                )}
                {ocrAvailableEngines.length > 1 && (
                  <span className="settings-hint">截图识别文字时使用的引擎</span>
                )}
                {ocrStatus === "saved" && <span className="settings-hint">已保存</span>}
                {ocrStatus === "error" && (
                  <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    保存失败
                  </span>
                )}
              </div>

              <hr className="settings-divider" />
              <h3 className="settings-subsection-title">录屏</h3>
              <div className="settings-item">
                <label className="settings-label" htmlFor="settings-recording-hotkey">
                  录屏快捷键
                </label>
                <div className="settings-inline-group">
                  <input
                    id="settings-recording-hotkey"
                    type="text"
                    value={recordingHotkeyRecording ? "按下组合键…" : recordingHotkey}
                    readOnly
                    placeholder="点击设置快捷键"
                    onFocus={() => {
                      setRecordingHotkeyRecording(true);
                      setRecordingHotkeyError("");
                    }}
                    onBlur={() => setRecordingHotkeyRecording(false)}
                    onKeyDown={handleRecordingHotkeyKeyDown}
                    className="settings-input"
                    style={{ width: 180 }}
                  />
                  {recordingHotkey && (
                    <button
                      className="settings-toggle-btn"
                      onClick={clearRecordingHotkey}
                      title="清除快捷键"
                      aria-label="清除快捷键"
                    >
                      <Icon name="X" size={16} />
                    </button>
                  )}
                </div>
                {recordingHotkeyStatus === "saving" && (
                  <span className="settings-hint">保存中…</span>
                )}
                {recordingHotkeyStatus === "saved" && <span className="settings-hint">已保存</span>}
                {recordingHotkeyStatus === "error" && (
                  <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    保存失败
                  </span>
                )}
                {recordingHotkeyError && (
                  <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    {recordingHotkeyError}
                  </p>
                )}
              </div>
              <div className="settings-item">
                <label className="settings-label">保存路径</label>
                <div className="settings-inline-group">
                  <input
                    type="text"
                    value={recordingSavePath}
                    readOnly
                    placeholder="未设置，保存时将弹出对话框"
                    className="settings-input"
                    style={{ flex: 1 }}
                  />
                  <button
                    className="settings-toggle-btn"
                    onClick={pickRecordingSavePath}
                    title="选择文件夹"
                    aria-label="选择文件夹"
                  >
                    <Icon name="FolderOpen" size={16} />
                  </button>
                  {recordingSavePath && (
                    <button
                      className="settings-toggle-btn"
                      onClick={clearRecordingSavePath}
                      title="清除路径"
                      aria-label="清除路径"
                    >
                      <Icon name="X" size={16} />
                    </button>
                  )}
                </div>
                {recordingSavePathStatus === "saved" && (
                  <span className="settings-hint">已保存</span>
                )}
                {recordingSavePathStatus === "error" && (
                  <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    保存失败
                  </span>
                )}
              </div>
              <div className="settings-item settings-row">
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-recording-gif-fps">
                    GIF 帧率
                  </label>
                  <select
                    id="settings-recording-gif-fps"
                    value={recordingConfig.gifFps}
                    onChange={(e) => updateRecordingConfig({ gifFps: Number(e.target.value) })}
                    className="settings-select"
                  >
                    {GIF_FPS_OPTION_ITEMS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-recording-video-fps">
                    视频帧率
                  </label>
                  <select
                    id="settings-recording-video-fps"
                    value={recordingConfig.videoFps}
                    onChange={(e) => updateRecordingConfig({ videoFps: Number(e.target.value) })}
                    className="settings-select"
                  >
                    {VIDEO_FPS_OPTION_ITEMS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="settings-item settings-row">
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-recording-max-duration">
                    最长录制时长
                  </label>
                  <select
                    id="settings-recording-max-duration"
                    value={recordingConfig.maxDurationSec}
                    onChange={(e) =>
                      updateRecordingConfig({ maxDurationSec: Number(e.target.value) })
                    }
                    className="settings-select"
                  >
                    {MAX_DURATION_OPTION_ITEMS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {recordingConfigStatus === "saved" && <p className="settings-hint">已保存</p>}
              {recordingConfigStatus === "error" && (
                <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                  保存失败，请重试
                </p>
              )}
            </>
          )}

          {/* ── 快速输入转盘 ──────────────────────────────────── */}
          {activeTab === "quick-input" && (
            <>
              <h2 className="settings-panel-title">快速输入转盘</h2>
              <p className="settings-panel-desc">
                唤起转盘，将鼠标悬停到目标扇区即可选中预设词或剪贴板历史，输入到当前光标位置
              </p>
              <div className="settings-item">
                <div className="settings-item-head">
                  <label className="settings-label">触发方式</label>
                  <span
                    className="settings-hint-inline"
                    title="点击切换：按下触发键唤起转盘，再按触发键关闭；鼠标点击扇区即输入。按住唤起：按住触发键转盘即出现，鼠标悬停高亮目标扇区，松开触发键即输入该扇区。"
                  >
                    <Icon name="AlertCircle" size={14} aria-hidden="true" />
                  </span>
                </div>
                <div className="settings-radio-row">
                  <label className={`settings-radio-chip ${qiMode === "click" ? "is-active" : ""}`}>
                    <input
                      type="radio"
                      name="qi-mode"
                      value="click"
                      checked={qiMode === "click"}
                      onChange={(e) => e.target.checked && changeQiMode("click")}
                    />
                    <span>点击切换</span>
                  </label>
                  <label className={`settings-radio-chip ${qiMode === "hold" ? "is-active" : ""}`}>
                    <input
                      type="radio"
                      name="qi-mode"
                      value="hold"
                      checked={qiMode === "hold"}
                      onChange={(e) => e.target.checked && changeQiMode("hold")}
                    />
                    <span>按住唤起</span>
                  </label>
                </div>
                {qiModeStatus === "saved" && <span className="settings-hint">已保存</span>}
                {qiModeStatus === "error" && (
                  <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    保存失败
                  </span>
                )}
              </div>
              <div className="settings-item">
                <div className="settings-item-head">
                  <label className="settings-label" htmlFor="settings-qi-trigger">
                    触发键
                  </label>
                  <span
                    className="settings-hint-inline"
                    title="唤起转盘并选择输入的触发键。具体交互取决于上方「触发方式」，仅启用该工具后生效。"
                  >
                    <Icon name="AlertCircle" size={14} aria-hidden="true" />
                  </span>
                </div>
                <input
                  type="text"
                  id="settings-qi-trigger"
                  className="settings-input"
                  style={{ width: 220 }}
                  value={qiTriggerRecording ? "按下按键…" : qiTriggerKey}
                  readOnly
                  onClick={() => {
                    setQiTriggerRecording(true);
                  }}
                  onKeyDown={handleQiTriggerKeyDown}
                  onBlur={() => setQiTriggerRecording(false)}
                  placeholder="点击后按下任意键"
                  title="点击输入框，再按下你要设为触发键的按键。"
                />
                {qiTriggerKeyStatus === "saved" && <span className="settings-hint">已保存</span>}
                {qiTriggerKeyStatus === "error" && qiTriggerError && (
                  <span
                    className="settings-hint"
                    style={{ color: "var(--color-danger-fg)", maxWidth: 260 }}
                  >
                    {qiTriggerError}
                  </span>
                )}
              </div>
              <div className="settings-item">
                <div className="settings-item-head">
                  <label className="settings-label">预设提示词</label>
                  <span
                    className="settings-hint-inline"
                    title="转盘扇区展示这些预设词，剪贴板历史会自动追加到预设词之后。可点击铅笔编辑已有预设词。"
                  >
                    <Icon name="AlertCircle" size={14} aria-hidden="true" />
                  </span>
                </div>
                <div className="qi-snippet-list">
                  {qiSnippets.length === 0 && (
                    <p className="settings-hint" style={{ opacity: 0.6 }}>
                      暂无预设词
                    </p>
                  )}
                  {qiSnippets.map((s, i) =>
                    qiEditingIndex === i ? (
                      <div className="qi-snippet-row qi-snippet-editing" key={i}>
                        <input
                          type="text"
                          value={qiEditLabel}
                          onChange={(e) => setQiEditLabel(e.target.value)}
                          placeholder="标签（可选）"
                          className="settings-input qi-snippet-edit-label"
                        />
                        <input
                          type="text"
                          value={qiEditText}
                          onChange={(e) => setQiEditText(e.target.value)}
                          placeholder="输入文本…"
                          className="settings-input"
                          style={{ flex: 1 }}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEditQiSnippet();
                            if (e.key === "Escape") cancelEditQiSnippet();
                          }}
                        />
                        <button
                          className="settings-toggle-btn settings-toggle-btn-sm"
                          onClick={saveEditQiSnippet}
                          title="保存"
                          aria-label="保存"
                        >
                          <Icon name="Check" size={14} />
                        </button>
                        <button
                          className="settings-toggle-btn settings-toggle-btn-sm"
                          onClick={cancelEditQiSnippet}
                          title="取消"
                          aria-label="取消"
                        >
                          <Icon name="X" size={14} />
                        </button>
                      </div>
                    ) : (
                      <div className="qi-snippet-row" key={i}>
                        <div className="qi-snippet-label" title={s.label}>
                          {s.label}
                        </div>
                        <div className="qi-snippet-text" title={s.text}>
                          {s.text}
                        </div>
                        <div className="qi-snippet-actions">
                          <button
                            className="settings-toggle-btn settings-toggle-btn-sm"
                            onClick={() => moveQiSnippet(i, -1)}
                            disabled={i === 0}
                            title="上移"
                            aria-label="上移"
                          >
                            <Icon name="ArrowUp" size={14} />
                          </button>
                          <button
                            className="settings-toggle-btn settings-toggle-btn-sm"
                            onClick={() => moveQiSnippet(i, 1)}
                            disabled={i === qiSnippets.length - 1}
                            title="下移"
                            aria-label="下移"
                          >
                            <Icon name="ArrowDown" size={14} />
                          </button>
                          <button
                            className="settings-toggle-btn settings-toggle-btn-sm"
                            onClick={() => startEditQiSnippet(i)}
                            title="编辑"
                            aria-label="编辑"
                          >
                            <Icon name="Pencil" size={14} />
                          </button>
                          <button
                            className="settings-toggle-btn settings-toggle-btn-sm"
                            onClick={() => removeQiSnippet(i)}
                            title="删除"
                            aria-label="删除"
                          >
                            <Icon name="X" size={14} />
                          </button>
                        </div>
                      </div>
                    ),
                  )}
                </div>
                <div className="qi-snippet-add">
                  <input
                    type="text"
                    value={qiNewLabel}
                    onChange={(e) => setQiNewLabel(e.target.value)}
                    placeholder="标签（可选）"
                    className="settings-input"
                    style={{ width: 120 }}
                  />
                  <input
                    type="text"
                    value={qiNewText}
                    onChange={(e) => setQiNewText(e.target.value)}
                    placeholder="输入文本…"
                    className="settings-input"
                    style={{ flex: 1 }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addQiSnippet();
                    }}
                  />
                  <button className="settings-toggle-btn" onClick={addQiSnippet} title="添加">
                    <Icon name="Check" size={16} />
                  </button>
                </div>
                {qiSnippetsStatus === "saved" && <span className="settings-hint">已保存</span>}
                {qiSnippetsStatus === "error" && (
                  <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    保存失败
                  </span>
                )}
              </div>
              <div className="settings-item">
                <div className="settings-item-head">
                  <label className="settings-label">剪贴板历史</label>
                  <span
                    className="settings-hint-inline"
                    title="自动记录复制到剪贴板的文本，最新在前，最多 20 条；可在转盘扇区中选中输入。"
                  >
                    <Icon name="AlertCircle" size={14} aria-hidden="true" />
                  </span>
                </div>
                <div className="qi-snippet-list">
                  {qiHistory.length === 0 && (
                    <p className="settings-hint" style={{ opacity: 0.6 }}>
                      暂无历史
                    </p>
                  )}
                  {qiHistory.map((h, i) => (
                    <div className="qi-snippet-row" key={i} title={h.text}>
                      <div className="qi-snippet-text">{h.preview}</div>
                    </div>
                  ))}
                </div>
                <div className="qi-history-actions">
                  <button
                    className="settings-danger-btn"
                    onClick={clearQiHistory}
                    disabled={qiHistory.length === 0}
                    title="清空剪贴板历史"
                  >
                    <Icon name="Eraser" size={14} />
                    清空历史
                  </button>
                  {qiHistoryStatus === "cleared" && <span className="settings-hint">已清空</span>}
                  {qiHistoryStatus === "error" && (
                    <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                      清空失败
                    </span>
                  )}
                </div>
              </div>
            </>
          )}

          {/* ── 系统监控 ──────────────────────────────────── */}
          {activeTab === "monitor" && (
            <>
              <h2 className="settings-panel-title">系统监控</h2>
              <p className="settings-panel-desc">配置监控悬浮窗的数据刷新频率和显示密度。</p>
              <div className="settings-item">
                <label
                  className={`settings-checkbox-label${systemMonitorEnabled ? "" : " is-disabled"}`}
                >
                  <input
                    type="checkbox"
                    checked={autostartIds.includes("system-monitor")}
                    disabled={!systemMonitorEnabled}
                    onChange={() => handleToggleToolAutostart("system-monitor")}
                  />
                  <span>启动时自动打开</span>
                </label>
                {!systemMonitorEnabled && (
                  <span className="settings-hint">该工具未启用，需先在悬浮球面板中启用</span>
                )}
                {autostartError && (
                  <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    设置失败
                  </span>
                )}
              </div>
              <div className="settings-item settings-row">
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-monitor-interval">
                    刷新间隔
                  </label>
                  <select
                    id="settings-monitor-interval"
                    value={systemMonitorConfig.intervalMs}
                    onChange={(e) =>
                      updateSystemMonitorConfig({ intervalMs: Number(e.target.value) })
                    }
                    className="settings-select"
                  >
                    {MONITOR_INTERVAL_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-monitor-display-mode">
                    显示模式
                  </label>
                  <select
                    id="settings-monitor-display-mode"
                    value={systemMonitorConfig.displayMode}
                    onChange={(e) =>
                      updateSystemMonitorConfig({
                        displayMode: e.target.value as SystemMonitorDisplayMode,
                      })
                    }
                    className="settings-select"
                  >
                    <option value="full">标准</option>
                    <option value="mini">迷你</option>
                  </select>
                </div>
              </div>
              {systemMonitorStatus === "saved" && <p className="settings-hint">已保存</p>}
              {systemMonitorStatus === "error" && (
                <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                  保存失败，请重试
                </p>
              )}
            </>
          )}

          {/* ── 番茄钟 ──────────────────────────────────── */}
          {activeTab === "pomodoro" && (
            <>
              <h2 className="settings-panel-title">番茄钟</h2>
              <p className="settings-panel-desc">配置番茄钟悬浮窗的倒计时时长与自动循环。</p>
              <div className="settings-item">
                <label
                  className={`settings-checkbox-label${pomodoroEnabled ? "" : " is-disabled"}`}
                >
                  <input
                    type="checkbox"
                    checked={autostartIds.includes("pomodoro")}
                    disabled={!pomodoroEnabled}
                    onChange={() => handleToggleToolAutostart("pomodoro")}
                  />
                  <span>启动时自动打开</span>
                </label>
                {!pomodoroEnabled && (
                  <span className="settings-hint">该工具未启用，需先在悬浮球面板中启用</span>
                )}
                {autostartError && (
                  <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    设置失败
                  </span>
                )}
              </div>
              <div className="settings-item settings-row">
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-pomodoro-work">
                    专注时长
                  </label>
                  <select
                    id="settings-pomodoro-work"
                    value={pomodoroConfig.workMinutes}
                    onChange={(e) => updatePomodoroConfig({ workMinutes: Number(e.target.value) })}
                    className="settings-select"
                  >
                    {POMODORO_WORK_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-pomodoro-short">
                    短休息
                  </label>
                  <select
                    id="settings-pomodoro-short"
                    value={pomodoroConfig.shortBreakMinutes}
                    onChange={(e) =>
                      updatePomodoroConfig({ shortBreakMinutes: Number(e.target.value) })
                    }
                    className="settings-select"
                  >
                    {POMODORO_SHORT_BREAK_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="settings-item settings-row">
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-pomodoro-long">
                    长休息
                  </label>
                  <select
                    id="settings-pomodoro-long"
                    value={pomodoroConfig.longBreakMinutes}
                    onChange={(e) =>
                      updatePomodoroConfig({ longBreakMinutes: Number(e.target.value) })
                    }
                    className="settings-select"
                  >
                    {POMODORO_LONG_BREAK_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-pomodoro-rounds">
                    长休息间隔
                  </label>
                  <select
                    id="settings-pomodoro-rounds"
                    value={pomodoroConfig.roundsBeforeLongBreak}
                    onChange={(e) =>
                      updatePomodoroConfig({ roundsBeforeLongBreak: Number(e.target.value) })
                    }
                    className="settings-select"
                  >
                    {POMODORO_ROUNDS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="settings-item">
                <label className="settings-checkbox-label">
                  <input
                    type="checkbox"
                    checked={pomodoroConfig.autoStartNext}
                    onChange={(e) => updatePomodoroConfig({ autoStartNext: e.target.checked })}
                  />
                  <span>到点自动开始下一阶段</span>
                </label>
              </div>
              <div className="settings-item settings-row">
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-pomodoro-notify">
                    到点提醒
                  </label>
                  <select
                    id="settings-pomodoro-notify"
                    value={pomodoroConfig.notifySoundType}
                    onChange={(e) =>
                      updatePomodoroConfig({
                        notifySoundType: e.target.value as PomodoroNotifySound,
                      })
                    }
                    className="settings-select"
                  >
                    {POMODORO_NOTIFY_SOUND_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {pomodoroStatus === "saved" && <p className="settings-hint">已保存</p>}
              {pomodoroStatus === "error" && (
                <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                  保存失败，请重试
                </p>
              )}
            </>
          )}

          {/* ── 工具栏 ────────────────────────────────────── */}
          {activeTab === "toolbar" && (
            <>
              <h2 className="settings-panel-title">文字工具</h2>

              <h3 className="settings-subsection-title">功能按钮</h3>
              <p className="settings-hint">选中文字后显示的功能按钮</p>
              <div className="settings-features-grid">
                {TOOLBAR_FEATURES.map((feature) => (
                  <label key={feature.id} className="settings-feature-chip">
                    <input
                      type="checkbox"
                      checked={enabledFeatures.includes(feature.id)}
                      onChange={() => handleToggleFeature(feature.id)}
                    />
                    <Icon name={feature.icon} size={14} />
                    <span>{feature.label}</span>
                  </label>
                ))}
              </div>
              {featuresStatus === "saved" && <p className="settings-hint">已保存</p>}
              {featuresStatus === "error" && (
                <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                  保存失败，请重试
                </p>
              )}

              <hr className="settings-divider" />

              <h3 className="settings-subsection-title">搜索</h3>
              <div className="settings-item settings-row">
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-search-engine">
                    搜索引擎
                  </label>
                  <select
                    id="settings-search-engine"
                    value={searchEngine}
                    onChange={(e) => handleChangeSearchEngine(e.target.value as SearchEngineId)}
                    className="settings-select"
                  >
                    {SEARCH_ENGINE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="settings-hint">「搜索」按钮打开选中文字的搜索引擎</p>
              {searchEngineStatus === "saved" && <p className="settings-hint">已保存</p>}
              {searchEngineStatus === "error" && (
                <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                  保存失败，请重试
                </p>
              )}

              <hr className="settings-divider" />

              <h3 className="settings-subsection-title">去重</h3>
              <div className="settings-item settings-row">
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-dedup-granularity">
                    去重粒度
                  </label>
                  <select
                    id="settings-dedup-granularity"
                    value={dedupMode.granularity}
                    onChange={(e) =>
                      handleChangeDedupMode({
                        ...dedupMode,
                        granularity: e.target.value as DedupGranularity,
                      })
                    }
                    className="settings-select"
                  >
                    {DEDUP_GRANULARITY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                {dedupMode.granularity === "char" && (
                  <div className="settings-inline-group">
                    <label className="settings-label" htmlFor="settings-dedup-char-submode">
                      字符去重方式
                    </label>
                    <select
                      id="settings-dedup-char-submode"
                      value={dedupMode.charSubMode}
                      onChange={(e) =>
                        handleChangeDedupMode({
                          ...dedupMode,
                          charSubMode: e.target.value as CharSubMode,
                        })
                      }
                      className="settings-select"
                    >
                      {DEDUP_CHAR_SUBMODE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              {dedupStatus === "saved" && <p className="settings-hint">已保存</p>}
              {dedupStatus === "error" && (
                <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                  保存失败，请重试
                </p>
              )}

              <hr className="settings-divider" />

              <h3 className="settings-subsection-title">MD5 加密</h3>
              <div className="settings-item settings-row">
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-md5-length">
                    MD5 位数
                  </label>
                  <select
                    id="settings-md5-length"
                    value={md5Length}
                    onChange={(e) => handleChangeMd5Length(e.target.value as Md5Length)}
                    className="settings-select"
                  >
                    {MD5_LENGTH_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {md5Status === "saved" && <p className="settings-hint">已保存</p>}
              {md5Status === "error" && (
                <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                  保存失败，请重试
                </p>
              )}

              <hr className="settings-divider" />

              <h3 className="settings-subsection-title">编号</h3>
              <div className="settings-item settings-row">
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-numbering-style">
                    编号样式
                  </label>
                  <select
                    id="settings-numbering-style"
                    value={numberingStyle}
                    onChange={(e) => handleChangeNumberingStyle(e.target.value as NumberingStyle)}
                    className="settings-select"
                  >
                    {NUMBERING_STYLE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {numberingStatus === "saved" && <p className="settings-hint">已保存</p>}
              {numberingStatus === "error" && (
                <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                  保存失败，请重试
                </p>
              )}

              <hr className="settings-divider" />

              <h3 className="settings-subsection-title">朗读</h3>
              <p className="settings-hint">选中文本朗读的语速、语音与音量</p>
              <div className="settings-item settings-row">
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-tts-rate">
                    语速
                  </label>
                  <select
                    id="settings-tts-rate"
                    value={ttsConfig.rate}
                    onChange={(e) =>
                      handleChangeTtsConfig({ rate: e.target.value as TtsConfig["rate"] })
                    }
                    className="settings-select"
                  >
                    {TTS_RATE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-tts-voice">
                    语音
                  </label>
                  <select
                    id="settings-tts-voice"
                    value={ttsConfig.voiceId}
                    onChange={(e) => handleChangeTtsConfig({ voiceId: e.target.value })}
                    className="settings-select"
                  >
                    <option value="">系统默认</option>
                    {ttsVoices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.display_name}
                        {v.language ? ` (${v.language})` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-tts-volume">
                    音量
                  </label>
                  <select
                    id="settings-tts-volume"
                    value={String(ttsConfig.volume)}
                    onChange={(e) => handleChangeTtsConfig({ volume: parseFloat(e.target.value) })}
                    className="settings-select"
                  >
                    {TTS_VOLUME_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {ttsStatus === "saved" && <p className="settings-hint">已保存</p>}
              {ttsStatus === "error" && (
                <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                  保存失败，请重试
                </p>
              )}

              <hr className="settings-divider" />

              <h3 className="settings-subsection-title">清除项</h3>
              <p className="settings-hint">「清除」按钮子菜单中显示的清除操作</p>
              <div className="settings-features-grid">
                {CLEAR_OPTIONS.map((option) => (
                  <label key={option.id} className="settings-feature-chip">
                    <input
                      type="checkbox"
                      checked={enabledClearIds.includes(option.id)}
                      onChange={() => handleToggleClearOption(option.id)}
                    />
                    <Icon name={option.icon} size={14} />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
              {clearStatus === "saved" && <p className="settings-hint">已保存</p>}
              {clearStatus === "error" && (
                <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                  保存失败，请重试
                </p>
              )}
            </>
          )}

          {/* ── AI 配置 ────────────────────────────────────── */}
          {activeTab === "ai" && (
            <>
              <h2 className="settings-panel-title">AI 配置</h2>
              <div className="settings-item">
                <label className="settings-label" htmlFor="settings-api-type">
                  API 类型
                </label>
                <select
                  id="settings-api-type"
                  value={aiConfig.api_type}
                  onChange={(e) => {
                    const newType = e.target.value;
                    setAiConfig((prev) => {
                      const updated = { ...prev, api_type: newType };
                      if (newType === "openai" && prev.base_url === "https://api.anthropic.com") {
                        updated.base_url = "https://api.openai.com";
                      } else if (
                        newType === "anthropic" &&
                        prev.base_url === "https://api.openai.com"
                      ) {
                        updated.base_url = "https://api.anthropic.com";
                      }
                      return updated;
                    });
                  }}
                  className="settings-select"
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI 兼容</option>
                </select>
              </div>
              <div className="settings-item">
                <label className="settings-label" htmlFor="settings-api-key">
                  API Key
                </label>
                <div className="settings-input-group">
                  <input
                    id="settings-api-key"
                    type={showApiKey ? "text" : "password"}
                    value={aiConfig.api_key}
                    onChange={(e) => setAiConfig({ ...aiConfig, api_key: e.target.value })}
                    placeholder="输入 API Key"
                    className="settings-input"
                    autoComplete="off"
                  />
                  <button
                    className="settings-toggle-btn"
                    onClick={() => setShowApiKey(!showApiKey)}
                    title={showApiKey ? "隐藏" : "显示"}
                    aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                  >
                    <Icon name={showApiKey ? "EyeOff" : "Eye"} size={16} />
                  </button>
                </div>
              </div>
              <div className="settings-item">
                <label className="settings-label" htmlFor="settings-base-url">
                  Base URL
                </label>
                <input
                  id="settings-base-url"
                  type="text"
                  value={aiConfig.base_url}
                  onChange={(e) => setAiConfig({ ...aiConfig, base_url: e.target.value })}
                  placeholder="https://api.anthropic.com"
                  className="settings-input"
                />
              </div>
              <div className="settings-item">
                <label className="settings-label" htmlFor="settings-model">
                  Model
                </label>
                <input
                  id="settings-model"
                  type="text"
                  value={aiConfig.model}
                  onChange={(e) => setAiConfig({ ...aiConfig, model: e.target.value })}
                  placeholder="claude-sonnet-5"
                  className="settings-input"
                />
              </div>
              <div className="settings-item">
                <button
                  className="settings-save-btn"
                  onClick={handleSaveAiConfig}
                  disabled={aiSaveStatus === "saving"}
                  aria-busy={aiSaveStatus === "saving" || undefined}
                >
                  {aiSaveStatus === "saving" && (
                    <>
                      <Icon name="Loader2" size={14} className="settings-save-spinner" /> 保存中...
                    </>
                  )}
                  {aiSaveStatus === "idle" && "保存"}
                  {aiSaveStatus === "saved" && (
                    <>
                      <Icon name="Check" size={14} /> 已保存
                    </>
                  )}
                  {aiSaveStatus === "error" && (
                    <>
                      <Icon name="X" size={14} /> 保存失败
                    </>
                  )}
                </button>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

export default Settings;
