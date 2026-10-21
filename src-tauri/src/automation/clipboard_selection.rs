use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::*;
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows::Win32::System::Threading::{
    OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

use super::{Rect, SelectionContext, SelectionInfo};

const CF_UNICODETEXT: u32 = 13;
const CF_DIB: u32 = 8;
/// 剪贴板文本最大字符数（防损坏数据越界）
const MAX_CLIPBOARD_U16: usize = 1024 * 1024;
const MAX_CLIPBOARD_DIB_BYTES: usize = 48 * 1024 * 1024;

/// 全局暂存的选区图片数据（CF_DIB 格式）
static DETECTED_IMAGE: std::sync::OnceLock<std::sync::Mutex<Option<Vec<u8>>>> =
    std::sync::OnceLock::new();

fn get_image_store() -> &'static std::sync::Mutex<Option<Vec<u8>>> {
    DETECTED_IMAGE.get_or_init(|| std::sync::Mutex::new(None))
}

/// 存储检测到的图片数据
pub fn store_detected_image(data: Vec<u8>) {
    let store = get_image_store();
    if let Ok(mut guard) = store.lock() {
        *guard = Some(data);
    }
}

/// 通过模拟 Ctrl+C 从剪贴板获取选中文字
/// 流程：保存原剪贴板 → 模拟 Ctrl+C → 读取 → **确认剪贴板里仍是自己写进去的那份内容**才恢复快照
/// 返回 (SelectionInfo, foreground_hwnd) — foreground_hwnd 用于后续替换时恢复焦点
pub fn get_selection_via_clipboard(
) -> Result<Option<(SelectionInfo, isize)>, Box<dyn std::error::Error>> {
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.is_invalid() {
            crate::utils::logger::log("clipboard_sel", "No foreground window");
            return Ok(None);
        }

        // #11: 检测目标窗口是否为管理员权限（High IL），SendInput 无法注入
        if is_elevated_window(foreground) {
            crate::utils::logger::log(
                "clipboard_sel",
                "Target window is elevated (admin), skipping SendInput",
            );
            return Ok(None);
        }

        // 保存原始剪贴板内容
        let saved_clipboard = save_clipboard_text();

        // 模拟 Ctrl+C
        if !simulate_copy() {
            crate::utils::logger::log("clipboard_sel", "Failed to simulate Ctrl+C");
            // 本次没有向剪贴板写入任何东西，也就没有「我们造成的变化」需要回滚。
            // 旧实现在这里也回滚一次快照，那反而会覆盖用户此刻自己复制的内容 ——
            // 详见 restore_clipboard_after_check 的说明。
            return Ok(None);
        }

        // 等待剪贴板更新（最多 500ms）
        // 必须传入 saved_clipboard 以区分新内容与旧内容，
        // 防止 simulate_copy 未生效时返回剪贴板中的残留数据
        //
        // ⚠️ 返回 None = **没观察到**这次模拟复制落地（目标程序不响应注入按键，或复制出的
        // 内容与原来完全一样）。此时剪贴板里的内容不是我们写的，绝不能回滚：这段最长 500ms
        // 的等待窗口里，用户往往已经自己按下了 Ctrl+C / Ctrl+X。
        let observed = wait_for_clipboard_text_changed(500, saved_clipboard.as_deref());

        // 检测并保存剪贴板中的图片数据（必须在回滚之前）
        let image_data = read_clipboard_image();
        let has_image = image_data.is_some();

        let cursor_pos = crate::automation::selection::get_cursor_pos();
        let rect = Rect {
            x: cursor_pos.x,
            y: cursor_pos.y,
            width: 0,
            height: 0,
        };

        // 获取焦点控件 HWND 和选区位置（用于替换时精确定位）
        // Scintilla（Notepad++）等控件响应 EM_GETSEL/EM_SETSEL
        let (focus_hwnd, focus_class, sel_start, sel_end) = get_focus_selection(foreground);

        match observed {
            Some((t, observed_sequence)) => {
                crate::utils::logger::log(
                    "clipboard_sel",
                    &format!(
                        "Clipboard success: {} chars, has_image: {}, focus_class='{}', sel={}",
                        t.len(),
                        has_image,
                        focus_class,
                        if sel_start == sel_end {
                            "none".to_string()
                        } else {
                            format!("{}..{}", sel_start, sel_end)
                        }
                    ),
                );

                // 如果有图片，暂存图片数据供复制操作使用
                if let Some(img_data) = image_data {
                    store_detected_image(img_data);
                }

                // 暂存选区上下文（含焦点控件 HWND 和选区位置，供替换时精确定位）
                super::store_selection_context(
                    &SelectionInfo {
                        text: t.clone(),
                        rect: rect.clone(),
                        has_image,
                    },
                    super::SelectionContext {
                        text: t.clone(),
                        rect: rect.clone(),
                        method: super::SelectionMethod::Clipboard,
                        foreground_hwnd: foreground.0 as isize,
                        focus_hwnd,
                        focus_class: focus_class.clone(),
                        sel_start,
                        sel_end,
                        occurrence_index: 0,
                    },
                );

                // 确认剪贴板里仍是这次模拟复制写进去的内容，才把快照写回去
                restore_clipboard_after_check(saved_clipboard.as_deref(), Some(observed_sequence));

                let info = SelectionInfo {
                    text: t,
                    rect,
                    has_image,
                };
                Ok(Some((info, foreground.0 as isize)))
            }
            _ if has_image => {
                // 纯图片选区（无文本）
                crate::utils::logger::log("clipboard_sel", "Clipboard has image but no text");
                if let Some(img_data) = image_data {
                    store_detected_image(img_data);
                }
                // 不回滚：等待窗口里没有可归因于我们的文本变化，无法证明这张图是我们写进去的，
                // 而回滚的代价可能是抹掉用户自己刚复制的内容。用户刚选中的图片留在剪贴板里，
                // 与「复制」按钮的语义也一致。
                let info = SelectionInfo {
                    text: String::new(),
                    rect,
                    has_image: true,
                };
                Ok(Some((info, foreground.0 as isize)))
            }
            _ => {
                crate::utils::logger::log(
                    "clipboard_sel",
                    "No text or image in clipboard after Ctrl+C",
                );
                Ok(None)
            }
        }
    }
}

/// 回滚本模块自己写进剪贴板的内容（选区检测的模拟 Ctrl+C、替换文本的剪贴板粘贴），
/// **只有能确认剪贴板里现在这份内容就是我们自己写进去的**，才允许回滚：
///
/// - `saved_text`：写入前的剪贴板文本（None = 本来没有可回滚的文本）；
/// - `observed_sequence`：观察到「我们这次写入落地」时，与内容同一次读取到的剪贴板序号
///   （None = 没观察到变化，即这次模拟按键没生效）。
///
/// 为什么非要这层守卫：`wait_for_clipboard_text_changed` 在目标程序不响应注入按键时要展满
/// 500ms 才返回，而「选中 → 立刻 Ctrl+C」的间隔常常就落在这半秒里 —— 旧实现无条件把快照
/// 写回去，会把用户刚复制 / 剪切进剪贴板的内容覆盖掉，现象就是「选中文字弹出工具栏后，
/// Ctrl+C / Ctrl+X 失效」。剪切更严重：文本已从文档删除、剪贴板又被覆盖，内容直接丢失。
///
/// 与快速输入转盘的粘贴恢复是同一条约定（见 `quick_input.rs` 的 `write_sequence` 守卫）。
unsafe fn restore_clipboard_after_check(
    saved_text: Option<&str>,
    observed_sequence: Option<u32>,
) -> bool {
    let current_sequence = clipboard_sequence_number();
    if !should_restore_clipboard(saved_text, observed_sequence, current_sequence) {
        // 只在「本来确实会回滚」的场景记一条：便于事后区分「剪贴板被用户改写而放过」
        // 与「压根没检测到复制」这两种情况。
        if saved_text.is_some() && observed_sequence.is_some() {
            crate::utils::logger::log(
                "clipboard_sel",
                "clipboard changed since our write; skip restoration",
            );
        }
        return false;
    }
    restore_clipboard_text(saved_text.unwrap_or_default())
}

/// 是否可以把检测前的剪贴板快照写回去。
///
/// 抽成纯函数是为了把四种情形钉死（Win32 调用无法在单测里跑）：
/// - 没有可回滚的文本 → 不动剪贴板；
/// - 没观察到我们自己的复制落地（超时）→ 不动剪贴板（**用户 Ctrl+C / Ctrl+X 的关键保护**）；
/// - 观察到落地后无人再写 → 回滚；
/// - 观察到落地、但序号已变（用户中途自己复制/剪切过）→ 放过，绝不覆盖用户的内容。
fn should_restore_clipboard(
    saved_text: Option<&str>,
    observed_sequence: Option<u32>,
    current_sequence: u32,
) -> bool {
    match (saved_text, observed_sequence) {
        (None, _) | (_, None) => false,
        (Some(_), Some(observed)) => observed == current_sequence,
    }
}

/// 获取前台窗口的焦点控件 HWND、类名和选区位置
/// Scintilla（Notepad++）等控件响应 EM_GETSEL，可获取精确选区位置
/// 返回 (focus_hwnd, focus_class, sel_start, sel_end)，失败时 hwnd=0
unsafe fn get_focus_selection(foreground: HWND) -> (isize, String, u32, u32) {
    let thread_id = GetWindowThreadProcessId(foreground, None);
    if thread_id == 0 {
        return (0, String::new(), 0, 0);
    }
    let mut gui_info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if GetGUIThreadInfo(thread_id, &mut gui_info).is_err() {
        return (0, String::new(), 0, 0);
    }
    let focus = gui_info.hwndFocus;
    if focus.is_invalid() {
        return (0, String::new(), 0, 0);
    }
    let mut buf = [0u16; 256];
    let len = GetClassNameW(focus, &mut buf);
    let class = if len > 0 {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        String::new()
    };

    // 尝试 EM_GETSEL 读取选区位置
    let mut sel_start: u32 = 0;
    let mut sel_end: u32 = 0;
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::Controls::EM_GETSEL;

    // Scintilla 控件用 SCI 消息（字节位置），EM_GETSEL 返回的位置与
    // EM_SETSEL 接受的位置单位不一致，会导致去重等长度变化的替换定位错位
    // Scintilla 消息：SCI_GETSELSTART=2143, SCI_GETSELEND=2145
    const SCI_GETSELSTART: u32 = 2143;
    const SCI_GETSELEND: u32 = 2145;
    if class.contains("Scintilla") {
        sel_start = SendMessageW(focus, SCI_GETSELSTART, None, None).0 as u32;
        sel_end = SendMessageW(focus, SCI_GETSELEND, None, None).0 as u32;
    } else {
        let result = SendMessageW(
            focus,
            EM_GETSEL,
            Some(WPARAM(&mut sel_start as *mut u32 as usize)),
            Some(LPARAM(&mut sel_end as *mut u32 as isize)),
        );
        if sel_start == 0 && sel_end == 0 && result.0 != 0 {
            sel_start = (result.0 & 0xFFFF) as u32;
            sel_end = ((result.0 >> 16) & 0xFFFF) as u32;
        }
    }
    (focus.0 as isize, class, sel_start, sel_end)
}

/// 通过模拟 Ctrl+V 替换选中文字
/// 流程：恢复焦点 → 选中目标范围（键盘）→ 设置剪贴板 → Ctrl+V → 重选新文本（键盘）
///
/// 关键约束（实测得出）：
/// - Scintilla 的 SCI_SETSEL/EM_SETSEL 跨进程 SendMessageW 会破坏选区（设为 0..0），不可用
/// - EmptyClipboard 不会清除 Scintilla 选区，所以设置剪贴板前后选区保持
/// - 因此用键盘 Shift+Right 选中目标范围，Ctrl+V 替换，再用 Shift+Left 重选新文本
pub fn replace_text_via_clipboard(ctx: &SelectionContext, new_text: &str) -> Result<(), String> {
    unsafe {
        // 恢复前台窗口焦点
        if ctx.foreground_hwnd != 0 {
            let foreground_hwnd = HWND(ctx.foreground_hwnd as *mut std::ffi::c_void);
            let _ = SetForegroundWindow(foreground_hwnd);
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        // 选中目标范围 [sel_start, sel_end]
        // 连续替换时前次操作已重选新文本，选区正好是本次目标，无需重新选中
        // 但若选区丢失（焦点变化等），用键盘重新选中
        ensure_selection(ctx, ctx.sel_start, ctx.sel_end);

        // 保存当前剪贴板
        let saved_clipboard = save_clipboard_text();

        // 设置剪贴板为新文本（EmptyClipboard 不清除 Scintilla 选区），
        // 并**同时**取回写入后的序号：回滚时用它判断这之后有没有人再写过
        // （用户中途自己按了 Ctrl+C / Ctrl+X 就绝不回滚，见 restore_clipboard_after_check）。
        // 序号由写入函数内部紧贴采样返回 —— 不能写完再单独取一次。
        let Some(write_sequence) = set_clipboard_text(new_text) else {
            return Err("设置剪贴板失败".to_string());
        };

        // 粘贴前释放所有修饰键，防止 Ctrl 卡住导致 Ctrl+Shift+V
        release_all_modifiers();

        // 模拟 Ctrl+V
        if !simulate_paste() {
            restore_clipboard_after_check(saved_clipboard.as_deref(), Some(write_sequence));
            return Err("模拟 Ctrl+V 失败".to_string());
        }

        // 等待粘贴完成
        std::thread::sleep(std::time::Duration::from_millis(150));

        // 恢复前台焦点
        if ctx.foreground_hwnd != 0 {
            let foreground_hwnd = HWND(ctx.foreground_hwnd as *mut std::ffi::c_void);
            let _ = SetForegroundWindow(foreground_hwnd);
            std::thread::sleep(std::time::Duration::from_millis(30));
        }

        // 释放修饰键
        release_all_modifiers();

        // 重选刚粘贴的新文本：粘贴后光标在末尾，Shift+Left 向左选中
        let new_code_points = new_text.chars().count();
        if new_code_points > 0 && new_code_points <= MAX_RESELECT_CHARS {
            select_text_before_cursor(new_code_points);
            std::thread::sleep(std::time::Duration::from_millis(100));
            crate::utils::logger::log(
                "clipboard_sel",
                &format!(
                    "Re-selected via Shift+Left ({} code points)",
                    new_code_points
                ),
            );
        }

        // 恢复原始剪贴板：只在这之后没人再写过剪贴板时才恢复
        //（用户在等待期间复制了新内容时放过，避免覆盖用户的最新剪贴板）
        restore_clipboard_after_check(saved_clipboard.as_deref(), Some(write_sequence));

        crate::utils::logger::log("clipboard_sel", "Clipboard replace success");
        Ok(())
    }
}

// ─── 内部工具函数 ────────────────────────────────────────────────

/// 保存当前剪贴板的文本内容
unsafe fn save_clipboard_text() -> Option<String> {
    if OpenClipboard(None).is_err() {
        return None;
    }
    let result = read_clipboard_text_locked();
    let _ = CloseClipboard();
    result
}

/// 在**已打开**剪贴板的状态下读取文本（Open/Close 由调用方负责）。
///
/// 需要「已打开」这一前提的场景是「文本 + 剪贴板序号」成对采样：持有剪贴板期间没有别的
/// 进程能改写内容，所以同一次锁内读到的文本与序号严格属于同一份剪贴板状态
/// （见 `wait_for_clipboard_text_changed`）。
unsafe fn read_clipboard_text_locked() -> Option<String> {
    let handle = GetClipboardData(CF_UNICODETEXT).ok()?;
    if handle.is_invalid() {
        return None;
    }
    let hmem = HGLOBAL(handle.0);
    let ptr = GlobalLock(hmem);
    if ptr.is_null() {
        return None;
    }
    let mem_size = GlobalSize(hmem);
    // GlobalSize == 0 说明句柄不可信（拿不到边界）。**不能**回退成「按 MAX_CLIPBOARD_U16
    // 一路扫到 NUL」—— 那是拿一个未知边界去读内存，越界就是访问违例。剪贴板里的文本句柄
    // 正常时必然取得到大小，取不到即视为本次读取失败（调用方按「剪贴板里没有文本」处理，
    // 与 `clipboard::manager` 的 `read_text_inner` 保持同一口径）。
    if mem_size == 0 {
        let _ = GlobalUnlock(hmem);
        return None;
    }
    let text = read_u16_string(ptr, (mem_size / 2).min(MAX_CLIPBOARD_U16));
    let _ = GlobalUnlock(hmem);
    text
}

/// 恢复剪贴板文本
unsafe fn restore_clipboard_text(text: &str) -> bool {
    write_clipboard_text(text).is_some()
}

/// 设置剪贴板为指定文本，返回**写入后**的剪贴板序号（`None` = 写入失败）。
///
/// 调用方拿到序号后才能在回滚时判断「这之后有没有人再写过剪贴板」。
/// 序号必须紧贴写入采样 —— 见 [`write_clipboard_text`] 的注释。
unsafe fn set_clipboard_text(text: &str) -> Option<u32> {
    write_clipboard_text(text)
}

/// 写入文本到剪贴板（公开，供 quick_input 模块调用）
pub unsafe fn set_clipboard_text_pub(text: &str) -> bool {
    write_clipboard_text(text).is_some()
}

/// 写入文本到剪贴板（内部公共实现）。
///
/// 返回 `Some(写入后的剪贴板序号)` / `None`（失败）。
/// **序号在这里就取**，而不是让调用方写完再单独调 `clipboard_sequence_number()`：
/// 那样两次调用之间若有人（用户自己按 Ctrl+C）写了剪贴板，拿到的是**对方**的序号，
/// 之后 `current == write_sequence` 会误判「没人改过」，回滚时把用户自己的复制覆盖掉。
unsafe fn write_clipboard_text(text: &str) -> Option<u32> {
    // ★ 先在私有内存里备好数据，再打开 / 清空剪贴板：分配或复制失败时，用户
    //   原来的剪贴板内容还没被动过。原来的顺序是先 EmptyClipboard 再分配，
    //   分配一失败原有内容就永久丢失了。
    let utf16: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let byte_len = utf16.len() * 2;
    let hmem = match GlobalAlloc(GMEM_MOVEABLE, byte_len) {
        Ok(handle) => handle,
        Err(_) => return None,
    };
    let ptr = GlobalLock(hmem);
    if ptr.is_null() {
        // GlobalLock 失败，hmem 仍有效但无法写入，必须释放避免泄漏
        let _ = windows::Win32::Foundation::GlobalFree(Some(hmem));
        return None;
    }
    std::ptr::copy_nonoverlapping(utf16.as_ptr(), ptr as *mut u16, utf16.len());
    let _ = GlobalUnlock(hmem);

    // 标记为应用自写：剪贴板监听器（WM_CLIPBOARDUPDATE）据此跳过，
    // 避免把粘贴/替换/恢复的原内容误入快速输入转盘历史。只在实际要写之前标记，
    // 分配失败时不留一个没有对应剪贴板事件的陈旧标记。
    crate::clipboard::listener::mark_self_write(text);

    if OpenClipboard(None).is_err() {
        let _ = windows::Win32::Foundation::GlobalFree(Some(hmem));
        return None;
    }
    if EmptyClipboard().is_err() {
        let _ = windows::Win32::Foundation::GlobalFree(Some(hmem));
        let _ = CloseClipboard();
        return None;
    }
    let set_ok = SetClipboardData(CF_UNICODETEXT, Some(HANDLE(hmem.0))).is_ok();
    if !set_ok {
        let _ = windows::Win32::Foundation::GlobalFree(Some(hmem));
    }
    let _ = CloseClipboard();
    set_ok.then(|| clipboard_sequence_number())
}

/// 模拟 Ctrl+C 按键
pub unsafe fn simulate_copy() -> bool {
    simulate_key_combo(VK_CONTROL, 0x43) // 0x43 = 'C'
}

/// 模拟 Ctrl+V 按键（公开，供 quick_input 模块调用）
pub unsafe fn simulate_paste() -> bool {
    simulate_key_combo(VK_CONTROL, 0x56) // 0x56 = 'V'
}

/// 模拟 Ctrl+V，并恢复调用前用户实际按下的修饰键。
pub unsafe fn simulate_paste_preserving_modifiers() -> bool {
    let modifier_state = capture_modifier_state();
    let complete = simulate_paste();
    restore_modifier_state(modifier_state);
    complete
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnicodeInputResult {
    Complete,
    Partial,
    Failed,
}

/// 直接向当前焦点窗口注入 Unicode 文本，不经过剪贴板。
///
/// 这条路径专供快速输入使用：部分终端/AI 工具把 Ctrl+V 定义为图片粘贴，
/// 此时即使剪贴板中是 CF_UNICODETEXT，也会被目标程序按图片格式读取。
/// KEYEVENTF_UNICODE 发送 WM_CHAR，不会触发这些 Ctrl+V 的特殊语义。
pub unsafe fn simulate_unicode_text(text: &str) -> UnicodeInputResult {
    if text.is_empty() {
        return UnicodeInputResult::Complete;
    }

    let modifier_state = capture_modifier_state();
    release_all_modifiers();

    let units: Vec<u16> = text.encode_utf16().collect();
    let mut inputs = Vec::with_capacity(units.len() * 2);
    for unit in units {
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: unit,
                    dwFlags: KEYEVENTF_UNICODE,
                    ..Default::default()
                },
            },
        });
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: unit,
                    dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                    ..Default::default()
                },
            },
        });
    }

    let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    restore_modifier_state(modifier_state);
    if sent == inputs.len() as u32 {
        UnicodeInputResult::Complete
    } else if sent > 0 {
        UnicodeInputResult::Partial
    } else {
        UnicodeInputResult::Failed
    }
}

/// 模拟常见终端的「粘贴纯文本」快捷键。
/// 与 Ctrl+V 区分，避免触发 Codex 等工具的图片粘贴处理。
pub unsafe fn simulate_text_paste() -> bool {
    let modifier_state = capture_modifier_state();
    release_all_modifiers();
    let inputs = [
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_CONTROL,
                    ..Default::default()
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_SHIFT,
                    ..Default::default()
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0x56),
                    ..Default::default()
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0x56),
                    dwFlags: KEYEVENTF_KEYUP,
                    ..Default::default()
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_SHIFT,
                    dwFlags: KEYEVENTF_KEYUP,
                    ..Default::default()
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_CONTROL,
                    dwFlags: KEYEVENTF_KEYUP,
                    ..Default::default()
                },
            },
        },
    ];
    let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    let complete = sent == inputs.len() as u32;
    if !complete {
        // 部分发送可能只注入了 Ctrl/Shift 的按下事件，立即清理，避免按键卡住。
        release_all_modifiers();
    }
    restore_modifier_state(modifier_state);
    complete
}

/// 返回当前前台窗口句柄，供异步输入在真正发送前校验焦点是否变化。
pub unsafe fn foreground_window_handle() -> isize {
    GetForegroundWindow().0 as isize
}

/// 捕获调用前真实处于按下状态的修饰键。
unsafe fn capture_modifier_state() -> u8 {
    let keys = [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN];
    let mut state = 0u8;
    for (index, key) in keys.into_iter().enumerate() {
        if GetAsyncKeyState(key.0 as i32) < 0 {
            state |= 1 << index;
        }
    }
    state
}

/// 恢复之前捕获的修饰键状态。
unsafe fn restore_modifier_state(state: u8) {
    let keys = [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN];
    let mut inputs = Vec::new();
    for (index, key) in keys.into_iter().enumerate() {
        if state & (1 << index) != 0 {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: key,
                        ..Default::default()
                    },
                },
            });
        }
    }
    if !inputs.is_empty() {
        let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

/// 判断当前前台窗口是否是常见终端宿主。
/// 终端中的多行文本应使用 Ctrl+Shift+V，避免 Unicode 注入把换行当成提交。
pub unsafe fn foreground_is_terminal_like() -> bool {
    let hwnd = GetForegroundWindow();
    if hwnd.is_invalid() {
        return false;
    }
    let mut buf = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut buf);
    if len <= 0 {
        return false;
    }
    let class = String::from_utf16_lossy(&buf[..len as usize]);
    is_terminal_window_class(&class)
}

fn is_terminal_window_class(class: &str) -> bool {
    matches!(
        class,
        "CASCADIA_HOSTING_WINDOW_CLASS"
            | "ConsoleWindowClass"
            | "mintty"
            | "Alacritty"
            | "org.wezfurlong.wezterm"
    )
}

/// 获取剪贴板序列号，用于判断异步粘贴期间用户是否写入了新内容。
pub unsafe fn clipboard_sequence_number() -> u32 {
    GetClipboardSequenceNumber()
}

/// 释放所有修饰键（Ctrl/Shift/Alt），防止按键卡住影响后续操作
pub(crate) unsafe fn release_all_modifiers() {
    let modifiers = [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN];
    let mut inputs = Vec::with_capacity(modifiers.len());
    for m in modifiers {
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: m,
                    dwFlags: KEYEVENTF_KEYUP,
                    ..Default::default()
                },
            },
        });
    }
    let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    std::thread::sleep(std::time::Duration::from_millis(30));
}

/// 确保目标范围 [sel_start, sel_end] 被选中
/// 连续替换时，前次操作已用 Shift+Left 重选新文本，当前选区即为目标，无需操作
/// 此函数仅记录诊断信息；若选区丢失（如焦点变化），无法可靠恢复
unsafe fn ensure_selection(ctx: &SelectionContext, _sel_start: u32, _sel_end: u32) {
    if let Some((s, e)) = read_actual_selection(ctx.focus_hwnd, &ctx.focus_class) {
        if s == 0 && e == 0 {
            crate::utils::logger::log("clipboard_sel", "Warning: selection lost before replace");
        }
    }
}

/// 读取控件当前实际选区位置（用于替换后更新上下文，避免换行符导致的位置计算偏差）
/// - Scintilla：SCI_GETSELSTART/SCI_GETSELEND（字节位置）
/// - EDIT/RICHEDIT：EM_GETSEL（UTF-16 位置）
pub unsafe fn read_actual_selection(focus_hwnd: isize, focus_class: &str) -> Option<(u32, u32)> {
    if focus_hwnd == 0 {
        return None;
    }
    let hwnd = HWND(focus_hwnd as *mut std::ffi::c_void);
    const SCI_GETSELSTART: u32 = 2143;
    const SCI_GETSELEND: u32 = 2145;
    if focus_class.contains("Scintilla") {
        let s = SendMessageW(hwnd, SCI_GETSELSTART, None, None).0 as u32;
        let e = SendMessageW(hwnd, SCI_GETSELEND, None, None).0 as u32;
        Some((s, e))
    } else {
        let (s, e) = read_sel(focus_hwnd);
        Some((s, e))
    }
}

/// 读取控件当前选区位置（EM_GETSEL），用于诊断
unsafe fn read_sel(focus_hwnd: isize) -> (u32, u32) {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::Controls::EM_GETSEL;
    if focus_hwnd == 0 {
        return (0, 0);
    }
    let hwnd = HWND(focus_hwnd as *mut std::ffi::c_void);
    let mut sel_start: u32 = 0;
    let mut sel_end: u32 = 0;
    let result = SendMessageW(
        hwnd,
        EM_GETSEL,
        Some(WPARAM(&mut sel_start as *mut u32 as usize)),
        Some(LPARAM(&mut sel_end as *mut u32 as isize)),
    );
    if sel_start == 0 && sel_end == 0 && result.0 != 0 {
        sel_start = (result.0 & 0xFFFF) as u32;
        sel_end = ((result.0 >> 16) & 0xFFFF) as u32;
    }
    (sel_start, sel_end)
}

/// 模拟 Shift+Left 选中光标左侧的指定字符数
/// 超过 MAX_RESELECT_CHARS 时跳过重选，避免大量 SendInput 导致丢键
const MAX_RESELECT_CHARS: usize = 200;
unsafe fn select_text_before_cursor(char_count: usize) {
    if char_count > MAX_RESELECT_CHARS {
        crate::utils::logger::log(
            "clipboard_sel",
            &format!(
                "Skip re-select: {} chars exceeds max {}",
                char_count, MAX_RESELECT_CHARS
            ),
        );
        return;
    }
    // Shift down → N次 Left down/up → Shift up
    let mut inputs = Vec::with_capacity(2 + char_count * 2);
    // Shift down
    inputs.push(INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_SHIFT,
                ..Default::default()
            },
        },
    });
    // N 次 Left
    for _ in 0..char_count {
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_LEFT,
                    ..Default::default()
                },
            },
        });
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_LEFT,
                    dwFlags: KEYEVENTF_KEYUP,
                    ..Default::default()
                },
            },
        });
    }
    // Shift up
    inputs.push(INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_SHIFT,
                dwFlags: KEYEVENTF_KEYUP,
                ..Default::default()
            },
        },
    });
    let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
}

/// 模拟 Ctrl+Key 组合键
unsafe fn simulate_key_combo(modifier: VIRTUAL_KEY, key: u16) -> bool {
    // 先释放所有修饰键，防止前次操作遗留卡住的 Ctrl/Shift/Alt/Win
    // 导致本次组合键变形（如 Ctrl+C 变成 Ctrl+Shift+C 或 Shift+C），复制/粘贴失效
    release_all_modifiers();

    let inputs = [
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: modifier,
                    ..Default::default()
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(key),
                    ..Default::default()
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(key),
                    dwFlags: KEYEVENTF_KEYUP,
                    ..Default::default()
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: modifier,
                    dwFlags: KEYEVENTF_KEYUP,
                    ..Default::default()
                },
            },
        },
    ];

    let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    let complete = sent == inputs.len() as u32;
    if !complete {
        release_all_modifiers();
    }
    complete
}

/// 等待剪贴板中出现与旧内容不同的文本，返回 `(新文本, 该内容对应的剪贴板序号)`。
///
/// 序号与文本在**同一次 Open/Close 内**读取：持有剪贴板期间别的进程无法改写，两者因此
/// 严格对应同一份剪贴板状态。调用方用这个序号判断「从观察到这一刻起，有没有人再写过剪贴板」
/// （见 `restore_clipboard_after_check`），这一步是「不覆盖用户自己复制的内容」的关键。
///
/// 防止 simulate_copy 未生效时返回剪贴板中的残留数据
unsafe fn wait_for_clipboard_text_changed(
    max_ms: u32,
    old_text: Option<&str>,
) -> Option<(String, u32)> {
    let mut elapsed = 0;
    while elapsed < max_ms {
        std::thread::sleep(std::time::Duration::from_millis(10));
        elapsed += 10;

        if OpenClipboard(None).is_err() {
            continue;
        }
        let text = read_clipboard_text_locked();
        let sequence = clipboard_sequence_number();
        let _ = CloseClipboard();

        if let Some(text) = text {
            if !text.is_empty() && Some(text.as_str()) != old_text {
                return Some((text, sequence));
            }
        }
    }
    None
}

/// 从内存指针读取 UTF-16 字符串，带长度上限保护
/// #1: 防止损坏数据导致越界读取
unsafe fn read_u16_string(ptr: *mut core::ffi::c_void, max_u16: usize) -> Option<String> {
    let mut len = 0usize;
    let mut p = ptr as *const u16;
    while len < max_u16 && *p != 0 {
        len += 1;
        p = p.add(1);
    }
    if len == 0 {
        return None;
    }
    let slice = std::slice::from_raw_parts(ptr as *const u16, len);
    Some(String::from_utf16_lossy(slice))
}

/// #11: 检测目标窗口所属进程是否以管理员权限运行
/// 通过 OpenProcess + GetTokenInformation 检查 elevation 状态
unsafe fn is_elevated_window(hwnd: HWND) -> bool {
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return false;
    }

    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };

    let process = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
        Ok(h) => h,
        Err(_) => return false,
    };

    let mut token = windows::Win32::Foundation::HANDLE::default();
    let elevated = if OpenProcessToken(process, TOKEN_QUERY, &mut token).is_ok() {
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut ret_len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut ret_len,
        );
        let _ = CloseHandle(token);
        ok.is_ok() && elevation.TokenIsElevated != 0
    } else {
        false
    };

    let _ = CloseHandle(process);
    elevated
}

/// 读取剪贴板中的图片数据（CF_DIB 格式）
/// 返回图片的原始字节数据
/// # Safety
/// 调用者需确保在合适的时机调用（会打开和关闭剪贴板）
pub(crate) unsafe fn read_clipboard_image() -> Option<Vec<u8>> {
    if OpenClipboard(None).is_err() {
        return None;
    }

    let result = (|| -> Option<Vec<u8>> {
        let handle = GetClipboardData(CF_DIB).ok()?;
        if handle.is_invalid() {
            return None;
        }
        let hmem = HGLOBAL(handle.0);
        let ptr = GlobalLock(hmem);
        if ptr.is_null() {
            return None;
        }
        let size = GlobalSize(hmem);
        if size == 0 || size > MAX_CLIPBOARD_DIB_BYTES {
            let _ = GlobalUnlock(hmem);
            return None;
        }
        let data = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
        let _ = GlobalUnlock(hmem);
        Some(data)
    })();

    let _ = CloseClipboard();
    result
}

/// 将 CF_DIB 图片数据写入剪贴板
#[allow(dead_code)]
pub fn write_clipboard_image(dib_data: &[u8]) -> bool {
    unsafe {
        if OpenClipboard(None).is_err() {
            return false;
        }

        let _ = EmptyClipboard();

        let hmem = match GlobalAlloc(GMEM_MOVEABLE, dib_data.len()) {
            Ok(h) => h,
            Err(_) => {
                let _ = CloseClipboard();
                return false;
            }
        };
        let ptr = GlobalLock(hmem);
        if ptr.is_null() {
            let _ = windows::Win32::Foundation::GlobalFree(Some(hmem));
            let _ = CloseClipboard();
            return false;
        }
        std::ptr::copy_nonoverlapping(dib_data.as_ptr(), ptr as *mut u8, dib_data.len());
        let _ = GlobalUnlock(hmem);
        let set_ok = SetClipboardData(CF_DIB, Some(HANDLE(hmem.0))).is_ok();
        if !set_ok {
            let _ = windows::Win32::Foundation::GlobalFree(Some(hmem));
        }
        let _ = CloseClipboard();
        set_ok
    }
}

/// 恢复快速输入前保存的文本和 DIB 图片格式。
/// 两种格式必须在同一次 OpenClipboard 中写入，否则后写入的格式会清掉先前内容。
pub unsafe fn restore_clipboard_snapshot(text: Option<&str>, dib_data: Option<&[u8]>) -> bool {
    if text.is_none() && dib_data.is_none() {
        return false;
    }
    if let Some(text) = text {
        crate::clipboard::listener::mark_self_write(text);
    }
    if OpenClipboard(None).is_err() {
        return false;
    }
    let _ = EmptyClipboard();
    let mut all_ok = true;

    let mut write_format = |format: u32, data: &[u8]| {
        let hmem = match GlobalAlloc(GMEM_MOVEABLE, data.len()) {
            Ok(h) => h,
            Err(_) => {
                all_ok = false;
                return;
            }
        };
        let ptr = GlobalLock(hmem);
        if ptr.is_null() {
            let _ = windows::Win32::Foundation::GlobalFree(Some(hmem));
            all_ok = false;
            return;
        }
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr as *mut u8, data.len());
        let _ = GlobalUnlock(hmem);
        if SetClipboardData(format, Some(HANDLE(hmem.0))).is_err() {
            let _ = windows::Win32::Foundation::GlobalFree(Some(hmem));
            all_ok = false;
        }
    };

    if let Some(text) = text {
        let utf16: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        write_format(
            CF_UNICODETEXT,
            std::slice::from_raw_parts(
                utf16.as_ptr() as *const u8,
                utf16.len() * std::mem::size_of::<u16>(),
            ),
        );
    }
    if let Some(dib_data) = dib_data {
        write_format(CF_DIB, dib_data);
    }

    let _ = CloseClipboard();
    all_ok
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── 常量 ─────────────────────────────────────────────────────

    #[test]
    fn test_constants() {
        assert_eq!(CF_UNICODETEXT, 13);
        assert_eq!(MAX_CLIPBOARD_U16, 1024 * 1024);
    }

    #[test]
    fn terminal_window_class_detection_covers_supported_hosts() {
        for class in [
            "CASCADIA_HOSTING_WINDOW_CLASS",
            "ConsoleWindowClass",
            "mintty",
            "Alacritty",
            "org.wezfurlong.wezterm",
        ] {
            assert!(is_terminal_window_class(class), "{class}");
        }
        assert!(!is_terminal_window_class("Notepad"));
        assert!(!is_terminal_window_class("Chrome_WidgetWin_1"));
    }

    // ─── read_u16_string ──────────────────────────────────────────

    #[test]
    fn test_read_u16_string_null_ptr() {
        // 无效指针 + max_u16=0 应返回 None（不 panic）
        let result = unsafe { read_u16_string(std::ptr::null_mut(), 0) };
        assert!(result.is_none());
    }

    #[test]
    fn test_read_u16_string_zero_max() {
        // max_u16 = 0 → 即使指针有效也返回 None
        let mut dummy = [0u16; 4];
        let result = unsafe { read_u16_string(dummy.as_mut_ptr() as *mut _, 0) };
        assert!(result.is_none());
    }

    // ─── 剪贴板回滚守卫 ───────────────────────────────────────────

    /// 去掉整行注释后再做源码断言：注释里提到某个调用名不该让哨兵误判
    /// （与 `utils/process.rs` 的守卫同一手法）。
    fn strip_line_comments(source: &str) -> String {
        source
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 取出某个顶层函数（从签名到列 0 的收尾大括号）的函数体源码。
    fn function_body<'a>(source: &'a str, signature: &str) -> &'a str {
        let after = source
            .split(signature)
            .nth(1)
            .unwrap_or_else(|| panic!("{signature} 不见了：本哨兵依赖它仍在本文件内"));
        &after[..after.find("\n}").unwrap_or(after.len())]
    }

    /// 用户报的「选中文字弹出工具栏后，Ctrl+C / Ctrl+X 复制剪切失效」就是这条：
    /// 模拟 Ctrl+C 没生效（等待超时）时绝不能回滚，否则会把用户在这半秒里自己写进
    /// 剪贴板的内容覆盖掉。
    #[test]
    fn should_restore_clipboard_skips_when_our_copy_never_landed() {
        assert!(!should_restore_clipboard(Some("原内容"), None, 100));
    }

    #[test]
    fn should_restore_clipboard_skips_without_saved_text() {
        // 本来就没有可回滚的文本（例如剪贴板里只有图片）
        assert!(!should_restore_clipboard(None, Some(100), 100));
        assert!(!should_restore_clipboard(None, None, 100));
    }

    #[test]
    fn should_restore_clipboard_restores_when_nothing_wrote_since() {
        // 观察到我们自己的复制落地（序号 100），且此后无人再写 → 可以回滚
        assert!(should_restore_clipboard(Some("原内容"), Some(100), 100));
    }

    #[test]
    fn should_restore_clipboard_skips_when_user_copied_meanwhile() {
        // 观察到落地时序号 100，现在已是 101：这半秒里有人写过剪贴板
        //（用户自己按了 Ctrl+C / Ctrl+X）→ 放过，绝不覆盖用户的内容
        assert!(!should_restore_clipboard(Some("原内容"), Some(100), 101));
    }

    /// 源码级哨兵：选区检测路径不得再出现「无条件回滚快照」的写法。
    /// 变异（把 restore_clipboard_after_check 换回 `if let Some(ref saved) = ... { restore_clipboard_text(saved) }`）
    /// 必须让这条变红。
    #[test]
    fn selection_check_never_restores_the_clipboard_unconditionally() {
        let source = include_str!("clipboard_selection.rs");
        let body = strip_line_comments(function_body(source, "pub fn get_selection_via_clipboard"));
        assert!(
            body.contains("restore_clipboard_after_check("),
            "检测路径的回滚必须走带守卫的 restore_clipboard_after_check"
        );
        assert!(
            !body.contains("restore_clipboard_text("),
            "不要在检测路径里直接回滚：没有序号守卫就会覆盖用户自己复制的内容"
        );
        assert!(
            body.contains("wait_for_clipboard_text_changed("),
            "回滚依据必须来自「观察到我们自己的复制落地」"
        );
    }

    /// 源码级哨兵：「文本 + 序号」必须同锁采样。
    /// 分两次读（读完文本先 CloseClipboard 再取序号）会让「这以后有没有人写过」的判断
    /// 出现空窗，守卫就会失效。
    #[test]
    fn clipboard_text_and_sequence_are_read_under_one_lock() {
        let source = include_str!("clipboard_selection.rs");
        let body = strip_line_comments(function_body(
            source,
            "unsafe fn wait_for_clipboard_text_changed",
        ));
        let text_read = body
            .find("read_clipboard_text_locked()")
            .expect("必须用「已打开剪贴板」版本的读取函数");
        let sequence_read = body
            .find("clipboard_sequence_number()")
            .expect("必须同锁读取剪贴板序号");
        let close = body
            .find("CloseClipboard()")
            .expect("循环里必须显式关闭剪贴板");
        assert!(
            text_read < sequence_read && sequence_read < close,
            "文本与序号必须在同一次 Open/Close 之间读取"
        );
    }

    // ─── 虚拟键码 ────────────────────────────────────────────────

    #[test]
    fn test_vk_control_value() {
        // VK_CONTROL = 0x11，Ctrl 键虚拟键码
        assert_eq!(VK_CONTROL.0, 0x11);
    }

    #[test]
    fn test_c_key_code() {
        // 0x43 = 'C'，用于 simulate_copy
        assert_eq!(0x43u16, b'C' as u16);
    }

    #[test]
    fn test_v_key_code() {
        // 0x56 = 'V'，用于 simulate_paste
        assert_eq!(0x56u16, b'V' as u16);
    }
}
