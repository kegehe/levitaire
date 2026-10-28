use super::*;

#[tauri::command]
pub fn copy_text(text: String, clipboard: State<'_, ClipboardManager>) -> Result<(), String> {
    clipboard.copy(&text).map_err(|e| e.to_string())
}

/// 读取剪贴板文本，供应用自绘的文本右键菜单「粘贴」使用
/// （见 src/utils/textContextMenu.ts）。
/// 剪贴板为空或内容不是文本时返回空字符串——这是正常情况（用户可能复制的是图片）。
#[tauri::command]
pub fn clipboard_read_text(clipboard: State<'_, ClipboardManager>) -> Result<String, String> {
    clipboard.get_text().map_err(|e| e.to_string())
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
pub fn harden_webview_window(window: tauri::WebviewWindow) -> Result<(), String> {
    crate::webview_hardening::harden(&window)
}

/// Persist uncaught frontend failures so release builds can be diagnosed
/// after a renderer crash or a black WebView surface.
#[tauri::command]
pub fn write_client_log(tag: String, message: String) -> Result<(), String> {
    crate::utils::logger::log(&format!("frontend/{tag}"), &message);
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
                    // Tauri 的拖放处理器默认启用：Windows 上它会把 WebView 的拖放事件接管走
                    // （改走 OLE + tauri://drag-*），页面内 HTML5 拖拽的 dragstart/dragover
                    // 一个都不会触发。tauri 2.11 该方法的文档写得很直白：
                    // "Disabling the drag and drop handler. This is required to use
                    //  HTML5 drag and drop APIs on the frontend on Windows."
                    // 设置页的「文字工具栏按钮顺序」与「快速输入预设词」都靠 HTML5 拖拽排序，
                    // 不关掉就会表现为「提示写了可拖拽，实际拖不动」。
                    // 代价仅为失去系统文件拖入的真实路径，而本应用未使用任何原生拖放事件。
                    .disable_drag_drop_handler()
                    .build()
                    .map_err(|e| format!("创建 settings 窗口失败: {}", e))?;
            win
        }
    };

    // 注册关闭拦截（仅一次）：隐藏而非销毁
    static SETTINGS_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);
    if !SETTINGS_CLOSE_HANDLER_REGISTERED.swap(true, Ordering::SeqCst) {
        let settings_app_handle = app.clone();
        window.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if let Some(win) = settings_app_handle.get_webview_window("settings") {
                    let _ = win.hide();
                }
            }
            // 窗口真被销毁时复位注册标记（同 monitor / utility-hub / screenshot-overlay）：
            // 不复位，重建后的同名窗口会以为「已注册过」而跳过注册，Alt+F4 直接关窗。
            tauri::WindowEvent::Destroyed => {
                SETTINGS_CLOSE_HANDLER_REGISTERED.store(false, Ordering::SeqCst);
            }
            _ => {}
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
                // 与 settings 窗口同理：不关掉原生拖放，工具配置页的
                // 「功能按钮」顺序就收不到 HTML5 拖拽事件，表现为写了可拖拽却拖不动。
                .disable_drag_drop_handler()
                .build()
                .map_err(|e| format!("创建工具配置窗口失败: {}", e))?
        }
    };

    static TOOL_CONFIG_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);
    if !TOOL_CONFIG_CLOSE_HANDLER_REGISTERED.swap(true, Ordering::SeqCst) {
        let tool_config_app_handle = app.clone();
        window.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if let Some(win) = tool_config_app_handle.get_webview_window("tool-config") {
                    let _ = win.hide();
                }
            }
            // 同 settings：销毁时复位，重建后才能重新注册关闭拦截。
            tauri::WindowEvent::Destroyed => {
                TOOL_CONFIG_CLOSE_HANDLER_REGISTERED.store(false, Ordering::SeqCst);
            }
            _ => {}
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
    crate::utils::logger::log(
        "commands",
        &format!("open_url: {}", redact_url_for_log(&url)),
    );
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

/// 单条快捷键的检查结论。
///
/// 顺序有意义：**先看工具是否启用**。禁用的工具热键已被反注册，
/// `registered == false` 是它的预期状态，据此判成「被其他程序占用」是误报。
/// 同理，冲突判定也只在启用中的工具之间成立——没注册的键不可能冲突。
fn classify_hotkey_status(
    enabled: bool,
    registered: bool,
    internal_conflict: Option<&str>,
) -> (&'static str, String) {
    if !enabled {
        return ("disabled", "工具未启用，快捷键未占用".to_string());
    }
    if let Some(label) = internal_conflict {
        return (
            "internal-conflict",
            format!("与其他 Levitaire 功能冲突（{}）", label),
        );
    }
    if registered {
        ("available", "快捷键可用".to_string())
    } else {
        (
            "external-conflict",
            "快捷键可能已被其他程序占用".to_string(),
        )
    }
}

/// 检查所有可配置的全局快捷键当前是否成功注册。
/// Windows RegisterHotKey 能判断是否被占用，但不会暴露占用者进程名称。
#[tauri::command]
pub fn check_hotkey_conflicts(
    config_manager: State<'_, ConfigManager>,
) -> Result<Vec<HotkeyConflictResult>, String> {
    let config = config_manager.get_startup_config()?;
    // 第四项是工具启用状态：禁用的工具不占用热键（注册会被释放），
    // 不能因为「没注册」就报成被外部程序占用。
    let entries = [
        (
            "screenshot",
            "截图",
            crate::hooks::hotkey::HotkeySlotId::Screenshot,
            config.screenshot_enabled,
            config.screenshot_hotkey,
        ),
        (
            "sketch",
            "屏幕草稿",
            crate::hooks::hotkey::HotkeySlotId::Sketch,
            config.sketch_enabled,
            config.sketch_hotkey,
        ),
        (
            "recording",
            "录屏",
            crate::hooks::hotkey::HotkeySlotId::Recording,
            config.recording_enabled,
            config.recording_hotkey,
        ),
        (
            "todo-quick-add",
            "待办快速添加",
            crate::hooks::hotkey::HotkeySlotId::TodoQuickAdd,
            config.todo_enabled,
            config.todo_quick_add_hotkey,
        ),
    ];
    let mut results = Vec::with_capacity(entries.len() + 1);
    let parsed_entries: Vec<_> = entries
        .iter()
        .map(|(id, label, _slot, enabled, hotkey)| {
            (
                *id,
                *label,
                *enabled,
                crate::hooks::hotkey::parse_hotkey(hotkey),
            )
        })
        .collect();
    for (id, _label, slot, enabled, hotkey) in entries.iter() {
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
        // 只有启用中的其他工具才会真正注册热键，禁用的工具不能作为冲突来源。
        let conflict_label = parsed_entries.iter().find_map(
            |(other_id, other_label, other_enabled, other_parsed)| {
                (*other_id != *id && *other_enabled && *other_parsed == parsed)
                    .then_some(*other_label)
            },
        );
        let (status, message) = classify_hotkey_status(
            *enabled,
            crate::hooks::hotkey::is_registered(*slot),
            conflict_label,
        );
        results.push(HotkeyConflictResult {
            id: (*id).into(),
            hotkey: trimmed,
            status: status.into(),
            message,
        });
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
        let conflict_label = parsed_entries
            .iter()
            .find_map(|(_, label, enabled, parsed)| {
                // 只和启用中的工具比较：关闭的工具热键已反注册，按键撞上也无实际冲突
                parsed
                    .filter(|(_, vk)| *enabled && *vk == trigger_vk)
                    .map(|_| *label)
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

/// palette 面板窗口四周的透明留白（逻辑像素）。
///
/// 窗口尺寸 = 视觉面板 + 留白。留白是给面板的 CSS 投影展开用的：窗口尺寸若等于
/// 面板尺寸，投影没有展开空间，只在面板 18px 圆角的「缺口」里露出一小块，并被
/// 窗口边界硬切成直角（四个角各一块直角残影）。详见 ToolPalette.css 的 .palette-stage。
///
/// 留白参与窗口坐标，因此下面的锚定与边界翻转都要扣掉它，否则面板相对悬浮球
/// 会整体偏移一个留白（首次打开时表现为「间距比设定的 8px 大了 20px」）。
///
/// ⚠️ 必须与 `.palette-stage { padding }` 保持一致，改一处必须同时改另一处。
const PALETTE_SHADOW_MARGIN: f64 = 20.0;

/// palette 面板的视觉尺寸（逻辑像素），**不含**四周投影留白。
///
/// 只用于首次创建时的初始窗口尺寸，以及「首次打开」的锚定/边界翻转判断；
/// 前端挂载后会按实测内容尺寸重新 setSize 覆盖。写在这里是为了首帧就给出接近
/// 真实的值，避免窗口先小后大的跳变，也让右侧边界翻转判断（x + pw 是否越界）
/// 不会因为用了过小的宽度而漏判。
///
/// ⚠️ 必须与 `.palette-container { width }` 及 4 列卡片布局的实际高度保持一致
///    （改卡片列数/尺寸、或增删工具导致分组行数变化时一并更新，
///      否则首次打开可能越出屏幕工作区）。
///    当前值对应面板 436×486（4 列 × 96.5px 卡片；3 个分组各 1 行 = 3 行）。
const PALETTE_PANEL_WIDTH: f64 = 436.0;
const PALETTE_PANEL_HEIGHT: f64 = 486.0;

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
                    // 初始尺寸取面板实测前的估值（大约 4 列 × 4 行卡片），
                    // 前端会按真实内容尺寸再修正一次。
                    // 尺寸含四周投影留白（见 PALETTE_SHADOW_MARGIN）。
                    .inner_size(
                        PALETTE_PANEL_WIDTH + 2.0 * PALETTE_SHADOW_MARGIN,
                        PALETTE_PANEL_HEIGHT + 2.0 * PALETTE_SHADOW_MARGIN,
                    )
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
        palette.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if let Some(win) = palette_app_handle.get_webview_window("palette") {
                    let _ = win.hide();
                }
            }
            // 同 settings：销毁时复位，重建后才能重新注册关闭拦截。
            tauri::WindowEvent::Destroyed => {
                PALETTE_CLOSE_HANDLER_REGISTERED.store(false, Ordering::SeqCst);
            }
            _ => {}
        });
    }

    // Keep the initialization lock through positioning and show so rapid orb
    // clicks cannot interleave their focus and placement operations.
    // Only the first opening is anchored beside the orb. Subsequent openings retain the
    // position selected by dragging the palette window.
    if should_anchor_to_orb {
        // palette 物理尺寸：宽度固定为面板宽 + 四周投影留白，高度由前端自适应调整
        // （fit-content + setSize）。
        // 首次创建时 inner_size() 可能返回 0，使用 WebviewWindowBuilder 中指定的逻辑尺寸乘 scale_factor 作为 fallback。
        // 高度取 inner_size()（非首次时已是前端上次调整的值），首次创建 fallback 用初始值。
        let scale = palette.scale_factor().unwrap_or(1.0);
        // 留白的物理像素值：窗口坐标是物理像素，留白是逻辑像素，必须按 DPI 缩放
        let margin = (PALETTE_SHADOW_MARGIN * scale).round() as i32;
        let inner = palette.inner_size().unwrap_or_else(|_| {
            tauri::PhysicalSize::new(
                ((PALETTE_PANEL_WIDTH + 2.0 * PALETTE_SHADOW_MARGIN) * scale) as u32,
                ((PALETTE_PANEL_HEIGHT + 2.0 * PALETTE_SHADOW_MARGIN) * scale) as u32,
            )
        });
        let pw = if inner.width > 0 {
            inner.width as i32
        } else {
            ((PALETTE_PANEL_WIDTH + 2.0 * PALETTE_SHADOW_MARGIN) * scale) as i32
        };
        let ph = if inner.height > 0 {
            inner.height as i32
        } else {
            ((PALETTE_PANEL_HEIGHT + 2.0 * PALETTE_SHADOW_MARGIN) * scale) as i32
        };

        // 锚点：优先用 orb 窗口位置；失败则用鼠标位置
        let (mut x, mut y, anchor_hwnd) = if let Some(orb) = app.get_webview_window("orb") {
            match orb.outer_position() {
                Ok(p) => {
                    let oi = orb.inner_size().unwrap_or_default();
                    let ow = oi.width as i32;
                    let oh = oi.height as i32;
                    let hwnd = orb.hwnd().map(|h| h.0).unwrap_or(std::ptr::null_mut());
                    let orb_scale = orb.scale_factor().unwrap_or(1.0);
                    let visual_size = (56.0 * orb_scale).round() as i32;
                    let visual_right = p.x + (ow + visual_size) / 2;
                    let visual_bottom = p.y + (oh + visual_size) / 2;
                    // 默认放在 orb 右上方，面板边缘与 orb 间隔 8px。
                    // 窗口左上角还要再向左/向上让出留白，面板边缘才落在目标位置。
                    (visual_right + 8 - margin, visual_bottom + margin - ph, hwnd)
                }
                Err(_) => {
                    if let Ok(cur) = crate::automation::get_mouse_position() {
                        (cur.x + 8 - margin, cur.y + 8 - margin, std::ptr::null_mut())
                    } else {
                        (100, 100, std::ptr::null_mut())
                    }
                }
            }
        } else if let Ok(cur) = crate::automation::get_mouse_position() {
            (cur.x + 8 - margin, cur.y + 8 - margin, std::ptr::null_mut())
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
                                let ow =
                                    orb.inner_size().map(|size| size.width as i32).unwrap_or(96);
                                let visual_size =
                                    (56.0 * orb.scale_factor().unwrap_or(1.0)).round() as i32;
                                let visual_left = p.x + (ow - visual_size) / 2;
                                // 同理：窗口右边缘要让出留白，面板右边缘才贴在
                                // visual_left 左侧 8px（+ margin 抵消窗口自身的留白）
                                x = visual_left - pw + margin - 8;
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

/// 执行滚动导航动作（top / bottom / page-up / page-down / line-up / line-down）。
///
/// `async` + `spawn_blocking`：动作链路里含跨进程 UIA 探测与 Win32 投递，
/// 同步命令会在事件循环主线程上跑完，连带冻结所有窗口。
#[tauri::command]
pub async fn navigate_scroll(
    action: String,
) -> Result<crate::scroll_navigation::ScrollNavigationState, String> {
    tokio::task::spawn_blocking(move || crate::scroll_navigation::navigate(&action))
        .await
        .map_err(|error| format!("滚动操作被中断: {error}"))?
}

/// 退出应用（悬浮球右键菜单「退出」入口，与托盘菜单 quit 等价）
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) -> Result<(), String> {
    crate::hooks::mouse::stop_color_pick();
    crate::hooks::mouse::stop_window_pin();
    // 置顶状态写在**目标窗口**身上，不主动撤销就会残留 —— 用户会看到几扇「莫名其妙
    // 永远在最前」的窗口，而那时 Levitaire 已经退出了。托盘 quit 是同一条路径。
    crate::window_pin::cleanup();
    app.exit(0);
    Ok(())
}

/// 重启应用（托盘右键菜单「重启应用」入口）：卡顿时用它拉起一个干净进程。
///
/// `request_restart` 会触发一次完整退出流程（`RunEvent::Exit`）再拉起新进程，
/// 所以这里与 `exit_app` 一样先做显式收尾：光标/置顶这两类状态是本进程持有的
/// 系统级资源，进程一没就还不了，必须在退出前还原。
///
/// 相比直接 `process::exit` 后由外部拉起，走 `request_restart` 能让单实例插件
/// （`tauri-plugin-single-instance`）的 `on_event(Exit)` 先释放互斥体/消息窗口，
/// 新进程启动时才不会误判「已有实例在跑」而当场自退。
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    crate::hooks::mouse::stop_color_pick();
    crate::hooks::mouse::stop_window_pin();
    crate::window_pin::cleanup();
    app.request_restart();
    Ok(())
}

/// 记忆悬浮窗位置（由前端在窗口拖动结束后调用），应用重启后恢复到上次位置。
/// window_id 如 "orb"、"monitor-overlay"、"time-overlay"
#[tauri::command]
pub fn set_window_position(
    id: String,
    x: i32,
    y: i32,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    // 恢复默认位置 / 夹取回工作区期间：程序化 set_position 会触发 onMoved → 前端在
    // 300ms 后再次 set_window_position，若不忽略会把刚恢复的默认位置（或刚被挤过的位置）
    // 重新记忆。仅忽略对应窗口。判据与写入端共用 `position_save_is_suppressed`。
    if position_save_is_suppressed(&id) {
        return Ok(());
    }
    config_manager.set_window_position(&id, crate::config::WindowPosition { x, y })
}

/// 可以「恢复默认位置」的悬浮窗 id（**id 即窗口 label**）。
///
/// 判据是「前端有没有对窗口调 `persistWindowPositionOnMove`」：记了位置就必须能被复位，
/// 反之列了却没人复位就是**静默失效**。两种漂移都出现过 ——
/// `system-cleaner-overlay` 在前端清单里、后端却整段漏掉（按钮亮「已恢复」，窗口不动）；
/// `sticky-notes-manager` 记了位置却没有入口（没有任何一键复位，只能自己再拖回去）。
///
/// ⚠️ 本清单与 `src/components/Settings.tsx` 的 `WINDOW_POSITION_TARGETS` 必须逐项一致：
/// 前端按它渲染按钮并逐个下发 `reset_window_position`。守卫见
/// `commands::tests::resettable_windows_match_frontend_targets`。
pub(crate) const RESETTABLE_WINDOW_IDS: &[&str] = &[
    "orb",
    "monitor-overlay",
    "time-overlay",
    "todo-overlay",
    "system-cleaner-overlay",
    "sticky-notes-manager",
];

/// 恢复悬浮窗默认位置：清除记忆位置，并将窗口移动到默认定位。
/// 支持的 id 见 `RESETTABLE_WINDOW_IDS`。
#[tauri::command]
pub fn reset_window_position(
    id: String,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    // 清单外的 id 一律报错，不要「只清记忆、不动窗口」地返回 Ok：前端据此把按钮点亮成
    // 「已恢复」，用户却看到窗口纹丝不动，失效就此被藏起来（系统清理正是如此）。
    if !RESETTABLE_WINDOW_IDS.contains(&id.as_str()) {
        return Err(format!("窗口 {id} 不支持恢复默认位置"));
    }

    config_manager.reset_window_position(&id)?;

    // 窗口可能压根还没创建（如系统清理面板从未打开过）：此时清掉记忆坐标就够了，
    // 下次创建走前端 ensure* 的默认定位。
    let Some(win) = app.get_webview_window(&id) else {
        return Ok(());
    };
    // 窗口已存在就移动到默认定位（隐藏窗口 set_position 同样生效，下次显示即默认位置）。
    // monitor 下次显示时按未记忆逻辑跟随鼠标重新定位。
    let inner = win.inner_size().unwrap_or_default();
    let (x, y) = default_window_position(&id, inner.width as i32, inner.height as i32);
    // 抑制程序化移动触发的 onMoved 保存（前端 300ms 后调用 set_window_position）
    if let Ok(mut suppress) = position_save_suppress().lock() {
        suppress.insert(id.clone(), now_ms() + 1500);
    }
    win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        x, y,
    )))
    .map_err(|e| e.to_string())
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

/// 把**调用它的那扇窗**夹进所在显示器的工作区。
///
/// 为什么需要单独一条命令：本项目的浮窗落点由后端按光标/选区/记忆位置算出
/// （`hooks/mouse.rs`、`hooks/keyboard.rs`、各 `show_*` 里的 `clamp_position_to_workarea`
/// 都只在**首次定位**时夹），而窗口的**最终尺寸**是前端量完内容才下发的 —— 谁都不
/// 掌握「最终尺寸 + 工作区」这一对信息。于是贴屏幕右/下沿的窗口在内容变高变宽后
/// （日历切视图、监控切模式、便签加行、面板换页、工具栏弹出二维码预览）会有一部分
/// 跑到工作区外：内容被裁、按钮点不到，而这些窗口都是无边框置顶窗、没有滚动条。
/// 前端在每次 `setSize` 之后调本命令即可。
///
/// `window` 由 Tauri 自动注入为**调用方**窗口，所以前端不必（也无法）传 label ——
/// 这对便利贴那种动态 label（`sticky-note-<id>`）尤其重要。
///
/// `width` / `height` 是**逻辑**像素（前端量的 CSS px），内部按窗口缩放换算成物理像素
/// 后再夹 —— 150% 缩放下直接用逻辑值会夹不到位。
#[tauri::command]
pub fn clamp_window_to_workarea(
    window: tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let win_w = (width * scale).round() as i32;
    let win_h = (height * scale).round() as i32;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let (x, y) = clamp_position_to_workarea(pos.x, pos.y, win_w, win_h);
    if x != pos.x || y != pos.y {
        // 这次移动是**程序性**的（内容变高变宽后被挤回工作区），不是用户拖的。
        // 前端 `persistWindowPositionOnMove` 监听 `onMoved` —— 程序性移动同样会触发 ——
        // 并在 300ms 后写回位置记忆。不抑制就会把"被挤过的位置"当成用户的选择永久记住：
        // 内容缩回后窗口不回落，反复几次就累积成位置漂移。
        // `reset_window_position` 早就为此挂了 1500ms 抑制，这条路径同理。
        if let Ok(mut suppress) = position_save_suppress().lock() {
            suppress.insert(window.label().to_string(), now_ms() + 1500);
        }
        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
                x, y,
            )))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::classify_hotkey_status;

    #[test]
    fn test_disabled_tool_is_not_reported_as_external_conflict() {
        // 工具关闭后热键被反注册，未注册是预期状态，不能报成被其他程序占用
        let (status, message) = classify_hotkey_status(false, false, None);
        assert_eq!(status, "disabled");
        assert_eq!(message, "工具未启用，快捷键未占用");
    }

    #[test]
    fn test_disabled_tool_wins_over_internal_conflict() {
        // 关闭的工具不注册热键，与其他功能的按键重合也不构成现实冲突
        let (status, _) = classify_hotkey_status(false, false, Some("截图"));
        assert_eq!(status, "disabled");
    }

    #[test]
    fn test_enabled_unregistered_tool_is_external_conflict() {
        let (status, message) = classify_hotkey_status(true, false, None);
        assert_eq!(status, "external-conflict");
        assert_eq!(message, "快捷键可能已被其他程序占用");
    }

    #[test]
    fn test_enabled_registered_tool_is_available() {
        let (status, message) = classify_hotkey_status(true, true, None);
        assert_eq!(status, "available");
        assert_eq!(message, "快捷键可用");
    }

    #[test]
    fn test_internal_conflict_precedes_registration_state() {
        // 内部冲突的提示要落实到具体功能名上，而不是笼统的「可能被占用」
        let (status, message) = classify_hotkey_status(true, true, Some("录屏"));
        assert_eq!(status, "internal-conflict");
        assert!(message.contains("录屏"));
    }
}
