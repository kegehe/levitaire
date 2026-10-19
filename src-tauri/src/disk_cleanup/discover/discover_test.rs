//! 通用占用发现的用例。
//!
//! 扫描部分全程在临时目录里跑 —— 真的去扫 C: 要几分钟，而且结果随机器变化，
//! 不适合进测试循环。全卷扫描留给手工验收（`--ignored`）。

use super::*;
use std::sync::atomic::AtomicBool;

fn stat(path: &str, bytes: u64, mtime: u64) -> DirEntryStat {
    DirEntryStat {
        path: path.to_string(),
        bytes,
        files: 1,
        newest_mtime: mtime,
        depth: 2,
    }
}

fn snapshot(entries: Vec<DirEntryStat>) -> Snapshot {
    Snapshot {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        taken_at: "2026-01-01T00:00:00+08:00".into(),
        volume: r"Q:\".into(),
        report_depth: 4,
        entries,
        unreadable_dirs: 0,
        root_bytes: 0,
        root_files: 0,
    }
}

// ── 祖先判定 ───────────────────────────────────────────────────────────

#[test]
fn descendant_check_uses_component_boundaries() {
    assert!(is_descendant(r"C:\Users\me\AppData", r"C:\Users\me"));
    assert!(is_descendant(
        r"C:\Users\me\AppData\Local\Temp",
        r"C:\Users"
    ));
    // 相等不是"后代"
    assert!(!is_descendant(r"C:\Users\me", r"C:\Users\me"));
    // 字符串前缀会把这些判成后代 —— 必须是组件边界
    assert!(!is_descendant(r"C:\Users2", r"C:\Users"));
    assert!(!is_descendant(r"C:\Users\me2", r"C:\Users\me"));
    // 大小写不敏感
    assert!(is_descendant(r"c:\users\me\x", r"C:\Users\me"));
}

/// ★ 回归：**非 ASCII 路径上不得 panic**。
///
/// 原实现用 `str::split_at(另一个字符串的字节长度)`，在非字符边界会 panic。
/// 实测复现过：同一份快照里任意两条路径长度对齐就命中（**不需要有祖先关系**），
/// 而第一次扫描时增长榜按路径字典序取前若干条，中文目录必然混在其中 ——
/// 后果不只是崩一下：panic 发生在 `spawn_blocking` 里，无人 await 的 JoinHandle
/// 把 panic 吞掉，**I9 闸门的 `finish()` 不执行**，此后所有操作都回
/// "已有一个任务在进行中"，重启应用才能恢复。
#[test]
fn descendant_check_never_panics_on_non_ascii_paths() {
    // 这些组合在原实现下会 panic：第二个参数的字节长度落在第一个参数的多字节字符中间
    assert!(!is_descendant("D:\\😀x", "D:\\ab"));
    assert!(!is_descendant("D:\\中文目录\\x", "D:\\Users"));
    assert!(!is_descendant("D:\\é\\x", "D:\\abc"));
    // 中文目录之间的正常判断仍然要对
    assert!(is_descendant("D:\\项目\\子目录", "D:\\项目"));
    assert!(!is_descendant("D:\\项目2", "D:\\项目"));
    assert!(is_descendant("D:\\😀\\深层", "D:\\😀"));
}

// ── 排名 ───────────────────────────────────────────────────────────────

#[test]
fn ranking_drops_nested_duplicates() {
    let current = snapshot(vec![
        stat(r"Q:\Users", 900, 0),
        stat(r"Q:\Users\me", 800, 0),
        stat(r"Q:\other", 700, 0),
    ]);
    let ranked = rank(&current, None, 10);
    let paths: Vec<&str> = ranked.iter().map(|d| d.path.as_str()).collect();
    // `Q:\Users` 入选后，`Q:\Users\me` 不再单独列出
    assert!(paths.contains(&r"Q:\Users"));
    assert!(!paths.contains(&r"Q:\Users\me"));
    assert!(paths.contains(&r"Q:\other"));
}

/// 反向也要去嵌套：内层先入选时，外层不该再挤进来 ——
/// 否则 `Q:\big` 会把已经说明问题的 `Q:\big\sessions` 顶掉。
#[test]
fn nesting_is_removed_in_both_directions() {
    let current = snapshot(vec![
        stat(r"Q:\outer", 500, 0),
        stat(r"Q:\outer\inner", 100, 0),
    ]);
    let baseline = snapshot(vec![
        stat(r"Q:\outer", 100, 0),
        stat(r"Q:\outer\inner", 0, 0),
    ]);
    let ranked = rank(&current, Some(&(baseline, 7)), 10);
    let paths: Vec<&str> = ranked.iter().map(|d| d.path.as_str()).collect();
    assert!(!(paths.contains(&r"Q:\outer") && paths.contains(&r"Q:\outer\inner")));
}

#[test]
fn growth_ranking_keeps_only_directories_that_grew() {
    let baseline = snapshot(vec![stat(r"Q:\grew", 100, 0), stat(r"Q:\shrank", 500, 0)]);
    let current = snapshot(vec![stat(r"Q:\grew", 900, 0), stat(r"Q:\shrank", 400, 0)]);
    let ranked = rank(&current, Some(&(baseline, 7)), 10);

    let grew = ranked.iter().find(|d| d.path == r"Q:\grew").unwrap();
    assert_eq!(grew.delta_bytes, Some(800));
    assert_eq!(grew.delta_days, Some(7));
    // 缩小的目录不该出现在增长榜里（它仍可能因为"占用大"被列出来，
    // 但增量必须是负数或 0，不能被当成"在长"）
    if let Some(shrank) = ranked.iter().find(|d| d.path == r"Q:\shrank") {
        assert_eq!(shrank.delta_bytes, Some(-100));
    }
    // 而且它不该排在增长榜的第一位
    assert_eq!(ranked[0].path, r"Q:\grew");
}

#[test]
fn without_history_there_is_no_delta_at_all() {
    let current = snapshot(vec![stat(r"Q:\a", 100, 0)]);
    let ranked = rank(&current, None, 10);
    assert_eq!(ranked.len(), 1);
    assert_eq!(
        ranked[0].delta_bytes, None,
        "没有历史快照时必须说「不知道」，不能显示 +0 —— 那会被读成「没长」"
    );
    assert_eq!(ranked[0].delta_days, None);
}

#[test]
fn ranking_is_bounded_by_the_discovery_id_budget() {
    let entries: Vec<DirEntryStat> = (0..500)
        .map(|index| stat(&format!(r"Q:\dir{index:03}"), 1_000_000 - index as u64, 0))
        .collect();
    let current = snapshot(entries);
    let ranked = rank(&current, None, 200);
    assert!(
        ranked.len() <= MAX_DISCOVERY_IDS,
        "签发的 id 数必须有上限，实际 {}",
        ranked.len()
    );
    // 大的排在前面
    assert!(ranked[0].bytes >= ranked[ranked.len() - 1].bytes);
}

// ── 扫描 ───────────────────────────────────────────────────────────────

/// 造一棵装置：`root/a/b/c` 各层放文件，并在 `root/a` 里放一个指向别处的 junction。
fn fixture(tag: &str) -> PathBuf {
    let root =
        std::env::temp_dir().join(format!("levitaire-discover-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("a").join("b").join("c")).unwrap();
    fs::create_dir_all(root.join("sibling")).unwrap();
    fs::write(root.join("top.bin"), vec![0u8; 1000]).unwrap();
    fs::write(root.join("a").join("x.bin"), vec![0u8; 2000]).unwrap();
    fs::write(root.join("a").join("b").join("y.bin"), vec![0u8; 4000]).unwrap();
    // 深层文件：只有"遍历到底"才会把它算进祖先
    fs::write(
        root.join("a").join("b").join("c").join("z.bin"),
        vec![0u8; 8000],
    )
    .unwrap();
    fs::write(root.join("sibling").join("s.bin"), vec![0u8; 500]).unwrap();
    root
}

fn scan(root: &Path, depth: usize) -> Snapshot {
    let cancel = AtomicBool::new(false);
    take_snapshot(
        &root.display().to_string(),
        depth,
        Politeness::BelowNormal,
        &cancel,
        &mut |_| {},
    )
    .expect("扫描失败")
    .expect("不该被取消")
}

fn find<'a>(snapshot: &'a Snapshot, suffix: &str) -> &'a DirEntryStat {
    snapshot
        .entries
        .iter()
        .find(|entry| entry.path.ends_with(suffix))
        .unwrap_or_else(|| panic!("快照里找不到 {suffix}：{:?}", snapshot.entries))
}

/// ★ 这条是"遍历到底、只报告浅层"的证明。
#[test]
fn sizes_are_complete_even_when_the_report_depth_is_shallow() {
    let root = fixture("depth");
    let snapshot = scan(&root, 2);

    // 装置结构：`a/b/c` 逐层向下，文件在 `a/x`、`a/b/y`、`a/b/c/z`
    // 报告深度 2 → `a`(1) 与 `a/b`(2) 进结果，`a/b/c`(3) 不进
    let a = find(&snapshot, "a");
    assert_eq!(
        a.bytes, 14000,
        "浅报告深度下，目录大小也必须把深层文件算进来 —— 否则摆给用户的就是错数字"
    );
    assert_eq!(a.files, 3);
    let b = find(&snapshot, "b");
    assert_eq!(b.bytes, 12000);
    assert!(
        !snapshot
            .entries
            .iter()
            .any(|entry| entry.path.ends_with("c")),
        "超过报告深度的目录不该出现在结果里"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_report_depth_controls_which_directories_are_listed() {
    let root = fixture("depth2");
    let shallow = scan(&root, 1);
    // 第 1 层只有 `a` 与 `sibling`
    assert!(shallow
        .entries
        .iter()
        .any(|entry| entry.path.ends_with("a")));
    assert!(!shallow
        .entries
        .iter()
        .any(|entry| entry.path.ends_with("b")));

    let deeper = scan(&root, 3);
    assert!(deeper.entries.iter().any(|entry| entry.path.ends_with("c")));
    let _ = fs::remove_dir_all(&root);
}

/// 不进入重解析点：链接指向的东西一个字节都不能算进来。
#[test]
fn a_junction_contributes_nothing_to_its_parent() {
    let root = fixture("link");
    let elsewhere =
        std::env::temp_dir().join(format!("levitaire-discover-target-{}", std::process::id()));
    let _ = fs::remove_dir_all(&elsewhere);
    fs::create_dir_all(&elsewhere).unwrap();
    fs::write(elsewhere.join("huge.bin"), vec![0u8; 500_000]).unwrap();

    let made = crate::utils::process::hidden_command("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(root.join("a").join("link"))
        .arg(&elsewhere)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false);
    assert!(made, "建 junction 失败，装置不完整");

    let snapshot = scan(&root, 3);
    let a = find(&snapshot, "a");
    assert_eq!(
        a.bytes, 14000,
        "链接指向的 500 KB 不能算进来，否则所有祖先的账目都会虚高"
    );

    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&elsewhere);
}

/// 开工前就被取消 → 什么都不产出。
#[test]
fn a_pre_cancelled_scan_produces_no_snapshot() {
    let root = fixture("cancel");
    let cancel = AtomicBool::new(true);
    let result = take_snapshot(
        &root.display().to_string(),
        4,
        Politeness::BelowNormal,
        &cancel,
        &mut |_| {},
    )
    .unwrap();
    assert!(result.is_none(), "半份快照不落盘：拿它算增量会得出错误结论");
    let _ = fs::remove_dir_all(&root);
}

/// ★ **扫到一半**取消 → 同样不产出快照。
///
/// 与前一条不是一回事：那条只是"开工前标志位已经是 true"，走的是入口检查；
/// 这条要证明的是**遍历中途**发现取消后能干净地退出，而不是把已经数到一半的
/// 数字当成完整快照存下来 —— 后者比不存更糟，它会变成一个错误的基准。
///
/// 靠 `on_progress` 回调来触发取消：它每 256 个目录上报一次，所以装置要够大。
#[test]
fn a_scan_cancelled_mid_flight_produces_no_snapshot() {
    let root = fixture("cancel-mid");
    for index in 0..300 {
        fs::create_dir_all(root.join("deep").join(format!("d{index:03}"))).unwrap();
    }
    let cancel = AtomicBool::new(false);
    let snapshot = take_snapshot(
        &root.display().to_string(),
        4,
        Politeness::BelowNormal,
        &cancel,
        &mut |_| {
            // 第一次上报就等于"用户在这时候点了取消"
            cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        },
    )
    .unwrap();
    assert!(
        snapshot.is_none(),
        "中途取消同样不能落盘 —— 半份数据的增量是错的"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn scanning_a_missing_volume_is_an_error_not_an_empty_result() {
    let cancel = AtomicBool::new(false);
    let result = take_snapshot(
        r"Q:\definitely-not-here",
        4,
        Politeness::BelowNormal,
        &cancel,
        &mut |_| {},
    );
    assert!(result.is_err(), "卷不存在必须报错，不能给一份空快照");
}

#[test]
fn progress_is_reported_periodically() {
    let root = fixture("progress");
    let cancel = AtomicBool::new(false);
    let mut reports = 0usize;
    let snapshot = take_snapshot(
        &root.display().to_string(),
        4,
        Politeness::BelowNormal,
        &cancel,
        &mut |_| {
            reports += 1;
        },
    )
    .unwrap()
    .unwrap();
    // 这棵装置只有几个目录，达不到 256 的上报门槛 —— 因此一次都不报是正确的
    assert_eq!(reports, 0);
    assert!(!snapshot.entries.is_empty());
    let _ = fs::remove_dir_all(&root);
}

// ── 快照的存取与基准 ───────────────────────────────────────────────────

/// ★ 版本不认识的快照必须被**过滤掉**，而不是被当成当前版本读进来。
///
/// 原来的写法只是"序列化再反序列化，断言版本号没变" —— 那是同义反复，
/// 真正要钉的是 `read_snapshot` 里那道 `schema_version ==` 的闸门。
/// 现在真的写文件、真的读回来。
#[test]
fn a_snapshot_with_an_unknown_schema_is_ignored_rather_than_misread() {
    let volume = r"Q:\schema-probe";
    let mut fresh = snapshot(vec![stat(r"Q:\schema-probe\a", 1, 0)]);
    fresh.volume = volume.to_string();
    save(&fresh).expect("存快照失败");

    // 捏一份"未来版本"的快照塞进同一个目录：文件名形态与真快照一致
    let future = Snapshot {
        schema_version: SNAPSHOT_SCHEMA_VERSION + 1,
        taken_at: "2099-01-01T00:00:00+08:00".into(),
        volume: volume.to_string(),
        ..snapshot(vec![stat(r"Q:\schema-probe\b", 999, 0)])
    };
    let path = snapshot_path(volume, &future.taken_at);
    fs::write(&path, serde_json::to_string(&future).unwrap()).unwrap();

    // 读回来时，"未来版本"那份必须消失，只剩当前版本的
    let loaded = load_recent(volume, SNAPSHOT_KEEP);
    assert_eq!(loaded.len(), 1, "版本不认识的快照必须被过滤掉：{loaded:?}");
    assert_eq!(loaded[0].schema_version, SNAPSHOT_SCHEMA_VERSION);

    // 清场（快照目录在用例里已隔离到临时根）
    let _ = fs::remove_file(&path);
    for leftover in list_files(volume) {
        let _ = fs::remove_file(leftover);
    }
}

/// 快照的存取往返：存进去的目录块要能原样读回来，且**新的排在前面**。
///
/// 这一层以前完全没有用例 —— 因为 `app_data_dir()` 没有测试隔离，谁都不敢写盘。
#[test]
fn snapshots_round_trip_and_list_newest_first() {
    let volume = r"Q:\roundtrip-probe";
    let older = Snapshot {
        taken_at: "2026-01-01T00:00:00+08:00".into(),
        volume: volume.to_string(),
        ..snapshot(vec![stat(r"Q:\roundtrip-probe\old", 111, 0)])
    };
    let newer = Snapshot {
        taken_at: "2026-06-01T00:00:00+08:00".into(),
        volume: volume.to_string(),
        ..snapshot(vec![stat(r"Q:\roundtrip-probe\new", 222, 0)])
    };
    save(&older).unwrap();
    save(&newer).unwrap();

    let loaded = load_recent(volume, SNAPSHOT_KEEP);
    assert_eq!(loaded.len(), 2);
    assert_eq!(
        loaded[0].taken_at, newer.taken_at,
        "新的必须在前面 —— `find_baseline` 靠这个顺序才敢按「从新到旧」扫"
    );
    assert_eq!(loaded[0].entries[0].bytes, 222);
    assert_eq!(loaded[1].entries[0].bytes, 111);

    for leftover in list_files(volume) {
        let _ = fs::remove_file(leftover);
    }
}

#[test]
fn volume_tags_stay_inside_the_snapshot_directory() {
    // 盘符理论上就是一个字母，但这条防线不能靠"理论上"
    for bad in [r"C:\", "../evil", "../../etc", r"..\..\x", r"D:\a/b"] {
        let tag = volume_tag(bad);
        assert!(!tag.contains('/'), "`{bad}` 的标签里不能有正斜杠：{tag}");
        assert!(!tag.contains('\\'), "`{bad}` 的标签里不能有反斜杠：{tag}");
        assert!(!tag.contains('.'), "`{bad}` 的标签里不能有 `.`：{tag}");
        assert!(!tag.is_empty(), "`{bad}` 必须得到非空标签");
    }
}

/// ★ 两个不同的监视目标绝不能压成同一个标签。
///
/// 监视目标不止卷根：`add_watch_target` 允许用户挑任意目录。只保留字母数字的话，
/// `D:\Games` 与 `D:\Gam es` 都会变成 `DGames` —— 两个目录**共用一份快照历史**，
/// 算出来的增量是拿 A 的体积减 B 的体积，一个纯粹的假数字，再拿它判断"谁在失控"。
#[test]
fn distinct_volumes_never_share_a_snapshot_tag() {
    let pairs = [
        (r"D:\Games", r"D:\Gam es"),
        (r"D:\a-b", r"D:\ab"),
        (r"D:\a_b", r"D:\a.b"),
        (r"C:\X\Y", r"C:\XY"),
    ];
    for (a, b) in pairs {
        assert_ne!(
            volume_tag(a),
            volume_tag(b),
            "`{a}` 与 `{b}` 撞成了同一个标签 —— 它们会共用快照历史"
        );
    }
    // 同一个目标必须稳定地得到同一个标签（否则历史每次都重新开始）
    assert_eq!(volume_tag(r"D:\Games"), volume_tag(r"D:\Games"));
}

/// 路径大小写不同 = 同一个目录。基准查表必须大小写不敏感，
/// 否则那个目录会从增长榜上**静默消失**（看着像"它没长"）。
#[test]
fn baseline_lookup_is_case_insensitive() {
    let baseline = snapshot(vec![stat(r"Q:\Users\me\Cache", 100, 0)]);
    let current = snapshot(vec![stat(r"q:\users\ME\cache", 900, 0)]);
    let ranked = rank(&current, Some(&(baseline, 7)), 10);
    assert_eq!(
        ranked[0].delta_bytes,
        Some(800),
        "大小写不同不该让基准查不到 —— 查不到就只剩「不知道」，而它是长了 800 的"
    );
}

/// 同分时**深的在前**：字节数相等说明父目录的全部内容就是那个子目录，
/// 列子目录信息量一样但更具体。
#[test]
fn a_tie_is_broken_in_favour_of_the_deeper_directory() {
    let current = snapshot(vec![
        stat(r"Q:\outer", 500, 0),
        stat(r"Q:\outer\inner", 500, 0),
    ]);
    let ranked = rank(&current, None, 10);
    let paths: Vec<&str> = ranked.iter().map(|d| d.path.as_str()).collect();
    assert_eq!(
        paths,
        vec![r"Q:\outer\inner"],
        "同分该留深的那条，父目录被它顶掉"
    );
}

/// ★ 回退必须退到**最老**那份，不是最新那份。
///
/// `load_recent` 是从新到旧。原来的实现把"第一个见到的"当回退（= 最新的一份），
/// 等于把 `min_age_days` 整个绕过：三分钟前刚扫过一次，就会拿三分钟前的快照报
/// "0 天里长了 500 MB" —— 那不是增长，是这段时间机器碰巧干了什么。
#[test]
fn the_fallback_baseline_is_the_oldest_snapshot_not_the_newest() {
    let now = chrono::Local::now();
    let stamp = |days_ago: i64| {
        (now - chrono::Duration::days(days_ago)).to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
    };
    // 从新到旧：3 小时前、1 天前、3 天前
    let three_hours = Snapshot {
        taken_at: (now - chrono::Duration::hours(3))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
        ..snapshot(vec![])
    };
    let one_day = Snapshot {
        taken_at: stamp(1),
        ..snapshot(vec![])
    };
    let three_days = Snapshot {
        taken_at: stamp(3),
        ..snapshot(vec![])
    };

    // 要求 7 天：谁都不够格 → 退到最老的（3 天），而不是最新的（3 小时）
    let picked = pick_baseline(
        &[three_hours.clone(), one_day.clone(), three_days.clone()],
        now,
        7,
    )
    .expect("应当退到最老的那份");
    assert_eq!(
        picked.0.taken_at, three_days.taken_at,
        "回退必须是最老的一份，否则 min_age_days 形同虚设"
    );
    assert_eq!(picked.1, 3, "间隔要如实报出来");

    // 够格时取"最接近 min_age_days 的那份"（从新到旧第一个满足的）
    let picked = pick_baseline(&[three_hours.clone(), one_day.clone(), three_days], now, 1)
        .expect("1 天前那份够格");
    assert_eq!(picked.0.taken_at, one_day.taken_at);
    assert_eq!(picked.1, 1);
}

/// 连一天都不到的窗口**不算窗口**：回 `None`，让界面说"还看不出增长"。
#[test]
fn a_baseline_younger_than_a_day_is_not_a_baseline() {
    let now = chrono::Local::now();
    let minutes_ago = Snapshot {
        taken_at: (now - chrono::Duration::minutes(20))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
        ..snapshot(vec![])
    };
    assert!(
        pick_baseline(&[minutes_ago], now, 7).is_none(),
        "20 分钟的间隔算出来的「增长」是噪声，必须说「不知道」而不是给个数字"
    );
}

/// 时间戳读不出来的快照要跳过，不能让一条坏数据把整段历史废掉。
#[test]
fn an_unparseable_snapshot_is_skipped_without_killing_the_history() {
    let now = chrono::Local::now();
    let broken = Snapshot {
        taken_at: "not a timestamp".into(),
        ..snapshot(vec![])
    };
    let good = Snapshot {
        taken_at: (now - chrono::Duration::days(2))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
        ..snapshot(vec![])
    };
    let picked = pick_baseline(&[broken, good.clone()], now, 7).expect("好数据仍应被选中");
    assert_eq!(picked.0.taken_at, good.taken_at);
    assert_eq!(picked.1, 2);
}

// ── 真机对账（手工跑）──────────────────────────────────────────────────

/// 拿真实目录树与 **robocopy** 对账，验证累加器的正确性。
///
/// **默认不跑**：它要遍历几十万条目录项（`%TEMP%` 约十几秒，整个 C 盘要好几分钟），
/// 而且结果随机器变化，不适合进测试循环。合成装置的用例证明不了"真实树上数字对不对"，
/// 而"报出一个错的体积"正是这个工具最不能犯的错（§17 验收第 14 条），所以这条手工用例
/// 必须留着。
///
/// 跑法：
/// ```text
/// cargo test --bin levitaire -- --ignored discover_matches_robocopy --nocapture
/// # 换目录/深度：设置 LEVITAIRE_DISCOVER_PROBE 与 LEVITAIRE_DISCOVER_DEPTH
/// ```
#[test]
#[ignore = "要遍历真实目录树（几十万条），手工执行"]
fn discover_matches_robocopy() {
    let target = std::env::var("LEVITAIRE_DISCOVER_PROBE")
        .or_else(|_| std::env::var("TEMP"))
        .expect("TEMP");
    let depth: usize = std::env::var("LEVITAIRE_DISCOVER_DEPTH")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(2);

    eprintln!("扫描 {target}（报告深度 {depth}）…");
    let started = std::time::Instant::now();
    let snapshot = scan(Path::new(target.as_str()), depth);
    eprintln!(
        "完成：{:.1} 秒，目录 {} 个，读不到 {} 个",
        started.elapsed().as_secs_f64(),
        snapshot.entries.len(),
        snapshot.unreadable_dirs
    );

    let total = snapshot.root_bytes;
    let files = snapshot.root_files;
    eprintln!("本工具统计：{total} 字节 / {files} 个文件");

    // 独立基准：robocopy 只列表（/L），/XJ 明确不跟随 junction。
    // ⚠️ 它的输出是**本地化**的（中文系统上"字节"而不是 "Bytes"），所以不能按标签匹配；
    // 按"含最大整数的那个数字"来取：字节总数必然远大于目录数/文件数。
    let output = crate::utils::process::hidden_command("robocopy")
        .args([
            target.as_str(),
            r"C:\__discover_probe_null__",
            "/L",
            "/E",
            "/XJ",
            "/BYTES",
            "/NFL",
            "/NDL",
            "/NJH",
            "/NC",
            "/NP",
            "/R:0",
            "/W:0",
        ])
        .output()
        .expect("跑 robocopy 失败");
    let text = String::from_utf8_lossy(&output.stdout);

    let mut top: Vec<&DirEntryStat> = snapshot.entries.iter().collect();
    top.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    eprintln!("占用前 15：");
    for entry in top.iter().take(15) {
        eprintln!(
            "  {:>12} 字节  {:>8} 文件  深度{}  {}",
            entry.bytes, entry.files, entry.depth, entry.path
        );
    }

    let baseline = text
        .lines()
        .filter_map(|line| {
            line.split_whitespace()
                .filter_map(|part| part.replace(',', "").parse::<i64>().ok())
                .max()
        })
        .max()
        .expect("从 robocopy 输出里解析不出字节数");
    eprintln!("robocopy 基准：{baseline} 字节");
    let diff = (total as i64 - baseline).abs();
    let ratio = diff as f64 / baseline.max(1) as f64;
    eprintln!("差额 {diff} 字节（{:.2}%）", ratio * 100.0);
    assert!(
        ratio < 0.02,
        "与 robocopy 基准差 {diff} 字节（{:.2}%），超过 2% 就要查清楚为什么",
        ratio * 100.0
    );
}
