use super::*;


// ─── 番茄钟（「时间工具」的番茄钟页签） ─────────────────────────
//
// 番茄钟不再是独立工具/独立窗口，它作为 time-overlay 的一个页签渲染。
// 计时状态仍由本模块独立持有（crate::pomodoro::PomodoroState），
// 因此隐藏时间工具窗口不会中断专注，到点提醒由后端完成。

/// 获取番茄钟当前状态（时间工具窗口打开/切回页签时拉取，前端据此恢复渲染）
#[tauri::command]
pub fn get_pomodoro_state(
    state: State<'_, crate::pomodoro::PomodoroState>,
) -> Result<crate::pomodoro::PomodoroStatePayload, String> {
    Ok(state.payload())
}


/// 开始/继续番茄钟倒计时
#[tauri::command]
pub fn start_pomodoro(
    app: tauri::AppHandle,
    state: State<'_, crate::pomodoro::PomodoroState>,
) -> Result<(), String> {
    state.start(&app);
    Ok(())
}


/// 暂停番茄钟倒计时（保留剩余时间）
#[tauri::command]
pub fn pause_pomodoro(
    app: tauri::AppHandle,
    state: State<'_, crate::pomodoro::PomodoroState>,
) -> Result<(), String> {
    state.pause();
    let _ = app.emit("pomodoro-tick", state.payload());
    Ok(())
}


/// 重置当前阶段倒计时
#[tauri::command]
pub fn reset_pomodoro(
    app: tauri::AppHandle,
    state: State<'_, crate::pomodoro::PomodoroState>,
) -> Result<(), String> {
    state.reset();
    let _ = app.emit("pomodoro-tick", state.payload());
    Ok(())
}


/// 跳过当前阶段进入下一阶段（计时中则继续计时新阶段）
#[tauri::command]
pub fn skip_pomodoro(
    app: tauri::AppHandle,
    state: State<'_, crate::pomodoro::PomodoroState>,
) -> Result<(), String> {
    let was_running = state.skip();
    if was_running {
        state.start(&app);
    } else {
        let _ = app.emit("pomodoro-tick", state.payload());
    }
    Ok(())
}


/// 获取番茄钟配置（JSON 字符串，空串表示未设置，前端取默认值）
#[tauri::command]
pub fn get_pomodoro_config(config_manager: State<'_, ConfigManager>) -> Result<String, String> {
    config_manager.get_pomodoro_config()
}


/// 更新番茄钟配置并持久化。解析成功时即时同步到计时状态（不中断计时）。
#[tauri::command]
pub fn set_pomodoro_config(
    config: String,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    if let Ok(parsed) = serde_json::from_str::<crate::pomodoro::PomodoroConfig>(&config) {
        if let Some(state) = app.try_state::<crate::pomodoro::PomodoroState>() {
            state.set_config(parsed);
            // 空闲（未计时）时不会有 tick，前端 `remaining` 又优先取 state.remaining_secs，
            // 于是「设置里改了专注/休息时长，番茄钟页签仍显示旧时长」直到切页签或开始才纠正。
            // set_config 已经按新配置重设了 remaining_secs，这里补发一次让它立刻生效。
            let _ = app.emit("pomodoro-tick", state.payload());
        }
    }
    config_manager.update_pomodoro_config(config)
}
