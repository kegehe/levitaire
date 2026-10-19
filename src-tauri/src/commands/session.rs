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

#[tauri::command]
pub fn mark_orb_ready() {
    ORB_READY.store(true, Ordering::SeqCst);
}
