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

// ── 手动尺寸（用户拖右下角 / 拖窗口边改大小）────────────────────────────────
// 尺寸以**窗口**逻辑像素存储（含 .sn-window 四周的透明留白：左右各 16、上 16 下 22），
// 与前端 `setSize` 下发的是同一套口径。0 表示「自动」：宽 264、高随内容走。
//
// 下限与前端 `src/tools/sticky-note/constants.ts` 的 `NOTE_MIN_WINDOW_WIDTH/HEIGHT`
// 必须一致：窗口的 `min_inner_size` 只在原生层兜底，前端手柄拖到极限时也要停在同一个值。
pub const NOTE_MIN_WIDTH_LOGICAL: f64 = 200.0;
pub const NOTE_MIN_HEIGHT_LOGICAL: f64 = 146.0;
/// 手动尺寸上限：**只是防脏数据的理智上限**（手改 notes.json、显示器缩放变化后的残留值），
/// 不是「用户拖不到这么大」——4K 屏 200% 缩放时逻辑宽也就 1920 上下，一个大屏用户可以合法地
/// 把便签拖到比 1600 宽。上限若压得太低，前端存进去的尺寸会被后端改小，下次开窗对不上。
pub const NOTE_MAX_WIDTH_LOGICAL: f64 = 10_000.0;
pub const NOTE_MAX_HEIGHT_LOGICAL: f64 = 10_000.0;

/// 归一化手动尺寸：非有限值 / ≤0 一律视为「自动」(0, 0)，其余夹到 [min, max]。
pub fn normalize_note_size(width: f64, height: f64) -> (f64, f64) {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return (0.0, 0.0);
    }
    (
        width.clamp(NOTE_MIN_WIDTH_LOGICAL, NOTE_MAX_WIDTH_LOGICAL),
        height.clamp(NOTE_MIN_HEIGHT_LOGICAL, NOTE_MAX_HEIGHT_LOGICAL),
    )
}

/// 便签窗口应使用的逻辑尺寸：手动尺寸有效时用它，否则回落「默认宽 × 初始高」。
pub fn note_window_size(width: f64, height: f64) -> (f64, f64) {
    let (w, h) = normalize_note_size(width, height);
    if w > 0.0 && h > 0.0 {
        (w, h)
    } else {
        (NOTE_WIDTH_LOGICAL, NOTE_INITIAL_HEIGHT_LOGICAL)
    }
}

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
    /// 手动设定的窗口逻辑宽 / 高（含透明留白）。0 = 自动（宽 264、高随内容）。
    /// 老数据没有这两个字段时 serde 补 0 —— 即维持「自动」语义，不会把旧便签撑大。
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
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
            width: 0.0,
            height: 0.0,
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

    /// 记住用户手动拖出来的尺寸（逻辑 px，含透明留白）。
    ///
    /// 尺寸与「自动」互斥：写过这里之后，前端不再下发按内容算出的高度
    /// （`StickyNote.tsx` 的 `scheduleResize` 在手动模式直接返回）。想回到自动
    /// 走 [`Self::reset_size`]。
    pub fn set_size(&self, id: &str, width: f64, height: f64) -> Result<StickyNote, String> {
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return Err("便利贴尺寸无效".to_string());
        }
        self.write_size(id, normalize_note_size(width, height))
    }

    /// 恢复「高度随内容」的自动模式（双击右下角手柄）。
    pub fn reset_size(&self, id: &str) -> Result<StickyNote, String> {
        self.write_size(id, (0.0, 0.0))
    }

    fn write_size(&self, id: &str, size: (f64, f64)) -> Result<StickyNote, String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let previous = data.clone();
        let note = data
            .notes
            .iter_mut()
            .find(|note| note.id == id)
            .ok_or_else(|| "便利贴不存在".to_string())?;
        note.width = size.0;
        note.height = size.1;
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
                    // 尺寸脏值（手改文件 / 换显示器后超界）在读取时就被夹回合法区间，
                    // 否则会被 `show_note_window` 直接拿去 set_size。
                    let (w, h) = normalize_note_size(note.width, note.height);
                    note.width = w;
                    note.height = h;
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
pub fn ensure_note_window(
    app: &tauri::AppHandle,
    id: &str,
) -> Result<tauri::WebviewWindow, String> {
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
        // 可改大小：右下角纸角手柄走前端的 `startResizeDragging()`（确定可用的一条路）。
        // 窗口**四边**能不能拖取决于原生样式，而这一条没有源码依据：tao 的 `RESIZABLE`
        // 会带 WS_SIZEBOX（= WS_THICKFRAME），但无边框窗在 `WM_NCCALCSIZE` 里把整个窗口
        // 算作客户区（tao-0.35 `platform_impl/windows/window.rs` 的 undecorated 分支
        // 直接 `return LRESULT(0)`），四边的隐形命中区还在不在**需要真机确认** ——
        // 别把它当成「用户能这么用」写进文档或提示文案。
        // 两者都要求这里为 true：关掉后 `start_resize_dragging` 会直接失败。
        .resizable(true)
        .min_inner_size(NOTE_MIN_WIDTH_LOGICAL, NOTE_MIN_HEIGHT_LOGICAL)
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
                let _ = close_app.emit_to(close_label.as_str(), "sticky-note-close-requested", ());
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
        let (w, h) = note_window_size(note.width, note.height);
        let w_px = (w * scale).round() as i32;
        let h_px = (h * scale).round() as i32;
        // 只有**手动尺寸**的便签才在这里 set_size，且必须在 show 之前设：前端在手动模式下
        // 不再量内容下发高度，晚一步设就会先闪一下 264×180 的小窗再跳到大尺寸。
        //
        // ⚠️ 自动尺寸（width/height = 0）时**绝不能**设成这里回落的默认值。窗口只隐藏不销毁：
        // 「收起（含 Alt+F4）→ 唤出」路径上页面还活着，前端 `onResized` 会把这次程序性缩放
        // 当成「用户拖过窗口边」，于是永久切进手动模式并把 264×180 落盘；而自动模式的高度
        // 本来就是前端量内容下发的，被压回 180 后不会再纠偏 —— 高一点的便签唤出后只剩顶上
        // 一条，正文被窗口裁掉（编辑器虽然能滚动，但卡片整体超出窗口，滚不到 footer）。
        let (manual_w, manual_h) = normalize_note_size(note.width, note.height);
        if manual_w > 0.0 && manual_h > 0.0 {
            if let Err(error) = win.set_size(tauri::LogicalSize::new(w, h)) {
                // 失败不阻断显示（便签仍可用），但必须留痕：手动尺寸的便签会停在默认尺寸上，
                // 而前端不会再纠偏 —— 静默失败就永远查不到「尺寸没恢复」的原因
                crate::utils::logger::log(
                    "sticky_note",
                    &format!("恢复便签尺寸失败（{}×{}）: {error}", w, h),
                );
            }
        }
        let (x, y) = crate::commands::clamp_position_to_workarea(note.x, note.y, w_px, h_px);
        win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            x, y,
        )))
        .map_err(|e| format!("设置便利贴位置失败: {e}"))?;
    }
    win.show().map_err(|e| format!("显示便利贴失败: {e}"))?;
    if focus {
        win.set_focus()
            .map_err(|e| format!("聚焦便利贴失败: {e}"))?;
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
/// 图片像素数量上限（与剪贴板模块同口径），挡住「小文件解码成巨图」的解压炸弹
pub const IMAGE_MAX_PIXELS: u64 = 25_000_000;
/// 图片根目录名（位于 app 数据目录下），与 tauri.conf.json asset scope 同步
pub const IMAGES_REL_ROOT: &str = "sticky-images";
/// 允许作为便签图片来源的扩展名（小写）。非 PNG 一律转码成 PNG 再落盘，
/// 因此目录里最终只有 `img_*.png` 一种文件，剪贴板复制 / 令牌解析都只认 PNG。
///
/// ⚠️ 这份清单受限于 `image` 依赖开启的特性（Cargo.toml：png/gif/jpeg/bmp）：
/// 加进清单的格式必须能被解码，否则「转码成 PNG」会失败、用户看到的是一句
/// 后端报错。要支持 WebP 得先给 image 加 `webp` 特性。
pub const IMAGE_SOURCE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp"];
/// 用户可见的来源格式提示（与 [IMAGE_SOURCE_EXTS] 保持同一份清单）
pub const IMAGE_SOURCE_HINT: &str = "只支持 PNG / JPG / GIF / BMP 图片";
/// 单调序号：同毫秒连续粘贴多张图时用于区分文件名
static IMG_SEQ: AtomicU64 = AtomicU64::new(0);

/// app 数据目录 → 便利贴图片根目录的绝对路径
pub fn images_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(IMAGES_REL_ROOT))
        .map_err(|e| format!("获取应用数据目录失败: {e}"))
}

/// 把任意受支持格式的图片字节统一成 PNG 字节。
///
/// **格式判定一律看字节内容（`with_guessed_format`），不看调用方说的扩展名**：
/// 剪贴板里的图片项 MIME 与真实字节并不总是一致（从资源管理器复制一张 .jpg 再粘贴，
/// 剪贴板给的是 `image/jpeg`），照扩展名写就会把 JPEG 字节塞进 `img_*.png` ——
/// 页面靠嗅探还能显示，但「复制到剪贴板」（`clipboard::copy_image` 只认 PNG）会失败。
///
/// 已经是 PNG 的原样返回（不做无意义的解码—编码往返）。顺带在这里按头部尺寸挡一次
/// 解压炸弹（与 `clipboard::validate_gif_dimensions` 同思路），所以在写盘/进剪贴板之前
/// 一定会先过像素数上限。
pub fn ensure_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("图片格式无法识别: {e}"))?;
    let format = reader.format();
    let (width, height) = reader
        .into_dimensions()
        .map_err(|e| format!("图片格式无法识别: {e}"))?;
    if u64::from(width) * u64::from(height) > IMAGE_MAX_PIXELS {
        return Err("图片像素数量过大".into());
    }
    match format {
        Some(image::ImageFormat::Png) => Ok(bytes.to_vec()),
        Some(_) => {
            let decoded =
                image::load_from_memory(bytes).map_err(|e| format!("图片解码失败: {e}"))?;
            let mut buffer = std::io::Cursor::new(Vec::new());
            decoded
                .write_to(&mut buffer, image::ImageFormat::Png)
                .map_err(|e| format!("图片转码失败: {e}"))?;
            Ok(buffer.into_inner())
        }
        // 认不出格式（含 SVG / 文本改名成 .png 之类）直接拒绝，
        // 别把不可显示的字节写进图片目录
        None => Err(IMAGE_SOURCE_HINT.into()),
    }
}

/// 保存一张图片，返回正文令牌中的相对路径（相对 [images_dir]）。
///
/// 非 PNG 一律转码成 PNG：目录里只留一种格式，代价是丢掉 GIF 动画，
/// 换来的是「复制到剪贴板」与「令牌解析」都只需处理 PNG 这一条路径。
pub fn save_image(app: &tauri::AppHandle, note_id: &str, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("图片内容为空".into());
    }
    if bytes.len() > IMAGE_MAX_BYTES {
        return Err(format!(
            "图片不能超过 {}MB",
            IMAGE_MAX_BYTES / (1024 * 1024)
        ));
    }
    let data = ensure_png(bytes)?;

    let subdir = images_dir(app)?.join(note_safe_dir(note_id));
    fs::create_dir_all(&subdir).map_err(|e| format!("创建图片目录失败: {e}"))?;
    let filename = format!(
        "img_{}_{}.png",
        Utc::now().timestamp_millis(),
        IMG_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    fs::write(subdir.join(&filename), data).map_err(|e| format!("写入图片文件失败: {e}"))?;
    Ok(format!("{}/{}", note_safe_dir(note_id), filename))
}

/// 从本地文件导入一张图片（资源管理器拖入便签）。扩展名只做**预筛**（早失败、少读盘），
/// 真正的格式判定在 [save_image] 里按字节做（.png 后缀里装 JPEG 也能正确转码）。
pub fn import_image_file(
    app: &tauri::AppHandle,
    note_id: &str,
    path: &std::path::Path,
) -> Result<String, String> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .ok_or_else(|| IMAGE_SOURCE_HINT.to_string())?;
    if !IMAGE_SOURCE_EXTS.contains(&ext.as_str()) {
        return Err(IMAGE_SOURCE_HINT.into());
    }
    let meta = fs::metadata(path).map_err(|e| format!("读取图片失败: {e}"))?;
    if meta.len() > IMAGE_MAX_BYTES as u64 {
        return Err(format!(
            "图片不能超过 {}MB",
            IMAGE_MAX_BYTES / (1024 * 1024)
        ));
    }
    let bytes = fs::read(path).map_err(|e| format!("读取图片失败: {e}"))?;
    save_image(app, note_id, &bytes)
}

/// 解析正文令牌里的图片相对路径为磁盘绝对路径。
///
/// ⚠️ `rel` 来自前端（正文文本），属于**不可信输入**：必须保证它只能落在
/// `sticky-images/<本便签目录>/img_*.<ext>` 之内 —— 否则一个 `../..` 就能让
/// 「删除图片」把用户任意文件删掉。这里逐段校验：目录段必须等于本便签的清洗后
/// 目录名（不含任何分隔符），文件名必须严格匹配本模块生成的
/// `img_<数字>_<数字>.<白名单扩展名>`，因此天然排除了上跳与分隔符。
pub fn resolve_image_path(
    app: &tauri::AppHandle,
    note_id: &str,
    rel: &str,
) -> Result<PathBuf, String> {
    let (dir, file) =
        validated_image_rel(note_id, rel).ok_or_else(|| "图片路径无效".to_string())?;
    Ok(images_dir(app)?.join(dir).join(file))
}

/// [`resolve_image_path`] 的纯函数内核（不依赖 AppHandle，便于用例直接钉住校验规则）：
/// 返回 `(目录名, 文件名)`，任何越界形态一律 `None`。
pub fn validated_image_rel(note_id: &str, rel: &str) -> Option<(String, String)> {
    let expected_dir = note_safe_dir(note_id);
    let (dir, file) = rel.split_once('/')?;
    if dir != expected_dir || !is_generated_image_file(file) {
        return None;
    }
    Some((expected_dir, file.to_string()))
}

/// 严格匹配本模块生成的文件名：`img_<millis>_<seq>.png`（也接受历史上可能出现的其它白名单扩展名）
fn is_generated_image_file(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("img_") else {
        return false;
    };
    let Some((stem, ext)) = rest.rsplit_once('.') else {
        return false;
    };
    if !IMAGE_SOURCE_EXTS.contains(&ext.to_ascii_lowercase().as_str()) {
        return false;
    }
    let mut parts = stem.split('_');
    let (Some(millis), Some(seq), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let digits = |value: &str| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit());
    digits(millis) && digits(seq)
}

/// 从便签正文里删掉一张图片时一并删掉磁盘文件。文件已不存在视为成功（幂等）。
pub fn delete_image(app: &tauri::AppHandle, note_id: &str, rel: &str) -> Result<(), String> {
    let path = resolve_image_path(app, note_id, rel)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除图片失败: {error}")),
    }
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

    // ── 手动尺寸 ────────────────────────────────────────────────────────────

    /// 尺寸只有两种语义：0 = 自动，>0 = 用户拖出来的固定尺寸（夹在上下限之间）。
    /// 脏值必须落回「自动」而不是被当成一个 1×1 的小窗。
    #[test]
    fn normalize_note_size_treats_non_positive_and_nan_as_auto() {
        assert_eq!(normalize_note_size(0.0, 0.0), (0.0, 0.0));
        assert_eq!(normalize_note_size(-5.0, 300.0), (0.0, 0.0));
        assert_eq!(normalize_note_size(f64::NAN, 300.0), (0.0, 0.0));
        assert_eq!(normalize_note_size(f64::INFINITY, 300.0), (0.0, 0.0));
        // 越界值夹回区间（上限只是理智边界：给一个明确超过它的脏值）
        assert_eq!(
            normalize_note_size(10.0, 10.0),
            (NOTE_MIN_WIDTH_LOGICAL, NOTE_MIN_HEIGHT_LOGICAL)
        );
        assert_eq!(
            normalize_note_size(1.0e9, 1.0e9),
            (NOTE_MAX_WIDTH_LOGICAL, NOTE_MAX_HEIGHT_LOGICAL)
        );
        // 大屏用户合法拖得到的尺寸**不能**被上限改小：前端存进去的值与后端落盘的值不一致时，
        // 下次开窗的窗口尺寸就会和用户拖出来的不一样（静默回缩）。
        assert_eq!(normalize_note_size(2400.0, 3000.0), (2400.0, 3000.0));
        // 合法值原样保留
        assert_eq!(normalize_note_size(320.0, 420.0), (320.0, 420.0));
    }

    #[test]
    fn note_window_size_falls_back_to_defaults_when_auto() {
        assert_eq!(
            note_window_size(0.0, 0.0),
            (NOTE_WIDTH_LOGICAL, NOTE_INITIAL_HEIGHT_LOGICAL)
        );
        assert_eq!(note_window_size(300.0, 400.0), (300.0, 400.0));
    }

    #[test]
    fn manual_size_persists_and_resets() {
        let (store, path) = test_store();
        let note = store.create("yellow", 0, 0).unwrap();
        // 新建便签默认是自动尺寸
        assert_eq!((note.width, note.height), (0.0, 0.0));

        let sized = store.set_size(&note.id, 340.0, 460.0).unwrap();
        assert_eq!((sized.width, sized.height), (340.0, 460.0));
        // 落盘后再读回来仍然是手动尺寸（重启应用不回退成自动高度）
        let reloaded = store.get(&note.id).unwrap();
        assert_eq!((reloaded.width, reloaded.height), (340.0, 460.0));

        let reset = store.reset_size(&note.id).unwrap();
        assert_eq!((reset.width, reset.height), (0.0, 0.0));
        let _ = fs::remove_file(path);
    }

    /// 尺寸下限必须由后端也守住：前端手柄拖过极限值、或手工改坏 notes.json 时，
    /// 一个 1×1 的便签窗用户既看不到也点不到，只能删数据。
    #[test]
    fn set_size_rejects_invalid_and_clamps_out_of_range() {
        let (store, path) = test_store();
        let note = store.create("yellow", 0, 0).unwrap();
        assert!(store.set_size(&note.id, 0.0, 300.0).is_err());
        assert!(store.set_size(&note.id, 300.0, -1.0).is_err());
        assert!(store.set_size(&note.id, f64::NAN, 300.0).is_err());
        let clamped = store.set_size(&note.id, 20.0, 20.0).unwrap();
        assert_eq!(
            (clamped.width, clamped.height),
            (NOTE_MIN_WIDTH_LOGICAL, NOTE_MIN_HEIGHT_LOGICAL)
        );
        let _ = fs::remove_file(path);
    }

    // ── 图片格式归一化 ──────────────────────────────────────────────────────

    /// 单帧 GIF 的字节（`image` 开了 gif 特性，测试里直接编一张）
    fn sample_gif_bytes() -> Vec<u8> {
        let frame = image::Frame::from_parts(
            image::RgbaImage::from_pixel(3, 2, image::Rgba([0, 255, 0, 255])),
            0,
            0,
            image::Delay::from_saturating_duration(std::time::Duration::from_millis(100)),
        );
        let mut buf = std::io::Cursor::new(Vec::new());
        image::codecs::gif::GifEncoder::new(&mut buf)
            .encode_frames([frame])
            .expect("GIF 编码失败");
        buf.into_inner()
    }

    /// PNG 的 8 字节文件头
    const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

    fn sample_png_bytes() -> Vec<u8> {
        let source = image::RgbaImage::from_pixel(3, 2, image::Rgba([200, 30, 30, 255]));
        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(source)
            .write_to(&mut buf, image::ImageFormat::Png)
            .expect("PNG 编码失败");
        buf.into_inner()
    }

    /// 格式判定必须看**字节内容**，不能信调用方给的扩展名 / 来源 MIME：
    /// 从资源管理器复制一张 .jpg 粘进便签时，剪贴板给的是 `image/jpeg`，而落盘固定叫
    /// `img_*.png`。照扩展名写就会把 JPEG 字节塞进 .png 文件 —— 页面能显示，
    /// 「复制到剪贴板」却解码失败（`clipboard::copy_image` 只认 PNG）。
    #[test]
    fn ensure_png_normalizes_by_content_not_by_name() {
        let png_bytes = sample_png_bytes();
        assert_eq!(&png_bytes[..8], PNG_MAGIC);
        // 本来就是 PNG：原样返回（不做无意义的解码—编码往返）
        assert_eq!(ensure_png(&png_bytes).unwrap(), png_bytes);

        // GIF 字节：即使来源自称 png，也要转成真正的 PNG
        let gif_bytes = sample_gif_bytes();
        let normalized = ensure_png(&gif_bytes).unwrap();
        assert_eq!(&normalized[..8], PNG_MAGIC, "非 PNG 字节必须被转码成 PNG");
        assert_ne!(normalized, gif_bytes);

        // 认不出格式：拒绝，而不是把不可显示的字节写进图片目录
        assert!(ensure_png(b"not an image").is_err());
        assert!(ensure_png(b"").is_err());
    }

    // ── 图片相对路径校验 ────────────────────────────────────────────────────
    /// rel 来自正文文本（**不可信**）。校验必须只放行本模块自己生成的文件名：
    /// 任何带分隔符 / 上跳 / 其它目录名 / 其它扩展名的写法都要被拒，否则
    /// 「删除图片」会变成「删除用户任意文件」。
    #[test]
    fn validated_image_rel_only_accepts_own_filenames() {
        let note_id = "note-1750000000000-1";
        let rel = "note-1750000000000-1/img_1750000000000_0.png";
        assert_eq!(
            validated_image_rel(note_id, rel),
            Some((
                "note-1750000000000-1".to_string(),
                "img_1750000000000_0.png".to_string()
            ))
        );
        // 历史 / 转码前的其它白名单扩展名同样可解析（目录里可能还留着旧文件）
        assert!(validated_image_rel(note_id, "note-1750000000000-1/img_1_2.jpg").is_some());

        for evil in [
            "../evil/img_1_2.png",                  // 目录段上跳
            "note-1750000000000-1/../img_1_2.png",  // 文件名上跳
            "note-1750000000000-1/sub/img_1_2.png", // 多余层级
            "note-1750000000000-1/img_1_2",         // 无扩展名
            "note-1750000000000-1/img_1_2.exe",     // 非图片扩展名
            "note-1750000000000-1/notes.json",      // 其它文件
            "note-1750000000000-1/img_a_b.png",     // 非数字序号
            "note-1750000000000-1/img_1_2_3.png",   // 段数不符
            "note-1750000000000-2/img_1_2.png",     // 别人的目录
            "img_1_2.png",                          // 没有目录段
            "note-1750000000000-1\\img_1_2.png",    // 反斜杠（split_once('/') 落空）
            "note-1750000000000-1/img_1_2.PNG.exe", // 双扩展名
        ] {
            assert!(
                validated_image_rel(note_id, evil).is_none(),
                "越界路径必须被拒绝: {evil}"
            );
        }
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
