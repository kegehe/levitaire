//! 滚动导航：控制「上一次用户点击过的外部窗口」的滚动位置。
//!
//! ## 三条通道（按可靠性降级）
//!
//! 1. **UIA `ScrollPattern`** —— 唯一能读/写精确百分比的路。实测只对**经典 Win32
//!    滚动控件**成立（记事本 FOUND@d3 且 `SetScrollPercent` 生效）。
//! 2. **投递键盘导航键**（`PostMessage` `WM_KEYDOWN/WM_KEYUP`）—— 浏览器、Electron
//!    接受投递过来的键；因为走 PostMessage，不需要抢前台，导航面板不会失焦。
//! 3. **投递滚轮**（`PostMessage` `WM_MOUSEWHEEL`）—— 唯一对浏览器 / Electron /
//!    资源管理器 / 阅读器都通用的通道（实测 Chromium 接受且无需移动光标、无需前台）。
//!    也是「相对微调」的唯一实现方式（投递方向键会在编辑器里移动光标而不是滚动）。
//!
//! 实测数据与反证见 `docs/滚动导航问题分析.md`，脚本与原始输出在
//! `D:\tmp\scroll-nav-audit\`。**不要再拿 UIA 当「这个窗口能不能滚」的判据**：
//! Chromium 不实现 UIA `IScrollProvider`，Electron 只把 `Document` 暴露成
//! `VerticallyScrollable=false`（对该 pattern 调 `SetScrollPercent` 抛
//! `0x80131509`），放宽 `vscroll` 门控并不能救。
//!
//! ## 线程
//!
//! 本模块所有函数都会做跨进程 COM / Win32 调用，**必须从阻塞线程调用**
//! （命令侧统一 `tokio::task::spawn_blocking`）。Tauri 的同步命令跑在事件循环主线程
//! （wry 在 WebView2 `WebMessageReceived` 回调里内联调用，见
//! `wry-0.55.1/src/webview2/mod.rs:890`），在这里做 UIA 会连带冻结所有窗口。

use serde::Serialize;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationScrollPattern,
    UIA_ScrollPatternId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    VIRTUAL_KEY, VK_CONTROL, VK_END, VK_HOME, VK_NEXT, VK_PRIOR,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsWindow,
    PostMessageW, WindowFromPoint, GA_ROOT, WM_KEYDOWN, WM_KEYUP, WM_MOUSEWHEEL,
};

const UIA_NO_SCROLL: f64 = -1.0;
const WHEEL_DELTA: i32 = 120;

/// `WM_KEYUP` 的 lParam：重复次数 1 + 前一状态按下 + 转换位。
const KEYUP_LPARAM: isize = 0xC000_0001u32 as isize;
/// `WM_KEYDOWN` 的 lParam：重复次数 1。
const KEYDOWN_LPARAM: isize = 1;

/// `find_scroll_pattern` 的花费上限。
///
/// 找不到滚动器时必须走满整棵 14 层子树（跨进程 COM）：实测 Electron 类窗口
/// **1513 节点 / ~800ms**，而「大多数窗口根本没有可用的 UIA 滚动器」才是常态。
/// 所以节点数与时间双上限，超了就放弃——剩下的交给滚轮/键盘通道。
const SCAN_NODE_BUDGET: u32 = 600;
const SCAN_TIME_BUDGET: Duration = Duration::from_millis(120);

/// UIA 探测结果的短期缓存：前端每 2s 轮询一次，缓存让「轮询 + 动作后回读」
/// 共用同一次遍历（TTL 只需覆盖这两者相邻的间隔）。
const PROBE_CACHE_TTL: Duration = Duration::from_millis(800);

/// 滚到顶/底时滚轮兜底推的格数。
///
/// 实测（`D:\tmp\scroll-nav-audit\edge_probe.py`，Chromium 约 6 万像素高的页面）：
/// 800 格足以从一端走到另一端并被夹住（连推两次快照完全一致），所以这个值是按
/// 「能真正收敛到边缘」定的，不是拍脑袋。800 次 PostMessage 只有毫秒级开销。
const EDGE_WHEEL_NOTCHES: i32 = 800;
/// 翻页投递按键失败时的滚轮兜底格数。
const PAGE_WHEEL_NOTCHES: i32 = 8;
/// 相对微调一次的滚轮格数。
const LINE_WHEEL_NOTCHES: i32 = 3;

static TARGET_HWND: AtomicIsize = AtomicIsize::new(0);
static LAST_EXTERNAL_TARGET: AtomicIsize = AtomicIsize::new(0);
static PROBE_CACHE: Mutex<Option<ProbeCache>> = Mutex::new(None);

struct ProbeCache {
    hwnd: isize,
    at: Instant,
    /// `Some(percent)` = 该窗口可精确控制；`None` = 没有可用的 UIA 滚动器。
    precise: Option<f64>,
}

fn clamp_percent(percent: f64) -> Result<f64, String> {
    percent
        .is_finite()
        .then_some(percent.clamp(0.0, 100.0))
        .ok_or_else(|| "滚动百分比必须是有效数字".to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollNavigationState {
    /// 目标窗口提供可精确控制的垂直滚动条（百分比与滑杆可用）。
    pub precise: bool,
    pub percent: Option<f64>,
    /// 存在目标窗口：可以做相对滚动（翻页 / 滚轮微调 / 到顶到底）。
    pub fallback_available: bool,
}

impl ScrollNavigationState {
    fn unavailable() -> Self {
        Self {
            precise: false,
            percent: None,
            fallback_available: false,
        }
    }

    fn relative() -> Self {
        Self {
            precise: false,
            percent: None,
            fallback_available: true,
        }
    }

    fn precise(percent: f64) -> Self {
        Self {
            precise: true,
            percent: Some(percent),
            fallback_available: true,
        }
    }
}

/// 能当滚动目标的窗口：存在 + 不属于 Levitaire 自己 + 不是桌面/任务栏。
///
/// 实现在 `commands::is_usable_target`（唯一权威版本，窗口置顶的点选共用同一口径）。
fn is_usable_target(app: &AppHandle, hwnd: HWND) -> bool {
    crate::commands::is_usable_target(app, hwnd)
}

pub fn capture_current_target(app: &AppHandle) {
    // Hiding the palette and restoring focus is asynchronous on Windows. Give
    // the shell a short window to complete that transition before sampling the
    // target, otherwise the palette itself is saved as the scroll destination.
    for _ in 0..12 {
        let foreground = unsafe { GetForegroundWindow() };
        if is_usable_target(app, foreground) {
            TARGET_HWND.store(foreground.0 as isize, Ordering::SeqCst);
            LAST_EXTERNAL_TARGET.store(foreground.0 as isize, Ordering::SeqCst);
            invalidate_probe();
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    // Windows may have already activated the orb by the time this function is
    // called. Reuse the last known external foreground window in that case.
    let previous = LAST_EXTERNAL_TARGET.load(Ordering::SeqCst);
    if previous != 0 {
        let hwnd = HWND(previous as *mut std::ffi::c_void);
        if is_usable_target(app, hwnd) {
            TARGET_HWND.store(previous, Ordering::SeqCst);
            invalidate_probe();
        }
    }
}

/// 记下用户刚刚点中的窗口，作为滚动目标。
///
/// 两个信号，用途不同：
///
/// 1. **落点处最顶层的窗口**（`WindowFromPoint` + `GA_ROOT`）—— 用户真正点中的窗口。
///    它才是新目标。不能用前台窗口代替：低层鼠标钩子在消息投递到目标窗口之前就被调用，
///    此时 `GetForegroundWindow()` 返回的还是**点击前**那个窗口，用它当目标会同时导致
///    两种错配——点进新程序切不过去，以及在导航面板上点按钮时把碰巧在前台的程序误记成目标。
/// 2. **点击前的前台窗口**（`foreground`，钩子内采样）—— 只用于「点在自己身上」的场景：
///    用户点悬浮球时落点在球上（不该改变目标），但他点球之前正在用的那个程序才是最可能
///    想滚的对象，记成「候选目标」（`LAST_EXTERNAL_TARGET`，仅在目标丢失时启用）。
pub fn remember_click_target(app: &AppHandle, x: i32, y: i32, foreground: isize) {
    let hit = unsafe { WindowFromPoint(POINT { x, y }) };
    if !hit.is_invalid() {
        let root = unsafe { GetAncestor(hit, GA_ROOT) };
        let root = if root.is_invalid() { hit } else { root };
        if is_usable_target(app, root) {
            LAST_EXTERNAL_TARGET.store(root.0 as isize, Ordering::SeqCst);
            TARGET_HWND.store(root.0 as isize, Ordering::SeqCst);
            invalidate_probe();
            return;
        }
    }

    // 落点在自己身上（悬浮球 / 面板按钮）或桌面/任务栏：不更换目标，只把「点击前的
    // 前台窗口」记为候选 —— 用户点悬浮球之前正在用的那个程序才是最可能想滚的对象。
    if foreground == 0 {
        return;
    }
    let previous = HWND(foreground as *mut std::ffi::c_void);
    if !is_usable_target(app, previous) {
        return;
    }
    LAST_EXTERNAL_TARGET.store(foreground, Ordering::SeqCst);
}

fn target_window() -> Option<HWND> {
    // 这里拿不到 AppHandle，所以只做与 app 无关的校验（存在 + 不是桌面/任务栏）。
    let usable = |hwnd: HWND| {
        !hwnd.is_invalid()
            && unsafe { IsWindow(Some(hwnd)).as_bool() }
            && !crate::commands::is_shell_window(hwnd)
    };

    let saved = HWND(TARGET_HWND.load(Ordering::SeqCst) as *mut std::ffi::c_void);
    if usable(saved) {
        return Some(saved);
    }
    // 目标窗口被关掉后不要永久失效：回退到最近一次真实点击过的外部窗口。用户只要在
    // 目标程序里点一下（钩子按落点写入）就能恢复，不必关掉面板重开。
    let previous = LAST_EXTERNAL_TARGET.load(Ordering::SeqCst);
    if previous != 0 {
        let hwnd = HWND(previous as *mut std::ffi::c_void);
        if usable(hwnd) {
            TARGET_HWND.store(previous, Ordering::SeqCst);
            return Some(hwnd);
        }
    }
    None
}

fn invalidate_probe() {
    if let Ok(mut guard) = PROBE_CACHE.lock() {
        *guard = None;
    }
}

struct ScanBudget {
    nodes: u32,
    deadline: Instant,
}

impl ScanBudget {
    fn new() -> Self {
        Self {
            nodes: 0,
            deadline: Instant::now() + SCAN_TIME_BUDGET,
        }
    }

    fn exhausted(&self) -> bool {
        self.nodes >= SCAN_NODE_BUDGET || Instant::now() >= self.deadline
    }

    fn visit(&mut self) -> bool {
        self.nodes += 1;
        !self.exhausted()
    }
}

unsafe fn find_scroll_pattern(
    automation: &IUIAutomation,
    element: &IUIAutomationElement,
    depth: u8,
    budget: &mut ScanBudget,
) -> Option<IUIAutomationScrollPattern> {
    if budget.exhausted() {
        return None;
    }
    if let Ok(pattern) =
        element.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
    {
        if pattern
            .CurrentVerticallyScrollable()
            .map(|value| value.as_bool())
            .unwrap_or(false)
        {
            return Some(pattern);
        }
    }
    if depth == 0 {
        return None;
    }
    let walker = automation.ControlViewWalker().ok()?;
    let mut child = walker.GetFirstChildElement(element).ok()?;
    loop {
        if !budget.visit() {
            return None;
        }
        if let Some(found) = find_scroll_pattern(automation, &child, depth - 1, budget) {
            return Some(found);
        }
        match walker.GetNextSiblingElement(&child) {
            Ok(next) => child = next,
            Err(_) => break,
        }
    }
    None
}

fn with_scroll_pattern<T>(
    target: HWND,
    operation: impl FnOnce(IUIAutomationScrollPattern) -> Result<T, String>,
) -> Result<T, String> {
    unsafe {
        // UIA **客户端**要用 MTA：跨进程调用时提供方可能回调客户端线程，而阻塞线程池
        // 上没有消息泵，STA 会死锁（Microsoft 对 UIA 客户端的建议就是 MTA）。
        // 这里所有 COM 对象都在同一个闭包内创建与释放，不会跨线程传递。
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let result = (|| {
            let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX(0x1))
                .map_err(|error| format!("无法初始化 Windows 自动化服务: {error}"))?;
            let root = automation
                .ElementFromHandle(target)
                .map_err(|error| format!("无法读取目标窗口: {error}"))?;
            let mut budget = ScanBudget::new();
            let pattern = find_scroll_pattern(&automation, &root, 14, &mut budget)
                .ok_or_else(|| "目标窗口未提供可精确控制的垂直滚动条".to_string())?;
            operation(pattern)
        })();
        if initialized {
            CoUninitialize();
        }
        result
    }
}

/// 探测目标窗口能否精确控制滚动；`None` = 没有可用的 UIA 滚动器。
fn probe_precise(target: HWND) -> Option<f64> {
    let mut found = None;
    let probe = with_scroll_pattern(target, |pattern| unsafe {
        let percent = pattern
            .CurrentVerticalScrollPercent()
            .map_err(|error| format!("无法读取滚动位置: {error}"))?;
        if percent.is_finite() && percent >= 0.0 && percent != UIA_NO_SCROLL {
            found = Some(percent.clamp(0.0, 100.0));
        }
        Ok(())
    });
    if probe.is_err() {
        return None;
    }
    found
}

fn store_probe(target: HWND, precise: Option<f64>) {
    if let Ok(mut guard) = PROBE_CACHE.lock() {
        *guard = Some(ProbeCache {
            hwnd: target.0 as isize,
            at: Instant::now(),
            precise,
        });
    }
}

fn cached_probe(target: HWND) -> Option<f64> {
    if let Ok(guard) = PROBE_CACHE.lock() {
        if let Some(entry) = guard.as_ref() {
            if entry.hwnd == target.0 as isize && entry.at.elapsed() < PROBE_CACHE_TTL {
                return entry.precise;
            }
        }
    }
    let precise = probe_precise(target);
    store_probe(target, precise);
    precise
}

/// `WM_MOUSEWHEEL` 的 wParam：高字是带符号的滚轮增量。
fn wheel_wparam(notches: i32) -> WPARAM {
    let delta = notches.saturating_mul(WHEEL_DELTA);
    WPARAM(((delta as u32 & 0xFFFF) << 16) as usize)
}

/// `WM_MOUSEWHEEL` 的 lParam：屏幕坐标。目标程序按这个点决定滚哪个滚动容器，
/// 所以必须给窗口内的一点（取中心）。
fn wheel_lparam(x: i32, y: i32) -> LPARAM {
    LPARAM((((y as u32 & 0xFFFF) << 16) | (x as u32 & 0xFFFF)) as isize)
}

/// 滚轮消息该投给哪个窗口：**落点处的那个窗口**，而不是顶层窗口。
///
/// 系统本来就是按「光标下的窗口」投递 WM_MOUSEWHEEL 的，这里只是复刻它。
/// 实测（`D:\tmp\scroll-nav-audit\explorer_probe.py`）资源管理器（`CabinetWClass`）的
/// 可滚动列表是子窗口 `DirectUIHWND`：投给顶层 HWND **完全不滚动**，投给落点子窗口才生效。
/// 例外见 `pick_wheel_destination`。
unsafe fn wheel_destination(target: HWND, x: i32, y: i32) -> HWND {
    let hit = WindowFromPoint(POINT { x, y });
    if hit.is_invalid() {
        return target;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hit, Some(&mut pid));
    let hit_is_ours = pid == std::process::id();
    let hit_belongs_to_target = !hit_is_ours && { GetAncestor(hit, GA_ROOT) == target };
    pick_wheel_destination(target, hit, hit_is_ours, hit_belongs_to_target)
}

/// 纯逻辑部分（真值来自 `wheel_destination` 的 Win32 查询），便于单测。
fn pick_wheel_destination(
    target: HWND,
    hit: HWND,
    hit_is_ours: bool,
    hit_belongs_to_target: bool,
) -> HWND {
    if hit.is_invalid() || hit == target {
        return target;
    }
    // 落点被我们自己的置顶浮窗盖住时不能用它 —— 否则会把导航面板自己滚走
    if hit_is_ours {
        return target;
    }
    // 只认目标窗口自己的子窗口，免得滚到别的程序上
    if !hit_belongs_to_target {
        return target;
    }
    hit
}

/// 向目标窗口投递滚轮。`notches > 0` 向上（回顶部），`< 0` 向下。
///
/// 走 `PostMessage` 而不是 `SendInput`：实测 Chromium / Electron 接受投递过来的
/// 滚轮消息，坐标取 lParam 里的屏幕点 —— 既不用移动光标，也不要求窗口在前台，
/// 于是导航面板不会因为一次滚动就丢掉焦点。
unsafe fn post_wheel(target: HWND, notches: i32) -> Result<(), String> {
    if notches == 0 {
        return Ok(());
    }
    if !IsWindow(Some(target)).as_bool() {
        return Err("目标窗口已关闭".to_string());
    }
    let mut rect = RECT::default();
    GetWindowRect(target, &mut rect).map_err(|error| format!("无法读取目标窗口位置: {error}"))?;
    let x = rect.left + (rect.right - rect.left) / 2;
    let y = rect.top + (rect.bottom - rect.top) / 2;
    let lparam = wheel_lparam(x, y);
    let wparam = wheel_wparam(if notches > 0 { 1 } else { -1 });
    let destination = wheel_destination(target, x, y);
    for _ in 0..notches.unsigned_abs() {
        PostMessageW(Some(destination), WM_MOUSEWHEEL, wparam, lparam)
            .map_err(|error| format!("无法向目标窗口发送滚动: {error}"))?;
    }
    Ok(())
}

/// 向目标窗口投递键盘导航键（浏览器 / Electron 接受投递过来的键，无需抢前台）。
unsafe fn post_keys(
    target: HWND,
    modifier: Option<VIRTUAL_KEY>,
    key: VIRTUAL_KEY,
) -> Result<(), String> {
    if !IsWindow(Some(target)).as_bool() {
        return Err("目标窗口已关闭".to_string());
    }
    if let Some(modifier) = modifier {
        PostMessageW(
            Some(target),
            WM_KEYDOWN,
            WPARAM(modifier.0 as usize),
            LPARAM(KEYDOWN_LPARAM),
        )
        .map_err(|error| format!("无法向目标窗口发送按键: {error}"))?;
    }
    PostMessageW(
        Some(target),
        WM_KEYDOWN,
        WPARAM(key.0 as usize),
        LPARAM(KEYDOWN_LPARAM),
    )
    .map_err(|error| format!("无法向目标窗口发送按键: {error}"))?;
    PostMessageW(
        Some(target),
        WM_KEYUP,
        WPARAM(key.0 as usize),
        LPARAM(KEYUP_LPARAM),
    )
    .map_err(|error| format!("无法向目标窗口发送按键: {error}"))?;
    if let Some(modifier) = modifier {
        PostMessageW(
            Some(target),
            WM_KEYUP,
            WPARAM(modifier.0 as usize),
            LPARAM(KEYUP_LPARAM),
        )
        .map_err(|error| format!("无法向目标窗口发送按键: {error}"))?;
    }
    Ok(())
}

fn set_percent_on(target: HWND, percent: f64) -> Result<ScrollNavigationState, String> {
    let percent = clamp_percent(percent)?;
    let state = with_scroll_pattern(target, |pattern| unsafe {
        pattern
            .SetScrollPercent(UIA_NO_SCROLL, percent)
            .map_err(|error| format!("无法设置滚动位置: {error}"))?;
        let actual = pattern
            .CurrentVerticalScrollPercent()
            .unwrap_or(percent)
            .clamp(0.0, 100.0);
        Ok(ScrollNavigationState::precise(actual))
    })?;
    store_probe(target, state.percent);
    Ok(state)
}

fn nudge_percent_on(target: HWND, delta: f64) -> Result<ScrollNavigationState, String> {
    let current =
        cached_probe(target).ok_or_else(|| "目标窗口未提供可精确控制的垂直滚动条".to_string())?;
    set_percent_on(target, current + delta)
}

/// 动作计划。把「动作 → 各通道参数」抽成纯函数，是为了让两套**方向相反的约定**
/// 有个可测的汇合点：
///   * UIA 百分比：0 = 顶部，100 = 底部；
///   * 滚轮增量：正 = 向上（朝顶部）。
/// 写反了不会编译失败，只会「点向上翻页结果往下走」。
enum ScrollPlan {
    /// 到顶 / 到底：先试绝对百分比，再按键，最后滚轮长推。
    Edge {
        percent: f64,
        modifier: VIRTUAL_KEY,
        key: VIRTUAL_KEY,
        direction: i32,
    },
    /// 翻页：先试「当前百分比 + delta」，再按键，最后滚轮短推。
    Page {
        delta: f64,
        key: VIRTUAL_KEY,
        direction: i32,
    },
    /// 相对微调：只走滚轮（投递方向键会在编辑器里移动光标而不是滚动）。
    Step { notches: i32 },
}

fn plan_for(action: &str) -> Result<ScrollPlan, String> {
    Ok(match action {
        "top" => ScrollPlan::Edge {
            percent: 0.0,
            modifier: VK_CONTROL,
            key: VK_HOME,
            direction: 1,
        },
        "bottom" => ScrollPlan::Edge {
            percent: 100.0,
            modifier: VK_CONTROL,
            key: VK_END,
            direction: -1,
        },
        "page-up" => ScrollPlan::Page {
            delta: -10.0,
            key: VK_PRIOR,
            direction: 1,
        },
        "page-down" => ScrollPlan::Page {
            delta: 10.0,
            key: VK_NEXT,
            direction: -1,
        },
        "line-up" => ScrollPlan::Step {
            notches: LINE_WHEEL_NOTCHES,
        },
        "line-down" => ScrollPlan::Step {
            notches: -LINE_WHEEL_NOTCHES,
        },
        _ => return Err("未知的滚动操作".to_string()),
    })
}

/// 到顶 / 到底。
///
/// 先试 UIA 精确；不行就投递 `Ctrl+Home` / `Ctrl+End`（浏览器、编辑器即时且精确），
/// 再补一次滚轮长推。两路都是「幂等收敛到边缘」的动作 —— 按键生效时滚轮只是把已经
/// 在边缘的窗口继续往同方向推（被夹住，无副作用），按键被忽略时（资源管理器、
/// 阅读器、Electron 自绘列表）滚轮才是真正起作用的那一路。
fn jump_to_edge(
    target: HWND,
    percent: f64,
    modifier: VIRTUAL_KEY,
    key: VIRTUAL_KEY,
    direction: i32,
) -> Result<ScrollNavigationState, String> {
    if let Ok(state) = set_percent_on(target, percent) {
        return Ok(state);
    }
    let keys = unsafe { post_keys(target, Some(modifier), key) };
    let wheel = unsafe { post_wheel(target, EDGE_WHEEL_NOTCHES * direction) };
    if keys.is_err() && wheel.is_err() {
        return Err("无法控制目标窗口滚动".to_string());
    }
    invalidate_probe();
    Ok(ScrollNavigationState::relative())
}

/// 翻页。UIA 可用时按百分比增量精确翻；否则投递 `PageUp` / `PageDown`，
/// 只有投递失败（结构性失败，不是「程序不理会」）才退回滚轮。
fn nudge_page(
    target: HWND,
    delta_percent: f64,
    key: VIRTUAL_KEY,
    direction: i32,
) -> Result<ScrollNavigationState, String> {
    if let Ok(state) = nudge_percent_on(target, delta_percent) {
        return Ok(state);
    }
    if unsafe { post_keys(target, None, key) }.is_ok() {
        invalidate_probe();
        return Ok(ScrollNavigationState::relative());
    }
    unsafe { post_wheel(target, PAGE_WHEEL_NOTCHES * direction) }
        .map_err(|error| format!("无法控制目标窗口滚动: {error}"))?;
    invalidate_probe();
    Ok(ScrollNavigationState::relative())
}

/// 相对微调（一步）。只走滚轮：投递方向键会在编辑器里移动光标而不是滚动。
fn step_by_wheel(target: HWND, notches: i32) -> Result<ScrollNavigationState, String> {
    unsafe { post_wheel(target, notches) }
        .map_err(|error| format!("无法控制目标窗口滚动: {error}"))?;
    invalidate_probe();
    Ok(ScrollNavigationState::relative())
}

pub fn state() -> ScrollNavigationState {
    let Some(target) = target_window() else {
        return ScrollNavigationState::unavailable();
    };
    match cached_probe(target) {
        Some(percent) => ScrollNavigationState::precise(percent),
        None => ScrollNavigationState::relative(),
    }
}

/// 「没有目标窗口」的状态。供命令在探测线程异常退出时兜底（失败即禁用面板，
/// 不会给出一个点了没反应的假可用状态）。
pub fn state_unavailable() -> ScrollNavigationState {
    ScrollNavigationState::unavailable()
}

pub fn set_percent(percent: f64) -> Result<ScrollNavigationState, String> {
    let target = target_window().ok_or_else(|| "未找到可控制的目标窗口".to_string())?;
    set_percent_on(target, percent)
}

pub fn navigate(action: &str) -> Result<ScrollNavigationState, String> {
    let plan = plan_for(action)?;
    let target = target_window().ok_or_else(|| "未找到可控制的目标窗口".to_string())?;
    match plan {
        ScrollPlan::Edge {
            percent,
            modifier,
            key,
            direction,
        } => jump_to_edge(target, percent, modifier, key, direction),
        ScrollPlan::Page {
            delta,
            key,
            direction,
        } => nudge_page(target, delta, key, direction),
        ScrollPlan::Step { notches } => step_by_wheel(target, notches),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        clamp_percent, pick_wheel_destination, plan_for, wheel_lparam, wheel_wparam, ScanBudget,
        ScrollPlan, SCAN_NODE_BUDGET,
    };
    use windows::Win32::Foundation::HWND;

    #[test]
    fn wheel_destination_prefers_the_child_under_the_point() {
        // 规则来源：explorer_probe.py —— 资源管理器投顶层不滚、投落点子窗口才滚。
        let target = HWND(0x100 as *mut std::ffi::c_void);
        let child = HWND(0x200 as *mut std::ffi::c_void);
        let empty = HWND::default();
        // 没有任何子窗口命中 → 顶层
        assert_eq!(pick_wheel_destination(target, empty, false, false), target);
        // 命中目标自己的子窗口 → 用它
        assert_eq!(pick_wheel_destination(target, child, false, true), child);
        // 落点被我们自己的置顶浮窗盖住 → 退回顶层，别把面板自己滚了
        assert_eq!(pick_wheel_destination(target, child, true, true), target);
        // 命中的是别的程序的窗口 → 退回顶层
        assert_eq!(pick_wheel_destination(target, child, false, false), target);
        // 命中的就是目标自己 → 顶层
        assert_eq!(pick_wheel_destination(target, target, false, true), target);
    }

    #[test]
    fn percent_is_clamped_by_public_contract() {
        assert_eq!(clamp_percent(-12.0).unwrap(), 0.0);
        assert_eq!(clamp_percent(145.0).unwrap(), 100.0);
        assert!(clamp_percent(f64::NAN).is_err());
    }

    #[test]
    fn wheel_wparam_packs_signed_delta_into_high_word() {
        // HIWORD 是带符号的增量：-120 必须落成 0xFF88，而不是 120 或溢出到低字。
        assert_eq!(wheel_wparam(-1).0, (0xFF88u32 << 16) as usize);
        assert_eq!(wheel_wparam(1).0, (120u32 << 16) as usize);
        assert_eq!(wheel_wparam(1).0 & 0xFFFF, 0);
        assert_eq!(((wheel_wparam(-1).0 >> 16) as u16) as i16, -120);
    }

    #[test]
    fn wheel_lparam_packs_screen_point() {
        let packed = wheel_lparam(0x0123, 0x0456);
        assert_eq!(packed.0 as u32 & 0xFFFF, 0x0123);
        assert_eq!((packed.0 as u32 >> 16) & 0xFFFF, 0x0456);
        // 负坐标也要能装进去（副屏在主屏左侧 / 上方时）
        let negative = wheel_lparam(-1920, -1080);
        assert_eq!(negative.0 as u32 & 0xFFFF, (-1920i32 as u32) & 0xFFFF);
        assert_eq!(
            (negative.0 as u32 >> 16) & 0xFFFF,
            (-1080i32 as u32) & 0xFFFF
        );
    }

    #[test]
    fn wheel_message_and_delta_match_win32_contract() {
        // 与 doc 里写死的数值对齐：投递用的是裸消息号，导入错常量不会编译失败，
        // 只会静默地发一条无人理解的消息（滚动「点了没反应」）。
        use windows::Win32::UI::WindowsAndMessaging::{WM_KEYDOWN, WM_KEYUP, WM_MOUSEWHEEL};
        assert_eq!(WM_MOUSEWHEEL, 0x020A);
        assert_eq!(WM_KEYDOWN, 0x0100);
        assert_eq!(WM_KEYUP, 0x0101);
        assert_eq!(super::WHEEL_DELTA, 120);
        assert_eq!(super::KEYUP_LPARAM, 0xC0000001u32 as isize);
    }

    #[test]
    fn action_plan_keeps_the_two_direction_conventions_aligned() {
        // UIA 百分比 0=顶部 / 滚轮增量 正=向上，两套约定方向相反 —— 这一条把
        // 「点向上翻页结果往下走」这类错误钉死。实测方向依据见
        // D:\tmp\scroll-nav-audit\edge_probe.py（正增量 800 格回到顶部基线）。
        let ScrollPlan::Page {
            delta, direction, ..
        } = plan_for("page-up").unwrap()
        else {
            panic!("page-up 应当是翻页计划");
        };
        assert!(delta < 0.0, "向上翻页必须减小百分比");
        assert!(direction > 0, "向上翻页的滚轮必须是正（向上）方向");

        let ScrollPlan::Page {
            delta, direction, ..
        } = plan_for("page-down").unwrap()
        else {
            panic!("page-down 应当是翻页计划");
        };
        assert!(delta > 0.0, "向下翻页必须增大百分比");
        assert!(direction < 0, "向下翻页的滚轮必须是负（向下）方向");

        let ScrollPlan::Edge {
            percent, direction, ..
        } = plan_for("top").unwrap()
        else {
            panic!("top 应当是到边计划");
        };
        assert_eq!(percent, 0.0);
        assert!(direction > 0);

        let ScrollPlan::Edge {
            percent, direction, ..
        } = plan_for("bottom").unwrap()
        else {
            panic!("bottom 应当是到边计划");
        };
        assert_eq!(percent, 100.0);
        assert!(direction < 0);

        let ScrollPlan::Step { notches } = plan_for("line-up").unwrap() else {
            panic!("line-up 应当是微调计划");
        };
        assert!(notches > 0);
        let ScrollPlan::Step { notches } = plan_for("line-down").unwrap() else {
            panic!("line-down 应当是微调计划");
        };
        assert!(notches < 0);

        assert!(plan_for("teleport").is_err());
    }

    #[test]
    fn scan_budget_stops_after_node_limit() {
        // 深树（Electron 类实测 1513 节点）必须在预算内提前放弃，
        // 否则跨进程遍历会把调用线程拖到 ~800ms。
        let mut budget = ScanBudget::new();
        let mut descents = 0u32;
        while budget.visit() {
            descents += 1;
        }
        // visit() 第 SCAN_NODE_BUDGET 次调用时判定耗尽 → 真正下探的次数少一次
        assert_eq!(descents + 1, SCAN_NODE_BUDGET);
        assert!(budget.exhausted());
        assert!(!budget.visit());
    }
}
