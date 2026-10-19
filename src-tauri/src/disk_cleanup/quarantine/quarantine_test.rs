//! 隔离区用例（§10 / §15.4）。
//!
//! 全过程都在临时目录里跑：隔离区会**真的搬运目录**，用例绝不能往用户的
//! `%APPDATA%\levitaire\quarantine` 里写东西（`quarantine_dir()` 在 `cfg(test)` 下
//! 每个线程给一个独立临时根，正是为此）。
//!
//! 每个用例独占一个隔离根，因此可以放心断言 `list()` 的总数。

use super::*;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

static SCRATCH: OnceLock<PathBuf> = OnceLock::new();

fn scratch() -> &'static PathBuf {
    SCRATCH.get_or_init(|| {
        // 隔离根由 quarantine 模块自己给（每线程独立），这里只准备"源目录"这一侧
        let root =
            std::env::temp_dir().join(format!("levitaire-quarantine-src-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    })
}

/// 每个用例一套独立的源目录，避免互相干扰。
fn source_dir(tag: &str) -> PathBuf {
    let dir = scratch().join(format!("src-{tag}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn job(tag: &str) -> String {
    // 任务 id 只允许纯数字：用标签的哈希拼一个定长数字，保证用例间不撞车
    let mut hash: u64 = 1469598103934665603;
    for byte in tag.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(1099511628211);
    }
    format!("{:016}", hash % 10_000_000_000_000_000)
}

/// `find` 现在返回 `Result`（读不出清单与"没有这条"是两回事，生产代码必须分开）。
/// 用例里绝大多数调用都期望"读取成功"，这里摊平成 `Option` 免得每处都写两遍。
fn find_ok(id: &str) -> Option<(PathBuf, QuarantineEntry)> {
    find(id).expect("隔离区清单应当可读")
}

/// 同理：用例默认期望账目读得出来。
fn summary_ok() -> (u64, u64) {
    summary().expect("隔离区账目应当可读")
}

// ── 往返 ────────────────────────────────────────────────────────────────

#[test]
fn a_moved_entry_can_be_restored_to_its_original_place() {
    let src = source_dir("roundtrip");
    let file = src.join("note.txt");
    fs::write(&file, "hello").unwrap();

    let id = job("roundtrip");
    let mut store = JobQuarantine::begin(&id).expect("开隔离区失败");
    let entry = store.move_in(&file, "manual", false).expect("搬运失败");
    store.finish().expect("收尾失败");

    assert!(!file.exists(), "条目应当已离开原位置");
    let stored = quarantine_dir().join(&id).join(entry.seq.to_string());
    assert!(stored.exists(), "隔离区里应当能找到它");
    assert_eq!(fs::read_to_string(&stored).unwrap(), "hello");

    // 清单要立即可读（逐条落盘，不等收尾）
    let listed = find_ok(&entry.id).expect("清单里应当有这条");
    assert_eq!(listed.1.original_path, file.display().to_string());
    assert_eq!(listed.1.size, 5);

    // 恢复
    let restored = restore(&entry.id).expect("恢复失败");
    assert_eq!(restored.id, entry.id);
    assert_eq!(fs::read_to_string(&file).unwrap(), "hello");
    assert!(!stored.exists(), "恢复后隔离区里不该还留着副本");
    assert!(find_ok(&entry.id).is_none(), "清单里应当已经移除这条");
}

#[test]
fn a_moved_directory_keeps_its_tree_intact() {
    let src = source_dir("tree");
    let dir = src.join("payload");
    fs::create_dir_all(dir.join("nested")).unwrap();
    fs::write(dir.join("a.txt"), "aaa").unwrap();
    fs::write(dir.join("nested").join("b.txt"), "bbb").unwrap();

    let id = job("tree");
    let mut store = JobQuarantine::begin(&id).unwrap();
    let entry = store.move_in(&dir, "manual", false).unwrap();
    store.finish().unwrap();

    assert!(entry.is_dir);
    assert!(!dir.exists(), "整个目录应当被搬走，而不是只搬内容");
    restore(&entry.id).unwrap();
    assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "aaa");
    assert_eq!(
        fs::read_to_string(dir.join("nested").join("b.txt")).unwrap(),
        "bbb"
    );
}

/// 恢复时原位置已被占用 → **拒绝，绝不覆盖**（§10.1）。
#[test]
fn restore_refuses_to_overwrite_an_occupied_original() {
    let src = source_dir("occupied");
    let file = src.join("note.txt");
    fs::write(&file, "original").unwrap();

    let id = job("occupied");
    let mut store = JobQuarantine::begin(&id).unwrap();
    let entry = store.move_in(&file, "manual", false).unwrap();
    store.finish().unwrap();

    // 用户在原位置新建了东西
    fs::write(&file, "the user's new file").unwrap();

    let error = restore(&entry.id).expect_err("原位置被占用时必须拒绝");
    assert!(error.contains("已被占用"), "错误信息要能解释清楚：{error}");
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        "the user's new file",
        "用户新建的文件一个字节都不能动"
    );
    // 隔离区里的那份也要原样留着，不能因为恢复失败就丢了
    let stored = find_ok(&entry.id).expect("隔离区内容不该丢");
    assert_eq!(fs::read_to_string(stored.0).unwrap(), "original");
}

// ── 彻底删除 ────────────────────────────────────────────────────────────

#[test]
fn purge_removes_the_content_and_the_manifest_entry() {
    let src = source_dir("purge");
    let file = src.join("junk.bin");
    fs::write(&file, "xxxx").unwrap();

    let id = job("purge");
    let mut store = JobQuarantine::begin(&id).unwrap();
    let entry = store.move_in(&file, "manual", false).unwrap();
    store.finish().unwrap();

    let purged = purge(&entry.id).expect("彻底删除失败");
    assert_eq!(purged.id, entry.id);
    assert!(find_ok(&entry.id).is_none());
    assert!(!quarantine_dir()
        .join(&id)
        .join(entry.seq.to_string())
        .exists());
}

/// 隔离区自身的空间账目要真实：搬进去多少字节就报多少。
#[test]
fn summary_reports_real_bytes_and_flags_user_data() {
    let src = source_dir("summary");
    let plain = src.join("plain.bin");
    let sensitive = src.join("sensitive.bin");
    fs::write(&plain, vec![0u8; 100]).unwrap();
    fs::write(&sensitive, vec![0u8; 300]).unwrap();

    let id = job("summary");
    let mut store = JobQuarantine::begin(&id).unwrap();
    let a = store.move_in(&plain, "manual", false).unwrap();
    let b = store.move_in(&sensitive, "manual", true).unwrap();
    store.finish().unwrap();

    let (total, user_data) = summary_ok();
    assert!(
        total >= 400,
        "总量至少包含刚搬进来的 400 字节，实际 {total}"
    );
    assert!(
        user_data >= 300,
        "用户数据那部分要单独统计得出来，实际 {user_data}"
    );
    assert!(user_data < total, "用户数据只是其中一部分");

    purge(&a.id).unwrap();
    purge(&b.id).unwrap();
}

// ── id 纪律（I1 的精神）─────────────────────────────────────────────────

/// id 会被拼进路径 —— 任何非数字字符都意味着路径穿越的可能。
#[test]
fn entry_ids_cannot_traverse_out_of_the_quarantine_directory() {
    for bad in [
        "../etc/passwd",
        r"..\..\config",
        "123-../4",
        "abc-1",
        "1-abc",
        "-1",
        "1-",
        "",
        "1-2-3",
    ] {
        assert!(
            parse_entry_id(bad).is_none(),
            "`{bad}` 不该被解析成 (jobId, 序号)"
        );
        assert!(find_ok(bad).is_none(), "`{bad}` 不该找到任何条目");
        assert!(restore(bad).is_err(), "`{bad}` 不该能触发恢复");
        assert!(purge(bad).is_err(), "`{bad}` 不该能触发彻底删除");
    }
    assert_eq!(parse_entry_id("123-4"), Some(("123".to_string(), 4)));
}

// ── 重解析点 ────────────────────────────────────────────────────────────

/// 搬走一个 junction：搬的是链接本身，它指向的真数据**一动都不能动**。
#[test]
fn moving_a_junction_moves_the_link_not_its_target() {
    let src = source_dir("link");
    let real = src.join("real");
    let trap = src.join("trap");
    fs::create_dir_all(&real).unwrap();
    fs::create_dir_all(&trap).unwrap();
    fs::write(real.join("keep.txt"), "keep me").unwrap();

    let made = crate::utils::process::hidden_command("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(trap.join("link"))
        .arg(&real)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false);
    if !made {
        eprintln!("建 junction 失败，跳过");
        return;
    }

    let id = job("link");
    let mut store = JobQuarantine::begin(&id).unwrap();
    let entry = store.move_in(&trap.join("link"), "manual", false).unwrap();
    store.finish().unwrap();

    assert_eq!(
        fs::read_to_string(real.join("keep.txt")).unwrap(),
        "keep me",
        "链接指向的真数据必须一字未变"
    );
    assert!(!trap.join("link").exists(), "链接本身应当已经搬走");

    // 恢复回去，链接应当又能用
    restore(&entry.id).unwrap();
    assert!(trap.join("link").exists());
    assert_eq!(
        fs::read_to_string(real.join("keep.txt")).unwrap(),
        "keep me"
    );
}

// ── 保留期判定 ──────────────────────────────────────────────────────────

/// 整目录搬运时，只要里面有"够新"的东西就不能整个搬走。
#[test]
fn a_tree_with_any_recent_entry_is_considered_recent() {
    let src = source_dir("recency");
    let dir = src.join("mixed");
    fs::create_dir_all(&dir).unwrap();
    let fresh = dir.join("fresh.txt");
    fs::write(&fresh, "x").unwrap();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let cutoff = crate::disk_cleanup::safety::unix_secs_to_filetime(now);

    // 截止线 = 现在 → 目录里有比它更新的东西（刚写的文件）→ 判定为"有新的"
    assert!(
        has_entry_newer_than(&dir, cutoff),
        "里面有刚写的文件，必须判定为「有新的」"
    );

    // 截止线推到未来 → 什么都不算新
    let future = crate::disk_cleanup::safety::unix_secs_to_filetime(now + 86_400);
    assert!(!has_entry_newer_than(&dir, future));

    // 读不到的路径按"有新的"处理，宁可不搬
    assert!(has_entry_newer_than(&src.join("not-there"), cutoff));
}

/// 目录里只剩"够旧"的东西时，整棵树都不算新。
#[test]
fn a_tree_with_only_old_entries_is_not_recent() {
    let src = source_dir("old");
    let dir = src.join("old-tree");
    fs::create_dir_all(dir.join("sub")).unwrap();
    fs::write(dir.join("a.txt"), "a").unwrap();
    fs::write(dir.join("sub").join("b.txt"), "b").unwrap();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 截止线在未来 → 所有条目都"够旧"
    let cutoff = crate::disk_cleanup::safety::unix_secs_to_filetime(now + 3600);
    assert!(!has_entry_newer_than(&dir, cutoff));
}

// ── purge_all ───────────────────────────────────────────────────────────

/// `purge_all` 会清掉隔离区里的每一条。断言只针对本次建的那条 ——
/// 用例并行跑时"总共几条"是不可靠的。
#[test]
fn purge_all_removes_our_entries() {
    let src = source_dir("purgeall");
    let file = src.join("one.bin");
    fs::write(&file, "1").unwrap();

    let id = job("purgeall");
    let mut store = JobQuarantine::begin(&id).unwrap();
    let entry = store.move_in(&file, "manual", false).unwrap();
    store.finish().unwrap();

    let removed = purge_all().expect("清空隔离区失败");
    assert!(removed >= 1, "至少应当清掉刚建的那一条");
    assert!(find_ok(&entry.id).is_none());
}

// ── 保留期自动清理 ──────────────────────────────────────────────────────

#[test]
fn purge_expired_is_disabled_at_zero_days() {
    let src = source_dir("retention0");
    let file = src.join("x.bin");
    fs::write(&file, "x").unwrap();

    let id = job("retention0");
    let mut store = JobQuarantine::begin(&id).unwrap();
    let entry = store.move_in(&file, "manual", false).unwrap();
    store.finish().unwrap();

    // 保留期 0 = 不自动清理（由用户显式彻底删除）
    assert_eq!(purge_expired(0), 0);
    assert!(find_ok(&entry.id).is_some(), "保留期 0 不该动任何条目");

    // 保留期为 1 天时，刚搬进去的条目也还没到期
    assert_eq!(purge_expired(1), 0);
    assert!(find_ok(&entry.id).is_some());

    purge(&entry.id).unwrap();
}

/// 隔离根被换成重解析点时必须拒绝使用 —— 否则我们写进去的东西会落到别处，
/// 恢复时却按原路径去找。
#[test]
fn a_redirected_quarantine_root_is_refused() {
    let src = source_dir("redirect");
    let elsewhere = src.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    let link = src.join("link-root");
    let made = crate::utils::process::hidden_command("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&elsewhere)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false);
    if !made {
        eprintln!("建 junction 失败，跳过");
        return;
    }

    // 直接用这条路径当隔离根（绕过 OnceLock，走 begin 的目录形态检查）
    let fake_job_dir = link.join(job("redirect"));
    fs::create_dir_all(&fake_job_dir).unwrap();
    let st = crate::disk_cleanup::safety::stat(&fake_job_dir).expect("stat 失败");
    assert!(
        !st.is_reparse_point(),
        "这个用例要的是「中间层是链接、叶子不是」"
    );

    // 逐层检查由闸一负责：把链接根本身交给闸一
    let profile = crate::disk_cleanup::safety::SafetyProfile::global().expect("派生失败");
    let Err(error) = profile.verify(&link) else {
        panic!("被重定向的隔离根必须被闸一拒绝");
    };
    assert!(
        matches!(
            error,
            crate::disk_cleanup::safety::SafetyError::RootRedirected { .. }
        ),
        "期望 RootRedirected，实际：{error}"
    );
}

// ── 空壳任务目录（回归）──────────────────────────────────────────────────

/// ★ 回归：一个**没有清单文件**的任务目录，不得让整个隔离区变成不可读。
///
/// 这种目录是真实会出现的：`begin` 建好目录之后 `move_in` 就失败（源被别处删了、
/// 同卷 rename 撞上占用、树太深…），或者空目录没删干净。原先 `read_manifest` 把
/// 「清单文件不存在」当**硬错误**，于是一个残留空目录就让 `list()` 整体失败：
/// 隔离区里所有条目**既看不到也恢复不了**，`purge_expired` 也静默停止
/// （读不到清单就什么都不删），隔离区只增不减。
#[test]
fn an_empty_job_directory_never_breaks_the_whole_quarantine() {
    let src = source_dir("junkdir");
    let file = src.join("real.bin");
    fs::write(&file, "real content").unwrap();

    let id = job("junkdir");
    let mut store = JobQuarantine::begin(&id).unwrap();
    let entry = store.move_in(&file, "manual", false).unwrap();
    store.finish().unwrap();

    // 造一个"建了目录但什么都没登记"的空壳 —— 正是 `begin` 之后立刻失败的样子
    let junk = quarantine_dir().join(job("junkdir-empty"));
    fs::create_dir_all(&junk).unwrap();

    // 有它在，真正的条目必须照样看得到
    let listed = list().expect("空壳目录不该让整个隔离区读不出来");
    assert!(
        listed.iter().any(|item| item.id == entry.id),
        "真正登记过的条目必须仍然可见：{listed:?}"
    );
    let (total, _) = summary().expect("账目必须仍然可读");
    assert!(total >= 12, "账目要把真实条目算进去，实际 {total}");

    // 恢复也照常能用
    restore(&entry.id).expect("恢复不该被空壳目录挡住");
    assert_eq!(fs::read_to_string(&file).unwrap(), "real content");

    let _ = fs::remove_dir_all(&junk);
}

/// 清单**存在但损坏**是另一回事：必须报错，绝不能当成"隔离区是空的"。
///
/// 内容还在磁盘上而我们认不出它 —— 说"空"等于告诉用户东西没了。
#[test]
fn a_corrupt_manifest_is_reported_rather_than_treated_as_empty() {
    let id = job("corrupt");
    let dir = quarantine_dir().join(&id);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("manifest.json"), "{ this is not json").unwrap();

    let error = list().expect_err("损坏的清单必须报错");
    assert!(
        error.contains("损坏"),
        "错误信息要指出是清单损坏，而不是「隔离区是空的」：{error}"
    );

    let _ = fs::remove_dir_all(&dir);
}

/// 「清空隔离区」要顺手收掉空壳目录，但**绝不能**因此删掉有内容的目录。
#[test]
fn purge_all_sweeps_empty_shells_but_never_touches_unregistered_content() {
    let id = job("sweep-empty");
    let empty = quarantine_dir().join(&id);
    fs::create_dir_all(&empty).unwrap();

    // 另一个：没有清单，但里面有东西 —— 这是"内容在、没人认得"的状态，
    // 只能靠人工判断，绝不能被这个动作顺手销毁
    let occupied = quarantine_dir().join(job("sweep-occupied"));
    fs::create_dir_all(&occupied).unwrap();
    fs::write(occupied.join("precious.bin"), "do not delete me").unwrap();

    purge_all().expect("清空空隔离区不该失败");

    assert!(!empty.exists(), "空壳目录应当被收掉");
    assert!(
        occupied.join("precious.bin").exists(),
        "没有登记但**有内容**的目录一个字节都不能动 —— 那是用户还能自己去看一眼的东西"
    );

    let _ = fs::remove_dir_all(&occupied);
}
