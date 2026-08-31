//! PaddleOCR ONNX 本地推理引擎。
//!
//! ## 模型获取
//! 1. 从 RapidOCR 获取 PP-OCRv6 ONNX 推理模型
//! 2. 使用 `paddle2onnx` 转换为 ONNX 格式
//! 3. 或从 RapidAI/RapidOCR 获取预转换的 ONNX 模型
//!
//! 模型文件放到 `%APPDATA%/levitaire/ocr/`:
//! - det.onnx (检测模型)
//! - rec.onnx (识别模型)
//! - ppocr_keys_v1.txt (PP-OCRv6 字典)

use std::path::Path;
use std::sync::Mutex;

use ndarray::Array;
use ort::session::{builder::SessionBuilder, Session};
use ort::value::Value;

use super::engine::{OcrBlock, OcrEngine, OcrError, OcrResult};

// ─── 模型参数 ────────────────────────────────────────────────────

const DET_MODEL: &str = "det.onnx";
const REC_MODEL: &str = "rec.onnx";
const DICT_FILE: &str = "ppocr_keys_v1.txt";

const DET_SIZE: u32 = 960;
const DET_THRESH: f32 = 0.3;
const REC_H: u32 = 48;
const REC_MIN_W: u32 = 320;
const REC_MAX_W: u32 = 4096;

const DET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const DET_STD: [f32; 3] = [0.229, 0.224, 0.225];
// PP-OCR recognition models are trained with symmetric normalization.
const REC_MEAN: f32 = 0.5;
const REC_STD: f32 = 0.5;
const SCALE: f32 = 1.0 / 255.0;

pub struct PaddleOcrEngine {
    available: bool,
    det_session: Option<Mutex<Session>>,
    rec_session: Option<Mutex<Session>>,
    char_dict: Vec<String>,
    blank_idx: usize,
}

impl PaddleOcrEngine {
    pub fn new(model_dir: Option<&Path>) -> Result<Self, OcrError> {
        let model_dir = model_dir
            .map(|p| p.to_path_buf())
            .or_else(get_default_model_dir)
            .unwrap_or_else(|| std::path::PathBuf::from("."));

        let det_path = model_dir.join(DET_MODEL);
        let rec_path = model_dir.join(REC_MODEL);
        let dict_path = model_dir.join(DICT_FILE);

        if !det_path.exists() || !rec_path.exists() || !dict_path.exists() {
            crate::utils::logger::log(
                "ocr",
                &format!(
                    "PaddleOCR 模型缺失: det={}, rec={}, dict={}",
                    det_path.exists(),
                    rec_path.exists(),
                    dict_path.exists()
                ),
            );
            return Ok(Self {
                available: false,
                det_session: None,
                rec_session: None,
                char_dict: Vec::new(),
                blank_idx: 0,
            });
        }

        let det_bytes = std::fs::read(&det_path).map_err(|e| {
            OcrError::ModelNotLoaded(format!("读取检测模型失败 {}: {}", det_path.display(), e))
        })?;
        let det_session = SessionBuilder::new()
            .map_err(|e| OcrError::ModelNotLoaded(format!("创建 SessionBuilder 失败: {}", e)))?
            .commit_from_memory(&det_bytes)
            .map_err(|e| {
                OcrError::ModelNotLoaded(format!("加载检测模型失败 {}: {}", det_path.display(), e))
            })?;

        let rec_bytes = std::fs::read(&rec_path).map_err(|e| {
            OcrError::ModelNotLoaded(format!("读取识别模型失败 {}: {}", rec_path.display(), e))
        })?;
        let rec_session = SessionBuilder::new()
            .map_err(|e| OcrError::ModelNotLoaded(format!("创建 SessionBuilder 失败: {}", e)))?
            .commit_from_memory(&rec_bytes)
            .map_err(|e| {
                OcrError::ModelNotLoaded(format!("加载识别模型失败 {}: {}", rec_path.display(), e))
            })?;

        let dict_content = std::fs::read_to_string(&dict_path).map_err(|e| {
            OcrError::ModelNotLoaded(format!("读取字典失败 {}: {}", dict_path.display(), e))
        })?;

        // Keep whitespace characters that are actual dictionary entries (notably U+3000).
        // `trim()` would remove them and shift every following CTC class.
        let char_dict: Vec<String> = dict_content
            .lines()
            .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
            .filter(|l| !l.is_empty())
            .collect();

        if char_dict.is_empty() {
            return Err(OcrError::ModelNotLoaded("字典文件为空".into()));
        }
        // PaddleOCR 标准字典约 6600+ 字符；过短视为损坏
        if char_dict.len() < 100 {
            return Err(OcrError::ModelNotLoaded(format!(
                "字典文件过短 ({} 字符)，可能已损坏",
                char_dict.len()
            )));
        }

        crate::utils::logger::log(
            "ocr",
            &format!("PaddleOCR 模型加载成功 (dict: {} chars)", char_dict.len()),
        );

        Ok(Self {
            available: true,
            det_session: Some(Mutex::new(det_session)),
            rec_session: Some(Mutex::new(rec_session)),
            char_dict,
            blank_idx: 0,
        })
    }

    // ─── 预处理 ──────────────────────────────────────────────────

    fn preprocess_det(
        &self,
        bgra: &[u8],
        w: u32,
        h: u32,
    ) -> Result<(Array<f32, ndarray::IxDyn>, f32, f32), OcrError> {
        if w == 0 || h == 0 {
            return Err(OcrError::PreprocessFailed("尺寸为 0".into()));
        }
        let scale = DET_SIZE as f32 / (w.max(h) as f32);
        let nw = ((w as f32) * scale).round() as u32;
        let nh = ((h as f32) * scale).round() as u32;

        let mut flat = vec![0f32; (3 * DET_SIZE * DET_SIZE) as usize];
        let fw = w as usize;
        let fh = h as usize;
        let ds = DET_SIZE as usize;

        for row in 0..nh as usize {
            let sr = (row as f32 / scale) as usize;
            if sr >= fh {
                continue;
            }
            for col in 0..nw as usize {
                let sc = (col as f32 / scale) as usize;
                if sc >= fw {
                    continue;
                }
                let si = (sr * fw + sc) * 4;
                let d = row * ds + col;
                let b = bgra[si] as f32 * SCALE;
                let g = bgra[si + 1] as f32 * SCALE;
                let r = bgra[si + 2] as f32 * SCALE;
                flat[d] = (b - DET_MEAN[0]) / DET_STD[0];
                flat[ds * ds + d] = (g - DET_MEAN[1]) / DET_STD[1];
                flat[2 * ds * ds + d] = (r - DET_MEAN[2]) / DET_STD[2];
            }
        }

        Array::from_shape_vec(ndarray::IxDyn(&[1, 3, ds, ds]), flat)
            .map(|a| (a, 1.0 / scale, 1.0 / scale))
            .map_err(|e| OcrError::PreprocessFailed(format!("tensor: {}", e)))
    }

    fn preprocess_rec(
        &self,
        bgra: &[u8],
        iw: u32,
        ih: u32,
        b: &TextBox,
    ) -> Result<Array<f32, ndarray::IxDyn>, OcrError> {
        // DB threshold boxes are often tight around glyph pixels. Add a small margin so
        // anti-aliased tops/bottoms are not clipped before recognition.
        let raw_cw = (b.x2 - b.x1).max(1.0);
        let raw_ch = (b.y2 - b.y1).max(1.0);
        let pad_x = (raw_cw * 0.02).max(1.0);
        let pad_y = (raw_ch * 0.30).max(2.0);
        let x1 = (b.x1 - pad_x).max(0.0).min(iw as f32) as u32;
        let y1 = (b.y1 - pad_y).max(0.0).min(ih as f32) as u32;
        let x2 = (b.x2 + pad_x).max(0.0).min(iw as f32) as u32;
        let y2 = (b.y2 + pad_y).max(0.0).min(ih as f32) as u32;
        let cw = (x2.saturating_sub(x1)).max(1);
        let ch = (y2.saturating_sub(y1)).max(1);

        let sy = REC_H as f32 / ch as f32;
        // Recognition models support dynamic width. Preserve the line aspect ratio instead
        // of squeezing long Chinese lines into 320 px (which drops most characters).
        let resized_w = ((cw as f32) * sy).ceil() as u32;
        let target_w = resized_w.clamp(REC_MIN_W, REC_MAX_W);
        let resized_w = resized_w.min(target_w);
        let sx = cw as f32 / resized_w as f32;
        let sc_y = ch as f32 / REC_H as f32;

        let mut flat = vec![0f32; (3 * REC_H * target_w) as usize];
        let fw = iw as usize;
        let rw = target_w as usize;
        let rh = REC_H as usize;

        for row in 0..rh {
            let sr = y1 as usize + ((row as f32) * sc_y) as usize;
            if sr >= ih as usize {
                break;
            }
            for col in 0..resized_w as usize {
                let sc = x1 as usize + ((col as f32) * sx) as usize;
                if sc >= fw {
                    break;
                }
                let si = (sr * fw + sc) * 4;
                let d = row * rw + col;
                let b = bgra[si] as f32 * SCALE;
                let g = bgra[si + 1] as f32 * SCALE;
                let r = bgra[si + 2] as f32 * SCALE;
                flat[d] = (b - REC_MEAN) / REC_STD;
                flat[rw * rh + d] = (g - REC_MEAN) / REC_STD;
                flat[2 * rw * rh + d] = (r - REC_MEAN) / REC_STD;
            }
        }

        Array::from_shape_vec(ndarray::IxDyn(&[1, 3, rh, rw]), flat)
            .map_err(|e| OcrError::PreprocessFailed(format!("rec tensor: {}", e)))
    }

    // ─── 检测 ────────────────────────────────────────────────────

    fn detect(
        &self,
        input: Array<f32, ndarray::IxDyn>,
        rh: f32,
        rw: f32,
    ) -> Result<Vec<TextBox>, OcrError> {
        let session = self
            .det_session
            .as_ref()
            .ok_or_else(|| OcrError::Unavailable("检测模型未加载".into()))?;

        // 获取模型第一个输入的名称
        let (input_name, out_name) = {
            let s = session
                .lock()
                .map_err(|e| OcrError::RecognitionFailed(format!("lock: {}", e)))?;
            (
                s.inputs()[0].name().to_string(),
                s.outputs()[0].name().to_string(),
            )
        };

        let input_value = Value::from_array(input.into_dyn())
            .map_err(|e| OcrError::RecognitionFailed(format!("det value: {}", e)))?;

        let inputs = ort::inputs![input_name.clone() => input_value];

        let mut s = session
            .lock()
            .map_err(|e| OcrError::RecognitionFailed(format!("lock: {}", e)))?;
        let outputs = s
            .run(inputs)
            .map_err(|e| OcrError::RecognitionFailed(format!("det run: {}", e)))?;

        let (shape, data) = outputs[out_name.as_str()]
            .try_extract_tensor::<f32>()
            .map_err(|e| OcrError::RecognitionFailed(format!("det output: {}", e)))?;

        self.postprocess_det(shape, data, rh, rw)
    }

    fn postprocess_det(
        &self,
        shape: &ort::value::Shape,
        data: &[f32],
        rh: f32,
        rw: f32,
    ) -> Result<Vec<TextBox>, OcrError> {
        let dims: Vec<usize> = shape.as_ref().iter().map(|&d| d as usize).collect();
        if dims.len() < 3 {
            return Ok(Vec::new());
        }
        let h = dims[dims.len() - 2];
        let w = dims[dims.len() - 1];
        // data is flat [N, C, H, W] — extract last channel
        let offset = if dims.len() >= 4 && dims[1] >= 1 {
            (dims[1] - 1)
                .checked_mul(h)
                .and_then(|v| v.checked_mul(w))
                .ok_or_else(|| OcrError::RecognitionFailed("det output shape overflow".into()))?
        } else {
            0
        };
        let required =
            offset
                .checked_add(h.checked_mul(w).ok_or_else(|| {
                    OcrError::RecognitionFailed("det output shape overflow".into())
                })?)
                .ok_or_else(|| OcrError::RecognitionFailed("det output shape overflow".into()))?;
        if required > data.len() {
            return Err(OcrError::RecognitionFailed(format!(
                "det output data too short: {} < {}",
                data.len(),
                required
            )));
        }

        let mut binary = vec![false; h * w];
        for i in 0..h {
            for j in 0..w {
                let val = data[offset + i * w + j];
                binary[i * w + j] = val > DET_THRESH;
            }
        }

        // 连通区域标记 (BFS)
        let mut visited = vec![false; h * w];
        let mut boxes: Vec<TextBox> = Vec::new();
        let dirs: [(isize, isize); 4] = [(0, 1), (0, -1), (1, 0), (-1, 0)];

        for i in 0..h {
            for j in 0..w {
                let idx = i * w + j;
                if binary[idx] && !visited[idx] {
                    let mut min_x = j;
                    let mut max_x = j;
                    let mut min_y = i;
                    let mut max_y = i;
                    let mut count = 0usize;
                    let mut stack = vec![(i, j)];
                    visited[idx] = true;

                    while let Some((y, x)) = stack.pop() {
                        count += 1;
                        min_x = min_x.min(x);
                        max_x = max_x.max(x);
                        min_y = min_y.min(y);
                        max_y = max_y.max(y);
                        for (dy, dx) in &dirs {
                            let ny = y as isize + dy;
                            let nx = x as isize + dx;
                            if ny >= 0 && ny < h as isize && nx >= 0 && nx < w as isize {
                                let nidx = (ny as usize) * w + (nx as usize);
                                if binary[nidx] && !visited[nidx] {
                                    visited[nidx] = true;
                                    stack.push((ny as usize, nx as usize));
                                }
                            }
                        }
                    }

                    if count < 10 {
                        continue;
                    }
                    boxes.push(TextBox {
                        x1: min_x as f32 * rw,
                        y1: min_y as f32 * rh,
                        x2: (max_x + 1) as f32 * rw,
                        y2: (max_y + 1) as f32 * rh,
                    });
                }
            }
        }

        // 排序 + 合并
        boxes.sort_by(|a, b| {
            let dy = a.y1 - b.y1;
            if dy.abs() < (a.y2 - a.y1).min(b.y2 - b.y1) * 0.5 {
                a.x1.partial_cmp(&b.x1).unwrap_or(std::cmp::Ordering::Equal)
            } else {
                dy.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
            }
        });

        Ok(merge_boxes(&boxes))
    }

    // ─── 识别 ────────────────────────────────────────────────────

    fn recognize_one(&self, input: Array<f32, ndarray::IxDyn>) -> Result<(String, f32), OcrError> {
        let session = self
            .rec_session
            .as_ref()
            .ok_or_else(|| OcrError::Unavailable("识别模型未加载".into()))?;

        let (input_name, out_name) = {
            let s = session
                .lock()
                .map_err(|e| OcrError::RecognitionFailed(format!("lock: {}", e)))?;
            (
                s.inputs()[0].name().to_string(),
                s.outputs()[0].name().to_string(),
            )
        };

        let input_value = Value::from_array(input.into_dyn())
            .map_err(|e| OcrError::RecognitionFailed(format!("rec value: {}", e)))?;

        let inputs = ort::inputs![input_name.clone() => input_value];

        let mut s = session
            .lock()
            .map_err(|e| OcrError::RecognitionFailed(format!("lock: {}", e)))?;
        let outputs = s
            .run(inputs)
            .map_err(|e| OcrError::RecognitionFailed(format!("rec run: {}", e)))?;

        let (shape, data) = outputs[out_name.as_str()]
            .try_extract_tensor::<f32>()
            .map_err(|e| OcrError::RecognitionFailed(format!("rec output: {}", e)))?;

        self.ctc_decode(shape, data)
    }

    fn ctc_decode(
        &self,
        shape: &ort::value::Shape,
        data: &[f32],
    ) -> Result<(String, f32), OcrError> {
        let dims: Vec<usize> = shape.as_ref().iter().map(|&d| d as usize).collect();
        if dims.len() < 3 {
            return Err(OcrError::RecognitionFailed("logits shape < 3".into()));
        }
        let seq_len = dims[dims.len() - 2];
        let num_classes = dims[dims.len() - 1];
        let required = seq_len
            .checked_mul(num_classes)
            .ok_or_else(|| OcrError::RecognitionFailed("rec output shape overflow".into()))?;
        if required > data.len() {
            return Err(OcrError::RecognitionFailed(format!(
                "rec output data too short: {} < {}",
                data.len(),
                required
            )));
        }

        // CTC output is [blank] + dictionary + optional ASCII space.
        let expected_base = self.char_dict.len() + 1;
        if num_classes != expected_base && num_classes != expected_base + 1 {
            return Err(OcrError::RecognitionFailed(format!(
                "识别模型类别数 {} 与字典 {} 不匹配",
                num_classes,
                self.char_dict.len()
            )));
        }

        // data is flat: [1, seq_len, num_classes]
        let mut last_char: isize = -1;
        let mut chars: Vec<char> = Vec::new();
        let mut conf_sum = 0f32;
        let mut conf_count = 0u32;

        for t in 0..seq_len {
            let mut max_idx = 0usize;
            let mut max_val = f32::NEG_INFINITY;
            for c in 0..num_classes {
                let v = data[t * num_classes + c];
                if v > max_val {
                    max_val = v;
                    max_idx = c;
                }
            }
            if max_idx != self.blank_idx && max_idx as isize != last_char {
                // PaddleOCR dictionaries contain only printable characters. Class 0 is
                // the CTC blank token, so model class n maps to dictionary entry n - 1.
                let dict_idx = max_idx.saturating_sub(1);
                if num_classes == expected_base + 1 && dict_idx == self.char_dict.len() {
                    chars.push(' ');
                } else if let Some(ch) = self.char_dict.get(dict_idx) {
                    if !ch.is_empty() && ch != " " {
                        for c in ch.chars() {
                            chars.push(c);
                        }
                    }
                }
                conf_sum += max_val;
                conf_count += 1;
            }
            last_char = max_idx as isize;
        }

        let text: String = chars.into_iter().collect();
        let confidence = if conf_count > 0 {
            conf_sum / conf_count as f32
        } else {
            0.0
        };
        Ok((text, confidence))
    }
}

impl OcrEngine for PaddleOcrEngine {
    fn recognize(&self, bgra: &[u8], width: u32, height: u32) -> Result<OcrResult, OcrError> {
        if !self.available {
            return Err(OcrError::Unavailable(
                "PaddleOCR 引擎不可用：模型文件缺失。".into(),
            ));
        }
        let start = std::time::Instant::now();

        let (det_input, rh, rw) = self.preprocess_det(bgra, width, height)?;
        let boxes = self.detect(det_input, rh, rw)?;

        let mut full_text = String::new();
        let mut blocks: Vec<OcrBlock> = Vec::new();

        for b in &boxes {
            match self.preprocess_rec(bgra, width, height, b) {
                Ok(rec_input) => {
                    if let Ok((text, conf)) = self.recognize_one(rec_input) {
                        if !text.trim().is_empty() {
                            blocks.push(OcrBlock {
                                text: text.clone(),
                                x: b.x1,
                                y: b.y1,
                                width: b.x2 - b.x1,
                                height: b.y2 - b.y1,
                                confidence: conf,
                            });
                            if !full_text.is_empty() {
                                full_text.push('\n');
                            }
                            full_text.push_str(&text);
                        }
                    }
                }
                Err(_) => continue,
            }
        }

        let elapsed = start.elapsed().as_millis() as u64;
        crate::utils::logger::log(
            "ocr",
            &format!(
                "PaddleOCR: {} chars, {} boxes, {}ms",
                full_text.chars().count(),
                blocks.len(),
                elapsed
            ),
        );

        Ok(OcrResult {
            text: full_text,
            blocks,
            engine: "PaddleOCR".to_string(),
            elapsed_ms: elapsed,
        })
    }

    fn name(&self) -> &'static str {
        "PaddleOCR"
    }
    fn is_available(&self) -> bool {
        self.available
    }
}

// ─── 工具 ────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct TextBox {
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
}

fn merge_boxes(boxes: &[TextBox]) -> Vec<TextBox> {
    if boxes.is_empty() {
        return Vec::new();
    }
    let mut merged: Vec<TextBox> = Vec::new();
    let mut used = vec![false; boxes.len()];
    for i in 0..boxes.len() {
        if used[i] {
            continue;
        }
        let mut m = boxes[i].clone();
        used[i] = true;
        for j in (i + 1)..boxes.len() {
            if used[j] {
                continue;
            }
            let bj = &boxes[j];
            let y_overlap = m.y1 <= bj.y2 && m.y2 >= bj.y1;
            if !y_overlap {
                continue;
            }
            let ch = (m.y2 - m.y1).min(bj.y2 - bj.y1);
            let gap = if m.x2 < bj.x1 {
                bj.x1 - m.x2
            } else if bj.x2 < m.x1 {
                m.x1 - bj.x2
            } else {
                0.0
            };
            if gap < ch * 2.0 {
                m.x1 = m.x1.min(bj.x1);
                m.y1 = m.y1.min(bj.y1);
                m.x2 = m.x2.max(bj.x2);
                m.y2 = m.y2.max(bj.y2);
                used[j] = true;
            }
        }
        merged.push(m);
    }
    merged
}

fn get_default_model_dir() -> Option<std::path::PathBuf> {
    if let Ok(path) = std::env::var("LEVITAIRE_OCR_MODEL_DIR") {
        let path = std::path::PathBuf::from(path);
        if path.is_dir() {
            return Some(path);
        }
    }
    dirs::data_dir().map(|p| p.join("levitaire").join("ocr"))
}

// ─── 测试 ────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_creation_without_models() {
        let tmp = std::env::temp_dir().join(format!("po_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let e = PaddleOcrEngine::new(Some(&tmp)).unwrap();
        assert!(!e.is_available());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_unavailable_rejects() {
        let tmp = std::env::temp_dir().join(format!("po_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let e = PaddleOcrEngine::new(Some(&tmp)).unwrap();
        assert!(e
            .recognize(&[0; 4], 1, 1)
            .unwrap_err()
            .to_string()
            .contains("不可用"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_preprocess_det() {
        let tmp = std::env::temp_dir().join(format!("po_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let e = PaddleOcrEngine::new(Some(&tmp)).unwrap();
        let bgra = vec![0u8; 100 * 50 * 4];
        let (t, rh, rw) = e.preprocess_det(&bgra, 100, 50).unwrap();
        assert_eq!(t.shape(), &[1, 3, 960, 960]);
        assert!(rh > 0.0 && rw > 0.0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_preprocess_rec() {
        let tmp = std::env::temp_dir().join(format!("po_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let e = PaddleOcrEngine::new(Some(&tmp)).unwrap();
        let bgra = vec![0u8; 200 * 100 * 4];
        let tb = TextBox {
            x1: 10.0,
            y1: 10.0,
            x2: 190.0,
            y2: 80.0,
        };
        let t = e.preprocess_rec(&bgra, 200, 100, &tb).unwrap();
        assert_eq!(t.shape(), &[1, 3, 48, 320]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_det_postprocess_empty() {
        let tmp = std::env::temp_dir().join(format!("po_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let e = PaddleOcrEngine::new(Some(&tmp)).unwrap();
        // shape [1,1,64,64], all zeros
        let shape = ort::value::Shape::from(vec![1i64, 1, 64, 64]);
        let data = vec![0f32; 64 * 64];
        let boxes = e.postprocess_det(&shape, &data, 1.0, 1.0).unwrap();
        assert!(boxes.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_det_postprocess_rejects_short_output() {
        let tmp = std::env::temp_dir().join(format!("po_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let e = PaddleOcrEngine::new(Some(&tmp)).unwrap();
        let shape = ort::value::Shape::from(vec![1i64, 1, 64, 64]);
        let error = e.postprocess_det(&shape, &[0.0; 8], 1.0, 1.0).unwrap_err();
        assert!(error.to_string().contains("too short"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_det_postprocess_content() {
        let tmp = std::env::temp_dir().join(format!("po_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let e = PaddleOcrEngine::new(Some(&tmp)).unwrap();
        // [1,1,64,64] with a high-prob rectangle in the middle
        let shape = ort::value::Shape::from(vec![1i64, 1, 64, 64]);
        let mut data = vec![0f32; 64 * 64];
        for y in 16..48 {
            for x in 16..48 {
                data[y * 64 + x] = 0.9;
            }
        }
        let boxes = e.postprocess_det(&shape, &data, 1.0, 1.0).unwrap();
        assert!(!boxes.is_empty());
        let b = &boxes[0];
        assert!((b.x1 - 15.0).abs() < 5.0);
        assert!((b.x2 - 49.0).abs() < 5.0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_ctc_decode() {
        let tmp = std::env::temp_dir().join(format!("po_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let mut e = PaddleOcrEngine::new(Some(&tmp)).unwrap();
        e.char_dict = vec!["a".into(), "b".into(), "c".into()];
        e.blank_idx = 0;

        // 帧 0-1: a, 帧 2-3: b, 帧 4-5: blank
        // Shape [1, 6, 4]
        let shape = ort::value::Shape::from(vec![1i64, 6, 4]);
        let data = vec![
            -10.0, 5.0, -10.0, -10.0, -10.0, 3.0, -10.0, -10.0, -10.0, -10.0, 5.0, -10.0, -10.0,
            -10.0, 3.0, -10.0, 5.0, -10.0, -10.0, -10.0, 5.0, -10.0, -10.0, -10.0,
        ];

        let (text, _) = e.ctc_decode(&shape, &data).unwrap();
        assert_eq!(text, "ab");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_ctc_decode_rejects_short_output() {
        let tmp = std::env::temp_dir().join(format!("po_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let mut e = PaddleOcrEngine::new(Some(&tmp)).unwrap();
        e.char_dict = vec!["a".into(), "b".into()];
        let shape = ort::value::Shape::from(vec![1i64, 2, 3]);
        let error = e.ctc_decode(&shape, &[0.0; 5]).unwrap_err();
        assert!(error.to_string().contains("too short"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_dictionary_loader_preserves_full_width_space() {
        let dict = "甲\n　\n乙\n";
        let entries: Vec<String> = dict
            .lines()
            .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
            .filter(|line| !line.is_empty())
            .collect();
        assert_eq!(entries, ["甲", "　", "乙"]);
    }

    #[test]
    fn test_preprocess_rec_uses_symmetric_normalization() {
        let tmp = std::env::temp_dir().join(format!("po_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let e = PaddleOcrEngine::new(Some(&tmp)).unwrap();
        let bgra = vec![255u8, 255, 255, 255];
        let tb = TextBox {
            x1: 0.0,
            y1: 0.0,
            x2: 1.0,
            y2: 1.0,
        };
        let input = e.preprocess_rec(&bgra, 1, 1, &tb).unwrap();
        assert!((input[[0, 0, 0, 0]] - 1.0).abs() < 1e-5);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
