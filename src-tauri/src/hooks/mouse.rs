use super::TOOLBAR_SHADOW_MARGIN;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicIsize, AtomicPtr, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CopyIcon, DestroyIcon, GetMessageW, GetWindowRect, LoadCursorW,
    PostThreadMessageW, SetCursor, SetSystemCursor, SetWindowsHookExW, UnhookWindowsHookEx,
    HCURSOR, HHOOK, HICON, ICONINFO, IDC_ARROW, MSG, OCR_NORMAL, WH_MOUSE_LL, WM_LBUTTONDOWN,
    WM_LBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_QUIT,
};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetForegroundWindow};

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
    /// 「用户又按下鼠标」的单调序号，`MouseDown` 时自增。
    ///
    /// 选区检测是**异步**的（可能跑几百毫秒），期间用户若已经点向别处，那次检测的结果就过期了
    /// —— 显示工具栏前比对序号，不一致就丢弃。不加这道：旧实现是同步跑在消费线程上的，
    /// 用户那次按下会被排在队列里、等工具栏显示之后才处理，于是「点外部即关闭」的语义
    /// 顺手生效；改成异步后那个按下会立刻被处理（工具栏此时还没显示，关不掉），
    /// 随后工具栏又冒出来 —— 表现为「点了外面它还在」。
    interaction_seq: AtomicU64,
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
    /// 窗口置顶点选模式：为 true 时左键用来选中目标窗口，并被吞掉不外传。
    window_pin_active: AtomicBool,
    /// 安装临时系统光标前的原光标。取色与窗口置顶共用一份 —— 同一时刻只有一个
    /// 取点模式在跑，谁装的谁负责恢复（见 `install_system_cursor`）。
    system_cursor_backup: AtomicIsize,
    /// 鼠标是否落在悬浮球圆形热区内（-1 未知 / 0 球外 / 1 球内）。
    /// 状态变化时通知 orb 窗口切换「忽略鼠标事件」：球外那圈透明留白（窗口被系统最小宽度
    /// 拉到 135 逻辑、球只有 56）若不吃掉落在其上的点击，压在下面的便签顶栏、面板、
    /// 桌面图标点了都没反应。
    orb_zone: AtomicI32,
    /// 上次上报 OrbZone 的时刻，用于「状态未变也定期重报一次」的自愈节流。
    orb_zone_last_emit_ms: AtomicU64,
}

/// Serialize system-cursor replacement/restoration. Starting and stopping the
/// picker from frontend commands and native window cleanup can otherwise
/// interleave and leave a custom cursor installed after the picker is gone.
/// 取色与窗口置顶共用这一把锁（两者都会替换系统光标）。
static PICK_CURSOR_LOCK: Mutex<()> = Mutex::new(());

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
    interaction_seq: AtomicU64::new(0),
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
    window_pin_active: AtomicBool::new(false),
    system_cursor_backup: AtomicIsize::new(0),
    // 悬浮球圆形热区的进出状态（-1 未知 / 0 球外 / 1 球内）与上次上报时刻，
    // 详见 HookState 上的字段说明
    orb_zone: AtomicI32::new(-1),
    orb_zone_last_emit_ms: AtomicU64::new(0),
};

enum HookEvent {
    MouseUp,
    LongCapturePointerUp {
        x: i32,
        y: i32,
    },
    /// 按下点的屏幕坐标 + 钩子内采样的前台窗口。
    /// 前台窗口是**点击前**那个（激活发生在钩子返回之后），只用作滚动目标的候选，
    /// 详见 `scroll_navigation::remember_click_target`。
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
    /// 鼠标进出悬浮球圆形热区：通知 orb 窗口把球外那圈透明留白设为点击穿透，
    /// 否则留白会吞掉落在其上的点击（下面的便签顶栏/面板/桌面图标全点不动）。
    OrbZone {
        inside: bool,
    },
    LongCaptureWheel {
        x: i32,
        y: i32,
        delta: i16,
    },
    SmartScreenshotMove {
        x: i32,
        y: i32,
    },
    SmartScreenshotClick {
        x: i32,
        y: i32,
    },
    ColorPicked {
        x: i32,
        y: i32,
    },
    /// 窗口置顶点选落点：由后台线程解析成目标窗口并切换其置顶状态。
    WindowPicked {
        x: i32,
        y: i32,
    },
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

/// 悬浮球视觉球半径对应的交互热区半径（逻辑像素）= 球半径 28（`--orb-size` 56 / 2）+ 2px 容差，
/// 覆盖 hover 放大（scale 1.05 → 半径约 29.4px）后的球边缘。
/// 与前端 `FloatingOrb.tsx::isPointWithinOrb` 的 `rect.width / 2 + 2` 同源。
const ORB_HIT_RADIUS_LOGICAL: f64 = ORB_BALL_LOGICAL / 2.0 + 2.0;
/// 视觉球逻辑边长，与 tokens.css 的 `--orb-size` 同步。
const ORB_BALL_LOGICAL: f64 = 56.0;
/// orb 窗口逻辑高度（tauri.conf.json 的 `height`），用于把逻辑半径等比换算成物理像素。
///
/// ⚠️ 这里用**高度**而不是宽度做基准：Windows 对带标题栏样式的窗口强制最小宽度
/// `SM_CXMINTRACK`（150% 缩放下 = 202 物理 px = 134.67 逻辑 px），而 tao 的
/// `decorations: false` 只是用 `WM_NCCALCSIZE` 隐掉边框、仍保留 `WS_CAPTION`，
/// 于是配置里的 96 宽在运行时会被系统拉到 **135**（`setSize` 也设不回去）。
/// 拿宽度当基准会把热区半径放大 135/96 ≈ 1.4 倍（30 → 42 逻辑），导致「球外一大圈」
/// 被误判为点在球上；高度不受该限制（96 > SM_CYMINTRACK），是可靠的基准。
const ORB_WINDOW_HEIGHT_LOGICAL: f64 = 96.0;

/// 点到圆心的圆形判定（不含窗口句柄，便于单测）
fn point_in_circle(cx: f64, cy: f64, radius: f64, x: i32, y: i32) -> bool {
    let dx = x as f64 - cx;
    let dy = y as f64 - cy;
    dx * dx + dy * dy <= radius * radius
}

/// 由 orb 窗口的物理高度算出热区半径（物理像素）。抽成纯函数便于单测。
fn orb_hit_radius_px(window_height_px: f64) -> f64 {
    window_height_px * (ORB_HIT_RADIUS_LOGICAL / ORB_WINDOW_HEIGHT_LOGICAL)
}

/// 悬停光标在球外时，orb 窗口是否应忽略鼠标事件。
///
/// 抽成纯函数是为了把**极性**钉住：反了会从「球外穿透」变成「球外吃点击、
/// 球内反而点不动」，两种错法都很难从现象反推。单测 + 变异验证盯着这里。
fn orb_ignore_cursor_events(inside: bool) -> bool {
    !inside
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
        // 球心 = **窗口矩形中心**。
        //
        // 窗口一定比球大（tauri.conf 的 96×96 里放 `--orb-size` 56 的球），多出来的那圈
        // 是承载投影的透明留白；球由 `#root` 的 flex 居中在窗口里。⚠️ 这个居中是
        // **FloatingOrb.tsx 在挂载时用内联样式写上去的**（`root.style.display = "flex"`
        // + `alignItems/justifyContent = "center"`），不是 `.css` 里的规则 —— 只 grep
        // 样式表会看不到它，从而误判成"球贴左上角"。
        // 真实引擎实测（无头 Chrome + 真实 tokens/global/FloatingOrb 三层 CSS + 上面那三条
        // 内联样式，内容盒分别取 135×96 与 96×96）：球心与 `#root` 盒中心**逐像素相等**
        // （135 宽时球占 x 39.5~95.5、球心 x 67.5 = 盒中心 67.5；96 宽时 48 = 48）。
        // ⇒ 球心就是窗口矩形中心。前端 `FloatingOrb.tsx::isPointWithinOrb` 用元素
        // `getBoundingClientRect()` 的中心，两端同源。
        //
        // ⚠️ 不要改成「窗口左上角 + 球半径」：那只在「窗口尺寸 == 球尺寸」时才成立，
        // 而这里窗口必定大于球，且宽度还会被系统最小宽度拉到 ~135 逻辑 px
        // （见 ORB_WINDOW_HEIGHT_LOGICAL）—— 判定圆会整体偏移 20~40px，表现为
        // 「球的中部和右半边点不动、左上那片透明留白反而吃掉桌面点击」。
        let height_px = (rect.bottom - rect.top) as f64;
        let radius = orb_hit_radius_px(height_px);
        let cx = (rect.left as f64 + rect.right as f64) / 2.0;
        let cy = (rect.top as f64 + rect.bottom as f64) / 2.0;
        point_in_circle(cx, cy, radius, x, y)
    }
}

fn is_point_in_utility_hub(x: i32, y: i32) -> bool {
    is_point_in_window_rect(STATE.utility_hub_hwnd.load(Ordering::SeqCst), x, y)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ─── 取色笔光标（画笔造型） ────────────────────────────────────
//
// 32×32、4× 超采样后降采样，全部程序化绘制（不用外部 .cur 资源）。
// 造型 = 画笔：青色毛尖（笔尖即采样点）→ 金属箍 → 笔杆，斜置 45° 指向右上。
// 几何与设计稿原型 `render2.py::draw_brush` 一一对应（归档在
// `.workbuddy/design/eyedropper-cursor/`）；要改造型就照着那份原型改，再同步这里。
//
// 版式约定（两处坑，务必保留）：
//   ① 细部件（毛尖、箍、笔杆的墨线）只允许「墨色轮廓 + 浅色芯」，**不给外白晕** ——
//      白晕每侧 +1.1，会把 1.6 宽的细件吹到 6.2 宽，和主体一样粗。
//   ② 用「内缩四边形 + 四角圆」拼圆角矩形时，半径顶到半宽必须单独走 stroke（见 `canvas_rbox`）。

/// 光标位图边长（Windows 光标上限 32×32）。
const EYEDROPPER_SIZE: usize = 32;
/// 超采样倍率。
const EYEDROPPER_SCALE: usize = 4;
/// 超采样画布边长。
const EYEDROPPER_HI: usize = EYEDROPPER_SIZE * EYEDROPPER_SCALE;
/// 笔尖（= 采样点）。热点 `EYEDROPPER_HOTSPOT` 必须落在它所在的像素（两者是同源的
/// 两个常量，由 `eyedropper_hotspot_lands_on_the_brush_tip` 钉住它们的关系）。
const EYEDROPPER_TIP: (f64, f64) = (3.4, 27.6);
/// 热点＝笔尖所在像素（像素 (3,27) 覆盖 3..4 × 27..28，中心 3.5,27.5）。
const EYEDROPPER_HOTSPOT: (u32, u32) = (3, 27);
/// 绘制轴向：-45°（右上）。
const EYEDROPPER_ANGLE: f64 = -std::f64::consts::FRAC_PI_4;

/// 置顶准星光标的正中心。
///
/// 取 `15.5` 而非画布正中 `16.0`：Windows 的像素 (15,15) 覆盖 15..16，中心正是 15.5。
/// 让「图形中心 = 热点像素中心」严丝合缝，比让图形在 32×32 里居中重要 —— 图形偏
/// 0.5px 看不出来，热点偏 0.5px 就是点不准。
const TARGET_CENTER: (f64, f64) = (15.5, 15.5);
/// 置顶准星的热点＝中心所在像素（像素 (15,15) 覆盖 15..16 × 15..16，中心 15.5,15.5）。
const TARGET_HOTSPOT: (u32, u32) = (15, 15);

/// 4× 画布上的胶囊描边（圆头线段）。
fn canvas_stroke(canvas: &mut [u32], x0: f64, y0: f64, x1: f64, y1: f64, width: f64, color: u32) {
    let vx = x1 - x0;
    let vy = y1 - y0;
    let len2 = vx * vx + vy * vy;
    let r2 = (width / 2.0) * (width / 2.0);
    for y in 0..EYEDROPPER_HI {
        let py = (y as f64 + 0.5) / EYEDROPPER_SCALE as f64;
        for x in 0..EYEDROPPER_HI {
            let px = (x as f64 + 0.5) / EYEDROPPER_SCALE as f64;
            let t = if len2 > 0.0 {
                (((px - x0) * vx + (py - y0) * vy) / len2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let dx = px - (x0 + t * vx);
            let dy = py - (y0 + t * vy);
            if dx * dx + dy * dy <= r2 {
                canvas[y * EYEDROPPER_HI + x] = color;
            }
        }
    }
}

/// 4× 画布上的实心圆。
fn canvas_circle(canvas: &mut [u32], cx: f64, cy: f64, radius: f64, color: u32) {
    let r2 = radius * radius;
    for y in 0..EYEDROPPER_HI {
        let py = (y as f64 + 0.5) / EYEDROPPER_SCALE as f64;
        let dy2 = (py - cy) * (py - cy);
        if dy2 > r2 {
            continue;
        }
        for x in 0..EYEDROPPER_HI {
            let px = (x as f64 + 0.5) / EYEDROPPER_SCALE as f64;
            let dx2 = (px - cx) * (px - cx);
            if dx2 + dy2 <= r2 {
                canvas[y * EYEDROPPER_HI + x] = color;
            }
        }
    }
}

/// 叉积判号（凸四边形填充用）。
fn edge_sign(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64) -> f64 {
    (ax - cx) * (by - cy) - (bx - cx) * (ay - cy)
}

/// 4× 画布上的凸四边形填充（顶点顺序可顺可逆）。
///
/// 退化多边形（面积为零，含四点重合、四点共线）直接跳过 —— 那种情况下四条边的叉积
/// 全是 0，凸性判定的 `neg && pos` 两边都不成立，会把**整块画布**填满。
fn canvas_quad(canvas: &mut [u32], p: [(f64, f64); 4], color: u32) {
    let area2: f64 = (0..4)
        .map(|i| {
            let (a, b) = (p[i], p[(i + 1) % 4]);
            a.0 * b.1 - b.0 * a.1
        })
        .sum();
    if area2.abs() < 1e-9 {
        return;
    }
    for y in 0..EYEDROPPER_HI {
        let py = (y as f64 + 0.5) / EYEDROPPER_SCALE as f64;
        for x in 0..EYEDROPPER_HI {
            let px = (x as f64 + 0.5) / EYEDROPPER_SCALE as f64;
            let mut neg = false;
            let mut pos = false;
            for i in 0..4 {
                let (a, b) = (p[i], p[(i + 1) % 4]);
                let d = edge_sign(px, py, a.0, a.1, b.0, b.1);
                neg |= d < 0.0;
                pos |= d > 0.0;
            }
            if !(neg && pos) {
                canvas[y * EYEDROPPER_HI + x] = color;
            }
        }
    }
}

/// 4× 画布上的锥形（尖端宽 `wt` → 底宽 `wb`）。
#[allow(clippy::too_many_arguments)]
fn canvas_taper(
    canvas: &mut [u32],
    tx: f64,
    ty: f64,
    bx: f64,
    by: f64,
    wt: f64,
    wb: f64,
    color: u32,
) {
    let vx = bx - tx;
    let vy = by - ty;
    let l2 = vx * vx + vy * vy;
    if l2 <= 0.0 {
        canvas_circle(canvas, tx, ty, wt.max(wb) / 2.0, color);
        return;
    }
    let l = l2.sqrt();
    let (nx, ny) = (-vy / l, vx / l);
    let (ht, hb) = (wt / 2.0, wb / 2.0);
    canvas_quad(
        canvas,
        [
            (tx + nx * ht, ty + ny * ht),
            (tx - nx * ht, ty - ny * ht),
            (bx - nx * hb, by - ny * hb),
            (bx + nx * hb, by + ny * hb),
        ],
        color,
    );
}

/// 4× 画布上沿 a→b 轴的圆角矩形；`grow` 是向外扩张量（用于画描边层 / 外白晕）。
#[allow(clippy::too_many_arguments)]
fn canvas_rbox(
    canvas: &mut [u32],
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    w: f64,
    r: f64,
    color: u32,
    grow: f64,
) {
    let w = w + 2.0 * grow;
    let vx = bx - ax;
    let vy = by - ay;
    let l = (vx * vx + vy * vy).sqrt();
    if l <= 0.0 {
        canvas_circle(canvas, ax, ay, w.max(r * 2.0) / 2.0, color);
        return;
    }
    let (dx, dy) = (vx / l, vy / l);
    let r = (r + grow).min(w / 2.0).min(l / 2.0);
    let hw = w / 2.0 - r;
    let pa = (ax + dx * r, ay + dy * r);
    let pb = (bx - dx * r, by - dy * r);
    if hw <= 1e-6 {
        // 半径顶到半宽 ⇒ 整体就是一根胶囊。
        // ⚠️ 此时内缩四边形退化成两个重合点，`canvas_quad` 对退化多边形不填任何像素，
        // 必须单独走 stroke；否则中间那段会**静默消失**，只剩两个端头小圆。
        canvas_stroke(canvas, pa.0, pa.1, pb.0, pb.1, w, color);
        return;
    }
    let (nx, ny) = (-dy, dx);
    let corners = [
        (pa.0 + nx * hw, pa.1 + ny * hw),
        (pb.0 + nx * hw, pb.1 + ny * hw),
        (pb.0 - nx * hw, pb.1 - ny * hw),
        (pa.0 - nx * hw, pa.1 - ny * hw),
    ];
    canvas_quad(canvas, corners, color);
    for c in corners {
        canvas_circle(canvas, c.0, c.1, r, color);
    }
}

/// 取色笔光标的光栅化结果：32×32，`0` = 透明，否则 `0xAARRGGBB`（当前全不透明）。
///
/// 抽成纯函数是为了**可测**：真出光标要走 GDI（`CreateBitmap` + `CreateIconIndirect`），
/// 测试里跑不起来，而「热点有没有落在笔尖」「图形有没有顶出画布」这些问题全在这一层。
fn eyedropper_pixels() -> [u32; EYEDROPPER_SIZE * EYEDROPPER_SIZE] {
    const INK: u32 = 0xFF0F_172A;
    const BODY: u32 = 0xFFF8_FAFC;
    const METAL: u32 = 0xFFE2_E8F0;
    const WHITE: u32 = 0xFFFF_FFFF;
    const TEAL: u32 = 0xFF14_B8A6;
    /// 墨色轮廓单边宽。
    const RIM: f64 = 1.2;
    /// 外侧白晕单边宽（否则深色背景上只剩一根黑线，看不见）。
    const HALO: f64 = 1.1;

    let mut high = vec![0u32; EYEDROPPER_HI * EYEDROPPER_HI];
    let (tx, ty) = EYEDROPPER_TIP;
    let (dx, dy) = (EYEDROPPER_ANGLE.cos(), EYEDROPPER_ANGLE.sin());
    // 沿轴的坐标：t = 离笔尖的距离，p = 垂直偏移
    let at = |t: f64, p: f64| (tx + dx * t - dy * p, ty + dy * t + dx * p);

    // 毛（笔尖 → 毛根）：白晕 / 墨色轮廓 / 青色毛
    let (a, b) = (at(0.0, 0.0), at(5.4, 0.0));
    for (extra, color) in [(RIM + HALO, WHITE), (RIM, INK)] {
        let (wt, wb) = (2.8 + 2.0 * extra, 7.0 + 2.0 * extra);
        canvas_taper(&mut high, a.0, a.1, b.0, b.1, wt, wb, color);
    }
    canvas_taper(&mut high, a.0, a.1, b.0, b.1, 0.4, 4.6, TEAL);

    // 金属箍
    let (f0, f1) = (at(4.9, 0.0), at(8.4, 0.0));
    for (extra, color) in [(RIM + HALO, WHITE), (RIM, INK), (0.0, METAL)] {
        canvas_rbox(&mut high, f0.0, f0.1, f1.0, f1.1, 4.6, 1.6, color, extra);
    }

    // 笔杆
    let (h0, h1) = (at(8.2, 0.0), at(26.6, 0.0));
    for (extra, color) in [(RIM + HALO, WHITE), (RIM, INK), (0.0, BODY)] {
        canvas_rbox(&mut high, h0.0, h0.1, h1.0, h1.1, 3.4, 1.7, color, extra);
    }

    // 采样点标记
    canvas_circle(&mut high, tx, ty, 1.7, INK);
    canvas_circle(&mut high, tx, ty, 0.9, TEAL);

    downsample(&high)
}

/// 4× 画布 → 32×32 光标位图：16 个子采样里 >= 8 个被覆盖才不透明（二值 alpha，见模块注释）。
///
/// 通道顺序：画布上的颜色写作 `0xAARRGGBB`（与 `CreateBitmap` 的 32bpp BI_RGB 一致 ——
/// 它在内存里是 B,G,R,A，小端下低字节就是蓝），所以低字节 = **蓝**、bit16 起 = **红**。
fn downsample(high: &[u32]) -> [u32; EYEDROPPER_SIZE * EYEDROPPER_SIZE] {
    debug_assert_eq!(high.len(), EYEDROPPER_HI * EYEDROPPER_HI);
    let mut pixels = [0u32; EYEDROPPER_SIZE * EYEDROPPER_SIZE];
    for y in 0..EYEDROPPER_SIZE {
        for x in 0..EYEDROPPER_SIZE {
            let mut count = 0u32;
            let (mut red, mut green, mut blue) = (0u32, 0u32, 0u32);
            let (x0, y0) = (x * EYEDROPPER_SCALE, y * EYEDROPPER_SCALE);
            for sy in 0..EYEDROPPER_SCALE {
                for sx in 0..EYEDROPPER_SCALE {
                    let value = high[(y0 + sy) * EYEDROPPER_HI + x0 + sx];
                    if value != 0 {
                        count += 1;
                        blue += value & 0x0000_00FF;
                        green += (value >> 8) & 0x0000_00FF;
                        red += (value >> 16) & 0x0000_00FF;
                    }
                }
            }
            if count >= (EYEDROPPER_SCALE * EYEDROPPER_SCALE) as u32 / 2 {
                pixels[y * EYEDROPPER_SIZE + x] =
                    0xFF00_0000 | ((red / count) << 16) | ((green / count) << 8) | (blue / count);
            }
        }
    }
    pixels
}

/// 置顶准星光标的光栅化结果（约定同 `eyedropper_pixels`）。
///
/// 造型 = 四段准星 + 中心实心点：准星指明「点在哪儿」，实心点就是热点本身。
///
/// 不做「取景框」那套双层结构：32×32 放不下框 + 臂两层，白晕一撑，框和臂会挤在一起
/// 互相吃掉，臂短到看不出是准星。这个尺寸下最干净的解法就是标准十字。
fn target_pixels() -> [u32; EYEDROPPER_SIZE * EYEDROPPER_SIZE] {
    const INK: u32 = 0xFF0F_172A;
    const WHITE: u32 = 0xFFFF_FFFF;
    const TEAL: u32 = 0xFF14_B8A6;
    /// 墨色轮廓单边宽。
    const RIM: f64 = 1.2;
    /// 外侧白晕单边宽（否则深色背景上只剩一根黑线，看不见）。
    const HALO: f64 = 1.1;
    /// 准星臂线宽。
    const ARM: f64 = 1.2;
    /// 臂的内端半径：给中心点让出位置，臂不穿心。
    const ARM_INNER: f64 = 2.4;
    /// 臂的外端半径。必须给「白晕层圆头半径」留足余量 ——
    /// 白晕层线宽 = ARM + 2×(RIM + HALO) = 5.8，圆头半径 2.9，
    /// 于是 10.5 + 2.9 = 13.4 < 15.5（画布半宽）：圆头一旦顶到边缘就会被裁掉一角
    ///（`target_never_touches_the_canvas_edge` 守着这条）。
    const ARM_OUTER: f64 = 10.5;

    let mut high = vec![0u32; EYEDROPPER_HI * EYEDROPPER_HI];
    let (cx, cy) = TARGET_CENTER;

    let arms = [
        ((cx, cy - ARM_OUTER), (cx, cy - ARM_INNER)),
        ((cx, cy + ARM_INNER), (cx, cy + ARM_OUTER)),
        ((cx - ARM_OUTER, cy), (cx - ARM_INNER, cy)),
        ((cx + ARM_INNER, cy), (cx + ARM_OUTER, cy)),
    ];
    for (a, b) in arms {
        canvas_stroke(
            &mut high,
            a.0,
            a.1,
            b.0,
            b.1,
            ARM + 2.0 * (RIM + HALO),
            WHITE,
        );
        canvas_stroke(&mut high, a.0, a.1, b.0, b.1, ARM + 2.0 * RIM, INK);
    }

    // 中心点：白底 + 青芯。热点就落在这个点的正中，用户看到它等于看到了落点。
    canvas_circle(&mut high, cx, cy, 1.6, WHITE);
    canvas_circle(&mut high, cx, cy, 1.0, TEAL);

    downsample(&high)
}

/// 把 32×32 的 ARGB 光栅图包成 HCURSOR（`CreateIconIndirect` + AND mask）。
///
/// 返回 `isize` 而非 `HCURSOR`，是为了能塞进 `OnceLock`（`HCURSOR` 不是 `Sync`）。
/// 失败返回 `None`（GDI 资源耗尽等）——调用方须回退到不改光标，而不是照常进入取点模式。
fn cursor_from_pixels(pixels: &[u32], size: usize, hotspot: (u32, u32)) -> Option<isize> {
    use windows::Win32::Graphics::Gdi::{CreateBitmap, DeleteObject};

    unsafe {
        let color = CreateBitmap(
            size as i32,
            size as i32,
            1,
            32,
            Some(pixels.as_ptr() as *const std::ffi::c_void),
        );
        if color.is_invalid() {
            return None;
        }
        // AND mask：按 alpha >= 128 清位（当前 alpha 只有 0/255 两档，
        // 这样写是为了将来开「覆盖率抗锯齿」时 mask 自动跟着走）。
        let mut mask_bits = vec![0xFFu8; size * (size / 8).max(1)];
        let row_bytes = size.div_ceil(8);
        for y in 0..size {
            for x in 0..size {
                if pixels[y * size + x] >> 24 >= 128 {
                    mask_bits[y * row_bytes + x / 8] &= !(0x80 >> (x % 8));
                }
            }
        }
        let mask = CreateBitmap(
            size as i32,
            size as i32,
            1,
            1,
            Some(mask_bits.as_ptr() as *const std::ffi::c_void),
        );
        if mask.is_invalid() {
            let _ = DeleteObject(color.into());
            return None;
        }
        let info = ICONINFO {
            fIcon: false.into(),
            xHotspot: hotspot.0,
            yHotspot: hotspot.1,
            hbmMask: mask,
            hbmColor: color,
        };
        let cursor = windows::Win32::UI::WindowsAndMessaging::CreateIconIndirect(&info).ok();
        let _ = DeleteObject(mask.into());
        let _ = DeleteObject(color.into());
        cursor.map(|icon| icon.0 as isize)
    }
}

fn eyedropper_cursor() -> Option<HCURSOR> {
    static CURSOR: OnceLock<Option<isize>> = OnceLock::new();
    CURSOR
        .get_or_init(|| {
            cursor_from_pixels(&eyedropper_pixels(), EYEDROPPER_SIZE, EYEDROPPER_HOTSPOT)
        })
        .as_ref()
        .map(|value| HCURSOR(*value as *mut std::ffi::c_void))
}

/// 置顶点选模式的准星光标。
fn target_cursor() -> Option<HCURSOR> {
    static CURSOR: OnceLock<Option<isize>> = OnceLock::new();
    CURSOR
        .get_or_init(|| cursor_from_pixels(&target_pixels(), EYEDROPPER_SIZE, TARGET_HOTSPOT))
        .as_ref()
        .map(|value| HCURSOR(*value as *mut std::ffi::c_void))
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
                    // 先取出并**立即**清除「按下落在球圆形热区」标志。
                    //
                    // 为什么必须在松手时清：WM_MOUSEMOVE 的上报门控要求它为 false（拖球期间
                    // 不上报，避免在原生拖拽的模态循环里改窗口样式）。它原本只在**按下**时
                    // 重算，于是松手后它一直是 true —— 光标再移到球外（窗口透明留白盖住的
                    // 桌面/便签）时穿透状态**一直不更新**，那一带的点击会被球窗口持续吃掉，
                    // 直到用户下次按下（而这次点击已经丢了）。放在分支最前面是因为下面有
                    // 多处 `continue`，写在后面会被跳过。
                    let down_on_orb_circle =
                        STATE.mouse_down_on_orb_circle.swap(false, Ordering::SeqCst);
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
                        // 用分支开头取出的快照（那里已经 swap 清零）。
                        if down_on_orb_circle {
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
                        && [
                            "settings",
                            "scroll-navigator-overlay",
                            "utility-hub-overlay",
                        ]
                        .iter()
                        .any(|label| {
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

                    // ⚠️ 检测本体**必须离开这条消费线程**（见 `spawn_selection_check`）：
                    // 它是一条四级降级链 —— UIA → Win32 → 模拟 Ctrl+C（内部 50+150+30+100ms
                    // 休眠）→ **截屏 + OCR**，最坏数百毫秒到秒级。留在消费线程上，这段时间里
                    // 滚轮转发、鼠标抬起、悬浮球穿透上报全部堵在队列里，表现为「点击丢失 /
                    // 穿透迟钝 / 长截图丢滚动 / 时好时坏」。
                    //
                    // 拖选矩形与交互序号**随请求一起交给检测线程**：矩形是 `ocr_selection` 的
                    // 全局值，而 OCR 那一级要到检测线程里才读 —— 若仍由消费线程在派发前写，
                    // 第二次拖拽会在第一次检测跑到 OCR 之前把它覆盖掉（拿别人的区域去 OCR）；
                    // 序号则让检测线程能判断自己是否已被更新的操作顶掉。
                    spawn_selection_check(
                        app.clone(),
                        SelectionCheckRequest {
                            drag: (down_x, down_y, cur.x, cur.y),
                            interaction_seq: STATE.interaction_seq.load(Ordering::SeqCst),
                        },
                    );
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
                            let color =
                                format!("#{:02X}{:02X}{:02X}", pixel[2], pixel[1], pixel[0]);
                            let _ =
                                app.emit_to("utility-hub-overlay", "utility-color-picked", color);
                        }
                        Ok(_) => {
                            let _ = app.emit_to(
                                "utility-hub-overlay",
                                "utility-color-pick-error",
                                "无法读取屏幕像素",
                            );
                        }
                        Err(error) => {
                            let _ = app.emit_to(
                                "utility-hub-overlay",
                                "utility-color-pick-error",
                                error,
                            );
                        }
                    }
                }
                HookEvent::WindowPicked { x, y } => {
                    // 上一次点选可能已经结束（模式被自己关掉），迟到的落点直接丢弃。
                    if !STATE.window_pin_active.load(Ordering::SeqCst) {
                        continue;
                    }
                    match crate::window_pin::toggle_at(&app, x, y) {
                        Ok(message) => {
                            // 成功即退出点选：置顶是「设置类」操作而非连续采样，光标长期
                            // 停在准星上容易被忘记，而此模式下左键是被吞掉的。
                            stop_window_pin();
                            crate::window_pin::publish(&app, Some(message));
                        }
                        Err(error) => {
                            // 落点没打中可用窗口（例如点在桌面上）、或目标窗口权限不够：
                            // 保持激活，用户可以直接换个位置再点，不必回去按一次按钮。
                            // 按失败推给面板 —— 它与「已置顶：X」的配色必须不同，
                            // 否则用户会把这次没做成读成做成了。
                            crate::window_pin::publish_error(&app, error);
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
                    // 记一次「用户又按下了鼠标」：选区检测在别的线程跑，收尾时靠这个序号
                    // 判断自己是不是已经被更新的操作顶掉（详见 `interaction_seq` 字段说明）。
                    STATE.interaction_seq.fetch_add(1, Ordering::SeqCst);

                    // 滚动目标按「点击落点所在的顶层窗口」记录，不读前台窗口：
                    // 钩子里 GetForegroundWindow 返回的还是点击前那个窗口。
                    // 落点落在自己的悬浮球/面板上时不更换目标，只把点击前的前台窗口
                    // 记为候选（用户点悬浮球前正在用的程序）。
                    crate::scroll_navigation::remember_click_target(&app, x, y, foreground);

                    let orb_hwnd = STATE.orb_hwnd.load(Ordering::SeqCst);
                    // 悬浮球隐藏时（GetWindowRect 仍会返回其矩形），不把该位置点击
                    // 当作悬浮球交互，否则隐藏状态下点击原位置会触发 orb-mouseup 弹面板
                    let on_orb =
                        STATE.orb_visible.load(Ordering::SeqCst) && is_point_on_orb(orb_hwnd, x, y);
                    STATE.mouse_down_on_orb.store(on_orb, Ordering::SeqCst);
                    // 圆形热区精确判定：仅落在视觉球内才在 mouseup 触发 orb 交互，
                    // 避免点击透明留白/角落误弹面板
                    let on_orb_circle = is_point_in_orb_circle(orb_hwnd, x, y);
                    STATE
                        .mouse_down_on_orb_circle
                        .store(on_orb_circle, Ordering::SeqCst);

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
                        STATE
                            .mouse_down_on_orb_circle
                            .store(false, Ordering::SeqCst);
                    }
                }
                HookEvent::OrbZone { inside } => {
                    // 直接在这里切换，不经前端转手：本项目其他 set_ignore_cursor_events
                    // 用法（截图 / 录制 / 长截图遮罩）都在 Rust 侧。走前端要多一个
                    // emit → IPC → invoke 的往返 —— 而这段延迟正好落在「鼠标移进球体 →
                    // 恢复交互」之间，快点击会整下漏掉；还多一个 capability 依赖和
                    // 「监听器没挂上就静默失效」的失败面。
                    // set_ignore_cursor_events 内部用 execute_in_thread 派发到窗口线程，
                    // 在后台线程调用是它设计内的用法。
                    if let Some(win) = app.get_webview_window("orb") {
                        if let Err(error) =
                            win.set_ignore_cursor_events(orb_ignore_cursor_events(inside))
                        {
                            crate::utils::logger::log(
                                "mouse",
                                &format!("切换悬浮球点击穿透失败: {error}"),
                            );
                        }
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
                    let _ = app.emit_to(
                        "screenshot-overlay",
                        "screenshot-target-move",
                        serde_json::json!({ "x": x, "y": y }),
                    );
                }
                HookEvent::SmartScreenshotClick { x, y } => {
                    let _ = app.emit_to(
                        "screenshot-overlay",
                        "screenshot-target-click",
                        serde_json::json!({ "x": x, "y": y }),
                    );
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

/// 选区检测的**在飞占有**守卫。
///
/// 用 `Drop` 复位而不是在末尾手写复位：检测线程里跑的是跨进程 UIA / `SendMessageW` /
/// 剪贴板 / OCR，一旦 panic 就再也不会执行到末尾，占有会**永久**为真 ——
/// 拖拽弹文字工具栏从此静默失效，只能重启，而 release 是 GUI 子系统、连一行日志都没有。
///
/// ★ `Drop` 只在**仍持有**时复位。正常收尾已经在「判空 + 释放占有」那个临界区里把占有交出去了
/// （见 [`spawn_selection_check`]），这里若无条件再清一次，抹掉的就是**后来者**的占有 ——
/// 那正是"两条链并发"的入口，而两条并发会互相踩剪贴板（链里会模拟 Ctrl+C 读回滚剪贴板）。
/// 编号（而不是 `bool`）就是为了让守卫能认出"占有还是不是我的"。
struct SelectionCheckGuard(u64);

impl Drop for SelectionCheckGuard {
    fn drop(&mut self) {
        selection_queue().release(self.0);
    }
}

/// 一次选区检测请求：把「这次检测属于哪次拖拽」和「当时用户操作的序号」绑在一起传给检测线程。
///
/// 两个字段都不能从全局现读：拖选矩形是全局值（会被下一次拖拽覆盖），序号是「我是否已被顶掉」
/// 的判据 —— 都必须随请求冻结下来。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SelectionCheckRequest {
    /// 拖选矩形的两个对角点（物理像素），供 OCR 兜底那一级截屏用。
    drag: (i32, i32, i32, i32),
    /// 派发那一刻的 `interaction_seq`，用于丢弃已被用户新操作顶掉的结果。
    interaction_seq: u64,
}

/// 选区检测的派发状态：**在飞占有与挂起请求共用同一把锁**。
///
/// # 为什么必须是同一把锁
///
/// 派发侧要判「现在有没有链在跑」，收尾侧要判「还有没有人在等我补跑」—— 这是**同一个决定的
/// 两半**。拆成两把锁（原来是一个原子标志位 + 一个 `pending` 互斥量），就必然留下这个交错：
///
/// ```text
/// C: take() → None          ← 判定「没活了」，准备退出
/// P: 抢标志位失败（此刻仍为 true）
/// P: *pending = Some(req)   ← 挂起请求落盘，指望 C 来取
/// C: 守卫析构 → 标志位 = false
/// ```
///
/// 此后标志位为 false、`pending` 里躺着没人认领的请求。它**不会自愈**：派发侧只在争抢失败时
/// 才写 pending，下一次拖拽会抢到标志位、自己起线程 ⇒ 用户看到「拖一次没反应」。
///
/// （曾经用第三个标志位 `RETIRE_COMPLETED` 打补丁：投递方落盘后复查"收尾是否已跨过最后一步"，
/// 是则自己接手派发。那只把窗口收窄，两件事仍分属两把锁；而且接手分支压根没有"再抢一次
/// 在飞标志位"的动作，一旦走进去，**整条新链都在无人占有的状态下跑** —— 后续任何一次拖拽
/// 都能再起一条链，与下面「检测不并发」直接冲突。所以改成单锁。）
///
/// 现在「判空 → 释放占有」与「判占有 → 落盘」都在这一把锁的临界区里，两者不可能交错：
/// 收尾只有在确认没人落盘之后才会释放占有。
struct SelectionCheckQueue {
    /// 当前占有检测链的持有者编号（`None` = 没人跑）。用编号而不是 `bool`，
    /// 是为了让守卫能认出"占有还是不是我的"（见 [`SelectionCheckGuard`]）。
    owner: Option<u64>,
    /// 在飞期间被顶掉的请求（只保留**最新**一次），由当前链收尾时补跑。
    ///
    /// 旧实现同步跑在消费线程上，队列天然保证「每次拖拽都会被检测、最新的最后生效」；
    /// 改成异步 + 在飞互斥之后，若直接丢弃被顶掉的请求，用户「拖一次没反应 → 再拖一次」
    /// 的第二次会被**静默吞掉**（而这恰恰是最需要它生效的场景）。
    pending: Option<SelectionCheckRequest>,
}

static SELECTION_QUEUE: Mutex<SelectionCheckQueue> = Mutex::new(SelectionCheckQueue {
    owner: None,
    pending: None,
});

impl SelectionCheckQueue {
    /// 派发侧的一次决策。`true` = **本次调用自己起链**（占有已认领）；
    /// `false` = 已有链在跑，请求已挂进 `pending` 等它收尾补跑。
    ///
    /// 判占有与落盘是**一步**：分成"先看再写"就又能被收尾的"判空、释放"插进来。
    fn claim_or_park(&mut self, claim: u64, request: SelectionCheckRequest) -> bool {
        if self.owner.is_some() {
            self.pending = Some(request);
            return false;
        }
        self.owner = Some(claim);
        true
    }

    /// 收尾侧的一次决策。`None` = 没活了 —— 并且**占有已经在同一次调用里释放**。
    ///
    /// ★「取空」与「释放占有」必须同在这一步里：拆开就又留下「判完之后还有人落盘」的交错，
    /// 那份请求没人认领（症状：拖一次没反应）。
    fn take_next_or_release(&mut self) -> Option<SelectionCheckRequest> {
        match self.pending.take() {
            Some(next) => Some(next),
            None => {
                self.owner = None;
                None
            }
        }
    }

    /// 守卫析构时复位占有。**只在仍持有（编号一致）时**才清。
    ///
    /// 无条件清会抹掉**后来者**的占有 —— 那正是"两条链并发"的入口，而链里会模拟 Ctrl+C
    /// 读回滚剪贴板，两条并发会互相踩。
    fn release(&mut self, claim: u64) {
        if self.owner == Some(claim) {
            self.owner = None;
        }
    }
}

/// 占有编号的来源（只需要"互不相同"）。
static SELECTION_CLAIM_SEQ: AtomicU64 = AtomicU64::new(1);

fn selection_queue() -> std::sync::MutexGuard<'static, SelectionCheckQueue> {
    SELECTION_QUEUE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 把选区检测派发到独立线程执行。
///
/// # 为什么不能就地跑在钩子事件的消费线程上
///
/// `HookEvent` 只有**一个**消费线程（`start_hook` 里的 `while let Ok(event) = rx.recv()`），
/// 而选区检测是一条**四级降级链**：UIA → Win32 → 模拟 Ctrl+C（`clipboard_selection.rs` 内
/// 50+150+30+100ms 四处休眠）→ **截屏 + OCR**（`ocr_selection.rs` 里 `.join()` 等它跑完，
/// 首次还要加载 OCR 模型）。最坏数百毫秒到秒级。
///
/// 而这条链的触发门槛很低：只要「拖拽位移 > 2px」，且落点不在自有窗口上 ——
/// **桌面拖拽、拖窗口标题栏、在资源管理器里框选文件都会命中**（`COOLDOWN_MS` 只有 300ms）。
/// 就地跑，这段期间里滚轮转发、鼠标抬起、悬浮球穿透上报、置顶/取色的落点全都堵在同一个
/// 队列里，用户看到的就是「点击丢失 / 穿透迟钝 / 长截图丢滚动 / 时好时坏」。
///
/// 连发拖拽时检测**不并发**（同一时刻最多一条链在跑）：链里会模拟 Ctrl+C 并读回滚剪贴板，
/// 两条并发会互相踩。被顶掉的那次记进 [`SelectionCheckQueue::pending`]，由当前这次收尾时补跑。
fn spawn_selection_check(app: tauri::AppHandle, request: SelectionCheckRequest) {
    let claim = SELECTION_CLAIM_SEQ.fetch_add(1, Ordering::SeqCst);
    // 认领：抢到就自己起线程，抢不到就挂进 pending 等收尾带走。
    // ★「判占有 → 落盘」与收尾的「判空 → 释放占有」在同一把锁下（见 SelectionCheckQueue），
    //   两者不可能交错。锁在这里用完即放（临时量），别绑成变量带到下面去。
    if !selection_queue().claim_or_park(claim, request) {
        crate::utils::logger::log("mouse", "Selection check in flight, queued the latest drag");
        return;
    }
    // 守卫在**本线程**就构造好再移进闭包：`thread::spawn` 自身失败（线程资源耗尽）时会
    // panic，若守卫是在线程内部才构造，占有就永远卡住了。放在外面，spawn 失败时守卫随
    // 函数作用域结束复位。
    let guard = SelectionCheckGuard(claim);
    let spawned = std::thread::Builder::new()
        .name("selection-check".to_string())
        .spawn(move || {
            // 守卫全程持有占有：补跑循环也在这把「互斥」之下，不会出现两条链并发。
            let _guard = guard;
            run_selection_check(&app, request);
            // 补跑期间被顶掉的请求（最新的赢）。取到 None（= 占有已释放）才退出。
            loop {
                // 锁在这一行用完即放：`run_selection_check` 可能跑秒级，绝不能锁着它跑 ——
                // 派发侧跑在钩子事件的消费线程上，锁一被占住它就堵在那里。
                let next = selection_queue().take_next_or_release();
                let Some(next) = next else { break };
                run_selection_check(&app, next);
            }
        });
    if spawned.is_err() {
        crate::utils::logger::log("mouse", "Failed to spawn selection check thread");
    }
}

/// 跑一次检测：先把本次拖选矩形落进 `ocr_selection` 的全局值（OCR 那一级要从它读），
/// 再走检测本体。
///
/// 矩形必须由**检测线程自己**写：它由本线程随后读取，而同一条链是串行的，
/// 所以不会被别的拖拽覆盖（这正是它不能留在消费线程里写的原因）。
fn run_selection_check(app: &tauri::AppHandle, request: SelectionCheckRequest) {
    let (x1, y1, x2, y2) = request.drag;
    crate::automation::ocr_selection::set_last_drag_rect(x1, y1, x2, y2);
    check_selection_and_show_toolbar(app, request.interaction_seq);
}

/// 选区检测本体：拿到选区就把文字工具栏摆到选区下方。
/// 由 `run_selection_check` 在独立线程调用，**不得**直接放进钩子事件的消费线程。
fn check_selection_and_show_toolbar(app: &tauri::AppHandle, interaction_seq: u64) {
    match crate::automation::get_current_selection() {
        Ok(Some(info)) if !info.text.is_empty() || info.has_image => {
            // 这次链可能跑了几百毫秒，期间用户若已按下鼠标（点向别处），结果就过期了。
            // 旧实现同步跑在消费线程上：那次按下会被排在队列里、等工具栏显示之后才处理，
            // 「点外部即关闭」的语义顺手生效；改成异步后那个按下会立刻被处理（工具栏此时
            // 还没显示，关不掉），随后工具栏又冒出来 —— 表现为「点了外面它还在」。
            // 用序号把这份耦合显式化，而不是继续依赖时序。
            if STATE.interaction_seq.load(Ordering::SeqCst) != interaction_seq {
                crate::utils::logger::log(
                    "mouse",
                    "Selection check superseded by a newer click, not showing toolbar",
                );
                return;
            }
            crate::utils::logger::log(
                "mouse",
                &format!("Selection found: {} chars", info.text.len()),
            );
            let _ = app.emit("selection-found", &info);
            if let Some(win) = app.get_webview_window("toolbar") {
                // 窗口四周有投影留白（见 TextToolbar.tsx 的 TOOLBAR_SHADOW_MARGIN）：
                // 容器左上角比窗口左上角内缩一个留白，所以窗口位置要相应左移，工具栏才会
                // 落在选区下方原位；y 不用补偿（留白只在左右和底部）。
                let toolbar_margin =
                    (TOOLBAR_SHADOW_MARGIN * win.scale_factor().unwrap_or(1.0)).round() as i32;
                let x = info.rect.x - toolbar_margin;
                let y = if info.rect.height > 0 {
                    info.rect.y + info.rect.height + 5
                } else {
                    info.rect.y + 20
                };
                let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
                    x, y,
                )));
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
        Err(e) => crate::utils::logger::log("mouse", &format!("Selection error: {}", e)),
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
    // 显隐切换后热区状态可能已过期（例如窗口被拖走、显示时鼠标已在球上）：
    // 置回「未知」，让下一次鼠标移动无条件重报一次，避免停留在错误的穿透状态。
    STATE.orb_zone.store(-1, Ordering::SeqCst);
    if visible {
        // 窗口位置是记忆恢复的，可能正好出现在光标下方。这时用户不动鼠标就直接点击，
        // 没有 WM_MOUSEMOVE 可依赖 —— 若停留在「球外穿透」状态，这一击会穿透到下面的
        // 窗口（可能误触便签的删除按钮、浏览器里的链接之类）。
        //
        // 所以显示时先无条件恢复可交互（fail-open）：即使 webview 刚重载、前端没起来，
        // 球也绝不会以「点不动」的状态出现；几毫秒后按真实光标位置修正为穿透。
        if let Some(app) = STATE.app_handle.get() {
            if let Some(win) = app.get_webview_window("orb") {
                let _ = win.set_ignore_cursor_events(false);
            }
        }
        sync_orb_zone_now();
    }
    crate::utils::logger::log("mouse", &format!("orb_visible = {}", visible));
}

/// 按当前光标位置立刻上报一次热区状态。
///
/// 正常路径是「鼠标移动 → 钩子判定 → 上报」，但上面那条「窗口在光标下方出现、
/// 用户不动鼠标直接点击」的路径没有任何鼠标移动可依赖，需要在这里补一次。
fn sync_orb_zone_now() {
    let hwnd = STATE.orb_hwnd.load(Ordering::SeqCst);
    if hwnd.is_null() {
        // 窗口还没就绪：保持「可交互」这个安全默认值，交给下一次鼠标移动
        return;
    }
    let mut cur = POINT::default();
    if unsafe { GetCursorPos(&mut cur) }.is_err() {
        return;
    }
    let Some(sender) = STATE.sender.get() else {
        return;
    };
    let inside = is_point_in_orb_circle(hwnd, cur.x, cur.y);
    STATE
        .orb_zone
        .store(if inside { 1 } else { 0 }, Ordering::SeqCst);
    STATE
        .orb_zone_last_emit_ms
        .store(now_ms(), Ordering::SeqCst);
    let _ = sender.send(HookEvent::OrbZone { inside });
}

/// Cache the utility hub HWND so the low-level mouse callback does not call
/// into Tauri while deciding whether a click belongs to the hub controls.
pub fn set_utility_hub_hwnd(hwnd: *mut std::ffi::c_void) {
    STATE.utility_hub_hwnd.store(hwnd, Ordering::SeqCst);
}

/// 把系统箭头光标换成 `cursor`，并记下原光标以便恢复。
///
/// 调用方**必须**持有 `PICK_CURSOR_LOCK`：`SetSystemCursor` 改的是系统级状态，取色与
/// 窗口置顶两个模式会先后进出，不加锁时「A 的恢复」可能插在「B 的安装」之后，把自定义
/// 光标永久留在系统里。
fn install_system_cursor(cursor: HCURSOR) -> Result<(), String> {
    unsafe {
        let original = LoadCursorW(None, IDC_ARROW)
            .ok()
            .and_then(|handle| CopyIcon(HICON(handle.0)).ok())
            .ok_or_else(|| "无法读取系统光标".to_string())?;
        // `SetSystemCursor` 会**接管并最终销毁**传入的 HCURSOR，所以必须给它一份副本 ——
        // 直接把缓存里的光标递过去，第二次进入该模式时用的就是已失效的句柄。
        //
        // 两条失败路径都要自己把已创建的副本还回去：`SetSystemCursor` 没接手时它们
        // 仍归本进程所有，漏掉就是每次失败丢一个图标句柄。
        let replacement = match CopyIcon(HICON(cursor.0)) {
            Ok(handle) => handle,
            Err(_) => {
                let _ = DestroyIcon(HICON(original.0));
                return Err("无法创建临时光标".to_string());
            }
        };
        if SetSystemCursor(HCURSOR(replacement.0), OCR_NORMAL).is_err() {
            let _ = DestroyIcon(replacement);
            let _ = DestroyIcon(HICON(original.0));
            return Err("无法设置临时光标".to_string());
        }
        STATE
            .system_cursor_backup
            .store(original.0 as isize, Ordering::SeqCst);
    }
    // `SetSystemCursor` 只对「此后新出现的」光标生效，当前这只还要单独换一次。
    unsafe {
        let _ = SetCursor(Some(cursor));
    }
    Ok(())
}

/// 恢复安装前的系统光标。幂等，且未安装过（备份为 0）时只把当前光标复位成箭头。
///
/// 同样要求调用方持有 `PICK_CURSOR_LOCK`。
fn restore_system_cursor() {
    let original = STATE.system_cursor_backup.swap(0, Ordering::SeqCst);
    if original != 0 {
        unsafe {
            let _ = SetSystemCursor(HCURSOR(original as *mut std::ffi::c_void), OCR_NORMAL);
        }
    }
    if let Ok(cursor) = unsafe { LoadCursorW(None, IDC_ARROW) } {
        unsafe {
            let _ = SetCursor(Some(cursor));
        }
    }
}

/// Arm a persistent native screen-pixel picker. Each primary click is consumed
/// after sampling, so it does not also activate the underlying application.
pub fn start_color_pick() -> Result<(), String> {
    // 与窗口置顶点选互斥。这条不变量放在这里、跟着系统光标资源走 —— 只靠命令层
    // 「进的路上先停掉对方」，漏掉任何一条入口（或将来新增一条）都会让两个模式同时
    // 开着，退出时恢复出来的是对方那只光标。
    //
    // 两个 stop 都自带「没开就原地返回」的守卫，各自取还一次锁；不能挪进下面的临界区
    // ——`PICK_CURSOR_LOCK` 是不可重入的普通 Mutex，那样会直接自锁。
    stop_window_pin();

    let _cursor_lock = PICK_CURSOR_LOCK
        .lock()
        .map_err(|_| "取色光标状态锁已损坏".to_string())?;
    STATE.mouse_down_valid.store(false, Ordering::SeqCst);
    if STATE.color_picker_active.load(Ordering::SeqCst) {
        return Ok(());
    }
    let cursor = eyedropper_cursor().ok_or_else(|| "无法创建取色光标".to_string())?;
    install_system_cursor(cursor)?;
    STATE.color_picker_active.store(true, Ordering::SeqCst);
    Ok(())
}

pub fn stop_color_pick() {
    // ⚠️ 锁中毒时**绝不能早退**：`SetSystemCursor` 改的是**系统级**箭头（不是窗口内光标），
    // 一旦在这里 return，整个 Windows 的指针就会停在取色笔上、直到重启（或别的程序重置
    // 系统光标）—— 因为还原用的句柄是本进程 `CopyIcon` 出来的副本，进程一死就没人能还了。
    // 毒化只说明上一次临界区没走完；恢复动作本身幂等（`system_cursor_backup` 用 swap 取走），
    // 照做是对的。
    let _cursor_lock = PICK_CURSOR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // 只在「确实是自己装的光标」时恢复：外部清理路径（关闭面板、退出应用）会无条件
    // 调本函数，若此时是窗口置顶点选在跑，盲目恢复会把它的准星也一并撤掉。
    if !STATE.color_picker_active.swap(false, Ordering::SeqCst) {
        return;
    }
    STATE.mouse_down_valid.store(false, Ordering::SeqCst);
    restore_system_cursor();
}

/// 进入窗口置顶点选模式：系统光标换成准星，左键用来选中目标窗口。
///
/// 与取色互斥，理由与实现位置同 `start_color_pick`。
pub fn start_window_pin() -> Result<(), String> {
    stop_color_pick();

    let _cursor_lock = PICK_CURSOR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    STATE.mouse_down_valid.store(false, Ordering::SeqCst);
    if STATE.window_pin_active.load(Ordering::SeqCst) {
        return Ok(());
    }
    let cursor = target_cursor().ok_or_else(|| "无法创建准星光标".to_string())?;
    install_system_cursor(cursor)?;
    STATE.window_pin_active.store(true, Ordering::SeqCst);
    Ok(())
}

pub fn stop_window_pin() {
    // 同 `stop_color_pick`：锁中毒也必须把系统光标还原，早退 = 整机指针停在准星上。
    let _cursor_lock = PICK_CURSOR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if !STATE.window_pin_active.swap(false, Ordering::SeqCst) {
        return;
    }
    STATE.mouse_down_valid.store(false, Ordering::SeqCst);
    restore_system_cursor();
}

/// 当前是否处于窗口置顶点选模式（供命令层与键盘钩子判断）。
pub fn is_window_pin_active() -> bool {
    STATE.window_pin_active.load(Ordering::SeqCst)
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
        STATE
            .mouse_down_on_orb_circle
            .store(false, Ordering::SeqCst);
        STATE.mouse_down_on_toolbar.store(false, Ordering::SeqCst);
    }
}

pub fn set_smart_screenshot_mode(active: bool) {
    STATE.smart_screenshot_mode.store(active, Ordering::SeqCst);
    if !active {
        STATE
            .smart_screenshot_last_emit_ms
            .store(0, Ordering::SeqCst);
        STATE.smart_controls_valid.store(false, Ordering::SeqCst);
    }
}

pub fn set_smart_screenshot_controls_bounds(bounds: Option<(i32, i32, i32, i32)>) {
    match bounds {
        Some((left, top, width, height)) if width > 0 && height > 0 => {
            STATE.smart_controls_left.store(left, Ordering::SeqCst);
            STATE.smart_controls_top.store(top, Ordering::SeqCst);
            STATE
                .smart_controls_right
                .store(left.saturating_add(width), Ordering::SeqCst);
            STATE
                .smart_controls_bottom
                .store(top.saturating_add(height), Ordering::SeqCst);
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
        STATE
            .mouse_down_on_orb_circle
            .store(false, Ordering::SeqCst);
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
                        if !hook.is_null() && is_point_in_utility_hub((*hook).pt.x, (*hook).pt.y) {
                            return CallNextHookEx(None, code, wparam, lparam);
                        }
                        return LRESULT(1);
                    }
                    if STATE.window_pin_active.load(Ordering::SeqCst) {
                        let hook = lparam.0
                            as *const windows::Win32::UI::WindowsAndMessaging::MSLLHOOKSTRUCT;
                        // 与按下对称：面板内的抬起要放行，否则那上面的按钮点不动。
                        if !hook.is_null() && is_point_in_utility_hub((*hook).pt.x, (*hook).pt.y) {
                            return CallNextHookEx(None, code, wparam, lparam);
                        }
                        return LRESULT(1);
                    }
                    if STATE.smart_mouse_down.swap(false, Ordering::SeqCst) {
                        return LRESULT(1);
                    }
                    if STATE.smart_screenshot_mode.load(Ordering::SeqCst) {
                        let hook = lparam.0
                            as *const windows::Win32::UI::WindowsAndMessaging::MSLLHOOKSTRUCT;
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
                _ if msg == WM_MOUSEMOVE && STATE.color_picker_active.load(Ordering::SeqCst) => {
                    let _ = SetCursor(eyedropper_cursor());
                }
                // 置顶点选：每次移动都重设准星。有些程序（浏览器、编辑器）会在自己的
                // 消息循环里 SetCursor 改回默认箭头，只在切换模式时设一次会被它们盖掉。
                _ if msg == WM_MOUSEMOVE && STATE.window_pin_active.load(Ordering::SeqCst) => {
                    let _ = SetCursor(target_cursor());
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
                        STATE
                            .smart_screenshot_last_emit_ms
                            .store(now, Ordering::SeqCst);
                        let hook = lparam.0
                            as *const windows::Win32::UI::WindowsAndMessaging::MSLLHOOKSTRUCT;
                        if !hook.is_null() {
                            let event = &*hook;
                            let _ = sender.send(HookEvent::SmartScreenshotMove {
                                x: event.pt.x,
                                y: event.pt.y,
                            });
                        }
                    }
                }
                // 悬浮球热区进出判定。放在各模式分支之后：截图/转盘等模式有自己的
                // 鼠标逻辑，不在这里抢。回调内只做算术 + channel send（emit 交给后台
                // 线程，理由同 QuickInputMove）；仅在「球内/球外发生变化」或距上次上报
                // ≥1s 时发送，既能自愈（窗口刚显示、坐标过期）又不会淹没后台线程。
                //
                // 拖球期间（按下时落在球内）不上报：拖拽时光标必然离开球体，
                // 而切换穿透会改写窗口扩展样式（tao 用 SWP_FRAMECHANGED 生效），
                // 在原生拖拽的模态循环里改样式有打断拖拽的风险。松手后下一次移动自然续上。
                _ if msg == WM_MOUSEMOVE
                    && STATE.orb_visible.load(Ordering::SeqCst)
                    && !STATE.mouse_down_on_orb_circle.load(Ordering::SeqCst) =>
                {
                    let hook =
                        lparam.0 as *const windows::Win32::UI::WindowsAndMessaging::MSLLHOOKSTRUCT;
                    if !hook.is_null() {
                        let event = &*hook;
                        let inside = is_point_in_orb_circle(
                            STATE.orb_hwnd.load(Ordering::SeqCst),
                            event.pt.x,
                            event.pt.y,
                        );
                        let zone = if inside { 1 } else { 0 };
                        let now = now_ms();
                        let changed = STATE.orb_zone.load(Ordering::SeqCst) != zone;
                        let stale = now
                            .saturating_sub(STATE.orb_zone_last_emit_ms.load(Ordering::SeqCst))
                            >= 1000;
                        if changed || stale {
                            STATE.orb_zone.store(zone, Ordering::SeqCst);
                            STATE.orb_zone_last_emit_ms.store(now, Ordering::SeqCst);
                            let _ = sender.send(HookEvent::OrbZone { inside });
                        }
                    }
                }
                _ if msg == WM_LBUTTONDOWN => {
                    if STATE.color_picker_active.load(Ordering::SeqCst) {
                        let hook = lparam.0
                            as *const windows::Win32::UI::WindowsAndMessaging::MSLLHOOKSTRUCT;
                        if !hook.is_null() {
                            let event = &*hook;
                            if is_point_in_utility_hub(event.pt.x, event.pt.y) {
                                return CallNextHookEx(None, code, wparam, lparam);
                            }
                            let _ = sender.send(HookEvent::ColorPicked {
                                x: event.pt.x,
                                y: event.pt.y,
                            });
                        }
                        STATE.mouse_down_valid.store(false, Ordering::SeqCst);
                        STATE.mouse_down_on_orb.store(false, Ordering::SeqCst);
                        STATE
                            .mouse_down_on_orb_circle
                            .store(false, Ordering::SeqCst);
                        STATE.mouse_down_on_toolbar.store(false, Ordering::SeqCst);
                        return LRESULT(1);
                    }
                    if STATE.window_pin_active.load(Ordering::SeqCst) {
                        let hook = lparam.0
                            as *const windows::Win32::UI::WindowsAndMessaging::MSLLHOOKSTRUCT;
                        if !hook.is_null() {
                            let event = &*hook;
                            // 落在通用工具面板内的按下放行给 WebView：否则用户在点选模式
                            // 下没法再点一次按钮退出（取色分支同理）。
                            if is_point_in_utility_hub(event.pt.x, event.pt.y) {
                                return CallNextHookEx(None, code, wparam, lparam);
                            }
                            let _ = sender.send(HookEvent::WindowPicked {
                                x: event.pt.x,
                                y: event.pt.y,
                            });
                        }
                        // 与取色一致：点选期间清掉按下残留，避免退出后误触发文字工具栏。
                        STATE.mouse_down_valid.store(false, Ordering::SeqCst);
                        STATE.mouse_down_on_orb.store(false, Ordering::SeqCst);
                        STATE
                            .mouse_down_on_orb_circle
                            .store(false, Ordering::SeqCst);
                        STATE.mouse_down_on_toolbar.store(false, Ordering::SeqCst);
                        return LRESULT(1);
                    }
                    // 快速输入转盘激活且实际可见时：任何按下都作为「点击选中扇区」处理。
                    // 通知前端（自行读高亮项并输入）后吞掉该按下，避免其落入
                    // 选区检测/拖选逻辑，也不会在转盘区域拖出文字工具栏。
                    // 可见性守卫：active 卡死而转盘未显示时不吞点击，保证全局鼠标可用。
                    if STATE.smart_screenshot_mode.load(Ordering::SeqCst) {
                        let hook = lparam.0
                            as *const windows::Win32::UI::WindowsAndMessaging::MSLLHOOKSTRUCT;
                        if !hook.is_null() {
                            let event = &*hook;
                            if is_smart_controls_point(event.pt.x, event.pt.y) {
                                return CallNextHookEx(None, code, wparam, lparam);
                            }
                            STATE.smart_mouse_down.store(true, Ordering::SeqCst);
                            let _ = sender.send(HookEvent::SmartScreenshotClick {
                                x: event.pt.x,
                                y: event.pt.y,
                            });
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
                        STATE
                            .mouse_down_on_orb_circle
                            .store(false, Ordering::SeqCst);
                        STATE.mouse_down_on_toolbar.store(false, Ordering::SeqCst);
                        // 吞掉该按下，不让它穿透到下层窗口
                        return LRESULT(1);
                    }
                    // WH_MOUSE_LL 的 lparam 是指向 MSLLHOOKSTRUCT 的指针，
                    // 其首字段 pt: POINT 即真实屏幕坐标
                    let pt = lparam.0 as *const POINT;
                    let x = (*pt).x;
                    let y = (*pt).y;
                    // 必须在这里读前台窗口：钩子返回后目标窗口才会被激活
                    let foreground = GetForegroundWindow();
                    let foreground = if foreground.is_invalid() {
                        0
                    } else {
                        foreground.0 as isize
                    };
                    let _ = sender.send(HookEvent::MouseDown { x, y, foreground });
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
        // 验证 orb 圆形热区的几何逻辑（无需实际窗口）。
        // 运行期真实几何：窗口被系统最小宽度拉到 ~135 逻辑宽 × 96 高（见
        // ORB_WINDOW_HEIGHT_LOGICAL），球（`--orb-size` 56）由 `#root` 的 flex 居中
        // → 球心 = 窗口中心 (67.5, 48)，球占 x 39.5~95.5、y 20~76，交互半径 30。
        let (win_w, win_h) = (135.0_f64, 96.0_f64);
        let (cx, cy) = (win_w / 2.0, win_h / 2.0);
        let r = ORB_HIT_RADIUS_LOGICAL;

        // 交互半径应略大于视觉球半径 28（hover scale 1.05 → 约 29.4px）
        assert!(r > 28.0);
        assert!(r <= 32.0);

        // 球心、以及球缘四向（距球心 27.5 / 28px）都必须命中
        assert!(point_in_circle(cx, cy, r, 68, 48));
        assert!(point_in_circle(cx, cy, r, 40, 48));
        assert!(point_in_circle(cx, cy, r, 95, 48));
        assert!(point_in_circle(cx, cy, r, 68, 20));
        assert!(point_in_circle(cx, cy, r, 68, 76));
        // 窗口四角是承载投影的透明留白，必须穿透给桌面
        assert!(!point_in_circle(cx, cy, r, 4, 4));
        assert!(!point_in_circle(cx, cy, r, 131, 92));

        // 把**错误假设**钉在测试里：球心若取「窗口左上角 + 球半径」(28,28)，
        // 球心与球的右半/下部都会被判成球外（点上去穿透到桌面），
        // 而左上那片透明留白反被判成球内（吃掉桌面的点击）。
        // 注意：本用例只钉「正确几何应当如何」（不读实现），能挡住的是"把期望值改成
        // 左上角"；实现侧的回归由源码级守卫 `orb_center_is_window_center` 抓。
        assert!(!point_in_circle(28.0, 28.0, r, 68, 48));
        assert!(!point_in_circle(28.0, 28.0, r, 95, 48));
        assert!(point_in_circle(28.0, 28.0, r, 10, 20));
    }

    /// `is_point_in_orb_circle` 必须用**窗口矩形中心**当球心，不得用「左上角 + 球半径」。
    ///
    /// 窗口比球大（留白供投影），球由 `#root` 的 flex 居中 —— 而那个居中是
    /// `FloatingOrb.tsx` 挂载时写上去的**内联样式**，不在 `.css` 里；只看样式表会误判成
    /// 「球贴左上角」。左上角假设会让判定圆整体偏 20~40px（宽度还会被系统最小宽度拉到
    /// ~135 逻辑 px），表现为球的中部/右半边点不动、左上透明留白吃掉点击。
    /// 前端 `FloatingOrb.tsx::isPointWithinOrb` 用元素实际 rect 的中心，两端同源。
    #[test]
    fn orb_center_is_window_center() {
        let src = include_str!("mouse.rs");
        let rest = src
            .split("fn is_point_in_orb_circle")
            .nth(1)
            .expect("is_point_in_orb_circle 被改名/删除了 —— 请同步本守卫");
        // 只认行首的收尾 `}`，不写死尾随换行：CI 检出的是 CRLF（仓库无 `.gitattributes`
        // 且 `core.autocrlf=true`），`"\n}\n"` 匹配不到会让 body 顺着 `unwrap_or` 退化成
        // 整段剩余源码 —— 断言随之变宽、恒真，守卫静默失效。
        let body_end = rest.find("\n}").map(|i| i + 1).unwrap_or(rest.len());
        let body = &rest[..body_end];
        assert!(
            body.contains("let cx = (rect.left as f64 + rect.right as f64) / 2.0;"),
            "球心必须取窗口矩形中心（球由 #root 的 flex 居中在窗口里）"
        );
        assert!(
            body.contains("let cy = (rect.top as f64 + rect.bottom as f64) / 2.0;"),
            "球心纵向也必须取窗口矩形中心"
        );
        assert!(
            !body.contains("rect.left as f64 + ball_radius")
                && !body.contains("rect.top as f64 + ball_radius"),
            "球心又被写成「窗口左上角 + 球半径」—— 窗口比球大（留白供投影），球心是窗口中心"
        );
    }

    /// 热区半径按窗口**高度**换算：宽度在运行时会被系统最小宽度拉到 135 逻辑
    /// （见 ORB_WINDOW_HEIGHT_LOGICAL 的说明），拿它当基准会把半径放大 1.4 倍。
    #[test]
    fn orb_hit_radius_follows_window_height() {
        // 96 逻辑高 @150% = 144 物理 px → 半径 = 30 逻辑 = 45 物理 px
        assert!((orb_hit_radius_px(144.0) - 45.0).abs() < 0.001);
        // 125% 缩放：96 逻辑高 = 120 物理 → 37.5 物理（同样是 30 逻辑）
        assert!((orb_hit_radius_px(120.0) - 37.5).abs() < 0.001);
    }

    /// 源码级哨兵：`is_point_in_orb_circle` 只能用窗口高度换算半径。
    /// 用宽度会得到 202 × 30/96 ≈ 63 物理（42 逻辑），比前端 `isPointWithinOrb`
    /// 的 30 逻辑大 12px —— 球外一圈会被误判成「点在球上」。
    #[test]
    fn orb_hit_radius_uses_height_not_width() {
        let source = include_str!("mouse.rs");
        let after = source
            .split("fn is_point_in_orb_circle")
            .nth(1)
            .expect("is_point_in_orb_circle 不见了：本哨兵依赖它仍在 mouse.rs 内");
        let body = &after[..after.find("\n}").unwrap_or(after.len())];
        assert!(
            body.contains("let height_px = (rect.bottom - rect.top) as f64;")
                && body.contains("orb_hit_radius_px(height_px)"),
            "半径必须用窗口高度换算（窗口宽度会被系统最小宽度拉宽）"
        );
        assert!(
            !body.contains("rect.right - rect.left"),
            "不要用窗口宽度换算半径：运行时宽度被拉到 135 逻辑，热区会被放大 1.4 倍"
        );
    }

    /// 穿透极性：球**外**忽略鼠标事件（点击穿透给下层），球内恢复交互。
    /// 反了就是「球外吃点击、球内点不动」——两个现象都很难反推到原因，所以钉死。
    #[test]
    fn orb_ignore_cursor_events_polarity() {
        assert!(
            orb_ignore_cursor_events(false),
            "球外必须忽略鼠标事件（穿透），否则留白又会吞掉落在下面的点击"
        );
        assert!(
            !orb_ignore_cursor_events(true),
            "球内必须恢复交互，否则悬浮球本身就点不动了"
        );
    }

    /// 源码级哨兵：`OrbZone` 分支必须**自己**调用 `set_ignore_cursor_events`。
    /// 曾经走过「后端 emit → 前端 JS → 再 invoke 回来」的绕路，比直连多一个 IPC 往返
    /// （鼠标移进球体到恢复交互之间的延迟，快点击会整下漏掉），还多一个 capability
    /// 依赖。谁能改回去，这条测试就红。
    #[test]
    fn orb_zone_arm_toggles_cursor_events_directly() {
        let source = include_str!("mouse.rs");
        let after = source
            .split("HookEvent::OrbZone { inside } =>")
            .nth(1)
            .expect("OrbZone 分支不见了：发送端与消费端必须成对存在");
        // 取到下一个 match 分支为止
        let arm = match after.find("HookEvent::QuickInputMove") {
            Some(end) => &after[..end],
            None => after,
        };
        assert!(
            arm.contains("set_ignore_cursor_events(orb_ignore_cursor_events(inside))"),
            "OrbZone 分支必须直接调用 set_ignore_cursor_events（不要绕前端）"
        );
        assert!(
            !arm.contains("orb-hit-zone"),
            "不要退回「emit 给前端、由前端切穿透」：多一个 IPC 往返与一个 capability 依赖"
        );
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

    /// 契约：选区检测（四级降级链：UIA → Win32 → 模拟 Ctrl+C → 截屏 OCR，最坏秒级）
    /// **不得**跑在钩子事件的单消费线程上。
    ///
    /// 就地跑会把滚轮转发、鼠标抬起、悬浮球穿透上报全堵在同一个队列里 ——
    /// 而「拖拽 > 2px 且不在自有窗口上」就触发，桌面拖拽 / 拖窗口标题栏 / 框选文件全都命中。
    /// 症状是「点击丢失 / 穿透迟钝 / 时好时坏」，且只在目标应用变慢时才显形，极难归因。
    #[test]
    fn selection_check_never_runs_on_the_hook_event_consumer_thread() {
        let source = include_str!("mouse.rs");
        // 拼出标识符，避免本用例自己的字面量被算进下面的出现次数
        let needle = concat!("get_current", "_selection");
        let hook_body = fn_body(source, "start_hook").expect("start_hook 不见了");
        let hook_code = strip_line_comments(hook_body);
        assert!(
            !hook_code.contains(needle),
            "选区检测又被搬回钩子事件的消费线程了：它最坏要跑秒级（含截屏 OCR），\
             会把滚轮/抬起/穿透上报全堵住。请走 `spawn_selection_check`。"
        );
        assert!(
            hook_code.contains("spawn_selection_check("),
            "start_hook 应当通过 `spawn_selection_check` 派发选区检测（异步、带在飞互斥）"
        );

        // 本体必须存在，且只在派发线程里被调用一次 —— 否则上面那条断言可以靠"干脆不检测"骗过
        let worker_body =
            fn_body(source, "check_selection_and_show_toolbar").expect("选区检测本体不见了");
        assert!(
            strip_line_comments(worker_body).contains(needle),
            "check_selection_and_show_toolbar 没有真的做选区检测"
        );
        assert_eq!(
            source.matches(needle).count(),
            1,
            "选区检测只应有一个调用点（在派发线程内）"
        );
    }

    /// 契约：在飞占有必须由 `Drop` 复位。
    ///
    /// 检测线程里跑的是跨进程 UIA / 剪贴板 / OCR，panic 后不会再执行到函数末尾；
    /// 手写复位会让占有永久为真 ⇒ 拖拽弹工具栏从此静默失效，只能重启，
    /// 而 release 是 GUI 子系统，panic 连日志都没有。
    #[test]
    fn selection_check_flag_is_released_by_a_drop_guard() {
        let source = include_str!("mouse.rs");
        let dispatch =
            fn_body(source, "spawn_selection_check").expect("spawn_selection_check 不见了");
        let code = strip_line_comments(dispatch);
        assert!(
            code.contains("SelectionCheckGuard"),
            "spawn_selection_check 应当用 SelectionCheckGuard 管理在飞占有"
        );
        // 守卫必须在 spawn **之前**构造：thread::spawn 自身失败会 panic，
        // 守卫若在线程内部才构造，占有就永远卡住了。
        let guard_at = code.find("SelectionCheckGuard(").expect("守卫构造不见了");
        let spawn_at = code.find(".spawn(").expect("派发线程不见了");
        assert!(
            guard_at < spawn_at,
            "守卫必须在 .spawn( 之前构造，否则 spawn 失败时占有永久卡死"
        );
        let guard_impl = source
            .find("impl Drop for SelectionCheckGuard")
            .expect("SelectionCheckGuard 的 Drop 实现不见了：占有必须靠 Drop 复位");
        let inflight = source
            .find("struct SelectionCheckGuard")
            .expect("SelectionCheckGuard 定义不见了");
        assert!(inflight < guard_impl, "Drop 实现应在结构体定义之后");
    }

    /// 契约：拖选矩形必须由**检测线程自己**写。
    ///
    /// `ocr_selection` 的拖选矩形是全局值，而 OCR 那一级要到检测线程里才读它。
    /// 若改由消费线程在派发前写，第二次拖拽会在第一次检测跑到 OCR 之前把它覆盖掉
    /// ⇒ 拿别人的区域去 OCR（工具栏内容与选区对不上）。随请求传参 + 检测线程内写才安全。
    #[test]
    fn drag_rect_is_written_by_the_check_thread_not_the_consumer() {
        let source = include_str!("mouse.rs");
        // 拼出标识符，避免本用例自己的字面量干扰
        let token = concat!("set_last_drag", "_rect");
        let hook_code =
            strip_line_comments(fn_body(source, "start_hook").expect("start_hook 不见了"));
        assert!(
            !hook_code.contains(token),
            "拖选矩形又被消费线程抢先写了：OCR 那一级在检测线程里才读它，\
             第二次拖拽会覆盖第一次的矩形（拿别人的区域去 OCR）。请随请求传参。"
        );
        let runner = strip_line_comments(
            fn_body(source, "run_selection_check").expect("run_selection_check 不见了"),
        );
        assert!(
            runner.contains(token),
            "run_selection_check 应当把本次拖选矩形写进去"
        );
    }

    /// 契约：检出结果一旦被用户的**新操作**顶掉，就不许再弹工具栏。
    ///
    /// 链是异步的（最坏秒级），期间用户可能已经点向别处。旧实现同步跑在消费线程上，
    /// 那次按下会排在队列里、等工具栏显示之后才处理，「点外部即关闭」顺手生效；
    /// 异步之后必须先比对交互序号，否则表现为「点了外面它还在」。
    #[test]
    fn stale_selection_result_is_dropped_before_showing_the_toolbar() {
        let source = include_str!("mouse.rs");
        let body = strip_line_comments(
            fn_body(source, "check_selection_and_show_toolbar").expect("选区检测本体不见了"),
        );
        let guard_at = body
            .find("interaction_seq")
            .expect("检测本体没有比对交互序号：过期结果会照样弹工具栏");
        let show_at = body.find(".show()").expect("检测本体应当会显示工具栏");
        assert!(
            guard_at < show_at,
            "序号比对必须在显示工具栏**之前**，否则过期结果仍会弹出来"
        );
        // 序号必须来自本次请求（形参）：现读全局永远等于自己，等于没判。
        let sig_start = source
            .find("fn check_selection_and_show_toolbar")
            .expect("检测本体不见了");
        let sig_end = source[sig_start..].find('{').expect("函数签名不见了") + sig_start;
        assert!(
            source[sig_start..sig_end].contains("interaction_seq: u64"),
            "interaction_seq 必须随请求冻结构成形参，不能现读全局"
        );
    }

    /// 派发/收尾的**状态机**：两次决策各是一步，且交接不留缝。
    ///
    /// 「判空」与「释放占有」必须同在一次调用里（见 `take_next_or_release`）：拆开就又回到
    /// 上面那个交错 —— 收尾刚判完空、派发侧才落盘，那份请求从此没人认领。
    #[test]
    fn the_selection_queue_hands_the_baton_without_stranding() {
        let mut queue = SelectionCheckQueue {
            owner: None,
            pending: None,
        };

        // 空闲时认领：自己起链，pending 不被写
        assert!(queue.claim_or_park(1, request(1)), "空闲时应当认领");
        assert_eq!(queue.owner, Some(1));
        assert!(queue.pending.is_none());

        // 在飞期间：挂起，且**只保留最新一次**（旧的被顶掉是设计，结果由序号兜住）
        assert!(
            !queue.claim_or_park(2, request(2)),
            "在飞期间不该再起一条链"
        );
        assert!(
            !queue.claim_or_park(3, request(3)),
            "在飞期间不该再起一条链"
        );
        assert_eq!(queue.pending, Some(request(3)), "只保留最新一次");

        // 收尾取走它继续跑，且**不释放占有**（还有活要干）
        assert_eq!(queue.take_next_or_release(), Some(request(3)));
        assert_eq!(queue.owner, Some(1), "还有活要干，占有没有释放");

        // ★ 取空 = 没活了：**同一次调用里**连占有一起释放 —— 派发侧要等到这一刻才可能
        //   起新链。若把释放挪到别处，就留出「判完之后还有人落盘」的窗口。
        assert_eq!(queue.take_next_or_release(), None);
        assert_eq!(
            queue.owner, None,
            "判空必须连占有一起释放，否则派发侧永远起不来新链（拖拽从此不弹工具栏）"
        );
        assert!(queue.claim_or_park(4, request(4)), "释放后应当能再认领");
    }

    /// 守卫析构只在**仍持有**时复位占有。
    ///
    /// 无条件复位会把后来者的占有抹掉 —— 那正是「两条链并发」的入口，
    /// 而链里会模拟 Ctrl+C 读回滚剪贴板，两条并发会互相踩。
    #[test]
    fn a_stale_guard_never_releases_someone_elses_claim() {
        let mut queue = SelectionCheckQueue {
            owner: Some(7),
            pending: None,
        };
        // 上一轮的守卫迟到析构
        queue.release(6);
        assert_eq!(queue.owner, Some(7), "迟到的守卫不许抹掉后来者的占有");
        queue.release(7);
        assert_eq!(queue.owner, None, "持有它的那一轮才该复位");
    }

    /// 契约：挂起请求必须能被认领，不许卡死。
    ///
    /// ★ 结构性约束：**在飞占有与挂起请求必须是同一把锁**。
    ///
    /// 曾经是两把锁（一个原子标志位 + 一个 `pending` 互斥量）：派发侧「先抢标志位、抢不到
    /// 才写 pending」，收尾侧「先 take 到 None、再释放标志位」。两组操作的顺序**交叉**，
    /// 于是存在这个交错 ——
    /// ```text
    /// C: take() → None          ← 判定「没活了」，准备退出
    /// P: CAS 失败（标志位此刻仍为 true）
    /// P: *pending = Some(req)   ← 挂起请求落盘，指望 C 来取
    /// C: 守卫析构 → 标志位 = false
    /// ```
    /// 之后标志位为 false、pending 里躺着没人认领的请求，而它**不会自愈**：派发侧只在
    /// 争抢失败时才写 pending，下一次拖拽会 CAS 成功、自己起线程 ⇒ 用户看到「拖一次没反应」。
    ///
    /// 曾经用第三个标志位 `RETIRE_COMPLETED` 打补丁，但它有两个洞：其一，收尾「判空」与
    /// 释放标志位仍分属两把锁，窗口只是被收窄；其二，接手分支没有真正抢回在飞标志位，
    /// 走进它之后**整条新链都在无人占有的状态下跑**，后续任意一次拖拽都能再起一条链 ——
    /// 与「检测不并发」直接冲突（链里会模拟 Ctrl+C 读回滚剪贴板，两条并发互相踩）。
    ///
    /// 所以这里钉两件行为用例覆盖不到的事：**决策各只有一处**、**锁不许被带到检测链上去**。
    #[test]
    fn queued_selection_check_is_never_stranded() {
        let source = include_str!("mouse.rs");
        let production =
            strip_line_comments(source.split("#[cfg(test)]").next().expect("应有生产代码段"));
        let dispatch = fn_body(&production, "spawn_selection_check").expect("派发函数不见了");

        // 「释放占有」只允许两处：判空时的释放、守卫按编号复位。多一处就可能把
        // 后来者的占有抹掉（= 两条链并发）。
        assert_eq!(
            production.matches("owner = None").count(),
            2,
            "释放占有的路径只该有两条（take_next_or_release 判空释放、release 按编号复位）：\
             多出来的那条很可能无条件清掉别人的占有"
        );

        // 收尾循环里 `selection_queue()` 只能当临时量用（用完即放）。绑成变量再跑检测，
        // 锁就会被占住整条链（秒级），而派发侧跑在钩子事件的消费线程上 —— 那正是这个模块
        // 一直在躲的"消费线程被堵住"。
        let spawn_at = dispatch.find(".spawn(").expect("派发线程不见了");
        let retire = strip_whitespace(&dispatch[spawn_at..]);
        assert!(
            !retire.contains("letmutqueue") && !retire.contains("letqueue"),
            "收尾循环不许把 `selection_queue()` 绑成变量：锁会一直持有到检测链跑完\
             （可能秒级），派发侧全堵在钩子事件的消费线程上"
        );

        // 老的两把锁方案不许回来
        assert!(
            !production.contains("RETIRE_COMPLETED")
                && !production.contains("PENDING_SELECTION_CHECK")
                && !production.contains("selection_check_inflight"),
            "派发状态只能有一把锁（SELECTION_QUEUE）与一个占有编号：两把锁就必然留下\
             「判空之后还有人落盘」的交错，三个标志位互相握手也补不掉。"
        );
    }

    /// 造一条检测请求（只用到序号，几何值无关紧要）。
    fn request(interaction_seq: u64) -> SelectionCheckRequest {
        SelectionCheckRequest {
            drag: (0, 0, 0, 0),
            interaction_seq,
        }
    }

    /// 去掉所有空白（含换行/缩进）：契约断言往往要跨行比对一小段代码，
    /// 直接被换行与缩进隔断会让守卫失准。
    fn strip_whitespace(code: &str) -> String {
        code.chars().filter(|ch| !ch.is_whitespace()).collect()
    }

    /// 取出 `fn <name>` 的函数体（按大括号配平），供上面的源码级契约测试使用。
    fn fn_body<'a>(source: &'a str, name: &str) -> Option<&'a str> {
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

    /// 剥掉整行注释：把守卫钉的调用**注释掉**（而不是删掉）在文本层面看起来「还在」，
    /// 不剥的话源码级守卫形同虚设。
    fn strip_line_comments(code: &str) -> String {
        code.lines()
            .map(|line| match line.find("//") {
                Some(index) => &line[..index],
                None => line,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 下面几个用例都直接读写全局 `STATE`，而 `mouse_down_valid` 是它们共用的字段：
    /// 不加锁并行跑时，一个用例刚清完标志、另一个用例又把它设回 true，断言就随机报红。
    static PICK_STATE_LOCK: Mutex<()> = Mutex::new(());

    fn lock_pick_state() -> std::sync::MutexGuard<'static, ()> {
        PICK_STATE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn stopping_color_pick_clears_global_interception_state() {
        let _guard = lock_pick_state();
        // Keep the stored cursor null so this test never changes the system
        // cursor scheme; it only verifies the state that controls interception.
        STATE.color_picker_active.store(true, Ordering::SeqCst);
        STATE.mouse_down_valid.store(true, Ordering::SeqCst);
        STATE.system_cursor_backup.store(0, Ordering::SeqCst);

        stop_color_pick();

        assert!(!STATE.color_picker_active.load(Ordering::SeqCst));
        assert!(!STATE.mouse_down_valid.load(Ordering::SeqCst));
    }

    #[test]
    fn stopping_window_pin_clears_global_interception_state() {
        let _guard = lock_pick_state();
        // 同取色：备份留 0，避免真的去改系统光标方案。
        STATE.window_pin_active.store(true, Ordering::SeqCst);
        STATE.mouse_down_valid.store(true, Ordering::SeqCst);
        STATE.system_cursor_backup.store(0, Ordering::SeqCst);

        stop_window_pin();

        assert!(!is_window_pin_active());
        assert!(!STATE.mouse_down_valid.load(Ordering::SeqCst));
    }

    #[test]
    fn stopping_window_pin_that_was_never_on_is_a_no_op() {
        let _guard = lock_pick_state();
        // 外部清理路径（切工具、关面板、退出）会无条件调用两个 stop。模式没开时
        // 必须原地返回，否则「停止置顶」会顺手恢复掉取色正用着的那只光标。
        STATE.window_pin_active.store(false, Ordering::SeqCst);
        STATE.system_cursor_backup.store(0, Ordering::SeqCst);

        stop_window_pin();

        assert!(!is_window_pin_active());
        assert_eq!(STATE.system_cursor_backup.load(Ordering::SeqCst), 0);
    }
    // ─── 取色笔光标（画笔造型）几何守卫 ──────────────────────────
    //
    // 这枚光标是纯几何常量画出来的，出问题不会报错、只会「看着不对 / 被裁掉」，
    // 所以把「热点位置」「不越出画布」「朝向」「面积量级」都钉住。

    fn eye_opaque(px: &[u32; EYEDROPPER_SIZE * EYEDROPPER_SIZE], x: usize, y: usize) -> bool {
        px[y * EYEDROPPER_SIZE + x] >> 24 == 0xFF
    }

    /// 把 1024 个像素的 `0xAARRGGBB` 按行优先顺序做 FNV-1a（64 位，逐字节小端）。
    fn eye_hash(pixels: &[u32; EYEDROPPER_SIZE * EYEDROPPER_SIZE]) -> u64 {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for value in pixels {
            for byte in value.to_le_bytes() {
                hash ^= byte as u64;
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
        hash
    }

    #[test]
    fn eyedropper_hotspot_lands_on_the_brush_tip() {
        let px = eyedropper_pixels();
        let (hx, hy) = (EYEDROPPER_HOTSPOT.0 as usize, EYEDROPPER_HOTSPOT.1 as usize);
        assert!(
            eye_opaque(&px, hx, hy),
            "热点像素必须不透明（否则笔尖点不到）"
        );
        // 热点像素的中心要落回笔尖常量附近
        let (cx, cy) = (hx as f64 + 0.5, hy as f64 + 0.5);
        let d = ((cx - EYEDROPPER_TIP.0).powi(2) + (cy - EYEDROPPER_TIP.1).powi(2)).sqrt();
        assert!(d <= 0.6, "热点应贴住笔尖，实际偏 {d:.2}px");
    }

    #[test]
    fn eyedropper_never_touches_the_canvas_edge() {
        // 32×32 光标没有「溢出可见」这回事：贴到最外圈就是被裁掉。
        let px = eyedropper_pixels();
        for i in 0..EYEDROPPER_SIZE {
            for (x, y) in [
                (i, 0),
                (i, EYEDROPPER_SIZE - 1),
                (0, i),
                (EYEDROPPER_SIZE - 1, i),
            ] {
                assert!(!eye_opaque(&px, x, y), "({x},{y}) 贴到画布边缘，会被裁切");
            }
        }
    }

    // ─── 置顶准星光标几何守卫 ────────────────────────────────────

    #[test]
    fn target_hotspot_lands_on_the_reticle_centre() {
        let px = target_pixels();
        let (hx, hy) = (TARGET_HOTSPOT.0 as usize, TARGET_HOTSPOT.1 as usize);
        assert!(
            eye_opaque(&px, hx, hy),
            "热点像素必须不透明（否则准星中心戳不到东西）"
        );
        // 热点像素的中心必须与绘制用的中心常量重合：两者一旦漂移，用户照着圆圈去点，
        // 实际选中的是旁边那扇窗口。
        assert_eq!((hx as f64 + 0.5, hy as f64 + 0.5), TARGET_CENTER);
    }

    #[test]
    fn target_never_touches_the_canvas_edge() {
        // 32×32 光标没有「溢出可见」这回事：贴到最外圈就是被裁掉，准星会缺一角。
        let px = target_pixels();
        for i in 0..EYEDROPPER_SIZE {
            for (x, y) in [
                (i, 0),
                (i, EYEDROPPER_SIZE - 1),
                (0, i),
                (EYEDROPPER_SIZE - 1, i),
            ] {
                assert!(!eye_opaque(&px, x, y), "({x},{y}) 贴到画布边缘，会被裁切");
            }
        }
    }

    #[test]
    fn target_is_mirrored_around_its_hotspot() {
        // 准星的全部价值在于「图形中心 = 热点」。镜像对称是这条性质最直接的守卫：
        // 画歪一点，用户就按着圆圈的中心去点，而热点已经偏到旁边去了。
        let px = target_pixels();
        let c = TARGET_HOTSPOT.0 as usize;
        for y in 0..EYEDROPPER_SIZE {
            for d in 1..=c {
                assert_eq!(
                    px[y * EYEDROPPER_SIZE + (c - d)],
                    px[y * EYEDROPPER_SIZE + (c + d)],
                    "第 {y} 行距中心 {d}px 处左右不对称"
                );
            }
        }
        for x in 0..EYEDROPPER_SIZE {
            for d in 1..=c {
                assert_eq!(
                    px[(c - d) * EYEDROPPER_SIZE + x],
                    px[(c + d) * EYEDROPPER_SIZE + x],
                    "第 {x} 列距中心 {d}px 处上下不对称"
                );
            }
        }
    }

    #[test]
    fn target_reticle_fingerprint_is_stable() {
        // 逐行不透明像素数。改任何几何常量都会让这里报红 —— 确认新造型无误后同步
        // 这 32 个数。它同时钉住上下镜像：行 1↔29、2↔28 … 必须成对相等
        //（中心在 15.5，配对按 (1,29)(2,28)…(14,16)，不是按画布中线）。
        const ROW_COUNTS: [usize; EYEDROPPER_SIZE] = [
            0, 0, 3, 5, 5, 7, 7, 7, 7, 7, 7, 7, 21, 25, 27, 27, 27, 25, 21, 7, 7, 7, 7, 7, 7, 7, 5,
            5, 3, 0, 0, 0,
        ];
        let px = target_pixels();
        let counts: Vec<usize> = (0..EYEDROPPER_SIZE)
            .map(|y| {
                (0..EYEDROPPER_SIZE)
                    .filter(|x| eye_opaque(&px, *x, y))
                    .count()
            })
            .collect();
        assert_eq!(counts, ROW_COUNTS.to_vec(), "准星光标逐行像素数变了");
    }

    #[test]
    fn target_colour_fingerprint_is_stable() {
        // 颜色指纹。**逐行像素数只能证明形状** —— 把红蓝通道写反（32bpp DIB 是 BGRA）
        // 它对不上是看不出来的，所以颜色单独钉一个哈希。
        // 动调色板 / 几何 → 这里报红，确认新配色无误后更新这一个数即可。
        assert_eq!(eye_hash(&target_pixels()), 14165338476397599290);
    }

    #[test]
    fn eyedropper_silhouette_points_up_right() {
        // 画笔斜置：笔尖在左下、笔杆伸向右上 ⇒ 上半部分的水平重心必须明显右于下半部分。
        let px = eyedropper_pixels();
        let mut lower = (0.0f64, 0usize);
        let mut upper = (0.0f64, 0usize);
        for y in 0..EYEDROPPER_SIZE {
            for x in 0..EYEDROPPER_SIZE {
                if !eye_opaque(&px, x, y) {
                    continue;
                }
                if y >= EYEDROPPER_SIZE / 2 {
                    lower.0 += x as f64;
                    lower.1 += 1;
                } else {
                    upper.0 += x as f64;
                    upper.1 += 1;
                }
            }
        }
        assert!(lower.1 > 0 && upper.1 > 0, "上下两半都应有笔身");
        let (lx, ux) = (lower.0 / lower.1 as f64, upper.0 / upper.1 as f64);
        assert!(
            ux > lx + 6.0,
            "笔杆应朝右上：下半重心 x={lx:.1}，上半 x={ux:.1}"
        );
    }

    #[test]
    fn eyedropper_pixel_fingerprint_is_stable() {
        // 逐行不透明像素数。这组数是从原型 `render2.py::draw_brush` 的真实渲染里
        // **逐像素核对**出来的（214 个不透明像素，32 行全等）。
        // 它同时覆盖「空图」与「满图」两种崩法：渲染整个丢了 → 全 0；退化多边形把画布
        // 填满 → 全是 32。改任何几何常量都会让这里报红 —— 确认新造型无误后同步这 32 个数。
        const ROW_COUNTS: [usize; EYEDROPPER_SIZE] = [
            0, 0, 0, 0, 0, 0, 0, 0, 5, 7, 8, 9, 10, 11, 11, 11, 11, 11, 10, 11, 13, 13, 12, 10, 11,
            11, 9, 9, 8, 3, 0, 0,
        ];
        let px = eyedropper_pixels();
        let counts: Vec<usize> = (0..EYEDROPPER_SIZE)
            .map(|y| {
                (0..EYEDROPPER_SIZE)
                    .filter(|x| eye_opaque(&px, *x, y))
                    .count()
            })
            .collect();
        assert_eq!(counts, ROW_COUNTS.to_vec(), "画笔光标逐行像素数变了");
    }

    #[test]
    fn eyedropper_colour_fingerprint_is_stable() {
        // 颜色的指纹。**逐行像素数只能证明形状** —— 把红蓝通道写反（32bpp DIB 是 BGRA，
        // 降采样时很容易顺手写错）它对不上是看不出来的，所以颜色必须单独钉一个哈希。
        // 该值取自与原型逐像素比对过的那一版输出（1024/1024 像素、形状与配色全等）。
        // 动调色板 / 几何 → 这里报红，确认新配色无误后更新这一个数即可。
        assert_eq!(
            eye_hash(&eyedropper_pixels()),
            0xF4CF_9C01_B33D_1765,
            "画笔光标的颜色指纹变了（注意 R/B 是否写反）"
        );
    }

    #[test]
    fn canvas_quad_skips_degenerate_polygons() {
        // 退化四边形必须画空。若不挡，四条边的叉积全为 0 ⇒ 凸性判定认为每个点都在内部
        // ⇒ **把整块画布填满**（光标会变成 32×32 实心方块，且不报任何错）。
        let mut canvas = vec![0u32; EYEDROPPER_HI * EYEDROPPER_HI];
        canvas_quad(&mut canvas, [(8.0, 8.0); 4], 0xFFFF_FFFF);
        assert!(canvas.iter().all(|v| *v == 0), "四点重合不得填充任何像素");
        canvas_quad(
            &mut canvas,
            [(8.0, 8.0), (24.0, 8.0), (24.0, 8.0), (8.0, 8.0)],
            0xFFFF_FFFF,
        );
        assert!(
            canvas.iter().all(|v| *v == 0),
            "零面积四边形不得填充任何像素"
        );
        // 正常四边形仍然要画
        canvas_quad(
            &mut canvas,
            [(8.0, 8.0), (24.0, 8.0), (24.0, 24.0), (8.0, 24.0)],
            0xFFFF_FFFF,
        );
        let n = canvas.iter().filter(|v| **v != 0).count();
        assert!(n > 2000, "正常四边形应被填充，实际只填了 {n} 个 4× 采样点");
    }

    #[test]
    fn canvas_rbox_degenerate_radius_draws_the_whole_capsule() {
        // 半径顶到半宽（= 标准胶囊）时内缩四边形退化成两个重合点，
        // `canvas_quad` 对退化多边形一个像素都不填 ⇒ 必须回退成 stroke。
        // 不回退的后果：画笔笔杆只剩两个端头小圆、中间整段消失（本轮踩到的真 bug）。
        let mut canvas = vec![0u32; EYEDROPPER_HI * EYEDROPPER_HI];
        let (ax, ay, bx, by) = (8.0, 24.0, 24.0, 8.0);
        canvas_rbox(&mut canvas, ax, ay, bx, by, 1.6, 0.8, 0xFFFF_FFFF, 0.0);
        let filled = |x: f64, y: f64| {
            let sx = (x * EYEDROPPER_SCALE as f64) as usize;
            let sy = (y * EYEDROPPER_SCALE as f64) as usize;
            canvas[sy * EYEDROPPER_HI + sx] != 0
        };
        assert!(
            filled((ax + bx) / 2.0, (ay + by) / 2.0),
            "胶囊中点必须被填充"
        );
        assert!(filled(ax + 0.5, ay - 0.5), "靠起端处也必须被填充");
        let n = canvas.iter().filter(|v| **v != 0).count();
        assert!(
            n > 400,
            "胶囊面积过小（{n} 个 4× 采样点），中间那段可能被丢了"
        );
    }
    /// 画布原语的一次调用（供下面的边界用例表使用）。
    type Draw = fn(&mut Vec<u32>);

    #[test]
    fn canvas_primitives_stay_small_on_degenerate_input() {
        // 退化输入下原语只能「少画」或「什么都不画」，绝不能整块填满 —— 填满就是一枚
        // 32×32 的实心方块光标，而且不报任何错。这里把几个入口过一遍。
        let total = EYEDROPPER_HI * EYEDROPPER_HI;
        let cases: [(&str, Draw); 5] = [
            ("rbox 轴比半径短", |c| {
                canvas_rbox(c, 8.0, 24.0, 9.0, 23.0, 4.0, 3.0, 0xFFFF_FFFF, 0.0)
            }),
            ("rbox 零长度轴", |c| {
                canvas_rbox(c, 8.0, 8.0, 8.0, 8.0, 4.0, 2.0, 0xFFFF_FFFF, 0.0)
            }),
            ("taper 零长度轴", |c| {
                canvas_taper(c, 8.0, 8.0, 8.0, 8.0, 4.0, 6.0, 0xFFFF_FFFF)
            }),
            ("taper 两边宽为 0", |c| {
                canvas_taper(c, 4.0, 4.0, 28.0, 28.0, 0.0, 0.0, 0xFFFF_FFFF)
            }),
            ("quad 四点重合", |c| {
                canvas_quad(c, [(8.0, 8.0); 4], 0xFFFF_FFFF)
            }),
        ];
        for (name, draw) in cases {
            let mut canvas = vec![0u32; total];
            draw(&mut canvas);
            let filled = canvas.iter().filter(|v| **v != 0).count();
            assert!(
                filled < total,
                "{name}：退化输入把整块 4× 画布填满了（会变成实心方块光标）"
            );
        }
    }
}
