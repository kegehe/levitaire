use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

use tauri::{Emitter, Manager};

use super::*;
use crate::shelf::{AddResult, ShelfSnapshot, ShelfStore};

static SHELF_CLOSE_REGISTERED: AtomicBool = AtomicBool::new(false);
static SHELF_DROP_HWND: AtomicIsize = AtomicIsize::new(0);

fn shelf_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("file-shelf-overlay")
        .ok_or_else(|| "file-shelf-overlay 窗口未找到".to_string())
}

#[tauri::command]
pub fn show_file_shelf(
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    let win = shelf_window(&app)?;
    if !SHELF_CLOSE_REGISTERED.swap(true, Ordering::SeqCst) {
        let win_on_close = win.clone();
        win.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = win_on_close.hide();
            }
            tauri::WindowEvent::Destroyed => {
                SHELF_CLOSE_REGISTERED.store(false, Ordering::SeqCst);
                SHELF_DROP_HWND.store(0, Ordering::SeqCst);
            }
            _ => {}
        });
    }
    if !win.is_visible().unwrap_or(true) {
        if let Ok(Some(pos)) = config_manager.get_window_position("file-shelf-overlay") {
            let inner = win.inner_size().unwrap_or_default();
            let (x, y) =
                clamp_position_to_workarea(pos.x, pos.y, inner.width as i32, inner.height as i32);
            win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)))
                .map_err(|error| error.to_string())?;
        }
    }
    win.show().map_err(|error| error.to_string())?;
    win.set_focus().map_err(|error| error.to_string())?;
    // DoDragDrop/OLE 把 Drop 派发到登记目标的那个线程，这里必须留在主线程（不能改成 async）。
    // 换到没有消息循环的线程登记，源程序拖到窗口上会一直卡住不落点。
    let hwnd = win.hwnd().map_err(|error| error.to_string())?;
    let raw = hwnd.0 as isize;
    if SHELF_DROP_HWND.swap(raw, Ordering::SeqCst) != raw {
        // 必须先关掉 WebView2 自己的外部拖放，否则文件被它截走，我们的 IDropTarget 收不到。
        if let Err(error) = crate::shelf::disable_webview_external_drop(&win) {
            crate::utils::logger::log("shelf", &error);
        }
        if let Err(error) = crate::shelf::bind_shelf_drop_target(hwnd, app) {
            SHELF_DROP_HWND.store(0, Ordering::SeqCst);
            return Err(error);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn hide_file_shelf(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("file-shelf-overlay") {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_file_shelf_enabled(config_manager: State<'_, ConfigManager>) -> Result<bool, String> {
    config_manager.get_file_shelf_enabled()
}

#[tauri::command]
pub fn set_file_shelf_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    if !enabled {
        if let Some(window) = app.get_webview_window("file-shelf-overlay") {
            window.hide().map_err(|error| error.to_string())?;
        }
    }
    config_manager.update_file_shelf_enabled(enabled)?;
    // 截图工具与长截图控制条是常驻窗口，只在挂载时读过一次开关。
    // 广播后它们才能实时收起/显示「放入暂存架」按钮，而不必等重启。
    let _ = app.emit("file-shelf-enabled-changed", enabled);
    Ok(())
}

/// 读取暂存架清单。
///
/// 必须 `async` + `spawn_blocking`：`list()` 会为每个条目做一次文件存在性检查，
/// 引用条目可能指向离线的网络盘 / 已拔出的移动盘，`exists()` 会卡到 SMB 超时。
/// 同步命令跑在主线程上，一次刷新就能把整个应用冻住。
#[tauri::command]
pub async fn shelf_list(app: tauri::AppHandle) -> ShelfSnapshot {
    tokio::task::spawn_blocking(move || {
        let store = app.state::<ShelfStore>();
        let snapshot = store.list();
        // 清单备份提示只展示一次。
        let _ = store.dismiss_notice();
        snapshot
    })
    .await
    .unwrap_or_else(|_| ShelfSnapshot {
        items: Vec::new(),
        collapsed: false,
        notice: Some("读取暂存架失败，请重开面板".to_string()),
    })
}

/// 条目预览缩略图（data URL）。不可出图 / 文件丢失 / 提取失败一律返回 None，
/// 前端回落到类型渐变 + 图形芯片，不弹错误。
#[tauri::command]
pub async fn shelf_thumbnail(id: String, store: State<'_, ShelfStore>) -> Result<Option<String>, String> {
    let Some((path, missing, name)) = store.media_item(&id) else {
        return Ok(None);
    };
    if missing {
        return Ok(None);
    }
    let Some(kind) = crate::shelf::thumb::media_kind(&name) else {
        return Ok(None);
    };
    let mtime = std::fs::metadata(&path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let key = format!("{path}|{mtime}");
    if let Some(cached) = store.thumb_get(&key) {
        return Ok(cached);
    }
    // 解码 / 取封面是同步阻塞调用（大视频的 GetImage 可能要几秒），必须丢进
    // spawn_blocking 的阻塞线程池，不能占住 tokio 的异步 worker。
    let rendered = tauri::async_runtime::spawn_blocking(move || {
        crate::shelf::thumb::render_thumb(std::path::Path::new(&path), kind)
    })
    .await
    .map_err(|error| format!("缩略图任务失败：{error}"))?;
    let value = rendered.ok();
    store.thumb_store(key, value.clone());
    Ok(value)
}

#[tauri::command]
pub fn shelf_add_paths(paths: Vec<String>, store: State<'_, ShelfStore>) -> Vec<AddResult> {
    let paths = paths.iter().map(std::path::PathBuf::from).collect::<Vec<_>>();
    store.add_paths(&paths)
}

/// 把一张 PNG（data URL 或裸 base64）写进暂存架。
///
/// 必须 `async` + `spawn_blocking`：长截图预览传的是原尺寸 PNG，base64 解码 + 写盘
/// 是几十到几百毫秒的活；同步命令跑在主线程上，会把整个应用（包括正在看的预览窗）
/// 一起冻住。与 `get_long_capture_preview`、`save_long_capture` 同一口径。
#[tauri::command]
pub async fn shelf_add_png(
    data: String,
    name: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    // 与贴图菜单的 shelf_pin 同口径：按钮状态可能因广播/点击存在毫秒级竞态，
    // 关闭开关后由后端兜底拒绝，避免截图被写进已关闭的暂存架。
    if !app
        .state::<ConfigManager>()
        .get_file_shelf_enabled()
        .unwrap_or(false)
    {
        return Err("文件暂存架已关闭".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let payload = data
            .split_once("base64,")
            .map(|(_, body)| body)
            .unwrap_or(data.as_str());
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload.trim())
            .map_err(|_| "图片数据无法识别".to_string())?;
        let id = app
            .state::<ShelfStore>()
            .add_png(&bytes, name.as_deref().unwrap_or("截图.png"))?;
        // 截图、长截图从别的窗口写入。暂存架开着时要刷新，收起时还要展开。
        let _ = app.emit_to(
            "file-shelf-overlay",
            "file-shelf-changed",
            serde_json::json!([{ "status": "added", "id": id }]),
        );
        Ok::<String, String>(id)
    })
    .await
    .map_err(|error| format!("暂存失败：{error}"))?
}

/// 同步命令，并且必须跑在主线程。DoDragDrop 会泵消息，不能放进 async 或 spawn_blocking。
#[tauri::command]
pub fn shelf_begin_drag(ids: Vec<String>, store: State<'_, ShelfStore>) -> Result<(), String> {
    crate::shelf::begin_drag(&store, &ids)
}

#[tauri::command]
pub fn shelf_remove(ids: Vec<String>, store: State<'_, ShelfStore>) -> Result<(), String> {
    store.remove(&ids)
}

#[tauri::command]
pub fn shelf_reorder(ids: Vec<String>, store: State<'_, ShelfStore>) -> Result<(), String> {
    store.reorder(&ids)
}

#[tauri::command]
pub fn shelf_clear(store: State<'_, ShelfStore>) -> Result<(), String> {
    store.clear()
}

#[tauri::command]
pub fn shelf_set_collapsed(collapsed: bool, store: State<'_, ShelfStore>) -> Result<(), String> {
    store.set_collapsed(collapsed)
}

/// 在资源管理器中定位条目。
///
/// 与 `shelf_list` 同理：引用条目可能指向离线的网络盘，`exists()` 的 SMB 超时
/// 能到数秒，不能压在主线程上。
#[tauri::command]
pub async fn shelf_reveal(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || app.state::<ShelfStore>().reveal(&id))
        .await
        .map_err(|error| format!("打开失败：{error}"))?
}

/// 用系统默认程序打开条目。
#[tauri::command]
pub async fn shelf_open(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || app.state::<ShelfStore>().open_item(&id))
        .await
        .map_err(|error| format!("打开失败：{error}"))?
}

/// 粘贴剪贴板里的文件 / 图片。
///
/// 与 `shelf_add_png` 同理：CF_DIB → RGBA → PNG 的转换对大图是几百毫秒级的，
/// 而且 `OpenClipboard` 可能被别的程序占着；同步命令跑在主线程上会冻住整个应用。
#[tauri::command]
pub async fn shelf_paste(app: tauri::AppHandle) -> Result<Vec<AddResult>, String> {
    tokio::task::spawn_blocking(move || {
        let store = app.state::<ShelfStore>();
        crate::shelf::paste_clipboard(&store)
    })
    .await
    .map_err(|error| format!("粘贴失败：{error}"))?
}
