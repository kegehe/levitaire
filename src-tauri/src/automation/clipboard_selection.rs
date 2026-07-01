use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::Win32::System::DataExchange::*;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GlobalSize, GMEM_MOVEABLE};
use windows::Win32::System::Threading::{OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};

use super::{SelectionInfo, Rect, SelectionContext};

const CF_UNICODETEXT: u32 = 13;
const CF_DIB: u32 = 8;
/// 剪贴板文本最大字符数（防损坏数据越界）
const MAX_CLIPBOARD_U16: usize = 1024 * 1024;

/// 全局暂存的选区图片数据（CF_DIB 格式）
static DETECTED_IMAGE: std::sync::OnceLock<std::sync::Mutex<Option<Vec<u8>>>> = std::sync::OnceLock::new();

fn get_image_store() -> &'static std::sync::Mutex<Option<Vec<u8>>> {
    DETECTED_IMAGE.get_or_init(|| std::sync::Mutex::new(None))
}

/// 存储检测到的图片数据
pub fn store_detected_image(data: Vec<u8>) {
    let store = get_image_store();
    if let Ok(mut guard) = store.lock() {
        *guard = Some(data);
    }
}

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

        // 等待剪贴板更新（最多 500ms）
        // 必须传入 saved_clipboard 以区分新内容与旧内容，
        // 防止 simulate_copy 未生效时返回剪贴板中的残留数据
        let text = wait_for_clipboard_text_changed(500, saved_clipboard.as_deref());

        // 检测并保存剪贴板中的图片数据（必须在恢复剪贴板之前）
        let image_data = read_clipboard_image();
        let has_image = image_data.is_some();

        // 立即恢复原始剪贴板
        if let Some(ref saved) = saved_clipboard {
            restore_clipboard_text(saved);
        }

        let cursor_pos = crate::automation::selection::get_cursor_pos();
        let rect = Rect { x: cursor_pos.x, y: cursor_pos.y, width: 0, height: 0 };

        // 获取焦点控件 HWND 和选区位置（用于替换时精确定位）
        // Scintilla（Notepad++）等控件响应 EM_GETSEL/EM_SETSEL
        let (focus_hwnd, focus_class, sel_start, sel_end) = get_focus_selection(foreground);

        match text {
            Some(t) if !t.is_empty() => {
                crate::utils::logger::log("clipboard_sel", &format!("Clipboard success: {} chars, has_image: {}, focus_class='{}', sel={}",
                    t.len(), has_image, focus_class, if sel_start == sel_end { "none".to_string() } else { format!("{}..{}", sel_start, sel_end) }));

                // 如果有图片，暂存图片数据供复制操作使用
                if let Some(img_data) = image_data {
                    store_detected_image(img_data);
                }

                // 暂存选区上下文（含焦点控件 HWND 和选区位置，供替换时精确定位）
                super::store_selection_context(&SelectionInfo { text: t.clone(), rect: rect.clone(), has_image }, super::SelectionContext {
                    text: t.clone(),
                    rect: rect.clone(),
                    method: super::SelectionMethod::Clipboard,
                    foreground_hwnd: foreground.0 as isize,
                    focus_hwnd,
                    focus_class: focus_class.clone(),
                    sel_start,
                    sel_end,
                    occurrence_index: 0,
                });

                let info = SelectionInfo { text: t, rect, has_image };
                Ok(Some((info, foreground.0 as isize)))
            }
            _ if has_image => {
                // 纯图片选区（无文本）
                crate::utils::logger::log("clipboard_sel", "Clipboard has image but no text");
                if let Some(img_data) = image_data {
                    store_detected_image(img_data);
                }
                let info = SelectionInfo { text: String::new(), rect, has_image: true };
                Ok(Some((info, foreground.0 as isize)))
            }
            _ => {
                crate::utils::logger::log("clipboard_sel", "No text or image in clipboard after Ctrl+C");
                Ok(None)
            }
        }
    }
}

/// 获取前台窗口的焦点控件 HWND、类名和选区位置
/// Scintilla（Notepad++）等控件响应 EM_GETSEL，可获取精确选区位置
/// 返回 (focus_hwnd, focus_class, sel_start, sel_end)，失败时 hwnd=0
unsafe fn get_focus_selection(foreground: HWND) -> (isize, String, u32, u32) {
    let thread_id = GetWindowThreadProcessId(foreground, None);
    if thread_id == 0 {
        return (0, String::new(), 0, 0);
    }
    let mut gui_info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if GetGUIThreadInfo(thread_id, &mut gui_info).is_err() {
        return (0, String::new(), 0, 0);
    }
    let focus = gui_info.hwndFocus;
    if focus.is_invalid() {
        return (0, String::new(), 0, 0);
    }
    let mut buf = [0u16; 256];
    let len = GetClassNameW(focus, &mut buf);
    let class = if len > 0 {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        String::new()
    };

    // 尝试 EM_GETSEL 读取选区位置
    let mut sel_start: u32 = 0;
    let mut sel_end: u32 = 0;
    use windows::Win32::UI::Controls::EM_GETSEL;
    use windows::Win32::Foundation::{WPARAM, LPARAM};

    // Scintilla 控件用 SCI 消息（字节位置），EM_GETSEL 返回的位置与
    // EM_SETSEL 接受的位置单位不一致，会导致去重等长度变化的替换定位错位
    // Scintilla 消息：SCI_GETSELSTART=2143, SCI_GETSELEND=2145
    const SCI_GETSELSTART: u32 = 2143;
    const SCI_GETSELEND: u32 = 2145;
    if class.contains("Scintilla") {
        sel_start = SendMessageW(focus, SCI_GETSELSTART, None, None).0 as u32;
        sel_end = SendMessageW(focus, SCI_GETSELEND, None, None).0 as u32;
    } else {
        let result = SendMessageW(
            focus,
            EM_GETSEL,
            Some(WPARAM(&mut sel_start as *mut u32 as usize)),
            Some(LPARAM(&mut sel_end as *mut u32 as isize)),
        );
        if sel_start == 0 && sel_end == 0 && result.0 != 0 {
            sel_start = (result.0 & 0xFFFF) as u32;
            sel_end = ((result.0 >> 16) & 0xFFFF) as u32;
        }
    }
    (focus.0 as isize, class, sel_start, sel_end)
}

/// 通过模拟 Ctrl+V 替换选中文字
/// 流程：恢复焦点 → 选中目标范围（键盘）→ 设置剪贴板 → Ctrl+V → 重选新文本（键盘）
///
/// 关键约束（实测得出）：
/// - Scintilla 的 SCI_SETSEL/EM_SETSEL 跨进程 SendMessageW 会破坏选区（设为 0..0），不可用
/// - EmptyClipboard 不会清除 Scintilla 选区，所以设置剪贴板前后选区保持
/// - 因此用键盘 Shift+Right 选中目标范围，Ctrl+V 替换，再用 Shift+Left 重选新文本
pub fn replace_text_via_clipboard(ctx: &SelectionContext, new_text: &str) -> Result<(), String> {
    unsafe {
        // 恢复前台窗口焦点
        if ctx.foreground_hwnd != 0 {
            let foreground_hwnd = HWND(ctx.foreground_hwnd as *mut std::ffi::c_void);
            let _ = SetForegroundWindow(foreground_hwnd);
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        // 选中目标范围 [sel_start, sel_end]
        // 连续替换时前次操作已重选新文本，选区正好是本次目标，无需重新选中
        // 但若选区丢失（焦点变化等），用键盘重新选中
        ensure_selection(ctx, ctx.sel_start, ctx.sel_end);

        // 保存当前剪贴板
        let saved_clipboard = save_clipboard_text();

        // 设置剪贴板为新文本（EmptyClipboard 不清除 Scintilla 选区）
        if !set_clipboard_text(new_text) {
            return Err("设置剪贴板失败".to_string());
        }

        // 粘贴前释放所有修饰键，防止 Ctrl 卡住导致 Ctrl+Shift+V
        release_all_modifiers();

        // 模拟 Ctrl+V
        if !simulate_paste() {
            if let Some(ref saved) = saved_clipboard {
                restore_clipboard_text(saved);
            }
            return Err("模拟 Ctrl+V 失败".to_string());
        }

        // 等待粘贴完成
        std::thread::sleep(std::time::Duration::from_millis(150));

        // 恢复前台焦点
        if ctx.foreground_hwnd != 0 {
            let foreground_hwnd = HWND(ctx.foreground_hwnd as *mut std::ffi::c_void);
            let _ = SetForegroundWindow(foreground_hwnd);
            std::thread::sleep(std::time::Duration::from_millis(30));
        }

        // 释放修饰键
        release_all_modifiers();

        // 重选刚粘贴的新文本：粘贴后光标在末尾，Shift+Left 向左选中
        let new_code_points = new_text.chars().count();
        if new_code_points > 0 && new_code_points <= MAX_RESELECT_CHARS {
            select_text_before_cursor(new_code_points);
            std::thread::sleep(std::time::Duration::from_millis(100));
            crate::utils::logger::log("clipboard_sel", &format!("Re-selected via Shift+Left ({} code points)", new_code_points));
        }

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
        // GlobalLock 失败，hmem 仍有效但无法写入，必须释放避免泄漏
        let _ = windows::Win32::Foundation::GlobalFree(Some(hmem));
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
pub unsafe fn simulate_copy() -> bool {
    simulate_key_combo(VK_CONTROL, 0x43) // 0x43 = 'C'
}

/// 模拟 Ctrl+V 按键
unsafe fn simulate_paste() -> bool {
    simulate_key_combo(VK_CONTROL, 0x56) // 0x56 = 'V'
}

/// 释放所有修饰键（Ctrl/Shift/Alt），防止按键卡住影响后续操作
unsafe fn release_all_modifiers() {
    let modifiers = [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN];
    let mut inputs = Vec::with_capacity(modifiers.len());
    for m in modifiers {
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: m, dwFlags: KEYEVENTF_KEYUP, ..Default::default() },
            },
        });
    }
    let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    std::thread::sleep(std::time::Duration::from_millis(30));
}

/// 确保目标范围 [sel_start, sel_end] 被选中
/// 连续替换时，前次操作已用 Shift+Left 重选新文本，当前选区即为目标，无需操作
/// 此函数仅记录诊断信息；若选区丢失（如焦点变化），无法可靠恢复
unsafe fn ensure_selection(ctx: &SelectionContext, _sel_start: u32, _sel_end: u32) {
    if let Some((s, e)) = read_actual_selection(ctx.focus_hwnd, &ctx.focus_class) {
        if s == 0 && e == 0 {
            crate::utils::logger::log("clipboard_sel", "Warning: selection lost before replace");
        }
    }
}

/// 读取控件当前实际选区位置（用于替换后更新上下文，避免换行符导致的位置计算偏差）
/// - Scintilla：SCI_GETSELSTART/SCI_GETSELEND（字节位置）
/// - EDIT/RICHEDIT：EM_GETSEL（UTF-16 位置）
pub unsafe fn read_actual_selection(focus_hwnd: isize, focus_class: &str) -> Option<(u32, u32)> {
    if focus_hwnd == 0 {
        return None;
    }
    let hwnd = HWND(focus_hwnd as *mut std::ffi::c_void);
    const SCI_GETSELSTART: u32 = 2143;
    const SCI_GETSELEND: u32 = 2145;
    if focus_class.contains("Scintilla") {
        let s = SendMessageW(hwnd, SCI_GETSELSTART, None, None).0 as u32;
        let e = SendMessageW(hwnd, SCI_GETSELEND, None, None).0 as u32;
        Some((s, e))
    } else {
        let (s, e) = read_sel(focus_hwnd);
        Some((s, e))
    }
}

/// 通过 EM_SETSEL 消息直接设置选区

/// 读取控件当前选区位置（EM_GETSEL），用于诊断
unsafe fn read_sel(focus_hwnd: isize) -> (u32, u32) {
    use windows::Win32::UI::Controls::EM_GETSEL;
    use windows::Win32::Foundation::{WPARAM, LPARAM};
    if focus_hwnd == 0 {
        return (0, 0);
    }
    let hwnd = HWND(focus_hwnd as *mut std::ffi::c_void);
    let mut sel_start: u32 = 0;
    let mut sel_end: u32 = 0;
    let result = SendMessageW(
        hwnd,
        EM_GETSEL,
        Some(WPARAM(&mut sel_start as *mut u32 as usize)),
        Some(LPARAM(&mut sel_end as *mut u32 as isize)),
    );
    if sel_start == 0 && sel_end == 0 && result.0 != 0 {
        sel_start = (result.0 & 0xFFFF) as u32;
        sel_end = ((result.0 >> 16) & 0xFFFF) as u32;
    }
    (sel_start, sel_end)
}

/// 模拟 Shift+Left 选中光标左侧的指定字符数
/// 超过 MAX_RESELECT_CHARS 时跳过重选，避免大量 SendInput 导致丢键
const MAX_RESELECT_CHARS: usize = 200;
unsafe fn select_text_before_cursor(char_count: usize) {
    if char_count > MAX_RESELECT_CHARS {
        crate::utils::logger::log("clipboard_sel", &format!(
            "Skip re-select: {} chars exceeds max {}", char_count, MAX_RESELECT_CHARS
        ));
        return;
    }
    // Shift down → N次 Left down/up → Shift up
    let mut inputs = Vec::with_capacity(2 + char_count * 2);
    // Shift down
    inputs.push(INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VK_SHIFT, ..Default::default() },
        },
    });
    // N 次 Left
    for _ in 0..char_count {
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: VK_LEFT, ..Default::default() },
            },
        });
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: VK_LEFT, dwFlags: KEYEVENTF_KEYUP, ..Default::default() },
            },
        });
    }
    // Shift up
    inputs.push(INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VK_SHIFT, dwFlags: KEYEVENTF_KEYUP, ..Default::default() },
        },
    });
    let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
}

/// 模拟 Ctrl+Key 组合键
unsafe fn simulate_key_combo(modifier: VIRTUAL_KEY, key: u16) -> bool {
    // 先释放所有修饰键，防止前次操作遗留卡住的 Ctrl/Shift/Alt/Win
    // 导致本次组合键变形（如 Ctrl+C 变成 Ctrl+Shift+C 或 Shift+C），复制/粘贴失效
    release_all_modifiers();

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

/// 读取剪贴板中的图片数据（CF_DIB 格式）
/// 返回图片的原始字节数据
/// # Safety
/// 调用者需确保在合适的时机调用（会打开和关闭剪贴板）
pub(crate) unsafe fn read_clipboard_image() -> Option<Vec<u8>> {
    if OpenClipboard(None).is_err() {
        return None;
    }

    let result = (|| -> Option<Vec<u8>> {
        let handle = GetClipboardData(CF_DIB).ok()?;
        if handle.is_invalid() {
            return None;
        }
        let hmem = HGLOBAL(handle.0);
        let ptr = GlobalLock(hmem);
        if ptr.is_null() {
            return None;
        }
        let size = GlobalSize(hmem);
        if size == 0 {
            let _ = GlobalUnlock(hmem);
            return None;
        }
        let data = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
        let _ = GlobalUnlock(hmem);
        Some(data)
    })();

    let _ = CloseClipboard();
    result
}

/// 将 CF_DIB 图片数据写入剪贴板
#[allow(dead_code)]
pub fn write_clipboard_image(dib_data: &[u8]) -> bool {
    unsafe {
        if OpenClipboard(None).is_err() {
            return false;
        }

        let _ = EmptyClipboard();

        let hmem = match GlobalAlloc(GMEM_MOVEABLE, dib_data.len()) {
            Ok(h) => h,
            Err(_) => {
                let _ = CloseClipboard();
                return false;
            }
        };
        let ptr = GlobalLock(hmem);
        if ptr.is_null() {
            let _ = windows::Win32::Foundation::GlobalFree(Some(hmem));
            let _ = CloseClipboard();
            return false;
        }
        std::ptr::copy_nonoverlapping(dib_data.as_ptr(), ptr as *mut u8, dib_data.len());
        let _ = GlobalUnlock(hmem);
        let _ = SetClipboardData(CF_DIB, Some(HANDLE(hmem.0)));
        let _ = CloseClipboard();
        true
    }
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
