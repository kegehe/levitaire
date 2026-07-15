# 离线 OCR 引擎实现方案

> 调研日期：2026-07-09 | 目标：为 floast 项目新增本地离线 OCR 能力

---

## 一、现状分析

### 1.1 当前 OCR 实现

```
当前路径：
  screenshot::capture_screen_region() → GDI 截屏获取 BGRA 像素
  → ocr_selection::recognize_bgra() → Windows.Media.Ocr.OcrEngine
  → 使用系统内置 OCR（Windows 10+ 自带）
```

**当前方案优缺点：**

| 优点 | 缺点 |
|------|------|
| 零额外依赖，系统自带 | **仅支持 Windows 10+** |
| 安装包不增加体积 | **中文识别精度一般**（不如 PaddleOCR） |
| 无需下载模型 | **不支持离线/无网环境回退** |
| API 稳定 | **不支持竖排文字、复杂排版** |
| | **无法跨平台（Linux/macOS 不可用）** |

### 1.2 使用场景分析

OCR 在项目中的调用路径有 3 处：

1. **文字工具栏 OCR**：用户截图 → 按需 OCR 识别 → 返回文字（screenshot tool → `recognize_bgra`）
2. **选区 fallback OCR**：UIA/Win32/剪贴板获取选区失败 → OCR 兜底（`get_selection_via_ocr`）
3. **截图工具 OCR 按钮**：截图后点击 OCR 按钮识别图中文字

---

## 二、候选方案对比

### 方案 A：PaddleOCR-ONNX（推荐 ⭐⭐⭐）

| 维度 | 详情 |
|------|------|
| **引擎** | PaddleOCR（百度）→ ONNX Runtime 推理 |
| **语言** | C++ 推理引擎 + Rust 绑定（或 FFI 调用） |
| **模型大小** | 检测 ~2MB + 识别 ~10MB + 字典 ~5MB = **~17MB** |
| **识别精度** | ⭐⭐⭐⭐⭐ 中文识别业界最佳 |
| **速度** | CPU 推理 ~50-200ms（取决于区域大小） |
| **GPU 加速** | 支持 CUDA/DirectML/OpenVINO |
| **维护状态** | GitHub 48k+ Stars，极度活跃 |
| **平台** | Win/Mac/Linux |
| **依赖** | ONNX Runtime (~10MB dll) |
| **特点** | 支持竖排文字、中英混排、表格识别 |

**Rust 集成方式**：
- 方案 A1：通过 `ort` (Rust ONNX Runtime binding) 直接加载 PaddleOCR ONNX 模型
- 方案 A2：通过 `paddleocr` 命令行 + Rust 子进程调用
- 方案 A3：C FFI 包装 PaddleOCR C++ API → Rust FFI 调用

### 方案 B：Tesseract

| 维度 | 详情 |
|------|------|
| **引擎** | Tesseract 5.x（Google 维护） |
| **语言** | C/C++，Rust 绑定 `leptess` / `tesseract-rs` |
| **模型大小** | 中文语言包 ~50MB（chi_sim.traineddata） |
| **识别精度** | ⭐⭐⭐ 英文好，中文一般 |
| **速度** | ~100-500ms |
| **GPU 加速** | 不支持 |
| **平台** | Win/Mac/Linux |
| **依赖** | libtesseract + libleptonica（~20MB dll） |
| **特点** | 历史最久，生态最成熟 |

### 方案 C：EasyOCR（Python 方案，不推荐）

| 维度 | 详情 |
|------|------|
| **限制** | 需要 Python 运行时 + PyTorch，总依赖 >2GB |
| **结论** | 不适合嵌入桌面应用，排除 |

### 方案 D：保留 Windows OCR + 新增离线回退

| 维度 | 详情 |
|------|------|
| **策略** | Windows 上优先用 `Windows.Media.Ocr`，不可用时回退到本地引擎 |
| **优点** | 最小改动，渐进增强 |
| **缺点** | 需要维护两套 OCR 路径 |

---

## 三、推荐方案：PaddleOCR-ONNX + Windows OCR 双引擎

### 3.1 架构设计

```
┌─────────────────────────────────────────────────────┐
│                   OcrEngine (统一接口)                │
│                                                     │
│  pub fn recognize(bgra, w, h) -> Result<String>     │
│  pub fn recognize_with_config(bgra, w, h, cfg)       │
│                                                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌──────────────────┐    ┌───────────────────────┐  │
│  │  WindowsOcrEngine │    │  PaddleOcrEngine      │  │
│  │  (Windows.Media)  │    │  (ONNX Runtime)       │  │
│  │                   │    │                       │  │
│  │  ✅ 零依赖         │    │  ✅ 跨平台             │  │
│  │  ✅ 系统内置        │    │  ✅ 中文精度高         │  │
│  │  ❌ 仅 Windows     │    │  ✅ 竖排文字           │  │
│  │  ❌ 中文精度一般    │    │  ❌ 需下载模型 ~17MB    │  │
│  └──────────────────┘    └───────────────────────┘  │
│                                                     │
│  策略：Windows 优先 WindowsOcrEngine                   │
│        用户可手动切换到 PaddleOcrEngine                  │
│        非 Windows 平台自动使用 PaddleOcrEngine          │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 3.2 新增 Cargo 依赖

```toml
# Cargo.toml 新增
[dependencies]
# ONNX Runtime for Rust
ort = { version = "2", features = ["load-dynamic"] }  # 动态加载 onnxruntime.dll

# 图像预处理
image = { version = "0.25", default-features = false, features = ["png"] }  # 已有

# 可选：DirectML 加速（Windows）
# ort = { version = "2", features = ["directml"] }
```

### 3.3 模型文件管理

```
项目资源目录结构：
src-tauri/
├── resources/
│   └── ocr/
│       ├── det.onnx          # PaddleOCR 检测模型 (~2MB)
│       ├── rec.onnx          # PaddleOCR 识别模型 (~10MB)
│       ├── ppocr_keys_v1.txt # 中文字典 (~5MB)
│       └── onnxruntime.dll   # ONNX Runtime 库 (~10MB)
│
# tauri.conf.json 配置 resources 打包：
{
  "bundle": {
    "resources": {
      "resources/ocr/*": "ocr/"
    }
  }
}
```

### 3.4 文件结构

```
src-tauri/src/
├── ocr/                        # 新增 OCR 模块（独立于现有 automation/ocr_selection.rs）
│   ├── mod.rs                  # 统一接口 + 引擎选择
│   ├── engine.rs               # OcrEngine trait 定义
│   ├── windows_ocr.rs          # Windows.Media.Ocr 封装（从 ocr_selection.rs 迁移）
│   └── paddle_ocr.rs           # PaddleOCR ONNX 引擎实现
```

### 3.5 核心代码设计

```rust
// src-tauri/src/ocr/engine.rs

/// OCR 引擎统一 trait
pub trait OcrEngine: Send + Sync {
    /// 对 BGRA 像素数据进行 OCR 识别
    fn recognize(&self, bgra: &[u8], width: u32, height: u32) -> Result<OcrResult, OcrError>;
    
    /// 引擎名称
    fn name(&self) -> &'static str;
    
    /// 是否可用（模型是否已加载/引擎是否支持当前平台）
    fn is_available(&self) -> bool;
}

#[derive(Debug, Clone)]
pub struct OcrResult {
    pub text: String,
    /// 每个识别块的位置（可选，用于高亮）
    pub blocks: Vec<OcrBlock>,
    /// 使用的引擎名称
    pub engine: String,
    /// 耗时（毫秒）
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone)]
pub struct OcrBlock {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub confidence: f32,
}

#[derive(Debug, thiserror::Error)]
pub enum OcrError {
    #[error("引擎不可用: {0}")]
    Unavailable(String),
    #[error("模型未加载: {0}")]
    ModelNotLoaded(String),
    #[error("识别失败: {0}")]
    RecognitionFailed(String),
    #[error("图像预处理失败: {0}")]
    PreprocessFailed(String),
}
```

```rust
// src-tauri/src/ocr/mod.rs

use std::sync::Arc;
use crate::config::AppConfig;

/// 全局 OCR 服务
pub struct OcrService {
    /// 当前激活的引擎
    active: Arc<dyn OcrEngine>,
    /// Windows OCR 引擎（备用）
    windows_ocr: Option<Arc<dyn OcrEngine>>,
    /// PaddleOCR 引擎（备用）
    paddle_ocr: Option<Arc<dyn OcrEngine>>,
}

impl OcrService {
    pub fn new(config: &AppConfig) -> Self {
        let windows_ocr = WindowsOcrEngine::new().map(Arc::new).ok();
        let paddle_ocr = PaddleOcrEngine::new(config.ocr_model_path()).map(Arc::new).ok();
        
        // 引擎选择策略：
        // 1. 用户手动选择 → 使用指定引擎
        // 2. 自动选择：Windows → Windows OCR，否则 → PaddleOCR
        let active = match config.ocr_engine.as_deref() {
            Some("paddle") => paddle_ocr.clone().unwrap_or_else(|| windows_ocr.clone().unwrap()),
            Some("windows") => windows_ocr.clone().unwrap_or_else(|| paddle_ocr.clone().unwrap()),
            _ => windows_ocr.clone().or(paddle_ocr.clone()).unwrap(),
        };
        
        Self { active, windows_ocr, paddle_ocr }
    }
    
    /// 对 BGRA 像素执行 OCR（封装多线程 + 大图分块逻辑）
    pub fn recognize_bgra(&self, bgra: &[u8], width: u32, height: u32) 
        -> Result<OcrResult, OcrError> 
    {
        // 保持原有的分块 + MTA 线程逻辑
        // 但内部调用 self.active.recognize()
        todo!()
    }
    
    /// 切换引擎
    pub fn switch_engine(&mut self, engine: &str) -> Result<(), String> {
        todo!()
    }
}
```

```rust
// src-tauri/src/ocr/paddle_ocr.rs

use ort::{session::Session, value::Tensor};
use image::{DynamicImage, GenericImageView};

pub struct PaddleOcrEngine {
    det_session: Session,  // 文本检测模型
    rec_session: Session,  // 文本识别模型
    char_dict: Vec<String>, // 字符映射表
    available: bool,
}

impl PaddleOcrEngine {
    pub fn new(model_dir: &std::path::Path) -> Result<Self, OcrError> {
        let det_path = model_dir.join("det.onnx");
        let rec_path = model_dir.join("rec.onnx");
        let dict_path = model_dir.join("ppocr_keys_v1.txt");
        
        if !det_path.exists() || !rec_path.exists() || !dict_path.exists() {
            return Err(OcrError::ModelNotLoaded(
                "OCR 模型文件不完整，请在设置页下载模型".into()
            ));
        }
        
        let det_session = Session::builder()
            .map_err(|e| OcrError::ModelNotLoaded(e.to_string()))?
            .commit_from_file(det_path)
            .map_err(|e| OcrError::ModelNotLoaded(e.to_string()))?;
        
        let rec_session = Session::builder()
            .map_err(|e| OcrError::ModelNotLoaded(e.to_string()))?
            .commit_from_file(rec_path)
            .map_err(|e| OcrError::ModelNotLoaded(e.to_string()))?;
        
        let char_dict = Self::load_dict(&dict_path)?;
        
        Ok(Self { det_session, rec_session, char_dict, available: true })
    }
    
    // 1. 检测阶段：输入 BGRA → 预处理 → 检测模型 → 输出文字区域坐标
    fn detect_text_areas(&self, bgra: &[u8], w: u32, h: u32) 
        -> Result<Vec<TextArea>, OcrError> { ... }
    
    // 2. 识别阶段：裁剪每个区域 → 识别模型 → 输出文字
    fn recognize_text(&self, roi: &DynamicImage) 
        -> Result<(String, f32), OcrError> { ... }
}

impl OcrEngine for PaddleOcrEngine {
    fn recognize(&self, bgra: &[u8], width: u32, height: u32) 
        -> Result<OcrResult, OcrError> 
    {
        let start = std::time::Instant::now();
        
        // Step 1: 检测文字区域
        let areas = self.detect_text_areas(bgra, width, height)?;
        
        // Step 2: 逐区域识别
        let img = Self::bgra_to_image(bgra, width, height)?;
        let mut blocks = Vec::new();
        let mut full_text = String::new();
        
        for area in areas {
            let roi = img.crop_imm(
                area.x as u32, area.y as u32, 
                area.w as u32, area.h as u32
            );
            match self.recognize_text(&roi) {
                Ok((text, conf)) => {
                    blocks.push(OcrBlock {
                        text: text.clone(),
                        x: area.x, y: area.y,
                        width: area.w, height: area.h,
                        confidence: conf,
                    });
                    if !full_text.is_empty() { full_text.push('\n'); }
                    full_text.push_str(&text);
                }
                Err(_) => continue,
            }
        }
        
        Ok(OcrResult {
            text: full_text,
            blocks,
            engine: "PaddleOCR-ONNX".into(),
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }
    
    fn name(&self) -> &'static str { "PaddleOCR" }
    fn is_available(&self) -> bool { self.available }
}
```

### 3.6 ONNX 模型预处理细节

PaddleOCR ONNX 模型的标准预处理流程：

```
输入：BGRA 像素 (u8)
  ↓
1. BGR 通道提取 + 归一化
   - 去除 Alpha 通道
   - 转换为 float32 [0, 1]
   - 标准化：(pixel - mean) / std
     mean = [0.485, 0.456, 0.406]
     std  = [0.229, 0.224, 0.225]
  ↓
2. 检测模型输入
   - resize 到 960×960（保持宽高比，填充 0）
   - shape: [1, 3, 960, 960] (NCHW)
  ↓
3. 检测后处理
   - 解析模型输出的二值化图 → 连通区域 → 文本框坐标
   - 文本框按 y 坐标排序（从上到下阅读顺序）
  ↓
4. 识别模型输入（逐区域）
   - 裁剪每个文字区域
   - resize 到 48×320（保持宽高比）
   - shape: [1, 3, 48, 320]
  ↓
5. 识别后处理
   - CTC decode → 字符索引序列
   - 查字典映射为文字
  ↓
输出：文字列表 + 坐标 + 置信度
```

### 3.7 与现有代码的集成方案

```
现有代码变更：
1. ocr_selection.rs 中的 recognize_bgra() 函数
   → 改为调用 OcrService::recognize_bgra()
   → 保持对外接口不变

2. ScreenshotTool.tsx 中的 OCR 按钮
   → 后端增加 engine 参数，允许前端选择引擎

3. 设置页新增：
   - OCR 引擎选择（Windows 系统 OCR / PaddleOCR 离线引擎）
   - 模型下载按钮（一键下载 ONNX 模型文件）
   - 下载进度显示

4. 首次启动：
   - 检测模型文件是否存在
   - 不存在 → 提示下载（可选跳过，仍可用 Windows OCR）
```

### 3.8 模型下载方案

```
模型托管选项：
A. GitHub Releases 托管（推荐）
   - 免费，不限带宽
   - 国内可能较慢

B. 阿里云 OSS / 腾讯云 COS
   - 国内速度快
   - 有少量费用

C. 内置在安装包中
   - 无需下载
   - 安装包增大 ~17MB
   - 推荐作为默认选项，用户可选"轻量安装"跳过

建议：默认将模型打包在安装包中（Tauri resources），
同时在设置页提供"检查更新模型"按钮。
```

---

## 四、实施计划

### 阶段 1：基础设施（1-2 天）
- [ ] 添加 `ort` crate 依赖
- [ ] 创建 `src-tauri/src/ocr/` 模块结构
- [ ] 实现 `OcrEngine` trait 和 `OcrResult` 类型
- [ ] 迁移现有 `recognize_bgra` 到 `windows_ocr.rs`（纯重构，不改行为）
- [ ] 编写单元测试

### 阶段 2：PaddleOCR 引擎（2-3 天）
- [ ] 实现 `PaddleOcrEngine`（加载 ONNX 模型）
- [ ] 实现图像预处理（BGRA → CHW float32 + 标准化）
- [ ] 实现检测模型推理 + 后处理
- [ ] 实现识别模型推理 + CTC decode
- [ ] 实现分块识别（大图自动切分）
- [ ] 编写集成测试（与 Windows OCR 对比精度）

### 阶段 3：模型管理（1 天）
- [ ] 配置 `tauri.conf.json` resources 打包
- [ ] 实现模型文件检测 + 自动下载
- [ ] 前端下载进度 UI

### 阶段 4：集成与设置（1 天）
- [ ] `OcrService` 全局服务（Tauri managed state）
- [ ] 前端设置页引擎选择
- [ ] 截图工具 OCR 按钮接入双引擎
- [ ] `ocr_selection.rs` fallback 接入

### 阶段 5：测试与优化（1 天）
- [ ] 实机测试（各种应用中的 OCR 识别）
- [ ] 中文/英文/中英混排/竖排文字测试
- [ ] 性能基准测试（vs Windows OCR）
- [ ] 内存占用优化

---

## 五、风险与注意事项

| 风险 | 缓解措施 |
|------|---------|
| ONNX Runtime DLL 兼容性 | 动态加载，失败回退 Windows OCR |
| 模型文件大小（17MB） | 可选下载，不强制；安装包默认包含 |
| 中文竖排文字 | PaddleOCR 原生支持 |
| CPU 推理速度慢（大图） | 保持现有分块逻辑，单块 ≤ 4096px |
| 内存占用 | 模型常驻 ~50MB，按需加载/卸载 |
| 与现有代码冲突 | 渐进重构：先迁移后替换，保持接口不变 |
