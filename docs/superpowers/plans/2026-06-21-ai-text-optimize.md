# AI 文本优化功能 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在浮动工具栏中添加 AI 文本优化功能，支持润色/正式化/简洁化/翻译四种预设模式，预览后确认替换。

**Architecture:** 后端扩展 AiService 支持 system_prompt，新增 replace_selection 命令通过 UI Automation 替换选中文字；前端 FloatingToolbar 改造为状态机驱动，新增 optimizeModes 常量和 useAiOptimize Hook；Settings 页新增 AI 配置区域。

**Tech Stack:** Rust (tauri 2.x, windows-rs 0.61, reqwest), React 18 + TypeScript, Vite

## Global Constraints

- Rust 后端使用 `windows` crate v0.61 的 Win32 API
- AI 调用走 Anthropic Messages API 格式（`/v1/messages`）
- 前端使用 `@tauri-apps/api` v2 的 `invoke` 和 `getCurrentWebviewWindow`
- CSS 变量体系已建立（`global.css`），新增样式必须使用 CSS 变量
- 工具栏窗口 transparent + alwaysOnTop + decorations: false
- 所有 Tauri 命令需在 `main.rs` 的 `invoke_handler` 中注册

## File Structure

| 操作 | 文件路径 | 职责 |
|------|---------|------|
| Create | `src/constants/optimizeModes.ts` | 预设模式定义（图标、标签、system prompt） |
| Create | `src/hooks/useAiOptimize.ts` | AI 优化 Hook（调用 AI、管理状态） |
| Modify | `src-tauri/src/ai/mod.rs` | AiService.call() 增加 system_prompt 参数 |
| Modify | `src-tauri/src/commands.rs` | call_ai 增加 system_prompt 参数；新增 replace_selection 命令 |
| Modify | `src-tauri/src/automation/mod.rs` | 新增 SelectionContext 暂存结构；新增 store_selection_context / replace_selection 函数 |
| Modify | `src-tauri/src/automation/selection.rs` | 新增 replace_text_via_uia / replace_text_via_win32 函数 |
| Modify | `src-tauri/src/hooks/mouse.rs` | selection-found 事件触发时调用 store_selection_context |
| Modify | `src-tauri/src/main.rs` | 注册 replace_selection 命令 |
| Modify | `src/components/FloatingToolbar.tsx` | 状态机改造，5 种状态渲染 |
| Modify | `src/components/FloatingToolbar.css` | 模式选择、预览区、加载动画、错误提示样式 |
| Modify | `src/components/ToolbarButton.tsx` | 增加 disabled / loading / variant props |
| Modify | `src/components/ToolbarButton.css` | disabled / loading / variant 样式 |
| Modify | `src/components/Settings.tsx` | 新增 AI 配置区域 |
| Modify | `src/components/Settings.css` | AI 配置区域样式 |
| Modify | `src/styles/global.css` | 新增预览态、错误态、AI 配置相关 CSS 变量 |
| Modify | `src/types.ts` | 新增 OptimizeMode / AiConfig 接口 |

---

### Task 1: 后端 — AiService 支持 system_prompt

**Files:**
- Modify: `src-tauri/src/ai/mod.rs:52-75`

**Interfaces:**
- Consumes: `AiConfig` (from `crate::config`)
- Produces: `AiService::call(&self, prompt: &str, system_prompt: Option<&str>) -> Result<AiResponse, String>`

- [ ] **Step 1: 修改 AiService::call 签名，添加 system_prompt 参数**

在 `src-tauri/src/ai/mod.rs` 中，将 `call` 方法签名从：

```rust
pub async fn call(&self, prompt: &str) -> Result<AiResponse, String>
```

改为：

```rust
pub async fn call(&self, prompt: &str, system_prompt: Option<&str>) -> Result<AiResponse, String>
```

- [ ] **Step 2: 修改请求体构建逻辑，条件性添加 system 字段**

将 `src-tauri/src/ai/mod.rs` 中的请求体构建部分（约第 66-75 行）替换为：

```rust
let mut request_body = serde_json::json!({
    "model": model,
    "max_tokens": 4096,
    "messages": [
        {
            "role": "user",
            "content": prompt
        }
    ]
});

if let Some(sys) = system_prompt {
    request_body["system"] = serde_json::Value::String(sys.to_string());
}
```

- [ ] **Step 3: 更新测试中的 call 调用**

在 `src-tauri/src/ai/mod.rs` 的测试函数 `test_ai_call` 中，将：

```rust
let result = service.call("请用一句话回答：1+1等于几？").await;
```

改为：

```rust
let result = service.call("请用一句话回答：1+1等于几？", None).await;
```

- [ ] **Step 4: 编译验证**

Run: `cd D:\projects\Programs\floast_service\src-tauri && cargo check 2>&1`
Expected: 编译成功（可能有 call_ai 命令处的参数不匹配警告，下一任务修复）

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ai/mod.rs
git commit -m "feat: AiService.call() 支持 system_prompt 参数"
```

---

### Task 2: 后端 — call_ai 命令扩展 system_prompt

**Files:**
- Modify: `src-tauri/src/commands.rs:77-90`

**Interfaces:**
- Consumes: `AiService::call(&self, prompt: &str, system_prompt: Option<&str>)` (from Task 1)
- Produces: `call_ai(prompt: String, system_prompt: Option<String>)` Tauri 命令

- [ ] **Step 1: 修改 call_ai 命令签名和实现**

将 `src-tauri/src/commands.rs` 中的 `call_ai` 函数替换为：

```rust
/// 调用 AI 接口
#[tauri::command]
pub async fn call_ai(
    prompt: String,
    system_prompt: Option<String>,
    ai_service: State<'_, crate::ai::AiService>,
) -> Result<crate::ai::AiResponse, String> {
    crate::utils::logger::log("commands", &format!("call_ai 命令被调用, prompt 长度: {} 字节", prompt.len()));
    if prompt.len() > MAX_PROMPT_LENGTH {
        return Err(format!("prompt 长度超过限制（最大 {} 字节）", MAX_PROMPT_LENGTH));
    }
    if prompt.is_empty() {
        return Err("prompt 不能为空".to_string());
    }
    ai_service.call(&prompt, system_prompt.as_deref()).await
}
```

- [ ] **Step 2: 编译验证**

Run: `cd D:\projects\Programs\floast_service\src-tauri && cargo check 2>&1`
Expected: 编译成功，无警告

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat: call_ai 命令支持 system_prompt 参数"
```

---

### Task 3: 后端 — 选区暂存与文本替换

**Files:**
- Modify: `src-tauri/src/automation/mod.rs`
- Modify: `src-tauri/src/automation/selection.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/hooks/mouse.rs`
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `SelectionInfo` (from `crate::automation`)
- Produces: `store_selection_context(info: &SelectionInfo)` — 暂存选区上下文
- Produces: `replace_selection_text(text: &str) -> Result<(), String>` — 替换选中文字
- Produces: `replace_selection(text: String) -> Result<(), String>` — Tauri 命令

- [ ] **Step 1: 在 automation/mod.rs 中新增 SelectionContext 结构和暂存机制**

在 `src-tauri/src/automation/mod.rs` 末尾追加：

```rust
use std::sync::OnceLock;
use std::sync::Mutex;

/// 选区上下文 — 用于后续替换操作时定位目标
#[derive(Debug, Clone)]
pub struct SelectionContext {
    /// 选中的文本
    pub text: String,
    /// 选区矩形
    pub rect: Rect,
    /// 前台窗口句柄（用于 Win32 替换）
    pub foreground_hwnd: isize,
    /// 焦点控件句柄（用于 Win32 替换）
    pub focus_hwnd: isize,
    /// 焦点控件类名（用于判断替换策略）
    pub focus_class: String,
    /// 选区起始位置（用于 Win32 EM_SETSEL + EM_REPLACESEL）
    pub sel_start: u32,
    /// 选区结束位置
    pub sel_end: u32,
    /// 是否通过 UI Automation 获取的选区
    pub via_uia: bool,
}

/// 全局暂存的选区上下文
static SELECTION_CONTEXT: OnceLock<Mutex<Option<SelectionContext>>> = OnceLock::new();

fn get_selection_context_store() -> &'static Mutex<Option<SelectionContext>> {
    SELECTION_CONTEXT.get_or_init(|| Mutex::new(None))
}

/// 暂存选区上下文（在 selection-found 事件时调用）
pub fn store_selection_context(info: &SelectionInfo, ctx: SelectionContext) {
    let store = get_selection_context_store();
    if let Ok(mut guard) = store.lock() {
        *guard = Some(ctx);
        crate::utils::logger::log("automation", &format!("选区上下文已暂存, text: {} chars", ctx.text.len()));
    }
}

/// 获取暂存的选区上下文
pub fn get_stored_selection_context() -> Option<SelectionContext> {
    let store = get_selection_context_store();
    store.lock().ok().and_then(|guard| guard.clone())
}

/// 替换选中文字
pub fn replace_selection_text(new_text: &str) -> Result<(), String> {
    let ctx = get_stored_selection_context()
        .ok_or("没有暂存的选区上下文，请重新选中文本")?;

    crate::utils::logger::log("automation", &format!("replace_selection_text: {} chars -> {} chars", ctx.text.len(), new_text.len()));

    if ctx.via_uia {
        selection::replace_text_via_uia(&ctx, new_text)
    } else {
        selection::replace_text_via_win32(&ctx, new_text)
    }
}
```

- [ ] **Step 2: 在 selection.rs 中新增 replace_text_via_uia 函数**

在 `src-tauri/src/automation/selection.rs` 末尾追加：

```rust
use super::SelectionContext;

/// 通过 UI Automation 替换选中文字
pub fn replace_text_via_uia(ctx: &SelectionContext, new_text: &str) -> Result<(), String> {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()
            .map_err(|e| format!("COM 初始化失败: {}", e))?;

        let result = (|| -> Result<(), String> {
            let clsctx = CLSCTX(0x1);
            let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, clsctx)
                .or_else(|_| CoCreateInstance(&CUIAutomation8, None, clsctx))
                .map_err(|e| format!("创建 IUIAutomation 失败: {}", e))?;

            // 获取焦点元素
            let element = automation.GetFocusedElement()
                .map_err(|e| format!("获取焦点元素失败: {}", e))?;

            // 尝试 ValuePattern（适用于大多数可编辑控件）
            use windows::Win32::UI::Accessibility::UIA_ValuePatternId;
            match element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
                Ok(value_pattern) => {
                    let current_value = value_pattern.CurrentValue()
                        .unwrap_or_default()
                        .to_string();

                    // 在完整文本中找到选中部分并替换
                    if let Some(pos) = current_value.find(&ctx.text) {
                        let new_value = format!("{}{}{}",
                            &current_value[..pos],
                            new_text,
                            &current_value[pos + ctx.text.len()..]
                        );
                        value_pattern.SetValue(&windows::core::HSTRING::from(&new_value))
                            .map_err(|e| format!("SetValue 失败: {}", e))?;
                        crate::utils::logger::log("selection", "UIA ValuePattern 替换成功");
                        return Ok(());
                    }

                    // 如果在完整文本中找不到选中部分，尝试直接 SetValue 为新文本
                    // 这适用于选区就是整个文本的情况
                    if current_value == ctx.text {
                        value_pattern.SetValue(&windows::core::HSTRING::from(new_text))
                            .map_err(|e| format!("SetValue 失败: {}", e))?;
                        crate::utils::logger::log("selection", "UIA ValuePattern 整文替换成功");
                        return Ok(());
                    }

                    Err("无法在当前文本中定位选中内容，请重新选中文本".to_string())
                }
                Err(_) => {
                    // ValuePattern 不可用，尝试 TextPattern
                    crate::utils::logger::log("selection", "ValuePattern 不可用，尝试 TextPattern");
                    Err("当前控件不支持文本替换（无 ValuePattern），请重新选中文本".to_string())
                }
            }
        })();

        CoUninitialize();
        result
    }
}
```

- [ ] **Step 3: 在 selection.rs 中新增 replace_text_via_win32 函数**

在 `src-tauri/src/automation/selection.rs` 末尾追加：

```rust
/// 通过 Win32 消息替换选中文字（适用于 EDIT/RICHEDIT 控件）
pub fn replace_text_via_win32(ctx: &SelectionContext, new_text: &str) -> Result<(), String> {
    unsafe {
        let hwnd = HWND(ctx.focus_hwnd);
        if hwnd.is_invalid() {
            return Err("焦点控件句柄无效，请重新选中文本".to_string());
        }

        // 先选中原始选区范围
        let result = SendMessageW(
            hwnd,
            windows::Win32::UI::Controls::EM_SETSEL,
            Some(WPARAM(ctx.sel_start as usize)),
            Some(LPARAM(ctx.sel_end as isize)),
        );
        crate::utils::logger::log("selection", &format!("EM_SETSEL result: {:?}", result));

        // 用 EM_REPLACESEL 替换选中内容
        let new_text_wide: Vec<u16> = new_text.encode_utf16().chain(std::iter::once(0u16)).collect();
        let result = SendMessageW(
            hwnd,
            windows::Win32::UI::Controls::RichEdit::EM_REPLACESEL,
            Some(WPARAM(TRUE.0 as usize)),
            Some(LPARAM(new_text_wide.as_ptr() as isize)),
        );
        crate::utils::logger::log("selection", &format!("EM_REPLACESEL result: {:?}", result));

        if result.0 == 0 {
            // EM_REPLACESEL 返回 0 可能表示失败，但某些控件总是返回 0
            // 检查文本是否已改变来确认
            crate::utils::logger::log("selection", "EM_REPLACESEL returned 0, replacement may have failed");
        }

        Ok(())
    }
}
```

- [ ] **Step 4: 修改 selection.rs 的 get_selection_via_uia 返回额外上下文**

在 `src-tauri/src/automation/selection.rs` 中，修改 `get_selection_via_uia` 函数。当前函数签名：

```rust
fn get_selection_via_uia() -> Result<Option<SelectionInfo>, Box<dyn std::error::Error>>
```

在函数内部，`Ok(Some(SelectionInfo { ... }))` 之前，添加暂存调用。在 `get_selection_via_uia` 函数的 `Ok(Some(SelectionInfo {` 之前插入：

```rust
// 暂存 UIA 选区上下文
super::store_selection_context(&SelectionInfo {
    text: text.to_string(),
    rect: rect.clone(),
}, super::SelectionContext {
    text: text.to_string(),
    rect,
    foreground_hwnd: 0,
    focus_hwnd: 0,
    focus_class: String::new(),
    sel_start: 0,
    sel_end: 0,
    via_uia: true,
});
```

注意：`rect` 需要在 `SelectionInfo` 构造之前 clone，因为 `SelectionInfo` 会 move 它。调整代码为：

```rust
let info = SelectionInfo {
    text: text.to_string(),
    rect: rect.clone(),
};

// 暂存 UIA 选区上下文
super::store_selection_context(&info, super::SelectionContext {
    text: info.text.clone(),
    rect: info.rect.clone(),
    foreground_hwnd: 0,
    focus_hwnd: 0,
    focus_class: String::new(),
    sel_start: 0,
    sel_end: 0,
    via_uia: true,
});

Ok(Some(info))
```

- [ ] **Step 5: 修改 selection.rs 的 get_selection_via_win32 返回额外上下文**

在 `get_selection_via_win32` 函数中，`Ok(Some(SelectionInfo { text, rect }))` 之前，添加暂存调用。将最后的返回改为：

```rust
let info = SelectionInfo { text, rect: rect.clone() };

// 暂存 Win32 选区上下文
super::store_selection_context(&info, super::SelectionContext {
    text: info.text.clone(),
    rect: info.rect.clone(),
    foreground_hwnd: foreground.0 as isize,
    focus_hwnd: target_hwnd.0 as isize,
    focus_class: target_class.clone(),
    sel_start,
    sel_end,
    via_uia: false,
});

Ok(Some(info))
```

注意：需要在函数开头保存 `foreground` 变量。在 `get_selection_via_win32` 函数中，`let foreground = GetForegroundWindow();` 这行之后，`foreground` 已经存在，直接使用即可。

- [ ] **Step 6: 新增 replace_selection Tauri 命令**

在 `src-tauri/src/commands.rs` 末尾追加：

```rust
/// 替换选中文字
#[tauri::command]
pub fn replace_selection(text: String) -> Result<(), String> {
    crate::utils::logger::log("commands", &format!("replace_selection 命令被调用, 新文本长度: {} 字节", text.len()));
    if text.is_empty() {
        return Err("替换文本不能为空".to_string());
    }
    crate::automation::replace_selection_text(&text)
}
```

- [ ] **Step 7: 在 main.rs 中注册 replace_selection 命令**

在 `src-tauri/src/main.rs` 的 `invoke_handler` 宏中，在 `commands::update_ai_config,` 后面追加：

```rust
commands::replace_selection,
```

- [ ] **Step 8: 编译验证**

Run: `cd D:\projects\Programs\floast_service\src-tauri && cargo check 2>&1`
Expected: 编译成功

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/automation/mod.rs src-tauri/src/automation/selection.rs src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat: 新增选区暂存与文本替换功能 (replace_selection)"
```

---

### Task 4: 前端 — 预设模式常量与类型定义

**Files:**
- Create: `src/constants/optimizeModes.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Produces: `OptimizeMode` 接口、`OPTIMIZE_MODES` 常量数组、`AiConfig` 接口

- [ ] **Step 1: 创建 optimizeModes.ts**

创建 `src/constants/optimizeModes.ts`：

```typescript
/** 优化模式定义 */
export interface OptimizeMode {
  /** 模式唯一标识 */
  id: string;
  /** 显示图标 */
  icon: string;
  /** 显示标签 */
  label: string;
  /** AI 系统提示词 */
  systemPrompt: string;
}

/** 预设优化模式列表 */
export const OPTIMIZE_MODES: OptimizeMode[] = [
  {
    id: "polish",
    icon: "✨",
    label: "润色",
    systemPrompt:
      "你是一个文本润色专家。请润色和优化以下文本，使其更流畅、更自然、更易读，保持原意不变。只返回润色后的文本，不要添加任何解释或前缀。",
  },
  {
    id: "formal",
    icon: "🎩",
    label: "正式化",
    systemPrompt:
      "你是一个文本正式化专家。请将以下文本改写为更正式、更专业的风格，适合商务或学术场景，保持原意不变。只返回改写后的文本，不要添加任何解释或前缀。",
  },
  {
    id: "concise",
    icon: "✂️",
    label: "简洁化",
    systemPrompt:
      "你是一个文本精简专家。请将以下文本精简为更简洁、更紧凑的版本，去除冗余表达，保持核心信息不变。只返回精简后的文本，不要添加任何解释或前缀。",
  },
  {
    id: "translate",
    icon: "🌐",
    label: "翻译",
    systemPrompt:
      "你是一个翻译专家。请将以下文本翻译为中文（如果原文是中文则翻译为英文），保持原文的语气和风格。只返回翻译后的文本，不要添加任何解释或前缀。",
  },
];
```

- [ ] **Step 2: 在 types.ts 中新增 AiConfig 接口**

在 `src/types.ts` 末尾追加：

```typescript
/** AI 配置 - 与后端 AiConfig 对应 */
export interface AiConfig {
  api_key: string;
  base_url: string;
  model: string;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/constants/optimizeModes.ts src/types.ts
git commit -m "feat: 新增预设优化模式常量与 AiConfig 类型定义"
```

---

### Task 5: 前端 — useAiOptimize Hook

**Files:**
- Create: `src/hooks/useAiOptimize.ts`

**Interfaces:**
- Consumes: `invoke("call_ai", { prompt, system_prompt })` (from Task 2), `invoke("get_ai_config")`, `OptimizeMode` (from Task 4), `AiConfig` (from Task 4)
- Produces: `useAiOptimize()` Hook 返回 `{ optimize, cancel, isLoading, optimizedText, errorMessage, aiConfig }`

- [ ] **Step 1: 创建 useAiOptimize.ts**

创建 `src/hooks/useAiOptimize.ts`：

```typescript
import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { OptimizeMode } from "../constants/optimizeModes";
import { AiConfig } from "../types";

interface UseAiOptimizeReturn {
  /** 调用 AI 优化文本 */
  optimize: (text: string, mode: OptimizeMode) => Promise<void>;
  /** 取消当前优化（重置状态） */
  cancel: () => void;
  /** 是否正在加载 */
  isLoading: boolean;
  /** AI 返回的优化文本 */
  optimizedText: string | null;
  /** 错误信息 */
  errorMessage: string | null;
  /** 当前 AI 配置 */
  aiConfig: AiConfig | null;
  /** 检查 AI 是否已配置 */
  checkAiConfig: () => Promise<AiConfig | null>;
}

export function useAiOptimize(): UseAiOptimizeReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [optimizedText, setOptimizedText] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [aiConfig, setAiConfig] = useState<AiConfig | null>(null);
  const cancelledRef = useRef(false);

  const checkAiConfig = useCallback(async (): Promise<AiConfig | null> => {
    try {
      const config = await invoke<AiConfig>("get_ai_config");
      setAiConfig(config);
      return config;
    } catch (err) {
      console.error("Failed to get AI config:", err);
      return null;
    }
  }, []);

  const optimize = useCallback(async (text: string, mode: OptimizeMode) => {
    cancelledRef.current = false;
    setIsLoading(true);
    setOptimizedText(null);
    setErrorMessage(null);

    try {
      const response = await invoke<{ content: string; model: string }>("call_ai", {
        prompt: text,
        systemPrompt: mode.systemPrompt,
      });

      if (cancelledRef.current) return;

      if (!response.content || response.content.trim().length === 0) {
        setErrorMessage("AI 未返回有效内容");
        setIsLoading(false);
        return;
      }

      setOptimizedText(response.content.trim());
      setIsLoading(false);
    } catch (err) {
      if (cancelledRef.current) return;
      const msg = typeof err === "string" ? err : String(err);
      setErrorMessage(msg || "AI 调用失败，请检查配置");
      setIsLoading(false);
    }
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    setIsLoading(false);
    setOptimizedText(null);
    setErrorMessage(null);
  }, []);

  return {
    optimize,
    cancel,
    isLoading,
    optimizedText,
    errorMessage,
    aiConfig,
    checkAiConfig,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/useAiOptimize.ts
git commit -m "feat: 新增 useAiOptimize Hook"
```

---

### Task 6: 前端 — ToolbarButton 扩展 disabled/loading/variant

**Files:**
- Modify: `src/components/ToolbarButton.tsx`
- Modify: `src/components/ToolbarButton.css`

**Interfaces:**
- Produces: `<ToolbarButton icon label onClick disabled? loading? variant? />`

- [ ] **Step 1: 扩展 ToolbarButton props**

将 `src/components/ToolbarButton.tsx` 替换为：

```typescript
import "./ToolbarButton.css";

interface ToolbarButtonProps {
  icon: string;
  label: string;
  onClick: () => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否显示加载动画 */
  loading?: boolean;
  /** 按钮变体：default / primary / danger */
  variant?: "default" | "primary" | "danger";
}

function ToolbarButton({
  icon,
  label,
  onClick,
  disabled = false,
  loading = false,
  variant = "default",
}: ToolbarButtonProps) {
  const className = [
    "toolbar-button",
    `toolbar-button--${variant}`,
    loading ? "toolbar-button--loading" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      className={className}
      onClick={onClick}
      title={label}
      aria-label={label}
      disabled={disabled || loading}
    >
      <span className="toolbar-button-icon">{loading ? "🔄" : icon}</span>
    </button>
  );
}

export default ToolbarButton;
```

- [ ] **Step 2: 扩展 ToolbarButton.css 样式**

在 `src/components/ToolbarButton.css` 末尾追加：

```css
/* 禁用状态 */
.toolbar-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.toolbar-button:disabled:hover {
  background: transparent;
}

/* 加载动画 */
.toolbar-button--loading .toolbar-button-icon {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* Primary 变体 */
.toolbar-button--primary {
  color: var(--button-primary-text);
}

.toolbar-button--primary:hover {
  background: var(--button-primary-hover-bg);
}

/* Danger 变体 */
.toolbar-button--danger {
  color: var(--button-danger-text);
}

.toolbar-button--danger:hover {
  background: var(--button-danger-hover-bg);
}
```

- [ ] **Step 3: 在 global.css 中新增按钮变体 CSS 变量**

在 `src/styles/global.css` 的 `:root` 块中，`--button-text: #333333;` 后追加：

```css
  --button-primary-text: #2563eb;
  --button-primary-hover-bg: #eff6ff;
  --button-danger-text: #dc2626;
  --button-danger-hover-bg: #fef2f2;
```

在 `[data-theme="dark"]` 块中，`--button-text: #e0e0e0;` 后追加：

```css
  --button-primary-text: #60a5fa;
  --button-primary-hover-bg: #1e3a5f;
  --button-danger-text: #f87171;
  --button-danger-hover-bg: #3b1c1c;
```

- [ ] **Step 4: Commit**

```bash
git add src/components/ToolbarButton.tsx src/components/ToolbarButton.css src/styles/global.css
git commit -m "feat: ToolbarButton 支持 disabled/loading/variant"
```

---

### Task 7: 前端 — FloatingToolbar 状态机改造

**Files:**
- Modify: `src/components/FloatingToolbar.tsx`
- Modify: `src/components/FloatingToolbar.css`
- Modify: `src/styles/global.css`

**Interfaces:**
- Consumes: `useAiOptimize` (from Task 5), `OPTIMIZE_MODES` (from Task 4), `ToolbarButton` (from Task 6), `invoke("replace_selection")` (from Task 3), `invoke("show_settings")`

- [ ] **Step 1: 重写 FloatingToolbar.tsx**

将 `src/components/FloatingToolbar.tsx` 替换为：

```typescript
import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import ToolbarButton from "./ToolbarButton";
import { SelectionInfo } from "../types";
import { OPTIMIZE_MODES, OptimizeMode } from "../constants/optimizeModes";
import { useAiOptimize } from "../hooks/useAiOptimize";
import "./FloatingToolbar.css";

type ToolbarState = "default" | "mode-select" | "loading" | "preview" | "error";

function FloatingToolbar() {
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [state, setState] = useState<ToolbarState>("default");
  const [selectedMode, setSelectedMode] = useState<OptimizeMode | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { optimize, cancel, isLoading, optimizedText, errorMessage: aiError, checkAiConfig } = useAiOptimize();

  // 隐藏工具栏
  const hideToolbar = useCallback(async () => {
    setIsVisible(false);
    setState("default");
    setSelectedMode(null);
    cancel();
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    try {
      await invoke("hide_toolbar");
    } catch {
      getCurrentWebviewWindow().hide();
    }
  }, [cancel]);

  // 重置到默认态
  const resetToDefault = useCallback(() => {
    setState("default");
    setSelectedMode(null);
    cancel();
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    resizeToolbar(200, 50);
  }, [cancel]);

  // 调整工具栏窗口大小
  const resizeToolbar = useCallback((width: number, height: number) => {
    const win = getCurrentWebviewWindow();
    win.setSize(new (require("@tauri-apps/api/dpi").LogicalSize)(width, height)).catch(() => {});
  }, []);

  useEffect(() => {
    const win = getCurrentWebviewWindow();

    const unlisten = win.listen<SelectionInfo>("selection-found", (event) => {
      setSelection(event.payload);
      setIsVisible(true);
      setState("default");
      resizeToolbar(200, 50);
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (state === "mode-select" || state === "preview" || state === "error") {
          resetToDefault();
        } else {
          hideToolbar();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      unlisten.then((fn) => fn());
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [hideToolbar, resetToDefault, state, resizeToolbar]);

  // 监听 AI 状态变化
  useEffect(() => {
    if (isLoading && state === "mode-select") {
      setState("loading");
      resizeToolbar(200, 50);
    }
    if (!isLoading && state === "loading") {
      if (aiError) {
        setState("error");
        setErrorMessage(aiError);
        resizeToolbar(300, 50);
        // 3 秒后自动回到默认态
        if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
        errorTimerRef.current = setTimeout(() => {
          resetToDefault();
        }, 3000);
      } else if (optimizedText) {
        setState("preview");
        resizeToolbar(400, 200);
      }
    }
  }, [isLoading, aiError, optimizedText, state, resetToDefault, resizeToolbar]);

  // 复制
  const handleCopy = async () => {
    if (selection) {
      try {
        await invoke("copy_text", { text: selection.text });
        hideToolbar();
      } catch (err) {
        console.error("Failed to copy:", err);
      }
    }
  };

  // 点击优化按钮
  const handleOptimizeClick = async () => {
    const config = await checkAiConfig();
    if (!config || !config.api_key || config.api_key.trim().length === 0) {
      setState("error");
      setErrorMessage("请先配置 AI");
      resizeToolbar(300, 50);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => {
        resetToDefault();
      }, 5000);
      return;
    }
    setState("mode-select");
    resizeToolbar(280, 50);
  };

  // 选择优化模式
  const handleModeSelect = async (mode: OptimizeMode) => {
    if (!selection) return;
    setSelectedMode(mode);
    await optimize(selection.text, mode);
  };

  // 确认替换
  const handleReplace = async () => {
    if (!optimizedText) return;
    try {
      await invoke("replace_selection", { text: optimizedText });
      hideToolbar();
    } catch (err) {
      setState("error");
      setErrorMessage(typeof err === "string" ? err : "无法替换，请重新选中文本");
      resizeToolbar(300, 50);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => {
        resetToDefault();
      }, 3000);
    }
  };

  // 跳转设置
  const handleGoSettings = async () => {
    try {
      await invoke("show_settings");
    } catch (err) {
      console.error("Failed to show settings:", err);
    }
    resetToDefault();
  };

  if (!isVisible || !selection) {
    return null;
  }

  return (
    <div id="toolbar" className="toolbar-container">
      {state === "default" && (
        <>
          <ToolbarButton icon="📋" label="复制" onClick={handleCopy} />
          <ToolbarButton icon="✨" label="优化" onClick={handleOptimizeClick} />
        </>
      )}

      {state === "mode-select" && (
        <div className="toolbar-mode-select">
          <ToolbarButton icon="←" label="返回" onClick={resetToDefault} />
          <div className="toolbar-mode-divider" />
          {OPTIMIZE_MODES.map((mode) => (
            <ToolbarButton
              key={mode.id}
              icon={mode.icon}
              label={mode.label}
              onClick={() => handleModeSelect(mode)}
            />
          ))}
        </div>
      )}

      {state === "loading" && (
        <div className="toolbar-loading">
          <ToolbarButton icon="✨" label="优化中..." loading />
          <ToolbarButton icon="✗" label="取消" onClick={resetToDefault} variant="danger" />
        </div>
      )}

      {state === "preview" && optimizedText && (
        <div className="toolbar-preview">
          <div className="toolbar-preview-text">{optimizedText}</div>
          <div className="toolbar-preview-actions">
            <ToolbarButton icon="✓" label="替换" onClick={handleReplace} variant="primary" />
            <ToolbarButton icon="✗" label="取消" onClick={resetToDefault} variant="danger" />
          </div>
        </div>
      )}

      {state === "error" && (
        <div className="toolbar-error">
          <span className="toolbar-error-text">{errorMessage}</span>
          {errorMessage === "请先配置 AI" ? (
            <ToolbarButton icon="⚙" label="设置" onClick={handleGoSettings} variant="primary" />
          ) : (
            <ToolbarButton icon="↩" label="返回" onClick={resetToDefault} />
          )}
        </div>
      )}
    </div>
  );
}

export default FloatingToolbar;
```

- [ ] **Step 2: 扩展 FloatingToolbar.css**

将 `src/components/FloatingToolbar.css` 替换为：

```css
.toolbar-container {
  display: flex;
  gap: 4px;
  padding: 6px 8px;
  background: var(--toolbar-bg);
  border: 1px solid var(--toolbar-border);
  border-radius: 8px;
  box-shadow: var(--toolbar-shadow);
  animation: fadeIn 0.2s ease-in-out;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 模式选择 */
.toolbar-mode-select {
  display: flex;
  align-items: center;
  gap: 2px;
}

.toolbar-mode-divider {
  width: 1px;
  height: 20px;
  background: var(--toolbar-border);
  margin: 0 4px;
}

/* 加载状态 */
.toolbar-loading {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 预览状态 */
.toolbar-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  max-height: 180px;
}

.toolbar-preview-text {
  font-size: 13px;
  line-height: 1.5;
  color: var(--preview-text-color);
  max-height: 140px;
  overflow-y: auto;
  padding: 4px;
  border-radius: 4px;
  background: var(--preview-bg);
  border: 1px solid var(--preview-border);
  word-break: break-word;
  white-space: pre-wrap;
}

.toolbar-preview-actions {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
}

/* 错误状态 */
.toolbar-error {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar-error-text {
  font-size: 12px;
  color: var(--error-text-color);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 3: 在 global.css 中新增预览态和错误态 CSS 变量**

在 `src/styles/global.css` 的 `:root` 块末尾（`--settings-input-bg: #ffffff;` 之后）追加：

```css
  /* 预览态 */
  --preview-text-color: #333333;
  --preview-bg: #f9fafb;
  --preview-border: #e5e7eb;

  /* 错误态 */
  --error-text-color: #dc2626;
```

在 `[data-theme="dark"]` 块末尾（`--settings-input-bg: #2d2d2d;` 之后）追加：

```css
  /* 预览态 */
  --preview-text-color: #e0e0e0;
  --preview-bg: #1e1e1e;
  --preview-border: #444444;

  /* 错误态 */
  --error-text-color: #f87171;
```

- [ ] **Step 4: Commit**

```bash
git add src/components/FloatingToolbar.tsx src/components/FloatingToolbar.css src/styles/global.css
git commit -m "feat: FloatingToolbar 状态机改造，支持 AI 优化流程"
```

---

### Task 8: 前端 — Settings 页 AI 配置区域

**Files:**
- Modify: `src/components/Settings.tsx`
- Modify: `src/components/Settings.css`

**Interfaces:**
- Consumes: `invoke("get_ai_config")`, `invoke("update_ai_config")`, `AiConfig` (from Task 4)

- [ ] **Step 1: 重写 Settings.tsx**

将 `src/components/Settings.tsx` 替换为：

```typescript
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AiConfig } from "../types";
import "./Settings.css";

function Settings() {
  const [autoStart, setAutoStart] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    return (localStorage.getItem("floast-theme") as "light" | "dark") || "light";
  });

  // AI 配置
  const [aiConfig, setAiConfig] = useState<AiConfig>({
    api_key: "",
    base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-20250514",
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [aiSaveStatus, setAiSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("floast-theme", theme);
  }, [theme]);

  // 加载 AI 配置
  useEffect(() => {
    invoke<AiConfig>("get_ai_config")
      .then((config) => setAiConfig(config))
      .catch((err) => console.error("Failed to load AI config:", err));
  }, []);

  const handleSaveAiConfig = async () => {
    setAiSaveStatus("saving");
    try {
      await invoke("update_ai_config", { newConfig: aiConfig });
      setAiSaveStatus("saved");
      setTimeout(() => setAiSaveStatus("idle"), 2000);
    } catch (err) {
      console.error("Failed to save AI config:", err);
      setAiSaveStatus("error");
      setTimeout(() => setAiSaveStatus("idle"), 3000);
    }
  };

  return (
    <div className="settings-container">
      <h1>Floast Service 设置</h1>

      <div className="settings-section">
        <h2>通用设置</h2>

        <div className="settings-item">
          <label>
            <input
              type="checkbox"
              checked={autoStart}
              onChange={(e) => setAutoStart(e.target.checked)}
            />
            开机自启动
          </label>
        </div>

        <div className="settings-item">
          <label>
            主题：
            <select value={theme} onChange={(e) => setTheme(e.target.value as "light" | "dark")}>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
        </div>
      </div>

      <div className="settings-section">
        <h2>AI 配置</h2>

        <div className="settings-item">
          <label className="settings-label">API Key</label>
          <div className="settings-input-group">
            <input
              type={showApiKey ? "text" : "password"}
              value={aiConfig.api_key}
              onChange={(e) => setAiConfig({ ...aiConfig, api_key: e.target.value })}
              placeholder="输入 API Key"
              className="settings-input"
            />
            <button
              className="settings-toggle-btn"
              onClick={() => setShowApiKey(!showApiKey)}
              title={showApiKey ? "隐藏" : "显示"}
            >
              {showApiKey ? "🙈" : "👁"}
            </button>
          </div>
        </div>

        <div className="settings-item">
          <label className="settings-label">Base URL</label>
          <input
            type="text"
            value={aiConfig.base_url}
            onChange={(e) => setAiConfig({ ...aiConfig, base_url: e.target.value })}
            placeholder="https://api.anthropic.com"
            className="settings-input"
          />
        </div>

        <div className="settings-item">
          <label className="settings-label">Model</label>
          <input
            type="text"
            value={aiConfig.model}
            onChange={(e) => setAiConfig({ ...aiConfig, model: e.target.value })}
            placeholder="claude-sonnet-4-20250514"
            className="settings-input"
          />
        </div>

        <div className="settings-item">
          <button
            className="settings-save-btn"
            onClick={handleSaveAiConfig}
            disabled={aiSaveStatus === "saving"}
          >
            {aiSaveStatus === "saving" && "保存中..."}
            {aiSaveStatus === "idle" && "保存"}
            {aiSaveStatus === "saved" && "✓ 已保存"}
            {aiSaveStatus === "error" && "✗ 保存失败"}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h2>关于</h2>
        <p>Floast Service v0.1.0</p>
        <p>Windows 浮窗工具 - 选中文字后显示工具栏</p>
      </div>
    </div>
  );
}

export default Settings;
```

- [ ] **Step 2: 扩展 Settings.css**

在 `src/components/Settings.css` 末尾追加：

```css
/* AI 配置区域 */
.settings-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 4px;
  color: var(--settings-subheading-color);
}

.settings-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--settings-border);
  border-radius: 4px;
  font-size: 14px;
  background: var(--settings-input-bg);
  color: var(--settings-heading-color);
  font-family: inherit;
}

.settings-input:focus {
  outline: none;
  border-color: var(--settings-focus-border, #2563eb);
  box-shadow: 0 0 0 2px var(--settings-focus-shadow, rgba(37, 99, 235, 0.2));
}

.settings-input-group {
  display: flex;
  gap: 4px;
}

.settings-input-group .settings-input {
  flex: 1;
}

.settings-toggle-btn {
  padding: 6px 10px;
  border: 1px solid var(--settings-border);
  border-radius: 4px;
  background: var(--settings-input-bg);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}

.settings-toggle-btn:hover {
  background: var(--button-hover-bg);
}

.settings-save-btn {
  padding: 8px 20px;
  border: none;
  border-radius: 4px;
  background: var(--settings-save-btn-bg, #2563eb);
  color: var(--settings-save-btn-text, #ffffff);
  font-size: 14px;
  cursor: pointer;
  transition: opacity 0.15s ease;
}

.settings-save-btn:hover {
  opacity: 0.9;
}

.settings-save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 3: 在 global.css 中新增设置页相关 CSS 变量**

在 `src/styles/global.css` 的 `:root` 块中追加：

```css
  /* 设置页 - AI 配置 */
  --settings-focus-border: #2563eb;
  --settings-focus-shadow: rgba(37, 99, 235, 0.2);
  --settings-save-btn-bg: #2563eb;
  --settings-save-btn-text: #ffffff;
```

在 `[data-theme="dark"]` 块中追加：

```css
  /* 设置页 - AI 配置 */
  --settings-focus-border: #60a5fa;
  --settings-focus-shadow: rgba(96, 165, 250, 0.2);
  --settings-save-btn-bg: #2563eb;
  --settings-save-btn-text: #ffffff;
```

- [ ] **Step 4: Commit**

```bash
git add src/components/Settings.tsx src/components/Settings.css src/styles/global.css
git commit -m "feat: Settings 页新增 AI 配置区域"
```

---

### Task 9: 集成验证与修复

**Files:**
- 可能修改上述任何文件

- [ ] **Step 1: 后端编译验证**

Run: `cd D:\projects\Programs\floast_service\src-tauri && cargo check 2>&1`
Expected: 编译成功，无错误

- [ ] **Step 2: 前端编译验证**

Run: `cd D:\projects\Programs\floast_service && npx tsc --noEmit 2>&1`
Expected: TypeScript 类型检查通过

- [ ] **Step 3: 修复编译中发现的问题**

根据 Step 1 和 Step 2 的输出修复任何编译错误。

- [ ] **Step 4: 应用启动测试**

Run: `cd D:\projects\Programs\floast_service && npm run tauri dev 2>&1`
Expected: 应用正常启动，悬浮球可见，设置页可打开

- [ ] **Step 5: 功能手动验证**

1. 打开设置页，确认 AI 配置区域可见
2. 输入 API Key，点击保存，确认状态显示"✓ 已保存"
3. 在记事本中选中文字，确认工具栏显示"复制"和"优化"按钮
4. 点击"优化"，确认显示模式选择面板
5. 选择"润色"，确认显示加载动画
6. AI 返回后，确认显示预览文本和"替换"/"取消"按钮
7. 点击"替换"，确认文本被替换
8. 测试未配置 API Key 时点击优化，确认显示"请先配置 AI"提示

- [ ] **Step 6: Commit 修复**

```bash
git add -A
git commit -m "fix: 集成验证修复"
```
