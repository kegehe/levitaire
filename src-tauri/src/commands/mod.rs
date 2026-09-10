use std::collections::HashMap;

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};

use std::sync::{Mutex, OnceLock};

use tauri::Emitter;

use tauri::Manager;

use tauri::State;

use windows::Win32::Foundation::{HWND, POINT};

use windows::Win32::UI::WindowsAndMessaging::{

    GetAncestor, GetCursorPos, GetForegroundWindow, GetWindowLongPtrW, IsWindow,
    SetForegroundWindow, SetWindowDisplayAffinity, SetWindowLongPtrW, WindowFromPoint, GA_ROOT,
    GWL_EXSTYLE, WDA_NONE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

use crate::automation::SelectionInfo;

use crate::clipboard::ClipboardManager;

use crate::config::ConfigManager;

use serde::Serialize;


static SCREENSHOT_STARTING: AtomicBool = AtomicBool::new(false);

static SKETCH_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);

static SKETCH_VISIBLE_BEFORE_SESSION: AtomicBool = AtomicBool::new(false);

static SCREENSHOT_START_PENDING: AtomicBool = AtomicBool::new(false);

static SCREENSHOT_OVERLAY_HEARTBEAT_MS: AtomicU64 = AtomicU64::new(0);

static SCREENSHOT_OVERLAY_HEARTBEAT_SEEN: AtomicBool = AtomicBool::new(false);

const SCREENSHOT_OVERLAY_HEARTBEAT_TIMEOUT_MS: u64 = 10_000;

const SCREENSHOT_OVERLAY_READY_TIMEOUT_MS: u64 = 3_000;

static RECORDING_SELECT_START_PENDING: AtomicBool = AtomicBool::new(false);

static SKETCH_START_PENDING: AtomicBool = AtomicBool::new(false);

// Invalidates an in-flight recording selection startup when cancellation or
// a newer startup wins the lifecycle race.
static RECORDING_SELECT_SESSION: AtomicU64 = AtomicU64::new(0);

static TODO_QUICK_ADD_PENDING: AtomicBool = AtomicBool::new(false);

static ORB_READY: AtomicBool = AtomicBool::new(false);

static STICKY_MANAGER_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);


const MAX_IPC_MEDIA_BYTES: usize = 64 * 1024 * 1024;

// GIF keeps each captured frame as an RGBA bitmap before palette encoding.
// This bounds peak per-frame allocation to roughly 64 MiB while allowing UHD.
const MAX_GIF_RECORDING_PIXELS: u64 = 16_000_000;


#[derive(Clone, Copy)]
struct ScreenshotMonitorBounds {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}


// Captured before the overlay takes focus so the selection controls stay on
// the monitor where the screenshot was started, even if the cursor moves while
// the overlay is being prepared.
static SCREENSHOT_MONITOR_BOUNDS: OnceLock<Mutex<Option<ScreenshotMonitorBounds>>> =
    OnceLock::new();

static SCREENSHOT_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);

static SCREENSHOT_SESSION: AtomicU64 = AtomicU64::new(0);

static UTILITY_HUB_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);

static MONITOR_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);

static POMODORO_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);

static TIMER_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);

static TODO_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);


/// 截图/录屏会话开始前 orb 的可见状态。
/// 会话清理（取消截图/录屏）时按此状态恢复 orb，而不是无条件 show：
/// 否则用户通过托盘「显示/隐藏浮球」已隐藏的 orb 会被强制弹出，
/// 与托盘开关相互矛盾。仅在真正进入会话时写入，会话结束后由下个会话覆盖。
static ORB_VISIBLE_BEFORE_SESSION: AtomicBool = AtomicBool::new(true);

/// 截图/录屏会话开始前时钟、待办悬浮窗的可见状态。
/// 与 orb 同理：缓存截取期间会临时隐藏它们，会话清理时按此状态恢复，
/// 而不是无条件 show。仅在真正进入会话时写入，会话结束后由下个会话覆盖。
static TIMER_VISIBLE_BEFORE_SESSION: AtomicBool = AtomicBool::new(false);

static TODO_VISIBLE_BEFORE_SESSION: AtomicBool = AtomicBool::new(false);


/// 截图/录屏会话是否活跃。进入 start_screenshot / start_recording_select 时置 true，
/// 会话清理（cleanup_screenshot_session_inner / cancel_recording_select）时置 false。
/// 用于区分「正在清理会话」（按会话前状态恢复 orb）与「空闲清理」
/// （如仅关闭工具开关，不应动 orb）。相比隐式推断 `is_screenshot_mode()/is_recording_mode()`
/// 的可靠性：录制「编码/预览」阶段 recording_mode 已被清除但 `is_finishing()` 仍为 true，
/// 此时清理仍应恢复 orb，故用显式标记覆盖整个会话生命周期。
static CAPTURE_SESSION_ACTIVE: AtomicBool = AtomicBool::new(false);

static TOOLBAR_VISIBLE_BEFORE_LONG_CAPTURE: AtomicBool = AtomicBool::new(false);

// Serializes session teardown with long-capture registration. Without this,
// Esc can clean up between the session check and worker registration.
static CAPTURE_SESSION_LOCK: Mutex<()> = Mutex::new(());

// Serializes recording-selection startup with cancellation. The startup path
// performs several window operations and must not be interleaved with teardown.
static RECORDING_SELECT_LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());

// Couples the recording-running check with overlay click-through changes so a
// delayed controls startup cannot re-arm an overlay after stop/cancel cleanup.
static RECORDING_CONTROLS_LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());

// Target detection and live capture both temporarily change the screenshot
// overlay's visibility/click-through state. Keep those transitions atomic so
// concurrent hover/click requests cannot restore the wrong state.
static SMART_SCREENSHOT_OVERLAY_LOCK: Mutex<()> = Mutex::new(());

/// 前台目标窗口快照。截图 Overlay 显示后前台窗口会变成 Levitaire，
/// 长截图开始时用此句柄把交互权交还给用户刚才操作的应用。
static SCREENSHOT_TARGET_HWND: AtomicIsize = AtomicIsize::new(0);


/// 恢复默认位置时抑制对应窗口 onMoved 保存的截止时间戳（窗口 id → 截止毫秒）。
/// 程序化 set_position 会触发 onMoved → 前端在 300ms 后再次 set_window_position，
/// 若不抑制会把刚恢复的默认位置重新记忆。此窗口期内仅忽略该窗口的保存请求，
/// 不影响其他悬浮窗的正常拖动记忆。
static POSITION_SAVE_SUPPRESS_UNTIL_MS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();


/// 保护 settings 窗口"检查+创建+注册关闭拦截"的异步互斥锁，防止快速双击导致竞态
/// 使用 tokio::sync::Mutex 而非 std::sync::Mutex，避免在 async 函数中持有同步锁导致死锁
static SETTINGS_INIT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Protect the independently-created tool configuration window from duplicate creation.
static TOOL_CONFIG_INIT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 保护 palette 窗口"检查+创建+注册关闭拦截"的异步互斥锁，防止快速双击导致竞态
static PALETTE_INIT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());


struct ScreenshotStartGuard;

impl ScreenshotStartGuard {
    fn acquire() -> Option<Self> {
        SCREENSHOT_STARTING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Self)
    }
}


impl Drop for ScreenshotStartGuard {
    fn drop(&mut self) {
        SCREENSHOT_STARTING.store(false, Ordering::SeqCst);
    }
}


/// prompt 最大长度限制（字节数，String::len() 返回 UTF-8 字节数）
const MAX_PROMPT_LENGTH: usize = 100000;


/// 允许通过 open_url 打开的 URL scheme 白名单。
/// 仅放行浏览器/常见协议，阻止 file://、脚本协议等可能被构造用于命令注入的 scheme。
const ALLOWED_URL_SCHEMES: &[&str] = &["http", "https", "mailto"];


#[derive(Clone, Serialize)]
pub struct HotkeyConflictResult {
    pub id: String,
    pub hotkey: String,
    pub status: String,
    pub message: String,
}


// ─── TTS 朗读 ────────────────────────────────────────────────────

/// TTS 单次合成的字符上限（一次性合成，超长会阻塞且占内存）
const MAX_TTS_CHARS: usize = 5000;


mod session;
mod text;
mod screenshot;
mod long_capture;
mod recording;
mod sketch;
mod ai;
mod quick_input;
mod todo;
mod sticky;
mod timer;
mod pomodoro;
mod monitor;
mod tools;
mod window;

pub use session::*;
pub use text::*;
pub use screenshot::*;
pub use long_capture::*;
pub use recording::*;
pub use sketch::*;
pub use ai::*;
pub use quick_input::*;
pub use todo::*;
pub use sticky::*;
pub use timer::*;
pub use pomodoro::*;
pub use monitor::*;
pub use tools::*;
pub use window::*;


fn decode_base64_media(data: &str, kind: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let raw = data.find(',').map(|idx| &data[idx + 1..]).unwrap_or(data);
    // Reject before decoding so a malicious IPC payload cannot force a large allocation.
    let max_encoded = MAX_IPC_MEDIA_BYTES
        .checked_add(2)
        .and_then(|n| n.checked_div(3))
        .and_then(|n| n.checked_mul(4))
        .unwrap_or(usize::MAX);
    if raw.len() > max_encoded {
        return Err(format!("{} 数据过大，已拒绝", kind));
    }
    let bytes = STANDARD
        .decode(raw)
        .map_err(|e| format!("base64 解码失败: {}", e))?;
    if bytes.len() > MAX_IPC_MEDIA_BYTES {
        return Err(format!("{} 数据过大，已拒绝", kind));
    }
    Ok(bytes)
}


fn screenshot_monitor_bounds() -> &'static Mutex<Option<ScreenshotMonitorBounds>> {
    SCREENSHOT_MONITOR_BOUNDS.get_or_init(|| Mutex::new(None))
}


pub fn queue_screenshot_start_pending() {
    SCREENSHOT_START_PENDING.store(true, Ordering::SeqCst);
}


/// 置位/复位截图·录屏捕获会话活跃标记，并把状态变化同步给 screenshot-overlay
/// 渲染进程：会话激活时 OverlaySwitcher 需要持续发送心跳，供原生 watchdog 确认
/// 渲染器存活；会话空闲时后端不消费心跳，前端据此停止周期 IPC，避免常驻浮层
/// 隐藏期间仍每 500ms 空转一次进程间通信。
fn set_capture_session_active(app: &tauri::AppHandle, active: bool) {
    CAPTURE_SESSION_ACTIVE.store(active, Ordering::SeqCst);
    let _ = app.emit_to(
        "screenshot-overlay",
        if active {
            "capture-session-active"
        } else {
            "capture-session-inactive"
        },
        (),
    );
}


pub fn queue_recording_select_start_pending() {
    RECORDING_SELECT_START_PENDING.store(true, Ordering::SeqCst);
}


pub fn queue_sketch_start_pending() {
    SKETCH_START_PENDING.store(true, Ordering::SeqCst);
}


pub fn queue_todo_quick_add_pending() {
    TODO_QUICK_ADD_PENDING.store(true, Ordering::SeqCst);
}


pub fn is_orb_ready() -> bool {
    ORB_READY.load(Ordering::SeqCst)
}


fn position_save_suppress() -> &'static Mutex<HashMap<String, u64>> {
    POSITION_SAVE_SUPPRESS_UNTIL_MS.get_or_init(|| Mutex::new(HashMap::new()))
}


fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}


fn show_screenshot_native_error(message: impl Into<String>) {
    let message = message.into();
    std::thread::spawn(move || {
        let _ = rfd::MessageDialog::new()
            .set_title("Levitaire")
            .set_description(message)
            .set_buttons(rfd::MessageButtons::Ok)
            .show();
    });
}


fn start_screenshot_overlay_watchdog(app: tauri::AppHandle, session: u64) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(1_000));
        if !CAPTURE_SESSION_ACTIVE.load(Ordering::SeqCst)
            || current_screenshot_session() != session
        {
            break;
        }
        let heartbeat = SCREENSHOT_OVERLAY_HEARTBEAT_MS.load(Ordering::SeqCst);
        if heartbeat != 0
            && now_ms().saturating_sub(heartbeat) <= SCREENSHOT_OVERLAY_HEARTBEAT_TIMEOUT_MS
        {
            continue;
        }

        crate::utils::logger::log(
            "screenshot",
            "截图 overlay 心跳超时，自动隐藏并清理截图会话",
        );
        // Only the watchdog that still owns this session may tear it down;
        // this avoids showing a false error after the user already cancelled.
        if cleanup_screenshot_session_if_current(&app, session) {
            // The renderer may be unavailable, so use a native dialog as the
            // guaranteed error surface instead of relying on the WebView UI.
            show_screenshot_native_error("截图工具页面加载失败，截图会话已退出。");
        }
        break;
    });
}


/// Wait for JavaScript to prove that the overlay renderer is alive before the
/// native window is made visible. This prevents WebView2's own load-error page
/// from ever becoming the user-facing screenshot surface.
fn wait_for_screenshot_overlay_ready(app: &tauri::AppHandle, session: u64) -> Result<(), String> {
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_millis(SCREENSHOT_OVERLAY_READY_TIMEOUT_MS);
    while std::time::Instant::now() < deadline {
        if current_screenshot_session() != session
            || !CAPTURE_SESSION_ACTIVE.load(Ordering::SeqCst)
        {
            return Err("截图会话已结束".to_string());
        }
        if SCREENSHOT_OVERLAY_HEARTBEAT_SEEN.load(Ordering::SeqCst) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    cleanup_screenshot_session_if_current(app, session);
    Err("截图工具页面加载失败，请重试".to_string())
}


/// End a screenshot session from every exit path without destroying the configured overlay.
fn cleanup_screenshot_session_inner(app: &tauri::AppHandle) {
    // 仅会话进行中被隐藏的 orb 才按会话前状态恢复，避免把用户经托盘已隐藏的 orb
    // 强制弹出（托盘「显示/隐藏浮球」与清理逻辑相互矛盾）。
    // 用会话活跃标记区分「正在清理会话」与「空闲清理」（如仅关闭工具开关），
    // 空闲清理不应动 orb。必须在 set_screenshot_mode(false) 之前读取。
    let session_active = CAPTURE_SESSION_ACTIVE.load(Ordering::SeqCst);
    let long_capture_was_active = app
        .try_state::<crate::scroll_capture::LongCaptureState>()
        .map(|state| {
            let active = state.is_active();
            state.cancel_active();
            active
        })
        .unwrap_or(false);
    if long_capture_was_active {
        // Keep the controls window in sync for global Esc and native-close
        // paths, which do not go through cancel_long_capture.
        let _ = app.emit("long-capture-cancelled", ());
    }
    if let Some(controls) = app.get_webview_window("long-capture-controls") {
        let _ = controls.hide();
    }
    if let Some(frame) = app.get_webview_window("long-capture-frame") {
        let _ = frame.hide();
    }
    crate::hooks::mouse::set_screenshot_mode(false);
    // 如果录制模式也处于活跃状态（例如 overlay 显示了 ScreenshotTool 但实际是录制模式），
    // 一并清理，避免 recording_mode 残留导致后续状态不一致
    if crate::hooks::mouse::is_recording_mode() {
        crate::hooks::mouse::set_recording_mode(false);
        if let Some(state) = app.try_state::<crate::recording::RecordingState>() {
            let _ = state.cancel();
        }
        let _ = finish_recording_controls(app.clone());
    }
    if let Some(overlay) = app.get_webview_window("screenshot-overlay") {
        // Wait for any in-flight target detection/live capture to finish its
        // temporary overlay transition before hiding it for cancellation.
        let _overlay_guard = SMART_SCREENSHOT_OVERLAY_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _ = overlay.hide();
    }
    if let Some(cache) = app.try_state::<crate::screenshot::ScreenCache>() {
        if let Ok(mut guard) = cache.pixels.lock() {
            *guard = None;
        }
    }
    // 仅当确有会话被清理且会话前 orb 可见时才恢复显示，避免强制弹出托盘已隐藏的 orb
    if session_active && ORB_VISIBLE_BEFORE_SESSION.load(Ordering::SeqCst) {
        if let Some(orb) = app.get_webview_window("orb") {
            let _ = orb.show();
            let _ = orb.set_always_on_top(true);
        }
    }
    // 恢复会话前可见的时钟/待办悬浮窗：缓存截取期间被临时隐藏，
    // 若会话在恢复步骤前被取消（如截屏期间按 Esc），此处兜底恢复。
    if session_active {
        if TIMER_VISIBLE_BEFORE_SESSION.swap(false, Ordering::SeqCst) {
            if let Some(timer) = app.get_webview_window("time-overlay") {
                let _ = timer.show();
            }
        }
        if TODO_VISIBLE_BEFORE_SESSION.swap(false, Ordering::SeqCst) {
            if let Some(todo) = app.get_webview_window("todo-overlay") {
                let _ = todo.show();
            }
        }
    }
    if TOOLBAR_VISIBLE_BEFORE_LONG_CAPTURE.swap(false, Ordering::SeqCst) {
        if let Some(toolbar) = app.get_webview_window("toolbar") {
            let _ = toolbar.show();
        }
    }
    if SKETCH_VISIBLE_BEFORE_SESSION.swap(false, Ordering::SeqCst) {
        if let Some(sketch) = app.get_webview_window("sketch-overlay") {
            let _ = sketch.show();
            let _ = sketch.set_focus();
        }
    }
    SCREENSHOT_TARGET_HWND.store(0, Ordering::SeqCst);
    SCREENSHOT_OVERLAY_HEARTBEAT_MS.store(0, Ordering::SeqCst);
    SCREENSHOT_OVERLAY_HEARTBEAT_SEEN.store(false, Ordering::SeqCst);
    // 会话结束，复位活跃标记，避免泄漏到后续空闲清理误判；
    // 同时通知 overlay 渲染进程停止周期心跳（空闲时无需空转 IPC）
    set_capture_session_active(app, false);
}


pub fn cleanup_screenshot_session(app: &tauri::AppHandle) {
    SCREENSHOT_SESSION.fetch_add(1, Ordering::SeqCst);
    let _session_lock = CAPTURE_SESSION_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    cleanup_screenshot_session_inner(app);
}


/// Returns whether a foreground/root HWND belongs to one of Levitaire's own
/// windows. A screenshot started from the palette or orb must still target
/// the external application underneath them.
fn is_levitaire_window(app: &tauri::AppHandle, hwnd: HWND) -> bool {
    if hwnd.0.is_null() {
        return false;
    }
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    let root = if root.0.is_null() { hwnd } else { root };
    [
        "orb",
        "toolbar",
        "palette",
        "settings",
        "tool-config",
        "context-menu",
        "pin-ocr",
        "update-prompt",
        "screenshot-overlay",
        "recording-controls",
        "long-capture-controls",
        "long-capture-frame",
        "monitor-overlay",
        "pomodoro-overlay",
        "quick-input-overlay",
        "time-overlay",
        "todo-overlay",
        "sketch-overlay",
        "utility-hub-overlay",
    ]
    .iter()
    .filter_map(|label| app.get_webview_window(label))
    .filter_map(|window| window.hwnd().ok())
    .map(|window| {
        let window_root = unsafe { GetAncestor(window, GA_ROOT) };
        if window_root.0.is_null() {
            window
        } else {
            window_root
        }
    })
    .any(|window| window.0 == root.0)
}


pub fn current_screenshot_session() -> u64 {
    SCREENSHOT_SESSION.load(Ordering::SeqCst)
}


pub fn is_screenshot_starting() -> bool {
    SCREENSHOT_STARTING.load(Ordering::SeqCst)
}


/// 若指定的 session 是当前截图会话则清理，并返回是否实际清理。
/// 返回 false 表示该 session 已过期（已有更新的会话接管），调用方据此判断
/// 不应向当前活跃会话发出「已取消」通知，避免误重置新会话的前端状态。
pub fn cleanup_screenshot_session_if_current(app: &tauri::AppHandle, session: u64) -> bool {
    if SCREENSHOT_SESSION
        .compare_exchange(
            session,
            session.wrapping_add(1),
            Ordering::SeqCst,
            Ordering::SeqCst,
        )
        .is_ok()
    {
        let _session_lock = CAPTURE_SESSION_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        cleanup_screenshot_session_inner(app);
        true
    } else {
        false
    }
}


/// 校验 URL 是否为允许的 scheme（大小写不敏感）。
/// 返回规范化后的小写 scheme。
fn validate_url_scheme(url: &str) -> Result<String, String> {
    // 去除首部空白与控制字符，避免 \r\n 等被用于注入
    let trimmed = url.trim_start_matches(|c: char| c.is_whitespace() || c.is_control());
    let scheme = trimmed
        .split(':')
        .next()
        .ok_or_else(|| "URL 缺少 scheme".to_string())?
        .trim_end_matches(|c: char| c.is_whitespace() || c.is_control())
        .to_lowercase();
    if scheme.is_empty() {
        return Err("URL scheme 为空".to_string());
    }
    // scheme 仅允许字母数字，杜绝 scheme 内嵌入特殊字符
    if !scheme.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("非法 URL scheme: {}", scheme));
    }
    if !ALLOWED_URL_SCHEMES.contains(&scheme.as_str()) {
        return Err(format!("不允许的 URL scheme: {}", scheme));
    }
    Ok(scheme)
}


/// 为日志生成脱敏 URL：仅保留 scheme 与 host，丢弃路径与查询串。
/// 避免把用户的搜索词、URL 中的 token 等敏感信息写进本地日志。
fn redact_url_for_log(url: &str) -> String {
    let trimmed = url.trim_start_matches(|c: char| c.is_whitespace() || c.is_control());
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        return "<redacted>".to_string();
    };
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    // 丢弃可能存在的 userinfo（形如 user:password@host），避免把凭据写进日志
    let host = rest[..host_end].rsplit('@').next().unwrap_or("");
    if host.is_empty() {
        format!("{}://<redacted>", scheme)
    } else {
        format!("{}://{}", scheme, host)
    }
}


/// 捕获当前光标所在显示器的工作区边界（物理像素）。
/// 供截图逻辑在异步/前端操作可能移动光标之前，锁定发起截图的目标显示器。
fn monitor_work_area_for_cursor() -> Option<ScreenshotMonitorBounds> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        };

        let mut cursor = POINT::default();
        if unsafe { GetCursorPos(&mut cursor) }.is_err() {
            return None;
        }
        let monitor = unsafe { MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST) };
        if monitor.is_invalid() {
            return None;
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
            return None;
        }
        let rc = info.rcWork;
        if rc.right <= rc.left || rc.bottom <= rc.top {
            return None;
        }
        Some(ScreenshotMonitorBounds {
            left: rc.left,
            top: rc.top,
            right: rc.right,
            bottom: rc.bottom,
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}


/// start_screenshot 的核心逻辑，独立出来供热键等非命令入口复用。
/// 缓存 State 在内部用 app.state() 获取，避免调用方构造 State 的麻烦与生命周期问题。
pub fn start_screenshot_inner(app: tauri::AppHandle) -> Result<(), String> {
    crate::utils::logger::log("screenshot", "start_screenshot called");
    SCREENSHOT_START_PENDING.store(false, Ordering::SeqCst);
    let Some(_start_guard) = ScreenshotStartGuard::acquire() else {
        crate::utils::logger::log("screenshot", "screenshot start already in progress");
        return Ok(());
    };
    // Serialize startup with cancellation/cleanup until the active-session
    // flags and visibility snapshots have been committed. Otherwise Esc can
    // clean up before activation and the old startup sequence can resurrect a
    // screenshot overlay afterwards.
    let session_lock = CAPTURE_SESSION_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // Capture the initiating monitor before any asynchronous/frontend work can
    // move the cursor or allow the overlay to take focus.
    if let Ok(mut stored) = screenshot_monitor_bounds().lock() {
        *stored = monitor_work_area_for_cursor();
    }
    // 录制模式激活时，不允许启动截图（避免两种模式同时激活导致 Esc 处理混乱）
    if crate::hooks::mouse::is_recording_mode() {
        crate::utils::logger::log(
            "screenshot",
            "recording mode active, ignoring screenshot start",
        );
        return Ok(());
    }
    if app
        .try_state::<crate::scroll_capture::LongCaptureState>()
        .map(|state| state.is_active())
        .unwrap_or(false)
    {
        crate::utils::logger::log(
            "screenshot",
            "long capture active, ignoring screenshot start",
        );
        return Ok(());
    }
    if crate::hooks::mouse::is_screenshot_mode() {
        // 检查 overlay 窗口是否真正存活：get_webview_window 可能返回已销毁窗口的残留引用，
        // 用 inner_size() 做活性验证，失败说明窗口已销毁但 screenshot_mode 未重置
        let overlay_alive = app
            .get_webview_window("screenshot-overlay")
            .and_then(|w| w.inner_size().ok());
        if overlay_alive.is_none() {
            crate::utils::logger::log(
                "screenshot",
                "screenshot_mode stale (overlay gone), resetting and retrying",
            );
            crate::hooks::mouse::set_screenshot_mode(false);
            if let Some(cache) = app.try_state::<crate::screenshot::ScreenCache>() {
                if let Ok(mut guard) = cache.pixels.lock() {
                    *guard = None;
                }
            }
        } else {
            crate::utils::logger::log(
                "screenshot",
                "screenshot already active, ignoring duplicate start",
            );
            return Ok(());
        }
    }
    if app.get_webview_window("screenshot-overlay").is_none() {
        return Err("screenshot overlay window was not found".to_string());
    }
    // The sketch overlay is full-screen and always-on-top. Hide it only after
    // all duplicate/invalid-session checks have passed, so an early return
    // cannot leave the user's sketch window hidden.
    if let Some(sketch) = app.get_webview_window("sketch-overlay") {
        if sketch.is_visible().unwrap_or(false) {
            SKETCH_VISIBLE_BEFORE_SESSION.store(true, Ordering::SeqCst);
            crate::utils::logger::log(
                "screenshot",
                "hiding visible sketch overlay before screenshot start",
            );
            if let Err(error) = sketch.hide() {
                SKETCH_VISIBLE_BEFORE_SESSION.store(false, Ordering::SeqCst);
                return Err(format!("隐藏草稿窗口失败: {}", error));
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    // Capture the user's foreground application before the screenshot overlay
    // becomes active and takes focus. Long capture restores this window after
    // the region has been confirmed.
    let foreground = unsafe { GetForegroundWindow() };
    let foreground_target = if unsafe { IsWindow(Some(foreground)).as_bool() }
        && !is_levitaire_window(&app, foreground)
    {
        let root = unsafe { GetAncestor(foreground, GA_ROOT) };
        if root.0.is_null() {
            foreground
        } else {
            root
        }
    } else {
        HWND(std::ptr::null_mut())
    };
    SCREENSHOT_TARGET_HWND.store(foreground_target.0 as isize, Ordering::SeqCst);
    // A completed long capture keeps its preview window visible. It must not
    // appear in the clean desktop frame captured for the next screenshot.
    if let Some(controls) = app.get_webview_window("long-capture-controls") {
        let _ = controls.hide();
    }
    if let Some(frame) = app.get_webview_window("long-capture-frame") {
        let _ = frame.hide();
    }
    if let Some(state) = app.try_state::<crate::scroll_capture::LongCaptureState>() {
        state.discard_all();
    }
    // A previous renderer crash may have left a stale WebView surface visible
    // while the native screenshot mode flag was already reset. Hide it before
    // touching the desktop or starting a new session.
    if let Some(existing_overlay) = app.get_webview_window("screenshot-overlay") {
        if let Err(error) = existing_overlay.hide() {
            return Err(format!("隐藏截图蒙层失败: {}", error));
        }
    }
    let session = SCREENSHOT_SESSION
        .fetch_add(1, Ordering::SeqCst)
        .wrapping_add(1);
    let overlay = app
        .get_webview_window("screenshot-overlay")
        .ok_or_else(|| {
            crate::utils::logger::log(
                "screenshot",
                "ERROR: screenshot-overlay 窗口未加载（前端 ensureScreenshotWindow 未创建成功）",
            );
            "screenshot-overlay 窗口未加载".to_string()
        })?;
    crate::utils::logger::log("screenshot", "overlay 窗口已获取，准备截屏缓存");
    // 对照：查 orb/toolbar/palette/monitor-overlay 窗口的 hwnd 是否就绪
    for (label, win) in [
        ("orb", app.get_webview_window("orb")),
        ("toolbar", app.get_webview_window("toolbar")),
        ("palette", app.get_webview_window("palette")),
        ("monitor-overlay", app.get_webview_window("monitor-overlay")),
    ] {
        match win {
            Some(w) => match w.hwnd() {
                Ok(h) => crate::utils::logger::log(
                    "screenshot",
                    &format!("对照 {} hwnd={:p} 就绪", label, h.0),
                ),
                Err(e) => crate::utils::logger::log(
                    "screenshot",
                    &format!("对照 {} hwnd 失败: {}", label, e),
                ),
            },
            None => crate::utils::logger::log("screenshot", &format!("对照 {} 窗口不存在", label)),
        }
    }
    // 等待底层 HWND 就绪：ensureScreenshotWindow 的 tauri://created 事件触发时，
    // 窗口逻辑对象已创建，但 Win32 HWND 可能尚未就绪（the underlying handle is not available）。
    // 此时 show/set_focus 会 no-op 且 is_visible 恒为 false，导致遮罩不显示、无法拖拽。
    // 轮询等待 hwnd 可用，最多约 2 秒。
    let mut hwnd_ready = false;
    for _ in 0..40 {
        match overlay.hwnd() {
            Ok(h) => {
                crate::utils::logger::log("screenshot", &format!("overlay hwnd 就绪: {:p}", h.0));
                hwnd_ready = true;
                break;
            }
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
    if !hwnd_ready {
        crate::utils::logger::log(
            "screenshot",
            "ERROR: overlay hwnd 2秒内未就绪，遮罩可能无法显示",
        );
        SCREENSHOT_SESSION.fetch_add(1, Ordering::SeqCst);
        cleanup_screenshot_session_inner(&app);
        return Err("screenshot overlay HWND did not become ready".to_string());
    }
    if current_screenshot_session() != session {
        return Ok(());
    }
    if SCREENSHOT_CLOSE_HANDLER_REGISTERED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let app_on_close = app.clone();
        overlay.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                cleanup_screenshot_session(&app_on_close);
            }
            // 前端每次进入截图/录屏前都会先销毁再重建 overlay 窗口，
            // 窗口销毁后其上的监听器随之失效。此处监听 Destroyed 复位
            // 注册标记，使新窗口能重新注册关闭拦截；否则第二次起在遮罩上
            // Alt+F4 会直接关窗而不清理截图状态，导致截图模式卡死。
            tauri::WindowEvent::Destroyed => {
                SCREENSHOT_CLOSE_HANDLER_REGISTERED.store(false, Ordering::SeqCst);
            }
            _ => {}
        });
    }
    let cache = app.state::<crate::screenshot::ScreenCache>();
    // 隐藏所有浮动 UI，避免被截入全屏缓存
    let orb_was_visible = app
        .get_webview_window("orb")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    // 时钟/待办悬浮窗常驻桌面，同样记录可见性并在缓存截取期间隐藏，
    // 避免被截入全屏缓存或成为智能截屏的目标。
    let timer_was_visible = app
        .get_webview_window("time-overlay")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    let todo_was_visible = app
        .get_webview_window("todo-overlay")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    // 记录会话前 orb/时钟/待办可见性 + 会话活跃标记，供会话清理（取消截图）时按原状态恢复，
    // 不强制弹出用户经托盘已隐藏的 orb。先记录再置 screenshot_mode，
    // 避免并发清理读到「模式已置但标记未更新」的半状态。
    ORB_VISIBLE_BEFORE_SESSION.store(orb_was_visible, Ordering::SeqCst);
    TIMER_VISIBLE_BEFORE_SESSION.store(timer_was_visible, Ordering::SeqCst);
    TODO_VISIBLE_BEFORE_SESSION.store(todo_was_visible, Ordering::SeqCst);
    // 置活跃标记并通知 overlay 启动周期心跳：wait_for_screenshot_overlay_ready
    // 与原生 watchdog 都依赖渲染器持续上报存活，此通知必须在 show 之前完成。
    set_capture_session_active(&app, true);
    SCREENSHOT_OVERLAY_HEARTBEAT_SEEN.store(false, Ordering::SeqCst);
    SCREENSHOT_OVERLAY_HEARTBEAT_MS.store(now_ms(), Ordering::SeqCst);
    start_screenshot_overlay_watchdog(app.clone(), session);
    crate::hooks::mouse::set_screenshot_mode(true);
    // Cleanup may proceed once the session state is fully published.
    drop(session_lock);
    let toolbar_was_visible = app
        .get_webview_window("toolbar")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    if orb_was_visible {
        if let Some(w) = app.get_webview_window("orb") {
            let _ = w.hide();
        }
    }
    if toolbar_was_visible {
        if let Some(w) = app.get_webview_window("toolbar") {
            let _ = w.hide();
        }
    }
    if timer_was_visible {
        if let Some(w) = app.get_webview_window("time-overlay") {
            let _ = w.hide();
        }
    }
    if todo_was_visible {
        if let Some(w) = app.get_webview_window("todo-overlay") {
            let _ = w.hide();
        }
    }
    if let Some(win) = app.get_webview_window("palette") {
        let _ = win.hide();
    }

    // 等 DWM 合成一帧，确保 orb/toolbar/palette/时钟/待办已从屏幕消失再截屏缓存，
    // 否则缓存里会残留它们的像素
    std::thread::sleep(std::time::Duration::from_millis(20));
    if current_screenshot_session() != session {
        return Ok(());
    }

    // 在 overlay 显示前截取全屏纯净画面缓存：此时屏幕上无任何截图 UI，
    // capture_region/ocr_region 后续直接从缓存裁剪选区，不二次截屏，
    // 既避免选区框被截入底图，又无需 hide/show overlay 造成闪烁。
    let bounds = crate::screenshot::virtual_desktop_bounds();
    let (origin_x, origin_y, vd_w, vd_h) = match &bounds {
        Ok(b) => (b.origin_x, b.origin_y, b.width, b.height),
        Err(e) => {
            crate::utils::logger::log(
                "screenshot",
                &format!("virtual_desktop_bounds 失败: {}, 回退主屏", e),
            );
            #[cfg(target_os = "windows")]
            {
                use windows::Win32::Foundation::RECT;
                use windows::Win32::UI::WindowsAndMessaging::{
                    SystemParametersInfoW, SPI_GETWORKAREA, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
                };
                let mut rc = RECT::default();
                let ok = unsafe {
                    SystemParametersInfoW(
                        SPI_GETWORKAREA,
                        0,
                        Some(&mut rc as *mut _ as *mut std::ffi::c_void),
                        SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
                    )
                    .is_ok()
                };
                if ok {
                    (rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top)
                } else {
                    (0, 0, 0, 0)
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                (0, 0, 0, 0)
            }
        }
    };
    if vd_w <= 0 || vd_h <= 0 {
        cleanup_screenshot_session(&app);
        return Err(format!("invalid virtual desktop size: {}x{}", vd_w, vd_h));
    }
    if vd_w > 0 && vd_h > 0 {
        match crate::screenshot::capture_screen_region(origin_x, origin_y, vd_w as u32, vd_h as u32)
        {
            Ok(bgra) => {
                crate::utils::logger::log(
                    "screenshot",
                    &format!("全屏缓存截取成功: {}x{} ({}字节)", vd_w, vd_h, bgra.len()),
                );
                match cache.pixels.lock() {
                    Ok(mut guard) => {
                        *guard = Some(crate::screenshot::CachedScreen {
                            bgra,
                            width: vd_w as u32,
                            height: vd_h as u32,
                            origin_x,
                            origin_y,
                        });
                    }
                    Err(error) => {
                        cleanup_screenshot_session(&app);
                        return Err(error.to_string());
                    }
                }
                if current_screenshot_session() != session {
                    return Ok(());
                }
            }
            Err(e) => {
                crate::utils::logger::log("screenshot", &format!("全屏缓存截取失败: {}", e));
            }
        }
    } else {
        crate::utils::logger::log(
            "screenshot",
            &format!("虚拟桌面尺寸异常: {}x{}, 跳过缓存", vd_w, vd_h),
        );
    }
    if current_screenshot_session() != session {
        return Ok(());
    }

    // Keep the native window hidden until the renderer has mounted and sent a
    // heartbeat. A failed WebView load therefore ends in a native error dialog
    // instead of exposing the browser's generic "page failed to load" page.
    wait_for_screenshot_overlay_ready(&app, session)?;

    // 恢复 orb/toolbar/时钟/待办可见性状态：截图前为截纯净画面临时 hide 了它们，
    // 此处按原状态恢复。随后 overlay 全屏置顶会盖住它们，但退出截图（overlay.hide）后
    // 它们会按原状态正常显现，不会因截图模式而意外消失。
    if orb_was_visible {
        if let Some(w) = app.get_webview_window("orb") {
            let _ = w.show();
        }
    }
    if toolbar_was_visible {
        if let Some(w) = app.get_webview_window("toolbar") {
            let _ = w.show();
        }
    }
    if timer_was_visible {
        if let Some(w) = app.get_webview_window("time-overlay") {
            let _ = w.show();
        }
    }
    if todo_was_visible {
        if let Some(w) = app.get_webview_window("todo-overlay") {
            let _ = w.show();
        }
    }
    if current_screenshot_session() != session {
        return Ok(());
    }

    {
        // 覆盖整个虚拟桌面（含负坐标区域），支持多显示器
        let pos_r = overlay.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            origin_x, origin_y,
        )));
        let size_r = overlay.set_size(tauri::PhysicalSize::new(vd_w, vd_h));
        crate::utils::logger::log(
            "screenshot",
            &format!(
                "overlay set_position={:?} set_size={:?} (pos=({},{}) {}x{})",
                pos_r, size_r, origin_x, origin_y, vd_w, vd_h
            ),
        );
        if let Err(error) = pos_r {
            cleanup_screenshot_session(&app);
            return Err(error.to_string());
        }
        if let Err(error) = size_r {
            cleanup_screenshot_session(&app);
            return Err(error.to_string());
        }
        if current_screenshot_session() != session {
            return Ok(());
        }
        if let Err(e) = overlay.show() {
            crate::utils::logger::log("screenshot", &format!("ERROR overlay.show 失败: {}", e));
            cleanup_screenshot_session(&app);
            return Err(e.to_string());
        }
        if let Err(e) = overlay.set_focus() {
            crate::utils::logger::log(
                "screenshot",
                &format!("ERROR overlay.set_focus 失败: {}", e),
            );
            cleanup_screenshot_session(&app);
            return Err(e.to_string());
        }
        let vis = overlay.is_visible().unwrap_or(false);
        crate::utils::logger::log(
            "screenshot",
            &format!("overlay show+focus 完成，is_visible={}", vis),
        );
        // 透明窗口 show 后可能存在合成延迟，短等后再查一次
        std::thread::sleep(std::time::Duration::from_millis(50));
        let vis2 = overlay.is_visible().unwrap_or(false);
        crate::utils::logger::log(
            "screenshot",
            &format!("overlay 延迟50ms后 is_visible={}", vis2),
        );
        // 诊断：直接查 Win32 窗口 style/exstyle/rect
        #[cfg(target_os = "windows")]
        match overlay.hwnd() {
            Ok(hwnd) => {
                use windows::Win32::Foundation::RECT;
                use windows::Win32::UI::WindowsAndMessaging::{
                    GetWindowLongW, GetWindowRect, GWL_EXSTYLE, GWL_STYLE,
                };
                unsafe {
                    let style = GetWindowLongW(hwnd, GWL_STYLE);
                    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
                    let mut rc = RECT::default();
                    let _ = GetWindowRect(hwnd, &mut rc);
                    const WS_VISIBLE: i32 = 0x10000000;
                    const WS_EX_LAYERED: i32 = 0x00080000;
                    const WS_EX_NOREDIRECTIONBITMAP: i32 = 0x00200000;
                    crate::utils::logger::log("screenshot", &format!(
                        "Win32 hwnd={:p} style=0x{:X} WS_VISIBLE={} ex=0x{:X} LAYERED={} NOREDIR={} rect=({},{},{},{}) {}x{}",
                        hwnd.0, style, (style & WS_VISIBLE) != 0, ex,
                        (ex & WS_EX_LAYERED) != 0, (ex & WS_EX_NOREDIRECTIONBITMAP) != 0,
                        rc.left, rc.top, rc.right, rc.bottom,
                        rc.right - rc.left, rc.bottom - rc.top
                    ));
                }
            }
            Err(e) => {
                crate::utils::logger::log("screenshot", &format!("overlay.hwnd() 失败: {}", e));
            }
        }
    }
    Ok(())
}


/// 从全屏缓存裁剪选区 BGRA：缓存由 start_screenshot 在 overlay 显示前截取，
/// 不含任何截图 UI，故选区框不会被截入；且无需 hide/show overlay，无闪烁。
/// 缓存不可用时回退到实时截屏（罕见，仅在 start_screenshot 截屏失败时）。
fn capture_from_cache(
    app: &tauri::AppHandle,
    cache: &crate::screenshot::ScreenCache,
    left: i32,
    top: i32,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    let cached = {
        let guard = cache.pixels.lock().map_err(|e| e.to_string())?;
        guard.as_ref().map(|c| c.crop(left, top, width, height))
    };
    if let Some(result) = cached {
        result
    } else {
        crate::utils::logger::log(
            "screenshot",
            "全屏缓存为空，回退实时截屏",
        );
        capture_region_without_overlay(app, left, top, width, height)
    }
}


/// Capture a selected region while keeping the screenshot UI out of the frame.
/// This is the fallback used when the full-desktop cache was rejected or could
/// not be allocated. The overlay is restored on every path, including errors.
fn capture_region_without_overlay(
    app: &tauri::AppHandle,
    left: i32,
    top: i32,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    if !CAPTURE_SESSION_ACTIVE.load(Ordering::SeqCst) {
        return Err("截图会话已结束".to_string());
    }
    let _overlay_guard = SMART_SCREENSHOT_OVERLAY_LOCK
        .lock()
        .map_err(|_| "截图蒙层状态锁已损坏".to_string())?;
    // The session may have been cancelled while this request waited for the
    // overlay lock. Re-check after acquiring it so a stale live capture cannot
    // hide and then resurrect the overlay after cleanup has completed.
    if !CAPTURE_SESSION_ACTIVE.load(Ordering::SeqCst) {
        return Err("截图会话已结束".to_string());
    }
    let overlay = app.get_webview_window("screenshot-overlay");
    if let Some(window) = &overlay {
        window
            .hide()
            .map_err(|e| format!("隐藏截图蒙层失败: {e}"))?;
        std::thread::sleep(std::time::Duration::from_millis(12));
    }
    let capture_result = crate::screenshot::capture_screen_region(left, top, width, height);
    let restore_result = overlay.as_ref().map(|window| window.show());
    let restore_error = restore_result.and_then(Result::err);
    let result = match (capture_result, restore_error.as_ref()) {
        (Ok(_pixels), Some(error)) => Err(format!("恢复截图蒙层失败: {error}")),
        (Err(error), Some(restore_error)) => Err(format!(
            "实时截图失败: {error}; 恢复截图蒙层也失败: {restore_error}"
        )),
        (Err(error), None) => Err(error),
        (Ok(pixels), None) => Ok(pixels),
    };
    if let Some(error) = restore_error {
        drop(_overlay_guard);
        cleanup_screenshot_session(app);
        show_screenshot_native_error(format!("截图蒙层恢复失败，截图会话已退出: {error}"));
    }
    result
}


// ─── 系统监控 ───────────────────────────────────────────────────

/// 将物理坐标裁剪到该点所在显示器的工作区内，防止窗口在显示器布局/分辨率变化后跑到屏幕外。
/// 返回裁剪后的坐标。
#[cfg(target_os = "windows")]
pub fn clamp_position_to_workarea(x: i32, y: i32, win_w: i32, win_h: i32) -> (i32, i32) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    let mut x = x;
    let mut y = y;
    let pt = POINT { x, y };
    let monitor = unsafe { MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST) };
    let mut mi = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetMonitorInfoW(monitor, &mut mi) }.as_bool() {
        let rc = mi.rcWork;
        if x + win_w > rc.right {
            x = rc.right - win_w;
        }
        if y + win_h > rc.bottom {
            y = rc.bottom - win_h;
        }
        if x < rc.left {
            x = rc.left;
        }
        if y < rc.top {
            y = rc.top;
        }
    }
    (x, y)
}


#[cfg(not(target_os = "windows"))]
pub fn clamp_position_to_workarea(x: i32, y: i32, _win_w: i32, _win_h: i32) -> (i32, i32) {
    (x, y)
}


/// 计算浮球（orb）的默认位置：主屏工作区右下角（与启动时未记忆的回退定位一致）。
fn default_orb_position(win_w: i32, win_h: i32) -> Option<(i32, i32)> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::RECT;
        use windows::Win32::UI::WindowsAndMessaging::{
            SystemParametersInfoW, SPI_GETWORKAREA, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
        };
        let margin = 20.0f64;
        // SPI_GETWORKAREA 在 DPI-aware 进程下返回物理像素，与 PhysicalPosition 单位一致
        let mut rc = RECT::default();
        let ok = unsafe {
            SystemParametersInfoW(
                SPI_GETWORKAREA,
                0,
                Some(&mut rc as *mut _ as *mut std::ffi::c_void),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
            .is_ok()
        };
        if ok {
            let visual_size = 56.0 * (win_w as f64 / 96.0);
            let x = rc.right as f64 - (win_w as f64 + visual_size) / 2.0 - margin;
            let y = rc.bottom as f64 - (win_h as f64 + visual_size) / 2.0 - margin;
            return Some((x as i32, y as i32));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (win_w, win_h);
    }
    None
}


/// 计算悬浮窗的默认（未记忆）位置。
/// - orb：主屏工作区右下角
/// - monitor-overlay：跟随鼠标（偏移 8px，多显示器边界钳制）
/// - pomodoro-overlay：创建时默认的左上角 (100, 100)
/// - time-overlay / todo-overlay：创建时默认的左上角 (100, 100)
///
/// 其余未知窗口一律回退 (100, 100)。
fn default_window_position(window_id: &str, win_w: i32, win_h: i32) -> (i32, i32) {
    match window_id {
        "orb" => default_orb_position(win_w, win_h).unwrap_or((100, 100)),
        "monitor-overlay" => {
            if let Ok(cur) = crate::automation::get_mouse_position() {
                clamp_position_to_workarea(cur.x + 8, cur.y + 8, win_w, win_h)
            } else {
                (100, 100)
            }
        }
        _ => (100, 100),
    }
}


// ─── 便利贴 ────────────────────────────────────────────────────

/// 通知管理窗刷新列表（便签窗口不订阅，避免自己打字被刷新打断）。
fn notify_sticky_notes_changed(app: &tauri::AppHandle) {
    let _ = app.emit_to(
        "sticky-notes-manager",
        "sticky-notes-changed",
        serde_json::json!({}),
    );
}


/// 新建便签默认落点：主屏工作区左上偏内的级联位置，避免多张完全重叠。
/// 传入 x/y 时由调用方决定，show 阶段还会统一裁剪到工作区内。
fn default_sticky_note_position(count: usize) -> (i32, i32) {
    let col = (count % 12) as i32;
    let row = (count / 12) as i32;
    (140 + col * 30, 120 + row * 34)
}


// ─── 录屏 ────────────────────────────────────────────────────────

/// 进入录屏选区模式：显示 overlay 并通知前端切换到录制模式
pub fn start_recording_select_inner(app: tauri::AppHandle) -> Result<(), String> {
    crate::utils::logger::log("recording", "start_recording_select called");
    let _lifecycle = RECORDING_SELECT_LIFECYCLE_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let recording_session = RECORDING_SELECT_SESSION.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    let startup_current = || {
        RECORDING_SELECT_SESSION.load(Ordering::SeqCst) == recording_session
            && CAPTURE_SESSION_ACTIVE.load(Ordering::SeqCst)
            && crate::hooks::mouse::is_recording_mode()
    };

    if app
        .try_state::<crate::scroll_capture::LongCaptureState>()
        .map(|state| state.is_active())
        .unwrap_or(false)
    {
        return Err("长截图进行中，请先完成或取消".into());
    }

    // 如果已经在录制中，热键触发时停止录制（toggle 行为）
    if crate::hooks::mouse::is_recording_mode() {
        let state = app.state::<crate::recording::RecordingState>();
        if state.is_running() && state.can_stop_from_hotkey() {
            crate::utils::logger::log("recording", "recording in progress, stopping via hotkey");
            // stop 后清理录制模式状态（与 stop_recording 命令一致）
            // 不恢复 orb——编码/预览期间 overlay 仍需显示
            state.stop()?;
            crate::hooks::mouse::set_recording_mode(false);
            finish_recording_controls(app.clone())?;
            return Ok(());
        }
        if state.is_running() {
            crate::utils::logger::log(
                "recording",
                "ignoring repeated recording hotkey immediately after start",
            );
            return Ok(());
        }
        // 录制模式但未在录制中（可能在选区阶段），忽略重复触发
        crate::utils::logger::log("recording", "recording mode already active, ignoring");
        return Ok(());
    }

    // 如果截图模式正在进行，先清理截图状态（不恢复 orb，因为马上又要隐藏）
    if crate::hooks::mouse::is_screenshot_mode() {
        crate::utils::logger::log(
            "recording",
            "screenshot mode active, cleaning up before recording",
        );
        crate::hooks::mouse::set_screenshot_mode(false);
        if let Some(cache) = app.try_state::<crate::screenshot::ScreenCache>() {
            if let Ok(mut guard) = cache.pixels.lock() {
                *guard = None;
            }
        }
        // 递增 session 使截图工具的异步回调失效
        SCREENSHOT_SESSION.fetch_add(1, Ordering::SeqCst);
    }

    // 复用截图 overlay 进入选区模式
    // 记录会话前 orb 可见性 + 会话活跃标记，再置 recording_mode，
    // 供取消选区时按原状态恢复，不强制弹出托盘已隐藏的 orb。
    // 若会话已活跃（截图→录屏转换、或录制预览后重新选区），保留首次进入时的
    // 会话前 orb 可见性：此时 orb 可能仍被本会话隐藏（如预览阶段），直接读 is_visible()
    // 会把它误记为「托盘隐藏」，导致会话结束后不恢复。
    if !CAPTURE_SESSION_ACTIVE.load(Ordering::SeqCst) {
        ORB_VISIBLE_BEFORE_SESSION.store(
            app.get_webview_window("orb")
                .map(|w| w.is_visible().unwrap_or(false))
                .unwrap_or(false),
            Ordering::SeqCst,
        );
        TIMER_VISIBLE_BEFORE_SESSION.store(
            app.get_webview_window("time-overlay")
                .map(|w| w.is_visible().unwrap_or(false))
                .unwrap_or(false),
            Ordering::SeqCst,
        );
        TODO_VISIBLE_BEFORE_SESSION.store(
            app.get_webview_window("todo-overlay")
                .map(|w| w.is_visible().unwrap_or(false))
                .unwrap_or(false),
            Ordering::SeqCst,
        );
        // 录制选区会话激活，通知 overlay 启动周期心跳
        set_capture_session_active(&app, true);
    }
    crate::hooks::mouse::set_recording_mode(true);

    if !startup_current() {
        return Ok(());
    }

    // 隐藏浮动 UI，避免被截入
    if let Some(w) = app.get_webview_window("orb") {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window("toolbar") {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window("time-overlay") {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window("todo-overlay") {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window("palette") {
        let _ = w.hide();
    }

    // 等一帧让 UI 消失
    std::thread::sleep(std::time::Duration::from_millis(20));

    if !startup_current() {
        return Ok(());
    }

    let overlay = match app.get_webview_window("screenshot-overlay") {
        Some(window) => window,
        None => {
            let _ = cancel_recording_select_inner(app.clone());
            return Err("recording overlay window was not found".to_string());
        }
    };
    if let Err(error) = overlay.set_ignore_cursor_events(false) {
        let _ = cancel_recording_select_inner(app.clone());
        return Err(error.to_string());
    }

    if !startup_current() {
        return Ok(());
    }

    // 等待底层 HWND 就绪
    // ensureScreenshotWindow 的 tauri://created 事件触发时，窗口逻辑对象已创建，
    // 但 Win32 HWND 可能尚未就绪，show/set_focus 会 no-op。
    let mut hwnd_ready = false;
    for _ in 0..100 {
        match overlay.hwnd() {
            Ok(_) => {
                hwnd_ready = true;
                break;
            }
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
    if !hwnd_ready {
        crate::utils::logger::log(
            "recording",
            "ERROR: overlay hwnd 5秒内未就绪，录制遮罩可能无法显示",
        );
        let _ = cancel_recording_select_inner(app.clone());
        return Err("recording overlay HWND did not become ready".to_string());
    }
    if !startup_current() {
        return Ok(());
    }

    let bounds = match crate::screenshot::virtual_desktop_bounds() {
        Ok(bounds) => bounds,
        Err(error) => {
            let _ = cancel_recording_select_inner(app.clone());
            return Err(error);
        }
    };
    if let Err(error) = overlay.set_position(tauri::Position::Physical(
        tauri::PhysicalPosition::new(bounds.origin_x, bounds.origin_y),
    )) {
        let _ = cancel_recording_select_inner(app.clone());
        return Err(error.to_string());
    }
    if let Err(error) = overlay.set_size(tauri::PhysicalSize::new(bounds.width, bounds.height)) {
        let _ = cancel_recording_select_inner(app.clone());
        return Err(error.to_string());
    }
    if let Err(error) = overlay.show() {
        let _ = cancel_recording_select_inner(app.clone());
        return Err(error.to_string());
    }
    if let Err(error) = overlay.set_focus() {
        let _ = cancel_recording_select_inner(app.clone());
        return Err(error.to_string());
    }

    if !startup_current() {
        return Ok(());
    }

    // 注册 overlay 关闭事件拦截（防止用户 Alt+F4 关闭 overlay 导致状态残留）
    // 关闭处理器需感知当前模式：录制模式下清理录制状态，截图模式下清理截图状态
    if SCREENSHOT_CLOSE_HANDLER_REGISTERED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let app_on_close = app.clone();
        overlay.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if crate::hooks::mouse::is_recording_mode() {
                    if let Some(state) =
                        app_on_close.try_state::<crate::recording::RecordingState>()
                    {
                        let _ = state.cancel();
                    }
                    let _ = cancel_recording_select(app_on_close.clone());
                } else {
                    // 截图模式：原有清理逻辑
                    cleanup_screenshot_session(&app_on_close);
                }
            }
            // 窗口被前端销毁重建时复位注册标记，确保新窗口重新注册关闭拦截
            //（与 start_screenshot_inner 中相同，见其注释）
            tauri::WindowEvent::Destroyed => {
                SCREENSHOT_CLOSE_HANDLER_REGISTERED.store(false, Ordering::SeqCst);
            }
            _ => {}
        });
    }

    // 通知 screenshot-overlay 前端切换到录制模式
    // 1. 立即发出 recording-select-switch 事件，让 OverlaySwitcher 马上切换到 RecordingTool，
    //    避免截图模式下 ScreenshotTool 仍能响应用户交互（Esc、失焦等）导致竞态
    // 2. 延迟发出 recording-select-start 事件，等前端 React 组件加载完毕后开始交互
    let app_switch = app.clone();
    if !startup_current() {
        return Ok(());
    }
    let _ = app_switch.emit_to("screenshot-overlay", "recording-select-switch", ());

    let app_emit = app.clone();
    std::thread::spawn(move || {
        // 等待前端加载完毕
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _lifecycle = RECORDING_SELECT_LIFECYCLE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if RECORDING_SELECT_SESSION.load(Ordering::SeqCst) == recording_session
            && CAPTURE_SESSION_ACTIVE.load(Ordering::SeqCst)
            && crate::hooks::mouse::is_recording_mode()
        {
            let _ = app_emit.emit_to("screenshot-overlay", "recording-select-start", ());
        }
    });

    Ok(())
}


fn destroy_recording_controls_window(app: &tauri::AppHandle) {
    if let Some(controls) = app.get_webview_window("recording-controls") {
        // WebView2 can leave a white composited surface after hide() on a
        // transparent child window. The controls are recreated for each recording.
        let _ = controls.destroy();
    }
}


fn set_recording_capture_protection(app: &tauri::AppHandle) {
    // The selection outline and mask sit outside the recorded region. Applying
    // WDA_EXCLUDEFROMCAPTURE to this transparent WebView2 window makes its
    // visible content disappear on some Windows versions, so keep it visible.
    if let Some(overlay) = app.get_webview_window("screenshot-overlay") {
        if let Ok(hwnd) = overlay.hwnd() {
            unsafe {
                let _ = SetWindowDisplayAffinity(hwnd, WDA_NONE);
            }
        }
    }
    // Transparent WebView2 windows disappear from the desktop on some Windows
    // versions when WDA_EXCLUDEFROMCAPTURE is applied. Keep the controls visible.
    if let Some(controls) = app.get_webview_window("recording-controls") {
        if let Ok(hwnd) = controls.hwnd() {
            unsafe {
                let _ = SetWindowDisplayAffinity(hwnd, WDA_NONE);
            }
        }
    }
}


/// 弹出文件保存对话框保存 GIF
async fn save_gif_with_dialog(
    app: &tauri::AppHandle,
    bytes: &[u8],
    filename: &str,
) -> Result<bool, String> {
    let mut dialog = rfd::FileDialog::new()
        .set_file_name(filename)
        .add_filter("GIF 动图", &["gif"]);
    if let Some(overlay) = app.get_webview_window("screenshot-overlay") {
        dialog = dialog.set_parent(&overlay);
    }
    let bytes = bytes.to_vec();
    tokio::task::spawn_blocking(move || match dialog.save_file() {
        Some(path) => {
            std::fs::write(&path, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;
            Ok(true)
        }
        None => Ok(false),
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}


async fn save_video_file_with_dialog(
    app: &tauri::AppHandle,
    source: &std::path::Path,
    filename: &str,
) -> Result<bool, String> {
    let mut dialog = rfd::FileDialog::new()
        .set_file_name(filename)
        .add_filter("MP4 视频", &["mp4"]);
    if let Some(overlay) = app.get_webview_window("screenshot-overlay") {
        dialog = dialog.set_parent(&overlay);
    }
    let source = source.to_path_buf();
    tokio::task::spawn_blocking(move || match dialog.save_file() {
        Some(path) => {
            std::fs::copy(&source, &path).map_err(|e| format!("写入文件失败: {}", e))?;
            Ok(true)
        }
        None => Ok(false),
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}


fn cancel_recording_select_inner(app: tauri::AppHandle) -> Result<(), String> {
    RECORDING_SELECT_SESSION.fetch_add(1, Ordering::SeqCst);
    // 仅会话进行中被隐藏的 orb 才按会话前状态恢复，避免把用户经托盘已隐藏的 orb
    // 强制弹出（托盘「显示/隐藏浮球」与清理逻辑相互矛盾）。
    // 用会话活跃标记覆盖整个会话生命周期（含录制编码/预览阶段 recording_mode 已被清除
    // 但仍属会话延长状态，此时清理也应恢复 orb）；空闲清理（如仅关闭工具开关）不动 orb。
    let session_active = CAPTURE_SESSION_ACTIVE.load(Ordering::SeqCst);
    crate::hooks::mouse::set_recording_mode(false);
    let _ = finish_recording_controls(app.clone());
    // 清理可能残留的 ScreenCache（录制模式启动时可能清空了但未恢复）
    if let Some(cache) = app.try_state::<crate::screenshot::ScreenCache>() {
        if let Ok(mut guard) = cache.pixels.lock() {
            *guard = None;
        }
    }
    if let Some(overlay) = app.get_webview_window("screenshot-overlay") {
        let _ = overlay.hide();
    }
    if session_active && ORB_VISIBLE_BEFORE_SESSION.load(Ordering::SeqCst) {
        if let Some(orb) = app.get_webview_window("orb") {
            let _ = orb.show();
            let _ = orb.set_always_on_top(true);
        }
    }
    // 恢复会话前可见的时钟/待办悬浮窗（与截图会话清理保持一致）
    if session_active {
        if TIMER_VISIBLE_BEFORE_SESSION.swap(false, Ordering::SeqCst) {
            if let Some(timer) = app.get_webview_window("time-overlay") {
                let _ = timer.show();
            }
        }
        if TODO_VISIBLE_BEFORE_SESSION.swap(false, Ordering::SeqCst) {
            if let Some(todo) = app.get_webview_window("todo-overlay") {
                let _ = todo.show();
            }
        }
    }
    // 会话结束，复位活跃标记，避免泄漏到后续空闲清理误判；
    // 同时通知 overlay 渲染进程停止周期心跳
    set_capture_session_active(&app, false);
    // 通知前端恢复截图模式
    let _ = app.emit_to("screenshot-overlay", "recording-select-cancel", ());
    Ok(())
}


fn configure_long_capture_frame(frame: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = frame.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        // Do not use WDA_EXCLUDEFROMCAPTURE here: on some transparent WebView2
        // builds it hides the entire frame instead of only excluding pixels.
        let _ = SetWindowDisplayAffinity(hwnd, WDA_NONE);
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let transparent = (WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW).0 as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, current | transparent);
    }
    Ok(())
}


/// 根据当前配置同步触发键与触发模式到 keyboard hook。
/// 触发键：启用且键有效时设置 vk_code，否则置 0。
/// 触发模式：无论是否启用都同步（切换模式时生效），便于运行时临时切换。
fn sync_quick_input_trigger(config: &ConfigManager) -> Result<(), String> {
    let enabled = config.get_quick_input_enabled()?;
    let key = config.get_quick_input_trigger_key()?;
    let key = if key.is_empty() { "CapsLock" } else { &key };
    let vk = if enabled {
        crate::quick_input::parse_trigger_key(key).unwrap_or(0)
    } else {
        0
    };
    crate::quick_input::set_trigger_vk(vk);
    // 同步触发模式：仅有效值才应用，非法值回退「单击切换」
    let mode = config.get_quick_input_mode()?;
    let mode_code = if mode == "hold" {
        crate::quick_input::MODE_HOLD
    } else {
        crate::quick_input::MODE_CLICK
    };
    crate::quick_input::set_mode(mode_code);
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    /// 「恢复默认位置」时，时钟/待办窗口与番茄钟一致回退到创建默认 (100, 100)，
    /// 与前端 ensureTimerWindow/ensureTodoWindow 的 x/y 初始值保持一致。
    #[test]
    fn test_default_window_position_time_and_todo() {
        assert_eq!(default_window_position("time-overlay", 380, 220), (100, 100));
        assert_eq!(default_window_position("todo-overlay", 360, 560), (100, 100));
    }

    /// 未知窗口 id 一律回退 (100, 100)。
    #[test]
    fn test_default_window_position_unknown_fallback() {
        assert_eq!(default_window_position("unknown-window", 100, 100), (100, 100));
    }

    /// 日志脱敏：仅保留 scheme 与 host，路径、查询串、fragment 全部丢弃。
    #[test]
    fn test_redact_url_for_log_drops_path_and_query() {
        assert_eq!(
            redact_url_for_log("https://www.bing.com/search?q=secret+query#frag"),
            "https://www.bing.com"
        );
        assert_eq!(
            redact_url_for_log("http://example.com/"),
            "http://example.com"
        );
        assert_eq!(
            redact_url_for_log("mailto:someone@example.com"),
            "<redacted>"
        );
        assert_eq!(redact_url_for_log("https://"), "https://<redacted>");
    }

    /// 日志脱敏：URL 内嵌的 userinfo（user:password@host）不得出现在日志中。
    #[test]
    fn test_redact_url_for_log_strips_userinfo() {
        assert_eq!(
            redact_url_for_log("https://alice:s3cr3t@example.com/private?token=abc"),
            "https://example.com"
        );
        assert_eq!(
            redact_url_for_log("https://user@example.com/path"),
            "https://example.com"
        );
    }
}
