//! 一次性可行性探针（**不属于产品代码**，结论确认后可删除）。
//!
//! 目的：验证 `WDA_EXCLUDEFROMCAPTURE` 对录屏所用「屏幕 DC + BitBlt」截图路径是否生效。
//! 录屏抓帧走的是 `screenshot::capture_screen_region`（GetDC(None) + BitBlt SRCCOPY），
//! 本探针逐字复刻该逻辑，只是采样一个很小的矩形并统计纯红像素。
//!
//! 流程：
//!   1. 建一个不透明、置顶、不抢焦点的纯红原生窗（无 WS_EX_LAYERED，模拟「原生不透明指示窗」）
//!   2. 未加标记时采样 —— 预期能截到红（证明采样方法本身有效）
//!   3. `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` 后再采样
//!   4. 若仍能截到，再做一次 hide/show 重断言后采样（已知某些实现需要重新 show 才生效）
//!
//! 运行：cd src-tauri && cargo run --example wda_probe

use std::time::{Duration, Instant};

use windows::core::w;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CombineRgn, CreateCompatibleBitmap, CreateCompatibleDC, CreateRectRgn,
    CreateSolidBrush, DeleteDC, DeleteObject, EndPaint, FillRect, GetDC, GetDIBits, InvalidateRect,
    ReleaseDC, SelectObject, SetWindowRgn, UpdateWindow, BITMAPINFO, BITMAPINFOHEADER,
    DIB_RGB_COLORS, RGN_DIFF, SRCCOPY,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect,
    GetWindowDisplayAffinity, GetWindowRect, LoadCursorW, PeekMessageW, RegisterClassExW,
    SetLayeredWindowAttributes, SetWindowDisplayAffinity, SetWindowPos, ShowWindow,
    TranslateMessage, WindowFromPoint, CS_HREDRAW, CS_VREDRAW, HWND_TOPMOST, IDC_ARROW, LWA_ALPHA,
    MSG, PM_REMOVE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE, SW_SHOWNOACTIVATE,
    WDA_EXCLUDEFROMCAPTURE, WM_DESTROY, WM_PAINT, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

const CLASS_NAME: windows::core::PCWSTR = w!("LevitaireWdaProbe");
/// 纯红（COLORREF 为 0x00BBGGRR）
const PROBE_RED: u32 = 0x0000_00FF;

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut ps = Default::default();
            let hdc = BeginPaint(hwnd, &mut ps);
            let mut rc = RECT::default();
            let _ = GetClientRect(hwnd, &mut rc);
            let brush = CreateSolidBrush(COLORREF(PROBE_RED));
            FillRect(hdc, &rc, brush);
            let _ = DeleteObject(brush.into());
            let _ = EndPaint(hwnd, &ps);
            LRESULT(0)
        }
        WM_DESTROY => LRESULT(0),
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// 抽干消息队列 `duration` 长的时间，让窗口真正完成绘制。
fn pump(duration: Duration) {
    let deadline = Instant::now() + duration;
    let mut msg = MSG::default();
    while Instant::now() < deadline {
        while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// 与 `screenshot::capture_screen_region` 相同的截屏路径：GetDC(None) + BitBlt SRCCOPY。
fn capture_region(left: i32, top: i32, width: u32, height: u32) -> Result<Vec<u8>, String> {
    unsafe {
        let screen_dc = GetDC(None);
        if screen_dc.is_invalid() {
            return Err("GetDC failed".into());
        }
        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        if mem_dc.is_invalid() {
            let _ = ReleaseDC(None, screen_dc);
            return Err("CreateCompatibleDC failed".into());
        }
        let bitmap = CreateCompatibleBitmap(screen_dc, width as i32, height as i32);
        if bitmap.is_invalid() {
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(None, screen_dc);
            return Err("CreateCompatibleBitmap failed".into());
        }
        let old_bmp = SelectObject(mem_dc, bitmap.into());
        if BitBlt(
            mem_dc,
            0,
            0,
            width as i32,
            height as i32,
            Some(screen_dc),
            left,
            top,
            SRCCOPY,
        )
        .is_err()
        {
            SelectObject(mem_dc, old_bmp);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(None, screen_dc);
            return Err("BitBlt failed".into());
        }

        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
        GetDIBits(
            mem_dc,
            bitmap,
            0,
            height,
            Some(pixels.as_mut_ptr() as *mut _),
            &bmi as *const _ as *mut _,
            DIB_RGB_COLORS,
        );

        SelectObject(mem_dc, old_bmp);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(None, screen_dc);
        Ok(pixels)
    }
}

/// 统计 BGRA 缓冲里「足够红」的像素数。
fn count_red(pixels: &[u8]) -> usize {
    pixels
        .chunks_exact(4)
        .filter(|p| p[2] > 200 && p[1] < 60 && p[0] < 60)
        .count()
}

/// 采样窗口内部区域（内缩 12px，避开边缘缩放混色），返回 (红像素数, 总像素数)。
fn probe(hwnd: HWND) -> (usize, usize) {
    let mut rc = RECT::default();
    unsafe {
        let _ = GetWindowRect(hwnd, &mut rc);
    }
    let inset = 12;
    let left = rc.left + inset;
    let top = rc.top + inset;
    let width = (rc.right - rc.left - inset * 2).max(1) as u32;
    let height = (rc.bottom - rc.top - inset * 2).max(1) as u32;
    match capture_region(left, top, width, height) {
        Ok(pixels) => {
            let total = (width as usize) * (height as usize);
            (count_red(&pixels), total)
        }
        Err(e) => {
            println!("    !! 采样失败: {}", e);
            (0, 0)
        }
    }
}

/// `--frame` 模式：验证「空心呼吸框」这一具体做法 ——
/// `SetWindowRgn` 把窗口裁成只有 6px 边框的中空矩形，中间镂空处不是窗口的一部分，
/// 鼠标应当直接穿透；再确认边框本身也能被 WDA 排除出 BitBlt。
unsafe fn run_frame_mode() {
    let hinst = GetModuleHandleW(None).expect("GetModuleHandleW");
    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(wnd_proc),
        hInstance: hinst.into(),
        lpszClassName: CLASS_NAME,
        hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
        ..Default::default()
    };
    let _ = RegisterClassExW(&wc);

    let (x, y, w, h) = (140, 140, 760, 460);
    let border = 6;
    let hwnd = match CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED,
        CLASS_NAME,
        w!("WDA Probe Frame"),
        WS_POPUP,
        x,
        y,
        w,
        h,
        None,
        None,
        Some(hinst.into()),
        None,
    ) {
        Ok(hwnd) => hwnd,
        Err(e) => {
            println!("CreateWindowExW failed: {}", e);
            return;
        }
    };
    let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);

    // 空心区域：外矩形减去内矩形 → 只剩一圈边框
    let outer = CreateRectRgn(0, 0, w, h);
    let inner = CreateRectRgn(border, border, w - border, h - border);
    let frame = CreateRectRgn(0, 0, 0, 0);
    CombineRgn(Some(frame), Some(outer), Some(inner), RGN_DIFF);
    SetWindowRgn(hwnd, Some(frame), true);
    let _ = DeleteObject(outer.into());
    let _ = DeleteObject(inner.into());

    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    let _ = UpdateWindow(hwnd);
    pump(Duration::from_millis(800));

    println!("模式: 空心呼吸框（{}px 边框，{}x{}）", border, w, h);

    // 边框上取一条横条，中间取一块 —— 采样坐标直接用窗口 rect，无需换算
    let sample = |left: i32, top: i32, sw: u32, sh: u32| -> usize {
        capture_region(left, top, sw, sh)
            .map(|p| count_red(&p))
            .unwrap_or(0)
    };
    let edge_red = sample(x + 40, y + 2, 120, 3);
    let hole_red = sample(x + 200, y + 150, 160, 100);
    println!(
        "[1] 边框采样   : 红像素 {}（期望 >0，证明边框确实画出来了）",
        edge_red
    );
    println!(
        "[2] 中间镂空   : 红像素 {}（期望 0，证明中间真的是空的）",
        hole_red
    );

    let set_result = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
    pump(Duration::from_millis(400));
    let edge_after = sample(x + 40, y + 2, 120, 3);
    println!(
        "[3] 加标记后   : 边框红像素 {}（Set={:?}）→ {}",
        edge_after,
        set_result.is_ok(),
        if edge_after == 0 {
            "✅ 边框不进成片"
        } else {
            "❌ 仍被截到"
        }
    );

    let on_border = WindowFromPoint(POINT {
        x: x + 2,
        y: y + h / 2,
    });
    let in_hole = WindowFromPoint(POINT {
        x: x + w / 2,
        y: y + h / 2,
    });
    println!(
        "[4] 命中边框   : {}（期望是本窗）",
        if on_border == hwnd {
            "本窗 ✅"
        } else {
            "其它窗 ❌"
        }
    );
    println!(
        "[5] 命中镂空处 : {}（期望不是本窗 = 鼠标穿透、不挡下层应用）",
        if in_hole == hwnd {
            "本窗 ❌ 会挡住交互"
        } else {
            "穿透 ✅"
        }
    );

    println!();
    println!("边框保持显示 6 秒，可肉眼确认：屏幕上一个中空的绿色/红色矩形框。");
    pump(Duration::from_secs(6));
    let _ = DestroyWindow(hwnd);
    pump(Duration::from_millis(200));
}

/// `--prehidden` 模式：验证**生产代码的实际顺序**是否安全 ——
/// `indicator::create_frame` 是「先设 WDA、再 ShowWindow」，而 --frame 模式验证的是
/// 「窗口已显示后再设 WDA」。若标记对隐藏窗口不生效，回读检查会通过、呼吸框却照样
/// 被录进成片（最坏情况：成片边缘一圈绿边）。
///
/// 做法：同一位置先后建两扇结构完全相同的空心框 ——
///   A 不设标记（对照组，必须能截到红）
///   B 隐藏状态下设好标记再显示（生产顺序，必须截不到）
unsafe fn run_prehidden_mode() {
    let hinst = GetModuleHandleW(None).expect("GetModuleHandleW");
    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(wnd_proc),
        hInstance: hinst.into(),
        lpszClassName: CLASS_NAME,
        hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
        ..Default::default()
    };
    let _ = RegisterClassExW(&wc);

    let (x, y, w, h, border) = (160, 160, 720, 440, 6);
    let sample = |left: i32, top: i32, sw: u32, sh: u32| -> usize {
        capture_region(left, top, sw, sh)
            .map(|p| count_red(&p))
            .unwrap_or(0)
    };

    // 建一扇与生产代码同构的空心框：不透明边框 + LAYERED + TRANSPARENT + TOPMOST
    let build = |with_affinity: bool| -> Option<HWND> {
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TRANSPARENT,
            CLASS_NAME,
            w!("WDA Probe Prehidden"),
            WS_POPUP,
            x,
            y,
            w,
            h,
            None,
            None,
            Some(hinst.into()),
            None,
        )
        .ok()?;

        let outer = CreateRectRgn(0, 0, w, h);
        let inner = CreateRectRgn(border, border, w - border, h - border);
        let hollow = CreateRectRgn(0, 0, 0, 0);
        CombineRgn(Some(hollow), Some(outer), Some(inner), RGN_DIFF);
        SetWindowRgn(hwnd, Some(hollow), false);
        let _ = DeleteObject(outer.into());
        let _ = DeleteObject(inner.into());
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);

        // 生产顺序的关键一步：窗口此刻还是隐藏的
        if with_affinity {
            let set = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
            let mut current: u32 = 0;
            let got = GetWindowDisplayAffinity(hwnd, &mut current);
            println!(
                "    隐藏状态下设标记: Set={:?} Get={:?} 当前值=0x{:X}（期望 0x11）",
                set.is_ok(),
                got.is_ok(),
                current
            );
        }

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
        let _ = UpdateWindow(hwnd);
        pump(Duration::from_millis(800));
        Some(hwnd)
    };

    println!("模式: 生产顺序（先设 WDA、再显示）");

    let control = build(false).expect("对照组建窗失败");
    let control_red = sample(x + 40, y + 2, 120, 3);
    println!(
        "[1] 对照组（无标记，显示后才采样）: 边框红像素 {} → {}",
        control_red,
        if control_red > 0 {
            "能截到，说明采样位置正确"
        } else {
            "!! 截不到，后续结论不可信"
        }
    );
    pump(Duration::from_millis(300));
    let _ = DestroyWindow(control);
    pump(Duration::from_millis(300));

    let target = build(true).expect("被测组建窗失败");
    let target_red = sample(x + 40, y + 2, 120, 3);
    println!(
        "[2] 被测组（隐藏时设标记，显示后）: 边框红像素 {}",
        target_red
    );

    println!();
    if control_red > 0 && target_red == 0 {
        println!("结论：✅ 隐藏状态下设标记同样生效 —— 生产顺序安全，呼吸框不会进成片");
    } else if control_red > 0 {
        println!("结论：❌ 隐藏时设标记未生效 —— 必须改成显示之后再设 WDA 并回读确认");
    } else {
        println!("结论：⚠️ 对照组就没截到，本机环境（锁屏/RDP/DPI）下结果不可用");
    }

    pump(Duration::from_secs(6));
    let _ = DestroyWindow(target);
    pump(Duration::from_millis(200));
}

fn main() {
    if std::env::args().any(|a| a == "--frame") {
        unsafe { run_frame_mode() };
        return;
    }
    if std::env::args().any(|a| a == "--prehidden") {
        unsafe { run_prehidden_mode() };
        return;
    }
    unsafe {
        let hinst = GetModuleHandleW(None).expect("GetModuleHandleW");
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinst.into(),
            lpszClassName: CLASS_NAME,
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            ..Default::default()
        };
        let _ = RegisterClassExW(&wc);

        // 不带 WS_EX_LAYERED 的不透明原生窗；`--layered` 时改用分层半透明窗，
        // 用来判断「半透明」本身会不会触发项目里那个「加标记后整窗不可见」的坑。
        let layered = std::env::args().any(|a| a == "--layered");
        let mut ex_style = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
        if layered {
            ex_style |= WS_EX_LAYERED;
        }
        println!(
            "模式: {}",
            if layered {
                "WS_EX_LAYERED 半透明（alpha=200）"
            } else {
                "不透明原生窗"
            }
        );
        let hwnd = match CreateWindowExW(
            ex_style,
            CLASS_NAME,
            w!("WDA Probe"),
            WS_POPUP,
            120,
            120,
            360,
            200,
            None,
            None,
            Some(hinst.into()),
            None,
        ) {
            Ok(hwnd) => hwnd,
            Err(e) => {
                println!("CreateWindowExW failed: {}", e);
                return;
            }
        };

        if layered {
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 200, LWA_ALPHA);
        }
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let _ = UpdateWindow(hwnd);
        pump(Duration::from_millis(800));

        let mut rc = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rc);
        println!(
            "窗口 rect: ({}, {}) {}x{}",
            rc.left,
            rc.top,
            rc.right - rc.left,
            rc.bottom - rc.top
        );

        let (before_red, total) = probe(hwnd);
        println!(
            "[1] 未加标记   : 红像素 {}/{}  → {}",
            before_red,
            total,
            if before_red * 10 > total * 9 {
                "BitBlt 能看到该窗口（采样方法有效）"
            } else {
                "!! 采样不到窗口，后续结论不可信"
            }
        );

        let set_result = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
        let mut affinity: u32 = 0;
        let got = GetWindowDisplayAffinity(hwnd, &mut affinity);
        println!(
            "[2] 设置标记   : Set={:?} / Get={:?} / 当前值=0x{:X}（WDA_EXCLUDEFROMCAPTURE=0x11）",
            set_result.is_ok(),
            got.is_ok(),
            affinity
        );

        pump(Duration::from_millis(400));
        let (after_red, _) = probe(hwnd);
        println!("[3] 加标记后   : 红像素 {}/{}", after_red, total);

        // 某些实现需要重新 show / 完整重绘后才让标记生效
        let _ = InvalidateRect(Some(hwnd), None, true);
        let _ = UpdateWindow(hwnd);
        pump(Duration::from_millis(600));
        let (repaint_red, _) = probe(hwnd);
        println!("[4] 强制重绘后 : 红像素 {}/{}", repaint_red, total);

        // 已知某些框架在 hide/show 后会丢失该标记（Electron #29085），
        // 这里无条件测一遍，确定实现时是否需要 show 之后重新断言。
        let _ = ShowWindow(hwnd, SW_HIDE);
        pump(Duration::from_millis(250));
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let _ = UpdateWindow(hwnd);
        pump(Duration::from_millis(600));
        let hidden_red = probe(hwnd).0;
        println!("[5] hide/show 后: 红像素 {}/{}", hidden_red, total);

        let best = hidden_red.min(repaint_red).min(after_red);
        println!();
        if best == 0 && before_red > 0 {
            println!("结论：✅ BitBlt 尊重 WDA_EXCLUDEFROMCAPTURE —— 不会被录进视频");
        } else if before_red > 0 {
            println!("结论：❌ BitBlt 忽略该标记 —— 仍会把指示窗录进成片，C 方案不成立");
        } else {
            println!("结论：⚠️ 基础采样就没截到窗口，本机环境（锁屏/RDP/DPI 缩放）下结果不可用");
        }

        // 加了标记之后窗口是否仍是桌面上一个正常的、可命中的窗口
        let hit = WindowFromPoint(POINT {
            x: rc.left + 40,
            y: rc.top + 40,
        });
        println!(
            "[6] 命中测试   : WindowFromPoint → {} （期望等于窗口句柄 {:?}）",
            if hit == hwnd {
                "该窗口 ✅"
            } else {
                "其它窗口 ❌"
            },
            hwnd
        );

        println!();
        println!("窗口保持显示 10 秒，请肉眼确认屏幕左上角是否还有红色方块：");
        println!("  看得到 → 标记不会让窗口对用户隐身，C 方案成立");
        println!("  看不到 → 复现了项目注释里那个坑，得换实现方式");
        pump(Duration::from_secs(10));

        let _ = DestroyWindow(hwnd);
        pump(Duration::from_millis(200));
    }
}
