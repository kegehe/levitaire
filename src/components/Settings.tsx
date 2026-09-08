import { useState, useEffect, useRef, useCallback } from "react";
import type { DragEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
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
  DEFAULT_PIN_BORDER_COLOR,
  PIN_BORDER_WIDTH_OPTIONS,
  fetchPinBorderColor,
  fetchPinBorderWidth,
  normalizePinBorderColor,
  normalizePinBorderWidth,
  savePinBorderColor,
  savePinBorderWidth,
  type PinBorderWidth,
} from "../constants/pinConfig";
import {
  THEME_ACCENTS,
  THEME_SCHEMES,
  applyThemePreferences,
  getStoredThemePreferences,
  loadThemePreferences,
  resolveThemeMode,
  subscribeSystemTheme,
  type ThemeAccentId,
  type ThemeMode,
  type ThemePreferences,
  type ThemeSchemeId,
} from "../styles/themePreferences";
import OrbIcon from "./OrbIcon";
import {
  getOrbIcon,
  setOrbIcon,
  ORB_ICON_OPTIONS,
  type OrbIconId,
} from "../constants/orbAppearance";
import { useUpdater } from "../hooks/useUpdater";
import "./Settings.css";
import TitleBar from "./TitleBar";
import {
  MAX_SKETCH_HISTORY_LIMIT,
  SKETCH_HISTORY_LIMIT_KEY,
  readSketchHistoryLimit,
  writeSketchHistoryLimit,
} from "../constants/sketchConfig";

/** 设置页左侧菜单项定义 */
const SYSTEM_SETTINGS_TABS = [
  { id: "general", label: "通用", icon: "Settings" as IconName },
  { id: "ai", label: "AI 配置", icon: "Sparkles" as IconName },
] as const;

const TOOL_SETTINGS_TABS = [
  { id: "screenshot", label: "屏幕截图", icon: "Camera" as IconName },
  { id: "recording", label: "GIF/录屏", icon: "Video" as IconName },
  { id: "sketch", label: "屏幕草稿", icon: "Pencil" as IconName },
  { id: "quick-input", label: "快速输入", icon: "Compass" as IconName },
  { id: "monitor", label: "系统监控", icon: "Activity" as IconName },
  { id: "pomodoro", label: "番茄钟", icon: "Timer" as IconName },
  { id: "timer", label: "时钟、倒计时、秒表与日历", icon: "Timer" as IconName },
  { id: "todo", label: "待办清单", icon: "ListFilter" as IconName },
  { id: "toolbar", label: "文字工具栏", icon: "Grid3x3" as IconName },
] as const;

const SETTINGS_TABS = [...SYSTEM_SETTINGS_TABS, ...TOOL_SETTINGS_TABS] as const;

type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

type HotkeyConflictResult = {
  id: string;
  hotkey: string;
  status: "disabled" | "available" | "internal-conflict" | "external-conflict" | "invalid";
  message: string;
};

/** 支持一键恢复默认位置的悬浮窗（与后端 window_positions 的窗口 id 对应） */
const WINDOW_POSITION_TARGETS = [
  { id: "orb", label: "悬浮球", icon: "GripVertical" as IconName },
  { id: "monitor-overlay", label: "系统监控", icon: "Activity" as IconName },
  { id: "pomodoro-overlay", label: "番茄钟", icon: "Timer" as IconName },
  { id: "time-overlay", label: "时钟、倒计时、秒表与日历", icon: "Timer" as IconName },
  { id: "todo-overlay", label: "待办清单", icon: "ListFilter" as IconName },
] as const;

function Settings() {
  const windowLabel = getCurrentWebviewWindow().label;
  const isToolConfigWindow = windowLabel === "tool-config";
  // The fallback keeps the component fully navigable in unit previews where
  // no Tauri window label is provided; production windows are explicitly
  // labelled `settings` or `tool-config` by App.tsx.
  const visibleTabs = isToolConfigWindow
    ? TOOL_SETTINGS_TABS
    : windowLabel === "settings"
      ? SYSTEM_SETTINGS_TABS
      : SETTINGS_TABS;
  const [activeTab, setActiveTab] = useState<SettingsTabId>(() =>
    isToolConfigWindow ? "screenshot" : "general",
  );
  const [autoStart, setAutoStart] = useState(false);
  const [autoStartError, setAutoStartError] = useState(false);
  const persistedThemePreferencesRef = useRef<ThemePreferences>(getStoredThemePreferences());
  const themeSaveVersionRef = useRef(0);
  const themeSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const accentOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [theme, setTheme] = useState<ThemeMode>(() => persistedThemePreferencesRef.current.theme);
  // 系统深浅色切换时触发重渲染，让 JSX 中按解析主题渲染的色板预览随之更新
  const [, setThemeTick] = useState(0);
  const [themeAccent, setThemeAccent] = useState<ThemeAccentId>(
    () => persistedThemePreferencesRef.current.accent,
  );
  const [themeScheme, setThemeScheme] = useState<ThemeSchemeId>(
    () => persistedThemePreferencesRef.current.scheme,
  );
  const [themePreferencesReady, setThemePreferencesReady] = useState(false);
  const [themePreferencesError, setThemePreferencesError] = useState(false);
  const [orbIcon, setOrbIconState] = useState<OrbIconId>(() => getOrbIcon());
  const orbIconSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [isClosing, setIsClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  const requestSettingsClose = useCallback(() => {
    setIsClosing(true);
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      getCurrentWebviewWindow().close().catch(console.error);
    }, 180);
  }, []);

  const handleOrbIconChange = (id: OrbIconId) => {
    setOrbIconState(id);
    setOrbIcon(id);
    void emit("levitaire-orb-icon-changed", { id });
    // Serialize rapid selections so an older IPC request cannot finish after
    // the latest one and leave the tray/config on the wrong icon.
    orbIconSaveQueueRef.current = orbIconSaveQueueRef.current
      .catch(() => undefined)
      .then(() => invoke<void>("set_orb_icon", { icon: id }))
      .catch((error) => {
        console.error("更新托盘悬浮球图标失败:", error);
      });
  };

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
  const [hotkeyConflicts, setHotkeyConflicts] = useState<Record<string, HotkeyConflictResult>>({});
  const [hotkeyCheckStatus, setHotkeyCheckStatus] = useState<"idle" | "checking" | "error">("idle");
  const hotkeyCheckRequestRef = useRef(0);

  // 屏幕草稿快捷键
  const [sketchHotkey, setSketchHotkey] = useState("Ctrl+Shift+D");
  const sketchHotkeyRef = useRef(sketchHotkey);
  sketchHotkeyRef.current = sketchHotkey;
  const sketchHotkeyRequestRef = useRef(0);
  const sketchHotkeyQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const [sketchHotkeyRecording, setSketchHotkeyRecording] = useState(false);
  const [sketchHotkeyStatus, setSketchHotkeyStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [sketchHotkeyError, setSketchHotkeyError] = useState("");
  const [sketchHistoryLimit, setSketchHistoryLimit] = useState(readSketchHistoryLimit);
  const [sketchHistoryLimitStatus, setSketchHistoryLimitStatus] = useState<"idle" | "saved">(
    "idle",
  );

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
  // 拖拽排序：当前正在拖拽的行索引（null=未拖拽），用于拖动中的行高亮样式
  const [qiDraggingIndex, setQiDraggingIndex] = useState<number | null>(null);
  /** 拖拽源项在当前列表中的实时索引，dragover 计算插入位置用（ref 避免闭包陈旧） */
  const qiDragIndexRef = useRef<number | null>(null);
  /** 拖拽期间的实时列表镜像，结束时据此统一落库 */
  const qiDragSnippetsRef = useRef<QuickInputSnippet[]>([]);
  /** 拖拽期间是否发生过顺序变更；未变更（按下即松开）时 dragend 不落库，避免无意义保存 */
  const qiDragDirtyRef = useRef(false);
  const [qiSnippetsStatus, setQiSnippetsStatus] = useState<"idle" | "saved" | "error">("idle");
  const [qiNewLabel, setQiNewLabel] = useState("");
  const [qiNewText, setQiNewText] = useState("");
  // 剪贴板历史（后端内存缓冲并持久化，默认保留最新 5 条）
  const [qiHistory, setQiHistory] = useState<Array<{ preview: string; text: string }>>([]);
  const [qiHistoryStatus, setQiHistoryStatus] = useState<"idle" | "cleared" | "error">("idle");
  const [qiHistoryEnabled, setQiHistoryEnabled] = useState(true);
  const [qiHistoryEnabledStatus, setQiHistoryEnabledStatus] = useState<"idle" | "saved" | "error">(
    "idle",
  );
  const qiHistoryEnabledRef = useRef(true);
  const qiHistoryEnabledSaveVersionRef = useRef(0);
  // 预设提示词是否启用（关闭后转盘不再展示预设词，已保存内容保留）
  const [qiSnippetsEnabled, setQiSnippetsEnabled] = useState(true);
  const [qiSnippetsEnabledStatus, setQiSnippetsEnabledStatus] = useState<
    "idle" | "saved" | "error"
  >("idle");
  const qiSnippetsEnabledRef = useRef(true);
  const qiSnippetsEnabledSaveVersionRef = useRef(0);
  const [qiHistoryLimit, setQiHistoryLimit] = useState(5);
  const [qiHistoryLimitStatus, setQiHistoryLimitStatus] = useState<"idle" | "saved" | "error">(
    "idle",
  );
  const qiHistoryLimitRef = useRef(5);
  const qiHistoryLimitSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const qiHistoryLimitSaveVersionRef = useRef(0);

  // 设置窗口会被隐藏后复用，不能依赖组件重新挂载来更新历史。
  const refreshQiHistory = useCallback(async () => {
    try {
      const history =
        await invoke<Array<{ preview: string; text: string }>>("get_quick_input_history");
      setQiHistory(history);
    } catch (err) {
      console.error("Failed to refresh quick input history:", err);
    }
  }, []);
  // 正在编辑的预设词下标（null 表示未处于编辑状态）
  const [qiEditingIndex, setQiEditingIndex] = useState<number | null>(null);
  const [qiEditLabel, setQiEditLabel] = useState("");
  const [qiEditText, setQiEditText] = useState("");

  const checkHotkeyConflicts = useCallback(async () => {
    const requestId = ++hotkeyCheckRequestRef.current;
    setHotkeyCheckStatus("checking");
    try {
      const results = await invoke<HotkeyConflictResult[]>("check_hotkey_conflicts");
      if (requestId !== hotkeyCheckRequestRef.current) return;
      setHotkeyConflicts(Object.fromEntries(results.map((result) => [result.id, result])));
      setHotkeyCheckStatus("idle");
    } catch (error) {
      if (requestId !== hotkeyCheckRequestRef.current) return;
      console.error("Failed to check hotkey conflicts:", error);
      setHotkeyCheckStatus("error");
    }
  }, []);

  // 触发键采集状态（true 表示正在监听用户按下的单键）
  const [qiTriggerRecording, setQiTriggerRecording] = useState(false);
  // 触发键保存/校验错误提示文案
  const [qiTriggerError, setQiTriggerError] = useState("");

  // 截图保存路径
  const [screenshotSavePath, setScreenshotSavePath] = useState("");
  const [screenshotSavePathStatus, setScreenshotSavePathStatus] = useState<
    "idle" | "saved" | "error"
  >("idle");
  const [pinBorderColor, setPinBorderColor] = useState(DEFAULT_PIN_BORDER_COLOR);
  const [pinBorderWidth, setPinBorderWidth] = useState<PinBorderWidth>(1);
  const [pinBorderStatus, setPinBorderStatus] = useState<"idle" | "saved" | "error">("idle");
  const pinBorderColorRef = useRef(pinBorderColor);
  const pinBorderWidthRef = useRef(pinBorderWidth);
  // Keep the last values confirmed by the backend so a failed optimistic save
  // can recover even when several edits are queued in quick succession.
  const persistedPinBorderColorRef = useRef(pinBorderColor);
  const persistedPinBorderWidthRef = useRef<PinBorderWidth>(pinBorderWidth);
  const pinBorderColorLoadedRef = useRef(false);
  const pinBorderWidthLoadedRef = useRef(false);
  const pinBorderColorFailedVersionRef = useRef(0);
  const pinBorderWidthFailedVersionRef = useRef(0);
  const pinBorderColorSaveVersionRef = useRef(0);
  const pinBorderWidthSaveVersionRef = useRef(0);
  const pinBorderSaveQueueRef = useRef<Promise<void>>(Promise.resolve());

  // 悬浮工具「启动时自动打开」配置（默认关闭，真值在后端 config.json）
  const [autostartIds, setAutostartIdsState] = useState<string[]>([]);
  // 保存失败时显示错误提示
  const [autostartError, setAutostartError] = useState(false);
  // 系统监控工具是否启用（自启动仅对已启用工具生效，未加载到后端状态前按启用处理）
  const [systemMonitorEnabled, setSystemMonitorEnabled] = useState(true);
  // 番茄钟工具是否启用（自启动仅对已启用工具生效，未加载到后端状态前按启用处理）
  const [pomodoroEnabled, setPomodoroEnabled] = useState(true);
  const [timerEnabled, setTimerEnabled] = useState(false);
  const [timerRemindersEnabled, setTimerRemindersEnabled] = useState(true);
  const [timerReminderSound, setTimerReminderSound] = useState("tone");
  const [timerLunarEnabled, setTimerLunarEnabled] = useState(true);
  const [todoEnabled, setTodoEnabled] = useState(false);
  const [todoRemindersEnabled, setTodoRemindersEnabled] = useState(true);
  const [todoReminderSound, setTodoReminderSound] = useState("tone");
  const [todoQuickAddHotkey, setTodoQuickAddHotkey] = useState("Ctrl+Alt+T");
  const [todoQuickAddRecording, setTodoQuickAddRecording] = useState(false);
  const [todoQuickAddStatus, setTodoQuickAddStatus] = useState<"idle" | "saved" | "error">("idle");
  const [todoQuickAddError, setTodoQuickAddError] = useState("");

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
    Promise.all([
      invoke<boolean>("get_todo_reminders_enabled"),
      invoke<string>("get_todo_reminder_sound"),
    ])
      .then(([enabled, sound]) => {
        setTodoRemindersEnabled(enabled);
        setTodoReminderSound(sound);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    invoke<string>("get_todo_quick_add_hotkey")
      .then((hotkey) => setTodoQuickAddHotkey(hotkey))
      .catch(() => {});
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

  // 主题为「跟随系统」时，随操作系统深浅色切换实时更新外观
  useEffect(() => {
    return subscribeSystemTheme((preferences) => {
      applyThemePreferences(preferences);
      setThemeTick((tick) => tick + 1);
    });
  }, []);

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

  // 设置窗口会被隐藏后复用，因此在进入快捷键相关页面时重新检查一次。
  useEffect(() => {
    void checkHotkeyConflicts();
  }, [checkHotkeyConflicts]);

  useEffect(() => {
    if (
      activeTab === "screenshot" ||
      activeTab === "recording" ||
      activeTab === "sketch" ||
      activeTab === "todo" ||
      activeTab === "quick-input"
    ) {
      void checkHotkeyConflicts();
    }
  }, [activeTab, checkHotkeyConflicts]);

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
      fetchPinBorderColor(),
      fetchPinBorderWidth(),
      invoke<string>("get_quick_input_trigger_key"),
      invoke<string>("get_quick_input_mode"),
      invoke<string>("get_quick_input_snippets"),
      invoke<string[]>("get_tools_autostart"),
      invoke<boolean>("get_timer_enabled"),
      invoke<boolean>("get_timer_reminders_enabled"),
      invoke<string>("get_timer_reminder_sound"),
      invoke<boolean>("get_timer_lunar_enabled"),
      invoke<boolean>("get_quick_input_history_enabled"),
      invoke<Array<{ preview: string; text: string }>>("get_quick_input_history"),
      invoke<boolean>("get_quick_input_snippets_enabled"),
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
        pinColor,
        pinWidth,
        qiKey,
        qiMode,
        qiSnips,
        autostart,
        timer,
        timerReminders,
        timerSound,
        timerLunar,
        qiHistoryEnabledResult,
        qiHist,
        qiSnippetsEnabledResult,
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
        if (pinColor.status === "fulfilled") {
          const value = normalizePinBorderColor(pinColor.value);
          persistedPinBorderColorRef.current = value;
          pinBorderColorLoadedRef.current = true;
          const shouldApply =
            pinBorderColorSaveVersionRef.current === 0 ||
            pinBorderColorFailedVersionRef.current === pinBorderColorSaveVersionRef.current;
          if (shouldApply) {
            pinBorderColorRef.current = value;
            setPinBorderColor(value);
            pinBorderColorFailedVersionRef.current = 0;
          }
        }
        if (pinWidth.status === "fulfilled") {
          const value = normalizePinBorderWidth(pinWidth.value);
          persistedPinBorderWidthRef.current = value;
          pinBorderWidthLoadedRef.current = true;
          const shouldApply =
            pinBorderWidthSaveVersionRef.current === 0 ||
            pinBorderWidthFailedVersionRef.current === pinBorderWidthSaveVersionRef.current;
          if (shouldApply) {
            pinBorderWidthRef.current = value;
            setPinBorderWidth(value);
            pinBorderWidthFailedVersionRef.current = 0;
          }
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
        if (timer.status === "fulfilled") setTimerEnabled(timer.value);
        if (timerReminders.status === "fulfilled") setTimerRemindersEnabled(timerReminders.value);
        if (timerSound.status === "fulfilled")
          setTimerReminderSound(timerSound.value === "none" ? "none" : "tone");
        if (timerLunar.status === "fulfilled") setTimerLunarEnabled(timerLunar.value);
        if (qiHistoryEnabledResult.status === "fulfilled") {
          qiHistoryEnabledRef.current = qiHistoryEnabledResult.value;
          setQiHistoryEnabled(qiHistoryEnabledResult.value);
        }
        if (qiHist.status === "fulfilled") setQiHistory(qiHist.value);
        if (qiSnippetsEnabledResult.status === "fulfilled") {
          qiSnippetsEnabledRef.current = qiSnippetsEnabledResult.value;
          setQiSnippetsEnabled(qiSnippetsEnabledResult.value);
        }
      },
    );
  }, []);

  useEffect(() => {
    invoke<number>("get_quick_input_history_limit")
      .then((limit) => {
        // 用户已开始修改时，忽略较晚返回的初始读取结果，避免覆盖用户输入。
        if (qiHistoryLimitSaveVersionRef.current !== 0) return;
        const normalized = Math.max(0, Math.min(20, Math.trunc(limit)));
        qiHistoryLimitRef.current = normalized;
        setQiHistoryLimit(normalized);
      })
      .catch((err) => console.error("Failed to load quick input history limit:", err));
  }, []);

  // 「启动时自动打开」勾选框依赖工具启用状态（系统监控/番茄钟/时钟与倒计时/待办）。
  // 这些开关可在悬浮球面板等外部入口被改动，而设置窗口隐藏后组件仍挂载，
  // 若只在首次挂载读取会导致勾选框状态滞后，这里单独抽出供重新聚焦时重新同步。
  const refreshToolEnableSnapshot = useCallback(() => {
    void Promise.allSettled([
      invoke<boolean>("get_system_monitor_enabled"),
      invoke<boolean>("get_pomodoro_enabled"),
      invoke<boolean>("get_todo_enabled"),
      invoke<boolean>("get_timer_enabled"),
      invoke<string[]>("get_tools_autostart"),
    ]).then(([monitor, pomodoro, todo, timer, autostart]) => {
      if (monitor.status === "fulfilled") setSystemMonitorEnabled(monitor.value);
      if (pomodoro.status === "fulfilled") setPomodoroEnabled(pomodoro.value);
      if (todo.status === "fulfilled") setTodoEnabled(todo.value);
      if (timer.status === "fulfilled") setTimerEnabled(timer.value);
      if (autostart.status === "fulfilled") setAutostartIdsState(autostart.value);
    });
  }, []);

  // 处理设置窗口被隐藏后再次打开的场景：此时 Settings 组件仍然挂载，
  // 只有重新读取后端快照才能显示最新的剪贴板历史与工具启停/自动打开状态。
  useEffect(() => {
    const window = getCurrentWebviewWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void window
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          setIsClosing(false);
          void refreshQiHistory();
          void refreshToolEnableSnapshot();
        }
      })
      .then((stop) => {
        if (disposed) {
          stop();
        } else {
          unlisten = stop;
        }
      })
      .catch((err) => console.error("Failed to listen for settings focus:", err));

    return () => {
      disposed = true;
      if (closeTimerRef.current !== null) globalThis.clearTimeout(closeTimerRef.current);
      unlisten?.();
    };
  }, [refreshQiHistory, refreshToolEnableSnapshot]);

  // 切换到快速输入页时主动刷新，保证用户看到的是当前后端历史。
  useEffect(() => {
    if (activeTab === "quick-input") void refreshQiHistory();
  }, [activeTab, refreshQiHistory]);

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

  useEffect(() => {
    invoke<string>("get_sketch_hotkey")
      .then((hotkey) => {
        if (sketchHotkeyRequestRef.current !== 0) return;
        setSketchHotkey(hotkey);
        sketchHotkeyRef.current = hotkey;
      })
      .catch((err) => console.error("Failed to load sketch hotkey:", err));
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

  useEffect(() => {
    let cancelled = false;
    invoke<boolean>("get_todo_enabled")
      .then((enabled) => {
        if (!cancelled) setTodoEnabled(enabled);
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
      void checkHotkeyConflicts();
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
      void checkHotkeyConflicts();
      setScreenshotHotkey("");
      setHotkeyStatus("idle");
      setHotkeyError("");
    } catch (err) {
      setHotkeyStatus("error");
      setHotkeyError(String(err));
      setTimeout(() => setHotkeyStatus("idle"), 3000);
    }
  };

  const saveTodoQuickAddHotkey = async (hotkey: string) => {
    const previous = todoQuickAddHotkey;
    setTodoQuickAddHotkey(hotkey);
    try {
      await invoke("set_todo_quick_add_hotkey", { hotkey });
      void checkHotkeyConflicts();
      setTodoQuickAddStatus("saved");
      setTodoQuickAddError("");
      setTimeout(() => setTodoQuickAddStatus("idle"), 2000);
    } catch (error) {
      setTodoQuickAddHotkey(previous);
      setTodoQuickAddStatus("error");
      setTodoQuickAddError(String(error));
    }
  };

  const handleTodoQuickAddKeyDown = (event: React.KeyboardEvent) => {
    if (!todoQuickAddRecording) return;
    event.preventDefault();
    const modifiers: string[] = [];
    if (event.ctrlKey) modifiers.push("Ctrl");
    if (event.altKey) modifiers.push("Alt");
    if (event.shiftKey) modifiers.push("Shift");
    if (event.metaKey) modifiers.push("Win");
    if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
    if (event.key === "Escape") {
      setTodoQuickAddRecording(false);
      return;
    }
    const isFKey = /^F([1-9]|1[0-2])$/.test(event.key);
    if (modifiers.length === 0 && !isFKey) {
      setTodoQuickAddError("快捷键需包含修饰键，或使用 F1-F12");
      return;
    }
    const mainKey = isFKey ? event.key : event.key.length === 1 ? event.key.toUpperCase() : "";
    if (!mainKey) {
      setTodoQuickAddError("不支持的按键");
      return;
    }
    setTodoQuickAddRecording(false);
    setTodoQuickAddError("");
    void saveTodoQuickAddHotkey([...modifiers, mainKey].join("+"));
  };

  const clearTodoQuickAddHotkey = () => {
    void saveTodoQuickAddHotkey("");
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
      void checkHotkeyConflicts();
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
      void checkHotkeyConflicts();
      setRecordingHotkey("");
      setRecordingHotkeyStatus("idle");
      setRecordingHotkeyError("");
    } catch (err) {
      setRecordingHotkeyStatus("error");
      setRecordingHotkeyError(String(err));
      setTimeout(() => setRecordingHotkeyStatus("idle"), 3000);
    }
  };

  const handleSketchHotkeyKeyDown = (e: React.KeyboardEvent) => {
    if (!sketchHotkeyRecording) return;
    e.preventDefault();
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Win");
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
    if (e.key === "Escape") {
      setSketchHotkeyRecording(false);
      return;
    }
    const isFKey = e.key.startsWith("F") && /^F([1-9]|1[0-2])$/.test(e.key);
    if (mods.length === 0 && !isFKey) {
      setSketchHotkeyError("快捷键需包含修饰键，或使用 F1-F12 单键");
      return;
    }
    const mainKey = isFKey ? e.key : e.key.length === 1 ? e.key.toUpperCase() : "";
    if (!mainKey) {
      setSketchHotkeyError("不支持的按键");
      return;
    }
    setSketchHotkeyRecording(false);
    setSketchHotkeyError("");
    saveSketchHotkey([...mods, mainKey].join("+"));
  };

  const saveSketchHotkey = async (combo: string) => {
    const requestId = ++sketchHotkeyRequestRef.current;
    const previous = sketchHotkeyRef.current;
    setSketchHotkey(combo);
    sketchHotkeyRef.current = combo;
    setSketchHotkeyStatus("saving");
    setSketchHotkeyError("");
    try {
      const request = sketchHotkeyQueueRef.current
        .catch(() => undefined)
        .then(() => invoke("set_sketch_hotkey", { hotkey: combo }));
      sketchHotkeyQueueRef.current = request.catch(() => undefined);
      await request;
      if (requestId !== sketchHotkeyRequestRef.current) return;
      setSketchHotkeyStatus("saved");
      void checkHotkeyConflicts();
      window.setTimeout(() => {
        if (requestId === sketchHotkeyRequestRef.current) setSketchHotkeyStatus("idle");
      }, 2000);
    } catch (err) {
      if (requestId !== sketchHotkeyRequestRef.current) return;
      setSketchHotkey(previous);
      sketchHotkeyRef.current = previous;
      setSketchHotkeyStatus("error");
      setSketchHotkeyError(String(err));
      window.setTimeout(() => {
        if (requestId === sketchHotkeyRequestRef.current) setSketchHotkeyStatus("idle");
      }, 3000);
    }
  };

  const clearSketchHotkey = async () => {
    const requestId = ++sketchHotkeyRequestRef.current;
    const previous = sketchHotkeyRef.current;
    sketchHotkeyRef.current = "";
    setSketchHotkeyStatus("saving");
    setSketchHotkeyError("");
    try {
      const request = sketchHotkeyQueueRef.current
        .catch(() => undefined)
        .then(() => invoke("set_sketch_hotkey", { hotkey: "" }));
      sketchHotkeyQueueRef.current = request.catch(() => undefined);
      await request;
      if (requestId !== sketchHotkeyRequestRef.current) return;
      setSketchHotkey("");
      void checkHotkeyConflicts();
      setSketchHotkeyStatus("idle");
      setSketchHotkeyError("");
    } catch (err) {
      if (requestId !== sketchHotkeyRequestRef.current) return;
      setSketchHotkey(previous);
      sketchHotkeyRef.current = previous;
      setSketchHotkeyStatus("error");
      setSketchHotkeyError(String(err));
    }
  };

  const changeSketchHistoryLimit = (value: number) => {
    const normalized = Math.max(1, Math.min(MAX_SKETCH_HISTORY_LIMIT, Math.trunc(value)));
    setSketchHistoryLimit(writeSketchHistoryLimit(normalized));
    setSketchHistoryLimitStatus("saved");
    window.setTimeout(() => setSketchHistoryLimitStatus("idle"), 2000);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: SKETCH_HISTORY_LIMIT_KEY,
        newValue: String(normalized),
        storageArea: localStorage,
      }),
    );
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
      void checkHotkeyConflicts();
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

  /** 拖拽排序：把 from 位置的项移动到 to 位置（to 为移除后新列表中的目标下标），并同步编辑行索引与实时列表 */
  const reorderQiSnippets = (from: number, to: number) => {
    if (from === to) return;
    const next = [...qiDragSnippetsRef.current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    // 正在编辑的行若随移动变更索引，同步更新，避免编辑内容错位
    if (qiEditingIndex !== null) {
      if (qiEditingIndex === from) {
        setQiEditingIndex(to);
      } else if (from < qiEditingIndex && to >= qiEditingIndex) {
        setQiEditingIndex(qiEditingIndex - 1);
      } else if (from > qiEditingIndex && to <= qiEditingIndex) {
        setQiEditingIndex(qiEditingIndex + 1);
      }
    }
    qiDragSnippetsRef.current = next;
    qiDragIndexRef.current = to;
    qiDragDirtyRef.current = true;
    setQiDraggingIndex(to);
    setQiSnippets(next);
  };

  /** 开始拖拽：记录源索引与初始列表快照 */
  const onQiSnippetDragStart = (e: DragEvent<HTMLDivElement>, idx: number) => {
    qiDragIndexRef.current = idx;
    qiDragSnippetsRef.current = qiSnippets;
    qiDragDirtyRef.current = false;
    setQiDraggingIndex(idx);
    // Firefox 需要 setData 才允许开始拖拽
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(idx));
    }
  };

  /** 拖过行时实时重排：按鼠标在行内的上下半区决定插入该行前/后 */
  const onQiSnippetDragOver = (e: DragEvent<HTMLDivElement>, targetIdx: number) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const from = qiDragIndexRef.current;
    if (from === null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    let to = before ? targetIdx : targetIdx + 1;
    if (from < to) to -= 1;
    if (to !== from) reorderQiSnippets(from, to);
  };

  /** 放下：仅阻止浏览器默认行为，最终顺序由 dragend 统一落库 */
  const onQiSnippetDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  /** 拖拽结束：清理状态，拖拽中若发生过顺序变更则落库 */
  const onQiSnippetDragEnd = () => {
    if (qiDragIndexRef.current === null) return;
    const final = qiDragSnippetsRef.current;
    const dirty = qiDragDirtyRef.current;
    qiDragIndexRef.current = null;
    qiDragSnippetsRef.current = [];
    qiDragDirtyRef.current = false;
    setQiDraggingIndex(null);
    if (dirty) void saveQiSnippets(final);
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

  const changeQiHistoryEnabled = async (enabled: boolean) => {
    const previous = qiHistoryEnabledRef.current;
    const version = ++qiHistoryEnabledSaveVersionRef.current;
    qiHistoryEnabledRef.current = enabled;
    setQiHistoryEnabled(enabled);
    setQiHistoryEnabledStatus("idle");
    try {
      await invoke("set_quick_input_history_enabled", { enabled });
      if (version !== qiHistoryEnabledSaveVersionRef.current) return;
      if (!enabled) {
        setQiHistory([]);
      } else {
        await refreshQiHistory();
      }
      setQiHistoryEnabledStatus("saved");
      setTimeout(() => setQiHistoryEnabledStatus("idle"), 2000);
    } catch (err) {
      if (version !== qiHistoryEnabledSaveVersionRef.current) return;
      console.error("Failed to save quick input history enabled state:", err);
      qiHistoryEnabledRef.current = previous;
      setQiHistoryEnabled(previous);
      setQiHistoryEnabledStatus("error");
      setTimeout(() => setQiHistoryEnabledStatus("idle"), 3000);
    }
  };

  const changeQiSnippetsEnabled = async (enabled: boolean) => {
    const previous = qiSnippetsEnabledRef.current;
    const version = ++qiSnippetsEnabledSaveVersionRef.current;
    qiSnippetsEnabledRef.current = enabled;
    setQiSnippetsEnabled(enabled);
    setQiSnippetsEnabledStatus("idle");
    try {
      await invoke("set_quick_input_snippets_enabled", { enabled });
      if (version !== qiSnippetsEnabledSaveVersionRef.current) return;
      setQiSnippetsEnabledStatus("saved");
      setTimeout(() => setQiSnippetsEnabledStatus("idle"), 2000);
    } catch (err) {
      if (version !== qiSnippetsEnabledSaveVersionRef.current) return;
      console.error("Failed to save quick input snippets enabled state:", err);
      qiSnippetsEnabledRef.current = previous;
      setQiSnippetsEnabled(previous);
      setQiSnippetsEnabledStatus("error");
      setTimeout(() => setQiSnippetsEnabledStatus("idle"), 3000);
    }
  };

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

  /** 保存剪贴板历史保留条数，并立即裁剪当前列表。 */
  const changeQiHistoryLimit = async (value: number) => {
    const limit = Math.max(0, Math.min(20, Math.trunc(value)));
    const previous = qiHistoryLimitRef.current;
    const version = ++qiHistoryLimitSaveVersionRef.current;
    qiHistoryLimitRef.current = limit;
    setQiHistoryLimit(limit);
    setQiHistoryLimitStatus("idle");

    // 保证快速连续修改按输入顺序写入；过期请求完成后不再改动界面状态。
    const save = qiHistoryLimitSaveQueueRef.current
      .catch(() => undefined)
      .then(() => invoke("set_quick_input_history_limit", { limit }).then(() => undefined));
    qiHistoryLimitSaveQueueRef.current = save;

    void save
      .then(() => {
        if (version !== qiHistoryLimitSaveVersionRef.current) return;
        setQiHistory((history) => history.slice(0, limit));
        setQiHistoryLimitStatus("saved");
        setTimeout(() => setQiHistoryLimitStatus("idle"), 2000);
      })
      .catch((err) => {
        if (version !== qiHistoryLimitSaveVersionRef.current) return;
        console.error("Failed to save quick input history limit:", err);
        qiHistoryLimitRef.current = previous;
        setQiHistoryLimit(previous);
        setQiHistory((history) => history.slice(0, previous));
        setQiHistoryLimitStatus("error");
        setTimeout(() => setQiHistoryLimitStatus("idle"), 3000);
      });
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

  const updatePinBorderColor = async (value: string) => {
    const color = normalizePinBorderColor(value);
    const version = ++pinBorderColorSaveVersionRef.current;
    pinBorderColorRef.current = color;
    setPinBorderColor(color);
    setPinBorderStatus("idle");
    try {
      const save = pinBorderSaveQueueRef.current
        .catch(() => undefined)
        .then(() => savePinBorderColor(color));
      pinBorderSaveQueueRef.current = save.catch(() => undefined);
      await save;
      persistedPinBorderColorRef.current = color;
      pinBorderColorFailedVersionRef.current = 0;
      if (version !== pinBorderColorSaveVersionRef.current) return;
      setPinBorderStatus("saved");
      window.setTimeout(() => {
        if (version === pinBorderColorSaveVersionRef.current) setPinBorderStatus("idle");
      }, 1500);
    } catch (err) {
      if (version !== pinBorderColorSaveVersionRef.current) return;
      console.error("Failed to save pin border color:", err);
      pinBorderColorFailedVersionRef.current = version;
      if (!pinBorderColorLoadedRef.current) {
        setPinBorderStatus("error");
        return;
      }
      const persisted = persistedPinBorderColorRef.current;
      pinBorderColorRef.current = persisted;
      setPinBorderColor(persisted);
      setPinBorderStatus("error");
    }
  };

  const updatePinBorderWidth = async (value: number) => {
    const width = normalizePinBorderWidth(value);
    const version = ++pinBorderWidthSaveVersionRef.current;
    pinBorderWidthRef.current = width;
    setPinBorderWidth(width);
    setPinBorderStatus("idle");
    try {
      const save = pinBorderSaveQueueRef.current
        .catch(() => undefined)
        .then(() => savePinBorderWidth(width));
      pinBorderSaveQueueRef.current = save.catch(() => undefined);
      await save;
      persistedPinBorderWidthRef.current = width;
      pinBorderWidthFailedVersionRef.current = 0;
      if (version !== pinBorderWidthSaveVersionRef.current) return;
      setPinBorderStatus("saved");
      window.setTimeout(() => {
        if (version === pinBorderWidthSaveVersionRef.current) setPinBorderStatus("idle");
      }, 1500);
    } catch (err) {
      if (version !== pinBorderWidthSaveVersionRef.current) return;
      console.error("Failed to save pin border width:", err);
      pinBorderWidthFailedVersionRef.current = version;
      if (!pinBorderWidthLoadedRef.current) {
        setPinBorderStatus("error");
        return;
      }
      const persisted = persistedPinBorderWidthRef.current;
      pinBorderWidthRef.current = persisted;
      setPinBorderWidth(persisted);
      setPinBorderStatus("error");
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

  // 在线更新：检查/下载/安装，由 tauri-plugin-updater 提供
  const updater = useUpdater();
  const [appVersion, setAppVersion] = useState("0.0.0");

  // 读取当前应用运行版本（用于「在线更新」区块展示）
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch((err) => console.error("Failed to get app version:", err));
  }, []);

  const renderHotkeyConflict = (id: string) => {
    const result = hotkeyConflicts[id];
    if (hotkeyCheckStatus === "checking") {
      return (
        <span
          className="settings-hotkey-status"
          title="正在检查快捷键冲突"
          aria-label="正在检查快捷键冲突"
        >
          <Icon name="Loader2" size={14} className="settings-save-spinner" aria-hidden="true" />
        </span>
      );
    }
    if (!result || result.status === "disabled") return null;
    const color =
      result.status === "available" ? "var(--color-success-fg)" : "var(--color-danger-fg)";
    return (
      <span
        className="settings-hotkey-status"
        style={{ color }}
        title={result.message}
        aria-label={result.message}
      >
        <Icon
          name={result.status === "available" ? "Check" : "AlertCircle"}
          size={16}
          aria-hidden="true"
        />
      </span>
    );
  };

  return (
    <div className={`settings-shell${isClosing ? " is-closing" : ""}`}>
      <TitleBar
        title={isToolConfigWindow ? "Levitaire 工具配置" : "Levitaire 系统设置"}
        onCloseRequested={requestSettingsClose}
      />
      <div className="settings-layout">
        <nav className="settings-sidebar">
          <div className="settings-sidebar-title">
            {isToolConfigWindow ? "工具配置" : "系统设置"}
          </div>
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              className={`settings-nav-item${activeTab === tab.id ? " is-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              // Preserve the historical accessible label used by integrations
              // while the visible name now matches the floating palette.
              aria-label={tab.id === "screenshot" ? "截图/录屏" : undefined}
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
              <div className="settings-theme-row">
                <div className="settings-item">
                  <div className="settings-inline-group">
                    <label className="settings-label" htmlFor="settings-autostart">
                      开机自启动
                    </label>
                    <input
                      id="settings-autostart"
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
                  </div>
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
                        setTheme(e.target.value as ThemeMode);
                        setThemePreferencesError(false);
                      }}
                      className="settings-select"
                    >
                      <option value="light">浅色</option>
                      <option value="dark">深色</option>
                      <option value="system">跟随系统</option>
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
                      style={
                        {
                          "--swatch-color": accent[resolveThemeMode(theme)].swatch,
                        } as React.CSSProperties
                      }
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

              <div className="settings-item settings-orb-item">
                <span className="settings-label" id="settings-orb-icon-label">
                  悬浮球形象
                </span>
                <div
                  className="settings-orb-options"
                  role="radiogroup"
                  aria-labelledby="settings-orb-icon-label"
                >
                  {ORB_ICON_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`settings-orb-option ${orbIcon === option.id ? "is-selected" : ""}`}
                      role="radio"
                      aria-checked={orbIcon === option.id}
                      aria-label={option.label}
                      title={`${option.label}：${option.description}`}
                      onClick={() => handleOrbIconChange(option.id)}
                    >
                      <span className="settings-orb-preview">
                        <OrbIcon icon={option.id} size={34} />
                      </span>
                      <span className="settings-orb-name">{option.label}</span>
                    </button>
                  ))}
                </div>
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

              <hr className="settings-divider" />
              <div className="settings-updater-head">
                <h3 className="settings-subsection-title">在线更新</h3>
                <div className="settings-updater-row">
                  <span className="settings-label">版本</span>
                  <span className="settings-updater-current">{appVersion}</span>
                </div>
                <div className="settings-updater-actions">
                  {updater.status === "idle" && (
                    <button className="settings-save-btn" onClick={updater.checkForUpdate}>
                      <Icon name="RefreshCw" size={14} /> 检查更新
                    </button>
                  )}
                  {updater.status === "checking" && (
                    <span className="settings-hint">
                      <Icon name="Loader2" size={14} className="settings-save-spinner" /> 正在检查…
                    </span>
                  )}
                  {updater.status === "upToDate" && (
                    <span className="settings-hint">
                      <Icon name="Check" size={14} /> 已是最新版本
                    </span>
                  )}
                  {updater.status === "available" && (
                    <div className="settings-updater-available">
                      <span className="settings-hint">
                        发现新版本 <b>{updater.availableVersion}</b>
                      </span>
                      <button className="settings-save-btn" onClick={updater.downloadAndInstall}>
                        <Icon name="Download" size={14} /> 下载并安装
                      </button>
                    </div>
                  )}
                  {updater.status === "downloading" && (
                    <span className="settings-hint">
                      <Icon name="Loader2" size={14} className="settings-save-spinner" /> 下载中
                      {updater.progress != null ? ` ${updater.progress}%` : "…"}
                    </span>
                  )}
                  {updater.status === "installing" && (
                    <span className="settings-hint">
                      <Icon name="Loader2" size={14} className="settings-save-spinner" />{" "}
                      正在安装，稍后会自动重启…
                    </span>
                  )}
                  {updater.status === "error" && (
                    <div className="settings-updater-error">
                      <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                        <Icon name="X" size={14} /> 检查更新失败
                      </span>
                      {updater.errorMessage && (
                        <span className="settings-hint" title={updater.errorMessage}>
                          {updater.errorMessage.slice(0, 120)}
                        </span>
                      )}
                      <button className="settings-toggle-btn" onClick={updater.reset} title="重试">
                        <Icon name="RotateCcw" size={14} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* ── 截图 ──────────────────────────────────────── */}
          {(activeTab === "screenshot" || activeTab === "recording" || activeTab === "sketch") && (
            <>
              <h2 className="settings-panel-title">
                {activeTab === "recording"
                  ? "GIF/录屏"
                  : activeTab === "sketch"
                    ? "屏幕草稿"
                    : "屏幕截图"}
              </h2>
              {activeTab === "screenshot" && (
                <>
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
                      {renderHotkeyConflict("screenshot")}
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
                </>
              )}
              {activeTab === "sketch" && (
                <>
                  <div className="settings-item">
                    <label className="settings-label" htmlFor="settings-sketch-hotkey">
                      屏幕草稿快捷键
                    </label>
                    <div className="settings-inline-group">
                      <input
                        id="settings-sketch-hotkey"
                        type="text"
                        value={sketchHotkeyRecording ? "按下组合键…" : sketchHotkey}
                        readOnly
                        placeholder="点击设置快捷键"
                        onFocus={() => {
                          setSketchHotkeyRecording(true);
                          setSketchHotkeyError("");
                        }}
                        onBlur={() => setSketchHotkeyRecording(false)}
                        onKeyDown={handleSketchHotkeyKeyDown}
                        className="settings-input"
                        style={{ width: 180 }}
                      />
                      {sketchHotkey && (
                        <button
                          className="settings-toggle-btn"
                          onClick={clearSketchHotkey}
                          title="清除快捷键"
                          aria-label="清除快捷键"
                        >
                          <Icon name="X" size={16} />
                        </button>
                      )}
                      {renderHotkeyConflict("sketch")}
                    </div>
                    {sketchHotkeyStatus === "saving" && (
                      <span className="settings-hint">保存中…</span>
                    )}
                    {sketchHotkeyStatus === "saved" && (
                      <span className="settings-hint">已保存</span>
                    )}
                    {sketchHotkeyError && (
                      <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                        {sketchHotkeyError}
                      </p>
                    )}
                  </div>
                  <div className="settings-item">
                    <label className="settings-label" htmlFor="settings-sketch-history-limit">
                      草稿历史保留条数
                    </label>
                    <div className="settings-inline-group">
                      <input
                        id="settings-sketch-history-limit"
                        className="settings-input"
                        type="number"
                        min={1}
                        max={MAX_SKETCH_HISTORY_LIMIT}
                        step={1}
                        value={sketchHistoryLimit}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (Number.isFinite(value)) changeSketchHistoryLimit(value);
                        }}
                        style={{ width: 84 }}
                      />
                      <span className="settings-hint">
                        最多 {MAX_SKETCH_HISTORY_LIMIT} 条，默认 10 条
                      </span>
                    </div>
                    {sketchHistoryLimitStatus === "saved" && (
                      <span className="settings-hint">已保存</span>
                    )}
                  </div>
                </>
              )}
              {activeTab === "screenshot" && (
                <>
                  <div className="settings-item">
                    <label className="settings-label">保存路径</label>
                    <div className="settings-inline-group settings-path-group">
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
                  <h3 className="settings-subsection-title">贴图边框</h3>
                  <div className="settings-item settings-row">
                    <div className="settings-inline-group">
                      <label className="settings-label" htmlFor="settings-pin-border-color">
                        颜色
                      </label>
                      <input
                        id="settings-pin-border-color"
                        className="settings-color-input"
                        type="color"
                        value={pinBorderColor}
                        onChange={(event) => void updatePinBorderColor(event.target.value)}
                        aria-label="贴图边框颜色"
                      />
                      <span className="settings-hint settings-color-value">{pinBorderColor}</span>
                    </div>
                    <div className="settings-inline-group">
                      <label className="settings-label" htmlFor="settings-pin-border-width">
                        粗细
                      </label>
                      <select
                        id="settings-pin-border-width"
                        className="settings-select"
                        value={pinBorderWidth}
                        onChange={(event) => void updatePinBorderWidth(Number(event.target.value))}
                        aria-label="贴图边框粗细"
                      >
                        {PIN_BORDER_WIDTH_OPTIONS.map((width) => (
                          <option key={width} value={width}>
                            {width}px
                          </option>
                        ))}
                      </select>
                    </div>
                    {pinBorderStatus === "saved" && <span className="settings-hint">已保存</span>}
                    {pinBorderStatus === "error" && (
                      <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                        保存失败
                      </span>
                    )}
                  </div>
                </>
              )}
              {activeTab === "recording" && (
                <>
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
                      {renderHotkeyConflict("recording")}
                    </div>
                    {recordingHotkeyStatus === "saving" && (
                      <span className="settings-hint">保存中…</span>
                    )}
                    {recordingHotkeyStatus === "saved" && (
                      <span className="settings-hint">已保存</span>
                    )}
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
                    <div className="settings-inline-group settings-path-group">
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
                        onChange={(e) =>
                          updateRecordingConfig({ videoFps: Number(e.target.value) })
                        }
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
                <div className="settings-inline-group settings-hotkey-input-group">
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
                  {renderHotkeyConflict("quick-input-trigger")}
                </div>
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
                  <button
                    type="button"
                    role="switch"
                    aria-checked={qiSnippetsEnabled}
                    aria-label="预设提示词"
                    className={`qi-toggle-switch${qiSnippetsEnabled ? " is-on" : ""}`}
                    onClick={() => void changeQiSnippetsEnabled(!qiSnippetsEnabled)}
                  >
                    <span className="qi-toggle-switch-thumb" />
                  </button>
                </div>
                {qiSnippetsEnabledStatus === "saved" && (
                  <span className="settings-hint">已保存</span>
                )}
                {qiSnippetsEnabledStatus === "error" && (
                  <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    保存失败
                  </span>
                )}
                <div className="qi-snippet-list">
                  {qiSnippets.length === 0 && (
                    <p className="settings-hint" style={{ opacity: 0.6 }}>
                      暂无预设词
                    </p>
                  )}
                  {qiSnippets.map((s, i) =>
                    qiEditingIndex === i ? (
                      <div
                        className="qi-snippet-row qi-snippet-editing"
                        key={i}
                        draggable={false}
                        onDragOver={(e) => onQiSnippetDragOver(e, i)}
                        onDrop={onQiSnippetDrop}
                      >
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
                      <div
                        className={`qi-snippet-row${qiDraggingIndex === i ? " qi-snippet-dragging" : ""}`}
                        key={i}
                        draggable
                        onDragStart={(e) => onQiSnippetDragStart(e, i)}
                        onDragOver={(e) => onQiSnippetDragOver(e, i)}
                        onDrop={onQiSnippetDrop}
                        onDragEnd={onQiSnippetDragEnd}
                      >
                        <div className="qi-snippet-label" title={s.label}>
                          {s.label}
                        </div>
                        <div className="qi-snippet-text" title={s.text}>
                          {s.text}
                        </div>
                        <div className="qi-snippet-actions">
                          <button
                            className="settings-toggle-btn settings-toggle-btn-sm"
                            draggable={false}
                            onClick={() => startEditQiSnippet(i)}
                            title="编辑"
                            aria-label="编辑"
                          >
                            <Icon name="Pencil" size={14} />
                          </button>
                          <button
                            className="settings-toggle-btn settings-toggle-btn-sm"
                            draggable={false}
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
                    title="自动记录复制到剪贴板的文本，最新在前；可设置保留条数，设为 0 可关闭历史记录。"
                  >
                    <Icon name="AlertCircle" size={14} aria-hidden="true" />
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={qiHistoryEnabled}
                    aria-label="剪贴板历史"
                    className={`qi-toggle-switch${qiHistoryEnabled ? " is-on" : ""}`}
                    onClick={() => void changeQiHistoryEnabled(!qiHistoryEnabled)}
                  >
                    <span className="qi-toggle-switch-thumb" />
                  </button>
                </div>
                {qiHistoryEnabledStatus === "saved" && (
                  <span className="settings-hint">已保存</span>
                )}
                {qiHistoryEnabledStatus === "error" && (
                  <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    保存失败
                  </span>
                )}
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
                <div className="settings-item-head" style={{ marginTop: 10 }}>
                  <label className="settings-label" htmlFor="settings-qi-history-limit">
                    保留条数
                  </label>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      id="settings-qi-history-limit"
                      className="settings-input"
                      type="number"
                      min={0}
                      max={20}
                      step={1}
                      value={qiHistoryLimit}
                      onChange={(e) => {
                        const value = Number(e.target.value);
                        if (Number.isFinite(value)) void changeQiHistoryLimit(value);
                      }}
                      style={{ width: 84 }}
                    />
                    <span className="settings-hint">条（0 表示不记录）</span>
                  </div>
                </div>
                {qiHistoryLimitStatus === "saved" && <span className="settings-hint">已保存</span>}
                {qiHistoryLimitStatus === "error" && (
                  <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    保存失败
                  </span>
                )}
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

          {/* ── 待办清单 ──────────────────────────────────── */}
          {activeTab === "timer" && (
            <>
              <h2 className="settings-panel-title">时钟、倒计时、秒表与日历</h2>
              <p className="settings-panel-desc">管理桌面时钟、倒计时、日历和秒表悬浮工具。</p>
              <div className="settings-item">
                <label className="settings-checkbox-label">
                  <input
                    type="checkbox"
                    checked={timerRemindersEnabled}
                    onChange={(event) => {
                      const value = event.target.checked;
                      setTimerRemindersEnabled(value);
                      invoke("set_timer_reminders_enabled", { enabled: value }).catch(() =>
                        setTimerRemindersEnabled(!value),
                      );
                    }}
                  />
                  <span>启用倒计时提醒</span>
                </label>
              </div>
              <div className="settings-item">
                <label className="settings-checkbox-label">
                  <input
                    type="checkbox"
                    checked={timerLunarEnabled}
                    onChange={(event) => {
                      const value = event.target.checked;
                      setTimerLunarEnabled(value);
                      invoke("set_timer_lunar_enabled", { enabled: value }).catch(() =>
                        setTimerLunarEnabled(!value),
                      );
                    }}
                  />
                  <span>显示农历日期</span>
                </label>
              </div>
              <div className="settings-item settings-row">
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-timer-sound">
                    提醒声音
                  </label>
                  <select
                    id="settings-timer-sound"
                    className="settings-select"
                    value={timerReminderSound}
                    onChange={(event) => {
                      const value = event.target.value;
                      setTimerReminderSound(value);
                      invoke("set_timer_reminder_sound", { sound: value }).catch(() =>
                        setTimerReminderSound(timerReminderSound),
                      );
                    }}
                  >
                    <option value="tone">提示音</option>
                    <option value="none">静音</option>
                  </select>
                </div>
              </div>
              <div className="settings-item">
                <label className={`settings-checkbox-label${timerEnabled ? "" : " is-disabled"}`}>
                  <input
                    type="checkbox"
                    checked={autostartIds.includes("timer")}
                    disabled={!timerEnabled}
                    onChange={() => handleToggleToolAutostart("timer")}
                  />
                  <span>启动时自动打开</span>
                </label>
                {!timerEnabled && (
                  <span className="settings-hint">请先在悬浮球面板中启用时钟与倒计时</span>
                )}
                {autostartError && (
                  <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    设置失败
                  </span>
                )}
              </div>
              <div className="settings-item">
                <span className="settings-hint">
                  倒计时结束时会播放提示音并发送系统通知；计时器状态会在应用重启后恢复。
                </span>
              </div>
            </>
          )}

          {activeTab === "todo" && (
            <>
              <h2 className="settings-panel-title">待办清单</h2>
              <p className="settings-panel-desc">管理待办悬浮窗和任务提醒。</p>
              <div className="settings-item">
                <label className={`settings-checkbox-label${todoEnabled ? "" : " is-disabled"}`}>
                  <input
                    type="checkbox"
                    checked={autostartIds.includes("todo")}
                    disabled={!todoEnabled}
                    onChange={() => handleToggleToolAutostart("todo")}
                  />
                  <span>启动时自动打开</span>
                </label>
                {!todoEnabled && (
                  <span className="settings-hint">请先在悬浮球面板中启用待办清单</span>
                )}
                {autostartError && (
                  <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    设置失败
                  </span>
                )}
              </div>
              <div className="settings-item">
                <label className="settings-checkbox-label">
                  <input
                    type="checkbox"
                    checked={todoRemindersEnabled}
                    onChange={(event) => {
                      const value = event.target.checked;
                      setTodoRemindersEnabled(value);
                      invoke("set_todo_reminders_enabled", { enabled: value }).catch(() =>
                        setTodoRemindersEnabled(!value),
                      );
                    }}
                  />
                  <span>启用任务提醒</span>
                </label>
              </div>
              <div className="settings-item settings-row">
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-todo-sound">
                    提醒声音
                  </label>
                  <select
                    id="settings-todo-sound"
                    className="settings-select"
                    value={todoReminderSound}
                    onChange={(event) => {
                      const value = event.target.value;
                      setTodoReminderSound(value);
                      invoke("set_todo_reminder_sound", { sound: value }).catch(() =>
                        setTodoReminderSound(todoReminderSound),
                      );
                    }}
                  >
                    <option value="tone">提示音</option>
                    <option value="none">静音</option>
                  </select>
                </div>
              </div>
              <div className="settings-item">
                <label className="settings-label" htmlFor="settings-todo-quick-add-hotkey">
                  快速添加快捷键
                </label>
                <div className="settings-inline-group">
                  <input
                    id="settings-todo-quick-add-hotkey"
                    type="text"
                    value={todoQuickAddRecording ? "按下组合键…" : todoQuickAddHotkey}
                    readOnly
                    placeholder="点击设置快捷键"
                    onFocus={() => {
                      setTodoQuickAddRecording(true);
                      setTodoQuickAddError("");
                    }}
                    onBlur={() => setTodoQuickAddRecording(false)}
                    onKeyDown={handleTodoQuickAddKeyDown}
                    className="settings-input"
                    style={{ width: 180 }}
                  />
                  {todoQuickAddHotkey && (
                    <button
                      className="settings-toggle-btn"
                      onClick={clearTodoQuickAddHotkey}
                      title="清除快捷键"
                      aria-label="清除快捷键"
                    >
                      <Icon name="X" size={16} />
                    </button>
                  )}
                  {renderHotkeyConflict("todo-quick-add")}
                  {todoQuickAddStatus === "saved" && <span className="settings-hint">已保存</span>}
                  {todoQuickAddStatus === "error" && (
                    <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                      保存失败
                    </span>
                  )}
                </div>
                <p className="settings-hint">在任意应用中唤起待办并聚焦新任务输入框。</p>
                {todoQuickAddError && (
                  <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    {todoQuickAddError}
                  </p>
                )}
              </div>
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
