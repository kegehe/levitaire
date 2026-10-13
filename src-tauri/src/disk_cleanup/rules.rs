//! 规则表的加载与校验（§5 / §15.3）。
//!
//! 校验器一律 **fail-closed**：任何无法判定的情况都拒绝加载（与 I2 一致）。
//!
//! ★ 内置兜底表与外部表走**同一个校验函数**。它的存在只是为了让"签名校验失败且本地
//! 没有上一份可用规则"时不至于功能全空 —— **不能因为是自带的就免检**，否则它就成了
//! 绕过校验器的后门（§7.1）。`builtin_table_passes_the_same_validator` 用例钉住这一点。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use windows::core::PCWSTR;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
};

use super::safety::{starts_with_ci, SafetyError, SafetyProfile};
use super::target::{known_folder, KnownFolderId, Target, USER_DATA_FOLDERS};

/// 本程序能理解的规则表结构版本。高于此值一律拒绝加载 ——
/// 不猜测未知字段的语义（§15.3）。
pub const SUPPORTED_SCHEMA_VERSION: u32 = 1;

// ── 数据模型 ────────────────────────────────────────────────────────────

/// `group` 是**封闭枚举**，不是自由字符串（§5.6）。规则校验器对未知值拒绝加载。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Group {
    /// 可再生缓存，允许永久删除
    Cache,
    /// 系统级目标，一律需管理员 + 逐项确认
    System,
    /// 疑似邻近用户数据，一律只允许隔离
    UserAdjacent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Tier {
    L0,
    L1,
    L2,
    L3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Undo {
    /// 永久删除
    #[default]
    None,
    /// 可隔离恢复
    Quarantine,
}

/// 执行前的护栏。命中即**拒绝执行该规则**，而不是冒险（§7.4）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Guard {
    /// 有更新正在安装 / 有待重启 → 不清理。安装过程会在 `%TEMP%` 里放 MSI 的临时文件，
    /// 清掉它会让安装失败在半路。
    NotInstalling,
    /// 内容不可恢复，需单独确认一次（回收站用，P3）
    ConfirmUnrecoverable,
}

/// 删除策略。
///
/// 每个变体都必须有实现：**写了但没实现的策略会被 serde 拒绝加载**（fail-closed），
/// 而不是运行到一半才发现。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Strategy {
    /// 清空目标目录的内容，保留目录本身
    #[serde(rename_all = "camelCase")]
    PurgeContents {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        older_than_days: Option<u32>,
    },
    /// 走 Shell API 清空回收站。只与 `Target::ShellRecycleBin` 配对（校验器强约束）。
    ShellEmptyRecycleBin,
}

impl Strategy {
    pub fn retention_days(&self) -> Option<u32> {
        match self {
            Strategy::PurgeContents { older_than_days } => *older_than_days,
            Strategy::ShellEmptyRecycleBin => None,
        }
    }

    pub fn kind_str(&self) -> &'static str {
        match self {
            Strategy::PurgeContents { .. } => "purgeContents",
            Strategy::ShellEmptyRecycleBin => "shellEmptyRecycleBin",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanRule {
    pub id: String,
    pub name: String,
    pub group: Group,
    pub tier: Tier,
    pub target: Target,
    pub strategy: Strategy,
    #[serde(default)]
    pub requires_admin: bool,
    #[serde(default)]
    pub default_checked: bool,
    #[serde(default)]
    pub guard: Vec<Guard>,
    /// **不允许为空**：UI 必须把后果讲清楚才允许执行（§13.2 第 3 条）
    pub consequence: String,
    #[serde(default)]
    pub undo: Undo,
}

impl CleanRule {
    pub fn has_guard(&self, guard: Guard) -> bool {
        self.guard.contains(&guard)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleSet {
    pub schema_version: u32,
    pub rules: Vec<CleanRule>,
}

// ── 错误 ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleError {
    SchemaTooNew { found: u32, supported: u32 },
    Empty,
    Parse(String),
    Safety(SafetyError),
    BadId { id: String },
    DuplicateId { id: String },
    MissingConsequence { id: String },
    TierAuthMismatch { id: String },
    L3DefaultChecked { id: String },
    CacheMustBePermanent { id: String },
    ZeroRetention { id: String },
    ShellTargetMismatch { id: String },
    ShellMustNotBeDefaultChecked { id: String },
    ShellMustBeSystemGroup { id: String },
    ShellMustNotBeRestorable { id: String },
    TargetRejected { id: String, source: SafetyError },
    UserDataTarget { id: String, path: String },
    OutsidePurgeRoots { id: String, path: String },
}

impl std::fmt::Display for RuleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        use RuleError::*;
        match self {
            SchemaTooNew { found, supported } => write!(
                f,
                "规则表 schemaVersion={found} 高于本程序支持的 {supported}，拒绝加载\
                 （不猜测未知字段的语义）"
            ),
            Empty => write!(f, "规则表为空，拒绝加载"),
            Parse(message) => write!(f, "规则表解析失败：{message}"),
            Safety(source) => write!(f, "无法派生安全档案：{source}"),
            BadId { id } => write!(
                f,
                "规则 id `{id}` 非法：只允许小写字母、数字与连字符"
            ),
            DuplicateId { id } => write!(f, "规则 id `{id}` 重复"),
            MissingConsequence { id } => write!(
                f,
                "规则 `{id}` 的 consequence 为空：后果文案是执行前的强制告知，不允许省略"
            ),
            TierAuthMismatch { id } => write!(
                f,
                "规则 `{id}` 的级别与授权不一致：L1 不该要管理员，L2/L3 必须要"
            ),
            L3DefaultChecked { id } => write!(
                f,
                "规则 `{id}` 是 L3（不可逆）却默认勾选：不可逆操作绝不能被默认选中"
            ),
            CacheMustBePermanent { id } => write!(
                f,
                "规则 `{id}` 声明 group=cache（可再生缓存）却又说可隔离恢复：语义矛盾"
            ),
            ZeroRetention { id } => write!(
                f,
                "规则 `{id}` 的 olderThanDays 为 0：它的语义是「截止线 = 现在」即什么都删不掉，\
                 写成 0 多半是想表达「全都删」。要删全部就省略该字段。"
            ),
            ShellTargetMismatch { id } => write!(
                f,
                "规则 `{id}` 的目标与策略不配对：Shell 虚拟目标（回收站）只能配 \
                 `shellEmptyRecycleBin`，文件系统目标不能配它"
            ),
            ShellMustNotBeDefaultChecked { id } => write!(
                f,
                "规则 `{id}` 清空回收站却默认勾选：回收站里是用户删掉、但可能还想找回的东西，\
                 它不命中用户数据目录的保护，因此必须由用户显式勾选"
            ),
            ShellMustBeSystemGroup { id } => write!(
                f,
                "规则 `{id}` 是 Shell 虚拟目标，group 必须是 system —— 它不是可再生缓存"
            ),
            ShellMustNotBeRestorable { id } => write!(
                f,
                "规则 `{id}` 清空回收站却声称可恢复：我们没有回收站内容的任何副本，\
                 恢复无从谈起"
            ),
            TargetRejected { id, source } => {
                write!(f, "规则 `{id}` 的目标未通过安全闸：{source}")
            }
            UserDataTarget { id, path } => write!(
                f,
                "规则 `{id}` 的目标 {path} 落在用户数据目录之内：本工具没有任何正当理由把\
                 用户数据目录作为缓存清理目标，拒绝加载"
            ),
            OutsidePurgeRoots { id, path } => write!(
                f,
                "规则 `{id}` 的目标 {path} 不在允许清理的根之内。允许的根是一份封闭清单\
                 （见 `purge_roots()`），新增清理位置必须显式加进去，不能靠放宽判定方式。"
            ),
        }
    }
}

impl std::error::Error for RuleError {}

// ── 允许清理的根（白名单，I2）──────────────────────────────────────────

/// 允许清理的**根**，全部从 KnownFolder / 环境变量派生，没有任何字面量。
///
/// 这是白名单而非黑名单：规则只能清理这些根之下的东西。它让 `fixedPath` 这类字面路径
/// 不再危险 —— 哪怕规则文件被写坏或被篡改，也指不到 `C:\Users` 或 `%ProgramFiles%`。
///
/// **要放开新的清理位置，就在这里显式加一条**（P6 放开 `%SystemRoot%` 下的系统项时
/// 会用到），而不是把判定方式放松成"红线之外都可以"。
pub fn purge_roots() -> Result<Vec<PathBuf>, SafetyError> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !roots.iter().any(|r| super::safety::equal_ci(r, &p)) {
            roots.push(p);
        }
    };

    push(known_folder(KnownFolderId::LocalAppData)?);
    push(known_folder(KnownFolderId::RoamingAppData)?);
    // `%TEMP%` / `%TMP%` 可能被用户重定向到别处，此时它不落在上面两个根之下，
    // 必须按实际值单独作为根。
    for var in ["TEMP", "TMP"] {
        if let Ok(value) = std::env::var(var) {
            if !value.trim().is_empty() {
                push(PathBuf::from(value));
            }
        }
    }
    // `%SystemRoot%\Temp`：唯一的系统级清理目标（§5.4 的 exact_allow）
    push(known_folder(KnownFolderId::Windows)?.join("Temp"));

    Ok(roots)
}

/// 用户数据目录（§5.6 优先级 1）。解析不出来就是硬错误 ——
/// 少了这份清单，I6/I12 就无从判定，宁可不加载规则表。
fn user_data_roots() -> Result<Vec<PathBuf>, RuleError> {
    let mut out = Vec::new();
    for folder in USER_DATA_FOLDERS {
        out.push(known_folder(*folder).map_err(RuleError::Safety)?);
    }
    Ok(out)
}

// ── 校验 ────────────────────────────────────────────────────────────────

/// 校验整张规则表。任一规则不合格即整表拒绝 —— 不做"跳过坏的那条"的局部容错，
/// 那会让"规则表被篡改"这件事静默地只损失一条（§17 验收第 6 条要求保留上一份可用规则，
/// 而不是保留半张表）。
pub fn validate(set: &RuleSet, profile: &SafetyProfile) -> Result<Vec<CleanRule>, RuleError> {
    if set.schema_version > SUPPORTED_SCHEMA_VERSION {
        return Err(RuleError::SchemaTooNew {
            found: set.schema_version,
            supported: SUPPORTED_SCHEMA_VERSION,
        });
    }
    if set.rules.is_empty() {
        return Err(RuleError::Empty);
    }

    let roots = purge_roots().map_err(RuleError::Safety)?;
    let user_data = user_data_roots()?;

    let mut seen: HashSet<&str> = HashSet::new();
    for rule in &set.rules {
        validate_one(rule, profile, &roots, &user_data, &mut seen)?;
    }
    Ok(set.rules.clone())
}

fn validate_one<'a>(
    rule: &'a CleanRule,
    profile: &SafetyProfile,
    purge_roots: &[PathBuf],
    user_data: &[PathBuf],
    seen: &mut HashSet<&'a str>,
) -> Result<(), RuleError> {
    let id = || rule.id.clone();

    if rule.id.is_empty()
        || !rule
            .id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(RuleError::BadId { id: id() });
    }
    if !seen.insert(rule.id.as_str()) {
        return Err(RuleError::DuplicateId { id: id() });
    }
    if rule.consequence.trim().is_empty() {
        return Err(RuleError::MissingConsequence { id: id() });
    }

    // 级别与授权必须一致：L1 不该要管理员（要了说明分级错了），L2/L3 必须要
    if rule.requires_admin != (rule.tier != Tier::L1) {
        return Err(RuleError::TierAuthMismatch { id: id() });
    }
    if rule.tier == Tier::L3 && rule.default_checked {
        return Err(RuleError::L3DefaultChecked { id: id() });
    }
    // 可再生缓存与"可隔离恢复"语义矛盾：缓存没必要留副本
    if rule.group == Group::Cache && rule.undo != Undo::None {
        return Err(RuleError::CacheMustBePermanent { id: id() });
    }
    if matches!(rule.strategy.retention_days(), Some(0)) {
        return Err(RuleError::ZeroRetention { id: id() });
    }

    // ★ Shell 虚拟目标走单独一条通路：它**没有文件系统路径**，因此红线与允许根白名单
    //   都无从判定 —— 安全边界完全由"必须走 Shell API"这一条提供（见 `recycle_bin.rs`：
    //   绝不按文件系统路径删 `$Recycle.Bin`，那会破坏 shell 一致性且该路径本身是红线）。
    if matches!(rule.target, Target::ShellRecycleBin)
        || matches!(rule.strategy, Strategy::ShellEmptyRecycleBin)
    {
        let paired = matches!(rule.target, Target::ShellRecycleBin)
            && matches!(rule.strategy, Strategy::ShellEmptyRecycleBin);
        if !paired {
            return Err(RuleError::ShellTargetMismatch { id: id() });
        }
        if rule.default_checked {
            return Err(RuleError::ShellMustNotBeDefaultChecked { id: id() });
        }
        if rule.group != Group::System {
            return Err(RuleError::ShellMustBeSystemGroup { id: id() });
        }
        if rule.undo != Undo::None {
            return Err(RuleError::ShellMustNotBeRestorable { id: id() });
        }
        return Ok(());
    }

    // ★ 闸一原样适用：规则表无权绕过红线（I3）。这一条同时覆盖了
    //   "规则写入 <Root>\Installer" 与"规则写入被重定向的根"两种情形。
    let resolved = profile
        .resolve_and_verify(&rule.target)
        .map_err(|source| RuleError::TargetRejected { id: id(), source })?;

    // 用户数据目录：判**整条路径是否落在其下**，不只是相等（I12）
    for folder in user_data {
        if starts_with_ci(&resolved, folder) {
            return Err(RuleError::UserDataTarget {
                id: id(),
                path: resolved.display().to_string(),
            });
        }
    }

    // 白名单：必须在允许清理的根之内
    if !purge_roots.iter().any(|root| starts_with_ci(&resolved, root)) {
        return Err(RuleError::OutsidePurgeRoots {
            id: id(),
            path: resolved.display().to_string(),
        });
    }

    Ok(())
}

// ── 加载 ────────────────────────────────────────────────────────────────

/// 随包分发的内置兜底规则表。
pub fn builtin_json() -> &'static str {
    include_str!("../../resources/rules/disk-cleanup.json")
}

pub fn parse_and_validate(text: &str, profile: &SafetyProfile) -> Result<Vec<CleanRule>, RuleError> {
    let set: RuleSet = serde_json::from_str(text).map_err(|e| RuleError::Parse(e.to_string()))?;
    validate(&set, profile)
}

/// 加载生效的规则表。
///
/// 顺序：资源目录里的副本（可热更新）→ 校验通过就用它；否则退回内置表。
/// **绝不降级到空表** —— 空表会让所有清理项消失，用户会以为功能坏了（§15.3 最后一条）。
///
/// 签名校验尚未接入：规则热更新本身还没实现（§18.2 第 3 条：签名密钥体系未定）。
/// 在它落地之前，只有随包分发的那份文件会被读到，而它在安装目录内、受 ACL 保护。
pub fn load_effective(resource_dir: Option<&Path>) -> Result<Vec<CleanRule>, RuleError> {
    let profile = SafetyProfile::global().map_err(RuleError::Safety)?;

    if let Some(dir) = resource_dir {
        let path = dir.join("rules").join("disk-cleanup.json");
        if let Ok(text) = std::fs::read_to_string(&path) {
            match parse_and_validate(&text, profile) {
                Ok(rules) => return Ok(rules),
                Err(e) => {
                    crate::utils::logger::log(
                        "disk-cleanup",
                        &format!(
                            "外部规则表未通过校验，回退到内置表：{e}"
                        ),
                    );
                }
            }
        }
    }

    parse_and_validate(builtin_json(), profile)
}

// ── 护栏 ────────────────────────────────────────────────────────────────

/// 有更新正在安装 / 有待重启（§7.4 的护栏）。
///
/// 命中时**拒绝执行带 `notInstalling` 护栏的规则**，而不是冒险：更新安装过程中
/// `%TEMP%` 里可能正躺着 MSI 的临时文件，清掉它会让安装失败在半路。
///
/// 只读注册表。标准用户可读 HKLM 下这几个键。
pub fn pending_reboot() -> bool {
    const KEYS: &[&str] = &[
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootInProgress",
    ];
    KEYS.iter()
        .any(|key| registry_key_exists(HKEY_LOCAL_MACHINE, key))
}

fn registry_key_exists(root: HKEY, path: &str) -> bool {
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let mut key = HKEY::default();
        let result = RegOpenKeyExW(root, PCWSTR(wide.as_ptr()), Some(0), KEY_READ, &mut key);
        if result != ERROR_SUCCESS {
            return false;
        }
        let _ = RegCloseKey(key);
        true
    }
}

#[cfg(test)]
mod rules_test;
