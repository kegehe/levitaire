use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;
use tauri::Manager;
use tauri::State;
use windows::Win32::UI::WindowsAndMessaging::{
    SetWindowDisplayAffinity, WDA_NONE,
};

use crate::automation::SelectionInfo;
use crate::clipboard::ClipboardManager;
use crate::config::ConfigManager;

static SCREENSHOT_STARTING: AtomicBool = AtomicBool::new(false);
static SCREENSHOT_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);
static SCREENSHOT_SESSION: AtomicU64 = AtomicU64::new(0);
static MONITOR_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);
static POMODORO_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);

/// 截图/录屏会话开始前 orb 的可见状态。
/// 会话清理（取消截图/录屏）时按此状态恢复 orb，而不是无条件 show：
/// 否则用户通过托盘「显示/隐藏浮球」已隐藏的 orb 会被强制弹出，
/// 与托盘开关相互矛盾。仅在真正进入会话时写入，会话结束后由下个会话覆盖。
static ORB_VISIBLE_BEFORE_SESSION: AtomicBool = AtomicBool::new(true);

/// 截图/录屏会话是否活跃。进入 start_screenshot / start_recording_select 时置 true，
/// 会话清理（cleanup_screenshot_session_inner / cancel_recording_select）时置 false。
/// 用于区分「正在清理会话」（按会话前状态恢复 orb）与「空闲清理」
/// （如仅关闭工具开关，不应动 orb）。相比隐式推断 `is_screenshot_mode()/is_recording_mode()`
/// 的可靠性：录制「编码/预览」阶段 recording_mode 已被清除但 `is_finishing()` 仍为 true，
/// 此时清理仍应恢复 orb，故用显式标记覆盖整个会话生命周期。
static CAPTURE_SESSION_ACTIVE: AtomicBool = AtomicBool::new(false);

/// 恢复默认位置时抑制对应窗口 onMoved 保存的截止时间戳（窗口 id → 截止毫秒）。
/// 程序化 set_position 会触发 onMoved → 前端在 300ms 后再次 set_window_position，
/// 若不抑制会把刚恢复的默认位置重新记忆。此窗口期内仅忽略该窗口的保存请求，
/// 不影响其他悬浮窗的正常拖动记忆。
static POSITION_SAVE_SUPPRESS_UNTIL_MS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

fn position_save_suppress() -> &'static Mutex<HashMap<String, u64>> {
    POSITION_SAVE_SUPPRESS_UNTIL_MS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 保护 settings 窗口"检查+创建+注册关闭拦截"的异步互斥锁，防止快速双击导致竞态
/// 使用 tokio::sync::Mutex 而非 std::sync::Mutex，避免在 async 函数中持有同步锁导致死锁
static SETTINGS_INIT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
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

/// End a screenshot session from every exit path without destroying the configured overlay.
fn cleanup_screenshot_session_inner(app: &tauri::AppHandle) {
    // 仅会话进行中被隐藏的 orb 才按会话前状态恢复，避免把用户经托盘已隐藏的 orb
    // 强制弹出（托盘「显示/隐藏浮球」与清理逻辑相互矛盾）。
    // 用会话活跃标记区分「正在清理会话」与「空闲清理」（如仅关闭工具开关），
    // 空闲清理不应动 orb。必须在 set_screenshot_mode(false) 之前读取。
    let session_active = CAPTURE_SESSION_ACTIVE.load(Ordering::SeqCst);
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
    // 会话结束，复位活跃标记，避免泄漏到后续空闲清理误判
    CAPTURE_SESSION_ACTIVE.store(false, Ordering::SeqCst);
}

pub fn cleanup_screenshot_session(app: &tauri::AppHandle) {
    SCREENSHOT_SESSION.fetch_add(1, Ordering::SeqCst);
    cleanup_screenshot_session_inner(app);
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
        cleanup_screenshot_session_inner(app);
        true
    } else {
        false
    }
}

#[tauri::command]
pub fn get_selection() -> Result<Option<SelectionInfo>, String> {
    crate::utils::logger::log("commands", "get_selection command called");
    let result = crate::automation::get_current_selection().map_err(|e| e.to_string());
    crate::utils::logger::log("commands", &format!("get_selection result: {:?}", result));
    result
}

#[tauri::command]
pub fn copy_text(text: String, clipboard: State<'_, ClipboardManager>) -> Result<(), String> {
    clipboard.copy(&text).map_err(|e| e.to_string())
}

/// 通过恢复原始窗口焦点 + 模拟 Ctrl+C 来复制选区内容
/// 这样可以保留富文本、图片等完整格式
#[tauri::command]
pub async fn copy_selection() -> Result<(), String> {
    crate::utils::logger::log("commands", "copy_selection called (simulate Ctrl+C)");
    tokio::task::spawn_blocking(crate::automation::copy_selection_via_simulation)
        .await
        .map_err(|e| format!("copy_selection task failed: {}", e))?
}

#[tauri::command]
pub fn get_toolbar_position() -> Result<crate::automation::Point, String> {
    crate::automation::get_mouse_position().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_toolbar(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("toolbar") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    crate::hooks::set_toolbar_visible(true);
    Ok(())
}

#[tauri::command]
pub fn hide_toolbar(app: tauri::AppHandle) -> Result<(), String> {
    // 隐藏窗口前，先恢复前台窗口焦点
    // 工具栏按钮点击后焦点可能在工具栏上，直接隐藏会导致 Windows 重新分配焦点，
    // 可能清除目标应用中刚恢复的文本选区
    if let Some(ctx) = crate::automation::get_stored_selection_context() {
        if ctx.foreground_hwnd != 0 {
            unsafe {
                let hwnd =
                    windows::Win32::Foundation::HWND(ctx.foreground_hwnd as *mut std::ffi::c_void);
                let _ = windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);
            }
        }
    }
    if let Some(window) = app.get_webview_window("toolbar") {
        window.hide().map_err(|e| e.to_string())?;
    }
    // 同步后端工具栏可见状态
    crate::hooks::set_toolbar_visible(false);
    Ok(())
}

#[tauri::command]
pub fn show_orb(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("orb") {
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn hide_orb(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("orb") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn show_settings(app: tauri::AppHandle) -> Result<(), String> {
    // 用 tokio Mutex 保护"检查+创建+注册关闭拦截"整个流程，防止快速双击竞态
    let _init_guard = SETTINGS_INIT_LOCK.lock().await;

    // 首次打开时动态创建窗口（settings 不再预创建，延迟到首次 show）
    let window = match app.get_webview_window("settings") {
        Some(win) => win,
        None => {
            use tauri::WebviewUrl;
            use tauri::WebviewWindowBuilder;
            let win = WebviewWindowBuilder::new(
                &app,
                "settings",
                WebviewUrl::App("index.html".into()),
            )
            .title("Levitaire Settings")
            .inner_size(780.0, 560.0)
            .center()
            .visible(false)
            // 自绘标题栏：去掉原生装饰，由前端渲染标题栏并跟随主题/主题色。
            // 失去 Windows 原生边框/阴影，由 CSS border 负责窗口边界（见 .settings-shell）。
            .decorations(false)
            .shadow(false)
            .resizable(true)
            .min_inner_size(520.0, 420.0)
            .build()
            .map_err(|e| format!("创建 settings 窗口失败: {}", e))?;
            win
        }
    };

    // 注册关闭拦截（仅一次）：隐藏而非销毁
    static SETTINGS_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);
    if !SETTINGS_CLOSE_HANDLER_REGISTERED.swap(true, Ordering::SeqCst) {
        let settings_app_handle = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Some(win) = settings_app_handle.get_webview_window("settings") {
                    let _ = win.hide();
                }
            }
        });
    }

    // 注册完成后释放初始化锁，show/set_focus 不需要在锁内执行
    drop(_init_guard);

    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// prompt 最大长度限制（字节数，String::len() 返回 UTF-8 字节数）
const MAX_PROMPT_LENGTH: usize = 100000;

/// 调用 AI 接口
#[tauri::command]
pub async fn call_ai(
    prompt: String,
    system_prompt: Option<String>,
    ai_service: State<'_, crate::ai::AiService>,
) -> Result<crate::ai::AiResponse, String> {
    crate::utils::logger::log(
        "commands",
        &format!("call_ai 命令被调用, prompt 长度: {} 字节", prompt.len()),
    );
    if prompt.len() > MAX_PROMPT_LENGTH {
        return Err(format!(
            "prompt 长度超过限制（最大 {} 字节）",
            MAX_PROMPT_LENGTH
        ));
    }
    if prompt.is_empty() {
        return Err("prompt 不能为空".to_string());
    }
    ai_service.call(&prompt, system_prompt.as_deref()).await
}

/// 流式调用 AI 接口，通过事件推送文本片段
#[tauri::command]
pub async fn call_ai_stream(
    app: tauri::AppHandle,
    prompt: String,
    system_prompt: Option<String>,
    ai_service: State<'_, crate::ai::AiService>,
) -> Result<(), String> {
    crate::utils::logger::log(
        "commands",
        &format!(
            "call_ai_stream 命令被调用, prompt 长度: {} 字节",
            prompt.len()
        ),
    );
    if prompt.len() > MAX_PROMPT_LENGTH {
        let _ = app.emit("ai-stream", serde_json::json!({ "type": "error", "data": format!("prompt 长度超过限制（最大 {} 字节）", MAX_PROMPT_LENGTH) }));
        return Err(format!(
            "prompt 长度超过限制（最大 {} 字节）",
            MAX_PROMPT_LENGTH
        ));
    }
    if prompt.is_empty() {
        let _ = app.emit(
            "ai-stream",
            serde_json::json!({ "type": "error", "data": "prompt 不能为空" }),
        );
        return Err("prompt 不能为空".to_string());
    }

    let app_handle = app.clone();
    // 发起新流式调用前重置取消标志（防止上一次取消影响本次请求），
    // 前端「取消」通过 cancel_ai_stream 命令置位，call_stream 每帧检测后提前终止。
    ai_service.reset_cancel();
    let result = ai_service
        .call_stream(&prompt, system_prompt.as_deref(), move |chunk| {
            let _ = app_handle.emit(
                "ai-stream",
                serde_json::json!({ "type": "chunk", "data": chunk }),
            );
        })
        .await;

    match result {
        Ok(_) => {
            let _ = app.emit("ai-stream", serde_json::json!({ "type": "done" }));
            Ok(())
        }
        Err(e) => {
            // 用户取消导致的提前终止同样回传消息，前端取消时已移除监听器，无副作用；
            // 若取消后重新发起了新请求，则该 error 事件被新请求的监听器屏蔽（requestId 校验）。
            let _ = app.emit(
                "ai-stream",
                serde_json::json!({ "type": "error", "data": &e }),
            );
            Err(e)
        }
    }
}

/// 请求取消当前流式 AI 调用（前端点取消时调用）
#[tauri::command]
pub fn cancel_ai_stream(ai_service: State<'_, crate::ai::AiService>) {
    ai_service.request_cancel();
}

/// 获取当前 AI 配置
#[tauri::command]
pub fn get_ai_config(
    config_manager: State<'_, ConfigManager>,
) -> Result<crate::config::AiConfig, String> {
    config_manager.get_ai_config()
}

/// 更新 AI 配置
#[tauri::command]
pub fn update_ai_config(
    new_config: crate::config::AiConfig,
    ai_service: State<'_, crate::ai::AiService>,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    crate::utils::logger::log("commands", "更新 AI 配置");
    // 先更新内存中的 AiService（如果失败可以安全返回错误，不会有不一致状态）
    ai_service.update_config(new_config.clone())?;
    // 内存更新成功后再持久化到配置文件
    config_manager.update_ai_config(new_config)?;
    Ok(())
}

#[tauri::command]
pub fn get_theme_preferences(
    config_manager: State<'_, ConfigManager>,
) -> Result<crate::config::ThemePreferences, String> {
    config_manager.get_theme_preferences()
}

#[tauri::command]
pub fn set_theme_preferences(
    preferences: crate::config::ThemePreferences,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_theme_preferences(preferences)
}

/// 替换选中文字
#[tauri::command]
pub async fn replace_selection(text: String) -> Result<(), String> {
    crate::utils::logger::log(
        "commands",
        &format!(
            "replace_selection 命令被调用, 新文本长度: {} 字节",
            text.len()
        ),
    );
    if text.is_empty() {
        return Err("替换文本不能为空".to_string());
    }
    // 在后台线程执行，避免 SendMessageW 阻塞主线程
    tokio::task::spawn_blocking(move || crate::automation::replace_selection_text(&text))
        .await
        .map_err(|e| format!("替换任务执行失败: {}", e))?
}

/// 允许通过 open_url 打开的 URL scheme 白名单。
/// 仅放行浏览器/常见协议，阻止 file://、脚本协议等可能被构造用于命令注入的 scheme。
const ALLOWED_URL_SCHEMES: &[&str] = &["http", "https", "mailto"];

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

/// 打开 URL（用默认浏览器）。
/// 通过校验 scheme 白名单 + ShellExecuteW 直接打开，避免 cmd /C start 的命令注入风险。
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    crate::utils::logger::log("commands", &format!("open_url: {}", url));
    validate_url_scheme(&url)?;

    #[cfg(target_os = "windows")]
    {
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        // 将 URL 编码为 UTF-16，ShellExecuteW 以 "open" 动词交给系统默认处理程序
        let url_wide: Vec<u16> = url.encode_utf16().chain(std::iter::once(0u16)).collect();
        let verb: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0u16)).collect();

        // SAFETY: verb 与 file 均为以 NUL 结尾的 UTF-16 字符串指针，参数符合 ShellExecuteW 签名。
        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(verb.as_ptr()),
                PCWSTR(url_wide.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        // ShellExecuteW 返回 HINSTANCE；当 HINSTANCE <= 32 时表示失败
        let hinst = result.0 as usize;
        if hinst <= 32 {
            return Err(format!("打开浏览器失败 (code: {})", hinst));
        }
    }
    Ok(())
}

/// 获取开机自启动状态
#[tauri::command]
pub fn get_auto_start() -> bool {
    crate::config::get_auto_start()
}

/// 设置开机自启动
#[tauri::command]
pub fn set_auto_start(enable: bool) -> Result<(), String> {
    crate::config::set_auto_start(enable)
}

/// 设置二维码预览模式
/// 为 true 时鼠标点击工具栏外部不会隐藏窗口
#[tauri::command]
pub fn set_qrcode_preview(active: bool) {
    crate::hooks::mouse::set_qrcode_preview(active);
}

/// 获取截图快捷键（空串表示未设置）
#[tauri::command]
pub fn get_screenshot_hotkey(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_screenshot_hotkey()
}

/// 设置截图快捷键：解析、注册全局热键（带冲突检测）、持久化。
/// 传入空串则反注册并清除。
/// 返回 Ok(()) 成功；Err 为冲突或无效格式信息。
#[tauri::command]
pub fn set_screenshot_hotkey(
    hotkey: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let trimmed = hotkey.trim().to_string();
    let previous = config_manager.get_screenshot_hotkey()?;
    if trimmed.is_empty() {
        crate::hooks::hotkey::unregister_hotkey(crate::hooks::hotkey::HotkeySlotId::Screenshot);
        if let Err(error) = config_manager.update_screenshot_hotkey(String::new()) {
            let _ = config_manager.update_screenshot_hotkey(previous.clone());
            if !previous.is_empty() {
                let _ = crate::hooks::hotkey::register_hotkey(
                    crate::hooks::hotkey::HotkeySlotId::Screenshot,
                    &previous,
                );
            }
            return Err(error);
        }
        return Ok(());
    }
    // 先注册（含冲突检测），成功后再持久化。
    // register_hotkey 内部会先反注册旧的再注册新的；若新的失败会尝试回滚恢复旧的，避免新旧皆失。
    crate::hooks::hotkey::register_hotkey(
        crate::hooks::hotkey::HotkeySlotId::Screenshot,
        &trimmed,
    )?;
    if let Err(error) = config_manager.update_screenshot_hotkey(trimmed) {
        let _ = config_manager.update_screenshot_hotkey(previous.clone());
        if previous.is_empty() {
            crate::hooks::hotkey::unregister_hotkey(crate::hooks::hotkey::HotkeySlotId::Screenshot);
        } else {
            let _ = crate::hooks::hotkey::register_hotkey(
                crate::hooks::hotkey::HotkeySlotId::Screenshot,
                &previous,
            );
        }
        return Err(error);
    }
    Ok(())
}

/// 设置截图工具启用状态（仅启用时热键才触发），同时持久化到配置
#[tauri::command]
pub fn set_screenshot_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let previous = config_manager.get_screenshot_enabled()?;
    if let Err(error) = config_manager.update_screenshot_enabled(enabled) {
        let _ = config_manager.update_screenshot_enabled(previous);
        return Err(error);
    }
    crate::hooks::hotkey::set_screenshot_enabled(enabled);
    if !enabled {
        cleanup_screenshot_session(&app);
    }
    Ok(())
}

/// 设置文字工具栏启用状态（关闭后选中文本不再弹出），同时持久化到配置
#[tauri::command]
pub fn set_text_toolbar_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let previous = config_manager.get_text_toolbar_enabled()?;
    if let Err(error) = config_manager.update_text_toolbar_enabled(enabled) {
        let _ = config_manager.update_text_toolbar_enabled(previous);
        return Err(error);
    }
    crate::hooks::mouse::set_text_toolbar_enabled(enabled);
    if !enabled {
        if let Some(toolbar) = app.get_webview_window("toolbar") {
            let _ = toolbar.hide();
        }
        crate::hooks::set_toolbar_visible(false);
    }
    Ok(())
}

/// 获取截图工具启用状态（供前端卡片开关与后端真值同步）
#[tauri::command]
pub fn get_screenshot_enabled(config_manager: State<'_, ConfigManager>) -> Result<bool, String> {
    config_manager.get_screenshot_enabled()
}

/// 获取文字工具栏启用状态（供前端卡片开关与后端真值同步）
#[tauri::command]
pub fn get_text_toolbar_enabled(config_manager: State<'_, ConfigManager>) -> Result<bool, String> {
    config_manager.get_text_toolbar_enabled()
}

/// 获取工具栏启用的功能 ID 列表
#[tauri::command]
pub fn get_toolbar_features(
    config_manager: State<'_, ConfigManager>,
) -> Result<Vec<String>, String> {
    config_manager.get_toolbar_features()
}

/// 更新工具栏启用的功能 ID 列表并持久化
#[tauri::command]
pub fn set_toolbar_features(
    features: Vec<String>,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_toolbar_features(features)
}

/// 获取搜索引擎配置（空串表示未设置，前端取默认 Bing）
#[tauri::command]
pub fn get_search_engine(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_search_engine()
}

/// 更新搜索引擎配置并持久化
#[tauri::command]
pub fn set_search_engine(
    engine: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_search_engine(engine)
}

/// 获取去重粒度配置（JSON 字符串，空串表示未设置）
#[tauri::command]
pub fn get_dedup_mode(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_dedup_mode()
}

/// 更新去重粒度配置并持久化
#[tauri::command]
pub fn set_dedup_mode(
    mode: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_dedup_mode(mode)
}

/// 获取 MD5 位数配置（空串表示未设置，前端取默认 32）
#[tauri::command]
pub fn get_md5_length(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_md5_length()
}

/// 更新 MD5 位数配置并持久化
#[tauri::command]
pub fn set_md5_length(
    length: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_md5_length(length)
}

/// 获取编号样式配置（空串表示未设置，前端取默认值）
#[tauri::command]
pub fn get_numbering_style(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_numbering_style()
}

/// 更新编号样式配置并持久化
#[tauri::command]
pub fn set_numbering_style(
    style: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_numbering_style(style)
}

/// 获取清除功能启用的清除项 ID 列表（空列表表示未设置，前端取默认全量）
#[tauri::command]
pub fn get_clear_options(config_manager: State<'_, ConfigManager>) -> Result<Vec<String>, String> {
    config_manager.get_clear_options()
}

/// 更新清除功能启用的清除项 ID 列表并持久化
#[tauri::command]
pub fn set_clear_options(
    options: Vec<String>,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_clear_options(options)
}

/// 显示卡片工具选择器面板，定位到悬浮球附近
#[tauri::command]
pub async fn show_palette(app: tauri::AppHandle) -> Result<(), String> {
    // 用 tokio Mutex 保护"检查+创建+注册关闭拦截"整个流程，防止快速双击竞态
    let _init_guard = PALETTE_INIT_LOCK.lock().await;

    // 首次打开时动态创建窗口（palette 不再预创建，延迟到首次 show）
    let palette = match app.get_webview_window("palette") {
        Some(win) => win,
        None => {
            use tauri::WebviewUrl;
            use tauri::WebviewWindowBuilder;
            let win = WebviewWindowBuilder::new(
                &app,
                "palette",
                WebviewUrl::App("index.html".into()),
            )
            .title("Levitaire Tools")
            .inner_size(360.0, 260.0)
            .resizable(false)
            .transparent(true)
            .decorations(false)
            // 由 palette-container 的 CSS 阴影负责视觉层级。Windows 原生阴影会在
            // 透明圆角的外侧参与合成，深色主题下会显出浅色边缘。
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focusable(true)
            .visible(false)
            // WebView2 默认背景为不透明白色 (255,255,255,255)，
            // 在 border-radius 圆角裁剪区域外会露出白边（深色模式下尤为明显）。
            // 显式设为完全透明，使圆角外区域真正透明。
            .background_color(tauri::webview::Color(0, 0, 0, 0))
            .build()
            .map_err(|e| format!("创建 palette 窗口失败: {}", e))?;
            win
        }
    };

    // 注册关闭拦截（仅一次）：隐藏而非销毁
    static PALETTE_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);
    if !PALETTE_CLOSE_HANDLER_REGISTERED.swap(true, Ordering::SeqCst) {
        let palette_app_handle = app.clone();
        palette.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Some(win) = palette_app_handle.get_webview_window("palette") {
                    let _ = win.hide();
                }
            }
        });
    }

    // 注册完成后释放初始化锁，后续定位和 show 不需要在锁内执行
    drop(_init_guard);

    // palette 物理尺寸：宽度固定 360，高度由前端自适应调整（fit-content + setSize）。
    // 首次创建时 inner_size() 可能返回 0，使用 WebviewWindowBuilder 中指定的逻辑尺寸乘 scale_factor 作为 fallback。
    // 高度取 inner_size()（非首次时已是前端上次调整的值），首次创建 fallback 用初始值。
    let scale = palette.scale_factor().unwrap_or(1.0);
    let inner = palette.inner_size().unwrap_or_else(|_| {
        tauri::PhysicalSize::new((360.0 * scale) as u32, (260.0 * scale) as u32)
    });
    let pw = if inner.width > 0 { inner.width as i32 } else { (360.0 * scale) as i32 };
    let ph = if inner.height > 0 { inner.height as i32 } else { (260.0 * scale) as i32 };

    // 锚点：优先用 orb 窗口位置；失败则用鼠标位置
    let (mut x, mut y, anchor_hwnd) = if let Some(orb) = app.get_webview_window("orb") {
        match orb.outer_position() {
            Ok(p) => {
                let oi = orb.inner_size().unwrap_or_default();
                let ow = oi.width as i32;
                let oh = oi.height as i32;
                let hwnd = orb.hwnd().map(|h| h.0).unwrap_or(std::ptr::null_mut());
                // 默认放在 orb 右上方，间隔 8px
                (p.x + ow + 8, p.y - ph + oh, hwnd)
            }
            Err(_) => {
                if let Ok(cur) = crate::automation::get_mouse_position() {
                    (cur.x + 8, cur.y + 8, std::ptr::null_mut())
                } else {
                    (100, 100, std::ptr::null_mut())
                }
            }
        }
    } else if let Ok(cur) = crate::automation::get_mouse_position() {
        (cur.x + 8, cur.y + 8, std::ptr::null_mut())
    } else {
        (100, 100, std::ptr::null_mut())
    };

    // 取 orb 所在显示器的工作区用于边界翻转（支持多显示器）
    // GetMonitorInfoW 在 Per-Monitor DPI Aware V2 进程中返回物理像素坐标
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        };
        let hwnd = HWND(anchor_hwnd);
        if !hwnd.is_invalid() {
            let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
            let mut mi = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if unsafe { GetMonitorInfoW(monitor, &mut mi) }.as_bool() {
                let rc = mi.rcWork;
                // 边界翻转：palette 不超出 orb 所在屏工作区
                if x + pw > rc.right {
                    // 右边放不下，改为放在 orb 左边
                    if let Some(orb) = app.get_webview_window("orb") {
                        if let Ok(p) = orb.outer_position() {
                            x = p.x - pw - 8;
                        }
                    }
                    // 如果左边也放不下，贴左边工作区
                    if x < rc.left {
                        x = rc.left;
                    }
                }
                if y + ph > rc.bottom {
                    y = rc.bottom - ph;
                }
                if x < rc.left {
                    x = rc.left;
                }
                if y < rc.top {
                    y = rc.top;
                }
            }
        }
    }

    let _ = palette.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        x, y,
    )));
    // set_size 使用 inner_size() 的当前值（非首次时已是前端上次调整的值），
    // 前端 useLayoutEffect 会在渲染后按实际内容高度再次 setSize 修正，
    // 两者之间可能有一帧微调，可接受。
    let _ = palette.set_size(tauri::PhysicalSize::new(pw, ph));

    palette.show().map_err(|e| e.to_string())?;
    palette.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// 隐藏卡片工具选择器面板
#[tauri::command]
pub fn hide_palette(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("palette") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 退出应用（悬浮球右键菜单「退出」入口，与托盘菜单 quit 等价）
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

/// 进入截图模式：显示全屏遮罩窗口并屏蔽鼠标钩子的选区检测
#[tauri::command]
pub fn start_screenshot(app: tauri::AppHandle) -> Result<(), String> {
    // 命令入口：Tauri 注入 app，缓存 State 在内部用 app.state() 获取
    start_screenshot_inner(app)
}

/// start_screenshot 的核心逻辑，独立出来供热键等非命令入口复用。
/// 缓存 State 在内部用 app.state() 获取，避免调用方构造 State 的麻烦与生命周期问题。
pub fn start_screenshot_inner(app: tauri::AppHandle) -> Result<(), String> {
    crate::utils::logger::log("screenshot", "start_screenshot called");
    let Some(_start_guard) = ScreenshotStartGuard::acquire() else {
        crate::utils::logger::log("screenshot", "screenshot start already in progress");
        return Ok(());
    };
    // 录制模式激活时，不允许启动截图（避免两种模式同时激活导致 Esc 处理混乱）
    if crate::hooks::mouse::is_recording_mode() {
        crate::utils::logger::log(
            "screenshot",
            "recording mode active, ignoring screenshot start",
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
    // 记录会话前 orb 可见性 + 会话活跃标记，供会话清理（取消截图）时按原状态恢复，
    // 不强制弹出用户经托盘已隐藏的 orb。先记录再置 screenshot_mode，
    // 避免并发清理读到「模式已置但标记未更新」的半状态。
    ORB_VISIBLE_BEFORE_SESSION.store(orb_was_visible, Ordering::SeqCst);
    CAPTURE_SESSION_ACTIVE.store(true, Ordering::SeqCst);
    crate::hooks::mouse::set_screenshot_mode(true);
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
    if let Some(win) = app.get_webview_window("palette") {
        let _ = win.hide();
    }

    // 等 DWM 合成一帧，确保 orb/toolbar/palette 已从屏幕消失再截屏缓存，
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

    // 恢复 orb/toolbar 可见性状态：截图前为截纯净画面临时 hide 了它们，
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

/// 获取虚拟桌面边界（多显示器并集，含负坐标原点），供截图遮罩前端换算绝对坐标
#[tauri::command]
pub fn get_virtual_desktop_bounds() -> Result<serde_json::Value, String> {
    let b = crate::screenshot::virtual_desktop_bounds()?;
    Ok(serde_json::json!({
        "originX": b.origin_x,
        "originY": b.origin_y,
        "width": b.width,
        "height": b.height,
    }))
}

/// 返回全屏缓存的 PNG base64（不带 data: 前缀），供前端放大镜铺底取像素。
/// 缓存由 start_screenshot 在 overlay 显示前截取，为纯净桌面画面。
/// 缓存未就绪时返回 Err，前端降级为仅显示十字线。
#[tauri::command]
pub fn get_screen_cache_png(
    cache: tauri::State<'_, crate::screenshot::ScreenCache>,
) -> Result<String, String> {
    let guard = cache.pixels.lock().map_err(|e| e.to_string())?;
    let c = guard.as_ref().ok_or_else(|| "截图缓存未就绪".to_string())?;
    crate::screenshot::encode_png_base64(&c.bgra, c.width, c.height)
}

/// 退出截图模式：隐藏遮罩并恢复鼠标钩子
#[tauri::command]
pub fn cancel_screenshot(app: tauri::AppHandle) -> Result<(), String> {
    crate::utils::logger::log("screenshot", "cancel_screenshot command called");
    cleanup_screenshot_session(&app);
    Ok(())
}

/// 从全屏缓存裁剪选区 BGRA：缓存由 start_screenshot 在 overlay 显示前截取，
/// 不含任何截图 UI，故选区框不会被截入；且无需 hide/show overlay，无闪烁。
/// 缓存不可用时回退到实时截屏（罕见，仅在 start_screenshot 截屏失败时）。
fn capture_from_cache(
    cache: &crate::screenshot::ScreenCache,
    left: i32,
    top: i32,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    let guard = cache.pixels.lock().map_err(|e| e.to_string())?;
    if let Some(c) = guard.as_ref() {
        c.crop(left, top, width, height)
    } else {
        crate::utils::logger::log(
            "screenshot",
            "全屏缓存为空，回退实时截屏（可能含 overlay UI）",
        );
        crate::screenshot::capture_screen_region(left, top, width, height)
    }
}

/// 截取屏幕指定区域（物理坐标），返回 PNG base64 与尺寸
#[tauri::command]
pub fn capture_region(
    cache: tauri::State<'_, crate::screenshot::ScreenCache>,
    left: i32,
    top: i32,
    width: i32,
    height: i32,
) -> Result<serde_json::Value, String> {
    crate::utils::logger::log(
        "screenshot",
        &format!("capture_region: ({},{}) {}x{}", left, top, width, height),
    );
    if width <= 0 || height <= 0 {
        return Err("截图区域尺寸无效".into());
    }
    let w = width as u32;
    let h = height as u32;
    let bgra = capture_from_cache(&cache, left, top, w, h)?;
    let b64 = crate::screenshot::encode_png_base64(&bgra, w, h)?;
    Ok(serde_json::json!({
        "pngBase64": b64,
        "width": w,
        "height": h,
    }))
}

/// 将 base64 PNG 写入剪贴板
#[tauri::command]
pub fn clipboard_set_image(
    base64_data: String,
    clipboard: State<'_, ClipboardManager>,
) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let raw = if let Some(idx) = base64_data.find(',') {
        &base64_data[idx + 1..]
    } else {
        &base64_data
    };
    let bytes = STANDARD
        .decode(raw)
        .map_err(|e| format!("base64 解码失败: {}", e))?;
    clipboard.copy_image(&bytes).map_err(|e| e.to_string())
}

/// 对屏幕区域执行 OCR 识别，返回文本
/// async：模型懒加载与识别在 spawn_blocking 阻塞池执行，避免首次使用时阻塞 UI 主线程
#[tauri::command]
pub async fn ocr_region(
    cache: tauri::State<'_, crate::screenshot::ScreenCache>,
    left: i32,
    top: i32,
    width: i32,
    height: i32,
) -> Result<String, String> {
    if width <= 0 || height <= 0 {
        return Err("OCR 区域尺寸无效".into());
    }
    let w = width as u32;
    let h = height as u32;
    crate::utils::logger::log(
        "ocr",
        &format!("ocr_region: ({},{}) {}x{}", left, top, w, h),
    );
    let bgra = capture_from_cache(&cache, left, top, w, h)?;
    tokio::task::spawn_blocking(move || {
        let result = crate::ocr::ensure_ocr_service()
            .ok_or_else(|| "OCR 服务初始化失败".to_string())?
            .lock()
            .map_err(|e| format!("OCR 服务锁失败: {}", e))?
            .recognize_bgra(&bgra, w, h);
        match result {
            Ok(result) => {
                crate::utils::logger::log(
                    "ocr",
                    &format!(
                        "ocr_region completed: engine={}, chars={}, elapsed={}ms",
                        result.engine,
                        result.text.chars().count(),
                        result.elapsed_ms
                    ),
                );
                Ok(result.text)
            }
            Err(error) => {
                crate::utils::logger::log("ocr", &format!("ocr_region failed: {}", error));
                Err(error.to_string())
            }
        }
    })
    .await
    .map_err(|e| format!("OCR 任务执行失败: {}", e))?
}

/// 将截图钉在桌面（创建贴图窗口），返回 pin id
#[tauri::command]
pub fn pin_image(
    app: tauri::AppHandle,
    base64_data: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<u32, String> {
    crate::utils::logger::log(
        "screenshot",
        &format!("pin_image called: ({},{}) {}x{}", x, y, width, height),
    );
    if width <= 0 || height <= 0 {
        return Err("贴图尺寸无效".into());
    }
    let id =
        crate::screenshot::pin::create_pin(&app, &base64_data, x, y, width as u32, height as u32)?;
    crate::utils::logger::log("screenshot", &format!("pin_image created id={}", id));
    Ok(id)
}

/// 关闭指定贴图
#[tauri::command]
pub fn close_pin(app: tauri::AppHandle, id: u32) -> Result<(), String> {
    crate::screenshot::pin::close_pin(&app, id)
}

/// 弹出系统保存对话框，将 base64 编码的 PNG 数据保存为文件
/// 如果配置了截图保存路径，直接保存到该目录（自动生成带时间戳的文件名）；
/// 否则弹出文件保存对话框让用户选择位置
#[tauri::command]
pub async fn save_image(
    app: tauri::AppHandle,
    base64_data: String,
    filename: String,
) -> Result<bool, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    // 去除 data:image/png;base64, 前缀
    let raw = if let Some(idx) = base64_data.find(',') {
        &base64_data[idx + 1..]
    } else {
        &base64_data
    };

    let bytes = STANDARD
        .decode(raw)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    // 检查是否配置了截图保存路径
    let config_manager = app.state::<ConfigManager>();
    let save_path = config_manager.get_screenshot_save_path()?;
    if !save_path.is_empty() {
        let dir = std::path::Path::new(&save_path);
        if dir.is_dir() {
            let now = chrono::Local::now();
            let timestamp = now.format("%Y%m%d_%H%M%S");
            let millis = now.timestamp_subsec_millis();
            let ext = std::path::Path::new(&filename)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("png");
            let auto_filename = format!("screenshot_{}_{}.{}", timestamp, millis, ext);
            let full_path = dir.join(&auto_filename);
            return tokio::task::spawn_blocking(move || {
                std::fs::write(&full_path, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;
                Ok(true)
            })
            .await
            .map_err(|e| format!("任务执行失败: {}", e))?;
        }
        // 配置的目录不存在，回退到对话框模式
    }

    // 将原生保存对话框绑定到截图 overlay。Windows 会以 owner 窗口关系把
    // 对话框置于截图与标注工具之上，同时保留截图画面，行为与 Snipaste 一致。
    // 文字工具栏是独立置顶窗口，临时取消置顶以免压过该模态对话框。
    if let Some(win) = app.get_webview_window("toolbar") {
        let _ = win.set_always_on_top(false);
    }

    let mut dialog = rfd::FileDialog::new()
        .set_file_name(&filename)
        .add_filter("PNG 图片", &["png"]);
    if let Some(overlay) = app.get_webview_window("screenshot-overlay") {
        dialog = dialog.set_parent(&overlay);
    }

    let result = tokio::task::spawn_blocking(move || {
        let path = dialog.save_file();

        match path {
            Some(path) => {
                std::fs::write(&path, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;
                Ok(true)
            }
            None => Ok(false),
        }
    })
    .await; // 不在此处用 ? 提前返回，确保下方 always-on-top 恢复

    // 无论任务结果如何（含 panic/取消），都恢复独立工具栏的置顶状态。
    if let Some(win) = app.get_webview_window("toolbar") {
        let _ = win.set_always_on_top(true);
    }

    result.map_err(|e| format!("任务执行失败: {}", e))?
}

// ─── TTS 朗读 ────────────────────────────────────────────────────

/// TTS 单次合成的字符上限（一次性合成，超长会阻塞且占内存）
const MAX_TTS_CHARS: usize = 5000;

/// 朗读文本。参数：text/rate(字/秒)/voice_id(空=默认)/volume(0~1)。
/// 合成在 MTA 子线程执行（同 OCR 模板），MediaPlayer 非阻塞由 TtsState 持有。
/// 同步命令：合成 .get() 阻塞，由 speak 内部 thread::spawn 隔离，Tauri 命令线程等待 join。
#[tauri::command]
pub fn tts_speak(
    app: tauri::AppHandle,
    text: String,
    rate: f64,
    voice_id: String,
    volume: f64,
) -> Result<(), String> {
    crate::utils::logger::log("tts", &format!("tts_speak: {} chars", text.chars().count()));
    if text.trim().is_empty() {
        return Err("朗读文本不能为空".to_string());
    }
    if text.chars().count() > MAX_TTS_CHARS {
        return Err(format!(
            "文本过长（超过 {} 字），暂不支持朗读",
            MAX_TTS_CHARS
        ));
    }
    crate::tts::speak(app, text, rate, voice_id, volume)
}

/// 停止朗读（Close 销毁 player；stop 内部在 MTA 线程执行 COM 调用）
#[tauri::command]
pub fn tts_stop(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<crate::tts::TtsState>();
    crate::tts::stop(&state)
}

/// 暂停朗读（pause 内部在 MTA 线程执行 COM 调用）
#[tauri::command]
pub fn tts_pause(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<crate::tts::TtsState>();
    crate::tts::pause(&state)
}

/// 继续朗读（resume 内部在 MTA 线程执行 COM 调用）
#[tauri::command]
pub fn tts_resume(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<crate::tts::TtsState>();
    crate::tts::resume(&state)
}

/// 枚举系统已安装语音（list_voices 内部在 MTA 线程执行）
#[tauri::command]
pub fn tts_get_voices() -> Result<Vec<crate::tts::VoiceInfo>, String> {
    crate::tts::list_voices()
}

/// 查询当前播放态快照（供工具栏恢复 speaking 态；仅读 Mutex 无 COM 调用）
#[tauri::command]
pub fn tts_get_state(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<crate::tts::TtsState>();
    let (playing, paused, has_player) = crate::tts::get_state_snapshot(&state);
    Ok(serde_json::json!({
        "playing": playing,
        "paused": paused,
        "hasPlayer": has_player,
    }))
}

/// 查询朗读进度：(positionMs, durationMs, paused)。
/// durationMs 为 0 表示总时长未知（无限时长，实时流等场景）。
/// 无 player 返回 Err，前端忽略即可。
#[tauri::command]
pub fn tts_get_progress(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<crate::tts::TtsState>();
    match crate::tts::get_progress(&state) {
        Some((pos_ms, dur_ms, paused)) => Ok(serde_json::json!({
            "positionMs": pos_ms,
            "durationMs": dur_ms,
            "paused": paused,
        })),
        None => Err("当前没有正在朗读的音频".to_string()),
    }
}

/// 获取 TTS 朗读配置（JSON 字符串，空串表示未设置，前端取默认值）
#[tauri::command]
pub fn get_tts_config(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_tts_config()
}

/// 更新 TTS 朗读配置并持久化
#[tauri::command]
pub fn set_tts_config(
    config: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_tts_config(config)
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
            let x = rc.right as f64 - win_w as f64 - margin;
            let y = rc.bottom as f64 - win_h as f64 - margin;
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

/// 记忆悬浮窗位置（由前端在窗口拖动结束后调用），应用重启后恢复到上次位置。
/// window_id 如 "orb"、"monitor-overlay"、"pomodoro-overlay"
#[tauri::command]
pub fn set_window_position(
    id: String,
    x: i32,
    y: i32,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    // 恢复默认位置期间：程序化 set_position 会触发 onMoved → 前端在 300ms 后再次
    // set_window_position，若不忽略会把刚恢复的默认位置重新记忆。仅忽略对应窗口。
    if let Ok(suppress) = position_save_suppress().lock() {
        if let Some(until) = suppress.get(&id) {
            if now_ms() < *until {
                return Ok(());
            }
        }
    }
    config_manager.set_window_position(&id, crate::config::WindowPosition { x, y })
}

/// 恢复悬浮窗默认位置：清除记忆位置，并将窗口移动到默认定位。
/// window_id 如 "orb"、"monitor-overlay"、"pomodoro-overlay"
#[tauri::command]
pub fn reset_window_position(
    id: String,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.reset_window_position(&id)?;

    let win = match id.as_str() {
        "orb" => app.get_webview_window("orb"),
        "monitor-overlay" => app.get_webview_window("monitor-overlay"),
        "pomodoro-overlay" => app.get_webview_window("pomodoro-overlay"),
        _ => None,
    };
    // 对已存在窗口统一移动到默认定位（隐藏窗口 set_position 同样生效，下次显示即默认位置）。
    // monitor 下次显示时按未记忆逻辑跟随鼠标重新定位；pomodoro 无记忆时保持此位置。
    if let Some(win) = win {
        let inner = win.inner_size().unwrap_or_default();
        let (x, y) = default_window_position(&id, inner.width as i32, inner.height as i32);
        // 抑制程序化移动触发的 onMoved 保存（前端 300ms 后调用 set_window_position）
        if let Ok(mut suppress) = position_save_suppress().lock() {
            suppress.insert(id.clone(), now_ms() + 1500);
        }
        win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 显示系统监控悬浮窗（优先恢复到上次记忆位置，未记忆时跟随鼠标，多显示器边界翻转）
/// 并启动采集线程
#[tauri::command]
pub fn show_monitor_window(
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let win = app
        .get_webview_window("monitor-overlay")
        .ok_or_else(|| "monitor-overlay 窗口未找到".to_string())?;
    // Use the saved mode before showing so the window never flashes at the wrong size.
    let is_mini = config_manager
        .get_system_monitor_config()
        .ok()
        .and_then(|config| serde_json::from_str::<serde_json::Value>(&config).ok())
        .and_then(|config| config.get("displayMode")?.as_str().map(str::to_owned))
        .is_some_and(|mode| mode == "mini");
    let (width, height) = if is_mini { (300.0, 180.0) } else { (300.0, 520.0) };
    win.set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    // 拦截关闭：停止采集并隐藏，保留窗口实例供下次打开复用。
    // 前端现复用窗口（不再每次销毁重建），监听器随窗口长期有效，故只注册一次；
    // 若窗口仍被真正销毁（异常路径），其上的监听器随之失效，此处监听 Destroyed
    // 复位注册标记，使新建窗口能重新注册拦截——否则 Alt+F4 会直接关窗而不停采，
    // 后台采集线程空跑。与 screenshot overlay 的关闭拦截处理方式一致。
    if MONITOR_CLOSE_HANDLER_REGISTERED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let win_on_close = win.clone();
        let app_on_close = app.clone();
        win.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if let Some(state) = app_on_close.try_state::<crate::monitor::MonitorState>() {
                    state.stop();
                }
                let _ = win_on_close.hide();
            }
            tauri::WindowEvent::Destroyed => {
                MONITOR_CLOSE_HANDLER_REGISTERED.store(false, Ordering::SeqCst);
            }
            _ => {}
        });
    }
    let inner = win.inner_size().unwrap_or_default();
    let ww = inner.width as i32;
    let wh = inner.height as i32;

    // 锚点：优先恢复上次拖拽后的记忆位置，未记忆时跟随鼠标，偏移 8px
    let saved = config_manager
        .get_window_position("monitor-overlay")
        .ok()
        .flatten();
    let (mut x, mut y) = if let Some(pos) = saved {
        (pos.x, pos.y)
    } else if let Ok(cur) = crate::automation::get_mouse_position() {
        (cur.x + 8, cur.y + 8)
    } else {
        (100, 100)
    };

    // 边界翻转：不超过该点所在显示器工作区
    (x, y) = clamp_position_to_workarea(x, y, ww, wh);

    let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        x, y,
    )));
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;

    // 启动采集线程前，从配置同步刷新间隔（避免 state 默认值与用户配置不符）
    if let Some(state) = app.try_state::<crate::monitor::MonitorState>() {
        if let Ok(interval) = config_manager.get_system_monitor_interval_ms() {
            if interval >= 200 {
                state.set_interval(interval);
            }
        }
        state.start(&app);
    }
    Ok(())
}

/// 隐藏系统监控悬浮窗并停止采集线程。窗口保留以避免再次打开时与销毁竞态。
#[tauri::command]
pub fn hide_monitor_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<crate::monitor::MonitorState>() {
        state.stop();
    }
    if let Some(window) = app.get_webview_window("monitor-overlay") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 获取系统监控工具启用状态
#[tauri::command]
pub fn get_system_monitor_enabled(
    config_manager: State<'_, ConfigManager>,
) -> Result<bool, String> {
    config_manager.get_system_monitor_enabled()
}

/// 设置系统监控工具启用状态并持久化。禁用时停采并隐藏窗口，避免重启销毁竞态。
#[tauri::command]
pub fn set_system_monitor_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    if !enabled {
        if let Some(state) = app.try_state::<crate::monitor::MonitorState>() {
            state.stop();
        }
        if let Some(window) = app.get_webview_window("monitor-overlay") {
            let _ = window.hide();
        }
    }
    config_manager.update_system_monitor_enabled(enabled)
}

/// 获取系统监控配置（JSON 字符串，空串表示未设置）
#[tauri::command]
pub fn get_system_monitor_config(
    config_manager: State<'_, ConfigManager>,
) -> Result<String, String> {
    config_manager.get_system_monitor_config()
}

/// 更新系统监控配置并持久化。解析 intervalMs 即时生效（无需重启采集线程）
#[tauri::command]
pub fn set_system_monitor_config(
    config: String,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    // 解析 intervalMs 即时下发到采集线程
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&config) {
        if let Some(ms) = parsed.get("intervalMs").and_then(|v| v.as_u64()) {
            if let Some(state) = app.try_state::<crate::monitor::MonitorState>() {
                state.set_interval(ms);
            }
            let _ = config_manager.update_system_monitor_interval_ms(ms);
        }
    }
    config_manager.update_system_monitor_config(config)
}

// ─── 番茄钟 ────────────────────────────────────────────────────

/// 显示番茄钟悬浮窗。关闭拦截仅隐藏窗口、不停计时（窗口隐藏后倒计时继续，
/// 到点提醒由后端完成，不依赖窗口可见）。
#[tauri::command]
pub fn show_pomodoro_window(
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let win = app
        .get_webview_window("pomodoro-overlay")
        .ok_or_else(|| "pomodoro-overlay 窗口未找到".to_string())?;
    // Use the saved mode before showing so the window never flashes at the wrong size.
    let is_mini = config_manager
        .get_pomodoro_config()
        .ok()
        .and_then(|config| serde_json::from_str::<serde_json::Value>(&config).ok())
        .and_then(|config| config.get("displayMode")?.as_str().map(str::to_owned))
        .is_some_and(|mode| mode == "mini");
    let (width, height) = if is_mini { (150.0, 182.0) } else { (240.0, 260.0) };
    win.set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    // 拦截关闭：仅隐藏，不停计时。窗口复用后监听器也会保留，因此只注册一次。
    if !POMODORO_CLOSE_HANDLER_REGISTERED.swap(true, Ordering::SeqCst) {
        let win_on_close = win.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = win_on_close.hide();
            }
        });
    }
    // 恢复上次拖拽后的记忆位置（窗口销毁重建后仍保持），未记忆时使用创建默认值。
    // 仅窗口隐藏时恢复，避免覆盖用户已摆好/正在拖动的位置；裁剪到显示器工作区，
    // 防止分辨率/显示器布局变化后窗口跑到屏幕外
    if !win.is_visible().unwrap_or(true) {
        if let Ok(Some(pos)) = config_manager.get_window_position("pomodoro-overlay") {
            let inner = win.inner_size().unwrap_or_default();
            let (x, y) =
                clamp_position_to_workarea(pos.x, pos.y, inner.width as i32, inner.height as i32);
            win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
                x, y,
            )))
            .map_err(|e| e.to_string())?;
        }
    }
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// 隐藏番茄钟悬浮窗。计时不停止（与系统监控不同）。
#[tauri::command]
pub fn hide_pomodoro_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("pomodoro-overlay") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 获取番茄钟当前状态（窗口重开/初始化时拉取，前端据此恢复渲染）
#[tauri::command]
pub fn get_pomodoro_state(
    state: State<'_, crate::pomodoro::PomodoroState>,
) -> Result<crate::pomodoro::PomodoroStatePayload, String> {
    Ok(state.payload())
}

/// 开始/继续番茄钟倒计时
#[tauri::command]
pub fn start_pomodoro(
    app: tauri::AppHandle,
    state: State<'_, crate::pomodoro::PomodoroState>,
) -> Result<(), String> {
    state.start(&app);
    Ok(())
}

/// 暂停番茄钟倒计时（保留剩余时间）
#[tauri::command]
pub fn pause_pomodoro(
    app: tauri::AppHandle,
    state: State<'_, crate::pomodoro::PomodoroState>,
) -> Result<(), String> {
    state.pause();
    let _ = app.emit("pomodoro-tick", state.payload());
    Ok(())
}

/// 重置当前阶段倒计时
#[tauri::command]
pub fn reset_pomodoro(
    app: tauri::AppHandle,
    state: State<'_, crate::pomodoro::PomodoroState>,
) -> Result<(), String> {
    state.reset();
    let _ = app.emit("pomodoro-tick", state.payload());
    Ok(())
}

/// 跳过当前阶段进入下一阶段（计时中则继续计时新阶段）
#[tauri::command]
pub fn skip_pomodoro(
    app: tauri::AppHandle,
    state: State<'_, crate::pomodoro::PomodoroState>,
) -> Result<(), String> {
    let was_running = state.skip();
    if was_running {
        state.start(&app);
    } else {
        let _ = app.emit("pomodoro-tick", state.payload());
    }
    Ok(())
}

/// 获取番茄钟工具启用状态
#[tauri::command]
pub fn get_pomodoro_enabled(
    config_manager: State<'_, ConfigManager>,
) -> Result<bool, String> {
    config_manager.get_pomodoro_enabled()
}

/// 设置番茄钟工具启用状态并持久化。禁用时停止计时并隐藏窗口。
#[tauri::command]
pub fn set_pomodoro_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    if !enabled {
        if let Some(state) = app.try_state::<crate::pomodoro::PomodoroState>() {
            state.stop();
            // 通知番茄钟窗口同步停止状态（窗口隐藏时 JS 仍在运行，可收到事件；
            // 否则重新打开后 UI 会停留在旧的运行态）
            let _ = app.emit("pomodoro-tick", state.payload());
        }
        if let Some(window) = app.get_webview_window("pomodoro-overlay") {
            let _ = window.hide();
        }
    }
    config_manager.update_pomodoro_enabled(enabled)
}

/// 获取番茄钟配置（JSON 字符串，空串表示未设置，前端取默认值）
#[tauri::command]
pub fn get_pomodoro_config(
    config_manager: State<'_, ConfigManager>,
) -> Result<String, String> {
    config_manager.get_pomodoro_config()
}

/// 更新番茄钟配置并持久化。解析成功时即时同步到计时状态（不中断计时）。
#[tauri::command]
pub fn set_pomodoro_config(
    config: String,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    if let Ok(parsed) = serde_json::from_str::<crate::pomodoro::PomodoroConfig>(&config) {
        if let Some(state) = app.try_state::<crate::pomodoro::PomodoroState>() {
            state.set_config(parsed);
        }
    }
    config_manager.update_pomodoro_config(config)
}

// ─── OCR 引擎管理 ─────────────────────────────────────────────────

/// 获取可用 OCR 引擎列表及当前激活引擎
/// async：懒加载在 spawn_blocking 阻塞池执行，避免首次打开设置页时阻塞 UI 主线程
#[tauri::command]
pub async fn get_ocr_engines() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(|| {
        let svc = crate::ocr::ensure_ocr_service().ok_or("OCR 服务初始化失败")?;
        let guard = svc.lock().map_err(|e| format!("OCR 服务锁失败: {}", e))?;
        let engines: Vec<&str> = guard
            .available_engines()
            .iter()
            .map(|e| e.as_str())
            .collect();
        Ok(serde_json::json!({
            "active": guard.active_engine_name(),
            "available": engines,
        }))
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 切换 OCR 引擎，并将用户偏好持久化到配置（重启后保持所选引擎）
#[tauri::command]
pub async fn set_ocr_engine(
    engine: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let id = crate::ocr::EngineId::from_str(&engine)
        .ok_or_else(|| format!("无效的引擎标识: {}", engine))?;

    // 在阻塞池切换引擎（加载模型/初始化可能耗时）。
    // 返回切换前的激活引擎，供持久化失败时回滚，保证内存引擎与 UI 显示一致。
    let previous = tokio::task::spawn_blocking(move || -> Result<crate::ocr::EngineId, String> {
        let svc = crate::ocr::ensure_ocr_service().ok_or("OCR 服务初始化失败")?;
        let mut guard = svc.lock().map_err(|e| format!("OCR 服务锁失败: {}", e))?;
        let previous = guard.active_engine;
        if !guard.switch_engine(id) {
            return Err(format!("引擎 '{}' 不可用", id.as_str()));
        }
        Ok(previous)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    // 持久化用户偏好（写入规范化引擎 ID）；失败时回滚内存引擎，避免 UI 显示与实际引擎脱节
    if let Err(error) = config_manager.update_ocr_engine(id.as_str().to_string()) {
        let rollback = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let svc = crate::ocr::ensure_ocr_service().ok_or("OCR 服务初始化失败")?;
            let mut guard = svc.lock().map_err(|e| format!("OCR 服务锁失败: {}", e))?;
            // 仅当内存引擎仍是我这次设置的才回滚，避免覆盖并发更新的引擎选择
            if guard.active_engine == id {
                let _ = guard.switch_engine(previous);
            }
            Ok(())
        })
        .await;
        if let Err(rollback_err) = rollback {
            crate::utils::logger::log(
                "ocr",
                &format!("OCR 引擎持久化失败后回滚出错: {}", rollback_err),
            );
        }
        return Err(error);
    }

    // 同步全局偏好变量（防御：服务当前不会重建，但若未来出现重建路径偏好仍正确）
    crate::ocr::set_preferred_engine(Some(id));
    Ok(())
}

// ─── 录屏 ────────────────────────────────────────────────────────

/// 进入录屏选区模式：显示 overlay 并通知前端切换到录制模式
pub fn start_recording_select_inner(app: tauri::AppHandle) -> Result<(), String> {
    crate::utils::logger::log("recording", "start_recording_select called");

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
        CAPTURE_SESSION_ACTIVE.store(true, Ordering::SeqCst);
    }
    crate::hooks::mouse::set_recording_mode(true);

    // 隐藏浮动 UI，避免被截入
    if let Some(w) = app.get_webview_window("orb") {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window("toolbar") {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window("palette") {
        let _ = w.hide();
    }

    // 等一帧让 UI 消失
    std::thread::sleep(std::time::Duration::from_millis(20));

    let overlay = match app.get_webview_window("screenshot-overlay") {
        Some(window) => window,
        None => {
            let _ = cancel_recording_select(app.clone());
            return Err("recording overlay window was not found".to_string());
        }
    };
    if let Err(error) = overlay.set_ignore_cursor_events(false) {
        let _ = cancel_recording_select(app.clone());
        return Err(error.to_string());
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
        let _ = cancel_recording_select(app.clone());
        return Err("recording overlay HWND did not become ready".to_string());
    }

    let bounds = match crate::screenshot::virtual_desktop_bounds() {
        Ok(bounds) => bounds,
        Err(error) => {
            let _ = cancel_recording_select(app.clone());
            return Err(error);
        }
    };
    if let Err(error) = overlay.set_position(tauri::Position::Physical(
        tauri::PhysicalPosition::new(bounds.origin_x, bounds.origin_y),
    )) {
        let _ = cancel_recording_select(app.clone());
        return Err(error.to_string());
    }
    if let Err(error) = overlay.set_size(tauri::PhysicalSize::new(bounds.width, bounds.height)) {
        let _ = cancel_recording_select(app.clone());
        return Err(error.to_string());
    }
    if let Err(error) = overlay.show() {
        let _ = cancel_recording_select(app.clone());
        return Err(error.to_string());
    }
    if let Err(error) = overlay.set_focus() {
        let _ = cancel_recording_select(app.clone());
        return Err(error.to_string());
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
                    if let Some(state) = app_on_close.try_state::<crate::recording::RecordingState>() {
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
    let _ = app_switch.emit_to("screenshot-overlay", "recording-select-switch", ());

    let app_emit = app.clone();
    std::thread::spawn(move || {
        // 等待前端加载完毕
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = app_emit.emit_to("screenshot-overlay", "recording-select-start", ());
    });

    Ok(())
}

/// Tauri 命令包装：进入录屏选区模式
#[tauri::command]
pub fn start_recording_select(app: tauri::AppHandle) -> Result<(), String> {
    start_recording_select_inner(app)
}

/// 开始录制（区域+模式+fps 已确定）
#[tauri::command]
pub fn start_recording(
    app: tauri::AppHandle,
    left: i32,
    top: i32,
    width: u32,
    height: u32,
    mode: String,
    fps: u32,
    max_duration_sec: u32,
) -> Result<(), String> {
    if width == 0 || height == 0 || width > 32_768 || height > 32_768 {
        return Err("invalid recording dimensions".to_string());
    }
    if u64::from(width) * u64::from(height) > 100_000_000 {
        return Err("recording region contains too many pixels".to_string());
    }
    if !(1..=60).contains(&max_duration_sec) {
        return Err("recording duration must be between 1 and 60 seconds".to_string());
    }
    crate::utils::logger::log(
        "recording",
        &format!("start_recording: ({},{}) {}x{}, mode={}, fps={}", left, top, width, height, mode, fps),
    );

    let record_mode = match mode.as_str() {
        "gif" => crate::recording::RecordMode::Gif,
        "video" => crate::recording::RecordMode::Video,
        _ => return Err(format!("无效的录制模式: {}", mode)),
    };

    let region = crate::recording::RecordRegion {
        left,
        top,
        width,
        height,
    };

    let state = app.state::<crate::recording::RecordingState>();
    // Enable exclusion before the worker can capture its first frame.
    set_recording_capture_protection(&app);
    if let Err(error) = state.start(&app, region, record_mode, fps, max_duration_sec) {
        set_recording_capture_protection(&app);
        return Err(error);
    }
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

/// The control window is created asynchronously by the frontend. This command
/// only makes the full-screen selection overlay click-through.
#[tauri::command]
pub fn show_recording_controls(app: tauri::AppHandle) -> Result<(), String> {
    set_recording_capture_protection(&app);
    if let Some(overlay) = app.get_webview_window("screenshot-overlay") {
        overlay
            .set_ignore_cursor_events(true)
            .map_err(|error| error.to_string())?;
    }
    let _ = app.emit("recording-controls-started", ());
    Ok(())
}

/// Destroy recording controls and restore interaction with the main overlay.
#[tauri::command]
pub fn finish_recording_controls(app: tauri::AppHandle) -> Result<(), String> {
    destroy_recording_controls_window(&app);
    set_recording_capture_protection(&app);
    crate::hooks::mouse::set_recording_mode(false);
    if let Some(overlay) = app.get_webview_window("screenshot-overlay") {
        overlay
            .set_ignore_cursor_events(false)
            .map_err(|error| error.to_string())?;
    }
    let _ = app.emit("recording-controls-finished", ());
    Ok(())
}

/// 暂停录制
#[tauri::command]
pub fn pause_recording(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<crate::recording::RecordingState>();
    state.pause()?;
    let _ = app.emit("recording-paused", ());
    Ok(())
}

/// 恢复录制
#[tauri::command]
pub fn resume_recording(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<crate::recording::RecordingState>();
    state.resume()?;
    let _ = app.emit("recording-resumed", ());
    Ok(())
}

/// 停止录制并编码
#[tauri::command]
pub fn stop_recording(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<crate::recording::RecordingState>();
    state.stop()?;
    crate::hooks::mouse::set_recording_mode(false);
    finish_recording_controls(app)
}

/// 取消录制（丢弃）
#[tauri::command]
pub fn cancel_recording(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<crate::recording::RecordingState>();
    state.cancel()?;
    finish_recording_controls(app)
}

/// Cancel an active recording and leave the selection overlay in one native
/// operation. This is used by the control window, which is destroyed during
/// cleanup and therefore cannot safely issue a follow-up frontend command.
#[tauri::command]
pub fn cancel_recording_and_select(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<crate::recording::RecordingState>();
    state.cancel()?;
    cancel_recording_select(app)
}

/// 获取录制状态快照
#[tauri::command]
pub fn get_recording_state(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<crate::recording::RecordingState>();
    Ok(serde_json::json!({
        "running": state.is_running(),
        "paused": state.is_paused(),
        "elapsedMs": state.elapsed_ms(),
        "frameCount": state.frame_count(),
        "mode": state.get_mode().map(|m| match m {
            crate::recording::RecordMode::Gif => "gif",
            crate::recording::RecordMode::Video => "video",
        }),
    }))
}

/// 查询当前是否处于录制选区模式（前端 OverlaySwitcher 挂载时调用，
/// 防止首次创建 overlay 窗口时 recording-select-switch 事件丢失导致模式不正确）
#[tauri::command]
pub fn is_recording_select_active() -> bool {
    crate::hooks::mouse::is_recording_mode()
}

/// 复制 GIF 到剪贴板
/// 写入注册的 "GIF" 格式保留完整动画，同时写入 CF_DIB 位图（首帧）作为通用兼容回退
#[tauri::command]
pub fn clipboard_set_gif(
    base64_data: String,
    clipboard: State<'_, ClipboardManager>,
) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let raw = if let Some(idx) = base64_data.find(',') {
        &base64_data[idx + 1..]
    } else {
        &base64_data
    };
    let bytes = STANDARD
        .decode(raw)
        .map_err(|e| format!("base64 解码失败: {}", e))?;
    clipboard.copy_gif(&bytes).map_err(|e| e.to_string())
}

/// 保存 GIF 文件
/// 如果配置了录屏保存路径，直接保存到该目录（自动生成带时间戳的文件名）；
/// 否则弹出文件保存对话框让用户选择位置
#[tauri::command]
pub async fn save_gif(
    app: tauri::AppHandle,
    base64_data: String,
    filename: String,
) -> Result<bool, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let raw = if let Some(idx) = base64_data.find(',') {
        &base64_data[idx + 1..]
    } else {
        &base64_data
    };
    let bytes = STANDARD
        .decode(raw)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    // 检查是否配置了录屏保存路径
    let config_manager = app.state::<ConfigManager>();
    let save_path = config_manager.get_recording_save_path()?;
    if !save_path.is_empty() {
        let dir = std::path::Path::new(&save_path);
        if dir.is_dir() {
            // 生成带时间戳的文件名：recording_20260714_153020_123.gif
            let now = chrono::Local::now();
            let timestamp = now.format("%Y%m%d_%H%M%S");
            let millis = now.timestamp_subsec_millis();
            let ext = std::path::Path::new(&filename)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("gif");
            let auto_filename = format!("recording_{}_{}.{}", timestamp, millis, ext);
            let full_path = dir.join(&auto_filename);
            tokio::task::spawn_blocking(move || {
                std::fs::write(&full_path, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;
                Ok(true)
            })
            .await
            .map_err(|e| format!("任务执行失败: {}", e))?
        } else {
            // 配置的目录不存在，回退到对话框模式
            save_gif_with_dialog(&app, &bytes, &filename).await
        }
    } else {
        save_gif_with_dialog(&app, &bytes, &filename).await
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
    tokio::task::spawn_blocking(move || {
        match dialog.save_file() {
            Some(path) => {
                std::fs::write(&path, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;
                Ok(true)
            }
            None => Ok(false),
        }
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 保存已编码的临时视频文件，避免把大体积 MP4 通过 IPC/base64 往返传输。
#[tauri::command]
pub async fn save_video_file(
    app: tauri::AppHandle,
    source_path: String,
    filename: String,
) -> Result<bool, String> {
    let source = std::path::PathBuf::from(&source_path);
    if !source.is_file() {
        return Err("视频文件不存在或已被清理".to_string());
    }
    let source = source
        .canonicalize()
        .map_err(|e| format!("读取视频文件失败: {}", e))?;
    let recording_temp_dir = std::env::temp_dir()
        .join("levitaire-recording")
        .canonicalize()
        .map_err(|e| format!("读取录屏临时目录失败: {}", e))?;
    if !source.starts_with(&recording_temp_dir) {
        return Err("视频文件不在录屏临时目录中".to_string());
    }

    let config_manager = app.state::<ConfigManager>();
    let save_path = config_manager.get_recording_save_path()?;
    if !save_path.is_empty() {
        let dir = std::path::Path::new(&save_path);
        if dir.is_dir() {
            let now = chrono::Local::now();
            let timestamp = now.format("%Y%m%d_%H%M%S");
            let millis = now.timestamp_subsec_millis();
            let ext = std::path::Path::new(&filename)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("mp4");
            let auto_filename = format!("recording_{}_{}.{}", timestamp, millis, ext);
            let target = dir.join(&auto_filename);
            tokio::task::spawn_blocking(move || {
                std::fs::copy(&source, &target).map_err(|e| format!("写入文件失败: {}", e))?;
                Ok(true)
            })
            .await
            .map_err(|e| format!("任务执行失败: {}", e))?
        } else {
            save_video_file_with_dialog(&app, &source, &filename).await
        }
    } else {
        save_video_file_with_dialog(&app, &source, &filename).await
    }
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
    tokio::task::spawn_blocking(move || {
        match dialog.save_file() {
            Some(path) => {
                std::fs::copy(&source, &path).map_err(|e| format!("写入文件失败: {}", e))?;
                Ok(true)
            }
            None => Ok(false),
        }
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 枚举可见窗口（窗口识别模式）
#[tauri::command]
pub fn enumerate_windows() -> Result<Vec<crate::recording::window_detect::WindowInfo>, String> {
    Ok(crate::recording::window_detect::enumerate_windows())
}

/// 获取录屏工具启用状态
#[tauri::command]
pub fn get_recording_enabled(config_manager: State<'_, ConfigManager>) -> Result<bool, String> {
    config_manager.get_recording_enabled()
}

/// 设置录屏工具启用状态并持久化
#[tauri::command]
pub fn set_recording_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_recording_enabled(enabled)?;
    crate::hooks::hotkey::set_slot_enabled(crate::hooks::hotkey::HotkeySlotId::Recording, enabled);
    if !enabled {
        // 禁用时退出所有录制状态，包括独立控制窗和鼠标穿透 overlay。
        let state = app.state::<crate::recording::RecordingState>();
        if state.is_running() {
            let _ = state.cancel();
        }
        let _ = cancel_recording_select(app.clone());
    }
    Ok(())
}

/// 获取录屏快捷键
#[tauri::command]
pub fn get_recording_hotkey(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_recording_hotkey()
}

/// 设置录屏快捷键
#[tauri::command]
pub fn set_recording_hotkey(
    hotkey: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let trimmed = hotkey.trim().to_string();
    let slot = crate::hooks::hotkey::HotkeySlotId::Recording;
    let previous = config_manager.get_recording_hotkey()?;
    if trimmed.is_empty() {
        crate::hooks::hotkey::unregister_hotkey(slot);
        if let Err(error) = config_manager.update_recording_hotkey(String::new()) {
            if !previous.is_empty() {
                let _ = crate::hooks::hotkey::register_hotkey(slot, &previous);
            }
            return Err(error);
        }
        return Ok(());
    }
    crate::hooks::hotkey::register_hotkey(slot, &trimmed)?;
    if let Err(error) = config_manager.update_recording_hotkey(trimmed) {
        if previous.is_empty() {
            crate::hooks::hotkey::unregister_hotkey(slot);
        } else {
            let _ = crate::hooks::hotkey::register_hotkey(slot, &previous);
        }
        return Err(error);
    }
    Ok(())
}

/// 获取录屏配置（JSON 字符串，空串表示未设置）
#[tauri::command]
pub fn get_recording_config(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_recording_config()
}

/// 更新录屏配置并持久化
#[tauri::command]
pub fn set_recording_config(
    config: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_recording_config(config)
}

/// 获取录屏文件保存路径（空串表示未设置，每次保存时弹出对话框）
#[tauri::command]
pub fn get_recording_save_path(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_recording_save_path()
}

/// 更新录屏文件保存路径并持久化
#[tauri::command]
pub fn set_recording_save_path(
    path: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_recording_save_path(path)
}

/// 获取截图文件保存路径（空串表示未设置，每次保存时弹出对话框）
#[tauri::command]
pub fn get_screenshot_save_path(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_screenshot_save_path()
}

/// 更新截图文件保存路径并持久化
#[tauri::command]
pub fn set_screenshot_save_path(
    path: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_screenshot_save_path(path)
}

/// 打开文件夹选择对话框，返回用户选择的目录路径；取消返回 null
#[tauri::command]
pub async fn pick_folder() -> Result<Option<String>, String> {
    let result = rfd::AsyncFileDialog::new()
        .set_title("选择文件夹")
        .pick_folder()
        .await;
    Ok(result.map(|f| {
        let path = f.path();
        path.to_string_lossy().to_string()
    }))
}

/// 获取自启动工具 ID 列表
#[tauri::command]
pub fn get_tools_autostart(
    config_manager: State<'_, ConfigManager>,
) -> Result<Vec<String>, String> {
    config_manager.get_tools_autostart()
}

/// 设置自启动工具 ID 列表并持久化
#[tauri::command]
pub fn set_tools_autostart(
    ids: Vec<String>,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_tools_autostart(ids)
}

/// 退出录制选区模式（前端选区取消时调用）
#[tauri::command]
pub fn cancel_recording_select(app: tauri::AppHandle) -> Result<(), String> {
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
    // 会话结束，复位活跃标记，避免泄漏到后续空闲清理误判
    CAPTURE_SESSION_ACTIVE.store(false, Ordering::SeqCst);
    // 通知前端恢复截图模式
    let _ = app.emit_to("screenshot-overlay", "recording-select-cancel", ());
    Ok(())
}

// ─── 快速输入转盘工具 ────────────────────────────────────────────

#[tauri::command]
pub fn get_quick_input_enabled(config: State<'_, ConfigManager>) -> Result<bool, String> {
    config.get_quick_input_enabled()
}

#[tauri::command]
pub fn set_quick_input_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config: State<'_, ConfigManager>,
) -> Result<(), String> {
    config.update_quick_input_enabled(enabled)?;
    // 启用时先确保转盘 overlay 窗口已创建（隐藏），再让触发键生效，
    // 避免「触发键已生效但窗口尚未建好」的窗口期内按下触发键时 begin_wheel
    // emit_to 静默失败且 QUICK_INPUT_ACTIVE 卡在 true（会导致鼠标点击被吞）。
    if enabled {
        crate::quick_input::ensure_window(&app)?;
    } else {
        // 禁用时若转盘正处于激活态，先退出并复位。否则 QUICK_INPUT_ACTIVE 会停留
        // 在 true，且 vk 已被置 0 无法再通过触发键 toggle 恢复，导致鼠标左键被持续吞掉。
        // end_wheel(None) 即“取消”语义，前端收到后会收起转盘并复位状态。
        if crate::quick_input::is_active() {
            crate::quick_input::end_wheel(&app, None);
        }
    }
    // 同步触发键到 keyboard hook（启用且配置了有效键才生效）
    sync_quick_input_trigger(&config)?;
    Ok(())
}

#[tauri::command]
pub fn get_quick_input_trigger_key(config: State<'_, ConfigManager>) -> Result<String, String> {
    let key = config.get_quick_input_trigger_key()?;
    if key.is_empty() {
        Ok("CapsLock".to_string())
    } else {
        Ok(key)
    }
}

#[tauri::command]
pub fn set_quick_input_trigger_key(
    key: String,
    config: State<'_, ConfigManager>,
) -> Result<(), String> {
    // 校验键名可解析
    let vk = match crate::quick_input::parse_trigger_key(&key) {
        Some(vk) => vk,
        None => return Err(format!("无法识别的触发键: {}", key)),
    };
    // 阻止会把全局键盘输入都吞掉的键（字母/数字/编辑导航区），避免影响所有程序的输入
    if crate::quick_input::is_dangerous_trigger_vk(vk) {
        return Err("该键在日常输入中会频繁用到，被设为触发键会中断正常打字。请选用功能键、CapsLock、ScrollLock 等锁定键作为触发键。".to_string());
    }
    config.update_quick_input_trigger_key(key)?;
    sync_quick_input_trigger(&config)?;
    Ok(())
}

/// 获取快速输入转盘触发模式（"click" 单击切换 | "hold" 按住唤起）
#[tauri::command]
pub fn get_quick_input_mode(config: State<'_, ConfigManager>) -> Result<String, String> {
    let mode = config.get_quick_input_mode()?;
    if mode.is_empty() {
        Ok("click".to_string())
    } else {
        Ok(mode)
    }
}

/// 设置快速输入转盘触发模式（"click" 单击切换 | "hold" 按住唤起）
#[tauri::command]
pub fn set_quick_input_mode(
    mode: String,
    config: State<'_, ConfigManager>,
) -> Result<(), String> {
    let normalized = mode.trim().to_lowercase();
    if normalized != "click" && normalized != "hold" {
        return Err(format!("无法识别的触发模式: {}", mode));
    }
    config.update_quick_input_mode(normalized)?;
    sync_quick_input_trigger(&config)?;
    Ok(())
}

/// 前端在转盘内移动鼠标时同步当前高亮扇区索引（-1 = 无选中），
/// 供「按住唤起」模式在松开触发键时读取并作为选中项。
#[tauri::command]
pub fn set_quick_input_highlight(index: i32) -> Result<(), String> {
    crate::quick_input::set_highlight(index);
    Ok(())
}

#[tauri::command]
pub fn get_quick_input_snippets(config: State<'_, ConfigManager>) -> Result<String, String> {
    config.get_quick_input_snippets()
}

#[tauri::command]
pub fn set_quick_input_snippets(
    snippets: String,
    config: State<'_, ConfigManager>,
) -> Result<(), String> {
    config.update_quick_input_snippets(snippets)
}

#[tauri::command]
pub fn get_quick_input_history() -> Result<Vec<crate::quick_input::ClipboardHistoryItem>, String> {
    Ok(crate::quick_input::get_history())
}

#[tauri::command]
pub fn clear_quick_input_history() -> Result<(), String> {
    crate::quick_input::clear_history();
    Ok(())
}

/// 选中某项后输入文本到当前焦点输入框（写剪贴板 + 模拟 Ctrl+V + 恢复原内容）
#[tauri::command]
pub fn quick_input_paste(text: String) -> Result<(), String> {
    crate::quick_input::type_text_async(text);
    Ok(())
}

/// 点击切换快速输入转盘：当前已激活则关闭（取消），否则打开并定位到鼠标处。
/// 供前端（悬浮工具面板点击「快速输入」卡片）唤起转盘，语义与触发键单击一致。
/// 打开前先确保 overlay 窗口已创建，避免运行时启用后立即点击唤起时窗口尚未就绪而静默失败。
#[tauri::command]
pub fn toggle_quick_input_wheel(app: tauri::AppHandle) -> Result<(), String> {
    // 若窗口不存在则先创建（隐藏），保证 begin_wheel 的 emit_to 有目标可投递
    crate::quick_input::ensure_window(&app)?;
    crate::quick_input::toggle_wheel(&app);
    Ok(())
}


/// 预创建快速输入转盘窗口（隐藏）。工具启用时由前端调用一次；
/// 应用启动时也会在 main.rs 的 setup 中调用（quick_input::ensure_window），
/// 确保重启后键盘钩子触发时 emit_to 能找到目标窗口。
/// 窗口透明、无边框、置顶、不可聚焦（绝不抢焦点，目标输入框需保持焦点）。
#[tauri::command]
pub async fn ensure_quick_input_window(app: tauri::AppHandle) -> Result<(), String> {
    crate::quick_input::ensure_window(&app)
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
