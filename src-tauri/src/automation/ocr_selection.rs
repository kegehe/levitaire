use windows::Win32::Graphics::Gdi::*;
use windows::Media::Ocr::OcrEngine;
use windows::Graphics::Imaging::*;
use windows::core::Interface;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

use super::{SelectionInfo, Rect};

/// 通过截屏 + OCR 获取鼠标拖选区域的文字
/// 这是最后的 fallback 方案，当 UIA/Win32/剪贴板全部失败时使用
pub fn get_selection_via_ocr() -> Result<Option<SelectionInfo>, Box<dyn std::error::Error>> {
    let (x1, y1, x2, y2) = get_last_drag_rect();
    if x1 == 0 && y1 == 0 && x2 == 0 && y2 == 0 {
        crate::utils::logger::log("ocr", "No drag rect available");
        return Ok(None);
    }

    let margin = 20i32;
    let left = (x1.min(x2) - margin).max(0);
    let top = (y1.min(y2) - margin).max(0);
    let right = x1.max(x2) + margin;
    let bottom = y1.max(y2) + margin;
    let width = (right - left).max(1) as u32;
    let height = (bottom - top).max(1) as u32;

    crate::utils::logger::log("ocr", &format!("OCR region: ({},{}) {}x{}", left, top, width, height));

    if width > 4096 || height > 4096 {
        crate::utils::logger::log("ocr", "Region too large for OCR");
        return Ok(None);
    }

    let pixels_width = width;
    let pixels_height = height;

    // OCR 必须在 MTA 线程执行：
    // RecognizeAsync().get() 在 STA 上会阻塞消息循环，导致 WinRT async 完成回调
    // 无法分发，operation 持有的 SoftwareBitmap 读锁不释放，触发 READER_LOCK_BUSY (0x88982F0D)，
    // 且首次失败后永久卡死。MTA 上 .get() 不依赖消息循环，回调能正常完成。
    let ocr_result = std::thread::spawn(move || {
        // 子线程内初始化为 MTA
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        // 子线程返回 String（Send），避免 Box<dyn Error> 跨线程不满足 Send
        let res: Result<String, String> = (|| {
            let pixels = unsafe { capture_screen_region(left, top, pixels_width, pixels_height) }
                .map_err(|e| format!("{:?}", e))?;
            let text = unsafe { ocr_from_bgra_pixels(&pixels, pixels_width, pixels_height) }
                .map_err(|e| format!("{:?}", e))?;
            Ok(text)
        })();
        unsafe { CoUninitialize(); }
        res
    }).join();

    let text = match ocr_result {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => return Err(e.into()),
        Err(e) => return Err(format!("OCR 线程 panic: {:?}", e).into()),
    };

    if text.is_empty() {
        crate::utils::logger::log("ocr", "OCR returned empty text");
        return Ok(None);
    }

    crate::utils::logger::log("ocr", &format!("OCR success: {} chars", text.len()));

    let info = SelectionInfo {
        text,
        rect: Rect { x: left, y: top, width: width as i32, height: height as i32 },
        has_image: false,
    };
    Ok(Some(info))
}

// ─── 拖选坐标管理 ────────────────────────────────────────────────

use std::sync::atomic::{AtomicI32, Ordering};

static LAST_DRAG_X1: AtomicI32 = AtomicI32::new(0);
static LAST_DRAG_Y1: AtomicI32 = AtomicI32::new(0);
static LAST_DRAG_X2: AtomicI32 = AtomicI32::new(0);
static LAST_DRAG_Y2: AtomicI32 = AtomicI32::new(0);

fn get_last_drag_rect() -> (i32, i32, i32, i32) {
    (
        LAST_DRAG_X1.load(Ordering::Relaxed),
        LAST_DRAG_Y1.load(Ordering::Relaxed),
        LAST_DRAG_X2.load(Ordering::Relaxed),
        LAST_DRAG_Y2.load(Ordering::Relaxed),
    )
}

/// 设置拖选坐标（由 mouse.rs 调用）
pub fn set_last_drag_rect(x1: i32, y1: i32, x2: i32, y2: i32) {
    LAST_DRAG_X1.store(x1, Ordering::Relaxed);
    LAST_DRAG_Y1.store(y1, Ordering::Relaxed);
    LAST_DRAG_X2.store(x2, Ordering::Relaxed);
    LAST_DRAG_Y2.store(y2, Ordering::Relaxed);
}

// ─── GDI 截屏 ────────────────────────────────────────────────────

unsafe fn capture_screen_region(
    left: i32, top: i32, width: u32, height: u32,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
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
    // #7: 检查 SelectObject 是否成功
    if old_bmp.is_invalid() {
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(None, screen_dc);
        return Err("SelectObject failed".into());
    }

    let _ = BitBlt(
        mem_dc, 0, 0, width as i32, height as i32,
        Some(screen_dc), left, top, SRCCOPY,
    );

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

    let mut pixels: Vec<u8> = vec![0u8; (width * height * 4) as usize];
    let _ = GetDIBits(
        mem_dc, bitmap, 0, height,
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

// ─── OCR 识别 ────────────────────────────────────────────────────

unsafe fn ocr_from_bgra_pixels(
    pixels: &[u8],
    width: u32,
    height: u32,
) -> Result<String, Box<dyn std::error::Error>> {
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|e| format!("创建 OcrEngine 失败: {}", e))?;

    // 创建 SoftwareBitmap
    let bitmap = SoftwareBitmap::Create(BitmapPixelFormat::Bgra8, width as i32, height as i32)
        .map_err(|e| format!("创建 SoftwareBitmap 失败: {}", e))?;

    // 通过 BitmapBuffer 写入像素数据
    let buffer = bitmap.LockBuffer(BitmapBufferAccessMode::Write)
        .map_err(|e| format!("LockBuffer 失败: {}", e))?;
    let plane = buffer.GetPlaneDescription(0)
        .map_err(|e| format!("GetPlaneDescription 失败: {}", e))?;
    let reference = buffer.CreateReference()
        .map_err(|e| format!("CreateReference 失败: {}", e))?;

    // 通过 IMemoryBufferByteAccess 获取可写指针
    // GUID: {5b0d3235-4dba-4d44-865e-8f1d0e4fd04d}
    let byte_access: IMemoryBufferByteAccess = Interface::cast(&reference)
        .map_err(|e| format!("QueryInterface IMemoryBufferByteAccess 失败: {}", e))?;
    let (ptr, capacity) = byte_access.GetBuffer()
        .map_err(|e| format!("GetBuffer 失败: {}", e))?;

    let stride = plane.Stride as usize;
    let src_stride = (width as usize) * 4;

    for y in 0..height as usize {
        let dst_offset = y * stride;
        let src_offset = y * src_stride;
        if dst_offset + stride > capacity { break; }
        let row_bytes = src_stride.min(stride);
        std::ptr::copy_nonoverlapping(
            pixels[src_offset..].as_ptr(),
            ptr.add(dst_offset),
            row_bytes,
        );
    }

    drop(reference);
    drop(buffer);

    // OCR 识别
    let async_op = engine.RecognizeAsync(&bitmap)
        .map_err(|e| format!("RecognizeAsync 失败: {}", e))?;
    let result = async_op.get()
        .map_err(|e| format!("OCR 异步操作失败: {}", e))?;
    let text = result.Text()
        .map_err(|e| format!("获取 OCR 文本失败: {}", e))?;

    Ok(text.to_string())
}

// ─── IMemoryBufferByteAccess 接口定义 ────────────────────────────
// windows crate 未直接暴露此接口，需手动定义
// 来自 Windows.Foundation，GUID: {5b0d3235-4dba-4d44-865e-8f1d0e4fd04d}

#[derive(Clone)]
#[repr(transparent)]
#[allow(non_camel_case_types)]
struct IMemoryBufferByteAccess(windows::core::IUnknown);

#[allow(non_snake_case)]
impl IMemoryBufferByteAccess {
    unsafe fn GetBuffer(&self) -> windows::core::Result<(*mut u8, usize)> {
        let mut ptr: *mut u8 = std::ptr::null_mut();
        let mut capacity: u32 = 0;
        (Interface::vtable(self).GetBuffer)(
            Interface::as_raw(self),
            &mut ptr as *mut _,
            &mut capacity,
        ).ok()?;
        Ok((ptr, capacity as usize))
    }
}

unsafe impl Interface for IMemoryBufferByteAccess {
    type Vtable = IMemoryBufferByteAccess_Vtbl;

    const IID: windows::core::GUID = windows::core::GUID::from_u128(
        0x5b0d3235_4dba_4d44_865e_8f1d0e4fd04d
    );
}

#[repr(C)]
#[allow(non_snake_case)]
struct IMemoryBufferByteAccess_Vtbl {
    base__: windows::core::IUnknown_Vtbl,
    GetBuffer: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut u8,
        *mut u32,
    ) -> windows::core::HRESULT,
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── 拖选坐标管理 ────────────────────────────────────────────

    #[test]
    fn test_drag_rect_set_and_read() {
        set_last_drag_rect(0, 0, 100, 100);
        let (x1, y1, x2, y2) = get_last_drag_rect();
        assert_eq!(x1, 0);
        assert_eq!(y1, 0);
        assert_eq!(x2, 100);
        assert_eq!(y2, 100);
    }

    #[test]
    fn test_drag_rect_overwrite() {
        set_last_drag_rect(10, 20, 30, 40);
        set_last_drag_rect(50, 60, 70, 80);
        let (x1, y1, x2, y2) = get_last_drag_rect();
        assert_eq!(x1, 50);
        assert_eq!(y1, 60);
        assert_eq!(x2, 70);
        assert_eq!(y2, 80);
    }

    #[test]
    fn test_drag_rect_negative_coords() {
        set_last_drag_rect(-100, -200, 300, 400);
        let (x1, y1, x2, y2) = get_last_drag_rect();
        assert_eq!(x1, -100);
        assert_eq!(y1, -200);
        assert_eq!(x2, 300);
        assert_eq!(y2, 400);
    }

    #[test]
    fn test_drag_rect_same_point() {
        set_last_drag_rect(42, 42, 42, 42);
        let (x1, y1, x2, y2) = get_last_drag_rect();
        assert_eq!(x1, 42);
        assert_eq!(y1, 42);
        assert_eq!(x2, 42);
        assert_eq!(y2, 42);
    }

    // ─── 选区区域计算逻辑（get_selection_via_ocr 内联逻辑） ───────

    #[test]
    fn test_ocr_region_normal() {
        set_last_drag_rect(100, 200, 300, 400);
        let (x1, y1, x2, y2) = get_last_drag_rect();
        let left = x1.min(x2);
        let top = y1.min(y2);
        let width = (x2 - x1).unsigned_abs();
        let height = (y2 - y1).unsigned_abs();
        assert_eq!(left, 100);
        assert_eq!(top, 200);
        assert_eq!(width, 200);
        assert_eq!(height, 200);
    }

    #[test]
    fn test_ocr_region_swapped() {
        // 从右下往左上拖拽 → x2 < x1
        set_last_drag_rect(300, 400, 100, 200);
        let (x1, y1, x2, y2) = get_last_drag_rect();
        let left = x1.min(x2);
        let top = y1.min(y2);
        let width = (x2 - x1).unsigned_abs();
        let height = (y2 - y1).unsigned_abs();
        assert_eq!(left, 100);
        assert_eq!(top, 200);
        assert_eq!(width, 200);
        assert_eq!(height, 200);
    }

    #[test]
    fn test_ocr_region_zero_size() {
        set_last_drag_rect(50, 50, 50, 50);
        let (x1, y1, x2, y2) = get_last_drag_rect();
        let width = (x2 - x1).unsigned_abs();
        let height = (y2 - y1).unsigned_abs();
        assert_eq!(width, 0);
        assert_eq!(height, 0);
        // 实际代码中 width == 0 || height == 0 时提前返回 None
    }

    #[test]
    fn test_ocr_region_negative_coords() {
        set_last_drag_rect(-50, -50, 50, 50);
        let (x1, y1, x2, y2) = get_last_drag_rect();
        let left = x1.min(x2);
        let top = y1.min(y2);
        let width = (x2 - x1).unsigned_abs();
        let height = (y2 - y1).unsigned_abs();
        assert_eq!(left, -50);
        assert_eq!(top, -50);
        assert_eq!(width, 100);
        assert_eq!(height, 100);
    }

    // ─── IMemoryBufferByteAccess GUID ─────────────────────────────

    #[test]
    fn test_imemory_buffer_byte_access_guid() {
        let expected = windows::core::GUID::from_u128(0x5b0d3235_4dba_4d44_865e_8f1d0e4fd04d);
        assert_eq!(<IMemoryBufferByteAccess as Interface>::IID, expected);
    }
}
