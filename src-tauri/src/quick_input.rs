//! 快速输入转盘工具 —— 状态管理与命令实现。
//!
//! 交互流程（武器轮盘式，点击切换）：
//! 1. 用户点击触发键（默认 CapsLock）→ keyboard hook 检测 keydown
//! 2. 进入 quick_input_mode：mouse hook 开始 emit "quick-input-mouse-move" {x,y}
//!    前端显示以触键为中心的转盘，根据鼠标角度高亮扇区
//! 3. 用户再次点击触发键 → keydown → toggle_wheel 关闭并取消；或
//!    在目标扇区单击鼠标 → mouse hook 捕获点击 → emit "quick-input-click"，前端按当前高亮输入
//! 4. 前端关闭转盘，若选中了某项则调用 quick_input_paste 输入文本
//!
//! 转盘窗口 focusable=false，绝不抢焦点（目标输入框需保持焦点接收 Ctrl+V）。
//! 鼠标移动/点击事件由后端 hook emit，不依赖前端 DOM（无焦点窗口收不到 DOM 事件）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicPtr, AtomicU16, AtomicU64, AtomicU8, Ordering};
#[cfg(not(test))]
use std::sync::OnceLock;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;

// ─── 转盘模式状态 ──────────────────────────────────────────────

/// 是否处于转盘模式（mouse hook 据此决定是否 emit 鼠标移动）
static QUICK_INPUT_ACTIVE: AtomicBool = AtomicBool::new(false);

/// overlay 窗口的 HWND（ensure_window 创建后缓存）。
/// 钩子线程用 IsWindowVisible 直接查询可见性，避免调用 get_webview_window
/// 争用 Tauri 内部窗口锁（设置窗口创建期间可能阻塞钩子回调导致被系统卸载）。
static OVERLAY_HWND: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());

/// 转盘激活状态的起始时间戳（毫秒），用于区分「正在显示中」与「激活卡死」
static QUICK_INPUT_ACTIVE_AT: AtomicU64 = AtomicU64::new(0);

/// 自愈阈值：active 置位后转盘持续不可见超过该时长才判定为卡死并自愈复位。
/// 避免误伤「刚触发、窗口正在 show」窗口期内的快速二次触发（该窗口期应正常走关闭分支）。
const WHEEL_HEAL_AFTER_MS: u64 = 400;

/// 触发键的虚拟键码（默认 VK_CAPITAL = 0x14）。
/// 0 表示未配置/工具禁用，keyboard hook 不响应。
static TRIGGER_VK: AtomicU16 = AtomicU16::new(0);

/// 触发键是否当前处于按下状态（防止 OS 自动重复 keydown 导致反复唤起）
static TRIGGER_DOWN: AtomicBool = AtomicBool::new(false);

/// 触发模式：1 = 单击切换（点击唤出/再点击关闭，鼠标点击扇区选中），
/// 2 = 按住唤起（按住显示转盘，松开时按当前高亮扇区选中输入）。
/// 默认单击切换模式。
static TRIGGER_MODE: AtomicU8 = AtomicU8::new(1);

/// 前端当前高亮的扇区索引（-1 = 无选中）。由前端在转盘内移动鼠标时同步，
/// 供「按住唤起」模式在松开触发键时读取并作为选中项。
static CURRENT_HIGHLIGHT: AtomicI32 = AtomicI32::new(-1);

/// 触发模式常量
pub const MODE_CLICK: u8 = 1;
pub const MODE_HOLD: u8 = 2;

/// 转盘模式是否激活
pub fn is_active() -> bool {
    QUICK_INPUT_ACTIVE.load(Ordering::SeqCst)
}

/// 当前是否处于「按住唤起」模式
pub fn is_hold_mode() -> bool {
    TRIGGER_MODE.load(Ordering::SeqCst) == MODE_HOLD
}

/// 设置触发模式（1=单击切换，2=按住唤起）。由命令层在配置变更时调用。
pub fn set_mode(mode: u8) {
    TRIGGER_MODE.store(mode, Ordering::SeqCst);
}

/// 更新前端同步过来的高亮扇区索引（-1 = 无选中）
pub fn set_highlight(idx: i32) {
    CURRENT_HIGHLIGHT.store(idx, Ordering::SeqCst);
}

/// 读取当前高亮扇区索引（-1 = 无选中）
pub fn highlight() -> i32 {
    CURRENT_HIGHLIGHT.load(Ordering::SeqCst)
}

/// 当前配置的触发键 vk_code（0 = 未启用）
pub fn trigger_vk() -> u16 {
    TRIGGER_VK.load(Ordering::SeqCst)
}

/// 设置触发键 vk_code（0 = 禁用）。由命令层在配置变更时调用。
pub fn set_trigger_vk(vk: u16) {
    TRIGGER_VK.store(vk, Ordering::SeqCst);
}

/// 触发键是否已按下（去重用）
pub fn is_trigger_down() -> bool {
    TRIGGER_DOWN.load(Ordering::SeqCst)
}

/// 标记触发键按下状态
pub fn set_trigger_down(down: bool) {
    TRIGGER_DOWN.store(down, Ordering::SeqCst);
}

/// 预创建转盘 overlay 窗口（隐藏、透明、不可聚焦）。首次调用创建，窗口已存在时为空操作。
/// 应用启动时和工具启用时各调用一次，确保键盘钩子触发后 emit_to 能找到目标窗口。
/// 创建/复用后缓存窗口 HWND，供 wheel_visible() 在钩子线程轻量查询可见性。
pub fn ensure_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("quick-input-overlay") {
        // 窗口已存在：刷新缓存 HWND，防止句柄过期
        if let Ok(hwnd) = win.hwnd() {
            OVERLAY_HWND.store(hwnd.0, Ordering::SeqCst);
        }
        return Ok(());
    }
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let win = WebviewWindowBuilder::new(
        app,
        "quick-input-overlay",
        WebviewUrl::App("index.html".into()),
    )
    .title("Levitaire Quick Input")
    .inner_size(320.0, 320.0)
    .resizable(false)
    .transparent(true)
    .decorations(false)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focusable(false)
    .visible(false)
    .background_color(tauri::webview::Color(0, 0, 0, 0))
    .build()
    .map_err(|e| format!("创建 quick-input-overlay 窗口失败: {}", e))?;
    if let Ok(hwnd) = win.hwnd() {
        OVERLAY_HWND.store(hwnd.0, Ordering::SeqCst);
    }
    Ok(())
}

/// 当前时间戳（毫秒）
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 转盘 overlay 窗口当前是否可见。用缓存 HWND + IsWindowVisible 判断，
/// 避免在钩子线程调用 get_webview_window 争用 Tauri 内部锁。
/// 当 QUICK_INPUT_ACTIVE 卡死而窗口不可见时，钩子应停止吞事件并允许 toggle 自愈复位。
pub fn wheel_visible() -> bool {
    let ptr = OVERLAY_HWND.load(Ordering::SeqCst);
    if ptr.is_null() {
        return false;
    }
    unsafe { IsWindowVisible(HWND(ptr)).as_bool() }
}

/// 进入转盘模式：开启鼠标移动 emit，通知前端显示转盘。
/// mouse hook 的 WM_MOUSEMOVE 分支会查询 is_active() 决定是否 emit。
/// 健壮性：前置检查 overlay 窗口存在，且 emit 失败时回滚激活态，
/// 避免「窗口未就绪/事件丢失」导致 QUICK_INPUT_ACTIVE 卡在 true——
/// 那会使转盘不显示、鼠标点击被全局吞掉，且 toggle 永远误走「关闭」分支。
pub fn begin_wheel(app: &tauri::AppHandle) {
    // overlay 窗口不存在时 emit_to 必失败，提前终止避免无谓激活
    let Some(win) = app.get_webview_window("quick-input-overlay") else {
        crate::utils::logger::log("quick_input", "begin_wheel aborted: overlay window missing");
        QUICK_INPUT_ACTIVE.store(false, Ordering::SeqCst);
        CURRENT_HIGHLIGHT.store(-1, Ordering::SeqCst);
        return;
    };
    // 顺手刷新 HWND 缓存：begin_wheel 已持有窗口句柄，若缓存过期（窗口重建等）
    // 会导致 wheel_visible() 误报不可见、toggle 误走自愈分支。
    if let Ok(hwnd) = win.hwnd() {
        OVERLAY_HWND.store(hwnd.0, Ordering::SeqCst);
    }
    // 先写时间戳再置 active：避免并发 toggle_wheel 读到 active=true 时拿到上一次
    // 未复位的旧 ACTIVE_AT（可能是数小时前）而误判 stale 触发自愈。
    QUICK_INPUT_ACTIVE_AT.store(now_ms(), Ordering::SeqCst);
    QUICK_INPUT_ACTIVE.store(true, Ordering::SeqCst);
    // 开始时复位高亮，避免上一次会话的残留高亮被「按住唤起」模式在松开时误读
    CURRENT_HIGHLIGHT.store(-1, Ordering::SeqCst);
    let pos =
        crate::automation::get_mouse_position().unwrap_or(crate::automation::Point { x: 0, y: 0 });
    if let Err(e) = app.emit_to(
        "quick-input-overlay",
        "quick-input-start",
        serde_json::json!({ "x": pos.x, "y": pos.y }),
    ) {
        // emit 失败（窗口不可用/IPC 异常）：回滚激活态，让下一次触发能重新尝试，
        // 否则 QUICK_INPUT_ACTIVE 卡在 true 会吞掉全局鼠标点击并让 toggle 永远走关闭分支。
        crate::utils::logger::log(
            "quick_input",
            &format!("begin_wheel emit failed, rolled back active: {}", e),
        );
        QUICK_INPUT_ACTIVE.store(false, Ordering::SeqCst);
        CURRENT_HIGHLIGHT.store(-1, Ordering::SeqCst);
    }
}

/// 退出转盘模式：停止鼠标移动 emit，通知前端确认/取消。
/// `selected_index` 为 None 表示未选中（鼠标在中心或无扇区），前端据此取消不输入。
pub fn end_wheel(app: &tauri::AppHandle, selected_index: Option<usize>) {
    QUICK_INPUT_ACTIVE.store(false, Ordering::SeqCst);
    let _ = app.emit_to(
        "quick-input-overlay",
        "quick-input-confirm",
        serde_json::json!({ "selectedIndex": selected_index }),
    );
}

/// 转盘模式下鼠标点击选中：退出转盘模式并通知前端。
/// 当前高亮扇区由前端持有（highlightedRef），因此这里只发点击信号，
/// 前端读到高亮项后执行输入并隐藏窗口，后端不再回传 index。
pub fn confirm_by_click(app: &tauri::AppHandle) {
    QUICK_INPUT_ACTIVE.store(false, Ordering::SeqCst);
    let _ = app.emit_to("quick-input-overlay", "quick-input-click", serde_json::json!({}));
}

/// 点击切换转盘：当前已激活则关闭（取消），否则打开。供触发键的按键事件与前端点击唤起共用。
/// 自愈：若 active 已置位但转盘窗口持续不可见（上一次 begin_wheel 的 emit 丢失/失败），
/// 先复位再重新激活，避免 toggle 误走「关闭」分支导致转盘永远无法唤起。
/// 仅当 active 持续超过 WHEEL_HEAL_AFTER_MS 且窗口仍不可见才判定为卡死，
/// 避免误伤「刚触发、窗口正在 show」窗口期内的快速二次触发（应正常走关闭分支）。
pub fn toggle_wheel(app: &tauri::AppHandle) {
    if is_active() {
        let stale = now_ms()
            .saturating_sub(QUICK_INPUT_ACTIVE_AT.load(Ordering::SeqCst))
            >= WHEEL_HEAL_AFTER_MS;
        if !wheel_visible() && stale {
            crate::utils::logger::log(
                "quick_input",
                "toggle_wheel: active but wheel not visible, self-healing",
            );
            QUICK_INPUT_ACTIVE.store(false, Ordering::SeqCst);
            CURRENT_HIGHLIGHT.store(-1, Ordering::SeqCst);
            begin_wheel(app);
            return;
        }
        end_wheel(app, None);
    } else {
        begin_wheel(app);
    }
}

// ─── 剪贴板历史（内存环形缓冲 + 本地文件持久化） ─────────────────

/// 历史记录最大条数
const HISTORY_MAX: usize = 20;

/// 单条历史记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardHistoryItem {
    /// 截断后的预览文本（供 UI 展示）
    pub preview: String,
    /// 完整文本（选中后输入此字段）
    pub text: String,
}

/// 内存中的历史缓冲（最新追加在末尾，展示时倒序取用）
static HISTORY: Mutex<Vec<ClipboardHistoryItem>> = Mutex::new(Vec::new());

/// 预览文本最大长度
const PREVIEW_MAX: usize = 60;

/// 历史记录文件路径（应用数据目录 levitaire 下，与 config.json 同级）。
/// 文件内容为 DPAPI 加密后 hex 编码的 JSON 数组，避免剪贴板文本明文落盘。
#[cfg(not(test))]
static HISTORY_PATH: OnceLock<PathBuf> = OnceLock::new();

/// 串行化历史文件的写入与删除，避免并发操作同一临时文件导致竞态
/// （与 config 模块的 CONFIG_SAVE_LOCK 同理）。
#[cfg(not(test))]
static HISTORY_SAVE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(not(test))]
fn history_save_lock() -> &'static Mutex<()> {
    HISTORY_SAVE_LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(not(test))]
fn history_path() -> PathBuf {
    HISTORY_PATH
        .get_or_init(|| {
            let data_dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
            let app_dir = data_dir.join("levitaire");
            let _ = std::fs::create_dir_all(&app_dir);
            app_dir.join("clipboard_history.json")
        })
        .clone()
}

/// 测试环境固定历史路径：隔离到临时目录，避免测试误触碰真实用户历史文件。
#[cfg(test)]
fn history_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "levitaire_test_history_{}.json",
        std::process::id()
    ))
}

/// 启动时从本地文件恢复剪贴板历史。文件不存在、解析失败或解密失败时
/// 保持当前（默认空）历史，不影响正常启动。
pub fn load_history() {
    let items = load_history_from(&history_path());
    if items.is_empty() {
        return;
    }
    if let Ok(mut hist) = HISTORY.lock() {
        *hist = items;
    }
}

/// 读取并解密历史文件，过滤空文本后裁剪到 HISTORY_MAX 上限。
/// 任何失败（文件缺失/损坏/解密失败）都返回空 Vec，不 panic。
fn load_history_from(path: &Path) -> Vec<ClipboardHistoryItem> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let bytes = match crate::utils::crypto::from_hex(content.trim()) {
        Ok(b) => b,
        Err(e) => {
            crate::utils::logger::log("quick_input", &format!("历史文件 hex 解码失败: {}", e));
            return Vec::new();
        }
    };
    let plaintext = match crate::utils::crypto::decrypt(&bytes) {
        Ok(p) => p,
        Err(e) => {
            crate::utils::logger::log("quick_input", &format!("历史文件解密失败: {}", e));
            return Vec::new();
        }
    };
    match serde_json::from_slice::<Vec<ClipboardHistoryItem>>(&plaintext) {
        Ok(mut items) => {
            items.retain(|i| !i.text.is_empty());
            if items.len() > HISTORY_MAX {
                let overflow = items.len() - HISTORY_MAX;
                items.drain(0..overflow);
            }
            items
        }
        Err(e) => {
            crate::utils::logger::log("quick_input", &format!("历史文件解析失败: {}", e));
            Vec::new()
        }
    }
}

/// 将内存历史序列化、DPAPI 加密后原子写入文件（临时文件 + rename）。
/// 持 HISTORY_SAVE_LOCK 将「克隆快照 + 写盘」作为一个整体串行化：
/// - 防止两个并发保存用旧快照覆盖新内容；
/// - 防止与 clear_history 的删除操作竞态。
///
/// 测试环境不落盘（push_history 在 cfg(not(test)) 下调用），故该函数仅编译进非测试构建。
#[cfg(not(test))]
fn save_history() {
    let _guard = history_save_lock().lock().unwrap_or_else(|e| e.into_inner());
    let items = HISTORY.lock().map(|h| h.clone()).unwrap_or_default();
    if let Err(e) = save_history_to(&history_path(), &items) {
        crate::utils::logger::log("quick_input", &format!("保存剪贴板历史失败: {}", e));
    }
}

/// 序列化 + DPAPI 加密 + 原子写文件；返回 Result 便于测试。
/// 本函数不自行加锁，并发安全由调用方保证（生产经 save_history 持 HISTORY_SAVE_LOCK 调用）。
fn save_history_to(path: &Path, items: &[ClipboardHistoryItem]) -> Result<(), String> {
    let plaintext = serde_json::to_vec(items).map_err(|e| format!("序列化失败: {}", e))?;
    let encrypted =
        crate::utils::crypto::encrypt(&plaintext).map_err(|e| format!("DPAPI 加密失败: {}", e))?;
    let content = crate::utils::crypto::to_hex(&encrypted);
    let temp_path = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&temp_path, content).map_err(|e| format!("写入临时文件失败: {}", e))?;
    if let Err(e) = std::fs::rename(&temp_path, path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("替换历史文件失败: {}", e));
    }
    Ok(())
}

/// 由 keyboard hook 在检测到 Ctrl+C 复制文本后调用，追加到历史。
/// 去重：与最近一条相同则跳过。内存更新后持久化到本地文件。
/// 测试环境跳过落盘，避免污染真实用户数据。
pub fn push_history(text: &str) {
    if text.is_empty() {
        return;
    }
    let preview = if text.chars().count() > PREVIEW_MAX {
        let truncated: String = text.chars().take(PREVIEW_MAX).collect();
        format!("{}…", truncated)
    } else {
        text.to_string()
    };
    let item = ClipboardHistoryItem {
        preview,
        text: text.to_string(),
    };
    let mut changed = false;
    if let Ok(mut hist) = HISTORY.lock() {
        // 与最近一条相同则跳过
        if hist.last().map(|i| i.text == item.text).unwrap_or(false) {
            return;
        }
        hist.push(item);
        if hist.len() > HISTORY_MAX {
            hist.remove(0);
        }
        changed = true;
    }
    if changed {
        #[cfg(not(test))]
        save_history();
    }
}

/// 获取历史记录快照（前端转盘展示用，最新在前）
pub fn get_history() -> Vec<ClipboardHistoryItem> {
    HISTORY
        .lock()
        .map(|h| h.iter().rev().cloned().collect())
        .unwrap_or_default()
}

/// 清空历史并删除本地历史文件。
/// 无条件删除文件（即使内存历史已为空也清除残留），确保清空后重启不会恢复旧历史。
pub fn clear_history() {
    #[cfg(not(test))]
    {
        let _guard = history_save_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _ = std::fs::remove_file(history_path());
    }
    if let Ok(mut h) = HISTORY.lock() {
        h.clear();
    }
}

// ─── 文本输入（写剪贴板 + 模拟 Ctrl+V + 恢复原内容） ─────────────

/// 是否有粘贴线程正在执行（防止快速连续选中时多个线程对同一剪贴板互踩）
static PASTE_INFLIGHT: AtomicBool = AtomicBool::new(false);

/// 将文本输入到当前焦点输入框：保存原剪贴板 → 写入新文本 → 模拟 Ctrl+V → 恢复原剪贴板。
/// 在独立线程执行，避免阻塞 hook；粘贴后短暂等待再恢复，给目标应用处理 Ctrl+V 的时间。
/// 若上一次粘贴仍在进行，本次请求直接丢弃，避免并发线程竞争同一剪贴板导致状态错乱。
pub fn type_text_async(text: String) {
    if PASTE_INFLIGHT.swap(true, Ordering::SeqCst) {
        crate::utils::logger::log("quick_input", "paste already in-flight, drop request");
        return;
    }
    std::thread::spawn(move || {
        let _guard = PasteGuard;
        // 保存原剪贴板文本（仅文本，图片不恢复——转盘工具只处理文本输入场景）
        let original = unsafe { read_clipboard_text_sync() };
        // 释放可能残留的修饰键，防止 Ctrl 卡住影响粘贴
        unsafe { crate::automation::clipboard_selection::release_all_modifiers() };
        // 写入目标文本
        if !unsafe { crate::automation::clipboard_selection::set_clipboard_text_pub(&text) } {
            crate::utils::logger::log("quick_input", "set_clipboard_text failed");
            return;
        }
        // 短暂等待剪贴板就绪
        std::thread::sleep(std::time::Duration::from_millis(40));
        // 模拟 Ctrl+V
        if !unsafe { crate::automation::clipboard_selection::simulate_paste() } {
            crate::utils::logger::log("quick_input", "simulate_paste failed");
        }
        // 等待目标应用处理粘贴
        std::thread::sleep(std::time::Duration::from_millis(120));
        // 恢复原剪贴板
        if let Some(orig) = original {
            unsafe { crate::automation::clipboard_selection::set_clipboard_text_pub(&orig) };
        }
    });

    /// RAII 守卫：线程结束（无论路径）时复位进行中标志
    struct PasteGuard;
    impl Drop for PasteGuard {
        fn drop(&mut self) {
            PASTE_INFLIGHT.store(false, Ordering::SeqCst);
        }
    }
}

/// 同步读取剪贴板文本（用于保存原内容）。复用 keyboard.rs 的实现思路。
unsafe fn read_clipboard_text_sync() -> Option<String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    const CF_UNICODETEXT: u32 = 13;
    if OpenClipboard(None).is_err() {
        return None;
    }
    let result = (|| {
        let handle = GetClipboardData(CF_UNICODETEXT).ok()?;
        if handle.is_invalid() {
            return None;
        }
        let hmem = HGLOBAL(handle.0);
        let ptr = GlobalLock(hmem);
        if ptr.is_null() {
            return None;
        }
        let size = GlobalSize(hmem);
        let max_u16 = if size > 0 { size / 2 } else { 0 };
        if max_u16 == 0 {
            let _ = GlobalUnlock(hmem);
            return None;
        }
        let mut len = 0usize;
        let mut p = ptr as *const u16;
        while len < max_u16 && *p != 0 {
            len += 1;
            p = p.add(1);
        }
        let slice = std::slice::from_raw_parts(ptr as *const u16, len);
        let text = String::from_utf16_lossy(slice);
        let _ = GlobalUnlock(hmem);
        Some(text)
    })();
    let _ = CloseClipboard();
    result
}

// ─── 触发键名 ⇄ vk_code 转换 ────────────────────────────────────

/// 判断某个解析出的触发键是否会在日常输入中被频繁按压（字母、数字、编辑/导航区，
/// 空格/回车/制表/退格/Esc 等）。这类键被设为触发键后会被全局吞掉，影响所有程序的
/// 文本输入，故应避免让用户选作触发键。功能键（F1-F12）与锁定键（CapsLock 等）不在其中。
pub fn is_dangerous_trigger_vk(vk: u16) -> bool {
    // 字母 A-Z（0x41..0x5A）、数字 0-9（0x30..0x39）
    if (0x41..=0x5A).contains(&vk) || (0x30..=0x39).contains(&vk) {
        return true;
    }
    // 编辑/导航区与空键、回车、制表、退格、Esc；方向键
    matches!(
        vk,
        0x20 | 0x0D | 0x09 | 0x08 | 0x1B | 0x2D | 0x2E | 0x24 | 0x23 | 0x21 | 0x22 | 0x25
            | 0x26 | 0x27 | 0x28
    )
}

/// 将触发键名解析为 vk_code。返回 None 表示无法识别。
///
/// 键名不区分大小写，返回 Windows 虚拟键码（VK）；无法识别的键返回 None。
/// 支持按键：字母 A-Z、数字 0-9、F1-F12、方向键、Home/End/PageUp/PageDown、
/// Insert/Delete、Space、Enter、Tab、Backspace、Esc，以及 CapsLock/ScrollLock/Pause/NumLock 等锁定键。
pub fn parse_trigger_key(name: &str) -> Option<u16> {
    let lower = name.trim().to_lowercase();
    // 锁定键 / 功能键
    match lower.as_str() {
        "capslock" | "caps" | "capital" => return Some(0x14), // VK_CAPITAL
        "scroll" | "scrolllock" => return Some(0x91),         // VK_SCROLL
        "pause" => return Some(0x13),                         // VK_PAUSE
        "numlock" => return Some(0x90),                       // VK_NUMLOCK
        "space" | "spacebar" => return Some(0x20),            // VK_SPACE
        "enter" | "return" => return Some(0x0D),              // VK_RETURN
        "tab" => return Some(0x09),                           // VK_TAB
        "backspace" => return Some(0x08),                     // VK_BACK
        "esc" | "escape" => return Some(0x1B),                // VK_ESCAPE
        "insert" | "ins" => return Some(0x2D),                // VK_INSERT
        "delete" | "del" => return Some(0x2E),                // VK_DELETE
        "home" => return Some(0x24),                          // VK_HOME
        "end" => return Some(0x23),                           // VK_END
        "pageup" | "pgup" => return Some(0x21),               // VK_PRIOR
        "pagedown" | "pgdn" => return Some(0x22),             // VK_NEXT
        "left" => return Some(0x25),                          // VK_LEFT
        "up" => return Some(0x26),                            // VK_UP
        "right" => return Some(0x27),                         // VK_RIGHT
        "down" => return Some(0x28),                          // VK_DOWN
        _ => {}
    }
    // F1..F12
    if let Some(n) = lower.strip_prefix('f') {
        if let Ok(num) = n.parse::<u32>() {
            if (1..=12).contains(&num) {
                return Some(0x6F + num as u16); // VK_F1 = 0x70
            }
        }
    }
    // 字母键 A-Z（VK_A = 0x41）
    if lower.len() == 1 {
        let c = lower.chars().next().unwrap();
        if c.is_ascii_alphabetic() {
            return Some(0x41 + (c as u16 - b'a' as u16));
        }
        // 数字键 0-9（VK_0 = 0x30）
        if c.is_ascii_digit() {
            return Some(0x30 + (c as u16 - b'0' as u16));
        }
    }
    None
}

/// vk_code 转回可读名（与 parse_trigger_key 保持一一对应）
/// vk_code 转回可读名（与 parse_trigger_key 保持一一对应）
pub fn vk_to_name(vk: u16) -> String {
    match vk {
        0x14 => "CapsLock".to_string(),
        0x91 => "ScrollLock".to_string(),
        0x13 => "Pause".to_string(),
        0x90 => "NumLock".to_string(),
        0x20 => "Space".to_string(),
        0x0D => "Enter".to_string(),
        0x09 => "Tab".to_string(),
        0x08 => "Backspace".to_string(),
        0x1B => "Esc".to_string(),
        0x2D => "Insert".to_string(),
        0x2E => "Delete".to_string(),
        0x24 => "Home".to_string(),
        0x23 => "End".to_string(),
        0x21 => "PageUp".to_string(),
        0x22 => "PageDown".to_string(),
        0x25 => "Left".to_string(),
        0x26 => "Up".to_string(),
        0x27 => "Right".to_string(),
        0x28 => "Down".to_string(),
        v if (0x70..=0x7B).contains(&v) => format!("F{}", v - 0x6F),
        v if (0x41..=0x5A).contains(&v) => {
            // 字母 A-Z（ASCII 值 'A'..'Z'，可安全收窄到 u8）
            let c = (v as u8 - 0x41 + b'A') as char;
            c.to_uppercase().to_string()
        }
        v if (0x30..=0x39).contains(&v) => {
            // 数字 0-9
            let c = (v as u8 - 0x30 + b'0') as char;
            c.to_string()
        }
        _ => format!("VK_{:02X}", vk),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        clear_history, get_history, history_path, is_dangerous_trigger_vk, load_history,
        load_history_from, parse_trigger_key, push_history, save_history_to, vk_to_name,
        ClipboardHistoryItem, HISTORY_MAX,
    };

    /// 串行化操作全局 HISTORY 的测试，避免并行运行互相污染
    static HISTORY_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn parse_trigger_key_supports_lock_and_function_keys() {
        assert_eq!(parse_trigger_key("CapsLock"), Some(0x14));
        assert_eq!(parse_trigger_key("caps"), Some(0x14)); // 别名
        assert_eq!(parse_trigger_key("ScrollLock"), Some(0x91));
        assert_eq!(parse_trigger_key("NumLock"), Some(0x90));
        assert_eq!(parse_trigger_key("Pause"), Some(0x13));
        // F1..F12，新旧格式不区分大小写
        assert_eq!(parse_trigger_key("F1"), Some(0x70));
        assert_eq!(parse_trigger_key("f12"), Some(0x7B));
        assert_eq!(parse_trigger_key("F13"), None); // 超出范围
        assert_eq!(parse_trigger_key("F0"), None);
    }

    #[test]
    fn parse_trigger_key_supports_letters_and_digits() {
        assert_eq!(parse_trigger_key("a"), Some(0x41));
        assert_eq!(parse_trigger_key("Z"), Some(0x5A));
        assert_eq!(parse_trigger_key("m"), Some(0x41 + (b'm' - b'a') as u16));
        assert_eq!(parse_trigger_key("0"), Some(0x30));
        assert_eq!(parse_trigger_key("9"), Some(0x39));
        assert_eq!(parse_trigger_key("5"), Some(0x35));
        // 单字符 F 是字母键 F（VK_F = 0x46），不是功能键
        assert_eq!(parse_trigger_key("f"), Some(0x46));
    }

    #[test]
    fn parse_trigger_key_supports_navigation_and_editing_keys() {
        assert_eq!(parse_trigger_key("Left"), Some(0x25));
        assert_eq!(parse_trigger_key("up"), Some(0x26));
        assert_eq!(parse_trigger_key("Right"), Some(0x27));
        assert_eq!(parse_trigger_key("DOWN"), Some(0x28));
        assert_eq!(parse_trigger_key("Home"), Some(0x24));
        assert_eq!(parse_trigger_key("End"), Some(0x23));
        assert_eq!(parse_trigger_key("PageUp"), Some(0x21));
        assert_eq!(parse_trigger_key("PageDown"), Some(0x22));
        assert_eq!(parse_trigger_key("Insert"), Some(0x2D));
        assert_eq!(parse_trigger_key("Delete"), Some(0x2E));
        assert_eq!(parse_trigger_key("Space"), Some(0x20));
        assert_eq!(parse_trigger_key("Enter"), Some(0x0D));
        assert_eq!(parse_trigger_key("Tab"), Some(0x09));
        assert_eq!(parse_trigger_key("Backspace"), Some(0x08));
        assert_eq!(parse_trigger_key("Esc"), Some(0x1B));
    }

    #[test]
    fn parse_trigger_key_rejects_unknown() {
        assert_eq!(parse_trigger_key(""), None);
        assert_eq!(parse_trigger_key("_"), None);
        assert_eq!(parse_trigger_key("Ctrl"), None); // 纯修饰键不支持作为触发键
        assert_eq!(parse_trigger_key("CapsLock+Shift"), None);
    }

    #[test]
    fn vk_to_name_roundtrips_parse_trigger_key() {
        // vk_to_name 结果再经 parse_trigger_key 应还原同一个 VK
        for vk in [
            0x14, 0x91, 0x90, 0x13, 0x20, 0x0D, 0x09, 0x08, 0x1B, 0x2D, 0x2E, 0x24, 0x23, 0x21,
            0x22, 0x25, 0x26, 0x27, 0x28,
        ] {
            let name = vk_to_name(vk);
            assert_eq!(parse_trigger_key(&name), Some(vk), "name={name}");
        }
        // 字母
        for c in b'A'..=b'Z' {
            let name = vk_to_name(0x41 + (c - b'A') as u16);
            assert_eq!(parse_trigger_key(&name), Some(0x41 + (c - b'A') as u16));
        }
        // 数字
        for c in b'0'..=b'9' {
            let name = vk_to_name(0x30 + (c - b'0') as u16);
            assert_eq!(parse_trigger_key(&name), Some(0x30 + (c - b'0') as u16));
        }
        // F1..F12
        for n in 1..=12u16 {
            let name = vk_to_name(0x70 + n - 1);
            assert_eq!(parse_trigger_key(&name), Some(0x70 + n - 1));
        }
    }

    #[test]
    fn is_dangerous_trigger_vk_flags_input_interfering_keys() {
        // 字母、数字、空格/回车/制表/退格/编辑导航区 均视为会干扰输入的键
        for vk in 0x41..=0x5A {
            assert!(is_dangerous_trigger_vk(vk), "字母 vk=0x{vk:X}");
        }
        for vk in 0x30..=0x39 {
            assert!(is_dangerous_trigger_vk(vk), "数字 vk=0x{vk:X}");
        }
        for vk in [
            0x20, 0x0D, 0x09, 0x08, 0x1B, 0x2D, 0x2E, 0x24, 0x23, 0x21, 0x22, 0x25, 0x26, 0x27,
            0x28,
        ] {
            assert!(is_dangerous_trigger_vk(vk), "编辑/导航 vk=0x{vk:X}");
        }
    }

    #[test]
    fn is_dangerous_trigger_vk_allows_lock_and_function_keys() {
        // 锁定键与功能键可安全作为触发键
        for vk in [0x14, 0x91, 0x90, 0x13] {
            assert!(!is_dangerous_trigger_vk(vk), "锁定键 vk=0x{vk:X}");
        }
        for vk in 0x70..=0x7B {
            assert!(!is_dangerous_trigger_vk(vk), "功能键 vk=0x{vk:X}");
        }
    }

    #[test]
    fn get_history_returns_latest_first() {
        let _guard = HISTORY_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_history();
        push_history("first");
        push_history("second");
        push_history("second"); // 与最近一条相同 → 去重
        let hist = get_history();
        assert_eq!(hist.len(), 2);
        assert_eq!(hist[0].text, "second", "最新一条应排在最前");
        assert_eq!(hist[1].text, "first");
        clear_history();
    }

    #[test]
    fn get_history_ignores_empty_push() {
        // push_history 只忽略真正空串（不 trim：复制的文本保留原样空格）
        let _guard = HISTORY_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_history();
        push_history("");
        assert!(get_history().is_empty());
    }

    #[test]
    fn get_history_respects_max_cap() {
        let _guard = HISTORY_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_history();
        for i in 0..25 {
            push_history(&format!("item-{}", i));
        }
        let hist = get_history();
        assert_eq!(hist.len(), 20, "超出上限后应裁剪为 HISTORY_MAX 条");
        assert_eq!(hist[0].text, "item-24", "最新一条应保留");
        assert_eq!(hist[19].text, "item-5", "最旧一条应被裁剪");
        clear_history();
    }

    /// 持久化往返：加密写入后能解密读回，内容一致
    #[test]
    fn history_persistence_roundtrip() {
        let tmp = std::env::temp_dir().join(format!(
            "levitaire_test_hist_{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&tmp);
        let path = tmp.join("clipboard_history.json");

        let items = vec![
            ClipboardHistoryItem {
                preview: "hello".to_string(),
                text: "hello".to_string(),
            },
            ClipboardHistoryItem {
                preview: "world".to_string(),
                text: "world".to_string(),
            },
        ];
        save_history_to(&path, &items).unwrap();
        let loaded = load_history_from(&path);
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].text, "hello");
        assert_eq!(loaded[1].text, "world");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 历史文件不落明文：磁盘内容应为 hex 编码的密文
    #[test]
    fn history_persistence_encrypts_plaintext() {
        let tmp = std::env::temp_dir().join(format!(
            "levitaire_test_hist_enc_{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&tmp);
        let path = tmp.join("clipboard_history.json");

        save_history_to(
            &path,
            &[ClipboardHistoryItem {
                preview: "secret".to_string(),
                text: "secret".to_string(),
            }],
        )
        .unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(!content.contains("secret"), "历史文件不应包含明文");
        assert!(
            content
                .trim()
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == '\r' || c == '\n'),
            "文件内容应为 hex 密文"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 加载时过滤空文本并裁剪到上限，保留最新条目
    #[test]
    fn history_persistence_filters_and_caps() {
        let tmp = std::env::temp_dir().join(format!(
            "levitaire_test_hist_cap_{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&tmp);
        let path = tmp.join("clipboard_history.json");

        let mut items: Vec<ClipboardHistoryItem> = (0..25)
            .map(|i| ClipboardHistoryItem {
                preview: format!("p{}", i),
                text: format!("t{}", i),
            })
            .collect();
        items.push(ClipboardHistoryItem {
            preview: String::new(),
            text: String::new(),
        });
        save_history_to(&path, &items).unwrap();

        let loaded = load_history_from(&path);
        assert_eq!(loaded.len(), HISTORY_MAX, "空文本应被过滤并裁剪到上限");
        assert_eq!(loaded[0].text, "t5", "最旧一条被裁剪");
        assert_eq!(loaded.last().unwrap().text, "t24", "最新一条应保留");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 损坏文件 / 非法内容 / 文件缺失均应被安全忽略（返回空），不 panic
    #[test]
    fn history_persistence_tolerates_corrupt_file() {
        let tmp = std::env::temp_dir().join(format!(
            "levitaire_test_hist_corrupt_{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&tmp);

        let corrupt = tmp.join("clipboard_history.json");
        std::fs::write(&corrupt, "not valid content").unwrap();
        assert!(load_history_from(&corrupt).is_empty());

        // hex 有效但 DPAPI 解密失败（伪造密文）也应返回空
        let fake = tmp.join("fake.json");
        std::fs::write(&fake, "0011aaff").unwrap();
        assert!(load_history_from(&fake).is_empty());

        // 文件缺失
        let missing = tmp.join("missing.json");
        assert!(load_history_from(&missing).is_empty());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// load_history 应从持久化文件恢复内存历史（模拟启动时恢复），并覆盖现有内存内容
    #[test]
    fn load_history_restores_persisted_items() {
        let _guard = HISTORY_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_history();
        let path = history_path();
        let _ = std::fs::remove_file(&path);

        // 持久化一条记录（cfg(test) 下 history_path 指向临时目录）
        save_history_to(
            &path,
            &[ClipboardHistoryItem {
                preview: "persisted".to_string(),
                text: "persisted".to_string(),
            }],
        )
        .unwrap();

        // 先在内存放入一条不同的内容，验证 load 会用文件内容覆盖
        push_history("in-memory");
        assert_eq!(get_history()[0].text, "in-memory");

        load_history();
        let hist = get_history();
        assert_eq!(hist.len(), 1);
        assert_eq!(hist[0].text, "persisted", "load 应恢复文件中的历史");

        clear_history();
        let _ = std::fs::remove_file(&path);
    }
}
