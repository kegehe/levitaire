//! OCR 引擎统一 trait 与类型定义。
//!
//! 所有 OCR 引擎（Windows 系统 OCR、PaddleOCR ONNX、未来可能的三方 API）均实现此 trait，
//! 对外通过 `OcrService` 统一调度。

/// OCR 识别结果
#[allow(dead_code)] // Detailed OCR metadata is retained for consumers beyond the current text-only command.
#[derive(Debug, Clone)]
pub struct OcrResult {
    /// 识别出的完整文本（多块拼接，换行符分隔）
    pub text: String,
    /// 每个识别块的详细信息（位置、置信度）
    pub blocks: Vec<OcrBlock>,
    /// 使用的引擎名称
    pub engine: String,
    /// 识别耗时（毫秒）
    pub elapsed_ms: u64,
}

/// 单个文字块识别结果
#[allow(dead_code)] // Detailed OCR metadata is retained for consumers beyond the current text-only command.
#[derive(Debug, Clone)]
pub struct OcrBlock {
    /// 识别文本
    pub text: String,
    /// 文本框左上角 x（像素，相对于输入图像）
    pub x: f32,
    /// 文本框左上角 y（像素，相对于输入图像）
    pub y: f32,
    /// 文本框宽度（像素）
    pub width: f32,
    /// 文本框高度（像素）
    pub height: f32,
    /// 识别置信度 (0.0 ~ 1.0)
    pub confidence: f32,
}

/// OCR 引擎统一 trait。
///
/// 引擎实例需要实现 `Send + Sync`，因为 `OcrService` 使用 `Arc<dyn OcrEngine>` 在多线程间共享。
pub trait OcrEngine: Send + Sync {
    /// 对 BGRA 像素数据进行 OCR 识别。
    ///
    /// # 参数
    /// - `bgra`: BGRA8888 像素数据，逐行连续存储
    /// - `width`: 图像宽度（像素）
    /// - `height`: 图像高度（像素）
    ///
    /// # 线程安全
    /// 引擎实现必须是线程安全的。调用方可能在任意线程中调用此方法。
    fn recognize(&self, bgra: &[u8], width: u32, height: u32) -> Result<OcrResult, OcrError>;

    /// 引擎名称标识。
    fn name(&self) -> &'static str;

    /// 引擎是否已就绪可用（模型已加载 / 平台支持等）。
    fn is_available(&self) -> bool;
}

/// OCR 错误类型
#[derive(Debug, thiserror::Error)]
pub enum OcrError {
    /// 引擎不可用（平台不支持 / 模型未加载）
    #[error("OCR 引擎不可用: {0}")]
    Unavailable(String),

    /// 模型文件未找到或加载失败
    #[error("OCR 模型未加载: {0}")]
    ModelNotLoaded(String),

    /// 识别过程失败
    #[error("OCR 识别失败: {0}")]
    RecognitionFailed(String),

    /// 图像预处理失败（尺寸无效、像素格式错误等）
    #[error("图像预处理失败: {0}")]
    PreprocessFailed(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ocr_result_creation() {
        let result = OcrResult {
            text: "hello".to_string(),
            blocks: vec![OcrBlock {
                text: "hello".to_string(),
                x: 10.0,
                y: 20.0,
                width: 50.0,
                height: 30.0,
                confidence: 0.95,
            }],
            engine: "test".to_string(),
            elapsed_ms: 42,
        };
        assert_eq!(result.text, "hello");
        assert_eq!(result.blocks.len(), 1);
        assert_eq!(result.elapsed_ms, 42);
    }

    #[test]
    fn test_ocr_error_display() {
        let err = OcrError::Unavailable("测试错误".to_string());
        assert!(err.to_string().contains("测试错误"));
        assert!(err.to_string().contains("不可用"));
    }

    #[test]
    fn test_ocr_error_model_not_loaded() {
        let err = OcrError::ModelNotLoaded("model.onnx not found".to_string());
        assert!(err.to_string().contains("model.onnx"));
    }
}
