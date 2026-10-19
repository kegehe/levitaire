//! 规则 → 校验器 → 扫描/执行 → 报告 的端到端用例。
//!
//! 用**临时装置**而不是真实清理项：真实项（npm 缓存、go-build 之类）动辄几 GB，
//! 在测试里遍历一遍既慢又会把磁盘打个半死。这里要验的是管线本身，不是某个具体规则。
//!
//! 断言的口径是"删了什么、跳过了什么、为什么跳过"（I8），以及 dry-run 与执行
//! 走同一段代码时结论是否一致 —— 那正是这个工具输出的全部价值所在。

use super::*;
use crate::disk_cleanup::rules;
use crate::disk_cleanup::safety::SafetyProfile;
use crate::utils::process::hidden_command;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

struct Fixture {
    root: PathBuf,
    sentinel: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // 只读文件会挡住 remove_dir_all，先摘掉只读位
        let _ = clear_readonly(&self.root);
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn clear_readonly(dir: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)?.flatten() {
        let meta = entry.metadata()?;
        if meta.is_dir() {
            clear_readonly(&entry.path())?;
        } else if meta.permissions().readonly() {
            let mut perms = meta.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            fs::set_permissions(entry.path(), perms)?;
        }
    }
    Ok(())
}

/// 造一套装置：`target/`（要被处理）+ `sentinel/`（绝不能被碰的真数据），
/// 并在 `target/` 里放一个指向 sentinel 的 junction。
fn fixture(tag: &str) -> Fixture {
    let base = std::env::temp_dir().join(format!("levitaire-scan-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let target = base.join("target");
    let sentinel = base.join("sentinel");
    fs::create_dir_all(target.join("sub")).unwrap();
    fs::create_dir_all(&sentinel).unwrap();
    fs::write(sentinel.join("keep.txt"), "keep me").unwrap();
    fs::write(target.join("a.tmp"), "aaaa").unwrap();
    fs::write(target.join("b.tmp"), "bb").unwrap();
    fs::write(target.join("sub").join("c.tmp"), "ccc").unwrap();

    // junction 建不出来（权限）时用例降级，但要在输出里说清楚
    let made = hidden_command("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(target.join("link"))
        .arg(&sentinel)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false);
    assert!(made, "建 junction 失败，装置不完整");

    Fixture {
        root: base,
        sentinel,
    }
}

fn rule_json_for(target: &Path, older_than_days: Option<u32>) -> String {
    let strategy = match older_than_days {
        Some(days) => format!(r#"{{"kind":"purgeContents","olderThanDays":{days}}}"#),
        None => r#"{"kind":"purgeContents"}"#.to_string(),
    };
    let escaped = target.display().to_string().replace('\\', "\\\\");
    format!(
        r#"{{"schemaVersion":1,"rules":[{{"id":"fixture","name":"测试装置","group":"cache",
           "tier":"L1","target":{{"kind":"fixedPath","path":"{escaped}"}},
           "strategy":{strategy},"consequence":"测试用，作用于临时目录。"}}]}}"#
    )
}

fn load_fixture_rule(target: &Path, older_than_days: Option<u32>) -> rules::CleanRule {
    let profile = SafetyProfile::global().expect("派生安全档案失败");
    let parsed = rules::parse_and_validate(&rule_json_for(target, older_than_days), profile)
        .expect("装置规则没通过校验器");
    parsed.into_iter().next().unwrap()
}

/// 同一条装置规则，但改写成 `undo: quarantine` 的形态。
///
/// `group` 必须一起改成 `user-adjacent`：校验器禁止 cache 类声明可恢复
/// （缓存没必要留副本）。
fn load_quarantine_fixture_rule(target: &Path) -> rules::CleanRule {
    let json = rule_json_for(target, None)
        .replace(r#""group":"cache""#, r#""group":"user-adjacent""#)
        .replace(r#""consequence""#, r#""undo":"quarantine","consequence""#);
    let profile = SafetyProfile::global().expect("派生安全档案失败");
    let parsed = rules::parse_and_validate(&json, profile).expect("隔离规则的构造有问题");
    let rule = parsed.into_iter().next().unwrap();
    assert_eq!(
        rule.undo,
        crate::disk_cleanup::rules::Undo::Quarantine,
        "装置没被改写成隔离规则"
    );
    rule
}

fn no_cancel() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

#[test]
fn dry_run_and_execute_agree_and_neither_follows_a_link() {
    let fixture = fixture("pipeline");
    let target = fixture.root.join("target");
    let rule = load_fixture_rule(&target, None);
    let profile = SafetyProfile::global().unwrap();

    // ① dry-run：报告齐全，磁盘一字未动
    let preview = run_rule(&rule, Mode::DryRun, &no_cancel(), profile, None);
    assert_eq!(
        preview.report.status,
        RuleStatus::Ok,
        "{:?}",
        preview.report.error
    );
    assert_eq!(preview.report.files, 3, "三个普通文件");
    assert!(
        preview.report.sample_paths.len() >= 3,
        "干跑必须给出「到底会删哪些」的抽样"
    );
    assert_eq!(preview.report.reparse_skipped, 1, "junction 只删链接本身");
    assert_eq!(preview.report.failures, 0);
    assert!(target.join("a.tmp").exists(), "dry-run 不得改动磁盘");
    assert!(fixture.sentinel.join("keep.txt").exists());

    // ② 执行：与预览的数一致（同一段代码，只差一个开关）
    let outcome = run_rule(&rule, Mode::Execute, &no_cancel(), profile, None);
    assert_eq!(
        outcome.report.status,
        RuleStatus::Ok,
        "{:?}",
        outcome.report.error
    );
    assert_eq!(
        outcome.report.files, preview.report.files,
        "预览说删几个就必须删几个 —— 分叉会直接摧毁用户信任"
    );
    assert_eq!(outcome.report.bytes_deleted, preview.report.bytes_deleted);
    assert_eq!(
        outcome.report.reparse_skipped,
        preview.report.reparse_skipped
    );

    // ③ 真数据一字未变，链接本身已移除
    assert_eq!(
        fs::read_to_string(fixture.sentinel.join("keep.txt")).unwrap(),
        "keep me"
    );
    assert!(!target.join("link").exists(), "链接本身应当被删除");
    assert!(!target.join("a.tmp").exists());
    assert!(!target.join("sub").exists(), "清空后的子目录应被移除");
    assert!(target.exists(), "只清内容，绝不删根");

    // ④ I8：每一条动作都有记录，链接被标记为 reparse-skipped
    assert!(
        outcome
            .records
            .iter()
            .any(|record| record.action == crate::disk_cleanup::delete::Action::ReparseSkipped),
        "链接必须留下 reparse-skipped 记录"
    );
    assert_eq!(
        outcome
            .records
            .iter()
            .filter(|r| r.action == crate::disk_cleanup::delete::Action::Deleted)
            .count(),
        4,
        "3 个文件 + 1 个子目录（链接记在 reparse-skipped 里，不算 deleted）"
    );
}

#[test]
fn a_target_that_does_not_exist_is_not_an_error() {
    let fixture = fixture("missing");
    let rule = load_fixture_rule(&fixture.root.join("not-installed"), None);
    let profile = SafetyProfile::global().unwrap();

    let outcome = run_rule(&rule, Mode::DryRun, &no_cancel(), profile, None);
    assert_eq!(
        outcome.report.status,
        RuleStatus::NoTarget,
        "规则对应的软件没装是常态，不该报错吓用户"
    );
    assert!(outcome.report.error.is_none());
}

#[test]
fn a_file_target_is_reported_as_not_a_directory() {
    let fixture = fixture("notdir");
    let file = fixture.root.join("plain.txt");
    fs::write(&file, "x").unwrap();
    let rule = load_fixture_rule(&file, None);
    let profile = SafetyProfile::global().unwrap();

    let outcome = run_rule(&rule, Mode::DryRun, &no_cancel(), profile, None);
    assert_eq!(outcome.report.status, RuleStatus::NotADirectory);
    assert!(
        !outcome.report.target_display.is_empty(),
        "报告里要能指出是哪个目标"
    );
}

#[test]
fn the_retention_filter_shows_up_in_the_preview() {
    let fixture = fixture("retention");
    let target = fixture.root.join("target");
    let rule = load_fixture_rule(&target, Some(7));
    let profile = SafetyProfile::global().unwrap();

    // 刚写下去的文件都是"新的"，因此一条都不该删
    let preview = run_rule(&rule, Mode::DryRun, &no_cancel(), profile, None);
    assert_eq!(preview.report.status, RuleStatus::Ok);
    assert_eq!(preview.report.files, 0, "7 天保留期内的新文件不得被删");
    assert_eq!(
        preview.report.skipped_too_recent, 3,
        "两个顶层新文件 + 子目录里那个（保留期对每一层都生效）"
    );
    // 目录里还有保留项 → 目录留着，且不算失败
    assert_eq!(preview.report.failures, 0);
    assert!(target.join("a.tmp").exists());
}

#[test]
fn a_cancelled_scan_reports_cancelled_without_deleting() {
    let fixture = fixture("cancel");
    let target = fixture.root.join("target");
    let rule = load_fixture_rule(&target, None);
    let profile = SafetyProfile::global().unwrap();

    let cancel = Arc::new(AtomicBool::new(true));
    let outcome = run_rule(&rule, Mode::DryRun, &cancel, profile, None);
    assert_eq!(outcome.report.status, RuleStatus::Cancelled);
    assert_eq!(outcome.report.files, 0);
    assert!(target.join("a.tmp").exists());
}

/// 护栏：有待重启的更新时跳过带 `notInstalling` 的规则。
#[test]
fn the_not_installing_guard_blocks_the_rule_when_a_reboot_is_pending() {
    if !rules::pending_reboot() {
        // 本机没有待重启的更新 —— 用例没有可断言的前提，跳过而非假绿
        eprintln!("本机没有待重启的更新，`notInstalling` 护栏的命中路径未覆盖");
        return;
    }
    let fixture = fixture("guard");
    let target = fixture.root.join("target");
    let escaped = target.display().to_string().replace('\\', "\\\\");
    let json = format!(
        r#"{{"schemaVersion":1,"rules":[{{"id":"fixture","name":"测试装置","group":"cache",
           "tier":"L1","target":{{"kind":"fixedPath","path":"{escaped}"}},
           "strategy":{{"kind":"purgeContents"}},"guard":[{{"kind":"notInstalling"}}],
           "consequence":"测试用。"}}]}}"#
    );
    let profile = SafetyProfile::global().unwrap();
    let rule = rules::parse_and_validate(&json, profile).unwrap().remove(0);

    let outcome = run_rule(&rule, Mode::DryRun, &no_cancel(), profile, None);
    assert_eq!(outcome.report.status, RuleStatus::Guarded);
    assert!(target.join("a.tmp").exists());
}

// ── 回收站（§9.4）──────────────────────────────────────────────────────

fn builtin_rule(id: &str) -> rules::CleanRule {
    let profile = SafetyProfile::global().expect("派生失败");
    rules::parse_and_validate(rules::builtin_json(), profile)
        .expect("内置规则表没通过校验器")
        .into_iter()
        .find(|rule| rule.id == id)
        .unwrap_or_else(|| panic!("内置表里没有 {id}"))
}

/// 回收站的干跑：报的数来自**只读实测**，并且不调用清空。
///
/// "干跑不会清空"这条由源码守卫
/// `source_guards::the_recycle_bin_is_only_emptied_after_the_dry_run_branch` 钉死
/// （它断言 `empty_all(` 出现在 dry-run 分支**之后**）—— 那条是秒级、确定性的。
/// 这里只补运行时的一半：数字与记录真的出来了。
///
/// 实测本身有成本（本机系统盘约 7 秒），所以一条用例只测一次卷。
#[test]
fn the_recycle_bin_dry_run_reports_the_measured_size() {
    let volume = std::env::var("SystemDrive").expect("SystemDrive");
    let rule = builtin_rule("recycle-bin");
    let profile = SafetyProfile::global().unwrap();

    let outcome =
        crate::disk_cleanup::recycle_bin::with_volumes_for_tests(vec![volume.clone()], || {
            run_rule(&rule, Mode::DryRun, &no_cancel(), profile, None)
        });
    assert_eq!(
        outcome.report.status,
        RuleStatus::Ok,
        "{:?}",
        outcome.report.error
    );
    assert_eq!(outcome.report.failures, 0, "读不到的 SID 不算失败");

    // I8：Shell API 给不出逐条明细，但至少要留一条汇总，且标识不能伪装成路径
    assert!(
        outcome
            .records
            .iter()
            .any(|record| record.path == crate::disk_cleanup::recycle_bin::RECYCLE_BIN_LABEL),
        "回收站必须留下一条汇总记录"
    );
    assert!(crate::disk_cleanup::recycle_bin::RECYCLE_BIN_LABEL.starts_with('<'));

    // 报告里的字节数必须与独立实测一致（干跑不改动任何东西，两次实测应当相同）
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let measured =
        crate::disk_cleanup::recycle_bin::measure_volumes(std::slice::from_ref(&volume), &cancel);
    assert_eq!(
        outcome.report.bytes_deleted,
        measured.bytes(),
        "干跑报的字节数与独立实测不一致 —— 说明中间有东西改动了回收站"
    );
}

/// 一个 `$Recycle.Bin` 都读不到时，退回 Shell 查询，并把"未能统计"如实标出来。
///
/// 用不存在的卷来构造这个场景：它又快又确定，不会碰用户真实的回收站。
#[test]
fn an_unreadable_recycle_bin_falls_back_to_the_shell_query() {
    let rule = builtin_rule("recycle-bin");
    let profile = SafetyProfile::global().unwrap();

    let outcome =
        crate::disk_cleanup::recycle_bin::with_volumes_for_tests(vec![r"Q:\".to_string()], || {
            run_rule(&rule, Mode::DryRun, &no_cancel(), profile, None)
        });
    assert_eq!(outcome.report.status, RuleStatus::Ok);
    // 兜底查询对不存在的卷会失败 → 必须留下"未统计"的说明，而不是悄悄报 0
    assert!(
        outcome.records.iter().any(|record| record.reason.is_some()
            && record.path == crate::disk_cleanup::recycle_bin::RECYCLE_BIN_LABEL),
        "读不到的卷必须留下说明，不能悄悄算成 0"
    );
    // 而且这句话要真的送到用户眼前（状态是 Ok，所以它走的是"提示"而不是"报错"）
    let note = outcome.report.error.as_deref().unwrap_or_default();
    assert!(
        note.contains("未计入") || note.contains("读不到"),
        "「数字不完整」必须出现在报告里，实际：{note:?}"
    );
}

/// 全卷的回收站扫描。**默认不跑**：开发机上要 40 秒左右（系统盘 8.7 秒 +
/// 数据盘 30 秒超时），不适合放进每次的测试循环。
///
/// 手工验证：`cargo test --bin levitaire -- --ignored recycle_bin`
#[test]
#[ignore = "会真的查询所有卷的回收站，耗时受条目数影响（本机约 40 秒）"]
fn the_recycle_bin_rule_scans_all_fixed_volumes() {
    let rule = builtin_rule("recycle-bin");
    let profile = SafetyProfile::global().unwrap();
    let outcome = run_rule(&rule, Mode::DryRun, &no_cancel(), profile, None);
    eprintln!(
        "回收站扫描：{:?} files={} bytes={} error={:?}",
        outcome.report.status,
        outcome.report.files,
        outcome.report.bytes_deleted,
        outcome.report.error
    );
    assert_eq!(outcome.report.status, RuleStatus::Ok);
    assert_eq!(outcome.report.failures, 0, "跳过卷不算失败");
}

/// 逐卷查询的聚合逻辑：超时的卷只记进 `skipped_volumes`，不影响其余卷的数字。
/// 这里用的是**不存在的盘符**，因此必然走超时/失败分支 —— 确定性且不碰真回收站。
#[test]
fn unavailable_volumes_are_reported_as_skipped_not_as_zero() {
    let report = crate::disk_cleanup::recycle_bin::query_volumes(&["Q:\\".to_string()]);
    assert_eq!(report.total.items, 0);
    assert!(
        !report.is_complete(),
        "查不到的卷必须记成「未统计」，不能悄悄算成 0 —— 那会让用户以为回收站是空的"
    );
    assert_eq!(report.skipped_volumes, vec!["Q:\\".to_string()]);
}

#[test]
fn the_recycle_bin_rule_is_unchecked_by_default_and_demands_confirmation() {
    let rule = builtin_rule("recycle-bin");
    // 回收站里是用户删掉、但可能还想找回的东西，且不命中用户数据目录的保护
    assert!(!rule.default_checked, "回收站绝不能默认勾选");
    assert!(rule.has_guard(rules::Guard::ConfirmUnrecoverable));
    assert!(!rule.requires_admin, "清空回收站在本版本走用户态");
    assert!(rule.consequence.contains("不可撤销"));
}

// ── 隔离通路（§10 / §16 P3）─────────────────────────────────────────────

/// `undo: quarantine` 的规则走隔离区而不是删除 —— 东西还在，只是换了地方。
#[test]
fn a_quarantine_rule_moves_instead_of_deleting() {
    let fixture = fixture("quarantine");
    let target = fixture.root.join("target");
    let rule = load_quarantine_fixture_rule(&target);
    let profile = SafetyProfile::global().unwrap();

    let job_id = crate::disk_cleanup::audit::new_job_id();
    let mut store = crate::disk_cleanup::quarantine::JobQuarantine::begin(&job_id).unwrap();
    let outcome = run_rule(
        &rule,
        Mode::Execute,
        &no_cancel(),
        profile,
        Some(&mut store),
    );
    store.finish().unwrap();

    assert_eq!(
        outcome.report.status,
        RuleStatus::Ok,
        "{:?}",
        outcome.report.error
    );
    assert_eq!(
        outcome.report.bytes_deleted, 0,
        "隔离不是删除，不能计进「已释放」"
    );
    assert!(outcome.report.quarantined >= 3, "三条内容都该进隔离区");
    assert!(outcome.report.bytes_quarantined > 0);

    // 真数据一字未变（junction 只搬链接本身）
    assert_eq!(
        std::fs::read_to_string(fixture.sentinel.join("keep.txt")).unwrap(),
        "keep me"
    );
    // 目标目录本身保留（只清内容）
    assert!(target.exists());
    // 每一条都有 quarantine 记录，而不是 deleted
    assert!(outcome
        .records
        .iter()
        .any(|record| record.action == crate::disk_cleanup::delete::Action::Quarantined));
    assert!(!outcome
        .records
        .iter()
        .any(|record| record.action == crate::disk_cleanup::delete::Action::Deleted));

    // 清场：把刚搬进隔离区的条目彻底删掉，别留垃圾
    for entry in crate::disk_cleanup::quarantine::list().expect("隔离区清单应当可读") {
        if entry.job_id == job_id {
            let _ = crate::disk_cleanup::quarantine::purge(&entry.id);
        }
    }
}

/// `undo: quarantine` 的**预览**必须与执行同口径：都记进隔离口径（`bytes_quarantined`），
/// 数字逐项一致。
///
/// 原来的预览一律走删除引擎的 dry-run，把"将搬进隔离区"的量记成 `bytes_deleted`，
/// 而前端把 `bytes_deleted` 渲染成「可立即释放」—— 用户看到"立即释放 9 字节"、
/// 执行完却是 0（那些字节进的是「隔离区暂存」，保留期内还占着磁盘）。
#[test]
fn quarantined_dry_run_and_execute_agree() {
    let fixture = fixture("quarantine-pipeline");
    let target = fixture.root.join("target");
    let rule = load_quarantine_fixture_rule(&target);
    let profile = SafetyProfile::global().unwrap();

    // ① 预览：账目进隔离口径，磁盘一字未动
    let preview = run_rule(&rule, Mode::DryRun, &no_cancel(), profile, None);
    assert_eq!(
        preview.report.status,
        RuleStatus::Ok,
        "{:?}",
        preview.report.error
    );
    assert_eq!(
        preview.report.bytes_deleted, 0,
        "隔离规则的预览不许把「将搬进隔离区」算成「可立即释放」"
    );
    assert!(
        preview.report.bytes_quarantined > 0,
        "预览要把字节数记进隔离口径"
    );
    assert!(
        !preview
            .records
            .iter()
            .any(|record| record.action == crate::disk_cleanup::delete::Action::Deleted),
        "预览里不许出现 Deleted —— 这批东西不会离开磁盘"
    );
    assert!(target.join("a.tmp").exists(), "预览必须只读");
    assert!(fixture.sentinel.join("keep.txt").exists(), "预览必须只读");

    // ② 执行：与预览同一份数字
    let job_id = crate::disk_cleanup::audit::new_job_id();
    let mut store = crate::disk_cleanup::quarantine::JobQuarantine::begin(&job_id).unwrap();
    let outcome = run_rule(
        &rule,
        Mode::Execute,
        &no_cancel(),
        profile,
        Some(&mut store),
    );
    store.finish().unwrap();

    assert_eq!(
        outcome.report.status,
        RuleStatus::Ok,
        "{:?}",
        outcome.report.error
    );
    assert_eq!(
        outcome.report.bytes_quarantined, preview.report.bytes_quarantined,
        "预览说搬多少字节，执行就得搬多少字节"
    );
    assert_eq!(outcome.report.quarantined, preview.report.quarantined);
    assert_eq!(outcome.report.bytes_deleted, preview.report.bytes_deleted);

    // 清场：把刚搬进隔离区的条目彻底删掉，别留垃圾
    for entry in crate::disk_cleanup::quarantine::list().expect("隔离区清单应当可读") {
        if entry.job_id == job_id {
            let _ = crate::disk_cleanup::quarantine::purge(&entry.id);
        }
    }
}

/// 隔离区不可用时**拒绝执行**，而不是退化成"直接删"。
#[test]
fn a_quarantine_rule_refuses_to_run_without_a_quarantine_store() {
    let fixture = fixture("no-quarantine");
    let target = fixture.root.join("target");
    let rule = load_quarantine_fixture_rule(&target);
    let profile = SafetyProfile::global().unwrap();

    let outcome = run_rule(&rule, Mode::Execute, &no_cancel(), profile, None);
    assert_eq!(outcome.report.status, RuleStatus::Failed);
    assert!(outcome
        .report
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("隔离区不可用"));
    // 一个文件都不许动
    assert!(target.join("a.tmp").exists(), "拒绝执行时必须什么都没做");
}
