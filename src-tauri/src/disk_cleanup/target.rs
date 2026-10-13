//! 规则目标（`target` 字段）的解析：把声明式目标描述变成一条**绝对路径**。
//!
//! §5.3 的硬要求：**不用字符串拼 `%LOCALAPPDATA%`**。用户配置重定向、OneDrive 接管
//! 桌面时这些目录根本不在系统盘，拼字符串必然找错地方 —— 因此 `knownFolder` 一律走
//! `SHGetKnownFolderPath`，`env` 只允许引用一个封闭的白名单变量。

use std::cell::Cell;
use std::ffi::c_void;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use windows::core::GUID;
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{
    SHGetKnownFolderPath, FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads,
    FOLDERID_LocalAppData, FOLDERID_Music, FOLDERID_Pictures, FOLDERID_Profile,
    FOLDERID_ProgramData, FOLDERID_RoamingAppData, FOLDERID_Videos, FOLDERID_Windows,
    KF_FLAG_DEFAULT,
};

use super::safety::SafetyError;

/// `env` 类目标允许引用的环境变量。**白名单而非黑名单**：未列出的变量名一律拒绝，
/// 与 I2 的 fail-closed 一致。
pub const ALLOWED_ENV_VARS: &[&str] = &[
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "APPDATA",
    "PROGRAMDATA",
    "SYSTEMROOT",
];

/// 用户数据目录（§5.6 优先级 1）。这些目录及其子路径**永久删除的代码路径不存在**。
pub const USER_DATA_FOLDERS: &[KnownFolderId] = &[
    KnownFolderId::Documents,
    KnownFolderId::Downloads,
    KnownFolderId::Desktop,
    KnownFolderId::Pictures,
    KnownFolderId::Videos,
    KnownFolderId::Music,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KnownFolderId {
    LocalAppData,
    RoamingAppData,
    ProgramData,
    Profile,
    Documents,
    Downloads,
    Desktop,
    Pictures,
    Videos,
    Music,
    /// 系统目录。不作为清理目标的常规来源，是 `exact_allow`（§5.4）的派生依据。
    Windows,
}

impl KnownFolderId {
    pub fn guid(self) -> &'static GUID {
        match self {
            Self::LocalAppData => &FOLDERID_LocalAppData,
            Self::RoamingAppData => &FOLDERID_RoamingAppData,
            Self::ProgramData => &FOLDERID_ProgramData,
            Self::Profile => &FOLDERID_Profile,
            Self::Documents => &FOLDERID_Documents,
            Self::Downloads => &FOLDERID_Downloads,
            Self::Desktop => &FOLDERID_Desktop,
            Self::Pictures => &FOLDERID_Pictures,
            Self::Videos => &FOLDERID_Videos,
            Self::Music => &FOLDERID_Music,
            Self::Windows => &FOLDERID_Windows,
        }
    }

    /// 用于错误信息与审计日志的稳定名字。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LocalAppData => "localAppData",
            Self::RoamingAppData => "roamingAppData",
            Self::ProgramData => "programData",
            Self::Profile => "profile",
            Self::Documents => "documents",
            Self::Downloads => "downloads",
            Self::Desktop => "desktop",
            Self::Pictures => "pictures",
            Self::Videos => "videos",
            Self::Music => "music",
            Self::Windows => "windows",
        }
    }
}

/// 规则表中的 `target` 字段（§5.3 的四种子类）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    /// `SHGetKnownFolderPath` + 相对子路径
    KnownFolder {
        folder: KnownFolderId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        relative: Option<String>,
    },
    /// 展开白名单环境变量 + 固定子路径
    Env {
        var: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        relative: Option<String>,
    },
    /// 字面绝对路径。**必须通过红线校验**，且规则校验器对其有额外约束（P2）。
    FixedPath { path: String },
    /// 虚拟目标：只能走 Shell API（`SHEmptyRecycleBin`），不可有 `relative`。
    ShellRecycleBin,
}

/// 解析目标为一条绝对路径。
///
/// 注意本函数**不做任何安全校验** —— 它只是把声明变成路径。安全校验是
/// [`super::safety::resolve_and_verify`] 的职责，两步刻意分开：
/// 「解析」依赖规则数据模型，「校验」是安全模块的独立命题。
pub fn resolve_target(target: &Target) -> Result<PathBuf, SafetyError> {
    match target {
        Target::KnownFolder { folder, relative } => {
            let base = known_folder(*folder)?;
            join_relative(base, relative.as_deref())
        }
        Target::Env { var, relative } => {
            if !ALLOWED_ENV_VARS.iter().any(|v| v.eq_ignore_ascii_case(var)) {
                return Err(SafetyError::EnvVarNotAllowed { var: var.clone() });
            }
            // 用 var 的原样大小写去查（Windows 环境变量名不区分大小写），
            // 但错误信息里保留规则作者写的那个名字。
            let value = std::env::var(var)
                .or_else(|_| {
                    ALLOWED_ENV_VARS
                        .iter()
                        .find(|v| v.eq_ignore_ascii_case(var))
                        .and_then(|v| std::env::var(v).ok())
                        .ok_or(())
                })
                .map_err(|_| SafetyError::EnvVarMissing { var: var.clone() })?;
            if value.is_empty() {
                return Err(SafetyError::EnvVarMissing { var: var.clone() });
            }
            join_relative(PathBuf::from(value), relative.as_deref())
        }
        Target::FixedPath { path } => {
            reject_env_expansion(path)?;
            Ok(PathBuf::from(path))
        }
        Target::ShellRecycleBin => Err(SafetyError::NotAPathTarget),
    }
}

/// `relative` 必须是**纯向下的相对子路径**：禁止绝对路径、禁止 `..`、禁止 `.`。
/// §5.3：「禁止通配符跨越用户目录，禁止相对路径穿越」。
fn join_relative(base: PathBuf, relative: Option<&str>) -> Result<PathBuf, SafetyError> {
    let Some(rel) = relative else {
        return Ok(base);
    };
    if rel.is_empty() {
        return Ok(base);
    }
    reject_env_expansion(rel)?;
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err(SafetyError::RelativeNotAllowed { relative: rel.to_string() });
    }
    for comp in rel_path.components() {
        match comp {
            Component::Normal(_) => {}
            // `..` / `.` / 盘符 / 根 / UNC —— 一律拒绝，不给"看起来无害"的中间态留口子
            _ => {
                return Err(SafetyError::RelativeNotAllowed { relative: rel.to_string() });
            }
        }
    }
    Ok(base.join(rel_path))
}

/// 目标描述里出现 `%` 一律拒绝：`Path::join` 与环境展开后的 Win32 调用都**不会**展开
/// `%VAR%`，放行只会让规则作者以为它生效了。fail-closed。
fn reject_env_expansion(text: &str) -> Result<(), SafetyError> {
    if text.contains('%') {
        return Err(SafetyError::EnvExpansionNotSupported { text: text.to_string() });
    }
    Ok(())
}

thread_local! {
    /// 本线程是否已经尝试过 COM 初始化。`SHGetKnownFolderPath` 在部分 KnownFolder 上
    /// 会走 `SHCoCreateInstance`，从工作线程调用时先确保 COM 可用。
    static COM_READY: Cell<bool> = const { Cell::new(false) };
}

/// 本线程是否已经尝试过 COM 初始化。`SHGetKnownFolderPath` 在部分 KnownFolder 上
/// 会走 `SHCoCreateInstance`，从工作线程调用时先确保 COM 可用。
///
/// `recycle_bin.rs` 的 Shell API 同样需要它 —— 在未初始化 COM 的线程上调用
/// Shell 函数会返回 `CO_E_NOTINITIALIZED`，某些实现还会在内部反复重试。
pub(crate) fn ensure_com_initialized() {
    COM_READY.with(|ready| {
        if ready.get() {
            return;
        }
        // ★ **只把成功缓存下来。** 原来不论成败都 `ready.set(true)`：一次偶发失败
        //   （例如初始化期间别的初始化正在收尾）会被记成"已经就绪"，此后这个线程上
        //   所有 `SHGetKnownFolderPath` / Shell 调用全都失败，而且**再也不会重试** ——
        //   表现是"用户数据目录解析不出来"，而 `is_user_data_path` 要靠它。
        //
        // `RPC_E_CHANGED_MODE` 要当成功：它表示本线程已按别的套间模型初始化过，
        // 那同样可用，重试只会一直拿到同一个 HRESULT。
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        let ok = hr.is_ok() || hr == RPC_E_CHANGED_MODE;
        if ok {
            // 线程退出时系统会回收，不需要配对的 CoUninitialize
            ready.set(true);
        }
    });
}

/// `SHGetKnownFolderPath` 的薄封装。返回值由 COM 分配，必须 `CoTaskMemFree`。
pub fn known_folder(folder: KnownFolderId) -> Result<PathBuf, SafetyError> {
    ensure_com_initialized();
    unsafe {
        let pw = SHGetKnownFolderPath(folder.guid(), KF_FLAG_DEFAULT, None).map_err(|e| {
            SafetyError::KnownFolderFailed {
                folder: folder.as_str(),
                hr: e.code().0 as u32,
            }
        })?;
        let text = pw.to_string().unwrap_or_default();
        CoTaskMemFree(Some(pw.0 as *const c_void));
        if text.is_empty() {
            return Err(SafetyError::KnownFolderFailed {
                folder: folder.as_str(),
                hr: 0,
            });
        }
        Ok(PathBuf::from(text))
    }
}
