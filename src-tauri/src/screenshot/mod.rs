//! 屏幕截图模块：GDI 截屏 + PNG 编码。
//! 支持多显示器：overlay 覆盖整个虚拟桌面，capture 用 GetDC(None) 的虚拟桌面坐标系。

pub mod pin;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use windows::Win32::Foundation::{LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
    EnumDisplayMonitors, GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
    DIB_RGB_COLORS, SRCCOPY,
};

/// 虚拟桌面边界（所有显示器的并集，可能含负坐标）。
pub struct VirtualDesktopBounds {
    pub origin_x: i32,
    pub origin_y: i32,
    pub width: i32,
    pub height: i32,
}

/// 进入截图模式时截取的全屏纯净画面缓存。
/// 在 overlay 显示前截取，故不含任何截图 UI（选区框/遮罩），
/// capture_region/ocr_region 直接从此缓存裁剪选区，避免二次截屏把 overlay 截入底图，
/// 也避免 hide/show overlay 造成的闪烁。
/// 截图模式结束（cancel_screenshot）时清空以释放内存。
#[derive(Default)]
pub struct ScreenCache {
    pub pixels: std::sync::Mutex<Option<CachedScreen>>,
}

pub struct CachedScreen {
    pub bgra: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub origin_x: i32,
    pub origin_y: i32,
}

// 100 million BGRA pixels require about 381 MiB before PNG encoding. This still
// covers large multi-monitor desktops while rejecting malformed command input.
const MAX_SCREENSHOT_PIXELS: u64 = 100_000_000;

impl CachedScreen {
    /// 从缓存裁剪选区子区域（虚拟桌面物理坐标）
    pub fn crop(&self, left: i32, top: i32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        crop_screen_region(
            &self.bgra,
            self.width,
            self.height,
            self.origin_x,
            self.origin_y,
            left,
            top,
            width,
            height,
        )
    }
}

/// 枚举结果上下文，通过 LPARAM 指针传给回调，避免 static mut 数据竞争。
struct EnumCtx {
    min_x: i32,
    min_y: i32,
    max_x: i32,
    max_y: i32,
    count: i32,
}

/// 枚举所有显示器，返回虚拟桌面边界（并集）。
/// EnumDisplayMonitors 回调在同线程同步执行，故用栈上局部变量安全。
pub fn virtual_desktop_bounds() -> Result<VirtualDesktopBounds, String> {
    let mut ctx = EnumCtx {
        min_x: i32::MAX,
        min_y: i32::MAX,
        max_x: i32::MIN,
        max_y: i32::MIN,
        count: 0,
    };
    let lparam = LPARAM(&mut ctx as *mut EnumCtx as isize);
    let ok = unsafe { EnumDisplayMonitors(None, None, Some(enum_callback), lparam) };
    if !ok.as_bool() {
        return Err("EnumDisplayMonitors failed".into());
    }
    if ctx.count == 0 {
        return Err("未枚举到任何显示器".into());
    }
    Ok(VirtualDesktopBounds {
        origin_x: ctx.min_x,
        origin_y: ctx.min_y,
        width: ctx.max_x - ctx.min_x,
        height: ctx.max_y - ctx.min_y,
    })
}

unsafe extern "system" fn enum_callback(
    _hmonitor: windows::Win32::Graphics::Gdi::HMONITOR,
    _hdc: windows::Win32::Graphics::Gdi::HDC,
    lprcmonitor: *mut RECT,
    ldata: LPARAM,
) -> windows::core::BOOL {
    let ctx_ptr = ldata.0 as *mut EnumCtx;
    if !lprcmonitor.is_null() && !ctx_ptr.is_null() {
        let rc = &*lprcmonitor;
        let ctx = &mut *ctx_ptr;
        if rc.left < ctx.min_x {
            ctx.min_x = rc.left;
        }
        if rc.top < ctx.min_y {
            ctx.min_y = rc.top;
        }
        if rc.right > ctx.max_x {
            ctx.max_x = rc.right;
        }
        if rc.bottom > ctx.max_y {
            ctx.max_y = rc.bottom;
        }
        ctx.count += 1;
    }
    windows::core::BOOL::from(true)
}

/// 截取屏幕指定区域（虚拟桌面物理坐标），返回 BGRA 像素。
/// GetDC(None) 返回的 DC 覆盖整个虚拟桌面，坐标系即虚拟桌面屏幕坐标，
/// 因此跨显示器区域可直接用虚拟桌面坐标 BitBlt，无需逐屏拼接。
pub fn capture_screen_region(
    left: i32,
    top: i32,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 {
        return Err("截图区域尺寸为 0".into());
    }
    // 上界保护，防止异常输入导致 u32 乘法溢出或分配过大缓冲区
    if width > 32768 || height > 32768 {
        return Err("截图区域尺寸过大".into());
    }
    if u64::from(width) * u64::from(height) > MAX_SCREENSHOT_PIXELS {
        return Err("截图区域像素总数过大".into());
    }
    unsafe { capture_screen_region_inner(left, top, width, height) }
}

unsafe fn capture_screen_region_inner(
    left: i32,
    top: i32,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
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
    if old_bmp.is_invalid() {
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(None, screen_dc);
        return Err("SelectObject failed".into());
    }

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
            biHeight: -(height as i32), // 自上而下
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0,
            ..Default::default()
        },
        ..Default::default()
    };

    let mut pixels: Vec<u8> = vec![0u8; (width as u64 * height as u64 * 4) as usize];
    let scanlines = GetDIBits(
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

    // GetDIBits 返回成功拷贝的扫描行数，0 表示失败
    if scanlines == 0 {
        return Err("GetDIBits failed".into());
    }

    Ok(pixels)
}

#[allow(clippy::too_many_arguments)]
/// 从一张全屏 BGRA 缓存中裁剪出指定子区域（虚拟桌面物理坐标）。
/// full 为全屏像素（origin_x, origin_y 为虚拟桌面左上原点），
/// 子区域 (left, top, w, h) 同为虚拟桌面坐标，先换算为缓存内偏移再按行拷贝。
/// 越界部分返回错误，避免读到缓存外内存。
pub fn crop_screen_region(
    full: &[u8],
    full_w: u32,
    full_h: u32,
    origin_x: i32,
    origin_y: i32,
    left: i32,
    top: i32,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 {
        return Err("裁剪区域尺寸为 0".into());
    }
    // 子区域左上在缓存内的像素偏移
    let off_x = left - origin_x;
    let off_y = top - origin_y;
    if off_x < 0 || off_y < 0 {
        return Err("裁剪区域超出缓存原点".into());
    }
    let ux = off_x as u32;
    let uy = off_y as u32;
    #[allow(clippy::unnecessary_map_or)]
    // `is_none_or` requires a newer MSRV than this project supports.
    let outside_bounds = ux.checked_add(width).map_or(true, |right| right > full_w)
        || uy
            .checked_add(height)
            .map_or(true, |bottom| bottom > full_h);
    if outside_bounds {
        return Err("裁剪区域超出缓存范围".into());
    }
    let full_stride = full_w as usize * 4;
    let sub_stride = width as usize * 4;
    let mut out = vec![0u8; sub_stride * height as usize];
    for row in 0..height as usize {
        let src = uy as usize * full_stride + ux as usize * 4 + row * full_stride;
        let dst = row * sub_stride;
        out[dst..dst + sub_stride].copy_from_slice(&full[src..src + sub_stride]);
    }
    Ok(out)
}

/// 将 BGRA 像素编码为 PNG，返回 base64 字符串（不带 data: 前缀）。
pub fn encode_png_base64(bgra: &[u8], width: u32, height: u32) -> Result<String, String> {
    if bgra.len() != (width * height * 4) as usize {
        return Err("像素数据长度与尺寸不匹配".into());
    }
    // BGRA -> RGBA
    let mut rgba: Vec<u8> = Vec::with_capacity(bgra.len());
    for chunk in bgra.chunks_exact(4) {
        rgba.push(chunk[2]); // R
        rgba.push(chunk[1]); // G
        rgba.push(chunk[0]); // B
        rgba.push(chunk[3]); // A
    }
    let img = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| "构造 RgbaImage 失败".to_string())?;
    let dyn_img = image::DynamicImage::ImageRgba8(img);
    let mut png_buf: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut png_buf);
    dyn_img
        .write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败: {}", e))?;
    Ok(STANDARD.encode(&png_buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_crop_region_basic() {
        // 4x2 全屏缓存，每像素 BGRA，行优先。原点 (10, 20)。
        // 像素值：行0 = 00..04 递增 R，行1 = 10..14
        let mut full = vec![0u8; 4 * 2 * 4];
        for x in 0..4 {
            full[x * 4 + 2] = x as u8; // R
            full[(4 + x) * 4 + 2] = 10 + x as u8; // 第二行 R
        }
        // 裁剪 (12, 20) 2x1 → 缓存内偏移 (2,0)，应取行0 的 x=2,3
        let out = crop_screen_region(&full, 4, 2, 10, 20, 12, 20, 2, 1).unwrap();
        assert_eq!(out.len(), 2 * 4);
        assert_eq!(out[2], 2); // R of x=2
        assert_eq!(out[6], 3); // R of x=3
    }

    #[test]
    fn test_crop_region_second_row() {
        // 裁剪第二行，验证行 stride 正确（避免按 1D 线性拷贝的错误）
        let mut full = vec![0u8; 4 * 2 * 4];
        for x in 0..4 {
            full[(4 + x) * 4 + 2] = 10 + x as u8;
        }
        let out = crop_screen_region(&full, 4, 2, 10, 20, 12, 21, 2, 1).unwrap();
        assert_eq!(out[2], 12); // R of row1 x=2
        assert_eq!(out[6], 13); // R of row1 x=3
    }

    #[test]
    fn test_crop_region_out_of_range() {
        let full = vec![0u8; 4 * 2 * 4];
        // 超出右边界
        assert!(crop_screen_region(&full, 4, 2, 10, 20, 12, 20, 10, 1).is_err());
        // 超出下边界
        assert!(crop_screen_region(&full, 4, 2, 10, 20, 12, 20, 1, 10).is_err());
        // 原点之前（负偏移）
        assert!(crop_screen_region(&full, 4, 2, 10, 20, 8, 20, 1, 1).is_err());
        // 零尺寸
        assert!(crop_screen_region(&full, 4, 2, 10, 20, 12, 20, 0, 1).is_err());
    }

    #[test]
    fn test_capture_region_zero_size() {
        assert!(capture_screen_region(0, 0, 0, 100).is_err());
        assert!(capture_screen_region(0, 0, 100, 0).is_err());
    }

    #[test]
    fn test_capture_region_too_large() {
        assert!(capture_screen_region(0, 0, 40000, 100).is_err());
        assert!(capture_screen_region(0, 0, 100, 40000).is_err());
        assert!(capture_screen_region(0, 0, 32768, 32768).is_err());
    }

    #[test]
    fn test_capture_region_normal() {
        // 主屏左上角 1x1 截图，应成功返回 4 字节 BGRA
        let result = capture_screen_region(0, 0, 1, 1);
        match result {
            Ok(pixels) => assert_eq!(pixels.len(), 4),
            // Headless CI and locked desktop sessions do not expose a usable screen DC.
            Err(error) => assert!(
                error == "GetDC failed" || error == "BitBlt failed" || error == "GetDIBits failed"
            ),
        }
    }

    #[test]
    fn test_encode_png_base64_size_mismatch() {
        // 像素数据长度与尺寸不匹配
        let bad_pixels = vec![0u8; 10]; // 不足 2x2x4=16
        assert!(encode_png_base64(&bad_pixels, 2, 2).is_err());
    }

    #[test]
    fn test_encode_png_base64_roundtrip() {
        // 1x1 红色像素 BGRA [B=0, G=0, R=255, A=255]
        let bgra = vec![0, 0, 255, 255];
        let result = encode_png_base64(&bgra, 1, 1);
        assert!(result.is_ok());
        let b64 = result.unwrap();
        // base64 应非空且可解码回 PNG
        assert!(!b64.is_empty());
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let decoded = STANDARD.decode(&b64).unwrap();
        // PNG magic number: 89 50 4E 47
        assert_eq!(&decoded[0..4], &[0x89, 0x50, 0x4E, 0x47]);
    }
}

#[cfg(test)]
mod virtual_desktop_tests {
    use super::*;

    #[test]
    fn test_virtual_desktop_bounds_valid() {
        // 真实枚举显示器，应至少有一块屏幕，且尺寸为正
        let bounds = virtual_desktop_bounds();
        assert!(
            bounds.is_ok(),
            "virtual_desktop_bounds 应成功: {:?}",
            bounds.err()
        );
        let b = bounds.unwrap();
        assert!(b.width > 0, "虚拟桌面宽度应为正: {}", b.width);
        assert!(b.height > 0, "虚拟桌面高度应为正: {}", b.height);
    }
}
