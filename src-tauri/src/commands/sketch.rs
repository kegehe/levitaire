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
    // 工具已禁用时不注册：禁用意味着不占用该组合键，等启用时再注册。
    let tool_enabled = config_manager.get_sketch_enabled()?;
    if trimmed.is_empty() {
        crate::hooks::hotkey::unregister_hotkey(slot);
        if let Err(error) = config_manager.update_sketch_hotkey(String::new()) {
            if tool_enabled && !previous.is_empty() {
                let _ = crate::hooks::hotkey::register_hotkey(slot, &previous);
            }
            return Err(error);
        }
        return Ok(());
    }
    if tool_enabled {
        crate::hooks::hotkey::register_hotkey(slot, &trimmed)?;
    }
    if let Err(error) = config_manager.update_sketch_hotkey(trimmed) {
        let _ = config_manager.update_sketch_hotkey(previous.clone());
        if !tool_enabled || previous.is_empty() {
            crate::hooks::hotkey::unregister_hotkey(slot);
        } else {
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
    let slot = crate::hooks::hotkey::HotkeySlotId::Sketch;
    // 先动热键再落盘：禁用时反注册，把组合键还给系统；启用时按配置注册回来。
    let hotkey = config_manager.get_sketch_hotkey().unwrap_or_default();
    if let Err(error) = crate::hooks::hotkey::sync_registration_with_enabled(slot, enabled, &hotkey)
    {
        // 热键注册失败（通常是被其他程序占用）不该拦住工具本身的启用：工具照常可用，
        // 设置页的快捷键自检会把冲突标出来。
        crate::utils::logger::log(
            "hotkey",
            &format!("更新草稿工具启用状态时同步快捷键失败: {}", error),
        );
    }
    if let Err(error) = config_manager.update_sketch_enabled(enabled) {
        let _ = config_manager.update_sketch_enabled(previous);
        // 落盘失败则把热键回滚到切换前的状态
        let _ = crate::hooks::hotkey::sync_registration_with_enabled(slot, previous, &hotkey);
        return Err(error);
    }
    crate::hooks::hotkey::set_slot_enabled(slot, enabled);
    if !enabled {
        SKETCH_VISIBLE_BEFORE_SESSION.store(false, Ordering::SeqCst);
        if let Some(window) = app.get_webview_window("sketch-overlay") {
            crate::utils::logger::log("sketch", "hiding sketch window because sketch is disabled");
            let _ = window.hide();
        }
    }
    Ok(())
}

/// 捕获描稿背景：临时隐藏描稿窗后抓取整个显示器，返回 PNG base64。
///
/// # 必须保持 `async`，且编解码走 `spawn_blocking`
///
/// 前端传的是整个显示器尺寸，全屏 BitBlt + PNG 编码在高分屏上是数百毫秒到秒级的
/// CPU/内存开销。同步命令会跑在主线程，这段开销会阻塞窗口事件循环，让整个应用
/// （含所有 WebView 的 IPC）卡住；编码本身不依赖主线程，因此移到阻塞线程池。
///
/// 隐藏窗口仍必须落在主线程：`hide()` 在主线程是同步的 `ShowWindow(SW_HIDE)`，
/// 跨线程调用只是投递消息。这里用 `is_visible()` 做同步屏障——它与 `hide()` 走
/// 同一条事件循环消息队列（FIFO），返回即证明 `hide()` 已在主线程落地，
/// 避免抓屏抓到尚未隐藏的描稿窗（原实现靠主线程直接 sleep 45ms，语义等价）。
#[tauri::command]
pub async fn capture_sketch_background(
    app: tauri::AppHandle,
    left: i32,
    top: i32,
    width: i32,
    height: i32,
) -> Result<String, String> {
    if width <= 0 || height <= 0 {
        return Err("草稿背景尺寸无效".to_string());
    }
    let overlay = app.get_webview_window("sketch-overlay");
    if let Some(window) = overlay.as_ref() {
        window
            .hide()
            .map_err(|e| format!("隐藏草稿窗口失败: {}", e))?;
        // 同步屏障：确认 hide 已在主线程生效（详见上方注释）
        let _ = window.is_visible();
    }
    let has_overlay = overlay.is_some();

    let result = tokio::task::spawn_blocking(move || {
        if has_overlay {
            // 等合成器真正把窗口移出画面后再抓屏（原实现在主线程 sleep，语义不变）
            std::thread::sleep(std::time::Duration::from_millis(45));
        }
        crate::screenshot::capture_screen_region(left, top, width as u32, height as u32).and_then(
            |bgra| crate::screenshot::encode_png_base64(&bgra, width as u32, height as u32),
        )
    })
    .await
    .map_err(|error| format!("描稿背景捕获任务失败: {}", error))?;

    if let Some(window) = overlay.as_ref() {
        window
            .show()
            .map_err(|e| format!("恢复草稿窗口失败: {}", e))?;
        window
            .set_focus()
            .map_err(|e| format!("恢复草稿窗口焦点失败: {}", e))?;
    }

    result
}
