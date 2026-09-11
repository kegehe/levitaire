# Levitaire 开发指南

## 目录

1. [项目概述](#项目概述)
2. [开发环境](#开发环境)
3. [项目结构](#项目结构)
4. [核心模块](#核心模块)
5. [工具开发](#工具开发)
6. [测试指南](#测试指南)
7. [发布流程](#发布流程)
8. [常见问题](#常见问题)

---

## 项目概述

Levitaire 是一个 Windows 悬浮工具，采用 Rust + Tauri 技术栈，主要用于选中文字后显示工具栏，提供剪切、复制等功能。

### 技术栈

- **后端语言**: Rust
- **前端**: HTML/CSS/JS (通过 Tauri WebView)
- **框架**: Tauri 2.0
- **Windows API**: windows-rs crate
- **包管理**: Cargo
- **前端构建**: npm/pnpm

---

## 开发环境

### 必需工具

1. **Rust 工具链**
   - 安装地址: https://rustup.rs/
   - 版本要求: 1.70+

2. **Node.js**
   - 版本要求: 18+
   - 用于前端开发和构建

3. **Tauri CLI**
   ```bash
   cargo install tauri-cli
   ```

4. **Visual Studio Build Tools**
   - 需要安装 C++ 构建工具
   - 下载地址: https://visualstudio.microsoft.com/visual-cpp-build-tools/

### 可选工具

- **VS Code** + Rust Analyzer 插件
- **RustRover** IDE
- **Windows SDK**: 用于调试 Windows API

### 环境配置

1. 克隆项目
```bash
git clone https://github.com/yourusername/Levitaire.git
cd Levitaire
```

2. 安装前端依赖
```bash
npm install
```

3. 运行开发模式
```bash
cargo tauri dev
```

---

## 项目结构

```
Levitaire/
├── src-tauri/                          # Rust 后端
│   ├── src/
│   │   ├── main.rs                     # 入口：模块初始化、命令注册、托盘与窗口定位
│   │   ├── commands/                   # Tauri 命令（#[tauri::command]）与会话/窗口编排
│   │   ├── hooks/                      # 全局钩子：mouse / keyboard / hotkey
│   │   ├── automation/                 # 选区获取：selection / clipboard_selection / ocr_selection
│   │   ├── screenshot/                 # 截屏、钉图、目标窗口识别
│   │   ├── scroll_capture/             # 长截图（滚动捕获与拼接）
│   │   ├── scroll_navigation.rs        # 滚动导航
│   │   ├── recording/                  # GIF / MP4 录制、窗口检测
│   │   ├── ocr/                        # OcrService：Windows OCR + PaddleOCR
│   │   ├── tts/  sound/                # 语音合成 / 提示音
│   │   ├── monitor/  pomodoro/         # 系统监控 / 番茄钟
│   │   ├── timer/  todo/  sticky_note/ # 时钟 / 待办 / 便利贴
│   │   ├── quick_input.rs              # 快速输入转盘 + 剪贴板历史
│   │   ├── clipboard/                  # 剪贴板读写与监听
│   │   ├── ai/                         # AI 服务（Anthropic / OpenAI 兼容）
│   │   ├── config/                     # ConfigManager、自启动、窗口位置记忆
│   │   ├── updater/                    # 在线更新
│   │   └── utils/                      # 日志、DPAPI 加解密
│   ├── resources/ocr/                  # PaddleOCR 模型（随包分发）
│   ├── binaries/ · libs/               # ffmpeg.exe / onnxruntime.dll（不入库，见 README）
│   ├── tauri.conf.json                 # Tauri 基础配置
│   ├── tauri.bundle.conf.json          # 发版叠加配置（发版时注入上述两个二进制）
│   └── Cargo.toml
│
├── src/                                # 前端（React + TypeScript + Vite）
│   ├── main.tsx / App.tsx              # 入口与多窗口路由
│   ├── components/                     # FloatingOrb / ToolPalette / Settings / ToolIcon / ContextMenu…
│   ├── tools/
│   │   ├── registry.ts                 # 工具注册表（新增工具在此登记）
│   │   ├── text-toolbar/ screenshot/ recording/ quick-input/
│   │   ├── pomodoro/ system-monitor/ timer/ todo/ sticky-note/
│   │   └── sketch/ utility-hub/ scroll-navigator/ color-picker/
│   ├── constants/ hooks/ utils/        # 常量、hooks、纯函数工具
│   └── styles/                         # 主题与设计 token
│
├── docs/                               # 文档
├── scripts/                            # 发版脚本 release.mjs 等
└── README.md
```

### 分层职责

| 层级 | 目录 | 职责 |
|------|------|------|
| **前端层** | `src/` | UI 显示、用户交互 |
| **后端层** | `src-tauri/src/` | 核心业务逻辑 |
| **系统层** | `src-tauri/src/hooks/` | Windows API 调用 |

---

## 核心模块

### 1. 系统钩子模块 (hooks/)

负责监听全局鼠标和键盘事件。

**职责：**
- 安装/卸载全局鼠标钩子
- 监听鼠标释放事件
- 监听键盘事件（快捷键支持）

**关键类型：**
- `MouseHook`: 鼠标钩子管理
- `KeyboardHook`: 键盘钩子管理
- `HookEvent`: 钩子事件枚举

**注意事项：**
- 钩子回调必须快速返回
- 程序退出时必须卸载钩子
- 需要管理员权限（某些情况）

### 2. 文字选择检测模块 (automation/)

负责通过 UI Automation API 获取选中的文字。

**职责：**
- 获取前台窗口信息
- 获取焦点元素
- 提取选中的文字和位置

**关键类型：**
- `TextSelection`: 文字选择信息
- `SelectionPosition`: 位置信息
- `AutomationManager`: 自动化管理器

**兼容性说明：**
- 大多数标准 Windows 控件支持
- 某些第三方控件可能不支持
- 自动降级到剪贴板方式

### 3. 剪贴板管理模块 (clipboard/)

负责剪切和复制操作。

**职责：**
- 复制文字到剪贴板
- 剪切文字（复制 + 删除）
- 读取剪贴板内容

**关键类型：**
- `ClipboardManager`: 剪贴板管理器
- `ClipboardError`: 错误类型

### 4. 工具模块与注册表 (tools/ + registry.ts)

每个工具前端是一个独立目录，后端是若干 `#[tauri::command]`。
前端用注册表统一登记，工具面板据此自动展示。

**职责：**
- 登记工具的元信息与组件入口（懒加载）
- 决定工具的激活方式（选中文字触发 / 点击即进入）
- 保持前后端的工具启停状态一致

**关键类型：**
- `FloatingTool`（`src/tools/registry.ts`）：工具定义接口
- `FLOATING_TOOLS`：工具注册表数组
- `BACKEND_TOOLS`：工具 id → 后端启停 getter 的映射

### 5. Tauri 命令模块 (commands/)

前后端通信的桥梁。

**职责：**
- 暴露命令给前端调用
- 处理前端请求
- 返回执行结果

**关键命令（完整列表见 `main.rs` 的 `generate_handler!`）：**
- `get_selection`: 获取选中文字（多策略回退）
- `copy_text` / `copy_selection`: 复制到剪贴板
- `replace_selection`: 替换选区
- `start_screenshot` / `ocr_region`: 截图 / OCR
- `call_ai` / `call_ai_stream`: AI 翻译与优化
- `show_toolbar` / `hide_toolbar` / `show_settings`: 窗口显隐

---

## 工具开发

### 前端：登记一个工具

在 `src/tools/registry.ts` 的 `FLOATING_TOOLS` 中追加一项：

```ts
{
  id: "my-tool",
  name: "我的工具",
  icon: "Sparkles",           // 可用图标名见 components/ToolIcon.tsx
  description: "一句话说明",
  category: "text",            // text | screen | system
  defaultEnabled: false,
  loader: () => import("./my-tool/MyTool"),   // 懒加载，Vite 自动分包
  activation: "immediate",     // immediate=点击即进入；selection=选中文字后触发
}
```

若该工具有独立启停开关，再到 `BACKEND_TOOLS` 登记 `{ id, getter }`，
用于与 `config.json` 中的真值双向同步（否则设置页开关不会生效）。

### 后端：新增一个命令

1. 在对应功能域模块里写函数并标注 `#[tauri::command]`
2. 在 `src-tauri/src/main.rs` 的 `tauri::generate_handler![...]` 中加入它
3. 前端用 `invoke("命令名", { 参数 })` 调用

```rust
/// 统计文本的字数与词数。
#[tauri::command]
pub fn count_words(text: String) -> Result<(usize, usize), String> {
    let chars = text.chars().count();
    let words = text.split_whitespace().count();
    Ok((chars, words))
}
```

### 最佳实践

1. **保持轻量**：钩子回调与命令应快速返回，耗时操作放后台线程
2. **建窗命令必须 `async`**：任何会调用 `WebviewWindowBuilder::build()` 的命令（含间接调用
   `ensure_*_window` 这类辅助函数）都必须声明为 `pub async fn`，否则在 Windows 上会死锁并冻结
   整个应用。非 `async` 命令由 Tauri 在主线程 inline 执行，而主线程此刻正处于 WebView2 的 IPC
   回调内部，`build()` 需要主线程再处理一次窗口创建，永远等不到。见
   [WebviewWindowBuilder 的 Known issues](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html)。
   前端用 JS `WebviewWindow` 建窗不受影响（走的是异步插件命令）。
3. **更新下载统一走后端 `install_update`**：前端任何"下载并安装"入口都应
   `invoke("install_update")` 并监听 `update-progress` 事件取进度，不要用 JS 插件
   `update.downloadAndInstall()`。原因：`UpdaterBuilder::timeout` 对 `download()` 不生效
   （插件在构造 `Update` 时把 timeout 硬编码为 `None`），后端是在 `configure_client` 里注入
   **连接超时 + 读空闲超时**才兜住的；而 JS 侧只暴露「整体 timeout」，给 96MB 安装包设整体
   超时会在慢速链路上误杀正常下载。`on_chunk` 的首参是**本次分块长度**，不是累计值，进度必须累加。
4. **错误处理**：命令返回 `Result<T, String>`，错误信息用中文，前端可直接展示
5. **勿阻塞钩子**：不要在低级钩子回调里做耗时操作，否则会拖慢系统输入
6. **状态管理**：新状态优先放进 Tauri `State`，避免继续新增模块级 `static`
7. **配置读写**：新增配置项走 `config::ConfigManager`，它保证原子写入（临时文件 + rename）
8. **提交前自检**：`npm run typecheck && npm run lint && npm run test`，以及 `cargo test`

---

## 测试指南

### 单元测试

后端使用 Rust 内置测试框架，测试模块与源码同文件（`#[cfg(test)] mod tests`）；
前端使用 Vitest + Testing Library。

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_redact_url_for_log_drops_path_and_query() {
        assert_eq!(
            redact_url_for_log("https://www.bing.com/search?q=secret#frag"),
            "https://www.bing.com"
        );
    }

    #[test]
    fn test_default_window_position_unknown_fallback() {
        assert_eq!(default_window_position("unknown-window", 100, 100), (100, 100));
    }
}
```

### 运行测试

```bash
# 后端全部测试
cargo test

# 只跑名字含 redact_url 的测试
cargo test redact_url

# 前端全部测试（Vitest）
npm run test

# 前端类型检查 + Lint
npm run typecheck && npm run lint
```

### 调试技巧

1. **日志输出**: 使用内置 `crate::utils::logger::log(tag, msg)`，写入 `levitaire-debug.log`
2. **断点调试**: 使用 VS Code + CodeLLDB 扩展
3. **Windows API 调试**: 使用 Spy++ 查看窗口消息

---

## 发布流程

### 1. 版本号管理

项目使用语义化版本号：`主版本号.次版本号.修订号`

需要同步版本号的**三处**（`npm run release <ver>` 会自动一起改并校验一致性）：
- `src-tauri/Cargo.toml` 中的 `version`
- `src-tauri/tauri.conf.json` 中的 `version`
- `package.json` 中的 `version`

### 2. 构建发布版本

发版前需先补齐两个不入库的二进制资源（见 README「构建与资源」）：
`src-tauri/binaries/ffmpeg.exe` 与 `src-tauri/libs/onnxruntime.dll`。

```bash
# 一条命令：升版本号 → 打包(--bundles nsis, 含发版叠加配置) → 签名 → 生成 latest.json
npm run release 0.1.4 "修复了…\n新增了…"

# 仅想手动出包不发版
npm run tauri build -- --bundles nsis --config src-tauri/tauri.bundle.conf.json
```

构建完成后，安装包位于 `src-tauri/target/release/bundle/nsis/`。

### 3. 发布检查清单

- [ ] 所有测试通过
- [ ] 版本号已更新
- [ ] 更新日志已编写
- [ ] 文档已更新
- [ ] 在不同 Windows 版本上测试
- [ ] 检查杀毒软件误报
- [ ] 创建发布包
- [ ] 上传到发布平台

---

## 常见问题

### Q: 钩子安装失败怎么办？

**A:** 可能的原因：
1. 权限不足 - 尝试以管理员身份运行
2. 杀毒软件拦截 - 将程序添加到白名单
3. 其他程序已安装钩子 - 检查是否有冲突

### Q: 在某些应用中无法获取选中的文字？

**A:** 可能的原因：
1. 应用不支持 UI Automation - 尝试使用剪贴板模式
2. 应用使用了自定义控件 - 需要特定的处理逻辑
3. 应用运行在管理员权限下 - 程序也需要管理员权限

### Q: 编译时出现链接错误？

**A:** 确保安装了：
1. Visual Studio Build Tools (C++ 构建工具)
2. Windows SDK
3. 正确的 Rust 工具链 (stable-x86_64-pc-windows-msvc)

### Q: 如何调试 UI Automation？

**A:** 使用以下工具：
1. **Accessibility Insights for Windows**: 查看控件树和属性
2. **Spy++**: 查看窗口消息
3. **UI Automation Verify**: 验证自动化属性

### Q: 如何添加新的 Windows API 调用？

**A:** 步骤：
1. 在 `Cargo.toml` 中添加 `windows` crate 依赖
2. 使用 `windows::Win32::*` 模块中的 API
3. 添加必要的 feature flags
4. 封装为安全的 Rust 接口

---

## 贡献指南

### 代码风格

- 使用 `rustfmt` 格式化代码
- 使用 `clippy` 进行代码检查
- 遵循 Rust 命名规范
- 添加文档注释

### 提交规范

使用约定式提交：

```
<类型>(<范围>): <描述>

[可选正文]

[可选脚注]
```

类型：
- `feat`: 新功能
- `fix`: 修复 bug
- `docs`: 文档更新
- `style`: 代码格式调整
- `refactor`: 代码重构
- `test`: 测试相关
- `chore`: 构建/工具相关

### Pull Request 流程

1. Fork 项目
2. 创建功能分支
3. 提交更改
4. 推送到分支
5. 创建 Pull Request
6. 等待代码审查
7. 合并到主分支

---

## 相关资源

### 官方文档

- [Rust 官方文档](https://doc.rust-lang.org/)
- [Tauri 官方文档](https://tauri.app/v1/guides/)
- [windows-rs 文档](https://microsoft.github.io/windows-rs/)

### 学习资源

- [Rust 程序设计语言](https://kaisery.github.io/trpl-zh-cn/)
- [Tauri 教程](https://tauri.app/v1/tutorials/)
- [Windows API 参考](https://docs.microsoft.com/zh-cn/windows/win32/apiindex/)

### 工具推荐

- [VS Code](https://code.visualstudio.com/) + Rust Analyzer
- [RustRover](https://www.jetbrains.com/rust/)
- [Spy++](https://docs.microsoft.com/zh-cn/cpp/mfc/reference/spy-increment-utility)

---

## 联系方式

- 项目主页: [GitHub](https://github.com/yourusername/Levitaire)
- 问题反馈: [Issues](https://github.com/yourusername/Levitaire/issues)

---

**最后更新**: 2024 年
