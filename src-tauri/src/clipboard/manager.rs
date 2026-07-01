use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

const CF_UNICODETEXT: u32 = 13;

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
                let _ = GlobalUnlock(hmem);
                let _ = CloseClipboard();
                return Err("GlobalLock failed".into());
            }

            std::ptr::copy_nonoverlapping(utf16.as_ptr(), ptr as *mut u16, utf16.len());

            // GlobalUnlock 失败通常不影响已复制的数据，但应记录
            if GlobalUnlock(hmem).is_err() {
                crate::utils::logger::log("clipboard", "GlobalUnlock returned error (non-critical)");
            }

            if SetClipboardData(CF_UNICODETEXT, Some(HANDLE(hmem.0))).is_err() {
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
        let _mgr = ClipboardManager::default();
        // 不应 panic
    }
}
