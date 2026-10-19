//! 规则扫描与执行（§7.2 / §13.2）。
//!
//! ★ **dry-run 与真实执行走的是同一段代码**，只差一个 `dry_run` 开关。这不是为了省代码：
//! 预览与执行一旦分叉，"预览说会删 3 GB、实际只删了 30 MB"这类不信任就没法修 ——
//! 而这个工具输出的核心价值就是"让用户自证没删错"。
//!
//! 三条策略通路：
//!
//! | 策略 | 通路 |
//! |---|---|
//! | `purgeContents` + `undo: none` | 自写递归删除（`delete.rs`），闸二/闸三原样适用 |
//! | `purgeContents` + `undo: quarantine` | 逐条搬进隔离区（`quarantine.rs`），可恢复 |
//! | `shellEmptyRecycleBin` | `SHEmptyRecycleBinW`（`recycle_bin.rs`），只走 Shell API |

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::delete::{purge_contents, Action, DeleteCtx, DeleteRecord, Reason};
use super::quarantine::{self, JobQuarantine};
use super::recycle_bin;
use super::rules::{CleanRule, Group, Guard, Strategy, Tier, Undo};
use super::safety::{stat, SafetyProfile};
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND};

/// 预览里最多展示几条抽样路径。
pub const SAMPLE_PATHS_MAX: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    DryRun,
    Execute,
}

impl Mode {
    pub fn is_dry_run(self) -> bool {
        matches!(self, Mode::DryRun)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuleStatus {
    /// 正常完成（扫描或执行）
    Ok,
    /// 目标不存在 —— 常见且**不是错误**：规则对应的软件没装
    NoTarget,
    /// 目标被安全闸拒绝
    Blocked,
    /// 被护栏拦下（例如正在安装更新）
    Guarded,
    /// 目标不是一个可清空的目录
    NotADirectory,
    /// 出错
    Failed,
    /// 用户取消
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleReport {
    pub rule_id: String,
    pub rule_name: String,
    pub tier: Tier,
    pub group: Group,
    pub status: RuleStatus,
    /// 目标路径**仅供展示与审计**。前端的删除请求只允许回传 `ruleId`（I1）。
    pub target_display: String,
    /// 永久删除的文件 / 目录
    pub files: u64,
    pub dirs: u64,
    pub bytes_deleted: u64,
    /// 移入隔离区的条目与字节。**与上面分开**：隔离区的空间要等保留期到期才真正释放
    /// （§10.2），混在一起就是承诺一个兑现不了的数字。
    pub quarantined: u64,
    pub bytes_quarantined: u64,
    pub skipped_in_use: u64,
    pub skipped_too_recent: u64,
    pub readonly_skipped: u64,
    pub reparse_skipped: u64,
    /// 枚举之后、删除之前已被**别的进程**删掉的条目。
    ///
    /// **不计进 `bytes_deleted`**：目标是达成了，但这份空间不是我们释放的。
    /// 单独列出来是为了让"本次释放了多少"这个数字经得起对账 —— 用户会拿它去比
    /// 磁盘上多出来的空间（§10.2：宁可少报，不可多报）。
    pub vanished: u64,
    pub bytes_vanished: u64,
    pub failures: u64,
    /// 抽样路径：让用户在点"清理"之前就能看到**到底会删哪些东西**
    pub sample_paths: Vec<String>,
    pub error: Option<String>,
}

impl RuleReport {
    fn new(rule: &CleanRule) -> Self {
        Self::blank(&rule.id, &rule.name, rule.tier, rule.group)
    }

    /// 为"不在规则库里的手工操作"造一条报告（手工隔离用）。
    ///
    /// 它存在的意义是**审计留痕**（I8）：手工隔离没有规则可挂靠，但一样得说清楚
    /// "动了哪个目录、动了多少"。tier/group 取 L1/user-adjacent —— 手工路径本来
    /// 就按"未知目录"对待（§5.6 优先级 2）。
    pub fn manual(label: &str, source_label: &str, bytes: u64, _is_dir: bool) -> Self {
        let mut report = Self::blank(source_label, label, Tier::L1, Group::UserAdjacent);
        report.target_display = label.to_string();
        // `files` / `dirs` 只统计"永久删除"的条目，手工隔离一律走 `quarantined`
        report.quarantined = 1;
        report.bytes_quarantined = bytes;
        report
    }

    fn blank(id: &str, name: &str, tier: Tier, group: Group) -> Self {
        Self {
            rule_id: id.to_string(),
            rule_name: name.to_string(),
            tier,
            group,
            status: RuleStatus::Ok,
            target_display: String::new(),
            files: 0,
            dirs: 0,
            bytes_deleted: 0,
            quarantined: 0,
            bytes_quarantined: 0,
            skipped_in_use: 0,
            skipped_too_recent: 0,
            readonly_skipped: 0,
            reparse_skipped: 0,
            vanished: 0,
            bytes_vanished: 0,
            failures: 0,
            sample_paths: Vec::new(),
            error: None,
        }
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobTotals {
    pub files: u64,
    pub dirs: u64,
    pub bytes_deleted: u64,
    pub quarantined: u64,
    pub bytes_quarantined: u64,
    pub skipped_in_use: u64,
    pub skipped_too_recent: u64,
    pub readonly_skipped: u64,
    pub reparse_skipped: u64,
    pub vanished: u64,
    pub bytes_vanished: u64,
    pub failures: u64,
}

impl JobTotals {
    pub fn add(&mut self, report: &RuleReport) {
        self.files += report.files;
        self.dirs += report.dirs;
        self.bytes_deleted += report.bytes_deleted;
        self.quarantined += report.quarantined;
        self.bytes_quarantined += report.bytes_quarantined;
        self.skipped_in_use += report.skipped_in_use;
        self.skipped_too_recent += report.skipped_too_recent;
        self.readonly_skipped += report.readonly_skipped;
        self.reparse_skipped += report.reparse_skipped;
        self.vanished += report.vanished;
        self.bytes_vanished += report.bytes_vanished;
        self.failures += report.failures;
    }
}

/// 单条规则的执行结果：给 UI 的报告 + 给审计日志的明细。
pub struct RuleOutcome {
    pub report: RuleReport,
    pub records: Vec<DeleteRecord>,
}

fn no_records(report: &RuleReport) -> RuleOutcome {
    RuleOutcome {
        report: report.clone(),
        records: Vec::new(),
    }
}

/// 跑一条规则。`mode` 只影响是否真的落盘。
pub fn run_rule(
    rule: &CleanRule,
    mode: Mode,
    cancel: &Arc<AtomicBool>,
    profile: &SafetyProfile,
    quarantine: Option<&mut JobQuarantine>,
) -> RuleOutcome {
    let mut report = RuleReport::new(rule);

    // 护栏：命中即拒绝执行该规则，而不是冒险（§7.4）
    if rule.has_guard(Guard::NotInstalling) && super::rules::pending_reboot() {
        report.status = RuleStatus::Guarded;
        report.error = Some(
            "检测到有待重启的更新安装，本次跳过：此时清理临时文件可能让安装失败在半路。\
             重启完成后再试。"
                .into(),
        );
        return no_records(&report);
    }

    let mut ctx = DeleteCtx::new();
    ctx.cancel = Arc::clone(cancel);
    ctx.dry_run = mode.is_dry_run();
    if let Some(days) = rule.strategy.retention_days() {
        ctx = ctx.with_older_than_days(days);
    }

    let outcome = match &rule.strategy {
        // 回收站没有文件系统目标，也就没有闸一可走（§9.4）
        Strategy::ShellEmptyRecycleBin => {
            report.target_display = "回收站（所有卷）".to_string();
            run_recycle_bin(mode, cancel, &mut ctx)
        }
        Strategy::PurgeContents { .. } => match resolve_target(profile, rule, &mut report) {
            Ok(target) => {
                report.target_display = target.display().to_string();
                match directory_precheck(&target, rule, &mut report) {
                    Ok(()) => {
                        if let Err(error) = profile.verify(&target) {
                            report.status = RuleStatus::Blocked;
                            report.error = Some(error.to_string());
                            return no_records(&report);
                        }
                        run_purge(rule, mode, &target, &mut ctx, quarantine)
                    }
                    Err(()) => return no_records(&report),
                }
            }
            Err(()) => return no_records(&report),
        },
    };

    if let Err(message) = outcome {
        report.status = RuleStatus::Failed;
        report.error = Some(message);
        return no_records(&report);
    }

    let stats = &ctx.stats;
    report.files = stats.files_deleted;
    report.dirs = stats.dirs_deleted;
    report.bytes_deleted = stats.bytes_deleted;
    report.quarantined = stats.files_quarantined + stats.dirs_quarantined;
    report.bytes_quarantined = stats.bytes_quarantined;
    report.skipped_in_use = stats.files_skipped_in_use;
    report.skipped_too_recent = stats.files_skipped_too_recent;
    report.readonly_skipped = stats.files_skipped_readonly + stats.dirs_skipped_readonly;
    report.reparse_skipped = stats.reparse_skipped;
    report.vanished = stats.files_vanished + stats.dirs_vanished;
    report.bytes_vanished = stats.bytes_vanished;
    report.failures = stats.failures;

    if cancel.load(Ordering::Relaxed) {
        report.status = RuleStatus::Cancelled;
    }
    // 扫描层要带给用户的那句话（数字不完整之类的提示），渲染成提示而不是报错
    if report.error.is_none() {
        report.error = ctx.note.clone();
    }

    // 抽样路径优先取"将要/已经删除"的条目：那是用户最想确认的东西
    for record in &ctx.records {
        if report.sample_paths.len() >= SAMPLE_PATHS_MAX {
            break;
        }
        if matches!(record.action, Action::Deleted | Action::Quarantined) {
            report.sample_paths.push(record.path.clone());
        }
    }
    // 删除项不够时，用跳过/链接项补齐 —— 预览看到"这些被跳过"同样重要
    for record in &ctx.records {
        if report.sample_paths.len() >= SAMPLE_PATHS_MAX {
            break;
        }
        if !matches!(record.action, Action::Deleted | Action::Quarantined)
            && !report.sample_paths.contains(&record.path)
        {
            report.sample_paths.push(record.path.clone());
        }
    }

    RuleOutcome {
        report,
        records: ctx.records,
    }
}

/// 解析目标并过闸一。失败时把报告置成 `Blocked` 并返回 `Err(())`。
fn resolve_target(
    profile: &SafetyProfile,
    rule: &CleanRule,
    report: &mut RuleReport,
) -> Result<PathBuf, ()> {
    // 闸一原样适用于扫描期：规则加载时已校验过一次，但环境可能在那之后变了
    // （盘符、重定向、卷类型都可能不同）
    match profile.resolve_and_verify(&rule.target) {
        Ok(path) => Ok(path),
        Err(error) => {
            report.status = RuleStatus::Blocked;
            report.error = Some(error.to_string());
            Err(())
        }
    }
}

/// 目标必须存在、且是可清空的目录。不能清的情况在这里就定状态并返回 `Err(())`。
fn directory_precheck(target: &Path, rule: &CleanRule, report: &mut RuleReport) -> Result<(), ()> {
    match stat(target) {
        Ok(st) if !st.is_dir() => {
            report.status = RuleStatus::NotADirectory;
            report.error = Some(format!(
                "{} 是文件而不是目录，当前策略（{}）只能清空目录内容",
                target.display(),
                rule.strategy.kind_str()
            ));
            Err(())
        }
        Ok(_) => Ok(()),
        Err(code) => {
            if code == ERROR_FILE_NOT_FOUND.0 || code == ERROR_PATH_NOT_FOUND.0 {
                report.status = RuleStatus::NoTarget;
            } else {
                report.status = RuleStatus::Failed;
                report.error = Some(format!(
                    "无法读取 {}（Win32 错误 {code}）",
                    target.display()
                ));
            }
            Err(())
        }
    }
}

fn run_purge(
    rule: &CleanRule,
    mode: Mode,
    target: &Path,
    ctx: &mut DeleteCtx,
    quarantine: Option<&mut JobQuarantine>,
) -> Result<(), String> {
    if rule.undo != Undo::Quarantine {
        // 永久删除：dry-run 与执行共用删除引擎的 dry-run —— 它给出的文件数与字节数，
        // 就是"将被删掉"的量。
        return purge_contents(target, ctx)
            .map_err(|e| format!("无法枚举 {}：{e}", target.display()));
    }
    // ★ `undo: quarantine` 的规则，**预览也必须走隔离口径**。
    //
    // 原来 dry-run 一律走删除引擎，于是"将搬进隔离区"的量被记成 `bytes_deleted`，
    // 前端把它渲染成「可立即释放」；而真跑起来这些字节进的是 `bytes_quarantined`
    // （「隔离区暂存」，保留期内甚至还占着更多磁盘）。预览承诺"立即释放 3 GB"、
    // 执行完却是 0 —— 正是这个工具最不能犯的账目失信。
    //
    // 拿到同一段枚举上还只是第一步：隔离是**整目录搬运 + 整树判保留期**，
    // 与删除引擎的逐文件枚举口径不同（文件数会差一截），所以预览必须复用
    // `quarantine_children` 本体，只把"搬"换成"数"。
    let source_label = format!("rule:{}", rule.id);
    if mode.is_dry_run() {
        return quarantine_children(target, None, ctx, &source_label, true);
    }
    let Some(store) = quarantine else {
        return Err("隔离区不可用，已拒绝执行：不做没有隔离区的「可恢复删除」".into());
    };
    // 走到这里的目标只可能是 `group: user-adjacent`（校验器禁止 cache 类声明可恢复），
    // 按用户数据对待：隔离区条目标记出来，恢复界面会更醒目。
    quarantine_children(target, Some(store), ctx, &source_label, true)
}

/// 逐条搬进隔离区。`store` 为 `None` 时是**预览**：同一个枚举、同一套保留期判定、
/// 同一套尺寸口径，只把"搬"换成"数"。
///
/// **整目录搬运，所以保留期要整树判定**：目录里只要还有够新的东西，就不能整个搬走 ——
/// 那会把用户正在用的文件一起挪出原位置。永久删除路径上是逐文件判的，这里不同。
fn quarantine_children(
    root: &Path,
    mut store: Option<&mut JobQuarantine>,
    ctx: &mut DeleteCtx,
    source_label: &str,
    is_user_data: bool,
) -> Result<(), String> {
    let entries =
        std::fs::read_dir(root).map_err(|e| format!("无法枚举 {}：{e}", root.display()))?;
    for entry in entries {
        if ctx.cancelled() {
            return Ok(());
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                ctx.record_failed(
                    root,
                    Reason::EnumFailed {
                        code: e.raw_os_error().unwrap_or(0) as u32,
                    },
                );
                break;
            }
        };
        let path = entry.path();
        let st = match stat(&path) {
            Ok(st) => st,
            Err(code) => {
                ctx.record_failed(&path, Reason::StatFailed { code });
                continue;
            }
        };

        if let Some(cutoff) = ctx.cutoff {
            let too_recent = if st.is_dir() && !st.is_reparse_point() {
                quarantine::has_entry_newer_than(&path, cutoff)
            } else {
                st.last_write >= cutoff
            };
            if too_recent {
                ctx.stats.files_skipped_too_recent += 1;
                ctx.stats.bytes_skipped_too_recent += st.size;
                ctx.record(Action::Skipped, &path, st.size, Some(Reason::TooRecent));
                continue;
            }
        }

        let size = match store.as_deref_mut() {
            Some(store) => match store.move_in(&path, source_label, is_user_data) {
                Ok(moved) => moved.size,
                Err(message) => {
                    ctx.record_failed(&path, Reason::QuarantineFailed { message });
                    continue;
                }
            },
            // 预览：只数不搬，但**尺寸必须与 `move_in` 同源**（调它用的那个
            // `quarantine::entry_size`），否则预览的数字与执行的账目照样对不上。
            None => match quarantine::entry_size(&path, &st) {
                Ok(bytes) => bytes,
                Err(error) => {
                    ctx.record_failed(
                        &path,
                        Reason::QuarantineFailed {
                            message: error.to_string(),
                        },
                    );
                    continue;
                }
            },
        };
        if st.is_dir() {
            ctx.stats.dirs_quarantined += 1;
        } else {
            ctx.stats.files_quarantined += 1;
        }
        ctx.stats.bytes_quarantined += size;
        // 链接被搬走时记 0 字节：搬的是链接本身，不是它指向的东西
        ctx.record(Action::Quarantined, &path, size, None);
    }
    Ok(())
}

/// 回收站通路。
///
/// **量尺寸用只读实测，清空用 Shell API** —— 这个分工是实测逼出来的：
/// Shell 查询的耗时与数据量无关（同一块盘，D 盘 6 万个文件本地枚举 0.4 秒，
/// Shell 查询 240 秒未返回），而且不透明、不可取消。详见 `recycle_bin.rs` 的模块头。
fn run_recycle_bin(
    mode: Mode,
    cancel: &Arc<AtomicBool>,
    ctx: &mut DeleteCtx,
) -> Result<(), String> {
    let measured = recycle_bin::measure_all(cancel);

    // 兜底：连一个 `$Recycle.Bin` 都列不出来时才去问 Shell（慢且无界）。
    // 只在"完全读不到"时用 —— 部分读不到是有意义的信息（其它用户的），不该被 shell
    // 那个更慢也更不可靠的数字盖掉。
    let measured_nothing =
        measured.volumes.iter().all(|volume| volume.files == 0) && measured.unreadable_sids() == 0;
    let fallback = if measured_nothing && !measured.unreadable_volumes.is_empty() {
        let report = recycle_bin::query_all();
        Some(report)
    } else {
        None
    };

    let info = match &fallback {
        Some(report) => report.total.clone(),
        None => measured.total(),
    };

    if info.items == 0 && info.bytes == 0 && fallback.is_none() {
        return Ok(());
    }

    if mode.is_dry_run() {
        // ★ dry-run **绝不**调用 SHEmptyRecycleBinW：预览阶段不许有任何破坏性调用
        ctx.stats.files_deleted += info.items;
        ctx.stats.bytes_deleted += info.bytes;
        ctx.record(
            Action::Deleted,
            Path::new(recycle_bin::RECYCLE_BIN_LABEL),
            info.bytes,
            None,
        );
        if let Some(caveat) = measurement_caveat(&measured, fallback.as_ref()) {
            // 同时留一条审计记录（可追溯）与一句给用户看的话（UI 上渲染成提示而非报错）
            ctx.record(
                Action::Skipped,
                Path::new(recycle_bin::RECYCLE_BIN_LABEL),
                0,
                Some(Reason::QuarantineFailed {
                    message: caveat.clone(),
                }),
            );
            ctx.note(caveat);
        }
        return Ok(());
    }

    let report = recycle_bin::empty_all();
    let freed = report.freed();
    ctx.stats.files_deleted += freed.items;
    ctx.stats.bytes_deleted += freed.bytes;
    ctx.record(
        Action::Deleted,
        Path::new(recycle_bin::RECYCLE_BIN_LABEL),
        freed.bytes,
        None,
    );
    for (volume, reason) in &report.problems {
        ctx.record(
            Action::Failed,
            Path::new(recycle_bin::RECYCLE_BIN_LABEL),
            0,
            Some(Reason::QuarantineFailed {
                message: format!("{volume}：{reason}"),
            }),
        );
    }
    Ok(())
}

/// 实测数字的"未计入"说明。**不完整就必须说出来** ——
/// 让用户以为这就是全部，比少报更糟。
fn measurement_caveat(
    measured: &recycle_bin::BinMeasure,
    fallback: Option<&recycle_bin::RecycleBinReport>,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(report) = fallback {
        if !report.is_complete() {
            parts.push(format!(
                "以下卷的回收站在限时内没能统计出来：{}",
                report.skipped_volumes.join("、")
            ));
        }
    }
    if !measured.unreadable_volumes.is_empty() {
        parts.push(format!(
            "以下卷的回收站目录读不到：{}",
            measured.unreadable_volumes.join("、")
        ));
    }
    let sids = measured.unreadable_sids();
    if sids > 0 {
        parts.push(format!(
            "另有 {sids} 个其它账户（含 SYSTEM）的回收站读不到，未计入上面的数字 —— \
             那部分非管理员也清不掉，所以上面的数字就是本次能释放的量"
        ));
    }
    let too_deep = measured.too_deep();
    if too_deep > 0 {
        parts.push(format!(
            "另有 {too_deep} 棵子树因为太深（超过 {} 层）或读不到而没被统计，\
             上面的数字是下界",
            recycle_bin::MAX_MEASURE_DEPTH
        ));
    }
    if measured.truncated {
        parts.push("统计被取消，上面的数字是下界".to_string());
    }
    (!parts.is_empty()).then(|| parts.join("；"))
}

/// 用例在 `scan/scan_test.rs`
#[cfg(test)]
mod scan_test;
