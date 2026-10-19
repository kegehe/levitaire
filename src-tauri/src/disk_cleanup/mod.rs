//! 系统清理工具（磁盘占用发现与清理）。
//!
//! 完整设计见 `docs/系统清理工具实现方案.md`。当前进度：**P3**。
//!
//! | 文件 | 职责 |
//! |---|---|
//! | `target.rs` | 规则目标解析（`knownFolder` / `env` / `fixedPath` / `shellRecycleBin`） |
//! | `safety.rs` | ★ 三道闸、运行时派生的红线（I3）、用户数据上级目录保护 |
//! | `delete.rs` | ★ 删除引擎：不跟随重解析点（I4）、占用即跳过（I5）、只读跳过 |
//! | `rules.rs` | 规则表加载 + fail-closed 校验器 + 允许清理的根白名单 + 护栏 |
//! | `scan.rs` | 规则扫描与执行（**同一段代码**，只差一个 dry-run 开关） |
//! | `quarantine.rs` | 隔离区：同卷 move、跨卷复制校验、恢复、彻底删除、保留期 |
//! | `recycle_bin.rs` | 回收站：**只走 Shell API**，绝不按文件系统路径删 `$Recycle.Bin` |
//! | `audit.rs` | 审计日志（I8）与隐私边界（§12.3） |
//! | `mod.rs` | 状态机、单一 publish 出口、重入闸门（I9）、`discovery_id`（§8.5）、空间账目 |

pub mod audit;
pub mod delete;
pub mod discover;
pub mod quarantine;
pub mod recycle_bin;
pub mod rules;
pub mod safety;
pub mod scan;
pub mod target;
pub mod watchdog;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use rules::CleanRule;
use safety::SafetyProfile;
use scan::{JobTotals, Mode, RuleReport};

/// 唯一的状态事件名。一条事件、一个全量快照 payload —— 不做
/// `xxx-progress` / `xxx-done` / `xxx-error` 三条（§7.2）。
pub const STATUS_EVENT: &str = "disk-cleanup-status";

/// 占用发现的事件名。与清理任务**分开**是刻意的：两者是不同性质的长任务
///（一个只读、一个动文件），合成一条事件会让前端分不清进度属于谁。
pub const DISCOVERY_EVENT: &str = "disk-cleanup-discovery";

/// 上报节流的最小间隔。
///
/// 当前的进度粒度是"一条规则"，事件数天然被规则条数限制住；这个节流是为将来加细粒度
/// 进度（按文件数）时准备的，现在同时兜住"规则很多 + 单条极快"这种组合。
const PUBLISH_MIN_INTERVAL: Duration = Duration::from_millis(120);

// ── 状态 ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Idle,
    Scanning,
    Ready,
    Cleaning,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: usize,
    pub total: usize,
}

/// 「不建议清理」条目：**只有原因，没有体积**。
///
/// 体积要靠目录遍历累加，而 `WinSxS` 那种硬链接重复计数的目录累加出来的数字本身就是错的
/// （§17 验收第 14 条：不出现"承诺释放 X GB 但实际只释放 Y MB"）。体积统计随占用发现
/// （P4）用统一口径提供。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Advice {
    pub label: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanStatus {
    pub job_id: Option<String>,
    pub phase: Phase,
    pub dry_run: bool,
    pub current_rule: Option<String>,
    pub progress: Option<Progress>,
    pub reports: Vec<RuleReport>,
    pub totals: JobTotals,
    pub advice: Vec<Advice>,
    /// 空间账目（§10.2）。**由后端算好**给前端，不把安全相关的算术放到 WebView 里。
    pub ledger: Ledger,
    /// 任务开始/结束时**系统卷的可用空间**（§12.2 要求审计界面给这个对照）。
    /// 两个都有值才算得出来 —— 所以是 `Option`，不是 0。
    pub free_before: Option<u64>,
    pub free_after: Option<u64>,
    /// 后端签发的发现目标（§8.5）。前端只回传 `id`，永远不回传路径（I1）。
    pub discoveries: Vec<DiscoveryEntry>,
    /// 本次任务（或本次启动）的错误
    pub error: Option<String>,
    /// 规则表加载失败的说明。**独立字段**，不与任务错误混用：
    /// 规则表没加载上时整个功能不可用，性质与"某次任务失败"完全不同。
    pub rules_error: Option<String>,
}

/// 空间账目。**必须分栏**（§10.2）：隔离区的空间是延迟释放的 —— 同卷 move 不释放任何
/// 空间，要等保留期到期真正删除后才释放。把两者加在一起就是承诺一个兑现不了的数字。
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    /// 本次（dry-run 时是"预计"）**永久释放**的字节
    pub immediate_bytes: u64,
    /// 本次（dry-run 时是"将"）进入隔离区的字节
    pub pending_quarantine_bytes: u64,
    /// 隔离区**当前**占用的总字节（含历史条目，是磁盘上的真实值）
    pub quarantine_bytes: u64,
    /// 其中属于用户数据目录的部分：这一部分**永远不会**变成"立即释放"
    pub quarantine_user_data_bytes: u64,
    /// 隔离区读不出来时的原因。**非空时上面两个数没有意义** ——
    /// 界面上要显示"读取失败"而不是 0：0 会被读成"隔离区是空的"，
    /// 而磁盘上可能躺着几个 GB。
    pub quarantine_error: Option<String>,
    /// 需要确认才能执行的项（带 `ConfirmUnrecoverable` 护栏，目前是回收站）的估算量。
    /// 扫到才有值。**不能按 tier 过滤**：回收站是 L1 却带着这道护栏。
    pub needs_confirm_bytes: u64,
}

impl Default for CleanStatus {
    fn default() -> Self {
        Self {
            job_id: None,
            phase: Phase::Idle,
            dry_run: false,
            current_rule: None,
            progress: None,
            reports: Vec::new(),
            totals: JobTotals::default(),
            advice: Vec::new(),
            ledger: Ledger::default(),
            free_before: None,
            free_after: None,
            discoveries: Vec::new(),
            error: None,
            rules_error: None,
        }
    }
}

// ── discovery_id（§8.5，I1 的落地）──────────────────────────────────────

/// 后端为"不在规则库里的目录"签发的临时标识。
///
/// `discovery_id` **只对当前会话有效**，作废时机有两条：
/// - 任何一次扫描或清理开始（`start` / `start_discovery`）—— 这是主要的一条，
///   防止"上一次扫描签发的 id"在磁盘状态变了之后仍然可用；
/// - 应用重启（注册表只在内存里）。
///
/// **重新打开面板不作废** —— 用户关掉面板再打开，看到的东西必须还是刚才那份。
/// （签发之后到真正动手之间，路径还可能被换成重定向，所以 `quarantine_discovery`
/// 会再走一遍闸一，那才是最后一道。）
///
/// 查不到 id 一律**拒绝**，绝不回退成"用 id 当路径"。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryEntry {
    pub id: String,
    /// **仅供展示**。前端不得把它回传（守卫 `delete_commands_never_accept_a_path`）。
    pub display_path: String,
    pub bytes: u64,
    pub files: u64,
    /// 命中用户数据 KnownFolder：这类目标只能隔离，且要额外二次确认
    pub is_user_data: bool,
}

/// 注册表内部条目。**路径只存在内存里**，不落盘、不进任何 payload ——
/// 落盘就等于多了一个"路径注入"的入口。
struct DiscoveryTarget {
    path: PathBuf,
    entry: DiscoveryEntry,
}

struct Inner {
    status: CleanStatus,
    discovery: DiscoveryStatus,
    watch: watchdog::WatchStatus,
    rules: Vec<CleanRule>,
    cancel: Arc<AtomicBool>,
    last_publish: Option<Instant>,
    discoveries: HashMap<String, DiscoveryTarget>,
    discovery_seq: u64,
}

pub struct CleanState {
    inner: Mutex<Inner>,
    /// I9 长任务单飞。**判定与置位在同一条 `compare_exchange` 上**，
    /// 不存在"两个任务都看到没人跑"的竞态（对标 `updater::try_begin_install`）。
    busy: AtomicBool,
}

impl CleanState {
    pub fn new(loaded: Result<Vec<CleanRule>, String>) -> Self {
        let (rules, rules_error) = match loaded {
            Ok(rules) => (rules, None),
            Err(e) => (Vec::new(), Some(e)),
        };
        // 启动就把「不建议清理」算好：它是面板的常驻分区，不该等第一次扫描才出现
        let advice = match SafetyProfile::global() {
            Ok(profile) => advice_for(profile),
            Err(_) => Vec::new(),
        };
        Self {
            inner: Mutex::new(Inner {
                status: CleanStatus {
                    advice,
                    rules_error,
                    ..Default::default()
                },
                discovery: DiscoveryStatus::default(),
                watch: watchdog::WatchStatus::default(),
                rules,
                cancel: Arc::new(AtomicBool::new(false)),
                last_publish: None,
                discoveries: HashMap::new(),
                discovery_seq: 0,
            }),
            busy: AtomicBool::new(false),
        }
    }

    // ── discovery_id ────────────────────────────────────────────────

    /// 为一条**不在规则库里**的路径签发 id。签发前必须过闸一与用户数据判定。
    pub fn issue_discovery(&self, path: &Path) -> Result<DiscoveryEntry, String> {
        let profile = SafetyProfile::global().map_err(|e| e.to_string())?;
        // ★ 闸一原样适用：用户手动挑的目录同样不许落在红线、非固定卷或重定向的根上
        let verified = profile.verify(path).map_err(|e| e.to_string())?;
        let st = safety::stat(&verified)
            .map_err(|code| format!("无法读取 {}（Win32 错误 {code}）", verified.display()))?;
        if !st.is_dir() {
            return Err(format!("{} 不是目录", verified.display()));
        }
        // ★ 数不完整就**拒绝签发**（见 `measure_tree` 的深度上限说明）：宁可让用户看到
        //   一句"这个目录数不完"，也不要给他一个偏小的数字去判断"要不要搬走它"。
        let (bytes, files) = measure_tree(&verified, 0).ok_or_else(|| {
            format!(
                "{} 的目录树超过 {MAX_MEASURE_DEPTH} 层，无法安全处理",
                verified.display()
            )
        })?;
        let is_user_data = is_user_data_path(&verified);

        let mut seq = 0u64;
        if let Ok(mut g) = self.inner.lock() {
            seq = g.discovery_seq;
            g.discovery_seq += 1;
        }
        let id = format!("d-{seq:015}");
        let entry = DiscoveryEntry {
            id: id.clone(),
            display_path: verified.display().to_string(),
            bytes,
            files,
            is_user_data,
        };
        if let Ok(mut g) = self.inner.lock() {
            g.discoveries.insert(
                id,
                DiscoveryTarget {
                    path: verified,
                    entry: entry.clone(),
                },
            );
            g.status.discoveries = g.discoveries.values().map(|d| d.entry.clone()).collect();
        }
        Ok(entry)
    }

    /// 按 id 取回路径。**查不到就拒绝**，绝不回退成把 id 当路径用。
    pub fn resolve_discovery(&self, id: &str) -> Result<(PathBuf, DiscoveryEntry), String> {
        let g = self
            .inner
            .lock()
            .map_err(|_| "清理状态不可用".to_string())?;
        let target = g
            .discoveries
            .get(id)
            .ok_or_else(|| format!("发现目标已失效：{id}（请重新选择目录）"))?;
        Ok((target.path.clone(), target.entry.clone()))
    }

    /// 作废全部发现目标。**每次任务开始、每次窗口重开都要调**。
    pub fn clear_discoveries(&self) {
        if let Ok(mut g) = self.inner.lock() {
            g.discoveries.clear();
            g.status.discoveries.clear();
        }
    }

    /// 放弃**一个**发现目标（用户挑了目录又决定不处理它）。
    pub fn drop_discovery(&self, id: &str) -> bool {
        let Ok(mut g) = self.inner.lock() else {
            return false;
        };
        let removed = g.discoveries.remove(id).is_some();
        g.status.discoveries = g.discoveries.values().map(|d| d.entry.clone()).collect();
        removed
    }

    /// 为一条**已知统计**的目录签发 id（占用发现的结果用）。
    ///
    /// 与 [`Self::issue_discovery`] 的区别：字节数与文件数已经在扫描时算过，
    /// 不必再走一遍 `measure_tree`（那是几十万次 stat）。但**闸一照样要走** ——
    /// 扫描结果里的路径同样可能是红线、非固定卷或被重定向的根。
    pub fn issue_known_discovery(
        &self,
        path: &Path,
        bytes: u64,
        files: u64,
        is_user_data: bool,
    ) -> Result<DiscoveryEntry, String> {
        let profile = SafetyProfile::global().map_err(|e| e.to_string())?;
        let verified = profile.verify(path).map_err(|e| e.to_string())?;

        let mut seq = 0u64;
        if let Ok(mut g) = self.inner.lock() {
            seq = g.discovery_seq;
            g.discovery_seq += 1;
        }
        let entry = DiscoveryEntry {
            id: format!("d-{seq:015}"),
            display_path: verified.display().to_string(),
            bytes,
            files,
            is_user_data,
        };
        if let Ok(mut g) = self.inner.lock() {
            g.discoveries.insert(
                entry.id.clone(),
                DiscoveryTarget {
                    path: verified,
                    entry: entry.clone(),
                },
            );
            g.status.discoveries = g.discoveries.values().map(|d| d.entry.clone()).collect();
        }
        Ok(entry)
    }

    // ── 占用发现的状态 ──────────────────────────────────────────────

    pub fn discovery_snapshot(&self) -> DiscoveryStatus {
        self.inner
            .lock()
            .map(|g| g.discovery.clone())
            .unwrap_or_default()
    }

    fn update_discovery(&self, f: impl FnOnce(&mut DiscoveryStatus)) {
        if let Ok(mut g) = self.inner.lock() {
            f(&mut g.discovery);
        }
    }

    /// 陈旧任务守卫：发现任务的每次写入都要先过这里。
    fn is_current_discovery(&self, job_id: &str) -> bool {
        self.inner
            .lock()
            .map(|g| {
                g.discovery.job_id.as_deref() == Some(job_id)
                    && g.discovery.phase == Phase::Scanning
            })
            .unwrap_or(false)
    }

    // ── 看门狗的状态 ────────────────────────────────────────────────

    pub fn watch_snapshot(&self) -> watchdog::WatchStatus {
        self.inner
            .lock()
            .map(|g| g.watch.clone())
            .unwrap_or_default()
    }

    pub(crate) fn update_watch(&self, f: impl FnOnce(&mut watchdog::WatchStatus)) {
        if let Ok(mut g) = self.inner.lock() {
            f(&mut g.watch);
        }
    }

    pub(crate) fn set_alerts(&self, alerts: Vec<watchdog::Alert>) {
        self.update_watch(|watch| watch.alerts = alerts);
    }

    /// 设置变化后同步一次看门狗状态（面板要立刻显示开关与阈值）。
    pub fn refresh_watch_settings(&self, settings: &watchdog::WatchSettings) {
        self.update_watch(|watch| {
            watch.enabled = settings.enabled;
            watch.interval_hours = settings.interval_hours;
            watch.min_bytes = settings.min_bytes;
            watch.min_delta_bytes = settings.min_delta_bytes;
            watch.min_age_days = settings.min_age_days;
            watch.targets = settings.targets();
        });
    }

    pub fn snapshot(&self) -> CleanStatus {
        self.inner
            .lock()
            .map(|g| g.status.clone())
            .unwrap_or_default()
    }

    pub fn rules(&self) -> Vec<CleanRule> {
        self.inner
            .lock()
            .map(|g| g.rules.clone())
            .unwrap_or_default()
    }

    pub fn cancel_handle(&self) -> Arc<AtomicBool> {
        self.inner
            .lock()
            .map(|g| Arc::clone(&g.cancel))
            .unwrap_or_else(|_| Arc::new(AtomicBool::new(false)))
    }

    /// 请求取消当前任务。返回是否确有任务在跑。
    pub fn request_cancel(&self) -> bool {
        if !self.busy.load(Ordering::SeqCst) {
            return false;
        }
        if let Ok(g) = self.inner.lock() {
            g.cancel.store(true, Ordering::SeqCst);
        }
        true
    }

    /// I9：抢占执行权。判定与置位在同一条原子操作上。
    ///
    /// **不要直接调它** —— 用 [`BusyGuard::acquire`]。手写的
    /// `try_begin` / `finish` 配对经不起任何一个 `?` 早返回。
    fn try_begin(&self) -> bool {
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    fn finish(&self) {
        self.busy.store(false, Ordering::SeqCst);
    }

    /// 闸门是不是关着（有长任务在跑）。
    ///
    /// 给**只读诊断**用：命令层要在"派发后台任务之前"如实回答用户"现在能不能开始"。
    /// 注意它是瞬时值 —— 判完之后到真正抢闸之间还有窗口，所以它只用来决定
    /// **说什么话**，绝不用来替代闸门本身。
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

    /// 用隔离区的**实测**占用刷新空间账目。
    ///
    /// 隔离区管理命令（恢复 / 彻底删除 / 清空）改的是磁盘上的东西，但不经过
    /// `run_job`，所以账目得由它们自己更新。**必须在阻塞线程上调用** ——
    /// `summary()` 要遍历隔离区目录树。
    pub fn refresh_quarantine_ledger(&self) {
        match quarantine::summary() {
            Ok((total, user_data)) => self.update(|s| {
                s.ledger.quarantine_bytes = total;
                s.ledger.quarantine_user_data_bytes = user_data;
                s.ledger.quarantine_error = None;
            }),
            Err(e) => self.update(|s| s.ledger.quarantine_error = Some(e)),
        }
    }

    /// 陈旧任务守卫：后台任务的每次写入都必须先过这里，防止上一个任务在结束时
    /// 覆盖掉新任务的阶段（对标 `updater::is_current_download`）。
    fn is_current_job(&self, job_id: &str) -> bool {
        self.inner
            .lock()
            .map(|g| {
                g.status.job_id.as_deref() == Some(job_id)
                    && matches!(g.status.phase, Phase::Scanning | Phase::Cleaning)
            })
            .unwrap_or(false)
    }

    fn update(&self, f: impl FnOnce(&mut CleanStatus)) {
        if let Ok(mut g) = self.inner.lock() {
            f(&mut g.status);
        }
    }

    /// 节流闸门：跨过最小间隔才允许上报，返回是否放行。
    fn should_publish(&self) -> bool {
        let Ok(mut g) = self.inner.lock() else {
            return false;
        };
        let now = Instant::now();
        match g.last_publish {
            Some(last) if now.duration_since(last) < PUBLISH_MIN_INTERVAL => false,
            _ => {
                g.last_publish = Some(now);
                true
            }
        }
    }
}

/// **唯一出口**。一条事件名、一个全量快照 payload。
pub fn publish(app: &AppHandle) -> CleanStatus {
    let status = app.state::<CleanState>().snapshot();
    let _ = app.emit(STATUS_EVENT, &status);
    status
}

/// 上报前先过节流；被节流掉时不发事件，但仍返回最新快照。
fn publish_throttled(app: &AppHandle) -> CleanStatus {
    let state = app.state::<CleanState>();
    if state.should_publish() {
        publish(app)
    } else {
        state.snapshot()
    }
}

// ── 任务 ────────────────────────────────────────────────────────────────

/// I9 闸门的 RAII 持有者。
///
/// ★ **凡是从 `try_begin` 拿到执行权的地方，都必须用这个包住。**
/// 手写 `try_begin()` / `finish()` 配对经不起任何一个 `?`、一次 panic、一次早返回 ——
/// 而这类路径真实存在：`quarantine_discovery` 里 `spawn_blocking` 的 `JoinError`
/// （闭包 panic 时产生）会让 `?` 直接返回函数，`finish()` 根本不会执行。
/// 后果不是"这次任务失败"，而是**闸门永久锁死**：此后每一次扫描、清理、发现都报
/// "已有一个任务在进行中"，重启应用才能恢复。
pub struct BusyGuard<'a> {
    state: &'a CleanState,
    armed: bool,
}

impl<'a> BusyGuard<'a> {
    /// 抢闸门。抢不到返回 `None`，调用方应拒绝这次操作。
    ///
    /// ★ **必须是 `if/else`，不能用 `bool::then_some(...)`。** `then_some` 是**按值**
    /// 传参的：条件为 false 时，那个 `BusyGuard` 已经被构造出来、又被丢弃 ——
    /// **`Drop` 照常执行，于是把别人正在持有的闸门放开**。
    ///
    /// 后果不是"这次抢闸失败"，而是 I9 在**竞争路径上整体失效**：任何一次在长任务
    /// 运行期间的抢闸尝试（用户双击、看门狗轮询、隔离区操作）都会打开闸门，让第二个
    /// 清理任务与第一个并发跑起来。已实测复现。`then(|| ...)` 才是惰性的。
    pub fn acquire(state: &'a CleanState) -> Option<Self> {
        if state.try_begin() {
            Some(Self { state, armed: true })
        } else {
            None
        }
    }

    /// 接管一把**已经被持有**的闸门。
    ///
    /// 用于"抢到闸门后 spawn 出去的阻塞任务"：真正干活的那个函数才是闸门的主人，
    /// 它必须能在 panic 时也把闸门放开。
    fn adopt(state: &'a CleanState) -> Self {
        Self { state, armed: true }
    }

    /// 交还闸门。重复调用无副作用。
    pub fn release(mut self) {
        self.armed = false;
        self.state.finish();
    }

    /// **把闸门的责任移交给后台线程**，本守卫不再归还。
    ///
    /// 只用于"抢到闸门 → 立刻 spawn 一个会自己 `finish()` 的任务"这条通路
    /// （`start` / `start_discovery`）。用错方向就是泄漏一把闸门。
    pub fn hand_off(mut self) {
        self.armed = false;
    }
}

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.state.finish();
        }
    }
}

/// 发起一次扫描或清理。立即返回（任务在阻塞线程里跑，进度走 `STATUS_EVENT`）。
///
/// `confirmed_unrecoverable`：用户是否已经就"不可恢复"做过显式确认。带
/// `confirmUnrecoverable` 护栏的规则（回收站）**必须**置位才允许执行 ——
/// 把"执行前单独确认一次"从 UI 约定变成后端契约，绕过 UI 直接 invoke 也拦得住。
pub fn start(
    app: &AppHandle,
    rule_ids: &[String],
    mode: Mode,
    confirmed_unrecoverable: bool,
) -> Result<CleanStatus, String> {
    let state = app.state::<CleanState>();

    if let Ok(g) = state.inner.lock() {
        if let Some(err) = g.status.rules_error.clone() {
            return Err(err);
        }
    }

    let mut selected = Vec::new();
    {
        let Ok(g) = state.inner.lock() else {
            return Err("清理状态不可用".into());
        };
        for id in rule_ids {
            let Some(rule) = g.rules.iter().find(|r| r.id == *id) else {
                return Err(format!("未知的清理项：{id}"));
            };
            selected.push(rule.clone());
        }
    }
    if selected.is_empty() {
        return Err("没有选择任何清理项".into());
    }
    validate_rule_ids(rule_ids)?;
    // 提权项在 P6 交付。现在就把话说清楚，而不是让用户点完什么也没发生。
    let needs_admin: Vec<&str> = selected
        .iter()
        .filter(|r| r.requires_admin)
        .map(|r| r.name.as_str())
        .collect();
    if !needs_admin.is_empty() {
        return Err(format!(
            "以下清理项需要管理员权限，将在后续版本提供：{}",
            needs_admin.join("、")
        ));
    }
    // 不可恢复项：扫描（只读）不需要确认，执行必须要
    check_unrecoverable(&selected, mode, confirmed_unrecoverable)?;

    // I9：抢不到执行权说明已有任务在跑。
    // ★ 用 RAII 持有，下面的任何 `?`／早返回都会自动归还 —— 手写的
    // `try_begin`/`finish` 配对漏一次就是闸门永久锁死。
    let Some(gate) = BusyGuard::acquire(&state) else {
        return Err("已有一个扫描或清理任务在进行中，请等它结束".into());
    };

    // 新任务开始即作废全部发现目标（§8.5）：过期的 id 一旦命中错路径，
    // 后果是删掉了用户没打算动的东西。
    state.clear_discoveries();

    let job_id = audit::new_job_id();
    let dry_run = mode.is_dry_run();
    let total = selected.len();
    {
        let handle = state.cancel_handle();
        handle.store(false, Ordering::SeqCst);
    }

    let profile = match SafetyProfile::global() {
        Ok(p) => p,
        Err(e) => {
            // `gate` 在这里随作用域归还，不需要手动 finish
            return Err(e.to_string());
        }
    };
    let advice = advice_for(profile);

    // ★ 磁盘 IO 一律在锁**外**做。`quarantine::summary()` 要遍历隔离区目录树
    //（几万个文件就是秒级），`system_volume_free_bytes()` 要问一次卷。
    // 放进 `state.update` 的闭包里就是把整把锁按住几秒 —— 那期间 UI 的状态轮询、
    // 取消按钮、关窗全都在排队。
    let (quarantine_bytes, quarantine_user_data_bytes, quarantine_error) =
        match quarantine::summary() {
            Ok((total, user_data)) => (total, user_data, None),
            Err(e) => (0, 0, Some(e)),
        };
    let free_before = system_volume_free_bytes();

    state.update(|s| {
        *s = CleanStatus {
            job_id: Some(job_id.clone()),
            phase: if dry_run {
                Phase::Scanning
            } else {
                Phase::Cleaning
            },
            dry_run,
            current_rule: None,
            progress: Some(Progress { done: 0, total }),
            reports: Vec::new(),
            totals: JobTotals::default(),
            advice: advice.clone(),
            ledger: Ledger {
                quarantine_bytes,
                quarantine_user_data_bytes,
                quarantine_error,
                ..Default::default()
            },
            free_before,
            free_after: None,
            discoveries: Vec::new(),
            error: None,
            rules_error: None,
        };
    });
    let snapshot = publish(app);

    let app_handle = app.clone();
    let job = job_id.clone();
    let ids: Vec<String> = selected.iter().map(|r| r.id.clone()).collect();
    tokio::task::spawn_blocking(move || {
        run_job(app_handle, job, ids, selected, mode, profile);
    });

    // 闸门交给后台任务自己归还（`run_job` 末尾的 `state.finish()`）
    gate.hand_off();

    Ok(snapshot)
}

/// 任务的阻塞体。跑在 `spawn_blocking` 上，绝不占 async worker。
fn run_job(
    app: AppHandle,
    job_id: String,
    rule_ids: Vec<String>,
    rules: Vec<CleanRule>,
    mode: Mode,
    profile: &'static SafetyProfile,
) {
    let state = app.state::<CleanState>();
    // 本函数是闸门真正的主人：`start()` 抢到之后就把它交接到这里。
    // 用守卫而不是手写 `finish()` —— 这个函数里有好几条早返回，
    // 而且它跑在 `spawn_blocking` 上，任何一次 panic 都会把手写的释放路径跳过去。
    let _gate = BusyGuard::adopt(&state);
    let cancel = state.cancel_handle();

    // 审计日志只记真实执行的删除动作（I8）。扫描不删任何东西，不写。
    let mut writer = if mode.is_dry_run() {
        None
    } else {
        match audit::AuditWriter::begin(&job_id, &rule_ids) {
            Ok(w) => Some(w),
            Err(e) => {
                // 写不了审计日志就不执行删除 —— 没有取证依据的删除不做（I8）
                state.update(|s| {
                    s.phase = Phase::Failed;
                    s.error = Some(format!(
                        "无法写入审计日志，已中止（不执行无记录的删除）：{e}"
                    ));
                });
                publish(&app);
                return;
            }
        }
    };

    let total = rules.len();
    let mut cancelled = false;

    // 隔离区只在**真有可恢复项**时才开：绝大多数任务全是永久删除，白建一个目录没必要。
    // 保留期由用户设置决定；为 0 时隔离区只在"用户数据条目"上仍然生效（§10.1）。
    let retention_days = quarantine_retention_days(&app);
    let mut store = if mode.is_dry_run() || !rules.iter().any(|r| r.undo == rules::Undo::Quarantine)
    {
        None
    } else {
        match quarantine::JobQuarantine::begin(&job_id) {
            Ok(store) => Some(store),
            Err(e) => {
                state.update(|s| {
                    s.phase = Phase::Failed;
                    s.error = Some(format!(
                        "隔离区不可用，已中止（不做没有隔离区的可恢复删除）：{e}"
                    ));
                });
                publish(&app);
                return;
            }
        }
    };

    for (index, rule) in rules.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        if !state.is_current_job(&job_id) {
            // 已被更新的任务取代：不再写状态，避免覆盖新任务的进度。
            // 闸门由 `_gate` 在返回时归还，这里不需要手动 finish。
            return;
        }

        state.update(|s| {
            s.current_rule = Some(rule.id.clone());
        });
        publish_throttled(&app);

        let outcome = scan::run_rule(rule, mode, &cancel, profile, store.as_mut());

        if let Some(w) = writer.as_mut() {
            if let Err(e) = w.write_rule(&outcome.report, &outcome.records) {
                // 单条规则的明细写失败：记进报告，但继续 —— 已删的东西无法回滚，
                // 半途中止只会让剩下的部分没有记录，比继续更糟。
                state.update(|s| {
                    s.error = Some(format!("审计日志写入不完整：{e}"));
                });
            }
        }

        if !state.is_current_job(&job_id) {
            return;
        }
        state.update(|s| {
            s.totals.add(&outcome.report);
            s.reports.push(outcome.report);
            s.progress = Some(Progress {
                done: index + 1,
                total,
            });
        });
        publish_throttled(&app);
    }

    if let Some(store) = store.take() {
        if let Err(e) = store.finish() {
            state.update(|s| {
                s.error = Some(format!("隔离区清单写入不完整：{e}"));
            });
        }
    }

    let mut final_status = state.snapshot();
    if cancelled {
        final_status.phase = Phase::Ready;
        final_status.error = Some("已取消：已处理的条目保持现状，未处理的目录树完好无损".into());
    } else {
        final_status.phase = if mode.is_dry_run() {
            Phase::Ready
        } else {
            Phase::Done
        };
    }
    final_status.current_rule = None;
    final_status.progress = Some(Progress { done: total, total });

    if let Some(w) = writer.as_mut() {
        let _ = w.finish(&final_status.totals, &final_status.reports);
    }

    // 空间账目（§10.2）：隔离区的数字取磁盘真实值，不是本次任务的累加 ——
    // 本次任务搬进去的东西，加上历史条目，才是隔离区真正占的地方。
    //
    // ★ 读不出来时**不能填 0**：0 会被读成"隔离区是空的"，而磁盘上可能躺着几个 GB。
    // 失败就把原因带上去，让界面显示"读取失败"。
    let (quarantine_bytes, quarantine_user_data_bytes, quarantine_error) =
        match quarantine::summary() {
            Ok((total, user_data)) => (total, user_data, None),
            Err(e) => (0, 0, Some(e)),
        };
    // ★ "需要确认的量"按**护栏**算，不按 tier 算。
    // 回收站是 L1 却带 `ConfirmUnrecoverable`（默认不勾选、执行前单独确认一次），
    // 按 `tier != L1` 过滤会正好把它排除掉 —— 那恰恰是全清单里唯一真正需要确认的项。
    let needs_confirm_bytes: u64 = final_status
        .reports
        .iter()
        .filter(|report| {
            rules.iter().any(|rule| {
                rule.id == report.rule_id && rule.has_guard(rules::Guard::ConfirmUnrecoverable)
            })
        })
        .map(|report| report.bytes_deleted + report.bytes_quarantined)
        .sum();
    let ledger = Ledger {
        immediate_bytes: final_status.totals.bytes_deleted,
        pending_quarantine_bytes: final_status.totals.bytes_quarantined,
        quarantine_bytes,
        quarantine_user_data_bytes,
        quarantine_error,
        needs_confirm_bytes,
    };
    let free_after = system_volume_free_bytes();

    state.update(|s| {
        s.phase = final_status.phase;
        s.current_rule = None;
        s.progress = Some(Progress { done: total, total });
        s.error = final_status.error.clone();
        s.ledger = ledger;
        s.free_after = free_after;
    });

    // 到期自动清理：保留期为 0 表示"不自动清理"，由用户显式彻底删除
    if !mode.is_dry_run() {
        quarantine::purge_expired(retention_days);
    }

    // 闸门的归还在 `_gate` 的 Drop 里 —— 放在 `publish` 之前是因为这两步都不需要持闸
    drop(_gate);
    publish(&app);
    audit::prune();
}

/// 手工隔离一个发现目标（§8.5）。
///
/// 与规则任务**共用同一把 I9 闸门**：手工搬运同样是"正在改动文件系统"，与规则任务
/// 并发会产出不可预期的中间状态。
///
/// 处理流程刻意与规则通路一致：再走一遍闸一（签发之后路径可能被换成重定向）、
/// 走同一套隔离区搬运、写同一条审计（I8）。
pub async fn quarantine_discovery(
    app: &AppHandle,
    discovery_id: &str,
    confirm_user_data: bool,
) -> Result<quarantine::QuarantineEntry, String> {
    let (path, entry) = {
        let state = app.state::<CleanState>();
        state.resolve_discovery(discovery_id)?
    };
    if entry.is_user_data && !confirm_user_data {
        return Err(format!(
            "{} 落在用户数据目录之内。这类目录不会被永久删除，但搬进隔离区同样会改变它的位置，\
             需要你再次确认。",
            entry.display_path
        ));
    }

    let state = app.state::<CleanState>();
    // ★ 闸门必须用守卫持有：下面那个 `.await?` 会在 `spawn_blocking` 的闭包 panic 时
    //   返回 `JoinError`，`?` 直接返回函数 —— 手写的 `state.finish()` 根本执行不到，
    //   闸门就此永久锁死，此后所有操作都报"已有一个任务在进行中"。
    let Some(gate) = BusyGuard::acquire(&state) else {
        return Err("已有一个扫描或清理任务在进行中，请等它结束".into());
    };

    let job_id = audit::new_job_id();
    let handle = app.clone();
    let ledger_handle = app.clone();
    let source_label = "manual".to_string();
    let is_user_data = entry.is_user_data;
    let result =
        tokio::task::spawn_blocking(move || -> Result<quarantine::QuarantineEntry, String> {
            // 先跑搬运本体，**成败都要**往下走到账目重算（失败路径同样可能已经改动了磁盘）。
            let outcome = (|| -> Result<quarantine::QuarantineEntry, String> {
                let profile = SafetyProfile::global().map_err(|e| e.to_string())?;
                // ★ 再走一遍闸一：签发与执行之间，目标可能被换成了重定向
                let verified = profile.verify(&path).map_err(|e| e.to_string())?;
                let mut store = quarantine::JobQuarantine::begin(&job_id)?;
                let moved = store.move_in(&verified, &source_label, is_user_data)?;
                store.finish()?;
                write_manual_audit(&job_id, &moved)?;
                Ok(moved)
            })();
            // 手工隔离不影响规则报告，只刷新账目。
            // 读失败时**保留上一个已知值并记下原因** —— 这里刚刚（可能）成功地往里搬了东西，
            // 把数字抹成 0 或者留着旧值不说明，都是在骗用户。
            //
            // ★ 重算同样要遍历整棵隔离区目录树，所以必须留在**这个阻塞线程**上：
            //   与 `commands/disk_cleanup.rs::with_clean_gate` 同一口径（那边的理由：
            //   几十 GB / 几十万文件的条目会让整个应用的窗口一起卡死）。
            ledger_handle
                .state::<CleanState>()
                .refresh_quarantine_ledger();
            outcome
        })
        .await
        .map_err(|e| format!("隔离任务失败：{e}"))?;

    gate.release();
    publish(&handle);
    result
}

fn write_manual_audit(job_id: &str, moved: &quarantine::QuarantineEntry) -> Result<(), String> {
    let mut writer = audit::AuditWriter::begin(job_id, &["manual".to_string()])?;
    let report = scan::RuleReport::manual(&moved.original_path, "manual", moved.size, moved.is_dir);
    let record = delete::DeleteRecord {
        action: delete::Action::Quarantined,
        path: moved.original_path.clone(),
        bytes: moved.size,
        reason: None,
    };
    writer.write_rule(&report, std::slice::from_ref(&record))?;
    let mut totals = JobTotals::default();
    totals.add(&report);
    writer.finish(&totals, std::slice::from_ref(&report))
}

/// 删除一个隔离条目（用户主动）。
pub fn purge_quarantine_entry(entry_id: &str) -> Result<quarantine::QuarantineEntry, String> {
    let entry = quarantine::purge(entry_id)?;
    Ok(entry)
}

/// 「不可恢复」的确认闸门。
///
/// 抽成纯函数是为了能单测：**这条契约只有这一处实现**，不能只靠 UI 自觉 ——
/// 绕过界面直接 invoke 也必须拦得住。扫描（只读）不要求确认。
pub(crate) fn check_unrecoverable(
    selected: &[CleanRule],
    mode: Mode,
    confirmed: bool,
) -> Result<(), String> {
    if mode.is_dry_run() || confirmed {
        return Ok(());
    }
    let unconfirmed: Vec<&str> = selected
        .iter()
        .filter(|rule| rule.has_guard(rules::Guard::ConfirmUnrecoverable))
        .map(|rule| rule.name.as_str())
        .collect();
    if unconfirmed.is_empty() {
        return Ok(());
    }
    Err(format!(
        "以下清理项的内容不可恢复，需要你确认：{}",
        unconfirmed.join("、")
    ))
}

fn validate_rule_ids(rule_ids: &[String]) -> Result<(), String> {
    let mut seen = std::collections::HashSet::with_capacity(rule_ids.len());
    if let Some(duplicate) = rule_ids.iter().find(|id| !seen.insert(id.as_str())) {
        return Err(format!("清理项重复选择：{duplicate}"));
    }
    Ok(())
}

/// 隔离区保留期。设置项缺失时用默认值 —— **不因为读不到设置就退化成 0**：
/// 0 意味着"不自动清理"，虽然方向相反，但同样不该由一次读失败来决定。
fn quarantine_retention_days(app: &AppHandle) -> u32 {
    app.try_state::<crate::config::ConfigManager>()
        .and_then(|manager| manager.get_system_cleaner_quarantine_days().ok())
        .unwrap_or(quarantine::DEFAULT_RETENTION_DAYS)
}

// ── 发现目标的度量（只读）────────────────────────────────────────────────

/// 目录树深度上限。取值与删除引擎的 `delete::MAX_DEPTH`、隔离区的
/// `quarantine::MAX_TREE_DEPTH` 一致（128），三处口径相同。
const MAX_MEASURE_DEPTH: usize = 128;

/// 目录的 `(字节数, 文件数)`，或 `None` 表示**树超过 [`MAX_MEASURE_DEPTH`]、数不完整**。
///
/// **不跟随重解析点**，链接本身计 0 —— 与删除引擎同一口径，否则预览的数字与删除的
/// 实际结果会对不上。读不到就跳过，不中断整棵树。
///
/// ★ 深度上限不是可选的：实测深度 600 左右就**栈溢出**，而 Rust 的栈溢出是
/// `abort()` —— 不走 panic、不 unwind、**整个进程直接消失**。用户手挑的目录深度不可控
/// （下载的归档、包里套包的构建产物都是真会出现的形态）。
///
/// ★ 触顶时返回 `None` 而不是"数到哪儿算哪儿"：这个数字是用户判断"要不要把它搬进
/// 隔离区"的依据，**偏小的数字比一句拒绝更糟**（用户以为只占 3 MB 就点了确认）。
/// 与隔离区的 `tree_bytes` 同为 fail-closed —— 那边本来也会以 `TreeError::TooDeep`
/// 拒绝搬运，在这里拒绝只是把失败提前到签发时刻。
fn measure_tree(root: &Path, depth: usize) -> Option<(u64, u64)> {
    if depth > MAX_MEASURE_DEPTH {
        return None;
    }
    let Ok(st) = safety::stat(root) else {
        return Some((0, 0));
    };
    if st.is_reparse_point() {
        return Some((0, 0));
    }
    if !st.is_dir() {
        return Some((st.size, 1));
    }
    let mut bytes = 0u64;
    let mut files = 0u64;
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let (b, f) = measure_tree(&entry.path(), depth + 1)?;
            bytes += b;
            files += f;
        }
    }
    Some((bytes, files))
}

/// 目标是否落在用户数据 KnownFolder 之内（§5.6 优先级 1）。
/// 路径是否落在用户数据目录（文档 / 下载 / 桌面 / 图片 / 视频 / 音乐）之内。
///
/// ★ **判不出来时必须当作"是"。** 原来写的是 `unwrap_or(false)`：`SHGetKnownFolderPath`
/// 一旦失败（COM 没初始化好、注册表被改、权限被收紧），结论就变成"这不是用户数据"，
/// 而下游正是拿这个布尔值决定"能不能永久删除"。也就是说一次读取失败会**静默地把
/// 用户数据降级成普通缓存** —— 这是这个工具最不能犯的一类错。
///
/// 代价是判不出来时每个目标都多要一次确认。方向是对的：多问一句可以忍，
/// 少问一句可能删掉别人的论文。
pub(crate) fn is_user_data_path(path: &Path) -> bool {
    let mut unresolved = false;
    let hit = target::USER_DATA_FOLDERS
        .iter()
        .any(|folder| match target::known_folder(*folder) {
            Ok(root) => safety::starts_with_ci(path, &root),
            Err(_) => {
                unresolved = true;
                false
            }
        });
    if hit {
        return true;
    }
    if unresolved {
        crate::utils::logger::log(
            "disk-cleanup",
            "有用户数据目录解析不出来，本次按「是用户数据」保守处理（只会隔离，且多要一次确认）",
        );
        return true;
    }
    false
}

// ── 占用发现（P4 / §8）──────────────────────────────────────────────────

/// 一次占用发现的进度与结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryStatus {
    pub job_id: Option<String>,
    pub phase: Phase,
    pub volume: Option<String>,
    pub report_depth: usize,
    /// 已访问的目录数（进度）
    pub dirs_visited: u64,
    pub current: Option<String>,
    /// 因不可读而没能统计的目录数：让"这机器没垃圾"与"我根本没读到"分得开
    pub unreadable_dirs: u64,
    /// 候选目录（已按增长、占用排序并去嵌套）。**只有带 `id` 的才能清理**（I1）
    pub entries: Vec<discover::DiscoveredDir>,
    /// 基准快照的时间点与间隔；`None` = 还没有历史可比
    pub baseline_at: Option<String>,
    pub baseline_days: Option<i64>,
    /// 上一次快照的时间（让用户知道增量是从哪算起的）
    pub last_snapshot_at: Option<String>,
    pub error: Option<String>,
}

impl Default for DiscoveryStatus {
    fn default() -> Self {
        Self {
            job_id: None,
            phase: Phase::Idle,
            volume: None,
            report_depth: discover::DEFAULT_REPORT_DEPTH,
            dirs_visited: 0,
            current: None,
            unreadable_dirs: 0,
            entries: Vec::new(),
            baseline_at: None,
            baseline_days: None,
            last_snapshot_at: None,
            error: None,
        }
    }
}

/// 发起一次占用发现。只读，但同样占 I9 那把闸门 —— 它要在磁盘上跑很久，
/// 与清理任务并行只会互相拖慢，而且"边扫边删"的账目谁也说不清。
pub fn start_discovery(
    app: &AppHandle,
    volume: String,
    report_depth: usize,
) -> Result<DiscoveryStatus, String> {
    let state = app.state::<CleanState>();

    // ★ 卷必须是**运行时派生出来的固定卷**，不能是前端随手给的路径。
    //   否则这个只读接口就成了"枚举任意目录"的入口（I1 的同一条纪律）。
    let allowed = safety::fixed_volume_roots();
    if !allowed
        .iter()
        .any(|root| root.eq_ignore_ascii_case(&volume))
    {
        return Err(format!(
            "{volume} 不是可扫描的固定卷。可选：{}",
            allowed.join("、")
        ));
    }
    let report_depth = if discover::DEPTH_CHOICES.contains(&report_depth) {
        report_depth
    } else {
        discover::DEFAULT_REPORT_DEPTH
    };

    let Some(gate) = BusyGuard::acquire(&state) else {
        return Err("已有一个扫描或清理任务在进行中，请等它结束".into());
    };
    // 新一轮发现开始即作废全部旧 id（§8.5）
    state.clear_discoveries();
    state.cancel_handle().store(false, Ordering::SeqCst);

    let job_id = audit::new_job_id();
    state.update_discovery(|d| {
        *d = DiscoveryStatus {
            job_id: Some(job_id.clone()),
            phase: Phase::Scanning,
            volume: Some(volume.clone()),
            report_depth,
            dirs_visited: 0,
            current: None,
            unreadable_dirs: 0,
            entries: Vec::new(),
            baseline_at: None,
            baseline_days: None,
            last_snapshot_at: discover::last_taken_at(&volume),
            error: None,
        };
    });
    let snapshot = publish_discovery(app);

    let handle = app.clone();
    let job = job_id.clone();
    tokio::task::spawn_blocking(move || {
        run_discovery(handle, job, volume, report_depth);
    });

    // 闸门交给后台任务自己归还（`run_discovery` 里的守卫）
    gate.hand_off();

    Ok(snapshot)
}

fn run_discovery(app: AppHandle, job_id: String, volume: String, report_depth: usize) {
    let state = app.state::<CleanState>();
    // 与 `run_job` 同理：本函数是闸门真正的主人，用守卫才能在 panic 时也放开
    let _gate = BusyGuard::adopt(&state);
    let cancel = state.cancel_handle();

    let taken = {
        let app_for_progress = app.clone();
        let job_for_progress = job_id.clone();
        let mut on_progress = move |progress: discover::ScanProgress| {
            let state = app_for_progress.state::<CleanState>();
            if !state.is_current_discovery(&job_for_progress) {
                return;
            }
            state.update_discovery(|d| {
                d.dirs_visited = progress.dirs_visited;
                d.current = Some(progress.current.clone());
            });
            publish_discovery_throttled(&app_for_progress);
        };
        discover::take_snapshot(
            &volume,
            report_depth,
            // 用户主动点的扫描：低于正常优先级但**会推进**
            // （实测后台模式在真实负载下慢 16 倍，见 discover::Politeness）
            discover::Politeness::BelowNormal,
            &cancel,
            &mut on_progress,
        )
    };

    let outcome = match taken {
        Err(message) => Err(message),
        // 被取消：半份快照不落盘，如实说明
        Ok(None) => {
            state.update_discovery(|d| {
                d.phase = Phase::Idle;
                d.error = Some("已取消：没有保存快照（半份数据算出来的增量会是错的）".into());
            });
            publish_discovery(&app);
            return;
        }
        Ok(Some(snapshot)) => {
            // 存快照 → 找基准 → 排名 → 签发 id
            if let Err(e) = discover::save(&snapshot) {
                crate::utils::logger::log("disk-cleanup", &format!("保存快照失败：{e}"));
            }
            let baseline = discover::find_baseline(&volume, 7);
            let ranked = discover::rank(&snapshot, baseline.as_ref(), 40);
            let entries = ranked
                .into_iter()
                .map(|mut candidate| {
                    candidate.id = state
                        .issue_known_discovery(
                            Path::new(&candidate.path),
                            candidate.bytes,
                            candidate.files,
                            candidate.is_user_data,
                        )
                        .ok()
                        .map(|entry| entry.id);
                    candidate
                })
                .collect();
            let (baseline_at, baseline_days) = match &baseline {
                Some((snapshot, days)) => (Some(snapshot.taken_at.clone()), Some(*days)),
                None => (None, None),
            };
            state.update_discovery(|d| {
                d.phase = Phase::Done;
                d.entries = entries;
                d.unreadable_dirs = snapshot.unreadable_dirs;
                d.current = None;
                d.baseline_at = baseline_at;
                d.baseline_days = baseline_days;
                d.last_snapshot_at = Some(snapshot.taken_at.clone());
            });
            Ok(())
        }
    };

    if let Err(message) = outcome {
        state.update_discovery(|d| {
            d.phase = Phase::Failed;
            d.error = Some(message);
        });
    }
    // 没有历史可比的第一次扫描，要明说 —— 不然"没看到增长"会被读成"没问题"
    let needs_history_note = state.discovery_snapshot().baseline_at.is_none();
    if needs_history_note {
        state.update_discovery(|d| {
            if d.error.is_none() {
                d.error =
                    Some("这是该卷的第一份快照，还看不出增长。过一天再扫一次就能对比了。".into());
            }
        });
    }

    // 闸门由 `_gate` 的 Drop 归还
    drop(_gate);
    publish_discovery(&app);
}

/// 取消当前任务（清理或发现，两者共用一把 I9 闸门与一个取消标志）。
pub fn cancel_all(app: &AppHandle) -> bool {
    app.state::<CleanState>().request_cancel()
}

fn publish_discovery(app: &AppHandle) -> DiscoveryStatus {
    let status = app.state::<CleanState>().discovery_snapshot();
    let _ = app.emit(DISCOVERY_EVENT, &status);
    status
}

fn publish_discovery_throttled(app: &AppHandle) -> DiscoveryStatus {
    let state = app.state::<CleanState>();
    if state.should_publish() {
        publish_discovery(app)
    } else {
        state.discovery_snapshot()
    }
}

/// 系统卷当前的可用空间（字节）。用于审计界面的"清理前后对照"（§12.2）。
///
/// 拿不到就返回 `None` —— **不返回 0**：0 会在界面上被当成"盘满了"。
fn system_volume_free_bytes() -> Option<u64> {
    let drive = safety::SafetyProfile::global()
        .ok()
        .map(|profile| profile.env().system_drive.to_string_lossy().to_string())?;
    let mut disks = sysinfo::Disks::new_with_refreshed_list();
    disks.refresh();
    disks
        .list()
        .iter()
        .find(|disk| {
            disk.mount_point()
                .to_string_lossy()
                .eq_ignore_ascii_case(&drive)
        })
        .map(|disk| disk.available_space())
}

// ── 不建议清理（§13.2 的核心交付之一）──────────────────────────────────

/// 看上去很大、但**不该由本工具清理**的目标，逐条附原因。
///
/// 第三方清理工具的信任危机正来自"只报喜不报忧"（§一.5）。这一节是核心交付，
/// 不是附属。
pub fn advice_for(profile: &SafetyProfile) -> Vec<Advice> {
    let env = profile.env();
    let mut out = Vec::new();
    let mut push = |path: PathBuf, label: &str, reason: &str| {
        if path.exists() {
            out.push(Advice {
                label: label.to_string(),
                reason: reason.to_string(),
            });
        }
    };

    push(
        env.system_root.join("WinSxS"),
        "组件存储 WinSxS",
        "硬链接会让资源管理器把同一份数据重复计数，显示体积远大于真实占用。\
         手工删除会导致系统无法启动、无法更新、无法修复 —— 要缩小它只能用 DISM 组件清理。",
    );
    push(
        env.system_root.join("Installer"),
        "MSI 修复缓存",
        "已安装软件的卸载与修复数据。删掉后这些软件将无法卸载、修复或更新\
         （报 1612 / 1635 / 1642 / 1714），且无法用重装找回。",
    );
    push(
        env.program_data.join("Package Cache"),
        "安装器包缓存",
        "Visual Studio、VC++ 运行库等安装器的安装包缓存，用于修复与卸载。删除后对应组件无法修复。",
    );
    push(
        env.system_root.join("System32").join("DriverStore"),
        "驱动程序仓库",
        "系统里所有已安装驱动的备份。手工删除会导致硬件失效，严重时无法启动或断网；\
         仅在设备已移除时才可通过 pnputil 清理。",
    );
    push(
        env.system_drive.join("hiberfil.sys"),
        "休眠文件",
        "体积约等于内存大小。它同时支撑「快速启动」，关掉休眠会让开机明显变慢。\
         要调整请用 powercfg，不要按路径删除。",
    );
    push(
        env.system_drive.join("pagefile.sys"),
        "页面文件",
        "虚拟内存的承载文件。删除会导致部分程序无法启动，且系统会立刻重建它。",
    );
    push(
        env.system_drive.join("System Volume Information"),
        "系统还原点",
        "删掉会永久失去回滚到更新前状态的能力；这类操作还会被安全软件按勒索行为拦截。",
    );

    out
}

#[cfg(test)]
mod source_guards;

#[cfg(test)]
mod state_test;
