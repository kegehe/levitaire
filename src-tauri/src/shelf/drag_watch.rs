//! 全局「开始拖文件」探测。
//!
//! 系统没有「拖放开始」的全局通知：只有光标进入放置目标窗口时，OLE 才会回调
//! `IDropTarget`。要在用户刚拎起文件、还没挪到暂存架上时就给出引导，只能自己看：
//!
//! - 按下点落在文件视图里（父链上有 `SHELLDLL_DefView`：资源管理器列表 / 桌面图标）；
//! - 按下后位移超过阈值，说明这是一次拖拽而不是点击。
//!
//! 两个条件都满足才通知暂存架进入「待放入」状态。判定放在独立线程里轮询，
//! 不塞进鼠标钩子的热路径——钩子回调慢会被系统摘掉。
//!
//! 按「按下点」而不是「当前捕获窗口」判断：OLE 拖放走的是它自己的鼠标钩子，
//! 源窗口不一定还握着 SetCapture，实测 `GetGUIThreadInfo.hwndCapture` 常常是空的。
//!
//! 已知误报：在资源管理器里拉框多选同样满足条件，暂存架会亮一下。代价只是闪烁。

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetCursorPos, GetParent, WindowFromPoint,
};

/// 位移超过这么多像素才算拖拽；与鼠标钩子里区分点击/拖拽的口径一致。
const DRAG_THRESHOLD_PX: i32 = 6;
const TICK: Duration = Duration::from_millis(40);

static STARTED: AtomicBool = AtomicBool::new(false);
static PRESSED: AtomicBool = AtomicBool::new(false);
/// 这次按下是不是落在文件视图里（按下时算一次，之后不再重复判断）。
static FROM_FILES: AtomicBool = AtomicBool::new(false);
static ARMED: AtomicBool = AtomicBool::new(false);
static DOWN_X: AtomicI32 = AtomicI32::new(0);
static DOWN_Y: AtomicI32 = AtomicI32::new(0);

pub fn start(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        if !PRESSED.load(Ordering::SeqCst) {
            continue;
        }
        // 抬起事件可能被某些模式（取色、置顶点选等）吞掉，兜底自查按键状态。
        // 必须放在 ARMED 判断**之前**：高亮亮着的时候松手，恰恰最需要这条兜底。
        let still_down = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000 != 0;
        if !still_down {
            PRESSED.store(false, Ordering::SeqCst);
            if ARMED.swap(false, Ordering::SeqCst) {
                let _ = app.emit_to("file-shelf-overlay", "file-shelf-drag-armed", false);
            }
            continue;
        }
        if ARMED.load(Ordering::SeqCst) || !FROM_FILES.load(Ordering::SeqCst) {
            continue;
        }
        let mut point = POINT::default();
        if unsafe { GetCursorPos(&mut point) }.is_err() {
            continue;
        }
        let moved = (point.x - DOWN_X.load(Ordering::SeqCst)).abs()
            + (point.y - DOWN_Y.load(Ordering::SeqCst)).abs();
        if moved < DRAG_THRESHOLD_PX {
            continue;
        }
        ARMED.store(true, Ordering::SeqCst);
        crate::utils::logger::log("shelf", "检测到文件拖拽开始，暂存架进入待放入");
        let _ = app.emit_to("file-shelf-overlay", "file-shelf-drag-armed", true);
    });
}

/// 左键按下：判断这次按下的起点是不是文件视图。由鼠标钩子的工作线程调用。
pub fn on_mouse_down(x: i32, y: i32) {
    DOWN_X.store(x, Ordering::SeqCst);
    DOWN_Y.store(y, Ordering::SeqCst);
    FROM_FILES.store(point_in_file_view(x, y), Ordering::SeqCst);
    PRESSED.store(true, Ordering::SeqCst);
}

/// 左键抬起：无论这次拖的是什么，都退出「待放入」状态。
pub fn on_mouse_up(app: &AppHandle) {
    PRESSED.store(false, Ordering::SeqCst);
    if ARMED.swap(false, Ordering::SeqCst) {
        let _ = app.emit_to("file-shelf-overlay", "file-shelf-drag-armed", false);
    }
}

/// 落点所在的窗口是不是资源管理器/桌面的文件视图。
///
/// 沿父链找 `SHELLDLL_DefView`：资源管理器的列表和桌面图标都挂在它下面；
/// 暂存架自己的 WebView2 永远不在这条链上，所以从暂存架往外拖不会误亮。
fn point_in_file_view(x: i32, y: i32) -> bool {
    unsafe {
        let mut hwnd = WindowFromPoint(POINT { x, y });
        while !hwnd.0.is_null() {
            let mut buffer = [0u16; 64];
            let len = GetClassNameW(hwnd, &mut buffer);
            if len > 0
                && String::from_utf16_lossy(&buffer[..len as usize]) == "SHELLDLL_DefView"
            {
                return true;
            }
            hwnd = match GetParent(hwnd) {
                Ok(parent) => parent,
                Err(_) => break,
            };
        }
        false
    }
}
