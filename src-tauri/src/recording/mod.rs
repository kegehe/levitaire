//! 录屏模块：GIF / 视频录制引擎。
//! 流式 GIF 编码（边录边写 GifEncoder），内存峰值仅单帧 + 输出缓冲。
//! 视频录制通过 ffmpeg 子进程 pipe 编码 MP4。

pub mod gif_encoder;
pub mod video_encoder;
pub mod window_detect;

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine as _;
use tauri::{Emitter, Manager};

// ─── 录制模式 ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum RecordMode {
    Gif,
    Video,
}

// ─── 录制区域（物理坐标） ──────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RecordRegion {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
}

// ─── 编码完成的结果 ───────────────────────────────────────────────

#[derive(Debug)]
#[allow(dead_code)]
pub struct RecordResult {
    pub data: Vec<u8>,
    pub base64: String,
    pub file_path: Option<String>,
    pub frame_count: u32,
    pub width: u32,
    pub height: u32,
    pub mode: RecordMode,
}

// ─── overlay 窗口截屏辅助 ─────────────────────────────────────────
// 录制期间排除 overlay UI 的方案：前端将选区框的 border 改为 outline（向外延伸），
// outline 在遮罩区域内（录制区域外），BitBlt 不会截到。遮罩和控制面板本身也
// 在录制区域外。因此后端无需干预，直接截屏即可。

// ─── 录制状态（Tauri managed state） ──────────────────────────────

#[derive(Default)]
pub struct RecordingState {
    /// 录制是否进行中
    running: AtomicBool,
    /// Recording has stopped, but its encoder is still producing output.
    finishing: AtomicBool,
    /// 是否暂停
    paused: AtomicBool,
    /// 停止后编码阶段是否被用户取消
    cancel_requested: AtomicBool,
    /// 录制代次（stop 时递增，使旧线程作废）
    generation: AtomicU64,
    /// 录制模式
    mode: Mutex<Option<RecordMode>>,
    /// 录制区域
    region: Mutex<Option<RecordRegion>>,
    /// 帧率
    fps: AtomicU32,
    /// 最大录制时长（秒）
    max_duration_sec: AtomicU32,
    /// 已捕获帧数
    frame_count: AtomicU64,
    /// 录制开始时间
    start_time: Mutex<Option<Instant>>,
    /// 暂停累计时间
    paused_duration: Mutex<Duration>,
    /// 暂停开始时刻
    pause_start: Mutex<Option<Instant>>,
    /// 编码完成的数据
    result: Mutex<Option<RecordResult>>,
}

impl RecordingState {
    /// 开始录制
    pub fn start(
        &self,
        app: &tauri::AppHandle,
        region: RecordRegion,
        mode: RecordMode,
        fps: u32,
        max_duration_sec: u32,
    ) -> Result<(), String> {
        if self.finishing.load(Ordering::SeqCst)
            || self
                .running
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
        {
            return Err("录制已在进行中".into());
        }

        *self.region.lock().map_err(|e| e.to_string())? = Some(region);
        *self.mode.lock().map_err(|e| e.to_string())? = Some(mode);
        self.fps.store(fps, Ordering::SeqCst);
        self.max_duration_sec
            .store(max_duration_sec, Ordering::SeqCst);
        self.frame_count.store(0, Ordering::SeqCst);
        self.paused.store(false, Ordering::SeqCst);
        self.finishing.store(false, Ordering::SeqCst);
        self.cancel_requested.store(false, Ordering::SeqCst);
        *self.start_time.lock().map_err(|e| e.to_string())? = Some(Instant::now());
        *self.paused_duration.lock().map_err(|e| e.to_string())? = Duration::ZERO;
        *self.pause_start.lock().map_err(|e| e.to_string())? = None;

        self.clear_result()?;

        let gen = self.generation.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
        let app_handle = app.clone();

        match mode {
            RecordMode::Gif => {
                std::thread::spawn(move || {
                    gif_recording_loop(app_handle, gen);
                });
            }
            RecordMode::Video => {
                std::thread::spawn(move || {
                    video_recording_loop(app_handle, gen);
                });
            }
        }

        Ok(())
    }

    /// 暂停录制
    pub fn pause(&self) -> Result<(), String> {
        if !self.running.load(Ordering::SeqCst) {
            return Err("未在录制中".into());
        }
        if self.paused.swap(true, Ordering::SeqCst) {
            return Ok(()); // 已暂停，幂等
        }
        *self.pause_start.lock().map_err(|e| e.to_string())? = Some(Instant::now());
        Ok(())
    }

    /// 恢复录制
    pub fn resume(&self) -> Result<(), String> {
        if !self.running.load(Ordering::SeqCst) {
            return Err("未在录制中".into());
        }
        if !self.paused.swap(false, Ordering::SeqCst) {
            return Ok(()); // 未暂停，幂等
        }
        if let Some(pause_start) = self
            .pause_start
            .lock()
            .map_err(|e| e.to_string())?
            .take()
        {
            let paused = pause_start.elapsed();
            *self.paused_duration.lock().map_err(|e| e.to_string())? += paused;
        }
        Ok(())
    }

    /// 停止录制（编码完成后产生结果）
    pub fn stop(&self) -> Result<(), String> {
        if !self.running.load(Ordering::SeqCst) {
            return Err("未在录制中".into());
        }
        // 递增 generation 使录制循环退出
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.running.store(false, Ordering::SeqCst);
        self.finishing.store(true, Ordering::SeqCst);
        // 如果正在暂停，恢复以让循环退出
        if self.paused.swap(false, Ordering::SeqCst) {
            if let Some(pause_start) = self
                .pause_start
                .lock()
                .map_err(|e| e.to_string())?
                .take()
            {
                *self.paused_duration.lock().map_err(|e| e.to_string())? += pause_start.elapsed();
            }
        }
        Ok(())
    }

    /// 取消录制（直接丢弃，不编码）
    pub fn cancel(&self) -> Result<(), String> {
        self.cancel_requested.store(true, Ordering::SeqCst);
        if self.running.load(Ordering::SeqCst) {
            self.stop()?;
        } else {
            self.generation.fetch_add(1, Ordering::SeqCst);
            self.paused.store(false, Ordering::SeqCst);
        }
        self.finishing.store(false, Ordering::SeqCst);
        self.clear_result()?;
        Ok(())
    }

    pub fn cancel_requested(&self) -> bool {
        self.cancel_requested.load(Ordering::SeqCst)
    }

    fn clear_result(&self) -> Result<(), String> {
        let previous = self.result.lock().map_err(|e| e.to_string())?.take();
        if let Some(result) = previous {
            if let Some(path) = result.file_path {
                let _ = std::fs::remove_file(path);
            }
        }
        Ok(())
    }

    /// 是否正在录制
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// 是否暂停中
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    pub fn is_finishing(&self) -> bool {
        self.finishing.load(Ordering::SeqCst)
    }

    /// Stop a failed worker only when it still owns the active generation.
    pub fn fail_generation(&self, gen: u64) -> bool {
        if self
            .generation
            .compare_exchange(
                gen,
                gen.wrapping_add(1),
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
        {
            self.running.store(false, Ordering::SeqCst);
            self.paused.store(false, Ordering::SeqCst);
            self.finishing.store(false, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    pub fn finish_encoding(&self) {
        self.finishing.store(false, Ordering::SeqCst);
    }

    /// 计算已录制时长（毫秒），扣除暂停时间
    pub fn elapsed_ms(&self) -> u64 {
        let start_opt = self.start_time.lock().ok();
        let Some(start_guard) = start_opt else { return 0 };
        let Some(start) = start_guard.as_ref() else { return 0 };

        let paused_dur = self
            .paused_duration
            .lock()
            .ok()
            .map(|g| *g)
            .unwrap_or(Duration::ZERO);

        let mut elapsed = start.elapsed();

        // 如果当前处于暂停状态，减去本次暂停已经过的时间
        if self.paused.load(Ordering::SeqCst) {
            if let Ok(ps_guard) = self.pause_start.lock() {
                if let Some(ps) = *ps_guard {
                    elapsed = elapsed.saturating_sub(ps.elapsed());
                }
            }
        }

        elapsed.saturating_sub(paused_dur).as_millis() as u64
    }

    /// 获取已捕获帧数
    pub fn frame_count(&self) -> u64 {
        self.frame_count.load(Ordering::SeqCst)
    }

    /// 获取录制区域
    pub fn get_region(&self) -> Option<RecordRegion> {
        self.region.lock().ok().and_then(|g| g.clone())
    }

    /// 获取录制模式
    pub fn get_mode(&self) -> Option<RecordMode> {
        self.mode.lock().ok().and_then(|g| *g)
    }

    /// 获取帧率
    pub fn get_fps(&self) -> u32 {
        self.fps.load(Ordering::SeqCst)
    }

    /// 获取录制结果
    #[allow(dead_code)]
    pub fn take_result(&self) -> Option<RecordResult> {
        self.result.lock().ok().and_then(|mut g| g.take())
    }
}

// ─── BGRA → RGBA 转换 ────────────────────────────────────────────

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

fn gif_frame_delay_ms(actual: Duration, fallback_ms: u32) -> u32 {
    let elapsed_ms = actual.as_millis().min(10_000) as u32;
    if elapsed_ms < 10 {
        fallback_ms
    } else {
        elapsed_ms
    }
}

// ─── GIF 流式录制循环 ─────────────────────────────────────────────

fn gif_recording_loop(app: tauri::AppHandle, gen: u64) {
    let state = match app.try_state::<RecordingState>() {
        Some(s) => s,
        None => return,
    };

    let region = match state.get_region() {
        Some(r) => r,
        None => {
            let _ = app.emit(
                "recording-progress",
                serde_json::json!({ "type": "error", "message": "录制区域未设置" }),
            );
            return;
        }
    };

    let fps = state.get_fps().max(5).min(30);
    let frame_interval = Duration::from_millis(1000 / fps as u64);
    let max_frames = (fps * state.max_duration_sec.load(Ordering::SeqCst)).max(10).min(600);

    // Large captures prioritize responsiveness over palette precision. NeuQuant's
    // highest sample factor is substantially faster for full-screen GIFs.
    let encoder_speed = if u64::from(region.width) * u64::from(region.height) >= 1280 * 720 {
        30
    } else {
        10
    };
    let mut gif_buf = std::io::Cursor::new(Vec::new());
    let mut encoder = image::codecs::gif::GifEncoder::new_with_speed(&mut gif_buf, encoder_speed);
    encoder
        .set_repeat(image::codecs::gif::Repeat::Infinite)
        .ok();

    // GIF 延迟：frame_delay_ms = 1000 / fps
    let frame_delay_ms = 1000u32 / fps;

    let mut frame_count: u32 = 0;
    let mut last_capture = Instant::now();
    // Hold one frame so its duration can use the actual interval to the next capture.
    let mut pending_frame: Option<(image::RgbaImage, Instant)> = None;

    crate::utils::logger::log(
        "recording",
        &format!(
            "GIF 录制开始: region=({},{}) {}x{}, fps={}, max_frames={}",
            region.left, region.top, region.width, region.height, fps, max_frames
        ),
    );

    while state.running.load(Ordering::SeqCst)
        && state.generation.load(Ordering::SeqCst) == gen
        && frame_count < max_frames
    {
        // 暂停时等待
        if state.paused.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(50));
            last_capture = Instant::now(); // 恢复后重置计时
            continue;
        }

        // 帧率控制
        let elapsed = last_capture.elapsed();
        if elapsed < frame_interval {
            std::thread::sleep(frame_interval - elapsed);
        }
        let captured_at = Instant::now();
        last_capture = captured_at;

        // 捕获屏幕区域
        // 前端已将选区框 border 改为 outline（向外延伸到遮罩区域），
        // 遮罩和控制面板在录制区域外，BitBlt 不会截到 overlay UI
        match crate::screenshot::capture_screen_region(
            region.left,
            region.top,
            region.width,
            region.height,
        ) {
            Ok(bgra) => {
                // BGRA → RGBA → Frame → encode → 释放
                let rgba = bgra_to_rgba(&bgra);
                if let Some(img) =
                    image::RgbaImage::from_raw(region.width, region.height, rgba)
                {
                    // 构建 GIF 帧，使用 Delay::from_numer_denom_ms 设置帧延迟
                    if let Some((previous_img, previous_captured_at)) = pending_frame.take() {
                        let delay = image::Delay::from_numer_denom_ms(
                            gif_frame_delay_ms(captured_at.duration_since(previous_captured_at), frame_delay_ms),
                            1,
                        );
                        let frame = image::Frame::from_parts(previous_img, 0, 0, delay);

                        if encoder.encode_frame(frame).is_err() {
                        crate::utils::logger::log("recording", "GIF 编码帧失败");
                        }
                    }
                    pending_frame = Some((img, captured_at));
                }

                frame_count += 1;
                let count = state.frame_count.fetch_add(1, Ordering::SeqCst) + 1;

                // 推送进度事件
                let _ = app.emit(
                    "recording-progress",
                    serde_json::json!({
                        "type": "frame",
                        "frameCount": count,
                        "elapsedMs": state.elapsed_ms(),
                    }),
                );
            }
            Err(e) => {
                crate::utils::logger::log("recording", &format!("capture failed: {}", e));
                // 单帧失败不终止，跳过继续
            }
        }
    }

    if state.cancel_requested() {
        return;
    }

    if let Some((last_img, last_captured_at)) = pending_frame.take() {
        let delay = image::Delay::from_numer_denom_ms(
            gif_frame_delay_ms(last_captured_at.elapsed(), frame_delay_ms),
            1,
        );
        let frame = image::Frame::from_parts(last_img, 0, 0, delay);
        if encoder.encode_frame(frame).is_err() {
            crate::utils::logger::log("recording", "GIF final frame encoding failed");
        }
    }

    // A cancellation may arrive while the final GIF frame is being encoded.
    if state.cancel_requested()
        || state.generation.load(Ordering::SeqCst) > gen.wrapping_add(1)
    {
        return;
    }

    crate::utils::logger::log(
        "recording",
        &format!("GIF 录制结束，共 {} 帧，开始编码", frame_count),
    );

    // 仅在 generation 未被 stop/cancel 修改时递增并清除 running
    // 防止覆盖新录制的 running=true
    if state.generation.compare_exchange(
        gen,
        gen.wrapping_add(1),
        Ordering::SeqCst,
        Ordering::SeqCst,
    )
    .is_ok()
    {
        state.running.store(false, Ordering::SeqCst);
        state.finishing.store(true, Ordering::SeqCst);
    }

    if frame_count == 0 {
        let _ = app.emit(
            "recording-progress",
            serde_json::json!({
                "type": "error",
                "message": "未捕获到任何帧",
            }),
        );
        state.finish_encoding();
        return;
    }

    // 通知前端开始编码
    let _ = app.emit(
        "recording-progress",
        serde_json::json!({
            "type": "encoding",
            "frameCount": frame_count,
        }),
    );

    // drop encoder 刷新缓冲区
    drop(encoder);

    let gif_bytes = gif_buf.into_inner();

    crate::utils::logger::log(
        "recording",
        &format!("GIF 编码完成: {} 字节", gif_bytes.len()),
    );

    let b64 = base64::engine::general_purpose::STANDARD.encode(&gif_bytes);
    let gif_bytes_len = gif_bytes.len();
    if let Ok(mut guard) = state.result.lock() {
        *guard = Some(RecordResult {
            data: gif_bytes,
            base64: b64.clone(),
            file_path: None,
            frame_count,
            width: region.width,
            height: region.height,
            mode: RecordMode::Gif,
        });
    }

    let _ = app.emit(
        "recording-progress",
        serde_json::json!({
            "type": "done",
            "gifBase64": b64,
            "frameCount": frame_count,
            "width": region.width,
            "height": region.height,
            "sizeBytes": gif_bytes_len,
            "elapsedMs": state.elapsed_ms(),
        }),
    );
    state.finish_encoding();
}

// ─── 视频录制循环（ffmpeg pipe） ──────────────────────────────────

fn video_recording_loop(app: tauri::AppHandle, gen: u64) {
    let state = match app.try_state::<RecordingState>() {
        Some(s) => s,
        None => return,
    };

    let region = match state.get_region() {
        Some(r) => r,
        None => {
            let _ = app.emit(
                "recording-progress",
                serde_json::json!({ "type": "error", "message": "录制区域未设置" }),
            );
            return;
        }
    };

    let fps = state.get_fps().max(10).min(60);

    crate::utils::logger::log(
        "recording",
        &format!(
            "video thread entered gen={}, region=({},{}) {}x{}, fps={}",
            gen, region.left, region.top, region.width, region.height, fps
        ),
    );

    // 临时输出文件
    let temp_dir = std::env::temp_dir().join("floast-recording");
    let _ = std::fs::create_dir_all(&temp_dir);
    let output_path = temp_dir.join(format!("recording_{}.mp4", gen));

    crate::utils::logger::log(
        "recording",
        &format!("starting ffmpeg output={}", output_path.to_string_lossy()),
    );

    let mut ffmpeg_candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        ffmpeg_candidates.push(resource_dir.join("ffmpeg.exe"));
        ffmpeg_candidates.push(resource_dir.join("binaries").join("ffmpeg.exe"));
        ffmpeg_candidates.push(resource_dir.join("ffmpeg-x86_64-pc-windows-msvc.exe"));
    }

    let mut ffmpeg = match video_encoder::FfmpegEncoder::new(
        region.width,
        region.height,
        fps,
        &output_path,
        &ffmpeg_candidates,
    ) {
        Ok(e) => e,
        Err(e) => {
            if !state.fail_generation(gen) {
                return;
            }
            let _ = app.emit(
                "recording-progress",
                serde_json::json!({
                    "type": "error",
                    "message": format!("启动 ffmpeg 失败: {}", e),
                }),
            );
            return;
        }
    };

    crate::utils::logger::log("recording", "ffmpeg started");

    let frame_interval = Duration::from_millis(1000 / fps as u64);
    let max_frames = (fps * state.max_duration_sec.load(Ordering::SeqCst)).max(10).min(600);
    let mut frame_count: u32 = 0;
    let mut write_error: Option<String> = None;
    let mut last_capture = Instant::now();

    crate::utils::logger::log(
        "recording",
        &format!(
            "视频录制开始: region=({},{}) {}x{}, fps={}, max_frames={}",
            region.left, region.top, region.width, region.height, fps, max_frames
        ),
    );

    while state.running.load(Ordering::SeqCst)
        && state.generation.load(Ordering::SeqCst) == gen
        && frame_count < max_frames
    {
        if state.paused.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(50));
            last_capture = Instant::now();
            continue;
        }

        let elapsed = last_capture.elapsed();
        if elapsed < frame_interval {
            std::thread::sleep(frame_interval - elapsed);
        }
        last_capture = Instant::now();

        // 捕获屏幕区域
        // 前端已将选区框 border 改为 outline（向外延伸到遮罩区域），
        // 遮罩和控制面板在录制区域外，BitBlt 不会截到 overlay UI
        match crate::screenshot::capture_screen_region(
            region.left,
            region.top,
            region.width,
            region.height,
        ) {
            Ok(bgra) => {
                if let Err(e) = ffmpeg.write_frame(&bgra) {
                    crate::utils::logger::log(
                        "recording",
                        &format!("ffmpeg write frame failed: {}", e),
                    );
                    write_error = Some(e);
                    break;
                }
                frame_count += 1;
                let count = state.frame_count.fetch_add(1, Ordering::SeqCst) + 1;
                let _ = app.emit(
                    "recording-progress",
                    serde_json::json!({
                        "type": "frame",
                        "frameCount": count,
                        "elapsedMs": state.elapsed_ms(),
                    }),
                );
            }
            Err(e) => {
                crate::utils::logger::log("recording", &format!("capture failed: {}", e));
            }
        }
    }

    if let Some(error) = write_error {
        let _ = ffmpeg.finish(Duration::from_secs(5));
        let _ = std::fs::remove_file(&output_path);
        if !state.fail_generation(gen) {
            return;
        }
        let _ = app.emit(
            "recording-progress",
            serde_json::json!({ "type": "error", "message": format!("ffmpeg 写入失败: {}", error) }),
        );
        return;
    }

    // 仅在 generation 未被 stop/cancel 修改时递增并清除 running
    if state.generation.compare_exchange(
        gen,
        gen.wrapping_add(1),
        Ordering::SeqCst,
        Ordering::SeqCst,
    )
    .is_ok()
    {
        state.running.store(false, Ordering::SeqCst);
        state.finishing.store(true, Ordering::SeqCst);
    }

    if frame_count == 0 {
        let _ = ffmpeg.finish(Duration::from_secs(5));
        let _ = std::fs::remove_file(&output_path);
        let _ = app.emit(
            "recording-progress",
            serde_json::json!({ "type": "error", "message": "未捕获到任何帧" }),
        );
        state.finish_encoding();
        return;
    }

    if state.cancel_requested()
        || state.generation.load(Ordering::SeqCst) > gen.wrapping_add(1)
    {
        let _ = ffmpeg.finish(Duration::from_secs(5));
        let _ = std::fs::remove_file(&output_path);
        return;
    }

    let _ = app.emit(
        "recording-progress",
        serde_json::json!({ "type": "encoding", "frameCount": frame_count }),
    );

    // 关闭 ffmpeg 并等待编码完成
    if let Err(e) = ffmpeg.finish_with_cancel(Duration::from_secs(30), || {
        state.cancel_requested()
            || state.generation.load(Ordering::SeqCst) > gen.wrapping_add(1)
    }) {
        let _ = std::fs::remove_file(&output_path);
        if state.cancel_requested()
            || state.generation.load(Ordering::SeqCst) > gen.wrapping_add(1)
        {
            return;
        }
        let _ = app.emit(
            "recording-progress",
            serde_json::json!({ "type": "error", "message": format!("ffmpeg 编码失败: {}", e) }),
        );
        state.finish_encoding();
        return;
    }

    if state.cancel_requested()
        || state.generation.load(Ordering::SeqCst) > gen.wrapping_add(1)
    {
        let _ = std::fs::remove_file(&output_path);
        return;
    }

    let video_bytes_len = std::fs::metadata(&output_path)
        .map(|m| m.len() as usize)
        .unwrap_or(0);
    let video_path = output_path.to_string_lossy().to_string();

    crate::utils::logger::log(
        "recording",
        &format!("视频编码完成: {} 字节", video_bytes_len),
    );

    if let Ok(mut guard) = state.result.lock() {
        *guard = Some(RecordResult {
            data: Vec::new(),
            base64: String::new(),
            file_path: Some(video_path.clone()),
            frame_count,
            width: region.width,
            height: region.height,
            mode: RecordMode::Video,
        });
    }

    let _ = app.emit(
        "recording-progress",
        serde_json::json!({
            "type": "done",
            "videoPath": video_path,
            "frameCount": frame_count,
            "width": region.width,
            "height": region.height,
            "sizeBytes": video_bytes_len,
            "elapsedMs": state.elapsed_ms(),
        }),
    );
    state.finish_encoding();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gif_frame_delay_uses_the_actual_capture_interval() {
        assert_eq!(gif_frame_delay_ms(Duration::from_millis(1_500), 100), 1_500);
        assert_eq!(gif_frame_delay_ms(Duration::ZERO, 100), 100);
    }

    #[test]
    fn failed_generation_releases_the_recording_state() {
        let state = RecordingState::default();
        state.running.store(true, Ordering::SeqCst);
        state.finishing.store(true, Ordering::SeqCst);

        assert!(state.fail_generation(0));
        assert!(!state.is_running());
        assert!(!state.is_finishing());
        assert!(!state.fail_generation(0));
    }
}
