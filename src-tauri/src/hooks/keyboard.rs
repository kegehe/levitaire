use windows::Win32::Foundation::{HGLOBAL, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::DataExchange::*;
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock, GlobalSize};
use tauri::{Emitter, Manager};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicPtr, AtomicBool, Ordering};

/// 键盘钩子全局状态
struct KeyboardState {
    hook_ptr: AtomicPtr<std::ffi::c_void>,
    enabled: AtomicBool,
    app_handle: OnceLock<tauri::AppHandle>,
    /// #4: 防止快速连按 Ctrl+C 创建大量线程，用锁控制并发
    processing: AtomicBool,
}

static KB_STATE: KeyboardState = KeyboardState {
    hook_ptr: AtomicPtr::new(std::ptr::null_mut()),
    enabled: AtomicBool::new(true),
    app_handle: OnceLock::new(),
    processing: AtomicBool::new(false),
};

/// 剪贴板文本最大字符数（#1: 防损坏数据越界）
const MAX_CLIPBOARD_U16: usize = 1024 * 1024;
/// CF_UNICODETEXT 常量
const CF_UNICODETEXT: u32 = 13;

/// 安装全局键盘钩子，监听 Ctrl+C 后读取剪贴板并触发选区事件
pub fn start_keyboard_hook(app_handle: tauri::AppHandle) {
    KB_STATE.app_handle.set(app_handle).expect("KB app_handle already set");

    unsafe {
        let hook = SetWindowsHookExW(
            WH_KEYBOARD_LL,
            Some(keyboard_hook_proc),
            GetModuleHandleW(None).ok().map(|h| h.into()),
            0,
        );

        match hook {
            Ok(h) => {
                KB_STATE.hook_ptr.store(h.0, Ordering::SeqCst);
                crate::utils::logger::log("keyboard", "Keyboard hook installed");

                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).into() {}
                crate::utils::logger::log("keyboard", "Keyboard hook message loop exited");
            }
            Err(e) => {
                crate::utils::logger::log("keyboard", &format!("Failed to install keyboard hook: {:?}", e));
            }
        }
    }
}

/// 停止键盘钩子
pub fn stop_keyboard_hook() {
    let ptr = KB_STATE.hook_ptr.swap(std::ptr::null_mut(), Ordering::SeqCst);
    if !ptr.is_null() {
        unsafe {
            let _ = UnhookWindowsHookEx(HHOOK(ptr));
            crate::utils::logger::log("keyboard", "Keyboard hook uninstalled");
        }
    }
}

/// 键盘钩子回调
unsafe extern "system" fn keyboard_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && KB_STATE.enabled.load(Ordering::SeqCst) {
        let msg = wparam.0 as u32;
        let kb_ref = &*(lparam.0 as *const KBDLLHOOKSTRUCT);

        if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
            // 跳过程序模拟的按键（SendInput 注入的事件标记为 LLKHF_INJECTED）
            if kb_ref.flags.0 & 0x10 != 0 {
                return CallNextHookEx(Some(HHOOK(KB_STATE.hook_ptr.load(Ordering::SeqCst))), code, wparam, lparam);
            }

            let vk_code = kb_ref.vkCode;

            // 检测 Ctrl+C
            if vk_code == 0x43 {
                let ctrl_pressed = (GetKeyState(VK_CONTROL.0 as i32) as u16) & 0x8000 != 0;
                if ctrl_pressed {
                    // #4: 用 AtomicBool 做 debounce，防止快速连按创建大量线程
                    if KB_STATE.processing.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                        let foreground = GetForegroundWindow();
                        let fg_hwnd = foreground.0 as isize;
                        // 在钩子回调中立即保存剪贴板快照，
                        // 确保快照早于前台 app 处理 Ctrl+C（避免线程调度延迟导致竞态）
                        let old_clipboard = read_clipboard_snapshot();
                        if let Some(app) = KB_STATE.app_handle.get() {
                            let app_clone = app.clone();
                            std::thread::spawn(move || {
                                handle_ctrl_c(app_clone, fg_hwnd, old_clipboard);
                                KB_STATE.processing.store(false, Ordering::SeqCst);
                            });
                        } else {
                            KB_STATE.processing.store(false, Ordering::SeqCst);
                        }
                    }
                }
            }
        }
    }

    let hook = HHOOK(KB_STATE.hook_ptr.load(Ordering::SeqCst));
    CallNextHookEx(Some(hook), code, wparam, lparam)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_constants() {
        assert_eq!(CF_UNICODETEXT, 13);
        assert_eq!(MAX_CLIPBOARD_U16, 1024 * 1024);
    }

    #[test]
    fn test_processing_flag_initial_false() {
        // KB_STATE.processing 是 AtomicBool，初始为 false
        assert!(!KB_STATE.processing.load(Ordering::SeqCst));
    }

    #[test]
    fn test_processing_flag_debounce() {
        // 模拟 compare_exchange 行为
        // 第一次应成功（false → true）
        let first = KB_STATE.processing.compare_exchange(
            false, true, Ordering::SeqCst, Ordering::SeqCst
        );
        assert!(first.is_ok(), "第一次 compare_exchange 应成功");

        // 第二次应失败（已为 true）
        let second = KB_STATE.processing.compare_exchange(
            false, true, Ordering::SeqCst, Ordering::SeqCst
        );
        assert!(second.is_err(), "第二次 compare_exchange 应失败（防抖生效）");

        // 恢复
        KB_STATE.processing.store(false, Ordering::SeqCst);
    }

    #[test]
    fn test_kb_state_enabled_default() {
        // 键盘钩子默认启用
        assert!(KB_STATE.enabled.load(Ordering::SeqCst));
    }

    #[test]
    fn test_image_formats_equal_empty() {
        assert!(image_formats_equal(&[], &[]));
    }

    #[test]
    fn test_image_formats_equal_same() {
        assert!(image_formats_equal(&[8, 2], &[8, 2]));
        assert!(image_formats_equal(&[8, 2], &[2, 8])); // 忽略顺序
    }

    #[test]
    fn test_image_formats_equal_different() {
        assert!(!image_formats_equal(&[8], &[8, 2]));
        assert!(!image_formats_equal(&[8, 2], &[8]));
        assert!(!image_formats_equal(&[8], &[2]));
    }
}

/// 剪贴板快照，用于在钩子回调中快速捕获 Ctrl+C 前的剪贴板状态
struct ClipSnapshot {
    text: Option<String>,
    has_image: bool,
}

/// 在钩子回调线程中一次性读取剪贴板的文本和图片格式状态
/// 单次 Open/Close 避免两次打开之间的竞态
/// 重试最多 3 次（间隔 20ms），避免剪贴板被其他进程短暂占用时阻塞钩子回调
unsafe fn read_clipboard_snapshot() -> ClipSnapshot {
    for _ in 0..3 {
        if OpenClipboard(None).is_ok() {
            let text = read_clipboard_text_inner();
            let has_image = clipboard_has_image_inner();
            let _ = CloseClipboard();
            return ClipSnapshot { text, has_image };
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    // 3 次均失败，返回空快照（保守：后续检测会因 old=None/new=Some 而显示工具栏）
    ClipSnapshot { text: None, has_image: false }
}

/// 处理 Ctrl+C：等待剪贴板更新，读取内容，触发选区事件
fn handle_ctrl_c(app: tauri::AppHandle, foreground_hwnd: isize, old_clipboard: ClipSnapshot) {
    // 等待前台 app 处理 Ctrl+C（将选中文本写入剪贴板）
    std::thread::sleep(std::time::Duration::from_millis(500));

    // 读取 Ctrl+C 后的剪贴板状态
    let new_text = unsafe { read_clipboard_text() };
    let (new_image_data, new_has_image) = unsafe { read_clipboard_image_data() };

    // 对比新旧剪贴板状态，判断是否有实际变化
    let text_changed = match (&new_text, &old_clipboard.text) {
        (Some(t), old) if !t.is_empty() => Some(t.as_str()) != old.as_deref(),
        _ => false,
    };
    let image_changed = new_has_image && !old_clipboard.has_image;

    // 文本和图片都未变化 → 不是用户主动复制（未选中文本按了 Ctrl+C），跳过
    if !text_changed && !image_changed {
        crate::utils::logger::log("keyboard", "Ctrl+C detected but clipboard unchanged, skipping");
        return;
    }

    let clipboard_text = new_text.unwrap_or_default();
    crate::utils::logger::log("keyboard", &format!("Ctrl+C detected, clipboard: {} chars, has_image: {}", clipboard_text.len(), new_has_image));

    // 如果有图片，暂存图片数据供复制操作使用
    if let Some(img_data) = new_image_data {
        crate::automation::clipboard_selection::store_detected_image(img_data);
    }

    let cursor_pos = crate::automation::selection::get_cursor_pos();
    let rect = crate::automation::Rect {
        x: cursor_pos.x,
        y: cursor_pos.y,
        width: 0,
        height: 0,
    };

    let info = crate::automation::SelectionInfo { text: clipboard_text, rect, has_image: new_has_image };

    crate::automation::store_selection_context(&info, crate::automation::SelectionContext {
        text: info.text.clone(),
        rect: info.rect.clone(),
        method: crate::automation::SelectionMethod::Clipboard,
        foreground_hwnd,
        focus_hwnd: 0,
        focus_class: String::new(),
        sel_start: 0,
        sel_end: 0,
        occurrence_index: 0,
    });

    let _ = app.emit("selection-found", &info);

    if let Some(win) = app.get_webview_window("toolbar") {
        let x = cursor_pos.x;
        let y = cursor_pos.y + 20;
        let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)));
        let _ = win.show();
        // 同步鼠标钩子的工具栏可见状态，确保点击外部可以正确隐藏
        crate::hooks::set_toolbar_visible(true);
        // 更新窗口句柄缓存
        if let Ok(hwnd) = win.hwnd() {
            crate::hooks::mouse::update_toolbar_hwnd(hwnd.0);
        }
    }

    crate::utils::logger::log("keyboard", "Toolbar shown after Ctrl+C");
}

// ─── 剪贴板工具函数 ────────────────────────────────────────────

/// 判断两次检测到的图片格式列表是否相同（忽略顺序）
/// 仅在测试中使用（生产代码直接用 ClipSnapshot.has_image bool 比较）
#[cfg(test)]
fn image_formats_equal(old: &[u32], new_formats: &[u32]) -> bool {
    if old.len() != new_formats.len() {
        return false;
    }
    // 两个列表通常很短（1-3个元素），直接逐一比较
    for fmt in old {
        if !new_formats.contains(fmt) {
            return false;
        }
    }
    true
}

/// 检查当前剪贴板是否包含图片格式
/// 在 OpenClipboard 状态下调用
unsafe fn clipboard_has_image_inner() -> bool {
    let mut fmt = 0u32;
    loop {
        fmt = EnumClipboardFormats(fmt);
        if fmt == 0 {
            break;
        }
        // CF_BITMAP(2), CF_DIB(8), CF_DIBV5(17)
        if matches!(fmt, 2 | 8 | 17) {
            return true;
        }
    }
    false
}

/// 检查当前剪贴板是否包含图片格式（自动管理剪贴板开关）
/// 仅在测试中使用
#[cfg(test)]
unsafe fn clipboard_has_image() -> bool {
    if OpenClipboard(None).is_err() {
        return false;
    }
    let result = clipboard_has_image_inner();
    let _ = CloseClipboard();
    result
}

/// 读取剪贴板图片数据（返回图片字节和是否包含图片格式标记）
unsafe fn read_clipboard_image_data() -> (Option<Vec<u8>>, bool) {
    if OpenClipboard(None).is_err() {
        return (None, false);
    }

    let has_image = clipboard_has_image_inner();
    let image_data = if has_image {
        // CF_DIB = 8
        let handle = GetClipboardData(8);
        match handle {
            Ok(h) if !h.is_invalid() => {
                let hmem = HGLOBAL(h.0);
                let ptr = GlobalLock(hmem);
                if !ptr.is_null() {
                    let size = GlobalSize(hmem);
                    if size > 0 {
                        let data = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
                        let _ = GlobalUnlock(hmem);
                        Some(data)
                    } else {
                        let _ = GlobalUnlock(hmem);
                        None
                    }
                } else {
                    None
                }
            }
            _ => None,
        }
    } else {
        None
    };

    let _ = CloseClipboard();
    (image_data, has_image)
}

/// 读取当前剪贴板的文本内容（#1: 带长度上限保护）
/// 必须在 OpenClipboard 状态下调用
unsafe fn read_clipboard_text_inner() -> Option<String> {
    let handle = GetClipboardData(CF_UNICODETEXT).ok()?;
    if handle.is_invalid() {
        return None;
    }
    let hmem = HGLOBAL(handle.0);
    let ptr = GlobalLock(hmem);
    if ptr.is_null() {
        return None;
    }
    let mem_size = GlobalSize(hmem);
    let max_u16 = if mem_size > 0 { mem_size / 2 } else { MAX_CLIPBOARD_U16 };
    let mut len = 0usize;
    let mut p = ptr as *const u16;
    while len < max_u16 && *p != 0 {
        len += 1;
        p = p.add(1);
    }
    if len == 0 {
        let _ = GlobalUnlock(hmem);
        return None;
    }
    let slice = std::slice::from_raw_parts(ptr as *const u16, len);
    let text = String::from_utf16_lossy(slice);
    let _ = GlobalUnlock(hmem);
    Some(text)
}

/// 读取当前剪贴板的文本内容（自动管理剪贴板开关）
unsafe fn read_clipboard_text() -> Option<String> {
    if OpenClipboard(None).is_err() {
        return None;
    }
    let result = read_clipboard_text_inner();
    let _ = CloseClipboard();
    result
}
