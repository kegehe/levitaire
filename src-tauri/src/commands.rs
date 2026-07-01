use tauri::State;
use tauri::Manager;

use crate::clipboard::ClipboardManager;
use crate::automation::SelectionInfo;
use crate::config::ConfigManager;

#[tauri::command]
pub fn get_selection() -> Result<Option<SelectionInfo>, String> {
    crate::utils::logger::log("commands", "get_selection command called");
    let result = crate::automation::get_current_selection()
        .map_err(|e| e.to_string());
    crate::utils::logger::log("commands", &format!("get_selection result: {:?}", result));
    result
}

#[tauri::command]
pub fn copy_text(text: String, clipboard: State<'_, ClipboardManager>) -> Result<(), String> {
    clipboard.copy(&text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_toolbar_position() -> Result<crate::automation::Point, String> {
    crate::automation::get_mouse_position()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_toolbar(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("toolbar") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    crate::hooks::set_toolbar_visible(true);
    Ok(())
}

#[tauri::command]
pub fn hide_toolbar(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("toolbar") {
        window.hide().map_err(|e| e.to_string())?;
    }
    // 同步后端工具栏可见状态
    crate::hooks::set_toolbar_visible(false);
    Ok(())
}

#[tauri::command]
pub fn show_orb(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("orb") {
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn hide_orb(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("orb") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn show_settings(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// prompt 最大长度限制（字节数，String::len() 返回 UTF-8 字节数）
const MAX_PROMPT_LENGTH: usize = 100000;

/// 调用 AI 接口
#[tauri::command]
pub async fn call_ai(
    prompt: String,
    system_prompt: Option<String>,
    ai_service: State<'_, crate::ai::AiService>,
) -> Result<crate::ai::AiResponse, String> {
    crate::utils::logger::log("commands", &format!("call_ai 命令被调用, prompt 长度: {} 字节", prompt.len()));
    if prompt.len() > MAX_PROMPT_LENGTH {
        return Err(format!("prompt 长度超过限制（最大 {} 字节）", MAX_PROMPT_LENGTH));
    }
    if prompt.is_empty() {
        return Err("prompt 不能为空".to_string());
    }
    ai_service.call(&prompt, system_prompt.as_deref()).await
}

/// 获取当前 AI 配置
#[tauri::command]
pub fn get_ai_config(
    config_manager: State<'_, ConfigManager>,
) -> Result<crate::config::AiConfig, String> {
    config_manager.get_ai_config()
}

/// 更新 AI 配置
#[tauri::command]
pub fn update_ai_config(
    new_config: crate::config::AiConfig,
    ai_service: State<'_, crate::ai::AiService>,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    crate::utils::logger::log("commands", "更新 AI 配置");
    // 先更新内存中的 AiService（如果失败可以安全返回错误，不会有不一致状态）
    ai_service.update_config(new_config.clone())?;
    // 内存更新成功后再持久化到配置文件
    config_manager.update_ai_config(new_config)?;
    Ok(())
}

/// 替换选中文字
#[tauri::command]
pub async fn replace_selection(text: String) -> Result<(), String> {
    crate::utils::logger::log("commands", &format!("replace_selection 命令被调用, 新文本长度: {} 字节", text.len()));
    if text.is_empty() {
        return Err("替换文本不能为空".to_string());
    }
    // 在后台线程执行，避免 SendMessageW 阻塞主线程
    tokio::task::spawn_blocking(move || {
        crate::automation::replace_selection_text(&text)
    }).await.map_err(|e| format!("替换任务执行失败: {}", e))?
}

/// 获取开机自启动状态
#[tauri::command]
pub fn get_auto_start() -> bool {
    crate::config::get_auto_start()
}

/// 设置开机自启动
#[tauri::command]
pub fn set_auto_start(enable: bool) -> Result<(), String> {
    crate::config::set_auto_start(enable)
}
