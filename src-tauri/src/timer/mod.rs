//! General time tools: independently managed countdowns and stopwatches.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

const MAX_TIMERS: usize = 8;
const MAX_DURATION_SECS: u64 = 24 * 60 * 60;
const MAX_LABEL_CHARS: usize = 60;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimerKind { Countdown, Stopwatch }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerPayload {
    pub id: String, pub label: String, pub kind: TimerKind, pub duration_secs: u64,
    pub remaining_secs: u64, pub elapsed_secs: u64, pub running: bool, pub completed: bool,
    pub deadline_unix_ms: Option<i64>, pub started_unix_ms: Option<i64>, pub laps: Vec<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimersPayload { pub timers: Vec<TimerPayload> }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTimerInput { pub kind: TimerKind, #[serde(default)] pub label: String, #[serde(default)] pub duration_secs: u64 }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimerData {
    id: String, label: String, kind: TimerKind, duration_secs: u64, remaining_secs: u64,
    elapsed_secs: u64, running: bool, completed: bool, deadline_unix_ms: Option<i64>, started_unix_ms: Option<i64>, #[serde(default)] laps: Vec<u64>, #[serde(default)] last_lap_elapsed_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedTimers { #[serde(default = "default_version")] version: u8, #[serde(default)] next_id: u64, #[serde(default)] timers: Vec<TimerData> }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyTimer { duration_secs: u64, remaining_secs: u64, running: bool, completed: bool, deadline_unix_ms: Option<i64> }

fn default_version() -> u8 { 3 }
struct StateData { next_id: u64, timers: Vec<TimerData> }
pub struct TimerState { data: Mutex<StateData>, file_path: Option<PathBuf> }

impl Default for TimerState {
    fn default() -> Self {
        Self { data: Mutex::new(StateData { next_id: 2, timers: vec![countdown("timer-1".to_string(), "倒计时".to_string(), 300)] }), file_path: None }
    }
}

fn countdown(id: String, label: String, duration_secs: u64) -> TimerData {
    let duration_secs = duration_secs.clamp(1, MAX_DURATION_SECS);
    TimerData { id, label, kind: TimerKind::Countdown, duration_secs, remaining_secs: duration_secs, elapsed_secs: 0, running: false, completed: false, deadline_unix_ms: None, started_unix_ms: None, laps: Vec::new(), last_lap_elapsed_secs: 0 }
}

fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_millis().min(i64::MAX as u128) as i64).unwrap_or(0) }

fn clean_label(value: String, kind: TimerKind) -> String {
    let label: String = value.trim().chars().take(MAX_LABEL_CHARS).collect();
    if label.is_empty() { match kind { TimerKind::Countdown => "倒计时".to_string(), TimerKind::Stopwatch => "秒表".to_string() } } else { label }
}

fn elapsed_for(data: &TimerData) -> u64 {
    if data.kind == TimerKind::Stopwatch && data.running {
        data.elapsed_secs.saturating_add(data.started_unix_ms.map(|started| ((now_ms() - started).max(0) as u64) / 1000).unwrap_or(0))
    } else { data.elapsed_secs }
}

fn payload(data: &TimerData) -> TimerPayload {
    TimerPayload { id: data.id.clone(), label: data.label.clone(), kind: data.kind, duration_secs: data.duration_secs, remaining_secs: data.remaining_secs, elapsed_secs: elapsed_for(data), running: data.running, completed: data.completed, deadline_unix_ms: data.deadline_unix_ms, started_unix_ms: data.started_unix_ms, laps: data.laps.clone() }
}

impl TimerState {
    pub fn new() -> Self {
        let dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("levitaire");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("timer.json");
        let state = Self { file_path: Some(path.clone()), ..Self::default() };
        let raw = std::fs::read_to_string(&path).ok();
        let loaded = raw.as_deref().and_then(|value| serde_json::from_str::<PersistedTimers>(value).ok().filter(|saved| !saved.timers.is_empty())).or_else(|| {
            raw.as_deref().and_then(|value| serde_json::from_str::<LegacyTimer>(value).ok().map(|legacy| PersistedTimers {
                version: default_version(), next_id: 2, timers: vec![TimerData { deadline_unix_ms: legacy.deadline_unix_ms, running: legacy.running, completed: legacy.completed, remaining_secs: legacy.remaining_secs, ..countdown("timer-1".to_string(), "倒计时".to_string(), legacy.duration_secs) }],
            }))
        });
        if let Some(mut saved) = loaded {
            let legacy_cumulative_laps = saved.version < default_version();
            saved.timers.truncate(MAX_TIMERS);
            if saved.timers.is_empty() { saved.timers.push(countdown("timer-1".to_string(), "倒计时".to_string(), 300)); }
            for timer in &mut saved.timers {
                timer.label = clean_label(timer.label.clone(), timer.kind);
                timer.duration_secs = timer.duration_secs.clamp(1, MAX_DURATION_SECS);
                timer.remaining_secs = timer.remaining_secs.min(MAX_DURATION_SECS);
                if legacy_cumulative_laps && timer.kind == TimerKind::Stopwatch {
                    let mut previous = 0;
                    for lap in &mut timer.laps {
                        let cumulative = *lap;
                        *lap = cumulative.saturating_sub(previous);
                        previous = cumulative;
                    }
                }
                if timer.last_lap_elapsed_secs == 0 {
                    timer.last_lap_elapsed_secs = timer.laps.iter().copied().sum();
                }
                restore_timer(timer);
            }
            let mut data = state.data.lock().expect("timer state poisoned");
            data.next_id = saved.next_id.max(2);
            data.timers = saved.timers;
        }
        state
    }

    fn persist(&self, data: &StateData) {
        let Some(path) = &self.file_path else { return; };
        let saved = PersistedTimers { version: default_version(), next_id: data.next_id, timers: data.timers.clone() };
        if let Ok(raw) = serde_json::to_vec_pretty(&saved) {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, raw).is_ok() { let _ = std::fs::rename(tmp, path); }
        }
    }

    pub fn payload(&self) -> TimersPayload {
        let data = self.data.lock().expect("timer state poisoned");
        TimersPayload { timers: data.timers.iter().map(payload).collect() }
    }

    pub fn create(&self, input: CreateTimerInput) -> Result<TimersPayload, String> {
        let mut data = self.data.lock().map_err(|_| "计时器状态不可用".to_string())?;
        if data.timers.len() >= MAX_TIMERS { return Err(format!("最多只能创建 {} 个计时器", MAX_TIMERS)); }
        let id = format!("timer-{}", data.next_id); data.next_id = data.next_id.saturating_add(1);
        let label = clean_label(input.label, input.kind);
        let timer = match input.kind {
            TimerKind::Countdown => countdown(id, label, input.duration_secs.max(300)),
        TimerKind::Stopwatch => TimerData { id, label, kind: TimerKind::Stopwatch, duration_secs: 0, remaining_secs: 0, elapsed_secs: 0, running: false, completed: false, deadline_unix_ms: None, started_unix_ms: None, laps: Vec::new(), last_lap_elapsed_secs: 0 },
        };
        data.timers.push(timer); self.persist(&data);
        Ok(TimersPayload { timers: data.timers.iter().map(payload).collect() })
    }

    pub fn delete(&self, id: &str) -> Result<TimersPayload, String> {
        let mut data = self.data.lock().map_err(|_| "计时器状态不可用".to_string())?;
        if data.timers.len() == 1 { return Err("请至少保留一个计时器".to_string()); }
        let original = data.timers.len(); data.timers.retain(|timer| timer.id != id);
        if data.timers.len() == original { return Err("计时器不存在".to_string()); }
        self.persist(&data); Ok(TimersPayload { timers: data.timers.iter().map(payload).collect() })
    }

    pub fn set_duration(&self, id: &str, seconds: u64) -> Result<TimersPayload, String> {
        self.with_timer(id, |timer| {
            if timer.kind != TimerKind::Countdown { return Err("秒表不能设置倒计时长度".to_string()); }
            if timer.running { return Err("请暂停后再修改时长".to_string()); }
            timer.duration_secs = seconds.clamp(1, MAX_DURATION_SECS); timer.remaining_secs = timer.duration_secs; timer.completed = false; Ok(())
        })
    }

    pub fn rename(&self, id: &str, label: String) -> Result<TimersPayload, String> {
        self.with_timer(id, |timer| { timer.label = clean_label(label, timer.kind); Ok(()) })
    }

    pub fn add_lap(&self, id: &str) -> Result<TimersPayload, String> {
        self.with_timer(id, |timer| {
            if timer.kind != TimerKind::Stopwatch { return Err("只有秒表支持分段记录".to_string()); }
            if !timer.running { return Err("请先开始秒表再记录分段".to_string()); }
            if timer.laps.len() >= 99 { return Err("最多保留 99 条分段记录".to_string()); }
            let elapsed = elapsed_for(timer);
            let lap = elapsed.saturating_sub(timer.last_lap_elapsed_secs);
            timer.laps.push(lap);
            timer.last_lap_elapsed_secs = elapsed;
            Ok(())
        })
    }

    pub fn start(&self, id: &str) -> Result<TimersPayload, String> {
        self.with_timer(id, |timer| {
            if timer.running { return Ok(()); }
            let now = now_ms();
            match timer.kind {
                TimerKind::Countdown => { if timer.remaining_secs == 0 && timer.completed { timer.remaining_secs = timer.duration_secs; timer.completed = false; } timer.deadline_unix_ms = Some(now.saturating_add(timer.remaining_secs as i64 * 1000)); }
                TimerKind::Stopwatch => timer.started_unix_ms = Some(now),
            }
            timer.running = true; Ok(())
        })
    }

    pub fn pause(&self, id: &str) -> Result<TimersPayload, String> {
        self.with_timer(id, |timer| {
            update_running_timer(timer);
            if timer.kind == TimerKind::Stopwatch {
                timer.elapsed_secs = timer.elapsed_secs.saturating_add(timer.started_unix_ms.map(|started| ((now_ms() - started).max(0) as u64) / 1000).unwrap_or(0));
            } else if timer.remaining_secs == 0 {
                timer.completed = true;
            }
            timer.running = false; timer.deadline_unix_ms = None; timer.started_unix_ms = None; Ok(())
        })
    }

    pub fn reset(&self, id: &str) -> Result<TimersPayload, String> {
        self.with_timer(id, |timer| {
            timer.running = false; timer.completed = false; timer.deadline_unix_ms = None; timer.started_unix_ms = None;
            match timer.kind { TimerKind::Countdown => timer.remaining_secs = timer.duration_secs, TimerKind::Stopwatch => { timer.elapsed_secs = 0; timer.laps.clear(); timer.last_lap_elapsed_secs = 0; } }
            Ok(())
        })
    }

    pub fn add_seconds(&self, id: &str, seconds: u64) -> Result<TimersPayload, String> {
        self.with_timer(id, |timer| {
            if timer.kind != TimerKind::Countdown { return Err("只能为倒计时加时".to_string()); }
            let amount = seconds.clamp(1, 60 * 60);
            if timer.running { timer.deadline_unix_ms = timer.deadline_unix_ms.map(|deadline| deadline.saturating_add(amount as i64 * 1000)); }
            else { timer.remaining_secs = timer.remaining_secs.saturating_add(amount).min(MAX_DURATION_SECS); timer.duration_secs = timer.duration_secs.max(timer.remaining_secs); timer.completed = false; }
            Ok(())
        })
    }

    /// Pause every running timer when the tool is disabled. This preserves
    /// elapsed/remaining time while preventing hidden timers from firing alerts.
    pub fn pause_all(&self) -> TimersPayload {
        let mut data = self.data.lock().expect("timer state poisoned");
        for timer in &mut data.timers {
            if !timer.running { continue; }
            update_running_timer(timer);
            if timer.kind == TimerKind::Stopwatch {
                timer.elapsed_secs = elapsed_for(timer);
            } else if timer.remaining_secs == 0 {
                timer.completed = true;
            }
            timer.running = false;
            timer.deadline_unix_ms = None;
            timer.started_unix_ms = None;
        }
        self.persist(&data);
        TimersPayload { timers: data.timers.iter().map(payload).collect() }
    }

    fn with_timer<F>(&self, id: &str, operation: F) -> Result<TimersPayload, String> where F: FnOnce(&mut TimerData) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|_| "计时器状态不可用".to_string())?;
        let timer = data.timers.iter_mut().find(|timer| timer.id == id).ok_or_else(|| "计时器不存在".to_string())?;
        operation(timer)?; self.persist(&data); Ok(TimersPayload { timers: data.timers.iter().map(payload).collect() })
    }

    fn tick(&self) -> (bool, Vec<String>) {
        let mut data = self.data.lock().expect("timer state poisoned");
        let mut changed = false; let mut completed = Vec::new();
        for timer in &mut data.timers {
            if !timer.running { continue; }
            let was_completed = timer.completed; update_running_timer(timer);
            if timer.kind == TimerKind::Countdown && timer.remaining_secs == 0 {
                timer.running = false; timer.completed = true; timer.deadline_unix_ms = None;
                if !was_completed { completed.push(timer.label.clone()); }
            }
            changed = true;
        }
        if !completed.is_empty() { self.persist(&data); }
        (changed, completed)
    }
}

fn restore_timer(timer: &mut TimerData) {
    if !timer.running { return; }
    match timer.kind {
        TimerKind::Countdown => { update_running_timer(timer); if timer.remaining_secs == 0 { timer.running = false; timer.completed = true; timer.deadline_unix_ms = None; } }
        TimerKind::Stopwatch => update_running_timer(timer),
    }
}

fn update_running_timer(timer: &mut TimerData) {
    let now = now_ms();
    match timer.kind {
        TimerKind::Countdown => { timer.remaining_secs = timer.deadline_unix_ms.map(|deadline| ((deadline - now).max(0) as u64) / 1000).unwrap_or(timer.remaining_secs); }
        TimerKind::Stopwatch => {}
    }
}

pub fn start_scheduler(app: AppHandle) {
    std::thread::spawn(move || loop {
        if let Some(state) = app.try_state::<TimerState>() {
            let (changed, completed) = state.tick();
            if changed { let _ = app.emit("timers-changed", state.payload()); }
            if !completed.is_empty() {
                let reminders_enabled = app.try_state::<crate::config::ConfigManager>()
                    .and_then(|config| config.get_timer_reminders_enabled().ok())
                    .unwrap_or(true);
                let sound_enabled = app.try_state::<crate::config::ConfigManager>()
                    .and_then(|config| config.get_timer_reminder_sound().ok())
                    .map(|sound| sound != "none")
                    .unwrap_or(true);
                if reminders_enabled {
                    if sound_enabled { crate::sound::play_tone(); }
                    for label in completed { let _ = app.notification().builder().title("倒计时结束").body(&label).show(); }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn default_has_one_idle_countdown() { let state = TimerState::default(); let payload = state.payload(); assert_eq!(payload.timers.len(), 1); assert_eq!(payload.timers[0].remaining_secs, 300); }
    #[test] fn create_supports_stopwatch_and_countdown() { let state = TimerState::default(); state.create(CreateTimerInput { kind: TimerKind::Stopwatch, label: "Study".to_string(), duration_secs: 0 }).unwrap(); let payload = state.payload(); assert_eq!(payload.timers.len(), 2); assert_eq!(payload.timers[1].kind, TimerKind::Stopwatch); }
    #[test] fn countdown_reset_restores_configured_duration() { let state = TimerState::default(); state.set_duration("timer-1", 42).unwrap(); state.start("timer-1").unwrap(); state.reset("timer-1").unwrap(); assert_eq!(state.payload().timers[0].remaining_secs, 42); }
    #[test] fn cannot_delete_the_only_timer() { let state = TimerState::default(); assert!(state.delete("timer-1").is_err()); }
    #[test] fn lap_requires_a_running_stopwatch() {
        let state = TimerState::default();
        let id = state.create(CreateTimerInput { kind: TimerKind::Stopwatch, label: String::new(), duration_secs: 0 }).unwrap().timers[1].id.clone();
        assert!(state.add_lap(&id).is_err());
        state.start(&id).unwrap();
        state.add_lap(&id).unwrap();
        assert_eq!(state.payload().timers[1].laps.len(), 1);
    }
    #[test] fn rename_normalizes_empty_labels() { let state = TimerState::default(); state.rename("timer-1", " ".to_string()).unwrap(); assert_eq!(state.payload().timers[0].label, "倒计时"); }

    #[test]
    fn old_cumulative_laps_convert_to_intervals() {
        let mut previous: u64 = 0;
        let mut laps: Vec<u64> = vec![10, 25, 40];
        for lap in &mut laps {
            let cumulative = *lap;
            *lap = cumulative.saturating_sub(previous);
            previous = cumulative;
        }
        assert_eq!(laps, vec![10, 15, 15]);
        assert_eq!(previous, 40);
    }

    #[test]
    fn pause_all_stops_running_timers() {
        let state = TimerState::default();
        state.start("timer-1").unwrap();
        let payload = state.pause_all();
        assert!(!payload.timers[0].running);
        assert!(payload.timers[0].deadline_unix_ms.is_none());
    }
}
