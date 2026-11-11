use std::path::PathBuf;

use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder};
use windows::Win32::Foundation::{HGLOBAL, HANDLE};
use windows::Win32::Graphics::Gdi::{BITMAPINFOHEADER, BI_RGB};
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, OpenClipboard, RegisterClipboardFormatW,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

use super::{AddResult, AddStatus, ShelfStore, MAX_OWNED_BYTES};

const CF_HDROP: u32 = 15;
const CF_DIB: u32 = 8;
const MAX_PIXELS: u64 = 25_000_000;

pub fn paste_clipboard(store: &ShelfStore) -> Result<Vec<AddResult>, String> {
    unsafe {
        OpenClipboard(None).map_err(|_| "剪贴板正被占用".to_string())?;
        let files = read_hdrop();
        let image = if files.is_empty() { read_image() } else { None };
        let _ = CloseClipboard();
        if !files.is_empty() {
            return Ok(store.add_paths(&files));
        }
        if let Some(png) = image {
            let id = store.add_png(&png, "截图.png")?;
            return Ok(vec![AddResult {
                path: String::new(),
                status: AddStatus::Added,
                message: None,
                id: Some(id),
            }]);
        }
        Err("剪贴板里没有文件或图片".to_string())
    }
}

unsafe fn read_hdrop() -> Vec<PathBuf> {
    let Ok(handle) = GetClipboardData(CF_HDROP) else {
        return Vec::new();
    };
    if handle.is_invalid() {
        return Vec::new();
    }
    let hdrop = HDROP(handle.0);
    let count = DragQueryFileW(hdrop, u32::MAX, None);
    let mut paths = Vec::with_capacity(count as usize);
    for index in 0..count {
        let len = DragQueryFileW(hdrop, index, None) as usize;
        let mut buffer = vec![0u16; len + 1];
        let written = DragQueryFileW(hdrop, index, Some(&mut buffer)) as usize;
        let end = written.min(buffer.len());
        let text = String::from_utf16_lossy(&buffer[..end]);
        let text = text.trim_end_matches('\0');
        if !text.is_empty() {
            paths.push(PathBuf::from(text));
        }
    }
    paths
}

unsafe fn read_image() -> Option<Vec<u8>> {
    if let Some(png) = read_png_format() {
        return Some(png);
    }
    read_dib()
}

unsafe fn read_png_format() -> Option<Vec<u8>> {
    let format = RegisterClipboardFormatW(windows::core::w!("PNG"));
    if format == 0 {
        return None;
    }
    let handle = GetClipboardData(format).ok()?;
    copy_global(handle).filter(|bytes| !bytes.is_empty() && bytes.len() as u64 <= MAX_OWNED_BYTES)
}

unsafe fn read_dib() -> Option<Vec<u8>> {
    let handle = GetClipboardData(CF_DIB).ok()?;
    let bytes = copy_global(handle)?;
    if bytes.len() < std::mem::size_of::<BITMAPINFOHEADER>() || bytes.len() as u64 > MAX_OWNED_BYTES {
        return None;
    }
    let header = &*(bytes.as_ptr() as *const BITMAPINFOHEADER);
    if header.biCompression != BI_RGB.0 || header.biWidth <= 0 {
        return None;
    }
    let bit_count = header.biBitCount;
    if bit_count != 24 && bit_count != 32 {
        return None;
    }
    let top_down = header.biHeight < 0;
    let height = header.biHeight.unsigned_abs();
    let width = header.biWidth as u32;
    if width == 0 || height == 0 {
        return None;
    }
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return None;
    }
    let header_bytes = header.biSize as usize;
    if header_bytes >= bytes.len() {
        return None;
    }
    let stride = (((u64::from(width) * u64::from(bit_count) + 31) / 32) * 4) as usize;
    let pixels = &bytes[header_bytes..];
    if stride == 0 || pixels.len() < stride.saturating_mul(height as usize) {
        return None;
    }
    let mut rgba = vec![0u8; width as usize * height as usize * 4];
    for row in 0..height as usize {
        let src_row = if top_down { row } else { height as usize - 1 - row };
        let src = &pixels[src_row * stride..src_row * stride + stride];
        for col in 0..width as usize {
            let dest = (row * width as usize + col) * 4;
            if bit_count == 32 {
                rgba[dest] = src[col * 4 + 2];
                rgba[dest + 1] = src[col * 4 + 1];
                rgba[dest + 2] = src[col * 4];
                rgba[dest + 3] = 255;
            } else {
                rgba[dest] = src[col * 3 + 2];
                rgba[dest + 1] = src[col * 3 + 1];
                rgba[dest + 2] = src[col * 3];
                rgba[dest + 3] = 255;
            }
        }
    }
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(&rgba, width, height, ExtendedColorType::Rgba8)
        .ok()?;
    Some(png)
}

unsafe fn copy_global(handle: HANDLE) -> Option<Vec<u8>> {
    if handle.is_invalid() {
        return None;
    }
    let memory = HGLOBAL(handle.0);
    let size = GlobalSize(memory);
    if size == 0 || size as u64 > MAX_OWNED_BYTES {
        return None;
    }
    let ptr = GlobalLock(memory);
    if ptr.is_null() {
        return None;
    }
    let bytes = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
    let _ = GlobalUnlock(memory);
    Some(bytes)
}
