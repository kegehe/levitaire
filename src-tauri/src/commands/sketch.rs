use super::*;


#[tauri::command]
pub fn get_sketch_hotkey(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_sketch_hotkey()
}


#[tauri::command]
pub fn set_sketch_hotkey(
    hotkey: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let trimmed = hotkey.trim().to_string();
    let previous = config_manager.get_sketch_hotkey()?;
    let slot = crate::hooks::hotkey::HotkeySlotId::Sketch;
    if trimmed.is_empty() {
        crate::hooks::hotkey::unregister_hotkey(slot);
        if let Err(error) = config_manager.update_sketch_hotkey(String::new()) {
            if !previous.is_empty() {
                let _ = crate::hooks::hotkey::register_hotkey(slot, &previous);
            }
            return Err(error);
        }
        return Ok(());
    }
    crate::hooks::hotkey::register_hotkey(slot, &trimmed)?;
    if let Err(error) = config_manager.update_sketch_hotkey(trimmed) {
        let _ = config_manager.update_sketch_hotkey(previous.clone());
        crate::hooks::hotkey::unregister_hotkey(slot);
        if !previous.is_empty() {
            let _ = crate::hooks::hotkey::register_hotkey(slot, &previous);
        }
        return Err(error);
    }
    Ok(())
}


#[tauri::command]
pub fn show_sketch_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("sketch-overlay")
        .ok_or_else(|| "草稿窗口尚未创建".to_string())?;
    if SKETCH_CLOSE_HANDLER_REGISTERED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let app_for_window = app.clone();
        window.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                crate::utils::logger::log(
                    "sketch",
                    "CloseRequested intercepted; hiding sketch window",
                );
                if let Some(sketch) = app_for_window.get_webview_window("sketch-overlay") {
                    let _ = sketch.hide();
                }
            }
            tauri::WindowEvent::Destroyed => {
                SKETCH_CLOSE_HANDLER_REGISTERED.store(false, Ordering::SeqCst);
                crate::utils::logger::log("sketch", "sketch window destroyed");
            }
            _ => {}
        });
    }
    crate::utils::logger::log("sketch", "show_sketch_window");
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}


#[tauri::command]
pub fn hide_sketch_window(app: tauri::AppHandle) -> Result<(), String> {
    SKETCH_VISIBLE_BEFORE_SESSION.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("sketch-overlay") {
        crate::utils::logger::log("sketch", "hide_sketch_window");
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}


#[tauri::command]
pub fn get_sketch_enabled(config_manager: State<'_, ConfigManager>) -> Result<bool, String> {
    config_manager.get_sketch_enabled()
}


#[tauri::command]
pub fn set_sketch_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let previous = config_manager.get_sketch_enabled()?;
    if let Err(error) = config_manager.update_sketch_enabled(enabled) {
        let _ = config_manager.update_sketch_enabled(previous);
        return Err(error);
    }
    crate::hooks::hotkey::set_slot_enabled(crate::hooks::hotkey::HotkeySlotId::Sketch, enabled);
    if !enabled {
        SKETCH_VISIBLE_BEFORE_SESSION.store(false, Ordering::SeqCst);
        if let Some(window) = app.get_webview_window("sketch-overlay") {
            crate::utils::logger::log("sketch", "hiding sketch window because sketch is disabled");
            let _ = window.hide();
        }
    }
    Ok(())
}


#[tauri::command]
pub fn capture_sketch_background(
    app: tauri::AppHandle,
    left: i32,
    top: i32,
    width: i32,
    height: i32,
) -> Result<String, String> {
    if width <= 0 || height <= 0 {
        return Err("草稿背景尺寸无效".to_string());
    }
    if let Some(window) = app.get_webview_window("sketch-overlay") {
        window
            .hide()
            .map_err(|e| format!("隐藏草稿窗口失败: {}", e))?;
        std::thread::sleep(std::time::Duration::from_millis(45));
        let result =
            crate::screenshot::capture_screen_region(left, top, width as u32, height as u32)
                .and_then(|bgra| {
                    crate::screenshot::encode_png_base64(&bgra, width as u32, height as u32)
                });
        window
            .show()
            .map_err(|e| format!("恢复草稿窗口失败: {}", e))?;
        window
            .set_focus()
            .map_err(|e| format!("恢复草稿窗口焦点失败: {}", e))?;
        return result;
    }
    let bgra = crate::screenshot::capture_screen_region(left, top, width as u32, height as u32)?;
    crate::screenshot::encode_png_base64(&bgra, width as u32, height as u32)
}
