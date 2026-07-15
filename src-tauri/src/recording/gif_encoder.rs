//! GIF 编码器：BGRA 帧序列 → 流式 GIF 编码。
//! 使用 image crate 的 GifEncoder + NeuQuant 颜色量化。

use std::io::Cursor;

/// 将 BGRA 帧序列编码为 GIF 字节（一次性编码，适用于帧数较少的场景）。
/// fps: 录制帧率，用于计算帧间延迟。
#[allow(dead_code)]
pub fn encode_gif(
    frames: &[Vec<u8>],
    width: u32,
    height: u32,
    fps: u32,
) -> Result<Vec<u8>, String> {
    let mut buf = Cursor::new(Vec::new());
    {
        let mut encoder = image::codecs::gif::GifEncoder::new_with_speed(&mut buf, 10); // speed=10, fast

        encoder
            .set_repeat(image::codecs::gif::Repeat::Infinite)
            .map_err(|e| format!("设置 GIF 循环失败: {}", e))?;

        let frame_delay_ms = 1000u32 / fps;

        for (i, bgra_frame) in frames.iter().enumerate() {
            let rgba = bgra_to_rgba(bgra_frame);
            let img = image::RgbaImage::from_raw(width, height, rgba)
                .ok_or_else(|| format!("第 {} 帧构造 RgbaImage 失败", i))?;

            // image crate 内置 NeuQuant 调色板量化
            let delay = image::Delay::from_numer_denom_ms(frame_delay_ms, 1);
            let frame = image::Frame::from_parts(img, 0, 0, delay);

            encoder
                .encode_frame(frame)
                .map_err(|e| format!("编码第 {} 帧失败: {}", i, e))?;
        }
    }

    Ok(buf.into_inner())
}

/// BGRA → RGBA 转换
fn bgra_to_rgba(bgra: &[u8]) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(bgra.len());
    for chunk in bgra.chunks_exact(4) {
        rgba.push(chunk[2]); // R
        rgba.push(chunk[1]); // G
        rgba.push(chunk[0]); // B
        rgba.push(chunk[3]); // A
    }
    rgba
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_gif_single_frame() {
        // 2x2 红色 BGRA 帧
        let bgra = vec![0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255];
        let result = encode_gif(&[bgra], 2, 2, 10);
        assert!(result.is_ok());
        let gif_bytes = result.unwrap();
        // GIF magic number: 47 49 46 38
        assert_eq!(&gif_bytes[0..3], b"GIF");
        assert!(!gif_bytes.is_empty());
    }

    #[test]
    fn test_encode_gif_multi_frame() {
        let bgra_red = vec![0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255];
        let bgra_blue = vec![255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255];
        let result = encode_gif(&[bgra_red, bgra_blue], 2, 2, 10);
        assert!(result.is_ok());
        let gif_bytes = result.unwrap();
        assert!(gif_bytes.len() > 20); // 多帧 GIF 应大于单帧
    }

    #[test]
    fn test_bgra_to_rgba() {
        let bgra = vec![1, 2, 3, 4]; // B=1, G=2, R=3, A=4
        let rgba = bgra_to_rgba(&bgra);
        assert_eq!(rgba, vec![3, 2, 1, 4]); // R=3, G=2, B=1, A=4
    }
}
