use std::sync::atomic::{AtomicBool, AtomicI32, AtomicPtr, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::OnceLock;
use tauri::{Emitter, Manager};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, GetWindowRect, PostThreadMessageW, SetWindowsHookExW,
    UnhookWindowsHookEx, HHOOK, MSG, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_QUIT,
};

// ─── 钩子全局状态 ──────────────────────────────────────────────

/// 集中管理的钩子全局状态（所有字段均为原子类型，无锁访问）
struct HookState {
    sender: OnceLock<mpsc::Sender<HookEvent>>,
    hook_ptr: AtomicPtr<std::ffi::c_void>,
    toolbar_hwnd: AtomicPtr<std::ffi::c_void>,
    orb_hwnd: AtomicPtr<std::ffi::c_void>,
    toolbar_visible: AtomicBool,
    /// 二维码预览模式：为 true 时点击工具栏外部不隐藏窗口
    qrcode_preview: AtomicBool,
    /// 截图模式：为 true 时跳过选区检测，避免截图遮罩上的拖拽误触发文字工具栏
    screenshot_mode: AtomicBool,
    /// 录制模式：为 true 时跳过选区检测，避免录制遮罩上的拖拽误触发文字工具栏
    recording_mode: AtomicBool,
    /// 文字工具栏是否启用（开关关闭后，拖拽选中文本不再弹出工具栏）
    text_toolbar_enabled: AtomicBool,
    // 鼠标按下位置（用于拖拽检测）
    mouse_down_x: AtomicI32,
    mouse_down_y: AtomicI32,
    mouse_down_valid: AtomicBool,
    // 鼠标按下时是否在悬浮球内
    mouse_down_on_orb: AtomicBool,
    // 鼠标按下时是否在工具栏内
    mouse_down_on_toolbar: AtomicBool,
    // 上次检测选区的时间戳（毫秒），冷却机制
    last_check_ms: AtomicU64,
    // 钩子线程 ID（用于发送 WM_QUIT 退出消息循环）
    hook_thread_id: AtomicU64,
}

const COOLDOWN_MS: u64 = 300;

static STATE: HookState = HookState {
    sender: OnceLock::new(),
    hook_ptr: AtomicPtr::new(std::ptr::null_mut()),
    toolbar_hwnd: AtomicPtr::new(std::ptr::null_mut()),
    orb_hwnd: AtomicPtr::new(std::ptr::null_mut()),
    toolbar_visible: AtomicBool::new(false),
    qrcode_preview: AtomicBool::new(false),
    screenshot_mode: AtomicBool::new(false),
    recording_mode: AtomicBool::new(false),
    text_toolbar_enabled: AtomicBool::new(true),
    mouse_down_x: AtomicI32::new(0),
    mouse_down_y: AtomicI32::new(0),
    mouse_down_valid: AtomicBool::new(false),
    mouse_down_on_orb: AtomicBool::new(false),
    mouse_down_on_toolbar: AtomicBool::new(false),
    last_check_ms: AtomicU64::new(0),
    hook_thread_id: AtomicU64::new(0),
};

enum HookEvent {
    MouseUp,
    MouseDown { x: i32, y: i32 },
}

// ─── 工具函数 ──────────────────────────────────────────────────

/// 检查屏幕坐标 (x, y) 是否在指定窗口的矩形内
fn is_point_in_window_rect(hwnd_ptr: *mut std::ffi::c_void, x: i32, y: i32) -> bool {
    if hwnd_ptr.is_null() {
        return false;
    }
    unsafe {
        let hwnd = HWND(hwnd_ptr);
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_ok() {
            return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        }
    }
    false
}

/// 检查屏幕坐标是否在悬浮球窗口内
/// orb 窗口 80×80，圆形可视区仅占中心一小块，但用户点击透明边距区域也应视为点球
/// 因此命中整个窗口矩形（而非仅圆形），避免点在边距时 mouse_down_on_orb 为 false
/// 导致 mouseup 走选区检测分支、误弹文字工具栏
fn is_point_on_orb(hwnd_ptr: *mut std::ffi::c_void, x: i32, y: i32) -> bool {
    is_point_in_window_rect(hwnd_ptr, x, y)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ─── 公共 API ──────────────────────────────────────────────────

pub fn start_hook(app_handle: tauri::AppHandle) {
    let (tx, rx) = mpsc::channel::<HookEvent>();

    STATE.sender.set(tx).expect("SENDER already initialized");
    crate::utils::logger::log("mouse", "SENDER initialized");

    // 保存窗口句柄
    if let Some(win) = app_handle.get_webview_window("toolbar") {
        if let Ok(hwnd) = win.hwnd() {
            STATE.toolbar_hwnd.store(hwnd.0, Ordering::SeqCst);
            crate::utils::logger::log("mouse", &format!("Toolbar HWND saved: {:?}", hwnd));
        }
    }
    if let Some(win) = app_handle.get_webview_window("orb") {
        if let Ok(hwnd) = win.hwnd() {
            STATE.orb_hwnd.store(hwnd.0, Ordering::SeqCst);
            crate::utils::logger::log("mouse", &format!("Orb HWND saved: {:?}", hwnd));
        }
    }

    // 后台线程处理鼠标事件
    let app = app_handle.clone();
    std::thread::spawn(move || {
        while let Ok(event) = rx.recv() {
            match event {
                HookEvent::MouseUp => {
                    // 截图/录制模式：跳过所有选区检测与工具栏交互，选区由遮罩前端处理
                    if STATE.screenshot_mode.load(Ordering::SeqCst)
                        || STATE.recording_mode.load(Ordering::SeqCst)
                    {
                        continue;
                    }
                    let down_x = STATE.mouse_down_x.load(Ordering::SeqCst);
                    let down_y = STATE.mouse_down_y.load(Ordering::SeqCst);
                    let down_valid = STATE.mouse_down_valid.load(Ordering::SeqCst);

                    let mut cur = POINT::default();
                    unsafe {
                        let _ = GetCursorPos(&mut cur);
                    }

                    let has_drag = if down_valid {
                        let dist = ((cur.x - down_x).abs() + (cur.y - down_y).abs()) as u64;
                        dist > 2
                    } else {
                        false
                    };
                    STATE.mouse_down_valid.store(false, Ordering::SeqCst);

                    // 悬浮球交互 → 通知 orb 窗口，跳过选区检测
                    // 注意：此分支不受 text_toolbar_enabled 开关影响，否则关掉文字工具栏后点击悬浮球也无法弹出工具选择面板
                    // payload.clicked 由鼠标位移判定（!has_drag），前端据此区分点击/拖拽，比窗口位移判定更可靠
                    if down_valid && STATE.mouse_down_on_orb.load(Ordering::SeqCst) {
                        crate::utils::logger::log(
                            "mouse",
                            "MouseUp after mousedown on orb, notifying orb window",
                        );
                        let _ = app.emit_to("orb", "orb-mouseup", !has_drag);
                        continue;
                    }

                    // 工具栏内点击 → 跳过选区检测（避免点击工具栏时重新触发选中）
                    if down_valid && STATE.mouse_down_on_toolbar.load(Ordering::SeqCst) {
                        crate::utils::logger::log(
                            "mouse",
                            "Click on toolbar, skipping selection check",
                        );
                        continue;
                    }

                    // 文字工具栏已禁用：以下均为选区检测路径，开关关闭后不再弹出文字工具栏
                    if !STATE.text_toolbar_enabled.load(Ordering::SeqCst) {
                        continue;
                    }

                    if !has_drag {
                        if down_valid {
                            let dist = ((cur.x - down_x).abs() + (cur.y - down_y).abs()) as u64;
                            if dist > 0 {
                                crate::utils::logger::log(
                                    "mouse",
                                    &format!("Drag too short ({}px), skipping", dist),
                                );
                            }
                        }
                        continue;
                    }

                    // 冷却检查
                    let last = STATE.last_check_ms.load(Ordering::SeqCst);
                    let now = now_ms();
                    if now.saturating_sub(last) < COOLDOWN_MS {
                        crate::utils::logger::log(
                            "mouse",
                            "Cooldown active, skipping selection check",
                        );
                        continue;
                    }
                    STATE.last_check_ms.store(now, Ordering::SeqCst);

                    crate::utils::logger::log("mouse", "Drag detected, checking selection");

                    // 记录拖选坐标供 OCR 使用
                    crate::automation::ocr_selection::set_last_drag_rect(
                        down_x, down_y, cur.x, cur.y,
                    );

                    match crate::automation::get_current_selection() {
                        Ok(Some(info)) if !info.text.is_empty() || info.has_image => {
                            crate::utils::logger::log(
                                "mouse",
                                &format!("Selection found: {} chars", info.text.len()),
                            );
                            let _ = app.emit("selection-found", &info);
                            if let Some(win) = app.get_webview_window("toolbar") {
                                let x = info.rect.x;
                                let y = if info.rect.height > 0 {
                                    info.rect.y + info.rect.height + 5
                                } else {
                                    info.rect.y + 20
                                };
                                let _ = win.set_position(tauri::Position::Physical(
                                    tauri::PhysicalPosition::new(x, y),
                                ));
                                let _ = win.show();
                                STATE.toolbar_visible.store(true, Ordering::SeqCst);
                                if let Ok(hwnd) = win.hwnd() {
                                    STATE.toolbar_hwnd.store(hwnd.0, Ordering::SeqCst);
                                }
                                crate::utils::logger::log("mouse", "Toolbar window shown");
                            }
                        }
                        Ok(Some(_)) => crate::utils::logger::log("mouse", "Selection empty"),
                        Ok(None) => crate::utils::logger::log("mouse", "No selection"),
                        Err(e) => {
                            crate::utils::logger::log("mouse", &format!("Selection error: {}", e))
                        }
                    }
                }
                HookEvent::MouseDown { x, y } => {
                    // 截图/录制模式：跳过所有状态写入与选区检测，避免退出后残留状态误触发
                    if STATE.screenshot_mode.load(Ordering::SeqCst)
                        || STATE.recording_mode.load(Ordering::SeqCst)
                    {
                        continue;
                    }
                    STATE.mouse_down_x.store(x, Ordering::SeqCst);
                    STATE.mouse_down_y.store(y, Ordering::SeqCst);
                    STATE.mouse_down_valid.store(true, Ordering::SeqCst);

                    let on_orb = is_point_on_orb(STATE.orb_hwnd.load(Ordering::SeqCst), x, y);
                    STATE.mouse_down_on_orb.store(on_orb, Ordering::SeqCst);

                    let on_toolbar =
                        is_point_in_window_rect(STATE.toolbar_hwnd.load(Ordering::SeqCst), x, y);
                    STATE
                        .mouse_down_on_toolbar
                        .store(on_toolbar, Ordering::SeqCst);

                    if !STATE.toolbar_visible.load(Ordering::SeqCst) {
                        continue;
                    }
                    if on_orb {
                        crate::utils::logger::log("mouse", "Click on orb, not hiding toolbar");
                        continue;
                    }

                    let toolbar_ptr = STATE.toolbar_hwnd.load(Ordering::SeqCst);
                    if !is_point_in_window_rect(toolbar_ptr, x, y) {
                        // 二维码预览模式下点击外部不隐藏
                        if STATE.qrcode_preview.load(Ordering::SeqCst) {
                            crate::utils::logger::log(
                                "mouse",
                                "QR code preview active, ignoring outside click",
                            );
                            continue;
                        }
                        crate::utils::logger::log(
                            "mouse",
                            &format!("Click outside toolbar ({}, {}), hiding", x, y),
                        );
                        if let Some(win) = app.get_webview_window("toolbar") {
                            let _ = win.hide();
                            let _ = app.emit("toolbar-hidden", ());
                            STATE.toolbar_visible.store(false, Ordering::SeqCst);
                        }
                    }
                }
            }
        }
        crate::utils::logger::log("mouse", "Event processing thread exited");
    });

    unsafe {
        let hook = SetWindowsHookExW(
            WH_MOUSE_LL,
            Some(mouse_hook_proc),
            GetModuleHandleW(None).ok().map(|h| h.into()),
            0,
        );

        match hook {
            Ok(h) => {
                STATE.hook_ptr.store(h.0, Ordering::SeqCst);
                // 记录钩子线程 ID，用于 stop_hook 发送 WM_QUIT
                STATE.hook_thread_id.store(
                    windows::Win32::System::Threading::GetCurrentThreadId() as u64,
                    Ordering::SeqCst,
                );
                crate::utils::logger::log("mouse", &format!("Mouse hook installed: {:?}", h));
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).into() {}
                crate::utils::logger::log("mouse", "GetMessageW loop exited, cleaning up hook");
                // 循环退出后清理钩子
                stop_hook();
            }
            Err(e) => {
                crate::utils::logger::log("mouse", &format!("Failed to set mouse hook: {:?}", e));
                eprintln!("Failed to set mouse hook: {:?}", e);
            }
        }
    }
}

/// 停止鼠标钩子并发送 WM_QUIT 退出消息循环
pub fn stop_hook() {
    let ptr = STATE.hook_ptr.swap(std::ptr::null_mut(), Ordering::SeqCst);
    if !ptr.is_null() {
        unsafe {
            let _ = UnhookWindowsHookEx(HHOOK(ptr));
            crate::utils::logger::log("mouse", "Mouse hook uninstalled");
        }
    }
    // 发送 WM_QUIT 让 GetMessageW 退出
    let thread_id = STATE.hook_thread_id.swap(0, Ordering::SeqCst);
    if thread_id != 0 {
        unsafe {
            let _ = PostThreadMessageW(thread_id as u32, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}

/// 供外部模块调用，同步工具栏可见状态
pub fn set_toolbar_visible(visible: bool) {
    STATE.toolbar_visible.store(visible, Ordering::SeqCst);
}

/// 供外部模块调用，更新工具栏窗口句柄缓存
pub fn update_toolbar_hwnd(hwnd: *mut std::ffi::c_void) {
    STATE.toolbar_hwnd.store(hwnd, Ordering::SeqCst);
}

/// 供前端调用，设置二维码预览模式
/// 为 true 时点击工具栏外部不会隐藏窗口
pub fn set_qrcode_preview(active: bool) {
    STATE.qrcode_preview.store(active, Ordering::SeqCst);
}

/// 截图模式开关：开启后鼠标钩子跳过选区检测，避免截图遮罩拖拽误触发文字工具栏
pub fn set_screenshot_mode(active: bool) {
    STATE.screenshot_mode.store(active, Ordering::SeqCst);
    // 退出截图模式时重置鼠标按下残留状态，避免下次 MouseUp 误判
    if !active {
        STATE.mouse_down_valid.store(false, Ordering::SeqCst);
        STATE.mouse_down_on_orb.store(false, Ordering::SeqCst);
        STATE.mouse_down_on_toolbar.store(false, Ordering::SeqCst);
    }
}

/// 查询当前是否处于截图模式（供键盘钩子监听 Esc 时判断）
pub fn is_screenshot_mode() -> bool {
    STATE.screenshot_mode.load(Ordering::SeqCst)
}

/// 文字工具栏启用开关：关闭后拖拽选中文本不再触发 selection-found / 弹出工具栏
pub fn set_text_toolbar_enabled(enabled: bool) {
    STATE.text_toolbar_enabled.store(enabled, Ordering::SeqCst);
    crate::utils::logger::log("mouse", &format!("text_toolbar_enabled = {}", enabled));
}

/// 查询文字工具栏是否启用（供键盘钩子的 Ctrl+C 路径判断，与鼠标抬起路径保持一致）
pub fn is_text_toolbar_enabled() -> bool {
    STATE.text_toolbar_enabled.load(Ordering::SeqCst)
}

/// 录制模式开关：开启后鼠标钩子跳过选区检测，避免录制遮罩拖拽误触发文字工具栏
pub fn set_recording_mode(active: bool) {
    STATE.recording_mode.store(active, Ordering::SeqCst);
    // 退出录制模式时重置鼠标按下残留状态，避免下次 MouseUp 误判
    if !active {
        STATE.mouse_down_valid.store(false, Ordering::SeqCst);
        STATE.mouse_down_on_orb.store(false, Ordering::SeqCst);
        STATE.mouse_down_on_toolbar.store(false, Ordering::SeqCst);
    }
}

/// 查询当前是否处于录制模式（供键盘钩子监听 Esc 时判断）
pub fn is_recording_mode() -> bool {
    STATE.recording_mode.load(Ordering::SeqCst)
}

// ─── 钩子回调 ──────────────────────────────────────────────────

unsafe extern "system" fn mouse_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let msg = wparam.0 as u32;
        if let Some(sender) = STATE.sender.get() {
            match msg {
                _ if msg == WM_LBUTTONUP => {
                    let _ = sender.send(HookEvent::MouseUp);
                }
                _ if msg == WM_LBUTTONDOWN => {
                    // WH_MOUSE_LL 的 lparam 是指向 MSLLHOOKSTRUCT 的指针，
                    // 其首字段 pt: POINT 即真实屏幕坐标
                    let pt = lparam.0 as *const POINT;
                    let x = (*pt).x;
                    let y = (*pt).y;
                    let _ = sender.send(HookEvent::MouseDown { x, y });
                }
                _ => {}
            }
        }
    }
    let hook = HHOOK(STATE.hook_ptr.load(Ordering::SeqCst));
    CallNextHookEx(Some(hook), code, wparam, lparam)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cooldown_constant() {
        assert_eq!(COOLDOWN_MS, 300);
    }

    #[test]
    fn test_is_point_in_window_rect_null_hwnd() {
        // null HWND 应返回 false
        assert!(!is_point_in_window_rect(std::ptr::null_mut(), 100, 100));
    }

    #[test]
    fn test_is_point_on_orb_null_hwnd() {
        // null HWND 应返回 false
        assert!(!is_point_on_orb(std::ptr::null_mut(), 100, 100));
    }

    #[test]
    fn test_now_ms_returns_nonzero() {
        let ms = now_ms();
        // 系统时间应返回非零值（1970 年后的毫秒数）
        assert!(ms > 0, "now_ms() 应返回正数，实际: {}", ms);
    }

    #[test]
    fn test_orb_circle_geometry() {
        // 验证 orb 圆形检测的几何逻辑（无需实际窗口）
        // orb 窗口 80×80，圆心在 (40, 40)，半径 28px
        let r: f64 = 28.0;

        // 圆心点应包含
        let dx = 0.0_f64;
        let dy = 0.0_f64;
        assert!((dx * dx + dy * dy) <= r * r);

        // 边界点（半径内）
        let dx = 27.0_f64;
        let dy = 0.0_f64;
        assert!((dx * dx + dy * dy) <= r * r);

        // 边界外点
        let dx = 29.0_f64;
        let dy = 0.0_f64;
        assert!((dx * dx + dy * dy) > r * r);
    }

    #[test]
    fn test_drag_distance_manhattan() {
        // 验证拖拽检测的曼哈顿距离逻辑
        // 距离 > 2 视为拖拽
        let has_drag = |dx: i32, dy: i32| -> bool { (dx.abs() + dy.abs()) as u64 > 2 };
        assert!(!has_drag(0, 0)); // 无移动
        assert!(!has_drag(1, 0)); // 距离 = 1，不算拖拽
        assert!(!has_drag(1, 1)); // 距离 = 2，刚好不算拖拽
        assert!(has_drag(1, 2)); // 距离 = 3，算拖拽
        assert!(has_drag(6, 0)); // 距离 = 6，算拖拽
        assert!(has_drag(-2, -2)); // 负方向也算
    }
}
