pub mod hotkey;
pub mod keyboard;
pub mod mouse;

/// 文字工具栏窗口四周的透明投影留白（逻辑像素）。
///
/// 窗口尺寸 = 工具栏容器 + 留白。窗口尺寸若等于容器尺寸，容器的 CSS 投影会被窗口
/// 边界硬切成容器圆角处的直角残影。容器在窗口内左上角内缩一个留白，所以按选区/光标
/// 计算窗口位置时要相应左移一个留白，工具栏才会落回原位（顶部不用补偿：body
/// 已有 24px tooltip 安全区，比留白宽）。
///
/// ⚠️ 必须与前端 `src/tools/text-toolbar/TextToolbar.tsx` 的 `TOOLBAR_SHADOW_MARGIN`
///    以及 `src/styles/global.css` 的 `body.toolbar-window` padding 保持一致。
pub const TOOLBAR_SHADOW_MARGIN: f64 = 10.0;

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

pub fn is_toolbar_visible() -> bool {
    mouse::is_toolbar_visible()
}

pub fn set_orb_visible(visible: bool) {
    mouse::set_orb_visible(visible);
}
