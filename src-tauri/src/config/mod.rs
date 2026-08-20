use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::*;

/// AI 服务配置
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AiConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    /// API 类型："anthropic" 或 "openai"（兼容 OpenAI API 格式的第三方服务）
    #[serde(default = "default_api_type")]
    pub api_type: String,
}

fn default_api_type() -> String {
    "anthropic".to_string()
}

/// Appearance preferences shared by every webview window.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemePreferences {
    pub theme: String,
    pub accent: String,
    pub scheme: String,
}

fn default_theme() -> String {
    "light".to_string()
}

fn default_theme_accent() -> String {
    "blue".to_string()
}

fn default_theme_scheme() -> String {
    "cloud".to_string()
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            base_url: String::from("https://api.anthropic.com"),
            model: String::from("claude-sonnet-5"),
            api_type: default_api_type(),
        }
    }
}

/// 悬浮窗位置（物理像素坐标），用于位置记忆
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowPosition {
    pub x: i32,
    pub y: i32,
}

/// 应用全局配置（与 config.json 文件结构对应）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub ai: AiConfig,
    /// Stored outside webview localStorage so newly opened tool windows share the same appearance.
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_theme_accent")]
    pub theme_accent: String,
    #[serde(default = "default_theme_scheme")]
    pub theme_scheme: String,
    /// DPAPI 加密后的 API Key（十六进制编码），与 ai.api_key 互斥存储
    /// 加载时自动解密填入 ai.api_key；保存时自动加密填入此字段，清空 ai.api_key
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_encrypted: Option<String>,
    /// 截图全局快捷键，如 "Ctrl+Shift+A"；空串表示不启用
    #[serde(default)]
    pub screenshot_hotkey: String,
    /// 截图工具是否启用（仅启用时热键才触发）。默认 true（与 registry defaultEnabled 一致）
    #[serde(default = "default_screenshot_enabled")]
    pub screenshot_enabled: bool,
    /// 文字工具栏是否启用（关闭后选中文本不再弹出工具栏）。默认 true（与 registry defaultEnabled 一致）
    #[serde(default = "default_text_toolbar_enabled")]
    pub text_toolbar_enabled: bool,
    /// 悬浮工具栏启用的功能 ID 列表（如 ["copy","search",...]）。空表示使用默认全量
    #[serde(default)]
    pub toolbar_features: Vec<String>,
    /// 文字工具栏「搜索」使用的搜索引擎 ID（如 "bing"/"google"/"baidu"）。空串表示使用默认 Bing
    #[serde(default)]
    pub search_engine: String,
    /// 去重粒度配置（JSON 字符串，前端解析）。空串表示使用默认值
    #[serde(default)]
    pub dedup_mode: String,
    /// MD5 加密输出位数："32" 或 "16"。空串表示使用默认值 32
    #[serde(default)]
    pub md5_length: String,
    /// 文本编号样式（JSON 字符串，前端解析）：number-dot / letter-dot / paren / cn-ordinal。空串表示使用默认值
    #[serde(default)]
    pub numbering_style: String,
    /// 清除功能启用的清除项 ID 列表（如 ["clear-spaces","clear-newlines",...]）。
    /// 空列表表示使用默认全量（与 toolbar_features 一致）
    #[serde(default)]
    pub clear_options: Vec<String>,
    /// TTS 朗读配置（JSON 字符串，前端解析）：{rate,voiceId,volume}。空串表示使用默认值
    #[serde(default)]
    pub tts_config: String,
    /// 系统监控工具是否启用（仅启用时 palette 卡片可激活）。默认 false
    #[serde(default = "default_system_monitor_enabled")]
    pub system_monitor_enabled: bool,
    /// 系统监控采集间隔（毫秒），默认 1000。运行时可改，无需重启采集线程
    #[serde(default = "default_system_monitor_interval_ms")]
    pub system_monitor_interval_ms: u64,
    /// 系统监控配置（JSON 字符串，前端解析）：如 {"intervalMs":1000}。空串表示使用默认值
    #[serde(default)]
    pub system_monitor_config: String,
    /// 番茄钟工具是否启用（仅启用时 palette 卡片可激活）。默认 false
    #[serde(default = "default_pomodoro_enabled")]
    pub pomodoro_enabled: bool,
    /// 番茄钟配置（JSON 字符串，前端解析）：如 {"workMinutes":25,"roundsBeforeLongBreak":4}。
    /// 空串表示使用默认值
    #[serde(default)]
    pub pomodoro_config: String,
    /// 录屏工具是否启用（仅启用时热键才触发）。默认 false
    #[serde(default)]
    pub recording_enabled: bool,
    /// 录屏全局快捷键，如 "Ctrl+Shift+G"；空串表示不启用
    #[serde(default)]
    pub recording_hotkey: String,
    /// 录屏配置（JSON 字符串，前端解析）：如 {"fps":10,"maxDurationSec":30,"quality":"medium"}。
    /// 空串表示使用默认值
    #[serde(default)]
    pub recording_config: String,
    /// 录屏文件保存路径（目录）。空串表示未设置，每次保存时弹出对话框选择位置
    #[serde(default)]
    pub recording_save_path: String,
    /// 截图文件保存路径（目录）。空串表示未设置，每次保存时弹出对话框选择位置
    #[serde(default)]
    pub screenshot_save_path: String,
    /// OCR 识别引擎偏好："windows"（Windows.Media.Ocr）或 "paddle"（PaddleOCR-ONNX）。
    /// 空串表示未设置，启动时按默认策略自动选择（Windows 平台优先 Windows OCR）
    #[serde(default)]
    pub ocr_engine: String,
    /// 自启动工具 ID 列表（应用启动时自动打开窗口的工具，如 ["system-monitor"]）
    #[serde(default)]
    pub tools_autostart: Vec<String>,
    /// 悬浮窗位置记忆（窗口 id → 物理坐标），如 "orb"、"monitor-overlay"、"pomodoro-overlay"。
    /// 空 map 表示尚未记忆任何位置，各窗口回退到默认定位
    #[serde(default)]
    pub window_positions: HashMap<String, WindowPosition>,
    /// 快速输入转盘工具是否启用（仅启用时触发键才唤起转盘）。默认 false
    #[serde(default = "default_quick_input_enabled")]
    pub quick_input_enabled: bool,
    /// 快速输入转盘触发键名（如 "CapsLock"、"F8"）。空串表示默认 CapsLock
    #[serde(default = "default_quick_input_trigger_key")]
    pub quick_input_trigger_key: String,
    /// 快速输入转盘触发模式："click" = 单击切换（再点击触发键关闭，鼠标点击扇区选中）；
    /// "hold" = 按住唤起（松开触发键即按当前高亮扇区选中）。默认 click
    #[serde(default = "default_quick_input_mode")]
    pub quick_input_mode: String,
    /// 快速输入转盘预设提示词（JSON 字符串，前端解析）：[{"label":"","text":""}]。空串表示无预设
    #[serde(default)]
    pub quick_input_snippets: String,
}

fn default_quick_input_enabled() -> bool {
    false
}

fn default_quick_input_trigger_key() -> String {
    "CapsLock".to_string()
}

fn default_quick_input_mode() -> String {
    "click".to_string()
}

fn default_screenshot_enabled() -> bool {
    true
}

fn default_text_toolbar_enabled() -> bool {
    true
}

fn default_system_monitor_enabled() -> bool {
    false
}

fn default_system_monitor_interval_ms() -> u64 {
    1000
}

fn default_pomodoro_enabled() -> bool {
    false
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            ai: AiConfig::default(),
            theme: default_theme(),
            theme_accent: default_theme_accent(),
            theme_scheme: default_theme_scheme(),
            api_key_encrypted: None,
            screenshot_hotkey: String::new(),
            screenshot_enabled: default_screenshot_enabled(),
            text_toolbar_enabled: default_text_toolbar_enabled(),
            toolbar_features: Vec::new(),
            search_engine: String::new(),
            dedup_mode: String::new(),
            md5_length: String::new(),
            numbering_style: String::new(),
            clear_options: Vec::new(),
            tts_config: String::new(),
            system_monitor_enabled: default_system_monitor_enabled(),
            system_monitor_interval_ms: default_system_monitor_interval_ms(),
            system_monitor_config: String::new(),
            pomodoro_enabled: default_pomodoro_enabled(),
            pomodoro_config: String::new(),
            recording_enabled: false,
            recording_hotkey: String::new(),
            recording_config: String::new(),
            recording_save_path: String::new(),
            screenshot_save_path: String::new(),
            ocr_engine: String::new(),
            tools_autostart: Vec::new(),
            window_positions: HashMap::new(),
            quick_input_enabled: default_quick_input_enabled(),
            quick_input_trigger_key: default_quick_input_trigger_key(),
            quick_input_mode: default_quick_input_mode(),
            quick_input_snippets: String::new(),
        }
    }
}

/// 启动时一次性读取的配置快照（减少加锁次数）
pub struct StartupConfig {
    pub ai_config: AiConfig,
    pub screenshot_hotkey: String,
    pub screenshot_enabled: bool,
    pub text_toolbar_enabled: bool,
    pub recording_hotkey: String,
    pub recording_enabled: bool,
    pub ocr_engine: String,
}

/// 配置管理器（线程安全）
pub struct ConfigManager {
    config: Mutex<AppConfig>,
    config_path: PathBuf,
}

// Settings commands may arrive concurrently from independent webviews. Serialize
// disk writes so their temporary-file replacements cannot race each other.
static CONFIG_SAVE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn config_save_lock() -> &'static Mutex<()> {
    CONFIG_SAVE_LOCK.get_or_init(|| Mutex::new(()))
}

impl Default for ConfigManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ConfigManager {
    /// 创建配置管理器，从文件加载配置，若文件不存在则使用默认值并写入
    pub fn new() -> Self {
        let config_path = Self::get_config_path();
        let config = Self::load_config(&config_path);
        let manager = Self {
            config: Mutex::new(config),
            config_path,
        };
        // 确保配置文件存在
        let _ = manager.save_config();
        manager
    }

    /// 一次性获取启动时需要的所有配置（减少加锁次数）
    pub fn get_startup_config(&self) -> Result<StartupConfig, String> {
        let c = self
            .config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))?;
        Ok(StartupConfig {
            ai_config: c.ai.clone(),
            screenshot_hotkey: c.screenshot_hotkey.clone(),
            screenshot_enabled: c.screenshot_enabled,
            text_toolbar_enabled: c.text_toolbar_enabled,
            recording_hotkey: c.recording_hotkey.clone(),
            recording_enabled: c.recording_enabled,
            ocr_engine: c.ocr_engine.clone(),
        })
    }

    /// 获取配置文件路径
    fn get_config_path() -> PathBuf {
        let data_dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
        let app_dir = data_dir.join("levitaire");
        // 确保目录存在
        let _ = fs::create_dir_all(&app_dir);
        app_dir.join("config.json")
    }

    /// 从文件加载配置
    /// 支持旧格式（明文 api_key）自动迁移为加密存储
    fn load_config(path: &Path) -> AppConfig {
        if path.exists() {
            match fs::read_to_string(path) {
                Ok(content) => match serde_json::from_str::<AppConfig>(&content) {
                    Ok(mut config) => {
                        // 优先从加密字段解密 API Key
                        if let Some(ref encrypted_hex) = config.api_key_encrypted {
                            match crate::utils::crypto::from_hex(encrypted_hex)
                                .and_then(|bytes| crate::utils::crypto::decrypt(&bytes))
                                .and_then(|decrypted| {
                                    String::from_utf8(decrypted)
                                        .map_err(|e| format!("UTF-8 解码失败: {}", e))
                                }) {
                                Ok(api_key) => {
                                    config.ai.api_key = api_key;
                                    crate::utils::logger::log("config", "已从加密字段解密 API Key");
                                }
                                Err(e) => {
                                    crate::utils::logger::log(
                                        "config",
                                        &format!("解密 API Key 失败: {}", e),
                                    );
                                }
                            }
                        }
                        // 兼容旧格式：api_key 明文存储，首次保存后会自动升级为加密格式
                        crate::utils::logger::log("config", "配置文件加载成功");
                        return config;
                    }
                    Err(e) => {
                        crate::utils::logger::log(
                            "config",
                            &format!("配置文件解析失败: {}, 使用默认配置", e),
                        );
                    }
                },
                Err(e) => {
                    crate::utils::logger::log(
                        "config",
                        &format!("配置文件读取失败: {}, 使用默认配置", e),
                    );
                }
            }
        }
        crate::utils::logger::log("config", "使用默认配置");
        AppConfig::default()
    }

    /// 保存配置到文件（在锁内克隆数据，释放锁后再做序列化和 IO，避免持锁阻塞）
    /// 自动将 api_key 明文加密后存储，内存中保留明文供运行时使用
    fn save_config(&self) -> Result<(), String> {
        let _save_guard = config_save_lock()
            .lock()
            .map_err(|e| format!("获取配置保存锁失败: {}", e))?;
        let mut config_to_save = self
            .config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))?
            .clone();

        if config_to_save.ai.api_key.is_empty() {
            // 用户清空了 API Key：同时清除加密字段，防止重启后旧 Key 恢复
            config_to_save.api_key_encrypted = None;
        } else {
            // 将 api_key 加密存储到 api_key_encrypted 字段
            let encrypted = crate::utils::crypto::encrypt(config_to_save.ai.api_key.as_bytes())
                .map_err(|e| {
                    crate::utils::logger::log("config", &format!("API Key 加密失败: {}", e));
                    format!("API Key 加密失败，配置未保存: {}", e)
                })?;
            config_to_save.api_key_encrypted = Some(crate::utils::crypto::to_hex(&encrypted));
            crate::utils::logger::log("config", "API Key 已加密存储");
            // 加密成功后清空明文 api_key（文件中不保存明文）
            config_to_save.ai.api_key = String::new();
        }

        let content = serde_json::to_string_pretty(&config_to_save)
            .map_err(|e| format!("序列化配置失败: {}", e))?;
        let temp_path = self
            .config_path
            .with_extension(format!("json.{}.tmp", std::process::id()));
        fs::write(&temp_path, content).map_err(|e| format!("写入临时配置文件失败: {}", e))?;
        if let Err(e) = fs::rename(&temp_path, &self.config_path) {
            let _ = fs::remove_file(&temp_path);
            return Err(format!("替换配置文件失败: {}", e));
        }
        crate::utils::logger::log("config", "配置文件保存成功");
        Ok(())
    }

    /// 获取 AI 配置的快照
    pub fn get_ai_config(&self) -> Result<AiConfig, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.ai.clone())
    }

    /// 更新 AI 配置
    pub fn update_ai_config(&self, new_ai_config: AiConfig) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.ai = new_ai_config;
        }
        self.save_config()
    }

    pub fn get_theme_preferences(&self) -> Result<ThemePreferences, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| ThemePreferences {
                theme: c.theme.clone(),
                accent: c.theme_accent.clone(),
                scheme: c.theme_scheme.clone(),
            })
    }

    pub fn update_theme_preferences(&self, preferences: ThemePreferences) -> Result<(), String> {
        if preferences.theme != "light" && preferences.theme != "dark" {
            return Err("主题必须是 light 或 dark".to_string());
        }
        if !matches!(
            preferences.accent.as_str(),
            "blue" | "cyan" | "teal" | "green" | "indigo" | "violet"
        ) {
            return Err("不支持的主题色".to_string());
        }
        if !matches!(
            preferences.scheme.as_str(),
            "signal"
                | "cloud"
                | "studio"
                | "quartz"
                | "moss"
                | "ember"
                | "arctic"
                | "mono"
                | "iris"
                | "dusk"
        ) {
            return Err("不支持的界面风格".to_string());
        }
        let requested = preferences.clone();
        let previous = {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            let previous = ThemePreferences {
                theme: config.theme.clone(),
                accent: config.theme_accent.clone(),
                scheme: config.theme_scheme.clone(),
            };
            config.theme = preferences.theme;
            config.theme_accent = preferences.accent;
            config.theme_scheme = preferences.scheme;
            previous
        };
        if let Err(error) = self.save_config() {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            // Do not overwrite a newer preference update that raced this failed write.
            if config.theme == requested.theme
                && config.theme_accent == requested.accent
                && config.theme_scheme == requested.scheme
            {
                config.theme = previous.theme;
                config.theme_accent = previous.accent;
                config.theme_scheme = previous.scheme;
            }
            return Err(error);
        }
        Ok(())
    }

    /// 获取截图快捷键（空串表示未设置）
    pub fn get_screenshot_hotkey(&self) -> Result<String, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.screenshot_hotkey.clone())
    }

    /// 更新截图快捷键并持久化
    pub fn update_screenshot_hotkey(&self, hotkey: String) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.screenshot_hotkey = hotkey;
        }
        self.save_config()
    }

    /// 获取截图工具启用状态
    pub fn get_screenshot_enabled(&self) -> Result<bool, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.screenshot_enabled)
    }

    /// 更新截图工具启用状态并持久化
    pub fn update_screenshot_enabled(&self, enabled: bool) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.screenshot_enabled = enabled;
        }
        self.save_config()
    }

    /// 获取文字工具栏启用状态
    pub fn get_text_toolbar_enabled(&self) -> Result<bool, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.text_toolbar_enabled)
    }

    /// 更新文字工具栏启用状态并持久化
    pub fn update_text_toolbar_enabled(&self, enabled: bool) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.text_toolbar_enabled = enabled;
        }
        self.save_config()
    }

    /// 获取工具栏启用的功能 ID 列表
    pub fn get_toolbar_features(&self) -> Result<Vec<String>, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.toolbar_features.clone())
    }

    /// 更新工具栏启用的功能 ID 列表并持久化
    pub fn update_toolbar_features(&self, features: Vec<String>) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.toolbar_features = features;
        }
        self.save_config()
    }

    /// 获取搜索引擎配置（空串表示未设置，前端取默认 Bing）
    pub fn get_search_engine(&self) -> Result<String, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.search_engine.clone())
    }

    /// 更新搜索引擎配置并持久化
    pub fn update_search_engine(&self, engine: String) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.search_engine = engine;
        }
        self.save_config()
    }

    /// 获取去重粒度配置（JSON 字符串，空串表示未设置）
    pub fn get_dedup_mode(&self) -> Result<String, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.dedup_mode.clone())
    }

    /// 更新去重粒度配置并持久化
    pub fn update_dedup_mode(&self, mode: String) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.dedup_mode = mode;
        }
        self.save_config()
    }

    /// 获取 MD5 位数配置（空串表示未设置，前端取默认 32）
    pub fn get_md5_length(&self) -> Result<String, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.md5_length.clone())
    }

    /// 更新 MD5 位数配置并持久化
    pub fn update_md5_length(&self, length: String) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.md5_length = length;
        }
        self.save_config()
    }

    /// 获取编号样式配置（空串表示未设置，前端取默认值）
    pub fn get_numbering_style(&self) -> Result<String, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.numbering_style.clone())
    }

    /// 更新编号样式配置并持久化
    pub fn update_numbering_style(&self, style: String) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.numbering_style = style;
        }
        self.save_config()
    }

    /// 获取清除功能启用的清除项 ID 列表（空列表表示未设置，前端取默认全量）
    pub fn get_clear_options(&self) -> Result<Vec<String>, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.clear_options.clone())
    }

    /// 更新清除功能启用的清除项 ID 列表并持久化
    pub fn update_clear_options(&self, options: Vec<String>) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.clear_options = options;
        }
        self.save_config()
    }

    /// 获取 TTS 朗读配置（JSON 字符串，空串表示未设置，前端取默认值）
    pub fn get_tts_config(&self) -> Result<String, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.tts_config.clone())
    }

    /// 更新 TTS 朗读配置并持久化
    pub fn update_tts_config(&self, tts_config: String) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.tts_config = tts_config;
        }
        self.save_config()
    }

    /// 获取系统监控工具启用状态
    pub fn get_system_monitor_enabled(&self) -> Result<bool, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.system_monitor_enabled)
    }

    /// 更新系统监控工具启用状态并持久化
    pub fn update_system_monitor_enabled(&self, enabled: bool) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.system_monitor_enabled = enabled;
        }
        self.save_config()
    }

    /// 获取系统监控采集间隔（毫秒）
    pub fn get_system_monitor_interval_ms(&self) -> Result<u64, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.system_monitor_interval_ms)
    }

    /// 更新系统监控采集间隔并持久化
    pub fn update_system_monitor_interval_ms(&self, ms: u64) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.system_monitor_interval_ms = ms;
        }
        self.save_config()
    }

    /// 获取系统监控配置（JSON 字符串，空串表示未设置，前端取默认值）
    pub fn get_system_monitor_config(&self) -> Result<String, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.system_monitor_config.clone())
    }

    /// 更新系统监控配置并持久化
    pub fn update_system_monitor_config(&self, config: String) -> Result<(), String> {
        {
            let mut config_lock = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config_lock.system_monitor_config = config;
        }
        self.save_config()
    }

    /// 获取番茄钟工具启用状态
    pub fn get_pomodoro_enabled(&self) -> Result<bool, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.pomodoro_enabled)
    }

    /// 更新番茄钟工具启用状态并持久化
    pub fn update_pomodoro_enabled(&self, enabled: bool) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.pomodoro_enabled = enabled;
        }
        self.save_config()
    }

    /// 获取番茄钟配置（JSON 字符串，空串表示未设置，前端取默认值）
    pub fn get_pomodoro_config(&self) -> Result<String, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.pomodoro_config.clone())
    }

    /// 更新番茄钟配置并持久化
    pub fn update_pomodoro_config(&self, config: String) -> Result<(), String> {
        {
            let mut config_lock = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config_lock.pomodoro_config = config;
        }
        self.save_config()
    }

    /// 获取录屏工具启用状态
    pub fn get_recording_enabled(&self) -> Result<bool, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.recording_enabled)
    }

    /// 更新录屏工具启用状态并持久化
    pub fn update_recording_enabled(&self, enabled: bool) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.recording_enabled = enabled;
        }
        self.save_config()
    }

    /// 获取录屏快捷键（空串表示未设置）
    pub fn get_recording_hotkey(&self) -> Result<String, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.recording_hotkey.clone())
    }

    /// 更新录屏快捷键并持久化
    pub fn update_recording_hotkey(&self, hotkey: String) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.recording_hotkey = hotkey;
        }
        self.save_config()
    }

    /// 获取录屏配置（JSON 字符串，空串表示未设置，前端取默认值）
    pub fn get_recording_config(&self) -> Result<String, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.recording_config.clone())
    }

    /// 更新录屏配置并持久化
    pub fn update_recording_config(&self, config: String) -> Result<(), String> {
        {
            let mut config_lock = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config_lock.recording_config = config;
        }
        self.save_config()
    }

    /// 获取录屏文件保存路径（空串表示未设置，每次保存时弹出对话框）
    pub fn get_recording_save_path(&self) -> Result<String, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.recording_save_path.clone())
    }

    /// 更新录屏文件保存路径并持久化
    pub fn update_recording_save_path(&self, path: String) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.recording_save_path = path;
        }
        self.save_config()
    }

    /// 获取截图文件保存路径（空串表示未设置，每次保存时弹出对话框）
    pub fn get_screenshot_save_path(&self) -> Result<String, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.screenshot_save_path.clone())
    }

    /// 更新截图文件保存路径并持久化
    pub fn update_screenshot_save_path(&self, path: String) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.screenshot_save_path = path;
        }
        self.save_config()
    }

    /// 更新 OCR 识别引擎偏好并持久化
    pub fn update_ocr_engine(&self, engine: String) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.ocr_engine = engine;
        }
        self.save_config()
    }

    /// 获取自启动工具 ID 列表
    pub fn get_tools_autostart(&self) -> Result<Vec<String>, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.tools_autostart.clone())
    }

    /// 更新自启动工具 ID 列表并持久化
    pub fn update_tools_autostart(&self, ids: Vec<String>) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.tools_autostart = ids;
        }
        self.save_config()
    }

    /// 获取指定悬浮窗的记忆位置（None 表示尚未记忆）
    pub fn get_window_position(&self, window_id: &str) -> Result<Option<WindowPosition>, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.window_positions.get(window_id).copied())
    }

    /// 记忆指定悬浮窗位置并持久化
    pub fn set_window_position(&self, window_id: &str, pos: WindowPosition) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.window_positions.insert(window_id.to_string(), pos);
        }
        self.save_config()
    }

    /// 清除指定悬浮窗的记忆位置并持久化，使其回退到默认定位
    pub fn reset_window_position(&self, window_id: &str) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.window_positions.remove(window_id);
        }
        self.save_config()
    }

    /// 获取快速输入转盘工具启用状态
    pub fn get_quick_input_enabled(&self) -> Result<bool, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.quick_input_enabled)
    }

    /// 更新快速输入转盘工具启用状态并持久化
    pub fn update_quick_input_enabled(&self, enabled: bool) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.quick_input_enabled = enabled;
        }
        self.save_config()
    }

    /// 获取快速输入转盘触发键名（空串表示默认 CapsLock）
    pub fn get_quick_input_trigger_key(&self) -> Result<String, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.quick_input_trigger_key.clone())
    }

    /// 更新快速输入转盘触发键名并持久化
    pub fn update_quick_input_trigger_key(&self, key: String) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.quick_input_trigger_key = key;
        }
        self.save_config()
    }

    /// 获取快速输入转盘触发模式（"click" = 单击切换，"hold" = 按住唤起）
    pub fn get_quick_input_mode(&self) -> Result<String, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.quick_input_mode.clone())
    }

    /// 更新快速输入转盘触发模式并持久化
    pub fn update_quick_input_mode(&self, mode: String) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.quick_input_mode = mode;
        }
        self.save_config()
    }

    /// 获取快速输入转盘预设提示词（JSON 字符串，空串表示无预设）
    pub fn get_quick_input_snippets(&self) -> Result<String, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.quick_input_snippets.clone())
    }

    /// 更新快速输入转盘预设提示词并持久化
    pub fn update_quick_input_snippets(&self, snippets: String) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.quick_input_snippets = snippets;
        }
        self.save_config()
    }
}

// ─── 开机自启动（Windows 注册表） ────────────────────────────────

const REG_RUN_PATH: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const REG_VALUE_NAME_STR: &str = "LevitaireService";

/// 获取当前可执行文件路径（UTF-16）
fn get_exe_path_wide() -> Result<Vec<u16>, String> {
    let mut buf = [0u16; 520];
    let len = unsafe { windows::Win32::System::LibraryLoader::GetModuleFileNameW(None, &mut buf) };
    if len == 0 {
        return Err("获取可执行文件路径失败".to_string());
    }
    // 返回值等于缓冲容量说明路径被截断，直接报错避免写入不完整路径
    if len as usize >= buf.len() {
        return Err("可执行文件路径过长，可能被截断".to_string());
    }
    Ok(buf[..len as usize].to_vec())
}

/// 将字符串转为 PCWSTR（含 null 终止符）
fn to_pcwstr(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 给 exe 路径两端加双引号（UTF-16），避免路径含空格时注册表 Run 键无法启动
fn quote_exe_path_wide(exe_path: &[u16]) -> Vec<u16> {
    let mut quoted = Vec::with_capacity(exe_path.len() + 2);
    quoted.push(b'"' as u16);
    quoted.extend_from_slice(exe_path);
    quoted.push(b'"' as u16);
    quoted
}

/// 查询开机自启动状态
pub fn get_auto_start() -> bool {
    let key_path = to_pcwstr(REG_RUN_PATH);
    let value_name = to_pcwstr(REG_VALUE_NAME_STR);
    unsafe {
        let mut hkey = HKEY::default();
        let result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            windows::core::PCWSTR(key_path.as_ptr()),
            Some(0),
            KEY_READ,
            &mut hkey,
        );
        if result != ERROR_SUCCESS {
            return false;
        }

        let mut data_type = REG_VALUE_TYPE(0);
        // 缓冲需容纳加双引号后的路径：最长 exe 路径(520 字符) + 2 个引号，取 2048 字节留足余量
        let mut data_buf = [0u8; 2048];
        let mut data_size = data_buf.len() as u32;

        let result = RegQueryValueExW(
            hkey,
            windows::core::PCWSTR(value_name.as_ptr()),
            None,
            Some(&mut data_type),
            Some(data_buf.as_mut_ptr()),
            Some(&mut data_size),
        );
        let _ = RegCloseKey(hkey);
        result == ERROR_SUCCESS && data_size > 0
    }
}

/// 设置开机自启动
pub fn set_auto_start(enable: bool) -> Result<(), String> {
    let key_path = to_pcwstr(REG_RUN_PATH);
    let value_name = to_pcwstr(REG_VALUE_NAME_STR);
    unsafe {
        let mut hkey = HKEY::default();
        let result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            windows::core::PCWSTR(key_path.as_ptr()),
            Some(0),
            KEY_WRITE,
            &mut hkey,
        );
        if result != ERROR_SUCCESS {
            return Err(format!("打开注册表键失败: {:?}", result));
        }

        if enable {
            let exe_path = get_exe_path_wide()?;
            // 双引号包裹完整路径，避免安装目录含空格时注册表 Run 键启动失败
            let quoted_path = quote_exe_path_wide(&exe_path);
            // REG_SZ 数据：UTF-16 含 null 终止符，字节切片
            let data = std::slice::from_raw_parts(
                quoted_path.as_ptr() as *const u8,
                quoted_path.len() * 2,
            );
            let result = RegSetValueExW(
                hkey,
                windows::core::PCWSTR(value_name.as_ptr()),
                Some(0),
                REG_SZ,
                Some(data),
            );
            let _ = RegCloseKey(hkey);
            if result != ERROR_SUCCESS {
                return Err(format!("设置注册表值失败: {:?}", result));
            }
            crate::utils::logger::log("config", "已设置开机自启动");
        } else {
            let result = RegDeleteValueW(hkey, windows::core::PCWSTR(value_name.as_ptr()));
            let _ = RegCloseKey(hkey);
            if result != ERROR_SUCCESS {
                // ERROR_FILE_NOT_FOUND (2) 表示值本来不存在，也算成功
                if result.0 != 2 {
                    return Err(format!("删除注册表值失败: {:?}", result));
                }
            }
            crate::utils::logger::log("config", "已取消开机自启动");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_quote_exe_path_wide() {
        // 含空格路径（如 Program Files）需被双引号包裹
        let path: Vec<u16> = "C:\\Program Files\\Levitaire\\levitaire.exe"
            .encode_utf16()
            .collect();
        let quoted = quote_exe_path_wide(&path);
        let quoted_str = String::from_utf16(&quoted).unwrap();
        assert_eq!(quoted_str, "\"C:\\Program Files\\Levitaire\\levitaire.exe\"");
        assert_eq!(quoted.first(), Some(&(b'"' as u16)));
        assert_eq!(quoted.last(), Some(&(b'"' as u16)));
        assert_eq!(quoted.len(), path.len() + 2);

        // 无空格路径同样包裹，行为一致
        let plain: Vec<u16> = "C:\\Levitaire\\levitaire.exe".encode_utf16().collect();
        let quoted_plain = quote_exe_path_wide(&plain);
        assert_eq!(
            String::from_utf16(&quoted_plain).unwrap(),
            "\"C:\\Levitaire\\levitaire.exe\""
        );

        // 空路径仅剩两个引号
        let empty: Vec<u16> = Vec::new();
        assert_eq!(
            String::from_utf16(&quote_exe_path_wide(&empty)).unwrap(),
            "\"\""
        );
    }

    #[test]
    fn test_ai_config_default() {
        let config = AiConfig::default();
        assert!(config.api_key.is_empty());
        assert_eq!(config.base_url, "https://api.anthropic.com");
        assert_eq!(config.model, "claude-sonnet-5");
        assert_eq!(config.api_type, "anthropic");
    }

    #[test]
    fn test_app_config_default_uses_feature_defaults() {
        let config = AppConfig::default();
        assert!(config.screenshot_enabled);
        assert!(config.text_toolbar_enabled);
        assert_eq!(config.system_monitor_interval_ms, 1000);
        assert!(!config.system_monitor_enabled);
        assert!(!config.pomodoro_enabled);
        assert!(config.tools_autostart.is_empty());
    }

    #[test]
    fn test_ai_config_serde_roundtrip() {
        let config = AiConfig {
            api_key: "sk-test-123".to_string(),
            base_url: "https://api.openai.com".to_string(),
            model: "gpt-4".to_string(),
            api_type: "openai".to_string(),
        };
        let json = serde_json::to_string(&config).unwrap();
        let decoded: AiConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(config, decoded);
    }

    #[test]
    fn test_ai_config_missing_api_type_defaults() {
        // 模拟旧版本配置文件（没有 api_type 字段）
        let json = r#"{"api_key":"","base_url":"https://api.anthropic.com","model":"claude-3"}"#;
        let config: AiConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.api_type, "anthropic");
    }

    #[test]
    fn test_app_config_serde_with_encrypted() {
        let config = AppConfig {
            ai: AiConfig {
                api_key: "".to_string(),
                ..Default::default()
            },
            api_key_encrypted: Some("deadbeef".to_string()),
            ..Default::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("api_key_encrypted"));
        let decoded: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.api_key_encrypted, Some("deadbeef".to_string()));
    }

    #[test]
    fn test_app_config_serde_without_encrypted() {
        // api_key_encrypted 为 None 时应跳过序列化
        let config = AppConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        assert!(!json.contains("api_key_encrypted"));
    }

    /// 集成测试：ConfigManager 的保存-加载-加密流程
    /// 使用临时目录，不影响真实配置文件
    #[test]
    fn test_config_manager_save_load_encrypted() {
        let tmp = std::env::temp_dir().join(format!("levitaire_test_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let config_path = tmp.join("config.json");

        // 手动构造 ConfigManager（跳过 get_config_path）
        let manager = ConfigManager {
            config: Mutex::new(AppConfig::default()),
            config_path: config_path.clone(),
        };

        // 设置 API Key 并保存
        let api_config = AiConfig {
            api_key: "sk-test-secret-key".to_string(),
            base_url: "https://api.anthropic.com".to_string(),
            model: "claude-3".to_string(),
            api_type: "anthropic".to_string(),
        };
        manager.update_ai_config(api_config).unwrap();

        // 验证文件中不包含明文 API Key
        let file_content = std::fs::read_to_string(&config_path).unwrap();
        assert!(
            !file_content.contains("sk-test-secret-key"),
            "文件中不应包含明文 API Key"
        );
        assert!(
            file_content.contains("api_key_encrypted"),
            "文件应包含加密字段"
        );

        // 重新加载，验证能正确解密
        let loaded = ConfigManager::load_config(&config_path);
        assert_eq!(
            loaded.ai.api_key, "sk-test-secret-key",
            "重新加载后 API Key 应正确解密"
        );

        // 清理
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 测试清空 API Key 时加密字段也被清除
    #[test]
    fn test_config_manager_clear_key_removes_encrypted() {
        let tmp = std::env::temp_dir().join(format!("levitaire_test_clear_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let config_path = tmp.join("config.json");

        let manager = ConfigManager {
            config: Mutex::new(AppConfig::default()),
            config_path: config_path.clone(),
        };

        // 先保存一个有 Key 的配置
        let api_config = AiConfig {
            api_key: "sk-to-be-cleared".to_string(),
            ..Default::default()
        };
        manager.update_ai_config(api_config).unwrap();

        // 清空 Key 后保存
        manager
            .update_ai_config(AiConfig {
                api_key: "".to_string(),
                ..Default::default()
            })
            .unwrap();

        let file_content = std::fs::read_to_string(&config_path).unwrap();
        assert!(
            !file_content.contains("api_key_encrypted"),
            "清空 Key 后加密字段应被移除"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 测试 md5_length 字段默认值与 serde 往返
    #[test]
    fn test_md5_length_default_and_roundtrip() {
        // 默认值为空串（前端取默认 32）
        let config = AppConfig::default();
        assert_eq!(config.md5_length, "");

        // 序列化含 md5_length，反序列化保持一致
        let config = AppConfig {
            md5_length: "16".to_string(),
            ..Default::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("md5_length"));
        let decoded: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.md5_length, "16");
    }

    /// 测试旧配置文件（无 md5_length 字段）加载时取默认空串
    #[test]
    fn test_md5_length_missing_defaults_empty() {
        let json = r#"{"ai":{"api_key":"","base_url":"","model":"","api_type":"anthropic"}}"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.md5_length, "");
    }

    /// 测试 ConfigManager 持久化 md5_length 的保存与加载
    #[test]
    fn test_config_manager_md5_length_save_load() {
        let tmp = std::env::temp_dir().join(format!("levitaire_test_md5_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let config_path = tmp.join("config.json");

        let manager = ConfigManager {
            config: Mutex::new(AppConfig::default()),
            config_path: config_path.clone(),
        };

        manager.update_md5_length("16".to_string()).unwrap();
        assert_eq!(manager.get_md5_length().unwrap(), "16");

        // 重新加载验证持久化
        let loaded = ConfigManager::load_config(&config_path);
        assert_eq!(loaded.md5_length, "16");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 测试 numbering_style 字段默认值与 serde 往返
    #[test]
    fn test_numbering_style_default_and_roundtrip() {
        // 默认值为空串（前端取默认 number-dot）
        let config = AppConfig::default();
        assert_eq!(config.numbering_style, "");

        // 序列化含 numbering_style，反序列化保持一致
        let config = AppConfig {
            numbering_style: "\"number-dot\"".to_string(),
            ..Default::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("numbering_style"));
        let decoded: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.numbering_style, "\"number-dot\"");
    }

    /// 测试旧配置文件（无 numbering_style 字段）加载时取默认空串
    #[test]
    fn test_numbering_style_missing_defaults_empty() {
        let json = r#"{"ai":{"api_key":"","base_url":"","model":"","api_type":"anthropic"}}"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.numbering_style, "");
    }

    /// 测试 ConfigManager 持久化 numbering_style 的保存与加载
    #[test]
    fn test_config_manager_numbering_style_save_load() {
        let tmp =
            std::env::temp_dir().join(format!("levitaire_test_numbering_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let config_path = tmp.join("config.json");

        let manager = ConfigManager {
            config: Mutex::new(AppConfig::default()),
            config_path: config_path.clone(),
        };

        manager
            .update_numbering_style("\"letter-dot\"".to_string())
            .unwrap();
        assert_eq!(manager.get_numbering_style().unwrap(), "\"letter-dot\"");

        // 重新加载验证持久化
        let loaded = ConfigManager::load_config(&config_path);
        assert_eq!(loaded.numbering_style, "\"letter-dot\"");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 测试 clear_options 字段默认值与 serde 往返
    #[test]
    fn test_clear_options_default_and_roundtrip() {
        // 默认值为空 Vec（前端取默认全量）
        let config = AppConfig::default();
        assert!(config.clear_options.is_empty());

        let config = AppConfig {
            clear_options: vec!["clear-spaces".to_string(), "clear-newlines".to_string()],
            ..Default::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("clear_options"));
        let decoded: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(
            decoded.clear_options,
            vec!["clear-spaces", "clear-newlines"]
        );
    }

    /// 测试旧配置文件（无 clear_options 字段）加载时取默认空 Vec
    #[test]
    fn test_clear_options_missing_defaults_empty() {
        let json = r#"{"ai":{"api_key":"","base_url":"","model":"","api_type":"anthropic"}}"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert!(config.clear_options.is_empty());
    }

    /// 测试 ConfigManager 持久化 clear_options 的保存与加载
    #[test]
    fn test_config_manager_clear_options_save_load() {
        let tmp =
            std::env::temp_dir().join(format!("levitaire_test_clearopts_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let config_path = tmp.join("config.json");

        let manager = ConfigManager {
            config: Mutex::new(AppConfig::default()),
            config_path: config_path.clone(),
        };

        let opts = vec!["clear-spaces".to_string(), "clear-chinese".to_string()];
        manager.update_clear_options(opts.clone()).unwrap();
        assert_eq!(manager.get_clear_options().unwrap(), opts);

        // 重新加载验证持久化
        let loaded = ConfigManager::load_config(&config_path);
        assert_eq!(loaded.clear_options, opts);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 测试 tts_config 字段默认值与 serde 往返
    #[test]
    fn test_tts_config_default_and_roundtrip() {        // 默认值为空串（前端取默认配置）
        let config = AppConfig::default();
        assert_eq!(config.tts_config, "");

        // 序列化含 tts_config，反序列化保持一致
        let config = AppConfig {
            tts_config: r#"{"rate":"slow","voiceId":"vid","volume":0.8}"#.to_string(),
            ..Default::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("tts_config"));
        let decoded: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(
            decoded.tts_config,
            r#"{"rate":"slow","voiceId":"vid","volume":0.8}"#
        );
    }

    /// 测试旧配置文件（无 tts_config 字段）加载时取默认空串
    #[test]
    fn test_tts_config_missing_defaults_empty() {
        let json = r#"{"ai":{"api_key":"","base_url":"","model":"","api_type":"anthropic"}}"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.tts_config, "");
    }

    /// 测试 ConfigManager 持久化 tts_config 的保存与加载
    #[test]
    fn test_config_manager_tts_config_save_load() {
        let tmp = std::env::temp_dir().join(format!("levitaire_test_tts_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let config_path = tmp.join("config.json");

        let manager = ConfigManager {
            config: Mutex::new(AppConfig::default()),
            config_path: config_path.clone(),
        };

        let payload = r#"{"rate":"fast","voiceId":"v1","volume":1.0}"#.to_string();
        manager.update_tts_config(payload.clone()).unwrap();
        assert_eq!(manager.get_tts_config().unwrap(), payload);

        // 重新加载验证持久化
        let loaded = ConfigManager::load_config(&config_path);
        assert_eq!(loaded.tts_config, payload);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 测试 search_engine 字段默认值与 serde 往返
    #[test]
    fn test_search_engine_default_and_roundtrip() {
        // 默认值为空串（前端取默认 Bing）
        let config = AppConfig::default();
        assert_eq!(config.search_engine, "");

        // 序列化含 search_engine，反序列化保持一致
        let config = AppConfig {
            search_engine: "baidu".to_string(),
            ..Default::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("search_engine"));
        let decoded: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.search_engine, "baidu");
    }

    /// 测试旧配置文件（无 search_engine 字段）加载时取默认空串
    #[test]
    fn test_search_engine_missing_defaults_empty() {
        let json = r#"{"ai":{"api_key":"","base_url":"","model":"","api_type":"anthropic"}}"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.search_engine, "");
    }

    /// 测试 ConfigManager 持久化 search_engine 的保存与加载
    #[test]
    fn test_config_manager_search_engine_save_load() {
        let tmp =
            std::env::temp_dir().join(format!("levitaire_test_search_engine_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let config_path = tmp.join("config.json");

        let manager = ConfigManager {
            config: Mutex::new(AppConfig::default()),
            config_path: config_path.clone(),
        };

        manager.update_search_engine("google".to_string()).unwrap();
        assert_eq!(manager.get_search_engine().unwrap(), "google");

        // 重新加载验证持久化
        let loaded = ConfigManager::load_config(&config_path);
        assert_eq!(loaded.search_engine, "google");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 测试 window_positions 字段默认值与 serde 往返
    #[test]
    fn test_window_positions_default_and_roundtrip() {
        // 默认为空 map（前端回退到各窗口默认定位）
        let config = AppConfig::default();
        assert!(config.window_positions.is_empty());

        let config = AppConfig {
            window_positions: HashMap::from([(
                "orb".to_string(),
                WindowPosition { x: 123, y: 456 },
            )]),
            ..Default::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("window_positions"));
        let decoded: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(
            decoded.window_positions.get("orb"),
            Some(&WindowPosition { x: 123, y: 456 })
        );
    }

    /// 测试旧配置文件（无 window_positions 字段）加载时取默认空 map
    #[test]
    fn test_window_positions_missing_defaults_empty() {
        let json = r#"{"ai":{"api_key":"","base_url":"","model":"","api_type":"anthropic"}}"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert!(config.window_positions.is_empty());
    }

    /// 测试 ConfigManager 持久化窗口位置的保存与加载
    #[test]
    fn test_config_manager_window_position_save_load() {
        let tmp = std::env::temp_dir().join(format!("levitaire_test_winpos_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let config_path = tmp.join("config.json");

        let manager = ConfigManager {
            config: Mutex::new(AppConfig::default()),
            config_path: config_path.clone(),
        };

        // 未记忆时返回 None
        assert_eq!(manager.get_window_position("orb").unwrap(), None);

        manager
            .set_window_position("orb", WindowPosition { x: 800, y: 600 })
            .unwrap();
        assert_eq!(
            manager.get_window_position("orb").unwrap(),
            Some(WindowPosition { x: 800, y: 600 })
        );

        // 覆盖已有位置
        manager
            .set_window_position("monitor-overlay", WindowPosition { x: 10, y: 20 })
            .unwrap();
        manager
            .set_window_position("orb", WindowPosition { x: 900, y: 700 })
            .unwrap();
        assert_eq!(
            manager.get_window_position("orb").unwrap(),
            Some(WindowPosition { x: 900, y: 700 })
        );

        // 重新加载验证持久化
        let loaded = ConfigManager::load_config(&config_path);
        assert_eq!(
            loaded.window_positions.get("orb"),
            Some(&WindowPosition { x: 900, y: 700 })
        );
        assert_eq!(
            loaded.window_positions.get("monitor-overlay"),
            Some(&WindowPosition { x: 10, y: 20 })
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 测试 ConfigManager 清除窗口位置记忆
    #[test]
    fn test_config_manager_reset_window_position() {
        let tmp = std::env::temp_dir().join(format!("levitaire_test_reset_winpos_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let config_path = tmp.join("config.json");

        let manager = ConfigManager {
            config: Mutex::new(AppConfig::default()),
            config_path: config_path.clone(),
        };

        // 未记忆时清除不应报错
        manager.reset_window_position("orb").unwrap();
        assert_eq!(manager.get_window_position("orb").unwrap(), None);

        // 记忆后清除
        manager
            .set_window_position("orb", WindowPosition { x: 800, y: 600 })
            .unwrap();
        manager
            .set_window_position("monitor-overlay", WindowPosition { x: 10, y: 20 })
            .unwrap();
        manager.reset_window_position("orb").unwrap();
        assert_eq!(manager.get_window_position("orb").unwrap(), None);
        assert_eq!(
            manager.get_window_position("monitor-overlay").unwrap(),
            Some(WindowPosition { x: 10, y: 20 })
        );

        // 重新加载验证持久化
        let loaded = ConfigManager::load_config(&config_path);
        assert_eq!(loaded.window_positions.get("orb"), None);
        assert_eq!(
            loaded.window_positions.get("monitor-overlay"),
            Some(&WindowPosition { x: 10, y: 20 })
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
