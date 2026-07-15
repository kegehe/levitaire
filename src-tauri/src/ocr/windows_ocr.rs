//! Windows 系统内置 OCR 引擎（Windows.Media.Ocr）。
//!
//! 利用 Windows 10+ 自带的 OcrEngine API，零额外依赖。
//! 识别在独立的 MTA 子线程中执行，避免 WinRT async 死锁。

use super::engine::{OcrEngine, OcrError, OcrResult};

#[cfg(target_os = "windows")]
mod imp {
    use windows::core::Interface;
    use windows::Foundation::{IMemoryBuffer, MemoryBuffer};
    use windows::Graphics::Imaging::*;
    use windows::Media::Ocr::OcrEngine as WinOcrEngine;
    use windows::Storage::Streams::Buffer;

    use super::super::engine::{OcrBlock, OcrError, OcrResult};

    /// 从 BGRA 像素创建 SoftwareBitmap，经过 MemoryBuffer→IBuffer→CreateCopyFromBuffer
    /// 路径写入像素，规避 LockBuffer 导致的 0x88982F0D 锁冲突。
    pub fn create_bitmap_from_bgra(
        pixels: &[u8],
        width: u32,
        height: u32,
    ) -> Result<SoftwareBitmap, OcrError> {
        let len = (width as usize) * (height as usize) * 4;
        if pixels.len() < len {
            return Err(OcrError::PreprocessFailed(format!(
                "像素数据长度 {} < 所需 {}",
                pixels.len(),
                len
            )));
        }

        let mem_buffer = MemoryBuffer::Create(len as u32)
            .map_err(|e| OcrError::PreprocessFailed(format!("MemoryBuffer::Create 失败: {}", e)))?;

        let reference = mem_buffer.CreateReference().map_err(|e| {
            OcrError::PreprocessFailed(format!("MemoryBuffer::CreateReference 失败: {}", e))
        })?;

        // IMemoryBufferByteAccess 接口（Windows SDK 未直接暴露）
        #[repr(transparent)]
        #[allow(non_camel_case_types)]
        #[derive(Clone)]
        struct IMemoryBufferByteAccess(windows::core::IUnknown);

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

        unsafe impl Interface for IMemoryBufferByteAccess {
            type Vtable = IMemoryBufferByteAccess_Vtbl;
            const IID: windows::core::GUID =
                windows::core::GUID::from_u128(0x5b0d3235_4dba_4d44_865e_8f1d0e4fd04d);
        }

        impl IMemoryBufferByteAccess {
            #[allow(non_snake_case)] // Matches the WinRT IMemoryBufferByteAccess vtable method.
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

        let byte_access: IMemoryBufferByteAccess = Interface::cast(&reference).map_err(|e| {
            OcrError::PreprocessFailed(format!(
                "QueryInterface IMemoryBufferByteAccess 失败: {}",
                e
            ))
        })?;

        let (ptr, capacity) = unsafe {
            byte_access
                .GetBuffer()
                .map_err(|e| OcrError::PreprocessFailed(format!("GetBuffer 失败: {}", e)))?
        };

        if capacity < len {
            return Err(OcrError::PreprocessFailed(format!(
                "MemoryBuffer 容量 {} < 所需 {}",
                capacity, len
            )));
        }

        unsafe {
            std::ptr::copy_nonoverlapping(pixels.as_ptr(), ptr, len);
        }
        drop(reference);

        let ibuffer = Buffer::CreateCopyFromMemoryBuffer(
            &mem_buffer
                .cast::<IMemoryBuffer>()
                .map_err(|e| OcrError::PreprocessFailed(format!("cast 失败: {}", e)))?,
        )
        .map_err(|e| {
            OcrError::PreprocessFailed(format!("CreateCopyFromMemoryBuffer 失败: {}", e))
        })?;

        ibuffer
            .SetLength(len as u32)
            .map_err(|e| OcrError::PreprocessFailed(format!("IBuffer::SetLength 失败: {}", e)))?;

        let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
            &ibuffer,
            BitmapPixelFormat::Bgra8,
            width as i32,
            height as i32,
        )
        .map_err(|e| OcrError::PreprocessFailed(format!("CreateCopyFromBuffer 失败: {}", e)))?;

        drop(mem_buffer);
        drop(ibuffer);

        Ok(bitmap)
    }

    /// 从 SoftwareBitmap 执行 OCR 识别，返回文本和逐行块。
    pub fn recognize_bitmap(bitmap: &SoftwareBitmap) -> Result<OcrResult, OcrError> {
        let engine = WinOcrEngine::TryCreateFromUserProfileLanguages()
            .map_err(|e| OcrError::Unavailable(format!("创建 OcrEngine 失败: {}", e)))?;

        let async_op = engine
            .RecognizeAsync(bitmap)
            .map_err(|e| OcrError::RecognitionFailed(format!("RecognizeAsync 失败: {}", e)))?;

        let result = async_op
            .get()
            .map_err(|e| OcrError::RecognitionFailed(format!("OCR 异步操作失败: {}", e)))?;

        let text = result
            .Text()
            .map_err(|e| OcrError::RecognitionFailed(format!("获取 OCR 文本失败: {}", e)))?;

        let lines = result
            .Lines()
            .map_err(|e| OcrError::RecognitionFailed(format!("获取 OCR 行失败: {}", e)))?;

        let mut blocks = Vec::new();
        for line in &lines {
            let words = line.Words().ok();
            if let Some(words) = words {
                for word in &words {
                    let bounding_rect = word.BoundingRect().ok();
                    if let Some(rc) = bounding_rect {
                        blocks.push(OcrBlock {
                            text: word.Text().unwrap_or_default().to_string(),
                            x: rc.X,
                            y: rc.Y,
                            width: rc.Width,
                            height: rc.Height,
                            confidence: 0.9, // Windows OCR 不提供逐字置信度
                        });
                    }
                }
            }
        }

        Ok(OcrResult {
            text: text.to_string(),
            blocks,
            engine: "WindowsOCR".to_string(),
            elapsed_ms: 0, // 由外层填充
        })
    }
}

/// Windows 系统 OCR 引擎。
///
/// 在 Windows 10+ 上可用，内部使用 Windows.Media.Ocr API。
pub struct WindowsOcrEngine {
    available: bool,
}

impl WindowsOcrEngine {
    pub fn new() -> Result<Self, OcrError> {
        #[cfg(target_os = "windows")]
        {
            // 尝试验证 OCR 引擎是否可用（任何错误都返回 Err）
            let _engine = windows::Media::Ocr::OcrEngine::TryCreateFromUserProfileLanguages()
                .map_err(|e| OcrError::Unavailable(format!(
                    "Windows OCR 引擎不可用: {}。请确认系统已安装至少一种 OCR 语言包（设置 → 时间和语言 → 语言和区域 → 添加语言 → 安装光学字符识别）",
                    e
                )))?;

            crate::utils::logger::log("ocr", "Windows OCR 引擎已就绪");

            Ok(WindowsOcrEngine { available: true })
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(OcrError::Unavailable(
                "Windows OCR 仅支持 Windows 平台".into(),
            ))
        }
    }
}

impl OcrEngine for WindowsOcrEngine {
    fn recognize(&self, bgra: &[u8], width: u32, height: u32) -> Result<OcrResult, OcrError> {
        if !self.available {
            return Err(OcrError::Unavailable("Windows OCR 引擎不可用".into()));
        }

        #[cfg(target_os = "windows")]
        {
            let start = std::time::Instant::now();
            let bitmap = imp::create_bitmap_from_bgra(bgra, width, height)?;
            let mut result = imp::recognize_bitmap(&bitmap)?;
            result.elapsed_ms = start.elapsed().as_millis() as u64;
            Ok(result)
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(OcrError::Unavailable(
                "Windows OCR 仅支持 Windows 平台".into(),
            ))
        }
    }

    fn name(&self) -> &'static str {
        "WindowsOCR"
    }

    fn is_available(&self) -> bool {
        self.available
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_ocr_engine_creation() {
        let engine = WindowsOcrEngine::new();
        assert!(
            engine.is_ok(),
            "Windows OCR 引擎应创建成功: {:?}",
            engine.err()
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_ocr_small_image() {
        // 截取屏幕左上角 1x1 像素并做 OCR
        let Ok(pixels) = crate::screenshot::capture_screen_region(0, 0, 1, 1) else {
            // A locked desktop or headless test host cannot provide a screen DC.
            return;
        };
        let engine = WindowsOcrEngine::new().expect("创建引擎失败");
        let result = engine.recognize(&pixels, 1, 1);
        // 1x1 区域通常无文字，应返回空文本而非报错
        assert!(result.is_ok(), "OCR 不应报错: {:?}", result.err());
        let r = result.unwrap();
        assert!(r.text.is_empty(), "1x1 像素不应有文字: '{}'", r.text);
        assert_eq!(r.engine, "WindowsOCR");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_ocr_zero_size_rejected() {
        let engine = WindowsOcrEngine::new().expect("创建引擎失败");
        let err = engine.recognize(&[], 0, 10).unwrap_err();
        // 零尺寸会被 create_bitmap_from_bgra 在像素长度检查或 CreateCopyFromBuffer 阶段拒绝
        let msg = err.to_string();
        assert!(
            msg.contains("不足")
                || msg.contains("小于")
                || msg.contains("所需")
                || msg.contains("width or height")
                || msg.contains("预处理"),
            "错误信息应包含尺寸相关描述: {}",
            msg
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_ocr_short_buffer_rejected() {
        let engine = WindowsOcrEngine::new().expect("创建引擎失败");
        let err = engine.recognize(&[0u8; 1], 100, 100).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("不足")
                || msg.contains("小于")
                || msg.contains("所需")
                || msg.contains("预处理"),
            "错误信息应包含尺寸不匹配: {}",
            msg
        );
    }
}
