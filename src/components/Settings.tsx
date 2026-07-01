import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import Icon from "./Icon";
import { AiConfig } from "../types";
import { TOOLBAR_FEATURES, getEnabledFeatures, setEnabledFeatures } from "../constants/toolbarFeatures";
import {
  getDedupMode,
  setDedupMode,
  DEDUP_GRANULARITY_OPTIONS,
  DEDUP_CHAR_SUBMODE_OPTIONS,
  type DedupMode,
  type DedupGranularity,
  type CharSubMode,
} from "../constants/dedupConfig";
import "./Settings.css";

function Settings() {
  const [autoStart, setAutoStart] = useState(false);
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

  // 工具栏功能配置
  const [enabledFeatures, setEnabledFeaturesState] = useState<string[]>(getEnabledFeatures);

  // 去重粒度配置
  const [dedupMode, setDedupModeState] = useState<DedupMode>(getDedupMode);

  const handleChangeDedupMode = (next: DedupMode) => {
    setDedupModeState(next);
    setDedupMode(next);
    // 广播去重配置变更事件，通知工具栏窗口同步
    emit("floast-dedup-mode-changed", next);
  };

  const handleToggleFeature = (id: string) => {
    setEnabledFeaturesState((prev) => {
      const next = prev.includes(id)
        ? prev.filter((f) => f !== id)
        : [...prev, id];
      setEnabledFeatures(next);
      // 广播功能配置变更事件，通知其他窗口同步
      emit("floast-features-changed", next);
      return next;
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
                invoke("set_auto_start", { enable: enabled }).catch((err) => {
                  console.error("Failed to set auto start:", err);
                  setAutoStart(!enabled); // 回滚 UI 状态
                });
              }}
            />
            <span>开机自启动</span>
          </label>

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
