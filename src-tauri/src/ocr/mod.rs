//! OCR 模块：PaddleOCR ONNX 主引擎 + Windows 内置 OCR 兜底的本地离线识别接口。
//!
//! ## 设计原则
//! - `OcrEngine` trait 定义统一接口
//! - `OcrService` 管理各引擎的生命周期，按「PaddleOCR → Windows OCR」选择激活引擎
//! - `recognize_bgra()` 公开入口，内部校验像素缓冲区并串行化模型会话
//!
//! ## 引擎回退
//! PaddleOCR 不可用时——模型/字典缺失或损坏、ONNX 会话创建失败，或本地缺少
//! `onnxruntime.dll`——服务自动激活 Windows 系统内置 OCR；两个引擎都不可用时才报错。
//!
//! ## 线程模型
//! - `PaddleOcrEngine`: ONNX Runtime 自身线程安全，可在任意线程调用
//! - `WindowsOcrEngine`: 需要 MTA 套间，识别在独立 MTA 线程中执行（见 `recognize_windows`）

#[cfg(test)]
mod accuracy_test;
pub mod engine;
pub mod paddle_ocr;
pub mod windows_ocr;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use engine::{OcrEngine, OcrResult};

/// 全局 OCR 服务单例：初始为 None，首次实际使用 OCR 时由 `ensure_ocr_service()` 懒加载初始化。
/// 避免应用启动时加载 OCR 模型（占用内存与启动开销），用户从不截图识图时零成本。
static GLOBAL_OCR_SERVICE: Mutex<Option<Arc<Mutex<OcrService>>>> = Mutex::new(None);

/// 本地未找到 onnxruntime.dll。由 `main::init_ort_dylib()` 探测后标记。
///
/// `ort` 的 `load-dynamic` 模式在 DLL 不可用时会 panic 或卡在系统加载器里，
/// 而不是返回 `Err`，因此必须在创建 PaddleOCR 之前跳过它，Windows OCR 兜底才有机会生效。
static ORT_DYLIB_MISSING: AtomicBool = AtomicBool::new(false);

/// 标记本地 onnxruntime.dll 缺失，PaddleOCR 将不再尝试初始化。
pub fn mark_ort_dylib_missing() {
    ORT_DYLIB_MISSING.store(true, Ordering::Relaxed);
}

/// 获取全局 OCR 服务的克隆引用（纯读取，不触发加载）。
/// 返回 None 表示尚未初始化（尚未实际使用过 OCR）。
#[allow(dead_code)]
pub fn get_ocr_service() -> Option<Arc<Mutex<OcrService>>> {
    GLOBAL_OCR_SERVICE
        .lock()
        .map_err(|e| {
            crate::utils::logger::log("ocr", &format!("获取 OCR 服务锁失败（可能锁中毒）: {}", e));
            e
        })
        .ok()
        .and_then(|guard| guard.clone())
}

/// 获取全局 OCR 服务，若尚未初始化则立即懒加载（阻塞当前线程直到初始化完成）。
/// 与 `get_ocr_service()` 的区别：本函数在服务未就绪时会触发引擎与模型加载。
/// 加载模型可能耗时数百毫秒，调用方应确保在非主线程（如 `spawn_blocking` 阻塞池）中调用，
/// 避免阻塞 UI 主线程。多线程并发首次调用时，后到者会在锁上等待首次初始化完成。
pub fn ensure_ocr_service() -> Option<Arc<Mutex<OcrService>>> {
    let mut guard = match GLOBAL_OCR_SERVICE.lock() {
        Ok(g) => g,
        Err(e) => {
            crate::utils::logger::log("ocr", &format!("获取 OCR 服务锁失败（可能锁中毒）: {}", e));
            return None;
        }
    };
    if guard.is_none() {
        crate::utils::logger::log("ocr", "OCR 服务未初始化，首次使用触发懒加载...");
        let service = OcrService::new(None);
        *guard = Some(Arc::new(Mutex::new(service)));
    }
    guard.clone()
}

/// 引擎标识
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum EngineId {
    /// Windows 系统内置 OCR（Windows.Media.Ocr），PaddleOCR 不可用时的兜底
    Windows,
    /// PaddleOCR ONNX 本地推理引擎（默认）
    Paddle,
}

impl EngineId {
    pub fn as_str(&self) -> &'static str {
        match self {
            EngineId::Windows => "windows",
            EngineId::Paddle => "paddle",
        }
    }
}

/// OCR 全局服务。
///
/// 负责持有各引擎实例、决定激活引擎，并提供统一的 BGRA 识别入口。
///
/// 通过 `GLOBAL_OCR_SERVICE` (Mutex<Option<Arc<Mutex<OcrService>>>>) 全局单例访问，
/// 首次实际使用 OCR 时由 `ensure_ocr_service()` 懒加载初始化。
pub struct OcrService {
    pub active_engine: EngineId,
    windows: Option<Arc<dyn OcrEngine>>,
    paddle: Option<Arc<dyn OcrEngine>>,
}

impl OcrService {
    /// 创建服务并初始化所有可用引擎。
    ///
    /// 激活引擎的选取顺序：PaddleOCR → Windows 内置 OCR。
    /// PaddleOCR 不可用（模型缺失/损坏、缺少 onnxruntime.dll 或加载失败）时自动落到
    /// Windows OCR，而不是直接不可用。
    pub fn new(model_dir: Option<std::path::PathBuf>) -> Self {
        let windows: Option<Arc<dyn OcrEngine>> = match windows_ocr::WindowsOcrEngine::new() {
            Ok(engine) => {
                if engine.is_available() {
                    crate::utils::logger::log("ocr", "Windows OCR 引擎就绪");
                    Some(Arc::new(engine) as Arc<dyn OcrEngine>)
                } else {
                    crate::utils::logger::log("ocr", "Windows OCR 引擎不可用");
                    None
                }
            }
            Err(e) => {
                crate::utils::logger::log("ocr", &format!("Windows OCR 引擎不可用: {}", e));
                None
            }
        };

        let paddle: Option<Arc<dyn OcrEngine>> = if ORT_DYLIB_MISSING.load(Ordering::Relaxed) {
            crate::utils::logger::log("ocr", "未找到 onnxruntime.dll，跳过 PaddleOCR");
            None
        } else {
            match paddle_ocr::PaddleOcrEngine::new(model_dir.as_deref()) {
                Ok(engine) => {
                    if engine.is_available() {
                        crate::utils::logger::log("ocr", "PaddleOCR 引擎就绪");
                        Some(Arc::new(engine) as Arc<dyn OcrEngine>)
                    } else {
                        crate::utils::logger::log(
                            "ocr",
                            "PaddleOCR 引擎不可用：模型文件未完整安装",
                        );
                        None
                    }
                }
                Err(e) => {
                    crate::utils::logger::log("ocr", &format!("PaddleOCR 引擎初始化失败: {}", e));
                    None
                }
            }
        };

        let windows_available = windows.as_ref().is_some_and(|e| e.is_available());
        let active_engine = Self::select_active(windows_available, paddle.is_some());

        crate::utils::logger::log(
            "ocr",
            &format!(
                "OCR 服务初始化完成，激活引擎: {} (windows={}, paddle={})",
                active_engine.as_str(),
                windows_available,
                paddle.is_some(),
            ),
        );

        OcrService {
            active_engine,
            windows,
            paddle,
        }
    }

    /// 决定激活引擎：PaddleOCR 优先、Windows OCR 兜底。
    fn select_active(has_windows: bool, has_paddle: bool) -> EngineId {
        if has_paddle {
            EngineId::Paddle
        } else if has_windows {
            EngineId::Windows
        } else {
            // 两者都不可用：保持 Paddle 作为名义引擎，识别时给出明确错误
            EngineId::Paddle
        }
    }

    /// 获取当前激活的引擎引用。
    fn active(&self) -> Option<&Arc<dyn OcrEngine>> {
        match self.active_engine {
            EngineId::Windows => self.windows.as_ref(),
            EngineId::Paddle => self.paddle.as_ref(),
        }
    }

    /// 对 BGRA 像素执行 OCR 识别。
    ///
    /// 内部负责输入尺寸校验和模型可用性检查。
    ///
    /// 调用方无需关心引擎类型和线程细节。
    pub fn recognize_bgra(
        &self,
        bgra: &[u8],
        width: u32,
        height: u32,
    ) -> Result<OcrResult, engine::OcrError> {
        if width == 0 || height == 0 {
            return Err(engine::OcrError::PreprocessFailed(
                "OCR 区域尺寸为 0".into(),
            ));
        }
        let expected = (width as u64)
            .saturating_mul(height as u64)
            .saturating_mul(4);
        if bgra.len() < expected as usize {
            return Err(engine::OcrError::PreprocessFailed(format!(
                "像素数据长度 {} 不足以容纳 {}x{} BGRA 数据",
                bgra.len(),
                width,
                height,
            )));
        }

        let engine = self.active().ok_or_else(|| {
            engine::OcrError::Unavailable(
                "无可用的 OCR 引擎：PaddleOCR 不可用（模型或 onnxruntime.dll 缺失/加载失败），且 Windows 内置 OCR 不可用"
                    .into(),
            )
        })?;

        if !engine.is_available() {
            return Err(engine::OcrError::Unavailable(format!(
                "引擎 {} 不可用",
                engine.name()
            )));
        }

        // Windows OCR 需要 MTA 套间，且超大图要分块；PaddleOCR 线程安全，直接调用。
        if self.active_engine == EngineId::Windows {
            self.recognize_windows(engine, bgra, width, height)
        } else {
            engine.recognize(bgra, width, height)
        }
    }

    /// Windows OCR 识别：按高度分块并在独立 MTA 线程中执行。
    ///
    /// WinRT 的 `IAsyncOperation::get()` 在未初始化套间的线程上可能死锁，
    /// 因此每次识别都放到新线程并 `CoInitializeEx(MTA)`；超过 4096px 高的图像
    /// 分块处理，避免超过 Windows OCR 的图像尺寸上限。
    fn recognize_windows(
        &self,
        engine: &Arc<dyn OcrEngine>,
        bgra: &[u8],
        width: u32,
        height: u32,
    ) -> Result<OcrResult, engine::OcrError> {
        const MAX_TILE_HEIGHT: u32 = 4096;

        let row_bytes = (width as usize) * 4;
        let mut full_text = String::new();
        let mut all_blocks = Vec::new();
        let mut total_elapsed = 0u64;

        let mut y = 0u32;
        loop {
            let tile_h = MAX_TILE_HEIGHT.min(height - y);
            let start = (y as usize) * row_bytes;
            let end = start + (tile_h as usize) * row_bytes;
            let mut result = recognize_in_mta(engine, &bgra[start..end], width, tile_h)?;

            // 分块坐标还原到整图坐标系
            for block in &mut result.blocks {
                block.y += y as f32;
            }
            if !result.text.is_empty() {
                if !full_text.is_empty() {
                    full_text.push('\n');
                }
                full_text.push_str(&result.text);
            }
            all_blocks.append(&mut result.blocks);
            total_elapsed += result.elapsed_ms;

            y += tile_h;
            if y >= height {
                break;
            }
        }

        Ok(OcrResult {
            text: full_text,
            blocks: all_blocks,
            engine: engine.name().to_string(),
            elapsed_ms: total_elapsed,
        })
    }
}

/// 在独立 MTA 线程中执行一次 Windows OCR 识别。
fn recognize_in_mta(
    engine: &Arc<dyn OcrEngine>,
    pixels: &[u8],
    width: u32,
    height: u32,
) -> Result<OcrResult, engine::OcrError> {
    std::thread::scope(|scope| {
        let handle = scope.spawn(|| {
            #[cfg(target_os = "windows")]
            unsafe {
                let _ = windows::Win32::System::Com::CoInitializeEx(
                    None,
                    windows::Win32::System::Com::COINIT_MULTITHREADED,
                );
            }
            let result = engine.recognize(pixels, width, height);
            #[cfg(target_os = "windows")]
            unsafe {
                windows::Win32::System::Com::CoUninitialize();
            }
            result
        });

        match handle.join() {
            Ok(result) => result,
            Err(_) => Err(engine::OcrError::RecognitionFailed("OCR 线程 panic".into())),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_select_active_prefers_paddle_then_falls_back_to_windows() {
        // (has_windows, has_paddle)：Paddle 优先，缺失时用 Windows 兜底
        assert_eq!(OcrService::select_active(true, true), EngineId::Paddle);
        assert_eq!(OcrService::select_active(true, false), EngineId::Windows);
        assert_eq!(OcrService::select_active(false, false), EngineId::Paddle);
    }

    #[test]
    fn test_missing_paddle_models_falls_back_to_windows() {
        let missing = std::env::temp_dir().join(format!(
            "levitaire-ocr-missing-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let service = OcrService::new(Some(missing));
        assert!(
            service.paddle.is_none(),
            "模型目录不存在时 PaddleOCR 不应可用"
        );

        #[cfg(target_os = "windows")]
        if windows_ocr::WindowsOcrEngine::new().is_ok() {
            assert!(
                service.windows.is_some(),
                "PaddleOCR 模型缺失时应回退到 Windows OCR"
            );
            assert_eq!(service.active_engine, EngineId::Windows);
        }
    }

    #[test]
    fn test_empty_region_rejected() {
        let service = OcrService::new(None);
        let err = service.recognize_bgra(&[], 0, 10).unwrap_err();
        assert!(err.to_string().contains("尺寸为 0"));
    }

    #[test]
    fn test_short_buffer_rejected() {
        let service = OcrService::new(None);
        let err = service.recognize_bgra(&[0u8; 1], 10, 10).unwrap_err();
        assert!(err.to_string().contains("不足以容纳"));
    }

    /// 实机测试：用全局 OCR 服务对屏幕区域进行真实识别。
    /// 使用 ignored 标记，运行方式：cargo test ocr_live_service -- --ignored --nocapture
    #[test]
    #[ignore]
    fn ocr_live_service_recognize() {
        // 初始化服务
        let service = OcrService::new(None);
        assert!(service.active().is_some(), "至少应有一个引擎可用");

        // 截取屏幕左上角 200x200 区域
        let bgra = crate::screenshot::capture_screen_region(0, 0, 200, 200).expect("截屏失败");
        println!("截取 {} 字节 BGRA 像素", bgra.len());
        println!("激活引擎: {}", service.active_engine.as_str());

        // 通过服务进行 OCR
        match service.recognize_bgra(&bgra, 200, 200) {
            Ok(result) => {
                println!("OCR 成功!");
                println!("  引擎: {}", result.engine);
                println!(
                    "  文本 ({} chars): [{}]",
                    result.text.chars().count(),
                    result.text
                );
                println!("  文字块: {} 个", result.blocks.len());
                println!("  耗时: {}ms", result.elapsed_ms);
                for (i, block) in result.blocks.iter().enumerate() {
                    println!(
                        "  块 {}: ({:.0},{:.0}) {}x{} conf={:.2} text=[{}]",
                        i + 1,
                        block.x,
                        block.y,
                        block.width,
                        block.height,
                        block.confidence,
                        block.text
                    );
                }
            }
            Err(e) => {
                panic!("OCR 失败: {}", e);
            }
        }
    }

    /// 实机测试：验证 OcrService 分块功能（对超过 4096 像素高的区域分块）。
    /// 使用 ignored 标记。
    #[test]
    #[ignore]
    fn ocr_live_service_tiling() {
        let service = OcrService::new(None);

        // 构造一个 100×5000 的 BGRA 图像（合成数据，全黑）
        let w: u32 = 100;
        let h: u32 = 5000;
        let bgra = vec![0u8; (w * h * 4) as usize];

        // 这不应 panic 或 hang
        match service.recognize_bgra(&bgra, w, h) {
            Ok(result) => {
                println!(
                    "分块 OCR 完成: engine={}, text=[{}]",
                    result.engine, result.text
                );
                // 全黑图像应该无文字
            }
            Err(e) => {
                // 识别可能因无文字而失败，但不能是 crash/hang
                println!("分块 OCR 返回错误（可接受）: {}", e);
            }
        }
    }
}
