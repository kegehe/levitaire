import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import Icon from "./Icon";
import { AiConfig } from "../types";
import { TOOLBAR_FEATURES, DEFAULT_FEATURE_IDS, fetchEnabledFeatures, saveEnabledFeatures } from "../constants/toolbarFeatures";
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
  DEFAULT_STT_CONFIG,
  fetchSttConfig,
  saveSttConfig,
  fetchSttApiKey,
  saveSttApiKey,
  type SttConfig,
} from "../constants/sttConfig";
import {
  DEFAULT_SYSTEM_MONITOR_CONFIG,
  MONITOR_INTERVAL_OPTIONS,
  fetchSystemMonitorConfig,
  saveSystemMonitorConfig,
  type SystemMonitorConfig,
  type SystemMonitorDisplayMode,
} from "../constants/systemMonitorConfig";
import "./Settings.css";

function Settings() {
  const [autoStart, setAutoStart] = useState(false);
  const [autoStartError, setAutoStartError] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    return (localStorage.getItem("floast-theme") as "light" | "dark") || "light";
  });

  // AI 配置
  const [aiConfig, setAiConfig] = useState<AiConfig>({
    api_key: "",
    base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-20250514",
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
  const [numberingStyle, setNumberingStyleState] = useState<NumberingStyle>(DEFAULT_NUMBERING_STYLE);
  const [numberingStatus, setNumberingStatus] = useState<"idle" | "saved" | "error">("idle");

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

  // 语音输入快捷键 + 配置
  const [sttHotkey, setSttHotkey] = useState("");
  const [sttHotkeyRecording, setSttHotkeyRecording] = useState(false);
  const [sttHotkeyStatus, setSttHotkeyStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [sttHotkeyError, setSttHotkeyError] = useState("");
  const [sttConfig, setSttConfigState] = useState<SttConfig>(DEFAULT_STT_CONFIG);
  const [sttApiKey, setSttApiKey] = useState("");
  const [systemMonitorConfig, setSystemMonitorConfig] = useState<SystemMonitorConfig>(
    DEFAULT_SYSTEM_MONITOR_CONFIG,
  );
  const [systemMonitorStatus, setSystemMonitorStatus] = useState<"idle" | "saved" | "error">("idle");
  const systemMonitorConfigRef = useRef<SystemMonitorConfig>(DEFAULT_SYSTEM_MONITOR_CONFIG);
  const systemMonitorSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const systemMonitorSaveVersionRef = useRef(0);

  // 录屏快捷键
  const [recordingHotkey, setRecordingHotkey] = useState("");
  const [recordingHotkeyRecording, setRecordingHotkeyRecording] = useState(false);
  const [recordingHotkeyStatus, setRecordingHotkeyStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [recordingHotkeyError, setRecordingHotkeyError] = useState("");

  // 录屏保存路径
  const [recordingSavePath, setRecordingSavePath] = useState("");
  const [recordingSavePathStatus, setRecordingSavePathStatus] = useState<"idle" | "saved" | "error">("idle");

  // 截图保存路径
  const [screenshotSavePath, setScreenshotSavePath] = useState("");
  const [screenshotSavePathStatus, setScreenshotSavePathStatus] = useState<"idle" | "saved" | "error">("idle");

  // STT 文本输入防抖：避免每次按键都触发后端加密+写盘（apiKey 每键 DPAPI 加密）
  const sttConfigDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sttApiKeyDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        // 保存失败：回滚 UI 到改前状态，与快捷键回滚策略一致
        setDedupModeState(previous);
        // 补发回滚事件，让下游工具栏窗口同步回旧值
        emit("floast-dedup-mode-changed", previous);
      });
    // 广播去重配置变更事件，通知工具栏窗口同步
    emit("floast-dedup-mode-changed", next);
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
        // 保存失败：回滚 UI 到改前状态
        setMd5LengthState(previous);
        // 补发回滚事件，让下游工具栏窗口同步回旧值
        emit("floast-md5-length-changed", previous);
      });
    // 广播 MD5 位数变更事件，通知工具栏窗口同步
    emit("floast-md5-length-changed", next);
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
        // 保存失败：回滚 UI 到改前状态
        setNumberingStyleState(previous);
        // 补发回滚事件，让下游工具栏窗口同步回旧值
        emit("floast-numbering-style-changed", previous);
      });
    // 广播编号样式变更事件，通知工具栏窗口同步
    emit("floast-numbering-style-changed", next);
  };

  // 朗读配置变更（partial 更新：rate/voiceId/volume 任一）
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
        // 保存失败：回滚 UI 到改前状态
        setTtsConfigState(previous);
        // 补发回滚事件，让下游工具栏窗口同步回旧值
        emit("floast-tts-config-changed", previous);
      });
    // 广播朗读配置变更事件，通知工具栏窗口同步
    emit("floast-tts-config-changed", next);
  };

  const handleToggleFeature = (id: string) => {
    // 直接读当前 state 派生 next，不在 updater 内做副作用（emit/save），
    // 避免 StrictMode 双调用 updater 导致副作用重复执行与闭包 prev 错乱。
    const previous = enabledFeatures;
    const next = previous.includes(id)
      ? previous.filter((f) => f !== id)
      : [...previous, id];
    setEnabledFeaturesState(next);
    // 广播功能配置变更事件，通知其他窗口同步
    emit("floast-features-changed", next);
    saveEnabledFeatures(next)
      .then(() => {
        setFeaturesStatus("saved");
        setTimeout(() => setFeaturesStatus("idle"), 1500);
      })
      .catch((err) => {
        console.error("Failed to save toolbar features:", err);
        setFeaturesStatus("error");
        setTimeout(() => setFeaturesStatus("idle"), 3000);
        // 保存失败：回滚 UI 到改前快照（previous 是事件处理函数作用域常量，确定可靠）
        setEnabledFeaturesState(previous);
        // 补发回滚事件，让下游工具栏窗口同步回旧值
        emit("floast-features-changed", previous);
      });
  };

  const handleToggleClearOption = (id: string) => {
    // 直接读当前 state 派生 next，不在 updater 内做副作用（emit/save），
    // 避免 StrictMode 双调用 updater 导致副作用重复执行与闭包 prev 错乱。
    const previous = enabledClearIds;
    const next = previous.includes(id)
      ? previous.filter((f) => f !== id)
      : [...previous, id];
    setEnabledClearIdsState(next);
    // 广播清除项配置变更事件，通知工具栏窗口同步
    emit("floast-clear-options-changed", next);
    saveClearOptions(next)
      .then(() => {
        setClearStatus("saved");
        setTimeout(() => setClearStatus("idle"), 1500);
      })
      .catch((err) => {
        console.error("Failed to save clear options:", err);
        setClearStatus("error");
        setTimeout(() => setClearStatus("idle"), 3000);
        // 保存失败：回滚 UI 到改前快照
        setEnabledClearIdsState(previous);
        // 补发回滚事件，让工具栏窗口同步回旧值
        emit("floast-clear-options-changed", previous);
      });
  };

  const updateSystemMonitorConfig = (partial: Partial<SystemMonitorConfig>) => {
    const previous = systemMonitorConfigRef.current;
    const next = { ...previous, ...partial };
    const version = ++systemMonitorSaveVersionRef.current;
    systemMonitorConfigRef.current = next;
    setSystemMonitorConfig(next);
    emit("floast-system-monitor-config-changed", next);

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
        emit("floast-system-monitor-config-changed", previous);
        setSystemMonitorStatus("error");
        setTimeout(() => setSystemMonitorStatus("idle"), 3000);
      });
  };

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("floast-theme", theme);
    // 广播主题变更事件，通知其他窗口同步
    emit("floast-theme-changed", theme);
  }, [theme]);

  // 设置窗口：允许内容滚动
  useEffect(() => {
    document.body.classList.add("settings-window");
    return () => { document.body.classList.remove("settings-window"); };
  }, []);

  // 加载自启动状态
  useEffect(() => {
    invoke<boolean>("get_auto_start")
      .then((enabled) => setAutoStart(enabled))
      .catch((err) => console.error("Failed to get auto start status:", err));
  }, []);

  // 加载 AI 配置
  useEffect(() => {
    invoke<AiConfig>("get_ai_config")
      .then((config) => setAiConfig(config))
      .catch((err) => console.error("Failed to load AI config:", err));
  }, []);

  // 加载截图快捷键配置
  useEffect(() => {
    invoke<string>("get_screenshot_hotkey")
      .then((hk) => setScreenshotHotkey(hk))
      .catch((err) => console.error("Failed to load screenshot hotkey:", err));
  }, []);

  // 并行加载所有配置（减少串行 IPC 往返延迟）
  useEffect(() => {
    Promise.allSettled([
      fetchEnabledFeatures(),
      fetchDedupMode(),
      fetchMd5Length(),
      fetchNumberingStyle(),
      fetchClearOptions(),
      fetchTtsConfig(),
      invoke<VoiceInfo[]>("tts_get_voices"),
      invoke<string>("get_stt_hotkey"),
      fetchSttConfig(),
      fetchSttApiKey(),
      fetchSystemMonitorConfig(),
      invoke<string>("get_recording_hotkey"),
      invoke<string>("get_recording_save_path"),
      invoke<string>("get_screenshot_save_path"),
    ]).then(([features, dedup, md5, numbering, clear, tts, voices, sttHk, sttCfg, sttKey, sysMon, recHk, recSavePath, ssSavePath]) => {
      if (features.status === "fulfilled") setEnabledFeaturesState(features.value);
      if (dedup.status === "fulfilled") setDedupModeState(dedup.value);
      if (md5.status === "fulfilled") setMd5LengthState(md5.value);
      if (numbering.status === "fulfilled") setNumberingStyleState(numbering.value);
      if (clear.status === "fulfilled") setEnabledClearIdsState(clear.value);
      if (tts.status === "fulfilled") setTtsConfigState(tts.value);
      if (voices.status === "fulfilled") setTtsVoices(voices.value);
      if (sttHk.status === "fulfilled") setSttHotkey(sttHk.value);
      if (sttCfg.status === "fulfilled") setSttConfigState(sttCfg.value);
      if (sttKey.status === "fulfilled") setSttApiKey(sttKey.value);
      if (sysMon.status === "fulfilled") {
        if (systemMonitorSaveVersionRef.current === 0) {
          systemMonitorConfigRef.current = sysMon.value;
          setSystemMonitorConfig(sysMon.value);
        }
      }
      if (recHk.status === "fulfilled") setRecordingHotkey(recHk.value);
      if (recSavePath.status === "fulfilled") setRecordingSavePath(recSavePath.value);
      if (ssSavePath.status === "fulfilled") setScreenshotSavePath(ssSavePath.value);
    });
  }, []);

  // 快捷键录入：聚焦时捕获按键组合
  const handleHotkeyKeyDown = (e: React.KeyboardEvent) => {
    if (!hotkeyRecording) return;
    e.preventDefault();
    // 单独的修饰键按下不生成快捷键
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Win");
    // 忽略纯修饰键
    const isModifierKey = ["Control", "Alt", "Shift", "Meta"].includes(e.key);
    if (isModifierKey) return;
    // Esc 取消录入
    if (e.key === "Escape") {
      setHotkeyRecording(false);
      return;
    }
    // 规范化主键名
    const isFKey = e.key.startsWith("F") && /^F([1-9]|1[0-2])$/.test(e.key);
    // F1-F12 单键允许无修饰键；其余主键必须搭配修饰键
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
      // 注册失败（冲突等）：后端配置未改，回滚 UI 到旧值，避免显示与实际不符
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

  // 语音输入快捷键录入：聚焦时捕获按键组合
  const handleSttHotkeyKeyDown = (e: React.KeyboardEvent) => {
    if (!sttHotkeyRecording) return;
    e.preventDefault();
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Win");
    const isModifierKey = ["Control", "Alt", "Shift", "Meta"].includes(e.key);
    if (isModifierKey) return;
    if (e.key === "Escape") {
      setSttHotkeyRecording(false);
      return;
    }
    const isFKey = e.key.startsWith("F") && /^F([1-9]|1[0-2])$/.test(e.key);
    if (mods.length === 0 && !isFKey) {
      setSttHotkeyError("快捷键需包含修饰键（Ctrl/Alt/Shift/Win），或使用 F1-F12 单键");
      return;
    }
    let mainKey: string;
    if (isFKey) {
      mainKey = e.key;
    } else if (e.key.length === 1) {
      mainKey = e.key.toUpperCase();
    } else {
      setSttHotkeyError("不支持的按键");
      return;
    }
    const combo = [...mods, mainKey].join("+");
    setSttHotkeyError("");
    setSttHotkeyRecording(false);
    saveSttHotkey(combo);
  };

  const saveSttHotkey = async (combo: string) => {
    const previous = sttHotkey;
    setSttHotkey(combo);
    setSttHotkeyStatus("saving");
    try {
      await invoke("set_stt_hotkey", { hotkey: combo });
      setSttHotkeyStatus("saved");
      setSttHotkeyError("");
      setTimeout(() => setSttHotkeyStatus("idle"), 2000);
    } catch (err) {
      setSttHotkey(previous);
      setSttHotkeyStatus("error");
      setSttHotkeyError(String(err));
      setTimeout(() => setSttHotkeyStatus("idle"), 3000);
    }
  };

  const clearSttHotkey = async () => {
    setSttHotkeyStatus("saving");
    try {
      await invoke("set_stt_hotkey", { hotkey: "" });
      setSttHotkey("");
      setSttHotkeyStatus("idle");
      setSttHotkeyError("");
    } catch (err) {
      setSttHotkeyStatus("error");
      setSttHotkeyError(String(err));
      setTimeout(() => setSttHotkeyStatus("idle"), 3000);
    }
  };

  // 录屏快捷键录入：聚焦时捕获按键组合
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

  // 录屏保存路径：选择文件夹
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

  // 录屏保存路径：清除
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

  // 截图保存路径：选择文件夹
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

  // 截图保存路径：清除
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

  const updateSttConfig = (partial: Partial<SttConfig>) => {
    const previous = sttConfig;
    const next = { ...sttConfig, ...partial };
    setSttConfigState(next);
    // 防抖保存：连续输入只保留最后一次，避免每键一次加密+写盘
    if (sttConfigDebounceRef.current) clearTimeout(sttConfigDebounceRef.current);
    sttConfigDebounceRef.current = setTimeout(() => {
      saveSttConfig(next).catch((err) => {
        console.error("Failed to save stt config:", err);
        setSttConfigState(previous);
      });
    }, 400);
  };

  const updateSttApiKey = (key: string) => {
    const previous = sttApiKey;
    setSttApiKey(key);
    // 防抖保存：API Key 每键加密代价高，连续输入只保留最后一次写盘
    if (sttApiKeyDebounceRef.current) clearTimeout(sttApiKeyDebounceRef.current);
    sttApiKeyDebounceRef.current = setTimeout(() => {
      saveSttApiKey(key).catch((err) => {
        console.error("Failed to save stt api key:", err);
        setSttApiKey(previous);
      });
    }, 400);
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
    <div className="settings-container">
      <h1 className="settings-title">Floast Service 设置</h1>

      <fieldset className="settings-section">
        <legend className="settings-section-heading">通用设置</legend>

        <div className="settings-item settings-row">
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
                  setAutoStart(!enabled); // 回滚 UI 状态
                  setAutoStartError(true);
                });
              }}
            />
            <span>开机自启动</span>
          </label>
          {autoStartError && <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>设置失败</span>}

          <div className="settings-inline-group">
            <label className="settings-label" htmlFor="settings-theme">主题</label>
            <select
              id="settings-theme"
              value={theme}
              onChange={(e) => setTheme(e.target.value as "light" | "dark")}
              className="settings-select"
            >
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </div>
        </div>
      </fieldset>

      <fieldset className="settings-section">
        <legend className="settings-section-heading">截图</legend>
        <p className="settings-hint">全局快捷键触发截图（仅截图工具启用时生效）</p>
        <div className="settings-item settings-row">
          <div className="settings-inline-group">
            <label className="settings-label" htmlFor="settings-hotkey">截图快捷键</label>
            <input
              id="settings-hotkey"
              type="text"
              value={hotkeyRecording ? "按下组合键…" : screenshotHotkey}
              readOnly
              placeholder="点击设置快捷键"
              onFocus={() => { setHotkeyRecording(true); setHotkeyError(""); }}
              onBlur={() => setHotkeyRecording(false)}
              onKeyDown={handleHotkeyKeyDown}
              className="settings-input"
              style={{ width: 180 }}
            />
            {screenshotHotkey && (
              <button className="settings-toggle-btn" onClick={clearHotkey} title="清除快捷键" aria-label="清除快捷键">
                <Icon name="X" size={16} />
              </button>
            )}
          </div>
          {hotkeyStatus === "saving" && <span className="settings-hint">保存中…</span>}
          {hotkeyStatus === "saved" && <span className="settings-hint">已保存</span>}
          {hotkeyStatus === "error" && <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>保存失败</span>}
        </div>
        {hotkeyError && (
          <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>{hotkeyError}</p>
        )}
        <div className="settings-item">
          <label className="settings-label">保存路径</label>
          <p className="settings-hint">设置后截图自动保存到该目录（无需每次选择），未设置则弹出对话框</p>
          <div className="settings-inline-group">
            <input
              type="text"
              value={screenshotSavePath}
              readOnly
              placeholder="未设置，保存时将弹出对话框"
              className="settings-input"
              style={{ flex: 1 }}
            />
            <button className="settings-toggle-btn" onClick={pickScreenshotSavePath} title="选择文件夹" aria-label="选择文件夹">
              <Icon name="FolderOpen" size={16} />
            </button>
            {screenshotSavePath && (
              <button className="settings-toggle-btn" onClick={clearScreenshotSavePath} title="清除路径" aria-label="清除路径">
                <Icon name="X" size={16} />
              </button>
            )}
          </div>
          {screenshotSavePathStatus === "saved" && <span className="settings-hint">已保存</span>}
          {screenshotSavePathStatus === "error" && <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>保存失败</span>}
        </div>
      </fieldset>

      <fieldset className="settings-section">
        <legend className="settings-section-heading">录屏</legend>
        <p className="settings-hint">全局快捷键触发 GIF/视频录制（仅录屏工具启用时生效）</p>
        <div className="settings-item settings-row">
          <div className="settings-inline-group">
            <label className="settings-label" htmlFor="settings-recording-hotkey">录屏快捷键</label>
            <input
              id="settings-recording-hotkey"
              type="text"
              value={recordingHotkeyRecording ? "按下组合键…" : recordingHotkey}
              readOnly
              placeholder="点击设置快捷键"
              onFocus={() => { setRecordingHotkeyRecording(true); setRecordingHotkeyError(""); }}
              onBlur={() => setRecordingHotkeyRecording(false)}
              onKeyDown={handleRecordingHotkeyKeyDown}
              className="settings-input"
              style={{ width: 180 }}
            />
            {recordingHotkey && (
              <button className="settings-toggle-btn" onClick={clearRecordingHotkey} title="清除快捷键" aria-label="清除快捷键">
                <Icon name="X" size={16} />
              </button>
            )}
          </div>
          {recordingHotkeyStatus === "saving" && <span className="settings-hint">保存中…</span>}
          {recordingHotkeyStatus === "saved" && <span className="settings-hint">已保存</span>}
          {recordingHotkeyStatus === "error" && <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>保存失败</span>}
        </div>
        {recordingHotkeyError && (
          <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>{recordingHotkeyError}</p>
        )}
        <div className="settings-item">
          <label className="settings-label">保存路径</label>
          <p className="settings-hint">设置后录屏自动保存到该目录（无需每次选择），未设置则弹出对话框</p>
          <div className="settings-inline-group">
            <input
              type="text"
              value={recordingSavePath}
              readOnly
              placeholder="未设置，保存时将弹出对话框"
              className="settings-input"
              style={{ flex: 1 }}
            />
            <button className="settings-toggle-btn" onClick={pickRecordingSavePath} title="选择文件夹" aria-label="选择文件夹">
              <Icon name="FolderOpen" size={16} />
            </button>
            {recordingSavePath && (
              <button className="settings-toggle-btn" onClick={clearRecordingSavePath} title="清除路径" aria-label="清除路径">
                <Icon name="X" size={16} />
              </button>
            )}
          </div>
          {recordingSavePathStatus === "saved" && <span className="settings-hint">已保存</span>}
          {recordingSavePathStatus === "error" && <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>保存失败</span>}
        </div>
      </fieldset>

      <fieldset className="settings-section">
        <legend className="settings-section-heading">语音输入</legend>
        <p className="settings-hint">云端识别（OpenAI 兼容接口），仅中文。需配置 API Key，可填官方或兼容第三方（Groq 等）。</p>
        <div className="settings-item settings-row">
          <div className="settings-inline-group">
            <label className="settings-label" htmlFor="settings-stt-hotkey">语音快捷键</label>
            <input
              id="settings-stt-hotkey"
              type="text"
              value={sttHotkeyRecording ? "按下组合键…" : sttHotkey}
              readOnly
              placeholder="点击设置快捷键"
              onFocus={() => { setSttHotkeyRecording(true); setSttHotkeyError(""); }}
              onBlur={() => setSttHotkeyRecording(false)}
              onKeyDown={handleSttHotkeyKeyDown}
              className="settings-input"
              style={{ width: 180 }}
            />
            {sttHotkey && (
              <button className="settings-toggle-btn" onClick={clearSttHotkey} title="清除快捷键" aria-label="清除快捷键">
                <Icon name="X" size={16} />
              </button>
            )}
          </div>
          {sttHotkeyStatus === "saving" && <span className="settings-hint">保存中…</span>}
          {sttHotkeyStatus === "saved" && <span className="settings-hint">已保存</span>}
          {sttHotkeyStatus === "error" && <span className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>保存失败</span>}
        </div>
        {sttHotkeyError && (
          <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>{sttHotkeyError}</p>
        )}
        <div className="settings-item">
          <label className="settings-label" htmlFor="settings-stt-apikey">API Key</label>
          <input
            id="settings-stt-apikey"
            type="password"
            value={sttApiKey}
            onChange={(e) => updateSttApiKey(e.target.value)}
            placeholder="sk-..."
            className="settings-input"
            autoComplete="off"
          />
        </div>
        <div className="settings-item settings-row">
          <div className="settings-inline-group">
            <label className="settings-label" htmlFor="settings-stt-baseurl">Base URL</label>
            <input
              id="settings-stt-baseurl"
              type="text"
              value={sttConfig.baseUrl}
              onChange={(e) => updateSttConfig({ baseUrl: e.target.value })}
              placeholder="https://api.openai.com"
              className="settings-input"
              style={{ width: 260 }}
            />
          </div>
          <div className="settings-inline-group">
            <label className="settings-label" htmlFor="settings-stt-model">模型</label>
            <input
              id="settings-stt-model"
              type="text"
              value={sttConfig.model}
              onChange={(e) => updateSttConfig({ model: e.target.value })}
              placeholder="whisper-1"
              className="settings-input"
              style={{ width: 140 }}
            />
          </div>
        </div>
        <div className="settings-item">
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              checked={sttConfig.autoPaste}
              onChange={(e) => updateSttConfig({ autoPaste: e.target.checked })}
            />
            <span>识别后自动粘贴到当前窗口</span>
          </label>
        </div>
      </fieldset>

      <fieldset className="settings-section">
        <legend className="settings-section-heading">系统监控</legend>
        <p className="settings-hint">配置监控悬浮窗的数据刷新频率和显示密度。</p>
        <div className="settings-item settings-row">
          <div className="settings-inline-group">
            <label className="settings-label" htmlFor="settings-monitor-interval">刷新间隔</label>
            <select
              id="settings-monitor-interval"
              value={systemMonitorConfig.intervalMs}
              onChange={(e) => updateSystemMonitorConfig({ intervalMs: Number(e.target.value) })}
              className="settings-select"
            >
              {MONITOR_INTERVAL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div className="settings-inline-group">
            <label className="settings-label" htmlFor="settings-monitor-display-mode">显示模式</label>
            <select
              id="settings-monitor-display-mode"
              value={systemMonitorConfig.displayMode}
              onChange={(e) => updateSystemMonitorConfig({
                displayMode: e.target.value as SystemMonitorDisplayMode,
              })}
              className="settings-select"
            >
              <option value="full">标准</option>
              <option value="mini">迷你</option>
            </select>
          </div>
        </div>
        {systemMonitorStatus === "saved" && <p className="settings-hint">已保存</p>}
        {systemMonitorStatus === "error" && (
          <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>保存失败，请重试</p>
        )}
      </fieldset>

      <fieldset className="settings-section">
        <legend className="settings-section-heading">悬浮工具栏</legend>
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
        {featuresStatus === "error" && <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>保存失败，请重试</p>}

        <div className="settings-item settings-row">
          <div className="settings-inline-group">
            <label className="settings-label" htmlFor="settings-dedup-granularity">去重粒度</label>
            <select
              id="settings-dedup-granularity"
              value={dedupMode.granularity}
              onChange={(e) => handleChangeDedupMode({
                ...dedupMode,
                granularity: e.target.value as DedupGranularity,
              })}
              className="settings-select"
            >
              {DEDUP_GRANULARITY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          {dedupMode.granularity === "char" && (
            <div className="settings-inline-group">
              <label className="settings-label" htmlFor="settings-dedup-char-submode">字符去重方式</label>
              <select
                id="settings-dedup-char-submode"
                value={dedupMode.charSubMode}
                onChange={(e) => handleChangeDedupMode({
                  ...dedupMode,
                  charSubMode: e.target.value as CharSubMode,
                })}
                className="settings-select"
              >
                {DEDUP_CHAR_SUBMODE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        {dedupStatus === "saved" && <p className="settings-hint">已保存</p>}
        {dedupStatus === "error" && <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>保存失败，请重试</p>}

        <div className="settings-item settings-row">
          <div className="settings-inline-group">
            <label className="settings-label" htmlFor="settings-md5-length">MD5 位数</label>
            <select
              id="settings-md5-length"
              value={md5Length}
              onChange={(e) => handleChangeMd5Length(e.target.value as Md5Length)}
              className="settings-select"
            >
              {MD5_LENGTH_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>
        {md5Status === "saved" && <p className="settings-hint">已保存</p>}
        {md5Status === "error" && <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>保存失败，请重试</p>}

        <div className="settings-item settings-row">
          <div className="settings-inline-group">
            <label className="settings-label" htmlFor="settings-numbering-style">编号样式</label>
            <select
              id="settings-numbering-style"
              value={numberingStyle}
              onChange={(e) => handleChangeNumberingStyle(e.target.value as NumberingStyle)}
              className="settings-select"
            >
              {NUMBERING_STYLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>
        {numberingStatus === "saved" && <p className="settings-hint">已保存</p>}
        {numberingStatus === "error" && <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>保存失败，请重试</p>}

        <div className="settings-item">
          <label className="settings-label">朗读</label>
          <p className="settings-hint">选中文本朗读的语速、语音与音量</p>
          <div className="settings-inline-group">
            <label className="settings-label" htmlFor="settings-tts-rate">语速</label>
            <select
              id="settings-tts-rate"
              value={ttsConfig.rate}
              onChange={(e) => handleChangeTtsConfig({ rate: e.target.value as TtsConfig["rate"] })}
              className="settings-select"
            >
              {TTS_RATE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="settings-inline-group">
            <label className="settings-label" htmlFor="settings-tts-voice">语音</label>
            <select
              id="settings-tts-voice"
              value={ttsConfig.voiceId}
              onChange={(e) => handleChangeTtsConfig({ voiceId: e.target.value })}
              className="settings-select"
            >
              <option value="">系统默认</option>
              {ttsVoices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.display_name}{v.language ? ` (${v.language})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="settings-inline-group">
            <label className="settings-label" htmlFor="settings-tts-volume">音量</label>
            <select
              id="settings-tts-volume"
              value={String(ttsConfig.volume)}
              onChange={(e) => handleChangeTtsConfig({ volume: parseFloat(e.target.value) })}
              className="settings-select"
            >
              {TTS_VOLUME_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>
        {ttsStatus === "saved" && <p className="settings-hint">已保存</p>}
        {ttsStatus === "error" && <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>保存失败，请重试</p>}

        <div className="settings-item">
          <label className="settings-label">清除项</label>
          <p className="settings-hint">「清除」按钮子菜单中显示的清除操作</p>
          <div className="settings-features-grid">
            {CLEAR_OPTIONS.map((option) => (
              <label key={option.id} className="settings-feature-chip">
                <input
                  type="checkbox"
                  checked={enabledClearIds.includes(option.id)}
                  onChange={() => handleToggleClearOption(option.id)}
                />
                <Icon name="RemoveFormatting" size={14} />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>
        {clearStatus === "saved" && <p className="settings-hint">已保存</p>}
        {clearStatus === "error" && <p className="settings-hint" style={{ color: "var(--color-danger-fg)" }}>保存失败，请重试</p>}
      </fieldset>

      <fieldset className="settings-section">
        <legend className="settings-section-heading">AI 配置</legend>

        <div className="settings-item">
          <label className="settings-label" htmlFor="settings-api-type">API 类型</label>
          <select
            id="settings-api-type"
            value={aiConfig.api_type}
            onChange={(e) => {
              const newType = e.target.value;
              setAiConfig((prev) => {
                const updated = { ...prev, api_type: newType };
                // 切换类型时自动更新默认 base_url（仅当用户未修改过时）
                if (newType === "openai" && prev.base_url === "https://api.anthropic.com") {
                  updated.base_url = "https://api.openai.com";
                } else if (newType === "anthropic" && prev.base_url === "https://api.openai.com") {
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
          <label className="settings-label" htmlFor="settings-api-key">API Key</label>
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
          <label className="settings-label" htmlFor="settings-base-url">Base URL</label>
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
          <label className="settings-label" htmlFor="settings-model">Model</label>
          <input
            id="settings-model"
            type="text"
            value={aiConfig.model}
            onChange={(e) => setAiConfig({ ...aiConfig, model: e.target.value })}
            placeholder="claude-sonnet-4-20250514"
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
              <><Icon name="Loader2" size={14} className="settings-save-spinner" /> 保存中...</>
            )}
            {aiSaveStatus === "idle" && "保存"}
            {aiSaveStatus === "saved" && <><Icon name="Check" size={14} /> 已保存</>}
            {aiSaveStatus === "error" && <><Icon name="X" size={14} /> 保存失败</>}
          </button>
        </div>
      </fieldset>

    </div>
  );
}

export default Settings;
