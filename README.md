# Floatory

一个基于 Rust + Tauri 的 Windows 悬浮工具集应用。通过悬浮球快速唤起截图、录屏、OCR、语音输入、系统监控、AI 文本优化等多种效率工具。

## ✨ 功能特性

### 📋 文字工具
- 🔍 **全局文字选择检测** — 通过 Windows 全局低级鼠标钩子（WH_MOUSE_LL）和键盘钩子（WH_KEYBOARD_LL）监听选中文字
- 📋 **悬浮工具栏** — 在选中文字下方自动弹出，透明无边框，始终置顶
- ✂️ **复制** — 快捷执行剪贴板操作
- 🤖 **AI 文本优化** — 润色、正式化、简洁化、翻译，支持 Anthropic 和 OpenAI 兼容 API
- 📱 **二维码生成** — 将选中文字转为二维码

### 📷 屏幕工具
- 🖼️ **区域截图** — 拖框截取屏幕任意区域，支持多显示器虚拟桌面
- 📌 **钉图** — 截图后钉在桌面最上层，可拖拽、缩放，用作临时参考
- 🎥 **GIF / 视频录制** — 录制屏幕区域为 GIF 动图或 MP4 视频（通过 ffmpeg 编码）
- 🔤 **离线 OCR** — 双引擎离线文字识别（Windows 系统 OCR + PaddleOCR ONNX），截图后可一键提取文字
- ✏️ **截图标注** — 截图后可绘制箭头、矩形、文字标注

### 🎤 语音工具
- 🎙️ **语音输入 (STT)** — 录音并云端识别为文字，自动粘贴到当前焦点窗口（支持 OpenAI 兼容 STT API）
- 🔊 **语音朗读 (TTS)** — 选中文字后朗读，支持暂停/继续/停止，基于 Windows 内置语音合成

### 📊 系统工具
- 📈 **系统监控** — 常驻悬浮显示 CPU、内存、网络、磁盘、电池实时状态曲线
- ⌨️ **全局热键** — 三槽位独立热键：截图热键、语音输入热键、录屏热键（Win32 RegisterHotKey）
- 💫 **悬浮球** — 可拖拽的悬浮快捷入口，始终置顶，点击展开工具面板

### ⚙️ 系统特性
- 🔒 **API Key 加密存储** — 使用 Windows DPAPI 加密保护 API 密钥
- 🚀 **开机自启动** — 通过 Windows 注册表实现
- 🎨 **主题支持** — 内置浅色 / 深色主题切换
- ⚡ **高性能** — Rust 原生编译，GDI 截屏、WinRT 语音/OCR 全链路原生调用

## 🛠️ 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 后端 | Rust + windows-rs 0.61 | 系统钩子、GDI 截屏、WinRT OCR/TTS、PDH 性能计数、DPAPI 加密 |
| 深度学习 | ONNX Runtime (ort 2.0.0-rc.12) | PaddleOCR 本地推理引擎（可选，无模型文件时自动回退 Windows OCR） |
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS 4 | 工具栏 UI、悬浮球、设置页 |
| 框架 | Tauri 2.x | 前后端桥接、多窗口管理、托盘图标 |
| 编码 | ffmpeg | MP4 视频编码（通过子进程 pipe） |
| 构建 | Cargo + npm | 依赖管理与构建 |

## 📦 环境要求

- Windows 10 / 11
- [Rust](https://rustup.rs/) 1.70+
- [Node.js](https://nodejs.org/) 18+
- [Tauri CLI](https://tauri.app/) 2.x

> **注意**：PaddleOCR 依赖 ONNX Runtime (`onnxruntime.dll`, ~20.5MB)，已纳入仓库版本控制（`src-tauri/libs/`）。使用 `load-dynamic` 模式，运行时动态加载，无需联网下载。构建产物中 DLL 会自动复制到安装目录。若仅使用 Windows 系统 OCR，可在 `Cargo.toml` 中移除 `ort` 依赖以减小构建体积和内存占用。

## 🚀 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/yourusername/Floatory.git
cd Floatory
```

### 2. 安装依赖

```bash
# 安装前端依赖
npm install

# 安装 Tauri CLI（如未安装）
cargo install tauri-cli
```

### 3. 开发模式运行

```bash
cargo tauri dev
```

启动后：
- Vite 开发服务器运行在 `http://localhost:1420`
- Tauri 窗口自动加载前端页面
- 系统托盘出现应用图标
- 悬浮球显示在屏幕中央

### 4. 构建发布版本

```bash
cargo tauri build
```

构建产物位于 `src-tauri/target/release/bundle/`，包含 `.msi` 安装包和独立 `.exe`。

## 📖 使用方法

1. 启动应用后，系统托盘出现 Floatory 图标，悬浮球显示在屏幕中央
2. **文字工具**：在任意应用中选中文字，自动弹出工具栏（复制、翻译、AI 优化、二维码、语音朗读）
3. **截图工具**：点击悬浮球 → 截图，拖框选取区域后可复制、保存、OCR 识别或钉在桌面
4. **录屏工具**：点击悬浮球 → 录屏，选择 GIF 或视频模式，拖框选区后开始录制
5. **语音输入**：点击悬浮球 → 语音输入，录音后自动识别并粘贴文字
6. **系统监控**：点击悬浮球 → 系统监控，显示实时性能面板
7. **全局热键**：在设置中配置三类快捷键，无需点击悬浮球即可快速触发

## 📁 项目结构

```
Floatory/
├── src-tauri/                              # Rust 后端
│   ├── src/
│   │   ├── main.rs                         # 入口：初始化各模块、注册命令
│   │   ├── commands.rs                     # Tauri 命令（103 个 #[tauri::command]）
│   │   ├── hooks/
│   │   │   ├── mod.rs                      # HookManager（Tauri managed state 占位）
│   │   │   ├── mouse.rs                    # WH_MOUSE_LL 全局鼠标钩子
│   │   │   ├── keyboard.rs                 # WH_KEYBOARD_LL 全局键盘钩子
│   │   │   └── hotkey.rs                   # Win32 RegisterHotKey 全局热键
│   │   ├── automation/
│   │   │   ├── mod.rs                      # SelectionInfo / Rect / Point 结构体
│   │   │   ├── selection.rs               # 多策略选区获取（UIA / Win32 / 剪贴板 / OCR 回退）
│   │   │   ├── clipboard_selection.rs     # 剪贴板回退选区
│   │   │   └── ocr_selection.rs           # OCR 回退选区
│   │   ├── clipboard/
│   │   │   ├── mod.rs                      # ClipboardManager
│   │   │   └── manager.rs                 # copy / cut / history
│   │   ├── screenshot/
│   │   │   ├── mod.rs                      # GDI 截屏（多显示器支持）、PNG 编码
│   │   │   └── pin.rs                     # 钉图窗口管理
│   │   ├── ocr/
│   │   │   ├── mod.rs                      # OcrService（引擎管理、分块、线程隔离）
│   │   │   ├── engine.rs                   # OcrEngine trait 统一接口
│   │   │   ├── windows_ocr.rs             # Windows.Media.Ocr 引擎
│   │   │   └── paddle_ocr.rs             # PaddleOCR ONNX 引擎
│   │   ├── recording/
│   │   │   ├── mod.rs                      # RecordingState（GIF / 视频录制循环）
│   │   │   ├── gif_encoder.rs             # 流式 GIF 编码
│   │   │   ├── video_encoder.rs           # ffmpeg pipe MP4 编码
│   │   │   └── window_detect.rs           # 窗口检测（录屏区域识别）
│   │   ├── tts/
│   │   │   └── mod.rs                      # WinRT SpeechSynthesizer 语音合成
│   │   ├── stt/
│   │   │   └── mod.rs                      # 云端语音识别（OpenAI 兼容 API）
│   │   ├── monitor/
│   │   │   └── mod.rs                      # 系统监控（CPU/内存/网络/磁盘/电池）
│   │   ├── ai/
│   │   │   └── mod.rs                      # AI 服务（Anthropic / OpenAI 兼容 API）
│   │   ├── config/
│   │   │   └── mod.rs                      # ConfigManager / AiConfig / 自启动
│   │   └── utils/
│   │       ├── mod.rs
│   │       ├── logger.rs                   # 日志
│   │       └── crypto.rs                   # DPAPI 加解密
│   ├── Cargo.toml
│   ├── tauri.conf.json                     # 窗口 / 托盘 / CSP / 构建配置
│   └── icons/                              # 应用图标
│
├── src/                                    # 前端（React + TypeScript）
│   ├── main.tsx                            # 入口
│   ├── App.tsx                             # 路由：toolbar / orb / settings 窗口
│   ├── types.ts                            # 类型定义
│   ├── components/
│   │   ├── FloatingOrb.tsx                 # 悬浮球组件
│   │   ├── ToolPalette.tsx                 # 工具面板（悬浮球展开）
│   │   ├── ToolbarButton.tsx              # 工具栏按钮组件
│   │   ├── Icon.tsx                        # 图标组件（基于 lucide-react）
│   │   └── Settings.tsx                    # 设置页面
│   ├── tools/
│   │   ├── registry.ts                     # 工具注册表（FLOATING_TOOLS）
│   │   ├── text-toolbar/                   # 文字工具栏
│   │   ├── screenshot/                     # 截图工具 + 标注
│   │   ├── recording/                      # 录屏工具
│   │   ├── voice-input/                    # 语音输入
│   │   └── system-monitor/                 # 系统监控
│   └── styles/
│       ├── global.css                      # 全局 CSS
│       └── tokens.css                      # CSS 变量
│
├── docs/                                   # 设计文档
├── package.json
├── vite.config.ts
├── tsconfig.json
└── index.html
```

## 🏗️ 架构概览

```
┌───────────────────────────────────────────────────────┐
│              前端层 (React + WebView)                  │
│   FloatingOrb → ToolPalette → 各工具组件               │
├───────────────────────────────────────────────────────┤
│              桥接层 (Tauri invoke / emit / listen)      │
├───────────────────────────────────────────────────────┤
│              后端层 (Rust)                              │
│   Mouse Hook ──→ emit("mouse-up")                      │
│   UI Automation ──→ get_selection                      │
│   GDI ──→ capture_screen_region                        │
│   WinRT OCR ──→ ocr_region                             │
│   WinRT TTS ──→ tts_speak / pause / resume             │
│   ffmpeg pipe ──→ start_recording / stop_recording     │
│   STT Cloud API ──→ stt_transcribe                     │
│   sysinfo + PDH ──→ show_monitor_window                │
│   RegisterHotKey ──→ 截图 / 语音 / 录屏 热键            │
│   AI Service ──→ call_ai                               │
└───────────────────────────────────────────────────────┘
```

### 核心流程

1. **鼠标钩子** (`hooks/mouse.rs`)：通过 `SetWindowsHookExW` 注册全局低级鼠标钩子，监听 `WM_LBUTTONUP` 事件
2. **事件传递**：钩子回调通过 `std::sync::mpsc` 将事件发送到后台线程，由后台线程调用 `app_handle.emit("mouse-up")` 通知前端
3. **前端响应**：`ToolPalette` 中的文字工具栏监听 `mouse-up` 事件，调用 `get_selection` 命令获取选中文字，显示工具栏
4. **悬浮球**：`FloatingOrb` 始终置顶显示，点击展开 `ToolPalette` 工具面板，选择截图/录屏/语音输入/系统监控等工具
5. **全局热键**：独立线程创建仅消息窗口，通过 `RegisterHotKey` 注册系统级快捷键，触发时直接调用后端功能无需经过前端
6. **OCR 引擎**：双引擎架构（Windows 系统 OCR + PaddleOCR ONNX），自动选择或手动切换，大图自动分块+COM 线程隔离

## 🔌 AI 配置

Floatory 支持两种 AI API 格式：

### Anthropic（默认）
- **Base URL**: `https://api.anthropic.com`
- **Model**: `claude-sonnet-4-20250514`
- 使用 `x-api-key` 认证

### OpenAI 兼容（DeepSeek、通义千问、OpenAI 等）
- **Base URL**: 如 `https://api.deepseek.com`、`https://dashscope.aliyuncs.com/compatible-mode`
- **Model**: 如 `deepseek-chat`、`qwen-plus`
- 使用 `Authorization: Bearer` 认证

在设置页面的"API 类型"下拉框中选择对应类型，填写 API Key、Base URL 和 Model 即可。

API Key 使用 Windows DPAPI 加密存储在 `%APPDATA%/floatory/config.json` 中，绑定当前用户，不可跨机器迁移。

### STT 语音识别配置

语音输入使用 OpenAI 兼容的 STT API（`/v1/audio/transcriptions`），支持任何兼容平台（OpenAI、Groq、DeepInfra 等），在设置页面单独配置 API Key、Base URL 和 Model。

## 📚 相关文档

- [架构设计文档](docs/architecture-design.md)
- [开发指南](docs/developer-guide.md)
- [快速开始](docs/quick-start.md)

## 📄 许可证

[MIT License](LICENSE) © 2026 Floatory