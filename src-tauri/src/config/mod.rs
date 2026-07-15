use serde::{Deserialize, Serialize};
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

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            base_url: String::from("https://api.anthropic.com"),
            model: String::from("claude-sonnet-4-20250514"),
            api_type: default_api_type(),
        }
    }
}

/// 应用全局配置（与 config.json 文件结构对应）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub ai: AiConfig,
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
    /// 语音输入工具是否启用（仅启用时热键才触发）。默认 false
    #[serde(default)]
    pub stt_enabled: bool,
    /// 语音输入全局快捷键，如 "Ctrl+Shift+S"；空串表示不启用
    #[serde(default)]
    pub stt_hotkey: String,
    /// 语音输入配置（JSON 字符串，前端解析）：{provider,baseUrl,model,autoPaste}。空串表示使用默认值。
    /// 注意：apiKey 不存此字段，单独用 stt_api_key_encrypted 加密存储
    #[serde(default)]
    pub stt_config: String,
    /// STT API Key 的 DPAPI 加密存储（十六进制编码）。加载时解密供运行时使用，保存时清空白文
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_api_key_encrypted: Option<String>,
    /// STT API Key 明文（仅运行时使用，保存时加密到 stt_api_key_encrypted 并清空本字段）
    #[serde(default, skip_serializing)]
    pub stt_api_key: String,
    /// 系统监控工具是否启用（仅启用时 palette 卡片可激活）。默认 false
    #[serde(default = "default_system_monitor_enabled")]
    pub system_monitor_enabled: bool,
    /// 系统监控采集间隔（毫秒），默认 1000。运行时可改，无需重启采集线程
    #[serde(default = "default_system_monitor_interval_ms")]
    pub system_monitor_interval_ms: u64,
    /// 系统监控配置（JSON 字符串，前端解析）：如 {"intervalMs":1000}。空串表示使用默认值
    #[serde(default)]
    pub system_monitor_config: String,
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

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            ai: AiConfig::default(),
            api_key_encrypted: None,
            screenshot_hotkey: String::new(),
            screenshot_enabled: default_screenshot_enabled(),
            text_toolbar_enabled: default_text_toolbar_enabled(),
            toolbar_features: Vec::new(),
            dedup_mode: String::new(),
            md5_length: String::new(),
            numbering_style: String::new(),
            clear_options: Vec::new(),
            tts_config: String::new(),
            stt_enabled: false,
            stt_hotkey: String::new(),
            stt_config: String::new(),
            stt_api_key_encrypted: None,
            stt_api_key: String::new(),
            system_monitor_enabled: default_system_monitor_enabled(),
            system_monitor_interval_ms: default_system_monitor_interval_ms(),
            system_monitor_config: String::new(),
            recording_enabled: false,
            recording_hotkey: String::new(),
            recording_config: String::new(),
            recording_save_path: String::new(),
            screenshot_save_path: String::new(),
        }
    }
}

/// 启动时一次性读取的配置快照（减少加锁次数）
pub struct StartupConfig {
    pub ai_config: AiConfig,
    pub screenshot_hotkey: String,
    pub screenshot_enabled: bool,
    pub text_toolbar_enabled: bool,
    pub stt_hotkey: String,
    pub stt_enabled: bool,
    pub recording_hotkey: String,
    pub recording_enabled: bool,
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
            stt_hotkey: c.stt_hotkey.clone(),
            stt_enabled: c.stt_enabled,
            recording_hotkey: c.recording_hotkey.clone(),
            recording_enabled: c.recording_enabled,
        })
    }

    /// 获取配置文件路径
    fn get_config_path() -> PathBuf {
        let data_dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
        let app_dir = data_dir.join("floast");
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
                        // 解密 STT API Key
                        if let Some(ref encrypted_hex) = config.stt_api_key_encrypted {
                            match crate::utils::crypto::from_hex(encrypted_hex)
                                .and_then(|bytes| crate::utils::crypto::decrypt(&bytes))
                                .and_then(|decrypted| {
                                    String::from_utf8(decrypted)
                                        .map_err(|e| format!("UTF-8 解码失败: {}", e))
                                }) {
                                Ok(key) => {
                                    config.stt_api_key = key;
                                    crate::utils::logger::log(
                                        "config",
                                        "已从加密字段解密 STT API Key",
                                    );
                                }
                                Err(e) => {
                                    crate::utils::logger::log(
                                        "config",
                                        &format!("解密 STT API Key 失败: {}", e),
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

        // STT API Key 加密存储（同 ai.api_key 模式）
        if config_to_save.stt_api_key.is_empty() {
            config_to_save.stt_api_key_encrypted = None;
        } else {
            let encrypted = crate::utils::crypto::encrypt(config_to_save.stt_api_key.as_bytes())
                .map_err(|e| {
                    crate::utils::logger::log("config", &format!("STT API Key 加密失败: {}", e));
                    format!("STT API Key 加密失败，配置未保存: {}", e)
                })?;
            config_to_save.stt_api_key_encrypted = Some(crate::utils::crypto::to_hex(&encrypted));
            crate::utils::logger::log("config", "STT API Key 已加密存储");
            config_to_save.stt_api_key = String::new();
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

    /// 获取语音输入工具启用状态
    pub fn get_stt_enabled(&self) -> Result<bool, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.stt_enabled)
    }

    /// 更新语音输入工具启用状态并持久化
    pub fn update_stt_enabled(&self, enabled: bool) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.stt_enabled = enabled;
        }
        self.save_config()
    }

    /// 获取语音输入快捷键（空串表示未设置）
    pub fn get_stt_hotkey(&self) -> Result<String, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.stt_hotkey.clone())
    }

    /// 更新语音输入快捷键并持久化
    pub fn update_stt_hotkey(&self, hotkey: String) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.stt_hotkey = hotkey;
        }
        self.save_config()
    }

    /// 获取语音输入配置（JSON 字符串，空串表示未设置，前端取默认值）
    pub fn get_stt_config(&self) -> Result<String, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.stt_config.clone())
    }

    /// 更新语音输入配置并持久化
    pub fn update_stt_config(&self, stt_config: String) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.stt_config = stt_config;
        }
        self.save_config()
    }

    /// 获取 STT API Key 明文（运行时使用，从加密字段解密）
    pub fn get_stt_api_key(&self) -> Result<String, String> {
        self.config
            .lock()
            .map_err(|e| format!("获取配置锁失败: {}", e))
            .map(|c| c.stt_api_key.clone())
    }

    /// 更新 STT API Key（加密存储）。空串则清除加密字段
    pub fn update_stt_api_key(&self, api_key: String) -> Result<(), String> {
        {
            let mut config = self
                .config
                .lock()
                .map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.stt_api_key = api_key;
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
}

// ─── 开机自启动（Windows 注册表） ────────────────────────────────

const REG_RUN_PATH: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const REG_VALUE_NAME_STR: &str = "FloastService";

/// 获取当前可执行文件路径（UTF-16）
fn get_exe_path_wide() -> Result<Vec<u16>, String> {
    let mut buf = [0u16; 520];
    let len = unsafe { windows::Win32::System::LibraryLoader::GetModuleFileNameW(None, &mut buf) };
    if len == 0 {
        return Err("获取可执行文件路径失败".to_string());
    }
    Ok(buf[..len as usize].to_vec())
}

/// 将字符串转为 PCWSTR（含 null 终止符）
fn to_pcwstr(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
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
        let mut data_buf = [0u8; 1040];
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
            // REG_SZ 数据：UTF-16 含 null 终止符，字节切片
            let data =
                std::slice::from_raw_parts(exe_path.as_ptr() as *const u8, exe_path.len() * 2);
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
    fn test_ai_config_default() {
        let config = AiConfig::default();
        assert!(config.api_key.is_empty());
        assert_eq!(config.base_url, "https://api.anthropic.com");
        assert_eq!(config.model, "claude-sonnet-4-20250514");
        assert_eq!(config.api_type, "anthropic");
    }

    #[test]
    fn test_app_config_default_uses_feature_defaults() {
        let config = AppConfig::default();
        assert!(config.screenshot_enabled);
        assert!(config.text_toolbar_enabled);
        assert_eq!(config.system_monitor_interval_ms, 1000);
        assert!(!config.stt_enabled);
        assert!(!config.system_monitor_enabled);
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
        let tmp = std::env::temp_dir().join(format!("floast_test_{}", std::process::id()));
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
        let tmp = std::env::temp_dir().join(format!("floast_test_clear_{}", std::process::id()));
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
        let tmp = std::env::temp_dir().join(format!("floast_test_md5_{}", std::process::id()));
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
            std::env::temp_dir().join(format!("floast_test_numbering_{}", std::process::id()));
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
            std::env::temp_dir().join(format!("floast_test_clearopts_{}", std::process::id()));
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
    fn test_tts_config_default_and_roundtrip() {
        // 默认值为空串（前端取默认配置）
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
        let tmp = std::env::temp_dir().join(format!("floast_test_tts_{}", std::process::id()));
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

    /// 测试 stt 字段默认值与 serde 往返
    #[test]
    fn test_stt_fields_default_and_roundtrip() {
        // 默认值：enabled=false, hotkey="", config="", api_key=""
        let config = AppConfig::default();
        assert!(!config.stt_enabled);
        assert_eq!(config.stt_hotkey, "");
        assert_eq!(config.stt_config, "");
        assert_eq!(config.stt_api_key, "");
        assert_eq!(config.stt_api_key_encrypted, None);

        let config = AppConfig {
            stt_enabled: true,
            stt_hotkey: "Ctrl+Shift+S".to_string(),
            stt_config: r#"{"provider":"openai","baseUrl":"https://api.openai.com","model":"whisper-1","autoPaste":true}"#.to_string(),
            ..Default::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("stt_enabled"));
        assert!(json.contains("stt_hotkey"));
        assert!(json.contains("stt_config"));
        // stt_api_key 是 skip_serializing，不应出现在 json
        assert!(!json.contains("stt_api_key\":"));
        let decoded: AppConfig = serde_json::from_str(&json).unwrap();
        assert!(decoded.stt_enabled);
        assert_eq!(decoded.stt_hotkey, "Ctrl+Shift+S");
        assert!(decoded.stt_config.contains("whisper-1"));
    }

    /// 测试旧配置文件（无 stt 字段）加载时取默认值
    #[test]
    fn test_stt_fields_missing_defaults() {
        let json = r#"{"ai":{"api_key":"","base_url":"","model":"","api_type":"anthropic"}}"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert!(!config.stt_enabled);
        assert_eq!(config.stt_hotkey, "");
        assert_eq!(config.stt_config, "");
        assert_eq!(config.stt_api_key, "");
    }

    /// 测试 ConfigManager 持久化 stt 字段的保存与加载
    #[test]
    fn test_config_manager_stt_save_load() {
        let tmp = std::env::temp_dir().join(format!("floast_test_stt_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let config_path = tmp.join("config.json");

        let manager = ConfigManager {
            config: Mutex::new(AppConfig::default()),
            config_path: config_path.clone(),
        };

        manager.update_stt_enabled(true).unwrap();
        assert!(manager.get_stt_enabled().unwrap());
        manager
            .update_stt_hotkey("Ctrl+Shift+S".to_string())
            .unwrap();
        assert_eq!(manager.get_stt_hotkey().unwrap(), "Ctrl+Shift+S");
        let payload = r#"{"provider":"openai","baseUrl":"https://api.openai.com","model":"whisper-1","autoPaste":false}"#.to_string();
        manager.update_stt_config(payload.clone()).unwrap();
        assert_eq!(manager.get_stt_config().unwrap(), payload);

        // 重新加载验证持久化
        let loaded = ConfigManager::load_config(&config_path);
        assert!(loaded.stt_enabled);
        assert_eq!(loaded.stt_hotkey, "Ctrl+Shift+S");
        assert_eq!(loaded.stt_config, payload);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 测试 STT API Key 的加密存储与解密加载
    #[test]
    fn test_config_manager_stt_api_key_encrypted() {
        let tmp = std::env::temp_dir().join(format!("floast_test_sttkey_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let config_path = tmp.join("config.json");

        let manager = ConfigManager {
            config: Mutex::new(AppConfig::default()),
            config_path: config_path.clone(),
        };

        // 设置 STT API Key 并保存
        manager
            .update_stt_api_key("sk-stt-secret-123".to_string())
            .unwrap();

        // 验证文件中不含明文 key，含加密字段
        let file_content = std::fs::read_to_string(&config_path).unwrap();
        assert!(
            !file_content.contains("sk-stt-secret-123"),
            "文件中不应包含明文 STT API Key"
        );
        assert!(
            file_content.contains("stt_api_key_encrypted"),
            "文件应包含加密字段"
        );

        // 运行时可读明文
        assert_eq!(manager.get_stt_api_key().unwrap(), "sk-stt-secret-123");

        // 重新加载验证解密
        let loaded = ConfigManager::load_config(&config_path);
        assert_eq!(loaded.stt_api_key, "sk-stt-secret-123");

        // 清空 key 后加密字段应被移除
        manager.update_stt_api_key(String::new()).unwrap();
        let file_content = std::fs::read_to_string(&config_path).unwrap();
        assert!(
            !file_content.contains("stt_api_key_encrypted"),
            "清空后加密字段应移除"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
