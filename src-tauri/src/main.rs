// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// ONNX Runtime DLL 加载：开发模式在仓库 libs/ 目录，发布模式在 exe 同目录（由 tauri resources 打包）。
// ort 的 load-dynamic feature 在首次调用 ort::api() 时自动加载 DLL，
// 查找优先级: ORT_DYLIB_PATH 环境变量 > 当前目录 onnxruntime.dll > exe 同目录。
fn init_ort_dylib() {
    use std::path::PathBuf;
    let candidates: &[fn() -> Option<PathBuf>] = &[
        // 1. ORT_DYLIB_PATH 环境变量（用户显式指定，最高优先级）
        || {
            std::env::var("ORT_DYLIB_PATH")
                .ok()
                .map(PathBuf::from)
                .filter(|p| p.exists())
        },
        // 2. 仓库 libs/ 目录（开发模式 cargo tauri dev）
        || {
            let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("libs")
                .join("onnxruntime.dll");
            p.exists().then_some(p)
        },
        // Tauri 发布包的 resource_dir 通常位于 exe 同级 resources/。
        || {
            let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
            [
                exe_dir.join("onnxruntime.dll"),
                exe_dir.join("resources").join("onnxruntime.dll"),
            ]
            .into_iter()
            .find(|p| p.exists())
        },
    ];
    for candidate in candidates {
        if let Some(path) = candidate() {
            std::env::set_var("ORT_DYLIB_PATH", &path);
            crate::utils::logger::log("ort", &format!("ONNX Runtime DLL: {}", path.display()));
            return;
        }
    }
    // 未找到本地 DLL，ort 将在首次调用时尝试当前目录/exe 同目录加载
    crate::utils::logger::log("ort", "未找到本地 onnxruntime.dll，运行时将搜索默认路径");
}

mod ai;
mod automation;
mod clipboard;
mod commands;
mod config;
mod hooks;
mod monitor;
mod ocr;
mod pomodoro;
mod quick_input;
mod recording;
mod screenshot;
mod scroll_navigation;
mod scroll_capture;
mod sound;
mod sticky_note;
mod todo;
mod tts;
mod timer;
mod updater;
mod utils;
mod webview_hardening;
mod window_pin;

use tauri::{
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

// Retained for compatibility with older callers; native surfaces now use the
// bundled app icon below instead of drawing a preference-dependent tray glyph.
#[allow(dead_code)]
const TRAY_ICON_CENTER: f32 = 16.0;
#[allow(dead_code)]
const TRAY_ICON_SCALE: f32 = 1.25;

#[allow(dead_code)]
fn tray_coord(value: i32) -> i32 {
    ((value as f32 - TRAY_ICON_CENTER) * TRAY_ICON_SCALE + TRAY_ICON_CENTER).round() as i32
}

#[allow(dead_code)]
fn tray_pixel(raw: &mut [u8], x: i32, y: i32, color: [u8; 4]) {
    if !(0..32).contains(&x) || !(0..32).contains(&y) {
        return;
    }
    let i = ((y * 32 + x) * 4) as usize;
    raw[i..i + 4].copy_from_slice(&color);
}

#[allow(dead_code)]
fn tray_line(raw: &mut [u8], mut x0: i32, mut y0: i32, x1: i32, y1: i32, color: [u8; 4]) {
    x0 = tray_coord(x0);
    y0 = tray_coord(y0);
    let x1 = tray_coord(x1);
    let y1 = tray_coord(y1);
    let dx = (x1 - x0).abs();
    let sx = if x0 < x1 { 1 } else { -1 };
    let dy = -(y1 - y0).abs();
    let sy = if y0 < y1 { 1 } else { -1 };
    let mut err = dx + dy;
    loop {
        tray_pixel(raw, x0, y0, color);
        tray_pixel(raw, x0 + 1, y0, color);
        tray_pixel(raw, x0, y0 + 1, color);
        if x0 == x1 && y0 == y1 { break; }
        let e2 = 2 * err;
        if e2 >= dy { err += dy; x0 += sx; }
        if e2 <= dx { err += dx; y0 += sy; }
    }
}

#[allow(dead_code)]
fn tray_circle(raw: &mut [u8], cx: i32, cy: i32, r: i32, color: [u8; 4], fill: bool) {
    let cx = tray_coord(cx);
    let cy = tray_coord(cy);
    let r = (r as f32 * TRAY_ICON_SCALE).round() as i32;
    for y in (cy - r)..=(cy + r) {
        for x in (cx - r)..=(cx + r) {
            let d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
            if (fill && d <= r * r) || (!fill && d <= r * r && d >= (r - 2) * (r - 2)) {
                tray_pixel(raw, x, y, color);
            }
        }
    }
}

#[allow(dead_code)]
fn tray_accent_color(accent: &str, hover: bool) -> [u8; 4] {
    let (normal, highlighted) = match accent {
        "cyan" => ([8, 145, 178], [14, 184, 214]),
        "teal" => ([10, 127, 117], [16, 164, 150]),
        "green" => ([22, 145, 88], [34, 181, 115]),
        "indigo" => ([79, 70, 190], [103, 92, 232]),
        "violet" => ([123, 88, 189], [151, 114, 220]),
        _ => ([37, 99, 210], [59, 130, 246]),
    };
    let rgb = if hover { highlighted } else { normal };
    [rgb[0], rgb[1], rgb[2], 255]
}

#[allow(dead_code)]
pub(crate) fn tray_orb_image(
    id: &str,
    hover: bool,
    accent: &str,
) -> tauri::image::Image<'static> {
    let mut raw = vec![0u8; 32 * 32 * 4];
    let fg = tray_accent_color(accent, hover);
    match id {
        "ufo" => {
            tray_line(&mut raw, 7, 16, 25, 16, fg);
            tray_line(&mut raw, 11, 13, 21, 13, fg);
            tray_line(&mut raw, 13, 13, 14, 10, fg);
            tray_line(&mut raw, 14, 10, 18, 10, fg);
            tray_line(&mut raw, 18, 10, 19, 13, fg);
        }
        "butterfly" => { tray_line(&mut raw, 16, 13, 16, 24, fg); tray_circle(&mut raw, 11, 12, 4, fg, false); tray_circle(&mut raw, 21, 12, 4, fg, false); tray_circle(&mut raw, 12, 19, 3, fg, false); tray_circle(&mut raw, 20, 19, 3, fg, false); }
        "balloon" => { tray_circle(&mut raw, 16, 12, 7, fg, false); tray_line(&mut raw, 16, 19, 16, 23, fg); tray_line(&mut raw, 12, 24, 20, 24, fg); }
        "rocket" => { tray_line(&mut raw, 16, 7, 22, 19, fg); tray_line(&mut raw, 22, 19, 10, 19, fg); tray_line(&mut raw, 10, 19, 16, 7, fg); tray_circle(&mut raw, 16, 13, 2, fg, false); tray_line(&mut raw, 12, 19, 9, 23, fg); tray_line(&mut raw, 20, 19, 23, 23, fg); }
        "cloud" => { tray_circle(&mut raw, 11, 17, 5, fg, false); tray_circle(&mut raw, 17, 14, 7, fg, false); tray_circle(&mut raw, 22, 18, 4, fg, false); tray_line(&mut raw, 8, 21, 24, 21, fg); }
        "plane" => { tray_line(&mut raw, 25, 8, 7, 16, fg); tray_line(&mut raw, 7, 16, 14, 18, fg); tray_line(&mut raw, 14, 18, 17, 24, fg); tray_line(&mut raw, 17, 24, 25, 8, fg); tray_line(&mut raw, 14, 18, 20, 13, fg); }
        "dandelion" => { tray_line(&mut raw, 16, 13, 16, 25, fg); for (x, y) in [(16, 7), (10, 10), (22, 10), (8, 15), (24, 15), (12, 6), (20, 6)] { tray_line(&mut raw, 16, 14, x, y, fg); tray_circle(&mut raw, x, y, 1, fg, true); } }
        "kite" => { tray_line(&mut raw, 16, 6, 23, 14, fg); tray_line(&mut raw, 23, 14, 16, 22, fg); tray_line(&mut raw, 16, 22, 9, 14, fg); tray_line(&mut raw, 9, 14, 16, 6, fg); tray_line(&mut raw, 16, 6, 16, 22, fg); tray_line(&mut raw, 9, 14, 23, 14, fg); tray_line(&mut raw, 16, 22, 19, 26, fg); }
        "bubble" => { tray_circle(&mut raw, 16, 15, 8, fg, false); tray_circle(&mut raw, 11, 11, 2, fg, false); tray_circle(&mut raw, 12, 12, 1, fg, true); }
        "jellyfish" => { tray_circle(&mut raw, 16, 13, 8, fg, false); tray_line(&mut raw, 9, 15, 23, 15, fg); for x in [10, 14, 18, 22] { tray_line(&mut raw, x, 16, x - 1, 24, fg); } }
        _ => { tray_circle(&mut raw, 16, 16, 8, fg, false); tray_circle(&mut raw, 16, 16, 2, fg, true); }
    }
    tauri::image::Image::new_owned(raw, 32, 32)
}

const APP_ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");

/// The native application icon is bundled with the installer. Keep tray and
/// title-bar surfaces branded consistently, regardless of orb preferences.
pub(crate) fn app_icon_image() -> tauri::image::Image<'static> {
    let source = image::load_from_memory(APP_ICON_PNG)
        .expect("bundled application icon is invalid")
        .to_rgba8();
    let resized = image::imageops::resize(
        &source,
        32,
        32,
        image::imageops::FilterType::Lanczos3,
    );
    tauri::image::Image::new_owned(resized.into_raw(), 32, 32)
}

fn main() {
    // 初始化 ONNX Runtime DLL 搜索路径（ort load-dynamic 模式，在 OCR 线程前调用）
    init_ort_dylib();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        // 单实例限制：第二个实例启动时直接退出，并激活已有实例
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("orb") {
                let _ = window.show();
                let _ = window.set_focus();
                // 单实例激活会强制显示 orb，需同步鼠标钩子可见状态
                crate::hooks::set_orb_visible(true);
            }
        }))
        // 在线更新：由 tauri-plugin-updater 提供，版本检查 endpoint 与签名公钥
        // 见 tauri.conf.json 的 plugins.updater。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // 清理上次运行遗留的贴图临时文件
            crate::screenshot::pin::cleanup_stale_temp_files();

            // 初始化配置管理器
            let config_manager = config::ConfigManager::new();

            // 一次性读取启动时需要的所有配置（减少加锁次数）
            let startup_config = config_manager.get_startup_config()?;

            // 使用配置中的 AI 设置初始化 AI 服务
            // 环境变量仅在配置值为空时作为 fallback，不写回配置文件
            let mut ai_config = startup_config.ai_config;

            if ai_config.api_key.is_empty() {
                if let Ok(key) = std::env::var("LEVITAIRE_AI_API_KEY") {
                    ai_config.api_key = key;
                }
            }
            if ai_config.base_url.is_empty() {
                if let Ok(url) = std::env::var("LEVITAIRE_AI_BASE_URL") {
                    ai_config.base_url = url;
                }
            }
            if ai_config.model.is_empty() {
                if let Ok(model) = std::env::var("LEVITAIRE_AI_MODEL") {
                    ai_config.model = model;
                }
            }

            let ai_service = ai::AiService::new(ai_config);
            app.manage(ai_service);

            // 初始化截图启用标志（热键触发时检查）
            hooks::hotkey::set_screenshot_enabled(startup_config.screenshot_enabled);
            hooks::hotkey::set_slot_enabled(
                hooks::hotkey::HotkeySlotId::Sketch,
                startup_config.sketch_enabled,
            );
            let startup_sketch_hotkey = startup_config.sketch_hotkey.clone();
            std::thread::spawn(move || {
                for _ in 0..40 {
                    if startup_sketch_hotkey.is_empty() {
                        break;
                    }
                    match hooks::hotkey::register_hotkey(
                        hooks::hotkey::HotkeySlotId::Sketch,
                        &startup_sketch_hotkey,
                    ) {
                        Ok(_) => break,
                        Err(error) if error == "热键线程未就绪" => {
                            std::thread::sleep(std::time::Duration::from_millis(50))
                        }
                        Err(error) => {
                            crate::utils::logger::log(
                                "hotkey",
                                &format!("草稿快捷键注册失败: {}", error),
                            );
                            break;
                        }
                    }
                }
            });
            // 初始化文字工具栏启用标志（鼠标钩子选区检测时检查）
            hooks::mouse::set_text_toolbar_enabled(startup_config.text_toolbar_enabled);

            // 初始化录屏启用标志
            hooks::hotkey::set_slot_enabled(
                hooks::hotkey::HotkeySlotId::Recording,
                startup_config.recording_enabled,
            );
            hooks::hotkey::set_slot_enabled(
                hooks::hotkey::HotkeySlotId::TodoQuickAdd,
                startup_config.todo_enabled,
            );
            let startup_todo_quick_add_hotkey = startup_config.todo_quick_add_hotkey.clone();
            if startup_config.todo_enabled && !startup_todo_quick_add_hotkey.is_empty() {
                std::thread::spawn(move || {
                    for _ in 0..40 {
                        match hooks::hotkey::register_hotkey(
                            hooks::hotkey::HotkeySlotId::TodoQuickAdd,
                            &startup_todo_quick_add_hotkey,
                        ) {
                            Ok(_) => return,
                            Err(error) if error == "热键线程未就绪" => {
                                std::thread::sleep(std::time::Duration::from_millis(50));
                            }
                            Err(error) => {
                                crate::utils::logger::log(
                                    "hotkey",
                                    &format!("待办快速添加快捷键注册失败: {}", error),
                                );
                                return;
                            }
                        }
                    }
                });
            }

            // 初始化快速输入转盘触发键（启用且键有效时设置 vk_code）
            {
                // 先应用历史保留条数，再从本地文件恢复，确保旧历史按新设置裁剪。
                let qi_history_enabled = config_manager
                    .get_quick_input_history_enabled()
                    .unwrap_or(true);
                quick_input::set_history_enabled(qi_history_enabled);
                let qi_history_limit = config_manager
                    .get_quick_input_history_limit()
                    .unwrap_or(quick_input::HISTORY_DEFAULT_LIMIT);
                quick_input::set_history_limit(qi_history_limit);
                quick_input::load_history();
                let qi_enabled = config_manager.get_quick_input_enabled().unwrap_or(false);
                let qi_key = config_manager
                    .get_quick_input_trigger_key()
                    .unwrap_or_default();
                let qi_key = if qi_key.is_empty() {
                    "CapsLock".to_string()
                } else {
                    qi_key
                };
                let vk = if qi_enabled {
                    quick_input::parse_trigger_key(&qi_key).unwrap_or(0)
                } else {
                    0
                };
                quick_input::set_trigger_vk(vk);
                // 同步触发模式（默认单击切换：键有效时转盘才被唤起，模式需与配置一致）
                let qi_mode = config_manager
                    .get_quick_input_mode()
                    .unwrap_or_else(|_| "click".to_string());
                quick_input::set_mode(if qi_mode == "hold" {
                    quick_input::MODE_HOLD
                } else {
                    quick_input::MODE_CLICK
                });
                // 启用时预创建转盘 overlay 窗口，确保键盘钩子触发 begin_wheel 时
                // emit_to("quick-input-overlay") 能找到目标。窗口已存在时为空操作。
                if qi_enabled {
                    quick_input::ensure_window(app.handle()).ok();
                }
            }

            app.manage(config_manager);
            // 截图全屏画面缓存（进入截图模式时填充，退出时清空）
            app.manage(screenshot::ScreenCache::default());
            app.manage(scroll_capture::LongCaptureState::default());

            // PaddleOCR 模型随安装包分发，优先使用 resource_dir/ocr；
            // 若资源不存在，paddle_ocr 会回退到用户数据目录以兼容旧版本。
            if let Ok(resource_dir) = app.path().resource_dir() {
                let model_dir = resource_dir.join("ocr");
                if model_dir.is_dir() {
                    std::env::set_var("LEVITAIRE_OCR_MODEL_DIR", &model_dir);
                    crate::utils::logger::log(
                        "ocr",
                        &format!("使用安装包内 OCR 模型目录: {}", model_dir.display()),
                    );
                }
            }

            // 初始化钩子管理器
            let hook_manager = hooks::HookManager::new();
            app.manage(hook_manager);

            // 初始化剪贴板管理器
            let clipboard_manager = clipboard::ClipboardManager::new();
            app.manage(clipboard_manager);

            // 初始化 TTS 朗读状态（持有当前播放的 MediaPlayer）
            app.manage(tts::TtsState::default());

            // Todo data is independent from config.json and survives all overlay windows.
            app.manage(todo::TodoStore::new());
            todo::start_scheduler(app.handle().clone());

            // 便利贴数据独立于 config.json，窗口按需创建/销毁，数据长期保留。
            app.manage(sticky_note::NoteStore::new());

            // 初始化系统监控状态（采集线程随监控窗口开关启停，此处仅注册 state）
            app.manage(monitor::MonitorState::default());

            // 初始化番茄钟状态（计时线程随 start/stop 启停，此处仅注册 state）。
            // 启动时从持久化配置恢复用户设置（时长、提醒方式等），避免重启后
            // 回退默认配置、与设置页显示不一致；配置缺失或损坏时回退默认值。
            let pomodoro_state = {
                let state = pomodoro::PomodoroState::default();
                if let Ok(config_json) = app.state::<config::ConfigManager>().get_pomodoro_config()
                {
                    if let Ok(config) =
                        serde_json::from_str::<pomodoro::PomodoroConfig>(&config_json)
                    {
                        state.set_config(config);
                    }
                }
                state
            };
            app.manage(pomodoro_state);

            app.manage(timer::TimerState::new());
            timer::start_scheduler(app.handle().clone());

            // 初始化录屏状态（录制线程随录制开关启停，此处仅注册 state）
            app.manage(recording::RecordingState::default());

            // 初始化在线更新状态，并启动后台周期检测：
            // 首次延迟检查 + 每 24h 复检；检测到新版本时**静默下载**，下载完成
            // 才由 update-prompt 窗口提示「已就绪，点击即装」（见 updater/mod.rs）。
            app.manage(updater::UpdaterState::default());
            updater::start_periodic_check(app.handle().clone());

            // OCR 服务改为首次实际使用时懒加载（见 ocr::ensure_ocr_service），
            // 启动时不再加载模型，避免占用内存与启动开销。

            // settings 和 palette 窗口的关闭拦截已移至 show_settings/show_palette 命令中
            // （延迟创建窗口时，在首次 show 时注册关闭拦截）

            let tray_icon = app_icon_image();
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon.clone())
                .tooltip("Levitaire")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "toggle_orb" => {
                            if crate::commands::is_orb_ready() {
                                if let Some(window) = app.get_webview_window("orb") {
                                    if window.is_visible().unwrap_or(false) {
                                        let _ = window.hide();
                                        crate::hooks::set_orb_visible(false);
                                    } else {
                                        let _ = window.show();
                                        // 注意：orb 窗口是 setFocusable(false)，不调用 set_focus()
                                        crate::hooks::set_orb_visible(true);
                                    }
                                }
                            }
                        }
                        "show_settings" => {
                            // 在独立线程中调用 async 命令，
                            // 避免 WebviewWindowBuilder::build() 在 Windows 主线程上死锁
                            let handle = app.clone();
                            std::thread::spawn(move || {
                                tauri::async_runtime::block_on(async {
                                    let _ = crate::commands::show_settings(handle).await;
                                });
                            });
                        }
                        "quit" => {
                            crate::hooks::mouse::stop_color_pick();
                            crate::hooks::mouse::stop_window_pin();
                            // 置顶状态写在**目标窗口**身上：不主动撤销的话，进程退出后
                            // 会留下几扇「永远在最前」的窗口，用户还查不到是谁干的。
                            crate::window_pin::cleanup();
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(move |tray, event| {
                    match &event {
                        TrayIconEvent::Enter { .. } | TrayIconEvent::Leave { .. } => return,
                        _ => {}
                    }
                    if let TrayIconEvent::Click {
                        button: MouseButton::Right,
                        button_state: tauri::tray::MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        let _ = tray.app_handle().emit(
                            "tray-context-menu-request",
                            serde_json::json!({
                                "source": "tray",
                                "x": position.x,
                                "y": position.y,
                            }),
                        );
                        return;
                    }
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        // 左键点击托盘图标：切换浮球显示
                        let app = tray.app_handle();
                        if crate::commands::is_orb_ready() {
                            if let Some(window) = app.get_webview_window("orb") {
                                if window.is_visible().unwrap_or(false) {
                                    let _ = window.hide();
                                    crate::hooks::set_orb_visible(false);
                                } else {
                                    let _ = window.show();
                                    // 注意：orb 窗口是 setFocusable(false)，不调用 set_focus()
                                    crate::hooks::set_orb_visible(true);
                                }
                            }
                        }
                    }
                })
                .build(app)?;

            // 启动剪贴板监听器（将 Ctrl+C、右键复制、应用内复制等所有来源的
            // 剪贴板文本变化追加到快速输入转盘历史）
            clipboard::listener::start_clipboard_listener();

            // 启动鼠标钩子
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                hooks::start_mouse_hook(app_handle);
            });

            // 启动键盘钩子（Ctrl+C 检测，作为补充触发方式）
            let app_handle_kb = app.handle().clone();
            std::thread::spawn(move || {
                hooks::start_keyboard_hook(app_handle_kb);
            });

            // 启动全局热键监听线程（截图快捷键）
            let app_handle_hk = app.handle().clone();
            hooks::hotkey::start_hotkey_thread(app_handle_hk);

            // 启动时按配置注册截图热键（热键线程的消息窗口需先就绪）
            let startup_hotkey = startup_config.screenshot_hotkey;
            if !startup_hotkey.is_empty() {
                std::thread::spawn(move || {
                    // 轮询等待热键线程就绪（最多约 2 秒）
                    for _ in 0..40 {
                        match hooks::hotkey::register_hotkey(
                            hooks::hotkey::HotkeySlotId::Screenshot,
                            &startup_hotkey,
                        ) {
                            Ok(_) => return,
                            Err(e) if e == "热键线程未就绪" => {
                                std::thread::sleep(std::time::Duration::from_millis(50));
                                continue;
                            }
                            Err(e) => {
                                crate::utils::logger::log(
                                    "hotkey",
                                    &format!("启动注册热键失败: {}", e),
                                );
                                return;
                            }
                        }
                    }
                    crate::utils::logger::log("hotkey", "启动时注册热键超时（热键线程未就绪）");
                });
            }

            // 启动时按配置注册录屏热键
            let startup_recording_hotkey = startup_config.recording_hotkey;
            if !startup_recording_hotkey.is_empty() {
                std::thread::spawn(move || {
                    for _ in 0..40 {
                        match hooks::hotkey::register_hotkey(
                            hooks::hotkey::HotkeySlotId::Recording,
                            &startup_recording_hotkey,
                        ) {
                            Ok(_) => return,
                            Err(e) if e == "热键线程未就绪" => {
                                std::thread::sleep(std::time::Duration::from_millis(50));
                                continue;
                            }
                            Err(e) => {
                                crate::utils::logger::log(
                                    "hotkey",
                                    &format!("启动注册录屏热键失败: {}", e),
                                );
                                return;
                            }
                        }
                    }
                    crate::utils::logger::log("hotkey", "启动时注册录屏热键超时（热键线程未就绪）");
                });
            }

            // 将浮球（orb）窗口定位：优先恢复上次拖拽后的记忆位置，
            // 未记忆时回退到主屏右下角（覆盖 tauri.conf.json 默认的左上角 (100, 100)）
            if let Some(orb) = app.get_webview_window("orb") {
                // inner_size() 已返回物理像素，与物理坐标的 workarea 单位一致
                let inner = orb.inner_size().unwrap_or_default();
                let win_w = inner.width as i32;
                let win_h = inner.height as i32;
                let scale = orb.scale_factor().unwrap_or(1.0);
                let visual_size = 56.0 * scale;
                // Legacy orb: 42px in a 64px window (11px margin); new orb: 56px in 96px (20px margin).
                // The 9px difference keeps the old visual anchor stable during migration.
                let position_offset = (9.0 * scale).round() as i32;
                let saved = app
                    .state::<config::ConfigManager>()
                    .get_window_position("orb")
                    .ok()
                    .flatten();
                if let Some(pos) = saved {
                    // 裁剪到显示器工作区，防止分辨率/显示器布局变化后 orb 跑到屏幕外
                    let (x, y) = commands::clamp_position_to_workarea(
                        pos.x - position_offset,
                        pos.y - position_offset,
                        win_w,
                        win_h,
                    );
                    let _ = orb.set_position(tauri::Position::Physical(
                        tauri::PhysicalPosition::new(x, y),
                    ));
                    // Normalize legacy/window coordinates to the visual-anchor format used by the frontend.
                    let _ = app
                        .state::<config::ConfigManager>()
                        .set_window_position("orb", config::WindowPosition {
                            x: x + position_offset,
                            y: y + position_offset,
                        });
                } else {
                    let margin = 20.0f64;
                    // 取主屏工作区（已排除任务栏），避免浮球被任务栏遮挡
                    // SPI_GETWORKAREA 在 DPI-aware 进程下返回物理像素，与 PhysicalPosition 单位一致
                    #[cfg(target_os = "windows")]
                    {
                        use windows::Win32::Foundation::RECT;
                        use windows::Win32::UI::WindowsAndMessaging::{
                            SystemParametersInfoW, SPI_GETWORKAREA,
                            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
                        };
                        let mut rc = RECT::default();
                        let ok = unsafe {
                            SystemParametersInfoW(
                                SPI_GETWORKAREA,
                                0,
                                Some(&mut rc as *mut _ as *mut std::ffi::c_void),
                                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
                            )
                            .is_ok()
                        };
                        if ok {
                            let x = rc.right as f64 - (win_w as f64 + visual_size) / 2.0 - margin;
                            let y = rc.bottom as f64 - (win_h as f64 + visual_size) / 2.0 - margin;
                            let _ = orb.set_position(tauri::Position::Physical(
                                tauri::PhysicalPosition::new(x as i32, y as i32),
                            ));
                        }
                    }
                }
            }

            // 注：不再在 Rust 端预创建 screenshot-overlay 窗口。
            // dev 模式下 Rust 端创建窗口时 app URL 尚未初始化，
            // WebviewUrl::App("index.html") 会被解析为 about:blank，
            // 导致前端代码无法加载、BitBlt 截屏失败。
            // 改为让前端 ensureScreenshotWindow() 自行创建窗口。

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_selection,
            commands::copy_text,
            commands::clipboard_read_text,
            commands::copy_selection,
            commands::get_toolbar_position,
            commands::show_toolbar,
            commands::hide_toolbar,
            commands::show_orb,
            commands::hide_orb,
            commands::toggle_orb,
            commands::harden_webview_window,
            commands::show_palette,
            commands::hide_palette,
            commands::start_scroll_navigation,
            commands::hide_scroll_navigation,
            commands::get_scroll_navigation_state,
            commands::set_scroll_navigation_percent,
            commands::recapture_scroll_target,
            commands::navigate_scroll,
            commands::start_utility_hub,
            commands::show_utility_hub,
            commands::stop_utility_color_pick,
            commands::hide_utility_hub,
            commands::get_utility_hub_enabled,
            commands::set_utility_hub_enabled,
            commands::start_utility_color_pick,
            commands::show_sketch_window,
            commands::hide_sketch_window,
            commands::get_sketch_enabled,
            commands::set_sketch_enabled,
            commands::capture_sketch_background,
            commands::start_screenshot,
            commands::mark_screenshot_overlay_heartbeat,
            commands::is_capture_session_active,
            commands::show_screenshot_error,
            commands::consume_screenshot_start_pending,
            commands::consume_recording_select_start_pending,
            commands::consume_sketch_start_pending,
            commands::consume_todo_quick_add_pending,
            commands::mark_orb_ready,
            commands::cancel_screenshot,
            commands::get_virtual_desktop_bounds,
            commands::get_screenshot_monitor_bounds,
            commands::get_screen_cache_png,
            commands::capture_region,
            commands::start_long_capture,
            commands::stop_long_capture,
            commands::cancel_long_capture,
            commands::get_long_capture_status,
            commands::get_long_capture_preview,
            commands::save_long_capture,
            commands::clipboard_set_long_capture,
            commands::discard_long_capture,
            commands::clipboard_set_image,
            commands::ocr_region,
            commands::pin_image,
            commands::close_pin,
            commands::pin_context_menu_action,
            commands::show_settings,
            commands::show_tool_config,
            commands::exit_app,
            commands::call_ai,
            commands::call_ai_stream,
            commands::cancel_ai_stream,
            updater::get_update_status,
            updater::check_for_updates,
            updater::dismiss_update,
            updater::install_update,
            commands::get_ai_config,
            commands::update_ai_config,
            commands::get_theme_preferences,
            commands::set_theme_preferences,
            commands::set_orb_icon,
            commands::replace_selection,
            commands::get_auto_start,
            commands::set_auto_start,
            commands::open_url,
            commands::save_image,
            commands::set_qrcode_preview,
            commands::clamp_window_to_workarea,
            commands::get_screenshot_hotkey,
            commands::set_screenshot_hotkey,
            commands::check_hotkey_conflicts,
            commands::get_sketch_hotkey,
            commands::set_sketch_hotkey,
            commands::set_screenshot_enabled,
            commands::get_screenshot_enabled,
            commands::set_text_toolbar_enabled,
            commands::get_text_toolbar_enabled,
            commands::get_toolbar_features,
            commands::set_toolbar_features,
            commands::get_toolbar_feature_order,
            commands::set_toolbar_feature_order,
            commands::get_search_engine,
            commands::set_search_engine,
            commands::get_dedup_mode,
            commands::set_dedup_mode,
            commands::get_md5_length,
            commands::set_md5_length,
            commands::get_numbering_style,
            commands::set_numbering_style,
            commands::get_clear_options,
            commands::set_clear_options,
            commands::tts_speak,
            commands::tts_stop,
            commands::tts_pause,
            commands::tts_resume,
            commands::tts_get_voices,
            commands::tts_get_state,
            commands::tts_get_progress,
            commands::get_tts_config,
            commands::set_tts_config,
            commands::show_monitor_window,
            commands::hide_monitor_window,
            commands::set_window_position,
            commands::reset_window_position,
            commands::get_system_monitor_enabled,
            commands::set_system_monitor_enabled,
            commands::get_system_monitor_config,
            commands::set_system_monitor_config,
            commands::get_pomodoro_state,
            commands::start_pomodoro,
            commands::start_pomodoro_for_todo,
            commands::pause_pomodoro,
            commands::reset_pomodoro,
            commands::skip_pomodoro,
            commands::get_pomodoro_config,
            commands::set_pomodoro_config,
            commands::show_timer_window,
            commands::hide_timer_window,
            commands::get_timer_enabled,
            commands::set_timer_enabled,
            commands::get_timer_reminders_enabled,
            commands::set_timer_reminders_enabled,
            commands::get_timer_reminder_sound,
            commands::set_timer_reminder_sound,
            commands::get_timer_lunar_enabled,
            commands::set_timer_lunar_enabled,
            commands::get_timers,
            commands::create_timer,
            commands::delete_timer,
            commands::set_timer_duration,
            commands::rename_timer,
            commands::add_timer_lap,
            commands::start_timer,
            commands::pause_timer,
            commands::reset_timer,
            commands::add_timer_seconds,
            commands::get_todos,
            commands::get_deleted_todos,
            commands::purge_deleted_todos,
            commands::export_todos,
            commands::import_todos,
            commands::reorder_todos,
            commands::move_todo,
            commands::get_todo_lists,
            commands::create_todo_list,
            commands::update_todo_list,
            commands::delete_todo_list,
            commands::create_todo,
            commands::update_todo,
            commands::set_todo_completed,
            commands::snooze_todo,
            commands::delete_todo,
            commands::restore_todo,
            commands::get_todo_enabled,
            commands::get_todo_quick_add_hotkey,
            commands::set_todo_quick_add_hotkey,
            commands::get_todo_reminders_enabled,
            commands::set_todo_reminders_enabled,
            commands::get_todo_reminder_sound,
            commands::set_todo_reminder_sound,
            commands::set_todo_enabled,
            commands::show_todo_window,
            commands::hide_todo_window,
            commands::get_sticky_notes_enabled,
            commands::set_sticky_notes_enabled,
            commands::get_sticky_notes,
            commands::get_sticky_note,
            commands::create_sticky_note,
            commands::update_sticky_note_content,
            commands::update_sticky_note_color,
            commands::set_sticky_note_position,
            commands::show_sticky_note,
            commands::collect_sticky_note,
            commands::collect_all_notes,
            commands::show_all_notes,
            commands::delete_sticky_note,
            commands::save_sticky_note_image,
            commands::get_sticky_note_images_dir,
            commands::restore_pinned_notes,
            commands::show_sticky_notes_manager,
            commands::hide_sticky_notes_manager,
            commands::get_ocr_engines,
            commands::set_ocr_engine,
            commands::start_recording_select,
            commands::start_recording,
            commands::show_recording_controls,
            commands::show_recording_indicator,
            commands::finish_recording_controls,
            commands::pause_recording,
            commands::resume_recording,
            commands::stop_recording,
            commands::cancel_recording,
            commands::cancel_recording_and_select,
            commands::cancel_recording_select,
            commands::get_recording_state,
            commands::is_recording_select_active,
            commands::clipboard_set_gif,
            commands::save_gif,
            commands::save_video_file,
            commands::enumerate_windows,
            commands::detect_screenshot_target,
            commands::capture_region_live,
            commands::set_smart_screenshot_mode,
            commands::set_smart_screenshot_controls_bounds,
            commands::get_recording_enabled,
            commands::set_recording_enabled,
            commands::get_recording_hotkey,
            commands::set_recording_hotkey,
            commands::get_recording_config,
            commands::set_recording_config,
            commands::get_recording_save_path,
            commands::set_recording_save_path,
            commands::get_screenshot_save_path,
            commands::set_screenshot_save_path,
            commands::get_pin_border_color,
            commands::set_pin_border_color,
            commands::get_pin_border_width,
            commands::set_pin_border_width,
            commands::pick_folder,
            commands::get_tools_autostart,
            commands::set_tools_autostart,
            commands::get_quick_input_enabled,
            commands::get_quick_input_state,
            commands::set_quick_input_enabled,
            commands::get_quick_input_trigger_key,
            commands::set_quick_input_trigger_key,
            commands::get_quick_input_mode,
            commands::set_quick_input_mode,
            commands::get_quick_input_history_limit,
            commands::set_quick_input_history_limit,
            commands::get_quick_input_history_enabled,
            commands::set_quick_input_history_enabled,
            commands::set_quick_input_highlight,
            commands::confirm_quick_input_hold,
            commands::get_quick_input_snippets,
            commands::set_quick_input_snippets,
            commands::get_quick_input_snippets_enabled,
            commands::set_quick_input_snippets_enabled,
            commands::get_quick_input_history,
            commands::clear_quick_input_history,
            commands::remove_quick_input_history_item,
            commands::set_quick_input_history_favorite,
            commands::quick_input_paste,
            commands::ensure_quick_input_window,
            commands::toggle_quick_input_wheel,
            commands::cancel_quick_input_wheel,
            commands::start_window_pin_pick,
            commands::stop_window_pin_pick,
            commands::get_pinned_windows,
            commands::unpin_window,
            commands::unpin_all_windows,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
