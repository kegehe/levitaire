use super::*;

#[tauri::command]
pub fn get_sticky_notes_enabled(config_manager: State<'_, ConfigManager>) -> Result<bool, String> {
    config_manager.get_sticky_notes_enabled()
}

#[tauri::command]
pub async fn set_sticky_notes_enabled(
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
        return config_manager.update_sticky_notes_enabled(false);
    }

    // 启用分支：
    //
    // ① 先落配置再恢复 —— `restore_pinned_notes_inner` 的前置守卫读的就是这个字段，
    //    写晚了会被它自己拦掉（返回 0 张）。
    // ② 必须把「数据里 visible=true」的便签重新贴回桌面。缺这一步的后果是：桌面空无一物，
    //    而管理窗仍写「桌面 N 张」、`hiddenCount=0` 让「唤出全部」置灰 —— 用户只能重启，
    //    或逐张点两次眼睛（先收起再唤出）。这是「禁用→再启用」路径上的空白。
    config_manager.update_sticky_notes_enabled(true)?;
    if let Some(store) = app.try_state::<crate::sticky_note::NoteStore>() {
        match restore_pinned_notes_inner(&app, &store).await {
            Ok(count) => crate::utils::logger::log(
                "sticky_note",
                &format!("重新启用便利贴：恢复 {count} 张已钉便签"),
            ),
            Err(error) => crate::utils::logger::log(
                "sticky_note",
                &format!("重新启用便利贴恢复失败: {error}"),
            ),
        }
    }
    Ok(())
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
///
/// # 必须保持 `async`
///
/// 本命令经 `show_note_window` 调用 `WebviewWindowBuilder::build()` 创建窗口。
/// Tauri 在 Windows 上禁止在**同步**命令里建窗：非 async 命令在主线程上 inline
/// 执行，而主线程此刻正处在 WebView2 的 IPC 回调内部，`build()` 所需的主线程
/// 再次调度永远无法执行，整个应用会死锁冻结。
/// 参见 https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html
/// 的 Known issues（"On Windows, this function deadlocks when used in a synchronous
/// command..."）。改回 `pub fn` 会重现「新建便利贴后应用卡死」。
#[tauri::command]
pub async fn create_sticky_note(
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

/// 记住用户手动拖出来的窗口尺寸（逻辑像素，含透明留白）。
/// 写入后便签进入「手动尺寸」模式：前端不再按内容下发高度。
///
/// 不下发列表刷新事件（与 `set_sticky_note_position` 同理）：拖拽过程中会被防抖地多次调用，
/// 而管理窗并不展示尺寸，多广播一次就是一次无谓的整列表重渲染。
#[tauri::command]
pub fn set_sticky_note_size(
    id: String,
    width: f64,
    height: f64,
    store: State<'_, crate::sticky_note::NoteStore>,
) -> Result<crate::sticky_note::StickyNote, String> {
    store.set_size(&id, width, height)
}

/// 恢复「宽度固定 + 高度随内容」的自动尺寸（双击右下角手柄时调用）。
#[tauri::command]
pub fn reset_sticky_note_size(
    id: String,
    store: State<'_, crate::sticky_note::NoteStore>,
) -> Result<crate::sticky_note::StickyNote, String> {
    store.reset_size(&id)
}

/// 拖拽过程中回写窗口位置（物理像素）。调用频繁，不触发列表刷新事件。
///
/// ⚠️ 本命令是便利贴位置的落盘入口，必须与窗口位置记忆**共用同一份抑制判据**
/// （`position_save_is_suppressed`）：
/// 便签贴屏幕下沿时，内容变高（或用户往下拖大）会让 `clamp_window_to_workarea` 把窗口
/// 挤回工作区；那次程序性移动同样触发前端的 `onMoved`，而前端会在 250ms 后回写位置。
/// 抑制的键是**窗口 label**（`sticky-note-<id>`），本命令拿的是 note id —— 所以这里必须
/// 自己换算；漏了这一步，抑制对便签就是死代码，"被挤过的 y" 会被永久记进 notes.json，
/// 内容缩回后也不回落（表现为便签反复编辑后自己往上爬）。
#[tauri::command]
pub fn set_sticky_note_position(
    id: String,
    x: i32,
    y: i32,
    store: State<'_, crate::sticky_note::NoteStore>,
) -> Result<(), String> {
    if position_save_is_suppressed(&crate::sticky_note::note_window_label(&id)) {
        return Ok(());
    }
    store.update_position(&id, x, y)?;
    Ok(())
}

/// 唤出某张（可能已收起）便签：标记 visible=true 并重建/聚焦窗口。
///
/// 必须保持 `async`：会经 `show_note_window` → `WebviewWindowBuilder::build()` 建窗，
/// 与 `create_sticky_note` 同理，同步命令在 Windows 上会死锁。
#[tauri::command]
pub async fn show_sticky_note(
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

/// 一键把所有「已收起」的便签重新贴回桌面（`collect_all_notes` 的逆操作）。
///
/// # 必须保持 `async`
///
/// 循环里每张便签都会经 `show_note_window` 触发 `WebviewWindowBuilder::build()` 建窗，
/// 与 `restore_pinned_notes` 完全同理：Windows 上同步命令在主线程 inline 执行会死锁整个
/// 应用。已有守卫 `window_building_commands_stay_async` 钉住这一点。
///
/// 返回实际唤出的张数。**建窗**失败只记日志、不中断后续（同 `restore_pinned_notes`）——
/// 并发下个别窗口会因竞态建不出来，用 `?` 直接上抛会让排在它后面的便签全都出不来。
/// 落盘失败（`set_visible`）仍然上抛：那说明整个 notes.json 写不进去，继续跑也是白跑。
#[tauri::command]
pub async fn show_all_notes(
    app: tauri::AppHandle,
    store: State<'_, crate::sticky_note::NoteStore>,
) -> Result<usize, String> {
    let mut count = 0;
    for note in store.list()? {
        if note.visible {
            continue;
        }
        // 先落盘 visible=true 再建窗，与 `show_sticky_note` 同序：建窗失败时数据停在
        // 「已贴在桌面」，下次启动 `restore_pinned_notes` 会自愈重试；反过来先建窗后落盘，
        // 落盘失败就会出现「窗口已经在桌面上、数据却说它已收起」的不一致。
        // 用返回值覆盖 note，和 `show_sticky_note` 一样把「已落盘的那份」交给建窗函数，
        // 免得以后 `show_note_window` 真去读 note.visible 时踩到旧值。
        let note = store.set_visible(&note.id, true)?;
        // focus=false：批量唤出不抢焦点，用户刚点的管理窗要留在前台。
        match crate::sticky_note::show_note_window(&app, &note, false) {
            Ok(()) => count += 1,
            Err(error) => crate::utils::logger::log(
                "sticky_note",
                &format!("唤出便签 {} 失败: {}", note.id, error),
            ),
        }
    }
    notify_sticky_notes_changed(&app);
    Ok(count)
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
    // 格式由后端按字节判定并统一转码成 PNG（剪贴板给的 MIME 不可全信，见 save_image 注释）
    let rel = crate::sticky_note::save_image(&app, &note_id, &bytes)?;
    // 写入后复核便签仍存在：若并发删除（delete_sticky_note 会清理图片目录）落在
    // 写盘之前，本函数会重建已删除便签的图片目录留下孤儿文件，这里兜底清理并报错。
    if store.get(&note_id).is_err() {
        crate::sticky_note::delete_images(&app, &note_id);
        return Err("便签已删除".to_string());
    }
    Ok(rel)
}

/// 从本地文件导入一张图片（把图片文件拖进便签）。返回正文令牌中的相对路径。
///
/// 与剪贴板粘贴分开两件事：这里带来源**路径**，由后端校验扩展名与体积、再转码落盘，
/// 前端拿到令牌后照常插入 `<img data-note-img>`。
#[tauri::command]
pub fn import_sticky_note_image(
    app: tauri::AppHandle,
    note_id: String,
    path: String,
    store: State<'_, crate::sticky_note::NoteStore>,
) -> Result<String, String> {
    store.get(&note_id)?;
    let rel = crate::sticky_note::import_image_file(&app, &note_id, std::path::Path::new(&path))?;
    if store.get(&note_id).is_err() {
        crate::sticky_note::delete_images(&app, &note_id);
        return Err("便签已删除".to_string());
    }
    Ok(rel)
}

/// 把便签里的一张图片复制到系统剪贴板（右键「复制图片」）。
///
/// 便签图片落盘时已统一为 PNG，所以这里通常零转码就能直接粘到聊天工具 / 文档里；
/// 仍走一次 `ensure_png`：早期版本按剪贴板 MIME 落盘，目录里可能留有「.png 后缀装
/// 其它格式字节」的老文件，那种文件直接喂给 `copy_image` 会解码失败。
#[tauri::command]
pub fn copy_sticky_note_image(
    app: tauri::AppHandle,
    id: String,
    rel: String,
    clipboard: State<'_, ClipboardManager>,
    store: State<'_, crate::sticky_note::NoteStore>,
) -> Result<(), String> {
    // 便签已被删除时不要动用户的剪贴板（宁可报错，也别覆盖刚复制的内容）
    store.get(&id)?;
    let path = crate::sticky_note::resolve_image_path(&app, &id, &rel)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("读取图片失败: {e}"))?;
    let png = crate::sticky_note::ensure_png(&bytes)?;
    clipboard
        .copy_image(&png)
        .map_err(|e| format!("复制图片失败: {e}"))
}

/// 删除便签正文里的一张图片（右键「删除图片」）：磁盘文件与正文节点都要去掉，
/// 正文节点由前端删除后照常走保存流程。
#[tauri::command]
pub fn delete_sticky_note_image(
    app: tauri::AppHandle,
    id: String,
    rel: String,
    store: State<'_, crate::sticky_note::NoteStore>,
) -> Result<(), String> {
    store.get(&id)?;
    crate::sticky_note::delete_image(&app, &id, &rel)
}

/// 应用启动/管理窗挂载时调用：把所有已钉在桌面的便签窗口重建出来。
/// 仅在工具启用时生效；不抢焦点。
///
/// # 必须保持 `async`
///
/// 这是「重启后整个应用卡死」的直接原因：本命令由 `preloadEnabledToolWindows()`
/// 在启动时调用，循环里对每张 `visible` 便签执行 `WebviewWindowBuilder::build()`。
/// 一旦改回同步命令，Windows 上每次启动都会死锁（浮球、托盘、右键菜单全部无响应），
/// 且因为便签已落盘 `visible: true`，该状态会自我延续、每次启动复现。
#[tauri::command]
pub async fn restore_pinned_notes(
    app: tauri::AppHandle,
    store: State<'_, crate::sticky_note::NoteStore>,
    config_manager: State<'_, ConfigManager>,
) -> Result<usize, String> {
    if !config_manager.get_sticky_notes_enabled()? {
        return Ok(0);
    }
    restore_pinned_notes_inner(&app, &store).await
}

/// [`restore_pinned_notes`] 的实现体。抽出来是为了让「重新启用便利贴」
/// （`set_sticky_notes_enabled`）复用同一条恢复路径，避免两套逻辑各自演化。
///
/// 调用方负责确认工具处于启用态。`async` 是硬要求：体内经 `show_note_window`
/// 建窗（见 `window_building_commands_stay_async` 守卫）。
async fn restore_pinned_notes_inner(
    app: &tauri::AppHandle,
    store: &crate::sticky_note::NoteStore,
) -> Result<usize, String> {
    let notes = store.list()?;
    let mut count = 0;
    for note in &notes {
        if !note.visible {
            continue;
        }
        // 单张便签重建失败不应中断其余便签的恢复。本函数可能与管理窗挂载时的另一次
        // 恢复并发，个别窗口会因竞态返回错误；若用 `?` 直接上抛，一张便签的失败会让
        // 排在其后的所有已钉便签都恢复不出来。
        match crate::sticky_note::show_note_window(app, note, false) {
            Ok(()) => count += 1,
            Err(error) => crate::utils::logger::log(
                "sticky_note",
                &format!("恢复便签 {} 失败: {}", note.id, error),
            ),
        }
    }
    Ok(count)
}

/// 显示便利贴管理窗。关闭拦截仅隐藏、不销毁，便于下次快速唤出。
///
/// # 不要在这里写死窗口尺寸
///
/// 管理窗高度随内容变化（空状态一两行、便签多时受列表 max-height 收口），尺寸由前端
/// `StickyNoteManager.tsx` 按面板实测高度下发。曾经这里每次显示都 `set_size(360, 560)`，
/// 结果前端刚算好的高度一显示就被打回固定值，窗口永远是一大片空白。
/// 宽度也不需要在这里兜：窗口只隐藏不销毁，尺寸一直有效。
#[tauri::command]
pub fn show_sticky_notes_manager(
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let win = app
        .get_webview_window("sticky-notes-manager")
        .ok_or_else(|| "sticky-notes-manager 窗口未找到".to_string())?;
    if !STICKY_MANAGER_CLOSE_HANDLER_REGISTERED.swap(true, Ordering::SeqCst) {
        let on_close = win.clone();
        win.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = on_close.hide();
            }
            // 窗口真被销毁时复位注册标记（同 monitor / utility-hub / screenshot-overlay）。
            // 便签窗本身就走 `destroy_note_window` 销毁重建，管理窗将来也可能被显式销毁，
            // 留着不复位就会让重建后的窗口跳过注册拦截。
            tauri::WindowEvent::Destroyed => {
                STICKY_MANAGER_CLOSE_HANDLER_REGISTERED.store(false, Ordering::SeqCst);
            }
            _ => {}
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

#[cfg(test)]
mod tests {
    /// 顶层 `pub [async] fn <name>(` 声明 → (名字, 是否 async)。
    /// 只认行首声明，不认 `//` 注释行（注释里写代码示例不算）。
    fn parse_command_decl(line: &str) -> Option<(String, bool)> {
        let line = line.trim_start();
        if line.starts_with("//") {
            return None;
        }
        let rest = line.strip_prefix("pub ")?;
        let (rest, is_async) = match rest.strip_prefix("async ") {
            Some(rest) => (rest, true),
            None => (rest, false),
        };
        let after = rest.strip_prefix("fn ")?;
        let name = after.split(['(', '<']).next()?;
        if name.is_empty() {
            return None;
        }
        Some((name.to_string(), is_async))
    }

    /// 建窗命令必须 `async`。
    ///
    /// 同步命令在 Windows 上由主线程 inline 执行（此时线程正处在 WebView2 的 IPC 回调
    /// 内部），`WebviewWindowBuilder::build()` 需要的主线程再次调度永远等不到 —— 整个应用
    /// 死锁冻结。这段约束在 `create_sticky_note` / `show_sticky_note` / `show_all_notes` /
    /// `restore_pinned_notes` 的注释里各写了一遍，但只有文档、没有守卫：把某个 `async`
    /// 改回 `pub fn` 编译照过、用例照绿，只有真机点一下才炸。本用例把「会建窗 ⇒ 必须 async」
    /// 变成可执行的规则。
    #[test]
    fn window_building_commands_stay_async() {
        let all_lines: Vec<&str> = include_str!("sticky.rs").lines().collect();
        // 模块边界只认「整行就是 #[cfg(test)]」：本函数自己的注释与断言消息里也写了这个
        // 标记，按子串计数会把守卫自己数进去（实测数出 5 个）。同时钉死「测试模块在文件
        // 末尾、且只有一个」——若将来在前面又插一个测试模块，生产区会被截短（漏检）。
        let test_module_starts: Vec<usize> = all_lines
            .iter()
            .enumerate()
            .filter(|(_, line)| line.trim() == "#[cfg(test)]")
            .map(|(index, _)| index)
            .collect();
        assert_eq!(
            test_module_starts.len(),
            1,
            "本守卫假设唯一的测试模块位于文件末尾；若在前面新增测试模块，扫描范围会缩小"
        );
        let production = &all_lines[..test_module_starts[0]];

        // 以顶层 `pub [async] fn` 声明为切分点，每个函数的函数体 = 下一条声明之前的内容。
        let decls: Vec<(usize, String, bool)> = production
            .iter()
            .enumerate()
            .filter_map(|(index, raw)| {
                parse_command_decl(raw).map(|(name, is_async)| (index, name, is_async))
            })
            .collect();
        assert!(
            decls.len() >= 10,
            "只解析出 {} 个命令，切分逻辑失效（守卫会空转）",
            decls.len()
        );

        // 第三向断言（完整性）：生产区里每个 `#[tauri::command]` 都必须解析出一条顶层 `pub fn`。
        // 少了这条，只要声明的写法一变（例如把属性与 `pub async fn` 写在同一行），
        // `parse_command_decl` 就认不出来 —— 那条命令从此不在守卫的检查范围内，而用例还是绿的。
        let attribute_count = production
            .iter()
            .filter(|line| {
                !line.trim_start().starts_with("//") && line.contains("#[tauri::command]")
            })
            .count();
        assert_eq!(
            attribute_count,
            decls.len(),
            "生产区有 {attribute_count} 个 #[tauri::command]，却只解析出 {parsed} 条顶层 pub fn —— \
             有命令的声明写法没被 parse_command_decl 认出来（它不会被本守卫检查）。\
             若确实新增了非命令的顶层 pub fn，请在这里显式放行",
            parsed = decls.len()
        );

        let mut window_building: Vec<String> = Vec::new();
        for (position, (line_index, name, is_async)) in decls.iter().enumerate() {
            let end = decls
                .get(position + 1)
                .map(|(next, ..)| *next)
                .unwrap_or(production.len());
            // 整行注释先剥掉再匹配：把调用注释掉（而不是删掉）在文本层面看起来「还在」，
            // 不剥注释的守卫会被注释式变异骗过。
            let body: String = production[*line_index..end]
                .iter()
                .filter(|line| !line.trim_start().starts_with("//"))
                .copied()
                .collect::<Vec<_>>()
                .join("\n");
            // 三条路径都算「会建窗」：本模块的两个入口，以及绕过它们直接构造 builder 的写法；
            // `restore_pinned_notes_inner` 是本模块的异步恢复实现体，任何同步命令若调用它
            // 都会在建窗时死锁，故一并纳入匹配面。
            let builds_window = body.contains("show_note_window(")
                || body.contains("ensure_note_window(")
                || body.contains("restore_pinned_notes_inner(")
                || body.contains("WebviewWindowBuilder");
            if !builds_window {
                continue;
            }
            assert!(
                *is_async,
                "`{name}` 会创建便签窗口，必须声明为 async —— 同步命令在 Windows 上会死锁整个应用"
            );
            window_building.push(name.clone());
        }

        // 双向断言：既要「没有漏网的同步建窗命令」，也要「已知的建窗命令真的被扫到」。
        // 只断言前者时，切分失败（一个都没扫到）会让守卫一直绿。
        for expected in [
            "create_sticky_note",
            "show_sticky_note",
            "show_all_notes",
            "restore_pinned_notes",
        ] {
            assert!(
                window_building.iter().any(|name| name == expected),
                "`{expected}` 会建窗，却没被守卫识别出（切分/匹配逻辑失效）"
            );
        }
    }
}
