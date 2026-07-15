use windows::Win32::Foundation::{GlobalFree, HANDLE};
use windows::Win32::Graphics::Gdi::{BITMAPINFOHEADER, BI_RGB};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
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

        let header_size = std::mem::size_of::<BITMAPINFOHEADER>();
        let total = header_size + dib_data.len();

        unsafe {
            OpenClipboard(None)?;
            if EmptyClipboard().is_err() {
                let _ = CloseClipboard();
                return Err("EmptyClipboard failed".into());
            }

            let hmem = GlobalAlloc(GMEM_MOVEABLE, total)?;
            let ptr = GlobalLock(hmem);
            if ptr.is_null() {
                let _ = GlobalFree(Some(hmem));
                let _ = CloseClipboard();
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
                let _ = CloseClipboard();
                return Err("SetClipboardData failed".into());
            }

            CloseClipboard()?;
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
}
