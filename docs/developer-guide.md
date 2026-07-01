# Floast Service 开发指南

## 目录

1. [项目概述](#项目概述)
2. [开发环境](#开发环境)
3. [项目结构](#项目结构)
4. [核心模块](#核心模块)
5. [插件开发](#插件开发)
6. [测试指南](#测试指南)
7. [发布流程](#发布流程)
8. [常见问题](#常见问题)

---

## 项目概述

Floast Service 是一个 Windows 悬浮工具，采用 Rust + Tauri 技术栈，主要用于选中文字后显示工具栏，提供剪切、复制等功能。

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
git clone https://github.com/yourusername/floast_service.git
cd floast_service
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
floast_service/
├── src-tauri/                          # Rust 后端
│   ├── src/
│   │   ├── main.rs                     # 程序入口
│   │   ├── lib.rs                      # 库入口
│   │   ├── hooks/                      # 系统钩子
│   │   │   ├── mod.rs
│   │   │   ├── mouse.rs                # 鼠标钩子
│   │   │   └── keyboard.rs             # 键盘钩子
│   │   ├── automation/                 # UI Automation
│   │   │   ├── mod.rs
│   │   │   └── text_selection.rs       # 文字选择检测
│   │   ├── clipboard/                  # 剪贴板管理
│   │   │   ├── mod.rs
│   │   │   └── manager.rs
│   │   ├── plugins/                    # 插件系统
│   │   │   ├── mod.rs
│   │   │   ├── trait.rs                # 插件接口
│   │   │   └── builtin/               # 内置插件
│   │   ├── commands/                   # Tauri 命令
│   │   │   ├── mod.rs
│   │   │   └── toolbar.rs
│   │   └── config/                     # 配置管理
│   │       └── mod.rs
│   ├── Cargo.toml                      # Rust 依赖
│   └── tauri.conf.json                 # Tauri 配置
│
├── src/                                # 前端代码
│   ├── index.html                      # 主页面
│   ├── toolbar.html                    # 工具栏页面
│   ├── styles/                         # 样式
│   │   ├── main.css
│   │   ├── toolbar.css
│   │   └── themes/
│   │       ├── dark.css
│   │       └── light.css
│   ├── scripts/                        # 脚本
│   │   ├── main.js
│   │   ├── toolbar.js
│   │   └── bridge.js                   # Tauri 桥接
│   └── assets/                         # 资源
│       ├── icons/
│       └── fonts/
│
├── docs/                               # 文档
├── Cargo.toml                          # 工作区配置
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

### 4. 插件系统模块 (plugins/)

管理插件的加载和执行。

**职责：**
- 插件的注册和管理
- 插件的执行调度
- 插件结果处理

**关键类型：**
- `Plugin` trait: 插件接口
- `PluginManager`: 插件管理器
- `PluginResult`: 执行结果

### 5. Tauri 命令模块 (commands/)

前后端通信的桥梁。

**职责：**
- 暴露命令给前端调用
- 处理前端请求
- 返回执行结果

**关键命令：**
- `get_selected_text`: 获取选中的文字
- `copy_text`: 复制文字
- `cut_text`: 剪切文字
- `show_toolbar`: 显示工具栏
- `hide_toolbar`: 隐藏工具栏
- `execute_plugin`: 执行插件

---

## 插件开发

### 插件接口

```rust
pub trait Plugin {
    /// 插件名称
    fn name(&self) -> &str;

    /// 插件图标
    fn icon(&self) -> &str;

    /// 插件描述
    fn description(&self) -> &str;

    /// 是否启用
    fn is_enabled(&self) -> bool;

    /// 优先级
    fn priority(&self) -> i32;

    /// 执行插件
    fn execute(&self, text: &str, context: &PluginContext) -> PluginResult;

    /// 初始化
    fn initialize(&mut self) -> Result<(), PluginError>;

    /// 销毁
    fn destroy(&mut self) -> Result<(), PluginError>;
}
```

### 创建新插件

1. 在 `src-tauri/src/plugins/builtin/` 创建新文件
2. 定义插件结构体
3. 实现 `Plugin` trait
4. 在 `mod.rs` 中注册

**示例：字数统计插件**

```rust
pub struct WordCountPlugin {
    name: String,
    enabled: bool,
}

impl Plugin for WordCountPlugin {
    fn name(&self) -> &str {
        &self.name
    }

    fn execute(&self, text: &str, _context: &PluginContext) -> PluginResult {
        let char_count = text.chars().count();
        let word_count = text.split_whitespace().count();

        PluginResult::success(format!(
            "字符数: {}, 单词数: {}",
            char_count, word_count
        ))
    }
}
```

### 插件最佳实践

1. **保持轻量**: 执行应该快速返回
2. **错误处理**: 返回友好的错误信息
3. **资源清理**: 在 `destroy` 中释放资源
4. **配置支持**: 支持插件配置

---

## 测试指南

### 单元测试

项目使用 Rust 内置的测试框架。

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clipboard_copy() {
        let manager = ClipboardManager::new();
        let result = manager.copy_text("测试文字");
        assert!(result.is_ok());
    }

    #[test]
    fn test_plugin_execute() {
        let plugin = WordCountPlugin::new();
        let result = plugin.execute("Hello World", &PluginContext::default());
        assert!(result.is_success());
    }
}
```

### 运行测试

```bash
# 运行所有测试
cargo test

# 运行特定测试
cargo test test_clipboard

# 运行集成测试
cargo test --test integration
```

### 调试技巧

1. **日志输出**: 使用 `tracing` crate 输出日志
2. **断点调试**: 使用 VS Code + CodeLLDB 插件
3. **Windows API 调试**: 使用 Spy++ 查看窗口消息

---

## 发布流程

### 1. 版本号管理

项目使用语义化版本号：`主版本号.次版本号.修订号`

更新版本号的位置：
- `src-tauri/Cargo.toml` 中的 `version` 字段
- `src-tauri/tauri.conf.json` 中的 `version` 字段

### 2. 构建发布版本

```bash
# 清理构建
cargo clean

# 构建 Release 版本
cargo tauri build
```

构建完成后，安装包位于 `src-tauri/target/release/bundle/` 目录。

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

- 项目主页: [GitHub](https://github.com/yourusername/floast_service)
- 问题反馈: [Issues](https://github.com/yourusername/floast_service/issues)

---

**最后更新**: 2024 年
