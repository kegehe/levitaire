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
const MAX_CLIPBOARD_DIB_BYTES: usize = 48 * 1024 * 1024;
/// CF_UNICODETEXT 常量
const CF_UNICODETEXT: u32 = 13;

/// 安装全局键盘钩子，监听 Ctrl+C 后读取剪贴板并触发选区事件。
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
        let vk_code = kb_ref.vkCode;

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

            // A full-screen or edge-to-edge recording has no safe location for
            // overlay controls. Keep these controls global and outside capture.
            let in_recording = crate::hooks::mouse::is_recording_mode();
            let in_long_capture = KB_STATE
                .app_handle
                .get()
                .and_then(|app| app.try_state::<crate::scroll_capture::LongCaptureState>())
                .map(|state| state.is_active())
                .unwrap_or(false);
            let in_screenshot = crate::hooks::mouse::is_screenshot_mode()
                || in_long_capture
                || crate::commands::is_screenshot_starting();
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
                                        let _ = crate::commands::finish_recording_controls(
                                            app_clone.clone(),
                                        );
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
                // 窗口置顶点选：Esc 退出。该模式下左键被全局吞掉，除了回去点一次按钮
                // 没有别的退出方式 —— 用户一旦忘记，整台机器都点不动。
                //
                // 必须挂在同一条 else-if 链上：这几件事都由 Esc 触发，但一次按键只该
                // 做一件 —— 平铺成两个 if 的话，退出点选的同时会把可见的文字工具栏
                // 也一并关掉。
                if crate::hooks::mouse::is_window_pin_active() {
                    // 钩子回调内不能阻塞（超时会被系统静默卸载钩子），收尾放独立线程。
                    if let Some(app) = KB_STATE.app_handle.get() {
                        let app_clone = app.clone();
                        std::thread::spawn(move || {
                            crate::hooks::mouse::stop_window_pin();
                            crate::window_pin::publish(
                                &app_clone,
                                Some("已退出窗口置顶".to_string()),
                            );
                        });
                    }
                } else if in_screenshot {
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
                    // 录制模式 Esc：后端直接清理 + 通知前端重置 UI。
                    // 后端清理不依赖前端监听器，避免前端未挂载时 recording_mode 残留。
                    if let Some(app) = KB_STATE.app_handle.get() {
                        let app_clone = app.clone();
                        // 防抖：与 cancelling 共用互斥锁，避免连按 Esc 创建多个清理线程
                        if KB_STATE
                            .cancelling
                            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok()
                        {
                            std::thread::spawn(move || {
                                if let Some(state) =
                                    app_clone.try_state::<crate::recording::RecordingState>()
                                {
                                    if state.is_running() {
                                        let _ = state.cancel();
                                    }
                                }
                                let _ = crate::commands::cancel_recording_select(app_clone.clone());
                                KB_STATE.cancelling.store(false, Ordering::SeqCst);
                            });
                        }
                        // 同时通知前端（如果已挂载则重置 UI，未挂载也无害）
                        let _ = app.emit("recording-esc-cancel", ());
                    }
                } else if crate::hooks::is_toolbar_visible() {
                    // 文字工具栏可见时，Esc 由全局钩子转发给前端：
                    // 工具栏窗口 focusable=false，页面内 DOM keydown 收不到按键，
                    // 组件里为 Esc/子菜单准备的关闭逻辑实际不会触发。
                    // 只转发不吞键——目标应用仍能收到 Esc（例如取消文本选区），
                    // 与「点击工具栏外部时透传给目标应用」的语义保持一致。
                    // WH_KEYBOARD_LL 回调要求在超时内返回，否则 Windows 会静默卸载钩子；
                    // emit_to 在窗口创建等场景下可能短暂阻塞，因此在独立线程执行。
                    if let Some(app) = KB_STATE.app_handle.get() {
                        let app_clone = app.clone();
                        std::thread::spawn(move || {
                            let _ = app_clone.emit_to("toolbar", "toolbar-esc", ());
                        });
                    }
                } else if crate::quick_input::is_active() {
                    // 快速输入转盘激活时，Esc 同理只转发给转盘前端（overlay 无焦点收不到 DOM 事件）：
                    // 子级 = 返回上一级，根级 = 关闭转盘，由前端按当前层级裁决。
                    // 只转发不吞键，emit 在独立线程执行，避免钩子回调超时被系统卸载。
                    if let Some(app) = KB_STATE.app_handle.get() {
                        let generation = crate::quick_input::state().generation;
                        let app_clone = app.clone();
                        std::thread::spawn(move || {
                            let _ = app_clone.emit_to(
                                "quick-input-overlay",
                                "quick-input-esc",
                                serde_json::json!({ "generation": generation }),
                            );
                        });
                    }
                }
                // 不吞键，继续传递，前端 keydown 也能收到
            }

            // Smart screenshot uses Tab to switch between UI element and top-level window.
            if vk_code == 0x09 && crate::hooks::mouse::is_smart_screenshot_mode() {
                if let Some(app) = KB_STATE.app_handle.get() {
                    let _ = app.emit_to("screenshot-overlay", "screenshot-target-scope-toggle", ());
                }
                return LRESULT(1);
            }

            // Ctrl+C detection — only trigger outside screenshot/recording modes.
            // In those modes the overlay consumes selection; popping up the text
            // toolbar would interfere with the active tool.
            if vk_code == 0x43 && !in_recording && !in_screenshot && ctrl_pressed {
                // #4: 用 AtomicBool 做 debounce，防止快速连按创建大量线程
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
                    // 记录 Ctrl+C 按下瞬间工具栏是否可见：若可见而等待期间被用户关闭，
                    // 检测结果不应再把工具栏弹回（见 handle_ctrl_c 中的抑制逻辑）。
                    let toolbar_visible_at_ctrl_c = crate::hooks::is_toolbar_visible();
                    if let Some(app) = KB_STATE.app_handle.get() {
                        let app_clone = app.clone();
                        std::thread::spawn(move || {
                            handle_ctrl_c(
                                app_clone,
                                fg_hwnd,
                                old_clipboard,
                                toolbar_visible_at_ctrl_c,
                            );
                            KB_STATE.processing.store(false, Ordering::SeqCst);
                        });
                    } else {
                        KB_STATE.processing.store(false, Ordering::SeqCst);
                    }
                }
            } else if in_long_capture && matches!(vk_code, 0x28 | 0x22 | 0x20 | 0x23) {
                // Down, PageDown, Space and End can all advance a scrollable
                // target without producing WM_MOUSEWHEEL. Notify the worker
                // while allowing the key to reach the target application.
                if let Some(app) = KB_STATE.app_handle.get() {
                    if let Some(state) = app.try_state::<crate::scroll_capture::LongCaptureState>()
                    {
                        state.notify_activity_at_cursor();
                    }
                }
            }
        }

        // ── 快速输入转盘：触发键处理（支持两种触发模式）─────────
        // click 模式：点击唤出/再点击关闭，鼠标点击扇区确认输入；
        // hold 模式：按住唤出，松开按当前高亮扇区确认输入。
        // 跳过程序模拟的按键（SendInput 注入的事件标记为 LLKHF_INJECTED）。
        let trigger_vk = crate::quick_input::trigger_vk();
        if trigger_vk != 0 && vk_code == trigger_vk as u32 && kb_ref.flags.0 & 0x10 == 0 {
            // 日志仅做纯内存操作（无 GetWindowTextW 等跨进程调用），
            // 避免阻塞 WH_KEYBOARD_LL 回调导致钩子被系统静默卸载。
            crate::utils::logger::log(
                "keyboard",
                &format!(
                    "QUICK-TRIGGER key={} vk=0x{:X} msg=0x{:X} active={}",
                    crate::quick_input::vk_to_name(vk_code as u16),
                    vk_code,
                    msg,
                    crate::quick_input::is_active(),
                ),
            );
            if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                // 去重：按住不松时 Windows 会持续送重复 keydown，用 TRIGGER_DOWN 忽略，
                // 只有「新的一次按下」才处理。松开 keyup 时复位标志。
                if !crate::quick_input::is_trigger_down() {
                    crate::quick_input::set_trigger_down(true);
                    if crate::quick_input::is_hold_mode() {
                        crate::quick_input::reset_hold_release_pending();
                    }
                    if let Some(app) = KB_STATE.app_handle.get() {
                        // 重要：在独立线程执行 begin_wheel / toggle_wheel —— begin_wheel 里的 get_mouse_position/emit_to
                        // 若在设置窗口创建等场景下可能短暂阻塞，而 WH_KEYBOARD_LL 回调要求在超时内返回，
                        // 否则 Windows 会静默卸载整个键盘钩子。spawn 线程让回调立即返回，避免钩子被系统移除。
                        let app_clone = app.clone();
                        std::thread::spawn(move || {
                            if crate::quick_input::is_hold_mode() {
                                // 按住唤起模式：按下即唤起转盘（转盘已激活时保持，松开才确认）
                                if !crate::quick_input::is_active() {
                                    crate::quick_input::begin_wheel(&app_clone);
                                    // keyup 可能在 begin_wheel 的窗口操作期间先到达；
                                    // 此时补发确认，避免转盘在松开后仍保持激活。
                                    if crate::quick_input::is_hold_release_pending()
                                        || !crate::quick_input::is_trigger_down()
                                    {
                                        crate::quick_input::request_hold_confirmation(&app_clone);
                                    }
                                }
                            } else {
                                // 单击切换模式：当前已激活则关闭（取消），否则打开
                                crate::quick_input::toggle_wheel(&app_clone);
                            }
                        });
                    }
                }
                // 吞掉 keydown，避免 CapsLock 切换大写
                return LRESULT(1);
            } else if msg == WM_KEYUP || msg == WM_SYSKEYUP {
                // 松开触发器时复位按下标志，允许下一次按下再次触发。
                if crate::quick_input::is_hold_mode() && crate::quick_input::is_trigger_down() {
                    // 按住唤起模式：请求前端按 keyup 时鼠标位置结算扇区后再确认。
                    // 不能直接读取后端缓存的高亮：快速松开时最新异步同步可能尚未到达。
                    // GetCursorPos 仅是一次轻量 Win32 读取，必须在 keyup 回调当下执行，
                    // 这样 begin_wheel 延迟或前端 IPC 排队期间鼠标移动也不会改变结果。
                    let release_pos = crate::automation::get_mouse_position()
                        .unwrap_or(crate::automation::Point {
                            x: crate::quick_input::state().x,
                            y: crate::quick_input::state().y,
                        });
                    crate::quick_input::mark_hold_release_pending(release_pos.x, release_pos.y);
                    if crate::quick_input::is_active() {
                        if let Some(app) = KB_STATE.app_handle.get() {
                            let app_clone = app.clone();
                            std::thread::spawn(move || {
                                crate::quick_input::request_hold_confirmation(&app_clone);
                            });
                        }
                    }
                }
                // 单击切换模式：松开仅复位标志，允许下一次点击再次切换，
                // 不再触发确认——「鼠标点击扇区」才是输入确认语义。
                crate::quick_input::set_trigger_down(false);
                // 吞掉 keyup
                return LRESULT(1);
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
        // KB_STATE.processing 是 AtomicBool，初始为 false
        assert!(!KB_STATE.processing.load(Ordering::SeqCst));
    }

    #[test]
    fn test_processing_flag_debounce() {
        let _guard = PROCESSING_STATE_TEST_LOCK.lock().unwrap();
        KB_STATE.processing.store(false, Ordering::SeqCst);
        // 模拟 compare_exchange 行为
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
        assert!(image_formats_equal(&[8, 2], &[2, 8])); // 忽略顺序
    }

    #[test]
    fn test_image_formats_equal_different() {
        assert!(!image_formats_equal(&[8], &[8, 2]));
        assert!(!image_formats_equal(&[8, 2], &[8]));
        assert!(!image_formats_equal(&[8], &[2]));
    }

    /// Ctrl+C 时工具栏已可见 → 不重新弹/搬/重置（用户是在自己复制）。
    #[test]
    fn ctrl_c_keeps_an_already_visible_toolbar_untouched() {
        assert!(
            !should_present_toolbar_at_cursor(true),
            "工具栏已开着时按 Ctrl+C 不该再弹一次（会把窗口搬到光标处并重置前端状态）"
        );
    }

    /// Ctrl+C 时工具栏不可见 → 仍要弹出来（键盘选词、右键复制等场景靠它唤出工具栏）。
    #[test]
    fn ctrl_c_still_presents_the_toolbar_when_hidden() {
        assert!(
            should_present_toolbar_at_cursor(false),
            "工具栏没开时 Ctrl+C 仍应把工具栏弹到光标处"
        );
    }
}

/// 截图模式下 Esc 全局退出：隐藏 overlay + 重置 screenshot_mode
/// 由全局键盘钩子触发，不依赖 overlay 窗口焦点（解决透明全屏窗口失焦时前端 keydown 收不到的问题）
fn cancel_screenshot_global(app: tauri::AppHandle, session: u64) {
    // 返回 true 才表示本次确实取消了当前截图会话（CAS 成功）；
    // 若返回 false，说明 Esc 时 session 已过期、有更新的活跃会话接管，
    // 此时不应发 screenshot-cancelled，否则会误重置新会话前端的状态。
    if crate::commands::cleanup_screenshot_session_if_current(&app, session) {
        // 通知前端重置 React 状态（选区/图片/繁忙态），避免再次 show 时残留
        let _ = app.emit_to("screenshot-overlay", "screenshot-cancelled", ());
        crate::utils::logger::log("keyboard", "Screenshot cancelled by Esc (global hook)");
    }
}

/// 剪贴板快照，用于在钩子回调中快速捕获 Ctrl+C 前的剪贴板状态
struct ClipSnapshot {
    text: Option<String>,
    has_image: bool,
}

/// 在钩子回调中一次性读取剪贴板的文本和图片格式状态
/// 单次 Open/Close 避免两次打开之间的竞态。
///
/// 重要：此函数在 WH_KEYBOARD_LL 钩子回调内被调用，必须在超时（LowLevelHooksTimeout）
/// 内返回，否则 Windows 会静默卸载整个键盘钩子（导致 Ctrl+C 选区检测、截图/录屏 Esc
/// 退出、快速输入触发键等全部失效）。因此这里**不做重试、不 sleep**：
/// - OpenClipboard 被其他进程暂占用时立即失败并返回保守空快照（后续检测会因
///   old=None/new=Some 而显示工具栏），绝不 sleep 等待；
/// - 读取本身（read_clipboard_text_inner / clipboard_has_image_inner）是纯内存操作，
///   即便剪贴板里有近 1MB 文本也只需毫秒级，不会接近钩子超时阈值。
///
/// 若确有剪贴板被长期独占的极端情况，宁愿这次选区检测失败回退，也不冒钩子被卸载的风险。
unsafe fn read_clipboard_snapshot() -> ClipSnapshot {
    if OpenClipboard(None).is_ok() {
        let text = read_clipboard_text_inner();
        let has_image = clipboard_has_image_inner();
        let _ = CloseClipboard();
        return ClipSnapshot { text, has_image };
    }
    // 单次失败即返回空快照，不重试不 sleep（保守弹工具栏）
    ClipSnapshot {
        text: None,
        has_image: false,
    }
}

/// Ctrl+C 检测到剪贴板变化后，是否应该把工具栏显示到光标处。
///
/// 只在「按下 Ctrl+C 时工具栏不可见」时才弹：工具栏已经开着说明用户正在看某个选区的
/// 这套工具，这一按是用户自己在复制，不该把窗口搬走、更不该把它的状态重置掉
/// （旧行为会 emit selection-found，正在看的二维码预览会被顶掉）。
/// 反过来，工具栏本来就没开时 Ctrl+C 仍要弹（键盘选词、右键复制等场景仍靠它唤出工具栏）。
///
/// 抽成纯函数是为了把方向钉住：写成 `toolbar_visible_at_ctrl_c`（即「开着才弹」）就会让
/// 工具栏在用户复制时被搬到光标处并重置（二维码预览被顶掉且之后点外部关不掉），
/// 而本来该弹出的场景反而没反应。
fn should_present_toolbar_at_cursor(toolbar_visible_at_ctrl_c: bool) -> bool {
    !toolbar_visible_at_ctrl_c
}

/// 处理 Ctrl+C：等待剪贴板更新，读取内容，触发选区事件
fn handle_ctrl_c(
    app: tauri::AppHandle,
    foreground_hwnd: isize,
    old_clipboard: ClipSnapshot,
    toolbar_visible_at_ctrl_c: bool,
) {
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

    let clipboard_text = new_text.unwrap_or_default();
    // 剪贴板历史由独立的剪贴板监听器（WM_CLIPBOARDUPDATE）统一记录，
    // 覆盖 Ctrl+C、右键复制、应用内复制等所有来源，此处不再重复写入。
    crate::utils::logger::log(
        "keyboard",
        &format!(
            "Ctrl+C detected, clipboard: {} chars, has_image: {}",
            clipboard_text.len(),
            new_has_image
        ),
    );

    // 文字工具栏已禁用：与鼠标抬起选区路径保持一致，Ctrl+C 也不弹出工具栏。
    // 剪贴板历史已由剪贴板监听器统一记录，此处仅跳过工具栏弹出与图片暂存流程。
    if !crate::hooks::mouse::is_text_toolbar_enabled() {
        crate::utils::logger::log(
            "keyboard",
            "Ctrl+C detected but text toolbar disabled, skipping toolbar",
        );
        return;
    }

    // 工具栏在按下 Ctrl+C 时就已可见 → 保持原状直接返回：不重新显示、不搬到光标处、
    // 也不重发 selection-found。
    //
    // 为什么：工具栏开着说明用户正看着某个选区的这套工具，此时按 Ctrl+C 是他自己
    // 在复制，而不是要换一套工具。旧实现在这种情况下仍然 emit selection-found +
    // 在光标处 show 窗口，后果是：
    //   ① 窗口从选区下方跳到鼠标位置（用户没要求移动）；
    //   ② 前端监听到 selection-found 会重置到默认态并清空二维码预览，但 **不会**
    //      调 set_qrcode_preview(false) —— 后端 qrcode_preview 标志仍为 true，之后
    //      「点击外部即关闭」这条路径全部被忽略，工具栏只能靠 Esc 关掉
    //      （日志里成片的 "QR code preview active, ignoring outside click" 就是这个）；
    //   ③ 后端暂存的选区上下文会被这条 Ctrl+C 路径覆盖成**粗粒度**版本
    //      （method=Clipboard、focus_hwnd=0、sel_start/sel_end=0），鼠标拖选拿到的那份
    //      （UIA/Win32 的精确上下文，或带焦点控件与选区范围的剪贴板上下文）就丢了 ——
    //      之后用替换类工具（转大写/去重/编号…）会退回剪贴板模拟、依赖键盘选区还在，更脆。
    // 覆盖两种子情况，日志分别可辨：
    //   - 等待剪贴板更新的这 ~500ms 内用户已经点外部/Esc 把它关掉（用户此刻并不想
    //     看到工具栏，检测结果不该再把它弹回来）；
    //   - 工具栏仍在（用户的复制操作不该打扰它、也不该让它退化成粗粒度上下文）。
    if !should_present_toolbar_at_cursor(toolbar_visible_at_ctrl_c) {
        crate::utils::logger::log(
            "keyboard",
            if crate::hooks::is_toolbar_visible() {
                "Toolbar already visible at Ctrl+C, keeping it where it is"
            } else {
                "Toolbar dismissed while waiting for clipboard, skipping re-show"
            },
        );
        return;
    }

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
        // 窗口四周有投影留白（见 hooks::TOOLBAR_SHADOW_MARGIN）：容器在窗口内左上角
        // 内缩一个留白，窗口位置要相应左移，工具栏才落在光标原位（y 不补偿，留白
        // 只在左右与底部）。
        let toolbar_margin =
            (crate::hooks::TOOLBAR_SHADOW_MARGIN * win.scale_factor().unwrap_or(1.0)).round()
                as i32;
        let x = cursor_pos.x - toolbar_margin;
        let y = cursor_pos.y + 20;
        let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            x, y,
        )));
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
                    if size > 0 && size <= MAX_CLIPBOARD_DIB_BYTES {
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
    // GlobalSize == 0 说明句柄不可信（拿不到边界）。**不能**回退成「按 MAX_CLIPBOARD_U16
    // 一路扫到 NUL」—— 那是拿一个未知边界去读内存，越界即访问违例。合法的剪贴板文本句柄
    // 必然取得到大小，取不到就按「剪贴板里没有文本」处理（与 clipboard 模块两处、以及
    // quick_input.rs 的同一读法保持一致）。
    if mem_size == 0 {
        let _ = GlobalUnlock(hmem);
        return None;
    }
    let max_u16 = (mem_size / 2).min(MAX_CLIPBOARD_U16);
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
