//! 暂存架条目的预览缩略图。
//!
//! 图片：`image` 解码后缩到最长边 320，JPEG 压成 data URL。
//! 视频：Windows Shell 的 `IShellItemImageFactory::GetImage`（资源管理器同款缩略图，
//! 编解码器缺失时 THUMBNAILONLY 会失败，上层回落到类型渐变兜底）。
//! 结果是 data URL，直接塞进 `<img src>`，不经 asset protocol、不暴露文件路径。

use std::os::windows::ffi::OsStrExt as _;
use std::path::Path;

use base64::Engine as _;
use image::GenericImageView as _;

const THUMB_MAX: u32 = 320;
const JPEG_QUALITY: u8 = 82;
/// 解码前的像素数上限（约 80MP / 320MB RGBA）。超大图直接拒绝，
/// 避免为一个缩略图把内存顶上几个 GB（回落到类型渐变即可）。
const MAX_DECODE_PIXELS: u64 = 80_000_000;
/// Shell 返回位图的像素数上限（16MP ≈ 64MB BGRA）。只挡异常尺寸，不影响正常缩略图。
const MAX_THUMB_SOURCE_PIXELS: u64 = 16_000_000;

/// 按扩展名分类可出缩略图的媒体。返回 "image" / "video"，其余 None。
pub(crate) fn media_kind(name: &str) -> Option<&'static str> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "ico" | "avif" => {
            Some("image")
        }
        "mp4" | "mkv" | "mov" | "avi" | "webm" | "m4v" | "wmv" | "flv" | "mpg" | "mpeg" | "ts"
        | "3gp" => Some("video"),
        _ => None,
    }
}

/// 生成条目缩略图 data URL。失败返回 Err，由调用方决定回落。
pub(crate) fn render_thumb(path: &Path, kind: &str) -> Result<String, String> {
    let rgba = match kind {
        "image" => image_thumb(path)?,
        "video" => video_thumb(path)?,
        _ => return Err("不是可出缩略图的类型".to_string()),
    };
    encode_jpeg_data_url(&rgba)
}

fn encode_jpeg_data_url(rgba: &image::RgbaImage) -> Result<String, String> {
    let flat = image::DynamicImage::ImageRgba8(rgba.clone()).to_rgb8();
    let mut out = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
    flat.write_with_encoder(encoder)
        .map_err(|error| format!("缩略图编码失败：{error}"))?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(out)
    ))
}

fn image_thumb(path: &Path) -> Result<image::RgbaImage, String> {
    // 先只读头部拿尺寸（不做全量解码），超限直接拒绝。
    let (width, height) = image::ImageReader::open(path)
        .map_err(|error| format!("打开文件失败：{error}"))?
        .into_dimensions()
        .map_err(|error| format!("图片解码失败：{error}"))?;
    if u64::from(width) * u64::from(height) > MAX_DECODE_PIXELS {
        return Err("图片过大，不生成缩略图".to_string());
    }
    let img = image::ImageReader::open(path)
        .map_err(|error| format!("打开文件失败：{error}"))?
        .decode()
        .map_err(|error| format!("图片解码失败：{error}"))?;
    let (width, height) = img.dimensions();
    let scaled = if width > THUMB_MAX || height > THUMB_MAX {
        img.thumbnail(THUMB_MAX, THUMB_MAX)
    } else {
        img
    };
    Ok(scaled.to_rgba8())
}

/// 视频封面：走资源管理器同款的 Shell 缩略图（系统装了对应编解码器就有画面）。
fn video_thumb(path: &Path) -> Result<image::RgbaImage, String> {
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, DIB_RGB_COLORS, HBITMAP,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::core::Interface as _;
    use windows::Win32::UI::Shell::{
        SHCreateItemFromParsingName, IShellItemImageFactory, SIIGBF_BIGGERSIZEOK,
        SIIGBF_THUMBNAILONLY,
    };

    // Shell 接口要求线程初始化过 COM；tokio 工作线程不一定初始化过，缺了就补 MTA。
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let hbitmap: HBITMAP = unsafe {
        let shell_item = SHCreateItemFromParsingName::<_, _, windows::Win32::UI::Shell::IShellItem>(
            windows::core::PCWSTR(wide.as_ptr()),
            None,
        )
        .map_err(|error| format!("Shell 打开失败：{error}"))?;
        let factory: IShellItemImageFactory = shell_item
            .cast()
            .map_err(|error| format!("缩略图接口不可用：{error}"))?;
        factory
            .GetImage(
                windows::Win32::Foundation::SIZE {
                    cx: THUMB_MAX as i32,
                    cy: THUMB_MAX as i32,
                },
                SIIGBF_BIGGERSIZEOK | SIIGBF_THUMBNAILONLY,
            )
            .map_err(|error| format!("视频封面提取失败：{error}"))?
    };

    unsafe {
        let mut bitmap = BITMAP::default();
        if GetObjectW(
            hbitmap.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bitmap as *mut BITMAP as *mut _),
        ) == 0
        {
            let _ = DeleteObject(hbitmap.into());
            return Err("读取位图信息失败".to_string());
        }
        let (width, height) = (bitmap.bmWidth as u32, bitmap.bmHeight.unsigned_abs());
        // Shell 一般按请求尺寸返回；SIIGBF_BIGGERSIZEOK 允许它给更大的缓存图。
        // 这里只做内存安全上限：一枚 320px 的缩略图不该出现 16MP 以上的位图，
        // 拿到异常尺寸就报错回落（调用方本来就会退到类型渐变）。
        if width == 0
            || height == 0
            || u64::from(width) * u64::from(height) > MAX_THUMB_SOURCE_PIXELS
        {
            let _ = DeleteObject(hbitmap.into());
            return Err("缩略图尺寸异常".to_string());
        }
        let hdc = GetDC(None);
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                // 负高度 = 自顶向下的行序，省一次上下翻转
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0, // BI_RGB
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
        let copied = GetDIBits(
            hdc,
            hbitmap,
            0,
            height,
            Some(pixels.as_mut_ptr().cast()),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        ReleaseDC(None, hdc);
        let _ = DeleteObject(hbitmap.into());
        if copied == 0 {
            return Err("读取位图像素失败".to_string());
        }
        // Shell 给的是 BGRA，翻成 RGBA
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }
        image::RgbaImage::from_raw(width, height, pixels)
            .ok_or_else(|| "位图像素长度不符".to_string())
    }
}
