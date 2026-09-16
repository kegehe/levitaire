use super::*;


/// Tauri 命令包装：进入录屏选区模式
#[tauri::command]
pub fn start_recording_select(app: tauri::AppHandle) -> Result<(), String> {
    start_recording_select_inner(app)
}


/// 开始录制（区域+模式+fps 已确定）
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn start_recording(
    app: tauri::AppHandle,
    left: i32,
    top: i32,
    width: u32,
    height: u32,
    mode: String,
    fps: u32,
    max_duration_sec: u32,
) -> Result<(), String> {
    if width == 0 || height == 0 || width > 32_768 || height > 32_768 {
        return Err("invalid recording dimensions".to_string());
    }
    let pixels = u64::from(width) * u64::from(height);
    if pixels > 100_000_000 {
        return Err("recording region contains too many pixels".to_string());
    }
    if !(1..=60).contains(&max_duration_sec) {
        return Err("recording duration must be between 1 and 60 seconds".to_string());
    }
    crate::utils::logger::log(
        "recording",
        &format!(
            "start_recording: ({},{}) {}x{}, mode={}, fps={}",
            left, top, width, height, mode, fps
        ),
    );

    let record_mode = match mode.as_str() {
        "gif" => crate::recording::RecordMode::Gif,
        "video" => crate::recording::RecordMode::Video,
        _ => return Err(format!("无效的录制模式: {}", mode)),
    };
    if matches!(record_mode, crate::recording::RecordMode::Gif) && pixels > MAX_GIF_RECORDING_PIXELS
    {
        return Err("GIF 录制区域过大，最多支持 1600 万像素".to_string());
    }

    let region = crate::recording::RecordRegion {
        left,
        top,
        width,
        height,
    };

    let state = app.state::<crate::recording::RecordingState>();
    // Enable exclusion before the worker can capture its first frame.
    set_recording_capture_protection(&app);
    if let Err(error) = state.start(&app, region, record_mode, fps, max_duration_sec) {
        set_recording_capture_protection(&app);
        return Err(error);
    }
    Ok(())
}


/// The control window is created asynchronously by the frontend. This command
/// only makes the full-screen selection overlay click-through.
#[tauri::command]
pub fn show_recording_controls(app: tauri::AppHandle) -> Result<(), String> {
    let _lifecycle = RECORDING_CONTROLS_LIFECYCLE_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // Do not let a delayed startup continuation re-arm the overlay after the
    // recording was cancelled or finished while controls were being created.
    if let Some(state) = app.try_state::<crate::recording::RecordingState>() {
        if !state.is_running() {
            return Err("录制已结束".to_string());
        }
    }
    set_recording_capture_protection(&app);
    if let Some(overlay) = app.get_webview_window("screenshot-overlay") {
        overlay
            .set_ignore_cursor_events(true)
            .map_err(|error| error.to_string())?;
    }
    let _ = app.emit("recording-controls-started", ());
    Ok(())
}


/// 显示全屏录制专用的原生指示层（屏幕边缘呼吸框 + 录制控制栏）。
///
/// 只应在录制范围**铺满屏幕**时调用：此时 WebView2 控制栏在录制区域外无处可放，
/// 压在区域内又会被 BitBlt 截进成片，故改用 `WDA_EXCLUDEFROMCAPTURE` 排除出捕获的
/// 原生窗（详见 `recording::indicator` 的模块注释）。区域/窗口录制不调用本命令，
/// 仍走原来的 `ensureRecordingControlsWindow` 路径。
///
/// `dark` 由前端按当前主题传入，让原生窗配色与 WebView2 控制栏保持一致。
#[tauri::command]
pub fn show_recording_indicator(
    app: tauri::AppHandle,
    left: i32,
    top: i32,
    width: u32,
    height: u32,
    dark: bool,
) -> Result<(), String> {
    let state = app.state::<crate::recording::RecordingState>();
    if !state.is_running() {
        return Err("录制未开始".to_string());
    }
    let region = windows::Win32::Foundation::RECT {
        left,
        top,
        right: left.saturating_add(width as i32),
        bottom: top.saturating_add(height as i32),
    };
    crate::recording::indicator::show(&app, region, dark)
}


/// 销毁录制控制栏并恢复主 overlay 的交互。
///
/// 录制控制栏有两套：区域/窗口录制的 WebView2 控制窗（`recording-controls`）与
/// 全屏录制的原生指示层（`recording::indicator`）。二者都在这里销毁 —— 停止、取消、
/// Esc 清理、45s 编码超时、关闭录屏开关等路径全都调本函数，挂在这里才不会漏掉某条
/// 异常路径而在屏幕上留下一扇置顶幽灵窗。
#[tauri::command]
pub fn finish_recording_controls(app: tauri::AppHandle) -> Result<(), String> {
    let _lifecycle = RECORDING_CONTROLS_LIFECYCLE_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    destroy_recording_controls_window(&app);
    crate::recording::indicator::destroy();
    set_recording_capture_protection(&app);
    crate::hooks::mouse::set_recording_mode(false);
    if let Some(overlay) = app.get_webview_window("screenshot-overlay") {
        overlay
            .set_ignore_cursor_events(false)
            .map_err(|error| error.to_string())?;
    }
    let _ = app.emit("recording-controls-finished", ());
    Ok(())
}


/// 暂停录制
#[tauri::command]
pub fn pause_recording(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<crate::recording::RecordingState>();
    state.pause()?;
    let _ = app.emit("recording-paused", ());
    Ok(())
}


/// 恢复录制
#[tauri::command]
pub fn resume_recording(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<crate::recording::RecordingState>();
    state.resume()?;
    let _ = app.emit("recording-resumed", ());
    Ok(())
}


/// 停止录制并编码
#[tauri::command]
pub fn stop_recording(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<crate::recording::RecordingState>();
    state.stop()?;
    crate::hooks::mouse::set_recording_mode(false);
    finish_recording_controls(app)
}


/// 取消录制（丢弃）
#[tauri::command]
pub fn cancel_recording(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<crate::recording::RecordingState>();
    state.cancel()?;
    finish_recording_controls(app)
}


/// Cancel an active recording and leave the selection overlay in one native
/// operation. This is used by the control window, which is destroyed during
/// cleanup and therefore cannot safely issue a follow-up frontend command.
#[tauri::command]
pub fn cancel_recording_and_select(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<crate::recording::RecordingState>();
    state.cancel()?;
    cancel_recording_select(app)
}


/// 获取录制状态快照
#[tauri::command]
pub fn get_recording_state(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<crate::recording::RecordingState>();
    Ok(serde_json::json!({
        "running": state.is_running(),
        "paused": state.is_paused(),
        "elapsedMs": state.elapsed_ms(),
        "frameCount": state.frame_count(),
        "mode": state.get_mode().map(|m| match m {
            crate::recording::RecordMode::Gif => "gif",
            crate::recording::RecordMode::Video => "video",
        }),
    }))
}


/// 查询当前是否处于录制选区模式（前端 OverlaySwitcher 挂载时调用，
/// 防止首次创建 overlay 窗口时 recording-select-switch 事件丢失导致模式不正确）
#[tauri::command]
pub fn is_recording_select_active() -> bool {
    crate::hooks::mouse::is_recording_mode()
}


/// 复制 GIF 到剪贴板
/// 写入注册的 "GIF" 格式保留完整动画，同时写入 CF_DIB 位图（首帧）作为通用兼容回退
#[tauri::command]
pub fn clipboard_set_gif(
    base64_data: String,
    clipboard: State<'_, ClipboardManager>,
) -> Result<(), String> {
    let bytes = decode_base64_media(&base64_data, "GIF")?;
    clipboard.copy_gif(&bytes).map_err(|e| e.to_string())
}


/// 保存 GIF 文件
/// 如果配置了录屏保存路径，直接保存到该目录（自动生成带时间戳的文件名）；
/// 否则弹出文件保存对话框让用户选择位置
#[tauri::command]
pub async fn save_gif(
    app: tauri::AppHandle,
    base64_data: String,
    filename: String,
) -> Result<bool, String> {
    let bytes = decode_base64_media(&base64_data, "GIF")?;

    // 检查是否配置了录屏保存路径
    let config_manager = app.state::<ConfigManager>();
    let save_path = config_manager.get_recording_save_path()?;
    if !save_path.is_empty() {
        let dir = std::path::Path::new(&save_path);
        if dir.is_dir() {
            // 生成带时间戳的文件名：recording_20260714_153020_123.gif
            let now = chrono::Local::now();
            let timestamp = now.format("%Y%m%d_%H%M%S");
            let millis = now.timestamp_subsec_millis();
            let ext = std::path::Path::new(&filename)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("gif");
            let auto_filename = format!("recording_{}_{}.{}", timestamp, millis, ext);
            let full_path = dir.join(&auto_filename);
            tokio::task::spawn_blocking(move || {
                std::fs::write(&full_path, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;
                Ok(true)
            })
            .await
            .map_err(|e| format!("任务执行失败: {}", e))?
        } else {
            // 配置的目录不存在，回退到对话框模式
            save_gif_with_dialog(&app, &bytes, &filename).await
        }
    } else {
        save_gif_with_dialog(&app, &bytes, &filename).await
    }
}


/// 保存已编码的临时视频文件，避免把大体积 MP4 通过 IPC/base64 往返传输。
#[tauri::command]
pub async fn save_video_file(
    app: tauri::AppHandle,
    source_path: String,
    filename: String,
) -> Result<bool, String> {
    let source = std::path::PathBuf::from(&source_path);
    if !source.is_file() {
        return Err("视频文件不存在或已被清理".to_string());
    }
    let source = source
        .canonicalize()
        .map_err(|e| format!("读取视频文件失败: {}", e))?;
    let recording_temp_dir = std::env::temp_dir()
        .join("levitaire-recording")
        .canonicalize()
        .map_err(|e| format!("读取录屏临时目录失败: {}", e))?;
    if !source.starts_with(&recording_temp_dir) {
        return Err("视频文件不在录屏临时目录中".to_string());
    }

    let config_manager = app.state::<ConfigManager>();
    let save_path = config_manager.get_recording_save_path()?;
    if !save_path.is_empty() {
        let dir = std::path::Path::new(&save_path);
        if dir.is_dir() {
            let now = chrono::Local::now();
            let timestamp = now.format("%Y%m%d_%H%M%S");
            let millis = now.timestamp_subsec_millis();
            let ext = std::path::Path::new(&filename)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("mp4");
            let auto_filename = format!("recording_{}_{}.{}", timestamp, millis, ext);
            let target = dir.join(&auto_filename);
            tokio::task::spawn_blocking(move || {
                std::fs::copy(&source, &target).map_err(|e| format!("写入文件失败: {}", e))?;
                Ok(true)
            })
            .await
            .map_err(|e| format!("任务执行失败: {}", e))?
        } else {
            save_video_file_with_dialog(&app, &source, &filename).await
        }
    } else {
        save_video_file_with_dialog(&app, &source, &filename).await
    }
}


/// 枚举可见窗口（窗口识别模式）
/// 枚举可录制的窗口列表。
///
/// 排除自有窗口必须按 HWND 精确匹配（`own_window_root_hwnds`）：只按标题前缀会漏掉
/// 标题不以 `Levitaire` 开头的自有窗（`pin-ocr` 的标题是 `Pin OCR`），它会出现在
/// 录屏的「窗口识别」列表里被当成可录目标。
#[tauri::command]
pub fn enumerate_windows(
    app: tauri::AppHandle,
) -> Result<Vec<crate::recording::window_detect::WindowInfo>, String> {
    Ok(crate::recording::window_detect::enumerate_windows(
        &crate::commands::own_window_root_hwnds(&app),
    ))
}


/// 获取录屏工具启用状态
#[tauri::command]
pub fn get_recording_enabled(config_manager: State<'_, ConfigManager>) -> Result<bool, String> {
    config_manager.get_recording_enabled()
}


/// 设置录屏工具启用状态并持久化
#[tauri::command]
pub fn set_recording_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_recording_enabled(enabled)?;
    crate::hooks::hotkey::set_slot_enabled(crate::hooks::hotkey::HotkeySlotId::Recording, enabled);
    if !enabled {
        // 禁用时退出所有录制状态，包括独立控制窗和鼠标穿透 overlay。
        let state = app.state::<crate::recording::RecordingState>();
        if state.is_running() {
            let _ = state.cancel();
        }
        let _ = cancel_recording_select_inner(app.clone());
    }
    Ok(())
}


/// 获取录屏快捷键
#[tauri::command]
pub fn get_recording_hotkey(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_recording_hotkey()
}


/// 设置录屏快捷键
#[tauri::command]
pub fn set_recording_hotkey(
    hotkey: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let trimmed = hotkey.trim().to_string();
    let slot = crate::hooks::hotkey::HotkeySlotId::Recording;
    let previous = config_manager.get_recording_hotkey()?;
    if trimmed.is_empty() {
        crate::hooks::hotkey::unregister_hotkey(slot);
        if let Err(error) = config_manager.update_recording_hotkey(String::new()) {
            if !previous.is_empty() {
                let _ = crate::hooks::hotkey::register_hotkey(slot, &previous);
            }
            return Err(error);
        }
        return Ok(());
    }
    crate::hooks::hotkey::register_hotkey(slot, &trimmed)?;
    if let Err(error) = config_manager.update_recording_hotkey(trimmed) {
        if previous.is_empty() {
            crate::hooks::hotkey::unregister_hotkey(slot);
        } else {
            let _ = crate::hooks::hotkey::register_hotkey(slot, &previous);
        }
        return Err(error);
    }
    Ok(())
}


/// 获取录屏配置（JSON 字符串，空串表示未设置）
#[tauri::command]
pub fn get_recording_config(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_recording_config()
}


/// 更新录屏配置并持久化
#[tauri::command]
pub fn set_recording_config(
    config: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_recording_config(config)
}


/// 获取录屏文件保存路径（空串表示未设置，每次保存时弹出对话框）
#[tauri::command]
pub fn get_recording_save_path(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_recording_save_path()
}


/// 更新录屏文件保存路径并持久化
#[tauri::command]
pub fn set_recording_save_path(
    path: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_recording_save_path(path)
}


/// 退出录制选区模式（前端选区取消时调用）
#[tauri::command]
pub fn cancel_recording_select(app: tauri::AppHandle) -> Result<(), String> {
    let _lifecycle = RECORDING_SELECT_LIFECYCLE_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    cancel_recording_select_inner(app)
}
