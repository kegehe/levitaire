use tauri::State;
use tauri::Manager;
use tauri::Emitter;

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

/// 通过恢复原始窗口焦点 + 模拟 Ctrl+C 来复制选区内容
/// 这样可以保留富文本、图片等完整格式
#[tauri::command]
pub async fn copy_selection() -> Result<(), String> {
    crate::utils::logger::log("commands", "copy_selection called (simulate Ctrl+C)");
    tokio::task::spawn_blocking(|| {
        crate::automation::copy_selection_via_simulation()
    }).await.map_err(|e| format!("copy_selection task failed: {}", e))?
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
    // 隐藏窗口前，先恢复前台窗口焦点
    // 工具栏按钮点击后焦点可能在工具栏上，直接隐藏会导致 Windows 重新分配焦点，
    // 可能清除目标应用中刚恢复的文本选区
    if let Some(ctx) = crate::automation::get_stored_selection_context() {
        if ctx.foreground_hwnd != 0 {
            unsafe {
                let hwnd = windows::Win32::Foundation::HWND(ctx.foreground_hwnd as *mut std::ffi::c_void);
                let _ = windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);
            }
        }
    }
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

/// 流式调用 AI 接口，通过事件推送文本片段
#[tauri::command]
pub async fn call_ai_stream(
    app: tauri::AppHandle,
    prompt: String,
    system_prompt: Option<String>,
    ai_service: State<'_, crate::ai::AiService>,
) -> Result<(), String> {
    crate::utils::logger::log("commands", &format!("call_ai_stream 命令被调用, prompt 长度: {} 字节", prompt.len()));
    if prompt.len() > MAX_PROMPT_LENGTH {
        let _ = app.emit("ai-stream", serde_json::json!({ "type": "error", "data": format!("prompt 长度超过限制（最大 {} 字节）", MAX_PROMPT_LENGTH) }));
        return Err(format!("prompt 长度超过限制（最大 {} 字节）", MAX_PROMPT_LENGTH));
    }
    if prompt.is_empty() {
        let _ = app.emit("ai-stream", serde_json::json!({ "type": "error", "data": "prompt 不能为空" }));
        return Err("prompt 不能为空".to_string());
    }

    let app_handle = app.clone();
    let result = ai_service.call_stream(&prompt, system_prompt.as_deref(), move |chunk| {
        let _ = app_handle.emit("ai-stream", serde_json::json!({ "type": "chunk", "data": chunk }));
    }).await;

    match result {
        Ok(_) => {
            let _ = app.emit("ai-stream", serde_json::json!({ "type": "done" }));
            Ok(())
        }
        Err(e) => {
            let _ = app.emit("ai-stream", serde_json::json!({ "type": "error", "data": &e }));
            Err(e)
        }
    }
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

/// 打开 URL（用默认浏览器）
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    crate::utils::logger::log("commands", &format!("open_url: {}", url));
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {}", e))?;
    }
    Ok(())
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

/// 设置二维码预览模式
/// 为 true 时鼠标点击工具栏外部不会隐藏窗口
#[tauri::command]
pub fn set_qrcode_preview(active: bool) {
    crate::hooks::mouse::set_qrcode_preview(active);
}

/// 弹出系统保存对话框，将 base64 编码的 PNG 数据保存为文件
#[tauri::command]
pub async fn save_image(app: tauri::AppHandle, base64_data: String, filename: String) -> Result<bool, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    // 去除 data:image/png;base64, 前缀
    let raw = if let Some(idx) = base64_data.find(',') {
        &base64_data[idx + 1..]
    } else {
        &base64_data
    };

    let bytes = STANDARD.decode(raw)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    // 临时移除 toolbar 的 always-on-top，防止对话框被遮挡
    if let Some(win) = app.get_webview_window("toolbar") {
        let _ = win.set_always_on_top(false);
    }

    let result = tokio::task::spawn_blocking(move || {
        let path = rfd::FileDialog::new()
            .set_file_name(&filename)
            .add_filter("PNG 图片", &["png"])
            .save_file();

        match path {
            Some(path) => {
                std::fs::write(&path, &bytes)
                    .map_err(|e| format!("写入文件失败: {}", e))?;
                Ok(true)
            }
            None => Ok(false),
        }
    }).await.map_err(|e| format!("任务执行失败: {}", e))?;

    // 恢复 toolbar 的 always-on-top
    if let Some(win) = app.get_webview_window("toolbar") {
        let _ = win.set_always_on_top(true);
    }

    result
}
