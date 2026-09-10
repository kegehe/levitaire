use super::*;


#[tauri::command]
pub fn copy_text(text: String, clipboard: State<'_, ClipboardManager>) -> Result<(), String> {
    clipboard.copy(&text).map_err(|e| e.to_string())
}


#[tauri::command]
pub fn show_orb(app: tauri::AppHandle) -> Result<(), String> {
    if !is_orb_ready() {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window("orb") {
        window.show().map_err(|e| e.to_string())?;
    }
    crate::hooks::set_orb_visible(true);
    Ok(())
}


#[tauri::command]
pub fn hide_orb(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("orb") {
        window.hide().map_err(|e| e.to_string())?;
    }
    // 隐藏后同步钩子可见状态：避免隐藏状态下点击原位置仍触发 orb 交互（弹面板）
    crate::hooks::set_orb_visible(false);
    Ok(())
}


#[tauri::command]
pub fn toggle_orb(app: tauri::AppHandle) -> Result<(), String> {
    if !is_orb_ready() {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window("orb") {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|e| e.to_string())?;
            crate::hooks::set_orb_visible(false);
        } else {
            window.show().map_err(|e| e.to_string())?;
            crate::hooks::set_orb_visible(true);
        }
    }
    Ok(())
}


#[tauri::command]
pub async fn show_settings(app: tauri::AppHandle) -> Result<(), String> {
    // 用 tokio Mutex 保护"检查+创建+注册关闭拦截"整个流程，防止快速双击竞态
    let _init_guard = SETTINGS_INIT_LOCK.lock().await;

    // 首次打开时动态创建窗口（settings 不再预创建，延迟到首次 show）
    let window = match app.get_webview_window("settings") {
        Some(win) => win,
        None => {
            use tauri::WebviewUrl;
            use tauri::WebviewWindowBuilder;
            let win =
                WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("index.html".into()))
                    .title("Levitaire Settings")
                    .inner_size(780.0, 560.0)
                    .center()
                    .visible(false)
                    // 自绘标题栏：去掉原生装饰，由前端渲染标题栏并跟随主题/主题色。
                    // 失去 Windows 原生边框/阴影，由 CSS border 负责窗口边界（见 .settings-shell）。
                    .transparent(true)
                    .decorations(false)
                    .shadow(false)
                    .background_color(tauri::webview::Color(0, 0, 0, 0))
                    .resizable(true)
                    .min_inner_size(520.0, 420.0)
                    .build()
                    .map_err(|e| format!("创建 settings 窗口失败: {}", e))?;
            win
        }
    };

    // 注册关闭拦截（仅一次）：隐藏而非销毁
    static SETTINGS_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);
    if !SETTINGS_CLOSE_HANDLER_REGISTERED.swap(true, Ordering::SeqCst) {
        let settings_app_handle = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Some(win) = settings_app_handle.get_webview_window("settings") {
                    let _ = win.hide();
                }
            }
        });
    }

    // 注册完成后释放初始化锁，show/set_focus 不需要在锁内执行
    drop(_init_guard);

    // Keep native title-bar surfaces aligned with the icon shipped by the installer.
    let _ = window.set_icon(crate::app_icon_image());

    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}


/// Show the tool-specific configuration window. System preferences intentionally
/// live in the separate `settings` window so the two scopes do not compete in
/// a single navigation tree.
#[tauri::command]
pub async fn show_tool_config(app: tauri::AppHandle) -> Result<(), String> {
    let _init_guard = TOOL_CONFIG_INIT_LOCK.lock().await;

    let window = match app.get_webview_window("tool-config") {
        Some(win) => win,
        None => {
            use tauri::WebviewUrl;
            use tauri::WebviewWindowBuilder;
            WebviewWindowBuilder::new(&app, "tool-config", WebviewUrl::App("index.html".into()))
                .title("Levitaire Tool Configuration")
                .inner_size(780.0, 560.0)
                .center()
                .visible(false)
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .background_color(tauri::webview::Color(0, 0, 0, 0))
                .resizable(true)
                .min_inner_size(520.0, 420.0)
                .build()
                .map_err(|e| format!("创建工具配置窗口失败: {}", e))?
        }
    };

    static TOOL_CONFIG_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);
    if !TOOL_CONFIG_CLOSE_HANDLER_REGISTERED.swap(true, Ordering::SeqCst) {
        let tool_config_app_handle = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Some(win) = tool_config_app_handle.get_webview_window("tool-config") {
                    let _ = win.hide();
                }
            }
        });
    }

    drop(_init_guard);

    let _ = window.set_icon(crate::app_icon_image());

    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}


#[tauri::command]
pub fn get_theme_preferences(
    config_manager: State<'_, ConfigManager>,
) -> Result<crate::config::ThemePreferences, String> {
    config_manager.get_theme_preferences()
}


#[tauri::command]
pub fn set_theme_preferences(
    preferences: crate::config::ThemePreferences,
    _app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_theme_preferences(preferences)
}


#[tauri::command]
pub fn set_orb_icon(
    icon: String,
    _app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_orb_icon(icon)
}


/// 打开 URL（用默认浏览器）。
/// 通过校验 scheme 白名单 + ShellExecuteW 直接打开，避免 cmd /C start 的命令注入风险。
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    crate::utils::logger::log("commands", &format!("open_url: {}", redact_url_for_log(&url)));
    validate_url_scheme(&url)?;

    #[cfg(target_os = "windows")]
    {
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        // 将 URL 编码为 UTF-16，ShellExecuteW 以 "open" 动词交给系统默认处理程序
        let url_wide: Vec<u16> = url.encode_utf16().chain(std::iter::once(0u16)).collect();
        let verb: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0u16)).collect();

        // SAFETY: verb 与 file 均为以 NUL 结尾的 UTF-16 字符串指针，参数符合 ShellExecuteW 签名。
        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(verb.as_ptr()),
                PCWSTR(url_wide.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        // ShellExecuteW 返回 HINSTANCE；当 HINSTANCE <= 32 时表示失败
        let hinst = result.0 as usize;
        if hinst <= 32 {
            return Err(format!("打开浏览器失败 (code: {})", hinst));
        }
    }
    Ok(())
}


/// 获取开机自启动状态
#[tauri::command]
pub fn get_auto_start() -> bool {
    crate::config::get_auto_start()
}


/// 设置开机自启动
#[tauri::command]
pub fn set_auto_start(enable: bool) -> Result<(), String> {
    crate::config::set_auto_start(enable)
}


/// 设置二维码预览模式
/// 为 true 时鼠标点击工具栏外部不会隐藏窗口
#[tauri::command]
pub fn set_qrcode_preview(active: bool) {
    crate::hooks::mouse::set_qrcode_preview(active);
}


/// 检查所有可配置的全局快捷键当前是否成功注册。
/// Windows RegisterHotKey 能判断是否被占用，但不会暴露占用者进程名称。
#[tauri::command]
pub fn check_hotkey_conflicts(
    config_manager: State<'_, ConfigManager>,
) -> Result<Vec<HotkeyConflictResult>, String> {
    let config = config_manager.get_startup_config()?;
    let entries = [
        (
            "screenshot",
            "截图",
            crate::hooks::hotkey::HotkeySlotId::Screenshot,
            config.screenshot_hotkey,
        ),
        (
            "sketch",
            "屏幕草稿",
            crate::hooks::hotkey::HotkeySlotId::Sketch,
            config.sketch_hotkey,
        ),
        (
            "recording",
            "录屏",
            crate::hooks::hotkey::HotkeySlotId::Recording,
            config.recording_hotkey,
        ),
        (
            "todo-quick-add",
            "待办快速添加",
            crate::hooks::hotkey::HotkeySlotId::TodoQuickAdd,
            config.todo_quick_add_hotkey,
        ),
    ];
    let mut results = Vec::with_capacity(entries.len() + 1);
    let parsed_entries: Vec<_> = entries
        .iter()
        .map(|(id, label, _slot, hotkey)| (*id, *label, hotkey.trim().to_string(), crate::hooks::hotkey::parse_hotkey(hotkey)))
        .collect();
    for (id, _label, slot, hotkey) in entries.iter() {
        let trimmed = hotkey.trim().to_string();
        if trimmed.is_empty() {
            results.push(HotkeyConflictResult {
                id: (*id).into(),
                hotkey: trimmed,
                status: "disabled".into(),
                message: "未设置".into(),
            });
            continue;
        }
        let parsed = crate::hooks::hotkey::parse_hotkey(&trimmed);
        if parsed.is_none() {
            results.push(HotkeyConflictResult {
                id: (*id).into(),
                hotkey: trimmed,
                status: "invalid".into(),
                message: "快捷键格式无效".into(),
            });
            continue;
        }
        let conflict_label = parsed_entries.iter().find_map(|(other_id, other_label, _, other_parsed)| {
            (*other_id != *id && *other_parsed == parsed).then_some(*other_label)
        });
        if let Some(conflict_label) = conflict_label {
            results.push(HotkeyConflictResult {
                id: (*id).into(),
                hotkey: trimmed,
                status: "internal-conflict".into(),
                message: format!("与其他 Levitaire 功能冲突（{}）", conflict_label),
            });
        } else if crate::hooks::hotkey::is_registered(*slot) {
            results.push(HotkeyConflictResult {
                id: (*id).into(),
                hotkey: trimmed,
                status: "available".into(),
                message: "快捷键可用".into(),
            });
        } else {
            results.push(HotkeyConflictResult {
                id: (*id).into(),
                hotkey: trimmed,
                status: "external-conflict".into(),
                message: "快捷键可能已被其他程序占用".into(),
            });
        }
    }

    let quick_input_enabled = config.quick_input_enabled;
    let quick_input_hotkey = config.quick_input_trigger_key;
    let quick_input_hotkey = if quick_input_hotkey.trim().is_empty() {
        "CapsLock".to_string()
    } else {
        quick_input_hotkey.trim().to_string()
    };
    if !quick_input_enabled {
        results.push(HotkeyConflictResult {
            id: "quick-input-trigger".into(),
            hotkey: quick_input_hotkey,
            status: "disabled".into(),
            message: "快速输入未启用".into(),
        });
    } else if let Some(trigger_vk) = crate::quick_input::parse_trigger_key(&quick_input_hotkey) {
        let conflict_label = parsed_entries.iter().find_map(|(_, label, _, parsed)| {
            parsed.filter(|(_, vk)| *vk == trigger_vk).map(|_| *label)
        });
        results.push(HotkeyConflictResult {
            id: "quick-input-trigger".into(),
            hotkey: quick_input_hotkey,
            status: if conflict_label.is_some() {
                "internal-conflict".into()
            } else {
                "available".into()
            },
            message: if let Some(label) = conflict_label {
                format!("与{}快捷键使用相同按键，可能同时触发", label)
            } else {
                "未发现 Levitaire 内部冲突；其他软件的单键占用无法可靠查询".into()
            },
        });
    } else {
        results.push(HotkeyConflictResult {
            id: "quick-input-trigger".into(),
            hotkey: quick_input_hotkey,
            status: "invalid".into(),
            message: "触发键格式无效".into(),
        });
    }
    Ok(results)
}


/// 显示卡片工具选择器面板，定位到悬浮球附近
#[tauri::command]
pub async fn show_palette(app: tauri::AppHandle) -> Result<(), String> {
    crate::scroll_navigation::capture_current_target(&app);
    // 用 tokio Mutex 保护"检查+创建+注册关闭拦截"整个流程，防止快速双击竞态
    let _init_guard = PALETTE_INIT_LOCK.lock().await;

    // 首次打开时动态创建窗口（palette 不再预创建，延迟到首次 show）
    let (palette, should_anchor_to_orb) = match app.get_webview_window("palette") {
        Some(win) => (win, false),
        None => {
            use tauri::WebviewUrl;
            use tauri::WebviewWindowBuilder;
            let win =
                WebviewWindowBuilder::new(&app, "palette", WebviewUrl::App("index.html".into()))
                    .title("Levitaire Tools")
                    // The nine-card grid is about 194px tall; using a close
                    // initial size keeps the first placement anchored while
                    // the frontend performs its final content measurement.
                    .inner_size(330.0, 194.0)
                    .resizable(false)
                    .transparent(true)
                    .decorations(false)
                    // 由 palette-container 的 CSS 阴影负责视觉层级。Windows 原生阴影会在
                    // 透明圆角的外侧参与合成，深色主题下会显出浅色边缘。
                    .shadow(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .focusable(true)
                    .visible(false)
                    // WebView2 默认背景为不透明白色 (255,255,255,255)，
                    // 在 border-radius 圆角裁剪区域外会露出白边（深色模式下尤为明显）。
                    // 显式设为完全透明，使圆角外区域真正透明。
                    .background_color(tauri::webview::Color(0, 0, 0, 0))
                    .build()
                    .map_err(|e| format!("创建 palette 窗口失败: {}", e))?;
            (win, true)
        }
    };

    // 注册关闭拦截（仅一次）：隐藏而非销毁
    static PALETTE_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);
    if !PALETTE_CLOSE_HANDLER_REGISTERED.swap(true, Ordering::SeqCst) {
        let palette_app_handle = app.clone();
        palette.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Some(win) = palette_app_handle.get_webview_window("palette") {
                    let _ = win.hide();
                }
            }
        });
    }

    // Keep the initialization lock through positioning and show so rapid orb
    // clicks cannot interleave their focus and placement operations.
    // Only the first opening is anchored beside the orb. Subsequent openings retain the
    // position selected by dragging the palette window.
    if should_anchor_to_orb {
    // palette 物理尺寸：宽度固定 330，高度由前端自适应调整（fit-content + setSize）。
    // 首次创建时 inner_size() 可能返回 0，使用 WebviewWindowBuilder 中指定的逻辑尺寸乘 scale_factor 作为 fallback。
    // 高度取 inner_size()（非首次时已是前端上次调整的值），首次创建 fallback 用初始值。
    let scale = palette.scale_factor().unwrap_or(1.0);
    let inner = palette.inner_size().unwrap_or_else(|_| {
        tauri::PhysicalSize::new((330.0 * scale) as u32, (194.0 * scale) as u32)
    });
    let pw = if inner.width > 0 {
        inner.width as i32
    } else {
        (330.0 * scale) as i32
    };
    let ph = if inner.height > 0 {
        inner.height as i32
    } else {
        (194.0 * scale) as i32
    };

    // 锚点：优先用 orb 窗口位置；失败则用鼠标位置
    let (mut x, mut y, anchor_hwnd) = if let Some(orb) = app.get_webview_window("orb") {
        match orb.outer_position() {
            Ok(p) => {
                let oi = orb.inner_size().unwrap_or_default();
                let ow = oi.width as i32;
                let oh = oi.height as i32;
                let hwnd = orb.hwnd().map(|h| h.0).unwrap_or(std::ptr::null_mut());
                // 默认放在 orb 右上方，间隔 8px
                let orb_scale = orb.scale_factor().unwrap_or(1.0);
                let visual_size = (56.0 * orb_scale).round() as i32;
                let visual_right = p.x + (ow + visual_size) / 2;
                let visual_bottom = p.y + (oh + visual_size) / 2;
                (visual_right + 8, visual_bottom - ph, hwnd)
            }
            Err(_) => {
                if let Ok(cur) = crate::automation::get_mouse_position() {
                    (cur.x + 8, cur.y + 8, std::ptr::null_mut())
                } else {
                    (100, 100, std::ptr::null_mut())
                }
            }
        }
    } else if let Ok(cur) = crate::automation::get_mouse_position() {
        (cur.x + 8, cur.y + 8, std::ptr::null_mut())
    } else {
        (100, 100, std::ptr::null_mut())
    };

    // 取 orb 所在显示器的工作区用于边界翻转（支持多显示器）
    // GetMonitorInfoW 在 Per-Monitor DPI Aware V2 进程中返回物理像素坐标
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        };
        let hwnd = HWND(anchor_hwnd);
        if !hwnd.is_invalid() {
            let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
            let mut mi = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if unsafe { GetMonitorInfoW(monitor, &mut mi) }.as_bool() {
                let rc = mi.rcWork;
                // 边界翻转：palette 不超出 orb 所在屏工作区
                if x + pw > rc.right {
                    // 右边放不下，改为放在 orb 左边
                    if let Some(orb) = app.get_webview_window("orb") {
                        if let Ok(p) = orb.outer_position() {
                            let ow = orb.inner_size().map(|size| size.width as i32).unwrap_or(96);
                            let visual_size = (56.0 * orb.scale_factor().unwrap_or(1.0)).round() as i32;
                            let visual_left = p.x + (ow - visual_size) / 2;
                            x = visual_left - pw - 8;
                        }
                    }
                    // 如果左边也放不下，贴左边工作区
                    if x < rc.left {
                        x = rc.left;
                    }
                }
                if y + ph > rc.bottom {
                    y = rc.bottom - ph;
                }
                if x < rc.left {
                    x = rc.left;
                }
                if y < rc.top {
                    y = rc.top;
                }
            }
        }
    }

    let _ = palette.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        x, y,
    )));
    // set_size 使用 inner_size() 的当前值（非首次时已是前端上次调整的值），
    // 前端 useLayoutEffect 会在渲染后按实际内容高度再次 setSize 修正，
    // 两者之间可能有一帧微调，可接受。
    let _ = palette.set_size(tauri::PhysicalSize::new(pw, ph));
    }

    palette.show().map_err(|e| e.to_string())?;
    palette.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}


/// 隐藏卡片工具选择器面板
#[tauri::command]
pub fn hide_palette(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("palette") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}


#[tauri::command]
pub fn navigate_scroll(
    action: String,
) -> Result<crate::scroll_navigation::ScrollNavigationState, String> {
    crate::scroll_navigation::navigate(&action)
}


/// 退出应用（悬浮球右键菜单「退出」入口，与托盘菜单 quit 等价）
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) -> Result<(), String> {
    crate::hooks::mouse::stop_color_pick();
    app.exit(0);
    Ok(())
}


/// 记忆悬浮窗位置（由前端在窗口拖动结束后调用），应用重启后恢复到上次位置。
/// window_id 如 "orb"、"monitor-overlay"、"pomodoro-overlay"
#[tauri::command]
pub fn set_window_position(
    id: String,
    x: i32,
    y: i32,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    // 恢复默认位置期间：程序化 set_position 会触发 onMoved → 前端在 300ms 后再次
    // set_window_position，若不忽略会把刚恢复的默认位置重新记忆。仅忽略对应窗口。
    if let Ok(suppress) = position_save_suppress().lock() {
        if let Some(until) = suppress.get(&id) {
            if now_ms() < *until {
                return Ok(());
            }
        }
    }
    config_manager.set_window_position(&id, crate::config::WindowPosition { x, y })
}


/// 恢复悬浮窗默认位置：清除记忆位置，并将窗口移动到默认定位。
/// window_id 如 "orb"、"monitor-overlay"、"pomodoro-overlay"、"time-overlay"、"todo-overlay"
#[tauri::command]
pub fn reset_window_position(
    id: String,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.reset_window_position(&id)?;

    let win = match id.as_str() {
        "orb" => app.get_webview_window("orb"),
        "monitor-overlay" => app.get_webview_window("monitor-overlay"),
        "pomodoro-overlay" => app.get_webview_window("pomodoro-overlay"),
        "time-overlay" => app.get_webview_window("time-overlay"),
        "todo-overlay" => app.get_webview_window("todo-overlay"),
        _ => None,
    };
    // 对已存在窗口统一移动到默认定位（隐藏窗口 set_position 同样生效，下次显示即默认位置）。
    // monitor 下次显示时按未记忆逻辑跟随鼠标重新定位；pomodoro 无记忆时保持此位置。
    if let Some(win) = win {
        let inner = win.inner_size().unwrap_or_default();
        let (x, y) = default_window_position(&id, inner.width as i32, inner.height as i32);
        // 抑制程序化移动触发的 onMoved 保存（前端 300ms 后调用 set_window_position）
        if let Ok(mut suppress) = position_save_suppress().lock() {
            suppress.insert(id.clone(), now_ms() + 1500);
        }
        win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            x, y,
        )))
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}


// ─── OCR 引擎管理 ─────────────────────────────────────────────────

/// 获取可用 OCR 引擎列表及当前激活引擎
/// async：懒加载在 spawn_blocking 阻塞池执行，避免首次打开设置页时阻塞 UI 主线程
#[tauri::command]
pub async fn get_ocr_engines() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(|| {
        let svc = crate::ocr::ensure_ocr_service().ok_or("OCR 服务初始化失败")?;
        let guard = svc.lock().map_err(|e| format!("OCR 服务锁失败: {}", e))?;
        let engines: Vec<&str> = guard
            .available_engines()
            .iter()
            .map(|e| e.as_str())
            .collect();
        Ok(serde_json::json!({
            "active": guard.active_engine_name(),
            "available": engines,
        }))
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}


/// 切换 OCR 引擎，并将用户偏好持久化到配置（重启后保持所选引擎）
#[tauri::command]
pub async fn set_ocr_engine(
    engine: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let id = crate::ocr::EngineId::from_str(&engine)
        .ok_or_else(|| format!("无效的引擎标识: {}", engine))?;
    if id != crate::ocr::EngineId::Paddle {
        return Err("OCR 已固定使用 PaddleOCR".into());
    }

    // 在阻塞池切换引擎（加载模型/初始化可能耗时）。
    // 返回切换前的激活引擎，供持久化失败时回滚，保证内存引擎与 UI 显示一致。
    let previous = tokio::task::spawn_blocking(move || -> Result<crate::ocr::EngineId, String> {
        let svc = crate::ocr::ensure_ocr_service().ok_or("OCR 服务初始化失败")?;
        let mut guard = svc.lock().map_err(|e| format!("OCR 服务锁失败: {}", e))?;
        let previous = guard.active_engine;
        if !guard.switch_engine(id) {
            return Err(format!("引擎 '{}' 不可用", id.as_str()));
        }
        Ok(previous)
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    // 持久化用户偏好（写入规范化引擎 ID）；失败时回滚内存引擎，避免 UI 显示与实际引擎脱节
    if let Err(error) = config_manager.update_ocr_engine(id.as_str().to_string()) {
        let rollback = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let svc = crate::ocr::ensure_ocr_service().ok_or("OCR 服务初始化失败")?;
            let mut guard = svc.lock().map_err(|e| format!("OCR 服务锁失败: {}", e))?;
            // 仅当内存引擎仍是我这次设置的才回滚，避免覆盖并发更新的引擎选择
            if guard.active_engine == id {
                let _ = guard.switch_engine(previous);
            }
            Ok(())
        })
        .await;
        if let Err(rollback_err) = rollback {
            crate::utils::logger::log(
                "ocr",
                &format!("OCR 引擎持久化失败后回滚出错: {}", rollback_err),
            );
        }
        return Err(error);
    }

    Ok(())
}


/// 打开文件夹选择对话框，返回用户选择的目录路径；取消返回 null
#[tauri::command]
pub async fn pick_folder() -> Result<Option<String>, String> {
    let result = rfd::AsyncFileDialog::new()
        .set_title("选择文件夹")
        .pick_folder()
        .await;
    Ok(result.map(|f| {
        let path = f.path();
        path.to_string_lossy().to_string()
    }))
}


/// 获取自启动工具 ID 列表
#[tauri::command]
pub fn get_tools_autostart(
    config_manager: State<'_, ConfigManager>,
) -> Result<Vec<String>, String> {
    config_manager.get_tools_autostart()
}


/// 设置自启动工具 ID 列表并持久化
#[tauri::command]
pub fn set_tools_autostart(
    ids: Vec<String>,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_tools_autostart(ids)
}
