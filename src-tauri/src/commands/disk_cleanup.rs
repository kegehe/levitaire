//! 系统清理工具的命令层：**薄壳，只做校验 + 转调 + 转 String**。
//!
//! 安全相关的实现全在 `crate::disk_cleanup` 里，这里不写任何删除逻辑。
//!
//! ★ **本文件不接受任何路径参数**（守卫 `delete_commands_never_accept_a_path`）：
//! 前端只允许传 `rule_id`（I1）。一旦这里出现路径入参，前端就重新获得了
//! "删任意文件"的能力 —— 而 WebView 是最容易被攻破的那一层。

use super::*;

use crate::disk_cleanup::rules::CleanRule;
use crate::disk_cleanup::scan::Mode;
use crate::disk_cleanup::{audit, publish, BusyGuard, CleanState, CleanStatus};

/// 窗口 label。与前端 `ToolWindowLabel`、`OWN_WINDOW_LABELS` 三处必须一致。
const CLEANER_WINDOW: &str = "system-cleaner-overlay";

static CLEANER_CLOSE_HANDLER_REGISTERED: AtomicBool = AtomicBool::new(false);


// ─── 窗口 ───────────────────────────────────────────────────────────────

/// 显示清理面板。
///
/// 窗口本身由前端 `ensureSystemCleanerWindow()` 创建（与 monitor / timer 同一形态），
/// 这里只负责：注册「关闭即隐藏」拦截、恢复上次位置、显示并聚焦、顺带刷一次最新状态。
#[tauri::command]
pub fn show_system_cleaner_window(
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let win = app
        .get_webview_window(CLEANER_WINDOW)
        .ok_or_else(|| format!("{CLEANER_WINDOW} 窗口未找到"))?;

    if !CLEANER_CLOSE_HANDLER_REGISTERED.swap(true, Ordering::SeqCst) {
        let win_on_close = win.clone();
        win.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = win_on_close.hide();
            }
            // 窗口真被销毁时复位注册标记，否则重建后的同名窗口会以为「已经注册过」
            // 而跳过注册 —— 那时 Alt+F4 会直接关窗而不是隐藏。写法与 monitor / timer 一致。
            tauri::WindowEvent::Destroyed => {
                CLEANER_CLOSE_HANDLER_REGISTERED.store(false, Ordering::SeqCst);
            }
            _ => {}
        });
    }

    if !win.is_visible().unwrap_or(true) {
        if let Ok(Some(pos)) = config_manager.get_window_position(CLEANER_WINDOW) {
            let inner = win.inner_size().unwrap_or_default();
            let (x, y) =
                clamp_position_to_workarea(pos.x, pos.y, inner.width as i32, inner.height as i32);
            win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)))
                .map_err(|e| e.to_string())?;
        }
    }
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;

    // 面板每次打开都推一次全量快照，避免显示上一次任务的陈旧进度
    publish(&app);
    Ok(())
}


#[tauri::command]
pub fn hide_system_cleaner_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(CLEANER_WINDOW) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}


// ─── 工具级开关 ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_system_cleaner_enabled(config_manager: State<'_, ConfigManager>) -> Result<bool, String> {
    config_manager.get_system_cleaner_enabled()
}


#[tauri::command]
pub fn set_system_cleaner_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    if !enabled {
        // 先取消正在跑的任务再收窗：留一个后台删除任务在跑、而用户已经没有任何入口
        // 看到它，是这个功能最糟的状态。
        if let Some(state) = app.try_state::<CleanState>() {
            state.request_cancel();
        }
        if let Some(window) = app.get_webview_window(CLEANER_WINDOW) {
            let _ = window.hide();
        }
    }
    config_manager.update_system_cleaner_enabled(enabled)
}


// ─── 规则与任务 ─────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanerRulesView {
    pub rules: Vec<CleanRule>,
    /// 规则表加载失败的说明。非空时整个功能不可用，UI 应直接展示原因。
    pub rules_error: Option<String>,
}


#[tauri::command]
pub fn disk_cleanup_rules(state: State<'_, CleanState>) -> CleanerRulesView {
    let status = state.snapshot();
    CleanerRulesView {
        rules: state.rules(),
        rules_error: status.rules_error,
    }
}


#[tauri::command]
pub fn disk_cleanup_status(state: State<'_, CleanState>) -> CleanStatus {
    state.snapshot()
}


#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeView {
    pub mount_point: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub is_system: bool,
}


/// 卷标识归一：去掉尾部分隔符再大写。
///
/// ★ 这两边**天生写法不同**，不归一就永远比不相等：
/// `SafetyEnv::system_drive` 来自 `%SystemDrive%`，是 `C:`（**不带反斜杠**）；
/// 而挂载点、`fixed_volume_roots()` 给的是 `C:\`。原来的
/// `mount.eq_ignore_ascii_case("C:")` 因此恒为 false —— 系统盘标记从来就没亮过，
/// 按它排序也是个空操作。
fn normalize_volume(text: &str) -> String {
    text.trim_end_matches(['\\', '/']).to_ascii_uppercase()
}

/// 固定卷的空间总览。只读、用户态，用于面板顶部的「磁盘总览」。
#[tauri::command]
pub fn disk_cleanup_volumes() -> Vec<VolumeView> {
    let mut disks = sysinfo::Disks::new_with_refreshed_list();
    disks.refresh();
    // 系统盘由 `SafetyProfile` 派生（I3），不写字面量
    let system_drive = crate::disk_cleanup::safety::SafetyProfile::global()
        .ok()
        .map(|profile| normalize_volume(&profile.env().system_drive.to_string_lossy()));
    // ★ 判定"是不是固定卷"必须与 `start_discovery` 的校验**用同一套判据**。
    //   那边认的是 `GetDriveTypeW == DRIVE_FIXED`（`fixed_volume_roots`），
    //   这里原来用 sysinfo 的 `is_removable()`：口径不同就会出现
    //   "列表里有、点进去说不是可扫描的固定卷"这种自相矛盾的体验。
    let fixed: Vec<String> = crate::disk_cleanup::safety::fixed_volume_roots()
        .iter()
        .map(|root| normalize_volume(root))
        .collect();

    let mut out: Vec<VolumeView> = disks
        .list()
        .iter()
        .filter_map(|disk| {
            let mount = disk.mount_point().to_string_lossy().to_string();
            let key = normalize_volume(&mount);
            // 只列固定卷：与校验器同一份判据
            if !fixed.contains(&key) {
                return None;
            }
            Some(VolumeView {
                is_system: system_drive.as_deref() == Some(key.as_str()),
                mount_point: mount,
                total_bytes: disk.total_space(),
                free_bytes: disk.available_space(),
            })
        })
        .collect();
    out.sort_by(|a, b| {
        b.is_system
            .cmp(&a.is_system)
            .then(a.mount_point.cmp(&b.mount_point))
    });
    out
}


/// 扫描（dry-run）。只读，不删任何东西。
///
/// 扫描**不需要**「不可恢复」确认：它一个文件都不动。
#[tauri::command]
pub async fn disk_cleanup_scan(
    rule_ids: Vec<String>,
    app: tauri::AppHandle,
) -> Result<CleanStatus, String> {
    crate::disk_cleanup::start(&app, &rule_ids, Mode::DryRun, false)
}


/// 执行清理。写审计日志（I8），删不掉的占用项一律跳过（I5）。
///
/// `confirmed_unrecoverable` 由前端在用户确认过「内容不可恢复」之后置位。
/// 它是**后端契约而不是 UI 约定**：绕过界面直接 invoke 也拦得住。
#[tauri::command]
pub async fn disk_cleanup_start(
    rule_ids: Vec<String>,
    confirmed_unrecoverable: bool,
    app: tauri::AppHandle,
) -> Result<CleanStatus, String> {
    crate::disk_cleanup::start(&app, &rule_ids, Mode::Execute, confirmed_unrecoverable)
}


/// 取消当前任务。返回是否确有任务在跑。
#[tauri::command]
pub fn disk_cleanup_cancel(app: tauri::AppHandle) -> bool {
    app.state::<CleanState>().request_cancel()
}


// ─── 发现目标（§8.5）────────────────────────────────────────────────────

/// 让用户挑一个目录，后端校验后签发 `discovery_id`。
///
/// ★ **路径来自系统对话框，不来自 WebView** —— 这是本命令能存在的前提：
/// 前端从头到尾没有机会指定路径，选目录发生在原生对话框里（I1）。
///
/// 校验不通过时**返回错误而不是签发**：用户会看到"为什么这个目录不能清"，
/// 而不是挑完之后什么也没发生。
#[tauri::command]
pub async fn disk_cleanup_pick_directory(
    app: tauri::AppHandle,
) -> Result<Option<crate::disk_cleanup::DiscoveryEntry>, String> {
    let guard = DialogTopmostGuard::suspend(&app, &[CLEANER_WINDOW]);
    let mut dialog = rfd::FileDialog::new()
        .set_title("选择一个要放进隔离区的目录（它不在规则库中，删除后果由你判断）");
    if let Some(owner) = guard.owner() {
        dialog = dialog.set_parent(owner);
    }
    let picked = tokio::task::spawn_blocking(move || dialog.pick_folder())
        .await
        .map_err(|e| format!("选择目录任务失败：{e}"))?;
    drop(guard);

    let Some(folder) = picked else {
        return Ok(None);
    };
    // ★ 签发同样必须走阻塞线程：`issue_discovery` 里的 `measure_tree` 要递归 stat 整棵树
    //   （用户挑一个几十万文件的目录就是秒级）。留在 async 工作线程上，同一 runtime 上的
    //   其它命令（更新检查、配置读写、窗口状态）会一起被拖住。口径与本文件
    //   `with_clean_gate` 一致：凡是"整树遍历"都不许占着异步线程跑。
    let handle = app.clone();
    let entry =
        tokio::task::spawn_blocking(move || handle.state::<CleanState>().issue_discovery(&folder))
            .await
            .map_err(|e| format!("签发目录任务失败：{e}"))??;
    // 推一次状态：让这个目录**立刻出现在面板的列表里等用户确认**，而不是被悄悄搬走。
    // 方案 §8.5 要求"删除必须用户显式确认"，所以这里只签发 id，不执行搬运。
    publish(&app);
    Ok(Some(entry))
}

/// 把某个发现目标搬进隔离区。
///
/// 只接受 `discovery_id`：查不到就拒绝，**绝不回退成"把 id 当路径用"**。
#[tauri::command]
pub async fn disk_cleanup_quarantine_discovery(
    discovery_id: String,
    confirm_user_data: bool,
    app: tauri::AppHandle,
) -> Result<crate::disk_cleanup::quarantine::QuarantineEntry, String> {
    crate::disk_cleanup::quarantine_discovery(&app, &discovery_id, confirm_user_data).await
}


/// 放弃**一个**发现目标（挑了目录又决定不处理它）。
///
/// 用 id 而不是路径：前端从头到尾没有机会指定路径（I1）。
#[tauri::command]
pub fn disk_cleanup_forget_discovery(discovery_id: String, app: tauri::AppHandle) {
    app.state::<CleanState>().drop_discovery(&discovery_id);
    publish(&app);
}


// ─── 隔离区（§10）───────────────────────────────────────────────────────

/// 隔离区管理是**改文件系统**的操作（搬回去 / 彻底删除），因此与规则任务共用
/// 同一把 I9 闸门：与清理任务并发时，"正在往里搬"和"正在往外删"会撞在一起，
/// 账目和清单都会对不上。
///
/// ★ **必须异步 + `spawn_blocking`。** 同步命令由 tauri-macros 内联在 IPC 回调
/// 线程上执行（Windows 上就是 UI 线程），而这里包着的是整树遍历（跨卷恢复要
/// `copy_tree` + 两次 `tree_bytes`）和递归删除 —— 几十 GB / 几十万文件的条目会让
/// **整个应用的窗口一起卡死**，没有进度、不能取消。同文件里其它重 IO 通路
/// （`quarantine_discovery`、`run_job`）都是这么处理的，这两条原来漏了。
///
/// 顺带把账目**重算后**再广播：`publish` 只是把当前状态推出去，不重算的话前端
/// 拿到的还是操作前的字节数（原来注释写着"必须主动广播"，但广播的内容是旧的）。
async fn with_clean_gate<T, F>(app: &tauri::AppHandle, body: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let state = app.state::<CleanState>();
    let Some(gate) = BusyGuard::acquire(&state) else {
        return Err("已有一个扫描或清理任务在进行中，请等它结束".into());
    };
    let handle = app.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let outcome = body();
        // 重算账目同样要遍历隔离区目录树，留在阻塞线程上做
        handle.state::<CleanState>().refresh_quarantine_ledger();
        outcome
    })
    .await;
    // 无论成败都广播：失败路径同样可能已经改动了磁盘（后端支持"部分成功仍返回 Err"）
    drop(gate);
    publish(app);
    match joined {
        Ok(outcome) => outcome,
        Err(e) => Err(format!("隔离区操作失败：{e}")),
    }
}

#[tauri::command]
pub fn disk_cleanup_quarantine_list(
) -> Result<Vec<crate::disk_cleanup::quarantine::QuarantineEntry>, String> {
    crate::disk_cleanup::quarantine::list()
}


/// 隔离区占用：`(总量, 其中用户数据)`。空间账目要用它（§10.2）。
///
/// **失败必须是错误，不能是 `(0, 0)`** —— 界面会把 0 显示成"隔离区是空的"，
/// 而磁盘上可能躺着几个 GB 等着被恢复或彻底删除。
#[tauri::command]
pub fn disk_cleanup_quarantine_summary() -> Result<(u64, u64), String> {
    crate::disk_cleanup::quarantine::summary()
}


#[tauri::command]
pub async fn disk_cleanup_quarantine_restore(
    entry_id: String,
    app: tauri::AppHandle,
) -> Result<crate::disk_cleanup::quarantine::QuarantineEntry, String> {
    with_clean_gate(&app, move || {
        crate::disk_cleanup::quarantine::restore(&entry_id)
    })
    .await
}


#[tauri::command]
pub async fn disk_cleanup_quarantine_purge(
    entry_id: String,
    app: tauri::AppHandle,
) -> Result<crate::disk_cleanup::quarantine::QuarantineEntry, String> {
    with_clean_gate(&app, move || {
        crate::disk_cleanup::purge_quarantine_entry(&entry_id)
    })
    .await
}


#[tauri::command]
pub async fn disk_cleanup_quarantine_purge_all(
    app: tauri::AppHandle,
) -> Result<u64, String> {
    with_clean_gate(&app, crate::disk_cleanup::quarantine::purge_all).await
}


#[tauri::command]
pub fn get_system_cleaner_quarantine_days(
    config_manager: State<'_, ConfigManager>,
) -> Result<u32, String> {
    config_manager.get_system_cleaner_quarantine_days()
}


#[tauri::command]
pub fn set_system_cleaner_quarantine_days(
    days: u32,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    config_manager.update_system_cleaner_quarantine_days(days)
}


// ─── 占用发现（P4 / §8）─────────────────────────────────────────────────

/// 发起一次占用发现。**只读**，但同样占 I9 那把闸门（它要在磁盘上跑很久）。
///
/// `volume` 只能是后端派生出来的固定卷根之一 —— 否则这个只读接口就成了
/// "枚举任意目录"的入口。校验在 `start_discovery` 里做。
#[tauri::command]
pub async fn disk_cleanup_discover_start(
    volume: String,
    report_depth: usize,
    app: tauri::AppHandle,
) -> Result<crate::disk_cleanup::DiscoveryStatus, String> {
    crate::disk_cleanup::start_discovery(&app, volume, report_depth)
}


/// 取消当前的发现或清理任务。
#[tauri::command]
pub fn disk_cleanup_discover_cancel(app: tauri::AppHandle) -> bool {
    crate::disk_cleanup::cancel_all(&app)
}


#[tauri::command]
pub fn disk_cleanup_discover_status(
    state: State<'_, CleanState>,
) -> crate::disk_cleanup::DiscoveryStatus {
    state.discovery_snapshot()
}


// ─── 看门狗（P5 / §11）──────────────────────────────────────────────────

#[tauri::command]
pub fn disk_cleanup_watch_status(
    state: State<'_, CleanState>,
) -> crate::disk_cleanup::watchdog::WatchStatus {
    state.watch_snapshot()
}


/// 保存看门狗设置。
///
/// 入参里**没有监视目录字段**（`WatchSettingsInput` 带 `deny_unknown_fields`）——
/// 带上它就是解析错误，于是"从设置里注入一条路径"这条路根本不存在（I1）。
#[tauri::command]
pub fn disk_cleanup_watch_update(
    input: crate::disk_cleanup::watchdog::WatchSettingsInput,
    app: tauri::AppHandle,
) -> Result<crate::disk_cleanup::watchdog::WatchStatus, String> {
    let manager = app
        .try_state::<ConfigManager>()
        .ok_or_else(|| "配置不可用".to_string())?;
    let settings = manager.update_system_cleaner_watch(&input)?;
    let state = app.state::<CleanState>();
    state.refresh_watch_settings(&settings);
    crate::disk_cleanup::watchdog::publish(&app);
    Ok(state.watch_snapshot())
}


/// 加入一个监视目录。路径来自**系统目录对话框**，不经过 WebView。
#[tauri::command]
pub async fn disk_cleanup_watch_add_directory(
    app: tauri::AppHandle,
) -> Result<Option<crate::disk_cleanup::watchdog::WatchStatus>, String> {
    let guard = DialogTopmostGuard::suspend(&app, &[CLEANER_WINDOW]);
    let mut dialog = rfd::FileDialog::new().set_title("选择要长期监视的目录（它只被统计，不会被删）");
    if let Some(owner) = guard.owner() {
        dialog = dialog.set_parent(owner);
    }
    let picked = tokio::task::spawn_blocking(move || dialog.pick_folder())
        .await
        .map_err(|e| format!("选择目录任务失败：{e}"))?;
    drop(guard);

    let Some(folder) = picked else {
        return Ok(None);
    };
    crate::disk_cleanup::watchdog::add_watch_target(&app, &folder)?;
    Ok(Some(app.state::<CleanState>().watch_snapshot()))
}


/// 移除第 `index` 个监视目录（用下标而不是路径 —— 前端不该提供路径）。
#[tauri::command]
pub fn disk_cleanup_watch_remove_directory(
    index: usize,
    app: tauri::AppHandle,
) -> Result<crate::disk_cleanup::watchdog::WatchStatus, String> {
    crate::disk_cleanup::watchdog::remove_watch_target(&app, index)?;
    Ok(app.state::<CleanState>().watch_snapshot())
}


/// 「立即检查」一次（不必等周期到）。跑完由 `disk-cleanup-watchdog` 事件推状态。
///
/// 返回**有没有真的开始** —— 有别的长任务占着闸门时返回 `false`，
/// 让设置页如实说"正在扫描/清理，稍后再试"，而不是提示"已开始检查"然后什么都没发生。
#[tauri::command]
pub fn disk_cleanup_watch_run_now(app: tauri::AppHandle) -> bool {
    crate::disk_cleanup::watchdog::run_now(&app)
}


// ─── 审计日志（I8 / §12）────────────────────────────────────────────────

#[tauri::command]
pub fn disk_cleanup_audit_list() -> Vec<audit::AuditJobInfo> {
    audit::list_jobs()
}


#[tauri::command]
pub fn disk_cleanup_audit_read(job_id: String) -> Result<Vec<audit::AuditLine>, String> {
    audit::read_job(&job_id)
}


/// 一键清空。设置页与本面板都可见（§12.3）。
#[tauri::command]
pub fn disk_cleanup_audit_clear() -> Result<u64, String> {
    audit::clear_all()
}


/// 导出某次任务的明细。
///
/// **这是审计日志唯一离开本机的路径**，且必须由用户显式点击触发（§12.3）。
/// 导出的是路径全文，所以对话框文案里要提醒这一点。
#[tauri::command]
pub async fn disk_cleanup_audit_export(
    job_id: String,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    // 先取源文件，避免用户选完目录之后才发现这次任务读不出来
    let source = audit::job_path(&job_id)?;
    if !source.is_file() {
        return Err(format!("没有找到任务 {job_id} 的审计日志"));
    }

    let guard = DialogTopmostGuard::suspend(&app, &[CLEANER_WINDOW]);
    let mut dialog = rfd::FileDialog::new()
        .add_filter("JSON Lines", &["jsonl"])
        .set_file_name(format!("levitaire-cleanup-{job_id}.jsonl"));
    if let Some(owner) = guard.owner() {
        dialog = dialog.set_parent(owner);
    }
    let picked = tokio::task::spawn_blocking(move || dialog.save_file())
        .await
        .map_err(|e| format!("保存对话框任务失败: {e}"))?;
    drop(guard);

    let Some(destination) = picked else {
        return Ok(false);
    };
    std::fs::copy(&source, &destination).map_err(|e| format!("写出审计日志失败: {e}"))?;
    Ok(true)
}
