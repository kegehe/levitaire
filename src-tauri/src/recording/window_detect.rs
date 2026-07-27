//! 窗口识别：枚举系统可见窗口，获取窗口标题和矩形。
//! 用于录屏的"窗口识别"模式。

use serde::Serialize;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextW, GetWindowRect, IsWindowVisible,
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

/// 枚举所有可见窗口（排除不可见窗口和系统桌面窗口）
pub fn enumerate_windows() -> Vec<WindowInfo> {
    let mut windows: Vec<WindowInfo> = Vec::new();
    let ctx_ptr = &mut windows as *mut Vec<WindowInfo> as isize;

    // SAFETY: EnumWindows 是同步阻塞调用，回调在同一线程执行，
    // ctx_ptr 指向栈上有效 Vec，函数返回前始终有效。
    unsafe {
        let _ = EnumWindows(Some(enum_callback), LPARAM(ctx_ptr));
    }

    windows
}

unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: lparam 指向 enumerate_windows 栈上的 Vec，EnumWindows 同步调用保证有效
    let windows = &mut *(lparam.0 as *mut Vec<WindowInfo>);

    // 仅枚举可见窗口
    if !IsWindowVisible(hwnd).as_bool() {
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

    // 排除 Floatory 自身窗口
    if title.starts_with("Floatory") {
        return BOOL(1);
    }

    // 排除 Program Manager（桌面窗口）
    if title == "Program Manager" {
        return BOOL(1);
    }

    // 获取窗口类名
    let class_name = get_class_name(hwnd);

    // 获取窗口矩形
    let mut rect = RECT::default();
    let _ = GetWindowRect(hwnd, &mut rect);
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;

    // 排除零尺寸或极小窗口
    if width <= 0 || height <= 0 || width < 50 || height < 50 {
        return BOOL(1);
    }

    windows.push(WindowInfo {
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
