# Floast Service

一个基于 Rust + Tauri 的 Windows 悬浮工具栏应用。在任意应用中选中文字后，自动在选中区域下方显示悬浮工具栏，提供剪切、复制等快捷操作。

## ✨ 功能特性

- 🔍 **全局文字选择检测** — 通过 Windows 鼠标钩子监听页面选中文字
- 📋 **悬浮工具栏** — 在选中文字下方自动弹出，透明无边框，始终置顶
- ✂️ **复制** — 快捷执行剪贴板操作
- 🤖 **AI 文本优化** — 润色、正式化、简洁化、翻译，支持 Anthropic 和 OpenAI 兼容 API
- 💫 **悬浮球** — 可拖拽的悬浮快捷入口，始终置顶
- 🔒 **API Key 加密存储** — 使用 Windows DPAPI 加密保护 API 密钥
- 🚀 **开机自启动** — 通过 Windows 注册表实现
- 🎨 **主题支持** — 内置浅色 / 深色主题切换（设置页面）
- ⚡ **高性能** — Rust 原生编译，内存占用约 35MB

## 🛠️ 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 后端 | Rust + windows-rs 0.61 | 系统钩子、剪贴板、UI Automation |
| 前端 | React 18 + TypeScript + Vite | 工具栏 UI |
| 框架 | Tauri 2.x | 前后端桥接、多窗口管理 |
| 构建 | Cargo + npm | 依赖管理与构建 |

## 📦 环境要求

- Windows 10 / 11
- [Rust](https://rustup.rs/) 1.70+
- [Node.js](https://nodejs.org/) 18+
- [Tauri CLI](https://tauri.app/) 2.x

## 🚀 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/yourusername/floast_service.git
cd floast_service
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

### 4. 构建发布版本

```bash
cargo tauri build
```

构建产物位于 `src-tauri/target/release/bundle/`，包含 `.msi` 安装包和独立 `.exe`。

## 📖 使用方法

1. 启动应用后，系统托盘出现 Floast 图标
2. 在任意应用中用鼠标选中一段文字
3. 松开鼠标后，悬浮工具栏自动出现在选中区域下方
4. 点击 **✂️ 剪切** 或 **📋 复制** 执行操作
5. 点击工具栏外部区域自动隐藏

## 📁 项目结构

```
floast_service/
├── src-tauri/                        # Rust 后端
│   ├── src/
│   │   ├── main.rs                   # 入口：初始化管理器、启动钩子
│   │   ├── commands.rs               # Tauri 命令（get_selection, copy_text 等）
│   │   ├── hooks/                    # Windows 鼠标钩子
│   │   │   ├── mod.rs                # HookManager
│   │   │   └── mouse.rs             # WH_MOUSE_LL 全局钩子实现
│   │   ├── automation/               # 文字选择检测
│   │   │   ├── mod.rs                # SelectionInfo / Rect / Point 结构体
│   │   │   └── selection.rs          # get_selection / get_cursor_position
│   │   ├── clipboard/                # 剪贴板管理
│   │   │   ├── mod.rs                # ClipboardManager
│   │   │   └── manager.rs            # copy / cut / history
│   │   ├── config/                   # 配置管理（含 DPAPI 加密存储、开机自启动）
│   │   │   └── mod.rs                # ConfigManager / AiConfig / auto_start
│   │   ├── ai/                       # AI 服务（支持 Anthropic / OpenAI 兼容 API）
│   │   │   └── mod.rs                # AiService
│   │   └── utils/                    # 工具模块
│   │       ├── mod.rs
│   │       ├── logger.rs             # 日志（debug 仅输出）
│   │       └── crypto.rs             # DPAPI 加解密
│   ├── Cargo.toml
│   ├── tauri.conf.json               # 窗口 / 托盘 / 构建配置
│   └── icons/                        # 应用图标
│
├── src/                              # 前端（React + TypeScript）
│   ├── main.tsx                      # 入口
│   ├── App.tsx                       # 路由：toolbar / orb / settings 窗口
│   ├── types.ts                      # 类型定义
│   ├── components/
│   │   ├── FloatingToolbar.tsx       # 悬浮工具栏主组件
│   │   ├── FloatingOrb.tsx           # 悬浮球组件
│   │   ├── ToolbarButton.tsx         # 工具栏按钮组件
│   │   ├── Icon.tsx                  # 图标组件（基于 lucide-react）
│   │   ├── Settings.tsx              # 设置页面
│   │   └── *.css                     # 组件样式
│   ├── hooks/
│   │   └── useAiOptimize.ts          # AI 优化 Hook
│   ├── constants/
│   │   └── optimizeModes.ts          # AI 优化模式定义
│   └── styles/
│       ├── global.css                # 全局 CSS
│       └── tokens.css                # CSS 变量
│
├── docs/                             # 设计文档
├── package.json
├── vite.config.ts
├── tsconfig.json
└── index.html
```

## 🏗️ 架构概览

```
┌─────────────────────────────────────────────┐
│           前端层 (React + WebView)          │
│   FloatingToolbar ← listen("mouse-up")      │
├─────────────────────────────────────────────┤
│           桥接层 (Tauri invoke / emit)       │
├─────────────────────────────────────────────┤
│           后端层 (Rust)                      │
│   Mouse Hook ──mpsc──→ emit("mouse-up")     │
│   UI Automation ──→ get_selection            │
│   Clipboard ──→ copy / cut                  │
│   AI Service ──→ call_ai                    │
└─────────────────────────────────────────────┘
```

### 核心流程

1. **鼠标钩子** (`hooks/mouse.rs`)：通过 `SetWindowsHookExW` 注册全局低级鼠标钩子，监听 `WM_LBUTTONUP` 事件
2. **事件传递**：钩子回调通过 `std::sync::mpsc` 将事件发送到后台线程，由后台线程调用 `app_handle.emit("mouse-up")` 通知前端
3. **前端响应**：`FloatingToolbar` 组件监听 `mouse-up` 事件，调用 `get_selection` 命令获取选中文字，显示工具栏
4. **操作执行**：用户点击按钮后，前端调用 `copy_text` 或 `cut_text` 命令

## 🔌 AI 配置

Floast 支持两种 AI API 格式：

### Anthropic（默认）
- **Base URL**: `https://api.anthropic.com`
- **Model**: `claude-sonnet-4-20250514`
- 使用 `x-api-key` 认证

### OpenAI 兼容（DeepSeek、通义千问、OpenAI 等）
- **Base URL**: 如 `https://api.deepseek.com`、`https://dashscope.aliyuncs.com/compatible-mode`
- **Model**: 如 `deepseek-chat`、`qwen-plus`
- 使用 `Authorization: Bearer` 认证

在设置页面的"API 类型"下拉框中选择对应类型，填写 API Key、Base URL 和 Model 即可。

API Key 使用 Windows DPAPI 加密存储在 `%APPDATA%/floast/config.json` 中，绑定当前用户，不可跨机器迁移。

## 📚 相关文档

- [架构设计文档](docs/architecture-design.md)
- [开发指南](docs/developer-guide.md)
- [快速开始](docs/quick-start.md)

## 📄 许可证

[MIT License](LICENSE) © 2026 Floast Service
