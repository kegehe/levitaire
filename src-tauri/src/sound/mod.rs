//! 系统提示音：播放低调的纯提示音，供番茄钟到点等场景提醒。
//!
//! 不依赖系统声音方案（MessageBeep 可能被静音），也不像 TTS 那样需要合成语音，
//! 用代码合成一段简短的双音"叮咚"（正弦波 + 半正弦包络），经 WinRT MediaPlayer
//! 播放内存 WAV。音量克制、时长短，适合"只需安静提醒"的场景。
//!
//! COM 环境与 tts 模块一致：播放线程内 CoInitializeEx(MTA)，避免 STA 上
//! WinRT 调用死锁/失败。播放为异步（Play 立即返回），线程在提示音播完前
//! sleep 保持存活，避免 player Drop 提前截断声音。

use std::time::Duration;

use windows::Media::Core::MediaSource;
use windows::Media::Playback::MediaPlayer;
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

/// WAV 采样率。44100 Hz 16bit mono。
const SAMPLE_RATE: u32 = 44_100;

/// 播放纯提示音。自开 MTA 线程异步播放，不阻塞调用方。
/// 播放失败不打断主流程（提示音属非关键提醒），仅记录日志便于排查。
pub fn play_tone() {
    std::thread::spawn(|| {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        if let Err(e) = play_inner() {
            crate::utils::logger::log("sound", &format!("播放提示音失败: {}", e));
        }
        unsafe {
            CoUninitialize();
        }
    });
}

fn play_inner() -> Result<(), String> {
    let wav = synth_tone_wav();
    // 内存随机访问流：写入 WAV 字节后作为 MediaSource 音频源
    let stream = InMemoryRandomAccessStream::new().map_err(|e| format!("创建内存流: {:?}", e))?;
    let output = stream
        .GetOutputStreamAt(0)
        .map_err(|e| format!("获取输出流: {:?}", e))?;
    let writer =
        DataWriter::CreateDataWriter(&output).map_err(|e| format!("创建 DataWriter: {:?}", e))?;
    writer
        .WriteBytes(&wav)
        .map_err(|e| format!("写入 WAV: {:?}", e))?;
    writer
        .StoreAsync()
        .map_err(|e| format!("StoreAsync: {:?}", e))?
        .get()
        .map_err(|e| format!("等待写入: {:?}", e))?;
    writer
        .FlushAsync()
        .map_err(|e| format!("FlushAsync: {:?}", e))?
        .get()
        .map_err(|e| format!("等待刷新: {:?}", e))?;
    // 写完后流位置在末尾，Seek 回开头供播放器读取
    stream.Seek(0).map_err(|e| format!("Seek: {:?}", e))?;

    let source = MediaSource::CreateFromStream(&stream, &windows::core::HSTRING::from("audio/wav"))
        .map_err(|e| format!("创建 MediaSource: {:?}", e))?;
    let player = MediaPlayer::new().map_err(|e| format!("创建 MediaPlayer: {:?}", e))?;
    // 提示音音量克制（0.6），避免打扰
    let _ = player.SetVolume(0.6);
    player
        .SetSource(&source)
        .map_err(|e| format!("SetSource: {:?}", e))?;
    player.Play().map_err(|e| format!("Play: {:?}", e))?;

    // 播放异步：保持线程存活直到声音播完，再释放 player 与流。
    // sleep 略长于提示音总时长（两段共约 0.3s），保证不截断。
    std::thread::sleep(Duration::from_millis(600));
    Ok(())
}

/// 合成双音"叮咚"WAV：880Hz（A5）+ 1174.66Hz（D6），各约 0.15s。
/// 每段使用半正弦包络淡入淡出，避免起止爆音；振幅 0.4 保持低调。
fn synth_tone_wav() -> Vec<u8> {
    let segments: [(f32, f32); 2] = [(880.0, 0.15), (1174.66, 0.15)];
    let mut pcm: Vec<i16> = Vec::new();
    for &(freq, dur) in &segments {
        let n = (SAMPLE_RATE as f32 * dur) as usize;
        for i in 0..n {
            let t = i as f32 / SAMPLE_RATE as f32;
            // 半正弦包络：首尾趋 0，无爆音
            let envelope = ((i as f32 / n as f32) * std::f32::consts::PI).sin();
            let sample = (t * 2.0 * std::f32::consts::PI * freq).sin() * envelope * 0.4;
            pcm.push((sample * i16::MAX as f32) as i16);
        }
    }
    // WAV header（44 字节，PCM 单声道 16bit）+ PCM 数据
    let data_len = (pcm.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + pcm.len() * 2);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // 单声道
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // 字节率（16bit 单声道 = 采样率*2）
    wav.extend_from_slice(&2u16.to_le_bytes()); // 块对齐
    wav.extend_from_slice(&16u16.to_le_bytes()); // 位深
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for s in pcm {
        wav.extend_from_slice(&s.to_le_bytes());
    }
    wav
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 合成 WAV 结构正确：RIFF/WAVE 头、PCM 单声道 16bit、data 块长度与内容一致
    #[test]
    fn synth_tone_wav_header_is_valid_pcm() {
        let wav = synth_tone_wav();
        assert!(wav.len() > 44);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1); // PCM
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1); // 单声道
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            SAMPLE_RATE
        );
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16); // 位深
        assert_eq!(&wav[36..40], b"data");
        let data_len = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]) as usize;
        assert_eq!(data_len, wav.len() - 44);
        assert!(data_len > 0);
    }

    /// 两段音调共约 0.3s（44100Hz * 0.3 * 2 字节）——与播放端 sleep 余量匹配
    #[test]
    fn synth_tone_wav_duration_matches_segments() {
        let wav = synth_tone_wav();
        let data_len = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]) as usize;
        let sample_count = data_len / 2;
        // 两段 0.15s：44100 * 0.3 = 13230 个采样
        assert_eq!(sample_count, (SAMPLE_RATE as usize * 3) / 10);
    }
}
