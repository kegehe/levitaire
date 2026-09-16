//! WebView2 桌面化加固
//!
//! 安装版里 WebView2 会把网页端的东西一起带进来：右键弹出「刷新 / 另存为 / 打印 / 检查」
//! 的默认菜单，F5、Ctrl+R、Ctrl+P 之类的浏览器快捷键也会生效，让应用看起来像浏览器页面。
//!
//! Tauri 没有把 wry 的 `with_default_context_menus` 暴露到 `WebviewWindowBuilder`，
//! 因此这里用 `with_webview` 直接取到 `ICoreWebView2Settings`，关掉两项设置：
//!
//! - `AreDefaultContextMenusEnabled`：WebView2 自带的右键菜单。渲染层的
//!   `preventDefault` 只能盖住 DOM 区域，滚动条等非 DOM 区域仍由 WebView2 自己画菜单，
//!   只有原生设置能彻底关掉。
//! - `AreBrowserAcceleratorKeysEnabled`：浏览器专用快捷键（刷新、打印、缩放、
//!   开发者工具、页面前进后退）。**仅在发布版关闭**，debug 版保留，否则开发者无法调试。
//!   该设置不影响文本编辑类快捷键（Ctrl+X/C/V/A/Z、Home/End、方向键）。
//!
//! 两个设置都是 WebView 级、设置后即刻生效，所以每个窗口都要设置一次：前端在每个窗口的
//! 入口（`src/utils/desktopShell.ts`）调用一次 `harden_webview_window` 完成。

use tauri::WebviewWindow;

/// 关掉指定窗口 WebView2 的「网页味」行为。
///
/// 返回 `Err` 只表示加固未能派发到 WebView2 线程（例如窗口正在销毁），调用方按
/// 非致命错误处理即可：渲染层的右键拦截仍然生效。
pub fn harden(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        let label = window.label().to_string();
        window
            .with_webview(move |webview| apply(&webview, &label))
            .map_err(|error| format!("WebView2 加固调度失败: {}", error))
    }

    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(())
    }
}

/// 在 WebView2 所在的 UI 线程上写入设置。失败只记日志，不影响窗口可用性。
#[cfg(windows)]
fn apply(webview: &tauri::webview::PlatformWebview, label: &str) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Settings, ICoreWebView2Settings3,
    };
    use windows::core::Interface;

    let core = match unsafe { webview.controller().CoreWebView2() } {
        Ok(core) => core,
        Err(error) => {
            log_failure(label, "读取 CoreWebView2 失败", &error.to_string());
            return;
        }
    };
    let settings: ICoreWebView2Settings = match unsafe { core.Settings() } {
        Ok(settings) => settings,
        Err(error) => {
            log_failure(label, "读取 WebView2 Settings 失败", &error.to_string());
            return;
        }
    };

    if let Err(error) = unsafe { settings.SetAreDefaultContextMenusEnabled(false) } {
        log_failure(label, "关闭默认右键菜单失败", &error.to_string());
    }

    // debug 版保留浏览器快捷键：F12 / Ctrl+Shift+I 打开开发者工具、Ctrl+R 重新加载页面
    // 是排查问题时的主要手段，发布版才需要它们彻底消失。
    if cfg!(debug_assertions) {
        return;
    }

    // 加速键开关在 ICoreWebView2Settings3 上（WebView2 Runtime ≥ 1.0.864）。
    // 旧运行时 cast 失败：右键菜单已经关掉，这里只记一条日志，不影响窗口可用性。
    match settings.cast::<ICoreWebView2Settings3>() {
        Ok(settings3) => {
            if let Err(error) = unsafe { settings3.SetAreBrowserAcceleratorKeysEnabled(false) } {
                log_failure(label, "关闭浏览器快捷键失败", &error.to_string());
            }
        }
        Err(error) => log_failure(
            label,
            "当前 WebView2 Runtime 不支持关闭浏览器快捷键（需 1.0.864+）",
            &error.to_string(),
        ),
    }
}

#[cfg(windows)]
fn log_failure(label: &str, what: &str, detail: &str) {
    crate::utils::logger::log("hardening", &format!("[{}] {}: {}", label, what, detail));
}
