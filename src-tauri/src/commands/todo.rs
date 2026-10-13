use super::*;


// ─── 待办清单 ──────────────────────────────────────────────────

#[tauri::command]
pub fn get_todos(
    include_completed: Option<bool>,
    sort_mode: Option<String>,
    state: State<'_, crate::todo::TodoStore>,
) -> Result<Vec<crate::todo::TodoItem>, String> {
    state.list(include_completed.unwrap_or(true), sort_mode.as_deref())
}


#[tauri::command]
pub fn get_deleted_todos(
    state: State<'_, crate::todo::TodoStore>,
) -> Result<Vec<crate::todo::TodoItem>, String> {
    state.deleted()
}


#[tauri::command]
pub fn purge_deleted_todos(
    app: tauri::AppHandle,
    state: State<'_, crate::todo::TodoStore>,
) -> Result<(), String> {
    state.purge_deleted()?;
    let _ = app.emit("todo-changed", serde_json::json!({ "trashPurged": true }));
    Ok(())
}


/// 导出待办为 JSON。
///
/// 必须是异步命令：① 内部打开**阻塞式**系统文件对话框，同步命令会在主线程 inline
/// 执行、把 WebView 一起卡住；② `DialogTopmostGuard` 要读窗口可见性/置顶态。
///
/// 待办窗是 alwaysOnTop，而 rfd 不带 parent 时给 `IFileDialog::Show` 传 NULL owner
/// ⇒ 对话框会被自己的窗口**完全盖住**（实测：置顶窗压住无主对话框，且
/// `SetForegroundWindow` 也抬不上来），表现为「点了导出没有任何反应」。
#[tauri::command]
pub async fn export_todos(
    app: tauri::AppHandle,
    state: State<'_, crate::todo::TodoStore>,
) -> Result<bool, String> {
    let guard = DialogTopmostGuard::suspend(&app, &["todo-overlay"]);
    let mut dialog = rfd::FileDialog::new()
        .add_filter("Todo JSON", &["json"])
        .set_file_name("levitaire-todos.json");
    if let Some(owner) = guard.owner() {
        dialog = dialog.set_parent(owner);
    }
    let picked = tokio::task::spawn_blocking(move || dialog.save_file())
        .await
        .map_err(|e| format!("保存对话框任务失败: {}", e))?;
    drop(guard);
    let Some(path) = picked else {
        return Ok(false);
    };
    state.export_to(&path)?;
    Ok(true)
}


/// 从 JSON 导入待办（异步原因同 [`export_todos`]）。
#[tauri::command]
pub async fn import_todos(
    app: tauri::AppHandle,
    state: State<'_, crate::todo::TodoStore>,
) -> Result<bool, String> {
    let guard = DialogTopmostGuard::suspend(&app, &["todo-overlay"]);
    let mut dialog = rfd::FileDialog::new().add_filter("Todo JSON", &["json"]);
    if let Some(owner) = guard.owner() {
        dialog = dialog.set_parent(owner);
    }
    let picked = tokio::task::spawn_blocking(move || dialog.pick_file())
        .await
        .map_err(|e| format!("打开对话框任务失败: {}", e))?;
    drop(guard);
    let Some(path) = picked else {
        return Ok(false);
    };
    state.import_from(&path)?;
    let _ = app.emit("todo-changed", serde_json::json!({ "imported": true }));
    Ok(true)
}


#[tauri::command]
pub fn reorder_todos(
    id: String,
    direction: i32,
    app: tauri::AppHandle,
    state: State<'_, crate::todo::TodoStore>,
) -> Result<crate::todo::TodoItem, String> {
    let item = state.reorder(&id, direction)?;
    let _ = app.emit("todo-changed", &item);
    Ok(item)
}


#[tauri::command]
pub fn move_todo(
    id: String,
    before_id: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, crate::todo::TodoStore>,
) -> Result<crate::todo::TodoItem, String> {
    let item = state.move_to(&id, before_id.as_deref())?;
    let _ = app.emit("todo-changed", &item);
    Ok(item)
}


#[tauri::command]
pub fn get_todo_lists(
    state: State<'_, crate::todo::TodoStore>,
) -> Result<Vec<crate::todo::TodoList>, String> {
    state.list_lists()
}


#[tauri::command]
pub fn create_todo_list(
    input: crate::todo::CreateTodoListInput,
    app: tauri::AppHandle,
    state: State<'_, crate::todo::TodoStore>,
) -> Result<crate::todo::TodoList, String> {
    let list = state.create_list(input)?;
    let _ = app.emit("todo-changed", &list);
    Ok(list)
}


#[tauri::command]
pub fn update_todo_list(
    id: String,
    input: crate::todo::UpdateTodoListInput,
    app: tauri::AppHandle,
    state: State<'_, crate::todo::TodoStore>,
) -> Result<crate::todo::TodoList, String> {
    let list = state.update_list(&id, input)?;
    let _ = app.emit("todo-changed", &list);
    Ok(list)
}


#[tauri::command]
pub fn delete_todo_list(
    id: String,
    app: tauri::AppHandle,
    state: State<'_, crate::todo::TodoStore>,
) -> Result<(), String> {
    state.delete_list(&id)?;
    let _ = app.emit(
        "todo-changed",
        serde_json::json!({ "id": id, "listDeleted": true }),
    );
    Ok(())
}


#[tauri::command]
pub fn create_todo(
    input: crate::todo::CreateTodoInput,
    app: tauri::AppHandle,
    state: State<'_, crate::todo::TodoStore>,
) -> Result<crate::todo::TodoItem, String> {
    let item = state.create(input)?;
    let _ = app.emit("todo-changed", &item);
    Ok(item)
}


#[tauri::command]
pub fn update_todo(
    id: String,
    input: crate::todo::UpdateTodoInput,
    app: tauri::AppHandle,
    state: State<'_, crate::todo::TodoStore>,
) -> Result<crate::todo::TodoItem, String> {
    let item = state.update(&id, input)?;
    let _ = app.emit("todo-changed", &item);
    Ok(item)
}


#[tauri::command]
pub fn set_todo_completed(
    id: String,
    completed: bool,
    app: tauri::AppHandle,
    state: State<'_, crate::todo::TodoStore>,
) -> Result<crate::todo::TodoItem, String> {
    let item = state.set_completed(&id, completed)?;
    let _ = app.emit("todo-changed", &item);
    if completed {
        if let Some(pomodoro) = app.try_state::<crate::pomodoro::PomodoroState>() {
            if pomodoro.clear_todo(&id) {
                let _ = app.emit("pomodoro-tick", pomodoro.payload());
            }
        }
    }
    Ok(item)
}


#[tauri::command]
pub fn snooze_todo(
    id: String,
    minutes: u32,
    app: tauri::AppHandle,
    state: State<'_, crate::todo::TodoStore>,
) -> Result<crate::todo::TodoItem, String> {
    let item = state.snooze(&id, minutes)?;
    let _ = app.emit("todo-changed", &item);
    Ok(item)
}


#[tauri::command]
pub fn delete_todo(
    id: String,
    app: tauri::AppHandle,
    state: State<'_, crate::todo::TodoStore>,
) -> Result<(), String> {
    state.delete(&id)?;
    let _ = app.emit(
        "todo-changed",
        serde_json::json!({ "id": id, "deleted": true }),
    );
    if let Some(pomodoro) = app.try_state::<crate::pomodoro::PomodoroState>() {
        if pomodoro.clear_todo(&id) {
            let _ = app.emit("pomodoro-tick", pomodoro.payload());
        }
    }
    Ok(())
}


#[tauri::command]
pub fn restore_todo(
    id: String,
    app: tauri::AppHandle,
    state: State<'_, crate::todo::TodoStore>,
) -> Result<crate::todo::TodoItem, String> {
    let restored = state.restore(&id)?;
    let _ = app.emit("todo-changed", &restored);
    Ok(restored)
}


#[tauri::command]
pub fn get_todo_quick_add_hotkey(
    config_manager: State<'_, ConfigManager>,
) -> Result<String, String> {
    config_manager.get_todo_quick_add_hotkey()
}


#[tauri::command]
pub fn set_todo_quick_add_hotkey(
    hotkey: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let hotkey = hotkey.trim().to_string();
    let previous = config_manager.get_todo_quick_add_hotkey()?;
    let tool_enabled = config_manager.get_todo_enabled()?;
    let slot = crate::hooks::hotkey::HotkeySlotId::TodoQuickAdd;
    if hotkey.is_empty() {
        crate::hooks::hotkey::unregister_hotkey(slot);
        if let Err(error) = config_manager.update_todo_quick_add_hotkey(String::new()) {
            if tool_enabled && !previous.is_empty() {
                let _ = crate::hooks::hotkey::register_hotkey(slot, &previous);
            }
            return Err(error);
        }
        return Ok(());
    }
    if tool_enabled {
        crate::hooks::hotkey::register_hotkey(slot, &hotkey)?;
    }
    if let Err(error) = config_manager.update_todo_quick_add_hotkey(hotkey) {
        if !tool_enabled || previous.is_empty() {
            crate::hooks::hotkey::unregister_hotkey(slot);
        } else {
            let _ = crate::hooks::hotkey::register_hotkey(slot, &previous);
        }
        return Err(error);
    }
    Ok(())
}


#[tauri::command]
pub fn get_todo_enabled(config_manager: State<'_, ConfigManager>) -> Result<bool, String> {
    config_manager.get_todo_enabled()
}


#[tauri::command]
pub fn get_todo_reminders_enabled(
    config_manager: State<'_, ConfigManager>,
) -> Result<bool, String> {
    config_manager.get_todo_reminders_enabled()
}


#[tauri::command]
pub fn set_todo_reminders_enabled(
    enabled: bool,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_todo_reminders_enabled(enabled)?;
    // 提醒开关影响调度线程的 busy 判定与等待时长：重新启用后立即唤醒，
    // 避免调度线程仍在最长 60s 的空闲沉睡中，导致超期/临期提醒延迟触发。
    crate::todo::wake_scheduler();
    Ok(())
}


#[tauri::command]
pub fn get_todo_reminder_sound(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_todo_reminder_sound()
}


#[tauri::command]
pub fn set_todo_reminder_sound(
    sound: String,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_todo_reminder_sound(sound)
}


#[tauri::command]
pub fn set_todo_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let previous = config_manager.get_todo_enabled()?;
    if !enabled {
        if let Some(window) = app.get_webview_window("todo-overlay") {
            let _ = window.hide();
        }
    }
    if enabled {
        if let Ok(hotkey) = config_manager.get_todo_quick_add_hotkey() {
            if !hotkey.is_empty() {
                crate::hooks::hotkey::register_hotkey(
                    crate::hooks::hotkey::HotkeySlotId::TodoQuickAdd,
                    &hotkey,
                )?;
            }
        }
    } else {
        crate::hooks::hotkey::unregister_hotkey(crate::hooks::hotkey::HotkeySlotId::TodoQuickAdd);
    }
    if let Err(error) = config_manager.update_todo_enabled(enabled) {
        let slot = crate::hooks::hotkey::HotkeySlotId::TodoQuickAdd;
        if previous {
            if let Ok(hotkey) = config_manager.get_todo_quick_add_hotkey() {
                if !hotkey.is_empty() {
                    let _ = crate::hooks::hotkey::register_hotkey(slot, &hotkey);
                }
            }
        } else {
            crate::hooks::hotkey::unregister_hotkey(slot);
        }
        crate::hooks::hotkey::set_slot_enabled(slot, previous);
        return Err(error);
    }
    // Wake the reminder scheduler immediately so a pending wait observes the
    // tool switch without waiting for its idle timeout.
    crate::todo::wake_scheduler();
    if !enabled {
        let _ = app.emit("todo-reminders-silenced", ());
    }
    crate::hooks::hotkey::set_slot_enabled(
        crate::hooks::hotkey::HotkeySlotId::TodoQuickAdd,
        enabled,
    );
    Ok(())
}


#[tauri::command]
pub fn show_todo_window(
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let win = app
        .get_webview_window("todo-overlay")
        .ok_or_else(|| "todo-overlay 窗口未找到".to_string())?;
    // # 不要在这里写死窗口尺寸
    //
    // 待办窗高度随内容走（空清单只有一百多像素，折叠/展开还会再收一次），尺寸由前端
    // `TodoTool.tsx` 按 `.todo-body` 实测高度下发。曾经这里每次显示都 `set_size(360, 560)`，
    // 结果前端刚算好的高度一显示就被打回固定值，窗口永远是一大片空白。
    // 窗口只隐藏不销毁，尺寸一直有效，宽度也不需要在这里兜。
    if !TODO_CLOSE_HANDLER_REGISTERED.swap(true, Ordering::SeqCst) {
        let on_close = win.clone();
        win.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = on_close.hide();
            }
            // 窗口真被销毁（异常路径，或将来某条显式 destroy）时复位注册标记 ——
            // 不复位，重建后的同名窗口会跳过注册，Alt+F4 会直接关窗而不走隐藏。
            // 写法与 monitor / utility-hub / screenshot-overlay 一致。
            tauri::WindowEvent::Destroyed => {
                TODO_CLOSE_HANDLER_REGISTERED.store(false, Ordering::SeqCst);
            }
            _ => {}
        });
    }
    if !win.is_visible().unwrap_or(true) {
        if let Ok(Some(pos)) = config_manager.get_window_position("todo-overlay") {
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
pub fn hide_todo_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("todo-overlay") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}


#[tauri::command]
pub fn start_pomodoro_for_todo(
    todo_id: String,
    app: tauri::AppHandle,
    todo_state: State<'_, crate::todo::TodoStore>,
    pomodoro_state: State<'_, crate::pomodoro::PomodoroState>,
) -> Result<(), String> {
    todo_state.active_item(&todo_id)?;
    pomodoro_state.start_for_todo(&app, todo_id);
    let _ = app.emit("pomodoro-tick", pomodoro_state.payload());
    Ok(())
}
