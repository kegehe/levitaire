<div align="center">

# Levitaire

**一个基于 Rust + Tauri 的 Windows 浮窗效率工具箱**

选中文字即时弹出工具栏 · 悬浮球一键唤起 · 截图 / 录屏 / OCR / 番茄钟 / 系统监控

<p>
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-blue.svg">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-1.70%2B-orange.svg">
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2.x-green.svg">
</p>

</div>

---

## 📖 项目介绍

Levitaire 是一款面向 Windows 的悬浮效率工具集。运行后一个悬浮球常驻屏幕顶部，通过全局钩子自动感知"选中文字"，在鼠标旁即时弹出工具栏；也可一键唤起截图、录屏、OCR、番茄钟、系统监控等桌面工具，覆盖日常办公中的高频操作。

**核心设计理念**：把散落在多个应用里的零碎操作（复制、搜索、翻译、转换格式、截屏、记录）收敛到一个"指针所在之处"的统一入口，减少应用间切换。

---

## ✨ 功能特性

### 🔤 文字工具
选中任意应用的文字后，工具栏自动在你鼠标旁弹出（透明无边框、始终置顶），提供：

- 📋 **一键复制** — 选中后无需手动 Ctrl+C，工具栏直接复制
- 🔍 **快捷搜索** — 一键在必应 / Google / 百度 / DuckDuckGo / 搜狗中搜索选中文字（可在设置中切换默认引擎）
- 🤖 **AI 翻译与优化** — 翻译、润色、正式化、简洁化等，基于 Anthropic 与 OpenAI 兼容 API（DeepSeek、通义千问等），需在设置中填写 API Key
- 🔄 **文本转换** — 大小写转换、Base64 编解码、中文与 Unicode 互转
- 🧮 **MD5 加密** — 生成 32 位 / 16 位 MD5 摘要
- ✂️ **去重 / 编号** — 按行去重、为多行文本自动编号
- 📱 **二维码** — 将选中文字即时转为二维码
- 📊 **字符统计** — 字数、字符数快速统计
- 🗑️ **清除格式** — 去除富文本格式
- 🔊 **语音朗读 (TTS)** — Windows 内置语音合成，支持暂停 / 继续 / 停止

### 🖥️ 快速输入
- 🎡 **转盘输入** — 按下触发键（默认 CapsLock）唤起圆形转盘，鼠标旋转选择预设词或剪贴板历史，点选即输入，无需打字

### 📷 屏幕工具
- 🖼️ **区域截图** — 拖框截取屏幕任意区域，支持多显示器 / 虚拟桌面
- ✏️ **截图标注** — 截图后可绘制箭头、矩形、文字标注
- 📌 **钉图** — 截图后钉在桌面最上层，可拖拽、缩放，作为临时参考
- 🔤 **离线 OCR** — 双引擎离线文字识别（Windows 系统 OCR + PaddleOCR），截图后一键提取文字，支持引擎切换
- 🎥 **GIF / 视频录制** — 录制屏幕区域为 GIF 或 MP4（ffmpeg 编码），支持全屏 / 区域 / 窗口识别

### 📊 系统工具
- 📈 **系统监控** — 常驻悬浮显示 CPU、内存、网络、磁盘、电池实时曲线
- 🍅 **番茄钟** — 常驻悬浮倒计时，专注 / 休息自动循环，到点语音播报或提示音提醒

### ⚙️ 全局能力
- 💫 **悬浮球** — 可拖拽、始终置顶，点击展开全部工具面板；每个工具可独立启停开关
- ⌨️ **全局热键** — 截图、录屏等操作支持系统级快捷键（Win32 `RegisterHotKey`），无需聚焦窗口，冲突自动检测
- 🔒 **安全存储** — API Key 使用 Windows DPAPI 加密，绑定当前用户，不可跨机器迁移
- 🚀 **开机自启动** — 一键开启，通过 Windows 注册表实现
- 🎨 **主题支持** — 浅色 / 深色主题切换
- ⚡ **高性能** — Rust 原生编译，GDI 截屏、WinRT OCR / TTS 全链路原生调用

---

## 🖼️ 界面预览

> TODO: 在此处添加应用截图（悬浮球、文字工具栏、截图标注、系统监控面板等）。

---

## 🛠️ 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 后端 | Rust + windows-rs 0.61 | 全局钩子、GDI 截屏、WinRT OCR/TTS、PDH 性能计数、DPAPI 加密 |
| 深度学习 | ONNX Runtime | PaddleOCR 本地推理引擎（可选，无模型时自动回退 Windows OCR） |
| 前端 | React 18 + TypeScript + Vite | 工具栏 UI、悬浮球、设置页 |
| 框架 | Tauri 2.x | 前后端桥接、多窗口管理、托盘图标 |
| 编码 | ffmpeg | MP4 视频编码 |
| 构建 | Cargo + npm + Vitest | 依赖管理、构建与单元测试 |

---

## 🚀 快速开始

### 环境要求

- Windows 10 / 11
- [Rust](https://rustup.rs/) 1.70+
- [Node.js](https://nodejs.org/) 18+
- [Tauri CLI](https://tauri.app/) 2.x

> **说明**：PaddleOCR 依赖 ONNX Runtime（`onnxruntime.dll`，约 20.5MB），已纳入仓库并采用 `load-dynamic` 模式运行时动态加载，无需联网下载。若仅使用 Windows 系统 OCR，可在 `Cargo.toml` 中移除 `ort` 依赖以减小构建体积。

### 安装与运行

```bash
# 1. 克隆
git clone https://github.com/yourusername/Levitaire.git
cd Levitaire

# 2. 安装前端依赖
npm install

# 3. 安装 Tauri CLI（如未安装）
cargo install tauri-cli

# 4. 开发模式运行
npm run tauri dev
```

启动后：悬浮球出现在屏幕中央，系统托盘出现图标。Vite 开发服务器默认运行在 `http://localhost:1420`。

### 构建发布版本

```bash
npm run tauri build
```

构建产物位于 `src-tauri/target/release/bundle/`，含 `.msi` 安装包与独立 `.exe`。

---

## 📖 使用指南

1. **文字工具**：在任意应用选中文字 → 自动弹出工具栏，使用复制、搜索、翻译、AI 优化、转换、二维码等
2. **截图 / 录屏**：点击悬浮球 → 屏幕截图 / GIF·录屏，拖框选区后复制、保存、OCR 或钉桌面
3. **快速输入**：在任意应用按下触发键（默认 CapsLock）→ 唤起转盘，鼠标选词即输入
4. **系统监控**：点击悬浮球 → 系统监控 / 番茄钟，显示实时面板或专注计时
5. **全局热键**：在设置中为截图 / 录屏配置快捷键，无需点击悬浮球即可触发
6. **工具开关**：设置页可独立启用 / 停用每个工具

### AI 配置

Levitaire 支持两种 API 格式，在设置页的"API 类型"中选择并填写 API Key、Base URL 与 Model：

| 类型 | Base URL | Model 示例 | 认证 |
|------|----------|-----------|------|
| **Anthropic**（默认） | `https://api.anthropic.com` | `claude-sonnet-5` | `x-api-key` |
| **OpenAI 兼容** | 如 `https://api.deepseek.com`、`https://dashscope.aliyuncs.com/compatible-mode` | `deepseek-chat`、`qwen-plus` | `Authorization: Bearer` |

API Key 使用 Windows DPAPI 加密存储于 `%APPDATA%/levitaire/config.json`。

---

## 🏗️ 项目结构

```
Levitaire/
├── src-tauri/                          # Rust 后端
│   ├── src/
│   │   ├── main.rs                     # 入口：初始化模块、注册命令
│   │   ├── commands.rs                 # Tauri 命令（#[tauri::command]）
│   │   ├── hooks/                      # WH_MOUSE_LL / WH_KEYBOARD_LL / RegisterHotKey
│   │   ├── automation/                 # 多策略选区获取（UIA / Win32 / 剪贴板 / OCR 回退）
│   │   ├── quick_input.rs               # 快速输入转盘 + 剪贴板历史
│   │   ├── clipboard/                   # 剪贴板写入（文字 / 图片 / GIF）
│   │   ├── screenshot/                  # GDI 截屏（多显示器）、钉图窗口
│   │   ├── ocr/                         # OcrService（Windows OCR + PaddleOCR 双引擎）
│   │   ├── recording/                   # GIF / ffmpeg MP4 录制、窗口检测
│   │   ├── tts/                         # WinRT SpeechSynthesizer 语音合成
│   │   ├── sound/                       # 合成提示音（番茄钟到点提醒）
│   │   ├── monitor/                     # 系统监控（CPU/内存/网络/磁盘/电池）
│   │   ├── pomodoro/                    # 番茄钟
│   │   ├── ai/                         # AI 服务（Anthropic / OpenAI 兼容 API）
│   │   ├── config/                     # ConfigManager、自启动
│   │   └── utils/                      # 日志、DPAPI 加解密
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── src/                                # 前端（React + TypeScript）
│   ├── main.tsx                        # 入口
│   ├── App.tsx                         # 路由：toolbar / orb / settings
│   ├── components/                     # FloatingOrb / ToolPalette / Settings / Icon
│   ├── tools/                          # 各工具（registry 注册，懒加载）
│   │   ├── registry.ts                 # 工具注册表（新增工具在此登记）
│   │   ├── text-toolbar/               # 文字工具栏
│   │   ├── screenshot/                 # 截图工具 + 标注
│   │   ├── recording/                  # 录屏工具
│   │   ├── quick-input/                # 快速输入转盘
│   │   ├── pomodoro/                   # 番茄钟
│   │   └── system-monitor/             # 系统监控
│   └── styles/
│
├── docs/                               # 设计文档
├── package.json
└── ...
```

---

## 🧭 架构概览

```
┌───────────────────────────────────────────────────────┐
│              前端层 (React + WebView)                  │
│   FloatingOrb → ToolPalette → 各工具组件              │
├───────────────────────────────────────────────────────┤
│              桥接层 (Tauri invoke / emit / listen)     │
├───────────────────────────────────────────────────────┤
│              后端层 (Rust)                              │
│   Mouse Hook ──→ emit("mouse-up")                     │
│   UI Automation ──→ get_selection                     │
│   GDI ──→ capture_screen_region                       │
│   WinRT OCR / PaddleOCR ──→ ocr_region                │
│   WinRT TTS ──→ tts_speak / pause / resume            │
│   ffmpeg pipe ──→ start_recording / stop_recording    │
│   sysinfo + PDH ──→ show_monitor_window               │
│   RegisterHotKey ──→ 全局热键                          │
│   AI Service ──→ call_ai                              │
└───────────────────────────────────────────────────────┘
```

### 核心运行流程

1. **选区感知**：全局低级鼠标钩子监听 `WM_LBUTTONUP`，通过 `mpsc` 通道通知后台线程，再 `emit("mouse-up")` 到前端
2. **文字工具栏**：前端监听事件 → 调用 `get_selection` 获取选中文字（多策略：UIA / Win32 / 剪贴板 / OCR 回退）→ 在选区旁弹出工具栏
3. **悬浮球**：始终置顶，点击展开工具面板，按需唤起各工具
4. **全局热键**：独立线程 + 仅消息窗口，`RegisterHotKey` 系统级触发
5. **OCR**：双引擎架构（Windows OCR + PaddleOCR ONNX），可自动选择或手动切换，大图自动分块 + COM 线程隔离

---

## 🤝 贡献指南

欢迎提交 Issue 与 Pull Request。

1. Fork 本仓库并新建你的功能分支
2. 提交前请确保通过测试与代码检查：

```bash
npm run test        # 单元测试（Vitest）
npm run lint        # ESLint 检查
npm run format:check # Prettier 格式检查
```

3. 提交清晰的改动说明，参考现有代码风格

> 新增工具时，在 `src/tools/registry.ts` 登记即可，卡片选择器会自动展示。

详细的架构与开发说明见 [docs 目录](docs/)。

---

## 📄 许可证

[MIT License](LICENSE) © 2026 Levitaire

---
