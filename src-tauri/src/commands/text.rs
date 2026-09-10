use super::*;


#[tauri::command]
pub fn get_selection() -> Result<Option<SelectionInfo>, String> {
    crate::utils::logger::log("commands", "get_selection command called");
    let result = crate::automation::get_current_selection().map_err(|e| e.to_string());
    crate::utils::logger::log("commands", &format!("get_selection result: {:?}", result));
    result
}


/// 通过恢复原始窗口焦点 + 模拟 Ctrl+C 来复制选区内容
/// 这样可以保留富文本、图片等完整格式
#[tauri::command]
pub async fn copy_selection() -> Result<(), String> {
    crate::utils::logger::log("commands", "copy_selection called (simulate Ctrl+C)");
    tokio::task::spawn_blocking(crate::automation::copy_selection_via_simulation)
        .await
        .map_err(|e| format!("copy_selection task failed: {}", e))?
}


#[tauri::command]
pub fn get_toolbar_position() -> Result<crate::automation::Point, String> {
    crate::automation::get_mouse_position().map_err(|e| e.to_string())
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
                let hwnd =
                    windows::Win32::Foundation::HWND(ctx.foreground_hwnd as *mut std::ffi::c_void);
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


/// 替换选中文字
#[tauri::command]
pub async fn replace_selection(text: String) -> Result<(), String> {
    crate::utils::logger::log(
        "commands",
        &format!(
            "replace_selection 命令被调用, 新文本长度: {} 字节",
            text.len()
        ),
    );
    if text.is_empty() {
        return Err("替换文本不能为空".to_string());
    }
    // 在后台线程执行，避免 SendMessageW 阻塞主线程
    tokio::task::spawn_blocking(move || crate::automation::replace_selection_text(&text))
        .await
        .map_err(|e| format!("替换任务执行失败: {}", e))?
}


/// 设置文字工具栏启用状态（关闭后选中文本不再弹出），同时持久化到配置
#[tauri::command]
pub fn set_text_toolbar_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let previous = config_manager.get_text_toolbar_enabled()?;
    if let Err(error) = config_manager.update_text_toolbar_enabled(enabled) {
        let _ = config_manager.update_text_toolbar_enabled(previous);
        return Err(error);
    }
    crate::hooks::mouse::set_text_toolbar_enabled(enabled);
    if !enabled {
        if let Some(toolbar) = app.get_webview_window("toolbar") {
            let _ = toolbar.hide();
        }
        crate::hooks::set_toolbar_visible(false);
    }
    Ok(())
}


/// 获取文字工具栏启用状态（供前端卡片开关与后端真值同步）
#[tauri::command]
pub fn get_text_toolbar_enabled(config_manager: State<'_, ConfigManager>) -> Result<bool, String> {
    config_manager.get_text_toolbar_enabled()
}


/// 获取工具栏启用的功能 ID 列表
#[tauri::command]
pub fn get_toolbar_features(
    config_manager: State<'_, ConfigManager>,
) -> Result<Vec<String>, String> {
    config_manager.get_toolbar_features()
}


/// 更新工具栏启用的功能 ID 列表并持久化
#[tauri::command]
pub fn set_toolbar_features(
    features: Vec<String>,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_toolbar_features(features)
}


/// 获取工具栏功能按钮顺序 ID 列表
#[tauri::command]
pub fn get_toolbar_feature_order(
    config_manager: State<'_, ConfigManager>,
) -> Result<Vec<String>, String> {
    config_manager.get_toolbar_feature_order()
}


/// 更新工具栏功能按钮顺序 ID 列表并持久化
#[tauri::command]
pub fn set_toolbar_feature_order(
    order: Vec<String>,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_toolbar_feature_order(order)
}


/// 获取搜索引擎配置（空串表示未设置，前端取默认 Bing）
#[tauri::command]
pub fn get_search_engine(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_search_engine()
}


/// 更新搜索引擎配置并持久化
#[tauri::command]
pub fn set_search_engine(
    engine: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_search_engine(engine)
}


/// 获取去重粒度配置（JSON 字符串，空串表示未设置）
#[tauri::command]
pub fn get_dedup_mode(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_dedup_mode()
}


/// 更新去重粒度配置并持久化
#[tauri::command]
pub fn set_dedup_mode(
    mode: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_dedup_mode(mode)
}


/// 获取 MD5 位数配置（空串表示未设置，前端取默认 32）
#[tauri::command]
pub fn get_md5_length(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_md5_length()
}


/// 更新 MD5 位数配置并持久化
#[tauri::command]
pub fn set_md5_length(
    length: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_md5_length(length)
}


/// 获取编号样式配置（空串表示未设置，前端取默认值）
#[tauri::command]
pub fn get_numbering_style(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_numbering_style()
}


/// 更新编号样式配置并持久化
#[tauri::command]
pub fn set_numbering_style(
    style: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_numbering_style(style)
}


/// 获取清除功能启用的清除项 ID 列表（空列表表示未设置，前端取默认全量）
#[tauri::command]
pub fn get_clear_options(config_manager: State<'_, ConfigManager>) -> Result<Vec<String>, String> {
    config_manager.get_clear_options()
}


/// 更新清除功能启用的清除项 ID 列表并持久化
#[tauri::command]
pub fn set_clear_options(
    options: Vec<String>,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_clear_options(options)
}


/// 朗读文本。参数：text/rate(字/秒)/voice_id(空=默认)/volume(0~1)。
/// 合成在 MTA 子线程执行（同 OCR 模板），MediaPlayer 非阻塞由 TtsState 持有。
/// 异步提交命令：合成在独立 worker 中执行，调用方通过 tts-started/tts-error 事件获知结果。
#[tauri::command]
pub fn tts_speak(
    app: tauri::AppHandle,
    text: String,
    rate: f64,
    voice_id: String,
    volume: f64,
) -> Result<u64, String> {
    crate::utils::logger::log("tts", &format!("tts_speak: {} chars", text.chars().count()));
    if text.trim().is_empty() {
        return Err("朗读文本不能为空".to_string());
    }
    if text.chars().count() > MAX_TTS_CHARS {
        return Err(format!(
            "文本过长（超过 {} 字），暂不支持朗读",
            MAX_TTS_CHARS
        ));
    }
    let state = app.state::<crate::tts::TtsState>();
    let request_id = crate::tts::reserve_request(&state)?;
    let worker_app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = crate::tts::speak(
            worker_app.clone(),
            request_id,
            text,
            rate,
            voice_id,
            volume,
        ) {
            crate::utils::logger::log("tts", &format!("tts_speak failed: {}", error));
            let state = worker_app.state::<crate::tts::TtsState>();
            if crate::tts::is_current_request(&state, request_id) {
                let _ = worker_app.emit(
                    "tts-error",
                    serde_json::json!({
                        "requestId": request_id,
                        "source": "text-toolbar",
                        "error": error,
                    }),
                );
            }
        }
    });
    Ok(request_id)
}


/// 停止朗读（Close 销毁 player；stop 内部在 MTA 线程执行 COM 调用）
#[tauri::command]
pub fn tts_stop(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<crate::tts::TtsState>();
    crate::tts::stop(&state)
}


/// 暂停朗读（pause 内部在 MTA 线程执行 COM 调用）
#[tauri::command]
pub fn tts_pause(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<crate::tts::TtsState>();
    crate::tts::pause(&state)
}


/// 继续朗读（resume 内部在 MTA 线程执行 COM 调用）
#[tauri::command]
pub fn tts_resume(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<crate::tts::TtsState>();
    crate::tts::resume(&state)
}


/// 枚举系统已安装语音（list_voices 内部在 MTA 线程执行）
#[tauri::command]
pub fn tts_get_voices() -> Result<Vec<crate::tts::VoiceInfo>, String> {
    crate::tts::list_voices()
}


/// 查询当前播放态快照（供工具栏恢复 speaking 态；仅读 Mutex 无 COM 调用）
#[tauri::command]
pub fn tts_get_state(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<crate::tts::TtsState>();
    let (playing, paused, has_player) = crate::tts::get_state_snapshot(&state);
    Ok(serde_json::json!({
        "playing": playing,
        "paused": paused,
        "hasPlayer": has_player,
    }))
}


/// 查询朗读进度：(positionMs, durationMs, paused)。
/// durationMs 为 0 表示总时长未知（无限时长，实时流等场景）。
/// 无 player 返回 Err，前端忽略即可。
#[tauri::command]
pub fn tts_get_progress(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<crate::tts::TtsState>();
    match crate::tts::get_progress(&state) {
        Some((pos_ms, dur_ms, paused)) => Ok(serde_json::json!({
            "positionMs": pos_ms,
            "durationMs": dur_ms,
            "paused": paused,
        })),
        None => Err("当前没有正在朗读的音频".to_string()),
    }
}


/// 获取 TTS 朗读配置（JSON 字符串，空串表示未设置，前端取默认值）
#[tauri::command]
pub fn get_tts_config(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_tts_config()
}


/// 更新 TTS 朗读配置并持久化
#[tauri::command]
pub fn set_tts_config(
    config: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_tts_config(config)
}
