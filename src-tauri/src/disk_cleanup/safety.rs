//! 三道安全闸（§6）。
//!
//! 本模块是**唯一能独立证明正确**的部分，必须先写、必须单独验证、必须有蜜罐测试。
//!
//! | 闸 | 职责 | 承载的不变量 |
//! |---|---|---|
//! | 闸一 [`SafetyProfile::verify`] | 形态拒绝 → 规范化 → 根形态 → 红线两级 → 保护文件名 → 固定卷 → 根重定向 | I2 / I3 / I4(根) / I12 |
//! | 闸二 [`super::delete`] 的逐层属性检查 | 递归永不跟随重解析点，遇链接只删链接本身 | I4(子树) |
//! | 闸三 [`super::delete`] 的容忍式删除 | 占用即跳过，不重试、不强删、不删一半 | I5 |

use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, FILETIME};
use windows::Win32::Storage::FileSystem::{
    GetDriveTypeW, GetFileAttributesExW, GetFileExInfoStandard, GetFullPathNameW, GetLongPathNameW,
    GetVolumePathNameW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_READONLY,
    FILE_ATTRIBUTE_REPARSE_POINT, INVALID_FILE_ATTRIBUTES, WIN32_FILE_ATTRIBUTE_DATA,
};

use super::target::{known_folder, KnownFolderId, Target};

/// `GetDriveTypeW` 的取值（`winnt.h`）。项目没有开
/// `Win32_System_WindowsProgramming` 特性，而这里只需要其中一个常量，
/// 因此就地声明而不是为一个数字引入整个特性模块。
const DRIVE_FIXED: u32 = 3;

/// 这些文件名**即使出现在允许目录内也必须拒绝**（防误伤与系统保护）。
const PROTECTED_FILE_NAMES: &[&str] = &[
    "pagefile.sys",
    "swapfile.sys",
    "hiberfil.sys",
    "DumpStack.log.tmp",
    "bootmgr",
    "BOOTNXT",
    "ntldr",
];

/// `%SystemRoot%` 之下**任何例外都无法放行**的子路径。
///
/// 红线一级已经让整个 `%SystemRoot%` 默认禁入（见 [`SafetyProfile::check_red_lines`]），
/// 这一层的存在是为了防止**将来往 `exact_allow` 里加一条更宽的路径**时，把 `WinSxS`、
/// `Installer` 之类顺带放行 —— `exact_allow` 对它们无效。
const WINDOWS_CRITICAL_SUBPATHS: &[&str] = &[
    "WinSxS",
    "Installer",
    "servicing",
    "assembly",
    "Microsoft.NET",
    "catroot2",
    // 整棵 System32（含 config / DriverStore）禁入，比只列子目录更稳
    "System32",
    "SysWOW64",
    "Boot",
    "Fonts",
    "inf",
    "SystemApps",
    "WinREAgent",
];

/// `%ProgramData%` 之下的同性质子路径。
const PROGRAMDATA_CRITICAL_SUBPATHS: &[&str] = &[
    "Package Cache",
    r"Microsoft\Windows Defender",
    r"Microsoft\Windows\Start Menu",
];

/// **每一块固定卷**的根下都必须禁入的目录名（见 `SafetyProfile::derive`）。
///
/// 只钉系统盘是错的：双系统、或把 Windows 装在 D 盘的机器很常见，那时
/// `D:\Windows`、`D:\System Volume Information` 一个都拦不住。
/// 不存在的一律跳过 —— 空卷上无物可删。
const VOLUME_LEVEL_RED_NAMES: &[&str] = &[
    // 系统与回滚
    "Windows",
    "Windows.old",
    r"$SysReset",
    r"$WinREAgent",
    "Recovery",
    // 备份：卷影副本与还原点。默认连列举都无权，看着像垃圾其实是备份
    "System Volume Information",
    // 每个卷的回收站目录。清空一律走 Shell API，绝不按路径删（§9.4）
    r"$Recycle.Bin",
    // 程序安装目录（非系统盘上的二次安装同样禁入）
    "Program Files",
    "Program Files (x86)",
    "ProgramData",
];

// ── 错误类型 ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SafetyError {
    // ── 运行环境派生失败（拒绝启动清理功能，I3）
    MissingEnv { name: String },
    EnvInconsistent { name: String, a: String, b: String },
    KnownFolderFailed { folder: &'static str, hr: u32 },

    // ── 目标解析（`target.rs`）
    EnvVarNotAllowed { var: String },
    EnvVarMissing { var: String },
    EnvExpansionNotSupported { text: String },
    RelativeNotAllowed { relative: String },
    NotAPathTarget,

    // ── 闸一
    NotAbsolute { path: String },
    DevicePathRejected { path: String },
    UncRejected { path: String },
    UnresolvablePath { path: String, code: u32 },
    ProtectedRoot { path: String },
    UserDataAncestor { path: String },
    RedLine { path: String, root: String },
    CriticalSubpath { path: String, sub: String },
    ProtectedFile { name: String },
    NotFixedVolume { path: String, drive_type: u32 },
    RootRedirected { path: String, component: String },
}

impl std::fmt::Display for SafetyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        use SafetyError::*;
        match self {
            MissingEnv { name } => {
                write!(f, "环境变量 {name} 缺失，无法安全地派生红线，已拒绝清理")
            }
            EnvInconsistent { name, a, b } => write!(
                f,
                "环境变量 {name} 的两个来源不一致（{a} / {b}），环境可能被污染，已拒绝清理"
            ),
            KnownFolderFailed { folder, hr } => {
                write!(f, "无法解析系统目录 {folder}（HRESULT 0x{hr:08X}）")
            }
            EnvVarNotAllowed { var } => write!(f, "环境变量 {var} 不在允许清单内"),
            EnvVarMissing { var } => write!(f, "环境变量 {var} 未设置或为空"),
            EnvExpansionNotSupported { text } => {
                write!(
                    f,
                    "目标描述 {text} 含 %，本工具不做环境展开，请改用 env 类型"
                )
            }
            RelativeNotAllowed { relative } => {
                write!(
                    f,
                    "相对子路径 {relative} 必须是纯向下的相对路径（禁止 .. / . / 绝对路径）"
                )
            }
            NotAPathTarget => write!(f, "该目标不是文件系统路径（需走 Shell API）"),
            NotAbsolute { path } => write!(f, "目标 {path} 不是绝对路径"),
            DevicePathRejected { path } => write!(
                f,
                "目标 {path} 带设备前缀（\\\\?\\ / \\\\.\\）。设备前缀会绕过 Win32 规范化，\
                 使 `..` 不被折叠，红线比对将拿到未规范化字符串，必须在规范化之前拒绝"
            ),
            UncRejected { path } => write!(f, "目标 {path} 是 UNC 网络路径，拒绝"),
            UnresolvablePath { path, code } => {
                write!(f, "无法规范化目标 {path}（Win32 错误 {code}）")
            }
            ProtectedRoot { path } => write!(f, "目标 {path} 是卷根，拒绝对卷根执行任何删除"),
            UserDataAncestor { path } => write!(
                f,
                "目标 {path} 是用户数据目录的「上级」目录（例如 C:\\Users 或用户配置文件根）。\
                 对它清空等于销毁全部个人数据，且它本身不受「用户数据目录」判定保护，因此拒绝"
            ),
            RedLine { path, root } => {
                write!(f, "目标 {path} 落在红线目录 {root} 之内，拒绝")
            }
            CriticalSubpath { path, sub } => write!(
                f,
                "目标 {path} 命中关键系统子路径 {sub}，该路径不允许任何例外放行"
            ),
            ProtectedFile { name } => write!(f, "{name} 属于系统保护文件，拒绝"),
            NotFixedVolume { path, drive_type } => write!(
                f,
                "目标 {path} 不在固定卷上（GetDriveTypeW = {drive_type}），拒绝"
            ),
            RootRedirected { path, component } => write!(
                f,
                "目标 {path} 的第 {component} 级被重定向（junction / 符号链接）到别处，\
                 白名单校验对象与实际删除对象将不一致，拒绝"
            ),
        }
    }
}

impl std::error::Error for SafetyError {}

// ── 路径工具 ────────────────────────────────────────────────────────────

/// UTF-16、NUL 结尾，供 `PCWSTR` 使用。
pub fn wide(path: &Path) -> Vec<u16> {
    let mut buf: Vec<u16> = path.as_os_str().encode_wide().collect();
    buf.push(0);
    buf
}

/// 给出参方向的长路径处理：**长度 ≥ 260 时才加** `\\?\`，且必须在规范化之后加
/// （`\\?\` 不做 `.` / `..` / 正斜杠的规范化，§7.3）。
pub fn long_path(path: &Path) -> PathBuf {
    let text = path.as_os_str().to_string_lossy();
    // 已经是设备路径（含我们自己刚加过的）就不再叠加
    if text.starts_with(r"\\?\") || text.starts_with(r"\\.\") {
        return path.to_path_buf();
    }
    let units = path.as_os_str().encode_wide().count();
    if units < 260 {
        return path.to_path_buf();
    }
    let verbatim = match text.strip_prefix(r"\\") {
        // UNC：\\server\share\... -> \\?\UNC\server\share\...
        Some(rest) => format!(r"\\?\UNC\{rest}"),
        None => format!(r"\\?\{text}"),
    };
    PathBuf::from(verbatim)
}

/// 供 Win32 调用使用的宽字符串，自动套用 [`long_path`]。
pub fn wide_long(path: &Path) -> Vec<u16> {
    wide(&long_path(path))
}

/// 按路径分隔符边界比较，**不是字符串前缀比较**。
///
/// 字符串前缀会把 `%SystemRoot%\Temporary`、`%SystemRoot%\TempTrap` 一并放行 ——
/// 一旦红线判定写成那样，红线就形同虚设。这里按组件比较，且大小写不敏感：
/// Windows 文件系统大小写不敏感，`c:\windows\system32` 与 `C:\Windows\System32`
/// 是同一个目录，大小写敏感比较会漏判。
pub fn starts_with_ci(path: &Path, root: &Path) -> bool {
    let p = path_key(path);
    let r = path_key(root);
    p.len() >= r.len() && p[..r.len()] == r[..]
}

/// 大小写不敏感的路径相等（尾部反斜杠差异忽略）。
pub fn equal_ci(a: &Path, b: &Path) -> bool {
    path_key(a) == path_key(b)
}

fn path_key(p: &Path) -> Vec<String> {
    // ★ 先剥设备前缀再比较：`\\?\C:\Windows` 与 `C:\Windows` 是**同一个目录**，
    //   不剥就会拿 `["\\?\C:", ...]` 去比 `["C:", ...]`，红线静默失配。
    //   规范化产物可能带这个前缀（`//?/...` 会被 Win32 转成 `\\?\...`），
    //   所以这层比较入口的清洗是必须的，不能只靠上游拒绝。
    let text = p.as_os_str().to_string_lossy();
    let cleaned = strip_device_prefix(&text);
    Path::new(cleaned)
        .components()
        .map(|c| match c {
            std::path::Component::Prefix(pre) => pre.as_os_str().to_string_lossy().to_uppercase(),
            other => other.as_os_str().to_string_lossy().to_uppercase(),
        })
        .collect()
}

fn trim_trailing_sep(p: PathBuf) -> PathBuf {
    if p.parent().is_none() {
        return p; // 卷根（`C:\`）保留
    }
    let text = p.as_os_str().to_string_lossy();
    let trimmed = text.trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        return p;
    }
    PathBuf::from(trimmed)
}

/// 是不是设备前缀（`\\?\` / `\\.\`）。
///
/// ★ **正斜杠写法（`//?/C:/x`）同样是设备前缀**，而且 Win32 会把它规范化成 `\\?\`。
/// 只认反斜杠的后果实测过：闸一第 2 步放行 → `GetFullPathNameW` 返回
/// `\\?\C:\Windows\System32` → 之后**所有前缀比较（红线、用户数据上级）全线失配**，
/// 闸一直接放行 System32。所以这里四种组合（两种斜杠 × 两种前缀）都要认。
fn has_device_prefix(text: &str) -> bool {
    let head: Vec<char> = text.chars().take(4).collect();
    if head.len() < 4 {
        return false;
    }
    let slash = |c: char| c == '\\' || c == '/';
    slash(head[0]) && slash(head[1]) && (head[2] == '?' || head[2] == '.') && slash(head[3])
}

/// 剥掉设备前缀，用于比较。剥不掉就原样返回。
///
/// ★ 必须与 [`has_device_prefix`] **认同一组写法**（两种斜杠 × 两种前缀）。
/// 只剥反斜杠写法的话，`path_key("//?/C:/Windows")` 会得到
/// `["//?/C:", "\\", "WINDOWS"]`，与 `["C:", "\\", "WINDOWS"]` 对不上 ——
/// 而 `path_key` 正是所有红线/祖先比较的入口，它的注释还写着"这层清洗是必须的"。
/// 当前上游会先把 `//?/` 拒掉，所以还不可达；但这层不该单独看就是坏的。
///
/// `\\?\Volume{GUID}\...` 这类剥完不成样子，但也**不会因此放行任何东西** ——
/// 它匹配不上任何红线根，属于 fail-closed 的一侧。
pub fn strip_device_prefix(text: &str) -> &str {
    for prefix in [
        r"\\?\", r"\\.\", "//?/", "//./", r"\\?/", "//?\\", r"\\./", "//.\\",
    ] {
        if let Some(rest) = text.strip_prefix(prefix) {
            return rest;
        }
    }
    text
}

fn is_unc(text: &str) -> bool {
    text.starts_with(r"\\")
}

/// `GetFullPathNameW`：折叠 `.` 与 `..`（词法折叠，不解析重解析点）。
fn get_full_path(path: &Path) -> Result<PathBuf, SafetyError> {
    let w = wide(path);
    let need = unsafe { GetFullPathNameW(PCWSTR(w.as_ptr()), None, None) };
    if need == 0 {
        return Err(SafetyError::UnresolvablePath {
            path: path.display().to_string(),
            code: std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32,
        });
    }
    let mut buf = vec![0u16; need as usize];
    let len = unsafe { GetFullPathNameW(PCWSTR(w.as_ptr()), Some(&mut buf), None) };
    if len == 0 || len as usize > buf.len() {
        return Err(SafetyError::UnresolvablePath {
            path: path.display().to_string(),
            code: std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32,
        });
    }
    buf.truncate(len as usize);
    Ok(PathBuf::from(OsString::from_wide(&buf)))
}

/// `GetLongPathNameW`：把 8.3 短名还原成长名（`PROGRA~1` → `Program Files`）。
/// **不解析重解析点**，这正是我们需要它而不是 `fs::canonicalize` 的原因 ——
/// 后者会跟随链接，那样闸一第 8 步的"根被重定向"就永远测不出来。
fn get_long_path(path: &Path) -> Result<PathBuf, SafetyError> {
    let w = wide(path);
    let need = unsafe { GetLongPathNameW(PCWSTR(w.as_ptr()), None) };
    if need == 0 {
        return Err(SafetyError::UnresolvablePath {
            path: path.display().to_string(),
            code: std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32,
        });
    }
    let mut buf = vec![0u16; need as usize];
    let len = unsafe { GetLongPathNameW(PCWSTR(w.as_ptr()), Some(&mut buf)) };
    if len == 0 || len as usize > buf.len() {
        return Err(SafetyError::UnresolvablePath {
            path: path.display().to_string(),
            code: std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32,
        });
    }
    buf.truncate(len as usize);
    Ok(PathBuf::from(OsString::from_wide(&buf)))
}

/// 规范化：折叠 `.` / `..`，并把 8.3 短名还原成长名。
///
/// ★ 8.3 展开必须**逐级向上找到第一个存在的祖先**再做，不能整条路径一把梭。
/// `GetLongPathNameW` 在路径不存在时是**整体失败**的，若就此退回词法结果，
/// `C:\PROGRA~1\<不存在的目录>` 会带着未展开的短名通过红线比对 —— 而
/// `C:\PROGRA~1` 这个前缀本身是存在的，`..` 折叠后完全可能落到系统目录上，
/// 这条路径是真实可利用的。踩过一次：`real_profile_rejects_the_8_3_short_form_
/// of_a_red_line` 用例就是这么红的。
fn normalize(path: &Path) -> Result<PathBuf, SafetyError> {
    let full = get_full_path(path)?;
    Ok(trim_trailing_sep(get_long_path_partial(&full)))
}

/// 尽量还原长名：整条路径能展开就整条展开；否则向上找到第一个可展开的祖先，
/// 展开它，再把剩下那截不存在的尾巴原样接回去。
fn get_long_path_partial(path: &Path) -> PathBuf {
    if let Ok(long) = get_long_path(path) {
        return long;
    }
    let mut tail: Vec<OsString> = Vec::new();
    let mut cur = path.to_path_buf();
    while let Some(parent) = cur.parent() {
        let Some(name) = cur.file_name() else {
            return path.to_path_buf();
        };
        tail.push(name.to_os_string());
        if let Ok(long_parent) = get_long_path(parent) {
            let mut out = long_parent;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return out;
        }
        cur = parent.to_path_buf();
    }
    path.to_path_buf()
}

/// 与 [`normalize`] 相同，但**要求路径存在**（用于红线根这类必须真实存在的路径）。
fn normalize_existing(path: &Path) -> Result<PathBuf, SafetyError> {
    let full = get_full_path(path)?;
    Ok(trim_trailing_sep(get_long_path(&full)?))
}

/// 文件属性 + 大小 + 最后写入时间，一次调用取回。
///
/// 用 `GetFileAttributesExW` 而不是 `GetFileAttributesW`：语义完全一致，但多带回大小和
/// 时间戳，删除统计不必再多一次 stat。
/// 返回 `Err(win32 code)` 表示查询失败（已消失 / 无权限）。
pub fn stat(path: &Path) -> Result<FileStat, u32> {
    let w = wide_long(path);
    let mut data = WIN32_FILE_ATTRIBUTE_DATA::default();
    let ok = unsafe {
        GetFileAttributesExW(
            PCWSTR(w.as_ptr()),
            GetFileExInfoStandard,
            &mut data as *mut _ as *mut core::ffi::c_void,
        )
    };
    if ok.is_err() {
        let code = unsafe { windows::Win32::Foundation::GetLastError() }.0;
        return Err(code);
    }
    Ok(FileStat {
        attributes: data.dwFileAttributes,
        size: ((data.nFileSizeHigh as u64) << 32) | data.nFileSizeLow as u64,
        last_write: filetime_to_u64(data.ftLastWriteTime),
    })
}

/// 只取属性。
pub fn attributes(path: &Path) -> Result<u32, u32> {
    stat(path).map(|s| s.attributes)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileStat {
    pub attributes: u32,
    pub size: u64,
    /// FILETIME（100ns since 1601-01-01）
    pub last_write: u64,
}

impl FileStat {
    pub fn is_dir(&self) -> bool {
        self.attributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0
    }
    pub fn is_reparse_point(&self) -> bool {
        self.attributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
    }
    pub fn is_readonly(&self) -> bool {
        self.attributes & FILE_ATTRIBUTE_READONLY.0 != 0
    }
}

fn filetime_to_u64(ft: FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

/// 把 `SystemTime` 换算成 FILETIME，用于"N 天前"的截止线。
pub fn unix_secs_to_filetime(unix_secs: u64) -> u64 {
    // 1601-01-01 到 1970-01-01 的秒数
    const EPOCH_DIFF_SECS: u64 = 11_644_473_600;
    (unix_secs + EPOCH_DIFF_SECS) * 10_000_000
}

/// 路径所在卷的挂载根（形如 `D:\`）。隔离区的「同卷 move」判定要用它拿**实际卷根**，
/// 而不是假设目标在系统盘（§10.1）。
pub fn volume_root(path: &Path) -> Result<PathBuf, SafetyError> {
    let w = wide_long(path);
    let mut buf = [0u16; 261];
    unsafe { GetVolumePathNameW(PCWSTR(w.as_ptr()), &mut buf) }.map_err(|e| {
        SafetyError::UnresolvablePath {
            path: path.display().to_string(),
            code: e.code().0 as u32 & 0xFFFF,
        }
    })?;
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Ok(PathBuf::from(OsString::from_wide(&buf[..len])))
}

/// 所有**固定卷**的挂载根（形如 `["C:\\", "D:\\"]`）。运行时枚举盘符得出，不写字面量。
///
/// 用于回收站（逐个卷查询/清空）—— 一次性传 NULL 让 shell 自己遍历所有卷，
/// 在某个卷上可能长时间不返回（实测 D 盘 240 秒未返回），逐卷做才能把问题隔离在单卷内。
pub fn fixed_volume_roots() -> Vec<String> {
    let mut out = Vec::new();
    for letter in b'A'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        let w = wide(Path::new(&root));
        // 卷不存在时 GetDriveTypeW 返回 DRIVE_NO_ROOT_DIR(1)，自然被下面的判断排除
        if unsafe { GetDriveTypeW(PCWSTR(w.as_ptr())) } == DRIVE_FIXED {
            out.push(root);
        }
    }
    out
}

/// 卷级红线要扫哪些卷。生产路径就是所有固定卷；用例可以把它换成自造的"卷根"，
/// 否则这条规则在任何一台真实机器上都无法被确定性地测到（谁也不会真去
/// `D:\Windows` 建东西）。
fn red_line_volumes() -> Vec<String> {
    #[cfg(test)]
    if let Some(list) = TEST_RED_VOLUMES.with(|slot| slot.borrow().clone()) {
        return list;
    }
    fixed_volume_roots()
}

#[cfg(test)]
thread_local! {
    static TEST_RED_VOLUMES: std::cell::RefCell<Option<Vec<String>>> =
        const { std::cell::RefCell::new(None) };
}

/// 用例专用：临时把"卷级红线扫哪些卷"换成自造的卷根。
#[cfg(test)]
pub fn with_red_volumes_for_tests<T>(volumes: Vec<String>, body: impl FnOnce() -> T) -> T {
    TEST_RED_VOLUMES.with(|slot| {
        let previous = slot.borrow_mut().replace(volumes);
        let out = body();
        *slot.borrow_mut() = previous;
        out
    })
}

/// 目标必须落在固定卷上（非网络盘、非可移动盘）。
fn is_fixed_volume(path: &Path) -> Result<bool, SafetyError> {
    let root = volume_root(path)?;
    let w = wide(&root);
    let drive_type = unsafe { GetDriveTypeW(PCWSTR(w.as_ptr())) };
    Ok(drive_type == DRIVE_FIXED)
}

/// 找出路径上**第一个被重定向的层级**（含最后一级）。
///
/// 这是闸一第 8 步的实现。刻意**不用** `GetFinalPathNameByHandleW` 的字符串比对：
/// 那个 API 在"卷无盘符"等情形下会返回 `\\?\Volume{GUID}\...`，比对结果取决于环境
/// 而非事实。逐级查 `FILE_ATTRIBUTE_REPARSE_POINT` 是确定性的 ——
/// 任何一级是 junction / 符号链接都逃不掉。
///
/// ★ **"读不到"与"不存在"必须分开**：
/// - 不存在（FILE_NOT_FOUND / PATH_NOT_FOUND）→ `Ok(None)`。目标根本删不掉，
///   没有可利用的缺口。
/// - **其它错误（ACCESS_DENIED 等）→ 拒绝**。原来一律 `Ok(None)` 放行，而循环是
///   从卷根往目标走，浅层一出错就 `return` —— **连目标自身那一层的重解析检查也跳过**。
///   于是"某级祖先读不到属性、但它下面的目标仍可打开"时，目标若是 junction，
///   这一步会放行，`purge_contents` 就会**穿过**它枚举并删掉目标盘的内容。
///   这正是第 8 步存在的理由，fail-closed 是唯一站得住的立场。
fn find_reparse_component(path: &Path) -> Result<Option<PathBuf>, SafetyError> {
    let ancestors: Vec<&Path> = path.ancestors().collect();
    for ancestor in ancestors.into_iter().rev() {
        // 卷根自身不可能是重定向
        if ancestor.parent().is_none() {
            continue;
        }
        match attributes(ancestor) {
            Ok(attrs) if attrs & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 => {
                return Ok(Some(ancestor.to_path_buf()));
            }
            Ok(_) => {}
            Err(code) if code == ERROR_FILE_NOT_FOUND.0 || code == ERROR_PATH_NOT_FOUND.0 => {
                // 这一层不存在 → 它下面的目标也不存在 → 没有可删的东西
                return Ok(None);
            }
            Err(code) => {
                return Err(SafetyError::UnresolvablePath {
                    path: ancestor.display().to_string(),
                    code,
                });
            }
        }
    }
    Ok(None)
}

// ── 红线（运行时派生，I3）──────────────────────────────────────────────

/// 派生红线所需的全部外部输入。
///
/// 生产环境来自进程环境变量 + KnownFolder；测试可以构造任意一套 ——
/// §15.2 要求闸一用例必须在"系统盘为 `C:`"与"系统盘为 `D:`"两套环境下各跑一遍，
/// 因此这层间接是必需的，不是为测试而测试。
#[derive(Debug, Clone)]
pub struct SafetyEnv {
    pub system_root: PathBuf,
    pub windir: PathBuf,
    pub program_files: PathBuf,
    pub program_files_x86: Option<PathBuf>,
    pub program_data: PathBuf,
    /// 形如 `C:\`
    pub system_drive: PathBuf,
    /// 用户配置文件根（`FOLDERID_Profile`）
    pub profile: PathBuf,
}

impl SafetyEnv {
    /// 从当前进程环境派生。
    ///
    /// `SystemRoot` 是进程环境变量，标准用户可以在自己的环境里覆盖它 ——
    /// 只信环境变量等于把红线交给用户输入。因此这里用 `FOLDERID_Windows` 做交叉校验，
    /// 不一致就拒绝启动清理功能（§5.4 的"交叉校验"，I3）。
    pub fn from_process() -> Result<Self, SafetyError> {
        let system_root = env_path("SystemRoot")?;
        let windir = env_path("windir")?;
        let windows_folder = known_folder(KnownFolderId::Windows)?;
        check_env_consistency(&system_root, &windir, &windows_folder)?;

        let system_drive = env_path("SystemDrive")?;
        let mut system_drive_root = system_drive;
        if !system_drive_root
            .as_os_str()
            .to_string_lossy()
            .ends_with('\\')
        {
            system_drive_root.push("\\");
        }

        Ok(Self {
            system_root,
            windir,
            program_files: env_path("ProgramFiles")?,
            // ★ 空串要当**不存在**，不能当路径。`GetFullPathNameW("")` 会以
            //   ERROR_INVALID_NAME(123) 失败，而 `derive` 里这一条是带 `?` 的 ——
            //   于是一台把 `ProgramFiles(x86)` 置成空串的机器上，`derive` 整体失败、
            //   `SafetyProfile::global()` 拿不到档案，**整个清理功能不可用**，
            //   用户看到的还是"无法规范化目标 （Win32 错误 123）"这种看不出原因的话。
            //   这是可选变量，解析不出来就该按"没有 x86 目录"处理（同卷级红线的口径）。
            program_files_x86: std::env::var("ProgramFiles(x86)")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
            program_data: env_path("ProgramData")?,
            system_drive: system_drive_root,
            profile: known_folder(KnownFolderId::Profile)?,
        })
    }
}

/// 红线来源的交叉校验（§5.4）。
///
/// 为什么要这一步：`SystemRoot` 只是一个**进程环境变量**，标准用户可以在自己的环境里
/// 覆盖它（`set SystemRoot=D:\fake`）。只信环境变量，等于把红线交给用户输入 ——
/// 三处来源互相印证之后，污染环境这条路才被堵死。
fn check_env_consistency(
    system_root: &Path,
    windir: &Path,
    windows_folder: &Path,
) -> Result<(), SafetyError> {
    if !equal_ci(system_root, windir) {
        return Err(SafetyError::EnvInconsistent {
            name: "SystemRoot / windir".into(),
            a: system_root.display().to_string(),
            b: windir.display().to_string(),
        });
    }
    if !equal_ci(system_root, windows_folder) {
        return Err(SafetyError::EnvInconsistent {
            name: "SystemRoot / FOLDERID_Windows".into(),
            a: system_root.display().to_string(),
            b: windows_folder.display().to_string(),
        });
    }
    Ok(())
}

fn env_path(name: &str) -> Result<PathBuf, SafetyError> {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => Ok(PathBuf::from(v)),
        _ => Err(SafetyError::MissingEnv { name: name.into() }),
    }
}

/// 已派生的安全档案。进程启动时构造一次。
#[derive(Debug)]
pub struct SafetyProfile {
    env: SafetyEnv,
    /// 一级红线：落在其下即拒绝（`exact_allow` 是唯一例外，`critical` 连例外也挡）
    red_roots: Vec<PathBuf>,
    /// `red_roots` 的**预计算键**，与它一一对应。
    ///
    /// ★ 红线检查是全盘扫描的热路径（**每个目录一次**），而 `path_key` 每次都要
    /// 分配一个 `Vec<String>`。卷级红线扩展到所有固定卷之后根的数量涨了好几倍，
    /// 不预计算的话一趟 4 万目录的扫描要白白分配上百万次。
    red_keys: Vec<Vec<String>>,
    /// 红线之内唯一允许精确命中的路径。**必须精确匹配，绝不前缀匹配** ——
    /// 否则 `%SystemRoot%\Temporary`、`%SystemRoot%\TempTrap` 会被一并放行。
    exact_allow: Vec<PathBuf>,
    /// 二级红线：`exact_allow` 也覆盖不了
    critical: Vec<PathBuf>,
    /// 用户数据目录的**上级**目录（`C:\Users`、`C:\Users\me`）—— 精确匹配，不是前缀
    user_data_ancestors: Vec<PathBuf>,
}

static GLOBAL: OnceLock<Result<SafetyProfile, SafetyError>> = OnceLock::new();

impl SafetyProfile {
    /// 进程级单例。派生失败会被缓存并反复返回同一个错误（fail-closed：
    /// 派生不出红线就**不做任何清理**，而不是退化成没有红线）。
    pub fn global() -> Result<&'static SafetyProfile, SafetyError> {
        GLOBAL
            .get_or_init(|| SafetyProfile::from_process())
            .as_ref()
            .map_err(|e| e.clone())
    }

    pub fn from_process() -> Result<Self, SafetyError> {
        Self::derive(SafetyEnv::from_process()?)
    }

    pub fn env(&self) -> &SafetyEnv {
        &self.env
    }

    /// 以下三个访问器目前只有闸一用例在用（用来断言"红线跟着 env 走"）——
    /// 它们是诊断面，不是生产路径，因此按测试专用标注，避免将来被误当成 API 依赖。
    #[cfg(test)]
    pub fn red_roots(&self) -> &[PathBuf] {
        &self.red_roots
    }

    #[cfg(test)]
    pub fn exact_allow(&self) -> &[PathBuf] {
        &self.exact_allow
    }

    #[cfg(test)]
    pub fn critical(&self) -> &[PathBuf] {
        &self.critical
    }

    /// 从一套环境派生红线。**没有任何字面量盘符** —— 这正是 I3 的落地方式。
    pub fn derive(env: SafetyEnv) -> Result<Self, SafetyError> {
        // 手工拼出来的 env 也必须自洽：`from_process` 有 FOLDERID_Windows 做交叉校验，
        // 而直接构造 `SafetyEnv` 会绕过它（测试、以及将来可能的"用户指定系统盘"都走这条路），
        // 所以这道检查必须落在 derive 里，而不是只留在 from_process。
        if !equal_ci(&env.system_root, &env.windir) {
            return Err(SafetyError::EnvInconsistent {
                name: "system_root / windir".into(),
                a: env.system_root.display().to_string(),
                b: env.windir.display().to_string(),
            });
        }

        let mut red_roots = vec![
            normalize_existing(&env.system_root)?,
            normalize_existing(&env.program_files)?,
            normalize_existing(&env.program_data)?,
        ];
        if let Some(x86) = &env.program_files_x86 {
            // ★ 解析不出来就跳过，**不要用 `?`**。`program_files_x86` 是可选目录：
            //   一台没有 x86 程序目录的机器（或变量指向已消失的路径）不该让整个
            //   安全档案派生失败 —— 那等于让清理功能整块不可用，而这里少一条红根
            //   的后果只是"少保护一个不存在的目录"。同函数下面的卷级循环就是这个口径。
            if let Ok(p) = normalize_existing(x86) {
                red_roots.push(p);
            }
        }
        // 卷级路径：$Recycle.Bin / $SysReset / Recovery 挂在 %SystemDrive% 下。
        // 可能不存在（全新卷），不存在则无物可删，跳过是安全的。
        for name in [r"$Recycle.Bin", r"$SysReset", "Recovery"] {
            if let Ok(p) = normalize_existing(&env.system_drive.join(name)) {
                red_roots.push(p);
            }
        }

        // ★ **每一块固定卷**上的系统级目录同样禁入，不只系统盘。
        //
        // 只钉系统盘是个真实缺口：双系统、或把 Windows 装在 D 盘的机器很常见，
        // 而规则目标与占用发现给出的路径完全可能落在 `D:\Windows`、
        // `D:\$Recycle.Bin` 或 `D:\System Volume Information` 上 —— 那时上面那三行
        // 一个都拦不住。系统盘上的同名目录已在上面的红根里，重复一条是无害的。
        //
        // 逐条说明为什么这几类必须禁入：
        // - `System Volume Information`：卷影副本与还原点。删它 = 删掉全部系统还原点，
        //   而且它默认连列目录都无权，属于"看着像垃圾、其实是备份"
        // - `$WinREAgent`：升级/恢复留下的工作目录，删到一半的升级会卡死
        // - `Windows` / `Windows.old`：一个操作系统安装 / 它的回滚备份
        // - `Program Files` / `Program Files (x86)` / `ProgramData`：程序安装目录
        //
        // 代价是"某块盘上恰好叫这个名字的用户目录也清不了"。这个代价是**正确方向**：
        // 拒绝对用户可见、可解释，而少拦一个的后果不可逆。
        for volume in red_line_volumes() {
            let root = PathBuf::from(&volume);
            for name in VOLUME_LEVEL_RED_NAMES {
                if let Ok(p) = normalize_existing(&root.join(name)) {
                    red_roots.push(p);
                }
            }
        }

        // `%SystemRoot%\Temp` 是唯一需要放行的系统级清理目标（§5.4）。
        // 同样派生，不写字面量；解析不出来就不放行（fail-closed）。
        let exact_allow = [env.system_root.join("Temp")]
            .into_iter()
            .filter_map(|p| normalize_existing(&p).ok())
            .collect();

        let mut critical = Vec::new();
        for rel in WINDOWS_CRITICAL_SUBPATHS {
            if let Ok(p) = normalize_existing(&env.system_root.join(rel)) {
                critical.push(p);
            }
        }
        for rel in PROGRAMDATA_CRITICAL_SUBPATHS {
            if let Ok(p) = normalize_existing(&env.program_data.join(rel)) {
                critical.push(p);
            }
        }

        // 用户数据目录的上级目录：`C:\Users`、`C:\Users\<me>`。
        // 它们既不是红线根（否则 %LOCALAPPDATA% 下的缓存全清不了），
        // 也不是"用户数据目录"本身（§5.6 优先级 1 管不到它们），
        // 但对它们执行清空等于销毁全部个人数据 —— 必须单独拒绝，且只做精确匹配。
        let mut user_data_ancestors = Vec::new();
        if let Some(users_root) = env.profile.parent() {
            if let Ok(p) = normalize_existing(users_root) {
                user_data_ancestors.push(p);
            }
        }
        if let Ok(p) = normalize_existing(&env.profile) {
            user_data_ancestors.push(p);
        }

        // 键只算一次：`red_roots` 是进程级不变的
        let red_keys: Vec<Vec<String>> = red_roots.iter().map(|root| path_key(root)).collect();

        Ok(Self {
            env,
            red_roots,
            red_keys,
            exact_allow,
            critical,
            user_data_ancestors,
        })
    }

    /// 红线判定结果。
    pub fn check_red_lines(&self, path: &Path) -> Result<(), SafetyError> {
        let text = || path.display().to_string();

        // 二级优先：命中关键子路径时**没有任何例外**
        for sub in &self.critical {
            if starts_with_ci(path, sub) {
                return Err(SafetyError::CriticalSubpath {
                    path: text(),
                    sub: sub.display().to_string(),
                });
            }
        }

        // 一级：红线根之下，只有 exact_allow 能开洞。两级都必须做 ——
        // 只做一级会把 %SystemRoot%\Temp 一起保护掉；只做二级会漏掉整个 %ProgramFiles%
        // （它没有关键子路径，等于完全放行）。
        //
        // 待查路径的键在循环外算一次；根的键在 `derive` 里就算好了（见 `red_keys`）。
        let key = path_key(path);
        for (root, root_key) in self.red_roots.iter().zip(&self.red_keys) {
            if key.len() < root_key.len() || key[..root_key.len()] != root_key[..] {
                continue;
            }
            // 只在前缀命中的极少数情况下才去比对例外表（那是慢路径）
            if self.exact_allow.iter().any(|a| starts_with_ci(path, a)) {
                return Ok(());
            }
            return Err(SafetyError::RedLine {
                path: text(),
                root: root.display().to_string(),
            });
        }
        Ok(())
    }

    fn is_user_data_ancestor(&self, path: &Path) -> bool {
        self.user_data_ancestors.iter().any(|a| equal_ci(a, path))
    }

    /// 闸一：任何进入删除引擎的路径都必须先过这里。
    ///
    /// 步骤顺序本身是安全属性，不能重排 —— 尤其是第 2 步必须在第 3 步之前。
    pub fn verify(&self, raw: &Path) -> Result<PathBuf, SafetyError> {
        let raw_text = raw.as_os_str().to_string_lossy().into_owned();

        // 1. 相对路径直接拒绝：删除引擎的输入必须是绝对路径
        if !raw.is_absolute() {
            return Err(SafetyError::NotAbsolute { path: raw_text });
        }

        // 2. ★ 形态拒绝必须在规范化之前。`\\?\` 会绕过 Win32 规范化：若不先拒绝，
        //    `\\?\D:\Windows\Temp\..\System32` 里的 `..` 不会被折叠，后续红线比对
        //    拿到的是未规范化的字符串，红线可能失配。UNC 同理（会删到网络位置）。
        //    注意这里检查的是**入参原文**，不是套了 `long_path()` 之后的形态 ——
        //    出参方向加前缀是我们自己的动作，不能反过来把自己判成设备路径。
        if has_device_prefix(&raw_text) {
            return Err(SafetyError::DevicePathRejected { path: raw_text });
        }
        if is_unc(&raw_text) {
            return Err(SafetyError::UncRejected { path: raw_text });
        }

        // 3. 展开 `..` 与 8.3 短名（D:\PROGRA~1 必须还原成长名再比较）
        let normalized = normalize(raw)?;

        // 3.5 ★ 规范化之后**再查一次**设备前缀。`GetFullPathNameW` 会把 `//?/C:/x`
        //     规范化成 `\\?\C:\x` —— 第 2 步认不出正斜杠写法时，产物会带着设备前缀
        //     一路走到红线比对，而那时所有前缀比较都已经失配了。这里逐条实测复现过。
        if has_device_prefix(&normalized.as_os_str().to_string_lossy()) {
            return Err(SafetyError::DevicePathRejected {
                path: normalized.display().to_string(),
            });
        }

        // 4. 根形态拒绝。
        //
        // ★ 判据不能只有 `parent().is_none()` —— 那**只认盘符根**（`C:\`）。
        //   挂在文件夹上的卷（`C:\Mount\Data\`）parent 是 `C:\Mount`，形态判定不成立；
        //   而 `fixed_volume_roots()` 也只枚举 A:–Z:，所以这种卷根既拿不到卷级红线，
        //   又躲过这一条 —— 闸一全绿之后 `purge_contents` 会清空**整块卷**。
        //   改成"它自己就是所在卷的挂载根"，两种形态一起覆盖。
        let mount_root = volume_root(&normalized)?;
        if normalized.parent().is_none() || equal_ci(&normalized, &mount_root) {
            return Err(SafetyError::ProtectedRoot {
                path: normalized.display().to_string(),
            });
        }
        if self.is_user_data_ancestor(&normalized) {
            return Err(SafetyError::UserDataAncestor {
                path: normalized.display().to_string(),
            });
        }

        // 5. 红线两级校验（按路径分隔符边界，不用字符串 StartsWith）
        self.check_red_lines(&normalized)?;

        // 6. 保护文件名
        if let Some(name) = normalized.file_name() {
            let name = name.to_string_lossy();
            if PROTECTED_FILE_NAMES
                .iter()
                .any(|p| name.eq_ignore_ascii_case(p))
            {
                return Err(SafetyError::ProtectedFile {
                    name: name.into_owned(),
                });
            }
        }

        // 7. ★ 必须是固定卷（非网络盘、非可移动盘）
        if !is_fixed_volume(&normalized)? {
            let drive_type = drive_type_of(&normalized);
            return Err(SafetyError::NotFixedVolume {
                path: normalized.display().to_string(),
                drive_type,
            });
        }

        // 8. ★ 根身份检查：只覆盖"根这一层是否被重定向"；遍历过程中每一层由闸二负责。
        //    两者互补、缺一不可 —— 不存在"唯一的 junction 防线"。
        if let Some(component) = find_reparse_component(&normalized)? {
            return Err(SafetyError::RootRedirected {
                path: normalized.display().to_string(),
                component: component.display().to_string(),
            });
        }

        Ok(normalized)
    }
}

fn drive_type_of(path: &Path) -> u32 {
    let Ok(root) = volume_root(path) else {
        return INVALID_FILE_ATTRIBUTES;
    };
    let w = wide(&root);
    unsafe { GetDriveTypeW(PCWSTR(w.as_ptr())) }
}

impl SafetyProfile {
    pub fn resolve_and_verify(&self, target: &Target) -> Result<PathBuf, SafetyError> {
        let raw = super::target::resolve_target(target)?;
        self.verify(&raw)
    }
}

/// 用例放在**独立文件**里，不在本文件内联 `mod tests {}`：这样本文件从头到尾都是
/// 生产代码，「红线不得出现盘符字面量」的源码守卫可以整文件扫描，不需要按
/// `#[cfg(test)]` 截断（截断会在文件后半段还有生产代码时失明）。
///
/// 文件名遵循 Rust 2018 的模块路径约定（`safety.rs` 的子模块在 `safety/` 下），
/// 而不是用 `#[path]` 平铺 —— `utils::process` 的
/// `scan_skips_only_known_test_only_module_files` 守卫就是按这个约定推导
/// 「整体只在测试下编译」的文件路径的，平铺会让它推导出一个不存在的路径、失去效力。
#[cfg(test)]
mod safety_test;
