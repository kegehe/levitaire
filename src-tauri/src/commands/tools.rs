use super::*;


#[tauri::command]
pub fn start_scroll_navigation(
    app: tauri::AppHandle,
) -> Result<crate::scroll_navigation::ScrollNavigationState, String> {
    // The palette owns focus while its tool button is being activated. Hide it
    // before capturing the target so the previous application becomes the
    // foreground window again instead of Levitaire's own palette HWND.
    if let Some(palette) = app.get_webview_window("palette") {
        if palette.is_visible().unwrap_or(false) {
            palette.hide().map_err(|error| error.to_string())?;
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    crate::scroll_navigation::capture_current_target(&app);
    let window = app
        .get_webview_window("scroll-navigator-overlay")
        .ok_or_else(|| "滚动导航窗口尚未创建".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(crate::scroll_navigation::state())
}


#[tauri::command]
pub fn hide_scroll_navigation(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("scroll-navigator-overlay") {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}


#[tauri::command]
pub fn start_utility_hub(app: tauri::AppHandle) -> Result<(), String> {
    // Capture the user's application before showing the always-on-top hub.
    // When launched from the palette, hiding it first restores the original
    // foreground window and gives the scroll sub-tool a valid target.
    if let Some(palette) = app.get_webview_window("palette") {
        if palette.is_visible().unwrap_or(false) {
            palette.hide().map_err(|error| error.to_string())?;
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    crate::scroll_navigation::capture_current_target(&app);
    let window = app
        .get_webview_window("utility-hub-overlay")
        .ok_or_else(|| "通用工具窗口尚未创建".to_string())?;
    if let Ok(hwnd) = window.hwnd() {
        crate::hooks::mouse::set_utility_hub_hwnd(hwnd.0);
    }
    // A native close (such as Alt+F4) bypasses the frontend close button.
    // The color picker owns a global mouse hook and replaces the system
    // cursor, so it must use the same cleanup path before hiding the window.
    if UTILITY_HUB_CLOSE_HANDLER_REGISTERED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let app_on_close = app.clone();
        window.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = hide_utility_hub(app_on_close.clone());
            }
            // Keep cleanup correct even if a platform or renderer failure
            // destroys the window without a CloseRequested event.
            tauri::WindowEvent::Destroyed => {
                crate::hooks::mouse::stop_color_pick();
                crate::hooks::mouse::set_utility_hub_hwnd(std::ptr::null_mut());
                UTILITY_HUB_CLOSE_HANDLER_REGISTERED.store(false, Ordering::SeqCst);
            }
            _ => {}
        });
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}


#[tauri::command]
pub fn show_utility_hub(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("utility-hub-overlay")
        .ok_or_else(|| "通用工具窗口尚未创建".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}


#[tauri::command]
pub fn stop_utility_color_pick() {
    crate::hooks::mouse::stop_color_pick();
}


#[tauri::command]
pub fn hide_utility_hub(app: tauri::AppHandle) -> Result<(), String> {
    crate::hooks::mouse::stop_color_pick();
    if let Some(window) = app.get_webview_window("utility-hub-overlay") {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}


#[tauri::command]
pub fn start_utility_color_pick(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("utility-hub-overlay")
        .ok_or_else(|| "通用工具窗口尚未创建".to_string())?;
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("无法获取通用工具窗口句柄: {}", error))?;
    crate::hooks::mouse::set_utility_hub_hwnd(hwnd.0);
    crate::hooks::mouse::start_color_pick()
}


#[tauri::command]
pub fn get_scroll_navigation_state() -> crate::scroll_navigation::ScrollNavigationState {
    crate::scroll_navigation::state()
}


#[tauri::command]
pub fn set_scroll_navigation_percent(
    percent: f64,
) -> Result<crate::scroll_navigation::ScrollNavigationState, String> {
    crate::scroll_navigation::set_percent(percent)
}
