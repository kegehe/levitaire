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
   - 版本要求: 1.89+（下限由 `tauri-plugin-notification` → `notify-rust 4.18` 决定；`ort` 为 1.88），使用 MSVC 工具链

2. **Node.js**
   - 版本要求: 20.19+ 或 22.12+
   - 用于前端开发和构建

3. **Visual Studio Build Tools**
   - 需要安装 C++ 构建工具
   - 下载地址: https://visualstudio.microsoft.com/visual-cpp-build-tools/

> 无需单独安装 Tauri CLI：`npm install` 已包含 `@tauri-apps/cli`，统一走 `npm run tauri`。

### 可选工具

- **VS Code** + Rust Analyzer 插件
- **RustRover** IDE
- **Windows SDK**: 用于调试 Windows API

### 环境配置

1. 克隆项目
```bash
git clone https://github.com/kegehe/levitaire.git
cd levitaire
```

2. 安装前端依赖
```bash
npm install
```

3. 运行开发模式
```bash
npm run tauri dev
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
│   │   ├── window_pin.rs               # 窗口置顶（含「我改过哪些窗口」清单与退出还原）
│   │   ├── recording/                  # GIF / MP4 录制、窗口检测
│   │   ├── ocr/                        # OcrService：Windows OCR + PaddleOCR
│   │   ├── tts/  sound/                # 语音合成 / 提示音
│   │   ├── monitor/  pomodoro/         # 系统监控 / 番茄钟计时状态（时间工具的页签）
│   │   ├── timer/  todo/  sticky_note/ # 倒计时与秒表 / 待办 / 便利贴
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
│   │   ├── timer/ system-monitor/ todo/ sticky-note/
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
- `BACKEND_TOOLS`：工具 id → 后端启停命令（getter/setter）的映射

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

再到 `BACKEND_TOOLS` 登记 `{ id, getter, setter }`（后端配一套
`get_<tool>_enabled` / `set_<tool>_enabled` 命令与 `xxx_enabled` 配置字段），
用于与 `config.json` 中的真值双向同步。

**每个悬浮工具都必须登记**：漏登记不会报任何错，但该工具的开关会退化成「只改前端状态」
——既不持久化，也不会在禁用时收起已打开的窗口，于是 palette 的「全部关闭」关不掉它。
`registry.test.ts` 里有守卫用例守住这个契约。

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
   便签侧已有源码级守卫 `commands/sticky.rs::window_building_commands_stay_async` 自动拦住
   这条：它按顶层 `pub [async] fn` 切出函数体、剥掉整行注释后匹配 `show_note_window(` /
   `ensure_note_window(` / `restore_pinned_notes_inner(` / `WebviewWindowBuilder`，命中即要求该
   命令是 `async`；另外反向断言「4 个已知建窗命令必须被扫到」且「生产区每个 `#[tauri::command]`
   都能解析出一条顶层 `pub fn`」——防止声明写法一变（属性与签名写在同一行）就静默漏扫。
   给别的模块加同类守卫可以直接照抄。
3. **在线更新是「静默下载 + 就绪提示」，全部走后端命令**（`src-tauri/src/updater/`）：
   - 前端唯一入口是后端四条命令 + 一条事件：`get_update_status`（挂载/打开菜单时读快照）、
     `check_for_updates`（「检查更新」，发现新版本会**接着在后台静默下载**）、
     `install_update`（安装已下好的本地包）、`dismiss_update`（提示窗「稍后」）、
     事件 `update-status`（全量状态快照，替代旧的 `update-available` + `update-progress`）。
     **不要用 JS 插件的 `check()` / `update.downloadAndInstall()`**：那条路径只暴露整体
     timeout，给 96MB 安装包设整体超时会误杀慢速链路；后端是在 `configure_client` 里注入
     **连接超时 + 读空闲超时**才兜住的。有源码级守卫盯着（`useUpdater.test.ts` 的
     「更新入口必须统一走后端命令」，覆盖设置页 / 提示窗 / 悬浮球托盘菜单三个入口）。
   - 检测到新版本**不弹窗**，后台下载完成、验签、落盘之后才 `show_update_prompt`；
     所以提示窗里没有进度条。守卫 `update_prompt_only_shows_after_download_finishes`
     把提示窗调用钉在 `finish_download(` 之后。
   - 提示窗只在 `ready` 与 `failed` 两个阶段渲染内容：`idle` / `downloading` 渲染 null
     并 `hide()`（否则窗口被后端 show 出来后就是一个空透明层，挡住下面所有点击）。
     `failed` **有意留着窗口**显示失败原因 —— 用户刚在本窗点了「立即更新」，让窗一闪而过
     等于什么都没说；卡片本身不透明，不存在遮挡问题。回归用例见
     `src/components/UpdatePrompt.test.tsx`。
   - `install_update` **不得再下载**（守卫 `install_path_never_downloads`）：它只做
     「读缓存包 → 复核签名 → `update.install()`」。这是「断网也能装」和「点击立刻开始装」
     （旧实现要重新 `check()` + 重新下载 96MB）的前提。
   - 缓存在 `%APPDATA%/levitaire/updates/pending-<版本>.exe`，先写 `.part` 再 rename，
     所以文件名一旦出现就是完整文件；**跨重启复用**（重启后检测到同一版本 + 缓存存在 →
     直接进就绪态，不再下一遍）。安装前还要用官方签名复核一次 —— 插件公开的 `install()`
     **不验签**（校验写死在 `download` 里），拆成两个时间点后必须自己补。
   - `on_chunk` 的首参是**本次分块长度**，不是累计值，进度必须累加；
     且只在跨过一个「上报刻度」时才 emit（`DownloadProgress::push_reportable`：总量已知按整数
     百分比、未知按 MiB），否则 96MB 的包会打出约 6000 次 IPC。
   - 「开始下载」的**判定与置位必须在同一把锁内**（`UpdaterState::try_begin_download`）：
     周期检查与手动检查是两条并发路径，先判断后置位会让两条路径同时下 96MB。
   - 托盘菜单只读本地快照（`get_update_status`），**不再每次右键都联网检查**；要现场确认
     得用户点「检查更新」。这是有意的：检测节奏归后端（启动 +5s、之后每 24h），
     菜单只负责显示，免得右键频率变成网络请求频率。
   - `tauri.conf.json` 的 `plugins.updater.windows.installMode` 决定安装器界面：
     本项目用 `passive`（只有进度条、无需交互、装完自动重启）；想彻底无界面改成 `quiet`
     即可（`basic` 会弹出需要人点的向导，不适合一键更新）。
4. **错误处理**：命令返回 `Result<T, String>`，错误信息用中文，前端可直接展示
5. **勿阻塞钩子**：不要在低级钩子回调里做耗时操作，否则会拖慢系统输入
6. **状态管理**：新状态优先放进 Tauri `State`，避免继续新增模块级 `static`
7. **配置读写**：新增配置项走 `config::ConfigManager`，它保证原子写入（临时文件 + rename）
8. **提交前自检**：`npm run typecheck && npm run lint && npm run test`，以及 `cargo test --manifest-path src-tauri/Cargo.toml`
9. **浮窗的逻辑宽度有系统下限（约 136）**：Windows 对「带标题栏样式」的窗口强制最小宽度
   `SM_CXMINTRACK`（150% 缩放下 = 202 物理 px = 134.67 逻辑 px），`CreateWindowEx` 与
   `SetWindowPos` 都会夹——**`setSize` 也设不回去**。tao 的 `decorations: false` 并不是去掉
   `WS_CAPTION`，而是保留它再用 `WM_NCCALCSIZE` 把边框隐掉，所以本项目的浮窗都吃这条限制。
   实测：orb 配置写 96×96，运行时实际是 **135×96**。三个直接后果都已在代码里处理：
   - 球外那圈约 39.5px 的透明留白会吞掉落在其上的点击（压在下面的便签顶栏/面板/桌面图标全点不动）
     → 后端鼠标钩子按圆形热区**直接**切换 orb 窗口的 `set_ignore_cursor_events`
     （球外穿透、球内恢复），见 `hooks/mouse.rs` 的 `OrbZone` 分支。**不要改成「emit 给前端、
     由前端切」**：多一个 emit→IPC→invoke 往返，而这段延迟正好落在「鼠标移进球体 → 恢复交互」
     之间，快点击会整下漏掉；源码级哨兵 `orb_zone_arm_toggles_cursor_events_directly` 盯着这点。
     项目里其他 `set_ignore_cursor_events` 用法（截图/录制/长截图遮罩）同样都在 Rust 侧。
   - 穿透靠 tao 的 `WS_EX_TRANSPARENT | WS_EX_LAYERED`（按 flags 整体重建样式时加的）。
     实测：**窗口不会因此变黑/消失**（tao 不调 `SetLayeredWindowAttributes` 也正常显示），
     摘掉后 exstyle 完全可逆。热区极性在 `mouse.rs` 的 `orb_ignore_cursor_events` 里，有单测钉住。
   - 窗口位置是**记忆恢复**的，可能正好出现在光标下方；这时没有任何鼠标移动可依赖，
     所以 `set_orb_visible(true)` 会先无条件恢复可交互（fail-open）再按当前光标位置修正 —— 
     否则那一击会穿透到下面的窗口（可能误触便签的删除按钮之类）。
   - **别用窗口宽度换算与球体相关的半径**（宽度被拉宽 1.4 倍，热区跟着放大）：用窗口**高度**，
     它不受该限制。`mouse.rs` 有源码级哨兵盯着这点。
   新增浮窗时逻辑宽度别低于 ~136，否则会被静默拉宽，按精确尺寸算出的位置/几何会跟着偏。
10. **面板窗口的高度要随内容走（别写死）**：固定高度在内容少时就是一大片空白 —— 空状态
   还会被 flex 居中把按钮推到窗口正中。做法见 `StickyNoteManager.tsx` / `UtilityHub.tsx`：
   量面板实测高度 + 上下投影留白，用 `getCurrentWebviewWindow().setSize(new LogicalSize(w, h))`
   下发（**必须 `LogicalSize`**：量到的是 CSS px，150% 缩放下物理尺寸是它的 1.5 倍，
   传 `PhysicalSize` 会整体放大），并用 `ResizeObserver` 跟随内容（尺寸去重，避免反复重排）。
   四条硬约束：
   - **别在 Rust 的显示命令里写死尺寸**：`show_*` 里调 `set_size(...)` 会把前端刚算好的高度
     在显示瞬间打回固定值（`commands/sticky.rs` 曾经如此）。窗口只隐藏不销毁，尺寸一直有效。
   - **被测量的元素不能撑满窗口**（`height: 100%` / `100vh`）：那样量到的就是窗口高度，形成
     「越测越大」的反馈环。长列表用 `max-height` + `overflow-y: auto` 收口。
   - **加载态先不量**（那时内容只有一行「加载中…」），否则开窗时能看见「压窄再弹回」两次跳变；
     建窗时的初始高度取内容量级附近的占位值即可。
   - 「隐藏态量不到布局」这条不用担心：工具窗都是 `visible: false` 建出来的，WebView2 照常布局
     （`getBoundingClientRect()` 会强制一次 layout），`UtilityHub` 一直是这个用法。
11. **剪贴板「写—读—回滚」必须带序号守卫，回滚绝不能无条件执行**：选区检测（模拟 Ctrl+C 读回选中
    文字）与替换文本（写新文本 + Ctrl+V）都是「先备份剪贴板、用完再写回」。这条链路上**执行回滚前
    必须确认剪贴板里还是自己写进去的那份内容**（`GetClipboardSequenceNumber()` 与内容**同一次
    Open/Close 内**成对读取，再在回滚前比对），否则会覆盖用户自己在这期间按下的 Ctrl+C / Ctrl+X：
    用户报的「选中文字弹出工具栏后 Ctrl+C / Ctrl+X 失效」就是它 —— `wait_for_clipboard_text_changed`
    在目标程序不响应注入按键时要展满 500ms 才返回，而「选中 → 立刻 Ctrl+C」常常就落在这半秒里；
    剪切更严重（文本已从文档删除、剪贴板又被回滚，内容直接丢失）。
    - 实现：`automation/clipboard_selection.rs` 的 `should_restore_clipboard`（纯函数，四种情形有单测）
      + `restore_clipboard_after_check`（唯一的回滚入口）。检测路径**没有观察到自己的复制落地
      （等待超时）就一律不回滚**——此时剪贴板里的内容不是我们的。快速输入转盘的粘贴路径早就是这条
      约定（`quick_input.rs` 的 `write_sequence`）。
    - 两条源码级哨兵盯着：`selection_check_never_restores_the_clipboard_unconditionally`（回滚必须
      走守卫、不得出现裸 `restore_clipboard_text(`）、`clipboard_text_and_sequence_are_read_under_one_lock`
      （文本与序号必须同锁采样，否则判断有窗口）。都给过变异验证。
    - 反过来，工具栏**已经开着**时按 Ctrl+C 不要重新弹/搬家/重置它：那是用户自己在复制，不是要换一套
      工具（旧行为会 emit `selection-found`，把窗口搬到光标处并重置前端状态，正在看的二维码预览被顶掉、
      之后点外部还关不掉）。极性在 `hooks/keyboard.rs` 的 `should_present_toolbar_at_cursor` 里，有单测。
12. **窗口实例必须 memo / ref 取一次，别写在渲染体里**：`getCurrentWebviewWindow()` 每次调用都返回
    **新对象**（`@tauri-apps/api/webviewWindow.js` 里是 `new WebviewWindow(label, {skip:true})`）。
    把它写进组件渲染体、又被 effect / `useCallback` 当依赖时，那些 effect 会**每次渲染都重跑**；
    若 effect 内再 `setState(新对象)`（典型是「量内容 → 下发尺寸/状态」），就是**自激渲染循环**。
    截图遮罩窗曾因此实测 **≈700 次 IPC/秒**，而它在应用启动时就会被预加载 ⇒ 常驻空转。
    - 约定：`useMemo(() => getCurrentWebviewWindow(), [])`（范本：`RecordingControls` / `TimerTool` /
      `TodoTool`），或 `useRef(getCurrentWebviewWindow())`（`StickyNote` / `StickyNoteManager`）。
    - 第二道保险：把 IPC 结果写进状态前先比值（见第 16 条的 `applyMonitorWorkArea`），
      对象引用变了但数值没变就不 setState。
    - 守卫：`src/test/windowInstanceGuard.test.ts`（源码级，钉住 15 个窗口组件）+ 行为级
      `src/tools/screenshot/ScreenshotTool.loop.test.tsx`（按时间采样 IPC 次数）。
      扫源码型守卫**必须先剥整行注释再匹配**（该文件里是 `readCode()`）：把调用注释掉（而不是删掉）
      在文本层面看起来「还在」，不剥注释的守卫会被这种变异骗过（实测过）。
    - **测试坑**：写这类 effect 的测试时，mock 若对「量内容」命令返回 `undefined`，状态被置回 `null`
      会让 React bail out，**循环在测试里根本看不见**——mock 必须返回合法对象。
13. **原生文件对话框（rfd）必须 `set_parent`，并在打开期间临时取消自有置顶窗的置顶**：本项目的浮窗
    几乎都是 `alwaysOnTop`，而 rfd 在没有 parent 时给 `IFileDialog::Show` 传的是 **NULL owner**
    （rfd 源码：`parent.unwrap_or(std::ptr::null_mut())`）。实测（Z 序 + 像素采样）：
    - 置顶窗会把**无主**对话框完全盖住，且把它设为前台窗口也**抬不上来** ⇒ 用户点「保存」后
      看不到任何反应（草稿保存、待办导出/导入、钉图保存、长截图保存都踩过）；
    - 仅设 owner 也不够：挡住对话框的可能是**另一扇**前台置顶窗，所以还要临时取消置顶。
    统一走 `commands/mod.rs` 的 `DialogTopmostGuard::suspend(&app, &["<本流程自己的窗 label>"])`
    （`Drop` 时自动恢复置顶）；裸 HWND 窗口（贴图）用 `screenshot/pin.rs::apply_window_topmost`，
    且**恢复置顶前先 `IsWindow` 判定** —— 对话框没有 owner，用户能在它开着时关掉贴图，
    那时 HWND 可能已失效甚至被系统复用。
    守卫：`every_file_dialog_suspends_topmost_first`（扫 5 个文件的全部 rfd 调用点，逐函数体校验，
    并按文件断言调用点数量，防止扫描面失效）。
14. **「是不是自家的窗口」只有一个权威实现：`commands::is_own_window`** —— 它必须同时覆盖三类，
    缺一类都会漏（三类都踩过）：
    ① `OWN_WINDOW_LABELS` 里固定 label 的 webview 窗（前端 `utils/toolWindows.ts` 的
       `ToolWindowLabel` 加一行时 Rust 侧要同步）；
    ② **非 webview 的原生窗**：贴图窗是 `CreateWindowExW` 建的 Win32 窗（类名
       `LevitairePinWindow`），`get_webview_window()` 根本找不到它；
    ③ **动态 label 的 webview 窗**：便利贴是 `sticky-note-<id>`，靠标题前缀 `Levitaire` 兜底
       （与 `recording::window_detect::enumerate_windows` 的排除口径一致）。
    消费方与漏判后果：`DialogTopmostGuard` 不取消置顶（对话框被自家窗挡住）、
    `start_screenshot_inner` 把自家窗当「用户的前台应用」、**滚动导航把自家窗当滚动目标**
    （点一下贴图或便利贴之后，面板每个按钮都静默失效）、录屏「窗口识别」把它当可录目标。
    ⚠️ **不要再在别处抄一份 label 清单**：`scroll_navigation.rs` 曾自带 19 项副本，少了
    `sticky-notes-manager`。守卫：`own_window_detection_is_single_sourced` +
    `own_window_labels_cover_frontend_tool_windows`（解析前端联合类型并逐项断言，同时反向
    断言项数；**解析前必须剥整行注释**，否则注释式变异会假绿）。
15. **悬浮球的球心 = 窗口矩形中心**（不是「左上角 + 球半径」）：窗口一定比球大
    （tauri.conf 的 96×96 里放 `--orb-size` 56 的球），多出来那圈是承载投影的透明留白，
    球由 `#root` 的 flex 居中在窗口里。⚠️ **这个居中是 `FloatingOrb.tsx` 挂载时用内联样式
    写上去的**（`root.style.display = "flex"` + `alignItems/justifyContent = "center"`），
    不在任何 `.css` 文件里 —— 只 grep 样式表会误判成「球贴左上角」（本文件第 15 条曾因此
    写错并让后端判定圆偏了 20~40px，已修）。真实引擎实测（无头 Chrome + 真实三层 CSS +
    那三条内联样式，内容盒取 135×96 与 96×96）：球心与 `#root` 盒中心**逐像素相等**
    （135 宽时球占 x 39.5~95.5、球心 x 67.5 = 盒中心 67.5）。
    再加窗口宽度会被系统最小宽度拉到 ~135 逻辑 px，所以后端只能：
    **球心取 `GetWindowRect` 的中心、半径按窗口*高度* 30/96 换算**（宽度不可作基准）。
    前端 `FloatingOrb.tsx::isPointWithinOrb` 用元素 `getBoundingClientRect()` 的中心，两端同源。
    守卫 `orb_center_is_window_center` + 几何用例 `test_orb_circle_geometry`（后者把
    「左上角 + 球半径」这个错法直接断言成失败，改回去就撞墙）。
16. **窗口尺寸是前端量完内容才下发的，所以每次 `setSize` 之后都要把窗口夹回工作区**：落点由后端
    按光标/选区/记忆位置算，且**只在首次定位**时夹过。贴屏幕右/下沿的窗口在内容变高变宽后
    （日历切视图 320→380、监控切 full、便签加行、面板换页、工具栏弹二维码预览）会有一部分
    跑到工作区外 —— 而这些窗口都是无边框置顶窗、没有滚动条，出屏的部分直接看不到也点不到。
    - 统一调 `utils/panelWindow.ts` 的 `clampWindowToWorkArea(w, h)`；Rust 侧
      `clamp_window_to_workarea` **自注入调用方窗口**，前端不传 label ⇒ 动态 label 的便签天然正确。
    - 豁免（不在此列）：放大后紧跟 `center()` 的（`LongCaptureControls`）、创建时按显示器尺寸设
      全屏遮罩的（`toolWindows.ts`）。
    - 守卫：`windowInstanceGuard.test.ts` 的 `CLAMPED_WINDOW_COMPONENTS`。
17. **同一份数据的 ref + state 双轨，必须收束到唯一写入口**：为挡「IPC 每次返回新对象 → 状态恒变
    → 自激」而加的值比较守卫，读的是 ref；若**别处的重置路径只写 state 不写 ref**，两边就会失同步
    —— 实测形态：会话结束把 state 置 `null` 而 ref 还留着旧值，再次打开遮罩时 IPC 返回同一块屏的
    相同数值被判成「没变」→ state 永远停在 `null`，坐标换算静默退回兜底值。
    约定：写一个 `applyMonitorWorkArea(next)` 同时写两边（内部保留值比较），其余路径一律走它；
    守卫钉「`setMonitorWorkArea(` 只允许出现在该 helper 内」（按**行首**匹配，避免命中注释）。
18. **「启用的 ID 列表」这类配置，空数组不等于"没设置过"**：后端 `clear_options` /
    `toolbar_features` 存的是**启用**项，而空数组同时能表达「从没设置过」（应回退默认全量）和
    「用户把每一项都关掉了」（应保持为空）。老实现一律按前者处理 ⇒ **「全部取消勾选」存不住**，
    重开又全选回来（与「老配置里的 `pomodoro` 自启项关不掉」同类）。约定：清空时存
    `[NONE_SELECTED_SENTINEL]`（见 `src/constants/selectionPersistence.ts`），读取先认哨兵、
    再走「未知 ID → 重置默认」那条判断。**新增这类"可全禁"的列表配置一律复用该模块**，别各造一套。
19. **程序性移动窗口必须挂 `position_save_suppress`**：前端 `persistWindowPositionOnMove` 监听
    `onMoved`（**程序性移动同样触发**），300ms 后写回位置记忆。`clamp_window_to_workarea` 把贴边窗口
    挤回工作区后，那个被挤过的位置会被永久记住（内容缩回也不回落，几次就成位置漂移）；
    `reset_window_position` 早就为此挂了 1500ms 抑制，夹取这条路径同样要挂。
    守卫：`commands::tests::clamp_window_suppresses_position_memory_writeback`。
20. **同一动作的跨窗口并发，只能由后端裁决**：前端三个入口（提示窗 / 设置页 / 托盘菜单）的按钮守卫
    都是**各窗口局部**状态，挡不住「点完提示窗立刻右键托盘再点一次」。下载用 `try_begin_download`、
    安装用 `try_begin_install`（判定与置位同一条 `compare_exchange`）。
    ⚠️ 安装权有个额外要求：**拿到权之后失败路径必须且只能有一个释放点**（成功路径靠 `install()` 后的
    `exit(0)` 自然消失）—— 多一处 `?` 或新的 `return Err` 就会绕过释放、让「安装权卡死 = 永远装不上」。
    守卫：`updater::tests::install_failure_paths_release_the_install_token`（把流程收口成
    `match prepare_and_install(...)` 一处，`install_update` 里除收口外不得再出现 `?` / `return Err`）。
21. **`index.html` 的首帧主题脚本必须自己解析 `system`**：CSS 只有 `[data-theme="dark"]` 一档覆盖，
    把 localStorage 原值（可能是 `system`）直接写进 `data-theme` 会落到 `:root` 的浅色默认值 ——
    「跟随系统」+ 系统深色时会先闪一帧浅色（React 挂载后才纠正）。解析口径与
    `themePreferences.ts::resolveThemeMode` 保持一致。守卫：`themePreferences.test.ts` 里
    **把那段脚本原样取出来执行**再断言 `data-theme`（不是断言字符串）。
22. **窗口的可见性 / 开合状态一律看原生真值，不要信前端缓存**：截图、长截图、激活工具等流程会
    **不经前端**直接 `window.hide()`（`commands/mod.rs`、`commands/long_capture.rs`、
    `commands/tools.rs`），任何缓存在前端的「我是打开的」都会因此过期 —— 拿它做判断会让下一次
    点击落空（实测形态：面板开着时按了截图热键，再点悬浮球"没反应"，第二次才生效）。
    约定：开合决策由**窗口自己**用 `WebviewWindow.isVisible()` 裁决，再走既有的 show / hide
    唯一路径；跨窗口只传「意图」，不传「状态」。用例见 `ToolPalette.test.tsx`
    （原生可见 → 收起；原生已隐藏 → 打开），悬浮球侧只负责区分「面板还没被创建过」。
23. **便利贴的可拖拽尺寸与「自动高度」互斥，且要能区分 resize 事件是谁引起的**（`StickyNote.tsx`）：
    - 尺寸语义：`notes.json` 里 `width` / `height` **0 = 自动**（宽 264、高随内容），> 0 = 用户拖出来的
      固定尺寸。前端 `scheduleResize()` 在手动模式下**直接 return** —— 不拦的话，用户刚拖好的窗口会
      被下一次「量内容」打回原形。回自动只能靠 `reset_sticky_note_size`（双击右下角纸角）。
    - **`onResized` 分不清「用户拖」与「前端量完内容 setSize」**，两者一模一样：自动高度每次内容变高
      都会 setSize，不排除这个回声，用户多打两行字就永久切进手动尺寸。做法同第 19 条的
      `position_save_suppress`：自己 setSize 前打一个 400ms 抑制窗口（`PROGRAMMATIC_RESIZE_*`）。
    - **尺寸从 `onResized` 的 payload 里拿**（Tauri 的 `WindowEvent::Resized` 带的就是新物理尺寸），
      不要回读 `innerSize()`：回读是每个 resize 事件两次 IPC（拖拽时 ~60 次/秒），而且异步结果可能
      乱序 —— 后发的读先返回，中间尺寸就被当成最终尺寸落盘。物理→逻辑的 scale 换算推迟到**防抖
      回调**里做一次（scale 只在换显示器缩放时才变），挂载时读一次缓存进 `scaleRef` 供事件线程用。
    - **后端 `show_note_window` 只允许给「手动尺寸」的便签 `set_size`**。窗口是只隐藏不销毁的：
      「收起（含 Alt+F4）→ 唤出」时页面还活着，后端这次程序性缩放会被前端当成「用户拖过窗口边」，
      ⇒ 永久切手动模式并把回落值（264×180）落盘，而自动高度的高度本来就是前端量内容下发的、
      被压回 180 后不会再纠偏，高便签只剩顶上一条。自动尺寸时不要碰尺寸，让前端自己量。
    - 除了 400ms 抑制窗口，还有一道**几何**判据 `isAutoSizeEcho(logicalW, logicalH, expectedHeight)`：
      逻辑尺寸等于自动模式的目标（宽 = `NOTE_WIDTH`、高 = 上次量到的高度，容差 1px）就说明这次变化
      不是用户拖的。它兜住两件抑制窗口兜不住的事：迟到的回声、以及**把便签拖到另一台缩放不同的
      显示器**（系统按新缩放重排窗口：物理尺寸变了、逻辑尺寸没变，只看物理值根本分不出来）。
      纯函数，用例直接钉（`StickyNote.test.tsx`）。
    - **模式位与尺寸数值要分开**：`manualMode`（state 驱动 `data-manual`）+ `manualModeRef`
      （立即生效，给定时器/原生回调读）。尺寸数值**不进 state** —— 手动模式的布局靠 `height: 100%`
      跟着窗口走，把数值放进 state 会让每个 resize 事件都重渲染一遍组件。
    - 手柄走 `startResizeDragging("SouthEast")`（需要窗口 `resizable(true)` + `min_inner_size` +
      capabilities 的 `core:window:allow-start-resize-dragging`）。**「窗口四边也能拖」这件事没有
      源码依据**：tao 的 `RESIZABLE` 会带 WS_SIZEBOX（= WS_THICKFRAME），但无边框窗在 `WM_NCCALCSIZE`
      里把整个窗口算作客户区（tao-0.35 `platform_impl/windows/window.rs` 的 undecorated 分支
      `return LRESULT(0)`）—— 四边的隐形命中区是否仍生效只能在真机上确认。所以手柄是唯一确定的
      入口，提示文案与文档都别把「拖窗口边缘」写成可用功能（失败提示指向「双击纸角回自动高度」）。
      手柄上还叠了「双击回自动高度」，所以 mousedown 要放掉
      `event.detail > 1`（否则第二下又开一次缩放模态循环，dblclick 可能收不到）。
    - 手动模式下 `.sn-window` 才能 `height: 100%`（自动模式的窗口高是**量出来的**，写 100% 会互相追逐，
      同第 10 条的四条硬约束），且 `.sn-editor` 的 `min-height` 要归零（96px 会把卡片内容顶出
      `overflow: hidden` 的卡片，footer 与纸角手柄一起被裁掉）。
    - 自动模式下 `.sn-window` 的宽度**钉死 264**（手动模式才 `width: 100%`）：量高度必须与窗口
      当时的宽度无关，否则从较宽的手动尺寸双击回自动高度时，那一刻量出的高度是按宽布局算的，
      宽度切回 264 后文字换行更多、底部（footer 与纸角手柄）被裁在窗口外，用户不打个字就永远纠不回来。
      这条在 CSS 里（`StickyNote.css` 的 `.sn-window`），与 `constants.ts::NOTE_WIDTH` 同值。
    - **改变卡片高度的任何 UI 状态都要重新量一次**：提示条（`.sn-notice`）插在 header 与正文之间，
      出现时会把 footer 与纸角手柄一起往下推 ~30px，消失时又推回去 —— 只在 `onInput` / 图片 `load`
      量高的话，用户刚触发的提示会自己把「新建 / 删除 / 改大小」三个入口顶出窗口。见 `notice` 的 effect。
    - 「往后别再漏夹」这类守卫靠**数量对齐**：`windowInstanceGuard.test.ts` 按文件比对
      `setSize(` 与 `clampWindowToWorkArea(` 的出现次数。新增 clamp 调用点要么走同一个 helper
      （`clampToWorkArea`），要么就得同步调整那个守卫并说明理由。
24. **浏览器原生光标的高度不受我们控制 ⇒ 图片行要自己画光标**：Chromium 的光标高度跟**字体度量**
    走（实测 14px 字号恒定 18px 高，把图片设成 `inline-block` / 加大 `line-height` 都不管用），而且
    图片后面紧跟换行时光标会被画到**下一行行首**。所以「光标高度 = 图片高度」只能自绘：
    `StickyNote.tsx::syncImageCaret` 在 `.sn-editor-wrap`（无内边距的定位锚）里摆一根 2px 竖条。
    - 几何单独抽成纯函数 `caretBarGeometry(imgRect, wrapRect)`，**不要在组件里就地算**：
      这类坐标一旦错就是「条飘到别处」，而 happy-dom 的 `getBoundingClientRect()` 恒为 0，
      只有当纯函数能在用例里钉（`StickyNote.test.tsx` 里的第一组数字直接取自预览页真实量到的值）。
    - 收起时机有两类，其中**窗口失焦不能只看 DOM 焦点**：WebView2 在窗口失去激活时**不会**把
      `document.activeElement` 从正文上摘掉，只判断 `editor.contains(activeElement)` 的话这根自绘的条
      会一直留着（而浏览器已经不画原生光标了，看着就是一根卡住的残影）⇒ 另记一位 `windowFocusedRef`
      （`window` 的 blur/focus 各更新一次）。
    - 两条踩过的口径：**左边界取图片右缘 +3px（外侧）**，贴内侧时满宽截图会正好压在图片自己的边框上
      （看起来像「图片右边框变粗了」）；**不要补 `scrollTop`** —— 这根条挂在**不滚动**的
      `.sn-editor-wrap` 上（滚动的是里面的 `.sn-editor`），补了正文一滚动整根条就整体偏移。
    - 高度取「图片 ∩ 可视区」那一段，完全不可见时收起：否则图片被滚出视口后这根条会画到编辑器外面，
      压在卡片顶栏上。
    - 图片本身必须是 `display: inline-block` 且**不要** `user-select: none`：前者让行盒高度跟着图片撑起来
      （框选高亮能整块盖住图片），后者会让框选直接跳过图片（想复制一张图必须先精确框住它）。
    - `cursor` 相关的浏览器行为不能靠推导，用真实渲染验证：`.workbuddy/design/sticky-note-resize/`
      下的预览页 + 出图脚本会打印光标条的内联定位（实测 `left: 211px; top: 23px; height: 116px`）。
    - **手抄的预览页会抄漏规则 ⇒ 还有一条「真组件 + 真 CSS」的核对路径**（两者的图互为印证）：
      `src/tools/sticky-note/__real_dom__.test.tsx` 把真组件渲染出的 DOM 导出、拼上
      `global.css` / `tokens.css` / `StickyNote.css` 的**原文**生成核对板，并打印每个状态的
      `offsetWidth/offsetHeight` 硬数字；`.workbuddy/design/sticky-note-resize/buildRealDom.mjs`
      出图并核对（自动模式宽度必须 264、手动/失败态卡片必须撑满、卡片不能比窗口高）。
      实测数字可作参照：空便签 264×210、提示条出现后 264×258（**差 48px**，这就是「提示条要
      重新量窗口高」的量化依据）、手动态卡片 328×262 = 窗口减上下内边距 38。
      跑法（默认跳过，因为它会往 `.workbuddy` 写文件）：
      `LEVITAIRE_REAL_DOM=1 npx vitest run src/tools/sticky-note/__real_dom__.test.tsx` →
      `node .workbuddy/design/sticky-note-resize/buildRealDom.mjs`。
      ⚠️ 量尺寸别挂 `requestAnimationFrame`：无头 Chrome + `--virtual-time-budget` 下 `dump-dom`
      实测拿不到回报，用 `load → setTimeout(0)` + 一个兜底定时器。
25. **右键接管的唯一入口是 `setContextMenuInterceptor`**：通用文本菜单在「没有选区」时
    「复制」是灰的，而图片本来就选不中 —— 便利贴的图片右键因此改成「复制图片 / 删除图片」
    （`showAppMenu` 复用同一套浮层样式与边缘夹取）。拦截器只有一份、按窗口注册，组件卸载时清掉；
    **返回 `false` 才是「交回通用菜单」**，所以拦截器里只判断自己认识的目标，其余一律放行。
    守卫：`StickyNote.test.tsx` 同时钉「图片上是图片菜单」与「图片以外仍是 剪切/复制/粘贴/全选」。
26. **便利贴图片目录只允许一种格式（PNG），来源格式白名单受 `image` crate 特性约束**：
    `sticky_note::save_image` 会把非 PNG 来源（JPG / GIF / BMP）解码后重新编码成 PNG 落盘，
    好处是「复制到剪贴板」（`clipboard::copy_image` 只认 PNG）与令牌解析都只有一条路径；
    代价是 GIF 动画丢失。`IMAGE_SOURCE_EXTS` 与 `Cargo.toml` 里 `image` 的 features
    （png/gif/jpeg/bmp）必须同步 —— 把 WebP 加进白名单前得先给 image 加 `webp` 特性。
    同一份清单在**三处**：前端 `constants.ts::IMG_REL_PATTERN`（水合时决定令牌是否还原成
    图片）、后端 `IMAGE_SOURCE_EXTS`（落盘白名单）与 `is_generated_image_file`（挡越界路径）。
    只改前端就会出现「渲染成图片、但复制/删除命令被 `validated_image_rel` 拒绝」的两套口径。
    - ⚠️ **格式判定一律按字节内容（`with_guessed_format`），不看调用方给的扩展名 / MIME**：
      剪贴板里的图片项 MIME 与真实字节并不总一致 —— 从资源管理器复制一张 .jpg 再粘贴，剪贴板给的是
      `image/jpeg`，照扩展名写就会把 JPEG 字节塞进 `img_*.png`（页面靠嗅探还能显示，
      「复制到剪贴板」却必然解码失败）。统一走 `ensure_png()`，写盘与进剪贴板两条路共用；
      用例 `ensure_png_normalizes_by_content_not_by_name` 钉住「GIF 字节必须被转成真 PNG」。
    - 前端粘接管道的 MIME 白名单（`PASTABLE_IMAGE_TYPES`）只放行**能落盘**的位图类型；但**落不下来的
      图片类型也要接管**（`image/svg+xml`、未开 webp 特性的 webp）：放给浏览器默认行为，它会插一张靠
      `blob:` / `data:` 的 `<img>`，而 `serializeEditorText` 只认 `data-note-img` ⇒ 用户在正文里
      **看不到任何令牌**：图看着贴进来了、重新打开便签却没有，比「什么都不发生」更糟。
      接管时自己把随图文字补回去（`clipboardData.getData("text/plain")`），再用 `showNotice`
      说明格式不被支持。用例 `StickyNote.test.tsx` 的「不支持的图片格式」条钉住这三点。
    - 拖入 / 粘贴图片前先要 `ensureEditorReady()`：读取中 / 读取失败态下正文还没挂载，命令却已经把
      文件写进图片目录了 —— 插不进去的那张图从此是孤儿文件（要等整张便签删除才清），用户还以为是
      贴成功了。**拦在发命令之前**，别拦在插入时。
    - 短暂提示条（`.sn-notice`）必须在**所有**渲染分支都渲染：只放在主分支的话，读取失败态里的
      图片导入失败 / 格式不支持 / 正文没准备好这些提示会全部静音（`noticeBar` 变量）。
    - ⚠️ 正文令牌里的相对路径是**不可信输入**：`validated_image_rel` 逐段校验
      （目录段 == 清洗后的 note id、文件名严格匹配 `img_<数字>_<数字>.<白名单扩展名>`），
      否则「删除图片」就是一个任意文件删除洞（用例 `validated_image_rel_only_accepts_own_filenames`
      列了 12 种越界写法）。
    - 尺寸上限（`NOTE_MAX_*` = 10000）**只是脏数据的理智边界**，别压低：大屏用户合法拖得到的尺寸
      一旦被后端改小，前端存进去的值与落盘值就不一致，下次开窗会静默回缩。

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
cargo test --manifest-path src-tauri/Cargo.toml

# 只跑名字含 redact_url 的测试
cargo test --manifest-path src-tauri/Cargo.toml redact_url

# 前端全部测试（Vitest）
npm run test

# 前端类型检查 + Lint
npm run typecheck && npm run lint
```

### 调试技巧

1. **日志输出**: 使用内置 `crate::utils::logger::log(tag, msg)`，写入 `%APPDATA%\Levitaire\levitaire.log`（超过 5 MB 轮转为 `levitaire.log.1`）
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

> `package-lock.json` 的 root version 不在脚本同步范围内；发版后执行一次
> `npm install --package-lock-only` 可让它与产品版本保持一致（不影响构建）。

### 2. 构建发布版本

发版前需先补齐两个不入库的二进制资源（见 README「可选二进制资源」）：
`src-tauri/binaries/ffmpeg.exe` 与 `src-tauri/libs/onnxruntime.dll`。
其中 ffmpeg 为**精简构建**（约 4 MB，官方 full build 的 1/57），可用
`./scripts/build-ffmpeg-lite.sh --install` 从源码重建（含组件清单与验证步骤）。

```bash
# 一条命令：升版本号 → 打包(--bundles nsis, 含发版叠加配置) → 签名 → 生成 latest.json
npm run release 0.1.8 "修复了…；新增了…"

# 多行说明（推荐）：UTF-8 文件，避免 shell 转义 / PowerShell 下 npm 传中文乱码
node scripts/release.mjs 0.1.8 --notes-file release-notes.txt

# 仅想手动出包不发版
npm run tauri build -- --bundles nsis --config src-tauri/tauri.bundle.conf.json
```

构建完成后，安装包位于 `src-tauri/target/release/bundle/nsis/`。

> 多行说明用 `--notes-file`；PowerShell 5.1 下用 `npm run` 传中文参数可能被 cmd.exe 转码，建议 Git Bash 或直接 `node scripts/release.mjs`。

### 3. 上传与升级清单

```bash
git tag v0.1.8 && git push origin v0.1.8
gh release create v0.1.8 \
  "src-tauri/target/release/bundle/nsis/Levitaire_0.1.8_x64-setup.exe" \
  "release/latest.json" --notes "发布说明"

# 在线更新的 endpoint 指向 GitHub Pages 的仓库根 latest.json，必须提交并推送
git add latest.json && git commit -m "chore: 更新在线升级清单至 v0.1.8" && git push
```

> `release/` 是本地生成物（已忽略），但仓库根 `latest.json` 不是：漏推它时
> Pages 仍返回 200 的旧清单，所有已安装客户端都收不到新版本，且不会有任何报错。

### 4. 发布检查清单

- [ ] 所有测试通过（`npm run typecheck && npm run lint && npm run test`，`cargo test --manifest-path src-tauri/Cargo.toml`）
- [ ] 版本号已更新，且三处一致
- [ ] 更新日志已编写：新增 `docs/releases/vX.Y.Z.md` 并更新 `docs/releases/README.md`
- [ ] 打包所需二进制资源已就位（`ffmpeg.exe` / `onnxruntime.dll`）
- [ ] `latest.json` 已生成、签名与本机私钥匹配
- [ ] 在不同 Windows 版本 / 缩放下测试
- [ ] 检查杀毒软件误报
- [ ] tag、GitHub Release、根 `latest.json` 都已推送
- [ ] 用上一版安装包实测一次在线升级
- [ ] 签名私钥与口令已备份（丢失即永久无法再签名更新）

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

- 项目主页: [GitHub](https://github.com/kegehe/levitaire)
- 问题反馈: [Issues](https://github.com/kegehe/levitaire/issues)

---

**最后更新**: 2024 年
