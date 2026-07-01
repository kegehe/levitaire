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
                        if let Some(app) = KB_STATE.app_handle.get() {
                            let app_clone = app.clone();
                            std::thread::spawn(move || {
                                handle_ctrl_c(app_clone, fg_hwnd);
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
}

/// 处理 Ctrl+C：等待剪贴板更新，读取内容，触发选区事件
fn handle_ctrl_c(app: tauri::AppHandle, foreground_hwnd: isize) {
    std::thread::sleep(std::time::Duration::from_millis(100));

    let text = unsafe { wait_for_clipboard_text(400) };

    match text {
        Some(t) if !t.is_empty() => {
            crate::utils::logger::log("keyboard", &format!("Ctrl+C detected, clipboard: {} chars", t.len()));

            let cursor_pos = crate::automation::selection::get_cursor_pos();
            let rect = crate::automation::Rect {
                x: cursor_pos.x,
                y: cursor_pos.y,
                width: 0,
                height: 0,
            };

            let info = crate::automation::SelectionInfo { text: t, rect };

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
            }

            crate::utils::logger::log("keyboard", "Toolbar shown after Ctrl+C");
        }
        _ => {
            crate::utils::logger::log("keyboard", "Ctrl+C detected but clipboard empty");
        }
    }
}

/// 等待剪贴板中出现文本内容
unsafe fn wait_for_clipboard_text(max_ms: u32) -> Option<String> {
    let mut elapsed = 0;
    while elapsed < max_ms {
        std::thread::sleep(std::time::Duration::from_millis(50));
        elapsed += 50;

        if let Some(text) = read_clipboard_text() {
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}

/// 读取当前剪贴板的文本内容（#1: 带长度上限保护）
unsafe fn read_clipboard_text() -> Option<String> {
    if OpenClipboard(None).is_err() {
        return None;
    }

    let result = (|| -> Option<String> {
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
    })();

    let _ = CloseClipboard();
    result
}
