//! 规则校验器用例（§15.3）。
//!
//! 校验器一律 **fail-closed**：任何无法判定的情况都拒绝加载（与 I2 一致）。
//! 用例全部走 JSON 文本 → `parse_and_validate`，顺带把 serde 层一起测到。

use super::*;
use std::path::{Path, PathBuf};

fn validate_json(json: &str) -> Result<Vec<CleanRule>, RuleError> {
    let profile = SafetyProfile::global().expect("本机应当能派生红线");
    parse_and_validate(json, profile)
}

/// 测试用的规则构造器。
///
/// 刻意做成"逐字段显式构造"而不是"默认 JSON + 片段拼接"：后者在覆盖已有键时会产生
/// **重复的 JSON 键**，而 serde 对重复字段是报错的 —— 那样测到的就不是校验器，
/// 而是测试自己写错了 JSON（这个坑真踩过一次，六个用例一起红）。
struct R {
    id: String,
    group: &'static str,
    tier: &'static str,
    requires_admin: bool,
    default_checked: bool,
    undo: &'static str,
    target: String,
    strategy: String,
    consequence: String,
}

impl Default for R {
    fn default() -> Self {
        Self {
            id: "t".into(),
            group: "cache",
            tier: "L1",
            requires_admin: false,
            default_checked: false,
            undo: "none",
            target: r#"{"kind":"env","var":"TEMP"}"#.into(),
            strategy: r#"{"kind":"purgeContents"}"#.into(),
            consequence: "只清理够旧、且当前未被占用的临时文件。".into(),
        }
    }
}

impl R {
    fn json(&self) -> String {
        format!(
            r#"{{"schemaVersion":1,"rules":[{{"id":"{}","name":"测试项","group":"{}","tier":"{}",
               "target":{},"strategy":{},"requiresAdmin":{},"defaultChecked":{},"undo":"{}",
               "consequence":"{}"}}]}}"#,
            self.id,
            self.group,
            self.tier,
            self.target,
            self.strategy,
            self.requires_admin,
            self.default_checked,
            self.undo,
            self.consequence
        )
    }
}

fn validate(r: &R) -> Result<Vec<CleanRule>, RuleError> {
    validate_json(&r.json())
}

/// 路径写进 JSON 字符串前必须转义反斜杠，否则 JSON 解析器会看到非法转义序列。
fn json_path(p: &Path) -> String {
    p.display().to_string().replace('\\', "\\\\")
}

fn system_root() -> PathBuf {
    PathBuf::from(std::env::var("SystemRoot").expect("SystemRoot"))
}

fn with_target(path: &Path) -> R {
    R {
        target: format!(r#"{{"kind":"fixedPath","path":"{}"}}"#, json_path(path)),
        ..Default::default()
    }
}

// ── 通过 ───────────────────────────────────────────────────────────────

#[test]
fn a_minimal_valid_rule_loads() {
    let rules = validate(&R::default()).expect("应当通过");
    assert_eq!(rules.len(), 1);
    assert_eq!(rules[0].id, "t");
    assert_eq!(rules[0].tier, Tier::L1);
    assert_eq!(rules[0].group, Group::Cache);
    assert!(!rules[0].requires_admin);
    assert!(rules[0].strategy.retention_days().is_none());
}

// ── 拒绝 ───────────────────────────────────────────────────────────────

#[test]
fn an_empty_consequence_is_rejected() {
    // consequence 是执行前的强制告知；UI 校验只是第二道，第一道在这里
    let r = R {
        consequence: "   ".into(),
        ..Default::default()
    };
    assert!(matches!(
        validate(&r),
        Err(RuleError::MissingConsequence { .. })
    ));
}

#[test]
fn a_missing_consequence_field_is_rejected() {
    // 连字段都不写同样拒绝（它不是 `#[serde(default)]`）
    let json = r#"{"schemaVersion":1,"rules":[{"id":"t","name":"a","group":"cache","tier":"L1",
        "target":{"kind":"env","var":"TEMP"},"strategy":{"kind":"purgeContents"}}]}"#;
    assert!(matches!(validate_json(json), Err(RuleError::Parse(_))));
}

#[test]
fn duplicate_ids_are_rejected() {
    let one = R::default();
    let json = format!(
        r#"{{"schemaVersion":1,"rules":[{},{}]}}"#,
        one.json()
            .trim_start_matches(r#"{"schemaVersion":1,"rules":["#)
            .trim_end_matches("]}"),
        one.json()
            .trim_start_matches(r#"{"schemaVersion":1,"rules":["#)
            .trim_end_matches("]}")
    );
    assert!(matches!(
        validate_json(&json),
        Err(RuleError::DuplicateId { .. })
    ));
}

#[test]
fn malformed_ids_are_rejected() {
    for bad in ["With Space", "UPPER", "has_underscore", "有中文"] {
        let r = R {
            id: bad.into(),
            ..Default::default()
        };
        assert!(
            matches!(validate(&r), Err(RuleError::BadId { .. })),
            "id `{bad}` 应当被拒绝"
        );
    }
}

#[test]
fn tier_and_admin_authorization_must_agree() {
    // L1 要管理员 → 分级错了
    let l1_admin = R {
        requires_admin: true,
        ..Default::default()
    };
    assert!(matches!(
        validate(&l1_admin),
        Err(RuleError::TierAuthMismatch { .. })
    ));

    // L2 不要管理员 → 会被当成普通项执行，等于跳过提权
    let l2_no_admin = R {
        tier: "L2",
        ..Default::default()
    };
    assert!(matches!(
        validate(&l2_no_admin),
        Err(RuleError::TierAuthMismatch { .. })
    ));

    // L2 + 要管理员 → 合法
    let l2_admin = R {
        tier: "L2",
        requires_admin: true,
        ..Default::default()
    };
    assert!(validate(&l2_admin).is_ok());
}

#[test]
fn l3_rules_can_never_be_checked_by_default() {
    // 不可逆操作绝不能被默认选中 —— 用户点一次"清理"就永久失去回滚能力
    let l3_checked = R {
        tier: "L3",
        requires_admin: true,
        default_checked: true,
        ..Default::default()
    };
    assert!(matches!(
        validate(&l3_checked),
        Err(RuleError::L3DefaultChecked { .. })
    ));

    let l3_unchecked = R {
        tier: "L3",
        requires_admin: true,
        ..Default::default()
    };
    assert!(validate(&l3_unchecked).is_ok());
}

#[test]
fn unknown_group_values_are_rejected_by_the_closed_enum() {
    // group 是封闭枚举（§5.6）。早期示例里的 "user-cache" / "system" 属未定义值，
    // 校验器无法据此判定删除策略 —— 因此必须在解析期就拒绝。
    for bad in ["user-cache", "userCache", "random", "Cache"] {
        let r = R {
            group: bad,
            ..Default::default()
        };
        assert!(
            matches!(validate(&r), Err(RuleError::Parse(_))),
            "group `{bad}` 应当被拒绝"
        );
    }
    // user-adjacent 是合法值
    let adjacent = R {
        group: "user-adjacent",
        ..Default::default()
    };
    assert!(validate(&adjacent).is_ok());
}

#[test]
fn cache_rules_cannot_claim_to_be_restorable() {
    // 可再生缓存与"可隔离恢复"语义矛盾：缓存没必要留副本，
    // 允许这么写会让 `group: cache` 失去"可永久删除"的一致含义。
    let contradictory = R {
        undo: "quarantine",
        ..Default::default()
    };
    assert!(matches!(
        validate(&contradictory),
        Err(RuleError::CacheMustBePermanent { .. })
    ));
}

#[test]
fn zero_retention_days_is_rejected_instead_of_silently_deleting_nothing() {
    // `olderThanDays: 0` 的实现语义是"截止线 = 现在"即什么都删不掉。
    // 写成 0 的人多半想表达"全都删" —— 放行等于让他以为工具坏了。
    let zero = R {
        strategy: r#"{"kind":"purgeContents","olderThanDays":0}"#.into(),
        ..Default::default()
    };
    assert!(matches!(
        validate(&zero),
        Err(RuleError::ZeroRetention { .. })
    ));

    // 省略字段 = 不设保留期，这才是"全都删"的表达方式
    let all = R::default();
    assert!(validate(&all).is_ok());
    assert!(all.strategy.contains("purgeContents"));
}

#[test]
fn targets_inside_red_lines_are_rejected_with_a_safety_error() {
    // 红线是运行时派生的（I3），断言用的根也来自派生，不写盘符字面量
    let err = validate(&with_target(&system_root().join("System32")))
        .expect_err("红线之内的目标必须被拒绝");
    assert!(
        matches!(err, RuleError::TargetRejected { .. }),
        "期望 TargetRejected，实际：{err}"
    );
}

#[test]
fn targets_that_are_user_data_directories_are_rejected_unconditionally() {
    // 「本工具没有任何正当理由把用户数据目录作为**缓存清理**目标」（§15.3）
    let r = R {
        target: r#"{"kind":"knownFolder","folder":"documents","relative":"sub"}"#.into(),
        ..Default::default()
    };
    let err = validate(&r).expect_err("用户数据目录必须被拒绝");
    assert!(
        matches!(err, RuleError::UserDataTarget { .. }),
        "期望 UserDataTarget，实际：{err}"
    );
}

#[test]
fn targets_outside_the_purge_roots_are_rejected() {
    // 白名单（I2）：规则只能清理封闭清单里的根之下。这条挡住的是
    // "规则文件被写坏或被篡改后指向任意目录"。
    let profile = PathBuf::from(std::env::var("USERPROFILE").expect("USERPROFILE"));
    let err = validate(&with_target(&profile.join(".levitaire-not-a-cache-root")))
        .expect_err("允许根之外的目标必须被拒绝");
    assert!(
        matches!(err, RuleError::OutsidePurgeRoots { .. }),
        "期望 OutsidePurgeRoots，实际：{err}"
    );
}

#[test]
fn a_newer_schema_version_is_rejected_rather_than_guessed() {
    let json = R::default().json().replace(
        r#""schemaVersion":1"#,
        &format!(r#""schemaVersion":{}"#, SUPPORTED_SCHEMA_VERSION + 1),
    );
    assert!(matches!(
        validate_json(&json),
        Err(RuleError::SchemaTooNew { .. })
    ));
}

#[test]
fn unknown_fields_are_rejected_so_a_newer_schema_cannot_be_half_understood() {
    // 例如 P6 才有的 `services`：现在的程序不懂"停服务再清理"，
    // 若默默忽略这个字段就会在不该删的时候删 —— 必须解析失败。
    let json = R::default().json().replace(
        r#""consequence":"#,
        r#""services":["wuauserv"],"consequence":"#,
    );
    assert!(matches!(validate_json(&json), Err(RuleError::Parse(_))));
}

#[test]
fn an_empty_rule_set_is_rejected() {
    // 空表会让所有清理项消失，用户会以为功能坏了
    assert!(matches!(
        validate_json(r#"{"schemaVersion":1,"rules":[]}"#),
        Err(RuleError::Empty)
    ));
}

#[test]
fn one_bad_rule_rejects_the_whole_table() {
    // 任何一条不合格即整表拒绝 —— 不做"跳过坏的那条"的局部容错：
    // 规则表被篡改时应当整体退回上一份，而不是静默地只损失一条。
    let good = R::default().json();
    let bad = R {
        id: "bad".into(),
        consequence: String::new(),
        ..Default::default()
    }
    .json();
    let strip = |json: String| {
        json.trim_start_matches(r#"{"schemaVersion":1,"rules":["#)
            .trim_end_matches("]}")
            .to_string()
    };
    let json = format!(
        r#"{{"schemaVersion":1,"rules":[{},{}]}}"#,
        strip(good),
        strip(bad)
    );
    assert!(matches!(
        validate_json(&json),
        Err(RuleError::MissingConsequence { .. })
    ));
}

// ── 回收站（Shell 虚拟目标）────────────────────────────────────────────

fn shell_rule() -> R {
    R {
        target: r#"{"kind":"shellRecycleBin"}"#.into(),
        strategy: r#"{"kind":"shellEmptyRecycleBin"}"#.into(),
        group: "system",
        default_checked: false,
        ..Default::default()
    }
}

#[test]
fn the_shell_target_and_strategy_must_pair_exactly() {
    // 配对正确 → 通过（它没有文件系统路径，因此不走红线与允许根那套判定）
    assert!(validate(&shell_rule()).is_ok());

    // 只写一半 → 拒绝。写错一半的规则比写错整条更危险：
    // 它看起来"有目标"，实际执行通路完全不同。
    let target_only = R {
        strategy: r#"{"kind":"purgeContents"}"#.into(),
        ..shell_rule()
    };
    assert!(matches!(
        validate(&target_only),
        Err(RuleError::ShellTargetMismatch { .. })
    ));

    let strategy_only = R {
        target: r#"{"kind":"env","var":"TEMP"}"#.into(),
        ..shell_rule()
    };
    assert!(matches!(
        validate(&strategy_only),
        Err(RuleError::ShellTargetMismatch { .. })
    ));
}

#[test]
fn the_recycle_bin_can_never_be_checked_by_default_or_declared_a_cache() {
    // 回收站里是用户删掉、但可能还想找回的东西，且它不命中用户数据目录的保护
    //（§5.6 明确记录了这个例外），因此必须由用户显式勾选。
    let checked = R {
        default_checked: true,
        ..shell_rule()
    };
    assert!(matches!(
        validate(&checked),
        Err(RuleError::ShellMustNotBeDefaultChecked { .. })
    ));

    // 它不是可再生缓存
    let cache = R {
        group: "cache",
        ..shell_rule()
    };
    assert!(matches!(
        validate(&cache),
        Err(RuleError::ShellMustBeSystemGroup { .. })
    ));

    // 也不该声称可恢复：回收站的内容我们没有任何副本
    let restorable = R {
        undo: "quarantine",
        ..shell_rule()
    };
    assert!(matches!(
        validate(&restorable),
        Err(RuleError::ShellMustNotBeRestorable { .. })
    ));
}

// ── 允许根 ─────────────────────────────────────────────────────────────

#[test]
fn purge_roots_are_derived_and_contain_the_user_level_battlefields() {
    let roots = purge_roots().expect("派生失败");
    assert!(
        roots.len() >= 3,
        "允许根至少应包含 LocalAppData / RoamingAppData / %TEMP%，实际 {roots:?}"
    );
    for root in &roots {
        assert!(root.is_absolute(), "{} 不是绝对路径", root.display());
    }
    // %TEMP% 必须在清单里：用户级清理的主战场
    let temp = PathBuf::from(std::env::var("TEMP").expect("TEMP"));
    assert!(
        roots
            .iter()
            .any(|r| super::super::safety::equal_ci(r, &temp)),
        "允许根里缺少 %TEMP%"
    );
}
