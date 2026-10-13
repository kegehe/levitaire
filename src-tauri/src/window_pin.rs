//! 通用工具 · 窗口置顶。
//!
//! 把**其他程序**的窗口钉在最前：`SetWindowPos` 是系统级窗口管理器接口，作用在目标
//! 窗口自己的 `WS_EX_TOPMOST` 扩展样式位上，跨进程有效（PowerToys 的 Always on Top
//! 同理）。置顶与取消都用 `SWP_NOACTIVATE`，全程不改动用户的焦点归属。
//!
//! 本模块维护一份「我改过哪些窗口」的内存清单，只为一件事服务 —— **工具停用或程序
//! 退出时把它们恢复原状**。置顶是写在目标窗口自己身上的状态，Levitaire 退出并不会
//! 自动撤销它；没有这份清单，用户会留下一个「莫名其妙永远在最前面」的窗口，还查不到
//! 是谁干的。
//!
//! 清单不落盘：`HWND` 跨进程重启即失效、且句柄值会被系统复用给无关窗口，持久化它只会
//! 让下次启动去操作一堆别人的窗口。程序被强制结束时无法兜底，这是这类工具的固有代价。

use std::ffi::c_void;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetWindowLongPtrW, GetWindowTextW, GetWindowThreadProcessId, IsWindow,
    SetWindowPos, WindowFromPoint, GA_ROOT, GWL_EXSTYLE, HWND_NOTOPMOST, HWND_TOPMOST,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_EX_TOPMOST,
};

/// 面板事件名：清单变化与用户提示一次性推送。
const UPDATE_EVENT: &str = "window-pin-updated";
/// 清单里标题的字符上限。面板宽度有限，超长网页标题没有整段带过去的必要。
const MAX_TITLE_CHARS: usize = 120;

/// 一个由本工具置顶的窗口。
#[derive(Clone)]
struct PinnedWindow {
    hwnd: isize,
    /// 窗口所属进程号。清理时用它做身份校验 —— 见 `cleanup`。
    /// 句柄值会被系统复用给无关窗口，进程号是唯一稳的判据（标题会随页面、文档变化）。
    pid: u32,
    title: String,
}

/// 推给前端的清单项。
#[derive(Clone, Serialize)]
pub struct PinnedWindowInfo {
    pub hwnd: i64,
    pub title: String,
}

/// 推给前端的完整载荷：清单 + 一句给用户看的提示 + 点选模式状态。
#[derive(Clone, Serialize)]
struct PinUpdate {
    windows: Vec<PinnedWindowInfo>,
    message: Option<String>,
    /// 这条 `message` 是一次失败。面板按它换配色 —— 否则「已置顶：X」和
    /// 「无法置顶：X（权限不足）」长得一模一样，用户会把失败读成操作成功。
    error: bool,
    /// 当前是否仍在点选模式。点选成功、Esc 退出、面板收起都会让它变成 false，
    /// 而这些路径都不经过前端 —— 带上它，按钮状态才不用前端自己猜。
    picking: bool,
}

static LIST: Mutex<Vec<PinnedWindow>> = Mutex::new(Vec::new());

/// 取清单锁。中毒（持锁线程 panic）时沿用内部数据：清单只是几个句柄与标题，
/// 没有需要靠 panic 保护的中间态，让整个工具因一次中毒而永久失效才是更糟的结果。
fn lock_list() -> MutexGuard<'static, Vec<PinnedWindow>> {
    LIST.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ─── Win32 薄封装 ──────────────────────────────────────────────

/// 窗口当前是否处于置顶带（读它自己的 `WS_EX_TOPMOST` 样式位）。
fn is_topmost(hwnd: HWND) -> bool {
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    (style as u32) & WS_EX_TOPMOST.0 != 0
}

/// Win32 错误 5 = `ERROR_ACCESS_DENIED`。`Error::from_win32` 会把它包成
/// `HRESULT_FROM_WIN32(5)`，低 16 位仍保留原始错误码。
fn is_access_denied(error: &windows::core::Error) -> bool {
    (error.code().0 as u32) & 0xFFFF == 5
}

/// 设置/取消置顶。
///
/// 失败必须**报出来**而不是静默：最常见的失败原因是目标进程以管理员权限运行，
/// 而非管理员的本进程受 UIPI 限制改不动它的窗口 —— 用户视角看就是「点了没反应」，
/// 没有错误提示就只会以为工具坏了。
fn set_topmost(hwnd: HWND, topmost: bool) -> Result<(), String> {
    if !unsafe { IsWindow(Some(hwnd)).as_bool() } {
        return Err("目标窗口已关闭".to_string());
    }
    let insert_after = if topmost { HWND_TOPMOST } else { HWND_NOTOPMOST };
    unsafe {
        SetWindowPos(
            hwnd,
            Some(insert_after),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
    }
    .map_err(|error| {
        if is_access_denied(&error) {
            // 文案要顺着**当前这个动作**说：取消置顶失败却提示「无法置顶」，
            // 会把用户支到反方向去。
            let action = if topmost { "置顶" } else { "取消置顶" };
            format!("无法{action}：该窗口以管理员权限运行，当前权限不足")
        } else {
            format!("无法调整窗口层级：{error}")
        }
    })
}

/// 窗口标题（供清单展示）。超长标题先截断，免得整段网页标题塞进事件载荷。
fn window_title(hwnd: HWND) -> String {
    let mut buffer = [0u16; 512];
    let length = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    if length <= 0 {
        return "未命名窗口".to_string();
    }
    let title: String = String::from_utf16_lossy(&buffer[..length as usize])
        .chars()
        .take(MAX_TITLE_CHARS)
        .collect();
    let trimmed = title.trim();
    if trimmed.is_empty() {
        "未命名窗口".to_string()
    } else {
        trimmed.to_string()
    }
}

fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

/// 坐标下的顶层窗口；不可用时返回 `None`。
fn root_window_at(app: &AppHandle, x: i32, y: i32) -> Option<HWND> {
    let hit = unsafe { WindowFromPoint(POINT { x, y }) };
    if hit.0.is_null() {
        return None;
    }
    // 现代应用（Electron / UWP / 浏览器）命中的多是子控件 HWND，直接置顶它没有效果，
    // 必须先归到顶层窗口。与滚动导航取目标同一套口径。
    let root = unsafe { GetAncestor(hit, GA_ROOT) };
    let root = if root.0.is_null() { hit } else { root };
    crate::commands::is_usable_target(app, root).then_some(root)
}

// ─── 清单与推送 ────────────────────────────────────────────────

/// 淘汰清单里**已经不存在的条目**。
///
/// 用户把被置顶的目标窗口自己关掉时，没有任何事件会通知本模块 —— 不回收，清单就会随
/// 「置顶 → 关窗（不取消）」的次数一直累积，面板上还会留着一排点不动的死条目。
/// 判据与 `unpin` / `unpin_all` 完全一致：`IsWindow` **加** pid 校验 ——
/// 句柄值会被系统复用给别的窗口，只判 `IsWindow` 会把别人的窗口当成我们的置顶对象。
///
/// 只在**读取口**（`list` / `emit_update`）调用，不塞进 `snapshot()`：`snapshot` 是纯映射，
/// 单测要靠它断言清单的簿记逻辑（去重、删除），而那些用例用的是伪造句柄。
fn prune_closed_entries() {
    let mut list = lock_list();
    list.retain(|item| {
        let hwnd = HWND(item.hwnd as *mut c_void);
        // 括号不能省：`unsafe { .. }` 出现在语句开头时会被当成语句，后面的 `&&` 会被解析成
        // 取地址（曾因此得到 `&&u32` 与 `u32` 比较的编译错误）。
        (unsafe { IsWindow(Some(hwnd)).as_bool() }) && window_pid(hwnd) == item.pid
    });
}

fn snapshot() -> Vec<PinnedWindowInfo> {
    lock_list()
        .iter()
        .map(|item| PinnedWindowInfo {
            hwnd: item.hwnd as i64,
            title: item.title.clone(),
        })
        .collect()
}

/// 把面板重新抬到置顶带最前。
///
/// 刚被置顶的目标窗口在置顶带里的次序高于面板，会直接盖住它 —— 用户点完就看不见结果了。
/// `SWP_NOACTIVATE` 保证抬升过程不抢焦点。
fn raise_hub(app: &AppHandle) {
    let Some(hwnd) = app
        .get_webview_window("utility-hub-overlay")
        .and_then(|window| window.hwnd().ok())
    else {
        return;
    };
    unsafe {
        let _ = SetWindowPos(
            HWND(hwnd.0),
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

/// 推送最新清单 + 一句提示。面板不可用时静默丢弃（它本就没显示）。
fn emit_update(app: &AppHandle, message: Option<String>, error: bool) {
    // 推送前先回收：用户自己关掉被置顶窗口时没有任何事件通知本模块，
    // 不在这里淘汰，面板会一直留着一排点不动的死条目。
    prune_closed_entries();
    let payload = PinUpdate {
        windows: snapshot(),
        message,
        error,
        picking: crate::hooks::mouse::is_window_pin_active(),
    };
    let _ = app.emit_to("utility-hub-overlay", UPDATE_EVENT, payload);
}

/// 从清单里摘掉某个窗口（不存在时无操作）。
fn forget(hwnd: HWND) {
    lock_list().retain(|item| item.hwnd != hwnd.0 as isize);
}

/// 把窗口记进清单。按句柄去重：同一扇窗口可能被反复置顶（中途曾被别的程序取消），
/// 不去重会让退出清理对同一扇窗口重复操作，清单里也会出现重复条目。
fn remember(hwnd: HWND, title: String) {
    let entry = PinnedWindow {
        hwnd: hwnd.0 as isize,
        pid: window_pid(hwnd),
        title,
    };
    let mut list = lock_list();
    list.retain(|item| item.hwnd != entry.hwnd);
    list.push(entry);
}

// ─── 对外接口 ──────────────────────────────────────────────────

/// 点选落点：切换该坐标下窗口的置顶状态。
///
/// 语义是**纯切换**（与 PowerToys 一致），不做「这是不是我置顶的」区分 —— 否则
/// Levitaire 重启一次（内存清单丢失，而窗口仍是置顶的），用户就再也取消不掉那个窗口了。
pub fn toggle_at(app: &AppHandle, x: i32, y: i32) -> Result<String, String> {
    let hwnd = root_window_at(app, x, y).ok_or_else(|| "该位置没有可置顶的窗口".to_string())?;
    let title = window_title(hwnd);

    if is_topmost(hwnd) {
        set_topmost(hwnd, false)?;
        forget(hwnd);
        raise_hub(app);
        return Ok(format!("已取消置顶：{title}"));
    }

    set_topmost(hwnd, true)?;
    remember(hwnd, title.clone());
    raise_hub(app);
    Ok(format!("已置顶：{title}"))
}

/// 取消指定窗口的置顶（面板清单里的单条操作）。
///
/// 标题取**清单里记的那份**而不是现读窗口：窗口若已关闭，再读只会得到「未命名窗口」，
/// 而用户需要看到是哪一个窗口从列表里消失了。
pub fn unpin(app: &AppHandle, hwnd_value: i64) -> Result<String, String> {
    let entry = lock_list()
        .iter()
        .find(|item| item.hwnd == hwnd_value as isize)
        .cloned()
        .ok_or_else(|| "该窗口已不在置顶列表中".to_string())?;

    let hwnd = HWND(entry.hwnd as *mut c_void);
    // 句柄值会被系统复用：原窗口已经关了、而这个值落到了别人身上时，绝不能照着它
    // 调 SetWindowPos —— 那会把无关窗口的置顶状态改掉。此时只把它从列表里摘掉。
    if !unsafe { IsWindow(Some(hwnd)).as_bool() } || window_pid(hwnd) != entry.pid {
        forget(hwnd);
        raise_hub(app);
        return Ok(format!("{} 已关闭，已从列表移除", entry.title));
    }

    set_topmost(hwnd, false)?;
    forget(hwnd);
    raise_hub(app);
    Ok(format!("已取消置顶：{}", entry.title))
}

/// 取消全部由本工具置顶的窗口，返回（已取消数, 未成功数）。
///
/// 只处理**清单内**的窗口：用户自己或别的程序把某个窗口置顶，与 Levitaire 无关，
/// 不在这里动它。
///
/// 取消失败的窗口会**原样留在清单里**：它们仍然是置顶的，丢掉记录就等于让用户
/// 再也取消不掉（只能去结束那个进程）。
pub fn unpin_all(app: &AppHandle) -> (usize, usize) {
    let items = {
        let mut list = lock_list();
        std::mem::take(&mut *list)
    };
    let (mut done, mut failed) = (0usize, 0usize);
    let mut keep: Vec<PinnedWindow> = Vec::new();
    for item in items {
        let hwnd = HWND(item.hwnd as *mut c_void);
        // 窗口已关 / 句柄值已易主：不必也不该再动它，直接丢弃这条记录。
        // 句柄值会被系统复用给新窗口，进程号比标题稳定得多（标题随页面、文档变化）。
        if !unsafe { IsWindow(Some(hwnd)).as_bool() } || window_pid(hwnd) != item.pid {
            continue;
        }
        match set_topmost(hwnd, false) {
            Ok(()) => done += 1,
            Err(_) => {
                failed += 1;
                keep.push(item);
            }
        }
    }
    // 用 extend 而不是整体覆盖：清点期间可能有新的置顶（点在面板上的另一次操作），
    // 那部分记录不能被这次清理吞掉。
    if !keep.is_empty() {
        lock_list().extend(keep);
    }
    if done > 0 {
        raise_hub(app);
    }
    (done, failed)
}

/// 工具停用 / 程序退出时的收尾：恢复所有由本工具置顶的窗口。
pub fn cleanup() {
    let items = {
        let mut list = lock_list();
        std::mem::take(&mut *list)
    };
    for item in items {
        let hwnd = HWND(item.hwnd as *mut c_void);
        if !unsafe { IsWindow(Some(hwnd)).as_bool() } {
            continue;
        }
        if window_pid(hwnd) != item.pid {
            continue;
        }
        let _ = set_topmost(hwnd, false);
    }
}

/// 读取当前清单（前端挂载或重新获焦时同步真值）。
pub fn list() -> Vec<PinnedWindowInfo> {
    // 同步真值时就该回收：这是"面板刚打开/重新获焦"的时刻，
    // 也正是用户最可能刚在别处关掉过某个被置顶窗口的时刻。
    prune_closed_entries();
    snapshot()
}

/// 推送当前清单，可选带一句**成功**提示（状态同步用 `None`）。
pub fn publish(app: &AppHandle, message: Option<String>) {
    emit_update(app, message, false);
}

/// 推送当前清单 + 一句失败提示（面板会给它换上与成功提示不同的配色）。
pub fn publish_error(app: &AppHandle, message: String) {
    emit_update(app, Some(message), true);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 清单是全局单例，测试并行跑会互相踩。仅本模块内的用例之间需要串行。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn fake_hwnd(value: usize) -> HWND {
        HWND(value as *mut c_void)
    }

    fn with_clean_list(body: impl FnOnce()) {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        lock_list().clear();
        body();
        lock_list().clear();
    }

    #[test]
    fn access_denied_is_recognised_through_the_hresult_wrapper() {
        // `Error::from_win32` 把 GetLastError 包成 HRESULT_FROM_WIN32：ERROR_ACCESS_DENIED(5)
        // 变成 0x8007_0005，低 16 位仍是原码 —— 这正是识别权限不足的依据。
        let denied =
            windows::core::Error::from_hresult(windows::core::HRESULT(0x8007_0005u32 as i32));
        assert!(is_access_denied(&denied));
    }

    #[test]
    fn unrelated_failures_are_not_reported_as_permission_problems() {
        // ERROR_FILE_NOT_FOUND(2)：同样经 HRESULT_FROM_WIN32 包装，但绝不能提示
        // 「权限不足」——那会把用户引向完全错误的排查方向。
        let missing =
            windows::core::Error::from_hresult(windows::core::HRESULT(0x8007_0002u32 as i32));
        assert!(!is_access_denied(&missing));
    }

    #[test]
    fn remember_deduplicates_by_handle_and_keeps_the_latest_title() {
        with_clean_list(|| {
            let hwnd = fake_hwnd(0x1000);
            remember(hwnd, "旧标题".into());
            remember(hwnd, "新标题".into());

            let items = snapshot();
            assert_eq!(items.len(), 1, "同一扇窗口只应留下一条记录");
            assert_eq!(items[0].title, "新标题");
            assert_eq!(items[0].hwnd, 0x1000);
        });
    }

    #[test]
    fn forget_removes_only_the_matching_handle() {
        with_clean_list(|| {
            let a = fake_hwnd(0x1000);
            let b = fake_hwnd(0x2000);
            remember(a, "A".into());
            remember(b, "B".into());

            forget(a);

            let items = snapshot();
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].hwnd, 0x2000);
        });
    }

    #[test]
    fn forget_on_an_unknown_handle_is_a_no_op() {
        with_clean_list(|| {
            remember(fake_hwnd(0x1000), "A".into());
            forget(fake_hwnd(0x9999));
            assert_eq!(snapshot().len(), 1);
        });
    }
}
