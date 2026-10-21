//! 贴图（钉在桌面）窗口管理 —— 原生 Win32 窗口方案（参考 Snipaste）。
//!
//! 每张贴图是一个独立原生 Win32 窗口（非 Tauri webview），
//! 窗口客户区直接用 GDI 绘制 BGRA 像素，避免 WebView2 动态创建窗口的死锁问题，
//! 且不依赖 asset 协议/临时文件/CSP，行为更接近 Snipaste。
//!
//! 交互：左键拖动、双击关闭、滚轮缩放（以左上角为心）、Ctrl+滚轮调透明度、
//! 右键菜单（旋转、翻转、镜像副本、复制、保存、关闭）、Esc 关闭。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::Emitter;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{
    GlobalFree, COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
};
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
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW,
    GetWindowRect, IsWindow, KillTimer, LoadCursorW, PostMessageW, PostQuitMessage,
    RegisterClassExW, SetLayeredWindowAttributes, SetTimer, SetWindowPos, ShowWindow,
    TranslateMessage, CS_HREDRAW, CS_VREDRAW, HTCAPTION, HWND_NOTOPMOST, HWND_TOPMOST, IDC_ARROW,
    LWA_ALPHA, SWP_NOACTIVATE, SWP_NOCOPYBITS, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    SW_SHOWNOACTIVATE, WM_COMMAND, WM_CONTEXTMENU, WM_ERASEBKGND, WM_KEYDOWN, WM_MOUSEWHEEL,
    WM_NCCREATE, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDBLCLK, WM_NCRBUTTONUP, WM_PAINT,
    WM_RBUTTONUP, WM_TIMER, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

/// VK_ESCAPE 虚拟键码（避免跨模块导入 KeyboardAndMouse）
const VK_ESCAPE: u16 = 0x1B;

const PIN_CLASS_NAME: PCWSTR = w!("LevitairePinWindow");
const CMD_CLOSE: u16 = 1;
const CMD_COPY: u16 = 2;
const CMD_SAVE: u16 = 3;
const CMD_ROTATE_LEFT: u16 = 4;
const CMD_ROTATE_RIGHT: u16 = 5;
const CMD_FLIP_HORIZONTAL: u16 = 6;
const CMD_FLIP_VERTICAL: u16 = 7;
const CMD_DUPLICATE_HORIZONTAL_MIRROR: u16 = 8;
const CMD_DUPLICATE_VERTICAL_MIRROR: u16 = 9;
const CMD_DUPLICATE_MIRROR: u16 = 10;
const CMD_OCR: u16 = 11;
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
/// 贴图窗口运行时数据
struct PinWindow {
    hwnd: isize,
    /// 占位期（hwnd 尚未回填）内是否已收到关闭请求。
    /// 为 true 时，窗口线程在建窗并回填 hwnd 后将立即销毁窗口，
    /// 避免「占位登记完成、hwnd 尚未回填」的窗口期内 close_pin 因 hwnd==0
    /// 直接移除记录，导致窗口随后照常创建却无法被关闭而永久泄漏。
    close_requested: bool,
    // 像素数据由窗口线程所有（通过 Box::into_raw 传给线程），此处仅存 hwnd 用于关闭
}

static PIN_ID: AtomicU32 = AtomicU32::new(1);
static PINS: Mutex<Option<HashMap<u32, PinWindow>>> = Mutex::new(None);

fn pins_locked<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<u32, PinWindow>) -> R,
{
    // 其他模块统一忽略中毒（持锁闭包里 panic 不应让整块功能永久瘫痪）。
    let mut guard = PINS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
    scale: f32,
    opacity: u8,
    border_width: i32,
    border_color: COLORREF,
}

#[derive(Clone, Copy)]
enum PinTransform {
    RotateLeft,
    RotateRight,
    FlipHorizontal,
    FlipVertical,
}

/// 线程内窗口数据（通过 GWLP_USERDATA 挂在窗口上）
struct PinState {
    app: tauri::AppHandle,
    id: u32,
    pixels: Vec<u8>,
    width: i32,
    height: i32,
    /// 当前缩放比例（1.0 = 原始尺寸）
    scale: f32,
    /// 当前不透明度（0-255）
    opacity: u8,
    border_width: i32,
    border_color: COLORREF,
    /// 比例角标显示截止时间；None 表示不显示
    show_scale_until: Option<std::time::Instant>,
    last_context_menu_at: Option<std::time::Instant>,
}

/// 清理所有遗留贴图临时文件（保留兼容，原生方案不再写临时文件，但清理旧版残留）
pub fn cleanup_stale_temp_files() {
    if let Ok(temp) = std::env::temp_dir().read_dir() {
        for entry in temp.flatten() {
            let name = entry.file_name();
            if let Some(name) = name.to_str() {
                if name.starts_with("levitaire-pin-") && name.ends_with(".png") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

/// 创建一张贴图：解码 base64 PNG 为 BGRA 像素，创建原生 Win32 窗口绘制。
/// 返回 pin id。
#[allow(clippy::too_many_arguments)]
pub fn create_pin(
    app: &tauri::AppHandle,
    base64_data: &str,
    x: i32,
    y: i32,
    _width: u32,
    _height: u32,
    border_color: &str,
    border_width: u32,
) -> Result<u32, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    const MAX_PNG_BYTES: usize = 64 * 1024 * 1024;
    const MAX_IMAGE_PIXELS: u64 = 25_000_000;
    let raw = if let Some(idx) = base64_data.find(',') {
        &base64_data[idx + 1..]
    } else {
        base64_data
    };
    if raw.len() > (MAX_PNG_BYTES / 3 + 1) * 4 {
        return Err("贴图图片数据过大".into());
    }
    let bytes = STANDARD
        .decode(raw)
        .map_err(|e| format!("base64 解码失败: {}", e))?;
    if bytes.len() > MAX_PNG_BYTES {
        return Err("贴图图片数据过大".into());
    }

    // 解码 PNG 为 BGRA 像素
    let img = image::load_from_memory(&bytes).map_err(|e| format!("PNG 解码失败: {}", e))?;
    let (raw_width, raw_height) = image::GenericImageView::dimensions(&img);
    if u64::from(raw_width) * u64::from(raw_height) > MAX_IMAGE_PIXELS {
        return Err("贴图图片像素数量过大".into());
    }
    let rgba = img.to_rgba8();
    let (iw, ih) = (rgba.width() as i32, rgba.height() as i32);
    // RGBA → BGRA（GDI 使用 BGRA 字节序）
    let mut pixels = rgba.into_raw();
    for px in pixels.chunks_exact_mut(4) {
        px.swap(0, 2);
    }

    let border_width = border_width.clamp(
        crate::config::PIN_BORDER_MIN_WIDTH,
        crate::config::PIN_BORDER_MAX_WIDTH,
    ) as i32;
    let border_color = parse_colorref(border_color);
    create_pin_from_bgra(
        app,
        pixels,
        iw,
        ih,
        x,
        y,
        1.0,
        OPACITY_MAX,
        border_width,
        border_color,
    )
}

/// Create a pin from already decoded BGRA pixels. Used by mirror-copy actions
/// so the duplicate never goes through a lossy or redundant PNG round trip.
#[allow(clippy::too_many_arguments)]
fn create_pin_from_bgra(
    app: &tauri::AppHandle,
    pixels: Vec<u8>,
    width: i32,
    height: i32,
    x: i32,
    y: i32,
    scale: f32,
    opacity: u8,
    border_width: i32,
    border_color: COLORREF,
) -> Result<u32, String> {
    validate_pixels(&pixels, width, height)?;

    let id = PIN_ID.fetch_add(1, Ordering::SeqCst);

    let params = PinCreateParams {
        id,
        pixels,
        width,
        height,
        x,
        y,
        scale,
        opacity,
        border_width,
        border_color,
    };

    // 登记占位（hwnd 稍后由窗口线程回填）
    pins_locked(|m| {
        m.insert(
            id,
            PinWindow {
                hwnd: 0,
                close_requested: false,
            },
        );
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
        app,
        id,
        pixels: params.pixels,
        width: params.width,
        height: params.height,
        scale: params.scale,
        opacity: params.opacity,
        border_width: params.border_width,
        border_color: params.border_color,
        show_scale_until: None,
        last_context_menu_at: None,
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

        // 窗口尺寸 = 图片 + 2*边框宽度，位置左上角向左上偏移边框宽度，
        // 使图片内容仍精确覆盖原选区位置，边框与发光画在图片外侧。
        let win_w = scaled_dimension(params.width, params.scale) + params.border_width * 2;
        let win_h = scaled_dimension(params.height, params.scale) + params.border_width * 2;
        let win_x = params.x - params.border_width;
        let win_y = params.y - params.border_width;

        // CreateWindowExW does not take ownership of the user-data pointer when
        // creation fails. Keep the raw pointer so the failure path can reclaim
        // PinState (including the potentially large pixel buffer).
        let state_ptr = Box::into_raw(state);
        let hwnd = match CreateWindowExW(
            ex_style,
            PIN_CLASS_NAME,
            w!("Levitaire Pin"),
            style,
            win_x,
            win_y,
            win_w,
            win_h,
            None,
            None,
            Some(hinst.into()),
            Some(state_ptr as *const _),
        ) {
            Ok(hwnd) => hwnd,
            Err(e) => {
                // No WM_NCDESTROY is delivered for a failed creation, so the
                // window procedure cannot release this allocation for us.
                drop(Box::from_raw(state_ptr));
                return Err(format!("CreateWindowExW failed: {}", e));
            }
        };

        // 初始化分层窗口 alpha，否则 layered 窗口默认不可见
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), params.opacity, LWA_ALPHA);
        // 属性就绪后再显示，SW_SHOWNOACTIVATE 避免贴图弹出抢走当前焦点
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);

        let hwnd_isize = hwnd.0 as isize;
        crate::utils::logger::log(
            "screenshot",
            &format!("create_pin id={} hwnd={:p}", id, hwnd.0),
        );

        // 回填 hwnd 到 PINS
        let close_requested = pins_locked(|m| {
            if let Some(p) = m.get_mut(&id) {
                let req = p.close_requested;
                p.hwnd = hwnd_isize;
                req
            } else {
                // 记录已被移除（占位期 close_pin 移除路径），正常关闭本窗口
                true
            }
        });

        // 检查窗口创建期间（占位期）是否已收到关闭请求。
        // 若收到，立即销毁本窗口：WM_NCDESTROY 会释放 PinState 并 PostQuitMessage 退出消息循环，
        // 随后 remove 记录并结束线程，从而杜绝「窗口已创建却无人能关闭」的窗口+线程泄漏。
        if close_requested {
            crate::utils::logger::log(
                "screenshot",
                &format!(
                    "pin id={} close requested during window creation, destroying",
                    id
                ),
            );
            let _ = DestroyWindow(hwnd);
        };

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
    }

    Ok(())
}

fn validate_pixels(pixels: &[u8], width: i32, height: i32) -> Result<(), String> {
    if width <= 0 || height <= 0 {
        return Err("贴图尺寸无效".to_string());
    }
    let expected = usize::try_from((width as u64) * (height as u64) * 4)
        .map_err(|_| "贴图尺寸溢出".to_string())?;
    if pixels.len() != expected {
        return Err("贴图像素尺寸与数据不匹配".to_string());
    }
    Ok(())
}

fn scaled_dimension(value: i32, scale: f32) -> i32 {
    ((value as f32 * scale).round() as i32).max(1)
}

/// Convert a validated #RRGGBB value to the COLORREF byte order (0x00BBGGRR).
/// Invalid values fall back to the default cyan used by older pin windows.
fn parse_colorref(value: &str) -> COLORREF {
    let hex = value.trim().strip_prefix('#').unwrap_or_default();
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return parse_colorref(crate::config::DEFAULT_PIN_BORDER_COLOR);
    }
    let Ok(rgb) = u32::from_str_radix(hex, 16) else {
        return parse_colorref(crate::config::DEFAULT_PIN_BORDER_COLOR);
    };
    let red = rgb >> 16;
    let green = (rgb >> 8) & 0xff;
    let blue = rgb & 0xff;
    COLORREF(red | (green << 8) | (blue << 16))
}

fn transform_bgra(
    pixels: &[u8],
    width: i32,
    height: i32,
    transform: PinTransform,
) -> Result<(Vec<u8>, i32, i32), String> {
    validate_pixels(pixels, width, height)?;
    let (out_width, out_height) = match transform {
        PinTransform::RotateLeft | PinTransform::RotateRight => (height, width),
        PinTransform::FlipHorizontal | PinTransform::FlipVertical => (width, height),
    };
    let mut output = vec![0; pixels.len()];
    let source_width = width as usize;
    let source_height = height as usize;
    let destination_width = out_width as usize;
    for y in 0..source_height {
        for x in 0..source_width {
            let (dest_x, dest_y) = match transform {
                PinTransform::RotateLeft => (y, source_width - 1 - x),
                PinTransform::RotateRight => (source_height - 1 - y, x),
                PinTransform::FlipHorizontal => (source_width - 1 - x, y),
                PinTransform::FlipVertical => (x, source_height - 1 - y),
            };
            let source = (y * source_width + x) * 4;
            let destination = (dest_y * destination_width + dest_x) * 4;
            output[destination..destination + 4].copy_from_slice(&pixels[source..source + 4]);
        }
    }
    Ok((output, out_width, out_height))
}

unsafe fn resize_pin_window_to_content(hwnd: HWND, state: &PinState) {
    let _ = SetWindowPos(
        hwnd,
        None,
        0,
        0,
        scaled_dimension(state.width, state.scale) + state.border_width * 2,
        scaled_dimension(state.height, state.scale) + state.border_width * 2,
        SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOCOPYBITS | SWP_NOMOVE,
    );
}

unsafe fn apply_transform(hwnd: HWND, transform: PinTransform) {
    let state_ptr = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
        hwnd,
        windows::Win32::UI::WindowsAndMessaging::GWL_USERDATA,
    ) as *mut PinState;
    if state_ptr.is_null() {
        return;
    }
    let state = &mut *state_ptr;
    let Ok((pixels, width, height)) =
        transform_bgra(&state.pixels, state.width, state.height, transform)
    else {
        return;
    };
    state.pixels = pixels;
    state.width = width;
    state.height = height;
    resize_pin_window_to_content(hwnd, state);
    let _ = windows::Win32::Graphics::Gdi::InvalidateRect(Some(hwnd), None, false);
}

unsafe fn duplicate_transformed_pin(hwnd: HWND, transform: PinTransform) {
    let state_ptr = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
        hwnd,
        windows::Win32::UI::WindowsAndMessaging::GWL_USERDATA,
    ) as *mut PinState;
    if state_ptr.is_null() {
        return;
    }
    let state = &*state_ptr;
    let Ok((pixels, width, height)) =
        transform_bgra(&state.pixels, state.width, state.height, transform)
    else {
        return;
    };
    let mut rect = RECT::default();
    let _ = GetWindowRect(hwnd, &mut rect);
    // Offset the new pin so the two images are both immediately visible.
    let x = rect.left.saturating_add(state.border_width + 24);
    let y = rect.top.saturating_add(state.border_width + 24);
    let _ = create_pin_from_bgra(
        &state.app,
        pixels,
        width,
        height,
        x,
        y,
        state.scale,
        state.opacity,
        state.border_width,
        state.border_color,
    );
}

/// 窗口过程
/// Duplicate the current pin without changing its pixels.
unsafe fn duplicate_pin(hwnd: HWND) {
    let state_ptr = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
        hwnd,
        windows::Win32::UI::WindowsAndMessaging::GWL_USERDATA,
    ) as *mut PinState;
    if state_ptr.is_null() {
        return;
    }
    let state = &*state_ptr;
    let mut rect = RECT::default();
    let _ = GetWindowRect(hwnd, &mut rect);
    // Offset the new pin so both identical images remain visible.
    let x = rect.left.saturating_add(state.border_width + 24);
    let y = rect.top.saturating_add(state.border_width + 24);
    let _ = create_pin_from_bgra(
        &state.app,
        state.pixels.clone(),
        state.width,
        state.height,
        x,
        y,
        state.scale,
        state.opacity,
        state.border_width,
        state.border_color,
    );
}

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

            // 图片绘制到边框内侧，边框完全位于图片外侧。
            let img_x = state.border_width;
            let img_y = state.border_width;
            let img_w = cw - state.border_width * 2;
            let img_h = ch - state.border_width * 2;
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

            // layered LWA_ALPHA 下整体透明度调节会一并作用到边框，符合预期。
            draw_border(mem_dc, cw, ch, state.border_width, state.border_color);

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
        // The whole pin is hit-tested as HTCAPTION to enable native dragging.
        // That routes a right click through WM_NCRBUTTONUP, and Windows does
        // not reliably follow it with WM_CONTEXTMENU for a popup window.
        // Handle both message paths explicitly so the menu always opens.
        WM_NCRBUTTONUP | WM_RBUTTONUP => {
            show_context_menu(hwnd);
            LRESULT(0)
        }
        WM_CONTEXTMENU => {
            show_context_menu(hwnd);
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
                CMD_ROTATE_LEFT => apply_transform(hwnd, PinTransform::RotateLeft),
                CMD_ROTATE_RIGHT => apply_transform(hwnd, PinTransform::RotateRight),
                CMD_FLIP_HORIZONTAL => apply_transform(hwnd, PinTransform::FlipHorizontal),
                CMD_FLIP_VERTICAL => apply_transform(hwnd, PinTransform::FlipVertical),
                CMD_DUPLICATE_MIRROR => duplicate_pin(hwnd),
                CMD_DUPLICATE_HORIZONTAL_MIRROR => {
                    duplicate_transformed_pin(hwnd, PinTransform::FlipHorizontal)
                }
                CMD_DUPLICATE_VERTICAL_MIRROR => {
                    duplicate_transformed_pin(hwnd, PinTransform::FlipVertical)
                }
                CMD_OCR => start_pin_ocr(hwnd),
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

/// Run OCR on the pin's original pixels and publish the result to the frontend.
/// The model can take a while to initialize, so keep the Win32 message thread responsive.
unsafe fn start_pin_ocr(hwnd: HWND) {
    let state_ptr = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
        hwnd,
        windows::Win32::UI::WindowsAndMessaging::GWL_USERDATA,
    ) as *mut PinState;
    if state_ptr.is_null() {
        return;
    }
    let state = &*state_ptr;
    let app = state.app.clone();
    let pin_id = state.id;
    let pixels = state.pixels.clone();
    let width = state.width;
    let height = state.height;
    std::thread::spawn(move || {
        let result = (|| -> Result<String, String> {
            let service =
                crate::ocr::ensure_ocr_service().ok_or_else(|| "OCR 服务初始化失败".to_string())?;
            let guard = service
                .lock()
                .map_err(|e| format!("OCR 服务锁失败: {}", e))?;
            let result = guard
                .recognize_bgra(&pixels, width as u32, height as u32)
                .map_err(|e| e.to_string())?;
            Ok(result.text)
        })();
        let payload = match result {
            Ok(text) => serde_json::json!({ "pinId": pin_id, "text": text }),
            Err(error) => serde_json::json!({ "pinId": pin_id, "error": error }),
        };
        let _ = app.emit("pin-ocr-result", payload);
    });
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

    state.scale = new_scale;

    // 以窗口左上角为缩放中心（同 Snipaste）：位置不变，只改尺寸。
    // SWP_NOMOVE 忽略 x/y；SWP_NOCOPYBITS 禁止系统复制旧客户区（昂贵且无意义，因全量重绘）。
    resize_pin_window_to_content(hwnd, state);

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

/// 绘制可配置的实色边框，宽度为 1-8 个逻辑像素。
unsafe fn draw_border(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    cw: i32,
    ch: i32,
    border_width: i32,
    color: COLORREF,
) {
    for inset in 0..border_width {
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

/// 弹出贴图右键菜单。原地变换、镜像副本和导出分组排列，避免
/// "翻转当前图" 与 "复制镜像" 两类操作混淆。
unsafe fn show_context_menu(hwnd: HWND) {
    let state_ptr = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
        hwnd,
        windows::Win32::UI::WindowsAndMessaging::GWL_USERDATA,
    ) as *mut PinState;
    if state_ptr.is_null() {
        return;
    }
    let state = &mut *state_ptr;
    let now = std::time::Instant::now();
    if state
        .last_context_menu_at
        .map(|last| now.duration_since(last).as_millis() < 120)
        .unwrap_or(false)
    {
        return;
    }
    state.last_context_menu_at = Some(now);

    let mut cursor = POINT::default();
    let _ = GetCursorPos(&mut cursor);
    let _ = state.app.emit_to(
        "orb",
        "pin-context-menu-request",
        serde_json::json!({ "source": "pin", "x": cursor.x, "y": cursor.y, "pinId": state.id }),
    );
}

/// 生成应用当前缩放与透明度后的 RGBA 像素（供「另存为/复制」导出）。
/// 屏幕显示效果来自 WM_PAINT 的 StretchDIBits（按 state.scale 拉伸）与
/// SetLayeredWindowAttributes(LWA_ALPHA)（按 state.opacity 调透明度）；
/// 导出时必须复现同样变换，否则得到的是原始未调整图像（所见与所得不一致）。
/// 像素数据与宽高不一致时返回 Err。
/// 成功时返回 (RGBA 像素, 宽, 高)。
fn render_pin_rgba(
    pixels: &[u8],
    width: i32,
    height: i32,
    scale: f32,
    opacity: u8,
) -> Result<(Vec<u8>, u32, u32), String> {
    // BGRA → RGBA（image crate 使用 RGBA 字节序）
    let mut rgba = Vec::with_capacity(pixels.len());
    for chunk in pixels.chunks_exact(4) {
        rgba.push(chunk[2]); // R
        rgba.push(chunk[1]); // G
        rgba.push(chunk[0]); // B
        rgba.push(chunk[3]); // A
    }
    let src_w = width as u32;
    let src_h = height as u32;
    let img = image::RgbaImage::from_raw(src_w, src_h, rgba)
        .ok_or_else(|| "贴图像素尺寸与数据长度不匹配".to_string())?;

    // 缩放：与 handle_wheel 的窗口尺寸计算保持一致（round(原尺寸*scale)）
    let dst_w = ((width as f32 * scale).round().max(1.0)) as u32;
    let dst_h = ((height as f32 * scale).round().max(1.0)) as u32;
    let scaled = if (dst_w, dst_h) != (src_w, src_h) {
        image::imageops::resize(&img, dst_w, dst_h, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    // 透明度：LWA_ALPHA 作用于整窗口，此处等效地乘到每个像素的 alpha 通道
    let mut out = scaled.into_raw();
    let alpha_factor = opacity as f32 / 255.0;
    if alpha_factor < 1.0 {
        for px in out.chunks_exact_mut(4) {
            px[3] = ((px[3] as f32) * alpha_factor).round() as u8;
        }
    }
    Ok((out, dst_w, dst_h))
}

/// 把当前贴图（含缩放/透明度调整）以 CF_DIB 复制到剪贴板。
unsafe fn copy_pin_to_clipboard(hwnd: HWND) -> Result<(), String> {
    let state_ptr = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
        hwnd,
        windows::Win32::UI::WindowsAndMessaging::GWL_USERDATA,
    ) as *mut PinState;
    if state_ptr.is_null() {
        return Err("贴图状态丢失".into());
    }
    let state = &*state_ptr;

    // 应用当前缩放与透明度（所见即所得），再转回 BGRA 供 DIB 使用
    let (rgba, width, height) = render_pin_rgba(
        &state.pixels,
        state.width,
        state.height,
        state.scale,
        state.opacity,
    )?;
    let mut pixels = Vec::with_capacity(rgba.len());
    for chunk in rgba.chunks_exact(4) {
        pixels.push(chunk[2]);
        pixels.push(chunk[1]);
        pixels.push(chunk[0]);
        pixels.push(chunk[3]);
    }

    // 构造 BITMAPINFO + 像素（BGRA，自上而下 biHeight 为负）
    let header_size = std::mem::size_of::<BITMAPINFOHEADER>();
    let pixels_len = pixels.len();
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
        biWidth: width as i32,
        biHeight: height as i32, // 正高度 = 自下而上
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
    let row = (width as usize) * 4;
    let rows = height as usize;
    let src = &pixels;
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
/// 故此处仅克隆像素与变换参数（owned），把渲染（缩放/透明度）、PNG 编码、对话框与文件 IO
/// 全部移到独立线程，既避免重入 wndproc，也不让大图放大渲染冻结贴图消息循环。
/// 对话框期间临时切换窗口置顶（贴图窗是 `WS_EX_TOPMOST`）。
///
/// 为什么需要：rfd 的保存对话框没有 owner（`Show(d, NULL)`），而实测置顶窗会把
/// **无主**对话框完全盖住、`SetForegroundWindow` 也抬不上来 —— 用户会以为
/// 「点了保存没有任何反应」。这里在打开对话框前取消置顶、关闭后恢复。
unsafe fn apply_window_topmost(hwnd: HWND, topmost: bool) {
    // 贴图窗不是保存对话框的 owner（对话框无 owner），所以对话框开着时用户仍能关掉贴图。
    // 那之后本函数会被再次调用（恢复置顶那一次），此时 HWND 已失效：直接 SetWindowPos
    // 轻则静默失败，重则该句柄值已被系统复用给其他窗口，就会把无关窗口设成置顶。
    if !IsWindow(Some(hwnd)).as_bool() {
        return;
    }
    let insert_after = if topmost {
        HWND_TOPMOST
    } else {
        HWND_NOTOPMOST
    };
    let _ = SetWindowPos(
        hwnd,
        Some(insert_after),
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
    );
}

/// 当前**可见且置顶**的贴图窗 HWND（供文件对话框期间临时取消置顶）。
///
/// 为什么不复用 `commands::OWN_WINDOW_LABELS`：贴图窗是 `CreateWindowExW` 建的原生窗，
/// 既不在那份 label 清单里，也不归 tao 管（没有 `WebviewWindow` 句柄可查）。
/// 漏掉它的后果与「只设 owner」是同一个坑：用户钉在屏幕上的截图正好压在文件对话框上时，
/// 对话框仍被 `WS_EX_TOPMOST` 的贴图窗挡住（rfd 的对话框没有 owner）。
pub fn topmost_pin_hwnds() -> Vec<isize> {
    use windows::Win32::UI::WindowsAndMessaging as wam;

    let all: Vec<isize> = pins_locked(|map| {
        map.values()
            .map(|pin| pin.hwnd)
            .filter(|raw| *raw != 0)
            .collect()
    });
    all.into_iter()
        .filter(|raw| {
            let hwnd = HWND(*raw as *mut std::ffi::c_void);
            unsafe {
                IsWindow(Some(hwnd)).as_bool()
                    && wam::IsWindowVisible(hwnd).as_bool()
                    && (wam::GetWindowLongPtrW(hwnd, wam::GWL_EXSTYLE) as u32
                        & WS_EX_TOPMOST.0 as u32)
                        != 0
            }
        })
        .collect()
}

/// 取消 / 恢复给定贴图窗的置顶（成对使用，`topmost=false` 后必须再以 `true` 调一次）。
///
/// 用原生 `SetWindowPos` 而不是 tao 的 `set_always_on_top`：贴图窗不归 tao 管，走 tao
/// 只会改它自己内部的标志、窗口的实际 Z 序不变。HWND 失效判定在 `apply_window_topmost` 内。
pub fn set_pins_topmost(hwnds: &[isize], topmost: bool) {
    for raw in hwnds {
        let hwnd = HWND(*raw as *mut std::ffi::c_void);
        unsafe { apply_window_topmost(hwnd, topmost) };
    }
}

unsafe fn save_pin_as(hwnd: HWND) -> Result<(), String> {
    let state_ptr = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
        hwnd,
        windows::Win32::UI::WindowsAndMessaging::GWL_USERDATA,
    ) as *mut PinState;
    if state_ptr.is_null() {
        return Err("贴图状态丢失".into());
    }
    let state = &*state_ptr;

    // 克隆像素与变换参数（owned），渲染 + PNG 编码 + 对话框 + 写入全部移入独立线程：
    // 1) 避免 rfd 模态对话框重入 wndproc 导致 PinState 悬垂；2) 大图放大渲染不冻结贴图消息循环。
    let pixels = state.pixels.clone();
    let width = state.width;
    let height = state.height;
    let scale = state.scale;
    let opacity = state.opacity;
    // HWND 不含 Send，跨线程只带裸地址、进线程再还原
    let hwnd_raw = hwnd.0 as isize;

    std::thread::spawn(move || {
        // 应用当前缩放与透明度（所见即所得）
        let (rgba, w, h) = match render_pin_rgba(&pixels, width, height, scale, opacity) {
            Ok(v) => v,
            Err(e) => {
                crate::utils::logger::log("screenshot", &format!("save_pin_as 渲染失败: {}", e));
                return;
            }
        };
        let img = match image::RgbaImage::from_raw(w, h, rgba) {
            Some(img) => image::DynamicImage::ImageRgba8(img),
            None => {
                crate::utils::logger::log("screenshot", "save_pin_as 构造 RgbaImage 失败");
                return;
            }
        };
        let mut png_buf: Vec<u8> = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut png_buf);
        if let Err(e) = img.write_to(&mut cursor, image::ImageFormat::Png) {
            crate::utils::logger::log("screenshot", &format!("save_pin_as PNG 编码失败: {}", e));
            return;
        }

        let pin_hwnd = HWND(hwnd_raw as *mut std::ffi::c_void);
        // 打开对话框期间取消置顶，避免它被自己这扇置顶窗盖住（见 apply_window_topmost 注释）
        unsafe { apply_window_topmost(pin_hwnd, false) };
        let path = rfd::FileDialog::new()
            .set_file_name("screenshot.png")
            .add_filter("PNG 图片", &["png"])
            .save_file();
        unsafe { apply_window_topmost(pin_hwnd, true) };
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
    let hwnd_isize = pins_locked(|m| {
        let Some(p) = m.get_mut(&id) else {
            // 记录不存在（窗口已彻底清理或建窗失败已移除），无需操作
            return 0;
        };
        if p.hwnd != 0 {
            p.hwnd
        } else {
            // 占位期（窗口线程尚未回填 hwnd）：不移除记录，仅标记待关闭。
            // 若此处直接 remove，窗口线程稍后仍会照常建窗并显示，记录已删导致
            // 窗口无人能关闭、消息循环永不退出，造成窗口+线程永久泄漏。
            // 标记后由窗口线程在回填 hwnd 时检测 close_requested 并自行销毁窗口。
            p.close_requested = true;
            0
        }
    });
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
    }
    Ok(())
}

/// 关闭当前全部贴图窗（截图工具被禁用时调用）。
///
/// 贴图窗是独立原生窗口，不随 screenshot-overlay 隐藏而消失：不显式关闭的话，
/// 「全部关闭」之后桌面上仍然留着已钉的截图（便利贴禁用会销毁便签窗，这里与之保持一致）。
/// 逐个复用 close_pin，占位期（hwnd 尚未回填）的窗口也能被正确标记关闭。
pub fn close_all_pins(app: &tauri::AppHandle) {
    let ids: Vec<u32> = pins_locked(|m| m.keys().copied().collect());
    for id in ids {
        let _ = close_pin(app, id);
    }
}

/// Dispatch a styled WebView context-menu action back to the pin's owning
/// window thread. Keeping this dispatch as WM_COMMAND preserves all existing
/// transform, clipboard, and save behavior.
pub fn context_menu_action(id: u32, action: &str) -> Result<(), String> {
    let command = match action {
        "close" => CMD_CLOSE,
        "copy" => CMD_COPY,
        "save" => CMD_SAVE,
        "rotate-left" => CMD_ROTATE_LEFT,
        "rotate-right" => CMD_ROTATE_RIGHT,
        "flip-horizontal" => CMD_FLIP_HORIZONTAL,
        "flip-vertical" => CMD_FLIP_VERTICAL,
        "duplicate-mirror" => CMD_DUPLICATE_MIRROR,
        "duplicate-horizontal-mirror" => CMD_DUPLICATE_HORIZONTAL_MIRROR,
        "duplicate-vertical-mirror" => CMD_DUPLICATE_VERTICAL_MIRROR,
        "ocr" => CMD_OCR,
        _ => return Err("未知的贴图菜单操作".into()),
    };
    let hwnd_isize = pins_locked(|m| m.get(&id).map(|p| p.hwnd).unwrap_or(0));
    if hwnd_isize == 0 {
        return Err("贴图窗口尚未就绪或已关闭".into());
    }
    unsafe {
        PostMessageW(
            Some(HWND(hwnd_isize as *mut std::ffi::c_void)),
            WM_COMMAND,
            WPARAM(command as usize),
            LPARAM(0),
        )
        .map_err(|error| format!("发送贴图菜单操作失败: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_colorref, render_pin_rgba, transform_bgra, PinTransform};

    /// 2x2 BGRA 像素：红 / 绿 / 蓝 / 白（各 alpha=255）。
    fn sample_bgra() -> Vec<u8> {
        vec![
            0, 0, 255, 255, // 红
            0, 255, 0, 255, // 绿
            255, 0, 0, 255, // 蓝
            255, 255, 255, 255, // 白
        ]
    }

    #[test]
    fn no_transform_keeps_pixels() {
        let px = sample_bgra();
        let (rgba, w, h) = render_pin_rgba(&px, 2, 2, 1.0, 255).unwrap();
        assert_eq!((w, h), (2, 2));
        assert_eq!(rgba.len(), px.len());
        // 首像素 BGRA(0,0,255,255) → RGBA(255,0,0,255)
        assert_eq!(&rgba[..4], &[255, 0, 0, 255]);
    }

    #[test]
    fn scale_upsizes_dimensions() {
        let px = sample_bgra();
        let (rgba, w, h) = render_pin_rgba(&px, 2, 2, 2.0, 255).unwrap();
        assert_eq!((w, h), (4, 4));
        assert_eq!(rgba.len(), 4 * 4 * 4);
    }

    #[test]
    fn scale_rounds_like_handle_wheel() {
        let px = sample_bgra();
        // round(2*1.4)=3，与 handle_wheel 的窗口内容尺寸计算一致
        let (_, w, h) = render_pin_rgba(&px, 2, 2, 1.4, 255).unwrap();
        assert_eq!((w, h), (3, 3));
    }

    #[test]
    fn opacity_scales_alpha() {
        let px = sample_bgra();
        let (rgba, _, _) = render_pin_rgba(&px, 2, 2, 1.0, 128).unwrap();
        // alpha_factor = 128/255，255 → round(255*128/255) = 128
        for c in rgba.chunks_exact(4) {
            assert_eq!(c[3], 128);
        }
    }

    #[test]
    fn mismatched_size_returns_err() {
        let px = sample_bgra(); // 16 字节
        assert!(render_pin_rgba(&px, 3, 2, 1.0, 255).is_err());
    }

    #[test]
    fn parse_colorref_converts_rgb_order() {
        assert_eq!(parse_colorref("#00C8FF").0, 0x00FF_C800);
        assert_eq!(parse_colorref("invalid").0, 0x00FF_C800);
    }

    #[test]
    fn rotate_right_swaps_dimensions_and_pixel_order() {
        let (pixels, width, height) =
            transform_bgra(&sample_bgra(), 2, 2, PinTransform::RotateRight).unwrap();
        assert_eq!((width, height), (2, 2));
        // [blue, red, white, green] in BGRA after clockwise rotation.
        assert_eq!(
            &pixels,
            &[255, 0, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 255, 0, 255,]
        );
    }

    #[test]
    fn rotate_left_swaps_non_square_dimensions() {
        let pixels = vec![
            1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255, 4, 4, 4, 255, 5, 5, 5, 255, 6, 6, 6, 255,
        ];
        let (rotated, width, height) =
            transform_bgra(&pixels, 3, 2, PinTransform::RotateLeft).unwrap();
        assert_eq!((width, height), (2, 3));
        assert_eq!(rotated[0], 3);
        assert_eq!(rotated[4], 6);
    }

    #[test]
    fn horizontal_and_vertical_flip_keep_dimensions() {
        let px = sample_bgra();
        let (horizontal, _, _) = transform_bgra(&px, 2, 2, PinTransform::FlipHorizontal).unwrap();
        let (vertical, _, _) = transform_bgra(&px, 2, 2, PinTransform::FlipVertical).unwrap();
        assert_eq!(&horizontal[..4], &[0, 255, 0, 255]);
        assert_eq!(&vertical[..4], &[255, 0, 0, 255]);
        assert_eq!(&vertical[8..12], &[0, 0, 255, 255]);
    }
}
