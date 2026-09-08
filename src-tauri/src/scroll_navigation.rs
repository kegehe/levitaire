use serde::Serialize;
use std::sync::atomic::{AtomicIsize, Ordering};
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX, COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationScrollPattern,
    UIA_ScrollPatternId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, SetFocus, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL,
    VK_END, VK_HOME, VK_NEXT, VK_PRIOR,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetForegroundWindow, GetWindowThreadProcessId, IsWindow, SetForegroundWindow,
    GA_ROOT,
};
const UIA_NO_SCROLL: f64 = -1.0;
static TARGET_HWND: AtomicIsize = AtomicIsize::new(0);
static LAST_EXTERNAL_TARGET: AtomicIsize = AtomicIsize::new(0);

fn clamp_percent(percent: f64) -> Result<f64, String> {
    percent
        .is_finite()
        .then_some(percent.clamp(0.0, 100.0))
        .ok_or_else(|| "滚动百分比必须是有效数字".to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollNavigationState {
    pub precise: bool,
    pub percent: Option<f64>,
    pub fallback_available: bool,
}

fn is_levitaire_window(app: &AppHandle, hwnd: HWND) -> bool {
    if hwnd.is_invalid() {
        return false;
    }
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    let root = if root.is_invalid() { hwnd } else { root };
    [
        "orb",
        "toolbar",
        "palette",
        "settings",
        "tool-config",
        "context-menu",
        "pin-ocr",
        "update-prompt",
        "screenshot-overlay",
        "recording-controls",
        "long-capture-controls",
        "long-capture-frame",
        "monitor-overlay",
        "pomodoro-overlay",
        "quick-input-overlay",
        "time-overlay",
        "todo-overlay",
        "sketch-overlay",
        "scroll-navigator-overlay",
        "utility-hub-overlay",
    ]
    .iter()
    .any(|label| {
        app.get_webview_window(label)
            .and_then(|window| window.hwnd().ok())
            .is_some_and(|candidate| {
                let candidate_root = unsafe { GetAncestor(candidate, GA_ROOT) };
                let candidate_root = if candidate_root.is_invalid() {
                    candidate
                } else {
                    candidate_root
                };
                candidate_root == root
            })
    })
}

pub fn capture_current_target(app: &AppHandle) {
    // Hiding the palette and restoring focus is asynchronous on Windows. Give
    // the shell a short window to complete that transition before sampling the
    // target, otherwise the palette itself is saved as the scroll destination.
    for _ in 0..12 {
        let foreground = unsafe { GetForegroundWindow() };
        if !foreground.is_invalid() && !is_levitaire_window(app, foreground) {
            TARGET_HWND.store(foreground.0 as isize, Ordering::SeqCst);
            LAST_EXTERNAL_TARGET.store(foreground.0 as isize, Ordering::SeqCst);
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    // Windows may have already activated the orb by the time this function is
    // called. Reuse the last known external foreground window in that case.
    let previous = LAST_EXTERNAL_TARGET.load(Ordering::SeqCst);
    if previous != 0 {
        let hwnd = HWND(previous as *mut std::ffi::c_void);
        if unsafe { IsWindow(Some(hwnd)).as_bool() } {
            TARGET_HWND.store(previous, Ordering::SeqCst);
        }
    }
}

/// Save the HWND that was foreground at the exact mouse-down instant. The
/// caller supplies the value from `MSLLHOOKSTRUCT` because reading
/// `GetForegroundWindow` later on the receiver thread can observe the orb
/// after Windows has already activated it.
pub fn remember_foreground_snapshot(app: &AppHandle, value: isize) {
    if value == 0 {
        return;
    }
    let foreground = HWND(value as *mut std::ffi::c_void);
    if foreground.is_invalid() || is_levitaire_window(app, foreground) {
        return;
    }
    LAST_EXTERNAL_TARGET.store(value, Ordering::SeqCst);
    TARGET_HWND.store(value, Ordering::SeqCst);
}

fn target_window() -> Option<HWND> {
    let saved = HWND(TARGET_HWND.load(Ordering::SeqCst) as *mut std::ffi::c_void);
    if !saved.is_invalid() && unsafe { IsWindow(Some(saved)).as_bool() } {
        return Some(saved);
    }
    // The target is captured before the palette/overlay takes focus. Do not
    // fall back to the current foreground window here: after the target exits,
    // that would be the navigator itself and keyboard fallback could operate
    // on Levitaire rather than reporting that no target remains.
    None
}

unsafe fn find_scroll_pattern(
    automation: &IUIAutomation,
    element: &IUIAutomationElement,
    depth: u8,
) -> Option<IUIAutomationScrollPattern> {
    if let Ok(pattern) =
        element.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
    {
        if pattern.CurrentVerticallyScrollable().ok()?.as_bool() {
            return Some(pattern);
        }
    }
    if depth == 0 {
        return None;
    }
    let walker = automation.ControlViewWalker().ok()?;
    let mut child = walker.GetFirstChildElement(element).ok()?;
    loop {
        if let Some(pattern) = find_scroll_pattern(automation, &child, depth - 1) {
            return Some(pattern);
        }
        match walker.GetNextSiblingElement(&child) {
            Ok(next) => child = next,
            Err(_) => break,
        }
    }
    None
}

fn with_scroll_pattern<T>(
    operation: impl FnOnce(IUIAutomationScrollPattern) -> Result<T, String>,
) -> Result<T, String> {
    let target = target_window().ok_or_else(|| "未找到可控制的目标窗口".to_string())?;
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let result = (|| {
            let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX(0x1))
                .map_err(|error| format!("无法初始化 Windows 自动化服务: {error}"))?;
            let root = automation
                .ElementFromHandle(target)
                .map_err(|error| format!("无法读取目标窗口: {error}"))?;
            let pattern = find_scroll_pattern(&automation, &root, 14)
                .ok_or_else(|| "目标窗口未提供可精确控制的垂直滚动条".to_string())?;
            operation(pattern)
        })();
        if initialized {
            CoUninitialize();
        }
        result
    }
}

fn precise_state() -> Result<ScrollNavigationState, String> {
    with_scroll_pattern(|pattern| unsafe {
        let percent = pattern
            .CurrentVerticalScrollPercent()
            .map_err(|error| format!("无法读取滚动位置: {error}"))?;
        Ok(ScrollNavigationState {
            precise: percent.is_finite() && percent >= 0.0 && percent != UIA_NO_SCROLL,
            percent: (percent.is_finite() && percent >= 0.0 && percent != UIA_NO_SCROLL)
                .then_some(percent.clamp(0.0, 100.0)),
            fallback_available: true,
        })
    })
}

pub fn state() -> ScrollNavigationState {
    precise_state().unwrap_or(ScrollNavigationState {
        precise: false,
        percent: None,
        fallback_available: target_window().is_some(),
    })
}

pub fn set_percent(percent: f64) -> Result<ScrollNavigationState, String> {
    let percent = clamp_percent(percent)?;
    with_scroll_pattern(|pattern| unsafe {
        pattern
            .SetScrollPercent(UIA_NO_SCROLL, percent)
            .map_err(|error| format!("无法设置滚动位置: {error}"))?;
        let actual = pattern
            .CurrentVerticalScrollPercent()
            .unwrap_or(percent)
            .clamp(0.0, 100.0);
        Ok(ScrollNavigationState {
            precise: true,
            percent: Some(actual),
            fallback_available: true,
        })
    })
}

unsafe fn activate_target(target: HWND) -> bool {
    let current_thread = GetCurrentThreadId();
    let target_thread = GetWindowThreadProcessId(target, None);
    let attached = target_thread != 0
        && target_thread != current_thread
        && AttachThreadInput(current_thread, target_thread, true).as_bool();
    let activated = SetForegroundWindow(target).as_bool();
    if activated {
        let _ = SetFocus(Some(target));
    }
    if attached {
        let _ = AttachThreadInput(current_thread, target_thread, false);
    }
    activated
}

fn send_navigation_keys(
    modifier: Option<windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY>,
    key: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY,
) -> Result<(), String> {
    let target = target_window().ok_or_else(|| "未找到可控制的目标窗口".to_string())?;
    unsafe {
        if !activate_target(target) {
            return Err("无法激活目标窗口".to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
        // Terminal applications use Ctrl+Home/Ctrl+End to move through the
        // scrollback buffer. A plain Home/End only moves the shell cursor.
        let inputs: Vec<INPUT> = if let Some(modifier) = modifier {
            vec![
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
                            wVk: key,
                            ..Default::default()
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: key,
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
            ]
        } else {
            vec![
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: key,
                            ..Default::default()
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: key,
                            dwFlags: KEYEVENTF_KEYUP,
                            ..Default::default()
                        },
                    },
                },
            ]
        };
        if SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) != inputs.len() as u32 {
            return Err("无法向目标窗口发送滚动按键".to_string());
        }
    }
    Ok(())
}

pub fn navigate(action: &str) -> Result<ScrollNavigationState, String> {
    match action {
        "top" => set_percent(0.0)
            .or_else(|_| send_navigation_keys(Some(VK_CONTROL), VK_HOME).map(|_| state())),
        "bottom" => set_percent(100.0)
            .or_else(|_| send_navigation_keys(Some(VK_CONTROL), VK_END).map(|_| state())),
        "page-up" => send_navigation_keys(None, VK_PRIOR).map(|_| state()),
        "page-down" => send_navigation_keys(None, VK_NEXT).map(|_| state()),
        _ => Err("未知的滚动操作".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::clamp_percent;

    #[test]
    fn percent_is_clamped_by_public_contract() {
        assert_eq!(clamp_percent(-12.0).unwrap(), 0.0);
        assert_eq!(clamp_percent(145.0).unwrap(), 100.0);
        assert!(clamp_percent(f64::NAN).is_err());
    }
}
