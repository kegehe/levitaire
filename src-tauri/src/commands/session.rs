use super::*;

/// Consume a screenshot request queued by the global hotkey while the
/// frontend-created overlay window was still loading.
#[tauri::command]
pub fn consume_screenshot_start_pending() -> bool {
    SCREENSHOT_START_PENDING.swap(false, Ordering::SeqCst)
}

#[tauri::command]
pub fn consume_recording_select_start_pending() -> bool {
    RECORDING_SELECT_START_PENDING.swap(false, Ordering::SeqCst)
}

#[tauri::command]
pub fn consume_sketch_start_pending() -> bool {
    SKETCH_START_PENDING.swap(false, Ordering::SeqCst)
}

#[tauri::command]
pub fn consume_todo_quick_add_pending() -> bool {
    TODO_QUICK_ADD_PENDING.swap(false, Ordering::SeqCst)
}

/// orb 的前端挂载完成并已自行 `show()` 后调用。
///
/// 球窗口的首次显示不走 `show_orb`（前端直接 `win.show()`），所以这里必须按
/// **真实可见性**补一次钩子同步：钩子标志初值是「不可见」，不能指望调用方记得置真。
#[tauri::command]
pub fn mark_orb_ready(app: tauri::AppHandle) {
    ORB_READY.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("orb") {
        crate::hooks::set_orb_visible(window.is_visible().unwrap_or(false));
    }
}
