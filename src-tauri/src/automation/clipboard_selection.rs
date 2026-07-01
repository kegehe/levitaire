use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::Win32::System::DataExchange::*;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GlobalSize, GMEM_MOVEABLE};
use windows::Win32::System::Threading::{OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};

use super::{SelectionInfo, Rect, SelectionContext};

const CF_UNICODETEXT: u32 = 13;
/// 剪贴板文本最大字符数（防损坏数据越界）
const MAX_CLIPBOARD_U16: usize = 1024 * 1024;

/// 通过模拟 Ctrl+C 从剪贴板获取选中文字
/// 流程：保存原剪贴板 → 模拟 Ctrl+C → 读取 → 恢复原剪贴板
/// 返回 (SelectionInfo, foreground_hwnd) — foreground_hwnd 用于后续替换时恢复焦点
pub fn get_selection_via_clipboard() -> Result<Option<(SelectionInfo, isize)>, Box<dyn std::error::Error>> {
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.is_invalid() {
            crate::utils::logger::log("clipboard_sel", "No foreground window");
            return Ok(None);
        }

        // #11: 检测目标窗口是否为管理员权限（High IL），SendInput 无法注入
        if is_elevated_window(foreground) {
            crate::utils::logger::log("clipboard_sel", "Target window is elevated (admin), skipping SendInput");
            return Ok(None);
        }

        // 保存原始剪贴板内容
        let saved_clipboard = save_clipboard_text();

        // 模拟 Ctrl+C
        if !simulate_copy() {
            crate::utils::logger::log("clipboard_sel", "Failed to simulate Ctrl+C");
            // #6: simulate_copy 失败时恢复剪贴板
            if let Some(ref saved) = saved_clipboard {
                restore_clipboard_text(saved);
            }
            return Ok(None);
        }

        // 等待剪贴板更新（最多 300ms）
        // 必须传入 saved_clipboard 以区分新内容与旧内容，
        // 防止 simulate_copy 未生效时返回剪贴板中的残留数据
        let text = wait_for_clipboard_text_changed(300, saved_clipboard.as_deref());

        // 立即恢复原始剪贴板
        if let Some(ref saved) = saved_clipboard {
            restore_clipboard_text(saved);
        }

        match text {
            Some(t) if !t.is_empty() => {
                crate::utils::logger::log("clipboard_sel", &format!("Clipboard success: {} chars", t.len()));

                let cursor_pos = crate::automation::selection::get_cursor_pos();
                let rect = Rect { x: cursor_pos.x, y: cursor_pos.y, width: 0, height: 0 };

                let info = SelectionInfo { text: t, rect };
                Ok(Some((info, foreground.0 as isize)))
            }
            _ => {
                crate::utils::logger::log("clipboard_sel", "No text in clipboard after Ctrl+C");
                Ok(None)
            }
        }
    }
}

/// 通过模拟 Ctrl+V 替换选中文字
/// 流程：恢复焦点 → 设置剪贴板为新文本 → 模拟 Ctrl+V → 恢复原剪贴板
pub fn replace_text_via_clipboard(ctx: &SelectionContext, new_text: &str) -> Result<(), String> {
    unsafe {
        // 恢复前台窗口焦点
        if ctx.foreground_hwnd != 0 {
            let foreground_hwnd = HWND(ctx.foreground_hwnd as *mut std::ffi::c_void);
            let _ = SetForegroundWindow(foreground_hwnd);
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        // 保存当前剪贴板
        let saved_clipboard = save_clipboard_text();

        // 设置剪贴板为新文本
        if !set_clipboard_text(new_text) {
            return Err("设置剪贴板失败".to_string());
        }

        // 模拟 Ctrl+V
        if !simulate_paste() {
            if let Some(ref saved) = saved_clipboard {
                restore_clipboard_text(saved);
            }
            return Err("模拟 Ctrl+V 失败".to_string());
        }

        // 等待粘贴完成
        std::thread::sleep(std::time::Duration::from_millis(100));

        // 恢复原始剪贴板
        if let Some(ref saved) = saved_clipboard {
            restore_clipboard_text(saved);
        }

        crate::utils::logger::log("clipboard_sel", "Clipboard replace success");
        Ok(())
    }
}

// ─── 内部工具函数 ────────────────────────────────────────────────

/// 保存当前剪贴板的文本内容
unsafe fn save_clipboard_text() -> Option<String> {
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
        let text = read_u16_string(ptr, max_u16);
        let _ = GlobalUnlock(hmem);
        text
    })();

    let _ = CloseClipboard();
    result
}

/// 恢复剪贴板文本
unsafe fn restore_clipboard_text(text: &str) -> bool {
    write_clipboard_text(text)
}

/// 设置剪贴板为指定文本
unsafe fn set_clipboard_text(text: &str) -> bool {
    write_clipboard_text(text)
}

/// 写入文本到剪贴板（内部公共实现）
unsafe fn write_clipboard_text(text: &str) -> bool {
    if OpenClipboard(None).is_err() {
        return false;
    }

    let _ = EmptyClipboard();

    let utf16: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let byte_len = utf16.len() * 2;
    let hmem = match GlobalAlloc(GMEM_MOVEABLE, byte_len) {
        Ok(h) => h,
        Err(_) => {
            let _ = CloseClipboard();
            return false;
        }
    };
    let ptr = GlobalLock(hmem);
    if ptr.is_null() {
        // GlobalLock 失败时无法使用 hmem，SetClipboardData 会接管所有权
        // 但此处未调用 SetClipboardData，hmem 泄漏为已知的极端情况
        let _ = CloseClipboard();
        return false;
    }
    std::ptr::copy_nonoverlapping(utf16.as_ptr(), ptr as *mut u16, utf16.len());
    let _ = GlobalUnlock(hmem);
    let _ = SetClipboardData(CF_UNICODETEXT, Some(HANDLE(hmem.0)));
    let _ = CloseClipboard();
    true
}

/// 模拟 Ctrl+C 按键
unsafe fn simulate_copy() -> bool {
    simulate_key_combo(VK_CONTROL, 0x43) // 0x43 = 'C'
}

/// 模拟 Ctrl+V 按键
unsafe fn simulate_paste() -> bool {
    simulate_key_combo(VK_CONTROL, 0x56) // 0x56 = 'V'
}

/// 模拟 Ctrl+Key 组合键
unsafe fn simulate_key_combo(modifier: VIRTUAL_KEY, key: u16) -> bool {
    let inputs = [
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: modifier, ..Default::default() },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: VIRTUAL_KEY(key), ..Default::default() },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: VIRTUAL_KEY(key), dwFlags: KEYEVENTF_KEYUP, ..Default::default() },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: modifier, dwFlags: KEYEVENTF_KEYUP, ..Default::default() },
            },
        },
    ];

    let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    sent == inputs.len() as u32
}

/// 等待剪贴板中出现与旧内容不同的文本
/// 防止 simulate_copy 未生效时返回剪贴板中的残留数据
unsafe fn wait_for_clipboard_text_changed(max_ms: u32, old_text: Option<&str>) -> Option<String> {
    let mut elapsed = 0;
    while elapsed < max_ms {
        std::thread::sleep(std::time::Duration::from_millis(10));
        elapsed += 10;

        if let Some(text) = read_clipboard_text() {
            if !text.is_empty() && Some(text.as_str()) != old_text {
                return Some(text);
            }
        }
    }
    None
}

/// 读取当前剪贴板的文本内容
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
        let text = read_u16_string(ptr, max_u16);
        let _ = GlobalUnlock(hmem);
        text
    })();

    let _ = CloseClipboard();
    result
}

/// 从内存指针读取 UTF-16 字符串，带长度上限保护
/// #1: 防止损坏数据导致越界读取
unsafe fn read_u16_string(ptr: *mut core::ffi::c_void, max_u16: usize) -> Option<String> {
    let mut len = 0usize;
    let mut p = ptr as *const u16;
    while len < max_u16 && *p != 0 {
        len += 1;
        p = p.add(1);
    }
    if len == 0 {
        return None;
    }
    let slice = std::slice::from_raw_parts(ptr as *const u16, len);
    Some(String::from_utf16_lossy(slice))
}

/// #11: 检测目标窗口所属进程是否以管理员权限运行
/// 通过 OpenProcess + GetTokenInformation 检查 elevation 状态
unsafe fn is_elevated_window(hwnd: HWND) -> bool {
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return false;
    }

    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::Foundation::CloseHandle;

    let process = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
        Ok(h) => h,
        Err(_) => return false,
    };

    let mut token = windows::Win32::Foundation::HANDLE::default();
    let elevated = if OpenProcessToken(process, TOKEN_QUERY, &mut token).is_ok() {
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut ret_len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut ret_len,
        );
        let _ = CloseHandle(token);
        ok.is_ok() && elevation.TokenIsElevated != 0
    } else {
        false
    };

    let _ = CloseHandle(process);
    elevated
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── 常量 ─────────────────────────────────────────────────────

    #[test]
    fn test_constants() {
        assert_eq!(CF_UNICODETEXT, 13);
        assert_eq!(MAX_CLIPBOARD_U16, 1024 * 1024);
    }

    // ─── read_u16_string ──────────────────────────────────────────

    #[test]
    fn test_read_u16_string_null_ptr() {
        // 无效指针 + max_u16=0 应返回 None（不 panic）
        let result = unsafe { read_u16_string(std::ptr::null_mut(), 0) };
        assert!(result.is_none());
    }

    #[test]
    fn test_read_u16_string_zero_max() {
        // max_u16 = 0 → 即使指针有效也返回 None
        let mut dummy = [0u16; 4];
        let result = unsafe { read_u16_string(dummy.as_mut_ptr() as *mut _, 0) };
        assert!(result.is_none());
    }

    // ─── 虚拟键码 ────────────────────────────────────────────────

    #[test]
    fn test_vk_control_value() {
        // VK_CONTROL = 0x11，Ctrl 键虚拟键码
        assert_eq!(VK_CONTROL.0, 0x11);
    }

    #[test]
    fn test_c_key_code() {
        // 0x43 = 'C'，用于 simulate_copy
        assert_eq!(0x43u16, b'C' as u16);
    }

    #[test]
    fn test_v_key_code() {
        // 0x56 = 'V'，用于 simulate_paste
        assert_eq!(0x56u16, b'V' as u16);
    }
}
