# Levitaire 快速开始指南

## 5 分钟快速上手

### 前提条件

- Windows 10/11
- Rust 1.70+
- Node.js 18+
- Visual Studio Build Tools

### 第一步：安装环境

**1. 安装 Rust**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**2. 安装 Node.js**
- 下载地址: https://nodejs.org/

**3. 安装 Tauri CLI**
```bash
cargo install tauri-cli
```

**4. 安装 Visual Studio Build Tools**
- 下载地址: https://visualstudio.microsoft.com/visual-cpp-build-tools/
- 选择"使用 C++ 的桌面开发"工作负载

### 第二步：获取代码

```bash
git clone https://github.com/yourusername/Levitaire.git
cd Levitaire
```

### 第三步：安装依赖

```bash
# 安装前端依赖
npm install
```

### 第四步：运行项目

```bash
# 开发模式运行
cargo tauri dev
```

### 第五步：测试功能

1. 程序启动后，会在系统托盘显示图标
2. 打开任意文本编辑器（如记事本）
3. 输入一些文字并用鼠标选中
4. 松开鼠标后，工具栏会自动出现在选中文字下方
5. 点击"复制"或"剪切"按钮

---

## 项目结构概览

```
Levitaire/
├── src-tauri/          # Rust 后端
│   ├── src/            # 源代码
│   ├── Cargo.toml      # Rust 依赖
│   └── tauri.conf.json # Tauri 配置
├── src/                # 前端代码
│   ├── index.html      # 主页面
│   ├── styles/         # 样式
│   └── scripts/        # 脚本
└── docs/               # 文档
```

---

## 核心功能说明

### 1. 文字选择检测

程序通过以下方式检测文字选择：

- **全局鼠标钩子**: 监听鼠标释放事件
- **UI Automation**: 获取选中的文字和位置
- **剪贴板监听**: 备用方案，通过模拟 Ctrl+C 获取文字

### 2. 悬浮工具栏

工具栏特性：
- 自动出现在选中文字下方
- 支持动画效果
- 失去焦点自动隐藏
- 可扩展的插件按钮

### 3. 剪切和复制

- **复制**: 将文字复制到剪贴板
- **剪切**: 复制文字并尝试删除原文字

---

## 常见问题

### Q: 程序无法启动？

**检查清单:**
1. 确保安装了 Rust 和 Node.js
2. 确保安装了 Visual Studio Build Tools
3. 确保以管理员身份运行（某些功能需要）
4. 检查杀毒软件是否拦截

### Q: 编译时出现错误？

**可能原因:**
1. Rust 版本过低 - 运行 `rustup update` 更新
2. 缺少依赖 - 运行 `npm install` 安装前端依赖
3. Windows SDK 缺失 - 安装 Visual Studio Build Tools

### Q: 工具栏不显示？

**可能原因:**
1. 程序未运行 - 检查系统托盘图标
2. 权限不足 - 以管理员身份运行
3. 目标应用不支持 - 尝试在记事本中测试

### Q: 在某些应用中无法获取文字？

**解决方案:**
1. 检查应用是否支持 UI Automation
2. 尝试使用剪贴板模式（自动降级）
3. 查看日志文件了解详细错误

---

## 下一步

### 阅读文档

- [架构设计文档](architecture-design.md) - 了解系统架构
- [开发指南](developer-guide.md) - 了解开发细节

### 尝试开发插件

1. 阅读 [插件开发指南](developer-guide.md#插件开发)
2. 创建自己的插件
3. 测试插件功能

### 参与贡献

1. 查看 [贡献指南](developer-guide.md#贡献指南)
2. 选择一个 Issue 开始
3. 提交 Pull Request

---

## 获取帮助

- **GitHub Issues**: 提交问题和建议
- **讨论区**: 参与社区讨论

---

## 相关资源

### 官方文档

- [Rust 官方文档](https://doc.rust-lang.org/)
- [Tauri 官方文档](https://tauri.app/v1/guides/)
- [windows-rs 文档](https://microsoft.github.io/windows-rs/)

### 学习资源

- [Rust 程序设计语言](https://kaisery.github.io/trpl-zh-cn/)
- [Tauri 教程](https://tauri.app/v1/tutorials/)

---

**提示**: 如果遇到问题，请查看日志输出，其中包含详细的错误信息。

**祝你使用愉快！** 🎉
