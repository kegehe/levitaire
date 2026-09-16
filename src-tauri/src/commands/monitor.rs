use super::*;


/// 标准模式各显示样式的首帧窗口尺寸（逻辑像素）：`(layout, width, height)`。
///
/// **真源在前端** `src/constants/systemMonitorConfig.ts::MONITOR_LAYOUT_OPTIONS` ——
/// 窗口的真实高度由前端量完内容后下发（`SystemMonitor.tsx` 的量高 effect），这里只负责让
/// 「显示出来的第一帧」尺寸就是对的：否则打开瞬间会先按默认尺寸画一帧再跳一下，而用户
/// 还没碰到窗口就觉得它在抖。
/// 数值必须与前端一致，守卫：`monitor_layout_sizes_match_frontend`。
const MONITOR_LAYOUT_SIZES: &[(&str, f64, f64)] = &[
    ("b", 300.0, 205.0),
    ("c", 340.0, 350.0),
    ("d", 300.0, 350.0),
    ("e", 300.0, 305.0),
];

/// layout 缺失（旧配置）或未知时的回退尺寸 = 前端 `DEFAULT_SYSTEM_MONITOR_LAYOUT` 那一项
const MONITOR_LAYOUT_DEFAULT_SIZE: (f64, f64) = (300.0, 305.0);

/// mini 形态的尺寸（mini 与 layout 无关）
const MONITOR_MINI_SIZE: (f64, f64) = (300.0, 125.0);

/// 由存储的配置 JSON 解析首帧窗口尺寸（纯函数，便于跨文件守卫直接调用）。
/// 脏数据一律回退默认，绝不 panic、也不会给出 0 尺寸。
fn monitor_window_size_from_config(config: Option<&str>) -> (f64, f64) {
    let parsed = config.and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok());
    let is_mini = parsed
        .as_ref()
        .and_then(|value| value.get("displayMode")?.as_str().map(str::to_owned))
        .is_some_and(|mode| mode == "mini");
    if is_mini {
        return MONITOR_MINI_SIZE;
    }
    let layout = parsed
        .as_ref()
        .and_then(|value| value.get("layout")?.as_str().map(str::to_owned))
        .unwrap_or_default();
    MONITOR_LAYOUT_SIZES
        .iter()
        .find(|(id, _, _)| *id == layout)
        .map(|(_, width, height)| (*width, *height))
        .unwrap_or(MONITOR_LAYOUT_DEFAULT_SIZE)
}


/// 显示系统监控悬浮窗（优先恢复到上次记忆位置，未记忆时跟随鼠标，多显示器边界翻转）
/// 并启动采集线程
#[tauri::command]
pub fn show_monitor_window(
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let win = app
        .get_webview_window("monitor-overlay")
        .ok_or_else(|| "monitor-overlay 窗口未找到".to_string())?;
    // Use the saved mode/style before showing so the window never flashes at the wrong size.
    let stored_config = config_manager.get_system_monitor_config().ok();
    let (width, height) = monitor_window_size_from_config(stored_config.as_deref());
    win.set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    // 拦截关闭：停止采集并隐藏，保留窗口实例供下次打开复用。
    // 前端现复用窗口（不再每次销毁重建），监听器随窗口长期有效，故只注册一次；
    // 若窗口仍被真正销毁（异常路径），其上的监听器随之失效，此处监听 Destroyed
    // 复位注册标记，使新建窗口能重新注册拦截——否则 Alt+F4 会直接关窗而不停采，
    // 后台采集线程空跑。与 screenshot overlay 的关闭拦截处理方式一致。
    if MONITOR_CLOSE_HANDLER_REGISTERED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let win_on_close = win.clone();
        let app_on_close = app.clone();
        win.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if let Some(state) = app_on_close.try_state::<crate::monitor::MonitorState>() {
                    state.stop();
                }
                let _ = win_on_close.hide();
            }
            tauri::WindowEvent::Destroyed => {
                MONITOR_CLOSE_HANDLER_REGISTERED.store(false, Ordering::SeqCst);
            }
            _ => {}
        });
    }
    let inner = win.inner_size().unwrap_or_default();
    let ww = inner.width as i32;
    let wh = inner.height as i32;

    // 锚点：优先恢复上次拖拽后的记忆位置，未记忆时跟随鼠标，偏移 8px
    let saved = config_manager
        .get_window_position("monitor-overlay")
        .ok()
        .flatten();
    let (mut x, mut y) = if let Some(pos) = saved {
        (pos.x, pos.y)
    } else if let Ok(cur) = crate::automation::get_mouse_position() {
        (cur.x + 8, cur.y + 8)
    } else {
        (100, 100)
    };

    // 边界翻转：不超过该点所在显示器工作区
    (x, y) = clamp_position_to_workarea(x, y, ww, wh);

    let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        x, y,
    )));
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;

    // 启动采集线程前，从配置同步刷新间隔（避免 state 默认值与用户配置不符）
    if let Some(state) = app.try_state::<crate::monitor::MonitorState>() {
        if let Ok(interval) = config_manager.get_system_monitor_interval_ms() {
            if interval >= 200 {
                state.set_interval(interval);
            }
        }
        state.start(&app);
    }
    Ok(())
}


/// 隐藏系统监控悬浮窗并停止采集线程。窗口保留以避免再次打开时与销毁竞态。
#[tauri::command]
pub fn hide_monitor_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<crate::monitor::MonitorState>() {
        state.stop();
    }
    if let Some(window) = app.get_webview_window("monitor-overlay") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}


/// 获取系统监控工具启用状态
#[tauri::command]
pub fn get_system_monitor_enabled(
    config_manager: State<'_, ConfigManager>,
) -> Result<bool, String> {
    config_manager.get_system_monitor_enabled()
}


/// 设置系统监控工具启用状态并持久化。禁用时停采并隐藏窗口，避免重启销毁竞态。
#[tauri::command]
pub fn set_system_monitor_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    if !enabled {
        if let Some(state) = app.try_state::<crate::monitor::MonitorState>() {
            state.stop();
        }
        if let Some(window) = app.get_webview_window("monitor-overlay") {
            let _ = window.hide();
        }
    }
    config_manager.update_system_monitor_enabled(enabled)
}


/// 获取系统监控配置（JSON 字符串，空串表示未设置）
#[tauri::command]
pub fn get_system_monitor_config(
    config_manager: State<'_, ConfigManager>,
) -> Result<String, String> {
    config_manager.get_system_monitor_config()
}


/// 更新系统监控配置并持久化。解析 intervalMs 即时生效（无需重启采集线程）
#[tauri::command]
pub fn set_system_monitor_config(
    config: String,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    // 解析 intervalMs 即时下发到采集线程
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&config) {
        if let Some(ms) = parsed.get("intervalMs").and_then(|v| v.as_u64()) {
            if let Some(state) = app.try_state::<crate::monitor::MonitorState>() {
                state.set_interval(ms);
            }
            let _ = config_manager.update_system_monitor_interval_ms(ms);
        }
    }
    config_manager.update_system_monitor_config(config)
}


#[cfg(test)]
mod tests {
    use super::*;

    /// 剥掉整行注释：把某一项注释掉（而不是删掉）在文本层面看起来"还在"，
    /// 直接用裸文本匹配会假绿。与 `commands/mod.rs` 里的同名助手判据一致。
    fn strip_line_comments(source: &str) -> String {
        source
            .lines()
            .map(|line| match line.find("//") {
                Some(index) if line[..index].trim().is_empty() => "",
                _ => line,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 首帧尺寸解析：模式 + 样式 → 尺寸，脏数据一律回退默认且不 panic。
    #[test]
    fn monitor_window_size_follows_mode_and_layout() {
        assert_eq!(
            monitor_window_size_from_config(None),
            MONITOR_LAYOUT_DEFAULT_SIZE
        );
        assert_eq!(
            monitor_window_size_from_config(Some("")),
            MONITOR_LAYOUT_DEFAULT_SIZE
        );
        assert_eq!(
            monitor_window_size_from_config(Some("{}")),
            MONITOR_LAYOUT_DEFAULT_SIZE
        );
        // 四套样式各自的尺寸
        for (id, width, height) in MONITOR_LAYOUT_SIZES {
            let json = format!("{{\"displayMode\":\"full\",\"layout\":\"{id}\"}}");
            assert_eq!(
                monitor_window_size_from_config(Some(&json)),
                (*width, *height),
                "样式 {id} 的尺寸取错"
            );
        }
        // 旧配置没有 layout 字段（升级路径）
        assert_eq!(
            monitor_window_size_from_config(Some("{\"displayMode\":\"full\"}")),
            MONITOR_LAYOUT_DEFAULT_SIZE
        );
        // 未知样式 / 坏 JSON
        assert_eq!(
            monitor_window_size_from_config(Some("{\"displayMode\":\"full\",\"layout\":\"z\"}")),
            MONITOR_LAYOUT_DEFAULT_SIZE
        );
        assert_eq!(
            monitor_window_size_from_config(Some("{not json")),
            MONITOR_LAYOUT_DEFAULT_SIZE
        );
        // mini 与样式无关
        assert_eq!(
            monitor_window_size_from_config(Some("{\"displayMode\":\"mini\",\"layout\":\"c\"}")),
            MONITOR_MINI_SIZE
        );
    }

    /// 跨文件守卫：前端的 `MONITOR_LAYOUT_OPTIONS` 才是宽度 / 占位高度的真源。
    ///
    /// 抄一份副本不会立刻报错，只会让"打开窗口时先按错的尺寸画一帧再跳"重新出现
    /// （旧实现把 300×520 抄在 Rust 里，与前端各样式都不一致）。
    #[test]
    fn monitor_layout_sizes_match_frontend() {
        let ts = include_str!("../../../src/constants/systemMonitorConfig.ts");
        let ts = strip_line_comments(&ts);

        // ① 每个样式块的 width / placeholderHeight
        for (id, width, height) in MONITOR_LAYOUT_SIZES {
            let marker = format!("value: \"{id}\",");
            let start = ts.find(&marker).unwrap_or_else(|| {
                panic!("前端 MONITOR_LAYOUT_OPTIONS 里找不到样式 {id}（改名/下线时请同步本守卫）")
            });
            let rest = &ts[start + marker.len()..];
            // 样式块的边界 = 下一个 `value: "`（或表尾）
            let end = rest.find("value: \"").unwrap_or(rest.len());
            let block = &rest[..end];
            assert!(
                block.contains(&format!("width: {width},")),
                "样式 {id} 的窗口宽度与 Rust 的 MONITOR_LAYOUT_SIZES 不一致：\n{block}"
            );
            assert!(
                block.contains(&format!("placeholderHeight: {height},")),
                "样式 {id} 的占位高度与 Rust 的 MONITOR_LAYOUT_SIZES 不一致：\n{block}"
            );
        }
        assert_eq!(
            MONITOR_LAYOUT_SIZES.len(),
            4,
            "样式数量变了，本守卫的解析面需要同步更新"
        );

        // ② 默认样式那一项必须等于 MONITOR_LAYOUT_DEFAULT_SIZE
        let default_start = ts
            .find("DEFAULT_SYSTEM_MONITOR_LAYOUT: SystemMonitorLayout = \"")
            .expect("未找到 DEFAULT_SYSTEM_MONITOR_LAYOUT（改名时请同步本守卫）");
        let default_rest = &ts[default_start..];
        let open = default_rest.find('"').expect("默认样式定义格式变了");
        let close = default_rest[open + 1..]
            .find('"')
            .expect("默认样式定义格式变了");
        let default_id = &default_rest[open + 1..open + 1 + close];
        let default_size = MONITOR_LAYOUT_SIZES
            .iter()
            .find(|(id, _, _)| *id == default_id)
            .unwrap_or_else(|| panic!("默认样式 {default_id} 不在 MONITOR_LAYOUT_SIZES 里"));
        assert_eq!(
            (default_size.1, default_size.2),
            MONITOR_LAYOUT_DEFAULT_SIZE,
            "MONITOR_LAYOUT_DEFAULT_SIZE 与前端默认样式（{default_id}）不一致"
        );

        // ③ mini 尺寸
        let mini_start = ts
            .find("MONITOR_MINI_SIZE = {")
            .expect("未找到 MONITOR_MINI_SIZE（改名时请同步本守卫）");
        let mini_block = &ts[mini_start..(mini_start + 160).min(ts.len())];
        assert!(
            mini_block.contains(&format!("width: {},", MONITOR_MINI_SIZE.0)),
            "MONITOR_MINI_SIZE 宽度与前端不一致：\n{mini_block}"
        );
        assert!(
            mini_block.contains(&format!("placeholderHeight: {}", MONITOR_MINI_SIZE.1)),
            "MONITOR_MINI_SIZE 占位高度与前端不一致：\n{mini_block}"
        );
    }
}
