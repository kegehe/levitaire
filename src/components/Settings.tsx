import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import type { DragEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Icon from "./Icon";
import type { IconName } from "./Icon";
import { AiConfig } from "../types";
import {
  TOOLBAR_FEATURES,
  DEFAULT_FEATURE_IDS,
  DEFAULT_FEATURE_ORDER,
  fetchEnabledFeatures,
  fetchToolbarFeatureOrder,
  saveEnabledFeatures,
  saveToolbarFeatureOrder,
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
  WATCHDOG_INTERVAL_OPTIONS,
  WATCHDOG_MIN_AGE_OPTIONS,
  WATCHDOG_MIN_BYTES_OPTIONS,
  WATCHDOG_MIN_DELTA_OPTIONS,
} from "../constants/diskCleanupConfig";
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
  MONITOR_LAYOUT_OPTIONS,
  fetchSystemMonitorConfig,
  normalizeSystemMonitorConfig,
  saveSystemMonitorConfig,
  type SystemMonitorConfig,
  type SystemMonitorDisplayMode,
  type SystemMonitorLayout,
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
import { resolveToolIdAlias } from "../tools/registry";
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
  { id: "timer", label: "时间工具", icon: "Clock" as IconName },
  { id: "todo", label: "待办清单", icon: "ListFilter" as IconName },
  { id: "toolbar", label: "文字工具栏", icon: "Grid3x3" as IconName },
  { id: "system-cleaner", label: "系统清理", icon: "Trash2" as IconName },
] as const;

const SETTINGS_TABS = [...SYSTEM_SETTINGS_TABS, ...TOOL_SETTINGS_TABS] as const;

type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

/** 看门狗状态（与 Rust 侧 `disk_cleanup::watchdog::WatchStatus` 对应）。 */
type WatchStatus = {
  enabled: boolean;
  intervalHours: number;
  minBytes: number;
  minDeltaBytes: number;
  minAgeDays: number;
  targets: string[];
  lastRunAt: string | null;
  lastError: string | null;
  current: string | null;
  dirsVisited: number;
  alerts: Array<{ path: string; bytes: number; deltaBytes: number; deltaDays: number }>;
};

type HotkeyConflictResult = {
  id: string;
  hotkey: string;
  status: "disabled" | "available" | "internal-conflict" | "external-conflict" | "invalid";
  message: string;
};

/**
 * 支持一键恢复默认位置的悬浮窗。
 *
 * 判据是「谁调用了 `persistWindowPositionOnMove`」—— 记了位置就必须有入口，否则用户
 * 把窗口拖丢之后没有任何一键复位的地方（便利贴管理窗曾如此）；反过来列了却不被后端复位，
 * 按钮会亮「已恢复」而窗口纹丝不动（系统清理曾如此）。后端 `RESETTABLE_WINDOW_IDS` 与之
 * 逐项对应，守卫 `resettable_windows_match_frontend_targets` 与
 * `src/test/windowPositionTargetsGuard.test.ts` 会拦住任何单边改动。
 */
const WINDOW_POSITION_TARGETS = [
  { id: "orb", label: "悬浮球", icon: "GripVertical" as IconName },
  { id: "monitor-overlay", label: "系统监控", icon: "Activity" as IconName },
  { id: "time-overlay", label: "时间工具", icon: "Clock" as IconName },
  { id: "todo-overlay", label: "待办清单", icon: "ListFilter" as IconName },
  { id: "system-cleaner-overlay", label: "系统清理", icon: "Trash2" as IconName },
  { id: "sticky-notes-manager", label: "便利贴", icon: "StickyNote" as IconName },
] as const;

/** 说明文案的窗口清单从 WINDOW_POSITION_TARGETS 派生，避免工具合并/增删（如番茄钟并入时间工具）后文案再次过期 */
const WINDOW_POSITION_HINT = `${WINDOW_POSITION_TARGETS.map((target) => target.label).join("、")}会记住上次拖拽的位置；窗口被拖到角落或屏幕布局变化后可在此一键恢复默认位置。`;

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
  // 页签懒加载标记：仅首次进入某页签时拉取该页后端配置（窗口隐藏复用后不重复请求）
  const loadedTabsRef = useRef<Partial<Record<SettingsTabId, boolean>>>({});
  // 始终指向最新 activeTab，供 onFocusChanged 回调读取，避免依赖变更导致重复订阅
  const activeTabRef = useRef<SettingsTabId>(activeTab);
  activeTabRef.current = activeTab;
  // 工具启停/自动打开快照是否已在本窗口会话内拉取过；重新聚焦时重置，
  // 保证重新打开窗口后首次进入「启动时自动打开」相关页签能取到最新快照。
  const toolSnapshotLoadedRef = useRef(false);
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
  const settingsShellRef = useRef<HTMLDivElement | null>(null);
  // 关闭流程守卫：请求过一次后忽略再次点击，避免快速重复点击导致退出动画/定时器错乱
  const closingRequestedRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  // 保存当前淡出过渡的 transitionend 监听器，供「重新聚焦取消关闭」时一并拆除，
  // 否则淡出被中断后 opacity 回弹会误触发 onOpacityEnd 而把窗口关掉。
  const closeTransitionHandlerRef = useRef<((event: TransitionEvent) => void) | null>(null);

  const requestSettingsClose = useCallback(() => {
    if (closingRequestedRef.current) return;
    closingRequestedRef.current = true;
    setIsClosing(true);

    const doClose = () => {
      getCurrentWebviewWindow()
        .close()
        .catch((err) => {
          console.error(err);
          // 关闭失败时复位守卫并淡回窗口，避免留下 opacity:0 的隐形窗口，
          // 让界面恢复可见以便用户重新触发关闭流程。
          closingRequestedRef.current = false;
          setIsClosing(false);
        });
    };

    const shell = settingsShellRef.current;
    if (!shell) {
      doClose();
      return;
    }
    // prefers-reduced-motion 下 transition 已被 CSS 禁用，淡出无实际动画，
    // 直接关闭，避免无意义的兜底等待。
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      doClose();
      return;
    }
    // 用 transitionend 精确对齐淡出动画结束的时机再真正关闭，
    // 取代原先硬编码的 180ms 定时（后者与 CSS 过渡时长可能不同步而带来迟滞感）。
    let didClose = false;
    const onOpacityEnd = (event: TransitionEvent) => {
      // 仅响应 shell 自身的 opacity 过渡结束：child 的 transitionend 会冒泡上来，
      // 若仅按 propertyName 过滤，子元素的透明度过渡可能被误判为窗口淡出完成而提前关闭。
      if (event.target === shell && event.propertyName === "opacity") finish();
    };
    const finish = () => {
      if (didClose) return;
      didClose = true;
      shell.removeEventListener("transitionend", onOpacityEnd);
      closeTransitionHandlerRef.current = null;
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      doClose();
    };
    shell.addEventListener("transitionend", onOpacityEnd);
    closeTransitionHandlerRef.current = onOpacityEnd;
    // 兜底：shell 自身的 opacity transitionend 未触发（如过渡被中断）时仍按时关闭，防止窗口卡住。
    // 时长取略长于过渡值，保证正常情况下由 transitionend 驱动，兜底不会提前抢走关闭。
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      finish();
    }, 300);
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

  // 工具栏按钮顺序（全量 ID 有序列表，与启用状态相互独立）
  const [featureOrder, setFeatureOrderState] = useState<string[]>(() => [...DEFAULT_FEATURE_ORDER]);
  const featureOrderRef = useRef<string[]>(featureOrder);
  featureOrderRef.current = featureOrder;
  // 后端确认过的顺序，拖拽落库失败时回滚用
  const persistedFeatureOrderRef = useRef<string[]>([...DEFAULT_FEATURE_ORDER]);
  // 顺序保存请求版本号：仅最新一次请求可写回持久化基准/回滚，避免陈旧请求覆盖后续编辑
  const featureOrderSaveVersionRef = useRef(0);
  // 工具栏功能启停保存请求版本号：仅最新一次请求可更新状态/回滚，避免陈旧读写覆盖用户后续切换
  const featuresSaveVersionRef = useRef(0);
  const [featureOrderStatus, setFeatureOrderStatus] = useState<"idle" | "saved" | "error">("idle");
  // 拖拽排序状态（与快速输入预设词行拖拽同一套 HTML5 DnD 交互模型）
  const [featureDragIndex, setFeatureDragIndex] = useState<number | null>(null);
  const featureDragIndexRef = useRef<number | null>(null);
  const featureDragOrderRef = useRef<string[]>([]);
  const featureDragDirtyRef = useRef(false);

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
    /**
     * 子项（可选）。非空数组 = 转盘中的「父级扇区」：点击进入子转盘（整盘置换），
     * 自身 text 在子转盘语义下不参与输入。历史项无子项。
     */
    children?: Array<{ label: string; text: string }>;
  }
  interface QuickInputHistoryItem {
    preview: string;
    text: string;
    favorite?: boolean;
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
  // 剪贴板历史（后端内存缓冲并持久化，默认保留最新 5 条；收藏项固定在最前）
  const [qiHistory, setQiHistory] = useState<QuickInputHistoryItem[]>([]);
  const [qiHistoryStatus, setQiHistoryStatus] = useState<"idle" | "cleared" | "error">("idle");
  /** 单条删除 / 收藏失败时的行内提示 */
  const [qiHistoryActionError, setQiHistoryActionError] = useState("");
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
  // 音效反馈（默认关闭：转盘会被高频唤起，声音应由用户主动打开）
  const [qiSoundEnabled, setQiSoundEnabled] = useState(false);
  const [qiSoundEnabledStatus, setQiSoundEnabledStatus] = useState<"idle" | "saved" | "error">(
    "idle",
  );
  const qiSoundEnabledRef = useRef(false);
  const qiSoundEnabledSaveVersionRef = useRef(0);
  const [qiSoundStyle, setQiSoundStyle] = useState("standard");
  const qiSoundStyleRef = useRef("standard");
  const qiSoundStyleSaveVersionRef = useRef(0);
  const [qiSoundStyleStatus, setQiSoundStyleStatus] = useState<"idle" | "saved" | "error">("idle");
  const [qiSoundVolume, setQiSoundVolume] = useState(45);
  const [qiSoundVolumeStatus, setQiSoundVolumeStatus] = useState<"idle" | "saved" | "error">(
    "idle",
  );
  const qiSoundVolumeRef = useRef(45);
  const qiSoundVolumeSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const qiSoundVolumeSaveVersionRef = useRef(0);
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
      const history = await invoke<QuickInputHistoryItem[]>("get_quick_input_history");
      setQiHistory(history);
    } catch (err) {
      console.error("Failed to refresh quick input history:", err);
    }
  }, []);
  // 正在编辑的预设词下标（null 表示未处于编辑状态）
  const [qiEditingIndex, setQiEditingIndex] = useState<number | null>(null);
  const [qiEditLabel, setQiEditLabel] = useState("");
  const [qiEditText, setQiEditText] = useState("");
  // 子项编辑器展开在哪个片段上（null = 收起）；子项为一级扁平列表，不支持再嵌套
  const [qiChildEditorIndex, setQiChildEditorIndex] = useState<number | null>(null);
  const [qiNewChildLabel, setQiNewChildLabel] = useState("");
  const [qiNewChildText, setQiNewChildText] = useState("");

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
  // 后端自启列表是否已读到。**必须拿它当勾选框的闸门**：`autostartIds` 初值是 `[]`，
  // 而 `set_tools_autostart` 是**全量覆盖**语义 —— 用户抢在快照返回前点一下，
  // 就会用 `["system-monitor"]` 把原有的自启项（待办 / 时间工具）整份抹掉。
  const [autostartLoaded, setAutostartLoaded] = useState(false);
  // 保存失败时显示错误提示
  const [autostartError, setAutostartError] = useState(false);
  // 系统监控工具是否启用（自启动仅对已启用工具生效，未加载到后端状态前按启用处理）
  const [systemMonitorEnabled, setSystemMonitorEnabled] = useState(true);
  const [systemCleanerEnabled, setSystemCleanerEnabled] = useState(false);
  const [watchStatus, setWatchStatus] = useState<WatchStatus | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  /**
   * 一次性动作的**成功**回执（与 `watchError` 分开）。
   *
   * 原来「立即检查」成功时把话写进 `watchError`，而那个字段只在 `watchStatus`
   * 为空时才会渲染 —— 也就是说设置正常加载的情况下，用户点了按钮**什么反馈都没有**。
   * 成功与失败必须走两个字段、渲染在两处。
   */
  const [watchNotice, setWatchNotice] = useState<string | null>(null);
  const [watchBusy, setWatchBusy] = useState(false);
  const [settingsAuditConfirm, setSettingsAuditConfirm] = useState(false);
  const [settingsAuditMessage, setSettingsAuditMessage] = useState<string | null>(null);
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

  // 悬浮窗默认位置恢复状态（key 为窗口 id：orb / monitor-overlay / time-overlay / todo-overlay）
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
    const version = ++featuresSaveVersionRef.current;
    const previous = enabledFeatures;
    const next = previous.includes(id) ? previous.filter((f) => f !== id) : [...previous, id];
    setEnabledFeaturesState(next);
    emit("levitaire-features-changed", next);
    saveEnabledFeatures(next)
      .then(() => {
        if (version !== featuresSaveVersionRef.current) return;
        setFeaturesStatus("saved");
        setTimeout(() => setFeaturesStatus("idle"), 1500);
      })
      .catch((err) => {
        if (version !== featuresSaveVersionRef.current) return;
        console.error("Failed to save toolbar features:", err);
        setFeaturesStatus("error");
        setTimeout(() => setFeaturesStatus("idle"), 3000);
        setEnabledFeaturesState(previous);
        emit("levitaire-features-changed", previous);
      });
  };

  // 保存按钮顺序：乐观更新 → 写后端 → 广播给文字工具栏窗口
  const handleSaveFeatureOrder = (order: string[]) => {
    const version = ++featureOrderSaveVersionRef.current;
    setFeatureOrderState(order);
    featureOrderRef.current = order;
    emit("levitaire-feature-order-changed", order);
    saveToolbarFeatureOrder(order)
      .then(() => {
        if (version !== featureOrderSaveVersionRef.current) return;
        persistedFeatureOrderRef.current = order;
        setFeatureOrderStatus("saved");
        setTimeout(() => setFeatureOrderStatus("idle"), 1500);
      })
      .catch((err) => {
        if (version !== featureOrderSaveVersionRef.current) return;
        console.error("Failed to save toolbar feature order:", err);
        setFeatureOrderStatus("error");
        setTimeout(() => setFeatureOrderStatus("idle"), 3000);
        const persisted = persistedFeatureOrderRef.current;
        setFeatureOrderState(persisted);
        featureOrderRef.current = persisted;
        // 回滚时同步广播，避免文字工具栏窗口停留在乐观更新的错误顺序上
        emit("levitaire-feature-order-changed", persisted);
      });
  };

  /** 拖拽排序：把 from 位置的功能移动到 to 位置（to 为移除后新列表中的目标下标） */
  const reorderFeatures = (from: number, to: number) => {
    if (from === to) return;
    const next = [...featureDragOrderRef.current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    featureDragOrderRef.current = next;
    featureDragIndexRef.current = to;
    featureDragDirtyRef.current = true;
    setFeatureDragIndex(to);
    setFeatureOrderState(next);
    featureOrderRef.current = next;
  };

  /** 开始拖拽：记录源索引与初始列表快照 */
  const onFeatureDragStart = (e: DragEvent<HTMLDivElement>, idx: number) => {
    featureDragIndexRef.current = idx;
    featureDragOrderRef.current = featureOrderRef.current;
    featureDragDirtyRef.current = false;
    setFeatureDragIndex(idx);
    // Firefox 需要 setData 才允许开始拖拽
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(idx));
    }
  };

  /** 拖过行时实时重排：按鼠标在行内的上下半区决定插入该行前/后 */
  const onFeatureDragOver = (e: DragEvent<HTMLDivElement>, targetIdx: number) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const from = featureDragIndexRef.current;
    if (from === null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    let to = before ? targetIdx : targetIdx + 1;
    if (from < to) to -= 1;
    if (to !== from) reorderFeatures(from, to);
  };

  /** 放下：仅阻止浏览器默认行为，最终顺序由 dragend 统一落库 */
  const onFeatureDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  /** 拖拽结束：清理状态，拖拽中若发生过顺序变更则落库 */
  const onFeatureDragEnd = () => {
    if (featureDragIndexRef.current === null) return;
    const final = featureDragOrderRef.current;
    const dirty = featureDragDirtyRef.current;
    featureDragIndexRef.current = null;
    featureDragOrderRef.current = [];
    featureDragDirtyRef.current = false;
    setFeatureDragIndex(null);
    if (dirty) handleSaveFeatureOrder(final);
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

  /** 保存看门狗设置。入参里没有监视目录 —— 那条通路只能走目录对话框（I1）。 */
  const saveWatchSettings = async (patch: {
    enabled?: boolean;
    intervalHours?: number;
    minBytes?: number;
    minDeltaBytes?: number;
    minAgeDays?: number;
  }) => {
    if (!watchStatus) return;
    setWatchBusy(true);
    setWatchError(null);
    // 成功回执也要清：否则改完设置之后，上一句"已开始检查"会一直挂在页面上
    setWatchNotice(null);
    try {
      const status = await invoke<WatchStatus>("disk_cleanup_watch_update", {
        input: {
          enabled: patch.enabled ?? watchStatus.enabled,
          intervalHours: patch.intervalHours ?? watchStatus.intervalHours,
          minBytes: patch.minBytes ?? watchStatus.minBytes,
          minDeltaBytes: patch.minDeltaBytes ?? watchStatus.minDeltaBytes,
          minAgeDays: patch.minAgeDays ?? watchStatus.minAgeDays,
        },
      });
      setWatchStatus(status);
    } catch (error) {
      setWatchError(String(error));
    } finally {
      setWatchBusy(false);
    }
  };

  /** 添加监视目录：路径来自系统对话框，不经过 WebView。 */
  const addWatchTarget = async () => {
    setWatchBusy(true);
    setWatchError(null);
    // 成功回执也要清：否则改完设置之后，上一句"已开始检查"会一直挂在页面上
    setWatchNotice(null);
    try {
      const status = await invoke<WatchStatus | null>("disk_cleanup_watch_add_directory");
      if (status) setWatchStatus(status);
    } catch (error) {
      setWatchError(String(error));
    } finally {
      setWatchBusy(false);
    }
  };

  /** 立即检查：后台跑，结果由 `disk-cleanup-watchdog` 事件推回来。 */
  const runWatchNow = async () => {
    setWatchError(null);
    setWatchNotice(null);
    try {
      // ★ 后端如实返回"有没有真的开始"。抢不到 I9 闸门时它什么都不做、
      //   也不写任何状态 —— 无条件提示"已开始检查"会让用户永远等不到结果，
      //   也看不到任何错误。
      const started = await invoke<boolean>("disk_cleanup_watch_run_now");
      if (started) {
        setWatchNotice("已开始检查，扫描期间结果会在清理面板里出现");
      } else {
        setWatchError("正在扫描或清理，看门狗这一轮没法开始 —— 等它结束后再点一次。");
      }
    } catch (error) {
      setWatchError(String(error));
    }
  };

  /** 不再监视某个目录。只传下标 —— 路径不经过前端（I1）。 */
  const removeWatchTarget = async (index: number) => {
    setWatchBusy(true);
    setWatchError(null);
    // 成功回执也要清：否则改完设置之后，上一句"已开始检查"会一直挂在页面上
    setWatchNotice(null);
    try {
      const status = await invoke<WatchStatus>("disk_cleanup_watch_remove_directory", { index });
      setWatchStatus(status);
    } catch (error) {
      setWatchError(String(error));
    } finally {
      setWatchBusy(false);
    }
  };

  /**
   * 清空审计日志（§12.3）。
   *
   * 两步：先点「我要清空…」再点「确认清空？」。文档写的是"一键清空"，
   * 但它销毁的是**出事之后唯一的取证依据**，值得多一次点击。动作本身在设置页可见 ✓。
   */
  const clearAuditLogs = async () => {
    setSettingsAuditMessage(null);
    try {
      const removed = await invoke<number>("disk_cleanup_audit_clear");
      setSettingsAuditMessage(`已清空 ${removed} 份审计日志`);
    } catch (error) {
      setSettingsAuditMessage(String(error));
    } finally {
      setSettingsAuditConfirm(false);
    }
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

  // 监控配置也可能在**监控浮窗**里被改（点标题栏切换「显示样式 / 迷你模式」）。本窗口只在
  // 进入该页签时读一次后端真值，若不订阅广播就会一直抱着陈旧副本 —— 之后改「刷新间隔」时
  // `saveSystemMonitorConfig` 是**整份 JSON 回写**，会把用户在浮窗里选的样式静默改回去
  // （设置页这边显示的还是旧值，用户看不到任何提示）。
  // ⚠️ 比较必须覆盖**每一个**字段：漏掉 layout 时，"只在浮窗里换了样式"会被当成自己发出的
  // 回声而跳过，随后任何一次设置页改动都会用旧样式整份回写。
  useEffect(() => {
    let disposed = false;
    const unlisten = listen<SystemMonitorConfig>(
      "levitaire-system-monitor-config-changed",
      (event) => {
        if (disposed) return;
        const incoming = normalizeSystemMonitorConfig(event.payload);
        const current = systemMonitorConfigRef.current;
        // 本窗口自己发出的广播也会回到这里：值与 ref 相同，跳过（别把乐观写入又 setState 一遍）
        if (
          incoming.intervalMs === current.intervalMs &&
          incoming.displayMode === current.displayMode &&
          incoming.layout === current.layout
        ) {
          return;
        }
        systemMonitorConfigRef.current = incoming;
        setSystemMonitorConfig(incoming);
      },
    );
    return () => {
      disposed = true;
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

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

  // 按页签懒加载：仅当首次进入某页签时才拉取对应工具/设置的后端配置，
  // 避免打开设置（默认停留在「通用」）就一次性读取截图、录屏、系统监控、
  // 番茄钟、待办、快速输入等全部工具的配置与数据。
  useEffect(() => {
    if (loadedTabsRef.current[activeTab]) return;
    loadedTabsRef.current[activeTab] = true;

    switch (activeTab) {
      case "general":
        invoke<boolean>("get_auto_start")
          .then((enabled) => setAutoStart(enabled))
          .catch((err) => console.error("Failed to get auto start status:", err));
        break;
      case "ai":
        invoke<AiConfig>("get_ai_config")
          .then((config) => setAiConfig(config))
          .catch((err) => console.error("Failed to load AI config:", err));
        break;
      case "screenshot":
        void Promise.allSettled([
          invoke<string>("get_screenshot_hotkey"),
          invoke<string>("get_screenshot_save_path"),
          fetchPinBorderColor(),
          fetchPinBorderWidth(),
        ]).then(([hotkey, savePath, pinColor, pinWidth]) => {
          if (hotkey.status === "fulfilled") setScreenshotHotkey(hotkey.value);
          if (savePath.status === "fulfilled") setScreenshotSavePath(savePath.value);
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
        });
        break;
      case "recording":
        void Promise.allSettled([
          invoke<string>("get_recording_hotkey"),
          invoke<string>("get_recording_save_path"),
          fetchRecordingConfig(),
        ]).then(([hotkey, savePath, config]) => {
          if (hotkey.status === "fulfilled") setRecordingHotkey(hotkey.value);
          if (savePath.status === "fulfilled") setRecordingSavePath(savePath.value);
          if (config.status === "fulfilled") {
            if (recordingConfigSaveVersionRef.current === 0) {
              recordingConfigRef.current = config.value;
              setRecordingConfig(config.value);
            }
          }
        });
        break;
      case "sketch":
        invoke<string>("get_sketch_hotkey")
          .then((hotkey) => {
            if (sketchHotkeyRequestRef.current !== 0) return;
            setSketchHotkey(hotkey);
            sketchHotkeyRef.current = hotkey;
          })
          .catch((err) => console.error("Failed to load sketch hotkey:", err));
        break;
      case "quick-input":
        void Promise.allSettled([
          invoke<string>("get_quick_input_trigger_key"),
          invoke<string>("get_quick_input_mode"),
          invoke<string>("get_quick_input_snippets"),
          invoke<boolean>("get_quick_input_history_enabled"),
          invoke<boolean>("get_quick_input_snippets_enabled"),
          invoke<number>("get_quick_input_history_limit"),
          invoke<boolean>("get_quick_input_sound_enabled"),
          invoke<string>("get_quick_input_sound_style"),
          invoke<number>("get_quick_input_sound_volume"),
        ]).then(
          ([
            key,
            mode,
            snippets,
            historyEnabled,
            snippetsEnabled,
            historyLimit,
            soundEnabled,
            soundStyle,
            soundVolume,
          ]) => {
            if (key.status === "fulfilled") setQiTriggerKey(key.value || "CapsLock");
            if (mode.status === "fulfilled") setQiMode(mode.value === "hold" ? "hold" : "click");
            if (snippets.status === "fulfilled" && snippets.value) {
              try {
                setQiSnippets(JSON.parse(snippets.value) as QuickInputSnippet[]);
              } catch {
                /* 忽略解析错误 */
              }
            }
            if (historyEnabled.status === "fulfilled") {
              qiHistoryEnabledRef.current = historyEnabled.value;
              setQiHistoryEnabled(historyEnabled.value);
            }
            if (snippetsEnabled.status === "fulfilled") {
              qiSnippetsEnabledRef.current = snippetsEnabled.value;
              setQiSnippetsEnabled(snippetsEnabled.value);
            }
            if (historyLimit.status === "fulfilled") {
              // 用户已开始修改时，忽略较晚返回的初始读取结果，避免覆盖用户输入。
              if (qiHistoryLimitSaveVersionRef.current === 0) {
                const normalized = Math.max(0, Math.min(20, Math.trunc(historyLimit.value)));
                qiHistoryLimitRef.current = normalized;
                setQiHistoryLimit(normalized);
              }
            }
            if (soundEnabled.status === "fulfilled") {
              qiSoundEnabledRef.current = soundEnabled.value;
              setQiSoundEnabled(soundEnabled.value);
            }
            if (soundStyle.status === "fulfilled") {
              // 同音量：用户已经改过风格就不要再被迟到的初始读取覆盖。
              // "none" 不暴露在设置页（它等价于「关掉音效开关」），因此下拉框里只有
              // minimal / standard 两档；读到 none 时按 standard 展示，避免出现空选项。
              if (qiSoundStyleSaveVersionRef.current === 0) {
                const style = soundStyle.value === "minimal" ? "minimal" : "standard";
                qiSoundStyleRef.current = style;
                setQiSoundStyle(style);
              }
            }
            if (soundVolume.status === "fulfilled") {
              // 同保留条数：用户已拖动过音量就不要再被初始读取覆盖。
              if (qiSoundVolumeSaveVersionRef.current === 0) {
                const normalized = Math.max(0, Math.min(100, Math.trunc(soundVolume.value)));
                qiSoundVolumeRef.current = normalized;
                setQiSoundVolume(normalized);
              }
            }
          },
        );
        break;
      case "system-cleaner":
        // 看门狗设置是长驻后台任务的配置，不在工具开关快照里，单独拉一次
        invoke<WatchStatus>("disk_cleanup_watch_status")
          .then((status) => setWatchStatus(status))
          .catch(() => {});
        break;
      case "monitor":
        // 工具启用/自动打开状态由进入页签时的快照刷新统一处理（见 refreshToolEnableSnapshot）
        fetchSystemMonitorConfig()
          .then((config) => {
            if (systemMonitorSaveVersionRef.current === 0) {
              systemMonitorConfigRef.current = config;
              setSystemMonitorConfig(config);
            }
          })
          .catch(() => {});
        break;
      case "timer":
        void Promise.allSettled([
          invoke<boolean>("get_timer_reminders_enabled"),
          invoke<string>("get_timer_reminder_sound"),
          invoke<boolean>("get_timer_lunar_enabled"),
        ]).then(([reminders, sound, lunar]) => {
          if (reminders.status === "fulfilled") setTimerRemindersEnabled(reminders.value);
          if (sound.status === "fulfilled") {
            setTimerReminderSound(sound.value === "none" ? "none" : "tone");
          }
          if (lunar.status === "fulfilled") setTimerLunarEnabled(lunar.value);
        });
        // 番茄钟已并入时间工具：配置跟随同一页签一起拉取
        fetchPomodoroConfig()
          .then((config) => {
            if (pomodoroSaveVersionRef.current === 0) {
              pomodoroConfigRef.current = config;
              setPomodoroConfig(config);
            }
          })
          .catch(() => {});
        break;
      case "todo":
        void Promise.allSettled([
          invoke<boolean>("get_todo_reminders_enabled"),
          invoke<string>("get_todo_reminder_sound"),
          invoke<string>("get_todo_quick_add_hotkey"),
        ]).then(([reminders, sound, quickAdd]) => {
          if (reminders.status === "fulfilled") setTodoRemindersEnabled(reminders.value);
          if (sound.status === "fulfilled") setTodoReminderSound(sound.value);
          if (quickAdd.status === "fulfilled") setTodoQuickAddHotkey(quickAdd.value);
        });
        break;
      case "toolbar":
        void Promise.allSettled([
          fetchEnabledFeatures(),
          fetchToolbarFeatureOrder(),
          fetchDedupMode(),
          fetchMd5Length(),
          fetchNumberingStyle(),
          fetchClearOptions(),
          fetchTtsConfig(),
          fetchSearchEngine(),
          invoke<VoiceInfo[]>("tts_get_voices"),
        ]).then(([features, order, dedup, md5, numbering, clear, tts, search, voices]) => {
          // 若读取期间用户已启停过功能开关，忽略本次读取结果，避免覆盖用户刚做的修改
          if (features.status === "fulfilled" && featuresSaveVersionRef.current === 0) {
            setEnabledFeaturesState(features.value);
          }
          // 若读取期间用户已拖拽保存过顺序，忽略本次读取结果，避免覆盖用户刚做的修改
          if (order.status === "fulfilled" && featureOrderSaveVersionRef.current === 0) {
            persistedFeatureOrderRef.current = order.value;
            setFeatureOrderState(order.value);
            featureOrderRef.current = order.value;
          }
          if (dedup.status === "fulfilled") setDedupModeState(dedup.value);
          if (md5.status === "fulfilled") setMd5LengthState(md5.value);
          if (numbering.status === "fulfilled") setNumberingStyleState(numbering.value);
          if (clear.status === "fulfilled") setEnabledClearIdsState(clear.value);
          if (tts.status === "fulfilled") setTtsConfigState(tts.value);
          if (search.status === "fulfilled") setSearchEngineState(search.value);
          if (voices.status === "fulfilled") setTtsVoices(voices.value);
        });
        break;
    }
  }, [activeTab]);

  // 「启动时自动打开」勾选框依赖工具启用状态（系统监控/时间工具/待办）。
  // 这些开关可在悬浮球面板等外部入口被改动，而设置窗口隐藏后组件仍挂载，
  // 若只在首次挂载读取会导致勾选框状态滞后，这里单独抽出供重新聚焦时重新同步。
  const refreshToolEnableSnapshot = useCallback(() => {
    toolSnapshotLoadedRef.current = true;
    void Promise.allSettled([
      invoke<boolean>("get_system_monitor_enabled"),
      invoke<boolean>("get_system_cleaner_enabled"),
      invoke<boolean>("get_todo_enabled"),
      invoke<boolean>("get_timer_enabled"),
      invoke<string[]>("get_tools_autostart"),
    ])
      .then(([monitor, cleaner, todo, timer, autostart]) => {
        if (monitor.status === "fulfilled") setSystemMonitorEnabled(monitor.value);
        if (cleaner.status === "fulfilled") setSystemCleanerEnabled(cleaner.value);
        if (todo.status === "fulfilled") setTodoEnabled(todo.value);
        if (timer.status === "fulfilled") setTimerEnabled(timer.value);
        if (autostart.status === "fulfilled") {
          // 旧 ID 在这里就归一化（pomodoro → timer）：下面的勾选框只认新 ID。
          // 后端存的是历史原值（`set_tools_autostart` 不做迁移），不归一化会出现
          // 「设置里显示未勾选、但启动时仍然自动打开」且**用户无法关掉**的老配置 ——
          // 勾选只加 "timer"、取消只删 "timer"，数组里那个 "pomodoro" 永远留着，
          // 而 FloatingOrb 会把它别名成 "timer" 照常打开。
          //
          // 数组守卫不能省：`invoke<string[]>` 的类型参数只是**声明**，不是运行时保证
          // （后端返回非数组时 `.map` 会抛）。这个 then 里抛出的异常没有 catch 兜，
          // 会变成未处理的 rejection —— 既不上屏、也不回滚，问题完全静默。
          const ids = Array.isArray(autostart.value) ? autostart.value : [];
          setAutostartIdsState([...new Set(ids.map(resolveToolIdAlias))]);
          // 读到之后才允许点击（见 autostartLoaded 的说明）
          setAutostartLoaded(true);
        }
      })
      .catch((error) => {
        // 兜底：任何一步抛错都只记日志，不让它变成未处理的 rejection
        console.error("同步工具启停状态失败:", error);
      });
  }, []);

  // 首次进入展示「启动时自动打开」的页签时同步工具启停/自动打开快照。
  // 快照按窗口会话只拉取一次（重新聚焦时失效），既避免在这些页签间反复读取后端，
  // 也避免刚保存的自动打开状态被后续快照覆盖。
  useEffect(() => {
    if (
      !toolSnapshotLoadedRef.current &&
      (activeTab === "monitor" ||
        activeTab === "system-cleaner" ||
        activeTab === "timer" ||
        activeTab === "todo")
    ) {
      refreshToolEnableSnapshot();
    }
  }, [activeTab, refreshToolEnableSnapshot]);

  // 处理设置窗口被隐藏后再次打开的场景：此时 Settings 组件仍然挂载，
  // 只有重新读取后端快照才能显示最新的剪贴板历史与工具启停/自动打开状态。
  // 仅在当前页签确实展示对应数据时才刷新，避免在「通用/AI」页反复读取各工具快照。
  useEffect(() => {
    const window = getCurrentWebviewWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void window
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          setIsClosing(false);
          // 关闭流程守卫复位，允许本轮会话再次触发关闭
          closingRequestedRef.current = false;
          // 同时拆除淡出监听与兜底定时器，真正取消关闭：若不拆除，
          // opacity 回弹会触发 transitionend 或 300ms 兜底定时器把窗口关掉。
          if (closeTransitionHandlerRef.current && settingsShellRef.current) {
            settingsShellRef.current.removeEventListener(
              "transitionend",
              closeTransitionHandlerRef.current,
            );
            closeTransitionHandlerRef.current = null;
          }
          if (closeTimerRef.current !== null) {
            globalThis.clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
          }
          // 重新聚焦即视为新一轮窗口会话：使快照失效，确保再进入相关页签时取到最新状态
          toolSnapshotLoadedRef.current = false;
          if (activeTabRef.current === "quick-input") void refreshQiHistory();
          if (
            activeTabRef.current === "monitor" ||
            activeTabRef.current === "system-cleaner" ||
            activeTabRef.current === "timer" ||
            activeTabRef.current === "todo"
          ) {
            refreshToolEnableSnapshot();
          }
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
    // 子项编辑器跟随同样的索引平移规则
    if (qiChildEditorIndex !== null) {
      if (qiChildEditorIndex === idx) setQiChildEditorIndex(null);
      else if (qiChildEditorIndex > idx) setQiChildEditorIndex(qiChildEditorIndex - 1);
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
    // 子项编辑器挂在特定片段上，重排后直接收起，避免指错行
    if (qiChildEditorIndex !== null) setQiChildEditorIndex(null);
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
    const editing = qiSnippets[qiEditingIndex];
    // 文本为空则不保存——但带子项的分组条目允许空文本（转盘中点击分组进入子级，不输入文本）
    if (!qiEditText.trim() && !editing?.children?.length) {
      setQiEditingIndex(null);
      return;
    }
    const next = qiSnippets.map((s, i) =>
      i === qiEditingIndex
        ? { ...s, label: qiEditLabel.trim() || qiEditText.slice(0, 20), text: qiEditText }
        : s,
    );
    setQiEditingIndex(null);
    void saveQiSnippets(next);
  };

  const cancelEditQiSnippet = () => setQiEditingIndex(null);

  /** 给指定片段添加子项（转盘中的二级条目）；标签缺省时取文本前 20 字 */
  const addChildQiSnippet = (parentIdx: number) => {
    if (!qiNewChildText.trim()) return;
    const parent = qiSnippets[parentIdx];
    if (!parent) return;
    const child = {
      label: qiNewChildLabel.trim() || qiNewChildText.slice(0, 20),
      text: qiNewChildText,
    };
    const next = qiSnippets.map((s, i) =>
      i === parentIdx ? { ...s, children: [...(s.children ?? []), child] } : s,
    );
    setQiNewChildLabel("");
    setQiNewChildText("");
    void saveQiSnippets(next);
  };

  /** 删除指定片段的一个子项；子项删空后移除 children 字段，条目退回普通片段 */
  const removeChildQiSnippet = (parentIdx: number, childIdx: number) => {
    const parent = qiSnippets[parentIdx];
    if (!parent) return;
    const children = (parent.children ?? []).filter((_, i) => i !== childIdx);
    const next = qiSnippets.map((s, i) =>
      i === parentIdx ? { ...s, children: children.length ? children : undefined } : s,
    );
    void saveQiSnippets(next);
  };

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

  /** 音效开关：转盘被高频唤起，开关必须即时生效，因此独立于风格与音量单发一次同步。 */
  const changeQiSoundEnabled = async (enabled: boolean) => {
    const previous = qiSoundEnabledRef.current;
    const version = ++qiSoundEnabledSaveVersionRef.current;
    qiSoundEnabledRef.current = enabled;
    setQiSoundEnabled(enabled);
    setQiSoundEnabledStatus("idle");
    try {
      await invoke("set_quick_input_sound_enabled", { enabled });
      if (version !== qiSoundEnabledSaveVersionRef.current) return;
      setQiSoundEnabledStatus("saved");
      setTimeout(() => setQiSoundEnabledStatus("idle"), 2000);
    } catch (err) {
      if (version !== qiSoundEnabledSaveVersionRef.current) return;
      console.error("Failed to save quick input sound enabled state:", err);
      qiSoundEnabledRef.current = previous;
      setQiSoundEnabled(previous);
      setQiSoundEnabledStatus("error");
      setTimeout(() => setQiSoundEnabledStatus("idle"), 3000);
    }
  };

  /** 音效风格：切换后立即试听一下当前风格的「确认」音，让用户听到差异。 */
  const changeQiSoundStyle = async (style: string) => {
    const previous = qiSoundStyleRef.current;
    if (previous === style) return;
    const version = ++qiSoundStyleSaveVersionRef.current;
    qiSoundStyleRef.current = style;
    setQiSoundStyle(style);
    setQiSoundStyleStatus("idle");
    try {
      await invoke("set_quick_input_sound_style", { style });
      if (version !== qiSoundStyleSaveVersionRef.current) return;
      setQiSoundStyleStatus("saved");
      setTimeout(() => setQiSoundStyleStatus("idle"), 2000);
      // 极简风格没有刻度音，用「确认」音作为风格样本；标准风格顺带演示刻度音。
      if (style === "minimal") {
        void invoke("preview_quick_input_sound", { cue: "confirm" }).catch(() => {});
      } else {
        void invoke("preview_quick_input_sound", { cue: "tick" }).catch(() => {});
      }
    } catch (err) {
      if (version !== qiSoundStyleSaveVersionRef.current) return;
      console.error("Failed to set quick input sound style:", err);
      qiSoundStyleRef.current = previous;
      setQiSoundStyle(previous);
      setQiSoundStyleStatus("error");
      setTimeout(() => setQiSoundStyleStatus("idle"), 3000);
    }
  };

  /**
   * 音量保存（滑杆会高频触发，沿用保留条数的「队列 + 版本号」模式）：
   * 串行化写盘避免乱序，版本号保证只有最后一次的结果被采纳。
   */
  const changeQiSoundVolume = async (volume: number) => {
    const normalized = Math.max(0, Math.min(100, Math.trunc(volume)));
    const previous = qiSoundVolumeRef.current;
    if (normalized === previous) return;
    const version = ++qiSoundVolumeSaveVersionRef.current;
    qiSoundVolumeRef.current = normalized;
    setQiSoundVolume(normalized);
    setQiSoundVolumeStatus("idle");

    const run = qiSoundVolumeSaveQueueRef.current.then(async () => {
      try {
        await invoke("set_quick_input_sound_volume", { volume: normalized });
        if (version !== qiSoundVolumeSaveVersionRef.current) return;
        setQiSoundVolumeStatus("saved");
        setTimeout(() => setQiSoundVolumeStatus("idle"), 2000);
      } catch (err) {
        if (version !== qiSoundVolumeSaveVersionRef.current) return;
        console.error("Failed to save quick input sound volume:", err);
        qiSoundVolumeRef.current = previous;
        setQiSoundVolume(previous);
        setQiSoundVolumeStatus("error");
        setTimeout(() => setQiSoundVolumeStatus("idle"), 3000);
      }
    });
    qiSoundVolumeSaveQueueRef.current = run.catch(() => {});
    await run;
  };

  /** 试听某个音效（不受音效开关约束，音量取当前配置）。 */
  const previewQiSound = (cue: "open" | "tick" | "confirm" | "cancel") => {
    void invoke("preview_quick_input_sound", { cue }).catch((err) =>
      console.error("preview quick input sound failed:", err),
    );
  };

  /**
   * 松手试听。音量 0 时直接跳过：后端会返回「音量为 0 不播放」的静默结果，
   * 用户按了没反应会以为试听坏了，不如不响应。
   * 音量取 ref 而不是 state —— state 在滑杆高频 onChange 下有闭包陈旧风险。
   */
  const previewQiSoundAtCurrentVolume = () => {
    if (qiSoundVolumeRef.current <= 0) return;
    previewQiSound("confirm");
  };

  /** 清空剪贴板历史（后端内存缓冲区） */
  const clearQiHistory = async () => {
    setQiHistoryStatus("idle");
    setQiHistoryActionError("");
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

  /** 删除单条历史记录（敏感内容可单独清理，无需整批清空） */
  const removeQiHistoryItem = async (text: string) => {
    setQiHistoryStatus("idle");
    setQiHistoryActionError("");
    try {
      await invoke("remove_quick_input_history_item", { text });
      await refreshQiHistory();
    } catch (err) {
      console.error("Failed to remove quick input history item:", err);
      setQiHistoryActionError("删除失败，请重试");
    }
  };

  /** 收藏 / 取消收藏某条历史记录：收藏项固定在转盘历史区最前，不被滚动裁剪 */
  const toggleQiHistoryFavorite = async (item: QuickInputHistoryItem) => {
    setQiHistoryStatus("idle");
    setQiHistoryActionError("");
    const favorite = !item.favorite;
    try {
      await invoke("set_quick_input_history_favorite", { text: item.text, favorite });
      await refreshQiHistory();
    } catch (err) {
      console.error("Failed to toggle quick input history favorite:", err);
      setQiHistoryActionError(favorite ? "收藏失败，请重试" : "取消收藏失败，请重试");
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
      .then(async () => {
        if (version !== qiHistoryLimitSaveVersionRef.current) return;
        // 后端裁剪含收藏项语义（收藏项不受保留条数限制），统一拉取最新列表避免本地截断失真
        await refreshQiHistory();
        if (version !== qiHistoryLimitSaveVersionRef.current) return;
        setQiHistoryLimitStatus("saved");
        setTimeout(() => setQiHistoryLimitStatus("idle"), 2000);
      })
      .catch(async (err) => {
        if (version !== qiHistoryLimitSaveVersionRef.current) return;
        console.error("Failed to save quick input history limit:", err);
        qiHistoryLimitRef.current = previous;
        setQiHistoryLimit(previous);
        setQiHistoryLimitStatus("error");
        await refreshQiHistory();
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

  // 在线更新：状态由后端 updater 维护（检测 → 静默下载 → 就绪），本页只订阅快照
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
    <div className={`settings-shell${isClosing ? " is-closing" : ""}`} ref={settingsShellRef}>
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
              <p className="settings-hint">{WINDOW_POSITION_HINT}</p>
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
                  {updater.status === "downloading" && (
                    <span className="settings-hint">
                      <Icon name="Loader2" size={14} className="settings-save-spinner" />{" "}
                      正在后台下载{" "}
                      {updater.availableVersion ? `v${updater.availableVersion} ` : "新版本 "}
                      {updater.progress != null ? `${updater.progress}%` : "…"}
                      （下载完成后会提示你安装）
                    </span>
                  )}
                  {updater.status === "ready" && (
                    <div className="settings-updater-available">
                      <span className="settings-hint">
                        <Icon name="Check" size={14} /> 新版本 <b>{updater.availableVersion}</b>{" "}
                        已下载完成
                      </span>
                      <button className="settings-save-btn" onClick={updater.installUpdate}>
                        <Icon name="Download" size={14} /> 立即更新
                      </button>
                    </div>
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
                        <Icon name="X" size={14} /> 更新失败
                      </span>
                      {updater.errorMessage && (
                        <span className="settings-hint" title={updater.errorMessage}>
                          {updater.errorMessage.slice(0, 120)}
                        </span>
                      )}
                      <button
                        className="settings-toggle-btn"
                        onClick={updater.checkForUpdate}
                        title="重试"
                      >
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
                      <Fragment key={i}>
                        <div
                          className={`qi-snippet-row${qiDraggingIndex === i ? " qi-snippet-dragging" : ""}`}
                          draggable
                          onDragStart={(e) => onQiSnippetDragStart(e, i)}
                          onDragOver={(e) => onQiSnippetDragOver(e, i)}
                          onDrop={onQiSnippetDrop}
                          onDragEnd={onQiSnippetDragEnd}
                        >
                          <div className="qi-snippet-label" title={s.label}>
                            {s.label}
                            {s.children?.length ? (
                              <span className="qi-snippet-children-badge">
                                {s.children.length} 子项
                              </span>
                            ) : null}
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
                              className={`settings-toggle-btn settings-toggle-btn-sm${qiChildEditorIndex === i ? " is-active" : ""}`}
                              draggable={false}
                              onClick={() =>
                                setQiChildEditorIndex(qiChildEditorIndex === i ? null : i)
                              }
                              title="子项（转盘二级条目）"
                              aria-label="子项"
                            >
                              <Icon name="FolderOpen" size={14} />
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
                        {qiChildEditorIndex === i && (
                          <div className="qi-child-editor">
                            {(s.children ?? []).map((c, ci) => (
                              <div className="qi-snippet-row qi-child-row" key={ci}>
                                <div className="qi-snippet-label" title={c.label}>
                                  {c.label}
                                </div>
                                <div className="qi-snippet-text" title={c.text}>
                                  {c.text}
                                </div>
                                <div className="qi-snippet-actions">
                                  <button
                                    className="settings-toggle-btn settings-toggle-btn-sm"
                                    onClick={() => removeChildQiSnippet(i, ci)}
                                    title="删除子项"
                                    aria-label="删除子项"
                                  >
                                    <Icon name="X" size={14} />
                                  </button>
                                </div>
                              </div>
                            ))}
                            <div className="qi-snippet-add qi-child-add">
                              <input
                                type="text"
                                value={qiNewChildLabel}
                                onChange={(e) => setQiNewChildLabel(e.target.value)}
                                placeholder="子标签（可选）"
                                className="settings-input"
                                style={{ width: 120 }}
                              />
                              <input
                                type="text"
                                value={qiNewChildText}
                                onChange={(e) => setQiNewChildText(e.target.value)}
                                placeholder="子项文本…"
                                className="settings-input"
                                style={{ flex: 1 }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") addChildQiSnippet(i);
                                }}
                              />
                              <button
                                className="settings-toggle-btn"
                                onClick={() => addChildQiSnippet(i)}
                                title="添加子项"
                              >
                                <Icon name="Check" size={16} />
                              </button>
                            </div>
                          </div>
                        )}
                      </Fragment>
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
                  <label className="settings-label">音效反馈</label>
                  <span
                    className="settings-hint-inline"
                    title="转盘唤出、鼠标划过扇区、确认输入、取消退出时各有一个短音效。默认关闭。"
                  >
                    <Icon name="AlertCircle" size={14} aria-hidden="true" />
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={qiSoundEnabled}
                    aria-label="音效反馈"
                    className={`qi-toggle-switch${qiSoundEnabled ? " is-on" : ""}`}
                    onClick={() => void changeQiSoundEnabled(!qiSoundEnabled)}
                  >
                    <span className="qi-toggle-switch-thumb" />
                  </button>
                </div>
                {qiSoundEnabledStatus === "saved" && <span className="settings-hint">已保存</span>}
                {qiSoundEnabledStatus === "error" && (
                  <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    保存失败
                  </span>
                )}
                <div className={`qi-sound-panel${qiSoundEnabled ? "" : " is-disabled"}`}>
                  <div className="settings-item-head">
                    <label className="settings-label" htmlFor="settings-qi-sound-style">
                      音效风格
                    </label>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <select
                        id="settings-qi-sound-style"
                        className="settings-select"
                        value={qiSoundStyle}
                        disabled={!qiSoundEnabled}
                        onChange={(e) => void changeQiSoundStyle(e.target.value)}
                      >
                        <option value="standard">标准（含刻度音）</option>
                        <option value="minimal">极简（仅唤出与确认）</option>
                      </select>
                      {qiSoundStyleStatus === "saved" && (
                        <span className="settings-hint">已保存</span>
                      )}
                      {qiSoundStyleStatus === "error" && (
                        <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                          保存失败
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="settings-item-head" style={{ marginTop: 10 }}>
                    <label className="settings-label" htmlFor="settings-qi-sound-volume">
                      音量
                    </label>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input
                        id="settings-qi-sound-volume"
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={qiSoundVolume}
                        disabled={!qiSoundEnabled}
                        onChange={(e) => void changeQiSoundVolume(Number(e.target.value))}
                        // 松手时用「刚刚保存的」音量试听，让用户听到的就是实际音量。
                        // 音量为 0 时不试听 —— 放了也听不到，只会让人以为试听坏了。
                        onMouseUp={previewQiSoundAtCurrentVolume}
                        onTouchEnd={previewQiSoundAtCurrentVolume}
                        style={{ width: 160 }}
                      />
                      <span className="settings-hint" style={{ minWidth: 34 }}>
                        {qiSoundVolume}%
                      </span>
                      {qiSoundVolumeStatus === "saved" && (
                        <span className="settings-hint">已保存</span>
                      )}
                      {qiSoundVolumeStatus === "error" && (
                        <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                          保存失败
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="qi-sound-preview-row">
                    <span className="settings-hint">试听</span>
                    {(
                      [
                        ["open", "唤出"],
                        ["tick", "划过"],
                        ["confirm", "确认"],
                        ["cancel", "取消"],
                      ] as const
                    ).map(([cue, label]) => (
                      <button
                        key={cue}
                        type="button"
                        className="settings-toggle-btn settings-toggle-btn-sm qi-sound-preview-btn"
                        disabled={
                          !qiSoundEnabled || (cue === "tick" && qiSoundStyle !== "standard")
                        }
                        onClick={() => previewQiSound(cue)}
                        title={`试听「${label}」音效`}
                        // 按钮可见文本只有「唤出/划过/确认/取消」，读屏器无法区分同名按钮，
                        // 因此显式给出可访问名称。
                        aria-label={`试听「${label}」音效`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <span className="settings-hint">拖动音量滑杆松手时会试听一次「确认」音。</span>
              </div>
              <div className="settings-item">
                <div className="settings-item-head">
                  <label className="settings-label">剪贴板历史</label>
                  <span
                    className="settings-hint-inline"
                    title="自动记录复制到剪贴板的文本，最新在前。点击星标可收藏常用片段，固定到转盘历史区最前且不会被自动清理；行内垃圾桶可删除某一条敏感记录。保留条数限制普通记录条数，设为 0 可停用历史（收藏一并清除）。"
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
                    <div
                      className={`qi-snippet-row qi-history-row${h.favorite ? " is-favorite" : ""}`}
                      key={`${h.text}-${i}`}
                      title={h.text}
                    >
                      <div className="qi-snippet-text">{h.preview}</div>
                      <div className="qi-snippet-actions">
                        <button
                          className={`settings-toggle-btn settings-toggle-btn-sm${h.favorite ? " is-active" : ""}`}
                          onClick={() => void toggleQiHistoryFavorite(h)}
                          title={
                            h.favorite
                              ? "取消收藏（不再固定到最前）"
                              : "收藏（固定到转盘历史区最前）"
                          }
                          aria-label={h.favorite ? "取消收藏" : "收藏"}
                          aria-pressed={!!h.favorite}
                        >
                          <Icon name="Star" size={14} />
                        </button>
                        <button
                          className="settings-toggle-btn settings-toggle-btn-sm"
                          onClick={() => void removeQiHistoryItem(h.text)}
                          title="删除该条记录"
                          aria-label="删除"
                        >
                          <Icon name="Trash2" size={14} />
                        </button>
                      </div>
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
                    <span className="settings-hint">条（收藏项不计入；0 不记录）</span>
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
                    title="清空剪贴板历史（含收藏项）"
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
                  {qiHistoryActionError && (
                    <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                      {qiHistoryActionError}
                    </span>
                  )}
                </div>
              </div>
            </>
          )}

          {/* ── 系统清理 ──────────────────────────────────── */}
          {activeTab === "system-cleaner" && (
            <>
              <h2 className="settings-panel-title">系统清理</h2>
              <p className="settings-panel-desc">
                {"扫描并清理磁盘垃圾。清理项与保留期由后端规则表决定，逐项写明后果；" +
                  "被占用的文件一律跳过，不会为了「清干净」而强删或改动文件属性。" +
                  "审计日志只存在本机用户数据目录下的 levitaire/cleanup-audit，绝不上传，可随时一键清空。"}
              </p>
              <div className="settings-item">
                <label
                  className={`settings-checkbox-label${systemCleanerEnabled ? "" : " is-disabled"}`}
                >
                  <input
                    type="checkbox"
                    checked={autostartIds.includes("system-cleaner")}
                    disabled={!autostartLoaded || !systemCleanerEnabled}
                    onChange={() => handleToggleToolAutostart("system-cleaner")}
                  />
                  <span>启动时自动打开</span>
                </label>
                {!autostartLoaded && <span className="settings-hint">正在读取配置…</span>}
                {autostartLoaded && !systemCleanerEnabled && (
                  <span className="settings-hint">该工具未启用，需先在悬浮球面板中启用</span>
                )}
                {autostartError && (
                  <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                    设置失败
                  </span>
                )}
              </div>

              {/* ── 看门狗（§11）────────────────────────────── */}
              <h3 className="settings-subsection-title">失控看门狗</h3>
              <p className="settings-panel-desc">
                {"每天低频比对历次快照，把「一直很大」和「正在失控」分开：只有同时超过大小与增长" +
                  "两条阈值的目录才会通知你。"}
                <b>它一个字节都不删</b>
                {"，只发通知，要不要处理由你在清理面板里决定。"}
              </p>
              {!watchStatus ? (
                <span className="settings-hint">{watchError ?? "正在读取看门狗设置…"}</span>
              ) : (
                <>
                  <div className="settings-item">
                    <label className="settings-checkbox-label">
                      <input
                        type="checkbox"
                        checked={watchStatus.enabled}
                        disabled={watchBusy}
                        onChange={(event) =>
                          void saveWatchSettings({ enabled: event.target.checked })
                        }
                      />
                      <span>启用看门狗</span>
                    </label>
                    <span className="settings-hint">
                      {watchStatus.lastRunAt
                        ? `上次检查：${watchStatus.lastRunAt}`
                        : "还没有检查过"}
                    </span>
                    {watchStatus.lastError && (
                      <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                        最近一次检查没能完成：{watchStatus.lastError}
                        {"（这不代表没有目录在变大，只是这一轮没查出来）"}
                      </span>
                    )}
                  </div>
                  <div className="settings-item settings-row">
                    <div className="settings-inline-group">
                      <label className="settings-label" htmlFor="settings-watch-interval">
                        检查间隔
                      </label>
                      <select
                        id="settings-watch-interval"
                        value={watchStatus.intervalHours}
                        disabled={watchBusy}
                        onChange={(event) =>
                          void saveWatchSettings({ intervalHours: Number(event.target.value) })
                        }
                        className="settings-select"
                      >
                        {WATCHDOG_INTERVAL_OPTIONS.map((hours) => (
                          <option key={hours} value={hours}>
                            {hours >= 24 ? `${hours / 24} 天` : `${hours} 小时`}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="settings-inline-group">
                      <label className="settings-label" htmlFor="settings-watch-min-bytes">
                        目录大于
                      </label>
                      <select
                        id="settings-watch-min-bytes"
                        value={watchStatus.minBytes}
                        disabled={watchBusy}
                        onChange={(event) =>
                          void saveWatchSettings({ minBytes: Number(event.target.value) })
                        }
                        className="settings-select"
                      >
                        {WATCHDOG_MIN_BYTES_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="settings-inline-group">
                      <label className="settings-label" htmlFor="settings-watch-min-delta">
                        且增长超过
                      </label>
                      <select
                        id="settings-watch-min-delta"
                        value={watchStatus.minDeltaBytes}
                        disabled={watchBusy}
                        onChange={(event) =>
                          void saveWatchSettings({ minDeltaBytes: Number(event.target.value) })
                        }
                        className="settings-select"
                      >
                        {WATCHDOG_MIN_DELTA_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="settings-inline-group">
                      <label className="settings-label" htmlFor="settings-watch-min-age">
                        观察窗口
                      </label>
                      <select
                        id="settings-watch-min-age"
                        value={watchStatus.minAgeDays}
                        disabled={watchBusy}
                        onChange={(event) =>
                          void saveWatchSettings({ minAgeDays: Number(event.target.value) })
                        }
                        className="settings-select"
                      >
                        {WATCHDOG_MIN_AGE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="settings-item">
                    <div className="settings-inline-group">
                      <span className="settings-label">监视范围</span>
                      <span className="settings-hint">
                        {watchStatus.targets.length === 0
                          ? "没有可监视的目标"
                          : "默认只盯系统卷；加一个自定义目录就只盯那些目录"}
                      </span>
                    </div>
                    {watchStatus.targets.map((target, index) => (
                      <div key={target} className="settings-inline-group">
                        <span className="settings-hint">{target}</span>
                        <button
                          type="button"
                          className="settings-toggle-btn"
                          disabled={watchBusy}
                          title="不再监视这个目录"
                          aria-label={`不再监视 ${target}`}
                          onClick={() => void removeWatchTarget(index)}
                        >
                          <Icon name="X" size={14} />
                        </button>
                      </div>
                    ))}
                    <div className="settings-inline-group">
                      <button
                        type="button"
                        className="settings-save-btn"
                        disabled={watchBusy}
                        onClick={() => void addWatchTarget()}
                      >
                        添加监视目录…
                      </button>
                      <button
                        type="button"
                        className="settings-save-btn"
                        disabled={watchBusy}
                        onClick={() => void runWatchNow()}
                      >
                        立即检查
                      </button>
                    </div>
                    {watchNotice && (
                      <span className="settings-hint">{watchNotice}</span>
                    )}
                    {watchError && (
                      <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                        {watchError}
                      </span>
                    )}
                    {watchStatus.alerts.length > 0 && (
                      <span className="settings-hint" style={{ color: "var(--color-warning-fg)" }}>
                        当前有 {watchStatus.alerts.length} 条失控告警，可在清理面板查看
                      </span>
                    )}

                  </div>
                </>
              )}

              {/* ── 审计日志（§12.3：清空动作必须在设置页可见）────── */}
              <h3 className="settings-subsection-title">审计日志</h3>
              <p className="settings-panel-desc">
                {'每次清理都会记录"删了什么、跳过了什么、为什么"。记录的是文件路径全文，'}
                <b>只存在本机</b>
                {"，不会上报、不随更新检查或崩溃报告带出去。" +
                  "默认保留 90 天或最近 100 次，到期自动删除。"}
              </p>
              <div className="settings-item">
                <div className="settings-inline-group">
                  <button
                    type="button"
                    className="settings-save-btn"
                    disabled={!settingsAuditConfirm}
                    onClick={() => void clearAuditLogs()}
                  >
                    {settingsAuditConfirm ? "确认清空？" : "清空审计日志"}
                  </button>
                  {!settingsAuditConfirm && (
                    <button
                      type="button"
                      className="settings-save-btn"
                      onClick={() => setSettingsAuditConfirm(true)}
                    >
                      我要清空…
                    </button>
                  )}
                  {settingsAuditMessage && (
                    <span className="settings-hint">{settingsAuditMessage}</span>
                  )}
                </div>
              </div>
            </>
          )}

          {/* ── 系统监控 ──────────────────────────────────── */}
          {activeTab === "monitor" && (
            <>
              <h2 className="settings-panel-title">系统监控</h2>
              <p className="settings-panel-desc">
                配置监控悬浮窗的数据刷新频率、显示模式与显示样式（四套样式也可以在浮窗标题栏上一键轮换）。
              </p>
              <div className="settings-item">
                <label
                  className={`settings-checkbox-label${systemMonitorEnabled ? "" : " is-disabled"}`}
                >
                  <input
                    type="checkbox"
                    checked={autostartIds.includes("system-monitor")}
                    disabled={!autostartLoaded || !systemMonitorEnabled}
                    onChange={() => handleToggleToolAutostart("system-monitor")}
                  />
                  <span>启动时自动打开</span>
                </label>
                {!autostartLoaded && <span className="settings-hint">正在读取配置…</span>}
                {autostartLoaded && !systemMonitorEnabled && (
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
              {/* 显示样式：只在标准模式下生效（mini 是固定形态）。也可以直接点浮窗标题栏的
                  样式按钮轮换，两条路径写的是同一份配置、都会广播。 */}
              <div className="settings-item settings-row">
                <div className="settings-inline-group">
                  <label className="settings-label" htmlFor="settings-monitor-layout">
                    显示样式
                  </label>
                  <select
                    id="settings-monitor-layout"
                    value={systemMonitorConfig.layout}
                    disabled={systemMonitorConfig.displayMode === "mini"}
                    onChange={(e) =>
                      updateSystemMonitorConfig({ layout: e.target.value as SystemMonitorLayout })
                    }
                    className="settings-select"
                  >
                    {MONITOR_LAYOUT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <span className="settings-hint">
                  {systemMonitorConfig.displayMode === "mini"
                    ? "迷你模式形态固定，切回标准后生效"
                    : MONITOR_LAYOUT_OPTIONS.find(
                        (option) => option.value === systemMonitorConfig.layout,
                      )?.hint}
                </span>
              </div>
              {systemMonitorStatus === "saved" && <p className="settings-hint">已保存</p>}
              {systemMonitorStatus === "error" && (
                <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                  保存失败，请重试
                </p>
              )}
            </>
          )}

          {/* ── 时间工具（时钟 / 倒计时 / 番茄钟 / 秒表 / 日历） ──── */}
          {activeTab === "timer" && (
            <>
              <h2 className="settings-panel-title">时间工具</h2>
              <p className="settings-panel-desc">管理时钟、倒计时、番茄钟、秒表和日历悬浮工具。</p>
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
                    disabled={!autostartLoaded || !timerEnabled}
                    onChange={() => handleToggleToolAutostart("timer")}
                  />
                  <span>启动时自动打开</span>
                </label>
                {!autostartLoaded && <span className="settings-hint">正在读取配置…</span>}
                {autostartLoaded && !timerEnabled && (
                  <span className="settings-hint">请先在悬浮球面板中启用时间工具</span>
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

              <h3 className="settings-subsection-title">番茄钟</h3>
              <p className="settings-panel-desc">
                番茄钟是时间工具里的一个页签，计时在后端持续运行，隐藏窗口不会中断专注。
              </p>
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

          {activeTab === "todo" && (
            <>
              <h2 className="settings-panel-title">待办清单</h2>
              <p className="settings-panel-desc">管理待办悬浮窗和任务提醒。</p>
              <div className="settings-item">
                <label className={`settings-checkbox-label${todoEnabled ? "" : " is-disabled"}`}>
                  <input
                    type="checkbox"
                    checked={autostartIds.includes("todo")}
                    disabled={!autostartLoaded || !todoEnabled}
                    onChange={() => handleToggleToolAutostart("todo")}
                  />
                  <span>启动时自动打开</span>
                </label>
                {!autostartLoaded && <span className="settings-hint">正在读取配置…</span>}
                {autostartLoaded && !todoEnabled && (
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
              <p className="settings-hint">选中文字后显示的功能按钮，可拖拽调整顺序</p>
              <div className="toolbar-order-list" role="list" aria-label="文字工具栏按钮顺序">
                {featureOrder.map((id, index) => {
                  const feature = TOOLBAR_FEATURES.find((f) => f.id === id);
                  if (!feature) return null;
                  const enabled = enabledFeatures.includes(feature.id);
                  return (
                    <div
                      key={feature.id}
                      role="listitem"
                      className={`toolbar-order-row${featureDragIndex === index ? " is-dragging" : ""}`}
                      draggable
                      onDragStart={(e) => onFeatureDragStart(e, index)}
                      onDragOver={(e) => onFeatureDragOver(e, index)}
                      onDrop={onFeatureDrop}
                      onDragEnd={onFeatureDragEnd}
                    >
                      <span className="toolbar-order-grip" aria-hidden="true">
                        <Icon name="GripVertical" size={14} />
                      </span>
                      <Icon
                        name={feature.icon}
                        size={16}
                        className="toolbar-order-feature-icon"
                        aria-hidden="true"
                      />
                      <span className="toolbar-order-label">{feature.label}</span>
                      <button
                        type="button"
                        role="switch"
                        draggable={false}
                        aria-checked={enabled}
                        aria-label={`${enabled ? "禁用" : "启用"}${feature.label}`}
                        className={`toolbar-feature-switch${enabled ? " is-on" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleFeature(feature.id);
                        }}
                      >
                        <span className="toolbar-feature-switch-thumb" />
                      </button>
                    </div>
                  );
                })}
              </div>
              {featureOrderStatus === "saved" && <p className="settings-hint">顺序已保存</p>}
              {featureOrderStatus === "error" && (
                <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>
                  顺序保存失败，请重试
                </p>
              )}
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
