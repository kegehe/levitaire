//! OCR 模块：统一离线 + 在线 OCR 引擎接口。
//!
//! ## 设计原则
//! - `OcrEngine` trait 定义统一接口，各引擎独立实现
//! - `OcrService` 管理引擎选择、模型生命周期、线程调度
//! - `recognize_bgra()` 公开入口，内部自动处理分块、COM 线程、锁隔离
//!
//! ## 引擎选择策略
//! 1. 用户手动选择 → 使用指定引擎
//! 2. Windows 平台 → 默认 Windows.Media.Ocr（零依赖，系统内置）
//! 3. 非 Windows 或 Windows OCR 不可用 → PaddleOCR-ONNX
//!
//! ## 线程模型
//! - `WindowsOcrEngine`: WTA COM，在 MTA 子线程中执行 (`CoInitializeEx(MTA)`)
//! - `PaddleOcrEngine`: ONNX Runtime 自身线程安全，可在任意线程调用
//! - 大图自动分块（>4096px 高度），每块独立线程 + COM 隔离

#[cfg(test)]
mod accuracy_test;
pub mod engine;
pub mod paddle_ocr;
pub mod windows_ocr;

use std::sync::{Arc, Mutex};

use engine::{OcrEngine, OcrResult};

/// 全局 OCR 服务单例：初始为 None，首次实际使用 OCR 时由 `ensure_ocr_service()` 懒加载初始化。
/// 避免应用启动时加载 OCR 模型（占用内存与启动开销），用户从不截图识图时零成本。
static GLOBAL_OCR_SERVICE: Mutex<Option<Arc<Mutex<OcrService>>>> = Mutex::new(None);

/// 用户在设置中选择的引擎偏好（配置持久化，启动时由 main.rs 注入）。
/// 在 `ensure_ocr_service()` 首次懒加载初始化时作为 `prefer` 传入 `OcrService::new`。
/// 仅在服务初始化前有意义；服务初始化后引擎切换直接操作 OcrService 实例。
static PREFERRED_ENGINE: Mutex<Option<EngineId>> = Mutex::new(None);

/// 设置用户偏好的 OCR 引擎（None 表示未设置，按默认策略自动选择）。
/// 由 main.rs 启动时从持久化配置读取并调用。
pub fn set_preferred_engine(id: Option<EngineId>) {
    if let Ok(mut guard) = PREFERRED_ENGINE.lock() {
        *guard = id;
    }
}

/// 获取全局 OCR 服务的克隆引用（纯读取，不触发加载）。
/// 返回 None 表示尚未初始化（尚未实际使用过 OCR）。
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
        let prefer = PREFERRED_ENGINE.lock().ok().and_then(|g| *g);
        if let Some(id) = prefer {
            crate::utils::logger::log("ocr", &format!("应用配置的引擎偏好: {}", id.as_str()));
        }
        let service = OcrService::new(prefer, None);
        *guard = Some(Arc::new(Mutex::new(service)));
    }
    guard.clone()
}

/// 引擎标识
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum EngineId {
    /// Windows 系统内置 OCR（Windows.Media.Ocr）
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
/// 负责：
/// - 持有所有可用引擎实例
/// - 根据配置选择激活引擎
/// - 提供 `recognize_bgra()` 统一入口
/// - 处理大图自动分块 + COM 线程隔离
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
    /// `prefer` 为用户偏好引擎；实际激活按策略：用户选择 → 平台可用 → fallback。
    pub fn new(prefer: Option<EngineId>, model_dir: Option<std::path::PathBuf>) -> Self {
        let windows: Option<Arc<dyn OcrEngine>> = match windows_ocr::WindowsOcrEngine::new() {
            Ok(engine) => {
                if engine.is_available() {
                    crate::utils::logger::log("ocr", "Windows OCR 引擎就绪");
                }
                Some(Arc::new(engine) as Arc<dyn OcrEngine>)
            }
            Err(e) => {
                crate::utils::logger::log("ocr", &format!("Windows OCR 引擎不可用: {}", e));
                None
            }
        };

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

        // 确定激活引擎（windows 需实际可用，而非仅成功创建——WindowsOcrEngine 创建总是 Ok，
        // 内部通过 is_available 记录运行时就绪状态，与 paddle 用 None 表示不可用的语义对齐）
        let windows_available = windows.as_ref().is_some_and(|e| e.is_available());
        let active_engine = Self::select_active(prefer, windows_available, paddle.is_some());

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

    fn select_active(prefer: Option<EngineId>, has_windows: bool, has_paddle: bool) -> EngineId {
        match prefer {
            Some(EngineId::Paddle) if has_paddle => EngineId::Paddle,
            Some(EngineId::Windows) if has_windows => EngineId::Windows,
            Some(_) => {
                // 指定引擎不可用，回退到可用引擎；全部不可用时回退 Windows（识别时再报错）
                if has_windows {
                    EngineId::Windows
                } else if has_paddle {
                    EngineId::Paddle
                } else {
                    EngineId::Windows
                }
            }
            None => {
                // 自动选择
                if has_windows {
                    EngineId::Windows
                } else if has_paddle {
                    EngineId::Paddle
                } else {
                    EngineId::Windows
                }
            }
        }
    }

    /// 获取当前激活的引擎引用。
    fn active(&self) -> Option<&Arc<dyn OcrEngine>> {
        match self.active_engine {
            EngineId::Windows => self.windows.as_ref(),
            EngineId::Paddle => self.paddle.as_ref(),
        }
    }

    /// 切换激活引擎。返回是否切换成功。
    pub fn switch_engine(&mut self, id: EngineId) -> bool {
        let available = match id {
            EngineId::Windows => self.windows.as_ref().is_some_and(|e| e.is_available()),
            EngineId::Paddle => self.paddle.is_some(),
        };
        if available {
            self.active_engine = id;
            crate::utils::logger::log("ocr", &format!("引擎已切换为: {}", id.as_str()));
        }
        available
    }

    /// 获取所有可用引擎 ID 列表（供前端设置页展示）。
    /// 仅返回实际可用的引擎：windows 需 is_available，paddle 以 Option 是否为 None 表示不可用。
    pub fn available_engines(&self) -> Vec<EngineId> {
        let mut ids = Vec::new();
        if self.windows.as_ref().is_some_and(|e| e.is_available()) {
            ids.push(EngineId::Windows);
        }
        if self.paddle.is_some() {
            ids.push(EngineId::Paddle);
        }
        ids
    }

    /// 获取激活引擎的名称
    pub fn active_engine_name(&self) -> &'static str {
        self.active_engine.as_str()
    }

    /// 对 BGRA 像素执行 OCR 识别。
    ///
    /// 内部自动处理：
    /// - 大图分块（高度 > 4096px）
    /// - COM 线程隔离（MTA 子线程）
    /// - 像素格式转换
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

        // Windows OCR 需要 COM 隔离（MTA 线程 + 分块）；
        // PaddleOCR ONNX Runtime 自身线程安全，直接调用即可。
        match engine.name() {
            "WindowsOCR" => self.recognize_with_tiling(engine.clone(), bgra, width, height),
            _ => engine.recognize(bgra, width, height),
        }
    }

    /// 分块 + MTA 线程隔离的 OCR（用于需要 COM 隔离的引擎，如 Windows OCR）。
    /// 当高度 > 4096 时分块，每块独立 MTA 线程识别后拼接。
    fn recognize_with_tiling(
        &self,
        engine: Arc<dyn OcrEngine>,
        bgra: &[u8],
        width: u32,
        height: u32,
    ) -> Result<OcrResult, engine::OcrError> {
        const MAX_TILE: u32 = 4096;

        if height <= MAX_TILE {
            return self.recognize_in_mta(engine, bgra.to_vec(), width, height);
        }

        // 高度方向分块
        let row_bytes = (width as usize) * 4;
        let mut tiles: Vec<(u32, u32, Vec<u8>)> = Vec::new();
        let mut y: u32 = 0;
        while y < height {
            let tile_h = std::cmp::min(MAX_TILE, height - y);
            let start = (y as usize) * row_bytes;
            let end = start + (tile_h as usize) * row_bytes;
            tiles.push((y, tile_h, bgra[start..end].to_vec()));
            y += tile_h;
        }

        // 每个分块独立 MTA 线程
        let mut handles: Vec<std::thread::JoinHandle<Result<OcrResult, engine::OcrError>>> =
            Vec::with_capacity(tiles.len());
        for (_tile_y, tile_h, tile_pixels) in tiles {
            let e = engine.clone();
            let w = width;
            handles.push(std::thread::spawn(move || {
                // MTA COM 初始化
                #[cfg(target_os = "windows")]
                unsafe {
                    let _ = windows::Win32::System::Com::CoInitializeEx(
                        None,
                        windows::Win32::System::Com::COINIT_MULTITHREADED,
                    );
                }
                let res = e.recognize(&tile_pixels, w, tile_h);
                #[cfg(target_os = "windows")]
                unsafe {
                    windows::Win32::System::Com::CoUninitialize();
                }
                res
            }));
        }

        // 收集结果
        let mut full_text = String::new();
        let mut all_blocks = Vec::new();
        let mut total_elapsed = 0u64;

        for h in handles {
            match h.join() {
                Ok(Ok(result)) => {
                    if !full_text.is_empty() {
                        full_text.push('\n');
                    }
                    full_text.push_str(&result.text);
                    all_blocks.extend(result.blocks);
                    total_elapsed = std::cmp::max(total_elapsed, result.elapsed_ms);
                }
                Ok(Err(e)) => return Err(e),
                Err(e) => {
                    return Err(engine::OcrError::RecognitionFailed(format!(
                        "OCR 线程 panic: {:?}",
                        e
                    )))
                }
            }
        }

        Ok(OcrResult {
            text: full_text,
            blocks: all_blocks,
            engine: engine.name().to_string(),
            elapsed_ms: total_elapsed,
        })
    }

    /// 在 MTA 子线程中执行单次 OCR 识别。
    fn recognize_in_mta(
        &self,
        engine: Arc<dyn OcrEngine>,
        pixels: Vec<u8>,
        width: u32,
        height: u32,
    ) -> Result<OcrResult, engine::OcrError> {
        let handle = std::thread::spawn(move || {
            #[cfg(target_os = "windows")]
            unsafe {
                let _ = windows::Win32::System::Com::CoInitializeEx(
                    None,
                    windows::Win32::System::Com::COINIT_MULTITHREADED,
                );
            }
            let res = engine.recognize(&pixels, width, height);
            #[cfg(target_os = "windows")]
            unsafe {
                windows::Win32::System::Com::CoUninitialize();
            }
            res
        });

        match handle.join() {
            Ok(result) => result,
            Err(e) => Err(engine::OcrError::RecognitionFailed(format!(
                "OCR 线程 panic: {:?}",
                e
            ))),
        }
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
    fn test_ocr_service_creation_windows() {
        // 无模型目录，仅 Windows OCR 可用（Windows 平台）
        let service = OcrService::new(None, None);
        let engines = service.available_engines();
        // 至少有一个引擎（在 Windows 上）
        if cfg!(target_os = "windows") {
            assert!(!engines.is_empty(), "Windows 上至少应有 Windows OCR");
        }
    }

    #[test]
    fn test_ocr_service_switch_engine() {
        let mut service = OcrService::new(None, None);
        let current = service.active_engine_name();

        // 切换到 Paddle（可能不可用）
        service.switch_engine(EngineId::Paddle);
        // 如果没有 Paddle 引擎，保持原引擎
        if service.paddle.is_some() {
            assert_eq!(service.active_engine_name(), "paddle");
        } else {
            assert_eq!(service.active_engine_name(), current);
        }
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
