//! 全局热键模块（多槽位：截图、语音输入、录屏）。
//!
//! 使用 Win32 RegisterHotKey 注册全局热键，独立线程跑消息循环接收 WM_HOTKEY。
//! RegisterHotKey 失败即表示快捷键已被其他程序占用（冲突），天然提供冲突检测。
//!
//! 重要：RegisterHotKey/UnregisterHotKey 必须在拥有 hwnd 的线程（热键线程）调用，
//! 跨线程调用会报 ERROR_INVALID_WINDOW_HANDLE (0x80070580)。
//! 因此命令线程通过 PostMessage 投递注册请求到热键线程，并用 oneshot channel 同步等待结果。

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{Emitter, Manager};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN, VK_F1, VK_F10,
    VK_F11, VK_F12, VK_F2, VK_F3, VK_F4, VK_F5, VK_F6, VK_F7, VK_F8, VK_F9,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostMessageW, PostQuitMessage,
    RegisterClassExW, TranslateMessage, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WM_DESTROY, WM_HOTKEY,
    WM_USER, WNDCLASSEXW, WS_OVERLAPPED,
};

/// 截图热键 ID
const HOTKEY_ID_SCREENSHOT: i32 = 9001;
/// 语音输入热键 ID
const HOTKEY_ID_VOICE: i32 = 9002;
/// 录屏热键 ID
const HOTKEY_ID_RECORDING: i32 = 9003;
/// 槽位数量
const SLOT_COUNT: usize = 3;
/// 自定义消息：注册热键（lparam = *mut HotkeyRequest）
const WM_REGISTER_HOTKEY: u32 = WM_USER + 1;
/// 自定义消息：反注册热键
const WM_UNREGISTER_HOTKEY: u32 = WM_USER + 2;

/// 热键槽位标识
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HotkeySlotId {
    Screenshot,
    Voice,
    Recording,
}

impl HotkeySlotId {
    fn id(self) -> i32 {
        match self {
            Self::Screenshot => HOTKEY_ID_SCREENSHOT,
            Self::Voice => HOTKEY_ID_VOICE,
            Self::Recording => HOTKEY_ID_RECORDING,
        }
    }
    fn index(self) -> usize {
        match self {
            Self::Screenshot => 0,
            Self::Voice => 1,
            Self::Recording => 2,
        }
    }
}

/// 跨线程注册请求：携带槽位、热键字符串与结果回传 channel
struct HotkeyRequest {
    slot: HotkeySlotId,
    hotkey: String,
    reply: mpsc::Sender<Result<(), String>>,
}

/// 单个热键槽位状态
struct HotkeySlot {
    /// 当前是否已注册
    registered: AtomicBool,
    /// 当前已注册的热键字符串（用于注册失败时回滚恢复）
    current_hotkey: Mutex<String>,
    /// 该工具是否启用（仅启用时热键才触发）
    enabled: AtomicBool,
}

impl HotkeySlot {
    const fn new() -> Self {
        Self {
            registered: AtomicBool::new(false),
            current_hotkey: Mutex::new(String::new()),
            enabled: AtomicBool::new(false),
        }
    }
}

/// 热键线程状态
struct HotkeyState {
    /// 消息窗口句柄（热键线程内创建）
    hwnd: AtomicU32,
    /// 注册后忽略热键触发的截止时间戳（毫秒），避免录入时组合键仍按着导致立即触发
    suppress_until_ms: AtomicU64,
    app_handle: OnceLock<tauri::AppHandle>,
    /// 多槽位：0=screenshot, 1=voice
    slots: [HotkeySlot; SLOT_COUNT],
}

static HOTKEY_STATE: HotkeyState = HotkeyState {
    hwnd: AtomicU32::new(0),
    suppress_until_ms: AtomicU64::new(0),
    app_handle: OnceLock::new(),
    slots: [HotkeySlot::new(), HotkeySlot::new(), HotkeySlot::new()],
};

/// 当前时间戳（毫秒）
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 启动热键监听线程（应用启动时调用一次）
pub fn start_hotkey_thread(app: tauri::AppHandle) {
    HOTKEY_STATE
        .app_handle
        .set(app)
        .expect("hotkey app_handle already set");
    std::thread::spawn(|| {
        run_hotkey_message_loop();
    });
}

/// 热键线程：创建仅消息窗口（接收 WM_HOTKEY），跑消息循环
fn run_hotkey_message_loop() {
    unsafe {
        let hinst = match GetModuleHandleW(None) {
            Ok(h) => h,
            Err(e) => {
                crate::utils::logger::log("hotkey", &format!("GetModuleHandleW failed: {}", e));
                return;
            }
        };

        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(hotkey_wndproc),
            hInstance: hinst.into(),
            lpszClassName: w!("FloatoryHotkeySink"),
            ..Default::default()
        };
        let _ = RegisterClassExW(&wc);

        // 创建仅消息窗口（HWND_MESSAGE，不可见），用于接收 WM_HOTKEY 与注册请求
        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("FloatoryHotkeySink"),
            w!("FloatoryHotkeySink"),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(hinst.into()),
            None,
        ) {
            Ok(h) => h,
            Err(e) => {
                crate::utils::logger::log("hotkey", &format!("CreateWindowExW failed: {}", e));
                return;
            }
        };

        HOTKEY_STATE.hwnd.store(hwnd.0 as u32, Ordering::SeqCst);
        crate::utils::logger::log("hotkey", "hotkey sink window created");

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).into() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        crate::utils::logger::log("hotkey", "hotkey message loop exited");
    }
}

/// 窗口过程（在热键线程内执行）
unsafe extern "system" fn hotkey_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_HOTKEY => {
            let id = wparam.0 as i32;
            let slot = match id {
                HOTKEY_ID_SCREENSHOT => HotkeySlotId::Screenshot,
                HOTKEY_ID_VOICE => HotkeySlotId::Voice,
                HOTKEY_ID_RECORDING => HotkeySlotId::Recording,
                _ => return LRESULT(0),
            };
            // 注册后短期内忽略触发：录入快捷键时组合键仍按着，注册瞬间会立即触发一次
            if now_ms() < HOTKEY_STATE.suppress_until_ms.load(Ordering::SeqCst) {
                return LRESULT(0);
            }
            let slot_state = &HOTKEY_STATE.slots[slot.index()];
            // 仅该工具启用时触发
            if !slot_state.enabled.load(Ordering::SeqCst) {
                return LRESULT(0);
            }
            if let Some(app) = HOTKEY_STATE.app_handle.get() {
                match slot {
                    HotkeySlotId::Screenshot => {
                        crate::utils::logger::log("hotkey", "screenshot hotkey triggered");
                        // The screenshot overlay is a configured native window, so
                        // start it directly. Routing through the orb WebView made
                        // this hotkey depend on an asynchronous frontend listener,
                        // which can be unavailable while that WebView reloads.
                        let app = app.clone();
                        std::thread::spawn(move || {
                            if let Err(error) = crate::commands::start_screenshot_inner(app) {
                                crate::utils::logger::log(
                                    "hotkey",
                                    &format!("failed to start screenshot from hotkey: {}", error),
                                );
                            }
                        });
                    }
                    HotkeySlotId::Voice => {
                        crate::utils::logger::log("hotkey", "voice hotkey triggered");
                        let _ = app.emit("voice-hotkey-triggered", ());
                    }
                    HotkeySlotId::Recording => {
                        crate::utils::logger::log("hotkey", "recording hotkey triggered");
                        let app_clone = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            if app_clone.get_webview_window("screenshot-overlay").is_none() {
                                // overlay 窗口不存在，通知前端创建并启动录制
                                let _ = app_clone.emit("ensure-overlay-and-start-recording", ());
                            } else {
                                // overlay 已存在，直接启动录制选区
                                let inner_app = app_clone.clone();
                                std::thread::spawn(move || {
                                    if let Err(error) = crate::commands::start_recording_select_inner(inner_app) {
                                        crate::utils::logger::log(
                                            "hotkey",
                                            &format!("failed to start recording: {}", error),
                                        );
                                    }
                                });
                            }
                        });
                    }
                }
            }
            LRESULT(0)
        }
        WM_REGISTER_HOTKEY => {
            // 取出请求（Box 转移所有权），执行注册，回传结果
            let req = Box::from_raw(lparam.0 as *mut HotkeyRequest);
            let result = register_hotkey_inner(req.slot, &req.hotkey);
            let _ = req.reply.send(result);
            LRESULT(0)
        }
        WM_UNREGISTER_HOTKEY => {
            let slot = match wparam.0 as i32 {
                HOTKEY_ID_SCREENSHOT => HotkeySlotId::Screenshot,
                HOTKEY_ID_VOICE => HotkeySlotId::Voice,
                HOTKEY_ID_RECORDING => HotkeySlotId::Recording,
                _ => return LRESULT(0),
            };
            unregister_hotkey_inner(slot);
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// 在热键线程内执行的实际注册逻辑
fn register_hotkey_inner(slot: HotkeySlotId, hotkey: &str) -> Result<(), String> {
    let (mods, vk) = parse_hotkey(hotkey).ok_or_else(|| format!("无效的快捷键格式: {}", hotkey))?;

    let hwnd_ptr = HOTKEY_STATE.hwnd.load(Ordering::SeqCst);
    if hwnd_ptr == 0 {
        return Err("热键线程未就绪".into());
    }
    let hwnd = HWND(hwnd_ptr as *mut std::ffi::c_void);
    let hotkey_id = slot.id();
    let slot_state = &HOTKEY_STATE.slots[slot.index()];

    let old_hotkey = slot_state
        .current_hotkey
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();

    unsafe {
        // 先反注册旧的（RegisterHotKey 同 id 重复注册会失败）
        if slot_state.registered.load(Ordering::SeqCst) {
            let _ = UnregisterHotKey(Some(hwnd), hotkey_id);
            slot_state.registered.store(false, Ordering::SeqCst);
        }

        match RegisterHotKey(
            Some(hwnd),
            hotkey_id,
            windows::Win32::UI::Input::KeyboardAndMouse::HOT_KEY_MODIFIERS(mods),
            vk as u32,
        ) {
            Ok(_) => {
                slot_state.registered.store(true, Ordering::SeqCst);
                if let Ok(mut g) = slot_state.current_hotkey.lock() {
                    *g = hotkey.to_string();
                }
                // 注册后 500ms 内忽略触发：避免录入时组合键仍按着导致立即触发一次
                HOTKEY_STATE
                    .suppress_until_ms
                    .store(now_ms() + 500, Ordering::SeqCst);
                crate::utils::logger::log("hotkey", &format!("registered {:?}: {}", slot, hotkey));
                Ok(())
            }
            Err(e) => {
                let win32_code = (e.code().0 & 0xFFFF) as u32;
                let msg = if win32_code == 1409 {
                    "快捷键已被其他程序占用".to_string()
                } else {
                    format!("注册快捷键失败: {}", e)
                };
                crate::utils::logger::log(
                    "hotkey",
                    &format!(
                        "register failed {:?} {} -> win32 code {}",
                        slot, hotkey, win32_code
                    ),
                );
                // 回滚：尝试恢复旧热键
                if !old_hotkey.is_empty() {
                    if let Some((old_mods, old_vk)) = parse_hotkey(&old_hotkey) {
                        if RegisterHotKey(
                            Some(hwnd),
                            hotkey_id,
                            windows::Win32::UI::Input::KeyboardAndMouse::HOT_KEY_MODIFIERS(
                                old_mods,
                            ),
                            old_vk as u32,
                        )
                        .is_ok()
                        {
                            slot_state.registered.store(true, Ordering::SeqCst);
                            crate::utils::logger::log(
                                "hotkey",
                                &format!("rolled back {:?} to: {}", slot, old_hotkey),
                            );
                        }
                    }
                }
                Err(msg)
            }
        }
    }
}

/// 在热键线程内执行的实际反注册逻辑
fn unregister_hotkey_inner(slot: HotkeySlotId) {
    let hwnd_ptr = HOTKEY_STATE.hwnd.load(Ordering::SeqCst);
    let hotkey_id = slot.id();
    let slot_state = &HOTKEY_STATE.slots[slot.index()];
    if hwnd_ptr != 0 {
        let hwnd = HWND(hwnd_ptr as *mut std::ffi::c_void);
        unsafe {
            let _ = UnregisterHotKey(Some(hwnd), hotkey_id);
        }
    }
    slot_state.registered.store(false, Ordering::SeqCst);
    if let Ok(mut g) = slot_state.current_hotkey.lock() {
        g.clear();
    }
    crate::utils::logger::log("hotkey", &format!("unregistered {:?}", slot));
}

/// 注册热键（可在任意线程调用）：通过 PostMessage 投递到热键线程执行，同步等待结果。
/// 返回 Ok(()) 成功，Err(消息) 表示冲突或失败。
/// 若新热键注册失败，会尝试回滚恢复之前的热键，避免新旧皆失。
pub fn register_hotkey(slot: HotkeySlotId, hotkey: &str) -> Result<(), String> {
    let hwnd_ptr = HOTKEY_STATE.hwnd.load(Ordering::SeqCst);
    if hwnd_ptr == 0 {
        return Err("热键线程未就绪".into());
    }
    let hwnd = HWND(hwnd_ptr as *mut std::ffi::c_void);

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let req = Box::new(HotkeyRequest {
        slot,
        hotkey: hotkey.to_string(),
        reply: tx,
    });
    let req_ptr = Box::into_raw(req);

    unsafe {
        // PostMessage 异步投递；若失败需回收 Box 避免泄漏
        if PostMessageW(
            Some(hwnd),
            WM_REGISTER_HOTKEY,
            WPARAM(0),
            LPARAM(req_ptr as isize),
        )
        .is_err()
        {
            drop(Box::from_raw(req_ptr));
            return Err("投递注册请求失败".into());
        }
    }
    // 同步等待热键线程回传结果（命令线程阻塞在此，可接受：用户设置快捷键是同步交互）
    rx.recv_timeout(Duration::from_secs(2))
        .map_err(|_| "等待热键注册结果超时".to_string())?
}

/// 反注册热键（清空快捷键时调用，可在任意线程）：PostMessage 到热键线程
pub fn unregister_hotkey(slot: HotkeySlotId) {
    let hwnd_ptr = HOTKEY_STATE.hwnd.load(Ordering::SeqCst);
    if hwnd_ptr == 0 {
        return;
    }
    let hwnd = HWND(hwnd_ptr as *mut std::ffi::c_void);
    unsafe {
        let _ = PostMessageW(
            Some(hwnd),
            WM_UNREGISTER_HOTKEY,
            WPARAM(slot.id() as usize),
            LPARAM(0),
        );
    }
}

/// 设置某槽位启用状态（仅启用时热键才触发）
pub fn set_slot_enabled(slot: HotkeySlotId, enabled: bool) {
    HOTKEY_STATE.slots[slot.index()]
        .enabled
        .store(enabled, Ordering::SeqCst);
    crate::utils::logger::log("hotkey", &format!("{:?}_enabled = {}", slot, enabled));
}

/// 设置截图工具启用状态（仅启用时热键才触发）
/// 向后兼容包装：等价于 set_slot_enabled(Screenshot, enabled)
pub fn set_screenshot_enabled(enabled: bool) {
    set_slot_enabled(HotkeySlotId::Screenshot, enabled);
}

/// 查询截图工具是否启用
#[allow(dead_code)]
pub fn is_screenshot_enabled() -> bool {
    HOTKEY_STATE.slots[HotkeySlotId::Screenshot.index()]
        .enabled
        .load(Ordering::SeqCst)
}

/// 解析热键字符串（如 "Ctrl+Shift+A"）为 (modifiers, vk_code)
/// 返回 None 表示格式无效
pub fn parse_hotkey(hotkey: &str) -> Option<(u32, u16)> {
    let s = hotkey.trim();
    if s.is_empty() {
        return None;
    }
    let mut mods = 0u32;
    let mut vk: Option<u16> = None;
    for part in s.split('+') {
        let p = part.trim().to_lowercase();
        match p.as_str() {
            "ctrl" | "control" => mods |= MOD_CONTROL.0,
            "alt" => mods |= MOD_ALT.0,
            "shift" => mods |= MOD_SHIFT.0,
            "win" | "super" | "meta" => mods |= MOD_WIN.0,
            _ => {
                if vk.is_some() {
                    return None;
                }
                vk = Some(parse_vk(&p)?);
            }
        }
    }
    let vk = vk?;
    // F1-F12 允许作为单键（无修饰键）；其余主键必须搭配至少一个修饰键，
    // 避免与系统/应用单键冲突。
    let is_fkey = (0x70..=0x7B).contains(&vk); // VK_F1 (0x70) .. VK_F12 (0x7B)
    if mods == 0 && !is_fkey {
        return None;
    }
    Some((mods, vk))
}

/// 将键名解析为虚拟键码
fn parse_vk(name: &str) -> Option<u16> {
    if let Some(n) = name.strip_prefix('f') {
        if let Ok(num) = n.parse::<u32>() {
            let vk = match num {
                1 => VK_F1.0,
                2 => VK_F2.0,
                3 => VK_F3.0,
                4 => VK_F4.0,
                5 => VK_F5.0,
                6 => VK_F6.0,
                7 => VK_F7.0,
                8 => VK_F8.0,
                9 => VK_F9.0,
                10 => VK_F10.0,
                11 => VK_F11.0,
                12 => VK_F12.0,
                _ => return None,
            };
            return Some(vk);
        }
    }
    let mut chars = name.chars();
    if name.len() == 1 {
        if let Some(c) = chars.next() {
            if c.is_ascii_lowercase() {
                return Some((c as u32 - 32) as u16);
            }
            if c.is_ascii_digit() {
                return Some(c as u16);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_hotkey_basic() {
        let (mods, vk) = parse_hotkey("Ctrl+Shift+A").unwrap();
        assert_ne!(mods & MOD_CONTROL.0, 0);
        assert_ne!(mods & MOD_SHIFT.0, 0);
        assert_eq!(vk, b'A' as u16);
    }

    #[test]
    fn test_parse_hotkey_fkeys() {
        let (mods, vk) = parse_hotkey("Ctrl+F5").unwrap();
        assert_ne!(mods & MOD_CONTROL.0, 0);
        assert_eq!(vk, VK_F5.0);
    }

    #[test]
    fn test_parse_hotkey_alt_s() {
        let (mods, vk) = parse_hotkey("Alt+S").unwrap();
        assert_ne!(mods & MOD_ALT.0, 0);
        assert_eq!(vk, b'S' as u16);
    }

    #[test]
    fn test_parse_hotkey_requires_modifier() {
        // 普通字母单键仍需修饰键
        assert!(parse_hotkey("A").is_none());
        // F1-F12 单键允许无修饰键
        let (mods, vk) = parse_hotkey("F5").unwrap();
        assert_eq!(mods, 0);
        assert_eq!(vk, VK_F5.0);
    }

    #[test]
    fn test_parse_hotkey_empty() {
        assert!(parse_hotkey("").is_none());
        assert!(parse_hotkey("   ").is_none());
    }

    #[test]
    fn test_parse_hotkey_multiple_keys() {
        assert!(parse_hotkey("Ctrl+A+B").is_none());
    }

    #[test]
    fn test_parse_hotkey_win_key() {
        let (mods, _) = parse_hotkey("Win+Shift+S").unwrap();
        assert_ne!(mods & MOD_WIN.0, 0);
        assert_ne!(mods & MOD_SHIFT.0, 0);
    }

    #[test]
    fn test_parse_hotkey_digit() {
        let (_, vk) = parse_hotkey("Ctrl+1").unwrap();
        assert_eq!(vk, b'1' as u16);
    }

    #[test]
    fn test_slot_id_mapping() {
        assert_eq!(HotkeySlotId::Screenshot.id(), HOTKEY_ID_SCREENSHOT);
        assert_eq!(HotkeySlotId::Voice.id(), HOTKEY_ID_VOICE);
        assert_eq!(HotkeySlotId::Recording.id(), HOTKEY_ID_RECORDING);
        assert_eq!(HotkeySlotId::Screenshot.index(), 0);
        assert_eq!(HotkeySlotId::Voice.index(), 1);
        assert_eq!(HotkeySlotId::Recording.index(), 2);
    }

    #[test]
    fn test_set_slot_enabled_screenshot_compat() {
        // set_screenshot_enabled 等价于 set_slot_enabled(Screenshot, ..)
        set_screenshot_enabled(true);
        assert!(is_screenshot_enabled());
        set_screenshot_enabled(false);
        assert!(!is_screenshot_enabled());
    }
}
