use super::*;


/// 显示系统监控悬浮窗（优先恢复到上次记忆位置，未记忆时跟随鼠标，多显示器边界翻转）
/// 并启动采集线程
#[tauri::command]
pub fn show_monitor_window(
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let win = app
        .get_webview_window("monitor-overlay")
        .ok_or_else(|| "monitor-overlay 窗口未找到".to_string())?;
    // Use the saved mode before showing so the window never flashes at the wrong size.
    let is_mini = config_manager
        .get_system_monitor_config()
        .ok()
        .and_then(|config| serde_json::from_str::<serde_json::Value>(&config).ok())
        .and_then(|config| config.get("displayMode")?.as_str().map(str::to_owned))
        .is_some_and(|mode| mode == "mini");
    let (width, height) = if is_mini {
        (300.0, 180.0)
    } else {
        (300.0, 520.0)
    };
    win.set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    // 拦截关闭：停止采集并隐藏，保留窗口实例供下次打开复用。
    // 前端现复用窗口（不再每次销毁重建），监听器随窗口长期有效，故只注册一次；
    // 若窗口仍被真正销毁（异常路径），其上的监听器随之失效，此处监听 Destroyed
    // 复位注册标记，使新建窗口能重新注册拦截——否则 Alt+F4 会直接关窗而不停采，
    // 后台采集线程空跑。与 screenshot overlay 的关闭拦截处理方式一致。
    if MONITOR_CLOSE_HANDLER_REGISTERED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let win_on_close = win.clone();
        let app_on_close = app.clone();
        win.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if let Some(state) = app_on_close.try_state::<crate::monitor::MonitorState>() {
                    state.stop();
                }
                let _ = win_on_close.hide();
            }
            tauri::WindowEvent::Destroyed => {
                MONITOR_CLOSE_HANDLER_REGISTERED.store(false, Ordering::SeqCst);
            }
            _ => {}
        });
    }
    let inner = win.inner_size().unwrap_or_default();
    let ww = inner.width as i32;
    let wh = inner.height as i32;

    // 锚点：优先恢复上次拖拽后的记忆位置，未记忆时跟随鼠标，偏移 8px
    let saved = config_manager
        .get_window_position("monitor-overlay")
        .ok()
        .flatten();
    let (mut x, mut y) = if let Some(pos) = saved {
        (pos.x, pos.y)
    } else if let Ok(cur) = crate::automation::get_mouse_position() {
        (cur.x + 8, cur.y + 8)
    } else {
        (100, 100)
    };

    // 边界翻转：不超过该点所在显示器工作区
    (x, y) = clamp_position_to_workarea(x, y, ww, wh);

    let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        x, y,
    )));
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;

    // 启动采集线程前，从配置同步刷新间隔（避免 state 默认值与用户配置不符）
    if let Some(state) = app.try_state::<crate::monitor::MonitorState>() {
        if let Ok(interval) = config_manager.get_system_monitor_interval_ms() {
            if interval >= 200 {
                state.set_interval(interval);
            }
        }
        state.start(&app);
    }
    Ok(())
}


/// 隐藏系统监控悬浮窗并停止采集线程。窗口保留以避免再次打开时与销毁竞态。
#[tauri::command]
pub fn hide_monitor_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<crate::monitor::MonitorState>() {
        state.stop();
    }
    if let Some(window) = app.get_webview_window("monitor-overlay") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}


/// 获取系统监控工具启用状态
#[tauri::command]
pub fn get_system_monitor_enabled(
    config_manager: State<'_, ConfigManager>,
) -> Result<bool, String> {
    config_manager.get_system_monitor_enabled()
}


/// 设置系统监控工具启用状态并持久化。禁用时停采并隐藏窗口，避免重启销毁竞态。
#[tauri::command]
pub fn set_system_monitor_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    if !enabled {
        if let Some(state) = app.try_state::<crate::monitor::MonitorState>() {
            state.stop();
        }
        if let Some(window) = app.get_webview_window("monitor-overlay") {
            let _ = window.hide();
        }
    }
    config_manager.update_system_monitor_enabled(enabled)
}


/// 获取系统监控配置（JSON 字符串，空串表示未设置）
#[tauri::command]
pub fn get_system_monitor_config(
    config_manager: State<'_, ConfigManager>,
) -> Result<String, String> {
    config_manager.get_system_monitor_config()
}


/// 更新系统监控配置并持久化。解析 intervalMs 即时生效（无需重启采集线程）
#[tauri::command]
pub fn set_system_monitor_config(
    config: String,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    // 解析 intervalMs 即时下发到采集线程
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&config) {
        if let Some(ms) = parsed.get("intervalMs").and_then(|v| v.as_u64()) {
            if let Some(state) = app.try_state::<crate::monitor::MonitorState>() {
                state.set_interval(ms);
            }
            let _ = config_manager.update_system_monitor_interval_ms(ms);
        }
    }
    config_manager.update_system_monitor_config(config)
}
