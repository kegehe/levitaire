use std::sync::atomic::{AtomicBool, AtomicI32, AtomicIsize, AtomicPtr, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetForegroundWindow};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, GetWindowRect, LoadCursorW,
    CopyIcon, PostThreadMessageW, SetCursor, SetSystemCursor, SetWindowsHookExW,
    UnhookWindowsHookEx, HCURSOR, HHOOK, ICONINFO, IDC_ARROW, MSG, OCR_NORMAL, WH_MOUSE_LL,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_QUIT,
};

// ─── 钩子全局状态 ──────────────────────────────────────────────

/// 集中管理的钩子全局状态（所有字段均为原子类型，无锁访问）
struct HookState {
    sender: OnceLock<mpsc::Sender<HookEvent>>,
    /// app_handle（供 hook_proc 在转盘模式下直接 emit 鼠标移动）
    app_handle: OnceLock<tauri::AppHandle>,
    hook_ptr: AtomicPtr<std::ffi::c_void>,
    toolbar_hwnd: AtomicPtr<std::ffi::c_void>,
    orb_hwnd: AtomicPtr<std::ffi::c_void>,
    utility_hub_hwnd: AtomicPtr<std::ffi::c_void>,
    toolbar_visible: AtomicBool,
    /// 悬浮球窗口是否可见。隐藏后即使 orb_hwnd 仍存在
    /// （GetWindowRect 对隐藏窗口也返回其矩形），也不再把该区域点击
    /// 当作悬浮球交互，避免隐藏状态下点击原位置仍弹出工具面板。
    orb_visible: AtomicBool,
    /// 二维码预览模式：为 true 时点击工具栏外部不隐藏窗口
    qrcode_preview: AtomicBool,
    /// 截图模式：为 true 时跳过选区检测，避免截图遮罩上的拖拽误触发文字工具栏
    screenshot_mode: AtomicBool,
    smart_screenshot_mode: AtomicBool,
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
    // 鼠标按下时是否在悬浮球圆形热区内（精确几何判定，决定是否触发 orb 交互）
    mouse_down_on_orb_circle: AtomicBool,
    // 鼠标按下时是否在工具栏内
    mouse_down_on_toolbar: AtomicBool,
    // 上次检测选区的时间戳（毫秒），冷却机制
    last_check_ms: AtomicU64,
    // 钩子线程 ID（用于发送 WM_QUIT 退出消息循环）
    hook_thread_id: AtomicU64,
    // 转盘模式：emit 鼠标移动时的上次时间戳（毫秒），用于节流
    quick_input_last_emit_ms: AtomicU64,
    smart_screenshot_last_emit_ms: AtomicU64,
    smart_controls_left: AtomicI32,
    smart_controls_top: AtomicI32,
    smart_controls_right: AtomicI32,
    smart_controls_bottom: AtomicI32,
    smart_controls_valid: AtomicBool,
    smart_mouse_down: AtomicBool,
    color_picker_active: AtomicBool,
    color_picker_restore_cursor: AtomicIsize,
}

/// Serialize system-cursor replacement/restoration. Starting and stopping the
/// picker from frontend commands and native window cleanup can otherwise
/// interleave and leave a custom cursor installed after the picker is gone.
static COLOR_PICK_LOCK: Mutex<()> = Mutex::new(());

const COOLDOWN_MS: u64 = 300;

static STATE: HookState = HookState {
    sender: OnceLock::new(),
    app_handle: OnceLock::new(),
    hook_ptr: AtomicPtr::new(std::ptr::null_mut()),
    toolbar_hwnd: AtomicPtr::new(std::ptr::null_mut()),
    orb_hwnd: AtomicPtr::new(std::ptr::null_mut()),
    utility_hub_hwnd: AtomicPtr::new(std::ptr::null_mut()),
    toolbar_visible: AtomicBool::new(false),
    orb_visible: AtomicBool::new(true),
    qrcode_preview: AtomicBool::new(false),
    screenshot_mode: AtomicBool::new(false),
    smart_screenshot_mode: AtomicBool::new(false),
    recording_mode: AtomicBool::new(false),
    text_toolbar_enabled: AtomicBool::new(true),
    mouse_down_x: AtomicI32::new(0),
    mouse_down_y: AtomicI32::new(0),
    mouse_down_valid: AtomicBool::new(false),
    mouse_down_on_orb: AtomicBool::new(false),
    mouse_down_on_orb_circle: AtomicBool::new(false),
    mouse_down_on_toolbar: AtomicBool::new(false),
    last_check_ms: AtomicU64::new(0),
    hook_thread_id: AtomicU64::new(0),
    quick_input_last_emit_ms: AtomicU64::new(0),
    smart_screenshot_last_emit_ms: AtomicU64::new(0),
    smart_controls_left: AtomicI32::new(0),
    smart_controls_top: AtomicI32::new(0),
    smart_controls_right: AtomicI32::new(0),
    smart_controls_bottom: AtomicI32::new(0),
    smart_controls_valid: AtomicBool::new(false),
    smart_mouse_down: AtomicBool::new(false),
    color_picker_active: AtomicBool::new(false),
    color_picker_restore_cursor: AtomicIsize::new(0),
};

enum HookEvent {
    MouseUp,
    LongCapturePointerUp {
        x: i32,
        y: i32,
    },
    MouseDown {
        x: i32,
        y: i32,
        foreground: isize,
    },
    /// 转盘模式下鼠标坐标：由钩子线程转发到后台线程再 emit，
    /// 避免 WH_MOUSE_LL 回调内执行 emit_to 阻塞导致钩子被系统静默卸载。
    QuickInputMove {
        x: i32,
        y: i32,
    },
    LongCaptureWheel {
        x: i32,
        y: i32,
        delta: i16,
    },
    SmartScreenshotMove { x: i32, y: i32 },
    SmartScreenshotClick { x: i32, y: i32 },
    ColorPicked { x: i32, y: i32 },
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

/// 检查屏幕坐标是否在悬浮球窗口矩形内（选区检测守卫）
/// orb 原生窗口 96×96 且透明，视觉球 56×56 居中，四周留白用于承载阴影。
/// 只要按下落在该矩形内，mouseup 就不应落入拖选/文字工具栏逻辑，因此命中
/// 整个窗口矩形作为第一层守卫；是否触发 orb 自身的点击/拖拽，由
/// is_point_in_orb_circle 做精确圆形判定。
fn is_point_on_orb(hwnd_ptr: *mut std::ffi::c_void, x: i32, y: i32) -> bool {
    is_point_in_window_rect(hwnd_ptr, x, y)
}

/// 悬浮球交互热区半径（逻辑像素）：视觉球半径 28（--orb-size 56 / 2）+ 2px 容差，
/// 覆盖 hover 放大（scale 1.05 → 半径约 29.4px）后的球边缘。
const ORB_HIT_RADIUS_LOGICAL: f64 = 30.0;
/// orb 窗口逻辑边长（tauri.conf.json），用于将逻辑半径等比换算为物理像素。
const ORB_WINDOW_LOGICAL: f64 = 96.0;

/// 点到圆心的圆形判定（不含窗口句柄，便于单测）
fn point_in_circle(cx: f64, cy: f64, radius: f64, x: i32, y: i32) -> bool {
    let dx = x as f64 - cx;
    let dy = y as f64 - cy;
    dx * dx + dy * dy <= radius * radius
}

/// 精确圆形热区判定：屏幕坐标是否落在视觉球圆形内（而非整个窗口矩形）。
/// 点击球外透明留白/角落不再被视为点击悬浮球，避免误触弹面板或拖动。
fn is_point_in_orb_circle(hwnd_ptr: *mut std::ffi::c_void, x: i32, y: i32) -> bool {
    if hwnd_ptr.is_null() {
        return false;
    }
    unsafe {
        let hwnd = HWND(hwnd_ptr);
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        // orb 窗口为方形，球心即窗口中心；半径按窗口实际物理宽度等比换算，
        // 使物理像素判定与 CSS（--orb-size 56 / 窗口 96）布局保持一致。
        let cx = (rect.left as f64 + rect.right as f64) / 2.0;
        let cy = (rect.top as f64 + rect.bottom as f64) / 2.0;
        let width = (rect.right - rect.left) as f64;
        let radius = width * (ORB_HIT_RADIUS_LOGICAL / ORB_WINDOW_LOGICAL);
        point_in_circle(cx, cy, radius, x, y)
    }
}

fn is_point_in_utility_hub(x: i32, y: i32) -> bool {
    is_point_in_window_rect(
        STATE.utility_hub_hwnd.load(Ordering::SeqCst),
        x,
        y,
    )
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn eyedropper_cursor() -> Option<windows::Win32::UI::WindowsAndMessaging::HCURSOR> {
    static CURSOR: OnceLock<Option<isize>> = OnceLock::new();
    CURSOR.get_or_init(|| unsafe {
        // Render at 4x and reduce to 32x32. This keeps the cursor crisp without
        // relying on an external .cur asset, while the mask preserves transparency.
        const SIZE: usize = 32;
        const SCALE: usize = 4;
        const HI: usize = SIZE * SCALE;
        let mut high = vec![0u32; HI * HI];
        let fill_circle = |canvas: &mut Vec<u32>, cx: f32, cy: f32, radius: f32, color: u32| {
            let r2 = radius * radius;
            for y in 0..HI {
                for x in 0..HI {
                    let px = (x as f32 + 0.5) / SCALE as f32;
                    let py = (y as f32 + 0.5) / SCALE as f32;
                    if (px - cx) * (px - cx) + (py - cy) * (py - cy) <= r2 {
                        canvas[y * HI + x] = color;
                    }
                }
            }
        };
        let stroke = |canvas: &mut Vec<u32>, x0: f32, y0: f32, x1: f32, y1: f32, width: f32, color: u32| {
            let vx = x1 - x0;
            let vy = y1 - y0;
            let len2 = vx * vx + vy * vy;
            let radius = width / 2.0;
            for y in 0..HI {
                for x in 0..HI {
                    let px = (x as f32 + 0.5) / SCALE as f32;
                    let py = (y as f32 + 0.5) / SCALE as f32;
                    let t = if len2 > 0.0 {
                        (((px - x0) * vx + (py - y0) * vy) / len2).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    let dx = px - (x0 + t * vx);
                    let dy = py - (y0 + t * vy);
                    if dx * dx + dy * dy <= radius * radius {
                        canvas[y * HI + x] = color;
                    }
                }
            }
        };

        // A compact, high-contrast pipette is readable at cursor size.
        stroke(&mut high, 6.9, 24.1, 21.0, 10.0, 6.4, 0xFF0F172A);
        stroke(&mut high, 6.9, 24.1, 21.0, 10.0, 4.1, 0xFFF8FAFC);

        // The narrow nozzle establishes an unambiguous sampling point.
        stroke(&mut high, 3.1, 27.9, 8.4, 22.6, 4.4, 0xFF0F172A);
        stroke(&mut high, 3.1, 27.9, 8.4, 22.6, 2.3, 0xFFE2E8F0);

        // A saturated collar separates the tube and bulb without obscuring the silhouette.
        stroke(&mut high, 12.0, 19.0, 15.9, 15.1, 7.5, 0xFF0F172A);
        stroke(&mut high, 12.0, 19.0, 15.9, 15.1, 4.7, 0xFF14B8A6);
        stroke(&mut high, 12.0, 19.0, 15.9, 15.1, 1.35, 0xFFCCFBF1);

        // The oversized bulb keeps the diagonal silhouette unmistakable.
        stroke(&mut high, 21.2, 9.8, 25.5, 5.5, 9.6, 0xFF0F172A);
        stroke(&mut high, 21.2, 9.8, 25.5, 5.5, 6.8, 0xFFF8FAFC);
        fill_circle(&mut high, 24.4, 6.6, 1.15, 0xFFFFFFFF);

        // Keep the hot spot visible even over detailed imagery.
        fill_circle(&mut high, 3.1, 27.9, 2.25, 0xFF0F172A);
        fill_circle(&mut high, 3.1, 27.9, 1.05, 0xFF14B8A6);

        let mut pixels = [0u32; SIZE * SIZE];
        for y in 0..SIZE {
            for x in 0..SIZE {
                let mut count = 0u32;
                let mut rb = 0u32;
                let mut g = 0u32;
                let mut b = 0u32;
                for sy in 0..SCALE {
                    for sx in 0..SCALE {
                        let value = high[(y * SCALE + sy) * HI + x * SCALE + sx];
                        if value != 0 {
                            count += 1;
                            rb += value & 0x000000FF;
                            g += (value >> 8) & 0x000000FF;
                            b += (value >> 16) & 0x000000FF;
                        }
                    }
                }
                // Require meaningful coverage so one high-resolution sample does not
                // create a stray opaque fringe around the silhouette.
                if count >= (SCALE * SCALE) as u32 / 2 {
                    pixels[y * SIZE + x] = 0xFF000000
                        | ((b / count) << 16)
                        | ((g / count) << 8)
                        | (rb / count);
                }
            }
        }
        let color = windows::Win32::Graphics::Gdi::CreateBitmap(
            SIZE as i32,
            SIZE as i32,
            1,
            32,
            Some(pixels.as_ptr() as *const std::ffi::c_void),
        );
        if color.is_invalid() {
            return None;
        }
        let mut mask_bits = [0xFFu8; SIZE * 4];
        for y in 0..SIZE {
            for x in 0..SIZE {
                if pixels[y * SIZE + x] != 0 {
                    mask_bits[y * 4 + x / 8] &= !(0x80 >> (x % 8));
                }
            }
        }
        let mask = windows::Win32::Graphics::Gdi::CreateBitmap(
            SIZE as i32,
            SIZE as i32,
            1,
            1,
            Some(mask_bits.as_ptr() as *const std::ffi::c_void),
        );
        if mask.is_invalid() {
            let _ = windows::Win32::Graphics::Gdi::DeleteObject(color.into());
            return None;
        }
        let info = ICONINFO {
            fIcon: false.into(),
            xHotspot: 3,
            yHotspot: 28,
            hbmMask: mask,
            hbmColor: color,
        };
        let cursor = windows::Win32::UI::WindowsAndMessaging::CreateIconIndirect(&info).ok();
        let _ = windows::Win32::Graphics::Gdi::DeleteObject(mask.into());
        let _ = windows::Win32::Graphics::Gdi::DeleteObject(color.into());
        cursor.map(|icon| icon.0 as isize)
    }).as_ref().map(|value| windows::Win32::UI::WindowsAndMessaging::HCURSOR(*value as *mut std::ffi::c_void))
}

// ─── 公共 API ──────────────────────────────────────────────────

pub fn start_hook(app_handle: tauri::AppHandle) {
    let (tx, rx) = mpsc::channel::<HookEvent>();

    STATE.sender.set(tx).expect("SENDER already initialized");
    STATE.app_handle.set(app_handle.clone()).ok();
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
                    // 转盘守卫与钩子线程一致：仅当转盘激活且实际可见时才跳过选区检测，
                    // active 卡死而转盘未显示时恢复正常的拖选/工具栏行为。
                    let long_capture_active = app
                        .try_state::<crate::scroll_capture::LongCaptureState>()
                        .map(|state| state.is_active())
                        .unwrap_or(false);
                    if STATE.screenshot_mode.load(Ordering::SeqCst)
                        || STATE.recording_mode.load(Ordering::SeqCst)
                        || long_capture_active
                        || (crate::quick_input::is_active() && crate::quick_input::wheel_visible())
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
                        // 按下点须落在视觉球圆形热区内才通知 orb（点击弹面板 / 拖拽存位置）；
                        // 落在窗口透明留白/角落则保持静默，仅跳过选区检测。
                        if STATE.mouse_down_on_orb_circle.load(Ordering::SeqCst) {
                            crate::utils::logger::log(
                                "mouse",
                                "MouseUp on orb circle, notifying orb window",
                            );
                            let _ = app.emit_to("orb", "orb-mouseup", !has_drag);
                        }
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

                    // 设置窗口内交互 → 跳过选区检测：
                    // settings 是应用自有窗口（含自绘标题栏拖动），其上的按下→抬起
                    // 不应触发文字工具栏，否则拖动标题栏松手时会被误判为拖选，
                    // 进而调用 get_selection()（含模拟 Ctrl+C）干扰设置窗口。
                    // settings 延迟创建且关闭后仅隐藏（窗口对象仍存在），故需 is_visible 守卫：
                    // 否则隐藏窗口仍保留最后的屏幕矩形，会让该区域内的正常拖选被误排除。
                    // 置于 text_toolbar_enabled 检查之后：开关关闭时选区检测本就跳过，无需查询。
                    let down_in_own_window = down_valid
                        && ["settings", "scroll-navigator-overlay", "utility-hub-overlay"].iter().any(|label| {
                            app.get_webview_window(label).is_some_and(|win| {
                                win.is_visible().unwrap_or(false)
                                    && win
                                        .hwnd()
                                        .map(|hwnd| is_point_in_window_rect(hwnd.0, down_x, down_y))
                                        .unwrap_or(false)
                            })
                        });
                    if down_in_own_window {
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
                HookEvent::ColorPicked { x, y } => {
                    // Keep the picker armed after every sample. It is only
                    // disarmed by switching tools or closing the utility hub.
                    if !STATE.color_picker_active.load(Ordering::SeqCst) {
                        continue;
                    }
                    let result = crate::screenshot::capture_screen_region(x, y, 1, 1);
                    // A close or tool switch may happen while screen capture is
                    // in progress. Do not deliver a stale result that could make
                    // the frontend show the hub again after the user closed it.
                    if !STATE.color_picker_active.load(Ordering::SeqCst) {
                        continue;
                    }
                    match result {
                        Ok(pixel) if pixel.len() >= 3 => {
                            // GDI returns pixels in BGRA order.
                            let color = format!("#{:02X}{:02X}{:02X}", pixel[2], pixel[1], pixel[0]);
                            let _ = app.emit_to("utility-hub-overlay", "utility-color-picked", color);
                        }
                        Ok(_) => {
                            let _ = app.emit_to("utility-hub-overlay", "utility-color-pick-error", "无法读取屏幕像素");
                        }
                        Err(error) => {
                            let _ = app.emit_to("utility-hub-overlay", "utility-color-pick-error", error);
                        }
                    }
                }
                HookEvent::MouseDown { x, y, foreground } => {
                    // 截图/录制模式：跳过所有状态写入与选区检测，避免退出后残留状态误触发
                    let long_capture_active = app
                        .try_state::<crate::scroll_capture::LongCaptureState>()
                        .map(|state| state.is_active())
                        .unwrap_or(false);
                    if STATE.screenshot_mode.load(Ordering::SeqCst)
                        || STATE.recording_mode.load(Ordering::SeqCst)
                        || long_capture_active
                    {
                        continue;
                    }
                    STATE.mouse_down_x.store(x, Ordering::SeqCst);
                    STATE.mouse_down_y.store(y, Ordering::SeqCst);
                    STATE.mouse_down_valid.store(true, Ordering::SeqCst);

                    // Use the foreground HWND captured inside the low-level
                    // hook. By the time this receiver thread runs, the orb or
                    // palette may already have taken focus.
                    crate::scroll_navigation::remember_foreground_snapshot(&app, foreground);

                    let orb_hwnd = STATE.orb_hwnd.load(Ordering::SeqCst);
                    // 悬浮球隐藏时（GetWindowRect 仍会返回其矩形），不把该位置点击
                    // 当作悬浮球交互，否则隐藏状态下点击原位置会触发 orb-mouseup 弹面板
                    let on_orb = STATE.orb_visible.load(Ordering::SeqCst)
                        && is_point_on_orb(orb_hwnd, x, y);
                    STATE.mouse_down_on_orb.store(on_orb, Ordering::SeqCst);
                    // 圆形热区精确判定：仅落在视觉球内才在 mouseup 触发 orb 交互，
                    // 避免点击透明留白/角落误弹面板
                    let on_orb_circle = is_point_in_orb_circle(orb_hwnd, x, y);
                    STATE.mouse_down_on_orb_circle.store(on_orb_circle, Ordering::SeqCst);

                    // The orb receives focus immediately after this low-level
                    // callback returns. Capture the real foreground target now,
                    // before the orb/palette can replace it.
                    if on_orb {
                        crate::scroll_navigation::capture_current_target(&app);
                    }

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
                        // 即便工具栏窗口句柄暂不可用，也要复位可见与按下状态，
                        // 避免残留的 toolbar_visible / mouse_down_* 让后续事件误判。
                        if let Some(win) = app.get_webview_window("toolbar") {
                            let _ = win.hide();
                            let _ = app.emit("toolbar-hidden", ());
                        }
                        STATE.toolbar_visible.store(false, Ordering::SeqCst);
                        // 这次按下已经用于「点击外部关闭工具栏」，不能再被随后的
                        // WM_LBUTTONUP 当作一次新的拖选去触发选区检测：清除按下状态，
                        // 否则松开鼠标时（哪怕只有 >2px 的手抖位移）会立即重新弹出工具栏，
                        // 表现为「刚点外面消失，马上又自己冒出来」。
                        STATE.mouse_down_valid.store(false, Ordering::SeqCst);
                        STATE.mouse_down_on_toolbar.store(false, Ordering::SeqCst);
                        STATE.mouse_down_on_orb.store(false, Ordering::SeqCst);
                        STATE.mouse_down_on_orb_circle.store(false, Ordering::SeqCst);
                    }
                }
                HookEvent::QuickInputMove { x, y } => {
                    // 从钩子线程收到转盘鼠标坐标，在后台线程 emit：
                    // 避免 WH_MOUSE_LL 回调内执行 emit_to 在设置窗口创建等场景下阻塞，
                    // 导致整个鼠标钩子被系统静默卸载。
                    if let Some(app) = STATE.app_handle.get() {
                        let _ = app.emit_to(
                            "quick-input-overlay",
                            "quick-input-mouse-move",
                            serde_json::json!({ "x": x, "y": y }),
                        );
                    }
                }
                HookEvent::LongCaptureWheel { x, y, delta } => {
                    if let Some(state) = app.try_state::<crate::scroll_capture::LongCaptureState>()
                    {
                        state.notify_wheel(x, y, delta);
                    }
                }
                HookEvent::LongCapturePointerUp { x, y } => {
                    if let Some(state) = app.try_state::<crate::scroll_capture::LongCaptureState>()
                    {
                        state.notify_activity(x, y);
                    }
                }
                HookEvent::SmartScreenshotMove { x, y } => {
                    let _ = app.emit_to("screenshot-overlay", "screenshot-target-move", serde_json::json!({ "x": x, "y": y }));
                }
                HookEvent::SmartScreenshotClick { x, y } => {
                    let _ = app.emit_to("screenshot-overlay", "screenshot-target-click", serde_json::json!({ "x": x, "y": y }));
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
    // The picker replaces the system arrow cursor. Restore it whenever the
    // hook is stopped as a final cleanup path, including application shutdown.
    stop_color_pick();
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

/// 供外部模块调用，同步悬浮球可见状态：
/// 隐藏后鼠标钩子不再把原位置点击当作悬浮球交互
pub fn set_orb_visible(visible: bool) {
    STATE.orb_visible.store(visible, Ordering::SeqCst);
    crate::utils::logger::log("mouse", &format!("orb_visible = {}", visible));
}

/// Cache the utility hub HWND so the low-level mouse callback does not call
/// into Tauri while deciding whether a click belongs to the hub controls.
pub fn set_utility_hub_hwnd(hwnd: *mut std::ffi::c_void) {
    STATE.utility_hub_hwnd.store(hwnd, Ordering::SeqCst);
}

/// Arm a persistent native screen-pixel picker. Each primary click is consumed
/// after sampling, so it does not also activate the underlying application.
pub fn start_color_pick() -> Result<(), String> {
    let _cursor_lock = COLOR_PICK_LOCK
        .lock()
        .map_err(|_| "取色光标状态锁已损坏".to_string())?;
    STATE.mouse_down_valid.store(false, Ordering::SeqCst);
    if STATE.color_picker_active.load(Ordering::SeqCst) {
        return Ok(());
    }
    unsafe {
        let original = LoadCursorW(None, IDC_ARROW)
            .ok()
            .and_then(|cursor| CopyIcon(windows::Win32::UI::WindowsAndMessaging::HICON(cursor.0)).ok());
        let replacement = eyedropper_cursor()
            .and_then(|cursor| CopyIcon(windows::Win32::UI::WindowsAndMessaging::HICON(cursor.0)).ok());
        let original = original.ok_or_else(|| "无法读取系统光标".to_string())?;
        let replacement = replacement.ok_or_else(|| "无法创建取色光标".to_string())?;
        SetSystemCursor(HCURSOR(replacement.0), OCR_NORMAL)
            .map_err(|_| "无法设置取色光标".to_string())?;
        STATE
            .color_picker_restore_cursor
            .store(original.0 as isize, Ordering::SeqCst);
    }
    STATE.color_picker_active.store(true, Ordering::SeqCst);
    unsafe {
        let _ = SetCursor(eyedropper_cursor());
    }
    Ok(())
}

pub fn stop_color_pick() {
    let Ok(_cursor_lock) = COLOR_PICK_LOCK.lock() else {
        return;
    };
    STATE.color_picker_active.store(false, Ordering::SeqCst);
    STATE.mouse_down_valid.store(false, Ordering::SeqCst);
    let original = STATE.color_picker_restore_cursor.swap(0, Ordering::SeqCst);
    if original != 0 {
        unsafe {
            let _ = SetSystemCursor(HCURSOR(original as *mut std::ffi::c_void), OCR_NORMAL);
        }
    }
    if let Ok(cursor) = unsafe { LoadCursorW(None, IDC_ARROW) } {
        unsafe { let _ = SetCursor(Some(cursor)); }
    }
}

/// 供外部模块调用，查询工具栏是否可见
pub fn is_toolbar_visible() -> bool {
    STATE.toolbar_visible.load(Ordering::SeqCst)
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
    if !active {
        set_smart_screenshot_mode(false);
    }
    // 退出截图模式时重置鼠标按下残留状态，避免下次 MouseUp 误判
    if !active {
        STATE.mouse_down_valid.store(false, Ordering::SeqCst);
        STATE.mouse_down_on_orb.store(false, Ordering::SeqCst);
        STATE.mouse_down_on_orb_circle.store(false, Ordering::SeqCst);
        STATE.mouse_down_on_toolbar.store(false, Ordering::SeqCst);
    }
}

pub fn set_smart_screenshot_mode(active: bool) {
    STATE.smart_screenshot_mode.store(active, Ordering::SeqCst);
    if !active {
        STATE.smart_screenshot_last_emit_ms.store(0, Ordering::SeqCst);
        STATE.smart_controls_valid.store(false, Ordering::SeqCst);
    }
}

pub fn set_smart_screenshot_controls_bounds(bounds: Option<(i32, i32, i32, i32)>) {
    match bounds {
        Some((left, top, width, height)) if width > 0 && height > 0 => {
            STATE.smart_controls_left.store(left, Ordering::SeqCst);
            STATE.smart_controls_top.store(top, Ordering::SeqCst);
            STATE.smart_controls_right.store(left.saturating_add(width), Ordering::SeqCst);
            STATE.smart_controls_bottom.store(top.saturating_add(height), Ordering::SeqCst);
            STATE.smart_controls_valid.store(true, Ordering::SeqCst);
        }
        _ => STATE.smart_controls_valid.store(false, Ordering::SeqCst),
    }
}

fn is_smart_controls_point(x: i32, y: i32) -> bool {
    STATE.smart_controls_valid.load(Ordering::SeqCst)
        && x >= STATE.smart_controls_left.load(Ordering::SeqCst)
        && x < STATE.smart_controls_right.load(Ordering::SeqCst)
        && y >= STATE.smart_controls_top.load(Ordering::SeqCst)
        && y < STATE.smart_controls_bottom.load(Ordering::SeqCst)
}

pub fn is_smart_screenshot_mode() -> bool {
    STATE.smart_screenshot_mode.load(Ordering::SeqCst)
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
        STATE.mouse_down_on_orb_circle.store(false, Ordering::SeqCst);
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
                    // Consume the release that belongs to a sampled click as
                    // well. This keeps a multi-pick session isolated from the
                    // normal selection/drag handling while it remains armed.
                    if STATE.color_picker_active.load(Ordering::SeqCst) {
                        let hook = lparam.0
                            as *const windows::Win32::UI::WindowsAndMessaging::MSLLHOOKSTRUCT;
                        if !hook.is_null()
                            && is_point_in_utility_hub((*hook).pt.x, (*hook).pt.y)
                        {
                            return CallNextHookEx(None, code, wparam, lparam);
                        }
                        return LRESULT(1);
                    }
                    if STATE.smart_mouse_down.swap(false, Ordering::SeqCst) {
                        return LRESULT(1);
                    }
                    if STATE.smart_screenshot_mode.load(Ordering::SeqCst) {
                        let hook = lparam.0 as *const windows::Win32::UI::WindowsAndMessaging::MSLLHOOKSTRUCT;
                        if !hook.is_null() {
                            let event = &*hook;
                            if is_smart_controls_point(event.pt.x, event.pt.y) {
                                return CallNextHookEx(None, code, wparam, lparam);
                            }
                        }
                    }
                    // 转盘激活且实际可见时吞掉左键抬起，与 WM_LBUTTONDOWN 对称：
                    // 确保「点选扇区」的一次点击完全不会落入选区检测/拖选逻辑。
                    // 可见性守卫：active 卡死而转盘未显示时不吞点击，避免全局左键被吞。
                    if crate::quick_input::is_active() && crate::quick_input::wheel_visible() {
                        return LRESULT(1);
                    }
                    let hook =
                        lparam.0 as *const windows::Win32::UI::WindowsAndMessaging::MSLLHOOKSTRUCT;
                    if !hook.is_null() {
                        let event = &*hook;
                        let _ = sender.send(HookEvent::LongCapturePointerUp {
                            x: event.pt.x,
                            y: event.pt.y,
                        });
                    }
                    let _ = sender.send(HookEvent::MouseUp);
                }
                _ if msg == WM_MOUSEMOVE
                    && STATE.color_picker_active.load(Ordering::SeqCst) =>
                {
                    let _ = SetCursor(eyedropper_cursor());
                }
                _ if msg == WM_MOUSEMOVE
                    && crate::quick_input::is_active()
                    && crate::quick_input::wheel_visible() =>
                {
                    // 转盘模式：节流后把鼠标坐标转发给后台线程 emit，避免 WH_MOUSE_LL
                    // 回调内执行 emit_to 在设置窗口创建等场景下阻塞导致钩子被系统静默卸载。
                    // 可见性守卫：active 卡死而转盘未显示时停止无效 emit。
                    let now = now_ms();
                    let last = STATE.quick_input_last_emit_ms.load(Ordering::SeqCst);
                    // 16ms 节流（约 60fps），避免高频 mousemove 淹没后台线程/前端
                    if now.saturating_sub(last) >= 16 {
                        STATE.quick_input_last_emit_ms.store(now, Ordering::SeqCst);
                        let mut cur = POINT::default();
                        if GetCursorPos(&mut cur).is_ok() {
                            let _ = sender.send(HookEvent::QuickInputMove { x: cur.x, y: cur.y });
                        }
                    }
                }
                _ if msg == WM_MOUSEMOVE && STATE.smart_screenshot_mode.load(Ordering::SeqCst) => {
                    let now = now_ms();
                    let last = STATE.smart_screenshot_last_emit_ms.load(Ordering::SeqCst);
                    if now.saturating_sub(last) >= 30 {
                        STATE.smart_screenshot_last_emit_ms.store(now, Ordering::SeqCst);
                        let hook = lparam.0 as *const windows::Win32::UI::WindowsAndMessaging::MSLLHOOKSTRUCT;
                        if !hook.is_null() {
                            let event = &*hook;
                            let _ = sender.send(HookEvent::SmartScreenshotMove { x: event.pt.x, y: event.pt.y });
                        }
                    }
                }
                _ if msg == WM_LBUTTONDOWN => {
                    if STATE.color_picker_active.load(Ordering::SeqCst) {
                        let hook = lparam.0 as *const windows::Win32::UI::WindowsAndMessaging::MSLLHOOKSTRUCT;
                        if !hook.is_null() {
                            let event = &*hook;
                            if is_point_in_utility_hub(event.pt.x, event.pt.y) {
                                return CallNextHookEx(None, code, wparam, lparam);
                            }
                            let _ = sender.send(HookEvent::ColorPicked { x: event.pt.x, y: event.pt.y });
                        }
                        STATE.mouse_down_valid.store(false, Ordering::SeqCst);
                        STATE.mouse_down_on_orb.store(false, Ordering::SeqCst);
                        STATE.mouse_down_on_orb_circle.store(false, Ordering::SeqCst);
                        STATE.mouse_down_on_toolbar.store(false, Ordering::SeqCst);
                        return LRESULT(1);
                    }
                    // 快速输入转盘激活且实际可见时：任何按下都作为「点击选中扇区」处理。
                    // 通知前端（自行读高亮项并输入）后吞掉该按下，避免其落入
                    // 选区检测/拖选逻辑，也不会在转盘区域拖出文字工具栏。
                    // 可见性守卫：active 卡死而转盘未显示时不吞点击，保证全局鼠标可用。
                    if STATE.smart_screenshot_mode.load(Ordering::SeqCst) {
                        let hook = lparam.0 as *const windows::Win32::UI::WindowsAndMessaging::MSLLHOOKSTRUCT;
                        if !hook.is_null() {
                            let event = &*hook;
                            if is_smart_controls_point(event.pt.x, event.pt.y) {
                                return CallNextHookEx(None, code, wparam, lparam);
                            }
                            STATE.smart_mouse_down.store(true, Ordering::SeqCst);
                            let _ = sender.send(HookEvent::SmartScreenshotClick { x: event.pt.x, y: event.pt.y });
                        }
                        return LRESULT(1);
                    }
                    if crate::quick_input::is_active() && crate::quick_input::wheel_visible() {
                        // 独立线程执行 confirm_by_click（内含 emit_to）：WH_MOUSE_LL 回调需在超时内返回，
                        // 避免设置窗口创建等场景下 emit 阻塞导致整个鼠标钩子被系统静默卸载。
                        if let Some(app) = STATE.app_handle.get() {
                            let app_clone = app.clone();
                            let generation = crate::quick_input::state().generation;
                            std::thread::spawn(move || {
                                crate::quick_input::confirm_by_click(&app_clone, generation);
                            });
                        }
                        // 清除残留的按下状态，避免随后的 WM_LBUTTONUP 误判为拖选而弹出文字工具栏
                        STATE.mouse_down_valid.store(false, Ordering::SeqCst);
                        STATE.mouse_down_on_orb.store(false, Ordering::SeqCst);
                        STATE.mouse_down_on_orb_circle.store(false, Ordering::SeqCst);
                        STATE.mouse_down_on_toolbar.store(false, Ordering::SeqCst);
                        // 吞掉该按下，不让它穿透到下层窗口
                        return LRESULT(1);
                    }
                    // WH_MOUSE_LL 的 lparam 是指向 MSLLHOOKSTRUCT 的指针，
                    // 其首字段 pt: POINT 即真实屏幕坐标
                    let pt = lparam.0 as *const POINT;
                    let x = (*pt).x;
                    let y = (*pt).y;
                    let foreground = GetForegroundWindow();
                    let foreground = if foreground.is_invalid() {
                        0
                    } else {
                        foreground.0 as isize
                    };
                    let _ = sender.send(HookEvent::MouseDown {
                        x,
                        y,
                        foreground,
                    });
                }
                _ if msg == WM_MOUSEWHEEL => {
                    let hook =
                        lparam.0 as *const windows::Win32::UI::WindowsAndMessaging::MSLLHOOKSTRUCT;
                    if !hook.is_null() {
                        let event = &*hook;
                        let delta = ((event.mouseData >> 16) & 0xffff) as u16 as i16;
                        let _ = sender.send(HookEvent::LongCaptureWheel {
                            x: event.pt.x,
                            y: event.pt.y,
                            delta,
                        });
                    }
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
    fn test_is_point_in_orb_circle_null_hwnd() {
        // null HWND 应返回 false
        assert!(!is_point_in_orb_circle(std::ptr::null_mut(), 100, 100));
    }

    #[test]
    fn test_now_ms_returns_nonzero() {
        let ms = now_ms();
        // 系统时间应返回非零值（1970 年后的毫秒数）
        assert!(ms > 0, "now_ms() 应返回正数，实际: {}", ms);
    }

    #[test]
    fn test_orb_circle_geometry() {
        // 验证 orb 圆形热区的几何逻辑（无需实际窗口）
        // 以窗口逻辑尺寸 96×96、圆心 (48, 48)、交互半径 30 为基准，
        // 与 is_point_in_orb_circle 的物理像素等比换算保持一致
        let cx = 48.0_f64;
        let cy = 48.0_f64;
        let r = ORB_HIT_RADIUS_LOGICAL;

        // 交互半径应略大于视觉球半径 28（hover scale 1.05 → 约 29.4px）
        assert!(r > 28.0);
        assert!(r <= 32.0);

        // 圆心点应包含
        assert!(point_in_circle(cx, cy, r, 48, 48));
        // 半径内点应包含
        assert!(point_in_circle(cx, cy, r, 48 + 29, 48));
        // 半径外点（窗口角部留白）不应包含
        assert!(!point_in_circle(cx, cy, r, 95, 95));
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

    #[test]
    fn test_toolbar_visible_getter_roundtrip() {
        // 保存现场，测试后恢复，避免污染共享的全局状态
        let original = is_toolbar_visible();
        set_toolbar_visible(false);
        assert!(!is_toolbar_visible());
        set_toolbar_visible(true);
        assert!(is_toolbar_visible());
        set_toolbar_visible(original);
    }

    #[test]
    fn stopping_color_pick_clears_global_interception_state() {
        // Keep the stored cursor null so this test never changes the system
        // cursor scheme; it only verifies the state that controls interception.
        STATE.color_picker_active.store(true, Ordering::SeqCst);
        STATE.mouse_down_valid.store(true, Ordering::SeqCst);
        STATE.color_picker_restore_cursor.store(0, Ordering::SeqCst);

        stop_color_pick();

        assert!(!STATE.color_picker_active.load(Ordering::SeqCst));
        assert!(!STATE.mouse_down_valid.load(Ordering::SeqCst));
    }
}
