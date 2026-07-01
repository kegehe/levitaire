pub mod selection;
pub mod clipboard_selection;
pub mod ocr_selection;

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SelectionInfo {
    pub text: String,
    pub rect: Rect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// 选区获取方法（标记用于选择合适的替换策略）
#[derive(Debug, Clone, PartialEq)]
pub enum SelectionMethod {
    /// UIA 获取（支持精确选区定位替换）
    Uia,
    /// Win32 消息获取（支持精确选区定位替换）
    Win32,
    /// 剪贴板模拟获取（读取 + 替换均走剪贴板）
    Clipboard,
    /// 屏幕 OCR 获取（仅读取，无法替换 — 用剪贴板方式替换）
    Ocr,
}

/// 选区上下文 — 用于后续替换操作时定位目标
#[derive(Debug, Clone)]
pub struct SelectionContext {
    /// 选中的文本
    pub text: String,
    /// 选区矩形
    #[allow(dead_code)]
    pub rect: Rect,
    /// 获取方法（决定替换策略）
    pub method: SelectionMethod,
    /// 前台窗口句柄（用于恢复焦点）
    pub foreground_hwnd: isize,
    /// 焦点控件句柄（用于 Win32 替换）
    pub focus_hwnd: isize,
    /// 焦点控件类名（用于判断替换策略）
    #[allow(dead_code)]
    pub focus_class: String,
    /// 选区起始位置（用于 Win32 EM_SETSEL + EM_REPLACESEL）
    pub sel_start: u32,
    /// 选区结束位置
    pub sel_end: u32,
    /// 选中文本在文档中的出现次序（0-based，用于 UIA 替换时定位正确的匹配位置）
    #[allow(dead_code)]
    pub occurrence_index: usize,
}

/// 全局暂存的选区上下文
static SELECTION_CONTEXT: OnceLock<Mutex<Option<SelectionContext>>> = OnceLock::new();

fn get_selection_context_store() -> &'static Mutex<Option<SelectionContext>> {
    SELECTION_CONTEXT.get_or_init(|| Mutex::new(None))
}

/// 暂存选区上下文（在 selection-found 事件时调用）
pub fn store_selection_context(_info: &SelectionInfo, ctx: SelectionContext) {
    let store = get_selection_context_store();
    if let Ok(mut guard) = store.lock() {
        let text_len = ctx.text.len();
        *guard = Some(ctx);
        crate::utils::logger::log("automation", &format!("选区上下文已暂存, text: {} chars", text_len));
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

    match ctx.method {
        SelectionMethod::Uia => selection::replace_text_via_uia(&ctx, new_text),
        SelectionMethod::Win32 => selection::replace_text_via_win32(&ctx, new_text),
        SelectionMethod::Clipboard => clipboard_selection::replace_text_via_clipboard(&ctx, new_text),
        SelectionMethod::Ocr => {
            // OCR 无法定位替换，走剪贴板模拟粘贴
            clipboard_selection::replace_text_via_clipboard(&ctx, new_text)
        }
    }
}

pub fn get_current_selection() -> Result<Option<SelectionInfo>, Box<dyn std::error::Error>> {
    selection::get_selection()
}

pub fn get_mouse_position() -> Result<Point, Box<dyn std::error::Error>> {
    Ok(selection::get_cursor_pos())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── SelectionInfo ────────────────────────────────────────────

    #[test]
    fn test_selection_info_clone() {
        let info = SelectionInfo {
            text: "hello world".to_string(),
            rect: Rect { x: 10, y: 20, width: 100, height: 30 },
        };
        let cloned = info.clone();
        assert_eq!(info.text, cloned.text);
        assert_eq!(info.rect.x, cloned.rect.x);
        assert_eq!(info.rect.width, cloned.rect.width);
    }

    #[test]
    fn test_selection_info_partial_eq() {
        let a = SelectionInfo {
            text: "same".to_string(),
            rect: Rect { x: 0, y: 0, width: 0, height: 0 },
        };
        let b = SelectionInfo {
            text: "same".to_string(),
            rect: Rect { x: 0, y: 0, width: 0, height: 0 },
        };
        assert_eq!(a, b);
    }

    #[test]
    fn test_selection_info_partial_eq_different() {
        let a = SelectionInfo {
            text: "hello".to_string(),
            rect: Rect { x: 0, y: 0, width: 0, height: 0 },
        };
        let b = SelectionInfo {
            text: "world".to_string(),
            rect: Rect { x: 0, y: 0, width: 0, height: 0 },
        };
        assert_ne!(a, b);
    }

    #[test]
    fn test_selection_info_serde() {
        let info = SelectionInfo {
            text: "test selection".to_string(),
            rect: Rect { x: 100, y: 200, width: 300, height: 40 },
        };
        let json = serde_json::to_string(&info).unwrap();
        let decoded: SelectionInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(info, decoded);
    }

    #[test]
    fn test_selection_info_empty_text() {
        let info = SelectionInfo {
            text: String::new(),
            rect: Rect { x: 0, y: 0, width: 0, height: 0 },
        };
        assert!(info.text.is_empty());
    }

    // ─── Point ────────────────────────────────────────────────────

    #[test]
    fn test_point_serde() {
        let p = Point { x: 42, y: -10 };
        let json = serde_json::to_string(&p).unwrap();
        let decoded: Point = serde_json::from_str(&json).unwrap();
        assert_eq!(p.x, decoded.x);
        assert_eq!(p.y, decoded.y);
    }

    // ─── Rect ─────────────────────────────────────────────────────

    #[test]
    fn test_rect_clone() {
        let r = Rect { x: 10, y: 20, width: 100, height: 50 };
        let cloned = r.clone();
        assert_eq!(r, cloned);
    }

    #[test]
    fn test_rect_partial_eq() {
        let a = Rect { x: 0, y: 0, width: 0, height: 0 };
        let b = Rect { x: 0, y: 0, width: 0, height: 0 };
        assert_eq!(a, b);

        let c = Rect { x: 1, y: 0, width: 0, height: 0 };
        assert_ne!(a, c);
    }

    // ─── SelectionContext ─────────────────────────────────────────

    #[test]
    fn test_selection_context_clone() {
        let ctx = SelectionContext {
            text: "selected text".to_string(),
            rect: Rect { x: 0, y: 0, width: 0, height: 0 },
            method: SelectionMethod::Uia,
            foreground_hwnd: 12345,
            focus_hwnd: 67890,
            focus_class: "Edit".to_string(),
            sel_start: 0,
            sel_end: 5,
            occurrence_index: 1,
        };
        let cloned = ctx.clone();
        assert_eq!(ctx.text, cloned.text);
        assert_eq!(ctx.method, cloned.method);
        assert_eq!(ctx.foreground_hwnd, cloned.foreground_hwnd);
        assert_eq!(ctx.sel_start, cloned.sel_start);
    }

    // ─── SelectionMethod ──────────────────────────────────────────

    #[test]
    fn test_selection_method_clone() {
        assert_eq!(SelectionMethod::Uia.clone(), SelectionMethod::Uia);
        assert_eq!(SelectionMethod::Win32.clone(), SelectionMethod::Win32);
        assert_eq!(SelectionMethod::Clipboard.clone(), SelectionMethod::Clipboard);
        assert_eq!(SelectionMethod::Ocr.clone(), SelectionMethod::Ocr);
    }

    // ─── store/get_selection_context ──────────────────────────────

    #[test]
    fn test_store_and_get_selection_context() {
        let info = SelectionInfo {
            text: "test context".to_string(),
            rect: Rect { x: 0, y: 0, width: 0, height: 0 },
        };
        let ctx = SelectionContext {
            text: "test context".to_string(),
            rect: Rect { x: 0, y: 0, width: 0, height: 0 },
            method: SelectionMethod::Clipboard,
            foreground_hwnd: 999,
            focus_hwnd: 0,
            focus_class: String::new(),
            sel_start: 0,
            sel_end: 0,
            occurrence_index: 0,
        };
        store_selection_context(&info, ctx);

        let retrieved = get_stored_selection_context();
        assert!(retrieved.is_some());
        let r = retrieved.unwrap();
        assert_eq!(r.text, "test context");
        assert_eq!(r.method, SelectionMethod::Clipboard);
        assert_eq!(r.foreground_hwnd, 999);
    }

    #[test]
    fn test_get_stored_selection_context_after_clear() {
        // 先清空 store
        {
            let store = get_selection_context_store();
            if let Ok(mut guard) = store.lock() {
                *guard = None;
            }
        }
        let result = get_stored_selection_context();
        assert!(result.is_none());
    }

    #[test]
    fn test_store_selection_context_overwrites() {
        let info = SelectionInfo {
            text: "overwrite test".to_string(),
            rect: Rect { x: 0, y: 0, width: 0, height: 0 },
        };
        let ctx1 = SelectionContext {
            text: "overwrite test".to_string(),
            rect: Rect { x: 0, y: 0, width: 0, height: 0 },
            method: SelectionMethod::Uia,
            foreground_hwnd: 1,
            focus_hwnd: 0,
            focus_class: String::new(),
            sel_start: 0,
            sel_end: 0,
            occurrence_index: 0,
        };
        store_selection_context(&info, ctx1);

        let ctx2 = SelectionContext {
            text: "overwrite test".to_string(),
            rect: Rect { x: 0, y: 0, width: 0, height: 0 },
            method: SelectionMethod::Win32,
            foreground_hwnd: 2,
            focus_hwnd: 0,
            focus_class: String::new(),
            sel_start: 0,
            sel_end: 0,
            occurrence_index: 0,
        };
        store_selection_context(&info, ctx2);

        let r = get_stored_selection_context().unwrap();
        assert_eq!(r.method, SelectionMethod::Win32);
        assert_eq!(r.foreground_hwnd, 2);
    }

    // ─── replace_selection_text 无上下文 ──────────────────────────

    #[test]
    fn test_replace_selection_text_no_context() {
        // 先清空 store 确保无上下文
        {
            let store = get_selection_context_store();
            if let Ok(mut guard) = store.lock() {
                *guard = None;
            }
        }
        let result = replace_selection_text("new text");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("没有暂存"));
    }
}
