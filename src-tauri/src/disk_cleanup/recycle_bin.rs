//! 回收站（§9.4）。
//!
//! # 两条路径，两套手段（实测逼出来的）
//!
//! | 做什么 | 手段 | 为什么 |
//! |---|---|---|
//! | **量尺寸** | 只读枚举 `<盘>:\$Recycle.Bin\*` | Shell 查询的**耗时与数据量无关**，且不透明、不可取消（见下） |
//! | **清空** | `SHEmptyRecycleBinW` | 删除必须由 shell 维护一致性；**绝不按文件系统路径删** |
//!
//! # 为什么不拿 `SHQueryRecycleBin` 量尺寸（实测数据）
//!
//! 同一台机器、同一块 NVMe、都是 NTFS：
//!
//! | 卷 | 回收站内容 | 递归枚举 | `SHQueryRecycleBin` |
//! |---|---|---|---|
//! | `C:\` | 66012 个文件 / 13.89 GB | 2.7 秒 | **8.7 秒** |
//! | `D:\` | 61128 个文件 / 38.61 GB | 0.4 秒 | **240 秒仍未返回** |
//!
//! 文件系统层面 0.4 秒能数完的东西，Shell 要 4 分钟以上 —— 差距不在数据量，在 Shell 自己的
//! 逐项解析（很可能在为每个条目解析原始位置，遇到已不存在的路径就慢慢等）。
//! 这种延迟**不可预测**（8.7 / 30 / 240 秒都出现过）、**不可取消**，提高预算治不了它。
//!
//! 改成本地枚举之后：受文件系统约束 —— **有界、可取消、可报进度**。
//! 代价是逐条 `stat`（沿用删除引擎"不信枚举器缓存"的纪律），本机约 7 秒/卷；
//! 若要更快，需要一个只统计不删除的专用枚举器，那是另一条偏离纪律的路径，暂不做。
//!
//! # 只统计，绝不删除
//!
//! `$Recycle.Bin` 是红线路径（§5.4）。本模块对它的所有操作都是**只读**：
//! 不展示内部文件名（那里是用户删掉的东西的名字）、不做任何删除。
//! 清空一律走 `SHEmptyRecycleBinW`。守卫：
//! `source_guards::the_recycle_bin_never_deletes_by_path`。
//!
//! # 已知的口径差异（要如实告诉用户）
//!
//! 1. **别的用户的回收站读不到** → 少报。非提权下 `SHEmptyRecycleBin` 本来也动不了别人的，
//!    所以报出来的正好是"我们能释放多少"。
//! 2. **计数口径不同**：资源管理器按"回收条目"计（删一个含 1000 文件的目录算 1 项），
//!    我们按文件计。字节数是能对上的（C 盘实测 13.890 vs Shell 的 13.881 GB）。
//! 3. **硬链接会略微多报**：回收站里的文件若还有别的链接，删掉这一份并不真正释放空间。
//!
//! # 为什么回收站排得靠前
//!
//! 里面本来就是用户已经删掉的文件，是全清单里**最安全、最易解释、收益又最大**的目标之一。
//! 但它装的是"用户删了、可能还想找回来"的东西，因此：
//!
//! - 默认**不勾选**（与其他 L1 项相反）
//! - 执行前单独确认一次（后端强制，见 `start` 的 `confirmed_unrecoverable`）
//!
//! # 清空刻意不设超时
//!
//! 放弃等待并不会让 shell 停下来，反而会出现"我们报告失败、文件其实正在被删"的错位。
//! 宁可让它跑完，UI 上如实显示"正在清空回收站"。
//!
//! # 提权的不确定性
//!
//! `SHEmptyRecycleBinW` 是否必需提权尚无定论（调研结论与"标准用户可清空自己的回收站"的
//! 直觉有出入）。本版本**先试用户态**，失败就如实报告并指向后续版本的提权通道，
//! **不做任何绕过**。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use windows::core::PCWSTR;
use windows::Win32::UI::Shell::{
    SHEmptyRecycleBinW, SHQueryRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI,
    SHERB_NOSOUND, SHQUERYRBINFO,
};

use crate::disk_cleanup::safety;

/// Shell 查询的兜底预算。**只在本模块一个目录都读不到时才会用到**（见 `measure_volumes`），
/// 所以这个数字不敏感 —— 它不再是扫描的热路径。
pub const QUERY_BUDGET_PER_VOLUME: Duration = Duration::from_secs(30);

/// 回收站在审计日志与报告里的标识。**它不是一条路径** ——
/// Shell API 也不会告诉我们删掉了哪些条目，所以 I8 在这里只能记汇总。
pub const RECYCLE_BIN_LABEL: &str = "<recycle-bin:fixed-volumes>";

/// 回收站的占用。`items` 的语义随来源而变：
/// - 实测（`measure_*`）：**文件数**
/// - Shell 兜底（`query_*`）：**回收条目数**（删一个目录算 1 项）
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecycleBinInfo {
    pub items: u64,
    pub bytes: u64,
}

// ── 只读实测 ────────────────────────────────────────────────────────────

/// 一个卷的回收站实测结果。
#[derive(Debug, Clone, Default)]
pub struct VolumeBin {
    pub volume: String,
    pub bytes: u64,
    pub files: u64,
    /// 读不到的 SID 子目录数（其它用户的回收站）
    pub unreadable_sids: u64,
    /// 因深度上限或读不到而**没数进去**的子树数。非零表示上面的数字是**下界**。
    pub too_deep: u64,
}

/// 多卷实测的汇总。
#[derive(Debug, Clone, Default)]
pub struct BinMeasure {
    pub volumes: Vec<VolumeBin>,
    /// 连 `$Recycle.Bin` 都列不出来的卷
    pub unreadable_volumes: Vec<String>,
    /// 因取消而截断（截断时数字是**下界**，必须如实标注）
    pub truncated: bool,
}

impl BinMeasure {
    pub fn bytes(&self) -> u64 {
        self.volumes.iter().map(|volume| volume.bytes).sum()
    }

    pub fn files(&self) -> u64 {
        self.volumes.iter().map(|volume| volume.files).sum()
    }

    pub fn unreadable_sids(&self) -> u64 {
        self.volumes.iter().map(|volume| volume.unreadable_sids).sum()
    }

    /// 没数进去的子树总数（深度上限 + 读不到）。**非零就说明数字是下界**。
    pub fn too_deep(&self) -> u64 {
        self.volumes.iter().map(|volume| volume.too_deep).sum()
    }

    /// 数字是否完整可信。不完整时调用方必须把"未计入的部分"说出来，
    /// 不能让用户以为这就是全部。
    #[allow(dead_code)]
    pub fn is_complete(&self) -> bool {
        !self.truncated
            && self.unreadable_volumes.is_empty()
            && self.unreadable_sids() == 0
            && self.too_deep() == 0
    }

    pub fn total(&self) -> RecycleBinInfo {
        RecycleBinInfo {
            items: self.files(),
            bytes: self.bytes(),
        }
    }
}

/// 一个卷的回收站目录。
///
/// ★ 卷标识**必须带尾部分隔符**：`C:` 在 Windows 上是"**C 盘当前目录**下的相对路径"，
/// 不是卷根。传一个不带反斜杠的 `C:` 进来会静默读到错误的位置（或读不到），
/// 而 `SystemDrive` 环境变量正好就是不带反斜杠的形式 —— 这个坑真踩到过。
fn bin_dir(volume: &str) -> PathBuf {
    let mut text = volume.to_string();
    if !text.ends_with('\\') && !text.ends_with('/') {
        text.push('\\');
    }
    PathBuf::from(text).join("$Recycle.Bin")
}

/// 实测递归的深度上限。
///
/// ★ 这个上限**不是可选的**：实测在默认栈大小的线程上（`spawn_blocking` 用的就是这种），
/// 深度 600 左右的目录树就会**栈溢出** —— 而 Rust 的栈溢出是 `abort()`，
/// 不走 panic、不 unwind、**整个应用进程直接消失**。回收站里完全可能存在被删掉的深目录树
/// （`$R<id>` 会完整保留原树的深度），所以"只读预览把它扫崩"是真实可达的。
///
/// 128 与删除引擎的 `MAX_DEPTH` 取同一个值，两处口径一致。
pub const MAX_MEASURE_DEPTH: usize = 128;

/// 累加结果的三个数：字节、文件、**因深度上限而没数进去的子树数**。
#[derive(Debug, Clone, Copy, Default)]
pub struct MeasureTotals {
    pub bytes: u64,
    pub files: u64,
    /// 触到深度上限而**没被统计**的子树数。非零表示上面的数字是**下界**。
    pub too_deep: u64,
}

/// 累加一棵子树的字节数与文件数。
///
/// **只统计，不删除**；不进入重解析点（I4 的同一条纪律：链接指向的东西不属于这里，
/// 跟进去只会让数字虚高）；读不到就跳过，不中断整棵树；**深度有上限**（见上）。
fn measure_tree(dir: &Path, cancel: &AtomicBool, acc: &mut MeasureTotals, depth: usize) {
    if depth > MAX_MEASURE_DEPTH {
        acc.too_deep += 1;
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        acc.too_deep += 1; // 读不到也算"没数进去"，与深度上限同一口径
        return;
    };
    for entry in entries.flatten() {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        let path = entry.path();
        let Ok(st) = safety::stat(&path) else {
            acc.too_deep += 1;
            continue;
        };
        if st.is_reparse_point() {
            // 链接本身不承载数据，跟进去会统计到别处的东西
            continue;
        }
        if st.is_dir() {
            measure_tree(&path, cancel, acc, depth + 1);
        } else {
            acc.bytes += st.size;
            acc.files += 1;
        }
    }
}

/// 只读实测若干卷的回收站占用。
///
/// 每一卷：列出 `$Recycle.Bin` 下的 SID 子目录，逐个累加。读不到的 SID 目录
/// （其它用户的）只计数不报错 —— 它们本来也不在我们能释放的范围内。
pub fn measure_volumes(volumes: &[String], cancel: &AtomicBool) -> BinMeasure {
    let mut measure = BinMeasure::default();

    for volume in volumes {
        if cancel.load(Ordering::Relaxed) {
            measure.truncated = true;
            break;
        }
        let root = bin_dir(volume);
        let Ok(entries) = std::fs::read_dir(&root) else {
            // 整个 `$Recycle.Bin` 都列不出来（通常是没有回收站，或权限被收紧）
            measure.unreadable_volumes.push(volume.clone());
            continue;
        };

        let mut bin = VolumeBin {
            volume: volume.clone(),
            ..Default::default()
        };
        for entry in entries.flatten() {
            if cancel.load(Ordering::Relaxed) {
                measure.truncated = true;
                break;
            }
            let path = entry.path();
            // SID 目录本身也可能是重解析点（被人做过手脚），同样不进去
            match safety::stat(&path) {
                Ok(st) if st.is_dir() && !st.is_reparse_point() => {}
                Ok(_) => continue,
                Err(_) => {
                    bin.unreadable_sids += 1;
                    continue;
                }
            }
            // 列不出来 = 别的用户的回收站（ACL 拦住了），如实计数而不是当成 0
            if std::fs::read_dir(&path).is_err() {
                bin.unreadable_sids += 1;
                continue;
            }
            let mut acc = MeasureTotals::default();
            measure_tree(&path, cancel, &mut acc, 0);
            bin.bytes += acc.bytes;
            bin.files += acc.files;
            bin.too_deep += acc.too_deep;
        }
        measure.volumes.push(bin);
    }

    // 逐卷留一条日志：数字看着不对时，这是唯一能查到"是哪一卷、读到了什么"的地方。
    // 只记卷、文件数、字节数 —— 回收站里的**文件名**是用户删掉的东西的名字，不进日志。
    for volume in &measure.volumes {
        crate::utils::logger::log(
            "disk-cleanup",
            &format!(
                "回收站实测 {}：{} 个文件 / {}，读不到的 SID 目录 {} 个",
                volume.volume,
                volume.files,
                format_bytes(volume.bytes),
                volume.unreadable_sids
            ),
        );
    }

    measure
}

/// 只读实测所有固定卷。**与 `empty_all` 走同一份卷清单** ——
/// 统计的集合与清空的集合必须是同一个，否则就会出现"说 52 GB、实际只释放 13 GB"。
pub fn measure_all(cancel: &AtomicBool) -> BinMeasure {
    measure_volumes(&target_volumes(), cancel)
}

// ── Shell 兜底与清空 ────────────────────────────────────────────────────

/// 逐卷的 Shell 查询结果（兜底用）。
#[derive(Debug, Clone, Default)]
pub struct RecycleBinReport {
    pub total: RecycleBinInfo,
    /// 查询超时或出错的卷（展示用）。非空表示 total 是**不完整**的。
    pub skipped_volumes: Vec<String>,
}

impl RecycleBinReport {
    pub fn is_complete(&self) -> bool {
        self.skipped_volumes.is_empty()
    }
}

#[derive(Debug, Clone, Default)]
pub struct EmptyReport {
    /// 成功清空并复核过的卷及其释放量
    pub emptied: Vec<(String, RecycleBinInfo)>,
    /// 失败或无法复核的卷与原因
    pub problems: Vec<(String, String)>,
}

impl EmptyReport {
    pub fn freed(&self) -> RecycleBinInfo {
        let mut out = RecycleBinInfo::default();
        for (_, info) in &self.emptied {
            out.items += info.items;
            out.bytes += info.bytes;
        }
        out
    }
}

/// 在**专用线程**上跑一次 Shell 调用：先初始化 COM，再把结果通过 channel 送回来。
///
/// Shell 的回收站接口可能长时间不返回（实测 D 盘 240 秒），直接在调用线程上等会把整个
/// 清理任务卡死。超时后我们**放弃那个线程**（它可能仍在 shell 内部），如实返回超时。
///
/// `budget = None` 表示不设超时（清空用）。
fn run_shell<T: Send + 'static>(
    label: &str,
    budget: Option<Duration>,
    job: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = mpsc::channel();
    std::thread::Builder::new()
        .name(format!("recycle-bin-{label}"))
        .spawn(move || {
            crate::disk_cleanup::target::ensure_com_initialized();
            let _ = sender.send(job());
        })
        .map_err(|e| format!("无法启动回收站工作线程：{e}"))?;

    match budget {
        None => receiver
            .recv()
            .map_err(|_| "回收站工作线程异常退出".to_string()),
        Some(limit) => match receiver.recv_timeout(limit) {
            Ok(value) => Ok(value),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(format!(
                "回收站操作超过 {} 秒仍未返回（回收站条目可能非常多）",
                limit.as_secs()
            )),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("回收站工作线程异常退出".to_string())
            }
        },
    }
}

fn query_one(volume: &str) -> Result<RecycleBinInfo, String> {
    let owned: Vec<u16> = volume.encode_utf16().chain(std::iter::once(0)).collect();
    let label = format!("query-{}", volume.replace(':', ""));
    run_shell(&label, Some(QUERY_BUDGET_PER_VOLUME), move || {
        let mut data = SHQUERYRBINFO {
            cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
            i64Size: 0,
            i64NumItems: 0,
        };
        unsafe { SHQueryRecycleBinW(PCWSTR(owned.as_ptr()), &mut data) }.map_err(|e| {
            format!("查询回收站失败（HRESULT 0x{:08X}）", e.code().0 as u32)
        })?;
        Ok(RecycleBinInfo {
            items: data.i64NumItems.max(0) as u64,
            bytes: data.i64Size.max(0) as u64,
        })
    })?
}

fn empty_one(volume: &str) -> Result<(), String> {
    let owned: Vec<u16> = volume.encode_utf16().chain(std::iter::once(0)).collect();
    let label = format!("empty-{}", volume.replace(':', ""));
    // 注意尾部没有分号：`run_shell` 返回的是 `Result<Result<(), String>, String>`，
    // 加一个 `?` 拆出内层，带分号就会把内层的错误悄悄丢掉。
    run_shell(&label, None, move || {
        unsafe {
            SHEmptyRecycleBinW(
                None,
                PCWSTR(owned.as_ptr()),
                SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND,
            )
        }
        .map_err(|e| {
            let hr = e.code().0 as u32;
            // E_UNEXPECTED 是 shell 在"这个卷的回收站本来就是空的"时的常见返回
            if hr == 0x8000_FFFF {
                return String::new();
            }
            format!(
                "清空失败（HRESULT 0x{hr:08X}）。最常见的原因是权限：回收站里可能混有其它\
                 用户或系统账户删除的内容，清空它需要管理员权限 —— 本版本暂不提权。"
            )
        })
    })?
}

/// 查询/清空/实测作用于哪些卷。**三者必须共用这一份清单。**
///
/// 用例可以把它收窄成单个卷（见 `with_volumes_for_tests`）。
fn target_volumes() -> Vec<String> {
    #[cfg(test)]
    if let Some(list) = TEST_VOLUMES.with(|slot| slot.borrow().clone()) {
        return list;
    }
    safety::fixed_volume_roots()
}

#[cfg(test)]
thread_local! {
    static TEST_VOLUMES: std::cell::RefCell<Option<Vec<String>>> =
        const { std::cell::RefCell::new(None) };
}

/// 用例专用：把回收站的作用范围临时收窄成指定的卷。
#[cfg(test)]
pub fn with_volumes_for_tests<T>(volumes: Vec<String>, body: impl FnOnce() -> T) -> T {
    TEST_VOLUMES.with(|slot| {
        let previous = slot.borrow_mut().replace(volumes);
        let out = body();
        *slot.borrow_mut() = previous;
        out
    })
}

/// 查询若干卷的回收站（**兜底路径**）。任一卷超时只记为"未统计"，不影响其余卷。
pub fn query_volumes(volumes: &[String]) -> RecycleBinReport {
    let mut report = RecycleBinReport::default();
    for volume in volumes {
        match query_one(volume) {
            Ok(info) => {
                report.total.items += info.items;
                report.total.bytes += info.bytes;
            }
            Err(reason) => {
                crate::utils::logger::log(
                    "disk-cleanup",
                    &format!("回收站查询未完成（{volume}）：{reason}"),
                );
                report.skipped_volumes.push(volume.clone());
            }
        }
    }
    report
}

/// 查询所有**固定卷**（兜底路径）。可移动盘与网络盘不在本工具范围内（§5.4）。
pub fn query_all() -> RecycleBinReport {
    query_volumes(&target_volumes())
}

/// 清空若干卷的回收站，并逐卷复核释放量。
///
/// 复核用**实测**（快、有界），不用 Shell 查询（慢、无界）。
/// 复核失败、或清空后仍有剩余时，该卷记进 `problems` 且**释放量按 0 计** ——
/// 宁可少报，不可多报（§10.2）。
pub fn empty_volumes(volumes: &[String]) -> EmptyReport {
    let mut report = EmptyReport::default();
    let cancel = AtomicBool::new(false);

    for volume in volumes {
        // 先量一次，否则"释放了多少"只能靠猜。量不到就当 0（宁可少报）。
        let before = measure_volumes(std::slice::from_ref(volume), &cancel);
        let before_bin = before.volumes.first().cloned().unwrap_or_default();
        let before_readable = !before.unreadable_volumes.contains(volume);

        if let Err(reason) = empty_one(volume) {
            if reason.is_empty() {
                continue; // 本来就是空的
            }
            report.problems.push((volume.clone(), reason));
            continue;
        }

        // 复核：清空后再实测一次
        let after = measure_volumes(std::slice::from_ref(volume), &cancel);
        let after_bin = after.volumes.first().cloned().unwrap_or_default();

        if after_bin.files > 0 {
            report.problems.push((
                volume.clone(),
                format!(
                    "清空后仍剩 {} 个文件（{}）：可能属于其它用户账户、正被占用、或需要管理员权限",
                    after_bin.files,
                    format_bytes(after_bin.bytes)
                ),
            ));
            continue;
        }
        if !before_readable {
            report.problems.push((
                volume.clone(),
                "已清空，但清空前无法实测，这一次释放了多少无从得知".into(),
            ));
            continue;
        }
        let freed = RecycleBinInfo {
            items: before_bin.files.saturating_sub(after_bin.files),
            bytes: before_bin.bytes.saturating_sub(after_bin.bytes),
        };
        report.emptied.push((volume.clone(), freed));
    }
    report
}

/// 清空所有固定卷的回收站。
pub fn empty_all() -> EmptyReport {
    empty_volumes(&target_volumes())
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut index = 0;
    while value >= 1024.0 && index < UNITS.len() - 1 {
        value /= 1024.0;
        index += 1;
    }
    format!("{value:.1} {}", UNITS[index])
}

/// 用例在 `recycle_bin/recycle_bin_test.rs`：本文件通篇是生产代码，
/// 源码守卫可以整文件扫描而不必按 `#[cfg(test)]` 截断。
#[cfg(test)]
mod recycle_bin_test;
