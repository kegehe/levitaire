//! 删除引擎的蜜罐测试与集成测试（§15.1 / §15.4）。
//!
//! 蜜罐测试是**唯一能证明"不跟随重定向"的方法**：建一个真数据目录、在里面放哨兵文件，
//! 再从另一个目录用 junction / 符号链接指过去，然后对后者执行删除 —— 断言哨兵文件
//! 内容一字未变。

use super::*;
use crate::disk_cleanup::safety::wide;
use crate::utils::process::hidden_command;
use std::fs;
use std::os::windows::fs::{symlink_dir, symlink_file};
use std::path::{Path, PathBuf};
use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, HANDLE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, SetFileTime, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_WRITE_ATTRIBUTES, OPEN_EXISTING,
};

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("levitaire-del-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// 建 junction。`mklink /J` **不需要管理员**（符号链接才需要），
/// 因此蜜罐测试可以在普通环境下跑。
fn make_junction(link: &Path, target: &Path) -> bool {
    hidden_command("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn set_readonly(path: &Path, readonly: bool) {
    let mut perms = fs::metadata(path).unwrap().permissions();
    perms.set_readonly(readonly);
    fs::set_permissions(path, perms).unwrap();
}

/// 造一个真正会阻止删除的打开句柄。
///
/// 两个坑，都实测过：
/// 1. `std::fs::File::open` 不行 —— Rust 总是带上 `FILE_SHARE_DELETE`，删除照样成功；
/// 2. **`FILE_READ_ATTRIBUTES` + 共享模式 0 也不行** —— 只请求属性访问的句柄不参与
///    删除的共享检查，`DeleteFileW` 仍然返回 `Ok(())`。必须请求真实的数据访问
///    （`GENERIC_READ`）并且不共享 `FILE_SHARE_DELETE`，才会拿到
///    `ERROR_SHARING_VIOLATION`(32)。
fn open_exclusive(path: &Path) -> Option<HANDLE> {
    let w = wide(path);
    unsafe {
        CreateFileW(
            PCWSTR(w.as_ptr()),
            GENERIC_READ.0,
            FILE_SHARE_READ,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
        .ok()
    }
}

fn set_last_write_days_ago(path: &Path, days: u64) {
    let w = wide(path);
    let handle = unsafe {
        CreateFileW(
            PCWSTR(w.as_ptr()),
            FILE_WRITE_ATTRIBUTES.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    }
    .expect("打开文件写属性失败");

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let stamp = unix_secs_to_filetime(now.saturating_sub(days * 86_400));
    let ft = windows::Win32::Foundation::FILETIME {
        dwLowDateTime: (stamp & 0xFFFF_FFFF) as u32,
        dwHighDateTime: (stamp >> 32) as u32,
    };
    unsafe {
        SetFileTime(handle, None, None, Some(&ft as *const _)).expect("写时间戳失败");
        let _ = CloseHandle(handle);
    }
}

// ── 蜜罐测试（§15.1，最高优先级）────────────────────────────────────────

#[test]
fn junction_content_is_never_touched() {
    let base = scratch("junction");
    let real = base.join("real");
    let trap = base.join("trap");
    fs::create_dir_all(&real).unwrap();
    fs::create_dir_all(&trap).unwrap();
    fs::write(real.join("sentinel.txt"), "keep me").unwrap();
    fs::create_dir_all(real.join("deeper")).unwrap();
    fs::write(real.join("deeper").join("also.txt"), "keep me too").unwrap();

    if !make_junction(&trap.join("link"), &real) {
        eprintln!("建 junction 失败，跳过");
        let _ = fs::remove_dir_all(&base);
        return;
    }

    let mut ctx = DeleteCtx::new();
    purge_contents(&trap, &mut ctx).unwrap();

    // 哨兵必须一字未变
    assert_eq!(
        fs::read_to_string(real.join("sentinel.txt")).unwrap(),
        "keep me"
    );
    assert_eq!(
        fs::read_to_string(real.join("deeper").join("also.txt")).unwrap(),
        "keep me too"
    );
    // 链接本身应当被移除（它是 trap 里的垃圾），但绝不进入
    assert!(!trap.join("link").exists(), "链接本身应当被删除");
    assert_eq!(ctx.stats.reparse_skipped, 1);
    assert_eq!(ctx.stats.links_removed, 1);
    // I8：跳过这件事必须留下审计记录
    assert!(ctx
        .records
        .iter()
        .any(|r| r.action == Action::ReparseSkipped && r.path.contains("link")));

    let _ = fs::remove_dir_all(&base);
}

/// 链接套链接：`trap/to-mid` → `mid`，`mid/to-real` → `real`。
/// 只要跟随了第一层，第二层就会把真数据删掉。
#[test]
fn a_chain_of_links_is_not_followed() {
    let base = scratch("chain");
    let real = base.join("real");
    let mid = base.join("mid");
    let trap = base.join("trap");
    for d in [&real, &mid, &trap] {
        fs::create_dir_all(d).unwrap();
    }
    fs::write(real.join("sentinel.txt"), "keep me").unwrap();

    if !make_junction(&mid.join("to-real"), &real) || !make_junction(&trap.join("to-mid"), &mid) {
        eprintln!("建 junction 失败，跳过");
        let _ = fs::remove_dir_all(&base);
        return;
    }

    let mut ctx = DeleteCtx::new();
    purge_contents(&trap, &mut ctx).unwrap();

    assert_eq!(
        fs::read_to_string(real.join("sentinel.txt")).unwrap(),
        "keep me"
    );
    assert!(
        mid.join("to-real").exists(),
        "中间层本身不在清理范围内，必须原样保留"
    );
    assert_eq!(ctx.stats.reparse_skipped, 1);
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn directory_symlink_content_is_never_touched() {
    let base = scratch("symdir");
    let real = base.join("real");
    let trap = base.join("trap");
    fs::create_dir_all(&real).unwrap();
    fs::create_dir_all(&trap).unwrap();
    fs::write(real.join("sentinel.txt"), "keep me").unwrap();

    if symlink_dir(&real, &trap.join("link")).is_err() {
        eprintln!("建目录符号链接失败（需要管理员或开发者模式），跳过");
        let _ = fs::remove_dir_all(&base);
        return;
    }

    let mut ctx = DeleteCtx::new();
    purge_contents(&trap, &mut ctx).unwrap();

    assert_eq!(
        fs::read_to_string(real.join("sentinel.txt")).unwrap(),
        "keep me"
    );
    assert!(!trap.join("link").exists());
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn file_symlink_target_survives_while_the_link_is_removed() {
    let base = scratch("symfile");
    let real = base.join("real.txt");
    let trap = base.join("trap");
    fs::create_dir_all(&trap).unwrap();
    fs::write(&real, "keep me").unwrap();

    if symlink_file(&real, &trap.join("link.txt")).is_err() {
        eprintln!("建文件符号链接失败（需要管理员或开发者模式），跳过");
        let _ = fs::remove_dir_all(&base);
        return;
    }

    let mut ctx = DeleteCtx::new();
    purge_contents(&trap, &mut ctx).unwrap();

    assert_eq!(fs::read_to_string(&real).unwrap(), "keep me");
    assert!(!trap.join("link.txt").exists());
    assert_eq!(ctx.stats.reparse_skipped, 1);
    let _ = fs::remove_dir_all(&base);
}

// ── 闸三：占用即跳过（I5）──────────────────────────────────────────────

#[test]
fn in_use_files_are_skipped_not_forced() {
    let base = scratch("inuse");
    let locked = base.join("locked.txt");
    fs::write(&locked, "data").unwrap();
    let Some(handle) = open_exclusive(&locked) else {
        eprintln!("独占打开失败，跳过");
        let _ = fs::remove_dir_all(&base);
        return;
    };

    let mut ctx = DeleteCtx::new();
    purge_contents(&base, &mut ctx).unwrap();

    assert!(locked.exists(), "占用中的文件绝不能被强删");
    assert_eq!(fs::read_to_string(&locked).unwrap(), "data", "内容必须完好");
    assert_eq!(ctx.stats.files_skipped_in_use, 1);
    assert_eq!(ctx.stats.failures, 0, "占用是「跳过」，不是「失败」");
    assert!(ctx
        .records
        .iter()
        .any(|r| r.action == Action::Skipped && r.reason == Some(Reason::InUse)));

    unsafe {
        let _ = CloseHandle(handle);
    }
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn one_blocked_entry_does_not_stop_the_rest_of_the_tree() {
    let base = scratch("tolerant");
    let sub = base.join("sub");
    fs::create_dir_all(&sub).unwrap();
    fs::write(sub.join("blocked.txt"), "x").unwrap();
    fs::write(sub.join("free1.txt"), "y").unwrap();
    fs::write(sub.join("free2.txt"), "z").unwrap();
    fs::write(base.join("top.txt"), "w").unwrap();
    set_readonly(&sub.join("blocked.txt"), true);

    let mut ctx = DeleteCtx::new();
    purge_contents(&base, &mut ctx).unwrap();

    // 一个被跳过的条目不得让同目录、同子树的其它条目停下来
    assert!(!sub.join("free1.txt").exists());
    assert!(!sub.join("free2.txt").exists());
    assert!(!base.join("top.txt").exists());
    assert!(sub.join("blocked.txt").exists());

    // 目录因子树仍有保留项而保留，这**不是失败**
    assert!(sub.exists());
    assert_eq!(ctx.stats.dirs_retained, 1);
    assert_eq!(ctx.stats.failures, 0);
    assert_eq!(ctx.stats.files_deleted, 3);

    set_readonly(&sub.join("blocked.txt"), false);
    let _ = fs::remove_dir_all(&base);
}

// ── 只读属性（§6.2 决策记录）──────────────────────────────────────────

#[test]
fn readonly_files_are_skipped_and_keep_their_attributes() {
    let base = scratch("readonly");
    let ro = base.join("ro.txt");
    fs::write(&ro, "x").unwrap();
    set_readonly(&ro, true);

    let mut ctx = DeleteCtx::new();
    purge_contents(&base, &mut ctx).unwrap();

    assert!(ro.exists(), "只读文件必须留下");
    assert!(
        fs::metadata(&ro).unwrap().permissions().readonly(),
        "不得为了删掉它而改动只读属性"
    );
    assert_eq!(ctx.stats.files_skipped_readonly, 1);
    assert_eq!(ctx.stats.files_deleted, 0);
    // 报告必须单列，不静默（§18.1 的"只读文件跳过的用户预期"）
    assert!(ctx
        .records
        .iter()
        .any(|r| r.action == Action::ReadOnlySkipped && r.reason == Some(Reason::ReadOnly)));

    set_readonly(&ro, false);
    let _ = fs::remove_dir_all(&base);
}

// ── 保留期 ─────────────────────────────────────────────────────────────

#[test]
fn older_than_filter_keeps_recent_files_and_reports_them() {
    let base = scratch("age");
    let old = base.join("old.txt");
    let fresh = base.join("fresh.txt");
    fs::write(&old, "old").unwrap();
    fs::write(&fresh, "fresh").unwrap();
    set_last_write_days_ago(&old, 30);

    let mut ctx = DeleteCtx::new().with_older_than_days(7);
    purge_contents(&base, &mut ctx).unwrap();

    assert!(!old.exists(), "30 天前的文件应被清理");
    assert!(fresh.exists(), "今天的文件必须保留");
    assert_eq!(ctx.stats.files_deleted, 1);
    assert_eq!(ctx.stats.files_skipped_too_recent, 1);
    assert_eq!(ctx.stats.failures, 0);
    let _ = fs::remove_dir_all(&base);
}

/// 目录里只剩"太新"的文件时，目录本身要留下（否则等于把还在用的东西清空）。
#[test]
fn a_directory_with_only_recent_files_is_retained() {
    let base = scratch("recent-dir");
    let sub = base.join("sub");
    fs::create_dir_all(&sub).unwrap();
    fs::write(sub.join("fresh.txt"), "fresh").unwrap();

    let mut ctx = DeleteCtx::new().with_older_than_days(7);
    purge_contents(&base, &mut ctx).unwrap();

    assert!(sub.exists());
    assert!(sub.join("fresh.txt").exists());
    assert_eq!(ctx.stats.dirs_retained, 1);
    assert_eq!(ctx.stats.dirs_deleted, 0);
    let _ = fs::remove_dir_all(&base);
}

// ── dry-run ────────────────────────────────────────────────────────────

/// dry-run 与真实执行走的是**同一段代码**，只是不落盘 ——
/// 这样"预览的数字"与"执行的动作"不会分叉。
#[test]
fn dry_run_reports_without_touching_the_disk() {
    let base = scratch("dryrun");
    let sub = base.join("d");
    fs::create_dir_all(&sub).unwrap();
    fs::write(sub.join("a.txt"), "aaa").unwrap();
    fs::write(base.join("b.txt"), "bb").unwrap();

    let mut ctx = DeleteCtx::new();
    ctx.dry_run = true;
    purge_contents(&base, &mut ctx).unwrap();

    assert!(sub.join("a.txt").exists(), "dry-run 不得改动磁盘");
    assert!(base.join("b.txt").exists());
    assert!(sub.exists());

    assert_eq!(ctx.stats.files_deleted, 2);
    assert_eq!(ctx.stats.bytes_deleted, 5);
    // 子项全部可删时，目录在 dry-run 里也算作"将被删除"
    assert_eq!(ctx.stats.dirs_deleted, 1);

    // 真跑一次，结果应当与 dry-run 的预测一致
    let mut real = DeleteCtx::new();
    purge_contents(&base, &mut real).unwrap();
    assert_eq!(real.stats.files_deleted, ctx.stats.files_deleted);
    assert_eq!(real.stats.dirs_deleted, ctx.stats.dirs_deleted);
    assert_eq!(real.stats.bytes_deleted, ctx.stats.bytes_deleted);

    let _ = fs::remove_dir_all(&base);
}

// ── 边界 ───────────────────────────────────────────────────────────────

/// 只清内容，**绝不删根**：删掉 `%TEMP%` 目录会破坏 `%TEMP%` 默认路径，
/// 导致安装程序报错（§6.3）。
#[test]
fn purge_never_removes_the_root_itself() {
    let base = scratch("root");
    fs::write(base.join("a.txt"), "a").unwrap();
    let sub = base.join("sub");
    fs::create_dir_all(&sub).unwrap();

    let mut ctx = DeleteCtx::new();
    purge_contents(&base, &mut ctx).unwrap();

    assert!(
        base.exists(),
        "根目录必须保留：删掉它等于破坏 %TEMP% 默认路径（§6.3）"
    );
    assert!(!sub.exists(), "根下的空目录应当被清掉");
    assert!(!base.join("a.txt").exists());
    assert_eq!(ctx.stats.dirs_deleted, 1);
    assert_eq!(ctx.stats.dirs_retained, 0);
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn cancel_stops_the_walk_without_partial_damage() {
    let base = scratch("cancel");
    for i in 0..20 {
        fs::write(base.join(format!("f{i}.txt")), "x").unwrap();
    }

    let mut ctx = DeleteCtx::new();
    ctx.cancel.store(true, Ordering::Relaxed);
    purge_contents(&base, &mut ctx).unwrap();

    let remaining = fs::read_dir(&base).unwrap().count();
    assert_eq!(remaining, 20, "已取消的任务不得删除任何文件");
    assert_eq!(ctx.stats.files_deleted, 0);
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn a_missing_root_is_an_error_not_a_silent_success() {
    let base = scratch("missing");
    let gone = base.join("not-there");
    let mut ctx = DeleteCtx::new();
    assert!(
        purge_contents(&gone, &mut ctx).is_err(),
        "目标不存在必须被报出来，让上层记成「该规则无目标」"
    );
    let _ = fs::remove_dir_all(&base);
}
