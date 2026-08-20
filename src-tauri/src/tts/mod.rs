//! 选中文本朗读（TTS）：基于 Windows 内置 WinRT SpeechSynthesizer 合成，
//! 用 MediaPlayer 播放，支持暂停/继续/停止与进度查询。
//!
//! 合成（SynthesizeTextToStreamAsync().get()）是阻塞调用，必须在 MTA 线程执行，
//! 否则 STA 上 .get() 会死锁（同 automation/ocr_selection.rs 的 OCR 模板记录的坑）。
//! MediaPlayer 本身非阻塞（Play/Pause 立即返回），需长期存活供播放控制，
//! 故由 TtsState（Tauri State）持有，事件回调只做 app.emit 不访问 TtsState。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{Emitter, Manager};
use windows::Foundation::TypedEventHandler;
use windows::Media::Core::MediaSource;
use windows::Media::Playback::MediaPlayer;
use windows::Media::SpeechSynthesis::{SpeechSynthesizer, VoiceGender};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

/// 系统已安装语音信息（供设置页下拉）
#[derive(serde::Serialize, Clone)]
pub struct VoiceInfo {
    pub id: String,
    pub display_name: String,
    pub language: String,
    pub gender: String,
}

/// 朗读状态。
/// player 为 (id, MediaPlayer)：id 单调递增，用于 MediaEnded 回调区分"自己的 player"
/// 是否仍是当前 player（重读时旧 player 的延迟回调不会误清新 player）。
/// MediaPlayer 无 IsPaused 查询接口，用 paused 自行标记暂停态。
pub struct TtsState {
    player: Mutex<Option<(u64, MediaPlayer)>>,
    paused: Mutex<bool>,
    next_id: AtomicU64,
}

impl Default for TtsState {
    fn default() -> Self {
        Self {
            player: Mutex::new(None),
            paused: Mutex::new(false),
            next_id: AtomicU64::new(1),
        }
    }
}

/// HSTRING 转 String 的便捷封装（失败返回空串，不中断流程）
fn hstr_to_string(h: windows::core::Result<windows::core::HSTRING>) -> String {
    match h {
        Ok(s) => s.to_string(),
        Err(_) => String::new(),
    }
}

/// VoiceGender 转字符串
fn gender_str(g: windows::core::Result<VoiceGender>) -> &'static str {
    match g {
        Ok(VoiceGender::Male) => "Male",
        Ok(VoiceGender::Female) => "Female",
        _ => "Unknown",
    }
}

/// 枚举系统已安装语音。AllVoices 同步不阻塞，但为统一 COM 环境放 MTA 子线程。
pub fn list_voices() -> Result<Vec<VoiceInfo>, String> {
    std::thread::spawn(|| {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let res: Result<Vec<VoiceInfo>, String> = (|| {
            let voices =
                SpeechSynthesizer::AllVoices().map_err(|e| format!("AllVoices 失败: {:?}", e))?;
            let mut out = Vec::new();
            for v in &voices {
                out.push(VoiceInfo {
                    id: hstr_to_string(v.Id()),
                    display_name: hstr_to_string(v.DisplayName()),
                    language: hstr_to_string(v.Language()),
                    gender: gender_str(v.Gender()).to_string(),
                });
            }
            Ok(out)
        })();
        unsafe {
            CoUninitialize();
        }
        res
    })
    .join()
    .map_err(|e| format!("list_voices 线程 panic: {:?}", e))?
}

/// 合成并播放。参数均由前端传入（rate=字/秒，volume=0.0~1.0，voice_id 空则用默认语音）。
/// 流程：清旧 player → 创建 synthesizer → 设语音/语速/音量 → 合成 stream →
/// MediaSource 包装 → MediaPlayer + 事件 → Play → 存入 TtsState → emit tts-started。
pub fn speak(
    app: tauri::AppHandle,
    text: String,
    rate: f64,
    voice_id: String,
    volume: f64,
) -> Result<(), String> {
    let app_handle = app.clone();
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let res: Result<(), String> = (|| {
            let state = app_handle.state::<TtsState>();

            // 1. 清旧 player（Close 释放，take 移除避免悬挂）
            if let Ok(mut guard) = state.player.lock() {
                if let Some((_, old)) = guard.take() {
                    let _ = old.Close();
                }
            }
            if let Ok(mut p) = state.paused.lock() {
                *p = false;
            }

            // 为本次播放分配唯一 id，供 MediaEnded 回调区分自己是否仍是当前 player
            let player_id = state.next_id.fetch_add(1, Ordering::SeqCst);

            // 2. 创建 synthesizer 并按 voice_id 选语音
            let synth =
                SpeechSynthesizer::new().map_err(|e| format!("创建 SpeechSynthesizer: {:?}", e))?;
            if !voice_id.is_empty() {
                let voices =
                    SpeechSynthesizer::AllVoices().map_err(|e| format!("AllVoices: {:?}", e))?;
                let mut found: Option<windows::Media::SpeechSynthesis::VoiceInformation> = None;
                for v in &voices {
                    if hstr_to_string(v.Id()) == voice_id {
                        found = Some(v.clone());
                        break;
                    }
                }
                let target = found.ok_or_else(|| format!("找不到语音 id: {}", voice_id))?;
                synth
                    .SetVoice(&target)
                    .map_err(|e| format!("SetVoice: {:?}", e))?;
            }

            // 3. 语速（Options 在老系统可能不支持，失败则忽略用默认值）。
            // 音量不在合成侧设（SetAudioVolume），改由下方 player.SetVolume 单点控制，
            // 避免合成流缩放与播放器音量双重衰减（实际听到 volume*volume）。
            if let Ok(options) = synth.Options() {
                let _ = options.SetSpeakingRate(rate);
            }

            // 4. 合成（阻塞，MTA 上安全）
            let stream = synth
                .SynthesizeTextToStreamAsync(&windows::core::HSTRING::from(text.as_str()))
                .map_err(|e| format!("SynthesizeTextToStreamAsync: {:?}", e))?
                .get()
                .map_err(|e| format!("合成 .get() 失败: {:?}", e))?;

            // 5. 包装为 MediaSource → MediaPlayer
            let ct = hstr_to_string(stream.ContentType());
            let content_type = if ct.is_empty() {
                "audio/wav".to_string()
            } else {
                ct
            };
            let source = MediaSource::CreateFromStream(
                &stream,
                &windows::core::HSTRING::from(content_type.as_str()),
            )
            .map_err(|e| format!("CreateFromStream: {:?}", e))?;

            let player = MediaPlayer::new().map_err(|e| format!("创建 MediaPlayer: {:?}", e))?;
            let _ = player.SetVolume(volume);
            player
                .SetSource(&source)
                .map_err(|e| format!("SetSource: {:?}", e))?;

            // 6. MediaEnded 回调 → 仅当自己仍是当前 player 时清理并 emit tts-finished
            // 自然播完后必须 take 清理 TtsState.player，否则 has_player 永真，
            // 下次 selection-found 会错误恢复 speaking 态但无声。
            // 用 player_id 区分：重读时旧 player 的延迟回调不会误清新 player。
            // 回调在 MTA 线程触发；take 仅 Mutex 操作无 COM 调用，player 移到独立线程 Drop（Close）。
            let app_for_event = app_handle.clone();
            let handler = TypedEventHandler::<MediaPlayer, windows::core::IInspectable>::new(
                move |_sender, _args| {
                    // 仅当自己是当前 player（id 匹配）时才清理 player + 重置 paused + emit tts-finished。
                    // 旧 player 的延迟回调（重读时 A 已被 Close，WinRT 不保证取消已排队回调）
                    // id 不匹配 → taken=None → 不 emit，避免错误复位新 player B 的 speaking 态。
                    if let Some(state) = app_for_event.try_state::<TtsState>() {
                        let taken = state.player.lock().ok().and_then(|mut g| {
                            if g.as_ref().map(|(id, _)| *id == player_id).unwrap_or(false) {
                                g.take().map(|(_, p)| p)
                            } else {
                                None
                            }
                        });
                        if let Some(p) = taken {
                            // 移到独立线程 Drop，避免在事件回调中同步销毁事件源的 COM 重入风险
                            std::thread::spawn(move || {
                                unsafe {
                                    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                                }
                                drop(p);
                                unsafe {
                                    CoUninitialize();
                                }
                            });
                            // 仅当清理的是自己的 player 时才重置 paused，
                            // 避免旧 player 的延迟回调错误重置新 player 的暂停态。
                            if let Ok(mut p) = state.paused.lock() {
                                *p = false;
                            }
                            // 仅当自然结束的是当前 player 时才通知前端退出 speaking 态
                            let _ = app_for_event.emit("tts-finished", ());
                        }
                    }
                    Ok(())
                },
            );
            player
                .MediaEnded(&handler)
                .map_err(|e| format!("MediaEnded 注册: {:?}", e))?;

            // 7. 先存入 TtsState 再 Play：确保 MediaEnded 触发时 player 已在 TtsState 中
            // （否则极短音频可能在存入前结束，回调无法清理导致 player 残留）。
            // clone player 调 Play，避免持锁做 COM 调用阻塞其他等锁命令。
            // 若 Play 失败，需 take 清理已存入的 player。
            if let Ok(mut guard) = state.player.lock() {
                *guard = Some((player_id, player));
            }
            let player_clone = state.player.lock().ok().and_then(|g| {
                g.as_ref()
                    .filter(|(id, _)| *id == player_id)
                    .map(|(_, p)| p.clone())
            });
            match player_clone {
                Some(p) => match p.Play() {
                    Ok(()) => {}
                    Err(e) => {
                        if let Ok(mut guard) = state.player.lock() {
                            if guard
                                .as_ref()
                                .map(|(id, _)| *id == player_id)
                                .unwrap_or(false)
                            {
                                if let Some((_, old)) = guard.take() {
                                    let _ = old.Close();
                                }
                            }
                        }
                        return Err(format!("Play: {:?}", e));
                    }
                },
                None => {
                    // Mutex 中毒或 player 被并发 take：视为失败
                    return Err("Play 失败：player 已不在状态中".to_string());
                }
            }
            if let Ok(mut p) = state.paused.lock() {
                *p = false;
            }
            let _ = app_handle.emit("tts-started", ());
            Ok(())
        })();
        unsafe {
            CoUninitialize();
        }
        res
    })
    .join()
    .map_err(|e| format!("speak 线程 panic: {:?}", e))?
}

/// 停止朗读：在 MTA 线程 Close 销毁 player，take 移除。MediaPlayer 无 Stop()，用 Close 释放。
pub fn stop(state: &TtsState) -> Result<(), String> {
    // 取出 player（在调用方线程，仅 Mutex 操作无 COM 调用）
    let player = state
        .player
        .lock()
        .ok()
        .and_then(|mut g| g.take())
        .map(|(_, p)| p);
    if let Some(p) = player {
        // COM 调用放 MTA 线程（player 是 agile 对象，跨线程 Close 需规范 COM 环境）
        let _ = std::thread::spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            let _ = p.Pause();
            let _ = p.Close();
            unsafe {
                CoUninitialize();
            }
        })
        .join();
    }
    if let Ok(mut p) = state.paused.lock() {
        *p = false;
    }
    Ok(())
}

/// 暂停：在 MTA 线程调 Pause（agile COM 对象跨线程需规范 COM 环境）
pub fn pause(state: &TtsState) -> Result<(), String> {
    let player = state
        .player
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|(_, p)| p.clone()));
    if let Some(p) = player {
        std::thread::spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            let r = p.Pause().map_err(|e| format!("Pause: {:?}", e));
            unsafe {
                CoUninitialize();
            }
            r
        })
        .join()
        .map_err(|e| format!("pause 线程 panic: {:?}", e))??;
    }
    if let Ok(mut p) = state.paused.lock() {
        *p = true;
    }
    Ok(())
}

/// 继续：在 MTA 线程调 Play（MediaPlayer 用 Play 恢复播放）
pub fn resume(state: &TtsState) -> Result<(), String> {
    let player = state
        .player
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|(_, p)| p.clone()));
    if let Some(p) = player {
        std::thread::spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            let _ = p.Play();
            unsafe {
                CoUninitialize();
            }
        })
        .join()
        .map_err(|e| format!("resume 线程 panic: {:?}", e))?;
    }
    if let Ok(mut p) = state.paused.lock() {
        *p = false;
    }
    Ok(())
}

/// 是否有 player（不代表正在播放，可能暂停中）
pub fn has_player(state: &TtsState) -> bool {
    state.player.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// 当前是否暂停（自标记）
pub fn is_paused(state: &TtsState) -> bool {
    state.paused.lock().map(|g| *g).unwrap_or(false)
}

/// 进度查询：(position_ms, duration_ms, paused)。无 player 返回 None。
/// duration_ms 为 0 表示总时长未知（NaturalDuration 为无限，实时流等场景），
/// 前端据此只显示已播时长、隐藏进度条比例。
/// COM 调用放 MTA 线程（同 pause/resume），避免命令线程未初始化 COM 导致调用失败。
pub fn get_progress(state: &TtsState) -> Option<(u64, u64, bool)> {
    let player = state.player.lock().ok()?.as_ref().map(|(_, p)| p.clone())?;
    let res = std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let r: Option<(u64, u64)> = (|| {
            let session = player.PlaybackSession().ok()?;
            let pos_ms = session.Position().ok()?.Duration as u64 / 10_000;
            let dur = session.NaturalDuration().ok()?.Duration;
            // NaturalDuration 对未知时长返回无限（i64::MAX），以 0 表示"未知"，避免前端溢出
            let dur_ms = if dur < 0 || dur >= i64::MAX / 2 {
                0
            } else {
                dur as u64 / 10_000
            };
            Some((pos_ms, dur_ms))
        })();
        unsafe {
            CoUninitialize();
        }
        r
    })
    .join()
    .ok()
    .flatten()?;
    let paused = state.paused.lock().map(|g| *g).unwrap_or(false);
    Some((res.0, res.1, paused))
}

/// 当前播放态快照（供前端恢复工具栏 speaking 态）
pub fn get_state_snapshot(state: &TtsState) -> (bool, bool, bool) {
    let has = has_player(state);
    let paused = is_paused(state);
    // 有 player 且未暂停视为"正在播放"
    let playing = has && !paused;
    (playing, paused, has)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TtsState 默认无 player：has_player/is_paused 为 false，get_state_snapshot 全 false。
    #[test]
    fn tts_state_default_empty() {
        let state = TtsState::default();
        assert!(!has_player(&state));
        assert!(!is_paused(&state));
        let (playing, paused, has) = get_state_snapshot(&state);
        assert!(!playing);
        assert!(!paused);
        assert!(!has);
    }

    /// 无 player 时 stop/pause/resume 返回 Ok 不 panic（防御空态）。
    #[test]
    fn tts_stop_pause_resume_on_empty_state() {
        let state = TtsState::default();
        assert!(stop(&state).is_ok());
        assert!(pause(&state).is_ok());
        assert!(resume(&state).is_ok());
        // 操作后仍无 player
        assert!(!has_player(&state));
        // resume 会把 paused 置 false（即使无 player 也执行清理标记）
        assert!(!is_paused(&state));
    }

    /// 无 player 时 get_progress 返回 None（不 panic）。
    #[test]
    fn tts_get_progress_empty_returns_none() {
        let state = TtsState::default();
        assert!(get_progress(&state).is_none());
    }

    /// next_id 单调递增（验证 player id 分配机制）。
    #[test]
    fn tts_next_id_monotonic() {
        let state = TtsState::default();
        let a = state.next_id.fetch_add(1, Ordering::SeqCst);
        let b = state.next_id.fetch_add(1, Ordering::SeqCst);
        assert!(b > a, "next_id 应单调递增");
    }

    /// 真机测试：枚举系统已安装语音。需 Windows 语音包，默认 ignore（CI 无语音环境）。
    /// 手动验证：cargo test --bin levitaire tts::tests::tts_list_voices_real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn tts_list_voices_real() {
        match list_voices() {
            Ok(voices) => {
                println!("系统语音数量: {}", voices.len());
                for v in &voices {
                    println!(
                        "  id={} name={} lang={} gender={}",
                        v.id, v.display_name, v.language, v.gender
                    );
                }
                // 大部分 Windows 系统至少有一个语音；无语音也不算失败（仅记录）
            }
            Err(e) => panic!("list_voices 失败: {}", e),
        }
    }

    /// 真机测试：验证 WinRT 合成+播放 API 链路（speak 的核心调用，不经 TtsState/回调）。
    /// 会真实发声（朗读"测试"两字约 1 秒）。默认 ignore。
    /// 手动验证：cargo test --bin levitaire tts::tests::tts_synthesize_play_real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn tts_synthesize_play_real() {
        use windows::Media::Core::MediaSource;
        use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
        // 合成必须在 MTA 线程（同 speak/OCR）
        let res = std::thread::spawn(|| {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            let r: Result<(), String> = (|| {
                let synth =
                    SpeechSynthesizer::new().map_err(|e| format!("创建 synthesizer: {:?}", e))?;
                let stream = synth
                    .SynthesizeTextToStreamAsync(&windows::core::HSTRING::from("测试朗读"))
                    .map_err(|e| format!("SynthesizeTextToStreamAsync: {:?}", e))?
                    .get()
                    .map_err(|e| format!("合成 .get(): {:?}", e))?;
                let ct = hstr_to_string(stream.ContentType());
                let content_type = if ct.is_empty() {
                    "audio/wav".to_string()
                } else {
                    ct
                };
                let source = MediaSource::CreateFromStream(
                    &stream,
                    &windows::core::HSTRING::from(content_type.as_str()),
                )
                .map_err(|e| format!("CreateFromStream: {:?}", e))?;
                let player =
                    MediaPlayer::new().map_err(|e| format!("创建 MediaPlayer: {:?}", e))?;
                player
                    .SetSource(&source)
                    .map_err(|e| format!("SetSource: {:?}", e))?;
                player.Play().map_err(|e| format!("Play: {:?}", e))?;
                // 播放 1.5 秒让声音出来（"测试朗读"约 1 秒），然后 Close 停止
                std::thread::sleep(std::time::Duration::from_millis(1500));
                let _ = player.Close();
                Ok(())
            })();
            unsafe {
                CoUninitialize();
            }
            r
        })
        .join()
        .map_err(|e| format!("线程 panic: {:?}", e));
        match res {
            Ok(inner) => {
                assert!(inner.is_ok(), "合成播放失败: {:?}", inner.err());
                println!("合成播放链路验证通过（应已听到'测试朗读'）");
            }
            Err(e) => panic!("线程 join 失败: {}", e),
        }
    }
}
