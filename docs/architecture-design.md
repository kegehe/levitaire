# Windows 悬浮工具 - 架构设计文档

## 1. 项目概述

### 1.1 项目目标
开发一个 Windows 悬浮效率工具箱：选中文字后在光标旁即时弹出工具栏，并可通过常驻悬浮球一键唤起
截图、录屏、OCR、时间工具、系统监控等桌面工具。架构设计需便于持续扩展新工具。

### 1.2 核心功能
- 监听全局文字选择事件（鼠标 / 键盘钩子）
- 在选中文字旁显示悬浮工具栏
- 文字工具：复制、搜索、翻译、AI 优化、文本转换、二维码、TTS 朗读等
- 屏幕工具：区域截图、标注、钉图、长截图、离线 OCR、GIF / MP4 录制
- 系统工具：系统监控、时间工具（时钟 / 倒计时 / 番茄钟 / 秒表 / 日历）、待办、便利贴
- 通过注册表驱动的工具架构支持持续扩展

---

## 2. 技术栈选择

### 2.1 技术栈：Rust + Tauri

**选择理由：**

| 特性 | 说明 |
|------|------|
| **性能优秀** | 原生编译，启动快，内存占用低 |
| **内存安全** | Rust 所有权机制避免内存泄漏 |
| **跨平台** | 未来可扩展到 macOS/Linux |
| **UI 灵活** | React + TypeScript 开发 UI，组件化、类型安全 |
| **生态成熟** | Tauri 框架稳定，社区活跃 |

### 2.2 技术栈详情

| 层级 | 技术 | 用途 |
|------|------|------|
| **后端** | Rust | 核心业务逻辑、系统 API 调用 |
| **前端** | React + TypeScript + Vite | UI 界面（通过 Tauri WebView） |
| **框架** | Tauri | 应用框架，桥接前后端 |
| **Windows API** | windows-rs | 系统钩子、UI Automation |
| **构建** | Cargo | Rust 包管理 |

---

## 3. 系统架构设计

### 3.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                       Tauri 应用                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │            前端层 (React + TypeScript)            │  │
│  │  ┌────────────────┐  ┌─────────────────────────┐  │  │
│  │  │ 悬浮球、工具   │  │ 设置页 / 各工具窗口     │  │  │
│  │  │ 面板           │  │ (registry 懒加载)       │  │  │
│  │  └────────────────┘  └─────────────────────────┘  │  │
│                            │                            │
│                      Tauri Bridge                       │
│                            │                            │
│  ┌───────────────────────────────────────────────────┐  │
│  │                   后端层 (Rust)                   │  │
│  │  ┌────────────────┐  ┌─────────────────────────┐  │  │
│  │  │ 系统钩子       │  │ 选区获取                │  │  │
│  │  │ (鼠/键/热键)   │  │ UIA / 剪贴板 / OCR      │  │  │
│  │  └────────────────┘  └─────────────────────────┘  │  │
│  │  ┌────────────────┐  ┌─────────────────────────┐  │  │
│  │  │ 剪贴板管理     │  │ 工具模块 / 注册表       │  │  │
│  │  │ 截图·录屏      │  │ 时间工具/待办/便利贴    │  │  │
│  │  └────────────────┘  └─────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 3.2 分层职责

| 层级 | 职责 | 技术 |
|------|------|------|
| **前端层** | UI 显示、用户交互 | React + TypeScript |
| **桥接层** | 前后端通信 | Tauri Bridge |
| **后端层** | 核心业务逻辑 | Rust |
| **系统层** | Windows API 调用 | windows-rs |

---

## 4. 核心模块设计

### 4.1 系统钩子模块 (Hook Manager)

**功能：**
- 监听全局鼠标事件（鼠标释放时检测文字选择）
- 监听全局键盘事件（快捷键支持）

**技术实现：**
- 使用 `SetWindowsHookEx` 安装鼠标钩子
- 使用 `WH_MOUSE_LL` 监听鼠标释放事件
- 钩子回调中触发文字选择检测

### 4.2 文字选择检测模块 (Text Selection)

**功能：**
- 检测当前选中的文字
- 获取选中文字的位置信息
- 支持多种应用程序的文字选择

**技术方案：**

**方案 A：UI Automation（推荐）**
- 使用 Windows UI Automation API
- 获取 `TextPattern` 中的选中文字
- 获取文字的边界矩形位置

**方案 B：剪贴板监听（备选）**
- 模拟 Ctrl+C 复制
- 读取剪贴板内容
- 恢复原始剪贴板（**仅当确认剪贴板里仍是自己写进去的那份内容**：用户中途自己按了
  Ctrl+C / Ctrl+X 就不能回滚，否则会把他刚复制/剪切的内容覆盖掉。判定与实现见
  `automation/clipboard_selection.rs` 的 `restore_clipboard_after_check`）

### 4.3 悬浮工具栏模块 (Floating Toolbar)

**功能：**
- 显示悬浮工具栏
- 支持动画效果
- 响应用户操作

**UI 设计：**
- 使用 HTML/CSS 构建工具栏
- 支持主题切换（暗色/亮色）
- 支持动画显示/隐藏

### 4.4 剪贴板管理模块 (Clipboard Manager)

**功能：**
- 复制文字到剪贴板
- 剪切文字（复制 + 删除）
- 读取剪贴板内容

### 4.5 工具模块与注册表 (Tool Registry)

**实现方式：**

后端按功能域拆分为独立模块（`screenshot` / `recording` / `ocr` / `todo` / `sticky_note` /
`timer` / `quick_input` 等），每个模块导出自己的 `#[tauri::command]`，统一在
`main.rs` 的 `tauri::generate_handler!` 中注册。

前端以 `src/tools/registry.ts` 作为唯一的工具注册入口，每个工具登记
`id / name / icon / category / loader / activation` 六项：

- `loader`：懒加载对应工具组件，Vite 会为每个工具切成独立 chunk
- `activation`：区分「选中文字后触发」(`selection`) 与「点击即进入」(`immediate`)
- 新增工具只需在注册表追加一项，工具面板会自动展示，无需改动面板代码

**已内置工具：** 文字工具栏、屏幕截图、GIF/录屏、快速输入、系统监控、时间工具
（时钟 / 倒计时 / 番茄钟 / 秒表 / 日历，番茄钟是其中一个页签）、待办清单、便利贴、屏幕草稿、
通用工具集（取色 / 滚动导航 / 窗口置顶）。

---

## 5. 项目结构设计

### 5.1 目录结构

```
Levitaire/
├── src-tauri/                          # Rust 后端
│   ├── src/
│   │   ├── main.rs                     # 入口：模块初始化、命令注册、托盘与窗口定位
│   │   ├── commands/                   # Tauri 命令（#[tauri::command]）与会话/窗口编排
│   │   ├── hooks/                      # 全局钩子
│   │   │   ├── mouse.rs                # 低级鼠标钩子（选区检测、取色）
│   │   │   ├── keyboard.rs             # 低级键盘钩子（Ctrl+C、快速输入触发键）
│   │   │   └── hotkey.rs               # RegisterHotKey 全局热键（截图/录屏/草稿/待办）
│   │   ├── automation/                 # 多策略选区获取
│   │   │   ├── selection.rs            # UIA / Win32 选区
│   │   │   ├── clipboard_selection.rs  # 剪贴板回退
│   │   │   └── ocr_selection.rs        # OCR 回退
│   │   ├── screenshot/                 # GDI 截屏、钉图、目标窗口识别
│   │   ├── scroll_capture/             # 长截图（滚动捕获与拼接）
│   │   ├── scroll_navigation.rs        # 滚动导航（UIA 滚动接口 + 投递键盘/滚轮）
│   │   ├── recording/                  # GIF / ffmpeg MP4 录制、窗口检测
│   │   ├── ocr/                        # OcrService：Windows OCR + PaddleOCR 双引擎
│   │   ├── tts/                        # WinRT SpeechSynthesizer 语音合成
│   │   ├── sound/                      # 合成提示音（到点提醒）
│   │   ├── monitor/                    # 系统监控（CPU/内存/网络/磁盘/电池）
│   │   ├── pomodoro/                   # 番茄钟计时状态（时间工具的番茄钟页签）
│   │   ├── timer/                      # 通用计时器（倒计时 / 秒表）
│   │   ├── todo/                       # 待办清单（独立数据存储 + 调度器）
│   │   ├── sticky_note/                # 便利贴
│   │   ├── quick_input.rs              # 快速输入转盘 + 剪贴板历史
│   │   ├── clipboard/                  # 剪贴板读写与监听
│   │   ├── ai/                         # AI 服务（Anthropic / OpenAI 兼容）
│   │   ├── config/                     # ConfigManager、自启动、窗口位置记忆
│   │   ├── updater/                    # 在线更新（启动 + 周期检查）
│   │   └── utils/                      # 日志、DPAPI 加解密
│   ├── resources/ocr/                  # 随包分发的 PaddleOCR 模型
│   ├── binaries/ · libs/               # ffmpeg.exe / onnxruntime.dll（不入库，见 README）
│   ├── tauri.conf.json                 # Tauri 基础配置
│   ├── tauri.bundle.conf.json          # 发版叠加配置（仅发版时注入上面两个二进制）
│   └── Cargo.toml
│
├── src/                                # 前端（React + TypeScript + Vite）
│   ├── main.tsx / App.tsx              # 入口与多窗口路由（toolbar / orb / settings…）
│   ├── components/                     # FloatingOrb / ToolPalette / Settings / ToolIcon / ContextMenu / UpdatePrompt
│   ├── tools/
│   │   ├── registry.ts                 # 工具注册表（新增工具在此登记）
│   │   ├── text-toolbar/               # 文字工具栏
│   │   ├── screenshot/                 # 截图 + 标注
│   │   ├── recording/                  # 录屏
│   │   ├── quick-input/                # 快速输入转盘
│   │   ├── timer/ system-monitor/      # 时间工具（时钟/倒计时/番茄钟/秒表/日历） / 系统监控
│   │   ├── todo/ sticky-note/          # 待办 / 便利贴
│   │   ├── sketch/ utility-hub/        # 屏幕草稿 / 通用工具集
│   │   ├── scroll-navigator/           # 滚动导航
│   │   └── color-picker/               # 取色器
│   ├── constants/ hooks/ utils/        # 常量、hooks、纯函数工具
│   └── styles/                         # 主题与设计 token
│
├── docs/                               # 设计文档
├── scripts/                            # 发版脚本 release.mjs 等
└── README.md
```

---

## 6. 数据流设计

### 6.1 文字选择处理流程

```
用户选择文字
      │
      ▼
┌─────────────────┐
│ 全局鼠标钩子    │
│ 检测鼠标释放    │
└─────────────────┘
      │
      ▼
┌─────────────────┐
│ UI Automation   │
│ 获取选中文字    │
│ 和位置信息      │
└─────────────────┘
      │
      ▼
┌─────────────────┐
│ Tauri 命令      │
│ 发送到前端      │
└─────────────────┘
      │
      ▼
┌─────────────────┐
│ 前端工具栏      │
│ 显示在指定位置  │
└─────────────────┘
      │
      ▼
┌─────────────────┐
│ 用户点击按钮    │
│ 调用后端命令    │
└─────────────────┘
```

### 6.2 前后端通信

```
前端 (JavaScript)          后端 (Rust)
        │                        │
        │   invoke('command')    │
        │ ─────────────────────> │
        │                        │
        │   返回结果             │
        │ <───────────────────── │
        │                        │
```

---

## 7. 扩展性设计

### 7.1 工具扩展

**新增一个工具（前端）：**
1. 在 `src/tools/<tool-id>/` 创建组件与样式
2. 在 `src/tools/registry.ts` 的 `FLOATING_TOOLS` 追加一项
   （`id / name / icon / description / category / defaultEnabled / loader / activation`）
3. 工具面板会自动展示，无需改动面板代码

**新增一个后端命令（Rust）：**
1. 在 `commands/` 下的对应功能域模块中写 `#[tauri::command]` 函数
2. 函数声明为 `pub fn`（`commands/mod.rs` 通过 `pub use <域>::*;` 重导出）
3. 在 `main.rs` 的 `tauri::generate_handler!` 中按 `commands::<函数名>` 注册
4. 在 `config` 里加 `xxx_enabled` 字段与 `get_`/`set_<tool>_enabled` 命令，并在 `registry.ts` 的
   `BACKEND_TOOLS` 登记 `{ id, getter, setter }`（用于前后端状态同步，也是面板开关的下发入口）。
   **所有悬浮工具都必须登记**：漏登记时开关只改前端状态，后端既不持久化、也不在禁用时收起窗口，
   palette 的「全部关闭」会因此关不掉该工具（通用工具曾踩过）

**下线或合并一个工具：**
工具被移除、或被并入另一个工具时，必须一并处理存储里的旧 ID，否则会**静默丢掉**用户的
启用状态与「启动时自动打开」配置：
1. 并入场景：在 `src/tools/registry.ts` 的 `TOOL_ID_ALIASES` 登记 `旧ID → 宿主ID`，
   `getEnabledTools()` 与 `FloatingOrb` 的自启动都会经 `resolveToolIdAlias()` 归一化
2. 前端窗口链路：`utils/toolWindows.ts` 的 `ToolWindowLabel` / `ensure*` 一套 / `openToolWindow` 分支、
   `App.tsx` 路由、`ToolPalette` 的激活分支 / `TOOL_COLORS`、
   `Settings` 的设置页签与 `WINDOW_POSITION_TARGETS`、`BACKEND_TOOLS`
   （开关的命令映射现已集中在 `BACKEND_TOOLS` 的 `setter`，不再有第二张 id→命令表）
3. 后端：`commands/mod.rs` 的 `is_levitaire_window` 清单、`scroll_navigation.rs` 窗口清单、
   `reset_window_position` 的窗口分支、对应的 `set_*_enabled` 命令与配置字段
4. 宿主工具的 `set_*_enabled(false)` 要负责**停掉被并入工具的后台计时/线程**，
   否则后端继续跑但用户已无入口看到

**示例：新增一个「文本去空格」工具**
- 前端加一个按钮触发 `invoke("trim_text", { text })`
- 后端在 `commands/` 下新增域模块，实现并注册 `trim_text`

### 7.2 主题扩展

**支持自定义主题：**
- 使用 CSS 变量定义主题色
- 支持暗色/亮色主题切换
- 可扩展自定义主题

### 7.3 快捷键扩展

**支持自定义快捷键：**
- 全局快捷键注册
- 可配置的快捷键映射

---

## 8. 技术实现要点

### 8.1 Windows API 调用

**使用 windows-rs crate：**
- 调用 `SetWindowsHookEx` 安装钩子
- 调用 UI Automation API 获取文字
- 调用剪贴板 API 进行复制/剪切

### 8.2 Tauri 命令

后端共注册 250+ 个 `#[tauri::command]`（集中在 `src-tauri/src/commands/`，按功能域拆分为多个子模块；`updater` 等模块导出自己的命令）。
按功能域举例：

**文字工具**
- `get_selection` — 获取选中文字（UIA / Win32 / 剪贴板 / OCR 多策略回退）
- `copy_text` / `copy_selection` — 复制到剪贴板
- `replace_selection` — 用处理结果替换原选区
- `call_ai` / `call_ai_stream` — AI 翻译与优化（支持流式返回）

**屏幕工具**
- `start_screenshot` / `capture_region` / `save_image` — 截图
- `ocr_region` — 离线 OCR（Windows OCR / PaddleOCR）
- `pin_image` / `close_pin` — 钉图
- `start_recording` / `stop_recording` / `save_video_file` — GIF / MP4 录制

**系统工具**
- `get_todos` / `create_todo` / `set_todo_completed` — 待办清单
- `get_timers` / `start_timer` / `set_timer_duration` — 时钟与倒计时 / 秒表
- `get_sticky_notes` / `create_sticky_note` — 便利贴
- `get_pomodoro_state` / `start_pomodoro` / `skip_pomodoro` — 番茄钟页签（计时状态由后端独立持有）

**配置与窗口**
- `get_ai_config` / `update_ai_config` — AI 配置
- `get_screenshot_hotkey` / `set_screenshot_hotkey` — 全局热键
- `show_settings` / `show_toolbar` / `hide_toolbar` — 窗口显隐

### 8.3 窗口管理

前端 `App.tsx` 按窗口 label 路由到不同界面。主要窗口：

| 窗口 label | 作用 |
|------------|------|
| `orb` | 常驻悬浮球（透明、置顶、不可聚焦） |
| `toolbar` | 选中文字后弹出的工具栏 |
| `palette` | 工具面板（点击悬浮球展开） |
| `settings` / `tool-config` | 设置页 / 单工具配置 |
| `screenshot-overlay` / `long-capture-*` | 截图选区与长截图覆盖层 |
| `monitor-overlay` / `time-overlay` / `todo-overlay` | 常驻系统工具浮窗（时间工具内含时钟 / 倒计时 / 番茄钟 / 秒表 / 日历页签） |
| `sticky-notes-manager` | 便利贴管理窗（各便签为独立窗口） |
| `quick-input-overlay` | 快速输入转盘 |
| `sketch-overlay` / `utility-hub-overlay` | 屏幕草稿 / 通用工具（滚动导航嵌在通用工具面板内） |
| `recording-controls` | 录屏控制条 |
| `update-prompt` | 新版本提示窗 |

窗口按需延迟创建（首次使用时才 `WebviewWindowBuilder::build`），关闭时拦截为隐藏以保留状态；
悬浮窗位置由 `config` 记忆，并在恢复时裁剪到当前显示器工作区内。

---

## 9. 开发计划

### 9.1 里程碑规划

以下为最初的阶段规划，括号内为当前实际状态（v0.1.3）。

**阶段 1：基础框架**
- [x] 搭建 Tauri 项目结构
- [x] 实现全局鼠标钩子（`hooks/mouse.rs`）
- [x] 实现文字选择检测（`automation/` 多策略）
- [x] 基础悬浮窗口显示（`orb` / `toolbar`）

**阶段 2：核心功能**
- [x] 实现复制 / 替换选区等功能
- [x] 完善 UI 样式和动画（React + TS + 设计 token）
- [x] 添加配置管理（`config/ConfigManager`，原子写入）
- [x] 异常处理和日志（`utils/logger`）

**阶段 3：工具化扩展（原「插件系统」）**
- [x] 以前端 `tools/registry.ts` 注册表替代动态插件机制
- [x] 11 个内置工具（文字工具栏 / 截图 / 录屏 / OCR / 快速输入 /
      系统监控 / 时间工具（时钟 / 倒计时 / 番茄钟 / 秒表 / 日历） / 待办 / 便利贴 / 屏幕草稿 / 通用工具集）
- [x] 每个工具可独立启停（设置页开关 ↔ 后端 config 双向同步）

**阶段 4：优化和完善**
- [x] 接入在线更新（Tauri Updater，本地脚本发版 + 签名）
- [x] 单元测试（前端 39 个测试文件 / 后端 316 项）
- [x] CI（typecheck + lint + vitest + cargo clippy/test）
- [x] 打包和发布（NSIS 安装包）

### 9.2 技术风险评估

| 风险 | 影响 | 解决方案 |
|------|------|----------|
| UI Automation 兼容性 | 部分应用无法获取文字 | 备用剪贴板监听方案 |
| 钩子性能影响 | 系统响应变慢 | 优化钩子处理逻辑 |
| Tauri 窗口管理 | 工具栏显示异常 | 研究 Tauri 窗口 API |

---

## 10. 总结

本架构设计采用 **Rust + Tauri** 技术栈，具有以下优势：

- ✅ **高性能**：Rust 原生编译，响应迅速
- ✅ **内存安全**：Rust 所有权机制避免内存问题
- ✅ **UI 灵活**：React + TypeScript 开发 UI，组件化、易维护
- ✅ **可扩展**：注册表驱动的工具架构，新增工具只需登记一项

核心模块包括：
1. **系统钩子模块**：全局鼠标 / 键盘 / 热键监听
2. **选区获取模块**：UIA / Win32 / 剪贴板 / OCR 多策略
3. **工具模块**：截图、录屏、OCR、快速输入、系统工具等，各自独立
4. **工具注册表**：前端统一登记，工具面板自动展示

后续可在此基础上继续扩展新的文字处理与屏幕工具。
