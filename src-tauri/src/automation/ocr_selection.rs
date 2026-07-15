use windows::core::Interface;
use windows::Foundation::{IMemoryBuffer, MemoryBuffer};
use windows::Graphics::Imaging::*;
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::Buffer;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

use super::{Rect, SelectionInfo};

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

    crate::utils::logger::log(
        "ocr",
        &format!("OCR region: ({},{}) {}x{}", left, top, width, height),
    );

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
        unsafe {
            CoUninitialize();
        }
        res
    })
    .join();

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
        rect: Rect {
            x: left,
            y: top,
            width: width as i32,
            height: height as i32,
        },
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
    left: i32,
    top: i32,
    width: u32,
    height: u32,
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
        mem_dc,
        0,
        0,
        width as i32,
        height as i32,
        Some(screen_dc),
        left,
        top,
        SRCCOPY,
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

    if scanlines == 0 {
        return Err("GetDIBits failed".into());
    }

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

    // 关键：不能用 SoftwareBitmap::LockBuffer(Write) 写像素。该写锁在 drop 后仍可能未完全释放，
    // 导致随后的 RecognizeAsync 内部读 bitmap 时撞上 WinRT 锁冲突
    // （错误 0x88982F0D “已经存在未完成的读取锁定或写入锁定”）。
    // 改用 MemoryBuffer 写入像素 → CopyFromMemoryBuffer 拷贝为 IBuffer →
    // SoftwareBitmap::CreateCopyFromBuffer 由 IBuffer 拷贝出独立 bitmap。
    // 最终传给 RecognizeAsync 的 bitmap 不持有任何运行时锁，彻底规避该错误。
    let len = (width as usize) * (height as usize) * 4;
    if pixels.len() < len {
        return Err(format!("像素数据长度 {} < 所需 {}", pixels.len(), len).into());
    }

    let mem_buffer = MemoryBuffer::Create(len as u32)
        .map_err(|e| format!("MemoryBuffer::Create 失败: {}", e))?;
    let reference = mem_buffer
        .CreateReference()
        .map_err(|e| format!("MemoryBuffer::CreateReference 失败: {}", e))?;
    let byte_access: IMemoryBufferByteAccess = Interface::cast(&reference)
        .map_err(|e| format!("QueryInterface IMemoryBufferByteAccess 失败: {}", e))?;
    let (ptr, capacity) = byte_access
        .GetBuffer()
        .map_err(|e| format!("GetBuffer 失败: {}", e))?;
    if capacity < len {
        return Err(format!("MemoryBuffer 容量 {} < 所需 {}", capacity, len).into());
    }
    std::ptr::copy_nonoverlapping(pixels.as_ptr(), ptr, len);
    drop(reference);

    // 由 MemoryBuffer 拷贝出 IBuffer，再由 IBuffer 拷贝出 SoftwareBitmap。
    // 两次拷贝后 MemoryBuffer/IBuffer 即可释放，bitmap 自身不持有写锁。
    let ibuffer = Buffer::CreateCopyFromMemoryBuffer(&mem_buffer.cast::<IMemoryBuffer>()?)
        .map_err(|e| format!("CreateCopyFromMemoryBuffer 失败: {}", e))?;
    ibuffer
        .SetLength(len as u32)
        .map_err(|e| format!("IBuffer::SetLength 失败: {}", e))?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        &ibuffer,
        BitmapPixelFormat::Bgra8,
        width as i32,
        height as i32,
    )
    .map_err(|e| format!("CreateCopyFromBuffer 失败: {}", e))?;
    drop(mem_buffer);
    drop(ibuffer);

    // OCR 识别
    let async_op = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| format!("RecognizeAsync 失败: {}", e))?;
    let result = async_op
        .get()
        .map_err(|e| format!("OCR 异步操作失败: {}", e))?;
    let text = result
        .Text()
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
        )
        .ok()?;
        Ok((ptr, capacity as usize))
    }
}

unsafe impl Interface for IMemoryBufferByteAccess {
    type Vtable = IMemoryBufferByteAccess_Vtbl;

    const IID: windows::core::GUID =
        windows::core::GUID::from_u128(0x5b0d3235_4dba_4d44_865e_8f1d0e4fd04d);
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

/// 对给定的 BGRA 像素执行 OCR 识别（公开入口，供截图工具的 OCR 按钮调用）。
/// 委托给全局 OCR 服务（OcrService）；若服务未注册（如在测试中）则回退到旧路径。
#[allow(dead_code)] // Compatibility entry point for screenshot OCR consumers.
pub fn recognize_bgra(
    bgra: &[u8],
    width: u32,
    height: u32,
) -> Result<String, Box<dyn std::error::Error>> {
    match crate::ocr::get_ocr_service() {
        Some(svc) => {
            let guard = svc.lock().map_err(|e| format!("OCR 服务锁失败: {}", e))?;
            Ok(guard.recognize_bgra(bgra, width, height)?.text)
        }
        None => {
            // 回退到旧路径：仅在测试环境中（OcrService 未初始化）
            unsafe { ocr_from_bgra_pixels(bgra, width, height) }
        }
    }
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

    // ─── 实机 OCR 集成测试（默认 ignored，需手动运行） ───────────────
    // 运行方式：cargo test --manifest-path src-tauri/Cargo.toml ocr_live -- --ignored --nocapture
    // 这些测试会真实截屏并调用 Windows OCR 引擎，用于定位
    // “已经存在未完成的读取锁定或写入锁定” 错误的发生位置。

    /// 截取屏幕左上角 200x200 区域并做单次 OCR，打印完整结果/错误。
    #[test]
    #[ignore]
    fn ocr_live_single() {
        let bgra = crate::screenshot::capture_screen_region(0, 0, 200, 200)
            .expect("capture_screen_region 失败");
        println!("captured {} bytes", bgra.len());
        match recognize_bgra(&bgra, 200, 200) {
            Ok(t) => println!("OCR OK ({} chars): [{}]", t.chars().count(), t),
            Err(e) => {
                println!("OCR ERR: {}", e);
                panic!("单次 OCR 失败: {}", e);
            }
        }
    }

    /// 在主线程内连续两次独立调用单块 OCR（不经过 recognize_bgra 的分块/多线程），
    /// 用于判断 “多次 RecognizeAsync 冲突” 是否在单线程内就会发生。
    #[test]
    #[ignore]
    fn ocr_live_raw_double_in_one_thread() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let bgra = crate::screenshot::capture_screen_region(0, 0, 100, 100)
                .expect("capture_screen_region 失败");
            for i in 0..2u32 {
                match ocr_from_bgra_pixels(&bgra, 100, 100) {
                    Ok(t) => println!("第 {} 次 raw OCR OK: [{}]", i + 1, t),
                    Err(e) => {
                        println!("第 {} 次 raw OCR ERR: {:?}", i + 1, e);
                        panic!("第 {} 次 raw OCR 失败: {:?}", i + 1, e);
                    }
                }
            }
            CoUninitialize();
        }
    }

    /// 调用 recognize_bgra 两次，验证多线程隔离后连续识别是否仍有锁定冲突。
    #[test]
    #[ignore]
    fn ocr_live_recognize_bgra_twice() {
        let bgra = crate::screenshot::capture_screen_region(0, 0, 150, 150)
            .expect("capture_screen_region 失败");
        for i in 0..2u32 {
            match recognize_bgra(&bgra, 150, 150) {
                Ok(t) => println!("第 {} 次 recognize_bgra OK: [{}]", i + 1, t),
                Err(e) => {
                    println!("第 {} 次 recognize_bgra ERR: {}", i + 1, e);
                    panic!("第 {} 次 recognize_bgra 失败: {}", i + 1, e);
                }
            }
        }
    }

    /// 合成一张宽 > 4096 的纯黑 BGRA 图（模拟跨多屏超宽选区），
    /// 验证宽度方向不分块时 recognize_bgra 不会 panic / 越界，能正常返回（空文本）。
    #[test]
    #[ignore]
    fn ocr_live_synthetic_wide() {
        let width: u32 = 5000;
        let height: u32 = 64;
        // 纯黑 BGRA
        let bgra = vec![0u8; (width as usize) * (height as usize) * 4];
        match recognize_bgra(&bgra, width, height) {
            Ok(t) => println!("wide OCR OK, text=[{}] (len={})", t, t.chars().count()),
            Err(e) => panic!("wide OCR 失败: {}", e),
        }
    }

    /// 合成极小尺寸（1x1）BGRA，验证边界尺寸不崩溃。
    #[test]
    #[ignore]
    fn ocr_live_synthetic_tiny() {
        let bgra = vec![255u8; 4]; // 1x1 白
        match recognize_bgra(&bgra, 1, 1) {
            Ok(t) => println!("tiny OCR OK, text=[{}]", t),
            Err(e) => panic!("tiny OCR 失败: {}", e),
        }
    }

    /// 零尺寸应直接报错，不进入 OCR 路径。
    #[test]
    fn ocr_unit_zero_size_errors() {
        assert!(recognize_bgra(&[], 0, 10).is_err());
        assert!(recognize_bgra(&[], 10, 0).is_err());
    }

    /// 像素缓冲长度不足应报错，不发生越界。
    #[test]
    fn ocr_unit_short_buffer_errors() {
        // 声称 10x10 但只给 1 字节
        assert!(recognize_bgra(&[0u8; 1], 10, 10).is_err());
    }
}
