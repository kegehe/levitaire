//! 子进程启动的统一入口。
//!
//! ## 为什么必须走这里
//!
//! Windows 上，**正式版**（`#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`，
//! 即 GUI 子系统、自身没有控制台）调用 `CreateProcess` 启动一个**控制台程序**
//! （`ffmpeg.exe`、`cmd.exe`、`powershell.exe` …）时，如果不带 `CREATE_NO_WINDOW`，
//! 系统会为子进程**新建一个控制台窗口**并显示出来——这就是「用录屏功能时弹出一个
//! 黑色控制台窗口」的原因。
//!
//! 关键点：把 `stdout` / `stderr` 重定向到 `null` 或管道**并不能**阻止它。重定向只改
//! 标准句柄，控制台窗口是否出现由创建标志决定。开发模式下（`npm run tauri dev`）父进程
//! 已连在终端上、子进程直接继承那个控制台，所以本地调试看不到这个窗口，只有安装包
//! 里才会出现——正是「正式版才有」的原因。
//!
//! 结论：**任何子进程都必须用 [`hidden_command`] 构造**。守卫见本文件测试
//! `production_code_spawns_children_through_hidden_command`（源码级）与
//! `hidden_child_creates_no_console_window`（行为级）。

use std::ffi::OsStr;
use std::process::Command;

/// `CREATE_NO_WINDOW`（winbase.h）：子进程不带控制台**窗口**。
///
/// 注意精确语义（实测，见 `VERIFY.md`）：子进程仍然会拿到一个控制台，只是这个控制台
/// **没有窗口**（子进程自报 `GetConsoleWindow() == 0`），因此用户看不到黑窗。
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 构造一个**不会弹出控制台窗口**的子进程命令。
///
/// 返回的 `Command` 与 `Command::new` 用法完全一致，可以继续链式 `.arg()` /
/// `.stdin()` / `.spawn()`。
pub fn hidden_command<S: AsRef<OsStr>>(program: S) -> Command {
    let mut command = Command::new(program);
    hide_console(&mut command);
    command
}

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    // `creation_flags` 是**覆盖**语义（不是按位或），默认 0，这里显式设成
    // CREATE_NO_WINDOW 即可。将来若需要叠加别的创建标志（如
    // CREATE_UNICODE_ENVIRONMENT），请在这里按位或，不要再写回裸 `Command::new`。
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    // ── hidden_command 的行为 ────────────────────────────────────────

    #[test]
    fn hidden_command_runs_child_and_pipes_stdout() {
        // 创建标志不能破坏正常的 stdin/stdout 接管：这里真正拉起子进程读回它的输出。
        let child = hidden_command("cmd")
            .args(["/c", "echo", "levitaire"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("cmd /c echo should be available on Windows");

        let output = child.wait_with_output().expect("child should exit");
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "levitaire");
    }

    /// 行为守卫：`hidden_command` 起的子进程**不会**产生控制台窗口。
    ///
    /// ## 为什么要在助手进程里做
    ///
    /// `cargo test` 自己就跑在一个控制台里（终端或 ConPTY），子进程会**继承**它——
    /// 「子进程新建控制台窗口」这个现象在测试进程里永远不会发生，有没有
    /// `CREATE_NO_WINDOW` 都一样。这不是推测：早先那版直接在本进程里前后比对窗口列表的
    /// 守卫，在把 `creation_flags` 改坏之后依然全绿。
    ///
    /// 所以这里用 `hidden_command` 拉起 `current_exe()`（同一份测试二进制）当**没有控制台**
    /// 的助手进程——CREATE_NO_WINDOW 让助手拿到一个无窗口控制台，助手再 `FreeConsole()`
    /// 真正脱离它，处境就与正式版（GUI 子系统、从无控制台）一致——由助手起子进程并采样窗口。
    #[cfg(windows)]
    #[test]
    fn hidden_child_creates_no_console_window() {
        if std::env::var(PROBE_HELPER_ENV).ok().as_deref() == Some(PROBE_HELPER_VALUE) {
            // 助手进程：跑真正的判定。
            probe_console_windows_from_consoleless_helper();
            return;
        }

        let helper = hidden_command(std::env::current_exe().expect("current_exe 应当可用"))
            // 只跑本用例自己；助手会因环境变量走上面那条分支。
            .args([
                "--exact",
                "utils::process::tests::hidden_child_creates_no_console_window",
            ])
            .env(PROBE_HELPER_ENV, PROBE_HELPER_VALUE)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .expect("探针助手应当能启动");

        let stdout = String::from_utf8_lossy(&helper.stdout);
        assert!(
            helper.status.success(),
            "探针助手失败（hidden_command 的子进程弹出了控制台窗口？）：\n\
             --- stdout ---\n{stdout}\n--- stderr ---\n{}",
            String::from_utf8_lossy(&helper.stderr),
        );

        // 助手必须真的跑到判定用例：本用例一旦改名，`--exact` 会匹配不到、助手零测试退出，
        // 断言全部落空 → 守卫静默失效。
        assert!(
            stdout.contains("1 passed"),
            "探针助手没有执行到判定用例（用例被改名了？）：\n{stdout}"
        );
    }

    /// 探针助手的身份标记：认的是**变量的完整取值**，不是「变量存在」。
    ///
    /// 若只认「存在」，谁的环境里恰好有个同名变量，测试进程就会把自己当助手——它会
    /// `FreeConsole()` 掉自己的控制台，而真正的判定（在无控制台处境下起子进程）根本没跑。
    #[cfg(windows)]
    const PROBE_HELPER_ENV: &str = "LEVITAIRE_CONSOLE_PROBE_HELPER";
    #[cfg(windows)]
    const PROBE_HELPER_VALUE: &str =
        "utils::process::tests::hidden_child_creates_no_console_window#helper";

    /// 助手进程主体：在**没有控制台**的处境下验证 `hidden_command` 起的子进程不弹控制台窗口。
    #[cfg(windows)]
    fn probe_console_windows_from_consoleless_helper() {
        use windows::Win32::System::Console::{FreeConsole, GetConsoleProcessList};

        /// 采样时长：控制台窗口在子进程创建时就出现，留一点余量即可。
        const SAMPLE: std::time::Duration = std::time::Duration::from_millis(900);

        // 真正脱离控制台。不做这一步，子进程会继承助手这个无窗口控制台、永远不会新建
        // 窗口——判定就成了永远的绿灯。脱离失败则说明前提不成立，直接报红而不是继续。
        let _ = unsafe { FreeConsole() };
        let mut list = [0u32; 8];
        let still_attached = unsafe { GetConsoleProcessList(&mut list) };
        assert_eq!(
            still_attached, 0,
            "助手进程没有真正脱离控制台，本用例的判定不可信"
        );

        let before = console_windows();

        let mut child =
            start_long_running_child(hidden_command("powershell")).expect("起子进程不应失败");
        std::thread::sleep(SAMPLE);
        let alive = child.try_wait().expect("try_wait 不应失败").is_none();
        let after = console_windows();
        let _ = child.kill();
        let _ = child.wait();

        assert!(alive, "采样期间子进程必须仍在运行，否则本用例是假绿");

        // 只认「这个子进程自己的控制台窗口」：控制台窗口的标题默认就是子进程的可执行文件
        // 全路径，按标题过滤可以免受其它程序开终端带来的干扰。
        let leaked: Vec<&String> = after
            .iter()
            .filter(|window| !before.contains(window) && window.to_lowercase().contains("powershell"))
            .collect();
        assert!(
            leaked.is_empty(),
            "hidden_command 起的子进程弹出了控制台窗口：{leaked:?}"
        );

        // 正对照：证明这套探测确实看得见「子进程新建的控制台窗口」。
        assert_positive_control_sees_console_window(&before);
    }

    /// 正对照：用 `CreateProcessW`（`CREATE_NEW_CONSOLE` + `SW_HIDE`）起一个**隐藏**控制台的
    /// 子进程，断言探测能看见这个新窗口——证明上面的「没看到窗口」不是探测失灵。
    ///
    /// 隐藏窗口不会闪，所以这条对照可以放进默认用例。
    #[cfg(windows)]
    fn assert_positive_control_sees_console_window(before: &[String]) {
        use windows::core::{PCWSTR, PWSTR};
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            CreateProcessW, TerminateProcess, CREATE_NEW_CONSOLE, PROCESS_INFORMATION,
            STARTF_USESHOWWINDOW, STARTUPINFOW,
        };
        use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

        const TITLE: &str = "levitaire-console-probe";
        const COMMAND_LINE: &str = "powershell.exe -NoProfile -Command Start-Sleep -Seconds 3";

        let mut command_line: Vec<u16> = COMMAND_LINE
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut title: Vec<u16> = TITLE.encode_utf16().chain(std::iter::once(0)).collect();

        let startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            lpTitle: PWSTR(title.as_mut_ptr()),
            dwFlags: STARTF_USESHOWWINDOW,
            wShowWindow: SW_HIDE.0 as u16,
            ..Default::default()
        };
        let mut info = PROCESS_INFORMATION::default();

        // SAFETY: command_line / title 均以 NUL 结尾且在调用期间存活；startup 与 info
        // 都是栈上有效结构；句柄用完后显式关闭。
        let created = unsafe {
            CreateProcessW(
                PCWSTR::null(),
                Some(PWSTR(command_line.as_mut_ptr())),
                None,
                None,
                false,
                CREATE_NEW_CONSOLE,
                None,
                PCWSTR::null(),
                &startup,
                &mut info,
            )
        };
        assert!(created.is_ok(), "正对照子进程应当能启动：{created:?}");

        // 控制台窗口在进程创建时就存在，留给终端宿主一点时间。
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let mut appeared = false;
        while std::time::Instant::now() < deadline {
            if console_windows()
                .iter()
                .any(|window| !before.contains(window))
            {
                appeared = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        // SAFETY: 句柄来自成功的 CreateProcessW。
        unsafe {
            let _ = TerminateProcess(info.hProcess, 0);
            let _ = CloseHandle(info.hProcess);
            let _ = CloseHandle(info.hThread);
        }

        assert!(
            appeared,
            "正对照失败：隐藏控制台的子进程没有产生可探测到的控制台窗口，本用例的探测不可信"
        );
    }

    /// 起一个会存活几秒的 PowerShell 子进程。
    #[cfg(windows)]
    fn start_long_running_child(mut command: Command) -> std::io::Result<std::process::Child> {
        command
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 3"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    }

    /// 枚举当前所有控制台窗口（`类名: 标题`）。
    ///
    /// **不过滤可见性**：正对照用的是隐藏的控制台窗口，过滤掉就看不见了。
    /// Win11 上控制台窗口有两种宿主：传统 conhost 的 `ConsoleWindowClass`，以及
    /// Windows Terminal 的 `CASCADIA_HOSTING_WINDOW_CLASS`。
    #[cfg(windows)]
    fn console_windows() -> Vec<String> {
        use windows::Win32::Foundation::LPARAM;
        use windows::Win32::UI::WindowsAndMessaging::EnumWindows;

        let mut windows: Vec<String> = Vec::new();
        let context = &mut windows as *mut Vec<String> as isize;

        // SAFETY: EnumWindows 同步阻塞、回调在同一线程执行，context 指向栈上有效 Vec，
        // 函数返回前始终有效。
        unsafe {
            let _ = EnumWindows(Some(collect_console_windows), LPARAM(context));
        }

        windows
    }

    #[cfg(windows)]
    unsafe extern "system" fn collect_console_windows(
        hwnd: windows::Win32::Foundation::HWND,
        lparam: windows::Win32::Foundation::LPARAM,
    ) -> windows::core::BOOL {
        use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetWindowTextW};

        const CONSOLE_WINDOW_CLASSES: [&str; 2] =
            ["ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS"];

        // SAFETY: lparam 指向 console_windows 栈上的 Vec，EnumWindows 同步调用保证有效。
        let windows = &mut *(lparam.0 as *mut Vec<String>);

        let mut class_buffer = [0u16; 256];
        let class_length = GetClassNameW(hwnd, &mut class_buffer);
        if class_length <= 0 {
            return windows::core::BOOL(1);
        }
        let class = String::from_utf16_lossy(&class_buffer[..class_length as usize]);
        if !CONSOLE_WINDOW_CLASSES.contains(&class.as_str()) {
            return windows::core::BOOL(1);
        }

        let mut title_buffer = [0u16; 512];
        let title_length = GetWindowTextW(hwnd, &mut title_buffer);
        let title = String::from_utf16_lossy(&title_buffer[..title_length.max(0) as usize]);

        windows.push(format!("{class}: {title}"));
        windows::core::BOOL(1)
    }

    // ── 源码守卫 ────────────────────────────────────────────────────

    /// 守卫：生产代码里只允许 `hidden_command` 一个子进程构造入口。
    ///
    /// 裸 `Command::new` 会绕过 `CREATE_NO_WINDOW`，正式版一旦拉起控制台程序就会弹黑窗
    /// （见模块头注释）。扫描 `src/` 下所有 `.rs`，忽略 `#[cfg(test)]` 门控的测试模块，
    /// 其余位置出现 `Command::new(` 即失败。确实需要裸 `Command`（例如要自带创建标志的
    /// 极特殊场景）时，把文件加进 `ALLOWED_FILES` 并写明理由。
    ///
    /// 已知局限：把 `Command` 改名导入（`use std::process::Command as X`）后写
    /// `X::new(...)` 可以绕过本守卫——守卫挡的是「顺手直接写 `Command::new`」这个
    /// 最常发生的退化，不是恶意绕过。
    #[test]
    fn production_code_spawns_children_through_hidden_command() {
        const ALLOWED_FILES: &[&str] = &[
            // hidden_command 自身的实现。
            "utils/process.rs",
        ];

        let sources = production_sources();

        // 扫描本身不能是空跑，否则守卫会假绿。
        assert!(
            sources.len() >= 40,
            "只扫到 {} 个源文件，扫描路径可能不对（守卫会假绿）",
            sources.len()
        );
        assert!(
            sources.iter().any(|(relative, _)| relative == "main.rs"),
            "扫描结果里应当包含 main.rs，否则扫描根目录不对"
        );

        let offenders: Vec<String> = sources
            .into_iter()
            .filter(|(relative, body)| {
                !ALLOWED_FILES.contains(&relative.as_str()) && body.contains("Command::new(")
            })
            .map(|(relative, _)| relative)
            .collect();

        assert!(
            offenders.is_empty(),
            "这些文件直接构造了子进程（`Command::new`），正式版会弹出控制台窗口，\
             请改用 `crate::utils::process::hidden_command`：{offenders:?}"
        );
    }

    /// 扫描用的生产代码集合 `(相对路径, 正文)`。
    ///
    /// 两个「不能算生产代码」的排除项：
    /// 1. 文件内 `#[cfg(test)]` 门控的测试模块与测试专用模块文件（见 [`stripped_sources`]）；
    /// 2. 整体只在测试下编译的模块文件（`#[cfg(test)] mod xxx;` 指向的 `xxx.rs`）。
    fn production_sources() -> Vec<(String, String)> {
        let stripped = stripped_sources();
        let test_only = test_only_module_files(&stripped);
        stripped
            .into_iter()
            .filter(|(relative, _, _)| !test_only.contains(relative))
            .map(|(relative, text, _)| (relative, text))
            .collect()
    }

    /// `src/` 下所有 `.rs`：`(相对路径, 剥掉测试模块后的正文, 该文件里被丢掉的测试模块文件名)`。
    ///
    /// 第三个元素是「整体只在测试下编译」的文件线索（`#[cfg(test)] mod xxx;` 里的 `xxx`），
    /// **由剥离器自己报告**——剥离之后那行声明已经不在了，事后再解析是查不到的。
    ///
    /// 顺序也重要：先逐文件剥离、再统计测试专用文件。反过来做会把测试代码里的**夹具字符串**
    /// （本文件自己就写着 `#[cfg(test)] mod accuracy_test;` 这种样例）当成真实模块声明，
    /// 凭空产出「测试专用文件」路径；万一撞上真实存在的生产文件，那个文件就会被整体移出
    /// 扫描范围（漏检）。
    fn stripped_sources() -> Vec<(String, String, Vec<String>)> {
        let mut stripped: Vec<(String, String, Vec<String>)> = raw_sources()
            .into_iter()
            .map(|(relative, text)| {
                let (kept, gated_files) = strip_test_modules(&text);
                (relative, kept, gated_files)
            })
            .collect();
        stripped.sort();
        stripped
    }

    /// 读取 `src/` 下所有 `.rs`（`(相对路径, 原文)`），不做任何剥离。
    fn raw_sources() -> Vec<(String, String)> {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        collect_rust_files(&root, &mut files);

        let mut raw: Vec<(String, String)> = files
            .into_iter()
            .map(|path| {
                let relative = path
                    .strip_prefix(&root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                // 读不出来必须报错：静默跳过等于让守卫对那个文件失明。
                let (text, error) = match std::fs::read_to_string(&path) {
                    Ok(text) => (text, None),
                    Err(error) => (String::new(), Some(error.to_string())),
                };
                assert!(error.is_none(), "读取 {relative} 失败：{error:?}");
                (relative, text)
            })
            .collect();
        raw.sort();
        raw
    }

    /// 收集「整体只在测试下编译」的模块文件（相对路径）。
    ///
    /// 例：`ocr/mod.rs` 里的 `#[cfg(test)] mod accuracy_test;` → `ocr/accuracy_test.rs`。
    /// 这类文件的代码不会进正式包，不该按生产代码的规矩要求——否则测试代码里出现
    /// `Command::new` 会让守卫误报（报错信息还会让人以为是生产代码的问题）。
    ///
    /// 同名模块若**另有**不带门控的声明（同一文件被两处引用），就不算测试专用：那种写法下
    /// 代码确实会进正式包，跳过它就是漏检。
    fn test_only_module_files(
        sources: &[(String, String, Vec<String>)],
    ) -> std::collections::HashSet<String> {
        let mut gated = std::collections::HashSet::new();
        let mut ungated = std::collections::HashSet::new();

        for (relative, text, gated_files) in sources {
            let directory = module_directory(relative);
            for name in gated_files {
                gated.insert(format!("{directory}{name}.rs"));
            }
            // 剥离后的正文里只剩不带门控的声明。
            for name in declared_modules(text) {
                ungated.insert(format!("{directory}{name}.rs"));
            }
        }

        gated.difference(&ungated).cloned().collect()
    }

    /// 声明方文件 → 它里面 `mod xxx;` 指向的目录（Rust 2018 的模块文件规则）。
    ///
    /// - 包根（`main.rs` / `lib.rs`）与 `mod.rs`：子模块在**同目录**（`src/foo.rs`）；
    /// - 其它文件 `foo.rs`：子模块在**子目录**（`src/foo/bar.rs`）。
    ///
    /// 这条规则算错会出「把生产文件当测试专用而整体跳过」的漏检，所以按真实规则算。
    fn module_directory(relative: &str) -> String {
        let (directory, file) = match relative.rsplit_once('/') {
            Some((dir, file)) => (format!("{dir}/"), file),
            None => (String::new(), relative),
        };
        match file {
            "main.rs" | "lib.rs" | "mod.rs" => directory,
            other => format!("{directory}{}/", other.strip_suffix(".rs").unwrap_or(other)),
        }
    }

    /// 收集文件里的**顶层** `mod xxx;` 声明（模块名）。调用方传的是**已剥离**的正文，
    /// 所以这里只会拿到不带门控的声明。
    /// 内联模块（`mod xxx { … }`）不返回——它们的正文由 [`strip_test_modules`] 处理。
    fn declared_modules(source: &str) -> Vec<String> {
        let mut declared = Vec::new();

        for line in source.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with("#[") {
                continue;
            }
            // 只认顶层声明（rustfmt 下顶层无缩进）。
            if line.len() == line.trim_start().len() {
                if let Some(name) = module_file_declaration(trimmed) {
                    declared.push(name);
                }
            }
        }

        declared
    }

    /// `mod foo;` / `pub mod foo;` / `pub(crate) mod foo;` → `Some("foo")`；
    /// 内联模块（`{`）或嵌套路径返回 `None`。
    fn module_file_declaration(trimmed: &str) -> Option<String> {
        let rest = trimmed
            .strip_prefix("pub(crate) mod ")
            .or_else(|| trimmed.strip_prefix("pub mod "))
            .or_else(|| trimmed.strip_prefix("mod "))?;
        let name = rest.strip_suffix(';')?;
        if name.is_empty() || !name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
            return None;
        }
        Some(name.to_string())
    }

    fn collect_rust_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_rust_files(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }

    /// 去掉 `#[cfg(test)]` 门控的测试模块（`#[cfg(test)]` + `mod xxx;` / `mod xxx {}`）。
    ///
    /// 返回 `(保留下来的正文, 被丢掉的模块文件名)`。第二个值用于识别「整体只在测试下编译」
    /// 的文件：`#[cfg(test)] mod accuracy_test;` 里的 `accuracy_test` 对应
    /// `accuracy_test.rs`，那个文件不该按生产代码要求。**必须由本函数报告**——剥离之后那行
    /// 声明已经不在了，事后再解析是查不到的。
    ///
    /// **只丢这个被门控的 `mod` 项本身，不丢它后面的代码**：本仓库 `ocr/mod.rs` 就是
    /// 「文件开头两个测试 `mod`、后面还有 200 行生产代码」的形状，早先的实现在第一个
    /// `#[cfg(test)]` 处直接截断到文件末尾，等于让那 200 行不参与扫描（漏检）。
    ///
    /// 只有**紧跟 `mod` 项**的 `#[cfg(test)]` 才算测试模块；普通的 `#[cfg(test)] use ...`
    /// （例如 `quick_input.rs` 里的写法）不算，避免把后面的生产代码误判成测试代码。
    ///
    /// 本函数要求 `#[cfg(test)]` **独占一行**（rustfmt 的默认行为）。遇到
    /// `#[cfg(test)] mod xxx;` 这种单行写法会直接报红：那时候既看不清模块边界，又可能把测试
    /// 代码当成生产代码，静默误判比报错更糟。
    fn strip_test_modules(source: &str) -> (String, Vec<String>) {
        let lines: Vec<&str> = source.lines().collect();
        let mut kept: Vec<&str> = Vec::with_capacity(lines.len());
        let mut gated_files: Vec<String> = Vec::new();
        let mut index = 0;

        while index < lines.len() {
            let trimmed = lines[index].trim();
            match trimmed.strip_prefix("#[cfg(test)]") {
                // 属性独占一行：丢掉它门控的那个 `mod` 项，后面的代码照样保留。
                Some(remainder) if remainder.split("//").next().unwrap_or("").trim().is_empty() => {
                    if let Some(end) = gated_module_end(&lines, index + 1) {
                        if let Some(name) = gated_module_file_name(&lines, index + 1) {
                            gated_files.push(name);
                        }
                        index = end;
                        continue;
                    }
                }
                // 单行写法：`#[cfg(test)] mod xxx;` / `#[cfg(test)] mod xxx {`
                Some(remainder) if is_module_declaration(remainder.trim_start()) => {
                    panic!(
                        "`strip_test_modules` 不支持 `#[cfg(test)] mod …` 写在同一行（第 {} 行）：{trimmed}\n\
                         请把属性和 `mod` 拆成两行（rustfmt 的默认行为），或扩展本函数。",
                        index + 1
                    );
                }
                _ => {}
            }
            kept.push(lines[index]);
            index += 1;
        }

        (kept.join("\n"), gated_files)
    }

    /// 被门控的若是 `mod xxx;`（测试代码在别的文件里），返回 `xxx`。
    fn gated_module_file_name(lines: &[&str], from: usize) -> Option<String> {
        let mut index = from;
        while index < lines.len() {
            let trimmed = lines[index].trim();
            if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with("#[") {
                index += 1;
                continue;
            }
            break;
        }
        module_file_declaration(lines.get(index)?.trim())
    }

    fn is_module_declaration(text: &str) -> bool {
        text.starts_with("mod ")
            || text.starts_with("pub mod ")
            || text.starts_with("pub(crate) mod ")
    }

    /// 若 `lines[from..]` 起是一个 `mod` 项（`#[cfg(test)]` 后面那个），返回该 `mod` 项
    /// **结束之后**的行号；不是 `mod` 项则返回 `None`。
    fn gated_module_end(lines: &[&str], from: usize) -> Option<usize> {
        // 跳过空行、注释与叠加的其它属性（`#[allow(...)]` 之类）。
        let mut index = from;
        while index < lines.len() {
            let trimmed = lines[index].trim();
            if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with("#[") {
                index += 1;
                continue;
            }
            break;
        }

        let item = lines.get(index)?.trim();
        let is_module = item.starts_with("mod ")
            || item.starts_with("pub mod ")
            || item.starts_with("pub(crate) mod ");
        if !is_module {
            return None;
        }

        // `mod xxx;`：单行声明，测试代码在别的文件里。
        if item.ends_with(';') {
            return Some(index + 1);
        }

        // 内联模块：跳到顶层收尾的 `}`。rustfmt 下顶层块的右花括号独占一行且无缩进。
        let mut cursor = index + 1;
        while cursor < lines.len() {
            if lines[cursor] == "}" {
                return Some(cursor + 1);
            }
            cursor += 1;
        }
        Some(lines.len())
    }

    #[test]
    fn strip_test_modules_drops_gated_test_modules() {
        let source =
            "fn production() {}\n#[cfg(test)]\nmod tests {\n    fn t() { Command::new(\"x\"); }\n}\n";
        let (stripped, gated) = strip_test_modules(source);
        assert!(stripped.contains("fn production"));
        assert!(!stripped.contains("Command::new"));
        assert!(gated.is_empty(), "内联测试模块不产生跳过项：{gated:?}");
    }

    #[test]
    #[should_panic(expected = "不支持 `#[cfg(test)] mod …` 写在同一行")]
    fn strip_test_modules_rejects_single_line_gated_module() {
        // 单行写法看不清模块边界，宁可显式报红也不要静默误判。
        let _ = strip_test_modules("#[cfg(test)] mod helper;\nfn production() {}\n");
    }

    #[test]
    fn test_only_module_files_skips_gated_module_files() {
        // `#[cfg(test)] mod helper;` → `helper.rs` 整体只在测试下编译，不该按生产代码要求。
        let test_only = test_only_of(&[
            ("ocr/mod.rs", "#[cfg(test)]\nmod helper;\npub mod engine;\n"),
            ("ocr/helper.rs", "fn t() { Command::new(\"cmd\").spawn(); }\n"),
        ]);
        assert!(test_only.contains("ocr/helper.rs"));
        assert!(!test_only.contains("ocr/mod.rs"), "声明方本身仍是生产代码");
        assert!(!test_only.contains("ocr/engine.rs"), "没被门控的模块文件不能跳过");
    }

    #[test]
    fn test_only_module_files_resolves_rust_2018_module_paths() {
        // `foo.rs` 里的 `mod bar;` 指的是 `foo/bar.rs`，不是同级的 `bar.rs`——
        // 算成同级会把一个同名的生产文件误当成测试专用而整体跳过（漏检）。
        let test_only = test_only_of(&[
            ("foo.rs", "#[cfg(test)]\nmod bar;\n"),
            ("bar.rs", "fn production() {}\n"),
            ("foo/bar.rs", "fn t() {}\n"),
        ]);
        assert!(
            test_only.contains("foo/bar.rs"),
            "子目录里的模块才是测试专用：{test_only:?}"
        );
        assert!(
            !test_only.contains("bar.rs"),
            "同级的同名生产文件不能被跳过（漏检）：{test_only:?}"
        );
    }

    #[test]
    fn module_directory_follows_crate_root_and_mod_rs_rules() {
        assert_eq!(module_directory("main.rs"), "");
        assert_eq!(module_directory("ocr/mod.rs"), "ocr/");
        assert_eq!(module_directory("ocr/engine.rs"), "ocr/engine/");
        assert_eq!(module_directory("a/b/c.rs"), "a/b/c/");
    }

    /// 真实仓库里「整体不参与扫描」的文件必须只有已知的那几个。
    ///
    /// 两个方向都断言：
    /// - 不能多（多出就等于把一个文件移出了扫描范围——那正是漏检的方向，必须显式确认）；
    /// - 已知的必须真的被识别出来（否则说明解析失效，本用例在空跑）。
    #[test]
    fn scan_skips_only_known_test_only_module_files() {
        const KNOWN: &[&str] = &["ocr/accuracy_test.rs", "ocr/windows_ocr.rs"];
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");

        let test_only = test_only_module_files(&stripped_sources());
        let unknown: Vec<&String> = test_only
            .iter()
            .filter(|relative| !KNOWN.contains(&relative.as_str()))
            .collect();
        assert!(
            unknown.is_empty(),
            "出现了新的「整体不参与扫描」文件：{unknown:?}\n\
             请确认它确实只在 `#[cfg(test)]` 下编译，再把它加进本用例的 KNOWN。"
        );

        for known in KNOWN {
            if root.join(known).is_file() {
                assert!(
                    test_only.contains(*known),
                    "{known} 只在测试下编译，却没被识别为测试专用（解析失效？）：{test_only:?}"
                );
            }
        }
    }

    #[test]
    fn test_only_module_files_keeps_modules_with_ungated_declaration() {
        // 同一个模块同时有不带门控的声明 → 代码会进正式包，不能跳过。
        let test_only = test_only_of(&[
            ("a.rs", "#[cfg(test)]\nmod shared;\n"),
            ("b.rs", "mod shared;\n"),
        ]);
        assert!(
            !test_only.contains("shared.rs"),
            "有不带门控的声明时不能当成测试专用：{test_only:?}"
        );
    }

    #[test]
    fn test_only_module_files_ignores_declarations_inside_test_code() {
        // 测试模块里的声明（含夹具字符串里的）不算真实模块声明：真按它跳过，可能把
        // 一个真实存在的生产文件整体移出扫描范围（漏检）。
        let test_only = test_only_of(&[
            (
                "foo.rs",
                "#[cfg(test)]\nmod tests {\n    #[cfg(test)]\n    mod fixture;\n}\n",
            ),
            ("foo/fixture.rs", "fn production() {}\n"),
        ]);
        assert!(
            test_only.is_empty(),
            "测试代码里的声明不该产生跳过项：{test_only:?}"
        );
    }

    /// 测试用：把 `(路径, 原文)` 走一遍真实管线（剥离 → 解析测试专用文件）。
    fn test_only_of(sources: &[(&str, &str)]) -> std::collections::HashSet<String> {
        let stripped: Vec<(String, String, Vec<String>)> = sources
            .iter()
            .map(|(relative, text)| {
                let (kept, gated) = strip_test_modules(text);
                (relative.to_string(), kept, gated)
            })
            .collect();
        test_only_module_files(&stripped)
    }

    #[test]
    fn declared_modules_ignores_nested_and_inline_declarations() {
        // 内联测试模块（`mod tests { … }`）与其内部缩进的 `mod helper;` 都不是顶层**文件**
        // 模块声明，不能据此把同名文件当测试专用（那会造成漏检——最危险的方向）。
        let source = "#[cfg(test)]\nmod tests {\n    mod helper;\n}\nmod real;\n";
        let declared = declared_modules(source);
        assert_eq!(
            declared,
            vec!["real".to_string()],
            "只应收集顶层的文件模块声明：{declared:?}"
        );
    }

    #[test]
    fn strip_test_modules_keeps_unrelated_cfg_test_imports() {
        // `#[cfg(test)] use ...` 不是测试模块，不能因此丢掉后面的生产代码。
        let source = "#[cfg(test)]\nuse std::sync::Once;\nfn production() { Command::new(\"x\"); }\n";
        let (stripped, gated) = strip_test_modules(source);
        assert!(stripped.contains("Command::new"));
        assert!(gated.is_empty(), "这不是模块声明，不该产生跳过项：{gated:?}");
    }

    #[test]
    fn strip_test_modules_keeps_production_code_between_test_modules() {
        // `ocr/mod.rs` 的真实形状：开头就有 `#[cfg(test)] mod xxx;`，中间还有生产代码。
        let source = r#"
#[cfg(test)]
mod accuracy_test;
pub mod engine;
#[cfg(test)]
mod windows_ocr;

use std::sync::Mutex;

fn production() { Command::new("x"); }

#[cfg(test)]
#[allow(clippy::too_many_lines)]
mod tests {
    fn t() { Command::new("y"); }
}
"#;
        let (stripped, gated) = strip_test_modules(source);
        assert!(stripped.contains("pub mod engine;"), "中间的生产代码不能丢");
        assert!(stripped.contains("use std::sync::Mutex;"), "中间的生产代码不能丢");
        assert!(
            stripped.contains(r#"Command::new("x")"#),
            "夹在测试模块之间的生产代码必须参与扫描"
        );
        assert!(
            !stripped.contains(r#"Command::new("y")"#),
            "末尾内联测试模块里的代码应被剥掉"
        );
        assert_eq!(
            gated,
            vec!["accuracy_test".to_string(), "windows_ocr".to_string()],
            "被丢掉的 `mod xxx;` 文件名要报告出来（供识别测试专用文件）"
        );
    }
}
