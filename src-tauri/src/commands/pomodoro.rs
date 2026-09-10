use super::*;


// ─── 番茄钟 ────────────────────────────────────────────────────

/// 显示番茄钟悬浮窗。关闭拦截仅隐藏窗口、不停计时（窗口隐藏后倒计时继续，
/// 到点提醒由后端完成，不依赖窗口可见）。
#[tauri::command]
pub fn show_pomodoro_window(
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let win = app
        .get_webview_window("pomodoro-overlay")
        .ok_or_else(|| "pomodoro-overlay 窗口未找到".to_string())?;
    // Keep the overlay size fixed now that the display mode has been removed.
    win.set_size(tauri::LogicalSize::new(240.0, 240.0))
        .map_err(|e| e.to_string())?;
    // 拦截关闭：仅隐藏，不停计时。窗口复用后监听器也会保留，因此只注册一次。
    if !POMODORO_CLOSE_HANDLER_REGISTERED.swap(true, Ordering::SeqCst) {
        let win_on_close = win.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = win_on_close.hide();
            }
        });
    }
    // 恢复上次拖拽后的记忆位置（窗口销毁重建后仍保持），未记忆时使用创建默认值。
    // 仅窗口隐藏时恢复，避免覆盖用户已摆好/正在拖动的位置；裁剪到显示器工作区，
    // 防止分辨率/显示器布局变化后窗口跑到屏幕外
    if !win.is_visible().unwrap_or(true) {
        if let Ok(Some(pos)) = config_manager.get_window_position("pomodoro-overlay") {
            let inner = win.inner_size().unwrap_or_default();
            let (x, y) =
                clamp_position_to_workarea(pos.x, pos.y, inner.width as i32, inner.height as i32);
            win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
                x, y,
            )))
            .map_err(|e| e.to_string())?;
        }
    }
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}


/// 隐藏番茄钟悬浮窗。计时不停止（与系统监控不同）。
#[tauri::command]
pub fn hide_pomodoro_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("pomodoro-overlay") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}


/// 获取番茄钟当前状态（窗口重开/初始化时拉取，前端据此恢复渲染）
#[tauri::command]
pub fn get_pomodoro_state(
    state: State<'_, crate::pomodoro::PomodoroState>,
) -> Result<crate::pomodoro::PomodoroStatePayload, String> {
    Ok(state.payload())
}


/// 开始/继续番茄钟倒计时
#[tauri::command]
pub fn start_pomodoro(
    app: tauri::AppHandle,
    state: State<'_, crate::pomodoro::PomodoroState>,
) -> Result<(), String> {
    state.start(&app);
    Ok(())
}


/// 暂停番茄钟倒计时（保留剩余时间）
#[tauri::command]
pub fn pause_pomodoro(
    app: tauri::AppHandle,
    state: State<'_, crate::pomodoro::PomodoroState>,
) -> Result<(), String> {
    state.pause();
    let _ = app.emit("pomodoro-tick", state.payload());
    Ok(())
}


/// 重置当前阶段倒计时
#[tauri::command]
pub fn reset_pomodoro(
    app: tauri::AppHandle,
    state: State<'_, crate::pomodoro::PomodoroState>,
) -> Result<(), String> {
    state.reset();
    let _ = app.emit("pomodoro-tick", state.payload());
    Ok(())
}


/// 跳过当前阶段进入下一阶段（计时中则继续计时新阶段）
#[tauri::command]
pub fn skip_pomodoro(
    app: tauri::AppHandle,
    state: State<'_, crate::pomodoro::PomodoroState>,
) -> Result<(), String> {
    let was_running = state.skip();
    if was_running {
        state.start(&app);
    } else {
        let _ = app.emit("pomodoro-tick", state.payload());
    }
    Ok(())
}


/// 获取番茄钟工具启用状态
#[tauri::command]
pub fn get_pomodoro_enabled(config_manager: State<'_, ConfigManager>) -> Result<bool, String> {
    config_manager.get_pomodoro_enabled()
}


/// 设置番茄钟工具启用状态并持久化。禁用时停止计时并隐藏窗口。
#[tauri::command]
pub fn set_pomodoro_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    if !enabled {
        if let Some(state) = app.try_state::<crate::pomodoro::PomodoroState>() {
            state.stop();
            // 通知番茄钟窗口同步停止状态（窗口隐藏时 JS 仍在运行，可收到事件；
            // 否则重新打开后 UI 会停留在旧的运行态）
            let _ = app.emit("pomodoro-tick", state.payload());
        }
        if let Some(window) = app.get_webview_window("pomodoro-overlay") {
            let _ = window.hide();
        }
    }
    config_manager.update_pomodoro_enabled(enabled)
}


/// 获取番茄钟配置（JSON 字符串，空串表示未设置，前端取默认值）
#[tauri::command]
pub fn get_pomodoro_config(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_pomodoro_config()
}


/// 更新番茄钟配置并持久化。解析成功时即时同步到计时状态（不中断计时）。
#[tauri::command]
pub fn set_pomodoro_config(
    config: String,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    if let Ok(parsed) = serde_json::from_str::<crate::pomodoro::PomodoroConfig>(&config) {
        if let Some(state) = app.try_state::<crate::pomodoro::PomodoroState>() {
            state.set_config(parsed);
        }
    }
    config_manager.update_pomodoro_config(config)
}
