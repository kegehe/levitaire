// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// ONNX Runtime DLL 加载：开发模式在仓库 libs/ 目录，发布模式在 exe 同目录（由 tauri resources 打包）。
// ort 的 load-dynamic feature 在首次调用 ort::api() 时自动加载 DLL，
// 查找优先级: ORT_DYLIB_PATH 环境变量 > 当前目录 onnxruntime.dll > exe 同目录。
fn init_ort_dylib() {
    use std::path::PathBuf;
    let candidates: &[fn() -> Option<PathBuf>] = &[
        // 1. ORT_DYLIB_PATH 环境变量（用户显式指定，最高优先级）
        || std::env::var("ORT_DYLIB_PATH").ok().map(PathBuf::from).filter(|p| p.exists()),
        // 2. 仓库 libs/ 目录（开发模式 cargo tauri dev）
        || {
            let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("libs").join("onnxruntime.dll");
            p.exists().then_some(p)
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
mod sound;
mod tts;
mod utils;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager,
};

fn main() {
    // 初始化 ONNX Runtime DLL 搜索路径（ort load-dynamic 模式，在 OCR 线程前调用）
    init_ort_dylib();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // 单实例限制：第二个实例启动时直接退出，并激活已有实例
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("orb") {
                let _ = window.show();
                let _ = window.set_focus();
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
            // 初始化文字工具栏启用标志（鼠标钩子选区检测时检查）
            hooks::mouse::set_text_toolbar_enabled(startup_config.text_toolbar_enabled);

            // 初始化录屏启用标志
            hooks::hotkey::set_slot_enabled(
                hooks::hotkey::HotkeySlotId::Recording,
                startup_config.recording_enabled,
            );

            // 初始化快速输入转盘触发键（启用且键有效时设置 vk_code）
            {
                // 从本地文件恢复持久化的剪贴板历史（重启后不丢失）
                quick_input::load_history();
                let qi_enabled = config_manager.get_quick_input_enabled().unwrap_or(false);
                let qi_key = config_manager.get_quick_input_trigger_key().unwrap_or_default();
                let qi_key = if qi_key.is_empty() { "CapsLock".to_string() } else { qi_key };
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

            // 应用 OCR 引擎偏好：写入 ocr 模块全局变量，OCR 服务懒加载初始化时
            // 会读取该偏好（见 ocr::ensure_ocr_service）。未设置时 EngineId::from_str 返回 None，
            // 服务按默认策略自动选择（Windows 平台优先 Windows OCR）。
            crate::ocr::set_preferred_engine(crate::ocr::EngineId::from_str(
                &startup_config.ocr_engine,
            ));

            // 初始化钩子管理器
            let hook_manager = hooks::HookManager::new();
            app.manage(hook_manager);

            // 初始化剪贴板管理器
            let clipboard_manager = clipboard::ClipboardManager::new();
            app.manage(clipboard_manager);

            // 初始化 TTS 朗读状态（持有当前播放的 MediaPlayer）
            app.manage(tts::TtsState::default());

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

            // 初始化录屏状态（录制线程随录制开关启停，此处仅注册 state）
            app.manage(recording::RecordingState::default());

            // OCR 服务改为首次实际使用时懒加载（见 ocr::ensure_ocr_service），
            // 启动时不再加载模型，避免占用内存与启动开销。

            // settings 和 palette 窗口的关闭拦截已移至 show_settings/show_palette 命令中
            // （延迟创建窗口时，在首次 show 时注册关闭拦截）

            // 创建系统托盘菜单
            let toggle_orb =
                MenuItem::with_id(app, "toggle_orb", "显示/隐藏浮球", true, None::<&str>)?;
            let show_settings =
                MenuItem::with_id(app, "show_settings", "设置", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle_orb, &show_settings, &separator, &quit])?;

            // 创建系统托盘图标
            // 运行时从 icons/icon.png 读取，避免依赖编译时嵌入的旧图标
            let tray_icon = {
                let icon_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("icons")
                    .join("icon.png");
                match image::open(&icon_path) {
                    Ok(img) => {
                        let rgba = img.to_rgba8();
                        let w = rgba.width();
                        let h = rgba.height();
                        tauri::image::Image::new_owned(rgba.into_raw(), w, h)
                    }
                    Err(e) => {
                        crate::utils::logger::log("tray", &format!("无法加载图标文件 {}: {e}，回退到默认图标", icon_path.display()));
                        app.default_window_icon()
                            .expect("未找到默认图标，请检查 src-tauri/icons/ 目录下是否存在图标文件")
                            .to_owned()
                    }
                }
            };
            let _tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("Levitaire")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "toggle_orb" => {
                            if let Some(window) = app.get_webview_window("orb") {
                                if window.is_visible().unwrap_or(false) {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    // 注意：orb 窗口是 setFocusable(false)，不调用 set_focus()
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
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        // 左键点击托盘图标：切换浮球显示
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("orb") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                // 注意：orb 窗口是 setFocusable(false)，不调用 set_focus()
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
                let saved = app
                    .state::<config::ConfigManager>()
                    .get_window_position("orb")
                    .ok()
                    .flatten();
                if let Some(pos) = saved {
                    // 裁剪到显示器工作区，防止分辨率/显示器布局变化后 orb 跑到屏幕外
                    let (x, y) = commands::clamp_position_to_workarea(pos.x, pos.y, win_w, win_h);
                    let _ = orb.set_position(tauri::Position::Physical(
                        tauri::PhysicalPosition::new(x, y),
                    ));
                } else {
                    let margin = 20.0f64;
                    // 取主屏工作区（已排除任务栏），避免浮球被任务栏遮挡
                    // SPI_GETWORKAREA 在 DPI-aware 进程下返回物理像素，与 PhysicalPosition 单位一致
                    #[cfg(target_os = "windows")]
                    {
                        use windows::Win32::Foundation::RECT;
                        use windows::Win32::UI::WindowsAndMessaging::{
                            SystemParametersInfoW, SPI_GETWORKAREA, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
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
                            let x = rc.right as f64 - win_w as f64 - margin;
                            let y = rc.bottom as f64 - win_h as f64 - margin;
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
            commands::copy_selection,
            commands::get_toolbar_position,
            commands::show_toolbar,
            commands::hide_toolbar,
            commands::show_orb,
            commands::hide_orb,
            commands::show_palette,
            commands::hide_palette,
            commands::start_screenshot,
            commands::cancel_screenshot,
            commands::get_virtual_desktop_bounds,
            commands::get_screen_cache_png,
            commands::capture_region,
            commands::clipboard_set_image,
            commands::ocr_region,
            commands::pin_image,
            commands::close_pin,
            commands::show_settings,
            commands::exit_app,
            commands::call_ai,
            commands::call_ai_stream,
            commands::cancel_ai_stream,
            commands::get_ai_config,
            commands::update_ai_config,
            commands::get_theme_preferences,
            commands::set_theme_preferences,
            commands::replace_selection,
            commands::get_auto_start,
            commands::set_auto_start,
            commands::open_url,
            commands::save_image,
            commands::set_qrcode_preview,
            commands::get_screenshot_hotkey,
            commands::set_screenshot_hotkey,
            commands::set_screenshot_enabled,
            commands::get_screenshot_enabled,
            commands::set_text_toolbar_enabled,
            commands::get_text_toolbar_enabled,
            commands::get_toolbar_features,
            commands::set_toolbar_features,
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
            commands::show_pomodoro_window,
            commands::hide_pomodoro_window,
            commands::get_pomodoro_state,
            commands::start_pomodoro,
            commands::pause_pomodoro,
            commands::reset_pomodoro,
            commands::skip_pomodoro,
            commands::get_pomodoro_enabled,
            commands::set_pomodoro_enabled,
            commands::get_pomodoro_config,
            commands::set_pomodoro_config,
            commands::get_ocr_engines,
            commands::set_ocr_engine,
            commands::start_recording_select,
            commands::start_recording,
            commands::show_recording_controls,
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
            commands::pick_folder,
            commands::get_tools_autostart,
            commands::set_tools_autostart,
            commands::get_quick_input_enabled,
            commands::set_quick_input_enabled,
            commands::get_quick_input_trigger_key,
            commands::set_quick_input_trigger_key,
            commands::get_quick_input_mode,
            commands::set_quick_input_mode,
            commands::set_quick_input_highlight,
            commands::get_quick_input_snippets,
            commands::set_quick_input_snippets,
            commands::get_quick_input_history,
            commands::clear_quick_input_history,
            commands::quick_input_paste,
            commands::ensure_quick_input_window,
            commands::toggle_quick_input_wheel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
