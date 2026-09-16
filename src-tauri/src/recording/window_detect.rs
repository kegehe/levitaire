//! 窗口识别：枚举系统可见窗口，获取窗口标题和矩形。
//! 用于录屏的"窗口识别"模式。

use serde::Serialize;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowRect, GetWindowTextW, IsWindowVisible,
};

/// 窗口信息
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub hwnd: isize,
    pub title: String,
    pub class_name: String,
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

/// 枚举上下文：结果 vec + 需要排除的「自有窗口」HWND 清单。
/// 排除必须按 HWND 做：只按标题前缀会漏掉标题不以 `Levitaire` 开头的自有窗
/// （`pin-ocr` 的标题就是 `Pin OCR`，会出现在录屏的窗口列表里）。
struct EnumContext {
    windows: Vec<WindowInfo>,
    exclude: Vec<isize>,
}

/// 枚举所有可见窗口（排除不可见窗口、自有窗口与系统桌面窗口）
pub fn enumerate_windows(exclude: &[isize]) -> Vec<WindowInfo> {
    let mut ctx = EnumContext {
        windows: Vec::new(),
        exclude: exclude.to_vec(),
    };
    let ctx_ptr = &mut ctx as *mut EnumContext as isize;

    // SAFETY: EnumWindows 是同步阻塞调用，回调在同一线程执行，
    // ctx_ptr 指向栈上有效 ctx，函数返回前始终有效。
    unsafe {
        let _ = EnumWindows(Some(enum_callback), LPARAM(ctx_ptr));
    }

    ctx.windows
}

/// 取窗口的**可见**边界。
///
/// `GetWindowRect` 含 DWM 的不可见 resize 边框：实测（150% 缩放）标准带框窗口
/// 800×600 的 `GetWindowRect` 是 800×600，而 DWM 可见边界是 782×591 ——
/// 左/右/下各多 9px。录屏用它取区域会让成片比窗口内容大一圈（把窗口背后的画面
/// 录进去），选框也与肉眼看到的窗口边缘错位。优先取 `DWMWA_EXTENDED_FRAME_BOUNDS`，
/// 失败（旧系统 / 非 DWM 合成窗口）再退回 `GetWindowRect`。
fn visible_window_rect(hwnd: HWND) -> Option<RECT> {
    let mut extended = RECT::default();
    let ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut extended as *mut RECT as *mut std::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )
    }
    .is_ok();
    if ok && extended.right > extended.left && extended.bottom > extended.top {
        return Some(extended);
    }
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) }.is_ok() {
        Some(rect)
    } else {
        None
    }
}

unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: lparam 指向 enumerate_windows 栈上的 EnumContext，EnumWindows 同步调用保证有效
    let ctx = &mut *(lparam.0 as *mut EnumContext);

    // 仅枚举可见窗口
    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }

    // 排除 Levitaire 自身窗口（按 HWND 精确排除；另保留标题前缀作为兜底，
    // 覆盖不在 label 清单里的动态窗口，如便利贴）
    if ctx.exclude.contains(&(hwnd.0 as isize)) {
        return BOOL(1);
    }

    // 获取窗口标题
    let mut title_buf = [0u16; 512];
    let title_len = GetWindowTextW(hwnd, &mut title_buf);
    if title_len == 0 {
        return BOOL(1); // 无标题窗口跳过
    }
    let title = String::from_utf16_lossy(&title_buf[..title_len as usize]);
    if title.trim().is_empty() {
        return BOOL(1);
    }

    // 排除 Levitaire 自身窗口
    if title.starts_with("Levitaire") {
        return BOOL(1);
    }

    // 排除 Program Manager（桌面窗口）
    if title == "Program Manager" {
        return BOOL(1);
    }

    // 获取窗口类名
    let class_name = get_class_name(hwnd);

    // 获取窗口**可见**矩形（排除 DWM 隐形边框，见 visible_window_rect）
    let Some(rect) = visible_window_rect(hwnd) else {
        return BOOL(1);
    };
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;

    // 排除零尺寸或极小窗口
    if width <= 0 || height <= 0 || width < 50 || height < 50 {
        return BOOL(1);
    }

    ctx.windows.push(WindowInfo {
        hwnd: hwnd.0 as isize,
        title,
        class_name,
        left: rect.left,
        top: rect.top,
        width,
        height,
    });

    BOOL(1) // 继续枚举
}

/// 获取窗口类名
unsafe fn get_class_name(hwnd: HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;

    let mut buf = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut buf);
    if len == 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..len as usize])
}
