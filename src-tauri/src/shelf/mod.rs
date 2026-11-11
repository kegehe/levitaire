//! 文件暂存架：清单与副本。
//!
//! 引用只记路径。易失路径上的文件在调用方返回前复制进 `shelf/files`。
//! 拖出只允许复制，删除副本前要证明路径仍在 `shelf/files` 里。

mod add;
mod delete;
mod drag_out;
mod drag_watch;
mod drop_target;
mod paste;
pub(crate) mod thumb;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use chrono::Utc;
use serde::{Deserialize, Serialize};

pub use drag_out::begin_drag;
pub use drag_watch::{on_mouse_down as note_mouse_down, on_mouse_up as note_mouse_up, start as start_drag_watch};
pub use drop_target::{bind_shelf_drop_target, disable_webview_external_drop};
pub use paste::paste_clipboard;

const MANIFEST_VERSION: u32 = 1;
pub const MAX_ITEMS: usize = 30;
pub const MAX_DRAG_ITEMS: usize = 20;
/// 易失复制与截图字节的单次上限。Drop 返回前要写完，再大源程序会取消拖放。
pub const MAX_OWNED_BYTES: u64 = 128 * 1024 * 1024;
pub const MAX_SHELF_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ShelfKind {
    Reference,
    Owned,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfItem {
    pub id: String,
    pub kind: ShelfKind,
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShelfFile {
    version: u32,
    #[serde(default)]
    collapsed: bool,
    items: Vec<ShelfItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfItemDto {
    pub id: String,
    pub kind: ShelfKind,
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub added_at: String,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfSnapshot {
    pub items: Vec<ShelfItemDto>,
    pub collapsed: bool,
    pub notice: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AddStatus {
    Added,
    Topped,
    Rejected,
    Ignored,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddResult {
    pub path: String,
    pub status: AddStatus,
    pub message: Option<String>,
    pub id: Option<String>,
}

struct ShelfData {
    collapsed: bool,
    items: Vec<ShelfItem>,
    notice: Option<String>,
    next_seq: u64,
}

pub struct ShelfStore {
    manifest_path: PathBuf,
    files_dir: PathBuf,
    data: Mutex<ShelfData>,
    dragging: AtomicBool,
    /// 缩略图缓存：`{path}|{mtime}` → data URL（None 表示生成过但拿不到，避免反复重试）。
    /// 上限随 MAX_ITEMS=30，内存占用 ~1-2MB，不做持久化、不做淘汰。
    thumb_cache: Mutex<HashMap<String, Option<String>>>,
}

impl ShelfStore {
    pub fn load_default() -> Self {
        let root = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("levitaire");
        Self::open(root)
    }

    pub fn open(root: PathBuf) -> Self {
        let _ = fs::create_dir_all(&root);
        let manifest_path = root.join("shelf.json");
        let files_dir = root.join("shelf").join("files");
        let _ = fs::create_dir_all(&files_dir);
        let (data, notice) = load_manifest(&manifest_path);
        Self {
            manifest_path,
            files_dir,
            data: Mutex::new(ShelfData {
                collapsed: data.collapsed,
                items: data.items,
                notice,
                next_seq: 1,
            }),
            dragging: AtomicBool::new(false),
            thumb_cache: Mutex::new(HashMap::new()),
        }
    }

    /// 取条目的媒体信息（路径 / 是否丢失 / 文件名），供缩略图命令使用。
    /// 目录一律返回 None：目录不取缩略图，也不能靠文件名猜类型（目录叫「x.mp4」时
    /// Shell 会给出文件夹封面，被当成视频缩略图展示）。
    pub fn media_item(&self, id: &str) -> Option<(String, bool, String)> {
        let data = self.lock();
        let item = data.items.iter().find(|item| item.id == id)?;
        if item.is_dir {
            return None;
        }
        Some((item.path.clone(), !Path::new(&item.path).exists(), item.name.clone()))
    }

    pub fn thumb_get(&self, key: &str) -> Option<Option<String>> {
        self.thumb_cache.lock().unwrap_or_else(|poison| poison.into_inner()).get(key).cloned()
    }

    pub fn thumb_store(&self, key: String, value: Option<String>) {
        let mut cache = self.thumb_cache.lock().unwrap_or_else(|poison| poison.into_inner());
        if cache.len() > 64 {
            cache.clear();
        }
        cache.insert(key, value);
    }

    pub fn list(&self) -> ShelfSnapshot {
        // 先在锁内拷出清单，再在锁外做存在性检查：引用条目可能指向离线的网络盘 /
        // 已拔出的移动盘，`exists()` 会卡到 SMB 超时（数秒）。拿着清单锁做，
        // 会把同一时间的加入/删除一起堵死；调用方（shelf_list）还会把它丢到
        // 阻塞线程池，不能占住 UI 主线程。
        let (items, collapsed, notice) = {
            let data = self.lock();
            (data.items.clone(), data.collapsed, data.notice.clone())
        };
        let items = items
            .into_iter()
            .map(|item| {
                let missing = !Path::new(&item.path).exists();
                ShelfItemDto {
                    id: item.id,
                    kind: item.kind,
                    name: item.name,
                    path: item.path,
                    is_dir: item.is_dir,
                    size: item.size,
                    added_at: item.added_at,
                    missing,
                }
            })
            .collect();
        ShelfSnapshot {
            items,
            collapsed,
            notice,
        }
    }

    pub fn dismiss_notice(&self) -> Result<(), String> {
        let mut data = self.lock();
        data.notice = None;
        Ok(())
    }

    pub fn set_collapsed(&self, collapsed: bool) -> Result<(), String> {
        let mut data = self.lock();
        let previous = data.collapsed;
        data.collapsed = collapsed;
        if let Err(error) = write_manifest(&self.manifest_path, &data) {
            data.collapsed = previous;
            return Err(error);
        }
        Ok(())
    }

    /// 按 `ids` 的顺序重写清单。必须正好是现有条目的一个排列，否则视为拖拽期间
    /// 清单已经被加入/移除改动过，让前端刷新后重来，避免按一份过期的顺序落盘。
    pub fn reorder(&self, ids: &[String]) -> Result<(), String> {
        let mut data = self.lock();
        if ids.len() != data.items.len() {
            return Err("清单已变化，请重试".to_string());
        }
        let mut remaining: std::collections::HashMap<&str, &ShelfItem> = data
            .items
            .iter()
            .map(|item| (item.id.as_str(), item))
            .collect();
        let mut next = Vec::with_capacity(ids.len());
        for id in ids {
            let Some(item) = remaining.remove(id.as_str()) else {
                return Err("清单已变化，请重试".to_string());
            };
            next.push(item.clone());
        }
        drop(remaining);
        let previous = std::mem::replace(&mut data.items, next);
        if let Err(error) = write_manifest(&self.manifest_path, &data) {
            data.items = previous;
            return Err(error);
        }
        Ok(())
    }

    pub fn add_paths(&self, paths: &[PathBuf]) -> Vec<AddResult> {
        if self.dragging.load(Ordering::SeqCst) {
            return paths
                .iter()
                .map(|path| AddResult {
                    path: path.display().to_string(),
                    status: AddStatus::Ignored,
                    message: None,
                    id: None,
                })
                .collect();
        }
        let mut data = self.lock();
        let mut results = Vec::with_capacity(paths.len());
        let mut created = Vec::new();
        let mut changed = false;
        for path in paths {
            let ingested = add::ingest_one(&mut data, &self.files_dir, path);
            if let Some(path) = ingested.created {
                created.push(path);
            }
            if matches!(ingested.result.status, AddStatus::Added | AddStatus::Topped) {
                changed = true;
            }
            results.push(ingested.result);
        }
        if changed {
            if let Err(error) = write_manifest(&self.manifest_path, &data) {
                for path in &created {
                    let _ = fs::remove_file(path);
                }
                let (reloaded, notice) = load_manifest(&self.manifest_path);
                data.items = reloaded.items;
                data.collapsed = reloaded.collapsed;
                data.notice = notice.or(Some(error));
                for result in &mut results {
                    if matches!(result.status, AddStatus::Added | AddStatus::Topped) {
                        result.status = AddStatus::Rejected;
                        result.message = Some("清单没有写上，这一项没有加入".to_string());
                        result.id = None;
                    }
                }
            }
        }
        results
    }

    pub fn add_png(&self, bytes: &[u8], display_name: &str) -> Result<String, String> {
        if bytes.is_empty() {
            return Err("找不到文件".to_string());
        }
        if bytes.len() as u64 > MAX_OWNED_BYTES {
            return Err("文件过大，暂存架不复制".to_string());
        }
        let mut data = self.lock();
        if data.items.len() >= MAX_ITEMS {
            return Err("暂存架已有 30 个文件".to_string());
        }
        delete::ensure_storage_writable(&self.files_dir)?;
        if owned_usage(&self.files_dir)? + bytes.len() as u64 > MAX_SHELF_BYTES {
            return Err("暂存架已满".to_string());
        }
        let id = next_id(&mut data.next_seq);
        let path = self.files_dir.join(format!("{id}.png"));
        let partial = self.files_dir.join(format!("{id}.partial"));
        if let Err(error) = fs::write(&partial, bytes) {
            let _ = fs::remove_file(&partial);
            return Err(format!("复制失败：{error}"));
        }
        if let Err(error) = fs::rename(&partial, &path) {
            let _ = fs::remove_file(&partial);
            return Err(format!("复制失败：{error}"));
        }
        let name = unique_display_name(&data.items, display_name);
        data.items.insert(
            0,
            ShelfItem {
                id: id.clone(),
                kind: ShelfKind::Owned,
                name,
                path: path.display().to_string(),
                source_path: None,
                is_dir: false,
                size: Some(bytes.len() as u64),
                added_at: Utc::now().to_rfc3339(),
            },
        );
        if let Err(error) = write_manifest(&self.manifest_path, &data) {
            data.items.retain(|item| item.id != id);
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        Ok(id)
    }

    pub fn remove(&self, ids: &[String]) -> Result<(), String> {
        self.remove_inner(ids, false)
    }

    pub fn clear(&self) -> Result<(), String> {
        let ids: Vec<String> = self.lock().items.iter().map(|item| item.id.clone()).collect();
        self.remove_inner(&ids, true)
    }

    pub fn reveal(&self, id: &str) -> Result<(), String> {
        let data = self.lock();
        let item = data
            .items
            .iter()
            .find(|item| item.id == id)
            .ok_or_else(|| "找不到这一项".to_string())?;
        if !Path::new(&item.path).exists() {
            return Err("找不到了".to_string());
        }
        let path = item.path.clone();
        let is_dir = item.is_dir;
        drop(data);
        reveal_in_explorer(&path, is_dir)
    }

    /// 用系统默认程序打开条目。文件夹交给资源管理器打开。
    pub fn open_item(&self, id: &str) -> Result<(), String> {
        let data = self.lock();
        let item = data
            .items
            .iter()
            .find(|item| item.id == id)
            .ok_or_else(|| "找不到这一项".to_string())?;
        if !Path::new(&item.path).exists() {
            return Err("找不到了".to_string());
        }
        let path = item.path.clone();
        drop(data);
        open_in_default_app(&path)
    }

    /// 拖出前取出仍存在的路径。有缺失 id 时整次失败。
    pub fn paths_for_drag(&self, ids: &[String]) -> Result<Vec<PathBuf>, String> {
        if ids.is_empty() {
            return Err("没有可拖出的文件".to_string());
        }
        if ids.len() > MAX_DRAG_ITEMS {
            return Err("一次最多拖出 20 个".to_string());
        }
        let data = self.lock();
        let mut paths = Vec::with_capacity(ids.len());
        for id in ids {
            let item = data
                .items
                .iter()
                .find(|item| item.id == *id)
                .ok_or_else(|| format!("找不到这一项：{id}"))?;
            if !Path::new(&item.path).exists() {
                return Err(format!("「{}」找不到了", item.name));
            }
            paths.push(PathBuf::from(&item.path));
        }
        Ok(paths)
    }

    pub fn set_dragging(&self, dragging: bool) {
        self.dragging.store(dragging, Ordering::SeqCst);
    }

    pub fn is_dragging(&self) -> bool {
        self.dragging.load(Ordering::SeqCst)
    }

    fn remove_inner(&self, ids: &[String], _clearing: bool) -> Result<(), String> {
        if delete::files_dir_is_reparse(&self.files_dir)? {
            return Err("暂存目录被重定向，已停止删除".to_string());
        }
        let mut data = self.lock();
        let snapshot = data.items.clone();
        // 先核对全部副本，再动手删。中间有一项路径不对时，前面的副本还在。
        let mut planned = Vec::new();
        for id in ids {
            let Some(item) = data.items.iter().find(|item| item.id == *id) else {
                continue;
            };
            if item.kind == ShelfKind::Owned {
                delete::validate_owned_delete(&self.files_dir, item)?;
            }
            planned.push(item.clone());
        }
        let mut finished = Vec::new();
        for item in &planned {
            if item.kind == ShelfKind::Owned {
                if let Err(error) = delete::delete_owned_file(&self.files_dir, item) {
                    return self.finish_remove(&mut data, &snapshot, &finished, Err(error));
                }
            }
            finished.push(item.id.clone());
        }
        self.finish_remove(&mut data, &snapshot, &finished, Ok(()))
    }

    fn finish_remove(
        &self,
        data: &mut ShelfData,
        snapshot: &[ShelfItem],
        finished: &[String],
        result: Result<(), String>,
    ) -> Result<(), String> {
        if finished.is_empty() {
            return result;
        }
        data.items.retain(|item| !finished.iter().any(|id| id == &item.id));
        let deleted_owned = snapshot.iter().any(|item| {
            item.kind == ShelfKind::Owned && finished.iter().any(|id| id == &item.id)
        });
        if let Err(error) = write_manifest(&self.manifest_path, data) {
            data.items = snapshot.to_vec();
            return Err(if deleted_owned {
                "副本已删除，但清单没写上，重启后会显示为找不到".to_string()
            } else {
                error
            });
        }
        result
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ShelfData> {
        self.data.lock().unwrap_or_else(|poison| poison.into_inner())
    }
}

fn load_manifest(path: &Path) -> (ShelfFile, Option<String>) {
    let empty = ShelfFile {
        version: MANIFEST_VERSION,
        collapsed: false,
        items: Vec::new(),
    };
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return (empty, None),
        // 文件在、但读不出来（被杀毒/备份工具占用、权限、IO 错误）：不能当成
        // 「空清单」静默继续 —— 之后任意一次写入都会把原清单覆盖掉，用户会
        // 在毫无提示的情况下丢掉整份暂存架。先尽力留一份副本，并明确告知。
        Err(error) => {
            let backup = path.with_file_name(format!(
                "shelf.json.bak-{}",
                Utc::now().format("%Y%m%d%H%M%S")
            ));
            let copied = fs::copy(path, &backup).is_ok();
            return (
                empty,
                Some(if copied {
                    "清单读取失败，已备份为 shelf.json.bak-*，暂存架从空列表开始".to_string()
                } else {
                    format!("清单读取失败（{error}），暂存架从空列表开始")
                }),
            );
        }
    };
    match serde_json::from_str::<ShelfFile>(&text) {
        Ok(file) if file.version == MANIFEST_VERSION => (file, None),
        Ok(_) | Err(_) => {
            let backup = path.with_file_name(format!(
                "shelf.json.bak-{}",
                Utc::now().format("%Y%m%d%H%M%S")
            ));
            let backed_up = fs::rename(path, &backup).is_ok();
            (
                empty,
                Some(if backed_up {
                    "清单已备份，暂存架从空列表重新开始".to_string()
                } else {
                    "清单无法解析且备份失败，暂存架从空列表开始".to_string()
                }),
            )
        }
    }
}

fn write_manifest(path: &Path, data: &ShelfData) -> Result<(), String> {
    let file = ShelfFile {
        version: MANIFEST_VERSION,
        collapsed: data.collapsed,
        items: data.items.clone(),
    };
    let content = serde_json::to_string_pretty(&file).map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(&temp, content).map_err(|error| format!("写入清单失败：{error}"))?;
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("替换清单失败：{error}"));
    }
    Ok(())
}

pub(crate) fn next_id(seq: &mut u64) -> String {
    *seq += 1;
    format!("shelf-{}-{}", Utc::now().timestamp_millis(), *seq)
}

pub(crate) fn owned_usage(files_dir: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    let entries = match fs::read_dir(files_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries.flatten() {
        let meta = match entry.metadata() {
            Ok(meta) if meta.is_file() => meta,
            _ => continue,
        };
        total = total.saturating_add(meta.len());
    }
    Ok(total)
}

pub(crate) fn unique_display_name(items: &[ShelfItem], name: &str) -> String {
    if !items.iter().any(|item| item.name == name) {
        return name.to_string();
    }
    let stem = Path::new(name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(name);
    let ext = Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| format!(".{ext}"))
        .unwrap_or_default();
    for index in 2..1000 {
        let candidate = format!("{stem} {index}{ext}");
        if !items.iter().any(|item| item.name == candidate) {
            return candidate;
        }
    }
    format!("{stem} {}", Utc::now().timestamp_millis())
}

fn reveal_in_explorer(path: &str, is_dir: bool) -> Result<(), String> {
    // 清单里存的是 canonicalize 后的 `\\?\` 路径；explorer 不认 verbatim 前缀。
    let shown = add::strip_extended_prefix(path);
    let argument = if is_dir {
        shown
    } else {
        format!("/select,{shown}")
    };
    crate::utils::process::hidden_command("explorer.exe")
        .arg(argument)
        .spawn()
        .map_err(|error| format!("无法打开资源管理器：{error}"))?;
    Ok(())
}

/// 用系统默认程序打开文件；文件夹会交给资源管理器。
///
/// 路径来自清单而不是前端，调用方 `open_item` 已经确认条目存在且路径仍有效，
/// 这里不需要再做路径白名单。
fn open_in_default_app(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        // 清单里存的是 canonicalize 后的 `\\?\` 路径；ShellExecute 不认 verbatim 前缀。
        let target = add::strip_extended_prefix(path);
        let file_wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0u16)).collect();
        let verb: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0u16)).collect();
        // SAFETY: 两个字符串都以 NUL 结尾；返回的 HINSTANCE <= 32 表示失败。
        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(verb.as_ptr()),
                PCWSTR(file_wide.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        let code = result.0 as usize;
        if code <= 32 {
            return Err(format!("打开失败 (code: {code})"));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试根目录放在 Local AppData，不放进 Temp。
    /// 放进 Temp 的文件会被当成易失路径复制，引用相关的断言就失真了。
    fn scratch(name: &str) -> PathBuf {
        let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
        let root = base.join("levitaire-shelf-tests").join(format!(
            "{name}-{}-{}",
            std::process::id(),
            Utc::now().timestamp_millis()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn reference_does_not_copy_into_shelf_files() {
        let root = scratch("ref");
        let store = ShelfStore::open(root.clone());
        let file = root.join("报告.pdf");
        fs::write(&file, b"pdf").unwrap();
        let results = store.add_paths(&[file.clone()]);
        assert_eq!(results[0].status, AddStatus::Added);
        let saved = fs::read_dir(root.join("shelf").join("files")).unwrap().count();
        assert_eq!(saved, 0);
        let listed = store.list();
        assert_eq!(listed.items[0].kind, ShelfKind::Reference);
        assert!(listed.items[0].path.to_lowercase().ends_with("报告.pdf"));
        assert!(!listed.items[0].missing);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn volatile_file_is_copied_and_deduped_by_source_path() {
        let root = scratch("vol");
        let store = ShelfStore::open(root.join("app"));
        let source = std::env::temp_dir().join(format!("shelf-src-{}.txt", std::process::id()));
        fs::write(&source, b"hello").unwrap();
        let first = store.add_paths(&[source.clone()]);
        assert_eq!(first[0].status, AddStatus::Added);
        let copied = store.list().items[0].path.clone();
        assert!(Path::new(&copied).exists());
        assert_ne!(copied, source.display().to_string());
        fs::remove_file(&source).unwrap();
        assert!(!store.list().items[0].missing);
        fs::write(&source, b"hello").unwrap();
        let second = store.add_paths(&[source.clone()]);
        assert_eq!(second[0].status, AddStatus::Topped);
        assert_eq!(store.list().items.len(), 1);
        let _ = fs::remove_file(&source);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prefixed_temp_path_is_still_volatile() {
        let temp = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        assert!(add::is_volatile(&temp.join("a.txt")));
    }

    #[test]
    fn volatile_directory_is_rejected() {
        let root = scratch("voldir");
        let store = ShelfStore::open(root.join("app"));
        let dir = std::env::temp_dir().join(format!("shelf-dir-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let results = store.add_paths(&[dir.clone()]);
        assert_eq!(results[0].status, AddStatus::Rejected);
        assert!(results[0].message.as_deref().unwrap().contains("临时文件夹"));
        assert!(store.list().items.is_empty());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stable_directory_is_a_reference() {
        let root = scratch("dir");
        let store = ShelfStore::open(root.join("app"));
        let dir = root.join("docs");
        fs::create_dir_all(&dir).unwrap();
        let results = store.add_paths(&[dir]);
        assert_eq!(results[0].status, AddStatus::Added);
        assert!(store.list().items[0].is_dir);
        assert_eq!(
            fs::read_dir(root.join("app").join("shelf").join("files"))
                .unwrap()
                .count(),
            0
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn item_cap_rejects_the_31st() {
        let root = scratch("cap");
        let store = ShelfStore::open(root.join("app"));
        for index in 0..MAX_ITEMS {
            let file = root.join(format!("f{index}.txt"));
            fs::write(&file, b"x").unwrap();
            assert_eq!(store.add_paths(&[file])[0].status, AddStatus::Added);
        }
        let extra = root.join("overflow.txt");
        fs::write(&extra, b"x").unwrap();
        let rejected = store.add_paths(&[extra]);
        assert_eq!(rejected[0].status, AddStatus::Rejected);
        assert_eq!(store.list().items.len(), MAX_ITEMS);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn directory_cap_rejects_the_31st() {
        let root = scratch("dircap");
        let store = ShelfStore::open(root.join("app"));
        for index in 0..MAX_ITEMS {
            let dir = root.join(format!("d{index}"));
            fs::create_dir_all(&dir).unwrap();
            assert_eq!(store.add_paths(&[dir])[0].status, AddStatus::Added);
        }
        let overflow = root.join("overflow-dir");
        fs::create_dir_all(&overflow).unwrap();
        let rejected = store.add_paths(&[overflow]);
        assert_eq!(rejected[0].status, AddStatus::Rejected);
        assert_eq!(rejected[0].message.as_deref(), Some("暂存架已有 30 个文件"));
        assert_eq!(store.list().items.len(), MAX_ITEMS);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reorder_persists_and_rejects_a_stale_list() {
        let root = scratch("order");
        let store = ShelfStore::open(root.join("app"));
        let mut ids = Vec::new();
        for name in ["a.txt", "b.txt", "c.txt"] {
            let file = root.join(name);
            fs::write(&file, b"x").unwrap();
            ids.push(store.add_paths(&[file])[0].id.clone().unwrap());
        }
        // 新条目在最上面：加入顺序是 a,b,c，清单顺序就是 c,b,a。
        assert_eq!(
            store.list().items.iter().map(|item| item.id.clone()).collect::<Vec<_>>(),
            vec![ids[2].clone(), ids[1].clone(), ids[0].clone()]
        );
        let desired = vec![ids[0].clone(), ids[2].clone(), ids[1].clone()];
        store.reorder(&desired).unwrap();
        assert_eq!(
            store.list().items.iter().map(|item| item.id.clone()).collect::<Vec<_>>(),
            desired
        );
        // 顺序随清单落盘，重新打开后仍然是这个顺序。
        let reopened = ShelfStore::open(root.join("app"));
        assert_eq!(
            reopened.list().items.iter().map(|item| item.id.clone()).collect::<Vec<_>>(),
            desired
        );
        // 重复 id 或数量对不上的过期顺序整次拒绝，现有顺序不变。
        assert!(reopened
            .reorder(&[ids[0].clone(), ids[0].clone(), ids[1].clone()])
            .is_err());
        assert!(reopened.reorder(&[ids[0].clone()]).is_err());
        assert_eq!(
            reopened.list().items.iter().map(|item| item.id.clone()).collect::<Vec<_>>(),
            desired
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn removing_a_reference_leaves_the_source() {
        let root = scratch("rmref");
        let store = ShelfStore::open(root.join("app"));
        let file = root.join("keep.txt");
        fs::write(&file, b"x").unwrap();
        let id = store.add_paths(&[file.clone()])[0].id.clone().unwrap();
        store.remove(&[id]).unwrap();
        assert!(file.exists());
        assert!(store.list().items.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn opening_a_removed_reference_is_rejected() {
        let root = scratch("open-missing");
        let store = ShelfStore::open(root.join("app"));
        assert!(store.open_item("missing").is_err());
        let file = root.join("gone.txt");
        fs::write(&file, b"x").unwrap();
        let id = store.add_paths(&[file.clone()])[0].id.clone().unwrap();
        fs::remove_file(&file).unwrap();
        let error = store.open_item(&id).unwrap_err();
        assert!(error.contains("找不到了"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn removing_owned_deletes_only_the_copy() {
        let root = scratch("rmown");
        let store = ShelfStore::open(root.join("app"));
        let outside = root.join("outside.png");
        fs::write(&outside, b"png").unwrap();
        let id = store.add_png(b"png-bytes", "截图.png").unwrap();
        let owned = store.list().items[0].path.clone();
        store.remove(&[id]).unwrap();
        assert!(!Path::new(&owned).exists());
        assert!(outside.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn oversized_volatile_file_is_not_stored_as_reference() {
        let root = scratch("big");
        let store = ShelfStore::open(root.join("app"));
        let source = std::env::temp_dir().join(format!("shelf-big-{}.bin", std::process::id()));
        let file = fs::File::create(&source).unwrap();
        file.set_len(MAX_OWNED_BYTES + 1).unwrap();
        let results = store.add_paths(&[source.clone()]);
        assert_eq!(results[0].status, AddStatus::Rejected);
        assert!(store.list().items.is_empty());
        let _ = fs::remove_file(&source);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bad_version_moves_the_manifest_aside() {
        let root = scratch("ver");
        let app = root.join("app");
        fs::create_dir_all(&app).unwrap();
        fs::write(app.join("shelf.json"), r#"{"version":9,"items":[]}"#).unwrap();
        let store = ShelfStore::open(app.clone());
        assert!(store.list().items.is_empty());
        assert!(store.list().notice.unwrap().contains("备份"));
        assert!(fs::read_dir(&app)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains("shelf.json.bak")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn hdrop_payload_is_wide_and_has_no_extended_prefix() {
        let bytes = drag_out::hdrop_bytes(&[PathBuf::from(r"\\?\D:\文档\报告.pdf")]);
        assert!(bytes.len() > 20);
        let wide = u32::from_le_bytes(bytes[16..20].try_into().unwrap());
        assert_eq!(wide, 1, "fWide 必须为 TRUE");
        let text = String::from_utf16_lossy(
            &bytes[20..]
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>(),
        );
        assert!(text.contains("报告.pdf"));
        assert!(!text.contains(r"\\?\"));
    }

    #[test]
    fn preferred_drop_effect_is_copy_only() {
        assert_eq!(drag_out::PREFERRED_DROP_EFFECT, 1);
    }

    #[test]
    fn drag_of_more_than_twenty_fails_as_a_whole() {
        let root = scratch("dragcap");
        let store = ShelfStore::open(root.join("app"));
        let mut ids = Vec::new();
        for index in 0..21 {
            let file = root.join(format!("d{index}.txt"));
            fs::write(&file, b"x").unwrap();
            ids.push(store.add_paths(&[file])[0].id.clone().unwrap());
        }
        let error = store.paths_for_drag(&ids).unwrap_err();
        assert!(error.contains("20"));
        assert_eq!(store.list().items.len(), 21);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_drag_id_fails_the_whole_drag() {
        let root = scratch("dragmiss");
        let store = ShelfStore::open(root.join("app"));
        let file = root.join("one.txt");
        fs::write(&file, b"x").unwrap();
        let id = store.add_paths(&[file])[0].id.clone().unwrap();
        let error = store
            .paths_for_drag(&[id, "missing".into()])
            .unwrap_err();
        assert!(error.contains("找不到"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_owned_copy_does_not_block_a_reused_temp_name() {
        let root = scratch("stale");
        let store = ShelfStore::open(root.join("app"));
        let source = std::env::temp_dir().join(format!("shelf-reuse-{}.txt", std::process::id()));
        fs::write(&source, b"a").unwrap();
        assert_eq!(store.add_paths(&[source.clone()])[0].status, AddStatus::Added);
        let owned = store.list().items[0].path.clone();
        fs::remove_file(&owned).unwrap();
        fs::write(&source, b"b").unwrap();
        let second = store.add_paths(&[source.clone()]);
        assert_eq!(second[0].status, AddStatus::Added);
        assert_eq!(store.list().items.len(), 2);
        let _ = fs::remove_file(&source);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn junction_files_dir_refuses_delete() {
        let root = scratch("junction");
        let real = root.join("real");
        let link = root.join("app").join("shelf").join("files");
        fs::create_dir_all(&real).unwrap();
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        let sentinel = real.join("sentinel.txt");
        fs::write(&sentinel, b"keep").unwrap();
        let made = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !made {
            let _ = fs::remove_dir_all(&root);
            return;
        }
        let store = ShelfStore::open(root.join("app"));
        // 直接塞一条 owned，绕过加入规则，模拟清单被改过。
        {
            let mut data = store.lock();
            data.items.push(ShelfItem {
                id: "shelf-x".into(),
                kind: ShelfKind::Owned,
                name: "sentinel.txt".into(),
                path: link.join("sentinel.txt").display().to_string(),
                source_path: None,
                is_dir: false,
                size: Some(4),
                added_at: Utc::now().to_rfc3339(),
            });
        }
        let error = store.remove(&["shelf-x".into()]).unwrap_err();
        assert!(error.contains("重定向"));
        assert!(sentinel.exists());
        let _ = fs::remove_dir(&link);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn junction_files_dir_refuses_copy() {
        let root = scratch("junction-copy");
        let real = root.join("real");
        let link = root.join("app").join("shelf").join("files");
        fs::create_dir_all(&real).unwrap();
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        let sentinel = real.join("sentinel.txt");
        fs::write(&sentinel, b"keep").unwrap();
        let made = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !made {
            let _ = fs::remove_dir_all(&root);
            return;
        }
        let store = ShelfStore::open(root.join("app"));
        let source = std::env::temp_dir().join(format!("shelf-junction-{}.txt", std::process::id()));
        fs::write(&source, b"temp").unwrap();
        let results = store.add_paths(&[source.clone()]);
        assert_eq!(results[0].status, AddStatus::Rejected);
        assert!(results[0].message.as_deref().unwrap_or("").contains("重定向"));
        let names: Vec<_> = fs::read_dir(&real)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("sentinel.txt")]);
        let _ = fs::remove_file(&source);
        let _ = fs::remove_dir(&link);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn later_unsafe_path_does_not_delete_the_earlier_copy() {
        let root = scratch("partial-delete");
        let store = ShelfStore::open(root.join("app"));
        let files = root.join("app").join("shelf").join("files");
        let good = files.join("good.txt");
        fs::write(&good, b"keep").unwrap();
        let outside = root.join("outside.txt");
        fs::write(&outside, b"no").unwrap();
        {
            let mut data = store.lock();
            data.items.push(ShelfItem {
                id: "good".into(),
                kind: ShelfKind::Owned,
                name: "good.txt".into(),
                path: good.display().to_string(),
                source_path: None,
                is_dir: false,
                size: Some(4),
                added_at: Utc::now().to_rfc3339(),
            });
            data.items.push(ShelfItem {
                id: "bad".into(),
                kind: ShelfKind::Owned,
                name: "outside.txt".into(),
                path: outside.display().to_string(),
                source_path: None,
                is_dir: false,
                size: Some(2),
                added_at: Utc::now().to_rfc3339(),
            });
        }
        let error = store.remove(&["good".into(), "bad".into()]).unwrap_err();
        assert!(error.contains("不在暂存目录"));
        assert!(good.exists());
        assert!(outside.exists());
        assert_eq!(store.list().items.len(), 2);
        let _ = fs::remove_dir_all(&root);
    }
}
