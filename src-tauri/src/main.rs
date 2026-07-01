// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod hooks;
mod automation;
mod clipboard;
mod utils;
mod config;
mod ai;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager,
};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // 初始化配置管理器
            let config_manager = config::ConfigManager::new();

            // 使用配置中的 AI 设置初始化 AI 服务
            // 环境变量仅在配置值为空时作为 fallback，不写回配置文件
            let mut ai_config = config_manager.get_ai_config()?;

            if ai_config.api_key.is_empty() {
                if let Ok(key) = std::env::var("FLOAST_AI_API_KEY") {
                    ai_config.api_key = key;
                }
            }
            if ai_config.base_url.is_empty() {
                if let Ok(url) = std::env::var("FLOAST_AI_BASE_URL") {
                    ai_config.base_url = url;
                }
            }
            if ai_config.model.is_empty() {
                if let Ok(model) = std::env::var("FLOAST_AI_MODEL") {
                    ai_config.model = model;
                }
            }

            let ai_service = ai::AiService::new(ai_config);
            app.manage(ai_service);

            app.manage(config_manager);

            // 初始化钩子管理器
            let hook_manager = hooks::HookManager::new();
            app.manage(hook_manager);

            // 初始化剪贴板管理器
            let clipboard_manager = clipboard::ClipboardManager::new();
            app.manage(clipboard_manager);

            // 拦截设置窗口关闭事件：隐藏而非销毁
            // 避免窗口被销毁后无法再次打开
            let settings_app_handle = app.handle().clone();
            let settings_window = app.get_webview_window("settings").unwrap();
            settings_window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Some(win) = settings_app_handle.get_webview_window("settings") {
                        let _ = win.hide();
                    }
                }
            });

            // 创建系统托盘菜单
            let toggle_orb = MenuItem::with_id(app, "toggle_orb", "显示/隐藏浮球", true, None::<&str>)?;
            let show_settings = MenuItem::with_id(app, "show_settings", "设置", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle_orb, &show_settings, &separator, &quit])?;

            // 创建系统托盘图标
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon()
                    .expect("未找到默认图标，请检查 src-tauri/icons/ 目录下是否存在图标文件")
                    .clone())
                .tooltip("Floast Service")
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
                            if let Some(window) = app.get_webview_window("settings") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
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
                    } = event {
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

            // 将浮球（orb）窗口定位到主屏右下角
            // 覆盖 tauri.conf.json 中默认的左上角 (100, 100) 位置
            if let Some(orb) = app.get_webview_window("orb") {
                let margin = 20.0f64;
                // 窗口逻辑尺寸（tauri.conf.json 中配置的 width/height）
                // 乘以 scale_factor 得到物理像素，与物理坐标的 workarea 单位一致
                let scale = orb.scale_factor().unwrap_or(1.0);
                let inner = orb.inner_size().unwrap_or_default();
                let win_w = inner.width as f64 * scale;
                let win_h = inner.height as f64 * scale;

                // 取主屏工作区（已排除任务栏），避免浮球被任务栏遮挡
                // SPI_GETWORKAREA 在 DPI-aware 进程下返回物理像素，与 PhysicalPosition 单位一致
                #[cfg(target_os = "windows")]
                {
                    use windows::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETWORKAREA, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS};
                    use windows::Win32::Foundation::RECT;
                    let mut rc = RECT::default();
                    let ok = unsafe {
                        SystemParametersInfoW(
                            SPI_GETWORKAREA,
                            0,
                            Some(&mut rc as *mut _ as *mut std::ffi::c_void),
                            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
                        ).is_ok()
                    };
                    if ok {
                        let x = rc.right as f64 - win_w - margin;
                        let y = rc.bottom as f64 - win_h - margin;
                        let _ = orb.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
                            x as i32, y as i32,
                        )));
                    }
                }
            }

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
            commands::show_settings,
            commands::call_ai,
            commands::call_ai_stream,
            commands::get_ai_config,
            commands::update_ai_config,
            commands::replace_selection,
            commands::get_auto_start,
            commands::set_auto_start,
            commands::open_url,
            commands::save_image,
            commands::set_qrcode_preview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
