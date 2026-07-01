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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_selection,
            commands::copy_text,
            commands::get_toolbar_position,
            commands::show_toolbar,
            commands::hide_toolbar,
            commands::show_orb,
            commands::hide_orb,
            commands::show_settings,
            commands::call_ai,
            commands::get_ai_config,
            commands::update_ai_config,
            commands::replace_selection,
            commands::get_auto_start,
            commands::set_auto_start,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
