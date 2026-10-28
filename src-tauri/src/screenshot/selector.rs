//! 截图选区阶段的原生渲染层：半透明遮罩 + 选框 + 边缘描边。
//!
//! ## 为什么要有这一层
//!
//! 遮罩和选框必须"黏"着手走。用 WebView 画时，位置要经过
//! 「pointermove → JS → React 提交 → 合成 → 呈现」这条队列，实测量到的是恰好 1 帧
//! （页内探针实测：派发 2.2ms、每帧内容只老 2.6ms、rAF 稳定 143Hz），这个 1 帧在
//! 60Hz 屏上就是 16.7ms，再加 DWM 呈现 1~2 帧，快速拖拽时选框会稳定落后光标 25~50px。
//! 这是 WebView 覆盖层的物理下限，靠优化 JS 消不掉。
//!
//! 因此选择阶段改成原生层绘制：坐标由已有的 WH_MOUSE_LL 钩子直接喂进来
//! （事件驱动，不轮询、不加定时器），GDI 只改 Region 不重画整屏；
//! 标注阶段仍然回到 WebView（撤销栈、文字编辑、OCR 面板那些都在那边）。
//!
//! ## 为什么是「两扇窗 + SetWindowRgn」而不是一扇逐像素 alpha 窗
//!
//! 遮罩要 35% 透明、描边要实色，逐像素 alpha 只能走 UpdateLayeredWindow，
//! 那是每帧上传整屏 DIB（1920×1080 一帧 8MB），拖框时反而成为新的瓶颈。
//! 改成两扇窗：遮罩窗 region 挖掉选区和描边、LWA_ALPHA 统一半透明；描边窗 region
//! 就是一个 2px 的空心环、alpha 255。两扇窗都只改 Region，
//! 像素只在被 Region 判定为新暴露的窄条上重绘 —— 与 recording/indicator.rs 同一条思路。
//!
//! ## 层级
//!
//! 原生层必须压在 screenshot-overlay 之下：WebView 那扇窗是透明的，
//! 原生层从透明处透出来即可；模式栏 / 提示文字 / 尺寸标签留在 WebView，画在原生层上方，
//! 不会被 35% 遮罩压暗。
//!
//! ## 坐标
//!
//! 全程物理像素（与 get_virtual_desktop_bounds 同一套坐标），
//! 窗口铺满虚拟桌面、左上角落在 (origin_x, origin_y)，因此不需要 WebView 那套
//! 「物理 / scale」换算，跨屏与混合 DPI 天然正确。

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicIsize, Ordering};

use tauri::{AppHandle, Manager};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CombineRgn, CreateRectRgn, CreateSolidBrush, DeleteObject, EndPaint, FillRect,
    SetWindowRgn, RGN_DIFF,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, LoadCursorW, PostMessageW,
    RegisterClassExW, SetLayeredWindowAttributes, SetWindowPos, ShowWindow,
    CS_HREDRAW, CS_VREDRAW, HWND_TOPMOST, IDC_ARROW, LWA_ALPHA, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, SW_HIDE, SW_SHOWNOACTIVATE, WM_CLOSE, WM_ERASEBKGND, WM_NCDESTROY, WM_PAINT,
    WM_APP, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_EX_TRANSPARENT, WS_POPUP,
};

const MASK_CLASS: PCWSTR = w!("LevitaireSelectorMask");
const FRAME_CLASS: PCWSTR = w!("LevitaireSelectorFrame");
const MASK_TITLE: PCWSTR = w!("Levitaire 截图遮罩");
const FRAME_TITLE: PCWSTR = w!("Levitaire 截图选框");

/// 遮罩整体不透明度（与 CSS 里 oklch(0 0 0 / 0.35) 对齐）：0.35 * 255 ≈ 89。
const MASK_ALPHA: u8 = 89;

const MSG_REFRESH: u32 = WM_APP + 1;

#[derive(Clone, Copy)]
pub struct RectI {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl RectI {
    const EMPTY: RectI = RectI { left: 0, top: 0, right: 0, bottom: 0 };
    fn from_end(l: i32, t: i32, r: i32, b: i32) -> Self {
        RectI { left: l, top: t, right: r, bottom: b }
    }
}

// ─── 全局状态 ──────────────────────────────────────────────────
//
// 全部原子量：窗口过程跑在主线程、喂坐标的是钩子线程，两边只能靠它们通信。

static MASK_HWND: AtomicIsize = AtomicIsize::new(0);
static FRAME_HWND: AtomicIsize = AtomicIsize::new(0);
/// 拖拽是否进行中：只有为 true 时钩子才转发坐标，窗口才显示。
static TRACKING: AtomicBool = AtomicBool::new(false);
/// 拖拽结束后"冻结保持"：松手到 WebView 接管（截屏编码 + 进标注态）之间有几十毫秒，
/// 这期间原生层必须继续显示最后一帧，否则会闪一下没有遮罩的裸桌面。
static FROZEN: AtomicBool = AtomicBool::new(false);
static VISIBLE: AtomicBool = AtomicBool::new(false);
/// 坐标喂入合并：一帧内多次移动只投递一条刷新消息。
static REFRESH_PENDING: AtomicBool = AtomicBool::new(false);
/// 虚拟桌面原点与尺寸（物理像素）。
static ORIGIN_X: AtomicI32 = AtomicI32::new(0);
static ORIGIN_Y: AtomicI32 = AtomicI32::new(0);
static AREA_W: AtomicI32 = AtomicI32::new(0);
static AREA_H: AtomicI32 = AtomicI32::new(0);
/// 锚点 / 当前光标（窗口局部坐标）。
static ANCHOR_X: AtomicI32 = AtomicI32::new(0);
static ANCHOR_Y: AtomicI32 = AtomicI32::new(0);
static CURSOR_X: AtomicI32 = AtomicI32::new(0);
static CURSOR_Y: AtomicI32 = AtomicI32::new(0);
/// 最近一次真正画出来的选区（局部坐标），end 用它作为权威结果。
static LAST: std::sync::Mutex<RectI> = std::sync::Mutex::new(RectI::EMPTY);
/// 描边强调色（COLORREF，0x00BBGGRR）。
static ACCENT: AtomicI32 = AtomicI32::new(0x00_8B_5B_F6);

fn hwnd_of(raw: isize) -> Option<HWND> {
    if raw == 0 {
        None
    } else {
        Some(HWND(raw as *mut _))
    }
}

// ─── 对外接口 ──────────────────────────────────────────────────

/// 进入区域框选模式时调用一次：按虚拟桌面铺两扇原生窗（初始为隐藏 + 空 region）。
pub fn prepare(app: &AppHandle, accent: i32) -> Result<(), String> {
    // 上一轮若异常收尾（前端崩溃、钩子错过了抬起），这里先把跟踪/冻结状态清掉：
    // 否则新窗一建好就会被当成"正在拖拽"直接画出来，或卡在上一轮的冻结帧上。
    TRACKING.store(false, Ordering::SeqCst);
    FROZEN.store(false, Ordering::SeqCst);
    let bounds = crate::screenshot::virtual_desktop_bounds()?;
    ORIGIN_X.store(bounds.origin_x, Ordering::SeqCst);
    ORIGIN_Y.store(bounds.origin_y, Ordering::SeqCst);
    AREA_W.store(bounds.width, Ordering::SeqCst);
    AREA_H.store(bounds.height, Ordering::SeqCst);
    ACCENT.store(accent, Ordering::SeqCst);

    // 层级基准：原生层要压在截图遮罩窗下方（遮罩窗是透明的，透出来即可）。
    let overlay = app
        .get_webview_window("screenshot-overlay")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
        .unwrap_or(0);

    app.run_on_main_thread(move || {
        // 幂等：重复 prepare（比如反复进来回切模式）时先清掉上一轮的两个窗
        destroy_now();
        create_now(overlay);
    })
    .map_err(|error| format!("创建原生选区层失败: {error}"))?;

    // 主线程建窗是**异步投递**的，必须等它真的落地再回报成功：
    // 否则前端会先把自己的遮罩隐藏掉，而原生层其实没建起来 —— 拖框时整块屏幕上
    // 既没有原生遮罩也没有 WebView 遮罩。建窗本身是毫秒级，这里的等待只在
    // 主线程被卡住时才会走到。
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
    while std::time::Instant::now() < deadline {
        if FRAME_HWND.load(Ordering::SeqCst) != 0 {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    crate::utils::logger::log("screenshot", "原生选区层创建超时，退回 WebView 绘制");
    Err("原生选区层创建超时".into())
}

/// 开始一次拖拽。x / y 是虚拟桌面的物理坐标（按下点）。
pub fn begin(x: i32, y: i32) -> Result<(), String> {
    if FRAME_HWND.load(Ordering::SeqCst) == 0 {
        // 让前端知道这次没接住，好退回 WebView 绘制（否则这一拖没有任何遮罩）
        return Err("原生选区层未就绪".into());
    }
    let lx = x - ORIGIN_X.load(Ordering::SeqCst);
    let ly = y - ORIGIN_Y.load(Ordering::SeqCst);
    ANCHOR_X.store(lx, Ordering::SeqCst);
    ANCHOR_Y.store(ly, Ordering::SeqCst);
    CURSOR_X.store(lx, Ordering::SeqCst);
    CURSOR_Y.store(ly, Ordering::SeqCst);
    FROZEN.store(false, Ordering::SeqCst);
    TRACKING.store(true, Ordering::SeqCst);
    request_refresh();
    Ok(())
}

/// 结束拖拽，返回最近一次真正画出来的选区（物理像素）。
///
/// 返回原生侧的结果而不是前端 pointerup 的坐标：用户看到的是这一帧的框，
/// 截出来的区域必须与它一致，否则会出现「框到这里、截出来差几像素」。
///
/// **不隐藏窗口**：隐藏交给 dispose（进标注态 / 取消 / 会话结束）。
/// 见 FROZEN 的注释——松手到 WebView 接管之间必须继续显示最后一帧。
pub fn end() -> Option<RectI> {
    TRACKING.store(false, Ordering::SeqCst);
    let last = *LAST.lock().unwrap_or_else(|e| e.into_inner());
    if last.right - last.left <= 0 || last.bottom - last.top <= 0 {
        return None;
    }
    let ox = ORIGIN_X.load(Ordering::SeqCst);
    let oy = ORIGIN_Y.load(Ordering::SeqCst);
    Some(RectI::from_end(last.left + ox, last.top + oy, last.right + ox, last.bottom + oy))
}

/// 钩子收到抬起时调用：用抬起点补最后一帧，然后收口。
///
/// 抬起的坐标本身就是"用户最后停在的位置"，比最后一帧已画出的框更接近真实意图
/// （两者最多差一次移动）。这里先把它写进 LAST，前端的 selector_end 随后读到的
/// 就是抬起点对应的选区，截图区域与用户预期一致。
pub fn finish_at(x: i32, y: i32) -> Option<RectI> {
    if !TRACKING.load(Ordering::SeqCst) {
        return None;
    }
    CURSOR_X.store(x - ORIGIN_X.load(Ordering::SeqCst), Ordering::SeqCst);
    CURSOR_Y.store(y - ORIGIN_Y.load(Ordering::SeqCst), Ordering::SeqCst);
    // 就地按抬起点算一次并写进 LAST：request_refresh 只是投递给窗口线程，
    // 若等它回填，紧接着的 end() 读到的还是上一帧的位置，等于白补。
    let hole = current_hole();
    *LAST.lock().unwrap_or_else(|e| e.into_inner()) = hole;
    // 关键：先停跟踪再冻结。否则钩子会继续喂坐标，框会跟着光标走，
    // "冻结"名存实亡（只在 dispose 之前的那一小段时间里不易察觉）。
    TRACKING.store(false, Ordering::SeqCst);
    // 冻结在抬起点这一帧：窗口先别收，等 WebView 真正接管（dispose）再拆
    FROZEN.store(true, Ordering::SeqCst);
    request_refresh();
    let ox = ORIGIN_X.load(Ordering::SeqCst);
    let oy = ORIGIN_Y.load(Ordering::SeqCst);
    Some(RectI::from_end(hole.left + ox, hole.top + oy, hole.right + ox, hole.bottom + oy))
}

/// 退出框选（切模式 / 取消 / 会话结束）：销毁两扇窗。
pub fn dispose() {
    TRACKING.store(false, Ordering::SeqCst);
    FROZEN.store(false, Ordering::SeqCst);
    VISIBLE.store(false, Ordering::SeqCst);
    *LAST.lock().unwrap_or_else(|e| e.into_inner()) = RectI::EMPTY;
    for slot in [&MASK_HWND, &FRAME_HWND] {
        if let Some(hwnd) = hwnd_of(slot.swap(0, Ordering::SeqCst)) {
            unsafe {
                let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    }
}

/// 钩子线程调用：把光标位置转成窗口局部坐标并请求一次重绘。
///
/// 只做两次原子写 + 一次合并投递，绝不在这里画图（WH_MOUSE_LL 回调超过超时
/// 会被系统静默摘掉钩子）。
pub fn feed_cursor(x: i32, y: i32) {
    if !TRACKING.load(Ordering::SeqCst) {
        return;
    }
    CURSOR_X.store(x - ORIGIN_X.load(Ordering::SeqCst), Ordering::SeqCst);
    CURSOR_Y.store(y - ORIGIN_Y.load(Ordering::SeqCst), Ordering::SeqCst);
    request_refresh();
}

/// 钩子是否应该转发坐标（区域框选进行中）。
pub fn is_tracking() -> bool {
    TRACKING.load(Ordering::SeqCst)
}

// ─── 内部 ──────────────────────────────────────────────────────

fn request_refresh() {
    if REFRESH_PENDING.swap(true, Ordering::SeqCst) {
        return; // 已有一次在途，合并掉
    }
    if let Some(hwnd) = hwnd_of(FRAME_HWND.load(Ordering::SeqCst)) {
        // 投递失败（窗口已销毁但原子量还没来得及清）时必须把合并标记复位，
        // 否则之后每次 feed_cursor 都会被这个"已有一次在途"直接吞掉，永远不再刷新。
        let posted = unsafe { PostMessageW(Some(hwnd), MSG_REFRESH, WPARAM(0), LPARAM(0)) };
        if posted.is_err() {
            REFRESH_PENDING.store(false, Ordering::SeqCst);
        }
    } else {
        REFRESH_PENDING.store(false, Ordering::SeqCst);
    }
}

fn create_now(overlay_hwnd: isize) {
    if FRAME_HWND.load(Ordering::SeqCst) != 0 {
        return;
    }
    let width = AREA_W.load(Ordering::SeqCst);
    let height = AREA_H.load(Ordering::SeqCst);
    if width <= 0 || height <= 0 {
        return;
    }
    if !register_classes() {
        crate::utils::logger::log("screenshot", "原生选区层窗口类注册失败，退回 WebView 绘制");
        return;
    }
    unsafe {
        let Ok(hinst) = GetModuleHandleW(None) else { return };
        let x = ORIGIN_X.load(Ordering::SeqCst);
        let y = ORIGIN_Y.load(Ordering::SeqCst);

        let create = |class: PCWSTR, title: PCWSTR| -> Option<HWND> {
            CreateWindowExW(
                WS_EX_TOPMOST
                    | WS_EX_TOOLWINDOW
                    | WS_EX_NOACTIVATE
                    | WS_EX_LAYERED
                    | WS_EX_TRANSPARENT,
                class,
                title,
                WS_POPUP,
                x,
                y,
                width,
                height,
                None,
                None,
                Some(hinst.into()),
                None,
            )
            .ok()
        };

        let Some(mask) = create(MASK_CLASS, MASK_TITLE) else { return };
        let Some(frame) = create(FRAME_CLASS, FRAME_TITLE) else {
            let _ = DestroyWindow(mask);
            return;
        };

        // 建窗后立刻给一个空 region，避免任何瞬间露出一整块未裁剪的黑窗
        let empty = CreateRectRgn(0, 0, 0, 0);
        if SetWindowRgn(mask, Some(empty), false) == 0 {
            let _ = DeleteObject(empty.into());
        }
        let empty2 = CreateRectRgn(0, 0, 0, 0);
        if SetWindowRgn(frame, Some(empty2), false) == 0 {
            let _ = DeleteObject(empty2.into());
        }
        let _ = SetLayeredWindowAttributes(mask, COLORREF(0), MASK_ALPHA, LWA_ALPHA);
        let _ = SetLayeredWindowAttributes(frame, COLORREF(0), 255, LWA_ALPHA);

        MASK_HWND.store(mask.0 as isize, Ordering::SeqCst);
        FRAME_HWND.store(frame.0 as isize, Ordering::SeqCst);
        // 新窗默认是隐藏的：显隐标记必须跟着复位，否则 show_windows(true) 会因为
        // "已经可见"直接跳过 ShowWindow，原生层永远不出现。
        VISIBLE.store(false, Ordering::SeqCst);

        // 压到 overlay 之下；overlay 缺失时退回置顶带最上层（会盖住模式栏，但能用）
        for hwnd in [mask, frame] {
            let after = if overlay_hwnd != 0 {
                HWND(overlay_hwnd as *mut _)
            } else {
                HWND_TOPMOST
            };
            let _ = SetWindowPos(
                hwnd,
                Some(after),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }
}

fn destroy_now() {
    for slot in [&MASK_HWND, &FRAME_HWND] {
        if let Some(hwnd) = hwnd_of(slot.swap(0, Ordering::SeqCst)) {
            unsafe {
                let _ = DestroyWindow(hwnd);
            }
        }
    }
}

fn register_classes() -> bool {
    unsafe {
        let Ok(hinst) = GetModuleHandleW(None) else { return false };
        let cursor = LoadCursorW(None, IDC_ARROW).unwrap_or_default();
        let classes: [(PCWSTR, unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT); 2] = [
            (MASK_CLASS, mask_wndproc),
            (FRAME_CLASS, frame_wndproc),
        ];
        for (class, proc_) in classes {
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(proc_),
                hInstance: hinst.into(),
                lpszClassName: class,
                hCursor: cursor,
                ..Default::default()
            };
            // 类可能已注册（同一次会话里反复进入区域模式），重复注册的错误可以忽略
            let _ = RegisterClassExW(&wc);
        }
        true
    }
}

/// 依据锚点与当前光标算出选区（窗口局部坐标，已夹在桌面范围内）。
fn current_hole() -> RectI {
    let ax = ANCHOR_X.load(Ordering::SeqCst);
    let ay = ANCHOR_Y.load(Ordering::SeqCst);
    let cx = CURSOR_X.load(Ordering::SeqCst);
    let cy = CURSOR_Y.load(Ordering::SeqCst);
    let w = AREA_W.load(Ordering::SeqCst);
    let h = AREA_H.load(Ordering::SeqCst);
    RectI {
        left: ax.min(cx).clamp(0, w),
        top: ay.min(cy).clamp(0, h),
        right: ax.max(cx).clamp(0, w),
        bottom: ay.max(cy).clamp(0, h),
    }
}

/// 把两扇窗的 Region 更新到当前选区。
///
/// Region 一改，系统只会重绘"区域发生变化"的窄条；像素由 WM_PAINT 补。
fn apply_regions(hole: RectI) {
    let (Some(mask), Some(frame)) = (
        hwnd_of(MASK_HWND.load(Ordering::SeqCst)),
        hwnd_of(FRAME_HWND.load(Ordering::SeqCst)),
    ) else {
        return;
    };
    let w = AREA_W.load(Ordering::SeqCst);
    let h = AREA_H.load(Ordering::SeqCst);
    unsafe {
        // 遮罩：整屏减去「选区 + 1px」，那 2px 留给描边窗画环
        let outer = CreateRectRgn(0, 0, w, h);
        let inner = CreateRectRgn(hole.left - 1, hole.top - 1, hole.right + 1, hole.bottom + 1);
        let mask_region = CreateRectRgn(0, 0, 0, 0);
        CombineRgn(Some(mask_region), Some(outer), Some(inner), RGN_DIFF);
        let _ = DeleteObject(outer.into());
        let _ = DeleteObject(inner.into());
        // bRedraw=true：系统按 Region 差异自动重绘新暴露的区域。
        // SetWindowRgn 成功时区域归系统所有；失败时仍归调用方，必须自己删（否则每次
        // 拖框每帧泄漏一个 GDI 区域对象）。
        if SetWindowRgn(mask, Some(mask_region), true) == 0 {
            let _ = DeleteObject(mask_region.into());
        }

        // 描边：2px 空心环（外扩 1px、内缩 1px）
        let o2 = CreateRectRgn(hole.left - 1, hole.top - 1, hole.right + 1, hole.bottom + 1);
        let i2 = CreateRectRgn(hole.left + 1, hole.top + 1, hole.right - 1, hole.bottom - 1);
        let ring = CreateRectRgn(0, 0, 0, 0);
        CombineRgn(Some(ring), Some(o2), Some(i2), RGN_DIFF);
        let _ = DeleteObject(o2.into());
        let _ = DeleteObject(i2.into());
        if SetWindowRgn(frame, Some(ring), true) == 0 {
            let _ = DeleteObject(ring.into());
        }
    }
}

fn show_windows(show: bool) {
    let was = VISIBLE.swap(show, Ordering::SeqCst);
    if was == show {
        return;
    }
    for slot in [&MASK_HWND, &FRAME_HWND] {
        if let Some(hwnd) = hwnd_of(slot.load(Ordering::SeqCst)) {
            unsafe {
                let _ = ShowWindow(hwnd, if show { SW_SHOWNOACTIVATE } else { SW_HIDE });
            }
        }
    }
}

fn refresh() {
    REFRESH_PENDING.store(false, Ordering::SeqCst);
    let tracking = TRACKING.load(Ordering::SeqCst);
    // FROZEN：拖拽已结束但 WebView 还没接管，继续显示最后一帧
    if !tracking && !FROZEN.load(Ordering::SeqCst) {
        show_windows(false);
        return;
    }
    let hole = current_hole();
    // 先设 Region 再显示：否则第一帧会露出一整块未裁剪的半透明黑
    apply_regions(hole);
    show_windows(true);
    *LAST.lock().unwrap_or_else(|e| e.into_inner()) = hole;
}

// ─── 窗口过程 ──────────────────────────────────────────────────

unsafe extern "system" fn mask_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut ps = Default::default();
            let hdc = BeginPaint(hwnd, &mut ps);
            let brush = CreateSolidBrush(COLORREF(0));
            FillRect(hdc, &ps.rcPaint, brush);
            let _ = DeleteObject(brush.into());
            let _ = EndPaint(hwnd, &ps);
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_NCDESTROY => {
            let _ =
                MASK_HWND.compare_exchange(hwnd.0 as isize, 0, Ordering::SeqCst, Ordering::SeqCst);
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

unsafe extern "system" fn frame_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        MSG_REFRESH => {
            refresh();
            LRESULT(0)
        }
        WM_PAINT => {
            let mut ps = Default::default();
            let hdc = BeginPaint(hwnd, &mut ps);
            let mut rc = RECT::default();
            let _ = GetClientRect(hwnd, &mut rc);
            let hole = *LAST.lock().unwrap_or_else(|e| e.into_inner());
            // 整窗先铺白（会被 Region 裁成 2px 环，只有外侧 1px 看得见），
            // 再用强调色盖住内侧 1px。
            let white = CreateSolidBrush(COLORREF(0x00_FF_FF_FF));
            FillRect(hdc, &ps.rcPaint, white);
            let _ = DeleteObject(white.into());
            let accent = CreateSolidBrush(COLORREF(ACCENT.load(Ordering::SeqCst) as u32));
            let mut clip = ps.rcPaint;
            if clip.left < hole.left {
                clip.left = hole.left;
            }
            if clip.top < hole.top {
                clip.top = hole.top;
            }
            if clip.right > hole.right {
                clip.right = hole.right;
            }
            if clip.bottom > hole.bottom {
                clip.bottom = hole.bottom;
            }
            if clip.right > clip.left && clip.bottom > clip.top {
                FillRect(hdc, &clip, accent);
            }
            let _ = DeleteObject(accent.into());
            let _ = EndPaint(hwnd, &ps);
            let _ = rc;
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_NCDESTROY => {
            let _ =
                FRAME_HWND.compare_exchange(hwnd.0 as isize, 0, Ordering::SeqCst, Ordering::SeqCst);
            VISIBLE.store(false, Ordering::SeqCst);
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}


#[cfg(test)]
mod guard_tests {
    //! 这三条守的是"原生层必须被收口"的契约。它们都是**源码级**断言：
    //! 行为级测试在 CI 里跑不到真实窗口，一旦有人删掉某条收口，只有源码守卫能拦住。

    /// 去掉整行注释再匹配：把调用「注释掉」（而不是删掉）在文本层面看起来仍然存在，
    /// 不剥注释的守卫会被这种变异骗过（项目里踩过）。
    fn strip_line_comments(src: &str) -> String {
        src.lines()
            .map(|line| line.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 会话收尾必须拆掉原生层：它是全屏置顶窗，残留下来会一直压着桌面、
    /// 而且拿不到鼠标事件。
    #[test]
    fn screenshot_cleanup_disposes_native_selector() {
        let src = strip_line_comments(include_str!("../commands/mod.rs"));
        let body = src
            .split("fn cleanup_screenshot_session_inner")
            .nth(1)
            .expect("cleanup_screenshot_session_inner 被改名/删除了 —— 请同步本守卫");
        // 只看函数开头这一段：够覆盖"进入函数就先拆层"的约定，又不至于跨到别的函数
        let head: String = body.chars().take(600).collect();
        assert!(
            head.contains("screenshot::selector::dispose()"),
            "cleanup_screenshot_session_inner 必须调用 screenshot::selector::dispose()"
        );
    }

    /// 钩子只能在"正在框选"时把坐标喂给原生层。
    ///
    /// 去掉门禁就等于：截图之外（悬浮球、普通桌面操作）每一次鼠标移动都会驱动
    /// 一个全屏置顶窗重算 region —— 白烧 CPU，而且可能把遮罩画到不该出现的时刻。
    #[test]
    fn hook_feeds_cursor_only_while_tracking() {
        let src = strip_line_comments(include_str!("../hooks/mouse.rs"));
        assert!(
            src.contains("selector::is_tracking()"),
            "鼠标钩子必须用 selector::is_tracking() 给喂坐标加门禁"
        );
        assert!(
            src.contains("selector::feed_cursor("),
            "鼠标钩子必须把坐标交给 selector::feed_cursor"
        );
    }

    /// 松手必须同时「停跟踪」和「冻结保持」。
    ///
    /// 只冻结不停跟踪 = 框继续跟着光标跑（冻结名存实亡）；
    /// 只停跟踪不冻结 = 松手到 WebView 接管之间会闪一下没有遮罩的裸桌面。
    #[test]
    fn finish_at_stops_tracking_and_freezes() {
        let src = include_str!("selector.rs");
        let body = src
            .split("pub fn finish_at")
            .nth(1)
            .and_then(|rest| rest.split("\n}").next())
            .expect("finish_at 被改名/删除了 —— 请同步本守卫");
        assert!(
            body.contains("TRACKING.store(false"),
            "finish_at 必须停掉 TRACKING，否则松手后原生层会继续跟着光标"
        );
        assert!(
            body.contains("FROZEN.store(true"),
            "finish_at 必须置 FROZEN，否则松手到 WebView 接管之间会闪空"
        );
    }
}
