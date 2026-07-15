//! 贴图（钉在桌面）窗口管理 —— 原生 Win32 窗口方案（参考 Snipaste）。
//!
//! 每张贴图是一个独立原生 Win32 窗口（非 Tauri webview），
//! 窗口客户区直接用 GDI 绘制 BGRA 像素，避免 WebView2 动态创建窗口的死锁问题，
//! 且不依赖 asset 协议/临时文件/CSP，行为更接近 Snipaste。
//!
//! 交互：左键拖动、双击关闭、滚轮缩放（以左上角为心）、Ctrl+滚轮调透明度、
//! 右键菜单（复制/另存为/关闭）、Esc 关闭。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{GlobalFree, COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateSolidBrush, DeleteDC,
    DeleteObject, EndPaint, FillRect, FrameRect, GetTextExtentPoint32W, SelectObject, SetBkMode,
    SetTextColor, StretchDIBits, TextOutW, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    PAINTSTRUCT, SRCCOPY, TRANSPARENT,
};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_DIB;
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, DestroyWindow,
    DispatchMessageW, GetMessageW, KillTimer, LoadCursorW, PostMessageW, PostQuitMessage,
    RegisterClassExW, SetForegroundWindow, SetLayeredWindowAttributes, SetTimer, SetWindowPos,
    ShowWindow, TrackPopupMenu, TranslateMessage, CS_HREDRAW, CS_VREDRAW, HTCAPTION, IDC_ARROW,
    LWA_ALPHA, MF_SEPARATOR, MF_STRING, SWP_NOACTIVATE, SWP_NOCOPYBITS, SWP_NOMOVE, SWP_NOZORDER,
    SW_SHOWNOACTIVATE, TPM_LEFTALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON, TPM_TOPALIGN, WM_COMMAND,
    WM_CONTEXTMENU, WM_ERASEBKGND, WM_KEYDOWN, WM_MOUSEWHEEL, WM_NCCREATE, WM_NCDESTROY,
    WM_NCHITTEST, WM_NCLBUTTONDBLCLK, WM_PAINT, WM_TIMER, WNDCLASSEXW, WS_EX_LAYERED,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

/// VK_ESCAPE 虚拟键码（避免跨模块导入 KeyboardAndMouse）
const VK_ESCAPE: u16 = 0x1B;

const PIN_CLASS_NAME: PCWSTR = w!("FloastPinWindow");
const CMD_CLOSE: u16 = 1;
const CMD_COPY: u16 = 2;
const CMD_SAVE: u16 = 3;
const SCALE_TIMER_ID: usize = 1;
/// 比例文字显示时长（毫秒）
const SCALE_LABEL_MS: u32 = 1200;
/// 缩放范围
const SCALE_MIN: f32 = 0.1;
const SCALE_MAX: f32 = 8.0;
/// 每档滚轮的倍率
const SCALE_STEP: f32 = 1.1;
/// 透明度范围（0-255）
const OPACITY_MIN: u8 = 30;
const OPACITY_MAX: u8 = 255;
/// 每档滚轮的透明度步进
const OPACITY_STEP: u8 = 20;
/// 贴图边框（含发光晕）总宽度，画在图片外侧。窗口尺寸 = 图片 + 2*BORDER。
/// 用多层递进亮度实色线模拟外发光（layered LWA_ALPHA 仅支持整体透明度，无 per-pixel alpha）。
/// 3 层 1px：最外最浅 → 中 → 内层主色，紧贴图片边缘，视觉呈发光晕染至亮边框。
const BORDER: i32 = 3;
/// 边框主体色（内层）：亮青蓝 RGB(0,200,255)。COLORREF 布局为 0x00BBGGRR。
const BORDER_COLOR: COLORREF = COLORREF(0x00FF_C800);
/// 中间晕色 RGB(60,212,255) → 0x00FF_D43C
const GLOW_MID: COLORREF = COLORREF(0x00FF_D43C);
/// 外层晕色（最浅）RGB(140,228,255) → 0x00FF_E48C
const GLOW_OUTER: COLORREF = COLORREF(0x00FF_E48C);

/// 贴图窗口运行时数据
struct PinWindow {
    hwnd: isize,
    // 像素数据由窗口线程所有（通过 Box::into_raw 传给线程），此处仅存 hwnd 用于关闭
}

static PIN_ID: AtomicU32 = AtomicU32::new(1);
static PINS: Mutex<Option<HashMap<u32, PinWindow>>> = Mutex::new(None);

fn pins_locked<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<u32, PinWindow>) -> R,
{
    let mut guard = PINS.lock().expect("PINS mutex poisoned");
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

/// 传递给窗口线程的创建参数
struct PinCreateParams {
    id: u32,
    pixels: Vec<u8>, // BGRA
    width: i32,
    height: i32,
    x: i32,
    y: i32,
}

/// 线程内窗口数据（通过 GWLP_USERDATA 挂在窗口上）
struct PinState {
    pixels: Vec<u8>,
    width: i32,
    height: i32,
    /// 当前缩放比例（1.0 = 原始尺寸）
    scale: f32,
    /// 当前不透明度（0-255）
    opacity: u8,
    /// 比例角标显示截止时间；None 表示不显示
    show_scale_until: Option<std::time::Instant>,
}

/// 清理所有遗留贴图临时文件（保留兼容，原生方案不再写临时文件，但清理旧版残留）
pub fn cleanup_stale_temp_files() {
    if let Ok(temp) = std::env::temp_dir().read_dir() {
        for entry in temp.flatten() {
            let name = entry.file_name();
            if let Some(name) = name.to_str() {
                if name.starts_with("floast-pin-") && name.ends_with(".png") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

/// 创建一张贴图：解码 base64 PNG 为 BGRA 像素，创建原生 Win32 窗口绘制。
/// 返回 pin id。
pub fn create_pin(
    app: &tauri::AppHandle,
    base64_data: &str,
    x: i32,
    y: i32,
    _width: u32,
    _height: u32,
) -> Result<u32, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let raw = if let Some(idx) = base64_data.find(',') {
        &base64_data[idx + 1..]
    } else {
        base64_data
    };
    let bytes = STANDARD
        .decode(raw)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    // 解码 PNG 为 BGRA 像素
    let img = image::load_from_memory(&bytes).map_err(|e| format!("PNG 解码失败: {}", e))?;
    let rgba = img.to_rgba8();
    let (iw, ih) = (rgba.width() as i32, rgba.height() as i32);
    // RGBA → BGRA（GDI 使用 BGRA 字节序）
    let mut pixels = rgba.into_raw();
    for px in pixels.chunks_exact_mut(4) {
        px.swap(0, 2);
    }

    let id = PIN_ID.fetch_add(1, Ordering::SeqCst);

    let params = PinCreateParams {
        id,
        pixels,
        width: iw,
        height: ih,
        x,
        y,
    };

    // 登记占位（hwnd 稍后由窗口线程回填）
    pins_locked(|m| {
        m.insert(id, PinWindow { hwnd: 0 });
    });

    // 在独立线程创建窗口并跑消息循环，避免阻塞 Tauri 命令线程
    let app_handle = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = run_pin_window(app_handle, params) {
            crate::utils::logger::log("screenshot", &format!("pin window thread error: {}", e));
            // 线程失败时移除占位记录
            pins_locked(|m| {
                m.remove(&id);
            });
        }
    });

    Ok(id)
}

/// 窗口线程：注册类、创建窗口、消息循环
fn run_pin_window(app: tauri::AppHandle, params: PinCreateParams) -> Result<(), String> {
    let id = params.id;
    let state = Box::new(PinState {
        pixels: params.pixels,
        width: params.width,
        height: params.height,
        scale: 1.0,
        opacity: OPACITY_MAX,
        show_scale_until: None,
    });

    unsafe {
        let hinst = windows::Win32::System::LibraryLoader::GetModuleHandleW(None)
            .map_err(|e| format!("GetModuleHandleW: {}", e))?;

        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(pin_wndproc),
            hInstance: hinst.into(),
            lpszClassName: PIN_CLASS_NAME,
            hCursor: LoadCursorW(None, IDC_ARROW).map_err(|e| format!("LoadCursor: {}", e))?,
            ..Default::default()
        };

        // 类可能已注册（多次贴图），忽略注册错误
        let _ = RegisterClassExW(&wc);

        // 窗口样式：弹出式、置顶、工具窗口（不在任务栏）、分层窗口。
        // 创建时不带 WS_VISIBLE：先设好 SetLayeredWindowAttributes 再 ShowWindow，
        // 避免 layered 窗口在 alpha 未设置期间出现一帧完全不可见/异样。
        // WS_EX_LAYERED + SetLayeredWindowAttributes(LWA_ALPHA) 仅调整体不透明度，
        // 不影响 GDI 绘制内容；初始化 alpha=255（完全不透明），由 Ctrl+滚轮调节。
        let style = WS_POPUP;
        let ex_style = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED;

        // 窗口尺寸 = 图片 + 2*BORDER，位置左上角向左上偏移 BORDER，
        // 使图片内容仍精确覆盖原选区位置，边框与发光画在图片外侧。
        let win_w = params.width + BORDER * 2;
        let win_h = params.height + BORDER * 2;
        let win_x = params.x - BORDER;
        let win_y = params.y - BORDER;

        let hwnd = CreateWindowExW(
            ex_style,
            PIN_CLASS_NAME,
            w!("Floast Pin"),
            style,
            win_x,
            win_y,
            win_w,
            win_h,
            None,
            None,
            Some(hinst.into()),
            Some(Box::into_raw(state) as *const _),
        )
        .map_err(|e| format!("CreateWindowExW failed: {}", e))?;

        // 初始化分层窗口 alpha，否则 layered 窗口默认不可见
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), OPACITY_MAX, LWA_ALPHA);
        // 属性就绪后再显示，SW_SHOWNOACTIVATE 避免贴图弹出抢走当前焦点
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);

        let hwnd_isize = hwnd.0 as isize;
        crate::utils::logger::log(
            "screenshot",
            &format!("create_pin id={} hwnd={:p}", id, hwnd.0),
        );

        // 回填 hwnd 到 PINS
        pins_locked(|m| {
            if let Some(p) = m.get_mut(&id) {
                p.hwnd = hwnd_isize;
            }
        });

        // 消息循环
        let mut msg = windows::Win32::UI::WindowsAndMessaging::MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).into() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        // 窗口销毁后从 PINS 移除
        pins_locked(|m| {
            m.remove(&id);
        });
        let _ = app; // 保留 app_handle 引用防止过早释放
    }

    Ok(())
}

/// 窗口过程
unsafe extern "system" fn pin_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_NCCREATE => {
            // 取出 CreateWindowExW 传入的 PinState 指针，挂到窗口 USERDATA
            let cs = lparam.0 as *const windows::Win32::UI::WindowsAndMessaging::CREATESTRUCTW;
            if !cs.is_null() {
                let state_ptr = (*cs).lpCreateParams as *mut PinState;
                if !state_ptr.is_null() {
                    windows::Win32::UI::WindowsAndMessaging::SetWindowLongPtrW(
                        hwnd,
                        windows::Win32::UI::WindowsAndMessaging::GWL_USERDATA,
                        state_ptr as isize,
                    );
                }
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_PAINT => {
            let state_ptr = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                hwnd,
                windows::Win32::UI::WindowsAndMessaging::GWL_USERDATA,
            ) as *mut PinState;
            if state_ptr.is_null() {
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            let state = &*state_ptr;

            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);
            if hdc.is_invalid() {
                return LRESULT(0);
            }

            let mut rc = RECT::default();
            let _ = windows::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &mut rc);
            let cw = rc.right - rc.left;
            let ch = rc.bottom - rc.top;
            if cw <= 0 || ch <= 0 {
                let _ = EndPaint(hwnd, &ps);
                return LRESULT(0);
            }

            // 双缓冲：先在内存 DC 上绘制完整帧，再一次性 BitBlt 到屏幕，
            // 消除缩放/角标绘制过程中的撕裂与闪烁。
            let mem_dc = CreateCompatibleDC(Some(hdc));
            if mem_dc.is_invalid() {
                let _ = EndPaint(hwnd, &ps);
                return LRESULT(0);
            }
            let mem_bmp = CreateCompatibleBitmap(hdc, cw, ch);
            if mem_bmp.is_invalid() {
                let _ = DeleteDC(mem_dc);
                let _ = EndPaint(hwnd, &ps);
                return LRESULT(0);
            }
            // SelectObject 返回被替换的旧对象，恢复时用
            let old_bmp = SelectObject(mem_dc, mem_bmp.into());

            // BITMAPINFO 描述 BGRA 像素
            let bi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: state.width,
                    biHeight: -state.height, // 负高度 = 自上而下
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: DIB_RGB_COLORS.0,
                    biSizeImage: state.pixels.len() as u32,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: [Default::default(); 1],
            };

            // 图片绘制到 (BORDER, BORDER)，四周留 BORDER 像素画发光边框
            let img_x = BORDER;
            let img_y = BORDER;
            let img_w = cw - BORDER * 2;
            let img_h = ch - BORDER * 2;
            if img_w > 0 && img_h > 0 {
                StretchDIBits(
                    mem_dc,
                    img_x,
                    img_y,
                    img_w,
                    img_h,
                    0,
                    0,
                    state.width,
                    state.height,
                    Some(state.pixels.as_ptr() as *const std::ffi::c_void),
                    &bi,
                    DIB_RGB_COLORS,
                    SRCCOPY,
                );
            }

            // 发光边框：3 层 1px 递进亮色，从外到内逐层加深，紧贴图片边缘。
            // layered LWA_ALPHA 下整体透明度调节会一并作用到边框，符合预期。
            draw_glow_border(mem_dc, cw, ch);

            // 比例角标（仅当处于显示窗口期内）
            let show = state
                .show_scale_until
                .map(|until| std::time::Instant::now() < until)
                .unwrap_or(false);
            if show {
                draw_scale_label(mem_dc, state.scale);
            }

            // 一次性拷贝到屏幕
            let _ = BitBlt(hdc, 0, 0, cw, ch, Some(mem_dc), 0, 0, SRCCOPY);

            // 清理 GDI 对象
            let _ = SelectObject(mem_dc, old_bmp);
            let _ = DeleteObject(mem_bmp.into());
            let _ = DeleteDC(mem_dc);

            let _ = EndPaint(hwnd, &ps);
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1), // 不擦除背景，避免闪烁
        // 客户区滚轮。注意：WM_NCHITTEST 返回 HTCAPTION 后，
        // 系统通常把滚轮以 WM_NCMOUSEWHEEL 投递，故二者都需处理。
        // 二者 wParam 布局相反：WM_MOUSEWHEEL 低字=key flags、高字=delta；
        // WM_NCMOUSEWHEEL 低字=delta、高字=key flags。handle_wheel 按 msg 区分解析。
        WM_MOUSEWHEEL => handle_wheel(hwnd, msg, wparam, lparam),
        // 0x020E = WM_NCMOUSEWHEEL（windows crate 0.61 未导出该常量）
        0x020E => handle_wheel(hwnd, msg, wparam, lparam),
        WM_KEYDOWN => {
            // Esc 关闭贴图（窗口获焦后 keydown 可收到）
            if wparam.0 as u16 == VK_ESCAPE {
                let _ = DestroyWindow(hwnd);
                return LRESULT(0);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_TIMER => {
            if wparam.0 == SCALE_TIMER_ID {
                let state_ptr = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                    hwnd,
                    windows::Win32::UI::WindowsAndMessaging::GWL_USERDATA,
                ) as *mut PinState;
                if !state_ptr.is_null() {
                    let state = &mut *state_ptr;
                    let expired = state
                        .show_scale_until
                        .map(|until| std::time::Instant::now() >= until)
                        .unwrap_or(true);
                    if expired {
                        state.show_scale_until = None;
                        let _ = KillTimer(Some(hwnd), SCALE_TIMER_ID);
                        let _ =
                            windows::Win32::Graphics::Gdi::InvalidateRect(Some(hwnd), None, false);
                    }
                }
            }
            LRESULT(0)
        }
        WM_NCHITTEST => {
            // 整个窗口作为标题栏：左键拖动由 DefWindowProc 原生处理（非模态，不阻塞双击）
            LRESULT(HTCAPTION as isize)
        }
        WM_NCLBUTTONDBLCLK => {
            // 标题栏双击关闭（HTCAPTION 下双击产生 NC 双击消息，非客户区双击不依赖 CS_DBLCLKS）
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_CONTEXTMENU => {
            // 右键菜单（HTCAPTION 下右键产生 WM_CONTEXTMENU，客户区右键同）
            show_context_menu(hwnd, lparam);
            LRESULT(0)
        }
        WM_COMMAND => {
            let cmd = (wparam.0 & 0xffff) as u16;
            match cmd {
                CMD_CLOSE => {
                    let _ = DestroyWindow(hwnd);
                }
                CMD_COPY => {
                    let _ = copy_pin_to_clipboard(hwnd);
                }
                CMD_SAVE => {
                    let _ = save_pin_as(hwnd);
                }
                _ => {}
            }
            LRESULT(0)
        }
        WM_NCDESTROY => {
            // 停止缩放比例定时器，避免释放后回调访问悬垂指针
            let _ = KillTimer(Some(hwnd), SCALE_TIMER_ID);
            // 释放 PinState
            let state_ptr = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                hwnd,
                windows::Win32::UI::WindowsAndMessaging::GWL_USERDATA,
            ) as *mut PinState;
            if !state_ptr.is_null() {
                drop(Box::from_raw(state_ptr));
            }
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// 处理滚轮：普通滚轮缩放，Ctrl+滚轮调透明度（参考 Snipaste）。
/// 缩放以窗口左上角为心（同 Snipaste），仅改尺寸不改位置，配合 SWP_NOCOPYBITS + 双缓冲消除卡顿。
///
/// `msg` 用于区分 wParam 布局：
/// - WM_MOUSEWHEEL：低 16 位 = key flags（MK_CONTROL=0x0008），高 16 位 = 有符号 wheel delta。
/// - WM_NCMOUSEWHEEL(0x020E)：低 16 位 = wheel delta，高 16 位 = key flags。二者相反。
///   因 WM_NCHITTEST 返回 HTCAPTION，滚轮实际以 WM_NCMOUSEWHEEL 投递，必须按 NC 布局解析。
unsafe fn handle_wheel(hwnd: HWND, msg: u32, wparam: WPARAM, _lparam: LPARAM) -> LRESULT {
    let state_ptr = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
        hwnd,
        windows::Win32::UI::WindowsAndMessaging::GWL_USERDATA,
    ) as *mut PinState;
    if state_ptr.is_null() {
        return LRESULT(0);
    }
    let state = &mut *state_ptr;

    let (delta, ctrl) = if msg == 0x020E {
        // WM_NCMOUSEWHEEL：低字 = delta，高字 = key flags
        let delta = (wparam.0 & 0xffff) as u16 as i16 as i32;
        let ctrl = ((wparam.0 >> 16) & 0x0008) != 0;
        (delta, ctrl)
    } else {
        // WM_MOUSEWHEEL：高字 = delta，低字 = key flags
        let delta = ((wparam.0 >> 16) & 0xffff) as u16 as i16 as i32;
        let ctrl = (wparam.0 & 0x0008) != 0;
        (delta, ctrl)
    };

    if ctrl {
        // 透明度调节
        let step = if delta >= 0 {
            OPACITY_STEP as i32
        } else {
            -(OPACITY_STEP as i32)
        };
        let new_opacity =
            ((state.opacity as i32) + step).clamp(OPACITY_MIN as i32, OPACITY_MAX as i32) as u8;
        if new_opacity == state.opacity {
            return LRESULT(0);
        }
        state.opacity = new_opacity;
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), new_opacity, LWA_ALPHA);
        // 透明度变化不需重绘像素，layered 合成自动应用
        return LRESULT(0);
    }

    // 新比例
    let factor = SCALE_STEP.powf(delta as f32 / 120.0);
    let new_scale = (state.scale * factor).clamp(SCALE_MIN, SCALE_MAX);
    if (new_scale - state.scale).abs() < 1e-4 {
        // 已到边界：仅刷新比例角标显示
        show_scale_label(hwnd, state);
        return LRESULT(0);
    }

    // 新尺寸（基于原始像素尺寸，避免累积误差），加 2*BORDER 为发光边框留位
    let new_w = ((state.width as f32 * new_scale).round() as i32).max(1) + BORDER * 2;
    let new_h = ((state.height as f32 * new_scale).round() as i32).max(1) + BORDER * 2;

    state.scale = new_scale;

    // 以窗口左上角为缩放中心（同 Snipaste）：位置不变，只改尺寸。
    // SWP_NOMOVE 忽略 x/y；SWP_NOCOPYBITS 禁止系统复制旧客户区（昂贵且无意义，因全量重绘）。
    let _ = SetWindowPos(
        hwnd,
        None,
        0,
        0,
        new_w,
        new_h,
        SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOCOPYBITS | SWP_NOMOVE,
    );

    show_scale_label(hwnd, state);
    LRESULT(0)
}

/// 显示比例角标并启动/重置一次性定时器，到期后擦除。
unsafe fn show_scale_label(hwnd: HWND, state: &mut PinState) {
    state.show_scale_until =
        Some(std::time::Instant::now() + std::time::Duration::from_millis(SCALE_LABEL_MS as u64));
    let _ = SetTimer(Some(hwnd), SCALE_TIMER_ID, SCALE_LABEL_MS + 30, None);
    let _ = windows::Win32::Graphics::Gdi::InvalidateRect(Some(hwnd), None, false);
}

/// 绘制发光边框：在客户区四周画 3 层 1px 递进亮色矩形。
/// 最外层 GLOW_OUTER（最浅）→ GLOW_MID → BORDER_COLOR（内层，最饱和），
/// 内层紧贴图片边缘。视觉上从图片边向外晕染渐亮，模拟外发光效果。
unsafe fn draw_glow_border(hdc: windows::Win32::Graphics::Gdi::HDC, cw: i32, ch: i32) {
    // 三层从外到内：外层矩形 (0,0,cw,ch)，中层 (1,1,cw-2,ch-2)，内层 (2,2,cw-4,ch-4)
    // FrameRect 画 1px 逻辑边框（实际为设备单位 1px）
    let layers = [(GLOW_OUTER, 0), (GLOW_MID, 1), (BORDER_COLOR, 2)];
    for (color, inset) in layers {
        let rc = RECT {
            left: inset,
            top: inset,
            right: cw - inset,
            bottom: ch - inset,
        };
        let brush = CreateSolidBrush(color);
        let _ = FrameRect(hdc, &rc as *const _, brush);
        let _ = DeleteObject(brush.into());
    }
}

/// 在客户区左上角绘制比例角标（黑底白字）。
unsafe fn draw_scale_label(hdc: windows::Win32::Graphics::Gdi::HDC, scale: f32) {
    use std::fmt::Write as _;
    // 比例文字，如 "120%"
    let mut text = String::new();
    let _ = write!(&mut text, "{}%", (scale * 100.0).round() as i32);
    let wide: Vec<u16> = text.encode_utf16().collect();

    const PAD: i32 = 6;
    const H: i32 = 18;
    const TEXT_PAD: i32 = 6;
    // 用 GetTextExtentPoint32W 实测文字尺寸，避免 CHAR_W 等宽估算导致黑底与文字不齐
    let mut size = windows::Win32::Foundation::SIZE { cx: 0, cy: 0 };
    let mut text_w = 8 * text.chars().count() as i32;
    if GetTextExtentPoint32W(hdc, &wide, &mut size).as_bool() && size.cx > 0 {
        text_w = size.cx;
    }
    let label_w = text_w + 12;
    let left = PAD;
    let top = PAD;
    let right = PAD + label_w;
    let bottom = top + H;

    let rc = RECT {
        left,
        top,
        right,
        bottom,
    };

    // 黑底（layered LWA_ALPHA 仅调整体不透明度，仍用不透明黑底保证可读性）
    let brush = CreateSolidBrush(COLORREF(0x00000000));
    let _ = FillRect(hdc, &rc as *const _, brush);
    let _ = DeleteObject(brush.into());

    // 白色文字，透明背景模式
    let _ = SetBkMode(hdc, TRANSPARENT);
    let _ = SetTextColor(hdc, COLORREF(0x00FFFFFF));
    let _ = TextOutW(hdc, left + TEXT_PAD, top + 1, &wide);
}

/// 弹出右键菜单：复制 / 另存为 / 关闭。
unsafe fn show_context_menu(hwnd: HWND, lparam: LPARAM) {
    let menu = match CreatePopupMenu() {
        Ok(m) => m,
        Err(_) => return,
    };
    let copy_str: Vec<u16> = "复制到剪贴板"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let save_str: Vec<u16> = "另存为…".encode_utf16().chain(std::iter::once(0)).collect();
    let close_str: Vec<u16> = "关闭贴图"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let _ = AppendMenuW(
        menu,
        MF_STRING,
        CMD_COPY as usize,
        PCWSTR(copy_str.as_ptr()),
    );
    let _ = AppendMenuW(
        menu,
        MF_STRING,
        CMD_SAVE as usize,
        PCWSTR(save_str.as_ptr()),
    );
    let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR(std::ptr::null()));
    let _ = AppendMenuW(
        menu,
        MF_STRING,
        CMD_CLOSE as usize,
        PCWSTR(close_str.as_ptr()),
    );

    // 屏幕坐标
    let x = (lparam.0 & 0xffff) as i16 as i32;
    let y = ((lparam.0 >> 16) & 0xffff) as i16 as i32;

    // TrackPopupMenu 需要窗口在前台，否则菜单不接收点击（Win32 限制）
    let _ = SetForegroundWindow(hwnd);
    let flags = TPM_LEFTALIGN | TPM_TOPALIGN | TPM_RIGHTBUTTON | TPM_RETURNCMD;
    let cmd = TrackPopupMenu(menu, flags, x, y, Some(0), hwnd, None);
    let _ = DestroyMenu(menu);
    // TPM_RETURNCMD 模式下返回选中项 ID（0 表示取消），显式 PostMessage 派发命令。
    let cmd_id = cmd.0 as u32;
    if cmd_id != 0 {
        let _ = PostMessageW(Some(hwnd), WM_COMMAND, WPARAM(cmd_id as usize), LPARAM(0));
    }
}

/// 把贴图像素以 CF_DIB 复制到剪贴板。
unsafe fn copy_pin_to_clipboard(hwnd: HWND) -> Result<(), String> {
    let state_ptr = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
        hwnd,
        windows::Win32::UI::WindowsAndMessaging::GWL_USERDATA,
    ) as *mut PinState;
    if state_ptr.is_null() {
        return Err("贴图状态丢失".into());
    }
    let state = &*state_ptr;

    // 构造 BITMAPINFO + 像素（BGRA，自上而下 biHeight 为负）
    let header_size = std::mem::size_of::<BITMAPINFOHEADER>();
    let pixels_len = state.pixels.len();
    let total = header_size + pixels_len;

    let hmem = GlobalAlloc(GMEM_MOVEABLE, total).map_err(|e| format!("GlobalAlloc: {}", e))?;
    let ptr = GlobalLock(hmem);
    if ptr.is_null() {
        // GlobalLock 失败极罕见，但需释放已分配的 hmem 避免泄漏
        let _ = GlobalFree(Some(hmem));
        return Err("GlobalLock 失败".into());
    }
    let buf = std::slice::from_raw_parts_mut(ptr as *mut u8, total);
    // 写头部（biHeight 取正，CF_DIB 约定为自下而上；此处像素已是自上而下需翻转或用正高度+倒序）
    // 简化：用正高度并把扫描行倒序拷贝，使剪贴板消费者按常规 DIB 解析
    let header = BITMAPINFOHEADER {
        biSize: header_size as u32,
        biWidth: state.width,
        biHeight: state.height, // 正高度 = 自下而上
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0,
        biSizeImage: pixels_len as u32,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
    };
    let header_bytes =
        std::slice::from_raw_parts(&header as *const BITMAPINFOHEADER as *const u8, header_size);
    buf[..header_size].copy_from_slice(header_bytes);
    // 像素自上而下 → 倒序写入（每行 width*4 字节），适配正高度 DIB
    let row = (state.width as usize) * 4;
    let rows = state.height as usize;
    let src = &state.pixels;
    for r in 0..rows {
        let src_off = r * row;
        let dst_off = header_size + (rows - 1 - r) * row;
        buf[dst_off..dst_off + row].copy_from_slice(&src[src_off..src_off + row]);
    }
    let _ = GlobalUnlock(hmem);

    // hmem 所有权：SetClipboardData 成功则转移给系统；失败则需我们 GlobalFree 释放。
    // 用 Option 跟踪：仅在成功后 take() 置 None，失败路径末尾统一 GlobalFree。
    let mut hmem_owner: Option<windows::Win32::Foundation::HGLOBAL> = Some(hmem);

    let mut err: Option<String> = None;
    if let Err(e) = OpenClipboard(Some(hwnd)) {
        err = Some(format!("OpenClipboard 失败: {}", e));
    } else {
        if let Err(e) = EmptyClipboard() {
            err = Some(format!("EmptyClipboard 失败: {}", e));
        }
        // 用裸指针构造 HANDLE 调用，成功后才转移所有权（take 置 None）；
        // 失败时 hmem 仍由 hmem_owner 持有，末尾 GlobalFree 释放。
        let handle = windows::Win32::Foundation::HANDLE(hmem_owner.as_ref().unwrap().0);
        match SetClipboardData(CF_DIB.0 as u32, Some(handle)) {
            Ok(_) => {
                hmem_owner.take(); // 所有权转移给剪贴板，不再释放
            }
            Err(e) => {
                err = Some(format!("SetClipboardData 失败: {}", e));
            }
        }
        let _ = CloseClipboard();
    }

    // 失败路径：若 hmem 仍未转移（未被 SetClipboardData 接管），释放避免泄漏
    if let Some(h) = hmem_owner {
        let _ = GlobalFree(Some(h));
    }

    match err {
        Some(msg) => Err(msg),
        None => Ok(()),
    }
}

/// 弹出保存对话框，把贴图像素编码为 PNG 写文件。
///
/// 在独立线程执行：rfd 的保存对话框是模态的，会跑自己的消息循环；
/// 若在窗口消息线程（pin_wndproc）内同步调用，对话框期间派发的消息会重入 wndproc，
/// 可能触发 DestroyWindow → WM_NCDESTROY → drop(PinState)，使此处持有的 state 引用悬垂（UB）。
/// 故此处仅克隆像素数据（owned），把阻塞的对话框与文件 IO 移到独立线程。
unsafe fn save_pin_as(hwnd: HWND) -> Result<(), String> {
    let state_ptr = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
        hwnd,
        windows::Win32::UI::WindowsAndMessaging::GWL_USERDATA,
    ) as *mut PinState;
    if state_ptr.is_null() {
        return Err("贴图状态丢失".into());
    }
    let state = &*state_ptr;

    // BGRA → PNG（在此同步完成，借用仅在此时存活，不跨 rfd 阻塞调用）
    let mut rgba: Vec<u8> = Vec::with_capacity(state.pixels.len());
    for chunk in state.pixels.chunks_exact(4) {
        rgba.push(chunk[2]); // R
        rgba.push(chunk[1]); // G
        rgba.push(chunk[0]); // B
        rgba.push(chunk[3]); // A
    }
    let width = state.width;
    let height = state.height;
    let img = image::RgbaImage::from_raw(width as u32, height as u32, rgba)
        .ok_or_else(|| "构造 RgbaImage 失败".to_string())?;
    let dyn_img = image::DynamicImage::ImageRgba8(img);
    let mut png_buf: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut png_buf);
    dyn_img
        .write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败: {}", e))?;

    // 阻塞的对话框 + 文件写入移到独立线程，避免重入 wndproc 与冻结贴图消息循环
    std::thread::spawn(move || {
        let path = rfd::FileDialog::new()
            .set_file_name("screenshot.png")
            .add_filter("PNG 图片", &["png"])
            .save_file();
        if let Some(p) = path {
            if let Err(e) = std::fs::write(&p, &png_buf) {
                crate::utils::logger::log("screenshot", &format!("save_pin_as 写入失败: {}", e));
            }
        }
    });
    Ok(())
}

/// 主动关闭贴图（按 id）
pub fn close_pin(_app: &tauri::AppHandle, id: u32) -> Result<(), String> {
    let hwnd_isize = pins_locked(|m| m.get(&id).map(|p| p.hwnd).unwrap_or(0));
    if hwnd_isize != 0 {
        unsafe {
            let hwnd = HWND(hwnd_isize as *mut std::ffi::c_void);
            // 跨线程发 WM_COMMAND(CMD_CLOSE)，由窗口线程自己 DestroyWindow（跨线程 DestroyWindow 可能不稳）
            let _ = PostMessageW(
                Some(hwnd),
                WM_COMMAND,
                WPARAM(CMD_CLOSE as usize),
                LPARAM(0),
            );
        }
        return Ok(());
    }
    // 窗口已不存在，清理记录
    pins_locked(|m| {
        m.remove(&id);
    });
    Ok(())
}
