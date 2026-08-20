//! 番茄钟：常驻悬浮倒计时工具。
//!
//! PomodoroState 作为 Tauri managed state。计时线程基于 end_time 差值计算剩余时间，
//! 通过 `app.emit("pomodoro-tick", payload)` 推送给前端；到点自动切换阶段
//! （专注 → 短休息/长休息），并发 `pomodoro-complete` 事件、可选提醒音
//! （语音播报 / 纯提示音）。
//!
//! 与系统监控不同：窗口隐藏（hide）不影响计时——关闭窗口仅隐藏实例，计时应继续，
//! 到点提醒不依赖窗口可见。仅当工具被禁用（set_pomodoro_enabled(false)）时 stop 并重置。
//! 计时状态由后端持有，前端重开窗口时通过 get_pomodoro_state 拉取恢复。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

/// 番茄钟阶段
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PomodoroStage {
    Focus,
    ShortBreak,
    LongBreak,
}

/// 到点提醒方式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PomodoroNotifySound {
    /// 语音播报（复用 TTS）
    #[default]
    Voice,
    /// 纯提示音（合成"叮咚"双音，低调不打扰）
    Tone,
    /// 静音
    None,
}

/// 番茄钟配置（JSON 字符串持久化于 config.json，前端解析后回写）。
/// 字段名以 camelCase 序列化，与前端存储的 JSON（workMinutes 等）一致。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroConfig {
    pub work_minutes: u64,
    pub short_break_minutes: u64,
    pub long_break_minutes: u64,
    /// 每完成多少个专注进入一次长休息
    pub rounds_before_long_break: u64,
    /// 到点后是否自动开始下一阶段
    pub auto_start_next: bool,
    /// 到点是否播放提示音。兼容旧配置：notify_sound_type 未设置时据此回退
    #[serde(default = "default_true")]
    pub notify_sound: bool,
    /// 到点提醒方式。None 表示旧配置未写入该字段，回退到 notify_sound 布尔逻辑
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notify_sound_type: Option<PomodoroNotifySound>,
}

/// `notify_sound` 的缺省值（旧配置缺失该字段时视为开启）
fn default_true() -> bool {
    true
}

impl Default for PomodoroConfig {
    fn default() -> Self {
        Self {
            work_minutes: 25,
            short_break_minutes: 5,
            long_break_minutes: 15,
            rounds_before_long_break: 4,
            auto_start_next: false,
            notify_sound: true,
            notify_sound_type: Some(PomodoroNotifySound::Voice),
        }
    }
}

impl PomodoroConfig {
    /// 当前配置实际生效的提醒方式：优先新字段，旧配置回退 notify_sound 布尔
    pub fn effective_notify_sound(&self) -> PomodoroNotifySound {
        self.notify_sound_type.unwrap_or(if self.notify_sound {
            PomodoroNotifySound::Voice
        } else {
            PomodoroNotifySound::None
        })
    }

    /// 某阶段的总时长（秒）
    pub fn total_secs(&self, stage: PomodoroStage) -> u64 {
        match stage {
            PomodoroStage::Focus => self.work_minutes * 60,
            PomodoroStage::ShortBreak => self.short_break_minutes * 60,
            PomodoroStage::LongBreak => self.long_break_minutes * 60,
        }
    }
}

/// 推送到前端的番茄钟状态 payload
#[derive(Debug, Clone, Serialize)]
pub struct PomodoroStatePayload {
    pub stage: PomodoroStage,
    /// 当前阶段剩余秒数
    pub remaining_secs: u64,
    /// 当前阶段总时长（秒）
    pub total_secs: u64,
    pub running: bool,
    /// 已完成的专注轮数（本次会话累计）
    pub rounds_done: u64,
}

/// 番茄钟运行状态（Tauri managed state）
pub struct PomodoroState {
    running: AtomicBool,
    /// 本轮结束的绝对时刻。暂停/停止时为 None，剩余时间由 remaining_secs 保存
    end_time: Mutex<Option<Instant>>,
    stage: Mutex<PomodoroStage>,
    /// 已完成的专注轮数
    rounds_done: AtomicU64,
    /// 未在计时时的剩余秒数（暂停/停止时保存）
    remaining_secs: Mutex<u64>,
    config: Mutex<PomodoroConfig>,
    /// 线程代次：pause/reset/skip/stop 时递增，作废在跑计时线程
    generation: AtomicU64,
}

impl Default for PomodoroState {
    fn default() -> Self {
        let config = PomodoroConfig::default();
        let stage = PomodoroStage::Focus;
        Self {
            running: AtomicBool::new(false),
            end_time: Mutex::new(None),
            stage: Mutex::new(stage),
            rounds_done: AtomicU64::new(0),
            remaining_secs: Mutex::new(config.total_secs(stage)),
            config: Mutex::new(config),
            generation: AtomicU64::new(0),
        }
    }
}

impl PomodoroState {
    /// 读取当前配置快照
    pub fn config(&self) -> PomodoroConfig {
        self.config.lock().map(|c| c.clone()).unwrap_or_default()
    }

    /// 更新配置。当前阶段总时长变化且未在计时时，剩余时间复位到新总长。
    /// 对越界时长做钳制，防御脏数据（如手动编辑 config.json）。
    pub fn set_config(&self, config: PomodoroConfig) {
        // 兼容旧配置：notify_sound_type 缺失（旧 JSON 仅 notify_sound）时，
        // 由布尔回退推断提醒方式，并让两者保持一致，避免字段矛盾。
        let notify_type = config.effective_notify_sound();
        let config = PomodoroConfig {
            work_minutes: config.work_minutes.clamp(1, 120),
            short_break_minutes: config.short_break_minutes.clamp(1, 60),
            long_break_minutes: config.long_break_minutes.clamp(1, 120),
            rounds_before_long_break: config.rounds_before_long_break.clamp(1, 12),
            auto_start_next: config.auto_start_next,
            notify_sound: notify_type != PomodoroNotifySound::None,
            notify_sound_type: Some(notify_type),
        };
        let stage = *self.stage.lock().unwrap();
        let new_total = config.total_secs(stage);
        let running = self.running.load(Ordering::SeqCst);
        {
            let mut rem = self.remaining_secs.lock().unwrap();
            if !running || *rem > new_total {
                *rem = new_total;
                // 运行中压缩时长：同步重设 end_time，保持 UI 剩余与到点一致。
                // 未在计时时 end_time 本为 None，保持不动。
                if running {
                    *self.end_time.lock().unwrap() =
                        Some(Instant::now() + Duration::from_secs(new_total));
                }
            }
        }
        *self.config.lock().unwrap() = config;
    }

    /// 当前是否在计时
    #[allow(dead_code)]
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// 构造当前状态 payload
    pub fn payload(&self) -> PomodoroStatePayload {
        let config = self.config();
        let stage = *self.stage.lock().unwrap();
        PomodoroStatePayload {
            stage,
            remaining_secs: *self.remaining_secs.lock().unwrap(),
            total_secs: config.total_secs(stage),
            running: self.running.load(Ordering::SeqCst),
            rounds_done: self.rounds_done.load(Ordering::SeqCst),
        }
    }

    /// 开始/继续计时，并确保计时线程在跑
    pub fn start(&self, app: &tauri::AppHandle) {
        // 已运行则跳过（线程已在跑）
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        // 递增代次作废可能尚未退出的旧线程（如到点后 running=false 但仍
        // 在 500ms sleep 中的线程），保证任意时刻只有一个计时线程在跑，
        // 避免双线程同时 emit tick / 重复触发阶段完成。
        self.generation.fetch_add(1, Ordering::SeqCst);
        // 幂等设置 end_time（暂停/停止后剩余时间已保存）。
        // 锁获取顺序与 set_config 保持一致（remaining_secs → end_time），
        // 避免交叉持锁形成死锁。
        {
            let rem = *self.remaining_secs.lock().unwrap();
            let mut end = self.end_time.lock().unwrap();
            if end.is_none() {
                *end = Some(Instant::now() + Duration::from_secs(rem));
            }
        }
        let gen = self.generation.load(Ordering::SeqCst);
        let app_handle = app.clone();
        std::thread::spawn(move || {
            // 500ms 心跳。基于 end_time 差值计算，即使心跳被延迟也能保证剩余时间准确。
            while let Some(st) = app_handle.try_state::<PomodoroState>() {
                if st.generation.load(Ordering::SeqCst) != gen
                    || !st.running.load(Ordering::SeqCst)
                {
                    break;
                }
                let remaining = {
                    let end = st.end_time.lock().unwrap();
                    match *end {
                        Some(t) => t.saturating_duration_since(Instant::now()).as_secs(),
                        None => 0,
                    }
                };
                if remaining > 0 {
                    *st.remaining_secs.lock().unwrap() = remaining;
                    let _ = app_handle.emit("pomodoro-tick", st.payload());
                } else {
                    // end_time 为 None 既可能是到点，也可能是 pause/reset/stop 恰好
                    // 清空了它。仅当仍处于运行态且代次未变时才视为到点，否则退出，
                    // 避免暂停瞬间旧线程读到 None 误判到点、重复推进阶段。
                    if !st.running.load(Ordering::SeqCst) || st.generation.load(Ordering::SeqCst) != gen {
                        break;
                    }
                    // 到点：完成当前阶段，切换下一阶段
                    let completed = *st.stage.lock().unwrap();
                    st.advance_stage();
                    let next_stage = *st.stage.lock().unwrap();
                    let cfg = st.config();
                    let next_total = cfg.total_secs(next_stage);
                    *st.remaining_secs.lock().unwrap() = next_total;
                    *st.end_time.lock().unwrap() = None;
                    st.running.store(false, Ordering::SeqCst);
                    let _ = app_handle.emit("pomodoro-complete", st.payload());

                    // 提醒音：语音播报 / 纯提示音均各自自开线程，不阻塞计时线程
                    match cfg.effective_notify_sound() {
                        PomodoroNotifySound::Voice => {
                            let text = match completed {
                                PomodoroStage::Focus => "专注结束，休息一下吧",
                                _ => "休息结束，开始专注吧",
                            };
                            let _ = crate::tts::speak(
                                app_handle.clone(),
                                text.to_string(),
                                4.0,
                                String::new(),
                                1.0,
                            );
                        }
                        PomodoroNotifySound::Tone => crate::sound::play_tone(),
                        PomodoroNotifySound::None => {}
                    }

                    // 自动开始下一阶段（否则线程下轮因 running=false 退出）
                    if cfg.auto_start_next {
                        st.running.store(true, Ordering::SeqCst);
                        *st.end_time.lock().unwrap() =
                            Some(Instant::now() + Duration::from_secs(next_total));
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        });
    }

    /// 暂停计时（保留剩余时间）
    pub fn pause(&self) {
        if !self.running.load(Ordering::SeqCst) {
            return;
        }
        self.running.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        // 先取走 end_time（guard 语句结束即释放），再更新 remaining，避免
        // 与 set_config 的 remaining → end_time 锁顺序交叉。
        let end = self.end_time.lock().unwrap().take();
        if let Some(end) = end {
            let rem = end.saturating_duration_since(Instant::now()).as_secs();
            *self.remaining_secs.lock().unwrap() = rem;
        }
    }

    /// 重置当前阶段倒计时（停止，回到阶段初始时长）
    pub fn reset(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.end_time.lock().unwrap().take();
        let stage = *self.stage.lock().unwrap();
        let total = self.config().total_secs(stage);
        *self.remaining_secs.lock().unwrap() = total;
    }

    /// 跳过当前阶段进入下一阶段。返回此前是否在计时（调用方据此决定是否重新 start）
    pub fn skip(&self) -> bool {
        let was_running = self.running.load(Ordering::SeqCst);
        self.running.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.advance_stage();
        let stage = *self.stage.lock().unwrap();
        let total = self.config().total_secs(stage);
        *self.remaining_secs.lock().unwrap() = total;
        if was_running {
            *self.end_time.lock().unwrap() = Some(Instant::now() + Duration::from_secs(total));
        } else {
            self.end_time.lock().unwrap().take();
        }
        was_running
    }

    /// 停止番茄钟并重置全部进度（工具禁用时调用）
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.end_time.lock().unwrap().take();
        self.rounds_done.store(0, Ordering::SeqCst);
        let stage = PomodoroStage::Focus;
        *self.stage.lock().unwrap() = stage;
        let total = self.config().total_secs(stage);
        *self.remaining_secs.lock().unwrap() = total;
    }

    /// 阶段推进：专注结束计一轮，达到轮数阈值进长休息，否则短休息；休息结束回到专注。
    /// 用取模判断阈值（每 N 轮一次长休息），与前端 rounds_done % N 的循环显示一致
    /// （前端在长休息期间将整除余数 0 显示为满格 N/N）；
    /// 若用 `>=`，第 4 轮起每轮专注都进长休息，短休息永不出现。
    fn advance_stage(&self) {
        let mut stage = self.stage.lock().unwrap();
        let rounds = self.rounds_done.load(Ordering::SeqCst);
        let cfg = self.config();
        *stage = match *stage {
            PomodoroStage::Focus => {
                self.rounds_done
                    .store(rounds + 1, Ordering::SeqCst);
                if (rounds + 1) % cfg.rounds_before_long_break.max(1) == 0 {
                    PomodoroStage::LongBreak
                } else {
                    PomodoroStage::ShortBreak
                }
            }
            PomodoroStage::ShortBreak | PomodoroStage::LongBreak => PomodoroStage::Focus,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_payload_focus_full() {
        let state = PomodoroState::default();
        let p = state.payload();
        assert_eq!(p.stage, PomodoroStage::Focus);
        assert_eq!(p.remaining_secs, 1500);
        assert_eq!(p.total_secs, 1500);
        assert!(!p.running);
        assert_eq!(p.rounds_done, 0);
    }

    #[test]
    fn test_set_config_updates_total_and_resets_when_idle() {
        let state = PomodoroState::default();
        state.set_config(PomodoroConfig {
            work_minutes: 45,
            ..Default::default()
        });
        let p = state.payload();
        assert_eq!(p.total_secs, 2700);
        assert_eq!(p.remaining_secs, 2700);
    }

    #[test]
    fn test_set_config_clamps_invalid_values() {
        let state = PomodoroState::default();
        state.set_config(PomodoroConfig {
            work_minutes: 999,
            rounds_before_long_break: 0,
            ..Default::default()
        });
        let cfg = state.config();
        assert_eq!(cfg.work_minutes, 120);
        assert_eq!(cfg.rounds_before_long_break, 1);
    }

    #[test]
    fn test_reset_returns_current_stage_initial() {
        let state = PomodoroState::default();
        state.reset();
        let p = state.payload();
        assert_eq!(p.stage, PomodoroStage::Focus);
        assert_eq!(p.remaining_secs, 1500);
        assert!(!p.running);
    }

    #[test]
    fn test_advance_stage_focus_to_short_break_counts_round() {
        let state = PomodoroState::default();
        state.advance_stage();
        assert_eq!(*state.stage.lock().unwrap(), PomodoroStage::ShortBreak);
        assert_eq!(state.rounds_done.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_advance_stage_reaches_long_break_after_rounds_threshold() {
        let state = PomodoroState::default();
        // 默认 4 轮阈值：前 3 次专注进短休息，第 4 次专注进长休息
        for _ in 0..3 {
            state.advance_stage(); // focus -> short_break
            state.advance_stage(); // short_break -> focus
        }
        state.advance_stage(); // 第 4 次专注完成
        assert_eq!(*state.stage.lock().unwrap(), PomodoroStage::LongBreak);
        assert_eq!(state.rounds_done.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn test_advance_stage_returns_to_short_break_after_long_break() {
        let state = PomodoroState::default();
        // 完成一轮（4 次专注，第 4 次进长休息），再回到专注
        for _ in 0..4 {
            state.advance_stage(); // focus -> break
            state.advance_stage(); // break -> focus
        }
        assert_eq!(*state.stage.lock().unwrap(), PomodoroStage::Focus);
        // 新循环第 1 次专注：应进短休息，而非继续长休息
        state.advance_stage();
        assert_eq!(*state.stage.lock().unwrap(), PomodoroStage::ShortBreak);
        assert_eq!(state.rounds_done.load(Ordering::SeqCst), 5);
    }

    #[test]
    fn test_skip_returns_running_flag_and_advances() {
        let state = PomodoroState::default();
        assert!(!state.skip()); // 未运行时跳过，返回 false
        assert_eq!(*state.stage.lock().unwrap(), PomodoroStage::ShortBreak);
        assert_eq!(*state.remaining_secs.lock().unwrap(), 300);
        assert!(!state.is_running());
    }

    /// 旧配置（仅 notify_sound=false，无 notify_sound_type）→ 提醒方式回退为 None
    #[test]
    fn test_set_config_backfill_none_from_notify_sound_false() {
        let state = PomodoroState::default();
        state.set_config(PomodoroConfig {
            notify_sound: false,
            notify_sound_type: None,
            ..Default::default()
        });
        let cfg = state.config();
        assert_eq!(cfg.effective_notify_sound(), PomodoroNotifySound::None);
        assert_eq!(cfg.notify_sound_type, Some(PomodoroNotifySound::None));
        assert!(!cfg.notify_sound);
    }

    /// 旧配置 notify_sound=true 无新字段 → 回退为语音播报
    #[test]
    fn test_set_config_backfill_voice_from_notify_sound_true() {
        let state = PomodoroState::default();
        state.set_config(PomodoroConfig {
            notify_sound: true,
            notify_sound_type: None,
            ..Default::default()
        });
        let cfg = state.config();
        assert_eq!(cfg.effective_notify_sound(), PomodoroNotifySound::Voice);
        assert!(cfg.notify_sound);
    }

    /// 新字段优先：notify_sound=true 与 notify_sound_type=Tone 并存时按 Tone 提醒
    #[test]
    fn test_effective_notify_sound_prefers_type_field() {
        let config = PomodoroConfig {
            notify_sound: true,
            notify_sound_type: Some(PomodoroNotifySound::Tone),
            ..Default::default()
        };
        assert_eq!(config.effective_notify_sound(), PomodoroNotifySound::Tone);
    }

    /// 提醒方式序列化为 snake_case（voice/tone/none），与前端约定一致
    #[test]
    fn test_notify_sound_type_serde_snake_case() {
        let json = serde_json::to_string(&PomodoroNotifySound::Tone).unwrap();
        assert_eq!(json, "\"tone\"");
        let parsed: PomodoroNotifySound = serde_json::from_str("\"none\"").unwrap();
        assert_eq!(parsed, PomodoroNotifySound::None);
    }

    /// 启动恢复链路：持久化 JSON（新格式）→ 反序列化 → set_config，提醒方式正确生效
    #[test]
    fn test_restore_from_persisted_json() {
        let json = r#"{"workMinutes":45,"shortBreakMinutes":5,"longBreakMinutes":15,"roundsBeforeLongBreak":4,"autoStartNext":false,"notifySoundType":"tone","notifySound":true,"displayMode":"full"}"#;
        let config: PomodoroConfig = serde_json::from_str(json).unwrap();
        let state = PomodoroState::default();
        state.set_config(config);
        let cfg = state.config();
        assert_eq!(cfg.work_minutes, 45);
        assert_eq!(cfg.effective_notify_sound(), PomodoroNotifySound::Tone);
        assert!(cfg.notify_sound);
    }

    /// 启动恢复链路：旧版本持久化 JSON（仅 notifySound）→ 反序列化 → 提醒方式回退静音
    #[test]
    fn test_restore_from_legacy_json_notify_sound_false() {
        let json = r#"{"workMinutes":25,"shortBreakMinutes":5,"longBreakMinutes":15,"roundsBeforeLongBreak":4,"autoStartNext":false,"notifySound":false,"displayMode":"full"}"#;
        let config: PomodoroConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.effective_notify_sound(), PomodoroNotifySound::None);
        let state = PomodoroState::default();
        state.set_config(config);
        assert_eq!(
            state.config().effective_notify_sound(),
            PomodoroNotifySound::None
        );
    }
}
