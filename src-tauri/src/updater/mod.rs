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
/// 启动时网络尚未就绪、代理初始化等导致检查失败时，不能直接等待下一个 24h 周期。
/// 保持应用运行即可在一分钟后自动重试；成功后恢复常规检查间隔。
const FAILED_CHECK_RETRY_INTERVAL: Duration = Duration::from_secs(60);
/// 应用启动后首次延迟（秒），给应用/网络就绪留余量
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(5);
/// 建立连接的超时：网络不可达、代理未启动时快速失败，避免长时间挂起
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 读空闲超时：相邻数据块间隔超过该值即判定连接已失效。
/// 这里用 read_timeout 而非整体超时，避免大安装包在慢速链路上被误杀。
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// 取锁时忽略 poison。
///
/// 本状态的临界区只是读写几个字段，不存在需要感知的中间态；若因别处 panic 令锁被
/// poison，继续用 `lock().unwrap()` 会让此后**所有**更新命令连带 panic（update 状态
/// 查询、忽略版本、下载安装全都会挂）。这里与 `sticky_note` 的取锁风格保持一致。
fn lock_ignore_poison<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl UpdaterState {
    fn current_info(&self) -> Option<UpdateInfo> {
        lock_ignore_poison(&self.available).clone()
    }
    fn set_available(&self, info: UpdateInfo) {
        *lock_ignore_poison(&self.available) = Some(info);
    }
    fn clear_available(&self) {
        *lock_ignore_poison(&self.available) = None;
    }
}

/// 下载字节累加器。
///
/// `Update::download` 的 `on_chunk` 回调首参是「本次分块长度」，不是累计已接收
/// 字节数。直接透传给前端会让百分比恒为 0（单块 16KB / 安装包 96MB ≈ 0%），
/// 必须累加后再上报；此处集中承担该语义，避免再次出现理解偏差。
#[derive(Default)]
struct DownloadProgress {
    received: u64,
}

impl DownloadProgress {
    /// 累加一个分块，返回累计已接收字节数
    fn push(&mut self, chunk_length: usize) -> u64 {
        self.received = self.received.saturating_add(chunk_length as u64);
        self.received
    }
}

/// 构建带超时保护的 updater 实例。
///
/// tauri-plugin-updater 在构造 `Update` 时把 timeout 硬编码为 `None`，导致
/// `UpdaterBuilder::timeout` 对 `download()` 不生效；下载一旦卡住（系统代理未
/// 生效时的典型表现：连接已建立但响应体始终不来）就会无限等待且不报错。
/// 这里统一通过 `configure_client` 注入连接超时与读空闲超时兜底。
///
/// 代理方面不在此处显式设置：`reqwest 0.13` 的 `system-proxy` 特性已在
/// Cargo.toml 中开启，客户端会自动读取 Windows 系统代理设置。
fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    app.updater_builder()
        .configure_client(|builder| {
            builder
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(READ_TIMEOUT)
        })
        .build()
        .map_err(|e| format!("updater 初始化失败: {e}"))
}

/// 启动后台周期检测任务。调用方（main.rs setup）负责 app.manage(UpdaterState)。
pub fn start_periodic_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            let next_check = if detect_and_notify(&app).await.is_ok() {
                UPDATE_INTERVAL
            } else {
                FAILED_CHECK_RETRY_INTERVAL
            };
            tokio::time::sleep(next_check).await;
        }
    });
}

/// 检查一次远程是否有新版本；有且未忽略则记录、发事件、拉起提示窗口。
async fn detect_and_notify(app: &AppHandle) -> Result<(), String> {
    let updater = build_updater(app)?;
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
    let dismissed = lock_ignore_poison(&state.dismissed_version).clone();
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
        &format!(
            "检测到新版本 v{}（emit:{} {:?}, win: {:?}）",
            info.version,
            emit_res.is_ok(),
            emit_res,
            win_res
        ),
    );
    win_res.map_err(|error| format!("更新提示窗口显示失败: {error}"))
}

/// 创建 / 显示右上角更新提示窗口（常驻，关闭=隐藏）
pub fn show_update_prompt(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("update-prompt") {
        win.show()
            .map_err(|e| format!("显示 update-prompt 失败: {e}"))?;
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
        let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            x, y,
        )));
    }
    win.show()
        .map_err(|e| format!("显示 update-prompt 失败: {e}"))?;
    win.set_focus().ok();
    Ok(())
}

// ── Tauri 命令 ───────────────────────────────────────────

/// 查询当前是否已有待更新版本（前端启动时兜底同步用）
#[tauri::command]
pub fn get_update_status(state: tauri::State<'_, UpdaterState>) -> Option<UpdateInfo> {
    state.current_info()
}

/// 标记忽略当前版本，本周期内不再提示
#[tauri::command]
pub fn dismiss_update(state: tauri::State<'_, UpdaterState>) {
    if let Some(info) = state.current_info() {
        *lock_ignore_poison(&state.dismissed_version) = Some(info.version);
        state.clear_available();
    }
}

/// 下载并安装更新（下载进度通过 update-progress 事件回报），完成后重启应用。
#[tauri::command]
#[allow(unreachable_code)]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = build_updater(&app)?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("检查失败: {e}"))?
        .ok_or_else(|| "没有可用更新".to_string())?;

    crate::utils::logger::log("updater", &format!("开始下载 v{}", update.version));

    let app_for_emit = app.clone();
    let mut progress = DownloadProgress::default();
    let bytes = update
        .download(
            |chunk_length, total| {
                let received = progress.push(chunk_length);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归：进度必须是累计值，而非最后一次回调的分块长度
    #[test]
    fn test_progress_accumulates_chunk_lengths() {
        let mut progress = DownloadProgress::default();
        // 模拟连续三次分块回调
        assert_eq!(progress.push(16_384), 16_384);
        assert_eq!(progress.push(16_384), 32_768);
        assert_eq!(progress.push(8_192), 40_960);
        assert_eq!(progress.received, 40_960);
    }

    /// 回归：不能被误认为「单块长度即进度」——单块相对安装包极小，
    /// 若透传则前端百分比长期为 0
    #[test]
    fn test_single_chunk_is_far_below_one_percent() {
        let mut progress = DownloadProgress::default();
        let received = progress.push(16_384);
        // 0.1.4 安装包实测 96,023,891 字节
        let total = 96_023_891u64;
        assert_eq!(received * 100 / total, 0, "单块占比为 0%，故必须累加");
        // 累加到一半时才应出现非零百分比
        for _ in 0..(total / 2 / 16_384) {
            progress.push(16_384);
        }
        assert!(progress.received * 100 / total > 40);
    }

    /// 累加溢出时饱和而非 panic（debug 构建下溢出会 panic）
    #[test]
    fn test_progress_saturates_on_overflow() {
        let mut progress = DownloadProgress {
            received: u64::MAX - 1,
        };
        assert_eq!(progress.push(1024), u64::MAX);
    }
}
