//! 隔离区（§10）：把"不确定该不该删"的东西先搬走，而不是直接销毁。
//!
//! # 布局
//!
//! ```text
//! %APPDATA%\levitaire\quarantine\<jobId>\
//!   ├─ manifest.json      # [{ id, originalPath, size, movedAt, source, isUserData }]
//!   └─ <序号>             # 按序号存放的文件/目录
//! ```
//!
//! # 两条硬约束
//!
//! 1. **同卷 move 优先**（元数据操作，秒级、原子）。同卷判定必须拿**目标实际所在卷**与
//!    隔离区所在卷比较，不能假设目标是系统盘。
//! 2. **绝不出现"源已删、副本不完整"**：跨卷复制必须校验（字节数 + 文件数），
//!    校验失败就把副本删掉、源原样留着。
//!
//! # 前端只看 id
//!
//! `id` 是 `<jobId>-<序号>`，两段都必须是纯数字。恢复与彻底删除**只接受 id**，
//! 由后端查 manifest 还原路径 —— 与 `discovery_id` 同一套纪律（I1）。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND};

// 只在非 test 构建里用到（test 下 quarantine_dir 走临时根）
#[cfg_attr(test, allow(unused_imports))]
use super::audit;
use super::delete::{purge_contents, DeleteCtx};
use super::safety;
use super::safety::{stat, volume_root};

/// 隔离区默认保留期（天）。0 表示**不自动清理**（由用户显式彻底删除；用户数据条目
/// 在任何保留期下都只能隔离，§10.1）。
pub const DEFAULT_RETENTION_DAYS: u32 = 7;

/// 可选的保留期档位（设置页用）。
pub const RETENTION_CHOICES: &[u32] = &[0, 7, 14, 30];

/// 隔离根目录：`%APPDATA%\levitaire\quarantine`。
///
/// 用例下（`#[cfg(test)]`）它指向一个**每线程独立**的临时目录：隔离区会真的搬运目录，
/// 用例绝不能往用户的隔离区里写东西；而且每个用例独占一个根，`purge_all` /
/// `purge_expired` 这类全局操作就不会去删别的用例正在用的东西
/// （共用根时实测出现过偶发的 `ERROR_ACCESS_DENIED`，甚至删掉别的用例的条目）。
/// 测试框架给每个用例一个独立线程，线程局部量正好按用例隔离。
pub fn quarantine_dir() -> PathBuf {
    #[cfg(test)]
    {
        return TEST_ROOT.with(|slot| {
            if let Some(root) = slot.borrow().as_ref() {
                return root.clone();
            }
            let root = std::env::temp_dir().join(format!(
                "levitaire-quarantine-test-{}-{}",
                std::process::id(),
                TEST_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            let _ = std::fs::create_dir_all(&root);
            *slot.borrow_mut() = Some(root.clone());
            root
        });
    }
    #[cfg(not(test))]
    {
        audit::app_data_dir().join("quarantine")
    }
}

#[cfg(test)]
thread_local! {
    static TEST_ROOT: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
static TEST_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 从隔离区 id 还原 `(jobId, 序号)`。**两段都必须是纯数字** ——
/// 这是防止"用 id 拼出一条能穿越目录的路径"的唯一防线。
fn parse_entry_id(entry_id: &str) -> Option<(String, u32)> {
    let (job, seq) = entry_id.split_once('-')?;
    if job.is_empty() || job.len() > 20 || !job.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if seq.is_empty() || seq.len() > 9 || !seq.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((job.to_string(), seq.parse().ok()?))
}

// ── 数据模型 ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineEntry {
    pub id: String,
    pub job_id: String,
    pub seq: u32,
    /// 原位置。**仅供展示**；恢复只接受 `id`（后端查 manifest 还原）。
    pub original_path: String,
    pub size: u64,
    pub moved_at: String,
    /// `rule:<id>` 或 `manual`（用户手动挑的目录）
    pub source: String,
    /// 命中用户数据 KnownFolder。这类条目**即使保留期为 0 也必须先隔离**
    pub is_user_data: bool,
    pub is_dir: bool,
    /// 跨卷搬运时源没删干净：**副本是完整的**，但原位置还留着东西（只读或正被占用）。
    /// 恢复时要留意原位置可能已被占用。
    #[serde(default)]
    pub partial: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    #[serde(default)]
    entries: Vec<QuarantineEntry>,
}

fn manifest_path(job_dir: &Path) -> PathBuf {
    job_dir.join("manifest.json")
}

/// 读清单。
///
/// ★ 两种"读不到"必须分开对待，混为一谈的代价是**整个隔离区不可用**：
///
/// - **清单文件不存在** → 返回空清单。这只表示这个任务目录里没有登记过任何条目：
///   `begin` 建好目录后 `move_in` 就失败了、或空目录没删干净。这**不是错误** ——
///   `JobQuarantine::begin` 本来就是这么理解的（"第一次用这个 job"）。
///   如果这里报错，一个残留空目录就会让 `list()` 整体失败：隔离区里所有条目
///   **既看不到也恢复不了**，而且 `purge_expired` 会静默停止（它读不到清单就什么都不删），
///   隔离区只增不减，用户只能手工去删目录。
/// - **清单存在却读不出来 / 解析不了** → **必须报错**，绝不返回空清单：
///   那意味着内容还在磁盘上而我们认不出它，说"隔离区是空的"等于告诉用户东西没了。
fn read_manifest(job_dir: &Path) -> Result<Manifest, String> {
    let path = manifest_path(job_dir);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Manifest::default()),
        Err(e) => return Err(format!("读取隔离区清单失败（{}）：{e}", path.display())),
    };
    serde_json::from_str(&text).map_err(|e| {
        format!(
            "隔离区清单已损坏（{}）：{e}。里面的内容仍在磁盘上但无法自动识别 —— \
             请不要删这个目录，先找开发者。",
            path.display()
        )
    })
}

fn write_manifest(job_dir: &Path, manifest: &Manifest) -> Result<(), String> {
    let text =
        serde_json::to_string_pretty(manifest).map_err(|e| format!("序列化隔离区清单失败：{e}"))?;
    // ★ 原子写：先写临时文件再 rename。
    //
    // 直接截断重写的话，断电/崩溃/盘满会留下**半份 JSON**，而 `read_manifest` 解析失败时
    // 返回空清单 —— 那个 job 的**所有**条目就此从 `list()`/`find()` 里消失：
    // 内容还占着磁盘，用户却再也看不到、恢复不了（在他眼里就是文件丢了）。
    let tmp = job_dir.join("manifest.json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("写入隔离区清单失败：{e}"))?;
    fs::rename(&tmp, manifest_path(job_dir)).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("替换隔离区清单失败：{e}")
    })
}

// ── 一次任务的隔离区 ────────────────────────────────────────────────────

/// 打开一次任务的隔离区。条目**随移动即时落盘**：中途崩溃也不会出现
/// "文件已经不在原处、但清单里没记"的黑洞。
pub struct JobQuarantine {
    job_id: String,
    dir: PathBuf,
    manifest: Manifest,
    next_seq: u32,
    /// 本次实际隔离的字节数（用于空间账目）
    pub bytes: u64,
    pub count: u64,
}

impl JobQuarantine {
    pub fn begin(job_id: &str) -> Result<Self, String> {
        if !job_id.chars().all(|c| c.is_ascii_digit()) || job_id.is_empty() {
            return Err(format!("非法的任务 id：{job_id}"));
        }
        let dir = quarantine_dir().join(job_id);
        // 隔离区目录本身必须是普通目录：它若被换成重解析点，我们写进去的东西
        // 会落到别处，恢复时却按原路径找 —— 直接拒绝，不猜。
        if let Ok(st) = stat(&dir) {
            if st.is_reparse_point() || !st.is_dir() {
                return Err(format!(
                    "隔离区目录 {} 不是普通目录（疑似被重定向），已拒绝使用",
                    dir.display()
                ));
            }
        }
        fs::create_dir_all(&dir).map_err(|e| format!("创建隔离区目录失败：{e}"))?;
        // `read_manifest` 已经把"没有清单"当空清单（那才是"第一次用这个 job"的正解）。
        // 两处各写一遍判断曾经导致语义分叉：这里当空、`list()` 当硬错误 ——
        // 于是一个残留的空任务目录能让整个隔离区不可读。
        let manifest = read_manifest(&dir)?;
        let next_seq = manifest.entries.iter().map(|e| e.seq + 1).max().unwrap_or(0);
        Ok(Self {
            job_id: job_id.to_string(),
            dir,
            manifest,
            next_seq,
            bytes: 0,
            count: 0,
        })
    }

    /// 把一个条目移进隔离区。**只搬运，不判断该不该搬**（那是闸一/规则表的职责）。
    pub fn move_in(
        &mut self,
        src: &Path,
        source_label: &str,
        is_user_data: bool,
    ) -> Result<QuarantineEntry, String> {
        let st = stat(src).map_err(|code| format!("{} 无法读取（Win32 错误 {code}）", src.display()))?;
        let seq = self.next_seq;
        let dest = self.dir.join(seq.to_string());

        // 目标已存在就拒绝。Windows 的 `fs::rename` 会**静默替换**已存在的目标 ——
        // 清单一旦损坏让 `next_seq` 算回 0，旧内容就会被无声覆盖掉。
        if dest.exists() {
            return Err(format!(
                "隔离区内已存在序号 {} 的位置，拒绝覆盖（隔离区可能已损坏）",
                seq
            ));
        }

        // 条目大小必须在**搬走之前**量：`GetFileAttributesExW` 对目录返回的是目录索引大小
        // （实测：含 14 MB 内容的目录返回 0），拿它当大小会让"隔离区暂存"这个数字恒为 0，
        // 而磁盘上确实少了那么多字节 —— 数字与事实双向失信。
        let size = entry_size(src, &st)?;

        // 同卷优先：元数据操作，秒级、原子。同卷判定拿**实际卷根**比较。
        let same_volume = match (volume_root(src), volume_root(&self.dir)) {
            (Ok(a), Ok(b)) => super::safety::equal_ci(&a, &b),
            _ => false,
        };
        // 跨卷搬目录时源可能删不干净（只读/占用的文件按纪律跳过）。非零表示
        // "副本是完整的、但原位置还留着东西"。
        let mut partial = false;

        if same_volume {
            fs::rename(src, &dest).map_err(|e| {
                format!(
                    "把 {} 移入隔离区失败（同卷重命名）：{e}",
                    src.display()
                )
            })?;
        } else {
            // 跨卷：先复制校验，再删源。校验不过就把副本删掉、源原样留着。
            if tree_has_reparse_point(src)? {
                return Err(format!(
                    "{} 与隔离区不在同一个卷，且目录树里含链接：跨卷复制无法保证链接语义一致，已拒绝。",
                    src.display()
                ));
            }
            copy_tree(src, &dest).map_err(|e| format!("跨卷复制到隔离区失败：{e}"))?;
            // ★ 量副本这一步失败也必须回收副本。漏掉的话：副本留在隔离区里、
            //   而 `next_seq` 还没加 —— 下一次搬运复用同一个序号，撞上上面的
            //   `dest.exists()` 检查，之后**每一条**都报"隔离区可能已损坏"，
            //   真实原因只是上一轮留下的一个没人登记的副本。
            let dest_bytes = match tree_bytes(&dest) {
                Ok(bytes) => bytes,
                Err(error) => {
                    let _ = discard(&dest);
                    return Err(format!(
                        "跨卷复制后无法核对副本大小：{error}（已删除副本、原文件保持不动）"
                    ));
                }
            };
            if size != dest_bytes {
                let _ = discard(&dest);
                return Err(format!(
                    "跨卷复制校验失败（源 {size} 字节 / 副本 {dest_bytes} 字节）：\
                     已删除副本、原文件保持不动。"
                ));
            }
            // 删源：文件走 remove_file，目录才走删除引擎（`purge_contents` 对**文件**
            // 会以 os error 267「目录名称无效」失败 —— 那是它第一行 `read_dir` 的行为）。
            //
            // ★ 源**删不干净**时（只读文件按纪律跳过、文件正被占用）要"留副本 + 如实登记"，
            //   不能两件事都做错：既不留副本（内容只剩一份半毁的），又不登记（副本没人看得到）。
            //   副本是完整的，登记了就能恢复；原位置剩什么，由 `partial` 标注出来。
            if st.is_dir() {
                let mut ctx = DeleteCtx::new();
                if let Err(e) = purge_contents(src, &mut ctx) {
                    // 连枚举都失败：副本删掉、源原样留着（此时源还没被动过）
                    let _ = discard(&dest);
                    return Err(format!("删除源目录内容失败：{e}（已回滚，原位置未改动）"));
                }
                partial = fs::remove_dir(src).is_err();
            } else if let Err(e) = fs::remove_file(src) {
                let _ = discard(&dest);
                return Err(format!("删除源文件失败：{e}（已回滚，原文件未改动）"));
            }
        }

        self.next_seq += 1;
        self.bytes += size;
        self.count += 1;

        let entry = QuarantineEntry {
            id: format!("{}-{}", self.job_id, seq),
            job_id: self.job_id.clone(),
            seq,
            original_path: src.display().to_string(),
            size,
            moved_at: chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            source: source_label.to_string(),
            is_user_data,
            is_dir: st.is_dir(),
            partial,
        };
        self.manifest.entries.push(entry.clone());
        // ★ 清单写失败必须把条目从内存里撤掉：否则内存说有、磁盘上没有，
        //   下一次 `move_in` 会用一条不存在的记录去覆盖序号，`finish` 也会写出它。
        if let Err(error) = write_manifest(&self.dir, &self.manifest) {
            self.manifest.entries.pop();
            self.next_seq -= 1;
            self.bytes -= size;
            self.count -= 1;
            return Err(format!(
                "隔离区的清单写不进去（{error}）：内容已在隔离区目录里但未登记，\
                 请勿继续清理并检查磁盘空间。"
            ));
        }
        Ok(entry)
    }

    /// 收尾。没有任何条目时把空目录删掉，不留一地空壳。
    pub fn finish(self) -> Result<(), String> {
        if self.manifest.entries.is_empty() {
            drop_empty_job_dir(&self.dir);
            return Ok(());
        }
        write_manifest(&self.dir, &self.manifest)
    }
}

// ── 查询与管理 ──────────────────────────────────────────────────────────

/// 列出全部隔离条目（新的在前）。
///
/// **读不出来就报错**，不返回空表：空表在界面上就是"隔离区是空的 / 0 B"，
/// 而磁盘上可能躺着几个 GB —— 那正是这个功能最不该犯的错。
pub fn list() -> Result<Vec<QuarantineEntry>, String> {
    let dir = quarantine_dir();
    let jobs = match fs::read_dir(&dir) {
        Ok(jobs) => jobs,
        // 隔离区还不存在 = 真的没有条目（首次使用），这不是错误
        Err(_) if !dir.exists() => return Ok(Vec::new()),
        Err(e) => return Err(format!("读取隔离区目录失败（{}）：{e}", dir.display())),
    };
    let mut out = Vec::new();
    for job in jobs.flatten() {
        let path = job.path();
        if !path.is_dir() {
            continue;
        }
        out.extend(read_manifest(&path)?.entries);
    }
    out.sort_by(|a, b| b.moved_at.cmp(&a.moved_at));
    Ok(out)
}

/// `(总字节, 其中属于用户数据的字节)`。
///
/// 用户数据那部分是**永远不会**变成"立即释放"的：即使保留期设为 0，用户数据条目
/// 也必须先隔离（§10.1）。账目里把它单独列出来，用户才知道那部分为什么不动。
pub fn summary() -> Result<(u64, u64), String> {
    let entries = list()?;
    let total = entries.iter().map(|e| e.size).sum();
    let user_data = entries
        .iter()
        .filter(|e| e.is_user_data)
        .map(|e| e.size)
        .sum();
    Ok((total, user_data))
}

/// 找一个条目（**只按 id 查 manifest，绝不按 id 拼路径**）。
pub fn find(entry_id: &str) -> Result<Option<(PathBuf, QuarantineEntry)>, String> {
    let Some((job_id, seq)) = parse_entry_id(entry_id) else {
        return Ok(None);
    };
    let dir = quarantine_dir().join(&job_id);
    if !manifest_path(&dir).exists() {
        return Ok(None);
    }
    let entry = read_manifest(&dir)?
        .entries
        .into_iter()
        .find(|e| e.seq == seq);
    Ok(entry.map(|entry| (dir.join(seq.to_string()), entry)))
}

/// 把条目移回原位置。
///
/// **原位置已被占用时拒绝，绝不覆盖**（§10.1）——覆盖等于用一份可能过期的副本
/// 替换掉用户新建的东西。
pub fn restore(entry_id: &str) -> Result<QuarantineEntry, String> {
    let (stored, entry) = find(entry_id)?
        .ok_or_else(|| format!("隔离条目不存在：{entry_id}"))?;
    if !stored.exists() {
        return Err(format!(
            "隔离条目 {entry_id} 的内容已不在隔离区（可能已被清理）"
        ));
    }
    let original = PathBuf::from(&entry.original_path);

    // ★ 拿清单里的 original_path 当写入目标之前**过一遍闸一**。
    //   这条路径来自我们自己的 manifest，正常情况一定合格；但 manifest 是磁盘上的
    //   普通文件，手工改一条就能让"恢复"往任意可写位置写 —— 落盘路径一律过闸一，
    //   不给"只有这一处例外"留口子。
    let profile = safety::SafetyProfile::global().map_err(|e| e.to_string())?;
    profile.verify(&original).map_err(|e| {
        format!(
            "隔离条目记录的原始位置 {} 未通过安全校验（{e}），已拒绝恢复",
            original.display()
        )
    })?;

    if original.exists() {
        return Err(format!(
            "{} 已被占用，未做任何改动。请先移走那里的内容再恢复。",
            original.display()
        ));
    }
    if let Some(parent) = original.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 {} 失败：{e}", parent.display()))?;
    }

    let same_volume = match (volume_root(&stored), volume_root(&original)) {
        (Ok(a), Ok(b)) => super::safety::equal_ci(&a, &b),
        _ => false,
    };
    if same_volume {
        fs::rename(&stored, &original).map_err(|e| {
            format!(
                "恢复失败：把 {} 移回 {} 时出错：{e}",
                stored.display(),
                original.display()
            )
        })?;
    } else {
        // 跨卷恢复同样**必须先确认树里没有重解析点** —— `copy_tree` 会把链接指向的
        // 真实数据整棵抄进去（那是几十 GB 级的意外复制）。
        if tree_has_reparse_point(&stored)? {
            return Err("隔离内容里含链接，跨卷恢复无法保证链接语义一致，已拒绝".into());
        }
        let expected = tree_bytes(&stored)?;
        if let Err(error) = copy_tree(&stored, &original) {
            // 复制中途失败（盘满/读错）要回滚：否则原位置留下半棵树，
            // 用户重试只会撞"已被占用"，恢复动作就永久卡死了。
            return Err(rollback_message(&original, &format!("跨卷恢复复制失败：{error}")));
        }
        let copied = match tree_bytes(&original) {
            Ok(bytes) => bytes,
            Err(error) => {
                return Err(rollback_message(
                    &original,
                    &format!("跨卷恢复后无法核对副本大小：{error}"),
                ));
            }
        };
        if expected != copied {
            return Err(rollback_message(&original, "跨卷恢复校验失败"));
        }
        if let Err(error) = discard(&stored) {
            // 已经恢复到原位置了，但隔离区那份删不掉：两份并存。如实说清楚。
            return Err(format!(
                "内容已恢复到 {}，但隔离区里的副本删不掉（{error}）：现在两份都在，\
                 请手动确认后删除隔离区那份。",
                original.display()
            ));
        }
    }

    if let Err(error) = remove_from_manifest(&entry.job_id, entry.seq) {
        return Err(format!(
            "{} 已恢复成功，但隔离区清单没更新（{error}）—— 界面上可能还挂着这条记录，\
             点「彻底删除」会报「内容已不在隔离区」，那是正常的。",
            original.display()
        ));
    }
    Ok(entry)
}

/// 彻底删除一个隔离条目（用户主动）。
pub fn purge(entry_id: &str) -> Result<QuarantineEntry, String> {
    let (stored, entry) = find(entry_id)?
        .ok_or_else(|| format!("隔离条目不存在：{entry_id}"))?;
    // ★ 先删内容、**再**摘清单。反过来的话，删不掉时清单已经没了 ——
    //   内容还在磁盘上却谁也看不到（`list()` 里没有、`restore` 说"条目不存在"）。
    discard(&stored)?;
    remove_from_manifest(&entry.job_id, entry.seq)?;
    Ok(entry)
}

/// 清空整个隔离区。
///
/// **不再用 `remove_dir_all` 兜底**：那会把删不掉的内容、以及清单损坏（读不出来）的
/// 条目一起抹掉 —— 前者是"用户还能自己去看一眼"的东西，后者是"内容在但没人认得"的
/// 东西，两者都不该被这个动作顺手销毁。剩下的空壳目录由各条 `purge` 自己收。
pub fn purge_all() -> Result<u64, String> {
    let entries = list()?;
    let mut removed = 0u64;
    let mut problems: Vec<String> = Vec::new();
    for entry in entries {
        match purge(&entry.id) {
            Ok(_) => removed += 1,
            Err(error) => problems.push(error),
        }
    }
    // 顺手收掉"没有登记过任何条目"的空壳目录：`begin` 建好目录后 `move_in` 失败、
    // 或空目录没删干净都会留下它们。它们现在无害（`list()` 不会因它们失败），
    // 但一直堆着没有意义 —— 用户点「清空隔离区」就是想让隔离区干净。
    drop_unregistered_job_dirs();
    if !problems.is_empty() {
        return Err(format!(
            "清空了 {removed} 条，但有 {} 条没清掉：{}",
            problems.len(),
            problems.join("；")
        ));
    }
    Ok(removed)
}

/// 收掉所有"没有清单文件"的任务目录。只删清单文件与目录本身，**绝不递归** ——
/// 有内容的目录会因为非空而删不掉，那正是我们要的（内容不能被顺手销毁）。
fn drop_unregistered_job_dirs() {
    let dir = quarantine_dir();
    let Ok(jobs) = fs::read_dir(&dir) else {
        return;
    };
    for job in jobs.flatten() {
        let path = job.path();
        if path.is_dir() && !manifest_path(&path).exists() {
            drop_empty_job_dir(&path);
        }
    }
}

/// 到期自动清理。`retention_days == 0` 表示不自动清理（由用户显式彻底删除）。
pub fn purge_expired(retention_days: u32) -> u64 {
    if retention_days == 0 {
        return 0;
    }
    let cutoff = chrono::Local::now() - chrono::Duration::days(retention_days as i64);
    let Ok(entries) = list() else {
        // 清单读不出来时**什么都不删**：宁可留到下次，也不拿一份读不懂的清单去删文件
        return 0;
    };
    let mut removed = 0u64;
    for entry in entries {
        let expired = chrono::DateTime::parse_from_rfc3339(&entry.moved_at)
            .map(|t| t.with_timezone(&chrono::Local) < cutoff)
            .unwrap_or(false);
        if expired && purge(&entry.id).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn remove_from_manifest(job_id: &str, seq: u32) -> Result<(), String> {
    let dir = quarantine_dir().join(job_id);
    let mut manifest = read_manifest(&dir)?;
    manifest.entries.retain(|e| e.seq != seq);
    if manifest.entries.is_empty() {
        drop_empty_job_dir(&dir);
        return Ok(());
    }
    write_manifest(&dir, &manifest)
}

/// 摘掉一个已经空了的任务目录。
///
/// ★ **不用 `remove_dir_all`**：删除路径上禁止标准库的递归删除 —— 它的重解析点
/// 语义由标准库决定，而这是全项目最危险的一次调用，不能外包（同 `delete.rs`
/// 的纪律，守卫 `the_delete_path_never_spawns_a_process_or_uses_std_recursive_delete`）。
/// 这里只有我们自己的两个文件名，逐个精确删除，不递归。
///
/// 尽力而为：杀软 / 索引器正持有目录句柄时 `remove_dir` 会失败，留下一个空壳。
/// 那已经**无害**了 —— `read_manifest` 把"没有清单"当空清单，`list()` 不会因此失败。
fn drop_empty_job_dir(dir: &Path) {
    let _ = fs::remove_file(manifest_path(dir));
    let _ = fs::remove_file(dir.join("manifest.json.tmp"));
    let _ = fs::remove_dir(dir);
}

/// 回滚原位置上的半棵树，并给出一句**与事实相符**的话。
///
/// ★ 不能无脑说"已回滚"：`discard` 走的是同一套删除引擎，而它按纪律**跳过只读文件**
/// （§6.2），`purge_contents` 又总是返回 `Ok` —— 只要树里有一个只读文件，`remove_dir`
/// 就会以「目录非空」失败。而 `fs::copy` 是**保留只读属性**的，所以"复制到一半失败"
/// 留下的那半棵树里很可能就有只读文件。这时原位置并没有被清干净，用户却以为干净了、
/// 重试只会撞"已被占用"，恢复动作就永久卡死 —— 那句话必须把实情说出来。
fn rollback_message(original: &Path, what: &str) -> String {
    match discard(original) {
        Ok(()) => format!("{what}（已回滚，隔离区内容保持不动）"),
        Err(error) => format!(
            "{what}。回滚没能把 {} 清干净（{error}）：原位置可能留着半份内容，\
             请手动删掉它之后再重试恢复 —— 隔离区里的那份是完好的。",
            original.display()
        ),
    }
}

/// 删除隔离区里的一条内容。它是我们自己的目录，用同一套删除引擎（闸二/闸三）即可。
fn discard(path: &Path) -> Result<(), String> {
    let st = match stat(path) {
        Ok(st) => st,
        // ★ 只有"真的不存在"才等价于删除成功。`GetFileAttributesExW` 对**以不共享方式
        //   打开**的文件返回 ACCESS_DENIED —— 把它也当成"已经没了"的话，`purge` 会接着
        //   把清单条目摘掉：内容还在磁盘上，而用户再也看不到、恢复不了。
        Err(code)
            if code == ERROR_FILE_NOT_FOUND.0 || code == ERROR_PATH_NOT_FOUND.0 =>
        {
            return Ok(());
        }
        Err(code) => {
            return Err(format!(
                "{} 读不出来（Win32 错误 {code}），未做任何改动",
                path.display()
            ))
        }
    };
    if !st.is_dir() {
        return fs::remove_file(path).map_err(|e| format!("删除 {} 失败：{e}", path.display()));
    }
    let mut ctx = DeleteCtx::new();
    purge_contents(path, &mut ctx).map_err(|e| format!("清空 {} 失败：{e}", path.display()))?;
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        // 里面有删不掉的项（占用/只读），保留目录并如实报告
        Err(e) => Err(format!(
            "{} 未能完全删除（可能被占用）：{e}。目录已保留，未强删。",
            path.display()
        )),
    }
}

// ── 树遍历（不跟随重解析点）─────────────────────────────────────────────

/// 遍历的深度上限。
///
/// ★ 不是可选的：实测深度 600 左右就**栈溢出**，而 Rust 的栈溢出是 `abort()` ——
/// 不走 panic、不 unwind、整个进程消失。这几棵树来自用户磁盘（手工挑的目录、
/// 回收站里被删掉的深目录树），深度不可控。
///
/// 取值与删除引擎的 `MAX_DEPTH` 一致。触顶时的处置**全部是 fail-closed**：
/// 数不出来就拒绝搬运（而不是搬一半），查不完链接就当作有链接，看不完新旧就当作有新。
const MAX_TREE_DEPTH: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeError {
    /// 树太深（超过 [`MAX_TREE_DEPTH`]），无法安全处理
    TooDeep,
    /// 读不出来（权限、已消失）
    Unreadable,
}

impl std::fmt::Display for TreeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TreeError::TooDeep => write!(f, "目录树超过 {MAX_TREE_DEPTH} 层，无法安全处理"),
            TreeError::Unreadable => write!(f, "目录树读不出来（权限或已被删除）"),
        }
    }
}

impl From<TreeError> for String {
    fn from(error: TreeError) -> Self {
        error.to_string()
    }
}

/// 整棵树的字节数（不跟随重解析点；链接本身计入 0）。
///
/// 供隔离时给条目算大小 —— `GetFileAttributesExW` 对**目录**返回的是目录索引大小
/// （实测：含 14 MB 内容的目录返回 0），拿它当条目大小会让"隔离区暂存"这个数字
/// 恒为 0。
fn tree_bytes(root: &Path) -> Result<u64, TreeError> {
    tree_bytes_at(root, 0)
}

/// 一个条目的隔离尺寸。
///
/// **`move_in` 与"预览"共用这一份** —— 两处各写一份必然漂移，而漂移的表现是
/// "预览说 X 字节、执行后账目是 Y 字节"，正是这个工具最不能犯的账目失信。
///
/// 口径：目录取**整树**字节数（`GetFileAttributesExW` 对目录返回的是目录索引大小，
/// 实测含 14 MB 内容的目录返回 0，拿它当大小会让「隔离区暂存」恒为 0），
/// 文件取自身大小，重解析点计 0（搬的是链接本身，不是它指向的东西）。
pub(crate) fn entry_size(src: &Path, st: &safety::FileStat) -> Result<u64, TreeError> {
    if st.is_dir() {
        tree_bytes(src)
    } else {
        Ok(st.size)
    }
}

fn tree_bytes_at(root: &Path, depth: usize) -> Result<u64, TreeError> {
    if depth > MAX_TREE_DEPTH {
        return Err(TreeError::TooDeep);
    }
    let st = stat(root).map_err(|_| TreeError::Unreadable)?;
    if st.is_reparse_point() {
        return Ok(0);
    }
    if !st.is_dir() {
        return Ok(st.size);
    }
    let mut total = 0u64;
    let entries = fs::read_dir(root).map_err(|_| TreeError::Unreadable)?;
    for entry in entries.flatten() {
        total += tree_bytes_at(&entry.path(), depth + 1)?;
    }
    Ok(total)
}

/// 树里有没有重解析点。**读不完就当作有**（fail-closed：宁可拒绝搬运）。
fn tree_has_reparse_point(root: &Path) -> Result<bool, TreeError> {
    tree_has_reparse_point_at(root, 0)
}

fn tree_has_reparse_point_at(root: &Path, depth: usize) -> Result<bool, TreeError> {
    if depth > MAX_TREE_DEPTH {
        return Ok(true);
    }
    let st = stat(root).map_err(|_| TreeError::Unreadable)?;
    if st.is_reparse_point() {
        return Ok(true);
    }
    if !st.is_dir() {
        return Ok(false);
    }
    let entries = fs::read_dir(root).map_err(|_| TreeError::Unreadable)?;
    for entry in entries.flatten() {
        if tree_has_reparse_point_at(&entry.path(), depth + 1)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 复制一棵树。**只调用在已经确认"树里没有重解析点"之后** ——
/// 否则 `fs::copy` 会把链接指向的真实数据复制进来。
fn copy_tree(src: &Path, dest: &Path) -> Result<(), String> {
    copy_tree_at(src, dest, 0)
}

fn copy_tree_at(src: &Path, dest: &Path, depth: usize) -> Result<(), String> {
    if depth > MAX_TREE_DEPTH {
        return Err(format!(
            "目录树超过 {MAX_TREE_DEPTH} 层，拒绝复制（栈深度不够，硬来会崩进程）"
        ));
    }
    let st = stat(src).map_err(|code| format!("{} 无法读取（{code}）", src.display()))?;
    if st.is_dir() {
        fs::create_dir_all(dest).map_err(|e| format!("创建 {} 失败：{e}", dest.display()))?;
        let entries = fs::read_dir(src).map_err(|e| format!("枚举 {} 失败：{e}", src.display()))?;
        for entry in entries.flatten() {
            copy_tree_at(&entry.path(), &dest.join(entry.file_name()), depth + 1)?;
        }
        Ok(())
    } else {
        fs::copy(src, dest).map_err(|e| format!("复制 {} 失败：{e}", src.display()))?;
        Ok(())
    }
}

/// 目录里是否有"比截止线更新"的条目（不跟随重解析点）。
///
/// 用途：隔离一条**目录**时，若它内部还有够新的东西，就不能整个搬走 ——
/// 那会把用户正在用的文件一起挪掉。永久删除路径上是逐个文件判的，
/// 而隔离是整目录搬运，所以这里必须单独走一遍。
///
/// **读不完就当作"有新的"**（fail-closed：宁可不搬）。
pub fn has_entry_newer_than(root: &Path, cutoff: u64) -> bool {
    has_entry_newer_than_at(root, cutoff, 0)
}

fn has_entry_newer_than_at(root: &Path, cutoff: u64, depth: usize) -> bool {
    if depth > MAX_TREE_DEPTH {
        return true;
    }
    let Ok(st) = stat(root) else {
        return true; // 读不到就当作"有新的"，宁可不搬
    };
    if st.is_reparse_point() {
        return false; // 链接不承载数据，搬走它不涉及"新的东西"
    }
    if !st.is_dir() {
        return st.last_write >= cutoff;
    }
    if st.last_write >= cutoff {
        return true;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return true;
    };
    for entry in entries.flatten() {
        if has_entry_newer_than_at(&entry.path(), cutoff, depth + 1) {
            return true;
        }
    }
    false
}

/// 用例在 `quarantine/quarantine_test.rs`：全过程跑在临时目录上（隔离区会真的搬运目录，
/// 绝不能往用户的隔离区里写东西）。
#[cfg(test)]
mod quarantine_test;
