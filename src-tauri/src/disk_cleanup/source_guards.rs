//! 源码级守卫（§15.5）。
//!
//! 与 `utils::process` 的子进程守卫同一路数：把「不变量」钉成可执行的断言，
//! 后续改动一旦破坏它，`cargo test` 立刻报红。
//!
//! 放在独立文件（而不是内联在 `mod.rs` 里）的理由同 `safety/`、`delete/` 下的用例：
//! `mod.rs` 通篇是生产代码，守卫可以整文件扫描而不必按 `#[cfg(test)]` 截断 ——
//! 截断会在文件后半段还有生产代码时失明。

use std::path::{Path, PathBuf};

fn strip_line_comments(source: &str) -> String {
    source
        .lines()
        .map(|line| match line.find("//") {
            Some(index) if line[..index].trim().is_empty() => "",
            _ => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 扫出源码里的所有字符串字面量（含 `"..."` / `r"..."` / `r#"..."#`）。
fn string_literals(source: &str) -> Vec<String> {
    let chars: Vec<char> = source.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] != '"' {
            i += 1;
            continue;
        }
        // 往前看是不是 raw string（`r"` / `br"` / `r#"`）
        let mut k = i;
        while k > 0 && chars[k - 1] == '#' {
            k -= 1;
        }
        let is_raw = k > 0 && chars[k - 1] == 'r';

        let mut j = i + 1;
        while j < chars.len() {
            if !is_raw && chars[j] == '\\' {
                j += 2;
                continue;
            }
            if chars[j] == '"' {
                break;
            }
            j += 1;
        }
        out.push(chars[i + 1..j.min(chars.len())].iter().collect());
        i = j + 1;
    }
    out
}

/// `src/` 下所有 `.rs` 的 `(相对路径, 原文)`。**不剥离测试模块** ——
/// 本组守卫的关键字都用拼接方式构造，自身源码里不含完整串，不会被自己扫中；
/// 不剥离反而能覆盖到测试代码，扫得更全。
fn all_rust_sources() -> Vec<(String, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect(&root, &mut files);
    let mut out: Vec<(String, String)> = files
        .into_iter()
        .map(|path| {
            let relative = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
                panic!(
                    "读不出 {}：{e}（静默跳过等于对那个文件失明）",
                    path.display()
                )
            });
            (relative, text)
        })
        .collect();
    out.sort();
    out
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// I3：红线与清理目标**必须运行时派生**，任何写死的盘符都会让红线在
/// "系统盘不是 `C:`"的机器上整体失效 —— 而那正是 §5.4 修掉的第 1 号缺陷。
///
/// 这条守卫扫的是**生产代码**（那几个文件通篇是生产代码，用例在独立的
/// `*_test.rs` 里），因此不需要按 `#[cfg(test)]` 截断。
#[test]
fn safety_code_has_no_drive_letter_literals() {
    const FILES: &[(&str, &str)] = &[
        ("disk_cleanup/safety.rs", include_str!("safety.rs")),
        ("disk_cleanup/target.rs", include_str!("target.rs")),
        ("disk_cleanup/delete.rs", include_str!("delete.rs")),
        ("disk_cleanup/rules.rs", include_str!("rules.rs")),
        ("disk_cleanup/mod.rs", include_str!("mod.rs")),
    ];

    let mut scanned = 0usize;
    for (name, raw) in FILES {
        let src = strip_line_comments(raw);
        assert!(
            src.contains("fn "),
            "{name} 扫到的内容不像 Rust 源码，守卫会假绿"
        );
        for literal in string_literals(&src) {
            let mut chars = literal.chars();
            let (Some(first), Some(second)) = (chars.next(), chars.next()) else {
                continue;
            };
            assert!(
                !(first.is_ascii_alphabetic() && second == ':'),
                "{name} 里出现了盘符字面量 \"{literal}\"：红线与清理目标必须从运行环境派生（I3）。\
                 写死盘符会让红线在系统盘非 C: 的机器上全部失效。"
            );
        }
        scanned += 1;
    }
    assert_eq!(
        scanned,
        FILES.len(),
        "文件清单与扫描数不一致，守卫的扫描面已失效"
    );
}

/// 删除路径上**不允许出现任何子进程**。
///
/// 「强删 / 改属主 / 自动关进程」这类补救动作一旦出现在删除路径上，就说明有人把
/// I5 的「占用即跳过」改成了「想办法把它删掉」。`std::fs::remove_dir_all` 同样禁止 ——
/// 它的重解析点语义由标准库决定，而这是全项目最危险的一次调用，不能外包。
///
/// ★ `quarantine.rs` 也必须在这个清单里。它不在的时候漏掉了两处真实的
/// `remove_dir_all`（清理收尾时删空任务目录）—— 那不是有意放行，只是没人扫到它。
/// 隔离区本身就是删除功能的一部分，没有理由比 `delete.rs` 宽松。
#[test]
fn the_delete_path_never_spawns_a_process_or_uses_std_recursive_delete() {
    const FILES: &[(&str, &str)] = &[
        ("disk_cleanup/delete.rs", include_str!("delete.rs")),
        ("disk_cleanup/safety.rs", include_str!("safety.rs")),
        ("disk_cleanup/scan.rs", include_str!("scan.rs")),
        ("disk_cleanup/quarantine.rs", include_str!("quarantine.rs")),
        (
            "disk_cleanup/recycle_bin.rs",
            include_str!("recycle_bin.rs"),
        ),
    ];
    let forbidden = [
        "Command::new(",
        "hidden_command(",
        "remove_dir_all",
        "remove_file",
        "takeown",
        "icacls",
        "taskkill",
    ];
    for (name, raw) in FILES {
        let src = strip_line_comments(raw);
        // `remove_file` 在 quarantine.rs 里是**有意保留**的：它删的是我们自己写的
        // `manifest.json`（一个已知路径、非重解析点），不是用户数据。
        // 其余 token 一律不得出现。
        let tokens: Vec<&str> = forbidden
            .iter()
            .copied()
            .filter(|token| !(name.ends_with("quarantine.rs") && token == &"remove_file"))
            .collect();
        for token in tokens {
            assert!(
                !src.contains(token),
                "{name} 的删除路径上出现了 `{token}`：删除引擎只允许用 DeleteFileW / \
                 RemoveDirectoryW 逐层删除，且必须是「占用即跳过」。"
            );
        }
    }
}

/// I1：前端永远不提供路径，只提供 `rule_id`（发现类目标是 P4 的 `discovery_id`）。
///
/// 因此任何接收删除请求的后端命令，签名里都不允许出现路径参数 ——
/// 一旦出现，前端就重新获得了"删任意文件"的能力。
#[test]
fn delete_commands_never_accept_a_path() {
    let src = strip_line_comments(include_str!("../commands/disk_cleanup.rs"));
    for token in [
        "PathBuf",
        "Path ",
        "&Path",
        "path: String",
        "target: String",
    ] {
        assert!(
            !src.contains(token),
            "commands/disk_cleanup.rs 里出现了路径参数 `{token}`：前端只允许传 rule_id，\
             传路径等于把删除任意文件的能力暴露给最易被攻破的那一层（I1）。"
        );
    }
}

/// I1：**前端永远不持有清理目标路径**。
///
/// 前端只允许持有后端签发的 `rule_id`。一旦这里出现路径字面量，就等于给"删任意文件"
/// 开了第二个人口 —— 而 WebView 是整套架构里最容易被攻破的一层。
#[test]
fn frontend_holds_no_cleanup_paths() {
    const FILES: &[(&str, &str)] = &[
        (
            "src/tools/system-cleaner/SystemCleanerTool.tsx",
            include_str!("../../../src/tools/system-cleaner/SystemCleanerTool.tsx"),
        ),
        (
            "src/constants/diskCleanupConfig.ts",
            include_str!("../../../src/constants/diskCleanupConfig.ts"),
        ),
    ];

    // 环境变量展开写法：前端不做展开，写了只会误导后来的人
    const ENV_FORMS: &[&str] = &[
        "%TEMP%",
        "%TMP%",
        "%APPDATA%",
        "%LOCALAPPDATA%",
        "%USERPROFILE%",
        "%ProgramData%",
        "%SystemRoot%",
    ];
    // 系统目录名：出现即说明有人在硬编码清理目标
    const DIR_NAMES: &[&str] = &["Program Files", "AppData", "Windows\\", "ProgramData"];

    let mut scanned = 0usize;
    for (name, raw) in FILES {
        let src = strip_line_comments(raw);
        assert!(
            src.contains("export"),
            "{name} 扫到的内容不像 TS 源码，守卫会假绿"
        );

        for literal in string_literals(&src) {
            let mut chars = literal.chars();
            let (Some(first), Some(second)) = (chars.next(), chars.next()) else {
                continue;
            };
            assert!(
                !(first.is_ascii_alphabetic() && second == ':'),
                "{name} 里出现了盘符字面量 \"{literal}\"：前端不得持有清理目标路径（I1）"
            );
            for form in ENV_FORMS {
                assert!(
                    !literal.contains(form),
                    "{name} 里出现了 \"{literal}\"：前端不做环境变量展开，且不得持有路径（I1）"
                );
            }
            for dir in DIR_NAMES {
                assert!(
                    !literal.contains(dir),
                    "{name} 里出现了系统目录名 \"{literal}\"：清理目标只能来自后端规则表（I1）"
                );
            }
        }
        scanned += 1;
    }
    assert_eq!(
        scanned,
        FILES.len(),
        "文件清单与扫描数不一致，守卫的扫描面已失效"
    );
}

/// 回收站的清空只能出现在**非 dry-run 分支之后**。
///
/// `SHEmptyRecycleBinW` 是这套工具里唯一一个"一次调用就永久销毁用户数据"的动作，
/// 而且它不给我们任何逐条明细。因此两层一起钉住：
///
/// 1. 这个函数名只允许出现在 `recycle_bin.rs` 里（别处想清空都得走它）；
/// 2. 在 `scan.rs` 的 `run_recycle_bin` 里，`empty_all(` 必须出现在 `is_dry_run` 之后 ——
///    也就是预览阶段根本走不到那一行。
///
/// 第 2 条是**调用顺序守卫**（同 §15.5 里"用户数据判定先于规则表判定"那条）：
/// 有人重排这两段代码时它会立刻报红。
#[test]
fn the_recycle_bin_is_only_emptied_after_the_dry_run_branch() {
    // 关键字用拼接构造：守卫自己的断言文案里也写着这个函数名，直接写字面量会把自己扫中
    let api = ["SHEmptyRecycle", "BinW"].concat();
    let sources = all_rust_sources();
    let offenders: Vec<&String> = sources
        .iter()
        .filter(|(name, text)| {
            name.as_str() != "disk_cleanup/recycle_bin.rs"
                && strip_line_comments(text).contains(api.as_str())
        })
        .map(|(name, _)| name)
        .collect();
    assert!(
        offenders.is_empty(),
        "这些文件直接调用了回收站的清空 API：清空必须只经由 `disk_cleanup::recycle_bin`，\
         才能保证它有统一的口径与记录：{offenders:?}"
    );

    let scan = strip_line_comments(include_str!("scan.rs"));
    let body_start = scan
        .find("fn run_recycle_bin(")
        .expect("scan.rs 里找不到 run_recycle_bin（被改名/移动时请同步本守卫）");
    let body = &scan[body_start..];
    let dry_run_at = body
        .find("is_dry_run()")
        .expect("run_recycle_bin 里找不到 dry-run 分支");
    let empty_at = body
        .find("empty_all(")
        .expect("run_recycle_bin 里找不到清空调用");
    assert!(
        empty_at > dry_run_at,
        "清空回收站的调用排在了 dry-run 分支**之前**：预览阶段就会真的清空回收站"
    );

    // 测试代码一律不得清空回收站（§9.4：不在用户真实回收站上做实验）
    let eager: Vec<&String> = sources
        .iter()
        .filter(|(name, _)| name.ends_with("_test.rs"))
        .filter(|(_, text)| {
            let src = strip_line_comments(text);
            src.contains("empty_all(")
                || src.contains("empty_volumes(")
                || src.contains("empty_one(")
        })
        .map(|(name, _)| name)
        .collect();
    assert!(
        eager.is_empty(),
        "这些用例调用了清空回收站的入口：方案 §9.4 明确要求不在用户真实回收站上做实验：{eager:?}"
    );
}

/// 隔离区保留期档位必须前后端一致。
///
/// 后端会**拒绝**不在清单里的值（`update_system_cleaner_quarantine_days`），
/// 所以前端多写一个档位、或者少写一个，症状都是"选了没反应"或"报错但没人知道为什么"。
/// 与 `commands/monitor.rs` 的 `monitor_layout_sizes_match_frontend` 同一路数。
#[test]
fn quarantine_retention_options_match_the_backend() {
    let ts = strip_line_comments(include_str!("../../../src/constants/diskCleanupConfig.ts"));
    let start = ts
        .find("QUARANTINE_RETENTION_OPTIONS")
        .expect("前端找不到 QUARANTINE_RETENTION_OPTIONS（改名时请同步本守卫）");
    let rest = &ts[start..];
    let end = rest
        .find("] as const")
        .expect("选项表没有以 `] as const` 结束");
    let block = &rest[..end];

    let mut found: Vec<u32> = Vec::new();
    let mut cursor = 0usize;
    while let Some(at) = block[cursor..].find("value: ") {
        let from = cursor + at + "value: ".len();
        let digits: String = block[from..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        cursor = from;
        if digits.is_empty() {
            break;
        }
        found.push(digits.parse().expect("档位应当是数字"));
    }
    found.sort_unstable();

    let mut expected: Vec<u32> = super::quarantine::RETENTION_CHOICES.to_vec();
    expected.sort_unstable();
    assert_eq!(
        found, expected,
        "前端的隔离区保留期档位与后端 RETENTION_CHOICES 不一致：后端会拒绝清单外的值"
    );
}

/// 占用发现的深度档位必须前后端一致。
///
/// 后端对不认识的值会**静默退回默认深度** —— 前端多写一个档位，症状是"选了没反应"。
#[test]
fn discovery_depth_options_match_the_backend() {
    let ts = strip_line_comments(include_str!("../../../src/constants/diskCleanupConfig.ts"));
    let start = ts
        .find("DISCOVERY_DEPTH_OPTIONS")
        .expect("前端找不到 DISCOVERY_DEPTH_OPTIONS（改名时请同步本守卫）");
    let rest = &ts[start..];
    let open = rest.find('[').expect("档位表应当是数组");
    let close = rest[open..].find(']').expect("档位表没有以 `]` 结束") + open;
    let block = &rest[open + 1..close];

    let mut found: Vec<usize> = block
        .split(',')
        .filter_map(|part| part.trim().parse::<usize>().ok())
        .collect();
    found.sort_unstable();

    let mut expected: Vec<usize> = super::discover::DEPTH_CHOICES.to_vec();
    expected.sort_unstable();
    assert_eq!(
        found, expected,
        "前端的报告深度档位与后端 DEPTH_CHOICES 不一致"
    );
    // 默认深度也要在档位里，否则选中的那一项在下拉框里根本不存在
    assert!(
        expected.contains(&super::discover::DEFAULT_REPORT_DEPTH),
        "默认报告深度不在档位表里"
    );
}

/// 看门狗**一个字节都不删**。
///
/// 它是唯一在无人值守时运行的组件（§11.1），权限面必须最小：只读磁盘、只发通知。
/// 它连隔离区都不碰 —— 是否处理由用户决定。这条守卫生效的前提是"看门狗只做判定"，
/// 一旦有人往它里面加清理动作，用户就会在完全不知情的情况下被删掉文件。
#[test]
fn the_watchdog_never_touches_deletion_or_quarantine() {
    let src = strip_line_comments(include_str!("watchdog.rs"));
    let forbidden = [
        "delete::",
        "quarantine::",
        "DeleteFileW",
        "RemoveDirectoryW",
        "purge_contents",
        "purge_",
        "remove_dir_all",
        "remove_file",
    ];
    for token in forbidden {
        assert!(
            !src.contains(token),
            "watchdog.rs 里出现了 `{token}`：看门狗只做判定与通知，绝不删除或隔离"
        );
    }
    // 它必须以**无人值守**的优先级跑：慢无所谓，反正没人等（实测后台模式比
    // BelowNormal 慢 16 倍，用户主动扫描那条通路不能用它）
    assert!(
        src.contains("Politeness::Background"),
        "看门狗的扫描必须用后台优先级（Politeness::Background）"
    );
}

/// 看门狗的间隔档位必须前后端一致。
///
/// 后端会把低于下限的间隔**抬到下限**（看门狗必须低频），前端多写一个小档位，
/// 症状就是"选了 1 分钟、实际还是 1 小时"这种谁也说不清的错位。
#[test]
fn watchdog_interval_choices_match_the_backend() {
    let ts = strip_line_comments(include_str!("../../../src/constants/diskCleanupConfig.ts"));
    let start = ts
        .find("WATCHDOG_INTERVAL_OPTIONS")
        .expect("前端找不到 WATCHDOG_INTERVAL_OPTIONS（改名时请同步本守卫）");
    let rest = &ts[start..];
    let open = rest.find('[').expect("档位表应当是数组");
    let close = rest[open..].find(']').expect("档位表没有以 `]` 结束") + open;
    let block = &rest[open + 1..close];

    let mut found: Vec<u64> = block
        .split(',')
        .filter_map(|part| part.trim().parse::<u64>().ok())
        .collect();
    found.sort_unstable();

    let mut expected: Vec<u64> = super::watchdog::INTERVAL_CHOICES.to_vec();
    expected.sort_unstable();
    assert_eq!(
        found, expected,
        "前端的看门狗间隔档位与后端 INTERVAL_CHOICES 不一致"
    );
    assert!(
        expected.contains(&super::watchdog::DEFAULT_INTERVAL_HOURS),
        "默认间隔不在档位表里"
    );
}

/// I8 / §9.4：回收站的**量尺寸改成只读实测**之后，这个模块对 `$Recycle.Bin` 的接触面
/// 变大了 —— 必须钉死它只有"读"这一种接触。
///
/// `$Recycle.Bin` 是红线路径（§5.4）。清空一律走 `SHEmptyRecycleBinW`（shell 才能维护
/// 回收站的一致性）；本模块对它的任何其它操作都必须是只读的。
#[test]
fn the_recycle_bin_never_deletes_by_path() {
    let src = strip_line_comments(include_str!("recycle_bin.rs"));
    let forbidden = [
        "DeleteFileW",
        "RemoveDirectoryW",
        "purge_contents",
        "delete::",
        "remove_file",
        "remove_dir",
        "quarantine",
    ];
    for token in forbidden {
        assert!(
            !src.contains(token),
            "recycle_bin.rs 里出现了 `{token}`：量尺寸只允许只读枚举，删除只允许走 Shell API"
        );
    }
    // 唯一允许的破坏性调用
    let empty_api = ["SHEmptyRecycle", "BinW"].concat();
    assert!(
        src.contains(empty_api.as_str()),
        "清空必须经由 Shell 的回收站 API —— 它是唯一允许的删除通路"
    );

    // 实测必须跳过重解析点：跟进去会把别处的数据算成回收站的占用
    assert!(
        src.contains("is_reparse_point()"),
        "回收站实测必须跳过重解析点（I4 的同一条纪律）"
    );
}

/// 统计的卷集合与清空的卷集合**必须是同一个**。
///
/// 两者不一致的症状是"说能释放 52 GB、实际只释放了 13 GB" —— 而这类数字失信
/// 正是第三方清理工具的通病（§一.5）。
#[test]
fn measuring_and_emptying_use_the_same_volume_set() {
    let src = strip_line_comments(include_str!("recycle_bin.rs"));
    for entry_point in ["pub fn measure_all", "pub fn empty_all"] {
        let start = src
            .find(entry_point)
            .unwrap_or_else(|| panic!("recycle_bin.rs 里找不到 {entry_point}"));
        let body = &src[start..];
        let end = body.find("\n}").unwrap_or(body.len());
        assert!(
            body[..end].contains("target_volumes()"),
            "{entry_point} 没有走 target_volumes()：统计与清空的卷集合可能不一致"
        );
    }
}

/// **每个后端命令都必须有前端调用方。**
///
/// 第 8 版复查时发现 7 个命令没有任何前端调用 —— 其中 4 个构成一整块缺口：
/// 审计日志的命令写完了、用例也有、**就是没接界面**，而设置页里那句"可随时一键清空"
/// 是真真切切写在那儿的。设置页写着一句它做不到的话，比少一个功能更糟。
///
/// 现有的守卫都是"写了的东西是对的"这一类；**"该写的都写了"没有守卫**。
/// 这条补的就是那个盲区 —— 它正是一个完整性断言。
#[test]
fn every_backend_command_has_a_frontend_caller() {
    let commands = strip_line_comments(include_str!("../commands/disk_cleanup.rs"));
    let mut names: Vec<&str> = Vec::new();
    for line in commands.lines() {
        let trimmed = line.trim();
        let rest = trimmed
            .strip_prefix("pub async fn ")
            .or_else(|| trimmed.strip_prefix("pub fn "));
        if let Some(rest) = rest {
            let name = rest.split('(').next().unwrap_or("").trim();
            if name.starts_with("disk_cleanup_")
                || name.starts_with("get_system_cleaner_")
                || name.starts_with("set_system_cleaner_")
            {
                names.push(name);
            }
        }
    }
    assert!(
        names.len() >= 20,
        "只解析出 {} 个命令，解析逻辑失效（守卫会空转）",
        names.len()
    );

    // 前端侧：工具面板 + 设置页 + 工具注册表（工具开关的命令名藏在 BACKEND_TOOLS 里，
    // 由 `backendSetterFor(id)` 间接取用 —— 不把 registry.ts 算进来会误报）。
    let mut frontend = String::new();
    frontend.push_str(include_str!(
        "../../../src/tools/system-cleaner/SystemCleanerTool.tsx"
    ));
    frontend.push_str(include_str!("../../../src/components/Settings.tsx"));
    frontend.push_str(include_str!("../../../src/tools/registry.ts"));

    let orphans: Vec<&&str> = names
        .iter()
        .filter(|name| !frontend.contains(**name))
        .collect();
    assert!(
        orphans.is_empty(),
        "这些后端命令没有任何前端调用方 —— 实现了但没接界面：{orphans:?}"
    );
}

/// 全库：**完全不使用**延迟删除机制。
///
/// 队列只增不减，有多次失败启动后累积、在下次健康重启时误删正常文件的真实案例。
#[test]
fn delayed_delete_mechanisms_are_never_used() {
    // 拼接构造关键字：守卫自身源码里不出现完整串，因此可以扫原始全文
    let needles = [
        ["PendingFileRename", "Operations"].concat(),
        ["MOVEFILE_DELAY", "_UNTIL_REBOOT"].concat(),
    ];
    let sources = all_rust_sources();
    assert!(
        sources.len() >= 40,
        "只扫到 {} 个源文件，扫描根目录可能不对",
        sources.len()
    );

    for (name, text) in &sources {
        let src = strip_line_comments(text);
        for needle in &needles {
            assert!(
                !src.contains(needle.as_str()),
                "{name} 使用了延迟删除机制 {needle}：该队列只增不减，重启时可能误删健康文件，\
                 本方案完全不使用它。"
            );
        }
    }
}

/// 全库：**绝不调用** Restart Manager 的关机/重启接口。
///
/// Restart Manager 只用来看「是谁占着文件」，用来提示用户关掉哪个程序。
/// `RmShutdown` 会强关进程、丢失用户未保存数据，而且是勒索软件用过的同款手法。
#[test]
fn restart_manager_is_only_used_for_diagnostics() {
    let needles = [["Rm", "Shutdown"].concat(), ["Rm", "Restart"].concat()];
    for (name, text) in &all_rust_sources() {
        let src = strip_line_comments(text);
        for needle in &needles {
            assert!(
                !src.contains(needle.as_str()),
                "{name} 调用了 {needle}：强关进程会丢失用户未保存的数据，\
                 本方案只允许用 Restart Manager 做占用诊断。"
            );
        }
    }
}

/// 内置兜底规则表必须过**同一个**校验器。
///
/// 它存在的意义只是"签名校验失败且本地没有上一份可用规则"时不至于功能全空；
/// 免检就等于给自己留了一个绕过校验器的后门（§7.1）。
#[test]
fn builtin_table_passes_the_same_validator() {
    let profile = super::safety::SafetyProfile::global().expect("本机应当能派生红线");
    let rules = super::rules::parse_and_validate(super::rules::builtin_json(), profile)
        .expect("内置规则表没通过校验器");
    assert!(!rules.is_empty(), "内置规则表不该是空的");

    // 能解析出来不等于每条都合理，把关键约束再钉一遍
    for rule in &rules {
        assert!(
            !rule.consequence.trim().is_empty(),
            "{} 缺后果文案",
            rule.id
        );
        assert!(
            rule.requires_admin == (rule.tier != super::rules::Tier::L1),
            "{} 的级别与授权不一致",
            rule.id
        );
        // Shell 虚拟目标（回收站）**没有文件系统路径**，闸一无从判定 ——
        // 它的安全边界由"必须走 Shell API"提供，校验器已强制它与策略严格配对。
        if matches!(rule.target, super::target::Target::ShellRecycleBin) {
            assert!(
                matches!(rule.strategy, super::rules::Strategy::ShellEmptyRecycleBin),
                "{} 的 Shell 目标没有配对 shellEmptyRecycleBin",
                rule.id
            );
            continue;
        }
        assert!(
            profile.resolve_and_verify(&rule.target).is_ok(),
            "{} 的目标在扫描期解析不出来",
            rule.id
        );
    }
}

/// 内置规则表的 id 唯一，且首批清单没被误删。
#[test]
fn builtin_table_has_unique_ids_and_the_expected_first_batch() {
    let profile = super::safety::SafetyProfile::global().expect("派生失败");
    let rules = super::rules::parse_and_validate(super::rules::builtin_json(), profile).unwrap();

    let mut ids: Vec<&str> = rules.iter().map(|r| r.id.as_str()).collect();
    ids.sort_unstable();
    let before = ids.len();
    ids.dedup();
    assert_eq!(before, ids.len(), "内置规则表出现重复 id：{ids:?}");

    for expected in ["temp-user", "explorer-cache", "updater-cache"] {
        assert!(
            ids.contains(&expected),
            "首批 L1 清单里少了 {expected}（清理范围被误删？）"
        );
    }
}

/// 扫出源码里所有 `spawn_blocking(` 的**实参区间**（半开区间）。
///
/// 只断言"出现过 `spawn_blocking`"是不够的：调用写在闭包**外面**、闭包体里另有别的东西，
/// 文本上一样"出现过"。所以按括号配平取出整段实参，再判目标是否落在里面。
fn spawn_blocking_spans(source: &str) -> Vec<(usize, usize)> {
    let bytes = source.as_bytes();
    let needle = concat!("spawn_", "blocking(");
    let mut spans = Vec::new();
    let mut cursor = 0usize;
    while let Some(offset) = source[cursor..].find(needle) {
        // 从 `(` 起按配平找到整段实参
        let open = cursor + offset + needle.len() - 1;
        let mut depth = 0usize;
        let mut index = open;
        while index < bytes.len() {
            match bytes[index] {
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            index += 1;
        }
        spans.push((open, index.min(bytes.len())));
        cursor = open + 1;
    }
    spans
}

/// 整树遍历**不许占着异步线程**。
///
/// `issue_discovery`（内部是 `measure_tree` 递归 stat 整棵树）与 `refresh_quarantine_ledger`
/// （遍历整棵隔离区目录树）都是秒级重活。占着 async 工作线程，同一 runtime 上的其它命令
/// （更新检查、配置读写、窗口状态）会一起被拖住；而**同步**命令更糟 —— `tauri-macros` 把它
/// 内联在 IPC 回调线程（Windows 上就是 UI 线程）上执行，整个应用的窗口一起卡死。
/// 这也正是 `with_clean_gate` 的注释已经写明的规矩，这个守卫就是让后来的调用点没法绕过它。
///
/// 只钉**入口**（这两个公开操作）而不是 `measure_tree` 本身：后者是私有实现，
/// 唯一入口就是 `issue_discovery`，钉住入口即可覆盖。
///
/// 这类"位置"约束没法用行为用例钉（要起 Tauri runtime），所以扫源码。
#[test]
fn whole_tree_walks_never_run_on_an_async_thread() {
    const HEAVY: &[&str] = &[
        concat!("issue_", "discovery"),
        concat!("refresh_quarantine_", "ledger"),
    ];
    const FILES: &[(&str, &str)] = &[
        (
            "commands/disk_cleanup.rs",
            include_str!("../commands/disk_cleanup.rs"),
        ),
        ("disk_cleanup/mod.rs", include_str!("mod.rs")),
    ];

    let mut checked = 0usize;
    for (name, raw) in FILES {
        let src = strip_line_comments(raw);
        let spans = spawn_blocking_spans(&src);
        for token in HEAVY {
            for (index, _) in src.match_indices(token) {
                // 函数定义本身（`pub fn issue_discovery(`）不是调用点
                if src[..index].ends_with("fn ") {
                    continue;
                }
                checked += 1;
                assert!(
                    spans
                        .iter()
                        .any(|(start, end)| *start <= index && index < *end),
                    "{name} 里的 `{token}` 没有落在 `spawn_blocking` 的实参里 —— \
                     它要遍历整棵树（秒级），占着异步线程会把同一 runtime 上的其它命令一起\
                     拖住；写成同步命令则会把整个应用的窗口卡死。"
                );
            }
        }
    }
    assert!(
        checked >= 3,
        "没扫到预期的调用点，守卫已失明（checked={checked}）"
    );
}
