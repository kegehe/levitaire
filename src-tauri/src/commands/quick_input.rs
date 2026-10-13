use super::*;


// ─── 快速输入转盘工具 ────────────────────────────────────────────

#[tauri::command]
pub fn get_quick_input_enabled(config: State<'_, ConfigManager>) -> Result<bool, String> {
    config.get_quick_input_enabled()
}


#[tauri::command]
pub fn get_quick_input_state() -> crate::quick_input::QuickInputState {
    crate::quick_input::state()
}


/// 启用/禁用快速输入转盘。
///
/// # 必须保持 `async`
///
/// 启用分支会调用 `quick_input::ensure_window()`，它会通过
/// `WebviewWindowBuilder::build()` 创建 overlay 窗口（例如「启动时工具未启用 →
/// 用户在工具面板打开」这条首次启用路径，窗口此时并不存在，必然走到 build）。
/// 同步命令在 Windows 上会于主线程的 WebView2 IPC 回调内重入建窗而死锁，
/// 冻结整个应用——与便利贴 `create_sticky_note` 是同一类问题。
/// 参见 https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html
/// 的 Known issues。改回 `pub fn` 会导致「首次启用快速输入即卡死」。
#[tauri::command]
pub async fn set_quick_input_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config: State<'_, ConfigManager>,
) -> Result<(), String> {
    config.update_quick_input_enabled(enabled)?;
    // 启用时先确保转盘 overlay 窗口已创建（隐藏），再让触发键生效，
    // 避免「触发键已生效但窗口尚未建好」的窗口期内按下触发键时 begin_wheel
    // emit_to 静默失败且 QUICK_INPUT_ACTIVE 卡在 true（会导致鼠标点击被吞）。
    if enabled {
        crate::quick_input::ensure_window(&app)?;
    } else {
        // 禁用时若转盘正处于激活态，先退出并复位。否则 QUICK_INPUT_ACTIVE 会停留
        // 在 true，且 vk 已被置 0 无法再通过触发键 toggle 恢复，导致鼠标左键被持续吞掉。
        // end_wheel(None) 即“取消”语义，前端收到后会收起转盘并复位状态。
        if crate::quick_input::is_active() {
            crate::quick_input::end_wheel(&app, None);
        }
    }
    // 同步触发键到 keyboard hook（启用且配置了有效键才生效）
    sync_quick_input_trigger(&config)?;
    Ok(())
}


#[tauri::command]
pub fn get_quick_input_trigger_key(config: State<'_, ConfigManager>) -> Result<String, String> {
    let key = config.get_quick_input_trigger_key()?;
    if key.is_empty() {
        Ok("CapsLock".to_string())
    } else {
        Ok(key)
    }
}


#[tauri::command]
pub fn set_quick_input_trigger_key(
    key: String,
    config: State<'_, ConfigManager>,
) -> Result<(), String> {
    // 校验键名可解析
    let vk = match crate::quick_input::parse_trigger_key(&key) {
        Some(vk) => vk,
        None => return Err(format!("无法识别的触发键: {}", key)),
    };
    // 阻止会把全局键盘输入都吞掉的键（字母/数字/编辑导航区），避免影响所有程序的输入
    if crate::quick_input::is_dangerous_trigger_vk(vk) {
        return Err("该键在日常输入中会频繁用到，被设为触发键会中断正常打字。请选用功能键、CapsLock、ScrollLock 等锁定键作为触发键。".to_string());
    }
    config.update_quick_input_trigger_key(key)?;
    sync_quick_input_trigger(&config)?;
    Ok(())
}


/// 获取快速输入转盘触发模式（"click" 单击切换 | "hold" 按住唤起）
#[tauri::command]
pub fn get_quick_input_mode(config: State<'_, ConfigManager>) -> Result<String, String> {
    let mode = config.get_quick_input_mode()?;
    if mode.is_empty() {
        Ok("click".to_string())
    } else {
        Ok(mode)
    }
}


/// 设置快速输入转盘触发模式（"click" 单击切换 | "hold" 按住唤起）
#[tauri::command]
pub fn set_quick_input_mode(mode: String, config: State<'_, ConfigManager>) -> Result<(), String> {
    let normalized = mode.trim().to_lowercase();
    if normalized != "click" && normalized != "hold" {
        return Err(format!("无法识别的触发模式: {}", mode));
    }
    config.update_quick_input_mode(normalized)?;
    sync_quick_input_trigger(&config)?;
    Ok(())
}


/// 获取快速输入剪贴板历史保留条数。
#[tauri::command]
pub fn get_quick_input_history_limit(config: State<'_, ConfigManager>) -> Result<usize, String> {
    let limit = config.get_quick_input_history_limit()?;
    Ok(limit.min(crate::quick_input::HISTORY_MAX))
}


/// 设置快速输入剪贴板历史保留条数，0 表示不记录历史。
#[tauri::command]
pub fn set_quick_input_history_limit(
    limit: usize,
    config: State<'_, ConfigManager>,
) -> Result<(), String> {
    if limit > crate::quick_input::HISTORY_MAX {
        return Err(format!(
            "历史保留条数必须在 0 到 {} 之间",
            crate::quick_input::HISTORY_MAX
        ));
    }
    config.update_quick_input_history_limit(limit)?;
    crate::quick_input::set_history_limit(limit);
    Ok(())
}


/// 获取快速输入是否记录剪贴板历史（历史区开关）。
#[tauri::command]
pub fn get_quick_input_history_enabled(config: State<'_, ConfigManager>) -> Result<bool, String> {
    config.get_quick_input_history_enabled()
}


#[tauri::command]
pub fn set_quick_input_history_enabled(
    enabled: bool,
    config: State<'_, ConfigManager>,
) -> Result<(), String> {
    config.update_quick_input_history_enabled(enabled)?;
    crate::quick_input::set_history_enabled(enabled);
    Ok(())
}


#[tauri::command]
pub fn set_quick_input_highlight(index: i32) -> Result<(), String> {
    crate::quick_input::set_highlight(index);
    Ok(())
}


/// 提交「按住唤起」模式在松开触发键瞬间结算出的扇区。
/// generation 用于拒绝滞后事件，避免旧会话的确认影响下一次唤起。
/// 返回 `true` 表示落在父级扇区、转盘保持并已请求前端换级展开；
/// `false` 表示会话已结束（叶子选中 / 取消 / 过期请求）。
#[tauri::command]
pub fn confirm_quick_input_hold(
    generation: u64,
    selected_index: Option<usize>,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    Ok(crate::quick_input::confirm_hold_wheel(
        &app, generation, selected_index,
    ))
}

/// 同步当前层级中「父级扇区」的索引集合（转盘前端每次换级渲染后调用）。
#[tauri::command]
pub fn set_quick_input_wheel_parents(indices: Vec<usize>) -> Result<(), String> {
    crate::quick_input::set_wheel_parents(indices);
    Ok(())
}

/// 子级转盘返回上一级：保持会话，复位高亮与刻度哨兵。
/// 返回 `false` 表示会话已结束或代次不匹配，前端不应换级。
#[tauri::command]
pub fn back_quick_input_wheel(generation: u64) -> Result<bool, String> {
    Ok(crate::quick_input::back_wheel(generation))
}


#[tauri::command]
pub fn get_quick_input_snippets(config: State<'_, ConfigManager>) -> Result<String, String> {
    config.get_quick_input_snippets()
}


#[tauri::command]
pub fn set_quick_input_snippets(
    snippets: String,
    config: State<'_, ConfigManager>,
) -> Result<(), String> {
    config.update_quick_input_snippets(snippets)
}


#[tauri::command]
pub fn get_quick_input_snippets_enabled(config: State<'_, ConfigManager>) -> Result<bool, String> {
    config.get_quick_input_snippets_enabled()
}


#[tauri::command]
pub fn set_quick_input_snippets_enabled(
    enabled: bool,
    config: State<'_, ConfigManager>,
) -> Result<(), String> {
    config.update_quick_input_snippets_enabled(enabled)
}


/// 获取快速输入转盘的音效反馈开关。
#[tauri::command]
pub fn get_quick_input_sound_enabled(config: State<'_, ConfigManager>) -> Result<bool, String> {
    config.get_quick_input_sound_enabled()
}


#[tauri::command]
pub fn set_quick_input_sound_enabled(
    enabled: bool,
    config: State<'_, ConfigManager>,
) -> Result<(), String> {
    config.update_quick_input_sound_enabled(enabled)?;
    sync_quick_input_sound(&config);
    Ok(())
}


/// 获取音效风格："minimal"（只保留唤出与确认）| "standard"（含切扇区刻度音）| "none"（静音）
#[tauri::command]
pub fn get_quick_input_sound_style(config: State<'_, ConfigManager>) -> Result<String, String> {
    config.get_quick_input_sound_style()
}


#[tauri::command]
pub fn set_quick_input_sound_style(
    style: String,
    config: State<'_, ConfigManager>,
) -> Result<(), String> {
    // 直接落库归一化后的值：非法串一旦被持久化，下次启动读出来的风格就是脏的。
    config.update_quick_input_sound_style(style)?;
    sync_quick_input_sound(&config);
    Ok(())
}


/// 获取音效音量（0-100 百分比）
#[tauri::command]
pub fn get_quick_input_sound_volume(config: State<'_, ConfigManager>) -> Result<u32, String> {
    config.get_quick_input_sound_volume()
}


#[tauri::command]
pub fn set_quick_input_sound_volume(
    volume: u32,
    config: State<'_, ConfigManager>,
) -> Result<(), String> {
    config.update_quick_input_sound_volume(volume)?;
    sync_quick_input_sound(&config);
    Ok(())
}


/// 试听音效：按当前音量配置播放指定音效（cue: open/tick/confirm/cancel）。
///
/// 命令层**故意不检查**「音效开关」—— 试听按钮本身在设置页里已由该开关置灰，
/// 而这里保持无门是为了让「先听再决定开不开」成为可能（前端若想放开限制无需改后端）。
/// 音量仍读配置，保证试听到的就是实际效果。
#[tauri::command]
pub fn preview_quick_input_sound(
    cue: String,
    config: State<'_, ConfigManager>,
) -> Result<(), String> {
    let cue = match cue.trim().to_lowercase().as_str() {
        "open" => crate::sound::Cue::Open,
        "tick" => crate::sound::Cue::Tick,
        "confirm" => crate::sound::Cue::Confirm,
        "cancel" => crate::sound::Cue::Cancel,
        other => return Err(format!("无法识别的音效: {}", other)),
    };
    let volume = config.get_quick_input_sound_volume()?;
    if volume == 0 {
        // 音量为 0 时不播放：调用方（设置页滑杆松手）按了没反应会以为试听坏了，
        // 这里直接返回让上层无感，好过播一段听不见的声音。
        return Ok(());
    }
    crate::sound::play_cue_preview(cue, volume as f64 / 100.0);
    Ok(())
}


#[tauri::command]
pub fn get_quick_input_history() -> Result<Vec<crate::quick_input::ClipboardHistoryItem>, String> {
    Ok(crate::quick_input::get_history())
}


#[tauri::command]
pub fn clear_quick_input_history() -> Result<(), String> {
    crate::quick_input::clear_history();
    Ok(())
}


/// 删除单条剪贴板历史记录（按文本精确匹配；同文本的重复/收藏记录一并清除）。
/// 供设置页「快速输入 → 剪贴板历史」单条删除使用，弥补只能整批清空的不足。
#[tauri::command]
pub fn remove_quick_input_history_item(text: String) -> Result<(), String> {
    crate::quick_input::remove_history_item(&text);
    Ok(())
}


/// 收藏 / 取消收藏某条历史记录：收藏项固定在转盘历史区最前，且不会被滚动保留条数裁掉。
#[tauri::command]
pub fn set_quick_input_history_favorite(text: String, favorite: bool) -> Result<(), String> {
    crate::quick_input::set_history_favorite(&text, favorite);
    Ok(())
}


/// 选中某项后输入文本到当前焦点输入框（写剪贴板 + 模拟 Ctrl+V + 恢复原内容）
#[tauri::command]
pub fn quick_input_paste(text: String) -> Result<(), String> {
    crate::quick_input::type_text_async(text);
    Ok(())
}


/// 点击切换快速输入转盘：当前已激活则关闭（取消），否则打开并定位到鼠标处。
/// 供前端（悬浮工具面板点击「快速输入」卡片）唤起转盘，语义与触发键单击一致。
/// 打开前先确保 overlay 窗口已创建，避免运行时启用后立即点击唤起时窗口尚未就绪而静默失败。
///
/// 必须保持 `async`：`ensure_window` 会调用 `WebviewWindowBuilder::build()` 建窗，
/// 同步命令在 Windows 上会在主线程的 WebView2 回调内重入建窗而死锁冻结整个应用；
/// 平时窗口已在启动时预建、走不到 build 分支，但一旦被销毁后重新启用，同步版本必卡死。
#[tauri::command]
pub async fn toggle_quick_input_wheel(app: tauri::AppHandle) -> Result<(), String> {
    // 若窗口不存在则先创建（隐藏），保证 begin_wheel 的 emit_to 有目标可投递
    crate::quick_input::ensure_window(&app)?;
    crate::quick_input::toggle_wheel(&app);
    Ok(())
}


/// 幂等取消快速输入转盘，供前端定位失败等异常路径复位后端会话。
#[tauri::command]
pub fn cancel_quick_input_wheel(
    generation: Option<u64>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    crate::quick_input::cancel_wheel_if_generation(&app, generation);
    Ok(())
}


/// 预创建快速输入转盘窗口（隐藏）。工具启用时由前端调用一次；
/// 应用启动时也会在 main.rs 的 setup 中调用（quick_input::ensure_window），
/// 确保重启后键盘钩子触发时 emit_to 能找到目标窗口。
/// 窗口透明、无边框、置顶、不可聚焦（绝不抢焦点，目标输入框需保持焦点）。
#[tauri::command]
pub async fn ensure_quick_input_window(app: tauri::AppHandle) -> Result<(), String> {
    crate::quick_input::ensure_window(&app)
}
