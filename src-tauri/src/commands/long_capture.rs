use super::*;


/// Start a manual vertical scrolling capture after removing the selection UI.
#[tauri::command]
pub fn start_long_capture(
    app: tauri::AppHandle,
    left: i32,
    top: i32,
    width: i32,
    height: i32,
) -> Result<crate::scroll_capture::LongCaptureSummary, String> {
    crate::utils::logger::log(
        "long-capture",
        &format!(
            "start_long_capture requested region=({}, {}) {}x{}",
            left, top, width, height
        ),
    );
    if width <= 0 || height <= 0 {
        return Err("长截图区域尺寸无效".into());
    }
    if crate::hooks::mouse::is_recording_mode() {
        return Err("录屏进行中，无法开始长截图".into());
    }
    let overlay = app
        .get_webview_window("screenshot-overlay")
        .ok_or_else(|| {
            crate::utils::logger::log(
            "long-capture",
            "screenshot overlay missing during start; refusing to start without a loaded frontend",
        );
            "截图覆盖层尚未准备好，请重新选择区域".to_string()
        })?;
    let start_result = {
        // Esc and native close hold this lock while tearing the session down.
        // Taking it before hiding UI makes the check-and-register transition
        // atomic with respect to that teardown.
        let _session_lock = CAPTURE_SESSION_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !CAPTURE_SESSION_ACTIVE.load(Ordering::SeqCst)
            || !crate::hooks::mouse::is_screenshot_mode()
        {
            return Err("截图会话已取消".into());
        }
        // The first frame must be captured after the overlay and all Levitaire
        // UI have disappeared; otherwise the selection mask becomes part of it.
        overlay.hide().map_err(|e| e.to_string())?;
        std::thread::sleep(std::time::Duration::from_millis(50));
        let toolbar_was_visible = app
            .get_webview_window("toolbar")
            .map(|window| window.is_visible().unwrap_or(false))
            .unwrap_or(false);
        TOOLBAR_VISIBLE_BEFORE_LONG_CAPTURE.store(toolbar_was_visible, Ordering::SeqCst);
        if let Some(window) = app.get_webview_window("orb") {
            let _ = window.hide();
        }
        if let Some(window) = app.get_webview_window("toolbar") {
            let _ = window.hide();
        }
        if let Some(window) = app.get_webview_window("time-overlay") {
            let _ = window.hide();
        }
        if let Some(window) = app.get_webview_window("todo-overlay") {
            let _ = window.hide();
        }
        if let Some(window) = app.get_webview_window("palette") {
            let _ = window.hide();
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
        // Prefer the foreground window saved before the overlay was shown.
        // The selection center may be over the desktop or another topmost UI.
        let saved_target = SCREENSHOT_TARGET_HWND.load(Ordering::SeqCst);
        let saved_is_valid = if saved_target == 0 {
            false
        } else {
            let target = HWND(saved_target as *mut std::ffi::c_void);
            unsafe { IsWindow(Some(target)).as_bool() }
        };
        let target_hwnd = if saved_is_valid {
            saved_target
        } else {
            let center = POINT {
                x: left.saturating_add(width / 2),
                y: top.saturating_add(height / 2),
            };
            let under_cursor = unsafe { WindowFromPoint(center) };
            let under_cursor = unsafe { GetAncestor(under_cursor, GA_ROOT) };
            if under_cursor.0.is_null() {
                0
            } else {
                under_cursor.0 as isize
            }
        };
        if target_hwnd != 0 {
            let target = HWND(target_hwnd as *mut std::ffi::c_void);
            if unsafe { IsWindow(Some(target)).as_bool() } {
                // Best effort: Windows may reject foreground changes across
                // input queues, but the user can still click the target window.
                let _ = unsafe { SetForegroundWindow(target) };
                std::thread::sleep(std::time::Duration::from_millis(80));
            }
        }
        let state = app.state::<crate::scroll_capture::LongCaptureState>();
        state.start(
            app.clone(),
            crate::scroll_capture::CaptureRegion {
                left,
                top,
                width: width as u32,
                height: height as u32,
            },
            target_hwnd,
        )
    };
    let summary = match start_result {
        Ok(summary) => summary,
        Err(error) => {
            crate::utils::logger::log("long-capture", &format!("start failed: {}", error));
            cleanup_screenshot_session(&app);
            return Err(error);
        }
    };
    let _session_lock = CAPTURE_SESSION_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let state = app.state::<crate::scroll_capture::LongCaptureState>();
    if !CAPTURE_SESSION_ACTIVE.load(Ordering::SeqCst) || !state.owns_result(summary.result_id) {
        // Cancellation may win the race between worker registration and this
        // second session check. Ensure no worker or hidden overlay survives
        // the failed start transition.
        state.cancel_active();
        cleanup_screenshot_session_inner(&app);
        return Err("长截图会话已取消".into());
    }
    crate::utils::logger::log(
        "long-capture",
        &format!(
            "worker started result_id={} target_hwnd={:?}",
            summary.result_id,
            SCREENSHOT_TARGET_HWND.load(Ordering::SeqCst)
        ),
    );
    // The full selection overlay is gone. Keep ordinary mouse/keyboard input
    // flowing to the target; Esc remains handled by the independent long
    // capture session check in the global keyboard hook.
    crate::hooks::mouse::set_screenshot_mode(false);
    if let Some(frame) = app.get_webview_window("long-capture-frame") {
        let _ = configure_long_capture_frame(&frame);
        let _ = frame.set_ignore_cursor_events(true);
        // Put the 2px CSS border outside the captured rectangle. The frame can
        // stay visible throughout sampling without becoming part of the PNG.
        let _ = frame.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            left.saturating_sub(2),
            top.saturating_sub(2),
        )));
        let _ = frame.set_size(tauri::PhysicalSize::new(
            width.saturating_add(4) as u32,
            height.saturating_add(4) as u32,
        ));
        let _ = frame.set_always_on_top(true);
        let _ = frame.show();
    }
    if let Some(controls) = app.get_webview_window("long-capture-controls") {
        let bounds = crate::screenshot::virtual_desktop_bounds().ok();
        let control_size = controls.outer_size().ok();
        let control_width = control_size.map(|size| size.width as i32).unwrap_or(300);
        let control_height = control_size.map(|size| size.height as i32).unwrap_or(64);
        let mut control_x = left;
        let mut control_y = top.saturating_add(height).saturating_add(10);
        if let Some(bounds) = bounds {
            let right = bounds.origin_x.saturating_add(bounds.width);
            let bottom = bounds.origin_y.saturating_add(bounds.height);
            let max_x = right.saturating_sub(control_width).max(bounds.origin_x);
            let max_y = bottom.saturating_sub(control_height).max(bounds.origin_y);
            if control_y.saturating_add(control_height) > bottom {
                control_y = top.saturating_sub(control_height + 10);
            }
            control_x = control_x.clamp(bounds.origin_x, max_x);
            control_y = control_y.clamp(bounds.origin_y, max_y);
        }
        let _ = controls.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            control_x, control_y,
        )));
        let _ = controls.show();
        let _ = controls.set_always_on_top(true);
    }
    // Showing a focusable controls window can briefly make Levitaire the
    // foreground app. Give input back to the application under the capture
    // region so wheel and keyboard scrolling work immediately.
    let target_hwnd = SCREENSHOT_TARGET_HWND.load(Ordering::SeqCst);
    if target_hwnd != 0 {
        let target = HWND(target_hwnd as *mut std::ffi::c_void);
        if unsafe { IsWindow(Some(target)).as_bool() } {
            let _ = unsafe { SetForegroundWindow(target) };
        }
    }
    let _ = app.emit("long-capture-started", &summary);
    crate::utils::logger::log("long-capture", "long-capture-started emitted");
    Ok(summary)
}


#[tauri::command]
pub fn stop_long_capture(
    app: tauri::AppHandle,
    result_id: u64,
) -> Result<crate::scroll_capture::LongCaptureSummary, String> {
    let session_lock = CAPTURE_SESSION_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    crate::utils::logger::log(
        "long-capture",
        &format!("stop_long_capture requested result_id={}", result_id),
    );
    let state = app.state::<crate::scroll_capture::LongCaptureState>();
    let summary = match state.stop(result_id) {
        Ok(summary) => summary,
        Err(error) => {
            drop(session_lock);
            cleanup_screenshot_session(&app);
            let _ = app.emit("long-capture-cancelled", ());
            let _ = app.emit_to("screenshot-overlay", "long-capture-overlay-reset", ());
            return Err(error);
        }
    };
    // Preserve the completed result while ending the overlay session. The
    // controls window remains alive and switches to its preview state.
    crate::hooks::mouse::set_screenshot_mode(false);
    if let Some(overlay) = app.get_webview_window("screenshot-overlay") {
        let _ = overlay.hide();
    }
    if let Some(frame) = app.get_webview_window("long-capture-frame") {
        let _ = frame.hide();
    }
    if let Some(orb) = app.get_webview_window("orb") {
        if ORB_VISIBLE_BEFORE_SESSION.load(Ordering::SeqCst) {
            let _ = orb.show();
            let _ = orb.set_always_on_top(true);
        }
    }
    if TOOLBAR_VISIBLE_BEFORE_LONG_CAPTURE.swap(false, Ordering::SeqCst) {
        if let Some(toolbar) = app.get_webview_window("toolbar") {
            let _ = toolbar.show();
        }
    }
    if TIMER_VISIBLE_BEFORE_SESSION.swap(false, Ordering::SeqCst) {
        if let Some(timer) = app.get_webview_window("time-overlay") {
            let _ = timer.show();
        }
    }
    if TODO_VISIBLE_BEFORE_SESSION.swap(false, Ordering::SeqCst) {
        if let Some(todo) = app.get_webview_window("todo-overlay") {
            let _ = todo.show();
        }
    }
    if let Some(cache) = app.try_state::<crate::screenshot::ScreenCache>() {
        if let Ok(mut guard) = cache.pixels.lock() {
            *guard = None;
        }
    }
    // 长截图完成，会话结束：通知 overlay 渲染进程停止周期心跳
    set_capture_session_active(&app, false);
    SCREENSHOT_TARGET_HWND.store(0, Ordering::SeqCst);
    let _ = app.emit("long-capture-completed", &summary);
    crate::utils::logger::log(
        "long-capture",
        &format!("long-capture-completed emitted result_id={}", result_id),
    );
    let _ = app.emit_to("screenshot-overlay", "long-capture-overlay-reset", ());
    Ok(summary)
}


#[tauri::command]
pub fn cancel_long_capture(app: tauri::AppHandle, result_id: u64) -> Result<(), String> {
    let _session_lock = CAPTURE_SESSION_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let state = app.state::<crate::scroll_capture::LongCaptureState>();
    state.cancel(result_id)?;
    SCREENSHOT_SESSION.fetch_add(1, Ordering::SeqCst);
    cleanup_screenshot_session_inner(&app);
    let _ = app.emit("long-capture-cancelled", ());
    let _ = app.emit_to("screenshot-overlay", "long-capture-overlay-reset", ());
    Ok(())
}


#[tauri::command]
pub fn get_long_capture_status(
    state: tauri::State<'_, crate::scroll_capture::LongCaptureState>,
    result_id: u64,
) -> Result<crate::scroll_capture::LongCaptureSummary, String> {
    state.status(result_id)
}


#[tauri::command]
pub fn get_long_capture_preview(
    state: tauri::State<'_, crate::scroll_capture::LongCaptureState>,
    result_id: u64,
) -> Result<String, String> {
    state.preview(result_id)
}


#[tauri::command]
pub async fn save_long_capture(app: tauri::AppHandle, result_id: u64) -> Result<bool, String> {
    let state = app.state::<crate::scroll_capture::LongCaptureState>();
    let (bgra, width, height) = state.raw(result_id)?;
    let save_path = app.state::<ConfigManager>().get_screenshot_save_path()?;
    if !save_path.is_empty() && std::path::Path::new(&save_path).is_dir() {
        let now = chrono::Local::now();
        let filename = format!(
            "long_screenshot_{}_{}.png",
            now.format("%Y%m%d_%H%M%S"),
            now.timestamp_subsec_millis()
        );
        let path = std::path::Path::new(&save_path).join(filename);
        return tokio::task::spawn_blocking(move || {
            let bytes = crate::scroll_capture::encode_png_direct(&bgra, width, height)?;
            std::fs::write(path, bytes).map_err(|e| format!("写入长截图失败: {e}"))?;
            Ok(true)
        })
        .await
        .map_err(|e| format!("保存任务失败: {e}"))?;
    }
    let dialog = rfd::FileDialog::new()
        .set_file_name("long_screenshot.png")
        .add_filter("PNG 图片", &["png"]);
    let result = tokio::task::spawn_blocking(move || {
        let bytes = crate::scroll_capture::encode_png_direct(&bgra, width, height)?;
        match dialog.save_file() {
            Some(path) => {
                std::fs::write(path, bytes).map_err(|e| format!("写入长截图失败: {e}"))?;
                Ok(true)
            }
            None => Ok(false),
        }
    })
    .await
    .map_err(|e| format!("保存任务失败: {e}"))?;
    result
}


#[tauri::command]
pub async fn clipboard_set_long_capture(
    state: tauri::State<'_, crate::scroll_capture::LongCaptureState>,
    result_id: u64,
) -> Result<(), String> {
    const MAX_CLIPBOARD_DIB_BYTES: u64 = 48 * 1024 * 1024;
    let (width, height) = state.dimensions(result_id)?;
    let dib_bytes = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "长截图尺寸溢出".to_string())?;
    if dib_bytes > MAX_CLIPBOARD_DIB_BYTES {
        return Err("长截图过大，复制已拒绝，请改用保存文件".to_string());
    }
    let (bgra, width, height) = state.raw(result_id)?;
    tokio::task::spawn_blocking(move || {
        ClipboardManager::new()
            .copy_bgra_image(&bgra, width, height)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("复制任务失败: {e}"))?
}


#[tauri::command]
pub fn discard_long_capture(
    state: tauri::State<'_, crate::scroll_capture::LongCaptureState>,
    result_id: u64,
) {
    state.discard(result_id);
}
