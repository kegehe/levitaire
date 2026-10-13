//! 审计日志（I8，§12）。
//!
//! # 为什么是安全机制而不是附加功能
//!
//! "能精确说出我删了什么、跳过了什么、为什么跳过"是这类工具**唯一的自证手段**，
//! 也是出事后的取证依据。它必须从第一个可交付版本就存在。
//!
//! # 隐私边界（§12.3）
//!
//! - 日志记录的是**用户文件系统路径全文**，属隐私数据；
//! - **纯本地存储**，位于 `%APPDATA%\levitaire\cleanup-audit\`；
//! - **绝不上传** —— 不上报、不遥测、不随崩溃报告或更新检查携带；
//! - 只有用户显式点击"导出"才会离开本机；
//! - 提供一键清空，且到期自动删除（90 天 / 最近 100 次），不让它长期累积成隐私面。
//!
//! 日志目录与 `config.json` 同处 `%APPDATA%\levitaire\`（项目既有约定，见
//! `config::ConfigManager::get_config_path`）—— 方案文档写的是 `com.levitaire.app`，
//! 实施时按项目既有目录统一，避免同一份用户数据散在两个根下。

use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::delete::{Action, DeleteRecord, Reason};
use super::scan::{JobTotals, RuleReport};

/// 保留期（天）
pub const RETENTION_DAYS: i64 = 90;
/// 保留次数
pub const RETENTION_JOBS: usize = 100;

/// `%APPDATA%\levitaire`
pub fn app_data_dir() -> PathBuf {
    // 用例一律落在**进程独立的临时根**：审计日志与快照都是真的写盘，
    // 不隔离就会往用户真实的 `%APPDATA%\levitaire` 里写东西 ——
    // 那也是快照存取一直没有用例的原因（不敢测）。
    #[cfg(test)]
    {
        return TEST_DATA_ROOT.with(|slot| {
            // ★ 先把已有的取出来再决定要不要写：`slot.borrow()` 的临时量会活到**整条语句**
            //   结束，写成 `slot.borrow().clone().unwrap_or_else(|| slot.borrow_mut()...)`
            //   会在闭包里撞上"已经借出去了"，直接 panic。
            if let Some(root) = slot.borrow().as_ref() {
                return root.clone();
            }
            let root = std::env::temp_dir().join(format!(
                "levitaire-appdata-test-{}-{}",
                std::process::id(),
                TEST_DATA_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            let _ = std::fs::create_dir_all(&root);
            *slot.borrow_mut() = Some(root.clone());
            root
        });
    }
    #[cfg(not(test))]
    {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("levitaire")
    }
}

#[cfg(test)]
thread_local! {
    static TEST_DATA_ROOT: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
static TEST_DATA_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 审计日志目录
pub fn audit_dir() -> PathBuf {
    app_data_dir().join("cleanup-audit")
}

/// job id 只允许纯数字（时间戳）。**这不是格式洁癖，是路径穿越防线**：
/// `read_job` / `clear_job` 的入参来自前端，若允许任意字符串，
/// `../../config.json` 就能被读出来。
fn is_valid_job_id(job_id: &str) -> bool {
    !job_id.is_empty() && job_id.len() <= 20 && job_id.chars().all(|c| c.is_ascii_digit())
}

/// 新建一个 job id：毫秒时间戳 + 进程内序号，定长 16 位（字典序即时间序）。
///
/// 序号不是装饰：I9 保证同一时刻只有一个任务，但 `new_job_id` 是公开函数，
/// 单元测试与将来的"预生成 id"都会快速连调 —— 纯毫秒时间戳会撞车，而撞车意味着
/// 两次任务的审计日志写进同一个文件，取证时无法区分。
pub fn new_job_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed) % 1000;
    format!("{millis:013}{seq:03}")
}

fn now_ts() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// ── 日志行 ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AuditLine {
    /// 任务开始
    Header {
        ts: String,
        job_id: String,
        rule_ids: Vec<String>,
    },
    /// 一条删除动作（含跳过与失败）
    Entry {
        ts: String,
        rule_id: String,
        action: Action,
        path: String,
        bytes: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<Reason>,
    },
    /// 任务结束
    Summary {
        ts: String,
        job_id: String,
        totals: JobTotals,
        per_rule: Vec<RuleReport>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditJobInfo {
    pub job_id: String,
    pub modified_at: String,
    pub size_bytes: u64,
}

// ── 写入 ────────────────────────────────────────────────────────────────

/// 一次任务的审计写入器。
///
/// 逐条规则 flush 一次：`%TEMP%` 动辄上万条，全部攒在内存里等任务结束再写，
/// 既没必要（明细本来就是顺序流），也意味着中途崩溃会丢掉整份取证依据。
pub struct AuditWriter {
    writer: Option<BufWriter<File>>,
    job_id: String,
}

impl AuditWriter {
    pub fn begin(job_id: &str, rule_ids: &[String]) -> Result<Self, String> {
        if !is_valid_job_id(job_id) {
            return Err(format!("非法的任务 id：{job_id}"));
        }
        let dir = audit_dir();
        fs::create_dir_all(&dir).map_err(|e| format!("创建审计日志目录失败：{e}"))?;
        let path = dir.join(format!("{job_id}.jsonl"));
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("打开审计日志失败：{e}"))?;
        let mut writer = Self {
            writer: Some(BufWriter::new(file)),
            job_id: job_id.to_string(),
        };
        writer.line(&AuditLine::Header {
            ts: now_ts(),
            job_id: job_id.to_string(),
            rule_ids: rule_ids.to_vec(),
        })?;
        Ok(writer)
    }

    /// 一条规则的明细：先写记录，再写该规则的汇总。
    pub fn write_rule(&mut self, report: &RuleReport, records: &[DeleteRecord]) -> Result<(), String> {
        let ts = now_ts();
        for record in records {
            self.line(&AuditLine::Entry {
                ts: ts.clone(),
                rule_id: report.rule_id.clone(),
                action: record.action,
                path: record.path.clone(),
                bytes: record.bytes,
                reason: record.reason.clone(),
            })?;
        }
        // 该规则的汇总也留一行，便于按规则筛选时不重新聚合
        self.line(&AuditLine::Entry {
            ts,
            rule_id: report.rule_id.clone(),
            action: Action::Skipped,
            path: format!("<rule-summary:{}>", report.rule_name),
            bytes: report.bytes_deleted + report.bytes_quarantined,
            reason: None,
        })?;
        self.flush()
    }

    pub fn finish(&mut self, totals: &JobTotals, reports: &[RuleReport]) -> Result<(), String> {
        self.line(&AuditLine::Summary {
            ts: now_ts(),
            job_id: self.job_id.clone(),
            totals: totals.clone(),
            per_rule: reports.to_vec(),
        })?;
        self.flush()
    }

    fn line(&mut self, line: &AuditLine) -> Result<(), String> {
        let Some(writer) = self.writer.as_mut() else {
            return Ok(());
        };
        let text = serde_json::to_string(line).map_err(|e| format!("序列化审计行失败：{e}"))?;
        writeln!(writer, "{text}").map_err(|e| format!("写审计日志失败：{e}"))
    }

    fn flush(&mut self) -> Result<(), String> {
        if let Some(writer) = self.writer.as_mut() {
            writer.flush().map_err(|e| format!("刷新审计日志失败：{e}"))?;
        }
        Ok(())
    }
}

impl Drop for AuditWriter {
    fn drop(&mut self) {
        let _ = self.flush();
    }
}

// ── 读取与管理 ──────────────────────────────────────────────────────────

pub fn list_jobs() -> Vec<AuditJobInfo> {
    let Ok(entries) = fs::read_dir(audit_dir()) else {
        return Vec::new();
    };
    let mut out: Vec<AuditJobInfo> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "jsonl") {
                return None;
            }
            let job_id = path.file_stem()?.to_string_lossy().to_string();
            if !is_valid_job_id(&job_id) {
                return None;
            }
            let meta = entry.metadata().ok()?;
            let modified = meta
                .modified()
                .ok()
                .map(|t| chrono::DateTime::<chrono::Local>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
                .unwrap_or_default();
            Some(AuditJobInfo {
                job_id,
                modified_at: modified,
                size_bytes: meta.len(),
            })
        })
        .collect();
    out.sort_by(|a, b| b.job_id.cmp(&a.job_id));
    out
}

/// 某次任务日志文件的路径。同样先校验 job id，不接受任何路径片段。
pub fn job_path(job_id: &str) -> Result<PathBuf, String> {
    if !is_valid_job_id(job_id) {
        return Err(format!("非法的任务 id：{job_id}"));
    }
    Ok(audit_dir().join(format!("{job_id}.jsonl")))
}

/// 读取一次任务的完整明细。`job_id` 已做纯数字校验，不接受任何路径片段。
pub fn read_job(job_id: &str) -> Result<Vec<AuditLine>, String> {
    if !is_valid_job_id(job_id) {
        return Err(format!("非法的任务 id：{job_id}"));
    }
    let path = audit_dir().join(format!("{job_id}.jsonl"));
    let text = fs::read_to_string(&path).map_err(|e| format!("读取审计日志失败：{e}"))?;
    let mut out = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<AuditLine>(line) {
            Ok(parsed) => out.push(parsed),
            // 单行损坏（例如断电写了半行）不该让整份日志不可读
            Err(e) => out.push(AuditLine::Entry {
                ts: String::new(),
                rule_id: format!("line-{}", index + 1),
                action: Action::Failed,
                path: format!("<无法解析的日志行：{e}>"),
                bytes: 0,
                reason: None,
            }),
        }
    }
    Ok(out)
}

/// 一键清空。设置页可见（§12.3）。
///
/// 返回**实际删掉的份数**，不是"尝试删的份数" —— 删不掉的不能在界面上算成删掉了。
/// 目录都读不出来时报错而不是返回 0：0 会被显示成"已清空 0 份"，
/// 而那和"日志还在，只是我没读到"是两回事。
pub fn clear_all() -> Result<u64, String> {
    let dir = audit_dir();
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        // 目录不存在 = 本来就没有日志（从没清理过），不是错误
        Err(_) if !dir.exists() => return Ok(0),
        Err(e) => return Err(format!("读取审计日志目录失败（{}）：{e}", dir.display())),
    };
    let mut removed = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "jsonl") && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// 到期清理：保留最近 `RETENTION_JOBS` 份、且不超过 `RETENTION_DAYS` 天。
pub fn prune() {
    let jobs = list_jobs();
    let cutoff = chrono::Local::now() - chrono::Duration::days(RETENTION_DAYS);
    for (index, job) in jobs.iter().enumerate() {
        let too_many = index >= RETENTION_JOBS;
        let too_old = chrono::DateTime::parse_from_rfc3339(&job.modified_at)
            .map(|t| t.with_timezone(&chrono::Local) < cutoff)
            .unwrap_or(false);
        if too_many || too_old {
            let _ = fs::remove_file(audit_dir().join(format!("{}.jsonl", job.job_id)));
        }
    }
}
