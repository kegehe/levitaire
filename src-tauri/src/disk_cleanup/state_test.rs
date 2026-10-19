//! 状态机与审计日志的用例（I8 / I9 / §7.2）。

use super::*;
use std::sync::atomic::Ordering;

fn idle_state() -> CleanState {
    CleanState::new(Ok(Vec::new()))
}

// ── I9：长任务单飞 ──────────────────────────────────────────────────────

#[test]
fn the_reentry_gate_admits_exactly_one_job() {
    let state = idle_state();
    assert!(state.try_begin(), "第一次应当抢到执行权");
    assert!(
        !state.try_begin(),
        "第二个任务必须被拒绝 —— 两个删除任务并发会产生不可预期的中间状态"
    );
    state.finish();
    assert!(state.try_begin(), "前一个任务结束后应当能再次开始");
    state.finish();
}

/// ★ 回归：**抢闸失败不得动到别人正在持有的闸门**。
///
/// `BusyGuard::acquire` 原来写成 `state.try_begin().then_some(Self { .. })`。
/// `then_some` 是**按值**传参的：条件为 false 时那个守卫已经被构造出来又被丢弃，
/// `Drop` 照常执行 → `finish()` → **把正在跑的那个任务的闸门放开**。
///
/// 于是 I9 在竞争路径上整体失效，而且触发条件毫不极端 —— 用户双击「开始清理」、
/// 看门狗轮询、点一下隔离区的恢复，任何一次在任务运行期间的抢闸尝试都会打开闸门，
/// 让第二个删除任务与第一个并发跑。这条用例就是钉住它。
#[test]
fn a_rejected_acquire_never_releases_someone_elses_gate() {
    let state = idle_state();

    let held = BusyGuard::acquire(&state).expect("第一个应当抢到");
    assert!(state.is_busy(), "持有期间闸门必须是关着的");

    // 失败的那一次抢闸
    assert!(BusyGuard::acquire(&state).is_none(), "第二个必须被拒绝");
    assert!(
        state.is_busy(),
        "★ 被拒绝的抢闸把闸门放开了 —— 第二个删除任务现在可以和第一个并发跑"
    );
    // 连带后果：取消按钮会静默失效（`request_cancel` 以 busy 为准）
    assert!(
        state.request_cancel(),
        "取消请求必须仍然认得正在跑的那个任务"
    );

    drop(held);
    assert!(!state.is_busy(), "持有者析构后才该放开");
    assert!(BusyGuard::acquire(&state).is_some(), "放开后应当能再次抢到");
}

#[test]
fn cancel_requests_are_only_honoured_while_a_job_runs() {
    let state = idle_state();
    assert!(
        !state.request_cancel(),
        "没有任务在跑时不该报告「已取消」（会让 UI 显示一个不存在的动作）"
    );
    assert!(state.try_begin());
    assert!(state.request_cancel());
    assert!(
        state.cancel_handle().load(Ordering::SeqCst),
        "取消标志必须真的落到任务看得见的那个 Arc 上"
    );
    state.finish();
}

// ── 陈旧任务守卫（对标 updater::is_current_download）────────────────────

#[test]
fn a_stale_job_can_never_overwrite_a_newer_one() {
    let state = idle_state();
    state.try_begin();
    state.update(|s| {
        s.job_id = Some("1".into());
        s.phase = Phase::Scanning;
    });
    assert!(state.is_current_job("1"));

    // 新任务接管
    state.update(|s| {
        s.job_id = Some("2".into());
    });
    assert!(!state.is_current_job("1"), "旧任务不得再写状态");
    assert!(state.is_current_job("2"));

    // 终态之后同样不再接受写入：否则旧任务会把 Done 覆盖回 Scanning，
    // 用户看到进度条倒退。
    state.update(|s| s.phase = Phase::Done);
    assert!(!state.is_current_job("2"));
    state.finish();
}

/// I9 的重入闸门必须是**判定与置位在同一条原子操作上**。
///
/// 单独测 `try_begin` 只能证明"第二次被拒"，证不了并发安全；
/// 这条用多线程真正去抢，断言恰好一个赢家。
#[test]
fn concurrent_starts_have_exactly_one_winner() {
    use std::sync::atomic::AtomicUsize;

    let state = std::sync::Arc::new(idle_state());
    let winners = std::sync::Arc::new(AtomicUsize::new(0));
    let mut handles = Vec::new();
    for _ in 0..8 {
        let state = std::sync::Arc::clone(&state);
        let winners = std::sync::Arc::clone(&winners);
        handles.push(std::thread::spawn(move || {
            if state.try_begin() {
                winners.fetch_add(1, Ordering::SeqCst);
            }
        }));
    }
    for handle in handles {
        handle.join().unwrap();
    }
    assert_eq!(
        winners.load(Ordering::SeqCst),
        1,
        "并发发起 8 次，只允许 1 次抢到执行权"
    );
}

// ── 上报节流 ───────────────────────────────────────────────────────────

#[test]
fn the_publish_throttle_bounds_the_event_rate() {
    let state = idle_state();
    let mut allowed = 0;
    for _ in 0..64 {
        if state.should_publish() {
            allowed += 1;
        }
    }
    assert_eq!(
        allowed, 1,
        "同一瞬间连发 64 次只应放行 1 次，实际 {allowed}（IPC 会被打爆）"
    );
}

// ── 规则表加载失败必须说出来 ───────────────────────────────────────────

#[test]
fn a_failed_rule_load_is_reported_instead_of_silently_empty() {
    let state = CleanState::new(Err("规则表坏了".into()));
    let status = state.snapshot();
    assert!(state.rules().is_empty());
    assert_eq!(status.rules_error.as_deref(), Some("规则表坏了"));
    // 空表 + 无说明 = 用户以为功能坏了却看不到原因；这两者必须同时出现
    assert!(!status.rules_error.unwrap().is_empty());
}

// ── 审计日志（I8 / §12.3）──────────────────────────────────────────────

/// 任务 id 来自前端，**必须**会被当成文件名拼进路径 —— 这是路径穿越的经典入口。
#[test]
fn audit_job_ids_cannot_traverse_out_of_the_log_directory() {
    for bad in [
        "../../config",
        r"..\..\config",
        "123/456",
        "abc",
        "",
        "12345678901234567890123",
    ] {
        assert!(audit::job_path(bad).is_err(), "任务 id `{bad}` 必须被拒绝");
        assert!(audit::read_job(bad).is_err(), "任务 id `{bad}` 必须被拒绝");
    }
    // 合法的纯数字 id 正常
    assert!(audit::job_path("1750000000000").is_ok());
}

#[test]
fn audit_round_trips_entries_and_summaries() {
    let job_id = format!("9{}", audit::new_job_id());
    {
        let mut writer =
            audit::AuditWriter::begin(&job_id, &["temp-user".to_string()]).expect("建审计日志失败");
        let report = scan::RuleReport {
            rule_id: "temp-user".into(),
            rule_name: "用户临时文件".into(),
            tier: rules::Tier::L1,
            group: rules::Group::Cache,
            status: scan::RuleStatus::Ok,
            target_display: r"Q:\somewhere".into(),
            files: 2,
            dirs: 1,
            bytes_deleted: 4096,
            quarantined: 0,
            bytes_quarantined: 0,
            skipped_in_use: 1,
            skipped_too_recent: 3,
            readonly_skipped: 1,
            reparse_skipped: 0,
            vanished: 2,
            bytes_vanished: 8192,
            failures: 0,
            sample_paths: vec![],
            error: None,
        };
        let records = vec![
            delete::DeleteRecord {
                action: delete::Action::Deleted,
                path: r"Q:\somewhere\a.tmp".into(),
                bytes: 4096,
                reason: None,
            },
            delete::DeleteRecord {
                action: delete::Action::ReparseSkipped,
                path: r"Q:\somewhere\link".into(),
                bytes: 0,
                reason: None,
            },
        ];
        writer.write_rule(&report, &records).expect("写明细失败");
        writer
            .finish(&scan::JobTotals::default(), std::slice::from_ref(&report))
            .expect("写汇总失败");
    }

    let lines = audit::read_job(&job_id).expect("读审计日志失败");
    assert!(
        matches!(lines.first(), Some(audit::AuditLine::Header { .. })),
        "首行必须是 header"
    );
    assert!(
        matches!(lines.last(), Some(audit::AuditLine::Summary { .. })),
        "末行必须是 summary"
    );
    let entries: Vec<&audit::AuditLine> = lines
        .iter()
        .filter(|l| matches!(l, audit::AuditLine::Entry { .. }))
        .collect();
    assert_eq!(entries.len(), 3, "两条记录 + 一条规则汇总");
    // 逐条动作都要留痕：删了什么、跳过什么（I8）
    assert!(entries.iter().any(|l| matches!(
        l,
        audit::AuditLine::Entry {
            action: delete::Action::ReparseSkipped,
            ..
        }
    )));

    // 清理现场
    let _ = std::fs::remove_file(audit::job_path(&job_id).unwrap());
}

#[test]
fn new_job_ids_are_unique_and_sortable() {
    let mut ids: Vec<String> = (0..16).map(|_| audit::new_job_id()).collect();
    let unsorted = ids.clone();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 16, "任务 id 不可重复");
    assert_eq!(ids.len(), unsorted.len());
    assert!(ids.iter().all(|id| id.len() == 16), "任务 id 定长才可排序");
}

// ── discovery_id（§8.5，I1 的落地）──────────────────────────────────────

/// 签发出来的 id 才是唯一的删除凭据；**展示路径不能当 id 用**，未知 id 一律拒绝。
#[test]
fn a_discovery_is_addressed_by_id_only() {
    let state = idle_state();
    let dir = std::env::temp_dir().join(format!("levitaire-discovery-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("a.bin"), vec![0u8; 64]).unwrap();

    let entry = state.issue_discovery(&dir).expect("签发失败");
    assert!(
        entry.id.starts_with("d-"),
        "id 形状应当一眼可辨：{}",
        entry.id
    );
    assert_eq!(entry.files, 1);
    assert!(entry.bytes >= 64);
    assert!(!entry.is_user_data);

    let (path, resolved) = state.resolve_discovery(&entry.id).expect("按 id 解析失败");
    assert!(path.exists());
    assert_eq!(resolved.id, entry.id);

    // 伪造 / 过期 / 用展示路径冒充 id —— 一律拒绝，且**绝不回退成按路径处理**
    for bad in [
        "d-999999",
        "not-an-id",
        "",
        "../etc",
        entry.display_path.as_str(),
    ] {
        assert!(
            state.resolve_discovery(bad).is_err(),
            "`{bad}` 不该被解析成一条路径"
        );
    }

    // 任何一次任务开始都会作废全部发现目标（`start` 里调的就是它）
    state.clear_discoveries();
    assert!(
        state.resolve_discovery(&entry.id).is_err(),
        "作废之后必须拒绝，否则过期 id 会命中错路径"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// 目录树超过深度上限时**拒绝签发**，而不是给一个偏小的数字。
///
/// 这个数字是用户判断"要不要把它搬进隔离区"的依据 —— 偏小比拒绝更糟（用户以为只占
/// 3 MB 就点了确认）。上限本身也不是可选项：实测深度 600 左右就**栈溢出**，而 Rust 的
/// 栈溢出是 `abort()` —— 不走 panic、整个进程直接消失。
#[test]
fn a_too_deep_tree_is_refused_instead_of_undercounted() {
    let state = idle_state();
    let base = std::env::temp_dir().join(format!("levitaire-deep-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();

    // 逐层建出 MAX_MEASURE_DEPTH + 2 层。**建的时候每层都要套 `long_path`**：
    // 这条路径注定超过 MAX_PATH，不套 `\\?\` 建不出来（`measure_tree` 自己那侧不必操心
    // —— `safety::stat` 与 `std::fs::read_dir` 都自带长路径处理）。
    let mut cur = base.clone();
    for _ in 0..(MAX_MEASURE_DEPTH + 2) {
        cur = cur.join("d");
        std::fs::create_dir(crate::disk_cleanup::safety::long_path(&cur))
            .expect("建深目录失败：本机可能没开长路径（LongPathsEnabled）");
    }

    let error = state
        .issue_discovery(&base)
        .expect_err("超过深度上限必须拒绝签发，而不是数出一棵偏小的树");
    assert!(
        error.contains("无法安全处理"),
        "拒绝的理由要能看懂，实际是：{error}"
    );

    let _ = std::fs::remove_dir_all(&base);
}

/// 手动挑的目录同样要过闸一：红线之内、非固定卷、被重定向的根，都签不出 id。
#[test]
fn a_red_lined_directory_cannot_be_issued_a_discovery_id() {
    let state = idle_state();
    let system_root = std::path::PathBuf::from(std::env::var("SystemRoot").expect("SystemRoot"));

    let error = state
        .issue_discovery(&system_root.join("System32"))
        .expect_err("红线之内的目录不该签发出 id");
    assert!(!error.is_empty(), "拒绝时要说清楚原因");
    // 拒绝过的东西不该悄悄留在注册表里
    assert!(state.snapshot().discoveries.is_empty());
}

// ── 不可恢复项的确认契约（§9.4）─────────────────────────────────────────

/// 「执行前单独确认一次」是**后端契约**，不是 UI 约定：
/// 绕过界面直接 invoke 也必须拦得住。
#[test]
fn the_unrecoverable_confirmation_is_enforced_by_the_backend() {
    let profile = safety::SafetyProfile::global().expect("派生失败");
    let rules = rules::parse_and_validate(rules::builtin_json(), profile).expect("内置表");
    let recycle = rules
        .iter()
        .find(|rule| rule.id == "recycle-bin")
        .expect("内置表里应当有回收站规则")
        .clone();

    // 执行 + 未确认 → 拒绝，并且要点名是哪一项
    let error = check_unrecoverable(std::slice::from_ref(&recycle), Mode::Execute, false)
        .expect_err("未确认时不该放行");
    assert!(error.contains("回收站"), "错误信息要点名：{error}");

    // 已确认 → 放行
    assert!(check_unrecoverable(std::slice::from_ref(&recycle), Mode::Execute, true).is_ok());

    // 扫描（只读）不需要确认
    assert!(check_unrecoverable(std::slice::from_ref(&recycle), Mode::DryRun, false).is_ok());

    // 普通 L1 规则任何时候都不需要额外确认
    let temp = rules
        .iter()
        .find(|rule| rule.id == "temp-user")
        .expect("内置表里应当有临时文件规则")
        .clone();
    assert!(check_unrecoverable(std::slice::from_ref(&temp), Mode::Execute, false).is_ok());
}

#[test]
fn duplicate_rule_ids_are_rejected_before_starting_a_job() {
    let duplicate = vec!["temp-user".to_string(), "temp-user".to_string()];
    assert!(validate_rule_ids(&duplicate).is_err());
    let distinct = vec!["temp-user".to_string(), "npm-cache".to_string()];
    assert!(validate_rule_ids(&distinct).is_ok());
}

// ── 不建议清理（§13.2 / §17 验收第 13 条）──────────────────────────────

#[test]
fn the_not_recommended_section_is_populated_from_real_paths() {
    let profile = safety::SafetyProfile::global().expect("派生失败");
    let advice = advice_for(profile);
    // 开发机上 WinSxS / Installer 一定存在，因此这一节不该是空的
    assert!(
        !advice.is_empty(),
        "「不建议清理」是核心交付（用户最需要知道的是「为什么这些不能动」），不该为空"
    );
    for item in &advice {
        assert!(!item.label.is_empty());
        assert!(
            item.reason.len() > 20,
            "{} 的原因说明太短，等于没说",
            item.label
        );
    }
    // 只报原因、不报体积：体积要靠目录遍历累加，而 WinSxS 那种硬链接虚高的目录
    // 累加出来的数字本身就是错的（§17 验收第 14 条）
    for item in &advice {
        assert!(
            !item.reason.contains("GB") && !item.reason.contains("MB"),
            "{} 的原因里出现了体积数字 —— 本版本不提供体积统计",
            item.label
        );
    }
}

// ── 磁盘总览（真实环境）────────────────────────────────────────────────

/// ★ 系统盘必须在列表里，且**只有它**被标成 `is_system`。
///
/// 这条以前是坏的：`SafetyEnv::system_drive` 来自 `%SystemDrive%`，是 `C:`
/// （**不带反斜杠**），而挂载点是 `C:\` —— 直接字符串比较**永远不相等**，
/// 于是标记从来没亮过、按它排序也是个空操作。没有任何用例覆盖到这一层，
/// 所以它静静地错了很久。这条用例把它钉死在真实环境上。
#[test]
fn the_volume_overview_marks_exactly_the_system_volume() {
    let volumes = crate::commands::disk_cleanup_volumes();
    assert!(
        !volumes.is_empty(),
        "本机至少有一块固定卷；一块都没有说明判据写错了"
    );

    let system: Vec<&str> = volumes
        .iter()
        .filter(|volume| volume.is_system)
        .map(|volume| volume.mount_point.as_str())
        .collect();
    assert_eq!(
        system.len(),
        1,
        "系统盘必须恰好标记一块，实际标了 {system:?}（全部：{:?}）",
        volumes
            .iter()
            .map(|volume| (&volume.mount_point, volume.is_system))
            .collect::<Vec<_>>()
    );

    // 标记的那一块必须就是 `%SystemDrive%` 指向的卷
    let expected = std::env::var("SystemDrive").expect("SystemDrive");
    let expected = expected.trim_end_matches(['\\', '/']);
    assert!(
        system[0]
            .trim_end_matches(['\\', '/'])
            .eq_ignore_ascii_case(expected),
        "标成系统盘的是 {}，而 %SystemDrive% 是 {expected}",
        system[0]
    );

    // 列表整体必须**按系统盘优先**排好（这正是那个失效的排序）
    assert!(volumes[0].is_system, "系统盘必须排在第一位");

    // 容量数字必须是真实的，不是占位
    for volume in &volumes {
        assert!(
            volume.total_bytes > 0,
            "{} 的总容量为 0",
            volume.mount_point
        );
        assert!(
            volume.free_bytes <= volume.total_bytes,
            "{} 的可用空间大于总容量",
            volume.mount_point
        );
    }
}
