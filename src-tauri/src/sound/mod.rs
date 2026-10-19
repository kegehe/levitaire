//! 提示音：代码合成简短音频，经 WinRT MediaPlayer 播放内存 WAV。
//!
//! 不依赖系统声音方案（MessageBeep 可能被静音），也不像 TTS 那样需要合成语音，
//! 用正弦波 + 半正弦包络合成极短音效。音量克制、时长短，适合"只需安静提醒"的场景。
//!
//! 两类调用方：
//! - `play_tone()`：番茄钟到点、待办提醒、倒计时结束的"叮咚"双音（保持原行为不变）；
//! - `play_cue(Cue)`：快速输入转盘的过程反馈（唤出 / 切扇区 / 确认 / 取消），
//!   音高与时长按语义区分，切扇区那种高频音效刻意做得更轻更短。
//!
//! COM 环境与 tts 模块一致：播放线程内 CoInitializeEx(MTA)，避免 STA 上
//! WinRT 调用死锁/失败。播放为异步（Play 立即返回），线程在提示音播完前
//! sleep 保持存活，避免 player Drop 提前截断声音。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use windows::Media::Core::MediaSource;
use windows::Media::Playback::MediaPlayer;
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

/// WAV 采样率。44100 Hz 16bit mono。
const SAMPLE_RATE: u32 = 44_100;

/// 默认播放音量（0.0-1.0）。番茄钟"叮咚"沿用 0.6，避免打扰。
const DEFAULT_VOLUME: f64 = 0.6;

/// 快速输入转盘的基准音量倍率：转盘会在鼠标划过的每个扇区上响一次，
/// 比一次性提醒音更频繁，因此整体压低到 0.45，避免连续"嗒嗒"声喧宾夺主。
/// 用户配置的音量百分比在此基础上再乘一次。
const CUE_VOLUME_BASE: f64 = 0.45;

/// 刻度音是否已在播放中（重入守卫）。
///
/// 快速甩动内圈时，每 13~21ms 就会换一个扇区，而刻度音本身长 35ms ——
/// 不加守卫会同时叠起十几个 MediaPlayer，听感是一片嘈杂的"嗡"而不是"咔咔"，
/// 每个都还占着一个线程 + 一份 COM 环境。
/// 有它在飞就直接丢弃这一次 —— 刻度音本就是"告诉你换了扇区"的提示，
/// 密集场景下保留其中一声即可，少响几声比叠音更接近刻度感。
///
/// **有效限流 ≈ 1 次 / 255ms（约 4 次/秒）**：守卫由播放线程持有，
/// 线程存活时长 = 音频时长 + 220ms 余量（见 `play_segments`）。
/// 想调密/调疏就调那个余量 —— 但不能小于「不掉尾」所需的余量。
/// 注意别只把守卫松开到音频时长（35ms）：那会变成首尾相接的连续音，
/// 听感是 1320Hz 的长鸣而不是刻度，反而更糟。
static TICK_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// 一段音：频率（Hz）、时长（秒）、相对振幅。
///
/// `freq == 0.0` 表示静音段，用于让两段音之间有干净的间隔（气声分隔），
/// 比"频率突变"听感更利落。
struct Segment {
    freq: f32,
    dur: f32,
    amp: f32,
}

/// 快速输入转盘的过程音效。
///
/// 设计约定：
/// - 唤出向上、取消向下、确认最高 —— 方向感即语义，不看屏幕也能分辨；
/// - 切扇区是最高频的一个（鼠标划一圈可能连响十几次），做成单段极短高音，
///   时长压到 35ms、振幅压到 0.5 倍，只当"咔哒"提示，不构成旋律；
/// - 全部音效总时长都 < 0.3s，不会盖住用户的下一个操作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cue {
    /// 转盘唤出：两段上行音，轻快的"起"
    Open,
    /// 扇区高亮变化：单段极短高音，当作刻度"咔"
    Tick,
    /// 确认输入：两段上行且音高更高，明确的"落定"
    Confirm,
    /// 取消 / 未选中退出：两段下行音，收束感
    Cancel,
}

impl Cue {
    /// 该音效的音频段落定义。
    fn segments(self) -> &'static [Segment] {
        match self {
            Cue::Open => &[
                Segment {
                    freq: 660.0,
                    dur: 0.045,
                    amp: 0.5,
                },
                Segment {
                    freq: 990.0,
                    dur: 0.055,
                    amp: 0.5,
                },
            ],
            Cue::Tick => &[Segment {
                freq: 1320.0,
                dur: 0.035,
                amp: 0.5,
            }],
            Cue::Confirm => &[
                Segment {
                    freq: 880.0,
                    dur: 0.05,
                    amp: 0.55,
                },
                Segment {
                    freq: 1318.51,
                    dur: 0.07,
                    amp: 0.55,
                },
            ],
            Cue::Cancel => &[
                Segment {
                    freq: 494.0,
                    dur: 0.05,
                    amp: 0.5,
                },
                Segment {
                    freq: 330.0,
                    dur: 0.07,
                    amp: 0.5,
                },
            ],
        }
    }

    /// 音频总时长（秒），用于决定播放线程要存活多久。
    #[cfg(test)]
    fn total_secs(self) -> f32 {
        segments_duration(self.segments())
    }
}

/// 番茄钟 / 待办提醒 / 倒计时结束的"叮咚"双音：两段等长上行，温和的提醒感。
const TONE_SEGMENTS: &[Segment] = &[
    Segment {
        freq: 880.0,
        dur: 0.15,
        amp: 0.4,
    },
    Segment {
        freq: 1174.66,
        dur: 0.15,
        amp: 0.4,
    },
];

/// 播放番茄钟/待办/倒计时的"叮咚"双音。自开 MTA 线程异步播放，不阻塞调用方。
/// 播放失败不打断主流程（提示音属非关键提醒），仅记录日志便于排查。
pub fn play_tone() {
    play_segments(TONE_SEGMENTS, DEFAULT_VOLUME, "提示音", false);
}

/// 播放快速输入转盘的过程音效。与 `play_tone` 一样异步、失败不影响主流程。
///
/// `volume` 为用户配置的音量（0.0-1.0），会再乘上转盘的基准音量 ——
/// 用户把音量拉到 100% 时听到的是「转盘的自然音量」，而不是把系统音量拉满。
///
/// ⚠️ 可能被钩子线程调用，因此这里**只做原子操作 + 起线程**：`compare_exchange`
/// 与 `thread::spawn` 都是微秒级。任何同步阻塞都会超出 LowLevelHooksTimeout。
pub fn play_cue(cue: Cue, volume: f64) {
    // 刻度音重入守卫：在飞就丢弃，避免快速划动时叠起多个播放实例。
    // 只有刻度音需要 —— 唤出/确认/取消都是用户单次动作触发的，本就稀疏。
    if cue == Cue::Tick && TICK_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return;
    }
    let effective = CUE_VOLUME_BASE * volume.clamp(0.0, 1.0);
    play_segments(cue.segments(), effective, "转盘音效", cue == Cue::Tick);
}

/// 试听专用：按与 `play_cue` 完全相同的音量算法播放，让设置页听到的就是真实音量。
///
/// 保留了这层薄封装，是为了让命令层（`preview_quick_input_sound`）与「试听」语义
/// 一一对应；将来试听若要差异化（例如忽略重入守卫、固定音量），改这里即可，
/// 不必去动转盘实际播放走的 `play_cue`。
pub fn play_cue_preview(cue: Cue, volume: f64) {
    play_cue(cue, volume);
}

/// 合成并播放若干段音。自开 MTA 线程，立即返回。
///
/// `is_tick` 为真时持有 `TICK_IN_FLIGHT` 守卫，播放线程结束才释放。
/// 释放必须用 **`Drop` guard** 而不是在末尾手写一句：`play_inner` 走的是 `?`
/// 早退路径，中途返回就会把守卫永久卡在 true ⇒ 刻度音从此再不响（且不自愈）。
///
/// `segments` 取 `&'static`（调用方给的都是常量表或 `Cue::segments()`），
/// 这样整段合成工作可以搬进播放线程，既不给钩子线程添活，也让守卫覆盖它。
fn play_segments(segments: &'static [Segment], volume: f64, label: &str, is_tick: bool) {
    // 守卫必须是本函数**第一件事**、并在 `.spawn(` 之前构造，再 move 进闭包。
    // 三种「拿不到播放线程」的路径都要靠它复位：
    // - `thread::spawn` 建线程失败会 panic ⇒ 闭包被丢弃 ⇒ 守卫析构复位。
    //   **若守卫写在闭包体内，这条路径上它从未被创建，`TICK_IN_FLIGHT` 会永久停在
    //   true、刻度音彻底哑掉且不自愈** —— 而建线程失败恰恰最容易发生在密集刻度音
    //   把线程刷爆的时候（正是守卫存在的理由）。
    // - WAV 合成/时长计算 panic（内存不足等）同理。
    // - 线程正常起来 ⇒ 守卫随闭包存活到播放结束才复位，正是要的「在飞」语义。
    let guard = tick_guard(is_tick);
    let label = label.to_string();
    std::thread::spawn(move || {
        // move 进来的守卫：闭包体跑完（或被丢弃）时析构复位
        let _tick_guard = guard;
        // 合成放进线程：纯计算，放在钩子线程上会白占 LowLevelHooksTimeout 预算
        let wav = synth_wav(segments);
        // 播放线程的存活时长略长于音频本身（+220ms 余量），避免 player Drop 提前截断。
        let keep_alive_ms = (segments_duration(segments) * 1000.0) as u64 + 220;
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        if let Err(e) = play_inner(&wav, volume, keep_alive_ms) {
            crate::utils::logger::log("sound", &format!("播放{}失败: {}", label, e));
        }
        unsafe {
            CoUninitialize();
        }
    });
}

/// 刻度音「在飞」标志的 `Drop` guard。
///
/// 用 guard 而非手写复位，是因为播放路径有多条早退分支（`?` 传播）。
/// 手写复位只要漏掉一条，`TICK_IN_FLIGHT` 就永久为 true，刻度音彻底哑掉。
/// 非刻度音返回 `None`（**不动那个标志**）。
///
/// ★ **不能写成 `is_tick.then_some(TickInFlightGuard)`。** `then_some` 是**按值**
/// 传参的：`is_tick` 为 false 时守卫已经被构造出来、又被丢弃，`Drop` 照常执行 →
/// `TICK_IN_FLIGHT.store(false)` —— **一次非刻度音（确认音、提示音）会把正在飞的那个
/// 刻度音的守卫清掉**，之后快速划动转盘刻度音就会叠放。`then(|| ...)` 才是惰性的。
fn tick_guard(is_tick: bool) -> Option<TickInFlightGuard> {
    if is_tick {
        Some(TickInFlightGuard)
    } else {
        None
    }
}

struct TickInFlightGuard;

impl Drop for TickInFlightGuard {
    fn drop(&mut self) {
        TICK_IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

/// 若干段音的总时长（秒）。
fn segments_duration(segments: &[Segment]) -> f32 {
    segments
        .iter()
        .map(|s| s.dur)
        .fold(0.0f32, |acc, d| acc + d)
}

/// 内存 WAV → MediaPlayer 播放。`keep_alive_ms` 为播放线程的存活时长。
fn play_inner(wav: &[u8], volume: f64, keep_alive_ms: u64) -> Result<(), String> {
    // 内存随机访问流：写入 WAV 字节后作为 MediaSource 音频源
    let stream = InMemoryRandomAccessStream::new().map_err(|e| format!("创建内存流: {:?}", e))?;
    let output = stream
        .GetOutputStreamAt(0)
        .map_err(|e| format!("获取输出流: {:?}", e))?;
    let writer =
        DataWriter::CreateDataWriter(&output).map_err(|e| format!("创建 DataWriter: {:?}", e))?;
    writer
        .WriteBytes(wav)
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
    let _ = player.SetVolume(volume.clamp(0.0, 1.0));
    player
        .SetSource(&source)
        .map_err(|e| format!("SetSource: {:?}", e))?;
    player.Play().map_err(|e| format!("Play: {:?}", e))?;

    // 播放异步：保持线程存活直到声音播完，再释放 player 与流。
    std::thread::sleep(Duration::from_millis(keep_alive_ms));
    Ok(())
}

/// 把音效段落合成为一段 PCM WAV。
/// 每段使用半正弦包络淡入淡出，避免起止爆音。
fn synth_wav(segments: &[Segment]) -> Vec<u8> {
    let mut pcm: Vec<i16> = Vec::new();
    for seg in segments {
        let n = (SAMPLE_RATE as f32 * seg.dur) as usize;
        if seg.freq <= 0.0 {
            // 静音段：直接补零，保留时长用于段间间隔
            pcm.extend(std::iter::repeat_n(0i16, n));
            continue;
        }
        for i in 0..n {
            let t = i as f32 / SAMPLE_RATE as f32;
            // 半正弦包络：首尾趋 0，无爆音
            let envelope = ((i as f32 / n as f32) * std::f32::consts::PI).sin();
            let sample = (t * 2.0 * std::f32::consts::PI * seg.freq).sin() * envelope * seg.amp;
            pcm.push((sample * i16::MAX as f32) as i16);
        }
    }
    encode_wav(&pcm)
}

/// PCM（单声道 16bit）→ WAV 字节流（44 字节头 + 数据）。
fn encode_wav(pcm: &[i16]) -> Vec<u8> {
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

/// 番茄钟"叮咚"的 WAV 字节。与 `play_tone` 共用同一组 `TONE_SEGMENTS`，
/// 这样测试验的就是真正会播出去的那段音频（此前两处各自写字面量，改一处会漂移）。
#[cfg(test)]
fn synth_tone_wav() -> Vec<u8> {
    synth_wav(TONE_SEGMENTS)
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

    /// 每个 Cue 都能合成出合法且非空的 WAV；总时长都短于 0.3s，
    /// 保证转盘音效不会盖住用户的下一个操作。
    #[test]
    fn every_cue_synthesizes_a_short_valid_wav() {
        for cue in [Cue::Open, Cue::Tick, Cue::Confirm, Cue::Cancel] {
            let wav = synth_wav(cue.segments());
            assert_eq!(&wav[0..4], b"RIFF", "{:?} 的 WAV 头损坏", cue);
            let data_len = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]) as usize;
            assert_eq!(data_len, wav.len() - 44, "{:?} 的 data 块长度不一致", cue);
            assert!(data_len > 0, "{:?} 合成出了空音频", cue);
            assert!(
                cue.total_secs() < 0.3,
                "{:?} 总时长 {}s 过长，会盖住用户的下一个操作",
                cue,
                cue.total_secs()
            );
        }
    }

    /// Tick 是鼠标划扇区时的最高频音效：必须比其余三个都短，
    /// 否则连续划过十几次会拖成一段黏连的长音。
    #[test]
    fn tick_is_the_shortest_cue() {
        for other in [Cue::Open, Cue::Confirm, Cue::Cancel] {
            assert!(
                Cue::Tick.total_secs() < other.total_secs(),
                "Tick ({}) 不比 {:?} ({}) 短",
                Cue::Tick.total_secs(),
                other,
                other.total_secs()
            );
        }
    }

    /// 确认音的高频段必须高于取消音的高频段：听感上"确认"比"取消"更明亮，
    /// 反过来会让两个相反的语义听起来一模一样。
    #[test]
    fn confirm_is_brighter_than_cancel() {
        let peak = |cue: Cue| cue.segments().iter().map(|s| s.freq).fold(0.0f32, f32::max);
        assert!(
            peak(Cue::Confirm) > peak(Cue::Cancel),
            "确认音峰值 {} 不高于取消音 {}",
            peak(Cue::Confirm),
            peak(Cue::Cancel)
        );
    }

    /// 两个合成器共用一个 `synth_wav`，但段落定义各自独立 ——
    /// 改转盘的音色不该挪动番茄钟的"叮咚"。
    #[test]
    fn tone_and_cue_segments_are_independent() {
        // 0.3s 总时长是番茄钟的既有听感，被无意改动会在测试里暴露
        assert_eq!(segments_duration(TONE_SEGMENTS), 0.3);
        for cue in [Cue::Open, Cue::Tick, Cue::Confirm, Cue::Cancel] {
            assert!(
                cue.total_secs() < segments_duration(TONE_SEGMENTS),
                "{:?} 不该比番茄钟提示音还长",
                cue
            );
        }
    }

    /// 串行化操作全局 `TICK_IN_FLIGHT` 的测试，避免并行运行互相污染
    /// （cargo 默认多线程跑测试；实测并行下「守卫存活期间标志应为 true」会随机失败）。
    static TICK_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 非刻度音不碰 `TICK_IN_FLIGHT` —— 否则一次「确认」就把刻度音锁死。
    ///
    /// ★ 不能只断言 `is_none()`：写成 `then_some` 时返回值同样是 `None`，
    /// 但那个守卫**已经被构造并析构过**，标志已被清掉 —— 用例照样绿。
    /// 必须真的去看标志。
    #[test]
    fn tick_guard_is_only_created_for_ticks() {
        let _serial = TICK_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        TICK_IN_FLIGHT.store(true, Ordering::SeqCst);
        assert!(tick_guard(false).is_none(), "非刻度音不该持有刻度守卫");
        assert!(
            TICK_IN_FLIGHT.load(Ordering::SeqCst),
            "★ 非刻度音把刻度音的「在飞」标志清掉了 —— 守卫被构造后立刻析构了"
        );
        assert!(tick_guard(true).is_some(), "刻度音必须持有守卫");
        TICK_IN_FLIGHT.store(false, Ordering::SeqCst);
    }

    /// 守卫析构后必须复位标志，否则刻度音会永久哑掉。
    #[test]
    fn tick_guard_releases_the_flag_on_drop() {
        let _serial = TICK_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        TICK_IN_FLIGHT.store(true, Ordering::SeqCst);
        {
            let _g = tick_guard(true).expect("刻度音应有守卫");
            assert!(
                TICK_IN_FLIGHT.load(Ordering::SeqCst),
                "守卫存活期间标志应保持 true"
            );
        }
        assert!(
            !TICK_IN_FLIGHT.load(Ordering::SeqCst),
            "守卫析构必须复位标志，否则刻度音永久哑掉"
        );
    }

    /// panic 展开也要复位 —— 这是用 `Drop` guard 而不是手写复位的核心理由。
    #[test]
    fn tick_guard_releases_the_flag_on_panic() {
        let _serial = TICK_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        TICK_IN_FLIGHT.store(true, Ordering::SeqCst);
        let result = std::panic::catch_unwind(|| {
            let _g = tick_guard(true).expect("刻度音应有守卫");
            panic!("模拟播放线程 panic");
        });
        assert!(result.is_err(), "应当捕获到 panic");
        assert!(
            !TICK_IN_FLIGHT.load(Ordering::SeqCst),
            "panic 展开后标志必须复位；依赖 Drop guard 才能做到"
        );
    }

    /// 「线程没起来」也必须复位：闭包被丢弃 ⇒ 它拥有的守卫析构。
    ///
    /// 这是「守卫必须在 `.spawn(` 之前构造、再 move 进闭包」的行为学证明。
    /// `thread::spawn` 建线程失败会 panic，那时闭包**一次都没执行**；
    /// 若守卫是写在闭包体内的，它就从未被创建过，`TICK_IN_FLIGHT` 会永久停在 true。
    /// 这里用一个「永远不执行的闭包」模拟那条路径。
    #[test]
    fn tick_guard_releases_the_flag_when_the_thread_never_runs() {
        let _serial = TICK_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        TICK_IN_FLIGHT.store(false, Ordering::SeqCst);
        // 模拟 play_cue 的 swap 抢占
        assert!(!TICK_IN_FLIGHT.swap(true, Ordering::SeqCst));
        // 守卫先构造，再 move 进闭包（与生产代码同构）
        let guard = tick_guard(true);
        let never_runs = move || {
            let _g = guard; // 拥有守卫，但闭包体永远不执行
        };
        // 线程创建失败 ⇒ 闭包被丢弃 ⇒ 守卫析构
        drop(never_runs);
        assert!(
            !TICK_IN_FLIGHT.load(Ordering::SeqCst),
            "闭包从未执行也必须复位；否则线程创建失败会让刻度音永久哑掉"
        );
    }

    /// 契约（源码级）：`play_segments` 里的守卫必须在 `.spawn(` **之前**构造。
    ///
    /// 与 `hooks/mouse.rs` 的 `SelectionCheckGuard` 同一条纪律（见 RUNTIME.md 钩子线程纪律②）。
    /// 写成源码守卫是因为「线程创建失败」无法在单测里稳定复现，而这条顺序一旦被
    /// 后人"顺手"挪进闭包，故障是**静默且不自愈**的 —— 正是需要钉住的形态。
    ///
    /// 同时钉住 `synth_wav` 也在守卫之后：它同样可能 panic（内存不足），
    /// 排在守卫前面就等于给标志留了一条卡死路径。
    #[test]
    fn tick_guard_is_constructed_before_spawn() {
        let src = include_str!("mod.rs").replace("\r\n", "\n");
        let start = src
            .find("fn play_segments(")
            .expect("play_segments 被改名/移动，请同步本守卫");
        let rest = &src[start..];
        let end = rest
            .find("\n\n")
            .expect("play_segments 后没有空行作为边界，请同步本守卫");
        // 剥注释后取位置，避免注释里提到的名字干扰排序判断
        let mut positions: [Option<usize>; 3] = [None; 3];
        let mut offset = 0usize;
        for line in rest[..end].lines() {
            if !line.trim_start().starts_with("//") {
                // 只看「构造守卫」那一句，不看只是引用守卫名的地方
                if positions[0].is_none() && line.contains("let guard = tick_guard(") {
                    positions[0] = Some(offset);
                }
                if positions[1].is_none() && line.contains("thread::spawn") {
                    positions[1] = Some(offset);
                }
                if positions[2].is_none() && line.contains("synth_wav(") {
                    positions[2] = Some(offset);
                }
            }
            offset += line.len() + 1;
        }
        let guard_pos =
            positions[0].expect("play_segments 里找不到 `let guard = tick_guard(`，请同步本守卫");
        let spawn_pos = positions[1].expect("play_segments 里找不到 thread::spawn，请同步本守卫");
        let synth_pos = positions[2].expect("play_segments 里找不到 synth_wav，请同步本守卫");
        assert!(
            guard_pos < spawn_pos,
            "守卫必须在 `thread::spawn` **之前**构造再 move 进闭包：\
             写进闭包体内的守卫在「建线程失败」这条路径上从未被创建，\
             TICK_IN_FLIGHT 会永久停在 true、刻度音彻底哑掉且不自愈"
        );
        assert!(
            guard_pos < synth_pos,
            "守卫必须在 `synth_wav` 之前构造：合成同样可能 panic（内存不足），\
             排在守卫前面等于给 TICK_IN_FLIGHT 留了一条永久卡死路径"
        );
    }

    /// 重入守卫的语义：已在飞时第二次调用直接丢弃。
    ///
    /// 这钉住 `play_cue` 里那句 `swap` 的含义 —— 快速甩动时每 13~21ms 换一个扇区，
    /// 而刻度音长 35ms；没有它就会同时叠起十几个播放实例。
    #[test]
    fn tick_swap_rejects_when_already_in_flight() {
        let _serial = TICK_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        TICK_IN_FLIGHT.store(false, Ordering::SeqCst);
        // 第一次抢占成功
        assert!(
            !TICK_IN_FLIGHT.swap(true, Ordering::SeqCst),
            "首次调用应抢占成功"
        );
        // 第二次（在飞）必须失败 ⇒ play_cue 会 return
        assert!(
            TICK_IN_FLIGHT.swap(true, Ordering::SeqCst),
            "在飞时再次调用必须被拒绝"
        );
        TICK_IN_FLIGHT.store(false, Ordering::SeqCst);
    }

    /// 契约：`play_cue` 可能从钩子线程进来，函数体里不能有阻塞调用。
    ///
    /// 守卫用 `swap` 抢占标志（原子操作），随后 `play_segments` 起线程立即返回。
    /// 若有人把播放改成同步（例如去掉 `thread::spawn`），钩子会被系统静默卸载。
    ///
    /// ⚠️ 取函数体时必须先**归一化行尾**：本文件是 CRLF，而 `\n\n` 在 `\r\n\r\n`
    /// 里匹配不上 —— 直接 `find("\n\n")` 会 panic（实测）。归一化后再切，才与行尾无关。
    #[test]
    fn play_cue_stays_hook_thread_safe() {
        // 归一化 CRLF -> LF，避免边界查找依赖工作区的行尾设置
        let src = include_str!("mod.rs").replace("\r\n", "\n");
        let start = src
            .find("pub fn play_cue(")
            .expect("play_cue 被改名/移动，请同步本守卫");
        let rest = &src[start..];
        let end = rest
            .find("\n\n")
            .expect("play_cue 后没有空行作为边界，请同步本守卫");
        let code: String = rest[..end]
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in ["play_inner", "thread::sleep", "CoInitializeEx"] {
            assert!(
                !code.contains(forbidden),
                "play_cue 里出现了 `{forbidden}` —— 它会阻塞钩子线程，\
                 超出 LowLevelHooksTimeout 后系统会静默卸载整个键盘钩子"
            );
        }
        assert!(
            code.contains("swap(true"),
            "play_cue 应通过原子 swap 抢占刻度守卫（这是它唯一的同步开销）"
        );
        assert!(
            code.contains("play_segments("),
            "play_cue 应通过 play_segments 起线程播放"
        );
    }

    /// 静音段（freq = 0）要真正产出等长的零采样，而不是被跳过导致时长缩水。
    #[test]
    fn silent_segment_keeps_its_duration() {
        let with_gap = synth_wav(&[
            Segment {
                freq: 440.0,
                dur: 0.05,
                amp: 0.4,
            },
            Segment {
                freq: 0.0,
                dur: 0.05,
                amp: 0.0,
            },
        ]);
        let data_len =
            u32::from_le_bytes([with_gap[40], with_gap[41], with_gap[42], with_gap[43]]) as usize;
        // 两段各 0.05s：44100 * 0.1 = 4410 个采样
        assert_eq!(data_len / 2, (SAMPLE_RATE as usize) / 10);
        // 后半段应全为零
        let half = data_len / 2 / 2;
        for i in half..(data_len / 2) {
            let sample = i16::from_le_bytes([with_gap[44 + i * 2], with_gap[44 + i * 2 + 1]]);
            assert_eq!(sample, 0, "静音段第 {} 个采样不为零", i);
        }
    }
}
