use std::path::Path;

use windows::core::PCWSTR;
use windows::Win32::Foundation::GetLastError;
use windows::Win32::Storage::FileSystem::{
    GetFileAttributesW, GetFullPathNameW, FILE_ATTRIBUTE_REPARSE_POINT, INVALID_FILE_ATTRIBUTES,
};

use super::ShelfItem;

/// `shelf/files` 自己或任一祖先是 junction / 符号链接时，整次删除作废。
pub fn files_dir_is_reparse(files_dir: &Path) -> Result<bool, String> {
    for ancestor in files_dir.ancestors() {
        if ancestor.parent().is_none() {
            continue;
        }
        if is_reparse(ancestor)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 复制前确认 `shelf/files` 不是 junction / 符号链接，也不会建在被重定向的目录里。
/// 先检查再创建：父目录已经是 junction 时不能先 `create_dir_all`，否则空目录会落进目标里。
pub fn ensure_storage_writable(files_dir: &Path) -> Result<(), String> {
    if files_dir_is_reparse(files_dir)? {
        return Err("暂存目录被重定向，已停止复制".to_string());
    }
    std::fs::create_dir_all(files_dir).map_err(|error| format!("复制失败：{error}"))?;
    if files_dir_is_reparse(files_dir)? {
        return Err("暂存目录被重定向，已停止复制".to_string());
    }
    Ok(())
}

/// 删除前的检查。重解析点要在 `exists()` 之前看：`exists()` 会跟着链接走，
/// 目标已经不在的 junction 会被当成「文件没了」，清单删掉，链接还留着。
pub fn validate_owned_delete(files_dir: &Path, item: &ShelfItem) -> Result<(), String> {
    let path = Path::new(&item.path);
    if is_reparse(path)? || files_dir_is_reparse(files_dir)? {
        return Err("暂存目录被重定向，已停止删除".to_string());
    }
    if !path.exists() {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "副本不在暂存目录里，已停止删除".to_string())?;
    if normalize(parent)? != normalize(files_dir)? {
        return Err("副本不在暂存目录里，已停止删除".to_string());
    }
    Ok(())
}

/// 只删除 `files_dir` 正下方的那一个文件。文件已经不在时视为成功，清单仍可去掉这一项。
pub fn delete_owned_file(files_dir: &Path, item: &ShelfItem) -> Result<(), String> {
    validate_owned_delete(files_dir, item)?;
    let path = Path::new(&item.path);
    if !path.exists() {
        return Ok(());
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除副本失败：{error}")),
    }
}

fn is_reparse(path: &Path) -> Result<bool, String> {
    let wide = wide(path);
    let attrs = unsafe { GetFileAttributesW(PCWSTR(wide.as_ptr())) };
    if attrs == INVALID_FILE_ATTRIBUTES {
        let code = unsafe { GetLastError() }.0;
        // 路径本身不存在，不是重解析点。祖先读不到则拒绝。
        if code == 2 || code == 3 {
            return Ok(false);
        }
        return Err(format!("无法确认路径是否被重定向（{code}）"));
    }
    Ok(attrs & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0)
}

fn normalize(path: &Path) -> Result<String, String> {
    let wide = wide(path);
    let mut buffer = vec![0u16; 1024];
    let written = unsafe { GetFullPathNameW(PCWSTR(wide.as_ptr()), Some(&mut buffer), None) };
    if written == 0 {
        return Err("无法确认副本位置".to_string());
    }
    if written as usize >= buffer.len() {
        buffer.resize(written as usize + 1, 0);
        let written = unsafe { GetFullPathNameW(PCWSTR(wide.as_ptr()), Some(&mut buffer), None) };
        if written == 0 {
            return Err("无法确认副本位置".to_string());
        }
    }
    let end = buffer.iter().position(|unit| *unit == 0).unwrap_or(buffer.len());
    let text = String::from_utf16_lossy(&buffer[..end]);
    Ok(super::add::strip_extended_prefix(&text).to_lowercase())
}

fn wide(path: &Path) -> Vec<u16> {
    path.to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}
