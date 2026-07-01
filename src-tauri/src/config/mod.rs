use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use windows::Win32::System::Registry::*;
use windows::Win32::Foundation::ERROR_SUCCESS;

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
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    pub ai: AiConfig,
    /// DPAPI 加密后的 API Key（十六进制编码），与 ai.api_key 互斥存储
    /// 加载时自动解密填入 ai.api_key；保存时自动加密填入此字段，清空 ai.api_key
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_encrypted: Option<String>,
}

/// 配置管理器（线程安全）
pub struct ConfigManager {
    config: Mutex<AppConfig>,
    config_path: PathBuf,
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
                                .and_then(|decrypted| String::from_utf8(decrypted).map_err(|e| format!("UTF-8 解码失败: {}", e)))
                            {
                                Ok(api_key) => {
                                    config.ai.api_key = api_key;
                                    crate::utils::logger::log("config", "已从加密字段解密 API Key");
                                }
                                Err(e) => {
                                    crate::utils::logger::log("config", &format!("解密 API Key 失败: {}", e));
                                }
                            }
                        }
                        // 兼容旧格式：api_key 明文存储，首次保存后会自动升级为加密格式
                        crate::utils::logger::log("config", "配置文件加载成功");
                        return config;
                    }
                    Err(e) => {
                        crate::utils::logger::log("config", &format!("配置文件解析失败: {}, 使用默认配置", e));
                    }
                },
                Err(e) => {
                    crate::utils::logger::log("config", &format!("配置文件读取失败: {}, 使用默认配置", e));
                }
            }
        }
        crate::utils::logger::log("config", "使用默认配置");
        AppConfig::default()
    }

    /// 保存配置到文件（在锁内克隆数据，释放锁后再做序列化和 IO，避免持锁阻塞）
    /// 自动将 api_key 明文加密后存储，内存中保留明文供运行时使用
    fn save_config(&self) -> Result<(), String> {
        let mut config_to_save = self.config.lock().map_err(|e| format!("获取配置锁失败: {}", e))?.clone();

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

        let content = serde_json::to_string_pretty(&config_to_save).map_err(|e| format!("序列化配置失败: {}", e))?;
        fs::write(&self.config_path, content).map_err(|e| format!("写入配置文件失败: {}", e))?;
        crate::utils::logger::log("config", "配置文件保存成功");
        Ok(())
    }

    /// 获取 AI 配置的快照
    pub fn get_ai_config(&self) -> Result<AiConfig, String> {
        self.config.lock().map_err(|e| format!("获取配置锁失败: {}", e)).map(|c| c.ai.clone())
    }

    /// 更新 AI 配置
    pub fn update_ai_config(&self, new_ai_config: AiConfig) -> Result<(), String> {
        {
            let mut config = self.config.lock().map_err(|e| format!("获取配置锁失败: {}", e))?;
            config.ai = new_ai_config;
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
            let data = std::slice::from_raw_parts(exe_path.as_ptr() as *const u8, exe_path.len() * 2);
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
            ai: AiConfig { api_key: "".to_string(), ..Default::default() },
            api_key_encrypted: Some("deadbeef".to_string()),
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
        assert!(!file_content.contains("sk-test-secret-key"), "文件中不应包含明文 API Key");
        assert!(file_content.contains("api_key_encrypted"), "文件应包含加密字段");

        // 重新加载，验证能正确解密
        let loaded = ConfigManager::load_config(&config_path);
        assert_eq!(loaded.ai.api_key, "sk-test-secret-key", "重新加载后 API Key 应正确解密");

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
        manager.update_ai_config(AiConfig { api_key: "".to_string(), ..Default::default() }).unwrap();

        let file_content = std::fs::read_to_string(&config_path).unwrap();
        assert!(!file_content.contains("api_key_encrypted"), "清空 Key 后加密字段应被移除");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
