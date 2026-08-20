//! 在线更新后端：后台周期检测 + 更新提示窗口触发 + 下载安装。
//!
//! 与 Milevia 的"Rust 驱动检测"一致：
//! - setup 时 app.manage(UpdaterState) 并 spawn 一个后台任务，
//!   首次延迟数秒检查一次，之后每 UPDATE_INTERVAL（24h）周期复查。
//! - 检测到新版本且未被忽略：更新 state、emit `update-available` 事件、
//!   创建/显示 update-prompt 窗口，由前端弹窗询问是否更新。
//! - install_update 下载（进度反馈）+ 安装 + 重启。
//! - 忽略版本后本周期不再弹（dismissed_version 记录）。
//!
//! dev 模式（未发布、updater 未初始化）下 check() 会抛错，此处一律静默
//! 吞掉，不阻塞启动、不弹窗、不崩溃。

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::UpdaterExt;

/// 检测到的新版本信息（供前端展示/前端命令查询）
#[derive(Clone, Debug, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub notes: String,
}

/// 全局更新状态
#[derive(Default)]
pub struct UpdaterState {
    /// 已检测到的新版本（无则为 None）
    pub available: Mutex<Option<UpdateInfo>>,
    /// 本次已忽略的版本号（该版本本周期不再提示）
    pub dismissed_version: Mutex<Option<String>>,
}

/// 后台周期检测间隔（24h）
const UPDATE_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// 应用启动后首次延迟（秒），给应用/网络就绪留余量
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(5);

impl UpdaterState {
    fn current_info(&self) -> Option<UpdateInfo> {
        self.available.lock().unwrap().clone()
    }
    fn set_available(&self, info: UpdateInfo) {
        *self.available.lock().unwrap() = Some(info);
    }
    fn clear_available(&self) {
        *self.available.lock().unwrap() = None;
    }
}

/// 启动后台周期检测任务。调用方（main.rs setup）负责 app.manage(UpdaterState)。
pub fn start_periodic_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            let _ = detect_and_notify(&app).await; // 失败静默，不阻塞循环
            tokio::time::sleep(UPDATE_INTERVAL).await;
        }
    });
}

/// 检查一次远程是否有新版本；有且未忽略则记录、发事件、拉起提示窗口。
async fn detect_and_notify(app: &AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| format!("updater 初始化失败: {e}"))?;
    let update = match updater.check().await {
        Ok(opt) => opt,
        Err(e) => {
            crate::utils::logger::log(
                "updater",
                &format!("检测失败（若为 dev 模式属预期，忽略）: {e}"),
            );
            return Err(format!("检测失败: {e}"));
        }
    };

    let Some(update) = update else {
        // 无新版本：清空待更新状态，避免旧缓存残留
        app.state::<UpdaterState>().clear_available();
        return Ok(());
    };

    let state = app.state::<UpdaterState>();
    let dismissed = state.dismissed_version.lock().unwrap().clone();
    if dismissed.as_deref() == Some(update.version.as_str()) {
        return Ok(()); // 本周期已忽略该版本，不再弹
    }

    let info = UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone().unwrap_or_default(),
    };
    state.set_available(info.clone());

    // 通知前端弹窗（独立 update-prompt 窗口收到事件后自行问询）
    let emit_res = app.emit("update-available", &info);
    let win_res = show_update_prompt(app);

    crate::utils::logger::log(
        "updater",
        &format!("检测到新版本 v{}（emit:{} {:?}, win: {:?}）", info.version, emit_res.is_ok(), emit_res, win_res),
    );
    Ok(())
}

/// 创建 / 显示右上角更新提示窗口（常驻，关闭=隐藏）
pub fn show_update_prompt(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("update-prompt") {
        win.show().map_err(|e| format!("显示 update-prompt 失败: {e}"))?;
        win.set_focus().ok();
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(app, "update-prompt", WebviewUrl::App("index.html".into()))
        .title("Levitaire 更新")
        .inner_size(360.0, 200.0)
        .resizable(false)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(false)
        .focusable(true)
        .visible(false)
        .background_color(tauri::webview::Color(0, 0, 0, 0))
        .build()
        .map_err(|e| format!("创建 update-prompt 窗口失败: {e}"))?;

    // 窗口创建后定位到主屏右上角（物理像素）
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale: f64 = monitor.scale_factor();
        let pos = monitor.position();
        let size = monitor.size();
        let mw: f64 = size.width as f64;
        let w: f64 = 360.0 * scale;
        let x: i32 = (pos.x as f64 + mw - w - 24.0 * scale) as i32;
        let y: i32 = (pos.y as f64 + 24.0 * scale) as i32;
        let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)));
    }
    win.show().map_err(|e| format!("显示 update-prompt 失败: {e}"))?;
    win.set_focus().ok();
    Ok(())
}

// ── Tauri 命令 ───────────────────────────────────────────

/// 查询当前是否已有待更新版本（前端启动时兜底同步用）
#[tauri::command]
pub fn get_update_status(
    state: tauri::State<'_, UpdaterState>,
) -> Option<UpdateInfo> {
    state.current_info()
}

/// 标记忽略当前版本，本周期内不再提示
#[tauri::command]
pub fn dismiss_update(state: tauri::State<'_, UpdaterState>) {
    if let Some(info) = state.current_info() {
        *state.dismissed_version.lock().unwrap() = Some(info.version);
        state.clear_available();
    }
}

/// 下载并安装更新（下载进度通过 update-progress 事件回报），完成后重启应用。
#[tauri::command]
#[allow(unreachable_code)]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| format!("updater 初始化失败: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("检查失败: {e}"))?
        .ok_or_else(|| "没有可用更新".to_string())?;

    crate::utils::logger::log("updater", &format!("开始下载 v{}", update.version));

    let app_for_emit = app.clone();
    let bytes = update
        .download(
            |received, total| {
                let _ = app_for_emit.emit(
                    "update-progress",
                    &(serde_json::json!({
                        "received": received,
                        "total": total,
                    })),
                );
            },
            || {},
        )
        .await
        .map_err(|e| format!("下载失败: {e}"))?;

    crate::utils::logger::log("updater", "下载完成，开始安装");
    update
        .install(&bytes)
        .map_err(|e| format!("安装失败: {e}"))?;

    crate::utils::logger::log("updater", "安装完成，重启应用");
    app.restart();
    Ok(())
}
