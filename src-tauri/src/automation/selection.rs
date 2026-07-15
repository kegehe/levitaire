use super::{Point, SelectionInfo};
use windows::core::BOOL;
use windows::core::PWSTR;
use windows::Win32::Foundation::{FALSE, HWND, LPARAM, POINT, TRUE, WPARAM};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX, COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Ole::{SafeArrayAccessData, SafeArrayDestroy, SafeArrayUnaccessData};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::Controls::RichEdit::{CHARRANGE, EM_GETTEXTRANGE, TEXTRANGEW};
use windows::Win32::UI::Controls::EM_POSFROMCHAR;
use windows::Win32::UI::Controls::{EM_GETSEL, EM_REPLACESEL, EM_SETSEL};
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::WindowsAndMessaging::*;

// UIA TreeWalker 遍历深度上限（防止 Electron 等深树结构遍历过深）
const TREE_WALKER_MAX_DEPTH: u32 = 3;

/// #10: 选区获取三态结果
/// 区分"API 有效但无选区"（跳过后续 fallback）和"API 不适用"（继续 fallback）
#[derive(Debug, PartialEq)]
enum SelectionResult {
    /// 成功获取到选区
    Found(SelectionInfo),
    /// API 适用但无选区（如焦点在编辑器中但未选中文字）→ 跳过 clipboard fallback
    EmptySelection,
    /// API 不适用（如焦点控件不支持该 API）→ 继续下一个 fallback
    NotApplicable,
}

// Win32 EDIT/RICHEDIT 控件类名
const EDIT_CLASS_NAMES: &[&str] = &[
    "Edit",
    "RichEdit",
    "RichEdit20W",
    "RichEdit20A",
    "RICHEDIT50W",    // 通用 RichEdit 5.0
    "RichEditD2DPT",  // Windows 11 Notepad
    "MSFTEDIT_CLASS", // RichEdit 4.1+
];

pub fn get_selection() -> Result<Option<SelectionInfo>, Box<dyn std::error::Error>> {
    crate::utils::logger::log("selection", "get_selection called");

    // #5: 在入口处捕获前台窗口（各 fallback 可能改变前台窗口状态）
    let foreground_hwnd = unsafe { GetForegroundWindow() };

    // 方法1: UI Automation（浏览器、Office、Electron 等）
    match get_selection_via_uia() {
        Ok(SelectionResult::Found(info)) => {
            crate::utils::logger::log(
                "selection",
                &format!("UIA success: {} chars", info.text.len()),
            );
            return Ok(Some(info));
        }
        Ok(SelectionResult::EmptySelection) => {
            crate::utils::logger::log(
                "selection",
                "UIA applicable but no selection, continuing to Win32",
            );
            // UIA EmptySelection 不再跳过 fallback — UIA 有时暂时读不到选区，
            // 让 Win32 和 clipboard 继续尝试以确保不遗漏
        }
        Ok(SelectionResult::NotApplicable) => {
            crate::utils::logger::log("selection", "UIA not applicable, trying Win32 fallback");
        }
        Err(e) => crate::utils::logger::log(
            "selection",
            &format!("UIA error: {}, trying Win32 fallback", e),
        ),
    }

    // 方法2: Win32 消息（记事本、Win32 编辑框等）
    match get_selection_via_win32() {
        Ok(SelectionResult::Found(info)) => {
            crate::utils::logger::log(
                "selection",
                &format!("Win32 success: {} chars", info.text.len()),
            );
            return Ok(Some(info));
        }
        Ok(SelectionResult::EmptySelection) => {
            crate::utils::logger::log(
                "selection",
                "Win32 applicable but no selection, skipping clipboard/OCR",
            );
            // Win32 找到 EDIT 控件但无选区，说明用户确实没有选中文本，跳过 clipboard/OCR
            return Ok(None);
        }
        Ok(SelectionResult::NotApplicable) => {
            crate::utils::logger::log("selection", "Win32 not applicable");
        }
        Err(e) => crate::utils::logger::log("selection", &format!("Win32 error: {}", e)),
    }

    // 方法3: 模拟 Ctrl+C + 剪贴板读取（万能 fallback）
    match super::clipboard_selection::get_selection_via_clipboard() {
        Ok(Some((info, fg_hwnd))) => {
            crate::utils::logger::log(
                "selection",
                &format!("Clipboard success: {} chars", info.text.len()),
            );
            // clipboard_selection::get_selection_via_clipboard 内部已暂存了含焦点控件
            // HWND 和选区位置的完整上下文（focus_hwnd/sel_start/sel_end），
            // 此处无需覆盖，避免丢失精确定位信息
            let _ = fg_hwnd;
            return Ok(Some(info));
        }
        Ok(None) => crate::utils::logger::log("selection", "Clipboard returned None"),
        Err(e) => crate::utils::logger::log("selection", &format!("Clipboard error: {}", e)),
    }

    // 方法4: 屏幕 OCR（最后手段，仅读取，无法精确替换）
    // #5: 使用入口处捕获的前台窗口，避免 fallback 链改变前台窗口状态
    match super::ocr_selection::get_selection_via_ocr() {
        Ok(Some(info)) => {
            crate::utils::logger::log(
                "selection",
                &format!("OCR success: {} chars", info.text.len()),
            );
            super::store_selection_context(
                &info,
                super::SelectionContext {
                    text: info.text.clone(),
                    rect: info.rect.clone(),
                    method: super::SelectionMethod::Ocr,
                    foreground_hwnd: foreground_hwnd.0 as isize,
                    focus_hwnd: 0,
                    focus_class: String::new(),
                    sel_start: 0,
                    sel_end: 0,
                    occurrence_index: 0,
                },
            );
            return Ok(Some(info));
        }
        Ok(None) => crate::utils::logger::log("selection", "OCR returned None"),
        Err(e) => crate::utils::logger::log("selection", &format!("OCR error: {}", e)),
    }

    Ok(None)
}

// ─── UI Automation ───────────────────────────────────────────────

/// #10: UIA 选区获取，返回三态结果
fn get_selection_via_uia() -> Result<SelectionResult, Box<dyn std::error::Error>> {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;

        let result = (|| -> Result<SelectionResult, Box<dyn std::error::Error>> {
            let clsctx = CLSCTX(0x1);
            let automation: IUIAutomation = match CoCreateInstance(&CUIAutomation, None, clsctx)
                .or_else(|_| CoCreateInstance(&CUIAutomation8, None, clsctx))
            {
                Ok(a) => a,
                Err(_) => return Ok(SelectionResult::NotApplicable),
            };

            let foreground = GetForegroundWindow();

            // GetFocusedElement 失败 → UIA 不适用
            let element = match automation.GetFocusedElement() {
                Ok(e) => e,
                Err(_) => return Ok(SelectionResult::NotApplicable),
            };

            // 分层 fallback 链
            match resolve_text_pattern_and_selection(&automation, &element) {
                Some((_text_pattern, sel_range, _source_element)) => {
                    let text = sel_range.GetText(-1)?;
                    if text.is_empty() {
                        // #10: UIA 能获取焦点元素和 TextPattern，但无选区 → 跳过后续 fallback
                        return Ok(SelectionResult::EmptySelection);
                    }

                    let rect = match get_range_rect(&sel_range) {
                        Some(r) => r,
                        None => {
                            let pos = get_cursor_pos();
                            super::Rect {
                                x: pos.x,
                                y: pos.y,
                                width: 0,
                                height: 0,
                            }
                        }
                    };

                    let info = SelectionInfo {
                        text: text.to_string(),
                        rect: rect.clone(),
                        has_image: false,
                    };

                    super::store_selection_context(
                        &info,
                        super::SelectionContext {
                            text: info.text.clone(),
                            rect: info.rect.clone(),
                            method: super::SelectionMethod::Uia,
                            foreground_hwnd: foreground.0 as isize,
                            focus_hwnd: 0,
                            focus_class: String::new(),
                            sel_start: 0,
                            sel_end: 0,
                            occurrence_index: 0,
                        },
                    );

                    Ok(SelectionResult::Found(info))
                }
                None => {
                    // TreeWalker 也失败，尝试 LegacyIAccessible
                    crate::utils::logger::log(
                        "selection",
                        "All TextPattern attempts failed, trying LegacyIAccessible",
                    );
                    if let Some(info) = try_legacy_accessible(&element) {
                        super::store_selection_context(
                            &info,
                            super::SelectionContext {
                                text: info.text.clone(),
                                rect: info.rect.clone(),
                                method: super::SelectionMethod::Uia,
                                foreground_hwnd: foreground.0 as isize,
                                focus_hwnd: 0,
                                focus_class: String::new(),
                                sel_start: 0,
                                sel_end: 0,
                                occurrence_index: 0,
                            },
                        );
                        return Ok(SelectionResult::Found(info));
                    }
                    // #10: GetFocusedElement 成功（UIA 适用），但找不到任何文本 → 跳过 clipboard
                    Ok(SelectionResult::EmptySelection)
                }
            }
        })();

        CoUninitialize();
        result
    }
}

/// 分层 fallback：尝试获取 TextPattern + 非空选区 TextRange
///
/// 优先级：
/// 1. 焦点元素的 TextPattern + GetSelection()
/// 2. 焦点元素的 TextPattern2 + GetCaretRange()
/// 3. TreeWalker 遍历子元素寻找 TextPattern + GetSelection()
unsafe fn resolve_text_pattern_and_selection(
    automation: &IUIAutomation,
    element: &IUIAutomationElement,
) -> Option<(
    IUIAutomationTextPattern,
    IUIAutomationTextRange,
    IUIAutomationElement,
)> {
    // --- Step 1: 焦点元素的 TextPattern ---
    if let Ok(tp) = element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
        if let Ok(ranges) = tp.GetSelection() {
            if ranges.Length().unwrap_or(0) > 0 {
                if let Ok(range) = ranges.GetElement(0) {
                    if let Ok(text) = range.GetText(-1) {
                        if !text.is_empty() {
                            return Some((tp, range, element.clone()));
                        }
                    }
                }
            }
        }
        crate::utils::logger::log(
            "selection",
            "TextPattern selection empty/invalid, trying TextPattern2 caret",
        );
    } else {
        crate::utils::logger::log("selection", "Focused element has no TextPattern");
    }

    // --- Step 2: TextPattern2 GetCaretRange ---
    if let Some(result) = try_text_pattern2_caret(element) {
        return Some(result);
    }

    // --- Step 3: TreeWalker 遍历子元素 ---
    crate::utils::logger::log(
        "selection",
        "TextPattern2 failed, trying TreeWalker traversal",
    );
    find_selection_via_tree_walker(automation, element, TREE_WALKER_MAX_DEPTH)
}

/// 从 TextRange 的 SAFEARRAY 中提取位置信息
unsafe fn get_range_rect(range: &IUIAutomationTextRange) -> Option<super::Rect> {
    let sa = range.GetBoundingRectangles().ok()?;
    if sa.is_null() {
        return None;
    }

    if (*sa).rgsabound[0].cElements < 4 {
        let _ = SafeArrayDestroy(sa);
        return None;
    }

    let mut data: *mut f64 = std::ptr::null_mut();
    if SafeArrayAccessData(sa, &mut data as *mut *mut f64 as *mut *mut _).is_err() {
        let _ = SafeArrayDestroy(sa);
        return None;
    }

    let x = *data as i32;
    let y = *data.add(1) as i32;
    let width = *data.add(2) as i32;
    let height = *data.add(3) as i32;

    let _ = SafeArrayUnaccessData(sa);
    let _ = SafeArrayDestroy(sa);

    Some(super::Rect {
        x,
        y,
        width,
        height,
    })
}

// ─── Win32 Messages (EDIT/RICHEDIT) ─────────────────────────────

fn get_selection_via_win32() -> Result<SelectionResult, Box<dyn std::error::Error>> {
    unsafe {
        // 1. 获取前台窗口及其线程 ID
        let foreground = GetForegroundWindow();
        if foreground.is_invalid() {
            crate::utils::logger::log("selection", "Win32: no foreground window");
            return Ok(SelectionResult::NotApplicable);
        }

        let thread_id = GetWindowThreadProcessId(foreground, None);
        if thread_id == 0 {
            crate::utils::logger::log("selection", "Win32: GetWindowThreadProcessId failed");
            return Ok(SelectionResult::NotApplicable);
        }

        // 2. 获取焦点控件 HWND
        let mut gui_info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };

        if GetGUIThreadInfo(thread_id, &mut gui_info).is_err() {
            crate::utils::logger::log("selection", "Win32: GetGUIThreadInfo failed");
            return Ok(SelectionResult::NotApplicable);
        }

        let hwnd_focus = gui_info.hwndFocus;
        if hwnd_focus.is_invalid() {
            crate::utils::logger::log("selection", "Win32: no focused control");
            return Ok(SelectionResult::NotApplicable);
        }

        // 3. 获取控件类名
        let class_name = match get_class_name(hwnd_focus) {
            Some(name) => name,
            None => return Ok(SelectionResult::NotApplicable),
        };

        // 确定目标 EDIT 控件 HWND
        let is_edit = EDIT_CLASS_NAMES
            .iter()
            .any(|n| n.eq_ignore_ascii_case(&class_name));
        let (target_hwnd, target_class) = if is_edit {
            (hwnd_focus, class_name)
        } else {
            match find_edit_child(hwnd_focus) {
                Some((h, c)) => (h, c),
                None => {
                    crate::utils::logger::log(
                        "selection",
                        &format!(
                            "Win32: class '{}' is not EDIT and no EDIT child found",
                            class_name
                        ),
                    );
                    return Ok(SelectionResult::NotApplicable);
                }
            }
        };

        // 4. 获取选区范围
        let mut sel_start: u32 = 0;
        let mut sel_end: u32 = 0;
        let result = SendMessageW(
            target_hwnd,
            EM_GETSEL,
            Some(WPARAM(&mut sel_start as *mut u32 as usize)),
            Some(LPARAM(&mut sel_end as *mut u32 as isize)),
        );

        if sel_start == 0 && sel_end == 0 && result.0 != 0 {
            sel_start = (result.0 & 0xFFFF) as u32;
            sel_end = ((result.0 >> 16) & 0xFFFF) as u32;
        }

        // #10: 找到 EDIT 控件但无选区 → EmptySelection，跳过 clipboard fallback
        if sel_start == sel_end {
            crate::utils::logger::log("selection", "Win32: no text selected (start == end)");
            return Ok(SelectionResult::EmptySelection);
        }

        crate::utils::logger::log(
            "selection",
            &format!("Win32: selection range {}..{}", sel_start, sel_end),
        );

        // 5. 获取选中文字
        let is_richedit = is_richedit_class(&target_class);
        let text = if is_richedit {
            get_richedit_text(target_hwnd, sel_start as i32, sel_end as i32)?
        } else {
            get_edit_text(target_hwnd, sel_start, sel_end)?
        };

        if text.is_empty() {
            crate::utils::logger::log("selection", "Win32: selected text is empty");
            return Ok(SelectionResult::EmptySelection);
        }

        crate::utils::logger::log("selection", &format!("Win32 success: {} chars", text.len()));

        let rect = match get_edit_position(target_hwnd, sel_start as i32, is_richedit) {
            Some(r) => r,
            None => {
                let pos = get_cursor_pos();
                super::Rect {
                    x: pos.x,
                    y: pos.y,
                    width: 0,
                    height: 0,
                }
            }
        };

        let info = SelectionInfo {
            text: text.clone(),
            rect: rect.clone(),
            has_image: false,
        };

        super::store_selection_context(
            &info,
            super::SelectionContext {
                text: info.text.clone(),
                rect: info.rect.clone(),
                method: super::SelectionMethod::Win32,
                foreground_hwnd: foreground.0 as isize,
                focus_hwnd: target_hwnd.0 as isize,
                focus_class: target_class,
                sel_start,
                sel_end,
                occurrence_index: 0,
            },
        );

        Ok(SelectionResult::Found(info))
    }
}

/// 获取窗口类名
unsafe fn get_class_name(hwnd: HWND) -> Option<String> {
    let mut buf = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut buf);
    if len == 0 {
        crate::utils::logger::log("selection", "Win32: GetClassNameW failed");
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

/// 在父窗口的子窗口中查找 EDIT/RICHEDIT 控件
unsafe fn find_edit_child(parent: HWND) -> Option<(HWND, String)> {
    let mut result: Option<(HWND, String)> = None;

    let _ = EnumChildWindows(
        Some(parent),
        Some(enum_child_proc),
        LPARAM(&mut result as *mut _ as isize),
    );

    result
}

unsafe extern "system" fn enum_child_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let result_ptr = lparam.0 as *mut Option<(HWND, String)>;
    let result = &mut *result_ptr;

    let mut buf = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut buf);
    if len > 0 {
        let class_name = String::from_utf16_lossy(&buf[..len as usize]);
        if EDIT_CLASS_NAMES
            .iter()
            .any(|n| n.eq_ignore_ascii_case(&class_name))
        {
            *result = Some((hwnd, class_name));
            return FALSE; // 找到了，停止枚举
        }
    }

    TRUE // 继续枚举
}

/// 判断是否为 RichEdit 控件（非标准 Edit）
fn is_richedit_class(class_name: &str) -> bool {
    !class_name.eq_ignore_ascii_case("Edit")
        && EDIT_CLASS_NAMES
            .iter()
            .any(|n| n.eq_ignore_ascii_case(class_name))
}

/// 从标准 EDIT 控件获取选中文字：WM_GETTEXT 拿全文 UTF-16，按选区索引截取
/// 注意：EM_GETSEL 返回的索引对应 UTF-16 码元（Windows 内部编码），
/// 所以在 UTF-16 buffer 上切片后再转 String，避免 char 索引偏移问题
unsafe fn get_edit_text(
    hwnd: HWND,
    sel_start: u32,
    sel_end: u32,
) -> Result<String, Box<dyn std::error::Error>> {
    // 获取全文长度（UTF-16 码元数，不含 null）
    let text_len = SendMessageW(hwnd, WM_GETTEXTLENGTH, None, None).0 as usize;
    if text_len == 0 {
        return Ok(String::new());
    }

    // 获取全文 UTF-16
    let mut buffer: Vec<u16> = vec![0u16; text_len + 1];
    let copied = SendMessageW(
        hwnd,
        WM_GETTEXT,
        Some(WPARAM(buffer.len())),
        Some(LPARAM(buffer.as_mut_ptr() as isize)),
    );
    let len = copied.0 as usize;
    if len == 0 {
        return Ok(String::new());
    }

    // 在 UTF-16 buffer 上按选区索引切片
    let start = sel_start as usize;
    let end = sel_end as usize;
    if start >= len || end > len || start >= end {
        return Ok(String::new());
    }

    Ok(String::from_utf16_lossy(&buffer[start..end]))
}

/// 从 RICHEDIT 控件获取选中文字：EM_GETTEXTRANGE 直接获取
unsafe fn get_richedit_text(
    hwnd: HWND,
    cp_min: i32,
    cp_max: i32,
) -> Result<String, Box<dyn std::error::Error>> {
    let char_count = (cp_max - cp_min) as usize;
    if char_count == 0 {
        return Ok(String::new());
    }

    let mut buffer: Vec<u16> = vec![0u16; char_count + 1];

    let mut textrange = TEXTRANGEW {
        chrg: CHARRANGE {
            cpMin: cp_min,
            cpMax: cp_max,
        },
        lpstrText: PWSTR(buffer.as_mut_ptr()),
    };

    let result = SendMessageW(
        hwnd,
        EM_GETTEXTRANGE,
        None,
        Some(LPARAM(&mut textrange as *mut TEXTRANGEW as isize)),
    );

    if result.0 == 0 {
        crate::utils::logger::log("selection", "Win32: EM_GETTEXTRANGE returned 0");
        return Ok(String::new());
    }

    let len = result.0 as usize;
    Ok(String::from_utf16_lossy(&buffer[..len]))
}

/// 获取 EDIT/RICHEDIT 控件中选区的屏幕坐标
unsafe fn get_edit_position(hwnd: HWND, sel_start: i32, is_richedit: bool) -> Option<super::Rect> {
    // EM_POSFROMCHAR: EDIT 用 lParam 传字符索引，RichEdit 用 wParam
    let result = if is_richedit {
        SendMessageW(hwnd, EM_POSFROMCHAR, Some(WPARAM(sel_start as usize)), None)
    } else {
        SendMessageW(hwnd, EM_POSFROMCHAR, None, Some(LPARAM(sel_start as isize)))
    };

    // 返回 -1 表示无效位置
    if result.0 == -1 {
        crate::utils::logger::log("selection", "Win32: EM_POSFROMCHAR returned -1");
        return None;
    }

    // 解包 POINTL：x 在低 32 位，y 在高 32 位
    let client_x = (result.0 & 0xFFFFFFFF) as i32;
    let client_y = ((result.0 >> 32) & 0xFFFFFFFF) as i32;

    // 转换为屏幕坐标
    let mut point = POINT {
        x: client_x,
        y: client_y,
    };
    if ClientToScreen(hwnd, &mut point).as_bool() {
        Some(super::Rect {
            x: point.x,
            y: point.y,
            width: 0,
            height: 0,
        })
    } else {
        crate::utils::logger::log("selection", "Win32: ClientToScreen failed");
        None
    }
}

// ─── UIA TreeWalker 遍历 ──────────────────────────────────────

/// 递归遍历 UIA 子树，寻找支持 TextPattern 且有选区的元素
/// 返回 (TextPattern, 选区 TextRange, 对应 Element) 三元组
unsafe fn find_selection_via_tree_walker(
    automation: &IUIAutomation,
    element: &IUIAutomationElement,
    depth: u32,
) -> Option<(
    IUIAutomationTextPattern,
    IUIAutomationTextRange,
    IUIAutomationElement,
)> {
    // 尝试当前元素的 TextPattern
    if let Ok(tp) = element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
        if let Ok(ranges) = tp.GetSelection() {
            if ranges.Length().unwrap_or(0) > 0 {
                if let Ok(range) = ranges.GetElement(0) {
                    if let Ok(text) = range.GetText(-1) {
                        if !text.is_empty() {
                            crate::utils::logger::log(
                                "selection",
                                &format!(
                                    "TreeWalker: found TextPattern with selection at depth {}",
                                    depth
                                ),
                            );
                            return Some((tp, range, element.clone()));
                        }
                    }
                }
            }
        }
    }

    if depth == 0 {
        return None;
    }

    // ControlViewWalker 遍历子元素
    let walker = match automation.ControlViewWalker() {
        Ok(w) => w,
        Err(_) => return None,
    };

    let mut child = match walker.GetFirstChildElement(element) {
        Ok(c) => c,
        Err(_) => return None,
    };

    loop {
        if let Some(result) = find_selection_via_tree_walker(automation, &child, depth - 1) {
            return Some(result);
        }
        match walker.GetNextSiblingElement(&child) {
            Ok(next) => child = next,
            Err(_) => break,
        }
    }

    None
}

/// 使用 TextPattern2 的 GetCaretRange 作为 fallback 获取光标附近的文本
/// 适用于 GetSelection() 返回空但应用实际有焦点文本的场景
unsafe fn try_text_pattern2_caret(
    element: &IUIAutomationElement,
) -> Option<(
    IUIAutomationTextPattern,
    IUIAutomationTextRange,
    IUIAutomationElement,
)> {
    let tp2: IUIAutomationTextPattern2 = element.GetCurrentPatternAs(UIA_TextPattern2Id).ok()?;

    let mut is_active = FALSE;
    let range = tp2.GetCaretRange(&mut is_active).ok()?;
    let text = range.GetText(-1).ok()?;

    if text.is_empty() {
        return None;
    }

    crate::utils::logger::log("selection", "TextPattern2 GetCaretRange: found text");
    // TextPattern2 继承自 TextPattern，直接转换为 TextPattern
    let tp: IUIAutomationTextPattern = element.GetCurrentPatternAs(UIA_TextPatternId).ok()?;
    Some((tp, range, element.clone()))
}

/// 使用 LegacyIAccessiblePattern 获取控件的 accValue 全文
/// 这是最后的 UIA fallback，无法获取精确选区范围，返回全文
unsafe fn try_legacy_accessible(element: &IUIAutomationElement) -> Option<super::SelectionInfo> {
    let la: IUIAutomationLegacyIAccessiblePattern = element
        .GetCurrentPatternAs(UIA_LegacyIAccessiblePatternId)
        .ok()?;

    let value = la.CurrentValue().ok()?.to_string();
    if value.is_empty() {
        return None;
    }

    crate::utils::logger::log(
        "selection",
        &format!("LegacyIAccessible: got value, {} chars", value.len()),
    );

    let pos = get_cursor_pos();
    Some(super::SelectionInfo {
        text: value,
        rect: super::Rect {
            x: pos.x,
            y: pos.y,
            width: 0,
            height: 0,
        },
        has_image: false,
    })
}

// ─── 通用工具 ────────────────────────────────────────────────────

pub fn get_cursor_pos() -> Point {
    unsafe {
        let mut point = POINT::default();
        let _ = GetCursorPos(&mut point);
        Point {
            x: point.x,
            y: point.y,
        }
    }
}

// ─── 文本替换 ────────────────────────────────────────────────────

/// 通过 UI Automation 替换选中文字
pub fn replace_text_via_uia(ctx: &super::SelectionContext, new_text: &str) -> Result<(), String> {
    unsafe {
        // 先恢复前台窗口到用户操作的编辑器
        // 工具栏按钮点击后，工具栏窗口可能获取了焦点，
        // 导致 GetFocusedElement() 返回工具栏而非编辑器
        if ctx.foreground_hwnd != 0 {
            let foreground_hwnd = HWND(ctx.foreground_hwnd as *mut std::ffi::c_void);
            let _ = SetForegroundWindow(foreground_hwnd);
            // 短暂等待让窗口切换生效
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| format!("COM 初始化失败: {}", e))?;

        let result = (|| -> Result<(), String> {
            let clsctx = CLSCTX(0x1);
            let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, clsctx)
                .or_else(|_| CoCreateInstance(&CUIAutomation8, None, clsctx))
                .map_err(|e| format!("创建 IUIAutomation 失败: {}", e))?;

            let element = automation
                .GetFocusedElement()
                .map_err(|e| format!("获取焦点元素失败: {}", e))?;

            // 尝试 ValuePattern（适用于大多数可编辑控件）
            // 如果焦点元素没有 ValuePattern，用 TreeWalker 遍历子元素寻找
            match find_value_pattern_for_replace(&automation, &element, ctx, new_text) {
                Ok(()) => Ok(()),
                Err(e) => {
                    crate::utils::logger::log("selection", &format!("替换失败: {}", e));
                    Err(e)
                }
            }
        })();

        CoUninitialize();
        result
    }
}

/// 通过 TreeWalker 查找支持 ValuePattern 的元素并执行替换
/// 优先级：焦点元素 > TreeWalker 子元素遍历
unsafe fn find_value_pattern_for_replace(
    automation: &IUIAutomation,
    element: &IUIAutomationElement,
    ctx: &super::SelectionContext,
    new_text: &str,
) -> Result<(), String> {
    // Step 1: 尝试焦点元素本身的 ValuePattern
    if let Ok(vp) = element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
        if try_replace_with_value_pattern(element, &vp, ctx, new_text, "focus element").is_ok() {
            return Ok(());
        }
    }

    // Step 2: TreeWalker 遍历子元素寻找 ValuePattern
    let walker = automation
        .ControlViewWalker()
        .map_err(|e| format!("获取 ControlViewWalker 失败: {}", e))?;

    let mut child = walker
        .GetFirstChildElement(element)
        .map_err(|_| "焦点元素无子控件，无法定位可编辑文本区域".to_string())?;

    loop {
        if let Ok(vp) = child.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
            if try_replace_with_value_pattern(&child, &vp, ctx, new_text, "child element").is_ok() {
                return Ok(());
            }
        }
        match walker.GetNextSiblingElement(&child) {
            Ok(next) => child = next,
            Err(_) => break,
        }
    }

    Err("当前控件不支持文本替换（无 ValuePattern），请重新选中文本".to_string())
}

/// 使用 ValuePattern 尝试替换文本
/// 安全检查：选中文本在文档中必须唯一出现
unsafe fn try_replace_with_value_pattern(
    element: &IUIAutomationElement,
    vp: &IUIAutomationValuePattern,
    ctx: &super::SelectionContext,
    new_text: &str,
    label: &str,
) -> Result<(), String> {
    let current_value = vp.CurrentValue().unwrap_or_default().to_string();

    // 如果选区就是整个文本，直接替换
    if current_value == ctx.text {
        vp.SetValue(&windows::core::BSTR::from(new_text))
            .map_err(|e| format!("SetValue 失败: {}", e))?;
        crate::utils::logger::log(
            "selection",
            &format!("UIA ValuePattern 整文替换成功 ({})", label),
        );
        reselect_replaced_text(element, new_text);
        return Ok(());
    }

    // 安全检查：选中文本在文档中是否唯一出现
    // UIA ValuePattern 没有字符级定位能力，无法区分文档中多处相同文本
    // 若选中文本出现多次，替换第一次出现会静默损坏文档内容
    // 仅对较长的选中文本做重复检查（短文本误判率太高，直接允许替换）
    if ctx.text.len() >= 6 {
        let occurrence_count = count_occurrences(&current_value, &ctx.text);
        if occurrence_count == 0 {
            return Err("无法在当前文本中定位选中内容，请重新选中文本".to_string());
        }
        if occurrence_count > 1 {
            return Err(format!(
                "选中文本在文档中出现 {} 次，无法确定替换位置，请重新选中更长的文本片段",
                occurrence_count
            ));
        }
    }

    // 选中文本唯一出现，安全替换
    if let Some(pos) = current_value.find(&ctx.text) {
        let new_value = format!(
            "{}{}{}",
            &current_value[..pos],
            new_text,
            &current_value[pos + ctx.text.len()..]
        );
        vp.SetValue(&windows::core::BSTR::from(&new_value))
            .map_err(|e| format!("SetValue 失败: {}", e))?;
        crate::utils::logger::log(
            "selection",
            &format!("UIA ValuePattern 替换成功 ({})", label),
        );
        reselect_replaced_text(element, new_text);
        return Ok(());
    }

    Err("无法在当前文本中定位选中内容，请重新选中文本".to_string())
}

/// 替换后通过 TextPattern 重新选中替换的文本
/// 使用 FindText 定位替换后的文本并选中
unsafe fn reselect_replaced_text(element: &IUIAutomationElement, new_text: &str) {
    let Ok(tp) = element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) else {
        crate::utils::logger::log("selection", "UIA: 无 TextPattern，无法重新选中");
        return;
    };

    let Ok(document_range) = tp.DocumentRange() else {
        crate::utils::logger::log("selection", "UIA: 无法获取文档范围");
        return;
    };

    // SetValue 后控件可能需要时间更新内部文档模型，
    // 重试 FindText 以应对控件尚未刷新的情况
    let search_text = windows::core::BSTR::from(new_text);
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if let Ok(found_range) = document_range.FindText(&search_text, false, false) {
            let found_text = found_range.GetText(-1).unwrap_or_default().to_string();
            if found_text == new_text {
                let _ = found_range.Select();
                crate::utils::logger::log(
                    "selection",
                    &format!(
                        "UIA: 已通过 FindText 重新选中替换文本 (attempt {})",
                        attempt + 1
                    ),
                );
                return;
            }
        }
    }

    crate::utils::logger::log("selection", "UIA: FindText 未找到替换文本，选区未恢复");
}

/// 统计 substring 在 s 中出现的次数
fn count_occurrences(s: &str, substring: &str) -> usize {
    if substring.is_empty() {
        return 0;
    }
    let mut count = 0;
    let mut start = 0;
    while let Some(pos) = s[start..].find(substring) {
        count += 1;
        start += pos + substring.len();
    }
    count
}

/// 通过 Win32 消息替换选中文字（适用于 EDIT/RICHEDIT 控件）
pub fn replace_text_via_win32(ctx: &super::SelectionContext, new_text: &str) -> Result<(), String> {
    unsafe {
        if ctx.focus_hwnd == 0 {
            return Err("焦点控件句柄无效，请重新选中文本".to_string());
        }
        // 从 isize 恢复 HWND
        let hwnd = HWND(ctx.focus_hwnd as *mut std::ffi::c_void);

        // 恢复前台窗口和焦点到用户操作的编辑器
        if ctx.foreground_hwnd != 0 {
            let foreground_hwnd = HWND(ctx.foreground_hwnd as *mut std::ffi::c_void);
            let _ = SetForegroundWindow(foreground_hwnd);
            let _ = SetFocus(Some(hwnd));
            // 短暂等待让焦点切换生效
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        // 先选中原始选区范围
        let _result = SendMessageW(
            hwnd,
            EM_SETSEL,
            Some(WPARAM(ctx.sel_start as usize)),
            Some(LPARAM(ctx.sel_end as isize)),
        );

        // 用 EM_REPLACESEL 替换选中内容
        let new_text_wide: Vec<u16> = new_text
            .encode_utf16()
            .chain(std::iter::once(0u16))
            .collect();
        let _replace_result = SendMessageW(
            hwnd,
            EM_REPLACESEL,
            Some(WPARAM(TRUE.0 as usize)),
            Some(LPARAM(new_text_wide.as_ptr() as isize)),
        );

        // 替换后重新选中替换的文本（光标此时在替换文本末尾）
        let new_text_len = new_text.encode_utf16().count() as u32; // UTF-16 码元数，不含 null
        let new_end = ctx.sel_start + new_text_len;
        let _ = SendMessageW(
            hwnd,
            EM_SETSEL,
            Some(WPARAM(ctx.sel_start as usize)),
            Some(LPARAM(new_end as isize)),
        );

        crate::utils::logger::log(
            "selection",
            "Win32 EM_REPLACESEL 已发送，已重新选中替换文本",
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── count_occurrences ────────────────────────────────────────

    #[test]
    fn test_count_occurrences_basic() {
        assert_eq!(count_occurrences("hello world hello", "hello"), 2);
        assert_eq!(count_occurrences("aaa", "a"), 3);
        assert_eq!(count_occurrences("abc", "d"), 0);
    }

    #[test]
    fn test_count_occurrences_empty_substring() {
        assert_eq!(count_occurrences("abc", ""), 0);
        assert_eq!(count_occurrences("", ""), 0);
    }

    #[test]
    fn test_count_occurrences_empty_string() {
        assert_eq!(count_occurrences("", "a"), 0);
    }

    #[test]
    fn test_count_occurrences_substring_longer() {
        assert_eq!(count_occurrences("ab", "abc"), 0);
    }

    #[test]
    fn test_count_occurrences_overlapping() {
        // 不重叠计数：每次从 pos + substring.len() 开始
        assert_eq!(count_occurrences("aaa", "aa"), 1);
        assert_eq!(count_occurrences("aaaa", "aa"), 2);
    }

    #[test]
    fn test_count_occurrences_single_char() {
        assert_eq!(count_occurrences("x", "x"), 1);
        assert_eq!(count_occurrences("y", "x"), 0);
    }

    #[test]
    fn test_count_occurrences_exactly_once() {
        assert_eq!(count_occurrences("the quick brown fox", "quick"), 1);
    }

    #[test]
    fn test_count_occurrences_unicode() {
        assert_eq!(count_occurrences("你好世界你好", "你好"), 2);
        assert_eq!(count_occurrences("🎉🎊🎉", "🎉"), 2);
    }

    #[test]
    fn test_count_occurrences_value_pattern_safety() {
        // 模拟 ValuePattern 替换时的真实场景：
        // 选中文本 "test" 在全文中出现多次
        let full_text = "this is a test. another test here.";
        assert_eq!(count_occurrences(full_text, "test"), 2);

        // 选中文本唯一出现 → 可以安全替换
        let full_text = "this is a unique phrase. nothing else.";
        assert_eq!(count_occurrences(full_text, "unique phrase"), 1);

        // 选中文本太短（< 6 字节）→ 跳过检查
        let full_text = "a b a b a";
        assert_eq!(count_occurrences(full_text, "a"), 3);
        // 但 ctx.text.len() < 6 时不检查，所以实际替换不会失败
    }

    // ─── is_richedit_class ────────────────────────────────────────

    #[test]
    fn test_is_richedit_class_standard_edit() {
        assert!(!is_richedit_class("Edit"));
        assert!(!is_richedit_class("edit"));
        assert!(!is_richedit_class("EDIT"));
    }

    #[test]
    fn test_is_richedit_class_rich_edit() {
        assert!(is_richedit_class("RichEdit"));
        assert!(is_richedit_class("RichEdit20W"));
        assert!(is_richedit_class("RichEdit20A"));
        assert!(is_richedit_class("RICHEDIT50W"));
        assert!(is_richedit_class("RichEditD2DPT"));
        assert!(is_richedit_class("MSFTEDIT_CLASS"));
    }

    #[test]
    fn test_is_richedit_class_unknown() {
        assert!(!is_richedit_class("NotepadPlus"));
        assert!(!is_richedit_class("Chrome"));
        assert!(!is_richedit_class(""));
    }

    #[test]
    fn test_is_richedit_class_case_insensitive() {
        assert!(is_richedit_class("richedit"));
        assert!(is_richedit_class("RICHEDIT"));
        assert!(is_richedit_class("richedit20w"));
        assert!(!is_richedit_class("edit"));
    }

    // ─── SelectionResult ──────────────────────────────────────────

    #[test]
    fn test_selection_result_debug() {
        let r = SelectionResult::Found(SelectionInfo {
            text: "hello".into(),
            rect: super::super::Rect {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
            },
            has_image: false,
        });
        assert!(format!("{:?}", r).contains("Found"));

        let r2 = SelectionResult::EmptySelection;
        assert!(format!("{:?}", r2).contains("EmptySelection"));

        let r3 = SelectionResult::NotApplicable;
        assert!(format!("{:?}", r3).contains("NotApplicable"));
    }

    #[test]
    fn test_selection_result_partial_eq() {
        let info = SelectionInfo {
            text: "test".into(),
            rect: super::super::Rect {
                x: 10,
                y: 20,
                width: 100,
                height: 20,
            },
            has_image: false,
        };
        assert_eq!(
            SelectionResult::Found(info.clone()),
            SelectionResult::Found(info)
        );
        assert_eq!(
            SelectionResult::EmptySelection,
            SelectionResult::EmptySelection
        );
        assert_eq!(
            SelectionResult::NotApplicable,
            SelectionResult::NotApplicable
        );
        assert_ne!(
            SelectionResult::EmptySelection,
            SelectionResult::NotApplicable
        );
    }

    // ─── EDIT_CLASS_NAMES ─────────────────────────────────────────

    #[test]
    fn test_edit_class_names_non_empty() {
        assert!(!EDIT_CLASS_NAMES.is_empty());
    }

    #[test]
    fn test_edit_class_names_contains_standard() {
        assert!(EDIT_CLASS_NAMES.contains(&"Edit"));
        assert!(EDIT_CLASS_NAMES.contains(&"RichEdit20W"));
    }

    // ─── TREE_WALKER_MAX_DEPTH ────────────────────────────────────

    #[test]
    fn test_tree_walker_max_depth() {
        assert_eq!(TREE_WALKER_MAX_DEPTH, 3);
    }
}
