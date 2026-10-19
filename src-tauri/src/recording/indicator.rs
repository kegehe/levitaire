//! 全屏录制的原生指示层：屏幕边缘呼吸框 + 录制控制栏。
//!
//! ## 为什么全屏录制要单独做一层原生窗
//!
//! 全屏录制的录制范围是整个虚拟桌面，控制栏只能压在录制区域内，而抓帧走的是
//! `screenshot::capture_screen_region`（`GetDC(None)` + `BitBlt`），压在区域内的
//! 自有窗口会被一并截进成片。项目里唯一「对用户可见但不进捕获」的手段是
//! `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`；而**透明 WebView2 窗口**加上
//! 该标记后整窗会从桌面上消失（见 `commands::set_recording_capture_protection` 与
//! `commands::configure_long_capture_frame` 两处注释，都是为此踩过的坑），所以现成的
//! WebView2 控制栏没法用。
//!
//! 原生 GDI 窗经 `examples/wda_probe.rs` 在本机实测（同一条 BitBlt 路径）：
//! - 未加标记 59136/59136 像素被截到 → 加标记后 0/59136，重绘、hide/show 后依然为 0；
//! - `SetWindowRgn` 挖空的空心边框同样被排除，且镂空处鼠标穿透、不挡下层应用。
//!
//! 因此：**全屏录制**改用本模块的原生窗；**区域/窗口录制**维持原有 WebView2 控制栏
//! （它们的控制栏本就在录制区域外，无需排除），**截屏**完全不涉及。
//!
//! ## 坐标系与线程
//!
//! 原生窗直接用**物理像素**，与 `get_virtual_desktop_bounds` 同一坐标系，不需要
//! WebView2 overlay 那套「物理 / scale」换算。
//!
//! 窗口只能由创建它的线程销毁，而 Tauri 命令可能跑在工作线程上，故创建与销毁
//! 一律 post 到主线程，靠同一消息队列的 FIFO 顺序保证不会「先销毁后创建」。

use std::sync::atomic::{AtomicIsize, Ordering};

use tauri::{AppHandle, Manager};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CombineRgn, CreateCompatibleBitmap, CreateCompatibleDC, CreateFontW,
    CreatePen, CreateRectRgn, CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, Ellipse,
    EndPaint, FillRect, GetDC, GetDeviceCaps, GetMonitorInfoW, GetStockObject, InvalidateRect,
    LineTo, MonitorFromPoint, MoveToEx, Polygon, ReleaseDC, RoundRect, SelectObject, SetBkMode,
    SetTextColor, SetWindowRgn, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET,
    DEFAULT_PITCH, DT_LEFT, DT_RIGHT, DT_SINGLELINE, DT_VCENTER, FF_DONTCARE, FW_BOLD, FW_NORMAL,
    LOGPIXELSY, MONITORINFO, MONITOR_DEFAULTTONEAREST, NULL_PEN, PAINTSTRUCT, PS_SOLID, RGN_DIFF,
    SRCCOPY, TRANSPARENT,
};

use windows::Win32::Graphics::Gdi::{HBITMAP, HDC, HFONT, HGDIOBJ};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetCursorPos,
    GetWindowDisplayAffinity, GetWindowLongPtrW, GetWindowRect, KillTimer, LoadCursorW,
    PostMessageW, RegisterClassExW, SetLayeredWindowAttributes, SetTimer, SetWindowDisplayAffinity,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, CREATESTRUCTW, CS_HREDRAW, CS_VREDRAW,
    GWL_USERDATA, HWND_TOPMOST, IDC_ARROW, LWA_ALPHA, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SW_SHOWNOACTIVATE, WDA_EXCLUDEFROMCAPTURE, WM_CLOSE, WM_ERASEBKGND, WM_LBUTTONDOWN,
    WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCCREATE, WM_NCDESTROY, WM_PAINT, WM_TIMER, WNDCLASSEXW,
    WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

use crate::recording::RecordingState;

/// 窗口标题统一以 `Levitaire` 开头：`commands::is_own_window` 与
/// `recording::window_detect` 都用标题前缀兜底排除自有窗口，而原生窗没有 label 可挂。
const FRAME_TITLE: PCWSTR = w!("Levitaire 录制边框");
const BAR_TITLE: PCWSTR = w!("Levitaire 录制控制栏");
const FRAME_CLASS: PCWSTR = w!("LevitaireRecordingFrame");
const BAR_CLASS: PCWSTR = w!("LevitaireRecordingBar");

/// 呼吸框线宽与颜色（逻辑像素 / 与选区框同一套绿色）
const FRAME_BORDER: i32 = 3;
const FRAME_COLOR: COLORREF = COLORREF(0x00_5E_C5_22); // #22C55E

/// 控制栏尺寸（逻辑像素）
const BAR_WIDTH: i32 = 168;
const BAR_HEIGHT: i32 = 76;
/// 控制栏与屏幕边角的间距（逻辑像素）
const BAR_GAP: i32 = 18;
/// 呼吸周期，与 CSS `rec-outline-breathe` 一致
const BREATHE_PERIOD_MS: u64 = 1400;
/// 动画帧间隔（约 30fps）
const ANIM_INTERVAL_MS: u32 = 33;

const TIMER_ANIM: usize = 1;

/// 当前存活的原生窗（0 = 不存在）。
/// 存 `isize` 而非 `HWND`：`HWND` 内含裸指针不是 `Send`，放不进 static。
static FRAME_HWND: AtomicIsize = AtomicIsize::new(0);
static BAR_HWND: AtomicIsize = AtomicIsize::new(0);

// ─── 配色 ────────────────────────────────────────────────────────

/// 控制栏配色，跟随前端主题（`show` 的 `dark` 参数决定用哪套）
#[derive(Clone, Copy)]
struct Palette {
    panel: COLORREF,
    border: COLORREF,
    text: COLORREF,
    muted: COLORREF,
    rec: COLORREF,
    rec_dim: COLORREF,
    paused: COLORREF,
    button: COLORREF,
    button_hover: COLORREF,
    button_stop: COLORREF,
}

impl Palette {
    /// COLORREF 为 `0x00BBGGRR`
    const DARK: Palette = Palette {
        panel: COLORREF(0x00_26_22_20),        // #202226
        border: COLORREF(0x00_46_40_3C),       // #3C4046
        text: COLORREF(0x00_F4_F2_F0),         // #F0F2F4
        muted: COLORREF(0x00_A6_9E_96),        // #969EA6
        rec: COLORREF(0x00_44_44_EF),          // #EF4444
        rec_dim: COLORREF(0x00_28_28_8A),      // #8A2828
        paused: COLORREF(0x00_0B_9E_F5),       // #F59E0B
        button: COLORREF(0x00_40_3A_37),       // #373A40
        button_hover: COLORREF(0x00_56_4F_4B), // #4B4F56
        button_stop: COLORREF(0x00_32_32_BE),  // #BE3232
    };

    const LIGHT: Palette = Palette {
        panel: COLORREF(0x00_FC_FA_FA),        // #FAFAFC
        border: COLORREF(0x00_E0_DA_D6),       // #D6DAE0
        text: COLORREF(0x00_1E_1A_18),         // #181A1E
        muted: COLORREF(0x00_7C_74_6E),        // #6E747C
        rec: COLORREF(0x00_44_44_DC),          // #DC4444
        rec_dim: COLORREF(0x00_96_96_F0),      // #F09696
        paused: COLORREF(0x00_0B_9E_D9),       // #D99E0B
        button: COLORREF(0x00_F0_ED_EB),       // #EBEDF0
        button_hover: COLORREF(0x00_E4_DF_DC), // #DCDFE4
        button_stop: COLORREF(0x00_32_32_BE),  // #BE3232
    };
}

// ─── 对外接口 ────────────────────────────────────────────────────

/// 创建全屏录制指示层（呼吸框 + 控制栏）。
///
/// 系统不支持 `WDA_EXCLUDEFROMCAPTURE`（Win10 2004 以下）时**整体放弃**：宁可不显示
/// 指示层（退回今天的静默录制 + 全局快捷键），也不要把 UI 录进成片。
pub fn show(app: &AppHandle, region: RECT, dark: bool) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || create_now(&handle, region, dark))
        .map_err(|error| format!("创建录制指示层失败: {}", error))
}

/// 销毁指示层。
///
/// 用 `PostMessage(WM_CLOSE)` 让窗口**自己**在稍后的消息里自毁，而不是直接
/// `DestroyWindow`：
/// - 用户点控制栏的「停止」时，这个调用就发生在控制栏**自己的窗口过程里**，
///   同步销毁会让窗口过程返回后再碰到已释放的状态；
/// - `run_on_main_thread` 在主线程上会**内联执行**（tauri-runtime-wry 的
///   `send_user_message` 检测到主线程就直接调用），指望它把销毁推迟到当前消息
///   之后并不可靠。
///
/// `PostMessage` 线程安全且必定异步，窗口过程用默认处理（`DefWindowProcW` 收到
/// WM_CLOSE 即 `DestroyWindow`），故任意线程调用都安全。
pub fn destroy() {
    for slot in [&FRAME_HWND, &BAR_HWND] {
        // 先清原子量再投递：立刻置 0 保证重复调用不会对同一窗口投递两次
        let raw = slot.swap(0, Ordering::SeqCst);
        if raw != 0 {
            unsafe {
                let _ = PostMessageW(Some(HWND(raw as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    }
}

// ─── 创建 / 销毁 ─────────────────────────────────────────────────

/// 同步销毁当前记录的窗口。只允许在**窗口过程之外**调用（建窗前清场用）；
/// 窗口过程内触发的销毁一律走 [`destroy`] 的异步路径。
fn destroy_now() {
    for slot in [&FRAME_HWND, &BAR_HWND] {
        let raw = slot.swap(0, Ordering::SeqCst);
        if raw != 0 {
            unsafe {
                let _ = DestroyWindow(HWND(raw as *mut _));
            }
        }
    }
}

fn create_now(app: &AppHandle, region: RECT, dark: bool) {
    // 幂等：重复触发（例如连点两次「开始录制」）时先清掉上一轮，避免残留窗口
    destroy_now();

    if !register_classes() {
        crate::utils::logger::log("recording", "指示层窗口类注册失败，退回静默录制");
        return;
    }

    let scale = system_scale();
    let palette = if dark { Palette::DARK } else { Palette::LIGHT };

    // 逐窗创建并就地失败清理：此刻两个 HWND 还没登记进原子量，[`destroy_now`] 看不到它们，
    // 漏掉哪一扇都会在屏幕上留下一圈再也关不掉的呼吸框。
    let frame = match create_frame(region, scale) {
        Some(frame) => frame,
        None => {
            crate::utils::logger::log("recording", "呼吸框创建失败，退回静默录制");
            return;
        }
    };
    let bar = match create_bar(app, region, scale, palette) {
        Some(bar) => bar,
        None => {
            unsafe {
                let _ = DestroyWindow(frame);
            }
            crate::utils::logger::log("recording", "控制栏创建失败，退回静默录制");
            return;
        }
    };

    // 两个窗都必须能被排除出捕获，否则整体放弃
    if !exclude_from_capture(frame) || !exclude_from_capture(bar) {
        unsafe {
            let _ = DestroyWindow(frame);
            let _ = DestroyWindow(bar);
        }
        crate::utils::logger::log(
            "recording",
            "系统不支持 WDA_EXCLUDEFROMCAPTURE，指示层放弃显示，退回静默录制",
        );
        return;
    }

    // 建窗期间用户可能已经取消（Esc 钩子线程走 `finish_recording_controls` → [`destroy`]，
    // 那时两个 HWND 还没登记进原子量，销毁不到它们）。不补这一刀就会在屏幕上留下一圈
    // 再也关不掉的呼吸框，只能重启应用。放在登记之前，登记之后窗口就一定能被 destroy 到了。
    let still_running = app
        .try_state::<RecordingState>()
        .map(|state| state.is_running())
        .unwrap_or(false);
    if !still_running {
        unsafe {
            let _ = DestroyWindow(frame);
            let _ = DestroyWindow(bar);
        }
        crate::utils::logger::log("recording", "指示层创建期间录制已结束，放弃显示");
        return;
    }

    // 先登记再显示：登记之后 `destroy` 才够得着这两扇窗；万一它恰好插在登记与显示之间，
    // 投出的 WM_CLOSE 也会让窗口自毁（最多闪一帧），不会留下残留。
    FRAME_HWND.store(frame.0 as isize, Ordering::SeqCst);
    BAR_HWND.store(bar.0 as isize, Ordering::SeqCst);

    // 确认能排除出捕获后再亮出来，避免「闪一下又消失」。
    // SetWindowPos 把两窗抬到置顶带最上层：screenshot-overlay 也是置顶窗，
    // 指示层必须压在它上面才看得见（且它此时是鼠标穿透的，不会抢走点击）。
    for hwnd in [frame, bar] {
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }

    crate::utils::logger::log(
        "recording",
        "全屏录制指示层已创建（已排除出捕获，不会进入成片）",
    );
}

/// 声明「本窗不参与屏幕捕获」，返回是否生效。
fn exclude_from_capture(hwnd: HWND) -> bool {
    unsafe {
        if SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE).is_err() {
            return false;
        }
        // 回读确认，避免个别版本静默忽略
        let mut current: u32 = 0;
        GetWindowDisplayAffinity(hwnd, &mut current).is_ok() && current == WDA_EXCLUDEFROMCAPTURE.0
    }
}

fn register_classes() -> bool {
    unsafe {
        let hinst = match windows::Win32::System::LibraryLoader::GetModuleHandleW(None) {
            Ok(hinst) => hinst,
            Err(_) => return false,
        };
        let cursor = LoadCursorW(None, IDC_ARROW).unwrap_or_default();

        let frame = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(frame_wndproc),
            hInstance: hinst.into(),
            lpszClassName: FRAME_CLASS,
            hCursor: cursor,
            ..Default::default()
        };
        // 类可能已注册（同一会话内录制多次），重复注册的错误可以忽略
        let _ = RegisterClassExW(&frame);

        let bar = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(bar_wndproc),
            hInstance: hinst.into(),
            lpszClassName: BAR_CLASS,
            hCursor: cursor,
            ..Default::default()
        };
        let _ = RegisterClassExW(&bar);
        !hinst.is_invalid()
    }
}

/// 系统 DPI 缩放（1.0 = 100%）。
///
/// 用 `GetDeviceCaps(LOGPIXELSY)` 而不是 `GetDpiForWindow`：后者属于 `Win32_UI_HiDpi`
/// 特性，当前未开启。代价是**混合 DPI 的多显示器**下指示层按主显示器缩放渲染，
/// 落在另一块缩放不同的屏幕上时尺寸可能略有偏差。
fn system_scale() -> f32 {
    unsafe {
        let dc = GetDC(None);
        if dc.is_invalid() {
            return 1.0;
        }
        let dpi = GetDeviceCaps(Some(dc), LOGPIXELSY);
        let _ = ReleaseDC(None, dc);
        if dpi <= 0 {
            1.0
        } else {
            dpi as f32 / 96.0
        }
    }
}

/// 呼吸权重 0..1（正弦，1.4s 一周期）。用全局时钟算，两个窗口都不必存起始时间。
fn breathe_weight() -> f32 {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let phase = (ms % BREATHE_PERIOD_MS) as f32 / BREATHE_PERIOD_MS as f32;
    (phase * std::f32::consts::TAU).sin() * 0.5 + 0.5
}

/// 按权重在两个颜色间线性插值
fn lerp_color(from: COLORREF, to: COLORREF, weight: f32) -> COLORREF {
    let mix = |shift: u32| -> u32 {
        let a = ((from.0 >> shift) & 0xFF) as f32;
        let b = ((to.0 >> shift) & 0xFF) as f32;
        (a + (b - a) * weight).round().clamp(0.0, 255.0) as u32
    };
    COLORREF(mix(0) | (mix(8) << 8) | (mix(16) << 16))
}

// ─── 呼吸框窗口 ─────────────────────────────────────────────────

/// 屏幕边缘的呼吸边框。
///
/// 用 `SetWindowRgn` 挖空成空心框，而不是画一层全屏透明窗：镂空区域**根本不属于窗口**，
/// 鼠标天然穿透，不需要透明通道，也不会挡住用户在全屏录制期间的操作。
fn create_frame(region: RECT, scale: f32) -> Option<HWND> {
    let width = region.right - region.left;
    let height = region.bottom - region.top;
    if width <= 0 || height <= 0 {
        return None;
    }
    // 边框夹住，避免窄屏上内矩形反向导致挖空失败
    let border = ((FRAME_BORDER as f32) * scale).round().max(1.0) as i32;
    // 内矩形必须还留得下内容：否则「挖空」会退化成整块实心绿糊住整个桌面
    // （`SetWindowRgn` 对这种退化区域是**成功**的，靠返回码拦不住）。
    // 正常场景录制区域是整个虚拟桌面，这条走不到，纯粹是防止参数异常时糊屏。
    if width <= border * 2 || height <= border * 2 {
        crate::utils::logger::log("recording", "录制区域过小，放不下呼吸框");
        return None;
    }

    unsafe {
        let hinst = windows::Win32::System::LibraryLoader::GetModuleHandleW(None).ok()?;
        // WS_EX_TRANSPARENT：整窗鼠标穿透。镂空区域本就不属于窗口，但边框那几像素
        // 若吃掉点击，会挡住贴边窗口的缩放、屏幕边缘手势等操作。
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TRANSPARENT,
            FRAME_CLASS,
            FRAME_TITLE,
            WS_POPUP,
            region.left,
            region.top,
            width,
            height,
            None,
            None,
            Some(hinst.into()),
            None,
        )
        .ok()?;

        let outer = CreateRectRgn(0, 0, width, height);
        let inner = CreateRectRgn(border, border, width - border, height - border);
        let hollow = CreateRectRgn(0, 0, 0, 0);
        CombineRgn(Some(hollow), Some(outer), Some(inner), RGN_DIFF);
        // 成功后区域归系统所有，只需删掉自己建的两个中间区域
        let applied = SetWindowRgn(hwnd, Some(hollow), false);
        let _ = DeleteObject(outer.into());
        let _ = DeleteObject(inner.into());

        // 挖空失败时窗口会变成一整块实心绿，糊住整个桌面 —— 宁可不要呼吸框
        if applied == 0 {
            // 只在成功时区域才归系统所有，失败时仍归调用方，得自己删
            let _ = DeleteObject(hollow.into());
            crate::utils::logger::log("recording", "呼吸框挖空失败，放弃创建");
            let _ = DestroyWindow(hwnd);
            return None;
        }

        // 分层窗口必须设 alpha，否则整窗不可见
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
        // 呼吸只改整窗 alpha、不重绘：内容恒定，重绘纯属浪费
        SetTimer(Some(hwnd), TIMER_ANIM, ANIM_INTERVAL_MS, None);
        Some(hwnd)
    }
}

unsafe extern "system" fn frame_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);
            let mut rc = RECT::default();
            let _ = GetClientRect(hwnd, &mut rc);
            let brush = CreateSolidBrush(FRAME_COLOR);
            FillRect(hdc, &rc, brush);
            let _ = DeleteObject(brush.into());
            let _ = EndPaint(hwnd, &ps);
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1), // 不擦背景，避免闪烁
        WM_TIMER if wparam.0 == TIMER_ANIM => {
            // 140..255 之间呼吸：足够显眼，又不会盖住下面的内容
            let alpha = (140.0 + breathe_weight() * 115.0).round() as u8;
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), alpha, LWA_ALPHA);
            LRESULT(0)
        }
        WM_NCDESTROY => {
            let _ = KillTimer(Some(hwnd), TIMER_ANIM);
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

// ─── 控制栏窗口 ─────────────────────────────────────────────────

/// 控制栏上一枚按钮
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum BarButton {
    Pause,
    Stop,
    Cancel,
}

impl BarButton {
    fn index(self) -> u8 {
        match self {
            BarButton::Pause => 1,
            BarButton::Stop => 2,
            BarButton::Cancel => 3,
        }
    }

    fn from_index(index: u8) -> Option<BarButton> {
        match index {
            1 => Some(BarButton::Pause),
            2 => Some(BarButton::Stop),
            3 => Some(BarButton::Cancel),
            _ => None,
        }
    }
}

/// 控制栏布局（全部按缩放换算好），绘制与命中测试共用同一份，避免两边算错。
struct BarLayout {
    width: i32,
    height: i32,
    dot_cx: i32,
    dot_cy: i32,
    dot_r: i32,
    timer_rect: RECT,
    frames_rect: RECT,
    buttons: [(i32, i32, i32, i32); 3],
}

impl BarLayout {
    fn new(scale: f32) -> BarLayout {
        let px = |value: f32| (value * scale).round() as i32;
        let width = px(BAR_WIDTH as f32);
        let height = px(BAR_HEIGHT as f32);
        let button_w = px(44.0);
        let button_h = px(24.0);
        let gap = px(6.0);
        let padding = px(12.0);
        let total = button_w * 3 + gap * 2;
        let start_x = (width - total) / 2;
        let top = height - padding - button_h;
        let mut buttons = [(0, 0, 0, 0); 3];
        for (index, rect) in buttons.iter_mut().enumerate() {
            let left = start_x + index as i32 * (button_w + gap);
            *rect = (left, top, left + button_w, top + button_h);
        }
        BarLayout {
            width,
            height,
            dot_cx: px(20.0),
            dot_cy: px(22.0),
            dot_r: px(5.0).max(3),
            timer_rect: RECT {
                left: px(34.0),
                top: px(10.0),
                right: px(104.0),
                bottom: px(34.0),
            },
            frames_rect: RECT {
                left: px(104.0),
                top: px(10.0),
                right: width - px(12.0),
                bottom: px(34.0),
            },
            buttons,
        }
    }

    fn hit_test(&self, x: i32, y: i32) -> Option<BarButton> {
        for (index, (left, top, right, bottom)) in self.buttons.iter().enumerate() {
            if x >= *left && x < *right && y >= *top && y < *bottom {
                return BarButton::from_index(index as u8 + 1);
            }
        }
        None
    }
}

/// 控制栏窗口状态（挂在 `GWLP_USERDATA` 上，`WM_NCDESTROY` 时释放）
struct BarState {
    app: AppHandle,
    palette: Palette,
    scale: f32,
    layout: BarLayout,
    timer_font: HFONT,
    small_font: HFONT,
    /// 双缓冲用的内存 DC 与位图。窗口尺寸固定，建一次复用，
    /// 避免 30fps 重绘时每帧都分配一张与窗口等大的位图。
    mem_dc: HDC,
    mem_bmp: HBITMAP,
    /// 建 `mem_dc` 时被顶替掉的原始位图，销毁前要选回去（GDI 规则）
    mem_old_bmp: HGDIOBJ,
    /// 悬停 / 按下的按钮（0 = 无）
    hover: u8,
    pressed: u8,
}

fn create_bar(app: &AppHandle, region: RECT, scale: f32, palette: Palette) -> Option<HWND> {
    let layout = BarLayout::new(scale);
    let (bar_width, bar_height) = (layout.width, layout.height);
    let (x, y) = bar_position(region, bar_width, bar_height, scale);

    let state = Box::new(BarState {
        app: app.clone(),
        palette,
        scale,
        layout,
        timer_font: Default::default(),
        small_font: Default::default(),
        mem_dc: Default::default(),
        mem_bmp: Default::default(),
        mem_old_bmp: Default::default(),
        hover: 0,
        pressed: 0,
    });

    unsafe {
        let hinst = windows::Win32::System::LibraryLoader::GetModuleHandleW(None).ok()?;
        let state_ptr = Box::into_raw(state);
        let hwnd = match CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED,
            BAR_CLASS,
            BAR_TITLE,
            WS_POPUP,
            x,
            y,
            bar_width,
            bar_height,
            None,
            None,
            Some(hinst.into()),
            Some(state_ptr as *const _),
        ) {
            Ok(hwnd) => hwnd,
            Err(_) => {
                // 建窗失败不会有 WM_NCDESTROY，窗口过程没机会替我们释放这块内存
                drop(Box::from_raw(state_ptr));
                return None;
            }
        };

        // 整窗 235/255：既不像纯色块那么硬，也不会看不清字
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 235, LWA_ALPHA);
        SetTimer(Some(hwnd), TIMER_ANIM, ANIM_INTERVAL_MS, None);
        Some(hwnd)
    }
}

/// 控制栏位置：光标所在显示器**工作区**的右下角（工作区已排除任务栏），
/// 拿不到工作区时退回录制区域右下角。
///
/// 不复用 `commands::monitor_work_area_for_cursor`：那个返回截图专用的私有结构体，
/// 这里按物理像素取工作区即可，没必要把两条路径耦合成一条。
fn bar_position(region: RECT, width: i32, height: i32, scale: f32) -> (i32, i32) {
    let gap = ((BAR_GAP as f32) * scale).round() as i32;
    unsafe {
        let mut cursor = POINT::default();
        if GetCursorPos(&mut cursor).is_ok() {
            let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
            if !monitor.is_invalid() {
                let mut info = MONITORINFO {
                    cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };
                if GetMonitorInfoW(monitor, &mut info).as_bool() {
                    let work = info.rcWork;
                    let x = work.right - width - gap;
                    let y = work.bottom - height - gap;
                    if x >= work.left && y >= work.top {
                        return (x, y);
                    }
                }
            }
        }
    }
    (region.right - width - gap, region.bottom - height - gap)
}

unsafe extern "system" fn bar_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_NCCREATE => {
            let cs = lparam.0 as *const CREATESTRUCTW;
            if !cs.is_null() {
                let state_ptr = (*cs).lpCreateParams as *mut BarState;
                if !state_ptr.is_null() {
                    SetWindowLongPtrW(hwnd, GWL_USERDATA, state_ptr as isize);
                }
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_PAINT => {
            if let Some(state) = bar_state(hwnd) {
                paint_bar(hwnd, &mut *state);
            }
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1), // 不擦背景，避免闪烁
        WM_TIMER if wparam.0 == TIMER_ANIM => {
            if let Some(state) = bar_state(hwnd) {
                // 没有 TrackMouseEvent（windows-rs 0.61 未导出），改为每帧自查光标位置：
                // 鼠标移出窗口后悬停高亮也能正常消失。
                clear_hover_when_outside(hwnd, &mut *state);
            }
            // 计时/帧数/呼吸点都靠重绘刷新（窗口很小，30fps 的 GDI 重绘开销可忽略）
            let _ = InvalidateRect(Some(hwnd), None, false);
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            if let Some(state) = bar_state(hwnd) {
                let state = &mut *state;
                let (x, y) = cursor_in_client(hwnd, lparam);
                let hover = state
                    .layout
                    .hit_test(x, y)
                    .map(BarButton::index)
                    .unwrap_or(0);
                if hover != state.hover {
                    state.hover = hover;
                    let _ = InvalidateRect(Some(hwnd), None, false);
                }
            }
            LRESULT(0)
        }
        WM_LBUTTONDOWN => {
            if let Some(state) = bar_state(hwnd) {
                let state = &mut *state;
                let (x, y) = cursor_in_client(hwnd, lparam);
                state.pressed = state
                    .layout
                    .hit_test(x, y)
                    .map(BarButton::index)
                    .unwrap_or(0);
                let _ = InvalidateRect(Some(hwnd), None, false);
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            if let Some(state) = bar_state(hwnd) {
                let state = &mut *state;
                let (x, y) = cursor_in_client(hwnd, lparam);
                let released = state
                    .layout
                    .hit_test(x, y)
                    .map(BarButton::index)
                    .unwrap_or(0);
                // 按下与松开必须落在同一枚按钮上才算点击（按住后移开再松手视为取消）
                let clicked = if released != 0 && released == state.pressed {
                    BarButton::from_index(released)
                } else {
                    None
                };
                state.pressed = 0;
                let _ = InvalidateRect(Some(hwnd), None, false);
                if let Some(button) = clicked {
                    // 按钮动作必须丢到工作线程，**不能在窗口过程里同步执行**：
                    // stop/cancel 命令会去抢 RECORDING_CONTROLS_LIFECYCLE_LOCK，而持有该锁的
                    // 钩子线程随后会调 `overlay.hwnd()` —— 那是阻塞式主线程往返（tauri 的
                    // `getter!` 宏 `send_user_message` + `rx.recv()`）。若主线程此刻正卡在窗口
                    // 过程里等这把锁，两边互等就是永久死锁（界面全僵、录制也拆不掉）。
                    // 丢到工作线程后窗口过程立刻返回，主线程随时能回应 getter。
                    let app = state.app.clone();
                    std::thread::spawn(move || activate_button(&app, button));
                }
            }
            LRESULT(0)
        }
        WM_NCDESTROY => {
            let _ = KillTimer(Some(hwnd), TIMER_ANIM);
            let state_ptr = GetWindowLongPtrW(hwnd, GWL_USERDATA) as *mut BarState;
            if !state_ptr.is_null() {
                SetWindowLongPtrW(hwnd, GWL_USERDATA, 0);
                let state = Box::from_raw(state_ptr);
                for font in [state.timer_font, state.small_font] {
                    if !font.is_invalid() {
                        let _ = DeleteObject(font.into());
                    }
                }
                // 位图仍被选在 DC 里：先选回原始位图，再依次删位图与 DC
                if !state.mem_dc.is_invalid() {
                    if !state.mem_old_bmp.is_invalid() {
                        SelectObject(state.mem_dc, state.mem_old_bmp);
                    }
                    let _ = DeleteDC(state.mem_dc);
                }
                if !state.mem_bmp.is_invalid() {
                    let _ = DeleteObject(state.mem_bmp.into());
                }
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn bar_state(hwnd: HWND) -> Option<*mut BarState> {
    let ptr = unsafe { GetWindowLongPtrW(hwnd, GWL_USERDATA) } as *mut BarState;
    if ptr.is_null() {
        None
    } else {
        Some(ptr)
    }
}

/// 鼠标消息的 lparam 是客户区坐标；取值时要按 i16 还原（窗口可能位于负坐标屏）
fn cursor_in_client(hwnd: HWND, lparam: LPARAM) -> (i32, i32) {
    let x = (lparam.0 & 0xFFFF) as u16 as i16 as i32;
    let y = ((lparam.0 >> 16) & 0xFFFF) as u16 as i16 as i32;
    // 拖动/快速移动时消息坐标可能落后，用当前光标位置兜底更稳
    unsafe {
        let mut cursor = POINT::default();
        if GetCursorPos(&mut cursor).is_ok() {
            let mut rc = RECT::default();
            if GetWindowRect(hwnd, &mut rc).is_ok()
                && cursor.x >= rc.left
                && cursor.x < rc.right
                && cursor.y >= rc.top
                && cursor.y < rc.bottom
            {
                return (cursor.x - rc.left, cursor.y - rc.top);
            }
        }
    }
    (x, y)
}

/// 光标已不在窗口内时清掉悬停/按下态（替代缺失的 WM_MOUSELEAVE）
fn clear_hover_when_outside(hwnd: HWND, state: &mut BarState) {
    if state.hover == 0 && state.pressed == 0 {
        return;
    }
    unsafe {
        let mut cursor = POINT::default();
        let mut rc = RECT::default();
        if GetCursorPos(&mut cursor).is_ok() && GetWindowRect(hwnd, &mut rc).is_ok() {
            let inside = cursor.x >= rc.left
                && cursor.x < rc.right
                && cursor.y >= rc.top
                && cursor.y < rc.bottom;
            if !inside {
                state.hover = 0;
                state.pressed = 0;
            }
        }
    }
}

/// 按 WebView2 控制栏的同款命令执行按钮动作，保证两条路径行为一致
/// （暂停/恢复要发事件同步前端，停止/取消要连带清理 overlay 与指示层）。
fn activate_button(app: &AppHandle, button: BarButton) {
    let result = match button {
        BarButton::Pause => {
            let paused = app
                .try_state::<RecordingState>()
                .map(|state| state.is_paused())
                .unwrap_or(false);
            if paused {
                crate::commands::resume_recording(app.clone())
            } else {
                crate::commands::pause_recording(app.clone())
            }
        }
        BarButton::Stop => crate::commands::stop_recording(app.clone()),
        BarButton::Cancel => crate::commands::cancel_recording_and_select(app.clone()),
    };
    if let Err(error) = result {
        crate::utils::logger::log("recording", &format!("指示栏按钮执行失败: {}", error));
    }
}

unsafe fn paint_bar(hwnd: HWND, state: &mut BarState) {
    let mut ps = PAINTSTRUCT::default();
    let hdc = BeginPaint(hwnd, &mut ps);
    let mut rc = RECT::default();
    let _ = GetClientRect(hwnd, &mut rc);
    let (width, height) = (rc.right - rc.left, rc.bottom - rc.top);
    if width <= 0 || height <= 0 {
        let _ = EndPaint(hwnd, &ps);
        return;
    }

    // 懒建字体：首次绘制时窗口已落在目标显示器上，取到的缩放才是准的
    if state.timer_font.is_invalid() {
        state.timer_font = create_font((22.0 * state.scale).round() as i32, FW_BOLD.0 as i32);
        state.small_font = create_font((12.0 * state.scale).round() as i32, FW_NORMAL.0 as i32);
    }

    // 双缓冲：呼吸动画每 33ms 重绘一次，直接画会闪。
    // DC 与位图建一次复用（窗口尺寸固定），避免每帧分配一张与窗口等大的位图。
    if state.mem_dc.is_invalid() {
        let mem_dc = CreateCompatibleDC(Some(hdc));
        if mem_dc.is_invalid() {
            let _ = EndPaint(hwnd, &ps);
            return;
        }
        let mem_bmp = CreateCompatibleBitmap(hdc, width, height);
        if mem_bmp.is_invalid() {
            let _ = DeleteDC(mem_dc);
            let _ = EndPaint(hwnd, &ps);
            return;
        }
        state.mem_old_bmp = SelectObject(mem_dc, mem_bmp.into());
        state.mem_dc = mem_dc;
        state.mem_bmp = mem_bmp;
    }
    let mem_dc = state.mem_dc;

    let palette = state.palette;
    let layout = &state.layout;
    let null_pen = GetStockObject(NULL_PEN);

    // 面板：圆角矩形，一次调用同时填充与描边
    let panel_brush = CreateSolidBrush(palette.panel);
    let border_pen = CreatePen(PS_SOLID, 1, palette.border);
    let old_pen = SelectObject(mem_dc, border_pen.into());
    let old_brush = SelectObject(mem_dc, panel_brush.into());
    let radius = (24.0 * state.scale) as i32;
    let _ = RoundRect(mem_dc, 0, 0, width, height, radius, radius);
    let _ = SelectObject(mem_dc, old_pen);
    let _ = SelectObject(mem_dc, old_brush);
    let _ = DeleteObject(panel_brush.into());
    let _ = DeleteObject(border_pen.into());

    // 录制状态直接读后端原子量，不依赖前端回传。
    // 用 try_state 而不是 state：定时器可能在应用退出、状态已被回收后才轮到一次
    // 消息，state() 此时会 panic，而这里只是画个数字，取不到按 0 处理即可。
    let (running, paused, elapsed_ms, frames) = match state.app.try_state::<RecordingState>() {
        Some(recording) => (
            recording.is_running(),
            recording.is_paused(),
            recording.elapsed_ms(),
            recording.frame_count(),
        ),
        None => (false, false, 0, 0),
    };

    // 呼吸点：录制中红色呼吸；暂停时常亮琥珀色；已结束（编码中）常亮灰色
    let dot_color = if paused {
        palette.paused
    } else if running {
        lerp_color(palette.rec_dim, palette.rec, breathe_weight())
    } else {
        palette.muted
    };
    let dot_brush = CreateSolidBrush(dot_color);
    let old_pen = SelectObject(mem_dc, null_pen);
    let old_brush = SelectObject(mem_dc, dot_brush.into());
    let _ = Ellipse(
        mem_dc,
        layout.dot_cx - layout.dot_r,
        layout.dot_cy - layout.dot_r,
        layout.dot_cx + layout.dot_r,
        layout.dot_cy + layout.dot_r,
    );
    let _ = SelectObject(mem_dc, old_pen);
    let _ = SelectObject(mem_dc, old_brush);
    let _ = DeleteObject(dot_brush.into());

    let _ = SetBkMode(mem_dc, TRANSPARENT);

    // 计时
    let old_font = SelectObject(mem_dc, state.timer_font.into());
    let _ = SetTextColor(mem_dc, palette.text);
    let mut timer_rect = layout.timer_rect;
    let mut timer_text = to_wide(&format_duration(elapsed_ms));
    let _ = DrawTextW(
        mem_dc,
        &mut timer_text,
        &mut timer_rect,
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );

    // 帧数（右对齐，小号字）
    let _ = SelectObject(mem_dc, state.small_font.into());
    let _ = SetTextColor(mem_dc, palette.muted);
    let mut frames_rect = layout.frames_rect;
    let mut frames_text = to_wide(&format!("{} 帧", frames));
    let _ = DrawTextW(
        mem_dc,
        &mut frames_text,
        &mut frames_rect,
        DT_RIGHT | DT_SINGLELINE | DT_VCENTER,
    );
    let _ = SelectObject(mem_dc, old_font);

    // 三枚按钮
    for (index, (left, top, right, bottom)) in layout.buttons.iter().enumerate() {
        let Some(button) = BarButton::from_index(index as u8 + 1) else {
            continue;
        };
        let highlighted = state.hover == button.index() || state.pressed == button.index();
        let background = match button {
            BarButton::Stop => palette.button_stop,
            _ if highlighted => palette.button_hover,
            _ => palette.button,
        };
        let brush = CreateSolidBrush(background);
        let old_pen = SelectObject(mem_dc, null_pen);
        let old_brush = SelectObject(mem_dc, brush.into());
        let corner = (8.0 * state.scale) as i32;
        let _ = RoundRect(mem_dc, *left, *top, *right, *bottom, corner, corner);
        let _ = SelectObject(mem_dc, old_pen);
        let _ = SelectObject(mem_dc, old_brush);
        let _ = DeleteObject(brush.into());
        draw_glyph(
            mem_dc,
            button,
            paused,
            *left,
            *top,
            *right,
            *bottom,
            state.scale,
            palette,
        );
    }

    let _ = BitBlt(hdc, 0, 0, width, height, Some(mem_dc), 0, 0, SRCCOPY);

    let _ = EndPaint(hwnd, &ps);
}

/// 按钮内的图标：暂停/继续、停止、取消
///
/// 图标的每一处尺寸都要跟着 `scale` 走：面板与字体已按 DPI 缩放，
/// 图标若用固定像素，在 125%/150% 下会缩成按钮里的一小点。
unsafe fn draw_glyph(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    button: BarButton,
    paused: bool,
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    scale: f32,
    palette: Palette,
) {
    let s = |value: f32| (value * scale).round() as i32;
    let center_x = (left + right) / 2;
    let center_y = (top + bottom) / 2;
    let color = match button {
        BarButton::Cancel => palette.muted,
        _ => palette.text,
    };
    let brush = CreateSolidBrush(color);
    let pen = CreatePen(PS_SOLID, s(2.0).max(1), color);
    let null_pen = GetStockObject(NULL_PEN);
    let old_pen;
    let old_brush;

    match button {
        // 暂停 = 两根竖条；已在暂停 = 继续（右向三角）
        BarButton::Pause if !paused => {
            old_pen = SelectObject(hdc, null_pen);
            old_brush = SelectObject(hdc, brush.into());
            let bar_width = s(3.0).max(1);
            let half_height = s(9.0).max(1);
            for offset in [s(-6.0), s(3.0)] {
                FillRect(
                    hdc,
                    &RECT {
                        left: center_x + offset,
                        top: center_y - half_height,
                        right: center_x + offset + bar_width,
                        bottom: center_y + half_height,
                    },
                    brush,
                );
            }
            SelectObject(hdc, old_pen);
            SelectObject(hdc, old_brush);
        }
        BarButton::Pause => {
            old_pen = SelectObject(hdc, pen.into());
            old_brush = SelectObject(hdc, brush.into());
            let back = s(-4.0);
            let half_height = s(7.0).max(1);
            let tip = s(6.0).max(1);
            let points = [
                POINT {
                    x: center_x + back,
                    y: center_y - half_height,
                },
                POINT {
                    x: center_x + back,
                    y: center_y + half_height,
                },
                POINT {
                    x: center_x + tip,
                    y: center_y,
                },
            ];
            let _ = Polygon(hdc, &points);
            SelectObject(hdc, old_pen);
            SelectObject(hdc, old_brush);
        }
        BarButton::Stop => {
            old_pen = SelectObject(hdc, null_pen);
            old_brush = SelectObject(hdc, brush.into());
            let half = s(7.0).max(1);
            FillRect(
                hdc,
                &RECT {
                    left: center_x - half,
                    top: center_y - half,
                    right: center_x + half,
                    bottom: center_y + half,
                },
                brush,
            );
            SelectObject(hdc, old_pen);
            SelectObject(hdc, old_brush);
        }
        BarButton::Cancel => {
            old_pen = SelectObject(hdc, pen.into());
            let near = s(6.0).max(1);
            let far = s(7.0).max(1);
            let _ = MoveToEx(hdc, center_x - near, center_y - near, None);
            let _ = LineTo(hdc, center_x + far, center_y + far);
            let _ = MoveToEx(hdc, center_x + near, center_y - near, None);
            let _ = LineTo(hdc, center_x - far, center_y + far);
            SelectObject(hdc, old_pen);
        }
    }

    let _ = DeleteObject(brush.into());
    let _ = DeleteObject(pen.into());
}

fn create_font(height: i32, weight: i32) -> windows::Win32::Graphics::Gdi::HFONT {
    unsafe {
        CreateFontW(
            height,
            0,
            0,
            0,
            weight,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            windows::Win32::Graphics::Gdi::OUT_TT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            CLEARTYPE_QUALITY,
            (DEFAULT_PITCH.0 | FF_DONTCARE.0) as u32,
            w!("Segoe UI"),
        )
    }
}

/// `mm:ss`
fn format_duration(ms: u64) -> String {
    let seconds = ms / 1000;
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}

fn to_wide(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Graphics::Gdi::{GetWindowRgn, PtInRegion};

    /// 呼吸框最关键的两个不变式，写坏了后果都很重：
    /// 挖空失败 → 一整块实心绿糊住整个桌面；没排除出捕获 → 绿框被录进成片。
    ///
    /// 测试只建窗、不 `ShowWindow`，所以不会在屏幕上闪任何东西。
    #[test]
    fn frame_window_is_hollow_and_excluded_from_capture() {
        assert!(register_classes(), "窗口类注册失败");
        let region = RECT {
            left: 0,
            top: 0,
            right: 640,
            bottom: 480,
        };
        let hwnd = create_frame(region, 1.0).expect("呼吸框创建失败");

        unsafe {
            let hollow = CreateRectRgn(0, 0, 1, 1);
            let kind = GetWindowRgn(hwnd, hollow);
            // RGN_ERROR(0) 表示窗口没有区域，那样会渲染成实心块
            assert!(kind.0 != 0, "窗口没有设置区域，会渲染成实心块");

            // 四角/边缘属于边框
            assert!(PtInRegion(hollow, 0, 0).as_bool(), "左上角应在边框内");
            assert!(PtInRegion(hollow, 639, 479).as_bool(), "右下角应在边框内");
            // 边框以里、以及中心，都必须镂空（镂空处不响应鼠标，才不会挡住用户操作）
            let inside = FRAME_BORDER + 2;
            assert!(
                !PtInRegion(hollow, inside, inside).as_bool(),
                "边框内侧应镂空"
            );
            assert!(!PtInRegion(hollow, 320, 240).as_bool(), "画面中心应镂空");
            assert!(
                !PtInRegion(hollow, 640 - 1 - inside, 480 - 1 - inside).as_bool(),
                "右下内侧应镂空"
            );
            let _ = DeleteObject(hollow.into());

            if exclude_from_capture(hwnd) {
                let mut affinity = 0u32;
                assert!(GetWindowDisplayAffinity(hwnd, &mut affinity).is_ok());
                assert_eq!(
                    affinity, WDA_EXCLUDEFROMCAPTURE.0,
                    "呼吸框必须排除出捕获，否则会被 BitBlt 录进成片"
                );
            } else {
                // Win10 2004 以下不支持该标记，生产代码此时会整体放弃指示层
                // （见 create_now），这里也只是提示，不判失败。
                eprintln!("本系统不支持 WDA_EXCLUDEFROMCAPTURE，跳过捕获排除断言");
            }

            let _ = DestroyWindow(hwnd);
        }
    }

    #[test]
    fn duration_is_formatted_as_mm_ss() {
        assert_eq!(format_duration(0), "00:00");
        assert_eq!(format_duration(999), "00:00");
        assert_eq!(format_duration(1_000), "00:01");
        assert_eq!(format_duration(61_000), "01:01");
        assert_eq!(format_duration(3_599_000), "59:59");
        // 超过一小时不回绕成 00:xx：长录制的计时必须继续往上走
        assert_eq!(format_duration(3_600_000), "60:00");
    }

    #[test]
    fn breathing_weight_stays_within_unit_range() {
        // 采样一个完整周期，权重必须始终落在 0..1（越界会让颜色插值溢出）
        for step in 0..=64 {
            let weight = breathe_weight();
            assert!((0.0..=1.0).contains(&weight), "权重越界: {}", weight);
            let _ = step;
        }
    }

    #[test]
    fn color_lerp_hits_both_ends_and_midpoint() {
        let from = COLORREF(0x00_00_00_FF); // 纯红
        let to = COLORREF(0x00_00_FF_00); // 纯绿（BGR 顺序下是中间字节）
        assert_eq!(lerp_color(from, to, 0.0).0, from.0);
        assert_eq!(lerp_color(from, to, 1.0).0, to.0);
        assert_eq!(lerp_color(from, to, 0.5).0, 0x00_00_80_80);
    }

    #[test]
    fn buttons_are_hittable_at_their_centers_and_gaps_are_not() {
        for scale in [1.0_f32, 1.25, 1.5, 2.0, 3.0] {
            let layout = BarLayout::new(scale);
            for (index, (left, top, right, bottom)) in layout.buttons.iter().enumerate() {
                let center_x = (left + right) / 2;
                let center_y = (top + bottom) / 2;
                let hit = layout.hit_test(center_x, center_y);
                assert_eq!(
                    hit,
                    BarButton::from_index(index as u8 + 1),
                    "scale={} 第 {} 枚按钮中心未命中",
                    scale,
                    index
                );
            }

            // 计时区（左上）不该命中任何按钮
            assert_eq!(layout.hit_test(layout.dot_cx, layout.dot_cy), None);
            // 按钮之间的间隙不该命中
            let gap_x = layout.buttons[0].2 + 1;
            let gap_y = (layout.buttons[0].1 + layout.buttons[0].3) / 2;
            assert_eq!(layout.hit_test(gap_x, gap_y), None);
            // 窗口外（负坐标 / 超出右下角）不该命中
            assert_eq!(layout.hit_test(-1, -1), None);
            assert_eq!(layout.hit_test(layout.width + 1, layout.height + 1), None);
        }
    }

    #[test]
    fn buttons_stay_inside_the_panel_at_every_scale() {
        for scale in [1.0_f32, 1.25, 1.5, 2.0, 3.0] {
            let layout = BarLayout::new(scale);
            let (left, top, right, bottom) = layout.buttons[2];
            assert!(left >= 0 && top >= 0, "scale={} 按钮越出左上角", scale);
            assert!(
                right <= layout.width && bottom <= layout.height,
                "scale={} 按钮越出右下角",
                scale
            );
        }
    }
}
