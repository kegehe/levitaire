use super::*;


/// Called periodically by the screenshot overlay renderer. The native
/// watchdog uses this to hide and clean up a crashed or reloading WebView.
#[tauri::command]
pub fn mark_screenshot_overlay_heartbeat() {
    if CAPTURE_SESSION_ACTIVE.load(Ordering::SeqCst) {
        SCREENSHOT_OVERLAY_HEARTBEAT_SEEN.store(true, Ordering::SeqCst);
        SCREENSHOT_OVERLAY_HEARTBEAT_MS.store(now_ms(), Ordering::SeqCst);
    }
}


/// Show a native error when the screenshot overlay cannot be created or loaded
/// and there is no screenshot frontend available to render an inline message.
#[tauri::command]
pub fn show_screenshot_error(message: String) {
    show_screenshot_native_error(message);
}


/// 获取截图快捷键（空串表示未设置）
#[tauri::command]
pub fn get_screenshot_hotkey(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_screenshot_hotkey()
}


/// 设置截图快捷键：解析、注册全局热键（带冲突检测）、持久化。
/// 传入空串则反注册并清除。
/// 返回 Ok(()) 成功；Err 为冲突或无效格式信息。
#[tauri::command]
pub fn set_screenshot_hotkey(
    hotkey: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let trimmed = hotkey.trim().to_string();
    let previous = config_manager.get_screenshot_hotkey()?;
    if trimmed.is_empty() {
        crate::hooks::hotkey::unregister_hotkey(crate::hooks::hotkey::HotkeySlotId::Screenshot);
        if let Err(error) = config_manager.update_screenshot_hotkey(String::new()) {
            let _ = config_manager.update_screenshot_hotkey(previous.clone());
            if !previous.is_empty() {
                let _ = crate::hooks::hotkey::register_hotkey(
                    crate::hooks::hotkey::HotkeySlotId::Screenshot,
                    &previous,
                );
            }
            return Err(error);
        }
        return Ok(());
    }
    // 先注册（含冲突检测），成功后再持久化。
    // register_hotkey 内部会先反注册旧的再注册新的；若新的失败会尝试回滚恢复旧的，避免新旧皆失。
    crate::hooks::hotkey::register_hotkey(
        crate::hooks::hotkey::HotkeySlotId::Screenshot,
        &trimmed,
    )?;
    if let Err(error) = config_manager.update_screenshot_hotkey(trimmed) {
        let _ = config_manager.update_screenshot_hotkey(previous.clone());
        if previous.is_empty() {
            crate::hooks::hotkey::unregister_hotkey(crate::hooks::hotkey::HotkeySlotId::Screenshot);
        } else {
            let _ = crate::hooks::hotkey::register_hotkey(
                crate::hooks::hotkey::HotkeySlotId::Screenshot,
                &previous,
            );
        }
        return Err(error);
    }
    Ok(())
}


/// 设置截图工具启用状态（仅启用时热键才触发），同时持久化到配置
#[tauri::command]
pub fn set_screenshot_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let previous = config_manager.get_screenshot_enabled()?;
    if let Err(error) = config_manager.update_screenshot_enabled(enabled) {
        let _ = config_manager.update_screenshot_enabled(previous);
        return Err(error);
    }
    crate::hooks::hotkey::set_screenshot_enabled(enabled);
    if !enabled {
        cleanup_screenshot_session(&app);
        // 贴图窗是独立原生窗口，会话清理不会碰它们。截图工具被禁用（含 palette 的
        // 「全部关闭」）时把桌面上钉的图一并收起，否则会留下「关了但窗口还在」的观感。
        crate::screenshot::pin::close_all_pins(&app);
    }
    Ok(())
}


/// 获取截图工具启用状态（供前端卡片开关与后端真值同步）
#[tauri::command]
pub fn get_screenshot_enabled(config_manager: State<'_, ConfigManager>) -> Result<bool, String> {
    config_manager.get_screenshot_enabled()
}


#[tauri::command]
pub async fn start_screenshot(app: tauri::AppHandle) -> Result<(), String> {
    // 命令入口：Tauri 注入 app，缓存 State 在内部用 app.state() 获取
    let result = tokio::task::spawn_blocking(move || start_screenshot_inner(app))
        .await
        .map_err(|error| format!("screenshot startup worker failed: {error}"))?;
    match result {
        Ok(()) => Ok(()),
        Err(error) => {
            // The caller may be a global hotkey with no visible frontend from
            // which to render an error. Always provide a native error surface.
            if error != "截图会话已结束" {
                show_screenshot_native_error(format!("截图启动失败：{}", error));
            }
            Err(error)
        }
    }
}


/// 获取虚拟桌面边界（多显示器并集，含负坐标原点），供截图遮罩前端换算绝对坐标
#[tauri::command]
pub fn get_virtual_desktop_bounds() -> Result<serde_json::Value, String> {
    let b = crate::screenshot::virtual_desktop_bounds()?;
    Ok(serde_json::json!({
        "originX": b.origin_x,
        "originY": b.origin_y,
        "width": b.width,
        "height": b.height,
    }))
}


/// 获取截图控件应使用的显示器工作区。活跃会话优先使用启动截图时
/// 捕获的显示器，避免前端加载期间鼠标移动造成控件跳到另一块屏幕。
#[tauri::command]
pub fn get_screenshot_monitor_bounds() -> Result<serde_json::Value, String> {
    let stored = screenshot_monitor_bounds()
        .lock()
        .ok()
        .and_then(|guard| *guard);
    let monitor = if CAPTURE_SESSION_ACTIVE.load(Ordering::SeqCst)
        || SCREENSHOT_STARTING.load(Ordering::SeqCst)
    {
        stored.or_else(monitor_work_area_for_cursor)
    } else {
        monitor_work_area_for_cursor().or(stored)
    };
    let bounds = monitor.or_else(|| {
        crate::screenshot::virtual_desktop_bounds()
            .ok()
            .map(|b| ScreenshotMonitorBounds {
                left: b.origin_x,
                top: b.origin_y,
                right: b.origin_x.saturating_add(b.width),
                bottom: b.origin_y.saturating_add(b.height),
            })
    });
    let b = bounds.ok_or_else(|| "无法获取显示器工作区".to_string())?;
    Ok(serde_json::json!({
        "left": b.left,
        "top": b.top,
        "right": b.right,
        "bottom": b.bottom,
    }))
}


/// 返回全屏缓存的 PNG base64（不带 data: 前缀），供前端放大镜铺底取像素。
/// 缓存由 start_screenshot 在 overlay 显示前截取，为纯净桌面画面。
/// 缓存未就绪时返回 Err，前端降级为仅显示十字线。
///
/// # 必须保持 `async`，且编码走 `spawn_blocking`
///
/// 这是整屏级别的 PNG 编码（缓存上限 `MAX_SCREENSHOT_PIXELS`，最坏约 128MB BGRA），
/// 同步命令会跑在主线程，编码期间阻塞窗口事件循环、冻结整个应用。
/// 这里先在 async 线程上取出像素并立即释放缓存锁，再交给阻塞线程池编码——
/// 主线程与缓存锁都不参与编码，与 `capture_from_cache`「锁内取数据、锁外处理」
/// 的既有做法一致（该处同样把 PNG 编码放在 spawn_blocking 里）。
#[tauri::command]
pub async fn get_screen_cache_png(
    cache: tauri::State<'_, crate::screenshot::ScreenCache>,
) -> Result<String, String> {
    let (bgra, width, height) = {
        let guard = cache.pixels.lock().map_err(|e| e.to_string())?;
        let c = guard.as_ref().ok_or_else(|| "截图缓存未就绪".to_string())?;
        (c.bgra.clone(), c.width, c.height)
    };
    tokio::task::spawn_blocking(move || crate::screenshot::encode_png_base64(&bgra, width, height))
        .await
        .map_err(|error| format!("截图缓存编码任务失败: {}", error))?
}


/// 退出截图模式：隐藏遮罩并恢复鼠标钩子
#[tauri::command]
pub fn cancel_screenshot(app: tauri::AppHandle) -> Result<(), String> {
    crate::utils::logger::log("screenshot", "cancel_screenshot command called");
    cleanup_screenshot_session(&app);
    Ok(())
}


/// 截取屏幕指定区域（物理坐标），返回 PNG base64 与尺寸。
/// 优先从 start_screenshot 截取的全屏缓存裁剪选区（不含截图 UI，无需 hide/show overlay，不闪屏）；
/// 缓存缺失时回退到 hide/show 实时截屏。async + spawn_blocking 把 PNG 编码移出主线程，
/// 避免大区域编码时阻塞窗口事件循环造成卡顿。
#[tauri::command]
pub async fn capture_region(
    app: tauri::AppHandle,
    left: i32,
    top: i32,
    width: i32,
    height: i32,
) -> Result<serde_json::Value, String> {
    crate::utils::logger::log(
        "screenshot",
        &format!("capture_region: ({},{}) {}x{}", left, top, width, height),
    );
    if width <= 0 || height <= 0 {
        return Err("截图区域尺寸无效".into());
    }
    let w = width as u32;
    let h = height as u32;
    let cache = app.state::<crate::screenshot::ScreenCache>();
    let bgra = capture_from_cache(&app, &cache, left, top, w, h)?;
    let b64 =
        tokio::task::spawn_blocking(move || crate::screenshot::encode_png_base64(&bgra, w, h))
            .await
            .map_err(|error| format!("截图编码任务失败: {error}"))??;
    Ok(serde_json::json!({
        "pngBase64": b64,
        "width": w,
        "height": h,
    }))
}


/// Detect the element or top-level window under a physical cursor position.
#[tauri::command]
pub fn detect_screenshot_target(
    app: tauri::AppHandle,
    x: i32,
    y: i32,
    scope: String,
) -> Result<Option<crate::screenshot::target::ScreenshotTarget>, String> {
    let _overlay_guard = SMART_SCREENSHOT_OVERLAY_LOCK
        .lock()
        .map_err(|_| "智能截图蒙层状态锁已损坏".to_string())?;
    if !CAPTURE_SESSION_ACTIVE.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let overlay = app.get_webview_window("screenshot-overlay");
    // The overlay is interactive so its mode bar can receive clicks. Temporarily
    // make it click-through while resolving the underlying native target.
    if let Some(window) = &overlay {
        let _ = window.set_ignore_cursor_events(true);
    }
    let scope = if scope == "window" {
        crate::screenshot::target::TargetScope::Window
    } else {
        crate::screenshot::target::TargetScope::Element
    };
    let target =
        crate::screenshot::target::detect(windows::Win32::Foundation::POINT { x, y }, scope);
    if let Some(window) = &overlay {
        let _ = window.set_ignore_cursor_events(false);
    }
    if let Some(target) = &target {
        if let Some(overlay) = app.get_webview_window("screenshot-overlay") {
            if let Ok(hwnd) = overlay.hwnd() {
                if target.hwnd == hwnd.0 as isize {
                    return Ok(None);
                }
            }
        }
    }
    Ok(target)
}


/// 智能（窗口）截图取图：与区域截图一致，从会话全屏缓存裁剪选区。
/// 历史实现直接 hide/show 整个透明 overlay 再实时截屏，每次点击都会让整屏
/// 明暗闪一次；改为缓存裁剪后与区域截图口径统一，且不会把 overlay 上的
/// 目标高亮框截入底图，仅在缓存缺失时回退到 hide/show 实时截屏。
/// PNG 编码同样在阻塞线程池执行。
#[tauri::command]
pub async fn capture_region_live(
    app: tauri::AppHandle,
    left: i32,
    top: i32,
    width: i32,
    height: i32,
) -> Result<serde_json::Value, String> {
    if width <= 0 || height <= 0 {
        return Err("截图区域尺寸无效".into());
    }
    let w = width as u32;
    let h = height as u32;
    let cache = app.state::<crate::screenshot::ScreenCache>();
    let bgra = capture_from_cache(&app, &cache, left, top, w, h)?;
    let b64 =
        tokio::task::spawn_blocking(move || crate::screenshot::encode_png_base64(&bgra, w, h))
            .await
            .map_err(|error| format!("截图编码任务失败: {error}"))??;
    Ok(serde_json::json!({ "pngBase64": b64, "width": w, "height": h }))
}


#[tauri::command]
pub fn set_smart_screenshot_mode(app: tauri::AppHandle, active: bool) -> Result<(), String> {
    let _overlay_guard = SMART_SCREENSHOT_OVERLAY_LOCK
        .lock()
        .map_err(|_| "智能截图蒙层状态锁已损坏".to_string())?;
    // Ignore a stale renderer command that arrives after session cleanup. It
    // must not re-arm the global mouse hook for a hidden/finished overlay.
    let effective_active = active && CAPTURE_SESSION_ACTIVE.load(Ordering::SeqCst);
    crate::hooks::mouse::set_smart_screenshot_mode(effective_active);
    if let Some(overlay) = app.get_webview_window("screenshot-overlay") {
        overlay
            .set_ignore_cursor_events(false)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}


#[tauri::command]
pub fn set_smart_screenshot_controls_bounds(
    left: i32,
    top: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    crate::hooks::mouse::set_smart_screenshot_controls_bounds(Some((left, top, width, height)));
    Ok(())
}


/// 将 base64 PNG 写入剪贴板
#[tauri::command]
pub fn clipboard_set_image(
    base64_data: String,
    clipboard: State<'_, ClipboardManager>,
) -> Result<(), String> {
    let bytes = decode_base64_media(&base64_data, "图片")?;
    clipboard.copy_image(&bytes).map_err(|e| e.to_string())
}


/// 对屏幕区域执行 OCR 识别，返回文本
/// async：模型懒加载与识别在 spawn_blocking 阻塞池执行，避免首次使用时阻塞 UI 主线程
#[tauri::command]
pub async fn ocr_region(
    app: tauri::AppHandle,
    cache: tauri::State<'_, crate::screenshot::ScreenCache>,
    left: i32,
    top: i32,
    width: i32,
    height: i32,
) -> Result<String, String> {
    if width <= 0 || height <= 0 {
        return Err("OCR 区域尺寸无效".into());
    }
    let w = width as u32;
    let h = height as u32;
    crate::utils::logger::log(
        "ocr",
        &format!("ocr_region: ({},{}) {}x{}", left, top, w, h),
    );
    let bgra = capture_from_cache(&app, &cache, left, top, w, h)?;
    tokio::task::spawn_blocking(move || {
        let result = crate::ocr::ensure_ocr_service()
            .ok_or_else(|| "OCR 服务初始化失败".to_string())?
            .lock()
            .map_err(|e| format!("OCR 服务锁失败: {}", e))?
            .recognize_bgra(&bgra, w, h);
        match result {
            Ok(result) => {
                crate::utils::logger::log(
                    "ocr",
                    &format!(
                        "ocr_region completed: engine={}, chars={}, elapsed={}ms",
                        result.engine,
                        result.text.chars().count(),
                        result.elapsed_ms
                    ),
                );
                Ok(result.text)
            }
            Err(error) => {
                crate::utils::logger::log("ocr", &format!("ocr_region failed: {}", error));
                Err(error.to_string())
            }
        }
    })
    .await
    .map_err(|e| format!("OCR 任务执行失败: {}", e))?
}


/// 将截图钉在桌面（创建贴图窗口），返回 pin id。
/// async + spawn_blocking：base64/PNG 解码与建窗参数准备移出主线程，避免大图解码
/// 阻塞窗口事件循环；窗口本身仍在独立线程创建并跑消息循环（见 pin::create_pin）。
#[tauri::command]
pub async fn pin_image(
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
    base64_data: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<u32, String> {
    crate::utils::logger::log(
        "screenshot",
        &format!("pin_image called: ({},{}) {}x{}", x, y, width, height),
    );
    if width <= 0 || height <= 0 {
        return Err("贴图尺寸无效".into());
    }
    let border_color = config_manager.get_pin_border_color()?;
    let border_width = config_manager.get_pin_border_width()?;
    let app_for_blocking = app.clone();
    let id = tokio::task::spawn_blocking(move || {
        crate::screenshot::pin::create_pin(
            &app_for_blocking,
            &base64_data,
            x,
            y,
            width as u32,
            height as u32,
            &border_color,
            border_width,
        )
    })
    .await
    .map_err(|error| format!("贴图创建任务失败: {error}"))??;
    crate::utils::logger::log("screenshot", &format!("pin_image created id={}", id));
    Ok(id)
}


/// 关闭指定贴图
#[tauri::command]
pub fn close_pin(app: tauri::AppHandle, id: u32) -> Result<(), String> {
    crate::screenshot::pin::close_pin(&app, id)
}


#[tauri::command]
pub fn pin_context_menu_action(id: u32, action: String) -> Result<(), String> {
    crate::screenshot::pin::context_menu_action(id, &action)
}


/// 弹出系统保存对话框，将 base64 编码的 PNG 数据保存为文件
/// 如果配置了截图保存路径，直接保存到该目录（自动生成带时间戳的文件名）；
/// 否则弹出文件保存对话框让用户选择位置
#[tauri::command]
pub async fn save_image(
    app: tauri::AppHandle,
    base64_data: String,
    filename: String,
) -> Result<bool, String> {
    let bytes = decode_base64_media(&base64_data, "图片")?;

    // 检查是否配置了截图保存路径
    let config_manager = app.state::<ConfigManager>();
    let save_path = config_manager.get_screenshot_save_path()?;
    if !save_path.is_empty() {
        let dir = std::path::Path::new(&save_path);
        if dir.is_dir() {
            let now = chrono::Local::now();
            let timestamp = now.format("%Y%m%d_%H%M%S");
            let millis = now.timestamp_subsec_millis();
            let ext = std::path::Path::new(&filename)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("png");
            let auto_filename = format!("screenshot_{}_{}.{}", timestamp, millis, ext);
            let full_path = dir.join(&auto_filename);
            return tokio::task::spawn_blocking(move || {
                std::fs::write(&full_path, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;
                Ok(true)
            })
            .await
            .map_err(|e| format!("任务执行失败: {}", e))?;
        }
        // 配置的目录不存在，回退到对话框模式
    }

    // 原生保存对话框的 owner 与置顶处理：
    // - 截图/标注流程：owner = 可见的 screenshot-overlay，Windows 会把对话框置于
    //   截图画面之上并保留画面，行为与 Snipaste 一致；
    // - 草稿流程（SketchTool 也调本命令）：overlay 通常不存在，owner 退回可见的
    //   sketch-overlay —— 否则对话框无 owner，会被全屏置顶的草稿窗**完全盖住**
    //   （实测：置顶窗压住无主对话框，SetForegroundWindow 也抬不上来），表现为
    //   「点保存后没有任何反应」。
    // DialogTopmostGuard 还会临时取消**所有可见自有置顶窗**的置顶并在 Drop 时恢复：
    // 只设 owner 挡不住「另一扇前台置顶窗」，实测过。
    let guard = DialogTopmostGuard::suspend(&app, &["screenshot-overlay", "sketch-overlay"]);

    let mut dialog = rfd::FileDialog::new()
        .set_file_name(&filename)
        .add_filter("PNG 图片", &["png"]);
    if let Some(owner) = guard.owner() {
        dialog = dialog.set_parent(owner);
    }

    let result = tokio::task::spawn_blocking(move || {
        let path = dialog.save_file();

        match path {
            Some(path) => {
                std::fs::write(&path, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;
                Ok(true)
            }
            None => Ok(false),
        }
    })
    .await; // 不在此处用 ? 提前返回，确保下方置顶状态恢复

    // 无论任务结果如何（含 panic/取消），都恢复被临时取消的置顶。
    drop(guard);

    result.map_err(|e| format!("任务执行失败: {}", e))?
}


/// 查询截图/录屏捕获会话是否激活。screenshot-overlay 渲染进程挂载时调用，
/// 用于在 capture-session-active 事件可能早于监听器注册而丢失的情况下，
/// 同步心跳定时器的启停初态（会话激活即需持续心跳，空闲则停发）。
#[tauri::command]
pub fn is_capture_session_active() -> bool {
    CAPTURE_SESSION_ACTIVE.load(Ordering::SeqCst)
}


/// 获取截图文件保存路径（空串表示未设置，每次保存时弹出对话框）
#[tauri::command]
pub fn get_screenshot_save_path(
    config_manager: State<'_, ConfigManager>,
) -> Result<String, String> {
    config_manager.get_screenshot_save_path()
}


/// 更新截图文件保存路径并持久化
#[tauri::command]
pub fn set_screenshot_save_path(
    path: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_screenshot_save_path(path)
}


/// 获取贴图窗口边框颜色（#RRGGBB）
#[tauri::command]
pub fn get_pin_border_color(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_pin_border_color()
}


/// 更新贴图窗口边框颜色并持久化
#[tauri::command]
pub fn set_pin_border_color(
    color: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_pin_border_color(color)
}


/// 获取贴图窗口边框粗细（像素）
#[tauri::command]
pub fn get_pin_border_width(config_manager: State<'_, ConfigManager>) -> Result<u32, String> {
    config_manager.get_pin_border_width()
}


/// 更新贴图窗口边框粗细并持久化
#[tauri::command]
pub fn set_pin_border_width(
    width: u32,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_pin_border_width(width)
}
