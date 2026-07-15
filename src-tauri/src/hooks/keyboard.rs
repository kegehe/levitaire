use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::OnceLock;
use tauri::{Emitter, Manager};
use windows::Win32::Foundation::{HGLOBAL, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

/// 键盘钩子全局状态
struct KeyboardState {
    hook_ptr: AtomicPtr<std::ffi::c_void>,
    enabled: AtomicBool,
    app_handle: OnceLock<tauri::AppHandle>,
    /// #4: 防止快速连按 Ctrl+C 创建大量线程，用锁控制并发
    processing: AtomicBool,
    /// 截图 Esc 退出防护：防止连按 Esc 创建多个退出线程（cancel 幂等，但避免无谓并发）
    cancelling: AtomicBool,
    /// 防止长按录制控制快捷键重复创建任务。
    recording_control: AtomicBool,
}

static KB_STATE: KeyboardState = KeyboardState {
    hook_ptr: AtomicPtr::new(std::ptr::null_mut()),
    enabled: AtomicBool::new(true),
    app_handle: OnceLock::new(),
    processing: AtomicBool::new(false),
    cancelling: AtomicBool::new(false),
    recording_control: AtomicBool::new(false),
};

/// 剪贴板文本最大字符数（1: 防止损坏数据越界）
const MAX_CLIPBOARD_U16: usize = 1024 * 1024;
/// CF_UNICODETEXT 甯搁噺
const CF_UNICODETEXT: u32 = 13;

/// 安装全局键盘钩子，监听 Ctrl+C 后读取剪贴板并触发选区事件
pub fn start_keyboard_hook(app_handle: tauri::AppHandle) {
    KB_STATE
        .app_handle
        .set(app_handle)
        .expect("KB app_handle already set");

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
                crate::utils::logger::log(
                    "keyboard",
                    &format!("Failed to install keyboard hook: {:?}", e),
                );
            }
        }
    }
}

/// 停止键盘钩子
#[allow(dead_code)]
pub fn stop_keyboard_hook() {
    let ptr = KB_STATE
        .hook_ptr
        .swap(std::ptr::null_mut(), Ordering::SeqCst);
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
                return CallNextHookEx(
                    Some(HHOOK(KB_STATE.hook_ptr.load(Ordering::SeqCst))),
                    code,
                    wparam,
                    lparam,
                );
            }

            let vk_code = kb_ref.vkCode;

            // A full-screen or edge-to-edge recording has no safe location for
            // overlay controls. Keep these controls global and outside capture.
            let in_recording = crate::hooks::mouse::is_recording_mode();
            let ctrl_pressed = (GetKeyState(VK_CONTROL.0 as i32) as u16) & 0x8000 != 0;
            let shift_pressed = (GetKeyState(VK_SHIFT.0 as i32) as u16) & 0x8000 != 0;
            if in_recording && ctrl_pressed && shift_pressed && (vk_code == 0x53 || vk_code == 0x50)
            {
                if KB_STATE
                    .recording_control
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    if let Some(app) = KB_STATE.app_handle.get() {
                        let app_clone = app.clone();
                        std::thread::spawn(move || {
                            if let Some(state) =
                                app_clone.try_state::<crate::recording::RecordingState>()
                            {
                                let result = if vk_code == 0x53 {
                                    state.stop().map(|_| {
                                        crate::hooks::mouse::set_recording_mode(false);
                                        let _ = crate::commands::finish_recording_controls(app_clone.clone());
                                        let _ = app_clone.emit("recording-stop-requested", ());
                                    })
                                } else if state.is_paused() {
                                    state.resume().map(|_| {
                                        let _ = app_clone.emit("recording-resumed", ());
                                    })
                                } else {
                                    state.pause().map(|_| {
                                        let _ = app_clone.emit("recording-paused", ());
                                    })
                                };
                                if let Err(error) = result {
                                    crate::utils::logger::log(
                                        "recording",
                                        &format!("global recording control failed: {}", error),
                                    );
                                }
                            }
                            KB_STATE.recording_control.store(false, Ordering::SeqCst);
                        });
                    } else {
                        KB_STATE.recording_control.store(false, Ordering::SeqCst);
                    }
                }
                return LRESULT(1);
            }

            // 截图/录制模式：监听 Esc 全局退出（不依赖 overlay 焦点，可靠退出）
            // VK_ESCAPE = 0x1B
            if vk_code == 0x1B {
                let in_screenshot = crate::hooks::mouse::is_screenshot_mode()
                    || crate::commands::is_screenshot_starting();
                if in_screenshot {
                    // 防抖：连按 Esc 只触发一次退出线程（cancel 幂等，但避免无谓并发）
                    if KB_STATE
                        .cancelling
                        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                    {
                        if let Some(app) = KB_STATE.app_handle.get() {
                            let app_clone = app.clone();
                            let session = crate::commands::current_screenshot_session();
                            std::thread::spawn(move || {
                                cancel_screenshot_global(app_clone, session);
                                KB_STATE.cancelling.store(false, Ordering::SeqCst);
                            });
                        } else {
                            KB_STATE.cancelling.store(false, Ordering::SeqCst);
                        }
                    }
                } else if in_recording
                    || KB_STATE
                        .app_handle
                        .get()
                        .and_then(|app| app.try_state::<crate::recording::RecordingState>())
                        .map(|state| state.is_finishing())
                        .unwrap_or(false)
                {
                    // 录制模式 Esc：通知前端取消录制
                    if let Some(app) = KB_STATE.app_handle.get() {
                        let _ = app.emit("recording-esc-cancel", ());
                    }
                }
                // 不吞键，继续传递，前端 keydown 也能收到
            }

            // 妫€娴?Ctrl+C
            if vk_code == 0x43 {
                let ctrl_pressed = (GetKeyState(VK_CONTROL.0 as i32) as u16) & 0x8000 != 0;
                if ctrl_pressed {
                    // #4: 鐢?AtomicBool 鍋?debounce锛岄槻姝㈠揩閫熻繛鎸夊垱寤哄ぇ閲忕嚎绋?
                    if KB_STATE
                        .processing
                        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                    {
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
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    static PROCESSING_STATE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn test_constants() {
        assert_eq!(CF_UNICODETEXT, 13);
        assert_eq!(MAX_CLIPBOARD_U16, 1024 * 1024);
    }

    #[test]
    fn test_processing_flag_initial_false() {
        let _guard = PROCESSING_STATE_TEST_LOCK.lock().unwrap();
        KB_STATE.processing.store(false, Ordering::SeqCst);
        // KB_STATE.processing 鏄?AtomicBool锛屽垵濮嬩负 false
        assert!(!KB_STATE.processing.load(Ordering::SeqCst));
    }

    #[test]
    fn test_processing_flag_debounce() {
        let _guard = PROCESSING_STATE_TEST_LOCK.lock().unwrap();
        KB_STATE.processing.store(false, Ordering::SeqCst);
        // 妯℃嫙 compare_exchange 琛屼负
        // 第一次应成功（false → true）
        let first =
            KB_STATE
                .processing
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst);
        assert!(first.is_ok(), "first compare_exchange should succeed");

        // 第二次应失败（已为 true）
        let second =
            KB_STATE
                .processing
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst);
        assert!(second.is_err(), "second compare_exchange should fail");

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
        assert!(image_formats_equal(&[8, 2], &[2, 8])); // 蹇界暐椤哄簭
    }

    #[test]
    fn test_image_formats_equal_different() {
        assert!(!image_formats_equal(&[8], &[8, 2]));
        assert!(!image_formats_equal(&[8, 2], &[8]));
        assert!(!image_formats_equal(&[8], &[2]));
    }
}

/// 截图模式下 Esc 全局退出：隐藏 overlay + 重置 screenshot_mode
/// 由全局键盘钩子触发，不依赖 overlay 窗口焦点（解决透明全屏窗口失焦时前端 keydown 收不到的问题）
fn cancel_screenshot_global(app: tauri::AppHandle, session: u64) {
    crate::commands::cleanup_screenshot_session_if_current(&app, session);
    // 通知前端重置 React 状态（选区/图片/繁忙态），避免再次 show 时残留
    let _ = app.emit_to("screenshot-overlay", "screenshot-cancelled", ());
    crate::utils::logger::log("keyboard", "Screenshot cancelled by Esc (global hook)");
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
    ClipSnapshot {
        text: None,
        has_image: false,
    }
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
        crate::utils::logger::log(
            "keyboard",
            "Ctrl+C detected but clipboard unchanged, skipping",
        );
        return;
    }

    // 文字工具栏已禁用：与鼠标抬起选区路径保持一致，Ctrl+C 也不弹出工具栏
    if !crate::hooks::mouse::is_text_toolbar_enabled() {
        crate::utils::logger::log(
            "keyboard",
            "Ctrl+C detected but text toolbar disabled, skipping",
        );
        return;
    }

    let clipboard_text = new_text.unwrap_or_default();
    crate::utils::logger::log(
        "keyboard",
        &format!(
            "Ctrl+C detected, clipboard: {} chars, has_image: {}",
            clipboard_text.len(),
            new_has_image
        ),
    );

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

    let info = crate::automation::SelectionInfo {
        text: clipboard_text,
        rect,
        has_image: new_has_image,
    };

    crate::automation::store_selection_context(
        &info,
        crate::automation::SelectionContext {
            text: info.text.clone(),
            rect: info.rect.clone(),
            method: crate::automation::SelectionMethod::Clipboard,
            foreground_hwnd,
            focus_hwnd: 0,
            focus_class: String::new(),
            sel_start: 0,
            sel_end: 0,
            occurrence_index: 0,
        },
    );

    let _ = app.emit("selection-found", &info);

    if let Some(win) = app.get_webview_window("toolbar") {
        let x = cursor_pos.x;
        let y = cursor_pos.y + 20;
        let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            x, y,
        )));
        let _ = win.show();
        // 同步鼠标钩子的工具栏可见状态，确保点击外部可以正确隐藏
        crate::hooks::set_toolbar_visible(true);
        // 鏇存柊绐楀彛鍙ユ焺缂撳瓨
        if let Ok(hwnd) = win.hwnd() {
            crate::hooks::mouse::update_toolbar_hwnd(hwnd.0);
        }
    }

    crate::utils::logger::log("keyboard", "Toolbar shown after Ctrl+C");
}

// ─── 剪贴板工具函数 ─────────────────────────────────────────────

/// 判断两次检测到的图片格式列表是否相同（忽略顺序）仅测试中使用（生产代码直接用 ClipSnapshot.has_image bool 比较）
#[cfg(test)]
fn image_formats_equal(old: &[u32], new_formats: &[u32]) -> bool {
    if old.len() != new_formats.len() {
        return false;
    }
    // 两个列表通常很短（2-3 个元素），直接逐一比较
    for fmt in old {
        if !new_formats.contains(fmt) {
            return false;
        }
    }
    true
}

/// 检查当前剪贴板是否包含图片格式
/// 鍦?OpenClipboard 鐘舵€佷笅璋冪敤
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

/// 读取剪贴板图片数据（自动管理剪贴板开关）
/// 仅在测试中使用
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

/// 读取当前剪贴板的文本内容（1: 带长度上限保护）
/// 蹇呴』鍦?OpenClipboard 鐘舵€佷笅璋冪敤
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
