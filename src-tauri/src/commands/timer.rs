use super::*;


#[tauri::command]
pub fn show_timer_window(
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let win = app
        .get_webview_window("time-overlay")
        .ok_or_else(|| "time-overlay 窗口未找到".to_string())?;
    if !TIMER_CLOSE_HANDLER_REGISTERED.swap(true, Ordering::SeqCst) {
        let win_on_close = win.clone();
        win.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = win_on_close.hide();
            }
            // 窗口真被销毁（异常路径，或将来某条显式 destroy）时复位注册标记。
            // 不复位的话，重建后的同名窗口会以为「已经注册过」而跳过注册 ——
            // 那时 Alt+F4 会直接关窗而不是隐藏，窗口上的状态复位也跟着丢。
            // 写法与 monitor / utility-hub / screenshot-overlay 一致。
            tauri::WindowEvent::Destroyed => {
                TIMER_CLOSE_HANDLER_REGISTERED.store(false, Ordering::SeqCst);
            }
            _ => {}
        });
    }
    if !win.is_visible().unwrap_or(true) {
        if let Ok(Some(pos)) = config_manager.get_window_position("time-overlay") {
            let inner = win.inner_size().unwrap_or_default();
            let (x, y) = clamp_position_to_workarea(pos.x, pos.y, inner.width as i32, inner.height as i32);
            win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)))
                .map_err(|e| e.to_string())?;
        }
    }
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}


#[tauri::command]
pub fn hide_timer_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("time-overlay") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}


#[tauri::command]
pub fn get_timer_enabled(config_manager: State<'_, ConfigManager>) -> Result<bool, String> {
    config_manager.get_timer_enabled()
}


#[tauri::command]
pub fn set_timer_enabled(enabled: bool, app: tauri::AppHandle, config_manager: State<'_, ConfigManager>) -> Result<(), String> {
    if !enabled {
        if let Some(state) = app.try_state::<crate::timer::TimerState>() {
            let payload = state.pause_all();
            let _ = app.emit("timers-changed", &payload);
        }
        // 番茄钟是时间工具的一个页签，工具被禁用时一并停止它的计时并同步 UI，
        // 否则后端会继续跑计时（到点还会提醒），但用户已经没有任何入口看到它。
        if let Some(pomodoro) = app.try_state::<crate::pomodoro::PomodoroState>() {
            pomodoro.stop();
            let _ = app.emit("pomodoro-tick", pomodoro.payload());
        }
        if let Some(window) = app.get_webview_window("time-overlay") { let _ = window.hide(); }
    }
    config_manager.update_timer_enabled(enabled)
}


#[tauri::command]
pub fn get_timer_reminders_enabled(config_manager: State<'_, ConfigManager>) -> Result<bool, String> {
    config_manager.get_timer_reminders_enabled()
}


#[tauri::command]
pub fn set_timer_reminders_enabled(enabled: bool, config_manager: State<'_, ConfigManager>) -> Result<(), String> {
    config_manager.update_timer_reminders_enabled(enabled)
}


#[tauri::command]
pub fn get_timer_reminder_sound(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_timer_reminder_sound()
}


#[tauri::command]
pub fn set_timer_reminder_sound(sound: String, config_manager: State<'_, ConfigManager>) -> Result<(), String> {
    config_manager.update_timer_reminder_sound(sound)
}


#[tauri::command]
pub fn get_timer_lunar_enabled(config_manager: State<'_, ConfigManager>) -> Result<bool, String> {
    config_manager.get_timer_lunar_enabled()
}


#[tauri::command]
pub fn set_timer_lunar_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_timer_lunar_enabled(enabled)?;
    let _ = app.emit("timer-lunar-enabled-changed", enabled);
    Ok(())
}


// ─── 时钟与计时 ───────────────────────────────────────────────

#[tauri::command]
pub fn get_timers(
    state: State<'_, crate::timer::TimerState>,
) -> Result<crate::timer::TimersPayload, String> {
    Ok(state.payload())
}


#[tauri::command]
pub fn create_timer(
    input: crate::timer::CreateTimerInput,
    app: tauri::AppHandle,
    state: State<'_, crate::timer::TimerState>,
) -> Result<crate::timer::TimersPayload, String> {
    let payload = state.create(input)?;
    let _ = app.emit("timers-changed", &payload);
    Ok(payload)
}


#[tauri::command]
pub fn delete_timer(
    id: String,
    app: tauri::AppHandle,
    state: State<'_, crate::timer::TimerState>,
) -> Result<crate::timer::TimersPayload, String> {
    let payload = state.delete(&id)?;
    let _ = app.emit("timers-changed", &payload);
    Ok(payload)
}


#[tauri::command]
pub fn set_timer_duration(
    id: String,
    seconds: u64,
    app: tauri::AppHandle,
    state: State<'_, crate::timer::TimerState>,
) -> Result<crate::timer::TimersPayload, String> {
    let payload = state.set_duration(&id, seconds)?;
    let _ = app.emit("timers-changed", &payload);
    Ok(payload)
}


#[tauri::command]
pub fn rename_timer(id: String, label: String, app: tauri::AppHandle, state: State<'_, crate::timer::TimerState>) -> Result<crate::timer::TimersPayload, String> {
    let payload = state.rename(&id, label)?;
    let _ = app.emit("timers-changed", &payload);
    Ok(payload)
}


#[tauri::command]
pub fn add_timer_lap(id: String, app: tauri::AppHandle, state: State<'_, crate::timer::TimerState>) -> Result<crate::timer::TimersPayload, String> {
    let payload = state.add_lap(&id)?;
    let _ = app.emit("timers-changed", &payload);
    Ok(payload)
}


#[tauri::command]
pub fn start_timer(id: String, app: tauri::AppHandle, state: State<'_, crate::timer::TimerState>) -> Result<crate::timer::TimersPayload, String> {
    let payload = state.start(&id)?;
    let _ = app.emit("timers-changed", &payload);
    Ok(payload)
}


#[tauri::command]
pub fn pause_timer(id: String, app: tauri::AppHandle, state: State<'_, crate::timer::TimerState>) -> Result<crate::timer::TimersPayload, String> {
    let payload = state.pause(&id)?;
    let _ = app.emit("timers-changed", &payload);
    Ok(payload)
}


#[tauri::command]
pub fn reset_timer(id: String, app: tauri::AppHandle, state: State<'_, crate::timer::TimerState>) -> Result<crate::timer::TimersPayload, String> {
    let payload = state.reset(&id)?;
    let _ = app.emit("timers-changed", &payload);
    Ok(payload)
}


#[tauri::command]
pub fn add_timer_seconds(id: String, seconds: u64, app: tauri::AppHandle, state: State<'_, crate::timer::TimerState>) -> Result<crate::timer::TimersPayload, String> {
    let payload = state.add_seconds(&id, seconds)?;
    let _ = app.emit("timers-changed", &payload);
    Ok(payload)
}
