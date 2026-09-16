//! 便利贴工具 —— 数据存储与窗口生命周期。
//!
//! 产品模型（参考 Windows 便笺 / Snipaste）：
//! - 每张便利贴 = 一个独立透明置顶 WebView 小窗（label `sticky-note-<id>`），
//!   可随意拖到桌面任意位置、独立输入文字；
//! - 数据（内容/颜色/几何/可见性）统一持久化在 `notes.json`，与窗口解耦：
//!   「收起」= 设 visible=false 并销毁窗口释放内存，数据保留；
//!   「显示/恢复」= 设 visible=true 并重建窗口；应用启动时恢复所有 visible 的便签；
//! - 便利贴整体由管理窗（sticky-notes-manager）统筹：新建 / 删除 / 收起 / 唤出。

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// 单张便利贴窗口的 label 前缀（capabilities 用 `sticky-note-*` glob 放行）
pub const NOTE_WINDOW_PREFIX: &str = "sticky-note-";

/// 便利贴内容长度上限（字符数），避免异常导致 notes.json 无限膨胀
pub const MAX_CONTENT_CHARS: usize = 100_000;

/// 逻辑宽度（CSS px）。前端 .sticky-note-card 宽度与之一致。
pub const NOTE_WIDTH_LOGICAL: f64 = 264.0;
/// 初始逻辑高度（前端挂载后会按内容自动调整）
pub const NOTE_INITIAL_HEIGHT_LOGICAL: f64 = 180.0;

/// 内置纸色 id（前端负责渲染具体色值）
pub const VALID_COLORS: &[&str] = &["yellow", "pink", "mint", "blue", "lavender", "peach"];
pub const DEFAULT_COLOR_ID: &str = "yellow";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StickyNote {
    pub id: String,
    pub content: String,
    pub color_id: String,
    /// 物理像素坐标（窗口左上角），拖拽时由前端回写
    pub x: i32,
    pub y: i32,
    /// 是否钉在桌面（visible=false 表示已收起，数据仍在，可从管理窗重新唤出）
    pub visible: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct NoteFile {
    version: u32,
    notes: Vec<StickyNote>,
}

pub struct NoteStore {
    file_path: PathBuf,
    data: Mutex<NoteFile>,
    next_id: AtomicU64,
}

impl NoteStore {
    pub fn new() -> Self {
        let file_path = Self::file_path();
        let data = load_file(&file_path);
        Self {
            file_path,
            data: Mutex::new(data),
            next_id: AtomicU64::new(1),
        }
    }

    fn file_path() -> PathBuf {
        let dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("levitaire");
        let _ = fs::create_dir_all(&dir);
        dir.join("notes.json")
    }

    /// 全部便签（按创建时间升序，管理窗按此稳定排列）
    pub fn list(&self) -> Result<Vec<StickyNote>, String> {
        let data = self.data.lock().map_err(|e| e.to_string())?;
        let mut notes = data.notes.clone();
        notes.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(notes)
    }

    pub fn get(&self, id: &str) -> Result<StickyNote, String> {
        let data = self.data.lock().map_err(|e| e.to_string())?;
        data.notes
            .iter()
            .find(|note| note.id == id)
            .cloned()
            .ok_or_else(|| "便利贴不存在".to_string())
    }

    /// 新建一张空便签（visible=true），由命令层负责打开窗口
    pub fn create(&self, color_id: &str, x: i32, y: i32) -> Result<StickyNote, String> {
        let now = Utc::now().to_rfc3339();
        let id = format!(
            "note-{}-{}",
            Utc::now().timestamp_millis(),
            self.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let note = StickyNote {
            id,
            content: String::new(),
            color_id: normalize_color_id(color_id),
            x,
            y,
            visible: true,
            created_at: now.clone(),
            updated_at: now,
        };
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        data.notes.push(note.clone());
        self.save_with_rollback(&mut data, previous)?;
        Ok(note)
    }

    pub fn update_content(&self, id: &str, content: &str) -> Result<StickyNote, String> {
        let content = content.trim().to_string();
        if content.chars().count() > MAX_CONTENT_CHARS {
            return Err(format!("便利贴内容不能超过 {} 字", MAX_CONTENT_CHARS));
        }
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        let note = data
            .notes
            .iter_mut()
            .find(|note| note.id == id)
            .ok_or_else(|| "便利贴不存在".to_string())?;
        note.content = content;
        note.updated_at = Utc::now().to_rfc3339();
        let result = note.clone();
        self.save_with_rollback(&mut data, previous)?;
        Ok(result)
    }

    pub fn update_color(&self, id: &str, color_id: &str) -> Result<StickyNote, String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        let note = data
            .notes
            .iter_mut()
            .find(|note| note.id == id)
            .ok_or_else(|| "便利贴不存在".to_string())?;
        note.color_id = normalize_color_id(color_id);
        note.updated_at = Utc::now().to_rfc3339();
        let result = note.clone();
        self.save_with_rollback(&mut data, previous)?;
        Ok(result)
    }

    pub fn update_position(&self, id: &str, x: i32, y: i32) -> Result<StickyNote, String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        let note = data
            .notes
            .iter_mut()
            .find(|note| note.id == id)
            .ok_or_else(|| "便利贴不存在".to_string())?;
        note.x = x;
        note.y = y;
        note.updated_at = Utc::now().to_rfc3339();
        let result = note.clone();
        self.save_with_rollback(&mut data, previous)?;
        Ok(result)
    }

    pub fn set_visible(&self, id: &str, visible: bool) -> Result<StickyNote, String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        let note = data
            .notes
            .iter_mut()
            .find(|note| note.id == id)
            .ok_or_else(|| "便利贴不存在".to_string())?;
        note.visible = visible;
        note.updated_at = Utc::now().to_rfc3339();
        let result = note.clone();
        self.save_with_rollback(&mut data, previous)?;
        Ok(result)
    }

    /// 彻底删除（从文件中移除），由命令层负责先销毁窗口
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        let before = data.notes.len();
        data.notes.retain(|note| note.id != id);
        if data.notes.len() == before {
            return Err("便利贴不存在".to_string());
        }
        self.save_with_rollback(&mut data, previous)
    }

    fn save_locked(&self, data: &NoteFile) -> Result<(), String> {
        let content = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        let temp = self
            .file_path
            .with_extension(format!("json.{}.tmp", std::process::id()));
        fs::write(&temp, content).map_err(|e| format!("写入便利贴文件失败: {e}"))?;
        fs::rename(&temp, &self.file_path).map_err(|e| {
            let _ = fs::remove_file(&temp);
            format!("保存便利贴文件失败: {e}")
        })
    }

    fn save_with_rollback(&self, data: &mut NoteFile, previous: NoteFile) -> Result<(), String> {
        if let Err(error) = self.save_locked(data) {
            *data = previous;
            return Err(error);
        }
        Ok(())
    }
}

impl Default for NoteStore {
    fn default() -> Self {
        Self::new()
    }
}

fn load_file(path: &PathBuf) -> NoteFile {
    match fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str::<NoteFile>(&raw) {
            Ok(mut file) => {
                // 旧数据字段缺失时补齐默认值（serde default 字段已兜底，这里统一修正脏值）
                file.version = file.version.max(1);
                for note in &mut file.notes {
                    note.color_id = normalize_color_id(&note.color_id);
                }
                file
            }
            Err(error) => {
                let backup = path.with_extension(format!(
                    "json.corrupt.{}.bak",
                    Utc::now().timestamp_millis()
                ));
                let _ = fs::rename(path, backup);
                crate::utils::logger::log(
                    "sticky_note",
                    &format!("invalid notes file moved aside: {error}"),
                );
                NoteFile {
                    version: 1,
                    notes: Vec::new(),
                }
            }
        },
        Err(_) => NoteFile {
            version: 1,
            notes: Vec::new(),
        },
    }
}

/// 归一化纸色 id，非法值回退默认黄
pub fn normalize_color_id(value: &str) -> String {
    if VALID_COLORS.contains(&value) {
        value.to_string()
    } else {
        DEFAULT_COLOR_ID.to_string()
    }
}

/// 单张便利贴窗口的 label
pub fn note_window_label(id: &str) -> String {
    format!("{}{}", NOTE_WINDOW_PREFIX, id)
}

/// 便签窗口「检查 + 创建」的串行锁。
///
/// 相关命令改为 `async` 后不再由主线程天然串行：启动预热（`FloatingOrb` 的
/// `preloadEnabledToolWindows`）与打开管理窗都会调用 `restore_pinned_notes`，
/// 用户点击唤出（`show_sticky_note`）也可能与之重叠。两个调用同时通过
/// `get_webview_window` 的存在性检查后都会去 `build()` 同一个 label，
/// 后者会拿到 "window label already exists" 错误。此处串行化整个检查+创建。
///
/// 锁内只做 `build()` 派发与窗口对象登记（非主线程调用不等待实际创建），
/// 持有时间极短；`ensure_note_window` 内部不会回调自身，无重入死锁风险。
static NOTE_WINDOW_INIT_LOCK: Mutex<()> = Mutex::new(());

/// 获取（必要时创建）某张便签的悬浮窗。创建时不显示，由 show 逻辑统一摆位。
///
/// # 调用约束（Windows 死锁防护）
///
/// 本函数内部的 `WebviewWindowBuilder::build()` 绝不能在**同步** Tauri 命令里被触发。
/// Tauri 在 Windows 上会把非 async 命令放在主线程上 inline 执行，而主线程此刻正处于
/// WebView2 的 IPC 回调内部；`build()` 需要主线程再处理一次窗口创建，永远等不到，
/// 导致整个应用死锁冻结。所有最终会走到这里的命令（commands/sticky.rs 的
/// `create_sticky_note` / `show_sticky_note` / `restore_pinned_notes`）都必须保持 `async`。
/// 参见 https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html
pub fn ensure_note_window(app: &tauri::AppHandle, id: &str) -> Result<tauri::WebviewWindow, String> {
    let label = note_window_label(id);
    // 存在性检查必须与创建同处锁内，否则并发调用会重复创建同名窗口
    let _init_guard = NOTE_WINDOW_INIT_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(win) = app.get_webview_window(&label) {
        return Ok(win);
    }
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Levitaire 便利贴")
        .inner_size(NOTE_WIDTH_LOGICAL, NOTE_INITIAL_HEIGHT_LOGICAL)
        .resizable(false)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focusable(true)
        .visible(false)
        .background_color(tauri::webview::Color(0, 0, 0, 0))
        .build()
        .map_err(|e| format!("创建便利贴窗口失败: {e}"))?;

    // Alt+F4（或任务栏关闭）产生的 WM_CLOSE：拦成「收起」，不要销毁。
    //
    // 不拦的后果：窗口消失、而数据里 `visible` 仍是 true —— 管理窗显示「已贴在桌面」
    // 但桌面上没有这张便签，两处状态从此不一致；且防抖中（≤500ms）的正文随窗口一起丢。
    // 对照：管理窗（`commands/sticky.rs::show_sticky_notes_manager`）与待办窗
    // （`commands/todo.rs`）都有同样的 CloseRequested 拦截，便签窗此前是唯一漏的。
    {
        let close_app = app.clone();
        let close_id = id.to_string();
        let close_label = label.clone();
        let close_win = win.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                // 先让前端把防抖中的正文冲盘（前端监听后立刻 flushSave），再落状态并隐藏。
                // 必须**定向**发（`emit_to`）：`Emitter::emit` 是全局广播，会让每一张
                // 便签窗都收到并各自多冲一次盘（多余 IPC + 写盘 + 管理窗列表抖动）。
                let _ = close_app.emit_to(
                    close_label.as_str(),
                    "sticky-note-close-requested",
                    (),
                );
                if let Some(store) = close_app.try_state::<NoteStore>() {
                    if let Err(error) = store.set_visible(&close_id, false) {
                        crate::utils::logger::log(
                            "sticky_note",
                            &format!("关闭便签时落 visible=false 失败: {error}"),
                        );
                    }
                }
                let _ = close_win.hide();
                crate::commands::notify_sticky_notes_changed(&close_app);
            }
        });
    }

    crate::utils::logger::log("sticky_note", &format!("note window created: {label}"));
    Ok(win)
}

/// 将便签窗口摆到记忆位置并显示。
/// `focus=true` 时额外聚焦（新建后立即输入用）；批量恢复时传 false 避免抢焦点。
pub fn show_note_window(
    app: &tauri::AppHandle,
    note: &StickyNote,
    focus: bool,
) -> Result<(), String> {
    let label = note_window_label(&note.id);
    let existing = app.get_webview_window(&label);
    let already_visible = existing
        .as_ref()
        .map(|win| win.is_visible().unwrap_or(false))
        .unwrap_or(false);
    let win = ensure_note_window(app, &note.id)?;
    // 窗口尚不可见（新建或重建）时按记忆位置摆位；已可见的便签保持原位，仅聚焦。
    if !already_visible {
        let scale = win.scale_factor().unwrap_or(1.0);
        let w_px = (NOTE_WIDTH_LOGICAL * scale).round() as i32;
        let h_px = (NOTE_INITIAL_HEIGHT_LOGICAL * scale).round() as i32;
        let (x, y) = crate::commands::clamp_position_to_workarea(note.x, note.y, w_px, h_px);
        win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)))
            .map_err(|e| format!("设置便利贴位置失败: {e}"))?;
    }
    win.show().map_err(|e| format!("显示便利贴失败: {e}"))?;
    if focus {
        win.set_focus().map_err(|e| format!("聚焦便利贴失败: {e}"))?;
    }
    Ok(())
}

/// 收起某张便签：销毁其悬浮窗（释放 WebView 内存），数据与可见性由调用方先更新。
pub fn destroy_note_window(app: &tauri::AppHandle, id: &str) {
    if let Some(win) = app.get_webview_window(&note_window_label(id)) {
        let _ = win.destroy();
        crate::utils::logger::log("sticky_note", &format!("note window destroyed: {id}"));
    }
}

// ── 图片支持 ─────────────────────────────────────────────────────────────────
// 便利贴正文仍以纯文本存于 notes.json；粘贴/截图拷入的图片落盘为独立文件，
// 正文中以令牌 `[[img:相对路径]]` 引用（相对路径相对 images 根目录，
// 形如 <noteId>/img_*.png）。渲染时前端用 convertFileSrc 把令牌转成 asset: URL
// 显示，故存放目录必须在 tauri.conf.json 的 assetProtocol scope 内；此处与 scope
// 的 $APPDATA 宏一致地使用 app.path().app_data_dir()（= dirs::data_dir()/{bundle_identifier}）。

/// 单张便利贴图片体积上限（字节），避免异常剪贴板数据把磁盘撑爆
pub const IMAGE_MAX_BYTES: usize = 32 * 1024 * 1024;
/// 图片根目录名（位于 app 数据目录下），与 tauri.conf.json asset scope 同步
pub const IMAGES_REL_ROOT: &str = "sticky-images";
/// 单调序号：同毫秒连续粘贴多张图时用于区分文件名
static IMG_SEQ: AtomicU64 = AtomicU64::new(0);

/// app 数据目录 → 便利贴图片根目录的绝对路径
pub fn images_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(IMAGES_REL_ROOT))
        .map_err(|e| format!("获取应用数据目录失败: {e}"))
}

/// 保存一张剪贴板粘贴的图片，返回正文令牌中的相对路径。
/// 相对路径相对 [images_dir]（images 根目录），形如 `<noteId>/img_*.png`；
/// 前端用 `images_dir + "/" + rel` 交给 convertFileSrc 解析。
pub fn save_image(
    app: &tauri::AppHandle,
    note_id: &str,
    bytes: &[u8],
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("图片内容为空".into());
    }
    if bytes.len() > IMAGE_MAX_BYTES {
        return Err(format!("图片不能超过 {}MB", IMAGE_MAX_BYTES / (1024 * 1024)));
    }
    let subdir = images_dir(app)?.join(note_safe_dir(note_id));
    fs::create_dir_all(&subdir).map_err(|e| format!("创建图片目录失败: {e}"))?;
    let filename = format!(
        "img_{}_{}.png",
        Utc::now().timestamp_millis(),
        IMG_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    fs::write(subdir.join(&filename), bytes).map_err(|e| format!("写入图片文件失败: {e}"))?;
    Ok(format!("{}/{}", note_safe_dir(note_id), filename))
}

/// 彻底删除便签时清理其图片目录，避免留下孤儿文件。失败仅记录，不阻断删除。
pub fn delete_images(app: &tauri::AppHandle, note_id: &str) {
    let dir = match images_dir(app) {
        Ok(dir) => dir.join(note_safe_dir(note_id)),
        Err(_) => return,
    };
    if dir.exists() {
        crate::utils::logger::log(
            "sticky_note",
            &format!("removing note images dir: {}", dir.display()),
        );
        let _ = fs::remove_dir_all(&dir);
    }
}

/// 把 note id 清洗成安全的目录名（note id 由本模块生成，全为安全字符，此处兜底）。
/// 单段结果若为 "." 或 ".."（可能指向 images 根目录/其父级）一律回退 unknown。
fn note_safe_dir(id: &str) -> String {
    let clean: String = id
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    if clean.is_empty() || clean == "." || clean == ".." {
        "unknown".to_string()
    } else {
        clean
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> (NoteStore, PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "levitaire-sticky-test-{}.json",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        (
            NoteStore {
                file_path: path.clone(),
                data: Mutex::new(NoteFile {
                    version: 1,
                    notes: Vec::new(),
                }),
                next_id: AtomicU64::new(1),
            },
            path,
        )
    }

    #[test]
    fn normalize_color_falls_back_to_default() {
        assert_eq!(normalize_color_id("pink"), "pink");
        assert_eq!(normalize_color_id("rainbow"), DEFAULT_COLOR_ID);
    }

    #[test]
    fn create_and_get_roundtrip() {
        let (store, path) = test_store();
        let note = store.create("mint", 10, 20).unwrap();
        assert_eq!(note.content, "");
        assert_eq!(note.color_id, "mint");
        assert_eq!(note.x, 10);
        assert_eq!(note.y, 20);
        assert!(note.visible);
        let fetched = store.get(&note.id).unwrap();
        assert_eq!(fetched.id, note.id);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn update_content_and_color_persist() {
        let (store, path) = test_store();
        let note = store.create("yellow", 0, 0).unwrap();
        let updated = store.update_content(&note.id, "  你好\n世界  ").unwrap();
        assert_eq!(updated.content, "你好\n世界");
        assert_eq!(store.get(&note.id).unwrap().content, "你好\n世界");
        let recolored = store.update_color(&note.id, "lavender").unwrap();
        assert_eq!(recolored.color_id, "lavender");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn oversized_content_is_rejected() {
        let (store, path) = test_store();
        let note = store.create("yellow", 0, 0).unwrap();
        let huge = "x".repeat(MAX_CONTENT_CHARS + 1);
        assert!(store.update_content(&note.id, &huge).is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn position_and_visibility_update() {
        let (store, path) = test_store();
        let note = store.create("blue", 5, 5).unwrap();
        store.update_position(&note.id, 100, 200).unwrap();
        assert_eq!(store.get(&note.id).unwrap().x, 100);
        assert_eq!(store.get(&note.id).unwrap().y, 200);
        store.set_visible(&note.id, false).unwrap();
        assert!(!store.get(&note.id).unwrap().visible);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn delete_removes_record() {
        let (store, path) = test_store();
        let note = store.create("peach", 0, 0).unwrap();
        store.delete(&note.id).unwrap();
        assert!(store.get(&note.id).is_err());
        assert!(store.list().unwrap().is_empty());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn list_sorts_by_created_at() {
        let (store, path) = test_store();
        let first = store.create("yellow", 0, 0).unwrap();
        let second = store.create("pink", 0, 0).unwrap();
        let notes = store.list().unwrap();
        let ids: Vec<_> = notes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, vec![first.id.as_str(), second.id.as_str()]);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn note_safe_dir_strips_path_separators_and_falls_back() {
        assert_eq!(note_safe_dir("note-1-2"), "note-1-2");
        assert_ne!(note_safe_dir("../evil/.."), "../evil/..");
        assert!(!note_safe_dir("../evil/..").contains('/'));
        assert!(!note_safe_dir("a\\b:c*?\"<>|").contains('\\'));
        assert_eq!(note_safe_dir("///"), "unknown");
        // 单段 "." / ".." 可能越过 images 根目录，必须回退
        assert_eq!(note_safe_dir("."), "unknown");
        assert_eq!(note_safe_dir(".."), "unknown");
    }

    /// 「便签不存在」是**跨端契约**：前端 `StickyNote.tsx` 靠这句话区分
    /// 「便签真的没了」（销毁窗口）与「瞬时读取失败」（保留窗口 + 重试卡片）。
    ///
    /// 为什么必须钉住：文案一改，前端 `includes` 就永远不成立 —— 已删除的便签会
    /// 变成一张「读取失败，重试」的幽灵卡片（点重试永远失败），而瞬时失败也不再
    /// 被误判（方向安全）；反过来，若前端把判定放宽成「任何错误都销毁窗口」，
    /// 一次 IPC 抖动就会销毁用户正看着的便签窗，而数据里它仍是 visible=true，
    /// 管理窗显示「已贴在桌面」但桌面没有窗口 —— 这正是本次要修的旧 bug。
    #[test]
    fn not_found_message_is_a_cross_boundary_contract() {
        const MARKER: &str = "便利贴不存在";
        // ① 生产代码里必须仍有这条文案（本用例自己写在文件末尾的测试模块里，不算）
        let source = include_str!("mod.rs");
        let production = source
            .split("\n#[cfg(test)]")
            .next()
            .expect("mod.rs 至少应有一段生产代码");
        assert!(
            production.contains(&format!("\"{MARKER}\"")),
            "后端不再返回「{MARKER}」：前端 StickyNote.tsx 的 NOTE_NOT_FOUND_MARKER 必须同步修改"
        );
        // ② 前端必须引用同一个字面量，且经由具名常量（避免散落的裸字符串）
        let frontend = include_str!("../../../src/tools/sticky-note/StickyNote.tsx");
        assert!(
            frontend.contains(&format!("const NOTE_NOT_FOUND_MARKER = \"{MARKER}\";")),
            "前端 StickyNote.tsx 的 NOTE_NOT_FOUND_MARKER 与后端文案不一致：\
             两侧必须逐字相同，否则「便签已删除」与「瞬时失败」再也分不开"
        );
        assert!(
            frontend.contains("message.includes(NOTE_NOT_FOUND_MARKER)"),
            "前端必须用该常量做判定；退回裸字符串会让本守卫失去意义"
        );
    }
}
