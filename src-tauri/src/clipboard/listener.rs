//! 剪贴板内容变化监听（覆盖所有复制来源）。
//!
//! 通过 AddClipboardFormatListener 注册一个隐藏消息窗口，接收 WM_CLIPBOARDUPDATE
//! 通知，将剪贴板文本变化追加到快速输入转盘历史。相比键盘钩子只检测 Ctrl+C，
//! 此方案覆盖右键复制、应用内自动复制等所有来源，历史更完整。
//!
//! 自写防护：应用内部机制向剪贴板写入内容（转盘粘贴的目标文本与恢复的原内容、
//! 工具栏替换文本、划词检测恢复的原内容等）通过 mark_self_write 标记，
//! 监听器检测到剪贴板内容与标记一致时跳过，避免把「粘贴的内容」或「恢复的原内容」
//! 误入历史。用户主动发起的应用内复制（如 copy_text 命令）不属于自写，正常入历史。

use std::sync::Mutex;

use windows::core::w;
use windows::Win32::Foundation::{HGLOBAL, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::{
    AddClipboardFormatListener, CloseClipboard, GetClipboardData, OpenClipboard,
    RemoveClipboardFormatListener,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
    PostQuitMessage, RegisterClassExW, TranslateMessage, MSG, WINDOW_EX_STYLE, WS_EX_TOOLWINDOW,
    WM_DESTROY, WNDCLASSEXW, WS_OVERLAPPED,
};

/// CF_UNICODETEXT
const CF_UNICODETEXT: u32 = 13;
/// 剪贴板文本最大字符数（防损坏数据越界）
const MAX_CLIPBOARD_U16: usize = 1024 * 1024;
/// WM_CLIPBOARDUPDATE（剪贴板内容变化通知）
const WM_CLIPBOARDUPDATE: u32 = 0x031D;
/// 自写标记有效时长（毫秒）。写入后超过该时长标记视为过期，
/// 防止写入图片等无文本更新场景下残留的标记导致后续相同内容被误跳过。
const SELF_WRITE_TIMEOUT_MS: u64 = 3000;

/// 监听线程状态
struct ListenerState {
    /// 应用最近一次写入剪贴板的文本及时间（自写防护）
    self_write: Mutex<Option<SelfWriteEntry>>,
}

static LISTENER_STATE: ListenerState = ListenerState {
    self_write: Mutex::new(None),
};

/// 自写标记条目
struct SelfWriteEntry {
    text: String,
    at_ms: u64,
}

/// 当前时间戳（毫秒）
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 启动剪贴板监听线程（应用启动时调用一次）
pub fn start_clipboard_listener() {
    std::thread::spawn(run_listener_message_loop);
}

/// 应用在写入剪贴板前调用，标记自写内容，避免被监听器误入历史。
pub fn mark_self_write(text: &str) {
    if let Ok(mut sw) = LISTENER_STATE.self_write.lock() {
        *sw = Some(SelfWriteEntry {
            text: text.to_string(),
            at_ms: now_ms(),
        });
    }
}

/// 监听线程：创建隐藏窗口并注册为剪贴板格式监听器，跑消息循环
fn run_listener_message_loop() {
    unsafe {
        let hinst = match GetModuleHandleW(None) {
            Ok(h) => h,
            Err(e) => {
                crate::utils::logger::log("clipboard", &format!("GetModuleHandleW failed: {}", e));
                return;
            }
        };

        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(listener_wndproc),
            hInstance: hinst.into(),
            lpszClassName: w!("LevitaireClipboardListener"),
            ..Default::default()
        };
        let _ = RegisterClassExW(&wc);

        // 隐藏顶层窗口（WS_EX_TOOLWINDOW 不占 Alt-Tab，不显示即不可见），
        // 用于接收 WM_CLIPBOARDUPDATE 通知。
        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(WS_EX_TOOLWINDOW.0),
            w!("LevitaireClipboardListener"),
            w!("LevitaireClipboardListener"),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(hinst.into()),
            None,
        ) {
            Ok(h) => h,
            Err(e) => {
                crate::utils::logger::log("clipboard", &format!("CreateWindowExW failed: {}", e));
                return;
            }
        };

        // 注册为剪贴板格式监听器，失败则销毁窗口并退出
        if AddClipboardFormatListener(hwnd).is_err() {
            crate::utils::logger::log("clipboard", "AddClipboardFormatListener failed");
            let _ = DestroyWindow(hwnd);
            return;
        }

        crate::utils::logger::log("clipboard", "clipboard format listener installed");

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).into() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        let _ = RemoveClipboardFormatListener(hwnd);
        crate::utils::logger::log("clipboard", "clipboard listener message loop exited");
    }
}

/// 窗口过程（在监听线程内执行）
unsafe extern "system" fn listener_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_CLIPBOARDUPDATE => {
            handle_clipboard_update();
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// 剪贴板变化处理：读取文本，跳过自写内容，其余追加到快速输入转盘历史
unsafe fn handle_clipboard_update() {
    // 其他进程写入时可能短暂占用剪贴板，重试读取（10ms 间隔，最多 3 次）。
    // 空文本 / 读取失败均跳过：EmptyClipboard 后的空通知不产生历史，
    // 最终数据由随后的 SetClipboardData 通知记录。
    let mut text = None;
    for _ in 0..3 {
        text = read_clipboard_text();
        if text.is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let Some(text) = text else { return };
    if text.is_empty() {
        return;
    }

    // 自写防护：与应用最近一次写入的内容一致则跳过。标记匹配时保留（不消费），
    // 供紧随其后的多个 WM_CLIPBOARDUPDATE 通知继续匹配——转盘粘贴流程会先写目标
    // 文本、后写回原内容（两次通知），若处理延迟导致第一次通知读到的是原内容，
    // 保留标记才能保证两次通知都正确跳过，避免「恢复的原内容」误入历史。
    if let Ok(mut sw) = LISTENER_STATE.self_write.lock() {
        if check_self_write(&mut sw, &text, now_ms()) {
            return;
        }
    }

    crate::quick_input::push_history(&text);
    crate::utils::logger::log(
        "clipboard",
        &format!("Clipboard changed, recorded history: {} chars", text.len()),
    );
}

/// 自写检查：标记未过期且内容与剪贴板一致 → 判定为自写（返回 true，保留标记）。
/// 标记过期或内容不一致 → 清除标记（作废），返回 false（按外部复制正常记录）。
/// 清除而非保留过期/不匹配的标记，防止残留标记误伤后续相同内容的正常复制。
fn check_self_write(entry: &mut Option<SelfWriteEntry>, text: &str, now: u64) -> bool {
    let Some(e) = entry.as_ref() else {
        return false;
    };
    if now.saturating_sub(e.at_ms) <= SELF_WRITE_TIMEOUT_MS && e.text == text {
        return true;
    }
    *entry = None;
    false
}

/// 读取当前剪贴板的文本内容（自动管理剪贴板开关，带长度上限保护）
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
        let max_u16 = if mem_size > 0 {
            mem_size / 2
        } else {
            MAX_CLIPBOARD_U16
        };
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_constants() {
        assert_eq!(CF_UNICODETEXT, 13);
        assert_eq!(WM_CLIPBOARDUPDATE, 0x031D);
        assert!(SELF_WRITE_TIMEOUT_MS > 0);
    }

    #[test]
    fn check_self_write_matches_fresh_and_keeps_marker() {
        let mut entry = Some(SelfWriteEntry {
            text: "hello".to_string(),
            at_ms: 1000,
        });
        assert!(check_self_write(&mut entry, "hello", 2000));
        // 匹配时保留标记：转盘粘贴会连续多次写剪贴板（目标文本 + 恢复原内容），
        // 保留标记才能让后续通知继续正确跳过
        assert!(entry.is_some(), "匹配时标记应保留，供后续通知继续匹配");
    }

    #[test]
    fn check_self_write_rejects_expired_and_clears() {
        let mut entry = Some(SelfWriteEntry {
            text: "hello".to_string(),
            at_ms: 1000,
        });
        // 超过超时窗口：即使内容相同也视为外部复制
        assert!(!check_self_write(
            &mut entry,
            "hello",
            1000 + SELF_WRITE_TIMEOUT_MS + 1
        ));
        assert!(entry.is_none(), "过期标记应被清除，防止残留误伤");
    }

    #[test]
    fn check_self_write_rejects_different_text_and_clears() {
        let mut entry = Some(SelfWriteEntry {
            text: "hello".to_string(),
            at_ms: 1000,
        });
        assert!(!check_self_write(&mut entry, "world", 2000));
        assert!(entry.is_none(), "不匹配标记应被清除");
    }

    #[test]
    fn check_self_write_no_marker() {
        let mut entry: Option<SelfWriteEntry> = None;
        assert!(!check_self_write(&mut entry, "hello", 1000));
    }

    #[test]
    fn check_self_write_at_boundary_is_fresh() {
        let mut entry = Some(SelfWriteEntry {
            text: "hello".to_string(),
            at_ms: 1000,
        });
        // 恰好在超时边界内仍视为新鲜
        assert!(check_self_write(&mut entry, "hello", 1000 + SELF_WRITE_TIMEOUT_MS));
        assert!(entry.is_some());
    }

    #[test]
    fn check_self_write_keeps_marker_for_consecutive_updates() {
        // 模拟转盘粘贴的竞态：先写目标文本、后写回原内容，且第一个通知处理延迟
        // （读到的是原内容）。保留标记才能让连续两次通知都正确跳过，原内容不误入历史。
        let mut entry = Some(SelfWriteEntry {
            text: "original".to_string(),
            at_ms: 1000,
        });
        assert!(check_self_write(&mut entry, "original", 1100));
        assert!(check_self_write(&mut entry, "original", 1200));
        assert!(entry.is_some(), "连续匹配后标记应保留，供后续通知继续匹配");
        // 之后外部复制了不同内容 → 标记作废，正常记录
        assert!(!check_self_write(&mut entry, "new-copy", 1300));
        assert!(entry.is_none());
    }
}
