//! 闸一（§6.1）的用例表。
//!
//! **约束：本模块不得出现盘符字面量**（如 `C:\Windows`）。所有断言都必须以
//! 「从 `SafetyEnv` 派生出来的根」为参数 —— 否则测试本身就在强化 §5.4 修掉的那个
//! 硬编码缺陷：用例在开发机（系统盘恰好是 `C:`）全绿，到别人机器上全部失效。

use super::*;
use crate::disk_cleanup::target::{resolve_target, KnownFolderId, Target};
use std::ffi::OsString;
use std::fs;
use std::os::windows::ffi::OsStringExt;
use windows::Win32::Storage::FileSystem::GetShortPathNameW;

// ── 夹具 ────────────────────────────────────────────────────────────────

/// 一套完整的"系统盘"布局。
///
/// `volume_root` 是真实卷根（`C:\` / `D:\`），`base` 是它下面的临时实验目录。
/// 之所以不把卷根直接当系统根：那需要管理员权限，而且会污染真实系统目录。
struct Fixture {
    volume_root: PathBuf,
    base: PathBuf,
    profile: SafetyProfile,
    windows: PathBuf,
    program_files: PathBuf,
    program_data: PathBuf,
    users: PathBuf,
    me: PathBuf,
}

fn build(volume_root: PathBuf, tag: &str) -> Option<Fixture> {
    let base = volume_root.join(format!("levitaire-gate1-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);

    let windows = base.join("Windows");
    let program_files = base.join("Program Files");
    let program_data = base.join("ProgramData");
    let users = base.join("Users");
    let me = users.join("me");

    for dir in [
        windows.join("Temp"),
        windows.join("Temporary"),
        windows.join("TempTrap"),
        windows.join("WinSxS"),
        windows.join("Installer"),
        windows.join("System32").join("config"),
        windows.join("System32").join("DriverStore"),
        program_files.join("SomeApp"),
        program_data.join("Package Cache"),
        program_data.join("Microsoft").join("Windows Defender"),
        me.join("AppData").join("Local").join("Temp"),
    ] {
        // 卷根可能不允许普通用户建目录（策略收紧的机器）——那时跳过，不要让用例变红
        if fs::create_dir_all(&dir).is_err() {
            let _ = fs::remove_dir_all(&base);
            eprintln!("无法在 {} 下建实验目录，跳过", volume_root.display());
            return None;
        }
    }

    let profile = SafetyProfile::derive(SafetyEnv {
        system_root: windows.clone(),
        windir: windows.clone(),
        program_files: program_files.clone(),
        program_files_x86: None,
        program_data: program_data.clone(),
        system_drive: base.clone(),
        profile: me.clone(),
    })
    .expect("红线派生失败");

    Some(Fixture {
        volume_root,
        base,
        profile,
        windows,
        program_files,
        program_data,
        users,
        me,
    })
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn reject(f: &Fixture, path: PathBuf) -> SafetyError {
    match f.profile.verify(&path) {
        Ok(normalized) => panic!(
            "{} 应被拒绝，实际放行（规范化为 {}）",
            path.display(),
            normalized.display()
        ),
        Err(e) => e,
    }
}

fn allow(f: &Fixture, path: PathBuf) -> PathBuf {
    f.profile
        .verify(&path)
        .unwrap_or_else(|e| panic!("{} 应被放行，实际被拒绝：{e}", path.display()))
}

/// 找一个**非系统盘**的固定卷根，用于把用例参数化到"系统盘不是 `C:`"的情形。
/// 找不到就跳过那一半 —— 不硬编码盘符。
fn other_fixed_volume() -> Option<PathBuf> {
    for letter in b'D'..=b'Z' {
        let root = PathBuf::from(format!("{}:\\", letter as char));
        let w = wide(&root);
        let mut buf = [0u16; 261];
        if unsafe { GetVolumePathNameW(PCWSTR(w.as_ptr()), &mut buf) }.is_err() {
            continue;
        }
        if unsafe { GetDriveTypeW(PCWSTR(buf.as_ptr())) } == DRIVE_FIXED {
            return Some(root);
        }
    }
    None
}

fn short_path_name(path: &Path) -> Option<PathBuf> {
    let w = wide(path);
    let need = unsafe { GetShortPathNameW(PCWSTR(w.as_ptr()), None) };
    if need == 0 {
        return None;
    }
    let mut buf = vec![0u16; need as usize];
    let len = unsafe { GetShortPathNameW(PCWSTR(w.as_ptr()), Some(&mut buf)) };
    if len == 0 || len as usize > buf.len() {
        return None;
    }
    buf.truncate(len as usize);
    Some(PathBuf::from(OsString::from_wide(&buf)))
}

// ── 闸一：完整用例表，跑在两套不同的"系统盘"布局上 ──────────────────────

fn run_gate1_table(f: &Fixture) {
    let w = &f.windows;

    // 规范化在红线判定**之前**：`..` 必须先被折叠
    assert!(matches!(
        reject(f, w.join("Temp").join("..").join("System32")),
        SafetyError::CriticalSubpath { .. }
    ));

    // 边界匹配：精确例外绝不能前缀匹配
    assert!(matches!(
        reject(f, w.join("Temporary")),
        SafetyError::RedLine { .. }
    ));
    assert!(matches!(
        reject(f, w.join("TempTrap")),
        SafetyError::RedLine { .. }
    ));
    // 精确例外本身放行
    allow(f, w.join("Temp"));

    // 二级红线：连 exact_allow 都覆盖不了的关键子路径
    assert!(matches!(
        reject(f, w.join("WinSxS")),
        SafetyError::CriticalSubpath { .. }
    ));
    assert!(matches!(
        reject(f, w.join("Installer")),
        SafetyError::CriticalSubpath { .. }
    ));
    assert!(matches!(
        reject(f, w.join("System32").join("config")),
        SafetyError::CriticalSubpath { .. }
    ));
    assert!(matches!(
        reject(f, w.join("System32").join("DriverStore")),
        SafetyError::CriticalSubpath { .. }
    ));

    // 一级红线：整根禁入
    assert!(matches!(reject(f, w.clone()), SafetyError::RedLine { .. }));
    assert!(matches!(
        reject(f, f.program_files.join("SomeApp")),
        SafetyError::RedLine { .. }
    ));
    assert!(matches!(
        reject(f, f.program_data.join("Package Cache")),
        SafetyError::CriticalSubpath { .. }
    ));
    assert!(matches!(
        reject(f, f.program_data.join("Microsoft").join("Windows Defender")),
        SafetyError::CriticalSubpath { .. }
    ));

    // 用户数据目录的上级：清空 `C:\Users` 或用户配置文件根 = 销毁全部个人数据
    assert!(matches!(
        reject(f, f.users.clone()),
        SafetyError::UserDataAncestor { .. }
    ));
    assert!(matches!(
        reject(f, f.me.clone()),
        SafetyError::UserDataAncestor { .. }
    ));

    // 卷根形态
    assert!(matches!(
        reject(f, f.volume_root.clone()),
        SafetyError::ProtectedRoot { .. }
    ));

    // 形态拒绝必须在规范化之前 —— 两个用例的差别在于 `..` 会不会被折叠
    assert!(matches!(
        reject(f, PathBuf::from(format!(r"\\?\{}\Temp", w.display()))),
        SafetyError::DevicePathRejected { .. }
    ));
    assert!(matches!(
        reject(
            f,
            PathBuf::from(format!(r"\\?\{}\Temp\..\System32", w.display()))
        ),
        SafetyError::DevicePathRejected { .. }
    ));
    assert!(matches!(
        reject(f, PathBuf::from(r"\\server\share\x")),
        SafetyError::UncRejected { .. }
    ));
    assert!(matches!(
        reject(f, PathBuf::from(r"relative\path")),
        SafetyError::NotAbsolute { .. }
    ));

    // 保护文件名：即使落在被放行的目录里也拒绝（大小写不敏感）
    for name in ["pagefile.sys", "hiberfil.sys", "PAGEFILE.SYS", "Bootmgr"] {
        assert!(
            matches!(
                reject(f, w.join("Temp").join(name)),
                SafetyError::ProtectedFile { .. }
            ),
            "保护文件名 {name} 必须被拒绝"
        );
    }

    // ★ 反证：用户缓存目录不在任何红线根下，必须放行。
    //   红线一旦写宽，这一条立刻失败 —— 它是"红线过宽 = 功能报废"的哨兵。
    allow(f, f.me.join("AppData").join("Local").join("Temp"));

    // 大小写不敏感：Windows 文件系统不区分大小写，大小写敏感比较会漏判红线
    let upper = PathBuf::from(w.as_os_str().to_string_lossy().to_uppercase());
    assert!(
        matches!(
            f.profile.verify(&upper.join("System32")),
            Err(SafetyError::CriticalSubpath { .. })
        ),
        "大小写变体必须同样命中红线"
    );
}

/// ★ 卷级红线必须覆盖**每一块固定卷**，不只是系统盘。
///
/// 这条规则以前只钉在 `%SystemDrive%` 上，是真实缺口：把 Windows 装在 D 盘的机器
/// （双系统、或系统盘换过）上，`D:\Windows`、`D:\System Volume Information`、
/// `D:\$Recycle.Bin` 一条都拦不住 —— 而规则目标与占用发现的路径完全可能落在那里。
///
/// 用自造的"卷根"来测：这条规则没法在真实机器上确定性地验证（谁也不会真去
/// `D:\Windows` 建东西），只能把卷清单换掉。
#[test]
fn volume_level_red_lines_cover_every_fixed_volume_not_just_the_system_one() {
    let scratch = std::env::temp_dir().join(format!(
        "levitaire-redvol-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    ));
    let _ = fs::remove_dir_all(&scratch);
    for name in VOLUME_LEVEL_RED_NAMES {
        fs::create_dir_all(scratch.join(name)).expect("造装置失败");
    }
    // ★ `temp_dir()` 在本机返回的是 **8.3 短名**（`C:\Users\TANGMA~1\...`），
    //   而红根会被规范化成长名。不统一成同一个形态，下面的比较会整体失配 ——
    //   这正是闸一里 8.3 那个老问题的同一种表现。
    let fake_volume = normalize_existing(&scratch).expect("规范化失败");

    let env = SafetyEnv::from_process().expect("取环境失败");
    with_red_volumes_for_tests(vec![fake_volume.display().to_string()], || {
        let profile = SafetyProfile::derive(env).expect("红线派生失败");
        for name in VOLUME_LEVEL_RED_NAMES {
            // 走完整闸一（`verify` 会先规范化再比对），而不是直接调 `check_red_lines` ——
            // 后者只在"调用方已经规范化过"的前提下成立
            let probe = fake_volume.join(name).join("anything");
            assert!(
                matches!(profile.verify(&probe), Err(SafetyError::RedLine { .. })),
                "卷根下的 {name} 必须被红线拦住，实际：{:?}",
                profile.verify(&probe)
            );
        }
        // 卷根上不存在的东西不该被凭空加进红线（否则"红线过宽 = 功能报废"）
        assert!(
            !profile
                .red_roots()
                .iter()
                .any(|r| r.starts_with(fake_volume.join("NoSuchDirAnywhere"))),
            "不存在的目录不该进红线"
        );
    });

    let _ = fs::remove_dir_all(&scratch);
}

/// ★ `ProgramFiles(x86)` 解析不出来时，**整个安全档案仍要能派生**。
///
/// 这条是"面向任意机器"的问题：`program_files_x86` 是可选目录，一台没有它的机器
/// （或变量被置成空串、指向已消失的路径）不该让 `derive` 失败。原实现用
/// `normalize_existing(x86)?`，`?` 会把整个 `SafetyProfile::global()` 打成 Err ——
/// 所有清理命令直接报错，用户看到的还是"无法规范化目标 （Win32 错误 123）"。
/// 方向是 fail-closed（不会误删），但功能整块不可用，且原因完全看不出来。
#[test]
fn an_unusable_x86_program_files_never_kills_the_whole_profile() {
    let real = SafetyEnv::from_process().expect("取环境失败");

    // 三种"有值但用不了"的形态：空串、纯空白、指向不存在的路径
    for broken in ["", "   ", r"Q:\definitely-not-here\Program Files (x86)"] {
        let env = SafetyEnv {
            program_files_x86: Some(PathBuf::from(broken)),
            ..real.clone()
        };
        let profile = SafetyProfile::derive(env)
            .unwrap_or_else(|e| panic!("`{broken}` 不该让红线派生失败：{e}"));

        // 少了这一条红根，但**别的红根一个都不能少**
        assert!(
            profile
                .red_roots()
                .iter()
                .any(|r| equal_ci(r, &normalize_existing(&real.program_files).unwrap())),
            "`{broken}` 时 %ProgramFiles% 的红线必须还在"
        );
        assert!(
            profile
                .red_roots()
                .iter()
                .any(|r| equal_ci(r, &normalize_existing(&real.program_data).unwrap())),
            "`{broken}` 时 %ProgramData% 的红线必须还在"
        );
        // 而它自己不该被塞进红线里（不存在的路径进了红根只是白占位置）
        assert!(
            !profile
                .red_roots()
                .iter()
                .any(|r| r.display().to_string() == broken),
            "用不了的路径不该进红线"
        );
    }
}

/// 路径所在卷的挂载根（`C:\` 之类）。**派生而来，不写字面量** ——/// 本文件里任何一处盘符字面量都会让整套参数化用例退化成"只在开发机上成立"。
fn volume_root_of(path: &Path) -> Option<PathBuf> {
    let w = wide(path);
    let mut buf = [0u16; 261];
    if unsafe { GetVolumePathNameW(PCWSTR(w.as_ptr()), &mut buf) }.is_err() {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0)?;
    Some(PathBuf::from(OsString::from_wide(&buf[..len])))
}

#[test]
fn gate1_on_the_system_volume() {
    let temp = std::env::temp_dir();
    let Some(root) = volume_root_of(&temp) else {
        eprintln!("拿不到临时目录所在卷根，跳过");
        return;
    };
    let Some(f) = build(root, "sys") else {
        return;
    };
    run_gate1_table(&f);
}

/// §15.2 专项：**系统盘不是 `C:` 时红线仍然生效**。
///
/// 这条用例存在的唯一理由是防止红线被"优化"回字面量 —— 只要有人把
/// `<系统盘>\Windows` 写成常量，本用例在非 `C:` 卷上会立刻失效。
#[test]
fn gate1_on_a_non_system_volume() {
    let Some(root) = other_fixed_volume() else {
        eprintln!("本机没有第二个固定卷，跳过「系统盘为 D:」用例");
        return;
    };
    let Some(f) = build(root, "other") else {
        return;
    };
    run_gate1_table(&f);
    // 本档案的红线根必须落在那个卷上，而不是系统盘
    assert!(
        f.profile.red_roots().iter().any(|r| r.starts_with(&f.base)),
        "红线根没有跟着 SafetyEnv 走 —— 说明它来自字面量而非派生"
    );
}

/// 档案里那两份清单的**形状**也要钉住：它们决定了"什么能放行"。
///
/// `exact_allow` 每多一项，系统目录里就多开一个口子；`critical` 少一项，
/// 将来往 `exact_allow` 里加路径时就可能顺带把 `WinSxS` 之类放行。
#[test]
fn the_profile_exposes_exactly_one_exception_and_a_nonempty_critical_list() {
    let profile = SafetyProfile::global().expect("派生失败");

    // 唯一的系统级例外就是 `%SystemRoot%\Temp`
    let allow = profile.exact_allow();
    assert_eq!(
        allow.len(),
        1,
        "系统级例外只应有 %SystemRoot%\\Temp 一条，实际：{allow:?}"
    );
    assert!(
        allow[0]
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("Temp")),
        "例外应当是 Temp 目录，实际：{}",
        allow[0].display()
    );

    // 关键子路径（连 exact_allow 也覆盖不了的）必须非空且覆盖到那几个众所周知的目录
    let critical = profile.critical();
    assert!(
        critical.len() >= 8,
        "关键子路径太少（{} 条），红线兜底会失效",
        critical.len()
    );
    for expected in ["WinSxS", "Installer", "System32"] {
        assert!(
            critical.iter().any(|path| path
                .file_name()
                .map(|name| name.to_string_lossy().eq_ignore_ascii_case(expected))
                .unwrap_or(false)),
            "关键子路径里缺少 {expected}：{critical:?}"
        );
    }
    // 每一条都必须是绝对路径（派生自系统根，不是相对片段）
    for path in critical.iter().chain(allow.iter()) {
        assert!(path.is_absolute(), "{} 不是绝对路径", path.display());
    }
}

/// ★ 回归：**正斜杠形式的设备前缀**同样必须被拒绝。
///
/// 这条是实测复现出来的真漏洞：`//?/C:/Windows/System32` 的 `is_absolute()` 是 true，
/// 而旧的 `has_device_prefix` 只认反斜杠 → 第 2 步放行；随后 `GetFullPathNameW`
/// 把它规范化成 `\\?\C:\Windows\System32`，于是**之后所有前缀比较全线失配**
/// （红线根 `["C:", ...]` 比不过 `["\\?\C:", ...]`），闸一直接放行 System32。
///
/// 三层一起堵：入参认四种斜杠组合、规范化之后再查一次、比较入口剥掉前缀。
#[test]
fn forward_slash_device_prefixes_are_rejected() {
    let profile = SafetyProfile::global().expect("派生失败");
    let system_root = std::env::var("SystemRoot").expect("SystemRoot");
    let drive = std::env::var("SystemDrive").expect("SystemDrive");
    let forward = system_root.replace('\\', "/");

    for raw in [
        // 正斜杠的设备前缀：这是原漏洞的入口
        format!("//?/{forward}/System32"),
        format!("//./{drive}/"),
        // 混合斜杠
        format!("\\\\?/{forward}/System32"),
        format!("//?\\{forward}\\System32"),
        // 反斜杠写法（原有覆盖）
        format!("\\\\?\\{system_root}\\System32"),
    ] {
        let error = profile
            .verify(Path::new(&raw))
            .expect_err("设备前缀必须被拒绝，无论用哪种斜杠");
        assert!(
            matches!(error, SafetyError::DevicePathRejected { .. }),
            "{raw} 期望 DevicePathRejected，实际：{error}"
        );
    }

    // 比较入口本身也要免疫：剥掉前缀之后 `\\?\C:\Windows` 与 `C:\Windows` 是同一个目录
    let root = Path::new(&system_root);
    let verbatim = format!("\\\\?\\{system_root}\\System32");
    let slashed = format!("{system_root}/System32");
    assert!(
        starts_with_ci(Path::new(&verbatim), root) && starts_with_ci(Path::new(&slashed), root),
        "比较入口必须剥掉设备前缀，否则红线会被静默跳过"
    );
}

// ── 闸一：真实档案（本机）──────────────────────────────────────────────

#[test]
fn real_profile_rejects_the_real_system_directories() {
    let p = SafetyProfile::global().expect("本机应当能派生红线");
    let system_root = PathBuf::from(std::env::var("SystemRoot").expect("SystemRoot"));
    let program_files = PathBuf::from(std::env::var("ProgramFiles").expect("ProgramFiles"));

    assert!(p.verify(&system_root.join("System32")).is_err());
    assert!(p.verify(&system_root.join("WinSxS")).is_err());
    assert!(p.verify(&system_root.join("Installer")).is_err());
    assert!(p.verify(&system_root).is_err());
    assert!(p.verify(&program_files.join("Anything")).is_err());

    // `%SystemRoot%\Temp` 是唯一放行的系统级目标（§5.4 的 exact_allow）
    let windows_temp = system_root.join("Temp");
    if windows_temp.exists() {
        assert!(
            p.verify(&windows_temp).is_ok(),
            "{} 应当被 exact_allow 放行",
            windows_temp.display()
        );
    }

    // 红线根必须等于派生来源，不是任何字面量
    assert!(p
        .red_roots()
        .iter()
        .any(|r| equal_ci(r, &normalize_existing(&system_root).unwrap())));
}

/// 8.3 短名必须在红线比对之前被还原成长名。
/// 卷上没开 8.3 生成时该用例无意义，直接跳过。
#[test]
fn real_profile_rejects_the_8_3_short_form_of_a_red_line() {
    let p = SafetyProfile::global().expect("派生失败");
    let program_files = PathBuf::from(std::env::var("ProgramFiles").expect("ProgramFiles"));
    let Some(short) = short_path_name(&program_files) else {
        eprintln!("拿不到 8.3 短名，跳过");
        return;
    };
    if equal_ci(&short, &program_files) {
        eprintln!("本卷未启用 8.3 短名生成，跳过");
        return;
    }
    let err = p
        .verify(&short.join("Anything"))
        .expect_err("8.3 短名必须被还原成长名后命中红线");
    assert!(
        matches!(err, SafetyError::RedLine { .. }),
        "期望 RedLine，实际：{err}"
    );
}

#[test]
fn env_consistency_detects_a_polluted_system_root() {
    let real = PathBuf::from(std::env::var("SystemRoot").expect("SystemRoot"));
    let upper = PathBuf::from(real.as_os_str().to_string_lossy().to_uppercase());
    // 大小写差异不算不一致
    assert!(check_env_consistency(&real, &upper, &real).is_ok());
    // windir 与 SystemRoot 不一致 → 拒绝
    assert!(check_env_consistency(&real, Path::new(r"Q:\windir"), &real).is_err());
    // SystemRoot 被用户环境覆盖（FOLDERID_Windows 仍是真值）→ 拒绝
    assert!(check_env_consistency(Path::new(r"Q:\fake"), Path::new(r"Q:\fake"), &real).is_err());
}

// ── 闸一：根被重定向（§15.1 变体）──────────────────────────────────────

#[test]
fn a_redirected_root_is_rejected() {
    let base = std::env::temp_dir().join(format!("levitaire-redirect-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let real = base.join("real");
    fs::create_dir_all(&real).unwrap();

    let link = base.join("redirected");
    let made = crate::utils::process::hidden_command("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&real)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !made {
        eprintln!("建 junction 失败，跳过");
        let _ = fs::remove_dir_all(&base);
        return;
    }

    let p = SafetyProfile::global().expect("派生失败");
    let err = p
        .verify(&link)
        .expect_err("根被重定向时必须拒绝，而不是删到链接指向的位置");
    assert!(
        matches!(err, SafetyError::RootRedirected { .. }),
        "期望 RootRedirected，实际：{err}"
    );

    // 链接之下的层级同样要被拦下（第 8 步逐级检查，不只查最后一级）
    let child = link.join("nested");
    fs::create_dir_all(&child).unwrap();
    assert!(p.verify(&child).is_err());

    let _ = fs::remove_dir_all(&base);
}

// ── 路径工具 ───────────────────────────────────────────────────────────

#[test]
fn long_path_prefix_is_only_added_when_needed() {
    let short = PathBuf::from(r"Q:\a\b");
    assert_eq!(long_path(&short), short, "短路径不该加设备前缀");

    let deep = PathBuf::from("Q:\\").join("x".repeat(300));
    let prefixed = long_path(&deep);
    assert!(
        prefixed.as_os_str().to_string_lossy().starts_with(r"\\?\"),
        "≥ 260 的路径必须加设备前缀"
    );

    let unc = PathBuf::from(r"\\server\share").join("y".repeat(300));
    let prefixed_unc = long_path(&unc);
    assert!(
        prefixed_unc
            .as_os_str()
            .to_string_lossy()
            .starts_with(r"\\?\UNC\"),
        "UNC 长路径要转成 \\\\?\\UNC\\ 形式，实际：{}",
        prefixed_unc.display()
    );

    // 已经是设备路径就不叠加
    let already = PathBuf::from(format!(r"\\?\Q:\{}", "z".repeat(300)));
    assert_eq!(long_path(&already), already);
}

#[test]
fn long_path_preserves_non_unicode_names() {
    // NTFS 允许含孤立代理项的文件名。旧实现先 to_string_lossy 再拼 \\?\，
    // 两个不同文件名都会变成 U+FFFD，长路径下就可能删错文件。
    let mut first: Vec<u16> = "x".repeat(300).encode_utf16().collect();
    first.push(0xD800);
    let mut second: Vec<u16> = "x".repeat(300).encode_utf16().collect();
    second.push(0xDC00);

    let first = long_path(&PathBuf::from(OsString::from_wide(&first)));
    let second = long_path(&PathBuf::from(OsString::from_wide(&second)));
    assert_ne!(first, second, "两个不同的非法文件名不能被判成同一个");
}

#[test]
fn boundary_matching_is_not_string_prefix_matching() {
    let root = Path::new(r"Q:\Temp");
    assert!(starts_with_ci(Path::new(r"Q:\Temp"), root));
    assert!(starts_with_ci(Path::new(r"Q:\Temp\a\b"), root));
    assert!(!starts_with_ci(Path::new(r"Q:\Temporary"), root));
    assert!(!starts_with_ci(Path::new(r"Q:\TempTrap"), root));
    // 大小写不敏感
    assert!(starts_with_ci(Path::new(r"q:\TEMP\x"), root));
}

// ── 目标解析 ───────────────────────────────────────────────────────────

#[test]
fn relative_subpaths_cannot_escape_upwards() {
    for bad in [r"..\..\Windows", r"\absolute", r"Q:\other", "..", r"a\..\b"] {
        let target = Target::KnownFolder {
            folder: KnownFolderId::LocalAppData,
            relative: Some(bad.into()),
        };
        assert!(
            matches!(
                resolve_target(&target),
                Err(SafetyError::RelativeNotAllowed { .. })
            ),
            "带穿越的相对子路径必须被拒绝：{bad}"
        );
    }
    // 正常的一段式相对路径要能解析
    let ok = Target::KnownFolder {
        folder: KnownFolderId::LocalAppData,
        relative: Some("Temp".into()),
    };
    let resolved = resolve_target(&ok).unwrap();
    assert!(resolved.ends_with("Temp"));
}

#[test]
fn env_target_variables_are_whitelisted() {
    let bad = Target::Env {
        var: "PATH".into(),
        relative: Some("x".into()),
    };
    assert!(matches!(
        resolve_target(&bad),
        Err(SafetyError::EnvVarNotAllowed { .. })
    ));
}

#[test]
fn env_expansion_in_targets_is_rejected_not_silently_ignored() {
    let bad = Target::FixedPath {
        path: r"Q:\%TEMP%\cache".into(),
    };
    assert!(matches!(
        resolve_target(&bad),
        Err(SafetyError::EnvExpansionNotSupported { .. })
    ));
}
