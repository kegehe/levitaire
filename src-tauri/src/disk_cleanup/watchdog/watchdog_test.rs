//! 看门狗用例。
//!
//! 判定逻辑做成纯函数就是为了这里能全覆盖：它决定"什么算失控"，
//! 而误报与漏报都会直接消耗用户对这个功能的信任。

use super::*;

fn discovered(path: &str, bytes: u64, delta: Option<i64>, days: Option<i64>) -> DiscoveredDir {
    DiscoveredDir {
        id: Some("d-000000000000001".into()),
        path: path.into(),
        bytes,
        files: 1,
        delta_bytes: delta,
        delta_days: days,
        is_user_data: false,
        newest_mtime: 0,
    }
}

fn settings() -> WatchSettings {
    WatchSettings {
        enabled: true,
        ..Default::default()
    }
}

// ── 判定 ───────────────────────────────────────────────────────────────

/// 两个条件必须**同时**满足（§11.1）。
#[test]
fn an_alert_needs_both_size_and_growth() {
    let config = settings();
    let big_and_growing = discovered("C:\\a", 10 * 1024 * 1024 * 1024, Some(5 * 1024 * 1024 * 1024), Some(7));
    let big_but_flat = discovered("C:\\b", 50 * 1024 * 1024 * 1024, Some(1024), Some(7));
    let growing_but_small = discovered("C:\\c", 100 * 1024 * 1024, Some(90 * 1024 * 1024), Some(7));

    let alerts = evaluate(&[big_and_growing, big_but_flat, growing_but_small], &config);
    assert_eq!(alerts.len(), 1, "只有同时满足两条的才该报：{alerts:?}");
    assert_eq!(alerts[0].path, "C:\\a");
}

/// 只看大小会把"一直很大的目录"天天报一遍；只看增长会把抖动当病。
#[test]
fn a_huge_but_stable_directory_is_not_an_alert() {
    let config = settings();
    let stable = discovered("C:\\huge", 200 * 1024 * 1024 * 1024, Some(0), Some(7));
    assert!(evaluate(&[stable], &config).is_empty());
}

/// 没有历史基准时**不报** —— 无从判断是不是在长，报了就是拿"不知道"冒充"有问题"。
#[test]
fn without_history_the_watchdog_stays_silent() {
    let config = settings();
    let unknown = discovered("C:\\a", 10 * 1024 * 1024 * 1024, None, None);
    assert!(
        evaluate(&[unknown], &config).is_empty(),
        "第一次扫描没有基准，不该报警"
    );
}

/// 增量间隔不够长也不报：刚扫完两次就下结论，报的是抖动不是趋势。
#[test]
fn a_short_observation_window_is_not_enough() {
    let config = settings();
    let quick = discovered("C:\\a", 10 * 1024 * 1024 * 1024, Some(5 * 1024 * 1024 * 1024), Some(1));
    assert!(
        evaluate(&[quick], &config).is_empty(),
        "只观察了 1 天（阈值 7 天）就报警，那是抖动"
    );
}

#[test]
fn a_shrinking_directory_is_never_an_alert() {
    let config = settings();
    let shrank = discovered("C:\\a", 10 * 1024 * 1024 * 1024, Some(-5 * 1024 * 1024 * 1024), Some(7));
    assert!(evaluate(&[shrank], &config).is_empty());
}

#[test]
fn alerts_are_sorted_by_growth_and_bounded() {
    let config = settings();
    let mut entries: Vec<DiscoveredDir> = (0..40)
        .map(|index| {
            discovered(
                &format!("C:\\d{index:02}"),
                10 * 1024 * 1024 * 1024,
                Some((2 * 1024 * 1024 * 1024) + index as i64 * 1024 * 1024),
                Some(7),
            )
        })
        .collect();
    entries.push(discovered(
        "C:\\biggest",
        10 * 1024 * 1024 * 1024,
        Some(9 * 1024 * 1024 * 1024),
        Some(7),
    ));

    let alerts = evaluate(&entries, &config);
    assert!(alerts.len() <= MAX_ALERTS, "告警条数必须有上限");
    assert_eq!(alerts[0].path, "C:\\biggest", "长得最快的排最前");
    // 单调不增
    for pair in alerts.windows(2) {
        assert!(pair[0].delta_bytes >= pair[1].delta_bytes);
    }
}

// ── 通知文案 ───────────────────────────────────────────────────────────

/// 通知正文里**不能出现完整路径**：它会被系统记进通知历史，而路径是隐私
/// （与 §12.3 同一条原则）。只报最后一段目录名。
#[test]
fn the_notification_body_does_not_leak_the_full_path() {
    let alerts = vec![Alert {
        path: r"C:\Users\someone\AppData\Local\Temp\DiagOutputDir".into(),
        bytes: 17 * 1024 * 1024 * 1024,
        delta_bytes: 5 * 1024 * 1024 * 1024,
        delta_days: 7,
        discovery_id: None,
        is_user_data: false,
    }];
    let body = summarize(&alerts);
    assert!(body.contains("DiagOutputDir"), "要说清是哪个目录：{body}");
    assert!(!body.contains(r"C:\"), "通知里不得出现完整路径：{body}");
    assert!(!body.contains("AppData"), "通知里不得出现中间路径段：{body}");
    assert!(body.contains("7 天"), "要说清时间窗口：{body}");
    assert!(body.contains("5.0 GB"), "要说清长了多少：{body}");
}

#[test]
fn the_summary_mentions_how_many_others_are_growing() {
    let make = |path: &str| Alert {
        path: path.into(),
        bytes: 10 * 1024 * 1024 * 1024,
        delta_bytes: 5 * 1024 * 1024 * 1024,
        delta_days: 7,
        discovery_id: None,
        is_user_data: false,
    };
    assert_eq!(summarize(&[make("C:\\one")]), "one 在 7 天内增长了 5.0 GB");
    let many = summarize(&[make("C:\\one"), make("C:\\two"), make("C:\\three")]);
    assert!(many.contains("另有 2 个"), "{many}");
}

#[test]
fn an_empty_alert_list_produces_no_text() {
    assert_eq!(summarize(&[]), "");
}

// ── 设置 ───────────────────────────────────────────────────────────────

/// 看门狗**必须低频**：间隔低于下限一律抬到下限。
#[test]
fn the_interval_is_clamped_to_the_low_frequency_floor() {
    let too_often = WatchSettings {
        interval_hours: 0,
        ..settings()
    }
    .normalized();
    assert_eq!(too_often.interval_hours, MIN_INTERVAL_HOURS);

    let absurd = WatchSettings {
        interval_hours: 24 * 365,
        ..settings()
    }
    .normalized();
    assert!(absurd.interval_hours <= 24 * 30, "上限也要有");
}

#[test]
fn thresholds_are_clamped_to_something_meaningful() {
    let silly = WatchSettings {
        min_bytes: 1,
        min_delta_bytes: 0,
        min_age_days: 0,
        ..settings()
    }
    .normalized();
    assert!(silly.min_bytes >= 64 * 1024 * 1024);
    assert!(silly.min_delta_bytes >= 16 * 1024 * 1024);
    assert!(silly.min_age_days >= 1);
}

/// 前端能改的字段里**没有监视目录**：带上它就是解析错误。
#[test]
fn the_settings_input_cannot_carry_a_path() {
    let malicious = r#"{"enabled":true,"intervalHours":24,"minBytes":1,"minDeltaBytes":1,
        "minAgeDays":7,"watched":["C:\\Windows"]}"#;
    assert!(
        serde_json::from_str::<WatchSettingsInput>(malicious).is_err(),
        "设置入参不该接受 watched 字段 —— 否则前端就有了注入路径的通路（I1）"
    );

    // 合法入参只有那五个字段
    let ok = r#"{"enabled":true,"intervalHours":24,"minBytes":1,"minDeltaBytes":1,"minAgeDays":7}"#;
    let parsed: WatchSettingsInput = serde_json::from_str(ok).expect("合法入参应当解析成功");
    assert!(parsed.enabled);
}

/// 保存设置时既有监视目录必须原样保留（它不在入参里）。
#[test]
fn saving_settings_keeps_the_existing_watch_targets() {
    let existing = WatchSettings {
        watched: vec![r"D:\Games".into()],
        enabled: false,
        ..Default::default()
    };
    let input = WatchSettingsInput {
        enabled: true,
        interval_hours: 6,
        min_bytes: 4 * 1024 * 1024 * 1024,
        min_delta_bytes: 2 * 1024 * 1024 * 1024,
        min_age_days: 14,
    };
    let merged = existing.apply(&input);
    assert!(merged.enabled);
    assert_eq!(merged.interval_hours, 6);
    assert_eq!(merged.min_age_days, 14);
    assert_eq!(merged.watched, vec![r"D:\Games".to_string()]);
}

#[test]
fn without_custom_targets_the_watchdog_watches_the_system_volume() {
    let targets = settings().targets();
    assert_eq!(targets.len(), 1, "默认只盯系统卷：{targets:?}");
    let system_drive = crate::disk_cleanup::safety::SafetyProfile::global()
        .expect("派生失败")
        .env()
        .system_drive
        .to_string_lossy()
        .to_string();
    assert_eq!(targets[0], system_drive, "系统盘必须来自运行时派生（I3）");
}

#[test]
fn custom_targets_replace_the_default() {
    let custom = WatchSettings {
        watched: vec![r"D:\Games".into(), r"D:\Models".into()],
        ..settings()
    };
    assert_eq!(custom.targets(), vec![r"D:\Games".to_string(), r"D:\Models".to_string()]);
}

/// 设置默认**关闭**：一个只要装上就每天自动扫盘的工具有点越界。
#[test]
fn the_watchdog_is_off_by_default() {
    assert!(!WatchSettings::default().enabled);
}
