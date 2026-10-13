//! 回收站实测的用例。
//!
//! ★ 这些用例**绝不调用清空**。方案 §9.4 明确要求「不在用户真实回收站上做实验」，
//! 源码守卫 `the_recycle_bin_is_only_emptied_after_the_dry_run_branch` 会挡住任何
//! 从用例里发出的清空调用。
//!
//! 但"读"是可以测的，也必须测 —— 量尺寸是这次改动的核心。
//! 用例在临时目录里造一棵假的回收站结构，只验证 `measure_tree` 的累加与跳过语义；
//! 真实卷上的数字由 `scan_test` 的只读对账用例覆盖。

use super::*;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

fn scratch(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("levitaire-bin-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}

/// 累加一棵树的 (字节, 文件)。深度从 0 起，与 `measure_volumes` 的调用口径一致。
fn measure(dir: &Path) -> (u64, u64) {
    let cancel = AtomicBool::new(false);
    let mut acc = MeasureTotals::default();
    measure_tree(dir, &cancel, &mut acc, 0);
    (acc.bytes, acc.files)
}

// ── 累加 ───────────────────────────────────────────────────────────────

#[test]
fn a_recycled_tree_sums_bytes_and_files_across_all_levels() {
    let root = scratch("sum");
    // 回收站的结构：`$I<id>` 元数据 + `$R<id>` 数据（目录时是整棵树）
    fs::write(root.join("$IAAAAAA.txt"), vec![0u8; 544]).unwrap();
    fs::write(root.join("$RAAAAAA.txt"), vec![0u8; 1000]).unwrap();
    fs::create_dir_all(root.join("$RBBBBBB").join("nested")).unwrap();
    fs::write(root.join("$RBBBBBB").join("a.bin"), vec![0u8; 2000]).unwrap();
    fs::write(
        root.join("$RBBBBBB").join("nested").join("b.bin"),
        vec![0u8; 4000],
    )
    .unwrap();

    let (bytes, files) = measure(&root);
    assert_eq!(bytes, 544 + 1000 + 2000 + 4000);
    assert_eq!(files, 4);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn an_empty_bin_measures_zero() {
    let root = scratch("empty");
    assert_eq!(measure(&root), (0, 0));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_missing_directory_measures_zero_instead_of_panicking() {
    let (bytes, files) = measure(&PathBuf::from(r"Q:\definitely-not-here"));
    assert_eq!((bytes, files), (0, 0));
}

/// ★ 不进入重解析点：链接指向的东西不属于回收站，跟进去只会让数字虚高。
#[test]
fn a_junction_inside_the_bin_contributes_nothing() {
    let root = scratch("link");
    let elsewhere = scratch("link-target");
    fs::write(elsewhere.join("huge.bin"), vec![0u8; 500_000]).unwrap();
    fs::write(root.join("$RREAL.bin"), vec![0u8; 100]).unwrap();

    let made = crate::utils::process::hidden_command("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(root.join("$RLINK"))
        .arg(&elsewhere)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false);
    assert!(made, "建 junction 失败，装置不完整");

    let (bytes, files) = measure(&root);
    assert_eq!(
        (bytes, files),
        (100, 1),
        "链接指向的 500 KB 不能算进来 —— 那会让回收站的占用虚高"
    );

    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&elsewhere);
}

/// 取消要能停下整棵树，并把结果标成"下界"。
#[test]
fn cancelling_marks_the_measurement_as_truncated() {
    let root = scratch("cancel");
    fs::create_dir_all(root.join("S-1-5-21-1-2-3-1001")).unwrap();
    fs::write(
        root.join("S-1-5-21-1-2-3-1001").join("$Rx.bin"),
        vec![0u8; 10],
    )
    .unwrap();

    let cancel = AtomicBool::new(true);
    let measure_result = measure_volumes(&[root.display().to_string()], &cancel);
    assert!(measure_result.truncated, "取消必须被如实标记");
    assert!(!measure_result.is_complete());
    let _ = fs::remove_dir_all(&root);
}

// ── 卷清单一致性 ───────────────────────────────────────────────────────

/// 统计与清空必须作用于同一份卷清单 —— 否则会出现"说能释放 X、实际只释放 Y"。
#[test]
fn the_volume_override_applies_to_both_measure_and_empty() {
    with_volumes_for_tests(vec![r"Q:\".to_string()], || {
        let cancel = AtomicBool::new(false);
        let measured = measure_all(&cancel);
        // `Q:\` 不存在 → 记为"连 $Recycle.Bin 都列不出来"，而不是当成 0
        assert_eq!(measured.volumes.len(), 0, "不存在的卷不该产出实测结果");
        assert_eq!(measured.unreadable_volumes, vec![r"Q:\".to_string()]);
        // 兜底查询走的是同一份清单
        let queried = query_all();
        assert!(queried.skipped_volumes.contains(&r"Q:\".to_string()));
    });
}

#[test]
fn a_missing_volume_is_reported_not_silently_zero() {
    let cancel = AtomicBool::new(false);
    let measured = measure_volumes(&[r"Q:\".to_string()], &cancel);
    assert!(
        !measured.is_complete(),
        "读不到的卷必须让整体标记为「不完整」"
    );
}

// ── 口径 ───────────────────────────────────────────────────────────────

/// `BinMeasure::total()` 报的是**文件数**（与 Shell 的"回收条目数"口径不同，
/// 见模块头）。这条用例把口径钉住，免得以后有人按 Shell 的语义改回来。
#[test]
fn the_total_reports_files_not_recycle_entries() {
    let measure = BinMeasure {
        volumes: vec![VolumeBin {
            volume: r"Q:\".into(),
            bytes: 1234,
            files: 56,
            unreadable_sids: 0,
            too_deep: 0,
        }],
        unreadable_volumes: vec![],
        truncated: false,
    };
    assert_eq!(measure.total().items, 56);
    assert_eq!(measure.total().bytes, 1234);
}

/// ★ 卷标识不带反斜杠时必须被补齐。
///
/// `C:` 与 `C:\` 是**两回事**：前者是"C 盘当前目录下的相对路径"。`SystemDrive`
/// 环境变量正好是不带反斜杠的形式，直接用会静默读到错误位置 —— 这个坑真踩过
/// （测试里传 `C:`，结果那一卷被记成"读不到"）。
#[test]
fn a_volume_without_a_trailing_separator_is_normalised() {
    assert_eq!(bin_dir("C:"), bin_dir(r"C:\"));
    assert_eq!(bin_dir(r"D:\"), bin_dir("D:/"));
    assert_eq!(bin_dir("C:"), PathBuf::from(r"C:\$Recycle.Bin"));
}

// ── 真机实测（手工跑）──────────────────────────────────────────────────

/// 实测本机所有固定卷的回收站，打印逐卷数字与耗时。
///
/// **默认不跑**：要遍历几万个文件（本机两个卷合计约 13 万），结果也随机器变化。
/// 手工跑：`cargo test --bin levitaire -- --ignored recycle_bin::recycle_bin_test --nocapture`
///
/// 它同时是对账手段：把这里的字节数与**资源管理器**里回收站的"大小"比一比
/// （口径见模块头：我们按文件计，资源管理器按回收条目计，字节数应当接近）。
#[test]
#[ignore = "要遍历真实回收站（十万级文件），手工执行"]
fn measure_all_fixed_volumes_on_this_machine() {
    let cancel = AtomicBool::new(false);
    let started = std::time::Instant::now();
    let measured = measure_all(&cancel);
    let elapsed = started.elapsed().as_secs_f64();

    eprintln!("\n===== 回收站实测（{elapsed:.1} 秒）=====");
    for volume in &measured.volumes {
        eprintln!(
            "  {}  {:>12} 字节  {:>7} 个文件  读不到的 SID {} 个",
            volume.volume,
            volume.bytes,
            volume.files,
            volume.unreadable_sids
        );
    }
    for volume in &measured.unreadable_volumes {
        eprintln!("  {volume}  连 $Recycle.Bin 都读不到");
    }
    eprintln!(
        "  合计：{} 个文件 / {}",
        measured.files(),
        format_bytes(measured.bytes())
    );
    eprintln!("  数字完整：{}", measured.is_complete());

    // 对照：Shell 查询的耗时（只查系统盘，避免等满 30 秒超时）
    let shell_started = std::time::Instant::now();
    let shell = query_volumes(&[r"C:\".to_string()]);
    eprintln!(
        "  对照 Shell 查询 C: 耗时 {:.1} 秒，报 {} 项 / {}",
        shell_started.elapsed().as_secs_f64(),
        shell.total.items,
        format_bytes(shell.total.bytes)
    );
}
