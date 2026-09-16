use super::*;


/// 显示滚动导航独立窗口。
///
/// `async` + `spawn_blocking`：抓目标窗口要轮询前台窗口（最多 12×10ms）并访问 Win32，
/// 同步命令跑在事件循环主线程上会连带冻结所有窗口（见 `scroll_navigation.rs` 模块注释）。
#[tauri::command]
pub async fn start_scroll_navigation(
    app: tauri::AppHandle,
) -> Result<crate::scroll_navigation::ScrollNavigationState, String> {
    // The palette owns focus while its tool button is being activated. Hide it
    // before capturing the target so the previous application becomes the
    // foreground window again instead of Levitaire's own palette HWND.
    // 捕获 + 状态探测都在阻塞任务里完成（探测也是一次跨进程 UIA 遍历）。
    let capture_app = app.clone();
    let state = tokio::task::spawn_blocking(move || {
        if let Some(palette) = capture_app.get_webview_window("palette") {
            if palette.is_visible().unwrap_or(false) {
                let _ = palette.hide();
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        crate::scroll_navigation::capture_current_target(&capture_app);
        crate::scroll_navigation::state()
    })
    .await
    .map_err(|error| format!("目标窗口捕获失败: {error}"))?;

    let window = app
        .get_webview_window("scroll-navigator-overlay")
        .ok_or_else(|| "滚动导航窗口尚未创建".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(state)
}


#[tauri::command]
pub fn hide_scroll_navigation(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("scroll-navigator-overlay") {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}


#[tauri::command]
pub async fn start_utility_hub(app: tauri::AppHandle) -> Result<(), String> {
    // Capture the user's application before showing the always-on-top hub.
    // When launched from the palette, hiding it first restores the original
    // foreground window and gives the scroll sub-tool a valid target.
    //
    // `async` + `spawn_blocking`：这段要睡 20ms 再轮询前台窗口（最多 120ms），
    // 放在主线程上会让「打开面板」整段卡住其它窗口的消息处理。
    let capture_app = app.clone();
    tokio::task::spawn_blocking(move || {
        if let Some(palette) = capture_app.get_webview_window("palette") {
            if palette.is_visible().unwrap_or(false) {
                let _ = palette.hide();
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        crate::scroll_navigation::capture_current_target(&capture_app);
    })
    .await
    .map_err(|error| format!("目标窗口捕获失败: {error}"))?;

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
                crate::hooks::mouse::stop_window_pin();
                // 面板没了 = 通用工具不再可用：把置顶过的窗口还原，别让它们永远悬在最前。
                // 这里在事件循环上，而还原要对每扇窗口调跨进程 SetWindowPos（目标卡死会
                // 阻塞到系统超时）—— 丢到独立线程，别把主线程拖住。
                std::thread::spawn(crate::window_pin::cleanup);
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
    crate::hooks::mouse::stop_window_pin();
    // 面板只是 hide，React 树不卸载、监听器照旧在 —— 这里推一次，否则下次显示时
    // 按钮还停在「退出点选」态，而准星其实早就撤了。
    crate::window_pin::publish(&app, None);
    if let Some(window) = app.get_webview_window("utility-hub-overlay") {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}


/// 获取通用工具启用状态（供前端卡片开关与后端真值同步）
#[tauri::command]
pub fn get_utility_hub_enabled(config_manager: State<'_, ConfigManager>) -> Result<bool, String> {
    config_manager.get_utility_hub_enabled()
}


/// 设置通用工具启用状态并持久化。
///
/// 通用工具没有热键，但它的悬浮窗是常驻的：禁用时必须收起窗口，否则 palette 的
/// 「全部关闭」只会改前端勾选，已经打开的通用工具浮窗会留在桌面上（其它工具都在各自的
/// `set_*_enabled(false)` 里隐藏了窗口，本命令补上同一契约）。
///
/// 一并撤销窗口置顶：置顶状态写在**别人窗口**身上，Levitaire 退出不会自动恢复它，
/// 工具都关掉了还留着几扇「永远在最前」的窗口，用户查不到是谁干的。
///
/// `async` + `spawn_blocking`：撤销要对每扇置顶窗各调一次跨进程 `SetWindowPos`，
/// 目标应用卡死时会阻塞到系统超时（理由同 `unpin_window`）。配置落盘本身很轻，
/// 留在命令体里没问题。
#[tauri::command]
pub async fn set_utility_hub_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    if !enabled {
        let _ = tokio::task::spawn_blocking(crate::window_pin::cleanup).await;
        // 清单已被清空，面板（隐藏但未卸载）也要跟上，免得重新启用时列着一批
        // 早已恢复原状的窗口。
        crate::window_pin::publish(&app, None);
        hide_utility_hub(app)?;
    }
    config_manager.update_utility_hub_enabled(enabled)
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


/// 读取滚动导航状态。
///
/// 前端每 2s 轮询一次，命令内部会做一次带预算的跨进程 UIA 探测（最坏 ~120ms，
/// 见 `scroll_navigation.rs` 的 `SCAN_NODE_BUDGET`）——**必须离开主线程**。
#[tauri::command]
pub async fn get_scroll_navigation_state() -> crate::scroll_navigation::ScrollNavigationState {
    tokio::task::spawn_blocking(crate::scroll_navigation::state)
        .await
        .unwrap_or_else(|_| crate::scroll_navigation::state_unavailable())
}


/// 设置滚动百分比（只有能精确控制的窗口才可用）。
#[tauri::command]
pub async fn set_scroll_navigation_percent(
    percent: f64,
) -> Result<crate::scroll_navigation::ScrollNavigationState, String> {
    tokio::task::spawn_blocking(move || crate::scroll_navigation::set_percent(percent))
        .await
        .map_err(|error| format!("滚动操作被中断: {error}"))?
}


/// 重新绑定滚动目标窗口。
///
/// 目标窗口被用户关掉后，面板会退化成「没有目标」——旧实现只能关掉面板重开。
/// 这里先藏起自己，让前台回到用户真正在用的程序上再抓一次，然后把自己显示回来。
#[tauri::command]
pub async fn recapture_scroll_target(
    app: tauri::AppHandle,
) -> Result<crate::scroll_navigation::ScrollNavigationState, String> {
    let capture_app = app.clone();
    // is_visible() 是「发消息给事件循环并等回执」的阻塞调用，必须待在阻塞线程里；
    // 只回显「本来就可见」的窗口，免得把历史遗留的隐藏浮窗一起弹出来。
    // 状态探测（跨进程 UIA，最坏 ~120ms）也一并留在这里，别放回 async 上下文。
    let (restore, state): (Vec<&'static str>, crate::scroll_navigation::ScrollNavigationState) =
        tokio::task::spawn_blocking(move || {
            let restore: Vec<&'static str> = ["utility-hub-overlay", "scroll-navigator-overlay"]
                .into_iter()
                .filter(|label| {
                    capture_app
                        .get_webview_window(label)
                        .is_some_and(|window| window.is_visible().unwrap_or(false))
                })
                .collect();
            for label in &restore {
                if let Some(window) = capture_app.get_webview_window(label) {
                    let _ = window.hide();
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
            crate::scroll_navigation::capture_current_target(&capture_app);
            (restore, crate::scroll_navigation::state())
        })
        .await
        .map_err(|error| format!("目标窗口捕获失败: {error}"))?;

    for label in restore {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    Ok(state)
}


// ─── 窗口置顶（通用工具的子工具） ──────────────────────────────

/// 进入窗口置顶的点选模式：系统光标换成准星，左键点任意窗口切换其置顶状态。
///
/// 与取色的互斥在 `hooks::mouse` 里强制（两者都接管系统光标），本命令不重复处理。
#[tauri::command]
pub fn start_window_pin_pick(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("utility-hub-overlay")
        .ok_or_else(|| "通用工具窗口尚未创建".to_string())?;
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("无法获取通用工具窗口句柄: {}", error))?;
    // 钩子靠这个句柄放行「落在面板上的点击」，不设的话点选期间连自己的按钮都点不动。
    crate::hooks::mouse::set_utility_hub_hwnd(hwnd.0);
    crate::hooks::mouse::start_window_pin()?;
    // 让面板的按钮立刻切到「点选中」态（`picking` 由后端给出，前端不自己猜）。
    crate::window_pin::publish(&app, None);
    Ok(())
}


/// 退出窗口置顶点选模式（面板切到别的子工具、关闭或收起时调用）。
#[tauri::command]
pub fn stop_window_pin_pick(app: tauri::AppHandle) {
    crate::hooks::mouse::stop_window_pin();
    crate::window_pin::publish(&app, None);
}


/// 读取当前由本工具置顶的窗口清单。
#[tauri::command]
pub fn get_pinned_windows() -> Vec<crate::window_pin::PinnedWindowInfo> {
    crate::window_pin::list()
}


/// 取消指定窗口的置顶（面板清单里的单条操作）。
///
/// `async` + `spawn_blocking`：`SetWindowPos` 是**跨进程**调用，会同步向目标窗口的
/// 线程投递 `WM_WINDOWPOSCHANGING` —— 目标应用卡死时它会一直阻塞到系统超时。同步命令
/// 跑在事件循环主线程上（见 `RUNTIME.md`），阻塞在这里等于整个应用一起冻住。
#[tauri::command]
pub async fn unpin_window(app: tauri::AppHandle, hwnd: i64) -> Result<(), String> {
    let worker = app.clone();
    let message = tokio::task::spawn_blocking(move || crate::window_pin::unpin(&worker, hwnd))
        .await
        .map_err(|error| format!("取消置顶被中断: {error}"))??;
    crate::window_pin::publish(&app, Some(message));
    Ok(())
}


/// 取消全部由本工具置顶的窗口。
///
/// 只动清单内的窗口：用户自己、或别的程序把某扇窗口置顶，与 Levitaire 无关，
/// 不在这里撤销。离开主线程的理由同 `unpin_window` —— 这里要对 N 扇窗口各调一次
/// `SetWindowPos`，其中任何一扇卡住都会把主线程拖住。
#[tauri::command]
pub async fn unpin_all_windows(app: tauri::AppHandle) {
    let worker = app.clone();
    let outcome =
        tokio::task::spawn_blocking(move || crate::window_pin::unpin_all(&worker)).await;

    let (done, failed) = match outcome {
        Ok(counts) => counts,
        Err(error) => {
            crate::window_pin::publish_error(&app, format!("取消失败：任务被中断（{error}）"));
            return;
        }
    };

    if failed > 0 {
        // 失败的那些仍然置顶、也仍在清单里，得让用户知道还剩几个没处理掉。
        // 按失败推：这条提示里有「没做成」的部分，不能和纯成功提示一个颜色。
        crate::window_pin::publish_error(
            &app,
            format!("已取消 {done} 个，{failed} 个未能取消（可能权限不足）"),
        );
        return;
    }
    let message = if done == 0 {
        "没有需要取消的置顶窗口".to_string()
    } else {
        format!("已取消 {done} 个窗口的置顶")
    };
    crate::window_pin::publish(&app, Some(message));
}
