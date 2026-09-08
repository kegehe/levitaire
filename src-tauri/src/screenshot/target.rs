//! Native target hit-testing used by smart screenshot selection.

use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::{HWND, POINT, RECT};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TargetScope {
    Element,
    Window,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotTarget {
    pub kind: TargetScope,
    pub hwnd: isize,
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
    pub control_type: Option<i32>,
    pub name: Option<String>,
}

fn rect_target(
    kind: TargetScope,
    hwnd: HWND,
    rect: RECT,
    control_type: Option<i32>,
    name: Option<String>,
) -> Option<ScreenshotTarget> {
    let width = rect.right.saturating_sub(rect.left);
    let height = rect.bottom.saturating_sub(rect.top);
    if width < 4 || height < 4 {
        return None;
    }
    Some(ScreenshotTarget {
        kind,
        hwnd: hwnd.0 as isize,
        left: rect.left,
        top: rect.top,
        width: width as u32,
        height: height as u32,
        control_type,
        name,
    })
}

#[cfg(target_os = "windows")]
fn is_usable_window(hwnd: HWND) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{IsWindow, IsWindowVisible};
    unsafe { IsWindow(Some(hwnd)).as_bool() && IsWindowVisible(hwnd).as_bool() }
}

#[cfg(target_os = "windows")]
fn window_title(hwnd: HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowTextW;
    let mut buf = [0u16; 512];
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..len.max(0) as usize])
}

#[cfg(target_os = "windows")]
fn root_window_at(point: POINT) -> Option<HWND> {
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT};
    unsafe {
        let child = WindowFromPoint(point);
        if child.0.is_null() {
            return None;
        }
        let root = GetAncestor(child, GA_ROOT);
        let hwnd = if root.0.is_null() { child } else { root };
        is_usable_window(hwnd).then_some(hwnd)
    }
}

#[cfg(target_os = "windows")]
fn window_target(point: POINT) -> Option<ScreenshotTarget> {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
    let hwnd = root_window_at(point)?;
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect).ok()? };
    rect_target(TargetScope::Window, hwnd, rect, None, None)
}

#[cfg(target_os = "windows")]
fn element_target(point: POINT) -> Option<ScreenshotTarget> {
    use windows::core::BSTR;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, UIA_GroupControlTypeId, UIA_TextControlTypeId,
        UIA_WindowControlTypeId,
    };

    unsafe {
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            return None;
        }
        let result = (|| {
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX(0x1)).ok()?;
            let element = automation.ElementFromPoint(point).ok()?;
            let walker = automation.ControlViewWalker().ok()?;
            let mut current = Some(element);
            let mut best = None;
            for _ in 0..6 {
                let Some(item) = current else { break };
                let rect = item.CurrentBoundingRectangle().ok()?;
                let contains = point.x >= rect.left
                    && point.x < rect.right
                    && point.y >= rect.top
                    && point.y < rect.bottom;
                if contains {
                    let control_type = item.CurrentControlType().ok().map(|v| v.0);
                    let name = item
                        .CurrentName()
                        .ok()
                        .map(|v: BSTR| v.to_string())
                        .filter(|v| !v.trim().is_empty());
                    let native = item
                        .CurrentNativeWindowHandle()
                        .ok()
                        .filter(|h| !h.0.is_null())
                        .unwrap_or_else(|| root_window_at(point).unwrap_or_default());
                    let meaningful = control_type
                        .map(|v| {
                            v != UIA_TextControlTypeId.0
                                && v != UIA_GroupControlTypeId.0
                                && v != UIA_WindowControlTypeId.0
                        })
                        .unwrap_or(false);
                    // ControlViewWalker starts at the deepest element and walks
                    // toward its parents. Keep the first meaningful match so a
                    // Button is not replaced by its containing Pane/Window.
                    if best.is_none() && meaningful {
                        best = rect_target(TargetScope::Element, native, rect, control_type, name);
                    }
                    if control_type == Some(UIA_WindowControlTypeId.0) {
                        break;
                    }
                }
                current = walker.GetParentElement(&item).ok();
            }
            best
        })();
        CoUninitialize();
        result
    }
}

#[cfg(target_os = "windows")]
pub fn detect(point: POINT, scope: TargetScope) -> Option<ScreenshotTarget> {
    let target = match scope {
        TargetScope::Window => window_target(point),
        TargetScope::Element => element_target(point).or_else(|| window_target(point)),
    }?;
    if target.hwnd != 0 {
        let title = window_title(HWND(target.hwnd as *mut std::ffi::c_void));
        if title.starts_with("Levitaire") || title == "Program Manager" {
            return None;
        }
    }
    Some(target)
}

#[cfg(not(target_os = "windows"))]
pub fn detect(_point: POINT, _scope: TargetScope) -> Option<ScreenshotTarget> {
    None
}
