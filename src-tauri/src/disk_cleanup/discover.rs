//! 通用占用发现（§8）：不盯固定路径，靠"扫一遍 + 和历史比"把失控的目录捞出来。
//!
//! # 为什么必须有
//!
//! 规则库只能覆盖我们知道的东西。实测中，一台机器上**最大的单一垃圾可能完全不在任何现成
//! 清理清单里**（调研时在开发机 `%TEMP%` 下发现一个 17 GB、每天增长 5.3 GB 的未知目录）。
//! 这类问题只能靠发现能力捞出来 —— 它是"通用性"这个设计目标的兑现方式。
//!
//! # 只读
//!
//! 本模块**一个字节都不删**。它的产出是「哪些目录大、哪些在长」，用户看到之后自己决定；
//! 要清理的话走 `discovery_id` 那套（§8.5）：只能进隔离区，不能永久删除。
//!
//! # 与 §8.2 的一处偏差（刻意）
//!
//! §8.2 写的是"从卷根 BFS 下钻，深度限制（默认 4 层）"。若照字面实现 —— 到第 4 层就不往下
//! 走了 —— 第 4 层目录的大小会**只统计到第 4 层为止**，而 `%TEMP%` 在第 6 层，于是
//! 「`AppData\Local` 只占 2 GB」这种明显错误的数字就会被摆到用户面前。
//! §17 验收第 14 条明令不许出现数字与事实不符的情况。
//!
//! 因此这里的做法是：**遍历到底（统计完整），只报告浅层**。`max_depth` 是**报告深度**，
//! 不是遍历深度。遍历的开销由另外几样东西控制：
//!
//! - 跳过红线目录（§8.2，反正也清不了）；
//! - 不进入重解析点（I4 的纪律在这里同样适用）；
//! - 把工作线程切成**后台模式**（低 IO 与 CPU 优先级），不跟用户抢磁盘；
//! - 随时可取消。
//!
//! # 快照与增量
//!
//! 每次扫描把结果存一份快照。只有把"一直很大"和"正在失控"区分开，发现才有意义 ——
//! 前者是历史事实，后者才是需要处理的问题（§8.4）。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Threading::{
    GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN, THREAD_MODE_BACKGROUND_END,
    THREAD_PRIORITY, THREAD_PRIORITY_BELOW_NORMAL, THREAD_PRIORITY_NORMAL,
};

use super::audit;
use super::safety::{self, SafetyProfile};

/// 快照结构版本。字段语义变化时递增；读到不认识的版本直接忽略（宁可重扫，不可误判）。
pub const SNAPSHOT_SCHEMA_VERSION: u32 = 1;

/// 默认的报告深度。
pub const DEFAULT_REPORT_DEPTH: usize = 4;
/// 可选的报告深度。
pub const DEPTH_CHOICES: &[usize] = &[2, 3, 4, 5, 6];

/// 递归的硬上限。报告深度最多到 6，但遍历本身也要防一条病态深的路径把栈打穿。
const MAX_WALK_DEPTH: usize = 96;

/// 快照保留份数（每个卷）。快照本身不能变成垃圾。
pub const SNAPSHOT_KEEP: usize = 30;

/// 一次扫描最多为多少个目录签发 `discovery_id`。
///
/// 有上限是必须的：id 表只存在内存里，前端一次也展示不了那么多。
pub const MAX_DISCOVERY_IDS: usize = 120;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryStat {
    /// 目录的完整路径。**仅供展示**；要清理必须用后端签发的 `discovery_id`（I1）。
    pub path: String,
    /// 整个子树的字节数（**完整**，不受报告深度影响）
    pub bytes: u64,
    pub files: u64,
    /// 子树内最新的修改时间（FILETIME）
    pub newest_mtime: u64,
    /// 相对卷根的层数（卷根的直接子目录为 1）
    pub depth: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub schema_version: u32,
    pub taken_at: String,
    /// 卷根，如 `C:\`
    pub volume: String,
    pub report_depth: usize,
    pub entries: Vec<DirEntryStat>,
    /// 因不可读而没能统计的目录数。让人知道这份快照有多完整 ——
    /// 少了它，"这机器没什么垃圾"与"我根本没读到"就分不出来。
    pub unreadable_dirs: u64,
    /// 根自身的合计。**不在 `entries` 里**（否则排名会被根一条全吞掉）。
    ///
    /// ★ **这不是"整卷共多少"**：红线目录（`Windows` / `Program Files` /
    /// `ProgramData` / `$Recycle.Bin` / `System Volume Information` …）在遍历里被整棵
    /// 跳过（§8.2：清不了的东西扫它只是白耗时间），所以这个数是"**能清理的那部分**有多大"。
    /// 拿它跟"整卷大小"或外部工具的全卷口径对账会得到巨大的差额 —— 那是设计如此，
    /// 不是统计错。见 `discover_test` 里对账用例的说明。
    #[serde(default)]
    pub root_bytes: u64,
    #[serde(default)]
    pub root_files: u64,
}

/// 扫描进度。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub dirs_visited: u64,
    pub current: String,
}

// ── 扫描 ────────────────────────────────────────────────────────────────

/// 扫描时的"客气程度"。
///
/// ★ 这个区分是**实测逼出来的**：同一个 `%TEMP%`（6.6 万个文件、约 19 GB），
/// `Background` 要 **127 秒**，`BelowNormal` 只要 **7.6 秒** —— 16 倍差距。
/// `THREAD_MODE_BACKGROUND_BEGIN` 会把 IO 优先级压到"仅在系统空闲时"，在真实负载下
/// 几乎拿不到磁盘时间片；照 §8.2 的字面要求直接用它，扫描会慢到没法用
/// （整个 C 盘要按小时计）。
///
/// 所以：用户主动点的扫描用 `BelowNormal`（确实低，但**会推进**）；
/// 无人值守的周期性扫描用 `Background`（慢无所谓，反正没人等）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Politeness {
    /// 低于正常优先级。用户主动发起的扫描用这个。
    BelowNormal,
    /// 后台模式（最低 IO 优先级）。无人值守的任务用这个。
    Background,
}

/// 按 `politeness` 调整当前线程优先级，返回还原守卫。
///
/// 失败不影响功能（有些受限环境不允许改优先级）。
fn apply_priority(politeness: Politeness) -> Option<PriorityGuard> {
    let thread = unsafe { GetCurrentThread() };
    let mode = match politeness {
        Politeness::BelowNormal => THREAD_PRIORITY_BELOW_NORMAL,
        Politeness::Background => THREAD_MODE_BACKGROUND_BEGIN,
    };
    match unsafe { SetThreadPriority(thread, mode) } {
        Ok(()) => Some(PriorityGuard { thread, mode }),
        Err(_) => None,
    }
}

struct PriorityGuard {
    thread: HANDLE,
    mode: THREAD_PRIORITY,
}

impl Drop for PriorityGuard {
    fn drop(&mut self) {
        // 必须还原：这个线程来自 tokio 的阻塞线程池，下一份任务还会复用它
        let restore = if self.mode == THREAD_MODE_BACKGROUND_BEGIN {
            THREAD_MODE_BACKGROUND_END
        } else {
            THREAD_PRIORITY_NORMAL
        };
        let _ = unsafe { SetThreadPriority(self.thread, restore) };
    }
}

/// 扫描一个卷，产出快照。只读。
///
/// 取消时返回 `Ok(None)`：**半份快照不落盘** —— 拿它算增量会得出错误结论，
/// 而错误结论比没有结论更糟。
pub fn take_snapshot(
    volume: &str,
    report_depth: usize,
    politeness: Politeness,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(ScanProgress),
) -> Result<Option<Snapshot>, String> {
    let profile = SafetyProfile::global().map_err(|e| e.to_string())?;
    let root = PathBuf::from(volume);
    let stat =
        safety::stat(&root).map_err(|code| format!("无法读取 {volume}（Win32 错误 {code}）"))?;
    if !stat.is_dir() {
        return Err(format!("{volume} 不是目录"));
    }
    let report_depth = report_depth.clamp(1, MAX_WALK_DEPTH - 1);

    let _priority = apply_priority(politeness);
    let mut walker = Walker {
        profile,
        report_depth,
        cancel,
        entries: Vec::new(),
        dirs_visited: 0,
        unreadable_dirs: 0,
        last_report: 0,
    };
    let root_total = walker.walk(&root, 0, on_progress);

    if cancel.load(Ordering::Relaxed) {
        return Ok(None);
    }
    Ok(Some(Snapshot {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        taken_at: chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        volume: volume.to_string(),
        report_depth,
        entries: walker.entries,
        unreadable_dirs: walker.unreadable_dirs,
        // 根自身的合计单独存：`entries` 里不含根（否则排名会被根一条全吞掉）。
        // ⚠️ 这是**可清理部分**的合计，不含红线目录（见 `Snapshot::root_bytes` 的说明）
        root_bytes: root_total.bytes,
        root_files: root_total.files,
    }))
}

struct Walker<'a> {
    profile: &'a SafetyProfile,
    report_depth: usize,
    cancel: &'a AtomicBool,
    entries: Vec<DirEntryStat>,
    dirs_visited: u64,
    unreadable_dirs: u64,
    last_report: u64,
}

/// 一棵子树的汇总。
#[derive(Default, Clone, Copy)]
struct Subtree {
    bytes: u64,
    files: u64,
    newest_mtime: u64,
}

impl Walker<'_> {
    /// 返回这棵子树的**完整**汇总。
    ///
    /// 只有 `depth > report_depth` 的目录不进 `entries`，但它们的内容照常计入祖先 ——
    /// 否则浅层目录的大小就是错的（见模块头的偏差说明）。
    fn walk(
        &mut self,
        dir: &Path,
        depth: usize,
        on_progress: &mut dyn FnMut(ScanProgress),
    ) -> Subtree {
        let mut total = Subtree::default();
        if self.cancel.load(Ordering::Relaxed) {
            return total;
        }
        self.dirs_visited += 1;
        // 每访问 256 个目录上报一次：比按时间判断便宜，也不会把 IPC 打爆
        if self.dirs_visited - self.last_report >= 256 {
            self.last_report = self.dirs_visited;
            on_progress(ScanProgress {
                dirs_visited: self.dirs_visited,
                current: dir.display().to_string(),
            });
        }

        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => {
                // 不可读（权限、目录已消失）不该中断整棵树，也不该被当成 0 字节悄悄算进去
                self.unreadable_dirs += 1;
                return total;
            }
        };

        for entry in entries.flatten() {
            if self.cancel.load(Ordering::Relaxed) {
                return total;
            }
            let path = entry.path();
            // 属性一律重查：枚举器缓存的数据在 Windows 上不可靠（与删除引擎同一条纪律）
            let Ok(st) = safety::stat(&path) else {
                self.unreadable_dirs += 1;
                continue;
            };
            if st.is_reparse_point() {
                // ★ 不进入链接（I4）。链接本身记 0 字节：它的"大小"是目标的大小，
                //   算进来会让所有祖先的账目虚高。
                continue;
            }
            if st.is_dir() {
                if depth + 1 < MAX_WALK_DEPTH && !self.is_skipped(&path) {
                    let sub = self.walk(&path, depth + 1, on_progress);
                    total.bytes += sub.bytes;
                    total.files += sub.files;
                    total.newest_mtime = total.newest_mtime.max(sub.newest_mtime);
                }
                // 目录自身的时间也算：一个刚被写过文件的目录，mtime 是新的
                total.newest_mtime = total.newest_mtime.max(st.last_write);
            } else {
                total.bytes += st.size;
                total.files += 1;
                total.newest_mtime = total.newest_mtime.max(st.last_write);
            }
        }

        if depth >= 1 && depth <= self.report_depth {
            self.entries.push(DirEntryStat {
                path: dir.display().to_string(),
                bytes: total.bytes,
                files: total.files,
                newest_mtime: total.newest_mtime,
                depth,
            });
        }
        total
    }

    /// 红线目录直接跳过：清不了，扫它只是白白耗时（§8.2）。
    fn is_skipped(&self, path: &Path) -> bool {
        self.profile.check_red_lines(path).is_err()
    }
}

// ── 快照存取 ────────────────────────────────────────────────────────────

pub fn snapshot_dir() -> PathBuf {
    audit::app_data_dir().join("cleanup-snapshots")
}

/// `C:\` → `C-<hash>`。只保留字母数字（避免盘符里的字符变成路径片段），
/// 再缀一段原串的短哈希。
///
/// ★ **只留字母数字会撞车。** 监视目标不止卷根 —— `add_watch_target` 允许用户挑任意
/// 目录，于是 `D:\Games` 与 `D:\Gam es` 都压成 `DGames`，两个不同的目录**共用一份
/// 快照历史**。后果不是"少报"，而是拿 A 的体积减 B 的体积得出一个纯粹的假数字，
/// 再拿它去判断"谁在失控"。哈希把不同目标分开；长度也截断，避免超长监视目录
/// 顶到文件名的长度上限。
fn volume_tag(volume: &str) -> String {
    let head: String = volume
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(32)
        .collect();
    // FNV-1a：只为了打散，不需要密码学强度
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in volume.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let tail = format!("{:08x}", (hash >> 32) as u32);
    if head.is_empty() {
        tail
    } else {
        format!("{head}-{tail}")
    }
}

fn snapshot_path(volume: &str, taken_at: &str) -> PathBuf {
    let stamp: String = taken_at.chars().filter(|c| c.is_ascii_digit()).collect();
    snapshot_dir().join(format!("{}-{}.json", volume_tag(volume), stamp))
}

pub fn save(snapshot: &Snapshot) -> Result<(), String> {
    let dir = snapshot_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建快照目录失败：{e}"))?;
    let path = snapshot_path(&snapshot.volume, &snapshot.taken_at);
    let text = serde_json::to_string(snapshot).map_err(|e| format!("序列化快照失败：{e}"))?;
    fs::write(&path, text).map_err(|e| format!("写入快照失败：{e}"))?;
    prune(&snapshot.volume);
    Ok(())
}

/// 某个卷的快照文件，**新的在前**。
fn list_files(volume: &str) -> Vec<PathBuf> {
    let prefix = format!("{}-", volume_tag(volume));
    let Ok(entries) = fs::read_dir(snapshot_dir()) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().starts_with(&prefix))
                .unwrap_or(false)
                && path.extension().is_some_and(|ext| ext == "json")
        })
        .collect();
    // 文件名里的时间戳是定长数字，字典序即时间序
    out.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    out
}

fn read_snapshot(path: &Path) -> Option<Snapshot> {
    let text = fs::read_to_string(path).ok()?;
    let snapshot: Snapshot = serde_json::from_str(&text).ok()?;
    // 版本不认识就当作没有：宁可重扫一次，也不拿语义不同的旧数据算增量
    (snapshot.schema_version == SNAPSHOT_SCHEMA_VERSION).then_some(snapshot)
}

pub fn load_recent(volume: &str, limit: usize) -> Vec<Snapshot> {
    list_files(volume)
        .into_iter()
        .filter_map(|path| read_snapshot(&path))
        .take(limit)
        .collect()
}

/// 最近一次快照的时间（展示用）。
pub fn last_taken_at(volume: &str) -> Option<String> {
    load_recent(volume, 1).into_iter().next().map(|s| s.taken_at)
}

/// 保留最近 `SNAPSHOT_KEEP` 份，多余的删掉。
pub fn prune(volume: &str) {
    for path in list_files(volume).into_iter().skip(SNAPSHOT_KEEP) {
        let _ = fs::remove_file(path);
    }
}

/// 快照之间**至少**要隔这么多天，增量才值得算。
///
/// 低于这个间隔的"增长"是噪声：两小时内长了 500 MB 只说明机器刚干了点什么，
/// 不说明这个目录在失控。间隔不足时一律回 `None` —— `None` 在界面上有明确定义
/// （"还看不出增长，过一天再扫一次"），比一个会被读成结论的假数字好。
pub const MIN_BASELINE_DAYS: i64 = 1;

/// 找一个**至少 `min_age_days` 天前**的基准快照；没有更老的就退回**最老的那份**。
///
/// 返回 `(快照, 实际间隔天数)` —— 间隔要如实报出来：只有 2 天的历史就得说"2 天内"，
/// 不能一律说成"7 天增长"（与 §17 验收第 14 条同一条原则）。
///
/// ★ 回退必须退到**最老**那份，不是最新那份。`load_recent` 是从新到旧，原来的实现取
/// "第一个见到的"（= 最新的一份），等于把 `min_age_days` 整个绕过：三分钟前刚扫过一次，
/// 就会拿三分钟前的快照报"0 天里长了 500 MB"。退到最老那份得到的是**能给出的最长窗口**，
/// 再由 `MIN_BASELINE_DAYS` 兜住"连一天都不到"的情况。
pub fn find_baseline(volume: &str, min_age_days: u32) -> Option<(Snapshot, i64)> {
    let history = load_recent(volume, SNAPSHOT_KEEP);
    pick_baseline(&history, chrono::Local::now(), min_age_days)
}

/// [`find_baseline`] 的纯函数版：从**从新到旧**的快照序列里挑基准。
///
/// 抽出来是为了能单测 —— 上面那个要从磁盘读，而"挑哪一份"恰恰是最容易挑错的一步
/// （原来就挑成了最新那份）。
pub(crate) fn pick_baseline(
    history: &[Snapshot],
    now: chrono::DateTime<chrono::Local>,
    min_age_days: u32,
) -> Option<(Snapshot, i64)> {
    let mut oldest: Option<(Snapshot, i64)> = None;
    for snapshot in history {
        let Ok(taken) = chrono::DateTime::parse_from_rfc3339(&snapshot.taken_at) else {
            continue;
        };
        let days = (now - taken.with_timezone(&chrono::Local)).num_days();
        // ★ 下限对**两条**返回路径都成立。只在回退分支上卡 `MIN_BASELINE_DAYS`
        //   的话，任何传 `min_age_days = 0` 的调用方（这两个函数都是 pub）就能拿到
        //   三分钟前的快照当基准，报出"0 天里长了 500 MB"。
        if days >= min_age_days as i64 && days >= MIN_BASELINE_DAYS {
            // 从新到旧遍历，第一个满足的就是"最接近 min_age_days 的那份"
            return Some((snapshot.clone(), days));
        }
        // 一直覆盖 → 循环结束时留下的正是**最老**的那份
        oldest = Some((snapshot.clone(), days));
    }
    oldest.filter(|(_, days)| *days >= MIN_BASELINE_DAYS)
}

// ── 排名 ────────────────────────────────────────────────────────────────

/// 一个候选的发现结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDir {
    /// 后端签发的 `discovery_id`。**清理只认它**（I1）。签发失败时为 `None`，
    /// 此时前端必须禁用「放入隔离区」而不是退回用路径。
    pub id: Option<String>,
    pub path: String,
    pub bytes: u64,
    pub files: u64,
    /// 相对基准快照的增量。`None` = 没有可用的历史快照，**不代表没有增长**。
    pub delta_bytes: Option<i64>,
    /// 增量的实际间隔天数（与 `delta_bytes` 同时出现）
    pub delta_days: Option<i64>,
    /// 命中用户数据 KnownFolder：这类目录只能隔离，且要多一次确认
    pub is_user_data: bool,
    /// 有没有"比基准更新"的内容（用于提示"里面还有东西在用"）
    pub newest_mtime: u64,
}

/// 大小写不敏感、按**组件边界**判断 `path` 是否在 `ancestor` 之下。
///
/// 字符串前缀会把 `C:\Users2` 当成 `C:\Users` 的后代。
///
/// ★ 全程按**字节**比较，不用 `str::split_at`：那个函数在非字符边界会 panic，
/// 而这里的输入是用户磁盘上的路径（可能有中文、emoji）。实测复现过：
/// 同一份快照里任意两条路径长度对齐就会命中，**两者不需要有祖先关系** ——
/// 第一次扫描时增长榜按路径字典序取前 40 条，中文目录必然混在其中。
pub fn is_descendant(path: &str, ancestor: &str) -> bool {
    let path = path.replace('/', "\\");
    let ancestor = ancestor.replace('/', "\\");
    let trimmed = ancestor.trim_end_matches('\\');
    let candidate = path.as_bytes();
    let prefix = trimmed.as_bytes();
    if candidate.len() <= prefix.len() {
        return false;
    }
    candidate[..prefix.len()].eq_ignore_ascii_case(prefix) && candidate[prefix.len()] == b'\\'
}

/// 从当前快照与基准快照算出候选清单。
///
/// **先按增长排、再按占用排，并且两个榜单合起来去嵌套**：
/// - 先增长：正在失控的目录才是需要处理的（§8.4）；
/// - 去嵌套：`C:\Users` 与 `C:\Users\me\AppData\Local` 会同时挤进榜单，
///   把真正不同的发现顶掉。
pub fn rank(
    current: &Snapshot,
    baseline: Option<&(Snapshot, i64)>,
    limit: usize,
) -> Vec<DiscoveredDir> {
    // ★ 键必须**大小写不敏感**。Windows 路径本来就不区分大小写，而这里是在拿
    //   "这一次扫描写出来的字符串"去查"上一次扫描写出来的字符串"：只要两轮的路径
    //   大小写形态不同（换了个入口、别处规范化过、卷挂载点被改过），查不到就是
    //   `delta_bytes: None`，那个目录于是从增长榜上**静默消失** —— 看着像"它没长"。
    let baseline_entries: std::collections::HashMap<String, &DirEntryStat> = baseline
        .map(|(snapshot, _)| {
            snapshot
                .entries
                .iter()
                .map(|entry| (entry.path.to_lowercase(), entry))
                .collect()
        })
        .unwrap_or_default();
    let gap_days = baseline.map(|(_, days)| *days);

    let all: Vec<DiscoveredDir> = current
        .entries
        .iter()
        .map(|entry| DiscoveredDir {
            id: None,
            path: entry.path.clone(),
            bytes: entry.bytes,
            files: entry.files,
            delta_bytes: baseline_entries
                .get(&entry.path.to_lowercase())
                .map(|before| entry.bytes as i64 - before.bytes as i64),
            delta_days: gap_days,
            is_user_data: super::is_user_data_path(Path::new(&entry.path)),
            newest_mtime: entry.newest_mtime,
        })
        .collect();

    let mut chosen: Vec<DiscoveredDir> = Vec::new();
    let push = |candidate: &DiscoveredDir, chosen: &mut Vec<DiscoveredDir>| {
        // 与已入选的任何一条「就是它」或「互为祖先/后代」都不再单独列出。
        // 相等这一条不能省：两轮排序会把同一条目各推一次，榜单里于是出现重复行。
        let overlaps = chosen.iter().any(|kept| {
            kept.path.eq_ignore_ascii_case(&candidate.path)
                || is_descendant(&candidate.path, &kept.path)
                || is_descendant(&kept.path, &candidate.path)
        });
        if !overlaps {
            chosen.push(candidate.clone());
        }
    };

    for candidate in top_by(&all, limit, |d| {
        // 主键是增量，次键是体积：**没有基准时增量全是 0**，只按增量排等于没排，
        // 于是去嵌套会按"谁先被遍历到"决定留父还是留子，把 900 字节的父目录
        // 输给 800 字节的子目录。次键让这时的排序仍然有意义。
        (d.delta_bytes.unwrap_or(0).max(0), d.bytes as i64)
    }) {
        push(candidate, &mut chosen);
    }
    for candidate in top_by(&all, limit, |d| (d.bytes as i64, 0)) {
        push(candidate, &mut chosen);
    }
    chosen.truncate(MAX_DISCOVERY_IDS);
    chosen
}

/// 取前 N 个（按 `key` 的两级降序；两级都同分时**深的在前**）。不做去嵌套 ——
/// 由调用方统一处理。
///
/// ★ 全同分（两级键都相等）时为什么要深的在前：去嵌套是"先入选者留下"，而父子两级的
/// 字节数**相等**意味着父目录的全部内容就是那个子目录 —— 这时列子目录信息量完全一样、
/// 还更具体，列父目录只会让用户多点开一层。按路径字典序排的话恰好是反的
/// （`Q:\outer` < `Q:\outer\inner`），所以必须显式按深度排。
fn top_by(
    entries: &[DiscoveredDir],
    limit: usize,
    key: impl Fn(&DiscoveredDir) -> (i64, i64),
) -> Vec<&DiscoveredDir> {
    let mut sorted: Vec<&DiscoveredDir> = entries.iter().collect();
    sorted.sort_by(|a, b| {
        let (a1, a2) = key(a);
        let (b1, b2) = key(b);
        b1.cmp(&a1)
            .then_with(|| b2.cmp(&a2))
            .then_with(|| path_depth(&b.path).cmp(&path_depth(&a.path)))
            .then_with(|| a.path.cmp(&b.path))
    });
    sorted.truncate(limit);
    sorted
}

/// 路径层数。只看分隔符个数 —— 不需要真的解析路径，只用来给同分的两条排序。
fn path_depth(path: &str) -> usize {
    path.chars().filter(|c| *c == '\\' || *c == '/').count()
}

/// 用例在 `discover/discover_test.rs`：本文件通篇是生产代码，
/// 源码守卫可以整文件扫描而不必按 `#[cfg(test)]` 截断。
#[cfg(test)]
mod discover_test;
