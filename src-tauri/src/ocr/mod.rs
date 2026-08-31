//! OCR 模块：基于 PaddleOCR ONNX 的本地离线识别接口。
//!
//! ## 设计原则
//! - `OcrEngine` trait 定义统一接口
//! - `OcrService` 管理 PaddleOCR 模型生命周期
//! - `recognize_bgra()` 公开入口，内部校验像素缓冲区并串行化模型会话
//!
//! ## 线程模型
//! - `PaddleOcrEngine`: ONNX Runtime 自身线程安全，可在任意线程调用

#[cfg(test)]
mod accuracy_test;
pub mod engine;
pub mod paddle_ocr;
#[cfg(test)]
mod windows_ocr;

use std::sync::{Arc, Mutex};

use engine::{OcrEngine, OcrResult};

/// 全局 OCR 服务单例：初始为 None，首次实际使用 OCR 时由 `ensure_ocr_service()` 懒加载初始化。
/// 避免应用启动时加载 OCR 模型（占用内存与启动开销），用户从不截图识图时零成本。
static GLOBAL_OCR_SERVICE: Mutex<Option<Arc<Mutex<OcrService>>>> = Mutex::new(None);

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
        let service = OcrService::new(Some(EngineId::Paddle), None);
        *guard = Some(Arc::new(Mutex::new(service)));
    }
    guard.clone()
}

/// 引擎标识
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum EngineId {
    /// 已弃用：Windows 系统内置 OCR（Windows.Media.Ocr）
    Windows,
    /// PaddleOCR ONNX 本地推理引擎
    Paddle,
}

impl EngineId {
    pub fn as_str(&self) -> &'static str {
        match self {
            EngineId::Windows => "windows",
            EngineId::Paddle => "paddle",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "windows" => Some(EngineId::Windows),
            "paddle" => Some(EngineId::Paddle),
            _ => None,
        }
    }
}

/// OCR 全局服务。
///
/// 负责持有 PaddleOCR 实例，并提供统一的 BGRA 识别入口。
///
/// 通过 `GLOBAL_OCR_SERVICE` (Mutex<Option<Arc<Mutex<OcrService>>>>) 全局单例访问，
/// 首次实际使用 OCR 时由 `ensure_ocr_service()` 懒加载初始化。
pub struct OcrService {
    pub active_engine: EngineId,
    paddle: Option<Arc<dyn OcrEngine>>,
}

impl OcrService {
    /// 创建服务并初始化固定的 PaddleOCR 引擎。
    pub fn new(_prefer: Option<EngineId>, model_dir: Option<std::path::PathBuf>) -> Self {
        let paddle: Option<Arc<dyn OcrEngine>> =
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
            };

        let active_engine = EngineId::Paddle;

        crate::utils::logger::log(
            "ocr",
            &format!(
                "OCR 服务初始化完成，激活引擎: {} (paddle={})",
                active_engine.as_str(),
                paddle.is_some(),
            ),
        );

        OcrService {
            active_engine,
            paddle,
        }
    }

    /// 获取当前激活的引擎引用。
    fn active(&self) -> Option<&Arc<dyn OcrEngine>> {
        match self.active_engine {
            EngineId::Windows => None,
            EngineId::Paddle => self.paddle.as_ref(),
        }
    }

    /// 切换激活引擎。返回是否切换成功。
    pub fn switch_engine(&mut self, id: EngineId) -> bool {
        if id != EngineId::Paddle {
            return false;
        }
        let available = match id {
            EngineId::Windows => false,
            EngineId::Paddle => self.paddle.is_some(),
        };
        if available {
            self.active_engine = id;
            crate::utils::logger::log("ocr", &format!("引擎已切换为: {}", id.as_str()));
        }
        available
    }

    /// 返回固定 OCR 引擎的可用状态，保留给旧版命令兼容。
    pub fn available_engines(&self) -> Vec<EngineId> {
        self.paddle
            .as_ref()
            .map(|_| vec![EngineId::Paddle])
            .unwrap_or_default()
    }

    /// 获取激活引擎的名称
    pub fn active_engine_name(&self) -> &'static str {
        self.active_engine.as_str()
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

        let engine = self
            .active()
            .ok_or_else(|| engine::OcrError::Unavailable("无可用的 OCR 引擎".into()))?;

        if !engine.is_available() {
            return Err(engine::OcrError::Unavailable(format!(
                "引擎 {} 不可用",
                engine.name()
            )));
        }

        engine.recognize(bgra, width, height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_engine_id_roundtrip() {
        assert_eq!(EngineId::from_str("windows"), Some(EngineId::Windows));
        assert_eq!(EngineId::from_str("PADDLE"), Some(EngineId::Paddle));
        assert_eq!(EngineId::from_str("unknown"), None);
        assert_eq!(EngineId::Windows.as_str(), "windows");
        assert_eq!(EngineId::Paddle.as_str(), "paddle");
    }

    #[test]
    fn test_ocr_service_is_fixed_to_paddle() {
        let service = OcrService::new(None, None);
        assert_eq!(service.active_engine_name(), "paddle");
    }

    #[test]
    fn test_ocr_service_switch_engine() {
        let mut service = OcrService::new(None, None);
        assert!(!service.switch_engine(EngineId::Windows));
        assert_eq!(service.active_engine_name(), "paddle");
    }

    #[test]
    fn test_empty_region_rejected() {
        let service = OcrService::new(None, None);
        let err = service.recognize_bgra(&[], 0, 10).unwrap_err();
        assert!(err.to_string().contains("尺寸为 0"));
    }

    #[test]
    fn test_short_buffer_rejected() {
        let service = OcrService::new(None, None);
        let err = service.recognize_bgra(&[0u8; 1], 10, 10).unwrap_err();
        assert!(err.to_string().contains("不足以容纳"));
    }

    /// 实机测试：用全局 OCR 服务对屏幕区域进行真实识别。
    /// 使用 ignored 标记，运行方式：cargo test ocr_live_service -- --ignored --nocapture
    #[test]
    #[ignore]
    fn ocr_live_service_recognize() {
        // 初始化服务
        let service = OcrService::new(None, None);
        assert!(
            !service.available_engines().is_empty(),
            "至少应有一个引擎可用"
        );

        // 截取屏幕左上角 200x200 区域
        let bgra = crate::screenshot::capture_screen_region(0, 0, 200, 200).expect("截屏失败");
        println!("截取 {} 字节 BGRA 像素", bgra.len());
        println!("激活引擎: {}", service.active_engine_name());

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
        let service = OcrService::new(None, None);

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

    /// 实机测试：验证引擎切换功能。
    /// 使用 ignored 标记。
    #[test]
    #[ignore]
    fn ocr_live_engine_switch() {
        let mut service = OcrService::new(None, None);
        let engines = service.available_engines();
        println!(
            "可用引擎: {:?}",
            engines.iter().map(|e| e.as_str()).collect::<Vec<_>>()
        );

        let bgra = crate::screenshot::capture_screen_region(0, 0, 100, 100).expect("截屏失败");

        for engine_id in &engines {
            println!("\n切换引擎到: {}", engine_id.as_str());
            let switched = service.switch_engine(*engine_id);
            assert!(switched, "切换应成功: {}", engine_id.as_str());
            assert_eq!(service.active_engine_name(), engine_id.as_str());

            match service.recognize_bgra(&bgra, 100, 100) {
                Ok(result) => {
                    println!(
                        "  {} 识别成功: {} chars, {}ms",
                        result.engine,
                        result.text.chars().count(),
                        result.elapsed_ms
                    );
                    // 验证引擎名称与实际激活引擎一致
                    let expected_name = match engine_id {
                        EngineId::Windows => "WindowsOCR",
                        EngineId::Paddle => "PaddleOCR",
                    };
                    assert_eq!(
                        result.engine, expected_name,
                        "引擎名称不匹配: expected {}, got {}",
                        expected_name, result.engine
                    );
                }
                Err(e) => {
                    println!("  {} 识别失败: {}", engine_id.as_str(), e);
                }
            }
        }
    }
}
