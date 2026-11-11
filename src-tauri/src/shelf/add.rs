use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;

use super::{
    next_id, owned_usage, unique_display_name, AddResult, AddStatus, ShelfItem, ShelfKind,
    MAX_ITEMS, MAX_OWNED_BYTES, MAX_SHELF_BYTES,
};

pub struct Ingested {
    pub result: AddResult,
    pub created: Option<PathBuf>,
}

pub fn ingest_one(data: &mut super::ShelfData, files_dir: &Path, raw: &Path) -> Ingested {
    let display = raw.display().to_string();
    let reject = |message: String| Ingested {
        result: AddResult {
            path: display.clone(),
            status: AddStatus::Rejected,
            message: Some(message),
            id: None,
        },
        created: None,
    };

    let meta = match fs::metadata(raw) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return reject("找不到文件".to_string());
        }
        Err(error) if is_access_denied(&error) => {
            return reject("没有读取权限".to_string());
        }
        Err(_) => return reject("找不到文件".to_string()),
    };

    let canonical = fs::canonicalize(raw).unwrap_or_else(|_| raw.to_path_buf());
    let volatile = is_volatile(&canonical);
    if meta.is_dir() {
        if volatile {
            return reject("临时文件夹不能暂存，请改拖里面的文件".to_string());
        }
        // 文件夹同样占一个名额，上限检查不能只放在下面的文件分支里。
        if data.items.len() >= MAX_ITEMS {
            return reject("暂存架已有 30 个文件".to_string());
        }
        return remember_reference(data, &canonical, true, None);
    }

    let topped = matching_item(data, &canonical).and_then(|existing| {
        let still_there =
            existing.kind == ShelfKind::Reference || Path::new(&existing.path).exists();
        still_there.then(|| existing.id.clone())
    });
    if let Some(id) = topped {
        move_to_front(data, &id);
        return Ingested {
            result: AddResult {
                path: display,
                status: AddStatus::Topped,
                message: None,
                id: Some(id),
            },
            created: None,
        };
    }

    if data.items.len() >= MAX_ITEMS {
        return reject("暂存架已有 30 个文件".to_string());
    }

    if volatile {
        if let Err(error) = super::delete::ensure_storage_writable(files_dir) {
            return reject(error);
        }
        if meta.len() > MAX_OWNED_BYTES {
            return reject("文件过大，暂存架不复制".to_string());
        }
        let usage = match owned_usage(files_dir) {
            Ok(usage) => usage,
            Err(error) => return reject(error),
        };
        if usage.saturating_add(meta.len()) > MAX_SHELF_BYTES {
            return reject("暂存架已满".to_string());
        }
        return copy_owned(data, files_dir, raw, &canonical, meta.len());
    }

    remember_reference(data, &canonical, false, Some(meta.len()))
}

pub fn is_volatile(path: &Path) -> bool {
    let key = path_key(path);
    if key.contains(r"\inetcache\")
        || key.contains(r"\content.outlook\")
        || key.contains(r"\temporary internet files\")
    {
        return true;
    }
    // GetTempPath 有时给出 8.3 短路径，canonicalize 则是长路径。两边都要比，
    // 否则 `\\?\` 形式的临时文件会被当成稳定路径，只记引用、不复制。
    let mut bases = vec![path_key(&std::env::temp_dir())];
    if let Ok(canonical) = fs::canonicalize(std::env::temp_dir()) {
        bases.push(path_key(&canonical));
    }
    bases.into_iter().any(|base| {
        let mut prefix = base;
        if !prefix.ends_with('\\') {
            prefix.push('\\');
        }
        key == prefix.trim_end_matches('\\') || key.starts_with(&prefix)
    })
}

pub(crate) fn path_key(path: &Path) -> String {
    strip_extended_prefix(&path.to_string_lossy().replace('/', "\\")).to_lowercase()
}

pub(crate) fn strip_extended_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

fn matching_item<'a>(data: &'a super::ShelfData, path: &Path) -> Option<&'a ShelfItem> {
    let key = path_key(path);
    data.items.iter().find(|item| {
        let stored = if item.kind == ShelfKind::Owned {
            item.source_path.as_deref().unwrap_or("")
        } else {
            item.path.as_str()
        };
        !stored.is_empty() && path_key(Path::new(stored)) == key
    })
}

fn move_to_front(data: &mut super::ShelfData, id: &str) {
    if let Some(index) = data.items.iter().position(|item| item.id == id) {
        let item = data.items.remove(index);
        data.items.insert(0, item);
    }
}

fn remember_reference(
    data: &mut super::ShelfData,
    path: &Path,
    is_dir: bool,
    size: Option<u64>,
) -> Ingested {
    let shown = strip_extended_prefix(&path.to_string_lossy());
    let name = Path::new(&shown)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("未命名")
        .to_string();
    let name = unique_display_name(&data.items, &name);
    let id = next_id(&mut data.next_seq);
    data.items.insert(
        0,
        ShelfItem {
            id: id.clone(),
            kind: ShelfKind::Reference,
            name,
            path: shown.clone(),
            source_path: None,
            is_dir,
            size,
            added_at: Utc::now().to_rfc3339(),
        },
    );
    Ingested {
        result: AddResult {
            path: shown,
            status: AddStatus::Added,
            message: None,
            id: Some(id),
        },
        created: None,
    }
}

fn copy_owned(
    data: &mut super::ShelfData,
    files_dir: &Path,
    source: &Path,
    canonical: &Path,
    size: u64,
) -> Ingested {
    let shown_source = strip_extended_prefix(&canonical.to_string_lossy());
    let display = source.display().to_string();
    let reject = |message: String| Ingested {
        result: AddResult {
            path: display.clone(),
            status: AddStatus::Rejected,
            message: Some(message),
            id: None,
        },
        created: None,
    };
    if let Err(error) = super::delete::ensure_storage_writable(files_dir) {
        return reject(error);
    }
    let id = next_id(&mut data.next_seq);
    let ext = owned_extension(source);
    let dest = files_dir.join(format!("{id}.{ext}"));
    let partial = files_dir.join(format!(".{id}.partial"));
    if let Err(error) = fs::copy(source, &partial) {
        let _ = fs::remove_file(&partial);
        let message = if is_access_denied(&error) {
            "没有读取权限".to_string()
        } else {
            format!("复制失败：{error}")
        };
        return reject(message);
    }
    if let Err(error) = fs::rename(&partial, &dest) {
        let _ = fs::remove_file(&partial);
        return reject(format!("复制失败：{error}"));
    }
    let file_name = Path::new(&shown_source)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("未命名");
    let name = unique_display_name(&data.items, file_name);
    data.items.insert(
        0,
        ShelfItem {
            id: id.clone(),
            kind: ShelfKind::Owned,
            name,
            path: strip_extended_prefix(&dest.to_string_lossy()),
            source_path: Some(shown_source),
            is_dir: false,
            size: Some(size),
            added_at: Utc::now().to_rfc3339(),
        },
    );
    Ingested {
        result: AddResult {
            path: display,
            status: AddStatus::Added,
            message: None,
            id: Some(id),
        },
        created: Some(dest),
    }
}

fn owned_extension(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("");
    if !ext.is_empty()
        && ext.len() <= 8
        && ext.chars().all(|ch| ch.is_ascii_alphanumeric())
    {
        ext.to_ascii_lowercase()
    } else {
        "bin".to_string()
    }
}

fn is_access_denied(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::PermissionDenied || error.raw_os_error() == Some(5)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_gib_budget_is_the_owned_cap() {
        assert_eq!(MAX_SHELF_BYTES, 2 * 1024 * 1024 * 1024);
        assert!(MAX_SHELF_BYTES - 10 + 11 > MAX_SHELF_BYTES);
        assert!(MAX_OWNED_BYTES < MAX_SHELF_BYTES);
    }

    #[test]
    fn outlook_cache_is_volatile_regardless_of_case_and_prefix() {
        let path = PathBuf::from(r"\\?\C:\Users\Me\AppData\Local\Microsoft\Windows\INetCache\Content.Outlook\abc\x.png");
        assert!(is_volatile(&path));
    }
}
