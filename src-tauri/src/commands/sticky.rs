use super::*;


#[tauri::command]
pub fn get_sticky_notes_enabled(
    config_manager: State<'_, ConfigManager>,
) -> Result<bool, String> {
    config_manager.get_sticky_notes_enabled()
}


#[tauri::command]
pub fn set_sticky_notes_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    if !enabled {
        // 关闭工具：隐藏管理窗，销毁所有便签窗（数据与 visible 保留，重新启用时恢复）
        if let Some(manager) = app.get_webview_window("sticky-notes-manager") {
            let _ = manager.hide();
        }
        if let Some(store) = app.try_state::<crate::sticky_note::NoteStore>() {
            if let Ok(notes) = store.list() {
                for note in notes {
                    crate::sticky_note::destroy_note_window(&app, &note.id);
                }
            }
        }
    }
    config_manager.update_sticky_notes_enabled(enabled)
}


#[tauri::command]
pub fn get_sticky_notes(
    store: State<'_, crate::sticky_note::NoteStore>,
) -> Result<Vec<crate::sticky_note::StickyNote>, String> {
    store.list()
}


#[tauri::command]
pub fn get_sticky_note(
    id: String,
    store: State<'_, crate::sticky_note::NoteStore>,
) -> Result<crate::sticky_note::StickyNote, String> {
    store.get(&id)
}


/// 新建一张便签并立即在桌面显示聚焦（方便直接输入）。
#[tauri::command]
pub fn create_sticky_note(
    app: tauri::AppHandle,
    color_id: Option<String>,
    x: Option<i32>,
    y: Option<i32>,
    store: State<'_, crate::sticky_note::NoteStore>,
) -> Result<crate::sticky_note::StickyNote, String> {
    let (dx, dy) = default_sticky_note_position(store.list()?.len());
    let color = color_id.unwrap_or_else(|| crate::sticky_note::DEFAULT_COLOR_ID.to_string());
    let note = store.create(&color, x.unwrap_or(dx), y.unwrap_or(dy))?;
    crate::sticky_note::show_note_window(&app, &note, true)?;
    notify_sticky_notes_changed(&app);
    Ok(note)
}


#[tauri::command]
pub fn update_sticky_note_content(
    app: tauri::AppHandle,
    id: String,
    content: String,
    store: State<'_, crate::sticky_note::NoteStore>,
) -> Result<crate::sticky_note::StickyNote, String> {
    let note = store.update_content(&id, &content)?;
    notify_sticky_notes_changed(&app);
    Ok(note)
}


#[tauri::command]
pub fn update_sticky_note_color(
    app: tauri::AppHandle,
    id: String,
    color_id: String,
    store: State<'_, crate::sticky_note::NoteStore>,
) -> Result<crate::sticky_note::StickyNote, String> {
    let note = store.update_color(&id, &color_id)?;
    notify_sticky_notes_changed(&app);
    Ok(note)
}


/// 拖拽过程中回写窗口位置（物理像素）。调用频繁，不触发列表刷新事件。
#[tauri::command]
pub fn set_sticky_note_position(
    id: String,
    x: i32,
    y: i32,
    store: State<'_, crate::sticky_note::NoteStore>,
) -> Result<(), String> {
    store.update_position(&id, x, y)?;
    Ok(())
}


/// 唤出某张（可能已收起）便签：标记 visible=true 并重建/聚焦窗口。
#[tauri::command]
pub fn show_sticky_note(
    app: tauri::AppHandle,
    id: String,
    store: State<'_, crate::sticky_note::NoteStore>,
) -> Result<crate::sticky_note::StickyNote, String> {
    let note = store.set_visible(&id, true)?;
    crate::sticky_note::show_note_window(&app, &note, true)?;
    notify_sticky_notes_changed(&app);
    Ok(note)
}


/// 收起某张便签：先落盘（若携带最新正文），再标记 visible=false 并销毁窗口。
/// content 由前端在收起瞬间主动传入，避免「防抖保存尚未触发窗口就被销毁」导致丢字。
#[tauri::command]
pub fn collect_sticky_note(
    app: tauri::AppHandle,
    id: String,
    content: Option<String>,
    store: State<'_, crate::sticky_note::NoteStore>,
) -> Result<crate::sticky_note::StickyNote, String> {
    if let Some(text) = content {
        store.update_content(&id, &text)?;
    }
    let note = store.set_visible(&id, false)?;
    crate::sticky_note::destroy_note_window(&app, &id);
    notify_sticky_notes_changed(&app);
    Ok(note)
}


/// 一键收起所有已钉在桌面的便签。
#[tauri::command]
pub fn collect_all_notes(
    app: tauri::AppHandle,
    store: State<'_, crate::sticky_note::NoteStore>,
) -> Result<(), String> {
    let notes = store.list()?;
    for note in notes {
        if note.visible {
            store.set_visible(&note.id, false)?;
            crate::sticky_note::destroy_note_window(&app, &note.id);
        }
    }
    notify_sticky_notes_changed(&app);
    Ok(())
}


/// 彻底删除一张便签（数据与窗口一并移除）。
/// 顺序：先销毁窗口，再校验并删除记录，最后清理图片目录——
/// 确保只在便签确实存在时才触碰文件系统，避免误删孤儿路径。
#[tauri::command]
pub fn delete_sticky_note(
    app: tauri::AppHandle,
    id: String,
    store: State<'_, crate::sticky_note::NoteStore>,
) -> Result<(), String> {
    crate::sticky_note::destroy_note_window(&app, &id);
    store.delete(&id)?;
    crate::sticky_note::delete_images(&app, &id);
    notify_sticky_notes_changed(&app);
    Ok(())
}


/// 便利贴图片根目录（绝对路径），前端用于 convertFileSrc 构造图片地址。
#[tauri::command]
pub fn get_sticky_note_images_dir(app: tauri::AppHandle) -> Result<String, String> {
    crate::sticky_note::images_dir(&app).map(|dir| dir.to_string_lossy().to_string())
}


/// 保存剪贴板粘贴的图片，返回正文令牌中的相对路径。
/// 先校验便签存在，避免并发删除后仍重建其图片目录（孤儿文件）。
#[tauri::command]
pub fn save_sticky_note_image(
    app: tauri::AppHandle,
    note_id: String,
    base64_data: String,
    store: State<'_, crate::sticky_note::NoteStore>,
) -> Result<String, String> {
    store.get(&note_id)?;
    let bytes = decode_base64_media(&base64_data, "图片")?;
    let rel = crate::sticky_note::save_image(&app, &note_id, &bytes)?;
    // 写入后复核便签仍存在：若并发删除（delete_sticky_note 会清理图片目录）落在
    // 写盘之前，本函数会重建已删除便签的图片目录留下孤儿文件，这里兜底清理并报错。
    if store.get(&note_id).is_err() {
        crate::sticky_note::delete_images(&app, &note_id);
        return Err("便签已删除".to_string());
    }
    Ok(rel)
}


/// 应用启动/管理窗挂载时调用：把所有已钉在桌面的便签窗口重建出来。
/// 仅在工具启用时生效；不抢焦点。
#[tauri::command]
pub fn restore_pinned_notes(
    app: tauri::AppHandle,
    store: State<'_, crate::sticky_note::NoteStore>,
    config_manager: State<'_, ConfigManager>,
) -> Result<usize, String> {
    if !config_manager.get_sticky_notes_enabled()? {
        return Ok(0);
    }
    let notes = store.list()?;
    let mut count = 0;
    for note in &notes {
        if note.visible {
            crate::sticky_note::show_note_window(&app, note, false)?;
            count += 1;
        }
    }
    Ok(count)
}


/// 显示便利贴管理窗。关闭拦截仅隐藏、不销毁，便于下次快速唤出。
#[tauri::command]
pub fn show_sticky_notes_manager(
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let win = app
        .get_webview_window("sticky-notes-manager")
        .ok_or_else(|| "sticky-notes-manager 窗口未找到".to_string())?;
    win.set_size(tauri::LogicalSize::new(360.0, 560.0))
        .map_err(|e| e.to_string())?;
    if !STICKY_MANAGER_CLOSE_HANDLER_REGISTERED.swap(true, Ordering::SeqCst) {
        let on_close = win.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = on_close.hide();
            }
        });
    }
    if !win.is_visible().unwrap_or(true) {
        if let Ok(Some(pos)) = config_manager.get_window_position("sticky-notes-manager") {
            let inner = win.inner_size().unwrap_or_default();
            let (x, y) =
                clamp_position_to_workarea(pos.x, pos.y, inner.width as i32, inner.height as i32);
            win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
                x, y,
            )))
            .map_err(|e| e.to_string())?;
        }
    }
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}


#[tauri::command]
pub fn hide_sticky_notes_manager(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("sticky-notes-manager") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}
