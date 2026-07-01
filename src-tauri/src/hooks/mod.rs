pub mod mouse;
pub mod keyboard;

/// 钩子管理器
///
/// 目前仅作为 Tauri managed state 的占位结构体。
/// 实际的钩子状态由 mouse.rs 和 keyboard.rs 中的全局静态变量管理。
pub struct HookManager;

impl Default for HookManager {
    fn default() -> Self {
        Self::new()
    }
}

impl HookManager {
    pub fn new() -> Self {
        Self
    }
}

pub fn start_mouse_hook(app_handle: tauri::AppHandle) {
    mouse::start_hook(app_handle);
}

pub fn start_keyboard_hook(app_handle: tauri::AppHandle) {
    keyboard::start_keyboard_hook(app_handle);
}

pub fn set_toolbar_visible(visible: bool) {
    mouse::set_toolbar_visible(visible);
}
