//! 删除引擎（闸二 + 闸三，§6.2 / §6.3）。
//!
//! **决策记录 —— 为什么不用 `IFileOperation`**：早期方案建议"优先用 Shell 语义，
//! 与资源管理器同一代码路径"。复查后不采用为主路径，两个理由：
//!
//! 1. 该依据（Shell 语义天然不跟随重定向）未经验证；
//! 2. 更关键的是它与三个硬需求冲突 —— **dry-run 预览、逐文件"成功/跳过/失败"分类、
//!    精确进度**。Shell API 给不了这个粒度，而这三点是"让用户自证没删错"的全部依据。
//!
//! 自写递归的核心防护只有二十行，见 [`process_entry`]。

use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_DIR_NOT_EMPTY, ERROR_FILE_NOT_FOUND, ERROR_LOCK_VIOLATION,
    ERROR_PATH_NOT_FOUND, ERROR_SHARING_VIOLATION,
};
use windows::Win32::Storage::FileSystem::{DeleteFileW, RemoveDirectoryW};

use super::safety::{stat, unix_secs_to_filetime, wide_long, FileStat};

/// 递归深度上限。因为**永不跟随重解析点**，路径不可能成环；这里防的是异常深的目录树
/// 把调用栈打穿（每层递归都带着一个 `read_dir` 迭代器）。
pub const MAX_DEPTH: usize = 128;

// ── 记录与统计 ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    /// 已删除
    Deleted,
    /// **已移入隔离区**（不是删除：东西还在，只是换了个地方）
    Quarantined,
    /// 主动跳过（未到保留期 / 被占用）
    Skipped,
    /// 只读属性，按决策记录跳过，**属性未被修改**
    #[serde(rename = "readonly-skipped")]
    ReadOnlySkipped,
    /// 失败（需要用户关注）
    Failed,
    /// 重解析点：**跳过了它的内容，删除了链接本身**
    ReparseSkipped,
    /// **删除前就已经不在了** —— 别的进程在我们枚举与删除之间把它删掉了。
    ///
    /// 与 `Deleted` 分开是有意的：目标是达成了，但**这份空间不是我们释放的**。
    /// 记成 `Deleted` 等于把别人干的事算进"本次释放"，而用户正是拿这个数字去对
    /// "C 盘怎么没多出 2 GB"的账（§10.2：宁可少报，不可多报）。
    Vanished,
}

/// 不能 `Copy` 的原因：`QuarantineFailed` 要带上给用户看的原话。
/// 用一个错误码糊过去等于让用户拿着"失败(5)"去猜。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Reason {
    TooRecent,
    ReadOnly,
    InUse,
    DepthExceeded,
    /// 枚举到删除之间，它已经被别的进程删掉了
    AlreadyGone,
    StatFailed {
        code: u32,
    },
    EnumFailed {
        code: u32,
    },
    AccessDenied,
    RemoveFailed {
        code: u32,
    },
    QuarantineFailed {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRecord {
    pub action: Action,
    pub path: String,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteStats {
    pub files_deleted: u64,
    pub dirs_deleted: u64,
    pub bytes_deleted: u64,
    /// 移入隔离区的条目。**与删除分开计**：隔离区的空间要等保留期到期才真正释放，
    /// 把它算进"立即释放"就是承诺一个兑现不了的数字（§10.2）。
    pub files_quarantined: u64,
    pub dirs_quarantined: u64,
    pub bytes_quarantined: u64,
    pub files_skipped_too_recent: u64,
    pub bytes_skipped_too_recent: u64,
    pub files_skipped_readonly: u64,
    pub bytes_skipped_readonly: u64,
    /// 因只读而跳过的**目录**。目录不占字节（`GetFileAttributesExW` 对目录返回的
    /// 是索引大小，不是内容大小），所以只计数。
    ///
    /// 单列出来是因为它容易被误当成"失败"：实测 `RemoveDirectoryW` 对**空但只读**
    /// 的目录返回 `ERROR_ACCESS_DENIED`，不区分的话报告里会出现一条假的权限问题。
    pub dirs_skipped_readonly: u64,
    pub files_skipped_in_use: u64,
    pub bytes_skipped_in_use: u64,
    /// 内容被跳过、只删掉链接本身的重解析点数量
    pub reparse_skipped: u64,
    /// 其中链接本身确实被移除了的数量（差额是链接删除失败）
    pub links_removed: u64,
    /// 因子树里仍有保留项而被留下的目录数（**不是错误**）
    pub dirs_retained: u64,
    /// 枚举到删除之间已被别处删掉的条目。**单独计，不进 `bytes_deleted`** ——
    /// 记进去就是把别人释放的空间算成自己的（见 `Action::Vanished`）。
    pub files_vanished: u64,
    pub bytes_vanished: u64,
    pub dirs_vanished: u64,
    pub failures: u64,
}

/// 一次删除任务的上下文。所有统计与逐条记录都汇总在这里，是审计日志（I8）的唯一来源。
pub struct DeleteCtx {
    pub cancel: Arc<AtomicBool>,
    /// 只统计不落盘。扫描阶段的 dry-run 与执行阶段走的是**同一段代码**，
    /// 保证"预览的数字"与"执行的动作"不会分叉。
    pub dry_run: bool,
    /// 早于此 FILETIME 的条目才算"够旧"。`None` = 不过滤。
    pub cutoff: Option<u64>,
    pub stats: DeleteStats,
    pub records: Vec<DeleteRecord>,
    /// 这次操作要**告诉用户的一句话**（不是错误，也不是逐条明细）。
    ///
    /// 用途：把"数字不完整"这类必须让用户看到、但不该渲染成失败的信息带出扫描层
    /// （例：回收站里有别的账户的部分读不到）。`run_rule` 会把它搬进报告的 `error` 字段，
    /// 前端对"状态正常但有 error"的渲染是提示而不是报错。
    pub note: Option<String>,
}

impl Default for DeleteCtx {
    fn default() -> Self {
        Self::new()
    }
}

impl DeleteCtx {
    pub fn new() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            dry_run: false,
            cutoff: None,
            stats: DeleteStats::default(),
            records: Vec::new(),
            note: None,
        }
    }

    /// 记一句要带给用户的话（覆盖式：只保留最后一条，避免堆成一堵墙）。
    pub(crate) fn note(&mut self, text: impl Into<String>) {
        self.note = Some(text.into());
    }

    /// `olderThanDays` 只清理"够旧"的内容。
    ///
    /// ★ `Some(0)` 的语义是"截止线 = 现在"，而 `is_old_enough` 判的是
    /// `last_write < cutoff` —— 也就是说 **0 等于「几乎全删」**（只有此刻正在写的
    /// 文件能躲过），是 **fail-open**，不是安全值。
    ///
    /// 这里以前把注释写反了（写成"什么都删不掉"）。现在由规则校验器
    /// （`rules::ZeroRetention`）直接拒绝 `olderThanDays: 0`，运行时不可达；
    /// 但注释与代码正好相反是危险的 —— 谁要是据此认为"0 是保守值"而放宽校验器，
    /// 后果就是全量删除。
    pub fn with_older_than_days(mut self, days: u32) -> Self {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let cutoff_secs = now.saturating_sub(days as u64 * 86_400);
        self.cutoff = Some(unix_secs_to_filetime(cutoff_secs));
        self
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    pub(crate) fn is_old_enough(&self, last_write: u64) -> bool {
        match self.cutoff {
            Some(cutoff) => last_write < cutoff,
            None => true,
        }
    }

    pub(crate) fn record(
        &mut self,
        action: Action,
        path: &Path,
        bytes: u64,
        reason: Option<Reason>,
    ) {
        self.records.push(DeleteRecord {
            action,
            path: path.display().to_string(),
            bytes,
            reason,
        });
    }

    pub(crate) fn record_failed(&mut self, path: &Path, reason: Reason) {
        self.stats.failures += 1;
        self.record(Action::Failed, path, 0, Some(reason));
    }
}

// ── 对外 API ────────────────────────────────────────────────────────────

/// 清空目录内容、**保留目录本身**。
///
/// 删掉 `%TEMP%` 目录会破坏 `%TEMP%` 默认路径，导致安装程序报错，所以规则里的
/// `purgeContents` 一律只清内容（§6.3）。
///
/// 返回 `Err` 只表示**根目录本身无法枚举**（不存在 / 无权限）；子树级的问题一律
/// 记进 [`DeleteCtx`]，不向上抛 —— 这是"容错继续"的关键：一个文件查不到属性，
/// 不能让整棵子树停下来。
pub fn purge_contents(root: &Path, ctx: &mut DeleteCtx) -> io::Result<()> {
    // Keep a local guard because this function is also used by quarantine cleanup.
    let root_stat = stat(root).map_err(|code| io::Error::from_raw_os_error(code as i32))?;
    if !root_stat.is_dir() || root_stat.is_reparse_point() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "清理根目录不是普通目录，已拒绝遍历",
        ));
    }
    let entries = fs::read_dir(root)?;
    for entry in entries {
        if ctx.cancelled() {
            return Ok(());
        }
        match entry {
            Ok(e) => {
                process_entry(&e.path(), 1, ctx);
            }
            Err(e) => {
                // 迭代器出错后不再继续调用：std 的 ReadDir 在错误后行为不保证，
                // 继续 next() 有重新开始枚举的风险。记一条失败，退出本目录。
                ctx.record_failed(root, Reason::EnumFailed { code: io_code(&e) });
                break;
            }
        }
    }
    Ok(())
}

// ── 递归 ────────────────────────────────────────────────────────────────

/// 处理一个条目，返回"它是否已经不在了（或 dry-run 下将会不在了）"。
///
/// 返回值驱动父目录的判断：只有子项**全部**处理干净，父目录才可能是空的。
fn process_entry(path: &Path, depth: usize, ctx: &mut DeleteCtx) -> bool {
    if ctx.cancelled() {
        return false;
    }
    if depth > MAX_DEPTH {
        ctx.record_failed(path, Reason::DepthExceeded);
        return false;
    }

    // ★ 必须重新查询属性，不能用枚举器缓存的 find_data —— Windows 上不可靠，
    //   这是 Chromium DeletePathRecursively 数据丢失事故的根因。
    //   查询失败只记一条并继续，绝不用 `?` 中断整棵树。
    let st = match stat(path) {
        Ok(s) => s,
        Err(code) if code == ERROR_FILE_NOT_FOUND.0 || code == ERROR_PATH_NOT_FOUND.0 => {
            // ★ "已经不在了"**不是失败**。这一条以前记成 `StatFailed` 失败：
            //   在 `%TEMP%` 这种活跃目录里，枚举完到重查属性之间被别的进程删掉太常见了，
            //   一次清理于是报出成百条"失败"，把真正需要用户处理的那几条淹掉。
            //   大小无从得知（文件已经没了），所以只记条目、不进字节账。
            //   返回 `true`：它确实不在了，父目录据此可以认为自己已经被清空。
            ctx.stats.files_vanished += 1;
            ctx.record(Action::Vanished, path, 0, Some(Reason::AlreadyGone));
            return true;
        }
        Err(code) => {
            ctx.record_failed(path, Reason::StatFailed { code });
            return false;
        }
    };

    // ★ 闸二：是链接本身 —— 删链接，绝不进入（I4）。
    //   不做保留期过滤：链接不承载数据，删掉链接不会删掉它指向的任何东西。
    if st.is_reparse_point() {
        ctx.stats.reparse_skipped += 1;
        // bytes 记 0：我们要删的是链接，不是它指向的目标，
        // 把目标的大小算成"已释放"是虚假账目（§10.2 的同一条原则）。
        ctx.record(Action::ReparseSkipped, path, 0, None);
        return remove_link_only(path, st.is_dir(), ctx);
    }

    if st.is_dir() {
        let emptied = purge_dir(path, depth + 1, ctx);
        if !emptied {
            ctx.stats.dirs_retained += 1;
            return false;
        }
        return remove_dir_tolerant(path, st.is_readonly(), ctx);
    }

    if !ctx.is_old_enough(st.last_write) {
        ctx.stats.files_skipped_too_recent += 1;
        ctx.stats.bytes_skipped_too_recent += st.size;
        ctx.record(Action::Skipped, path, st.size, Some(Reason::TooRecent));
        return false;
    }

    delete_file_tolerant(path, st, ctx)
}

/// 清空一个目录，返回"它现在（或将）是空的"。
fn purge_dir(path: &Path, depth: usize, ctx: &mut DeleteCtx) -> bool {
    let entries = match fs::read_dir(path) {
        Ok(it) => it,
        Err(e) => {
            // 枚举失败（权限 / 目录已消失）不中断整棵子树，只记一条失败
            ctx.record_failed(path, Reason::EnumFailed { code: io_code(&e) });
            return false;
        }
    };

    let mut emptied = true;
    for entry in entries {
        if ctx.cancelled() {
            return false;
        }
        match entry {
            Ok(e) => {
                if !process_entry(&e.path(), depth, ctx) {
                    emptied = false;
                }
            }
            Err(e) => {
                ctx.record_failed(path, Reason::EnumFailed { code: io_code(&e) });
                return false;
            }
        }
    }
    emptied
}

/// 容忍式删除目录本身。
///
/// 直接删并容忍 `ERROR_DIR_NOT_EMPTY`（说明子树里有跳过项，目录留着是对的）。
/// **不用"先判空再删"** —— 那是两步操作，中间存在竞态（§6.2）。
///
/// `is_readonly` 由调用方传入（`process_entry` 已经查过属性，不再多一次 stat）：
/// 实测 `RemoveDirectoryW` 对**空但只读**的目录返回 `ERROR_ACCESS_DENIED`。
/// 不区分的话，这种目录会被记成"失败"、把提示语往"权限/CFA 拦截"上引，
/// 而它其实是"按纪律跳过只读、属性一字未改"——那套单列不静默的计数
/// （`files_skipped_readonly`）也就永远统计不到目录。
fn remove_dir_tolerant(path: &Path, is_readonly: bool, ctx: &mut DeleteCtx) -> bool {
    if ctx.dry_run {
        ctx.stats.dirs_deleted += 1;
        ctx.record(Action::Deleted, path, 0, None);
        return true;
    }
    let w = wide_long(path);
    match unsafe { RemoveDirectoryW(PCWSTR(w.as_ptr())) } {
        Ok(()) => {
            ctx.stats.dirs_deleted += 1;
            ctx.record(Action::Deleted, path, 0, None);
            true
        }
        Err(e) => {
            let code = win32_code(e.code().0 as u32);
            if code == ERROR_DIR_NOT_EMPTY.0 {
                // 子树里还有跳过项 —— 目录留着是对的，不是失败
                ctx.stats.dirs_retained += 1;
                false
            } else if code == ERROR_PATH_NOT_FOUND.0 || code == ERROR_FILE_NOT_FOUND.0 {
                // 已被别的进程删掉。目录不占字节，但同样不该记成"我们删的"
                ctx.stats.dirs_vanished += 1;
                ctx.record(Action::Vanished, path, 0, Some(Reason::AlreadyGone));
                true
            } else if code == ERROR_ACCESS_DENIED.0 && is_readonly {
                // 空但只读的目录：按 §6.2 的决策**跳过、不改属性**，单列出来。
                // 归成"失败"会让用户以为需要处理权限，而它本来就是这个工具的选择。
                ctx.stats.dirs_skipped_readonly += 1;
                ctx.record(Action::ReadOnlySkipped, path, 0, Some(Reason::ReadOnly));
                false
            } else {
                ctx.record_failed(path, Reason::RemoveFailed { code });
                false
            }
        }
    }
}

/// 只删除链接本身。目录型链接（junction / 目录符号链接）走 `RemoveDirectoryW`，
/// 文件型链接走 `DeleteFileW` —— 两者都只作用于链接这个目录项，不触碰目标。
fn remove_link_only(path: &Path, is_dir: bool, ctx: &mut DeleteCtx) -> bool {
    if ctx.dry_run {
        ctx.stats.links_removed += 1;
        return true;
    }
    let w = wide_long(path);
    let result = if is_dir {
        unsafe { RemoveDirectoryW(PCWSTR(w.as_ptr())) }
    } else {
        unsafe { DeleteFileW(PCWSTR(w.as_ptr())) }
    };
    match result {
        Ok(()) => {
            ctx.stats.links_removed += 1;
            true
        }
        Err(e) => {
            let code = win32_code(e.code().0 as u32);
            // ★ "已经不在了"不是失败。这里是同一类竞态（stat 之后、删除之前被别的进程
            //   删掉），`process_entry` / `remove_dir_tolerant` / `delete_file_tolerant`
            //   都归成了 `Vanished`，只有这里漏了 —— 后果不只是多一条假失败：
            //   返回 `false` 会让父目录被判"未清空"（`dirs_retained`），**空目录被留下**。
            if code == ERROR_FILE_NOT_FOUND.0 || code == ERROR_PATH_NOT_FOUND.0 {
                ctx.stats.files_vanished += 1;
                ctx.record(Action::Vanished, path, 0, Some(Reason::AlreadyGone));
                return true;
            }
            // 链接删除失败的原因通常是"它指向的目标不存在"（dangling link）或权限，
            // 两种都不该让整个任务停下
            ctx.record_failed(path, Reason::RemoveFailed { code });
            false
        }
    }
}

/// 闸三：占用即跳过。
fn delete_file_tolerant(path: &Path, st: FileStat, ctx: &mut DeleteCtx) -> bool {
    // 只读文件默认跳过（§6.2 决策记录）：覆盖率下降，但绝不改变文件的既有属性。
    // 报告会单列 ReadOnlySkipped，不静默。
    if st.is_readonly() {
        ctx.stats.files_skipped_readonly += 1;
        ctx.stats.bytes_skipped_readonly += st.size;
        ctx.record(
            Action::ReadOnlySkipped,
            path,
            st.size,
            Some(Reason::ReadOnly),
        );
        return false;
    }

    if ctx.dry_run {
        ctx.stats.files_deleted += 1;
        ctx.stats.bytes_deleted += st.size;
        ctx.record(Action::Deleted, path, st.size, None);
        return true;
    }

    let w = wide_long(path);
    match unsafe { DeleteFileW(PCWSTR(w.as_ptr())) } {
        Ok(()) => {
            ctx.stats.files_deleted += 1;
            ctx.stats.bytes_deleted += st.size;
            ctx.record(Action::Deleted, path, st.size, None);
            true
        }
        Err(e) => {
            let code = win32_code(e.code().0 as u32);
            if code == ERROR_SHARING_VIOLATION.0 || code == ERROR_LOCK_VIOLATION.0 {
                // I5：记入"跳过"，不重试、不强删、不自动关进程。
                // P6 在这里接入 Restart Manager 占用者采样（§6.4）——
                // 采样必须按 rule 去重 + 批量，绝不逐文件调用，否则 %TEMP% 这种
                // 数千文件的场景会让清理时间膨胀一个数量级。
                ctx.stats.files_skipped_in_use += 1;
                ctx.stats.bytes_skipped_in_use += st.size;
                ctx.record(Action::Skipped, path, st.size, Some(Reason::InUse));
            } else if code == ERROR_ACCESS_DENIED.0 {
                // 注意：可能是权限，也可能是受控文件夹访问(CFA)拦截。
                // P6 接入 detect_cfa() 后，位于用户数据目录的拒绝改归 CfaBlocked。
                ctx.record_failed(path, Reason::AccessDenied);
            } else if code == ERROR_FILE_NOT_FOUND.0 || code == ERROR_PATH_NOT_FOUND.0 {
                // 已被别的进程删掉。目标达成了，但**空间不是我们释放的**，
                // 所以记 `Vanished` 而不是 `Deleted`，也不进 `bytes_deleted`。
                ctx.stats.files_vanished += 1;
                ctx.stats.bytes_vanished += st.size;
                ctx.record(Action::Vanished, path, st.size, Some(Reason::AlreadyGone));
                return true;
            } else {
                ctx.record_failed(path, Reason::RemoveFailed { code });
            }
            false
        }
    }
}

// ── 小工具 ──────────────────────────────────────────────────────────────

/// `windows_core::Error` 由 `from_win32()` 构造时是 `HRESULT_FROM_WIN32(code)`，
/// 低 16 位保留原始 Win32 错误码。
fn win32_code(hr: u32) -> u32 {
    hr & 0xFFFF
}

fn io_code(e: &io::Error) -> u32 {
    e.raw_os_error().unwrap_or(0) as u32
}

/// 用例放在独立文件里，理由同 `safety.rs`（含文件名为什么必须是 `delete/delete_test.rs`）。
#[cfg(test)]
mod delete_test;
