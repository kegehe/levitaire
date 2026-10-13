<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" height="96" alt="Levitaire">

# Levitaire

**基于 Rust + Tauri 的 Windows 浮窗效率工具箱**

选中文字即时弹出工具栏 · 悬浮球一键唤起 · 截图 / 录屏 / OCR / 时间工具 / 系统监控

<p>
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-blue.svg">
  <img alt="Release" src="https://img.shields.io/github/v/release/kegehe/levitaire">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-1.88%2B-orange.svg">
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2.x-green.svg">
</p>

</div>

---

## 📌 简介

Levitaire 是一款面向 Windows 的悬浮效率工具集。运行后一个悬浮球常驻屏幕，通过全局钩子自动感知「选中文字」，在鼠标旁即时弹出工具栏；也可一键唤起截图、录屏、OCR、时间工具、系统监控等桌面工具，覆盖日常办公中的高频操作。

核心思路是把散落在多个应用里的零碎操作（复制、搜索、翻译、转换格式、截屏、记录）收敛到一个「指针所在之处」的统一入口，减少应用间切换。

---

## ✨ 功能特性

### 🔤 文字工具

选中任意应用的文字后，工具栏自动在鼠标旁弹出（透明无边框、始终置顶）：

- **一键复制 / 快捷搜索** — 点一下即复制，或在必应 / Google / 百度 / DuckDuckGo / 搜狗中搜索选中文字（默认必应，可切换）
- **AI 翻译与优化** — 翻译、润色、正式化、简洁化，兼容 Anthropic 与 OpenAI 两类 API（DeepSeek、通义千问等）
- **文本转换** — 大小写转换、Base64 编解码、中文与 Unicode 互转、简繁转换
- **编辑处理** — 按行去重、自动编号、MD5 摘要、字符统计，以及按类型批量清理（空格 / 制表符 / 换行 / 空白 / 字母 / 数字 / 中文）
- **二维码与朗读** — 选中文字即时转二维码；Windows 内置语音合成朗读，支持暂停 / 继续 / 停止

### 🖥️ 快速输入

- **转盘输入** — 按下触发键（默认 CapsLock，可改）唤起圆形转盘，鼠标旋转选择预设词或剪贴板历史，点选即输入

### 📷 屏幕工具

- **区域截图与标注** — 拖框截取屏幕任意区域（支持多显示器 / 虚拟桌面），可绘制箭头、矩形、文字标注
- **钉图** — 截图后钉在桌面最上层，可拖拽、缩放，作临时参考
- **长截图** — 滚动捕获可滚动页面并自动拼接为一张长图，支持预览、保存与复制
- **屏幕草稿** — 在当前屏幕上绘制临时草图，可保存为透明 PNG
- **离线 OCR** — 双引擎离线文字识别（Windows 系统 OCR + PaddleOCR），无需联网，可切换引擎
- **GIF / 视频录制** — 录制屏幕区域为 GIF 或 MP4，支持全屏 / 区域 / 窗口识别

### 📊 系统工具

- **系统监控** — 常驻悬浮显示 CPU、内存、网络、磁盘、电池实时曲线
- **时间工具** — 一个悬浮窗内置时钟、倒计时、番茄钟、秒表、月历五个页签；月历带农历与 24 节气（本地历法计算，不联网）
- **待办清单** — 分组待办、截止时间与提醒、重复任务、导入导出，支持全局快捷键快速添加
- **便利贴** — 桌面多张便签、6 种预置纸色、实时编辑并持久化；管理窗可一键收起 / 一键把已收起的全部贴回

### 🧰 通用工具

- **取色器** — 拾取屏幕任意位置的颜色值，可查看并一键复制 HEX / `rgb(r, g, b)`，最近用色本地保留
- **滚动导航** — 长网页 / 长文档翻页与定位：目标窗口提供 UIA 滚动接口时给出百分比与滑杆，否则改用投递键盘 / 滚轮通道做相对滚动（到顶到底、翻页、微调），浏览器与资源管理器同样可用
- **窗口置顶** — 点选任意其他程序的窗口把它钉在最前（面板按钮进入点选、`Esc` 退出），面板中可查看当前置顶清单并逐条 / 一键取消；工具停用或退出应用时会自动把所有窗口还原

### ⚙️ 全局能力

- **悬浮球与工具面板** — 可拖拽、始终置顶，点击展开工具面板（按文字 / 屏幕 / 系统分组，悬停可见用途说明）；每个工具可独立启停
- **全局热键** — 截图、录屏等支持系统级快捷键（Win32 `RegisterHotKey`），无需聚焦窗口，冲突自动检测
- **安全存储** — API Key 使用 Windows DPAPI 加密，绑定当前用户，不可跨机器迁移
- **开机自启动与主题** — 注册表实现自启，浅色 / 深色主题切换
- **原生全链路** — Rust 原生编译，GDI 截屏、WinRT OCR / TTS、PDH 性能计数均直接调用系统接口

---

## 📦 下载安装

- **安装包**：到 [Releases](https://github.com/kegehe/levitaire/releases) 下载最新的 `Levitaire_x.y.z_x64-setup.exe`（NSIS 安装包）
- **在线更新**：启动后自动检查（之后每 24h 复检），发现新版本会在**后台静默下载**，全程不打扰；下载完成并在右上角提示「新版本已就绪」后点一下即可安装，断网也能装。也可在「设置 → 通用 → 在线更新」中手动检查
- **系统要求**：Windows 10 / 11（x64），依赖 WebView2 运行时；缺失时安装包会静默下载并安装（需联网）
- **更新日志**：[发布说明](docs/releases/)

首次启动后悬浮球落在主屏右下角（工作区边缘内 20px），系统托盘出现图标；悬浮球可拖到任意位置并记忆。默认开启的工具有文字工具栏、屏幕截图、屏幕草稿、通用工具，其余工具在工具面板中按需开启。

---

## 🚀 快速开始（源码构建）

### 环境要求

- Windows 10 / 11（x64）
- [Rust](https://rustup.rs/) 1.88+（下限由 PaddleOCR 的 `ort` 依赖决定；tauri 2.x 自身只要求 1.77.2），需 Visual Studio C++ 生成工具（MSVC 工具链）
- [Node.js](https://nodejs.org/) 20.19+ 或 22.12+（本项目使用 npm，Node 自带 npm 即可）

> 无需单独安装 Tauri CLI，`npm install` 已包含 `@tauri-apps/cli`，统一走 `npm run tauri`。

### 克隆与运行

```bash
git clone https://github.com/kegehe/levitaire.git
cd levitaire

npm install        # 安装前端依赖
npm run tauri dev  # 开发模式运行
```

Vite 开发服务器固定运行在 `http://localhost:1420`（`strictPort`）。

### 打包

```bash
npm run build:app   # = tauri build --config src-tauri/tauri.bundle.conf.json
```

产物位于 `src-tauri/target/release/bundle/`，`nsis/` 与 `msi/` 下各有一份安装包（`bundle.targets` 为 `all`）；未打包的可执行文件为 `src-tauri/target/release/levitaire.exe`。发版脚本只出 NSIS（`--bundles nsis`）。

### 可选二进制资源（仅打包需要）

| 文件 | 放置路径 | 用途 | 体积 |
|------|----------|------|------|
| `ffmpeg.exe` | `src-tauri/binaries/ffmpeg.exe` | MP4 视频编码 | 约 4 MB（精简构建） |
| `onnxruntime.dll` | `src-tauri/libs/onnxruntime.dll` | PaddleOCR 本地推理 | 约 20 MB |

两者均**未纳入 Git 仓库**，缺失时发版脚本会直接提示路径；开发模式不受影响，OCR 会自动回退到 Windows 内置引擎。PaddleOCR 模型（`det.onnx` / `rec.onnx` 等）已随仓库提供，位于 `src-tauri/resources/ocr/`，打包时映射到安装目录的 `ocr/`。

`ffmpeg.exe` 采用**精简构建**：录制只用到 `rawvideo` 解码 → `libx264` 编码 → `mp4` 封装 → `crop` 滤镜这一条链路，官方 full build（约 230 MB）的其余编解码器全部闲置。精简版只含该链路，约 4 MB，安装包（NSIS）由 92 MB 降至 37 MB、安装后占用由约 305 MB 降至约 77 MB。两者产出的 MP4 经逐像素比对完全一致（PSNR 无穷大），编码速度相当。重建方式见 `scripts/build-ffmpeg-lite.sh`（含完整组件清单与验证步骤）。

重建时必须用 `-static` 链接。若产物依赖 `libwinpthread-1.dll` 这类**非系统 DLL**，开发机上一切正常（Git/WinLibs 的 `mingw64\bin` 在 PATH 上），端用户机器却必然启动失败——`spawn()` 会成功而进程加载即崩，只留下 `0xc0000135`。脚本的产物自检会拦住这一项；相关教训：本地 PSNR 比对与 `cargo test` **都发现不了**它，只有把 PATH 清空到只剩 `System32` 的实测才能暴露。

`ffmpeg_path()` 只按文件名查找、不校验构建选项，因此放回官方 full build 同样可用，代价是安装包大 200 MB 以上。

PaddleOCR 以 `load-dynamic` 模式运行时加载 ONNX Runtime（不静态链接），按 `ORT_DYLIB_PATH` → 当前目录 → exe 同目录 → exe 同目录 `resources/` 的顺序查找 DLL。不使用 PaddleOCR 时，可移除 `ort` / `ndarray` 依赖与 `src-tauri/src/ocr/paddle_ocr.rs` 以减小构建体积。

### 发布新版本

```bash
# 升版本号（package.json / Cargo.toml / tauri.conf.json 三处校验并同步）
# + 打包 NSIS + 签名 + 生成 release/latest.json（同时写入仓库根 latest.json）
npm run release 0.1.6 "修复了…\n新增了…"

# 发布：打 tag、上传安装包与升级清单、更新 GitHub Pages 上的 latest.json
git tag v0.1.6 && git push origin v0.1.6
gh release create v0.1.6 "src-tauri/target/release/bundle/nsis/Levitaire_0.1.6_x64-setup.exe" "release/latest.json" --notes "发布说明"
git add latest.json && git commit -m "chore: 更新在线升级清单至 v0.1.6" && git push
```

- 仅同步版本号不打包：`npm run release:bump 0.2.0`；不重新出包、只签现有安装包：`node scripts/release.mjs 0.1.6 --no-build`。
- 在线更新从 `https://kegehe.github.io/levitaire/latest.json` 读取（GitHub Pages 源 = `master` 分支根目录），因此**仓库根 `latest.json` 必须提交并推送**；`release/` 为本地生成物，已加入 `.gitignore`。
- 签名私钥与口令保存在本机 `~/.tauri/` 且不入库，**丢失任一个即永久无法再签名更新包**，务必备份。
- 更多细节见[开发指南 · 发布流程](docs/developer-guide.md#发布流程)。

---

## 📖 使用指南

1. **文字工具**：在任意应用选中文字 → 工具栏自动弹出 → 复制、搜索、翻译、AI 优化、转换、二维码等
2. **截图与录屏**：悬浮球 → 屏幕截图 / GIF·录屏，拖框选区后可复制、保存、OCR 或钉桌面
3. **快速输入**：在任意应用按下触发键（默认 CapsLock）→ 唤起转盘，鼠标选词即输入
4. **悬浮球与设置**：悬浮球展开工具面板，唤起系统监控、时间工具、待办、便利贴等；设置页可配置全局热键、AI 参数，并独立启用 / 停用每个工具

### AI 配置

在「设置 → AI 配置 → API 类型」中选择格式，并填写 API Key、Base URL 与 Model：

| 类型 | Base URL | Model 示例 | 认证 |
|------|----------|-----------|------|
| **Anthropic**（默认） | `https://api.anthropic.com` | `claude-sonnet-5` | `x-api-key` |
| **OpenAI 兼容** | 如 `https://api.deepseek.com`、`https://dashscope.aliyuncs.com/compatible-mode` | `deepseek-chat`、`qwen-plus` | `Authorization: Bearer` |

API Key 使用 Windows DPAPI 加密存储于 `%APPDATA%/levitaire/config.json`。

---

## 🛠️ 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 后端 | Rust + windows-rs | 全局钩子、GDI 截屏、WinRT OCR / TTS、PDH 性能计数、DPAPI 加密 |
| 深度学习 | ONNX Runtime | PaddleOCR 本地推理引擎（可选，缺少 DLL / 模型时自动回退 Windows OCR） |
| 前端 | React 18 + TypeScript + Vite | 工具栏 UI、悬浮球、设置页 |
| 框架 | Tauri 2.x | 前后端桥接、多窗口管理、托盘图标 |
| 编码 | ffmpeg | MP4 视频编码 |
| 构建 | Cargo + npm + Vitest | 依赖管理、构建与单元测试 |

---

## 🤝 贡献

欢迎提交 Issue 与 Pull Request。提交前请确保通过：

```bash
npm run typecheck    # TypeScript 类型检查
npm run lint         # ESLint 检查
npm run test         # 前端单元测试（Vitest）
npm run format:check # Prettier 格式检查
cargo test --manifest-path src-tauri/Cargo.toml   # 后端单元测试
```

- CI（`.github/workflows/ci.yml`）会在 push 与 PR 时自动跑 typecheck / lint / Vitest / cargo clippy / cargo test。
- **新增工具**：在 `src/tools/<tool>/` 实现组件，并在 `src/tools/registry.ts` 的 `FLOATING_TOOLS` 中登记；若该工具有后端启停开关，还需在 `BACKEND_TOOLS` 中登记一对 `<get|set>_<id>_enabled` 命令（`registry.test.ts` 有守卫测试兜底，漏登记不会报错但开关会失效）。

---

## 📚 文档

- [快速开始](docs/quick-start.md)
- [开发指南](docs/developer-guide.md) — 项目结构、核心模块、工具开发、测试、发布
- [架构设计](docs/architecture-design.md)
- [发布说明](docs/releases/)

---

## 📄 许可证

[MIT License](LICENSE) © 2026 Levitaire
