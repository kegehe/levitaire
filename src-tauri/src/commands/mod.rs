use std::collections::HashMap;

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};

use std::sync::{Mutex, OnceLock};

use tauri::Emitter;

use tauri::Manager;

use tauri::State;

use windows::Win32::Foundation::{HWND, POINT};

use windows::Win32::UI::WindowsAndMessaging::{

    GetAncestor, GetClassNameW, GetCursorPos, GetForegroundWindow, GetWindowLongPtrW, GetWindowTextW,
    IsWindow, SetForegroundWindow, SetWindowDisplayAffinity, SetWindowLongPtrW, WindowFromPoint,
    GA_ROOT, GWL_EXSTYLE, WDA_NONE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
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
mod disk_cleanup;

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
pub use disk_cleanup::*;


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


/// 位置记忆抑制：本次「窗口位置落盘」是否应当被忽略。
///
/// # 这是「写—读」两端契约的**消费端**，所有把窗口位置写进配置的命令都必须过这里
///
/// 写入端（`clamp_window_to_workarea` 的夹取、`reset_window_position` 的复位）做的是
/// **程序性**移动，而 `WebviewWindow::onMoved` 对程序性移动同样触发 ⇒ 前端在几百毫秒后
/// 会把这个「被挤过 / 被复位过」的位置回写。不忽略，它就会被永久记住：内容缩回后窗口
/// 不回落，反复几次累积成肉眼可见的位置漂移。
///
/// ⚠️ 只在一处挂抑制、消费端却不读，抑制就是**死代码** —— 便利贴曾因此漂移许久：
/// 它的位置不走 `set_window_position`，而走自己的 `set_sticky_note_position`。
/// 新增任何位置落盘入口时，先来这里接上，并同步
/// `tests::every_position_persisting_command_consults_the_suppression` 里的 EXPECTED 清单。
///
/// 读取时顺手淘汰过期项：键含动态 label（`sticky-note-<id>`），只写不删会让这张表
/// 随「便签创建/删除次数」无界增长。
pub(crate) fn position_save_is_suppressed(id: &str) -> bool {
    let Ok(mut suppress) = position_save_suppress().lock() else {
        // 锁中毒按「不抑制」处理：宁可多记一次位置，也不能让位置记忆永久失灵
        return false;
    };
    let now = now_ms();
    suppress.retain(|_, until| *until > now);
    suppress.contains_key(id)
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


/// 该工具此刻是否仍处于启用状态（用于判断会话清理能否按「会话前可见」恢复浮窗）。
///
/// 用户可能在截图/录屏/长截图会话进行中通过 palette 关掉某个工具（「全部关闭」会逐个
/// 下发 `set_*_enabled(false)`），此时不该再把它按会话前状态恢复出来。
///
/// 读不到配置、读取出错、或遇到未登记的工具名时都按**恢复**处理：恢复只是回到会话前的
/// 状态，属于既有行为；反倒是「不恢复」会让用户看到浮窗凭空消失这种静默回归。
fn tool_still_enabled(app: &tauri::AppHandle, tool: &str) -> bool {
    let Some(config) = app.try_state::<ConfigManager>() else {
        return true;
    };
    let enabled = match tool {
        "timer" => config.get_timer_enabled(),
        "todo" => config.get_todo_enabled(),
        "sketch" => config.get_sketch_enabled(),
        "text-toolbar" => config.get_text_toolbar_enabled(),
        _ => return true,
    };
    enabled.unwrap_or(true)
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
    // 但工具已被用户关掉时不再恢复（标记无条件消费，避免残留到下一次清理误判）。
    if session_active {
        if TIMER_VISIBLE_BEFORE_SESSION.swap(false, Ordering::SeqCst)
            && tool_still_enabled(app, "timer")
        {
            if let Some(timer) = app.get_webview_window("time-overlay") {
                let _ = timer.show();
            }
        }
        if TODO_VISIBLE_BEFORE_SESSION.swap(false, Ordering::SeqCst)
            && tool_still_enabled(app, "todo")
        {
            if let Some(todo) = app.get_webview_window("todo-overlay") {
                let _ = todo.show();
            }
        }
    }
    if TOOLBAR_VISIBLE_BEFORE_LONG_CAPTURE.swap(false, Ordering::SeqCst)
        && tool_still_enabled(app, "text-toolbar")
    {
        if let Some(toolbar) = app.get_webview_window("toolbar") {
            let _ = toolbar.show();
        }
    }
    if SKETCH_VISIBLE_BEFORE_SESSION.swap(false, Ordering::SeqCst)
        && tool_still_enabled(app, "sketch")
    {
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


/// 自有窗口 label 清单。两处共用同一份，避免「判定自己的窗口」与「文件对话框 owner
/// 候选」两张清单各自漂移。
///
/// 两处用途都对**完整性**敏感，漏一个就出问题：
/// - `is_own_window`：用于判断前台窗口是不是自己（截图/录屏要穿透到下层应用）；
/// - `DialogTopmostGuard::suspend`：要取消**所有可见自有置顶窗**的置顶，漏掉的那扇
///   正好压在文件对话框上时，用户就看不到对话框（本清单漏过 `sticky-notes-manager`
///   与 `scroll-navigator-overlay`，两者都是 `alwaysOnTop: true`）。
/// - `own_window_root_hwnds`：录屏「窗口识别」列表要按 HWND 排除自己。
///
/// 注：便利贴是动态 label（`sticky-note-<id>`），不在本清单内；它们不会作为对话框
/// owner（草稿/待办/长截图/钉图四条路径都用固定 label 的窗口），录屏列表那条另有
/// 标题前缀兜底（`Levitaire 便利贴`）。新增固定 label 的浮窗时**必须**补进本清单。
pub const OWN_WINDOW_LABELS: &[&str] = &[
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
    "quick-input-overlay",
    "time-overlay",
    "todo-overlay",
    "sketch-overlay",
    "utility-hub-overlay",
    "scroll-navigator-overlay",
    "sticky-notes-manager",
    "system-cleaner-overlay",
];


/// 某个 HWND 是否属于 Levitaire 自己的窗口（**唯一权威实现**）。
///
/// 判定必须**三类都覆盖**，缺一类就会漏 —— 三类都踩过：
/// 1. `OWN_WINDOW_LABELS` 里的固定 label webview 窗口；
/// 2. **非 webview 的原生窗**：贴图窗是 `CreateWindowExW` 建的 Win32 窗（类名
///    `LevitairePinWindow`），`get_webview_window()` 根本找不到它；
/// 3. **动态 label 的 webview 窗**：便利贴是 `sticky-note-<id>`，不在清单里，但标题
///    统一以 `Levitaire` 开头 —— 用标题前缀兜底（与 `recording::window_detect::
///    enumerate_windows` 的排除口径保持一致，两处不能各拿一套）。
///
/// 调用方（都要求「自家窗不算外部窗」）：
/// - `start_screenshot_inner` 取「用户的前台应用」作为长截图的恢复目标时；
/// - 滚动导航的 `is_usable_target` —— 漏判的后果是用户点一下自己的贴图或便利贴，
///   目标就被永久粘成自家窗口，之后面板每个按钮都**静默失效**（不报错、不位移）。
///
/// ⚠️ 不要再在别处复制一份 label 清单（`scroll_navigation.rs` 曾经自带 19 项副本，
/// 少了 `sticky-notes-manager`）。守卫 `own_window_detection_is_single_sourced`。
pub fn is_own_window(app: &tauri::AppHandle, hwnd: HWND) -> bool {
    if hwnd.0.is_null() {
        return false;
    }
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    let root = if root.0.is_null() { hwnd } else { root };

    // ③ 标题前缀：覆盖动态 label 的 webview 窗（便利贴）与任何自有原生窗。
    if window_text_starts_with(root, "Levitaire") {
        return true;
    }
    // ② 贴图窗：用户可同时贴多张、标题不可靠，按**窗口类名**判定。
    if window_class_equals(root, "LevitairePinWindow") {
        return true;
    }
    // ① 固定 label 的 webview 窗口。
    OWN_WINDOW_LABELS
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


/// 桌面 / 任务栏等 shell 窗口从来不是可用目标。
///
/// 选中它们只会让调用方进入「按钮都正常、点了没反应」的状态，而这还是**持久**的：
/// 用户随手点一下桌面（用来收起面板之类）就会踩到。
pub fn is_shell_window(hwnd: HWND) -> bool {
    let mut buffer = [0u16; 64];
    let length = unsafe { GetClassNameW(hwnd, &mut buffer) };
    if length <= 0 {
        return false;
    }
    matches!(
        String::from_utf16_lossy(&buffer[..length as usize]).as_str(),
        "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
    )
}


/// 能当作「外部目标窗口」的窗口：存在 + 不属于 Levitaire 自己 + 不是桌面/任务栏。
///
/// 调用方：滚动导航的目标绑定、通用工具·窗口置顶的点选与清理。两处必须同口径 ——
/// 曾各自持有一份实现，其中一份漏了动态 label 的便利贴，用户点一下自己的窗口就把
/// 目标永久粘成了自家窗口。
pub fn is_usable_target(app: &tauri::AppHandle, hwnd: HWND) -> bool {
    !hwnd.is_invalid()
        && unsafe { IsWindow(Some(hwnd)).as_bool() }
        && !is_own_window(app, hwnd)
        && !is_shell_window(hwnd)
}


/// 窗口标题是否以给定前缀开头（无标题返回 false）。
fn window_text_starts_with(hwnd: HWND, prefix: &str) -> bool {
    let mut buffer = [0u16; 512];
    let length = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    if length <= 0 {
        return false;
    }
    String::from_utf16_lossy(&buffer[..length as usize]).starts_with(prefix)
}


/// 窗口类名是否**完全等于**给定值。
fn window_class_equals(hwnd: HWND, class_name: &str) -> bool {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetClassNameW(hwnd, &mut buffer) };
    if length <= 0 {
        return false;
    }
    String::from_utf16_lossy(&buffer[..length as usize]) == class_name
}


/// 当前自有窗口的根 HWND（用于把「自己的窗口」排除出录屏的窗口识别列表）。
///
/// 便利贴不在 `OWN_WINDOW_LABELS` 里（动态 label），它们的标题统一以 `Levitaire`
/// 开头，调用侧另有标题前缀兜底 —— 两条合起来才不会漏（`pin-ocr` 的标题是
/// `Pin OCR`，只靠标题前缀就会漏，这正是本函数的用途）。
pub fn own_window_root_hwnds(app: &tauri::AppHandle) -> Vec<isize> {
    OWN_WINDOW_LABELS
        .iter()
        .filter_map(|label| app.get_webview_window(label))
        .filter_map(|window| window.hwnd().ok())
        .map(|hwnd| {
            let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
            if root.0.is_null() {
                hwnd.0 as isize
            } else {
                root.0 as isize
            }
        })
        .collect()
}


/// 隐藏文字工具栏，并把**后端侧**的工具栏状态一并复位（所有非前端主动关闭的路径都要走它）。
///
/// 只调 `window.hide()` 会漏掉 `qrcode_preview` 标志：该标志为 true 时鼠标钩子会忽略
/// 「点击工具栏外部」这一路径（`mouse.rs` 里显式 continue），于是下次工具栏再弹出时
/// **点外部关不掉**，只能按 Esc。同时这里补发 `toolbar-hidden`，让前端把 QR 预览态
/// 一并复位（否则窗口隐藏后 React 仍停在预览态，重新弹出时会带着旧面板）。
pub fn hide_toolbar_and_reset_state(app: &tauri::AppHandle) {
    crate::hooks::mouse::set_qrcode_preview(false);
    if let Some(toolbar) = app.get_webview_window("toolbar") {
        let _ = toolbar.hide();
    }
    crate::hooks::set_toolbar_visible(false);
    let _ = app.emit("toolbar-hidden", ());
}


/// 打开原生文件对话框期间的置顶守卫（`Drop` 时自动恢复）。
///
/// **为什么必须有它**：本项目的浮窗几乎都是 `alwaysOnTop`，而 rfd 在没有
/// `set_parent` 时给 `IFileDialog::Show` 传的是 NULL owner
/// （rfd 源码：`parent.unwrap_or(std::ptr::null_mut())`）。实测（Z 序 + 像素采样）：
/// 置顶窗会把**无主**的对话框完全盖住，且把它设为前台窗口也抬不上来
/// ⇒ 用户点「保存」后看不到任何反应。反过来，把 owner 指向**当时可见的自有置顶窗**
/// 时对话框会显示在该 owner 之上；但若挡住它的其实是另一扇（前台）置顶窗，
/// 光设 owner 仍然不够 ⇒ 所以这里同时**临时取消所有可见自有窗的置顶**。
///
/// 「所有可见自有窗」有**三类**，缺一类都会漏（三类都踩过）：
/// 1. `OWN_WINDOW_LABELS` 里的固定 label webview 窗；
/// 2. 便利贴（动态 label `sticky-note-<id>`，含 `alwaysOnTop`）；
/// 3. 贴图窗（原生 `WS_EX_TOPMOST`，不归 tao 管，只能自己 `SetWindowPos`）。
///
/// 用法（必须让 guard 活到对话框关闭之后）：
/// ```ignore
/// let guard = DialogTopmostGuard::suspend(&app, &["sketch-overlay", "screenshot-overlay"]);
/// let mut dialog = rfd::FileDialog::new();
/// if let Some(owner) = guard.owner() { dialog = dialog.set_parent(owner); }
/// let path = dialog.save_file();
/// drop(guard); // 恢复置顶（失败路径也要走到）
/// ```
pub struct DialogTopmostGuard {
    owner: Option<tauri::WebviewWindow>,
    suspended: Vec<tauri::WebviewWindow>,
    /// 被临时取消置顶的原生贴图窗（恢复时要逐个置顶回去）。
    suspended_pins: Vec<isize>,
}

impl DialogTopmostGuard {
    /// `preferred`：按优先级给出「本次流程自己那扇窗」的 label；命中第一个可见者作为
    /// owner，都没有就退回最后一扇可见自有窗。没有任何可见自有窗时 owner 为 None
    /// （此时没有自有窗遮挡，对话框照常可见）。
    pub fn suspend(app: &tauri::AppHandle, preferred: &[&str]) -> Self {
        // owner 仍是「固定 label 清单里的可见窗」—— 不便让便利贴当 owner（它是个小窗，
        // 位置随机），保持既有行为。
        let visible: Vec<tauri::WebviewWindow> = OWN_WINDOW_LABELS
            .iter()
            .filter_map(|label| app.get_webview_window(label))
            .filter(|window| window.is_visible().unwrap_or(false))
            .collect();
        let owner = preferred
            .iter()
            .find_map(|label| visible.iter().find(|window| window.label() == *label).cloned())
            .or_else(|| visible.last().cloned());

        // 取消置顶的范围要比 owner 候选**更宽**：便利贴（动态 label）与贴图窗（原生窗）
        // 都可能正好压在对话框上，而它们都不在固定 label 清单里。
        let note_labels: Vec<String> = app
            .try_state::<crate::sticky_note::NoteStore>()
            .and_then(|store| store.list().ok())
            .map(|notes| {
                notes
                    .iter()
                    .map(|note| crate::sticky_note::note_window_label(&note.id))
                    .collect()
            })
            .unwrap_or_default();

        let mut suspended = Vec::new();
        for window in visible.into_iter().chain(
            note_labels
                .iter()
                .filter_map(|label| app.get_webview_window(label)),
        ) {
            // 只动「当前确实是置顶」的窗口：恢复时无条件置顶会把本来就非置顶的窗口改坏。
            if window.is_visible().unwrap_or(false)
                && window.is_always_on_top().unwrap_or(false)
                && window.set_always_on_top(false).is_ok()
            {
                suspended.push(window);
            }
        }

        let suspended_pins = crate::screenshot::pin::topmost_pin_hwnds();
        crate::screenshot::pin::set_pins_topmost(&suspended_pins, false);

        Self {
            owner,
            suspended,
            suspended_pins,
        }
    }

    /// 供 `rfd::FileDialog::set_parent` 使用；None 表示没有合适的自有窗。
    pub fn owner(&self) -> Option<&tauri::WebviewWindow> {
        self.owner.as_ref()
    }
}

impl Drop for DialogTopmostGuard {
    fn drop(&mut self) {
        // 贴图窗先恢复（原生 SetWindowPos 是同步的），webview 窗的 `set_always_on_top`
        // 由 tao 异步投递，顺序对结果无影响。
        crate::screenshot::pin::set_pins_topmost(&self.suspended_pins, true);
        for window in &self.suspended {
            let _ = window.set_always_on_top(true);
        }
    }
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
        && !is_own_window(&app, foreground)
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
    //
    // 顺序要紧：先把心跳标记清零、再发激活通知。前端收到通知后会**立即**补报一次
    // 心跳（见 App.tsx 的 start()），若清零排在通知之后，那次补报可能被清零覆盖，
    // 又要白等一个 500ms 周期。
    SCREENSHOT_OVERLAY_HEARTBEAT_SEEN.store(false, Ordering::SeqCst);
    SCREENSHOT_OVERLAY_HEARTBEAT_MS.store(now_ms(), Ordering::SeqCst);
    set_capture_session_active(&app, true);
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
        // 统一入口：隐藏 + 复位后端侧状态（qrcode_preview 标志）＋通知前端复位预览态。
        // 只 `hide()` 会让标志残留，下次工具栏弹出后「点外部关不掉」，只能 Esc。
        hide_toolbar_and_reset_state(&app);
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
/// - time-overlay / todo-overlay：创建时默认的左上角 (100, 100)
/// - system-cleaner-overlay：创建时默认的 (120, 120)
///
/// 这里的取值必须与前端各 `ensure*Window` 里 `createToolWindow` 的 `x`/`y` 一致 ——
/// 否则「恢复默认位置」和「重建窗口」会落到两个不同的点（守卫
/// `tests::default_window_position_matches_frontend_creation`）。
/// ⚠️ 前端 `x`/`y` 是**逻辑**像素、这里回的是 `PhysicalPosition`，缩放 ≠1 时两者本就差
/// `(scale−1)×坐标`（既定取舍，另外几扇固定坐标窗同样如此）；本约定只锁「数值一致」。
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
        "system-cleaner-overlay" => (120, 120),
        _ => (100, 100),
    }
}


// ─── 便利贴 ────────────────────────────────────────────────────

/// 通知管理窗刷新列表（便签窗口不订阅，避免自己打字被刷新打断）。
pub fn notify_sticky_notes_changed(app: &tauri::AppHandle) {
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
    // 统一入口：隐藏 + 复位后端侧状态（qrcode_preview 残留会让下次弹出后点外部关不掉）
    hide_toolbar_and_reset_state(&app);
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
    // ⚠ 这里**只**处理这两扇 WebView2 窗，不要改成"遍历所有自有窗统一设 WDA_NONE"：
    // 全屏录制的原生指示层（`recording::indicator`）正是靠 WDA_EXCLUDEFROMCAPTURE
    // 才做到"用户看得见、成片里没有"，被改成 WDA_NONE 就会重新被 BitBlt 录进视频。
    //
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
    // 与 save_image 同理：仅 set_parent 不足以防止「另一扇前台置顶窗盖住对话框」，
    // 统一走 DialogTopmostGuard（取可见 overlay 作 owner + 临时取消自有置顶窗的置顶）。
    let guard = DialogTopmostGuard::suspend(app, &["screenshot-overlay"]);
    let mut dialog = rfd::FileDialog::new()
        .set_file_name(filename)
        .add_filter("GIF 动图", &["gif"]);
    if let Some(owner) = guard.owner() {
        dialog = dialog.set_parent(owner);
    }
    let bytes = bytes.to_vec();
    let result = tokio::task::spawn_blocking(move || match dialog.save_file() {
        Some(path) => {
            std::fs::write(&path, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;
            Ok(true)
        }
        None => Ok(false),
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?;
    drop(guard);
    result
}


async fn save_video_file_with_dialog(
    app: &tauri::AppHandle,
    source: &std::path::Path,
    filename: &str,
) -> Result<bool, String> {
    let guard = DialogTopmostGuard::suspend(app, &["screenshot-overlay"]);
    let mut dialog = rfd::FileDialog::new()
        .set_file_name(filename)
        .add_filter("MP4 视频", &["mp4"]);
    if let Some(owner) = guard.owner() {
        dialog = dialog.set_parent(owner);
    }
    let source = source.to_path_buf();
    let result = tokio::task::spawn_blocking(move || match dialog.save_file() {
        Some(path) => {
            std::fs::copy(&source, &path).map_err(|e| format!("写入文件失败: {}", e))?;
            Ok(true)
        }
        None => Ok(false),
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?;
    drop(guard);
    result
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
    // 恢复会话前可见的时钟/待办悬浮窗（与截图会话清理保持一致）。
    // 工具已被用户关掉（例如 palette 的「全部关闭」）时不再恢复——标记无条件消费。
    if session_active {
        if TIMER_VISIBLE_BEFORE_SESSION.swap(false, Ordering::SeqCst)
            && tool_still_enabled(&app, "timer")
        {
            if let Some(timer) = app.get_webview_window("time-overlay") {
                let _ = timer.show();
            }
        }
        if TODO_VISIBLE_BEFORE_SESSION.swap(false, Ordering::SeqCst)
            && tool_still_enabled(&app, "todo")
        {
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


/// 把快速输入的音效配置同步到运行时状态。
///
/// 三个入口（开关 / 风格 / 音量）任意一个变更都要走这里，否则运行时会用旧值播放：
/// 三者在后端被压成一个「开关 + 刻度音开关 + 音量」三元组，只更新其中一项会让
/// 另外两项停留在上次同步的值（例如刚打开音效又被上一次的静音风格覆盖）。
fn sync_quick_input_sound(config: &ConfigManager) {
    let enabled = config.get_quick_input_sound_enabled().unwrap_or(false);
    let style = config
        .get_quick_input_sound_style()
        .unwrap_or_else(|_| crate::config::SOUND_STYLE_STANDARD.to_string());
    let volume = config.get_quick_input_sound_volume().unwrap_or(45);
    crate::quick_input::set_sound_config(enabled, &style, volume);
}


#[cfg(test)]
mod tests {
    use super::*;

    /// 工具级开关的契约：`set_<tool>_enabled(false)` 必须收起自己的窗口。
    ///
    /// 这条契约既没有编译期保护、也没有运行时测试（需要 AppHandle），漏写的症状只有用户看得到：
    /// 「点了全部关闭，窗口还在」（通用工具就这么漏过一次）。这里直接扫描源码把它锁住。
    #[test]
    fn test_every_tool_toggle_closes_its_window_when_disabled() {
        const SOURCES: &[&str] = &[
            include_str!("tools.rs"),
            include_str!("screenshot.rs"),
            include_str!("sketch.rs"),
            include_str!("text.rs"),
            include_str!("monitor.rs"),
            include_str!("timer.rs"),
            include_str!("todo.rs"),
            include_str!("recording.rs"),
            include_str!("quick_input.rs"),
            include_str!("sticky.rs"),
            include_str!("disk_cleanup.rs"),
        ];
        // 收窗动作：隐藏窗口 / 销毁窗口 / 取消会话 / 收起转盘 / 关闭全部贴图 /
        // 走统一入口隐藏文字工具栏（内含 hide + 状态复位）。
        const CLOSING_ACTIONS: &[&str] = &[
            ".hide()",
            "hide_utility_hub",
            "hide_toolbar_and_reset_state",
            "destroy",
            ".cancel(",
            "end_wheel",
            "close_all_pins",
        ];
        // 与前端 registry 的 BACKEND_TOOLS 一一对应的工具级开关
        const TOGGLE_FNS: &[&str] = &[
            "set_sketch_enabled",
            "set_text_toolbar_enabled",
            "set_screenshot_enabled",
            "set_system_monitor_enabled",
            "set_timer_enabled",
            "set_todo_enabled",
            "set_recording_enabled",
            "set_quick_input_enabled",
            "set_sticky_notes_enabled",
            "set_utility_hub_enabled",
            "set_system_cleaner_enabled",
        ];
        for name in TOGGLE_FNS {
            let body = SOURCES
                .iter()
                .find_map(|source| extract_fn_body(source, name))
                .unwrap_or_else(|| {
                    panic!(
                        "{name} 未在上述 commands 模块中找到：函数被移动时请把新文件加进 SOURCES"
                    )
                });
            // 必须先剥掉整行注释：把收窗调用注释掉（而不是删掉）在文本层面看起来「还在」，
            // 那样这个守卫就形同虚设。
            let code = strip_line_comments(body);
            assert!(
                CLOSING_ACTIONS.iter().any(|action| code.contains(action)),
                "{name} 的禁用分支没有收起自己的窗口：palette 的「全部关闭」会关不掉它"
            );
        }
    }

    /// 契约：程序性夹取产生的位移不得被当成「用户摆的位置」写进位置记忆。
    ///
    /// 前端 `persistWindowPositionOnMove` 监听 `onMoved` —— **程序性移动同样会触发** ——
    /// 并在 300ms 后写回记忆。贴屏幕右/下沿的窗口在内容变高后被夹取上移，若那个被挤过的
    /// 位置被记住，内容缩回后窗口也不回落，几次之后就累积成肉眼可见的位置漂移。
    /// `reset_window_position` 早就为程序性移动挂了 1500ms 抑制，夹取这条路径必须同样挂上。
    #[test]
    fn clamp_window_suppresses_position_memory_writeback() {
        let body = extract_fn_body(include_str!("window.rs"), "clamp_window_to_workarea")
            .expect("clamp_window_to_workarea 不见了：本契约依赖它仍在 commands/window.rs");
        let code = strip_line_comments(body);
        let suppress = code
            .find("position_save_suppress()")
            .expect("夹取窗口必须为本次移动挂上位置记忆抑制（否则被挤过的位置会被永久记住）");
        let move_it = code
            .find(".set_position(")
            .expect("clamp_window_to_workarea 应当移动窗口");
        assert!(
            suppress < move_it,
            "抑制必须在 set_position 之前落好，否则这次移动仍会被前端写回记忆"
        );
    }

    /// 契约：位置记忆抑制的**消费端**必须覆盖所有位置落盘入口。
    ///
    /// 上一条守卫只证明了「夹取里**写了**抑制」。机制存在 + 消费端缺失 = 全绿 ——
    /// 便利贴就是这么漏掉的：它的位置不走 `set_window_position`，而走
    /// `set_sticky_note_position`，于是抑制对它完全是**死代码**：贴边便签内容变高被夹回后，
    /// 「被挤过的 y」仍被前端在 250ms 后写进 notes.json，内容缩回也不回落（便签自己往上爬）。
    ///
    /// 所以这里从反向锁住：`window.rs` / `sticky.rs` 里**每一个**名字含 `position` 的公开
    /// 命令，要么是抑制的消费端（`position_save_is_suppressed`），要么是抑制的写入端
    /// （`.insert(`）。数量也对齐 —— 新增位置落盘入口会立刻红，逼人来接上。
    ///
    /// 不含 `mod.rs`：它既是抑制机制的定义地，`clamp_position_to_workarea` 也只是纯计算、
    /// 不落盘，混进来只会让规则变糊。
    #[test]
    fn every_position_persisting_command_consults_the_suppression() {
        const SOURCES: &[(&str, &str)] = &[
            ("window.rs", include_str!("window.rs")),
            ("sticky.rs", include_str!("sticky.rs")),
        ];
        // (文件, 函数名, 角色)：consumer = 读抑制；writer = 写抑制（程序性移动的来源）
        const EXPECTED: &[(&str, &str, &str)] = &[
            ("window.rs", "set_window_position", "consumer"),
            ("window.rs", "reset_window_position", "writer"),
            ("sticky.rs", "set_sticky_note_position", "consumer"),
        ];

        let found: Vec<(&str, String)> = SOURCES
            .iter()
            .flat_map(|(file, source)| {
                position_command_names(source)
                    .into_iter()
                    .map(move |name| (*file, name))
            })
            .collect();

        let mut found_sorted: Vec<(&str, &str)> = found
            .iter()
            .map(|(file, name)| (*file, name.as_str()))
            .collect();
        found_sorted.sort_unstable();
        let mut expected_sorted: Vec<(&str, &str)> =
            EXPECTED.iter().map(|(file, name, _)| (*file, *name)).collect();
        expected_sorted.sort_unstable();
        assert_eq!(
            found_sorted, expected_sorted,
            "位置相关命令的清单变了。新增入口必须显式接上 `position_save_is_suppressed`\
             （键是**窗口 label**，便利贴要经 note_window_label 换算），并登记进本用例的 EXPECTED ——\
             否则它就是一个绕过位置记忆抑制的落盘口子，被夹取过的位置会被永久记住。"
        );

        for (file, name, role) in EXPECTED {
            let source = SOURCES
                .iter()
                .find(|(candidate, _)| candidate == file)
                .map(|(_, source)| *source)
                .expect("SOURCES 与 EXPECTED 的文件名不一致");
            let body = extract_fn_body(source, name)
                .unwrap_or_else(|| panic!("{file} 里找不到 {name}：函数被改名/移走时请同步本守卫"));
            let code = strip_line_comments(body);
            let token = if *role == "consumer" {
                "position_save_is_suppressed("
            } else {
                ".insert("
            };
            assert!(
                code.contains(token),
                "{file}::{name} 没有接入位置记忆抑制（期望角色 {role}，函数体里应出现 `{token}`）"
            );
        }
    }

    /// 扫描源码里所有名字含 `position` 的公开函数名（`pub fn` / `pub async fn` / `pub(crate) fn`）。
    fn position_command_names(source: &str) -> Vec<String> {
        let mut names = Vec::new();
        for (index, _) in source.match_indices("fn ") {
            let before = &source[..index];
            if !(before.ends_with("pub ")
                || before.ends_with("pub async ")
                || before.ends_with("pub(crate) "))
            {
                continue;
            }
            let name: String = source[index + "fn ".len()..]
                .chars()
                .take_while(|ch| ch.is_alphanumeric() || *ch == '_')
                .collect();
            if name.contains("position") {
                names.push(name);
            }
        }
        names
    }

    /// 取出 `fn <name>` 的函数体（按大括号配平），供上一条契约测试做源码扫描。
    fn extract_fn_body<'a>(source: &'a str, name: &str) -> Option<&'a str> {
        let start = source.find(&format!("fn {name}"))?;
        let open = source[start..].find('{')? + start;
        let mut depth = 0usize;
        for (offset, ch) in source[open..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(&source[open..open + offset]);
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// 剥掉整行注释，避免「注释掉的代码」被当成有效调用。
    /// 只在 `//` 之前全是空白时才判定为注释行——否则会误伤字符串里的 `https://`。
    fn strip_line_comments(source: &str) -> String {
        source
            .lines()
            .map(|line| match line.find("//") {
                Some(index) if line[..index].trim().is_empty() => "",
                _ => line,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 「恢复默认位置」时，时钟/待办窗口与番茄钟一致回退到创建默认 (100, 100)，
    /// 与前端 ensureTimerWindow/ensureTodoWindow 的 x/y 初始值保持一致。
    /// 系统清理面板回退到它自己的创建默认 (120, 120)。
    #[test]
    fn test_default_window_position_time_and_todo() {
        assert_eq!(default_window_position("time-overlay", 380, 220), (100, 100));
        assert_eq!(default_window_position("todo-overlay", 360, 560), (100, 100));
        assert_eq!(
            default_window_position("system-cleaner-overlay", 520, 640),
            (120, 120)
        );
    }

    /// 未知窗口 id 一律回退 (100, 100)。
    #[test]
    fn test_default_window_position_unknown_fallback() {
        assert_eq!(default_window_position("unknown-window", 100, 100), (100, 100));
    }

    /// 契约：「恢复默认位置」的窗口清单必须与前端 `WINDOW_POSITION_TARGETS` 逐项一致。
    ///
    /// 这是**静默失效**类缺陷：前端按自己的清单渲染按钮、逐个下发 `reset_window_position`，
    /// 后端只认真认识的那几个 id。两边一旦漂移，用户看到的是「按钮亮『已恢复』、
    /// 窗口纹丝不动」—— 系统清理就这么失效了很久，而且同排另外四个按钮都正常，极难察觉。
    /// 反方向的漂移同样糟：能记住位置的窗口（便利贴管理窗）没有入口，用户只能自己再拖回去。
    #[test]
    fn resettable_windows_match_frontend_targets() {
        let ts = strip_line_comments(include_str!("../../../src/components/Settings.tsx"));
        let start = ts
            .find("const WINDOW_POSITION_TARGETS = [")
            .expect("未找到 WINDOW_POSITION_TARGETS（改名/移动时请同步本守卫）");
        let rest = &ts[start..];
        let end = rest
            .find("] as const;")
            .expect("WINDOW_POSITION_TARGETS 未以 `] as const;` 结束");
        let block = &rest[..end];

        let mut frontend: Vec<&str> = Vec::new();
        let mut cursor = 0usize;
        while let Some(rel) = block[cursor..].find("{ id: \"") {
            let open = cursor + rel + "{ id: \"".len();
            let Some(close) = block[open..].find('"') else {
                break;
            };
            frontend.push(&block[open..open + close]);
            cursor = open + close + 1;
        }
        // 反向断言：解析面失效（改成单行写法、换成别的字段名）时不能静默通过。
        assert!(
            frontend.len() >= 6,
            "只从 WINDOW_POSITION_TARGETS 提取到 {} 项，守卫的解析面已失效",
            frontend.len()
        );

        let mut frontend_sorted = frontend.clone();
        frontend_sorted.sort_unstable();
        frontend_sorted.dedup();
        // 同一 id 写两遍时上面那次 dedup 会让两边仍然相等，这里显式挡掉。
        assert_eq!(
            frontend_sorted.len(),
            frontend.len(),
            "WINDOW_POSITION_TARGETS 里有重复的窗口 id：{frontend:?}"
        );

        let mut backend = crate::commands::window::RESETTABLE_WINDOW_IDS.to_vec();
        backend.sort_unstable();
        assert_eq!(
            frontend_sorted, backend,
            "前端「恢复默认位置」清单与后端 RESETTABLE_WINDOW_IDS 不一致：\
             前端多出来的 id 会「已恢复」却纹丝不动，后端多出来的窗口则没有入口。\
             两边同时补，并在 default_window_position 里给出它的默认定位。"
        );
    }

    /// 契约：「恢复默认位置」的落点必须与前端创建窗口时的默认坐标一致。
    ///
    /// 同一件事（窗口的默认位置）存在两份独立常量：`default_window_position` 与
    /// `toolWindows.ts` 里 `createToolWindow` 的 `x`/`y`。漂移的后果是同一个按钮两种结果 ——
    /// 点「恢复默认位置」落到 A 点，窗口被销毁重建后落到 B 点，只能靠肉眼发现。
    #[test]
    fn default_window_position_matches_frontend_creation() {
        let ts = strip_line_comments(include_str!("../../../src/utils/toolWindows.ts"));
        // (窗口 label, 后端 default_window_position 的 x/y)。orb 与 monitor-overlay 不算在内：
        // 它们分别按工作区右下角 / 鼠标位置计算，本就是动态的。
        const CASES: &[(&str, i32, i32)] = &[
            ("time-overlay", 100, 100),
            ("todo-overlay", 100, 100),
            ("system-cleaner-overlay", 120, 120),
            ("sticky-notes-manager", 100, 100),
        ];
        for (label, x, y) in CASES {
            let start = ts.find(&format!("createToolWindow(\"{label}\"")).unwrap_or_else(|| {
                panic!("toolWindows.ts 里找不到 createToolWindow(\"{label}\")：窗口创建方式变了，请同步本守卫")
            });
            // 选项块以下一个 createToolWindow 调用为界，避免把相邻窗口的坐标算进来
            let rest = &ts[start..];
            let end = rest[1..]
                .find("createToolWindow(")
                .map_or(rest.len(), |index| index + 1);
            let block = &rest[..end];
            for (key, value) in [("x", *x), ("y", *y)] {
                assert!(
                    block
                        .lines()
                        .any(|line| line.trim() == format!("{key}: {value},")),
                    "前端创建 {label} 时的 {key} 不再是 {value}：`default_window_position` 里的\
                     默认定位要跟着改，否则「恢复默认位置」与窗口重建会落到两个不同的点"
                );
            }
            assert_eq!(
                default_window_position(label, 360, 560),
                (*x, *y),
                "{label} 的默认定位与前端创建坐标不一致"
            );
        }
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

    /// 每个 `rfd` 文件对话框调用点都必须先处理「置顶 / owner」。
    ///
    /// 为什么这条要变成可执行约束：本项目的浮窗几乎都是 `alwaysOnTop`，而 rfd 在没有
    /// parent 时给 `IFileDialog::Show` 传的是 **NULL owner**（`parent.unwrap_or(null)`）。
    /// 实测（Z 序 + 像素采样）：置顶窗会把**无主**对话框完全盖住，把它设为前台也抬不上来
    /// ⇒ 用户点「保存」后看不到任何反应，很可能以为程序卡死。仅设 owner 也不够：挡住
    /// 对话框的可能是**另一扇**前台置顶窗，所以还必须临时取消自有置顶窗的置顶。
    ///
    /// 允许的两种写法（二者都做在打开对话框之前）：
    /// ① 有 `AppHandle`：`DialogTopmostGuard::suspend(...)`；
    /// ② 裸 HWND 窗口（贴图）：`apply_window_topmost(hwnd, ...)`。
    #[test]
    fn every_file_dialog_suspends_topmost_first() {
        // (文件名, 源码, 该文件里预期的 rfd 调用点数)
        let files: [(&str, &str, usize); 6] = [            ("commands/mod.rs", include_str!("mod.rs"), 2),
            ("commands/screenshot.rs", include_str!("screenshot.rs"), 1),
            ("commands/todo.rs", include_str!("todo.rs"), 2),
            ("commands/long_capture.rs", include_str!("long_capture.rs"), 1),
            ("commands/disk_cleanup.rs", include_str!("disk_cleanup.rs"), 3),
            ("screenshot/pin.rs", include_str!("../screenshot/pin.rs"), 1),
        ];
        for (name, raw, expected) in files {
            // 只扫生产区：本用例自身的源码里也含 `rfd::FileDialog::new()` 这个匹配串，
            // 不把测试模块切掉就会把自己扫进去、永远报红。
            let production = raw.split("\n#[cfg(test)]").next().unwrap_or(raw);
            // 先剥整行注释：把守卫调用注释掉（而不是删掉）在文本层面看起来「还在」，
            // 不剥注释的守卫会被这种变异骗过。
            let src = strip_line_comments(production);
            let mut found = 0usize;
            let mut rest = src.as_str();
            while let Some(index) = rest.find("rfd::FileDialog::new()") {
                found += 1;
                // 只在该调用所在的函数体内找守卫：不能因为「文件别处有守卫」就放行。
                let before = &rest[..index];
                let fn_start = ["\npub async fn ", "\npub fn ", "\nasync fn ", "\nunsafe fn ", "\nfn "]
                    .iter()
                    .filter_map(|pat| before.rfind(pat))
                    .max()
                    .unwrap_or(0);
                let body_prefix = &before[fn_start..];
                assert!(
                    body_prefix.contains("DialogTopmostGuard::suspend(")
                        || body_prefix.contains("apply_window_topmost("),
                    "{name} 里的 rfd 对话框没有先处理置顶/owner —— 它会被本项目的置顶窗\
                     完全盖住（用户点保存没有任何反应）"
                );
                rest = &rest[index + 1..];
            }
            // 反向断言：调用点被挪走或 include_str! 路径写错时不能静默通过。
            assert_eq!(
                found, expected,
                "{name} 里扫到 {found} 处 rfd 调用，预期 {expected} —— 守卫的扫描面已失效"
            );
        }
    }

    /// 前端 `ToolWindowLabel` 里的每个浮窗都必须出现在 `OWN_WINDOW_LABELS` 中。
    ///
    /// 这份清单有三处消费者，漏一个的后果都是用户可见的：`DialogTopmostGuard` 不会
    /// 取消那扇窗的置顶（它正好压在文件对话框上时，用户点保存看不到任何反应）、
    /// `is_own_window` 会把自家窗误判成外部窗口、录屏列表会把它当成可录目标。
    /// 历史上就漏过 `sticky-notes-manager` 与 `scroll-navigator-overlay`（两者都是
    /// `alwaysOnTop: true`），所以这里钉成可执行约束 —— 新增浮窗时前端加一行、
    /// 这里就会报红提醒补 Rust 侧。
    #[test]
    fn own_window_labels_cover_frontend_tool_windows() {
        let ts = include_str!("../../../src/utils/toolWindows.ts");
        // 剥整行注释后再解析：TS 里把某一项注释掉（`// | "xxx"`）时，它是**真的不在**
        // 联合类型里了，但裸文本匹配仍会把它提取出来 → `contains` 恰好命中时假绿。
        // 剥注释后注释行变空串，其中的 `"…"` 自然不会被扫到。
        let ts = strip_line_comments(ts);
        let start = ts
            .find("type ToolWindowLabel =")
            .expect("未找到 ToolWindowLabel 定义（被改名/移动时请同步本守卫）");
        let rest = &ts[start..];
        let end = rest.find(';').expect("ToolWindowLabel 定义未以 `;` 结束");
        let block = &rest[..end];

        let mut checked = 0usize;
        let mut cursor = 0usize;
        while let Some(open_rel) = block[cursor..].find('"') {
            let open = cursor + open_rel;
            let Some(close_rel) = block[open + 1..].find('"') else {
                break;
            };
            let label = &block[open + 1..open + 1 + close_rel];
            cursor = open + 1 + close_rel + 1;
            assert!(
                OWN_WINDOW_LABELS.contains(&label),
                "前端 ToolWindowLabel 里的 `{label}` 不在 OWN_WINDOW_LABELS 中：新增自有浮窗\
                 必须补进该清单，否则文件对话框会被它挡住、录屏也会把它当成外部窗口"
            );
            checked += 1;
        }
        // 反向断言：解析面失效（类型改名、改成单行联合等）时不能静默通过。
        assert!(
            checked >= 13,
            "只从 ToolWindowLabel 提取到 {checked} 个 label，预期 ≥13 —— 守卫的解析面已失效"
        );
    }

    /// 自有窗口的判定只能有**一处**实现（三类窗口都必须覆盖）。
    ///
    /// 历史上漂移过三次：`commands` 里那份清单（当时叫 `is_levitaire_window`，现
    /// `is_own_window`）漏过 `sticky-notes-manager` 与 `scroll-navigator-overlay`；
    /// `scroll_navigation.rs` 干脆自带了一份 19 项副本。
    /// 漏判的后果都是用户可见的：文件对话框被自家置顶窗挡住、滚动导航把自己当目标
    /// （点一下贴图/便利贴之后按钮全部静默失效）、截图目标是自家窗口。
    #[test]
    fn own_window_detection_is_single_sourced() {
        // ① label 清单只能定义一次。
        let files: [(&str, &str); 3] = [
            ("commands/mod.rs", include_str!("mod.rs")),
            (
                "scroll_navigation.rs",
                include_str!("../scroll_navigation.rs"),
            ),
            (
                "recording/window_detect.rs",
                include_str!("../recording/window_detect.rs"),
            ),
        ];
        let declared: Vec<&str> = files
            .iter()
            .filter(|(_, src)| src.contains("const OWN_WINDOW_LABELS"))
            .map(|(name, _)| *name)
            .collect();
        assert_eq!(
            declared,
            vec!["commands/mod.rs"],
            "OWN_WINDOW_LABELS 必须只在 commands/mod.rs 单点定义"
        );

        // ② 别处不得再逐项列举自有窗口 label（改用 `commands::is_own_window`）。
        let scroll = strip_line_comments(include_str!("../scroll_navigation.rs"));
        for label in [
            "\"scroll-navigator-overlay\"",
            "\"screenshot-overlay\"",
            "\"utility-hub-overlay\"",
        ] {
            assert!(
                !scroll.contains(label),
                "scroll_navigation.rs 里又出现了自有窗口 label {label} —— 不要再维护第二份清单"
            );
        }

        // ③ 权威实现本身必须覆盖三类：webview 清单 / 原生贴图窗 / 标题前缀兜底。
        //
        // 只看**生产区**且剥掉整行注释后的代码。本用例自己就写在 mod.rs 里，下面这三个
        // 字符串字面量也在本函数源码中 —— 直接拿 `include_str!("mod.rs")` 断言
        // `contains(...)` 会**自己满足自己**、恒为真（等于没写，实测过）。
        let whole = strip_line_comments(include_str!("mod.rs"));
        let production = whole.split("\n#[cfg(test)]").next().unwrap_or("");
        assert!(
            !production.contains("fn own_window_detection_is_single_sourced")
                && !production.is_empty(),
            "没能把测试模块切出去（`#[cfg(test)]` 的写法变了？）—— 这会让下面的断言恒成立"
        );
        for needle in [
            "OWN_WINDOW_LABELS",
            "LevitairePinWindow",
            "window_text_starts_with",
        ] {
            assert!(
                production.contains(needle),
                "is_own_window 缺少一类判定：{needle} —— 贴图窗是原生窗、便利贴是动态 label，\
                 只查 webview 清单都会漏"
            );
        }

        // ④ 文件对话框期间「取消置顶」的范围必须与 ③ 同样覆盖三类，否则用户钉在屏幕上的
        // 截图 / 便签正好压在对话框上时，对话框照样被挡住（与「只设 owner」是同一个坑）。
        let anchor = production
            .find("pub fn suspend(app: &tauri::AppHandle")
            .expect("DialogTopmostGuard::suspend 被改名/移走了 —— 请同步本守卫");
        let rest = &production[anchor..];
        let end = rest
            .find("\n    }\n")
            .expect("解析不到 suspend 的函数体结束位置");
        let body = &rest[..end];
        for needle in ["note_window_label(", "topmost_pin_hwnds(", "set_pins_topmost("] {
            assert!(
                body.contains(needle),
                "DialogTopmostGuard::suspend 漏了一类自有置顶窗：{needle} —— 固定 label 清单、\
                 便利贴（动态 label）、贴图窗（原生 WS_EX_TOPMOST）三类都要取消置顶"
            );
        }
    }

}
