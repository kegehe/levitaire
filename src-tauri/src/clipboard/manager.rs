use windows::Win32::Foundation::{GlobalFree, HANDLE};
use windows::Win32::Graphics::Gdi::{BITMAPINFOHEADER, BI_RGB};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

const CF_UNICODETEXT: u32 = 13;
const CF_DIB: u32 = 8;

pub struct ClipboardManager;

impl Default for ClipboardManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ClipboardManager {
    pub fn new() -> Self {
        Self
    }

    pub fn copy(&self, text: &str) -> Result<(), Box<dyn std::error::Error>> {
        self.set_clipboard(text)
    }

    /// 将 PNG 字节解码后以 CF_DIB 格式写入剪贴板
    pub fn copy_image(&self, png_bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
        let dyn_img = image::load_from_memory_with_format(png_bytes, image::ImageFormat::Png)?;
        let (dib_data, width, height) = build_dib_data(&dyn_img)?;
        unsafe {
            OpenClipboard(None)?;
            let result = (|| -> Result<(), Box<dyn std::error::Error>> {
                if EmptyClipboard().is_err() {
                    return Err("EmptyClipboard failed".into());
                }
                write_dib_handle(&dib_data, width, height)
            })();
            let _ = CloseClipboard();
            result?;
        }
        Ok(())
    }

    /// 将 GIF 动图写入剪贴板：
    /// - 注册的 "GIF" 格式：写入完整动图数据，保留动画（核心格式，供支持 GIF 粘贴的应用使用）
    /// - CF_DIB 位图格式：首帧静态图，作为可选兼容回退，保证不支持 GIF 格式的应用也能粘贴出静态图
    pub fn copy_gif(&self, gif_bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
        unsafe {
            OpenClipboard(None)?;
            let result = (|| -> Result<(), Box<dyn std::error::Error>> {
                if EmptyClipboard().is_err() {
                    return Err("EmptyClipboard failed".into());
                }

                // 1. 注册的 "GIF" 格式——完整动图数据（核心，保留动画）
                let cf_gif = RegisterClipboardFormatW(windows::core::w!("GIF"));
                let hmem_gif = GlobalAlloc(GMEM_MOVEABLE, gif_bytes.len())?;
                let ptr_gif = GlobalLock(hmem_gif);
                if ptr_gif.is_null() {
                    let _ = GlobalFree(Some(hmem_gif));
                    return Err("GlobalLock failed".into());
                }
                std::ptr::copy_nonoverlapping(
                    gif_bytes.as_ptr(),
                    ptr_gif as *mut u8,
                    gif_bytes.len(),
                );
                if GlobalUnlock(hmem_gif).is_err() {
                    crate::utils::logger::log(
                        "clipboard",
                        "GlobalUnlock returned error (non-critical)",
                    );
                }
                if SetClipboardData(cf_gif, Some(HANDLE(hmem_gif.0))).is_err() {
                    let _ = GlobalFree(Some(hmem_gif));
                    return Err("SetClipboardData(GIF) failed".into());
                }

                // 2. CF_DIB 位图（首帧）——可选兼容回退，失败仅记录日志，不影响已写入的 GIF 格式
                try_write_dib_fallback(gif_bytes);

                Ok(())
            })();
            let _ = CloseClipboard();
            result?;
        }
        Ok(())
    }

    fn set_clipboard(&self, text: &str) -> Result<(), Box<dyn std::error::Error>> {
        unsafe {
            OpenClipboard(None)?;

            // 清空剪贴板，检查是否成功
            if EmptyClipboard().is_err() {
                let _ = CloseClipboard();
                return Err("EmptyClipboard failed".into());
            }

            // CF_UNICODETEXT: UTF-16 with null terminator
            let utf16: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
            let byte_size = utf16.len() * 2;

            let hmem = GlobalAlloc(GMEM_MOVEABLE, byte_size)?;
            let ptr = GlobalLock(hmem);
            if ptr.is_null() {
                let _ = GlobalFree(Some(hmem));
                let _ = CloseClipboard();
                return Err("GlobalLock failed".into());
            }

            std::ptr::copy_nonoverlapping(utf16.as_ptr(), ptr as *mut u16, utf16.len());

            // GlobalUnlock 失败通常不影响已复制的数据，但应记录
            if GlobalUnlock(hmem).is_err() {
                crate::utils::logger::log(
                    "clipboard",
                    "GlobalUnlock returned error (non-critical)",
                );
            }

            if SetClipboardData(CF_UNICODETEXT, Some(HANDLE(hmem.0))).is_err() {
                let _ = GlobalFree(Some(hmem));
                let _ = CloseClipboard();
                return Err("SetClipboardData failed".into());
            }

            CloseClipboard()?;
        }
        Ok(())
    }
}

/// 将 RGBA 图像转为 Windows DIB 像素数据（BGR 字节序 + 自下而上的行序），返回 (像素数据, 宽, 高)
fn build_dib_data(
    dyn_img: &image::DynamicImage,
) -> Result<(Vec<u8>, u32, u32), Box<dyn std::error::Error>> {
    let rgba = dyn_img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let rgba_pixels = rgba.into_raw();

    // RGBA -> BGRA（DIB 默认 BGR，未压缩时按行从下到上）
    let mut bgra: Vec<u8> = Vec::with_capacity(rgba_pixels.len());
    for chunk in rgba_pixels.chunks_exact(4) {
        bgra.push(chunk[2]); // B
        bgra.push(chunk[1]); // G
        bgra.push(chunk[0]); // R
        bgra.push(0xFF); // 保留位按不透明处理，避免部分应用把第4字节当 alpha 导致图像透明
    }

    // DIB 像素按行从下到上存储，翻转行序
    let row_size = (width as usize) * 4;
    let mut rows: Vec<&[u8]> = bgra.chunks_exact(row_size).collect();
    rows.reverse();
    let mut dib_data: Vec<u8> = Vec::with_capacity(bgra.len());
    for row in rows {
        dib_data.extend_from_slice(row);
    }
    Ok((dib_data, width, height))
}

/// 在已打开并清空的剪贴板会话内写入 CF_DIB 数据（不负责剪贴板的打开/关闭）
unsafe fn write_dib_handle(
    dib_data: &[u8],
    width: u32,
    height: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    let header_size = std::mem::size_of::<BITMAPINFOHEADER>();
    let total = header_size + dib_data.len();

    let hmem = GlobalAlloc(GMEM_MOVEABLE, total)?;
    let ptr = GlobalLock(hmem);
    if ptr.is_null() {
        let _ = GlobalFree(Some(hmem));
        return Err("GlobalLock failed".into());
    }

    let header = BITMAPINFOHEADER {
        biSize: header_size as u32,
        biWidth: width as i32,
        biHeight: height as i32, // 正高度 = 自下而上
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    std::ptr::copy_nonoverlapping(
        &header as *const _ as *const u8,
        ptr as *mut u8,
        header_size,
    );
    std::ptr::copy_nonoverlapping(
        dib_data.as_ptr(),
        (ptr as *mut u8).add(header_size),
        dib_data.len(),
    );

    if GlobalUnlock(hmem).is_err() {
        crate::utils::logger::log(
            "clipboard",
            "GlobalUnlock returned error (non-critical)",
        );
    }

    if SetClipboardData(CF_DIB, Some(HANDLE(hmem.0))).is_err() {
        let _ = GlobalFree(Some(hmem));
        return Err("SetClipboardData failed".into());
    }
    Ok(())
}

/// 尝试写入 CF_DIB 首帧作为兼容回退；任何阶段失败仅记录日志，不影响已写入的 GIF 格式
unsafe fn try_write_dib_fallback(gif_bytes: &[u8]) {
    let dyn_img = match image::load_from_memory_with_format(gif_bytes, image::ImageFormat::Gif) {
        Ok(img) => img,
        Err(e) => {
            crate::utils::logger::log("clipboard", &format!("CF_DIB 回退解码失败: {}", e));
            return;
        }
    };
    let (dib_data, width, height) = match build_dib_data(&dyn_img) {
        Ok(d) => d,
        Err(e) => {
            crate::utils::logger::log("clipboard", &format!("CF_DIB 回退构建失败: {}", e));
            return;
        }
    };
    if let Err(e) = write_dib_handle(&dib_data, width, height) {
        crate::utils::logger::log("clipboard", &format!("CF_DIB 回退写入失败: {}", e));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cf_unicode_text_constant() {
        assert_eq!(CF_UNICODETEXT, 13);
    }

    #[test]
    fn test_clipboard_manager_new() {
        let _mgr = ClipboardManager::new();
        // 不应 panic
    }

    #[test]
    fn test_clipboard_manager_default() {
        let _mgr = ClipboardManager;
        // 不应 panic
    }

    /// 构造一个 2 帧 GIF（首帧红色、次帧绿色），返回其字节
    fn sample_gif_bytes() -> Vec<u8> {
        let delay = image::Delay::from_saturating_duration(std::time::Duration::from_millis(100));
        let frame1 = image::Frame::from_parts(
            image::RgbaImage::from_pixel(3, 2, image::Rgba([255, 0, 0, 255])),
            0,
            0,
            delay.clone(),
        );
        let frame2 = image::Frame::from_parts(
            image::RgbaImage::from_pixel(3, 2, image::Rgba([0, 255, 0, 255])),
            0,
            0,
            delay,
        );
        let mut gif_buf = std::io::Cursor::new(Vec::new());
        image::codecs::gif::GifEncoder::new(&mut gif_buf)
            .encode_frames([frame1, frame2])
            .expect("GIF 编码失败");
        gif_buf.into_inner()
    }

    #[test]
    fn test_build_dib_data_from_gif() {
        let gif_bytes = sample_gif_bytes();
        assert!(!gif_bytes.is_empty());

        let dyn_img =
            image::load_from_memory_with_format(&gif_bytes, image::ImageFormat::Gif).unwrap();
        let (dib_data, width, height) = build_dib_data(&dyn_img).unwrap();
        assert_eq!((width, height), (3, 2));
        // DIB：3×2 像素 × 4 字节
        assert_eq!(dib_data.len(), 3 * 2 * 4);
    }

    #[test]
    #[ignore = "需要交互式桌面会话且会覆盖系统剪贴板"]
    fn test_copy_gif_writes_animation_to_clipboard() {
        use windows::Win32::Foundation::HGLOBAL;
        use windows::Win32::System::DataExchange::{
            GetClipboardData, IsClipboardFormatAvailable,
        };
        use windows::Win32::System::Memory::GlobalSize;

        let gif_bytes = sample_gif_bytes();
        let mgr = ClipboardManager::new();
        mgr.copy_gif(&gif_bytes).expect("copy_gif 失败");

        // 剪贴板中应存在注册的 GIF 格式（此前修复丢失动画的根因）
        let cf_gif = unsafe { RegisterClipboardFormatW(windows::core::w!("GIF")) };
        assert!(
            unsafe { IsClipboardFormatAvailable(cf_gif) }.is_ok(),
            "剪贴板应包含 GIF 格式"
        );

        // 读回 GIF 数据，验证与原始字节一致（动画完整保留）
        unsafe {
            OpenClipboard(None).expect("OpenClipboard 失败");
            let hmem = GetClipboardData(cf_gif).expect("GetClipboardData 失败");
            let hg = HGLOBAL(hmem.0);
            let len = GlobalSize(hg);
            let ptr = GlobalLock(hg);
            assert!(!ptr.is_null(), "GlobalLock 失败");
            assert!(
                len >= gif_bytes.len(),
                "剪贴板数据长度异常: {} < {}",
                len,
                gif_bytes.len()
            );
            let copied = std::slice::from_raw_parts(ptr as *const u8, len);
            assert_eq!(&copied[..gif_bytes.len()], gif_bytes.as_slice());
            GlobalUnlock(hg).expect("GlobalUnlock 失败");
            CloseClipboard().expect("CloseClipboard 失败");
        }
    }
}
