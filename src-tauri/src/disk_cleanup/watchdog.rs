//! 看门狗（§11）：低频比对历次快照，把"正在失控"的目录自动浮出来。
//!
//! # 不盯固定路径，只比对增量
//!
//! 这是 §11.1 的核心设计：**不为每种病写一条硬编码规则**，而是"某目录持续增长"这个模式
//! 统一捞出来。所以它复用 P4 的发现引擎与快照，自己只做两件事：
//! 挑出同时满足"够大"与"长得够快"的目录，然后通知。
//!
//! # 它一个字节都不删
//!
//! 看门狗是**唯一在无人值守时运行**的组件，所以它的权限面必须最小：
//! 只读磁盘、只发通知、只写自己的快照。它甚至不碰隔离区 —— 是否处理由用户决定。
//! 守卫：`source_guards::the_watchdog_never_touches_deletion_or_quarantine`。
//!
//! # 必须低频
//!
//! 默认 24 小时一次，最短 1 小时（设置里被强制夹住）。它还要**先看快照的新鲜度**：
//! 如果本卷最近已经扫过（不管是谁扫的），这一轮就跳过 —— 否则重启几次就会连扫几次。

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use super::discover::{self, DiscoveredDir, Politeness};
use super::safety;
use super::CleanState;

/// 默认间隔（小时）
pub const DEFAULT_INTERVAL_HOURS: u64 = 24;
/// 最短间隔。看门狗**必须低频**，否则它自己就成了负担。
pub const MIN_INTERVAL_HOURS: u64 = 1;
/// 前端可选的间隔档位。
///
/// **只用于与前端对账的源码守卫**：后端不对间隔做枚举校验，只把它夹在
/// `[MIN_INTERVAL_HOURS, 30 天]` 之间 —— 夹比"吸附到最近的档位"更符合直觉
/// （用户填 12 小时就该是 12 小时，不是"离它最近的那个预设"）。
#[cfg(test)]
pub const INTERVAL_CHOICES: &[u64] = &[1, 6, 24, 72, 168];

/// 默认：单目录超过 2 GB
pub const DEFAULT_MIN_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// 默认：近 7 日增长超过 1 GB
pub const DEFAULT_MIN_DELTA_BYTES: u64 = 1024 * 1024 * 1024;
pub const DEFAULT_MIN_AGE_DAYS: u32 = 7;

/// 启动后先等这么久再跑第一轮。别和启动过程抢磁盘 ——
/// 开机那一分钟用户最需要的是机器能快点用起来。
const FIRST_RUN_DELAY: Duration = Duration::from_secs(10 * 60);
/// 被别的事情挡住时的重试间隔（比如用户正在清理）
const BLOCKED_RETRY: Duration = Duration::from_secs(30 * 60);
/// 一轮最多报几条。通知里写不下更多，面板也看不过来。
pub const MAX_ALERTS: usize = 8;

// ── 设置 ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchSettings {
    pub enabled: bool,
    pub interval_hours: u64,
    pub min_bytes: u64,
    pub min_delta_bytes: u64,
    pub min_age_days: u32,
    /// 额外监视的目录。**只能由后端通过目录对话框加入**（见 `add_watch_target`），
    /// 前端永远不提供路径（I1）。空 = 只监视系统卷。
    #[serde(default)]
    pub watched: Vec<String>,
}

impl Default for WatchSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_hours: DEFAULT_INTERVAL_HOURS,
            min_bytes: DEFAULT_MIN_BYTES,
            min_delta_bytes: DEFAULT_MIN_DELTA_BYTES,
            min_age_days: DEFAULT_MIN_AGE_DAYS,
            watched: Vec::new(),
        }
    }
}

/// 前端可以改的字段。**没有 `watched`** —— 带上它就是解析错误（`deny_unknown_fields`），
/// 于是"从设置 JSON 里注入一条路径"这条路根本不存在。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchSettingsInput {
    pub enabled: bool,
    pub interval_hours: u64,
    pub min_bytes: u64,
    pub min_delta_bytes: u64,
    pub min_age_days: u32,
}

impl WatchSettings {
    /// 夹到合法范围。**间隔低于下限一律抬到下限** —— 看门狗必须低频，
    /// 这不是"建议"而是这个组件能否存在的前提。
    ///
    /// ★ **上下两个方向都要夹。** 只夹下限留下一个很隐蔽的失败模式：
    /// 前端传 `min_delta_bytes = u64::MAX`，下面 `evaluate` 里
    /// `min_delta_bytes as i64` 会回绕成 `-1`，于是 `delta < -1` 恒不成立，
    /// 阈值被**静默关掉** —— 看门狗从此再也报不出任何东西，而且没有任何报错。
    /// "保护措施被输入关掉"比"没夹"更危险，所以上限一律夹到 1 PB。
    pub fn normalized(mut self) -> Self {
        const MAX_BYTES: u64 = 1024 * 1024 * 1024 * 1024 * 1024; // 1 PB
        self.interval_hours = self.interval_hours.clamp(MIN_INTERVAL_HOURS, 24 * 30);
        self.min_bytes = self.min_bytes.clamp(64 * 1024 * 1024, MAX_BYTES);
        self.min_delta_bytes = self.min_delta_bytes.clamp(16 * 1024 * 1024, MAX_BYTES);
        self.min_age_days = self.min_age_days.clamp(1, 90);
        self
    }

    pub fn apply(&self, input: &WatchSettingsInput) -> Self {
        Self {
            enabled: input.enabled,
            interval_hours: input.interval_hours,
            min_bytes: input.min_bytes,
            min_delta_bytes: input.min_delta_bytes,
            min_age_days: input.min_age_days,
            // 监视目录不在输入端，只能保留既有值
            watched: self.watched.clone(),
        }
        .normalized()
    }

    /// 这一轮要扫哪些目标。
    pub fn targets(&self) -> Vec<String> {
        if !self.watched.is_empty() {
            return self.watched.clone();
        }
        // 默认只看系统卷：整个工具的重心在系统盘上，全卷天天扫也没必要。
        // 系统盘由运行时派生（I3），不写字面量。
        safety::SafetyProfile::global()
            .ok()
            .map(|profile| profile.env().system_drive.to_string_lossy().to_string())
            .map(|drive| vec![drive])
            .unwrap_or_default()
    }

    pub fn interval(&self) -> Duration {
        Duration::from_secs(self.interval_hours.clamp(MIN_INTERVAL_HOURS, 24 * 30) * 3600)
    }
}

// ── 判定 ────────────────────────────────────────────────────────────────

/// 一条告警：某个目录**同时**满足"够大"与"长得够快"。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub path: String,
    pub bytes: u64,
    /// 正数：这段时间里长了多少
    pub delta_bytes: i64,
    /// 增量的实际间隔天数
    pub delta_days: i64,
    /// 后端签发的发现目标 id（能在面板里直接隔离）。签发失败时为 `None`。
    pub discovery_id: Option<String>,
    pub is_user_data: bool,
}

/// **纯函数**：从排名结果里挑出满足阈值的告警。
///
/// 两个条件必须**同时**满足（§11.1）：
/// - 单目录大小 ≥ `min_bytes`；
/// - 近 N 日增长 ≥ `min_delta_bytes`。
///
/// （边界取"大于等于"：恰好等于阈值算命中。措辞按代码写，别让人照着一个
/// 与实现不符的"超过"去推边界。）
///
/// 只看大小会把"一直很大的目录"报一遍又一遍；只看增长会把小目录的抖动当病。
/// 没有历史基准（`delta_bytes == None`）时**不报** —— 无从判断是不是在长，
/// 报了就是拿"不知道"冒充"有问题"。
pub fn evaluate(ranked: &[DiscoveredDir], settings: &WatchSettings) -> Vec<Alert> {
    // ★ 用 `try_from` 而不是 `as i64`：`as` 在超过 i64::MAX 时**回绕成负数**，
    //   然后 `delta < 负数` 恒不成立 —— 阈值被输入悄悄关掉。`normalized()` 已经
    //   夹过上限，这里是第二道：`evaluate` 是 pub，别指望每个调用方都先夹过。
    let min_delta = i64::try_from(settings.min_delta_bytes).unwrap_or(i64::MAX);
    let mut out: Vec<Alert> = ranked
        .iter()
        .filter_map(|entry| {
            let delta = entry.delta_bytes?;
            let days = entry.delta_days?;
            // ★ 一律在 i64 里比较。写成 `(delta as u64) < min_delta` 的话，
            //   负增量（目录变小了）会被转成一个天文数字而**通过**阈值 ——
            //   "缩小的目录被报成在增长"，这个 bug 真出现过，用例抓住了它。
            if entry.bytes < settings.min_bytes
                || delta < min_delta
                || days < settings.min_age_days as i64
            {
                return None;
            }
            Some(Alert {
                path: entry.path.clone(),
                bytes: entry.bytes,
                delta_bytes: delta,
                delta_days: days,
                discovery_id: entry.id.clone(),
                is_user_data: entry.is_user_data,
            })
        })
        .collect();
    out.sort_by(|a, b| b.delta_bytes.cmp(&a.delta_bytes));
    out.truncate(MAX_ALERTS);
    out
}

/// 把告警组织成一句人话（通知正文）。抽出来是为了能单测文案。
pub fn summarize(alerts: &[Alert]) -> String {
    let Some(first) = alerts.first() else {
        return String::new();
    };
    let name = first
        .path
        .rsplit(['\\', '/'])
        .find(|part| !part.is_empty())
        .unwrap_or(first.path.as_str());
    let head = format!(
        "{name} 在 {} 天内增长了 {}",
        first.delta_days,
        human_bytes(first.delta_bytes.max(0) as u64)
    );
    if alerts.len() == 1 {
        head
    } else {
        format!("{head}；另有 {} 个目录在快速变大", alerts.len() - 1)
    }
}

fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut index = 0;
    while value >= 1024.0 && index < UNITS.len() - 1 {
        value /= 1024.0;
        index += 1;
    }
    if index == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[index])
    }
}

// ── 运行 ────────────────────────────────────────────────────────────────

/// 一次运行的结局，决定下一轮隔多久。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// 正常跑完（或本轮无需扫描），按设置的间隔再来
    Settled,
    /// 被别的事情挡住（用户正在清理），稍后再试
    Blocked,
}

/// 启动看门狗。低频循环，永不退出。
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_RUN_DELAY).await;
        loop {
            let next = match run_once(&app, false).await {
                Outcome::Settled => read_settings(&app).interval(),
                Outcome::Blocked => BLOCKED_RETRY,
            };
            tokio::time::sleep(next).await;
        }
    });
}

/// 用户主动点了「立即检查」：不阻塞界面，跑完由事件推状态。
///
/// 返回**有没有真的开始**。`false` 表示此刻有别的长任务占着闸门（扫描 / 清理 /
/// 占用发现）—— 那种情况下 `run_once` 会直接返回 `Blocked`、什么都不写，
/// 而调用方原来无条件提示"已开始检查"，用户于是永远等不到结果也看不到错误。
///
/// 这里用 `is_busy()` 做一次瞬时探测，是为了能在**派发之前**回答用户。
/// 它不替代闸门本身（真正抢闸仍在 `run_once` 里），所以存在一个极小的窗口：
/// 探测通过、派发时闸门已被别人抢走 —— 那时用户看到的是一句稍微乐观的话，
/// 而不会发生任何并发操作。
pub fn run_now(app: &tauri::AppHandle) -> bool {
    if app.state::<CleanState>().is_busy() {
        return false;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        run_once(&handle, true).await;
    });
    true
}

/// 加入一个监视目录。
///
/// ★ 路径**只能来自系统目录对话框**（调用方负责），并且照样要过闸一 ——
/// 红线之内、非固定卷、被重定向的根，都不接受。前端从头到尾没有机会指定路径（I1）。
pub fn add_watch_target(
    app: &tauri::AppHandle,
    dir: &std::path::Path,
) -> Result<WatchSettings, String> {
    let profile = safety::SafetyProfile::global().map_err(|e| e.to_string())?;
    let verified = profile.verify(dir).map_err(|e| e.to_string())?;
    if !safety::stat(&verified)
        .map(|st| st.is_dir())
        .unwrap_or(false)
    {
        return Err(format!("{} 不是目录", verified.display()));
    }

    let manager = app
        .try_state::<crate::config::ConfigManager>()
        .ok_or_else(|| "配置不可用".to_string())?;
    let mut settings = manager.get_system_cleaner_watch()?;
    let text = verified.display().to_string();
    if settings
        .watched
        .iter()
        .any(|item| item.eq_ignore_ascii_case(&text))
    {
        return Err(format!("{text} 已经在监视列表里了"));
    }
    settings.watched.push(text);
    manager.store_system_cleaner_watch(&settings)?;
    app.state::<CleanState>().refresh_watch_settings(&settings);
    publish(app);
    Ok(settings)
}

/// 移除第 `index` 个监视目录。
///
/// 用**下标**而不是路径：前端不该有机会提供路径，哪怕只是"要删的那一条"。
pub fn remove_watch_target(app: &tauri::AppHandle, index: usize) -> Result<WatchSettings, String> {
    let manager = app
        .try_state::<crate::config::ConfigManager>()
        .ok_or_else(|| "配置不可用".to_string())?;
    let mut settings = manager.get_system_cleaner_watch()?;
    if index >= settings.watched.len() {
        return Err(format!("监视列表里没有第 {} 项", index + 1));
    }
    settings.watched.remove(index);
    manager.store_system_cleaner_watch(&settings)?;
    app.state::<CleanState>().refresh_watch_settings(&settings);
    publish(app);
    Ok(settings)
}

/// 读设置。**一律过一遍 `normalized()`** —— 存进配置的 JSON 可能是旧版本写的、
/// 也可能被手工改过，而下游有几处直接拿字段当数用（新鲜度窗口就是其中之一）。
fn read_settings(app: &tauri::AppHandle) -> WatchSettings {
    app.try_state::<crate::config::ConfigManager>()
        .and_then(|manager| manager.get_system_cleaner_watch().ok())
        .unwrap_or_default()
        .normalized()
}

/// 跑一轮。
///
/// 顺序刻意如此：先看开关 → 再看有没有别的任务在跑 → 再看快照新不新鲜 →
/// 最后才真的扫盘。前面任何一步能省掉一次全盘扫描，都值得。
///
/// `force` = 用户主动点了「立即检查」：跳过开关判断（他要的是立刻看到结果），
/// 但仍然要过 I9 闸门与快照新鲜度 —— 那两条是"别把机器拖垮"，不是"要不要理他"。
pub async fn run_once(app: &tauri::AppHandle, force: bool) -> Outcome {
    let settings = read_settings(app);
    if !settings.enabled && !force {
        return Outcome::Settled;
    }

    let state = app.state::<CleanState>();
    // 用户在扫描或清理时不要插队：共用同一把 I9 闸门，抢不到就等下一轮。
    // ★ 用 RAII 守卫持有 —— 下面跨着一个 `.await`，中途出错、早返回、或任务被 abort
    //   都会跳过手写的 `finish()`，把那把闸门永久锁死。
    //
    // ⚠️ **不要给这个 future 套 `abort()` / 超时。** 闸门是随 future 一起析构的，
    //   但 `run_targets` 里那次 `spawn_blocking` 一旦开跑就**无法取消**
    //   （tokio 的文档明确说 blocking 任务不能被 abort）—— future 被丢掉的结果是
    //   "闸门放开了、全卷扫描还在跑"，第二个清理任务可以同时启动，正是 I9 要防的。
    //   目前没有任何地方 abort 它（两个 spawn 点都直接丢句柄），所以是潜在约束而非缺陷；
    //   将来要加超时，得先让守卫跟着 blocking 任务走。
    let Some(gate) = crate::disk_cleanup::BusyGuard::acquire(&state) else {
        return Outcome::Blocked;
    };
    state.cancel_handle().store(false, Ordering::SeqCst);

    let result = run_targets(app, &settings).await;
    drop(gate);

    match result {
        Ok((alerts, scanned)) => {
            // ★ 一个目标都没真扫（快照都还够新，见 `run_targets` 的新鲜度判断）时
            //   **什么都不写**。原来无条件写 `last_run_at = now` + 清空告警，
            //   于是"没查"被显示成"刚查过、没问题"：面板里原有的告警连同它们的
            //   `discovery_id` 一起被抹掉，用户读到的是一次根本没发生的通过。
            if scanned > 0 {
                state.set_alerts(alerts);
                state.update_watch(|watch| {
                    watch.last_run_at = Some(now());
                    watch.last_error = None;
                    watch.current = None;
                });
            } else {
                state.update_watch(|watch| {
                    watch.current = None;
                });
            }
        }
        Err(message) => {
            state.set_alerts(Vec::new());
            state.update_watch(|watch| {
                watch.last_run_at = Some(now());
                watch.last_error = Some(message);
                watch.current = None;
            });
        }
    }
    publish(app);

    // 无论成败都按正常间隔再来：看门狗是长期运行的东西，不该因为一次失败就变得急躁
    Outcome::Settled
}

/// 返回 `(告警, 真正扫了几个目标)`。
///
/// 第二个数是必须的：看门狗在"快照还够新"时会跳过整个目标（那是它的低频策略），
/// 而调用方**不能**把"一个都没扫"记成"检查过了、没问题"。
async fn run_targets(
    app: &tauri::AppHandle,
    settings: &WatchSettings,
) -> Result<(Vec<Alert>, usize), String> {
    let targets = settings.targets();
    if targets.is_empty() {
        return Err("没有可监视的目标（系统卷也解析不出来）".into());
    }

    let mut alerts: Vec<Alert> = Vec::new();
    let mut scanned_targets = 0usize;
    for target in targets {
        // 快照够新就跳过：不管是谁扫的，最近扫过就没必要再扫一遍。
        //
        // ★ 窗口取 `settings.interval()`（已夹过），**不是**原始的 `interval_hours`：
        //   那个字段来自配置文件，可以是 0，也可以是 u64::MAX —— 后者 `as i64`
        //   回绕成负数，`age < 负数小时` 恒不成立，于是每一次重启都触发一轮全卷扫描。
        //   这正是看门狗"必须低频"要防的事，不能由一次配置读入决定。
        //
        // ★ 不用 `from_std(...).unwrap_or_default()`：失败时窗口会变成 0，等价于
        //   "永不跳过"，而且没有任何日志。兜底取**最小间隔**（而不是 0），
        //   失败方向就落在"保守地多扫一点"而不是"每一轮都全卷扫"。
        let fresh_window = chrono::Duration::from_std(settings.interval())
            .unwrap_or_else(|_| chrono::Duration::hours(MIN_INTERVAL_HOURS as i64));
        if let Some(taken_at) = discover::last_taken_at(&target) {
            if let Ok(taken) = chrono::DateTime::parse_from_rfc3339(&taken_at) {
                let age = chrono::Local::now() - taken.with_timezone(&chrono::Local);
                if age < fresh_window {
                    continue;
                }
            }
        }

        let scan_target = target.clone();
        let depth = discover::DEFAULT_REPORT_DEPTH;
        let app_for_state = app.clone();
        // 扫描是阻塞的，绝不占 async worker
        let scanned = tokio::task::spawn_blocking(move || {
            let state = app_for_state.state::<CleanState>();
            let cancel = state.cancel_handle();
            let mut on_progress = |progress: discover::ScanProgress| {
                let state = app_for_state.state::<CleanState>();
                state.update_watch(|watch| {
                    watch.dirs_visited = progress.dirs_visited;
                    watch.current = Some(progress.current.clone());
                });
            };
            discover::take_snapshot(
                &scan_target,
                depth,
                // ★ 无人值守：进后台模式。慢无所谓，反正没人等 ——
                //   用户主动扫描那条通路用的是 BelowNormal（实测差 16 倍）
                Politeness::Background,
                &cancel,
                &mut on_progress,
            )
        })
        .await
        .map_err(|e| format!("监视任务失败：{e}"))??;

        let Some(snapshot) = scanned else {
            // 被取消：当作这一轮没跑，不落快照也不算失败
            continue;
        };
        if let Err(error) = discover::save(&snapshot) {
            crate::utils::logger::log("disk-cleanup", &format!("看门狗存快照失败：{error}"));
        }
        scanned_targets += 1;
        let baseline = discover::find_baseline(&target, settings.min_age_days);
        let ranked = discover::rank(&snapshot, baseline.as_ref(), 40);
        alerts.extend(evaluate(&ranked, settings));
    }

    alerts.sort_by(|a, b| b.delta_bytes.cmp(&a.delta_bytes));
    alerts.truncate(MAX_ALERTS);

    install_discovery_ids(app, &mut alerts);

    if !alerts.is_empty() {
        notify(app, &alerts);
    }
    Ok((alerts, scanned_targets))
}

/// 给告警里的目录签发 `discovery_id`，让面板上能直接隔离它们。
fn install_discovery_ids(app: &tauri::AppHandle, alerts: &mut [Alert]) {
    let state = app.state::<CleanState>();
    for alert in alerts.iter_mut() {
        if alert.discovery_id.is_some() {
            continue;
        }
        alert.discovery_id = state
            .issue_known_discovery(
                std::path::Path::new(&alert.path),
                alert.bytes,
                0,
                alert.is_user_data,
            )
            .ok()
            .map(|entry| entry.id);
    }
}

fn notify(app: &tauri::AppHandle, alerts: &[Alert]) {
    use tauri_plugin_notification::NotificationExt;

    // 通知里绝不写完整路径：它会被系统记进通知历史，而路径是隐私（§12.3 的同一条原则）。
    // 用户点开面板看得到全部细节。
    let body = summarize(alerts);
    let _ = app
        .notification()
        .builder()
        .title("有目录正在快速变大")
        .body(&body)
        .show();
}

// ── 状态 ────────────────────────────────────────────────────────────────

/// 看门狗的对外状态（面板展示用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    pub enabled: bool,
    pub interval_hours: u64,
    pub min_bytes: u64,
    pub min_delta_bytes: u64,
    pub min_age_days: u32,
    /// 监视目标（系统卷或用户挑的目录）。**仅供展示**。
    pub targets: Vec<String>,
    pub last_run_at: Option<String>,
    pub last_error: Option<String>,
    /// 正在扫描时的进度
    pub current: Option<String>,
    pub dirs_visited: u64,
    pub alerts: Vec<Alert>,
}

impl Default for WatchStatus {
    fn default() -> Self {
        let settings = WatchSettings::default();
        Self {
            enabled: settings.enabled,
            interval_hours: settings.interval_hours,
            min_bytes: settings.min_bytes,
            min_delta_bytes: settings.min_delta_bytes,
            min_age_days: settings.min_age_days,
            targets: settings.targets(),
            last_run_at: None,
            last_error: None,
            current: None,
            dirs_visited: 0,
            alerts: Vec::new(),
        }
    }
}

pub const WATCHDOG_EVENT: &str = "disk-cleanup-watchdog";

pub fn publish(app: &tauri::AppHandle) {
    let status = app.state::<CleanState>().watch_snapshot();
    let _ = tauri::Emitter::emit(app, WATCHDOG_EVENT, &status);
}

fn now() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 用例在 `watchdog/watchdog_test.rs`。
#[cfg(test)]
mod watchdog_test;
