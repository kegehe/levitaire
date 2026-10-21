//! Manual vertical scrolling capture. The worker owns raw frames and the final
//! BGRA image so large captures never travel through the webview as base64.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, Manager};
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT};

const MAX_LONG_CAPTURE_PIXELS: u64 = 30_000_000;
// Sample at a bounded cadence while the user is scrolling. A pure debounce
// would keep extending its deadline for every wheel message, so continuous
// scrolling would produce only one frame after the user stopped.
// Keep adjacent frames close enough that ordinary touchpad/wheel bursts still
// leave a visible overlap. The capture itself runs off the hook thread.
const SAMPLE_INTERVAL: Duration = Duration::from_millis(30);

#[derive(Clone, Copy, Debug)]
pub struct CaptureRegion {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
}

impl CaptureRegion {
    pub fn contains(self, x: i32, y: i32) -> bool {
        x >= self.left
            && y >= self.top
            && x < self.left.saturating_add(self.width as i32)
            && y < self.top.saturating_add(self.height as i32)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongCaptureSummary {
    pub result_id: u64,
    pub width: u32,
    pub height: u32,
    pub frame_count: u32,
    pub status: String,
    pub message: Option<String>,
}

struct StoredResult {
    width: u32,
    height: u32,
    frame_count: u32,
    status: CaptureStatus,
    message: Option<String>,
    bgra_chunks: VecDeque<Vec<u8>>,
    bgra_len: usize,
    row_signatures: Vec<u64>,
}

impl StoredResult {
    fn from_initial(width: u32, height: u32, initial: Vec<u8>) -> Self {
        let bgra_len = initial.len();
        let row_signatures = frame_row_signatures(&initial, width);
        let mut bgra_chunks = VecDeque::new();
        bgra_chunks.push_back(initial);
        Self {
            width,
            height,
            frame_count: 1,
            status: CaptureStatus::Capturing,
            message: None,
            bgra_chunks,
            bgra_len,
            row_signatures,
        }
    }

    fn materialize(&self) -> Vec<u8> {
        let mut pixels = Vec::with_capacity(self.bgra_len);
        for chunk in &self.bgra_chunks {
            pixels.extend_from_slice(chunk);
        }
        pixels
    }

    fn starts_with(&self, data: &[u8]) -> bool {
        if data.len() > self.bgra_len {
            return false;
        }
        let mut offset = 0;
        for chunk in &self.bgra_chunks {
            if offset == data.len() {
                break;
            }
            let take = (data.len() - offset).min(chunk.len());
            if chunk.get(..take) != data.get(offset..offset + take) {
                return false;
            }
            offset += take;
        }
        offset == data.len()
    }

    fn ends_with(&self, data: &[u8]) -> bool {
        if data.len() > self.bgra_len {
            return false;
        }
        let mut remaining = data.len();
        for chunk in self.bgra_chunks.iter().rev() {
            if remaining == 0 {
                break;
            }
            let take = remaining.min(chunk.len());
            let chunk_start = chunk.len() - take;
            let data_start = remaining - take;
            if chunk.get(chunk_start..) != data.get(data_start..remaining) {
                return false;
            }
            remaining -= take;
        }
        remaining == 0
    }

    /// 合并一帧时可以跳过的行数（见 [`reusable_rows`] 的规则）。
    fn reuse_rows(&self, rows: &[u64], direction: i8) -> usize {
        reusable_rows(rows, &self.row_signatures, direction)
    }

    fn summary(&self, result_id: u64) -> LongCaptureSummary {
        LongCaptureSummary {
            result_id,
            width: self.width,
            height: self.height,
            frame_count: self.frame_count,
            status: self.status.as_str().to_string(),
            message: self.message.clone(),
        }
    }
}

const MIN_REVISIT_ROWS: usize = 3;

/// 合并一帧时，能安全跳过的行数。
///
/// 1. 整段 candidate 正好贴在拼接边上 → 无论多短都跳过（与 HEAD 之前那版
///    starts_with / ends_with 的行为一致；HEAD 那版对 <3 行返回 0，会把 1、2 行的
///    微滚动重复追加。贴边重复行本身内容相同，跳过不会丢可见内容）。
/// 2. 整段 candidate 出现在成图别处 → 只有达到 MIN_REVISIT_ROWS 才跳过；
///    太短的片段在空白行 / 重复表格行里太容易误命中。
/// 3. 只匹配到一部分时，只信任贴着拼接边的那一段（向下=成图尾部，向上=成图头部），
///    且同样要求至少 MIN_REVISIT_ROWS 行。否则宁可全部追加 —— 凭一次中间匹配
///    就少追加几行，会直接丢掉用户新看到的内容。
fn reusable_rows(candidate: &[u64], stitched: &[u64], direction: i8) -> usize {
    if candidate.is_empty() || stitched.is_empty() {
        return 0;
    }
    let edge_match = if direction < 0 {
        candidate.len() <= stitched.len() && candidate == &stitched[..candidate.len()]
    } else {
        candidate.len() <= stitched.len()
            && candidate == &stitched[stitched.len() - candidate.len()..]
    };
    if edge_match {
        return candidate.len();
    }
    if candidate.len() >= MIN_REVISIT_ROWS && contains_run(stitched, candidate) {
        return candidate.len();
    }
    let max_len = candidate.len().min(stitched.len());
    for length in (MIN_REVISIT_ROWS..=max_len).rev() {
        let anchored = if direction < 0 {
            // 向上滚动：新行接在成图头部，能跳过的只能是 candidate 的尾部
            candidate[candidate.len() - length..] == stitched[..length]
        } else {
            // 向下滚动：新行接在成图尾部，能跳过的只能是 candidate 的头部
            stitched[stitched.len() - length..] == candidate[..length]
        };
        if anchored {
            return length;
        }
    }
    0
}

/// candidate 是否作为连续片段出现在 stitched 中。
fn contains_run(stitched: &[u64], candidate: &[u64]) -> bool {
    candidate.len() >= MIN_REVISIT_ROWS
        && stitched.len() >= candidate.len()
        && stitched
            .windows(candidate.len())
            .any(|window| window == candidate)
}

fn frame_row_signatures(frame: &[u8], width: u32) -> Vec<u64> {
    let row_bytes = width as usize * 4;
    if row_bytes == 0 {
        return Vec::new();
    }
    frame
        .chunks_exact(row_bytes)
        .map(|row| {
            // 每 4 个像素取 1 个：这是“这一行是否相似”的廉价指纹，不承诺逐像素
            // 一致。reusable_rows 只在整段命中或贴边时跳过，采样碰撞要影响结果
            // 需要整段候选都撞上，概率远低于单行误判。
            row.chunks_exact(4)
                .step_by(4)
                .fold(1469598103934665603u64, |hash, pixel| {
                    pixel[..3].iter().fold(hash, |hash, byte| {
                        hash ^ u64::from(*byte).wrapping_mul(1099511628211)
                    })
                })
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CaptureStatus {
    Capturing,
    Partial,
    Completed,
}

impl CaptureStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Capturing => "capturing",
            Self::Partial => "partial",
            Self::Completed => "completed",
        }
    }
}

struct ActiveCapture {
    result_id: u64,
    region: CaptureRegion,
    target_hwnd: isize,
    sender: mpsc::Sender<WorkerCommand>,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
}

enum WorkerCommand {
    /// direction: 1 for downward scrolling, -1 for upward scrolling, 0 for
    /// keyboard/activity sampling where the direction is unknown.
    Wheel {
        direction: i8,
    },
    Stop(mpsc::Sender<()>),
    Cancel(mpsc::Sender<()>),
}

#[derive(Default)]
pub struct LongCaptureState {
    next_id: AtomicU64,
    active: Mutex<Option<ActiveCapture>>,
    results: Arc<Mutex<HashMap<u64, StoredResult>>>,
}

impl LongCaptureState {
    pub fn is_active(&self) -> bool {
        self.active
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }

    pub fn owns_result(&self, result_id: u64) -> bool {
        self.active
            .lock()
            .map(|guard| {
                guard
                    .as_ref()
                    .is_some_and(|active| active.result_id == result_id)
            })
            .unwrap_or(false)
    }

    pub fn start(
        &self,
        app: tauri::AppHandle,
        region: CaptureRegion,
        target_hwnd: isize,
    ) -> Result<LongCaptureSummary, String> {
        validate_region(region)?;
        let mut active = self.active.lock().map_err(|e| e.to_string())?;
        if active.is_some() {
            return Err("已有长截图正在进行".into());
        }

        // Keep the result store bounded. A new capture replaces an unclosed
        // preview from an earlier session rather than retaining another 30MP
        // allocation indefinitely.
        self.results.lock().map_err(|e| e.to_string())?.clear();

        let initial = crate::screenshot::capture_screen_region(
            region.left,
            region.top,
            region.width,
            region.height,
        )?;
        let result_id = self.next_id.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
        let result = StoredResult::from_initial(region.width, region.height, initial.clone());
        self.results
            .lock()
            .map_err(|e| e.to_string())?
            .insert(result_id, result);

        let (sender, receiver) = mpsc::channel();
        let results = Arc::clone(&self.results);
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let worker_cancelled = Arc::clone(&cancelled);
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                worker_loop(
                    result_id,
                    app.clone(),
                    region,
                    initial,
                    receiver,
                    results,
                    worker_cancelled,
                )
            }));
            if result.is_err() {
                crate::utils::logger::log(
                    "long-capture",
                    &format!("worker panicked result_id={}", result_id),
                );
                // A panic bypasses the normal Stop/Cancel command path. Clear
                // the active session and retained pixels so the next capture
                // is not permanently blocked by a dead worker.
                if let Some(state) = app.try_state::<LongCaptureState>() {
                    state.clear_failed_worker(result_id);
                }
            }
        });
        *active = Some(ActiveCapture {
            result_id,
            region,
            target_hwnd,
            sender,
            cancelled,
        });
        self.status(result_id)
    }

    pub fn notify_wheel(&self, x: i32, y: i32, delta: i16) {
        if delta == 0 {
            return;
        }
        let direction = if delta < 0 { 1 } else { -1 };
        let Ok(active) = self.active.lock() else {
            return;
        };
        if let Some(active) = active
            .as_ref()
            .filter(|active| activity_belongs_to_capture(active, x, y))
        {
            crate::utils::logger::log(
                "long-capture",
                &format!("wheel accepted at ({},{}) delta={}", x, y, delta),
            );
            let _ = active.sender.send(WorkerCommand::Wheel { direction });
        } else {
            crate::utils::logger::log(
                "long-capture",
                &format!(
                    "wheel ignored at ({},{}) delta={} (outside capture target)",
                    x, y, delta
                ),
            );
        }
    }

    pub fn notify_activity(&self, x: i32, y: i32) {
        let Ok(active) = self.active.lock() else {
            return;
        };
        if let Some(active) = active
            .as_ref()
            .filter(|active| activity_belongs_to_capture(active, x, y))
        {
            let _ = active.sender.send(WorkerCommand::Wheel { direction: 0 });
        }
    }

    pub fn notify_activity_at_cursor(&self) {
        let mut point = windows::Win32::Foundation::POINT::default();
        if unsafe { windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut point) }.is_ok() {
            self.notify_activity(point.x, point.y);
        }
    }

    pub fn stop(&self, result_id: u64) -> Result<LongCaptureSummary, String> {
        let sender = {
            let active = self.active.lock().map_err(|e| e.to_string())?;
            let active = active
                .as_ref()
                .filter(|active| active.result_id == result_id)
                .ok_or_else(|| "会话已过期".to_string())?;
            active.sender.clone()
        };
        let (done_tx, done_rx) = mpsc::channel();
        sender
            .send(WorkerCommand::Stop(done_tx))
            .map_err(|_| "长截图采集线程已停止".to_string())?;
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "等待长截图最后一帧超时".to_string())?;
        let mut active = self.active.lock().map_err(|e| e.to_string())?;
        if active
            .as_ref()
            .is_some_and(|active| active.result_id == result_id)
        {
            active.take();
        }
        self.status(result_id)
    }

    pub fn cancel(&self, result_id: u64) -> Result<(), String> {
        let active = self.take_active(result_id)?;
        active
            .cancelled
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let (done_tx, done_rx) = mpsc::channel();
        if active.sender.send(WorkerCommand::Cancel(done_tx)).is_ok() {
            let _ = done_rx.recv_timeout(Duration::from_secs(5));
        }
        self.results
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&result_id);
        Ok(())
    }

    pub fn cancel_active(&self) {
        let active = self.active.lock().ok().and_then(|mut guard| guard.take());
        if let Some(active) = active {
            active
                .cancelled
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let (done_tx, done_rx) = mpsc::channel();
            if active.sender.send(WorkerCommand::Cancel(done_tx)).is_ok() {
                // Wait for an in-flight capture before cleanup hides the controls.
                // The cancellation flag also prevents a late capture from showing it.
                let _ = done_rx.recv_timeout(Duration::from_secs(5));
            }
            if let Ok(mut results) = self.results.lock() {
                results.remove(&active.result_id);
            }
        }
    }

    pub fn status(&self, result_id: u64) -> Result<LongCaptureSummary, String> {
        self.results
            .lock()
            .map_err(|e| e.to_string())?
            .get(&result_id)
            .map(|result| result.summary(result_id))
            .ok_or_else(|| "长截图结果不存在或已释放".to_string())
    }

    /// 取出原始像素与尺寸（虚拟桌面物理坐标下的完整结果）。
    /// 调用方自行释放锁后编码——`get_long_capture_preview` 正是据此把 PNG 编码
    /// 移出主线程，避免大图编码阻塞窗口事件循环。
    /// 结果已由 MAX_LONG_CAPTURE_PIXELS 约束，直接返回原始像素而非缩略图，
    /// 预览/保存/复制共用同一份 raw 结果。
    pub fn raw(&self, result_id: u64) -> Result<(Vec<u8>, u32, u32), String> {
        let results = self.results.lock().map_err(|e| e.to_string())?;
        let result = results
            .get(&result_id)
            .ok_or_else(|| "长截图结果不存在或已释放".to_string())?;
        Ok((result.materialize(), result.width, result.height))
    }

    pub fn dimensions(&self, result_id: u64) -> Result<(u32, u32), String> {
        let results = self.results.lock().map_err(|e| e.to_string())?;
        let result = results
            .get(&result_id)
            .ok_or_else(|| "长截图结果不存在或已释放".to_string())?;
        Ok((result.width, result.height))
    }

    pub fn discard_all(&self) {
        if let Ok(mut results) = self.results.lock() {
            results.clear();
        }
    }

    pub fn discard(&self, result_id: u64) {
        if let Ok(mut results) = self.results.lock() {
            results.remove(&result_id);
        }
    }

    fn take_active(&self, result_id: u64) -> Result<ActiveCapture, String> {
        let mut active = self.active.lock().map_err(|e| e.to_string())?;
        match active.take() {
            Some(active) if active.result_id == result_id => Ok(active),
            Some(other) => {
                *active = Some(other);
                Err("长截图会话已过期".into())
            }
            None => Err("没有进行中的长截图会话".into()),
        }
    }

    fn clear_failed_worker(&self, result_id: u64) {
        if let Ok(mut active) = self.active.lock() {
            if active
                .as_ref()
                .is_some_and(|capture| capture.result_id == result_id)
            {
                active.take();
            }
        }
        if let Ok(mut results) = self.results.lock() {
            results.remove(&result_id);
        }
    }
}

fn activity_belongs_to_capture(active: &ActiveCapture, x: i32, y: i32) -> bool {
    // The pointer may be over a child window or a scrollbar whose root HWND
    // differs from the foreground snapshot. The fixed capture region is the
    // authoritative interaction boundary, so accept activity inside it first.
    if active.region.contains(x, y) {
        return true;
    }
    if active.target_hwnd == 0 {
        return false;
    }
    point_belongs_to_target(active.target_hwnd, x, y)
}

fn point_belongs_to_target(target_hwnd: isize, x: i32, y: i32) -> bool {
    if target_hwnd == 0 {
        return false;
    }
    let point = POINT { x, y };
    let window = unsafe { WindowFromPoint(point) };
    if window.0.is_null() {
        return false;
    }
    let root = unsafe { GetAncestor(window, GA_ROOT) };
    let root = if root.0.is_null() { window } else { root };
    root.0 as isize == target_hwnd
}

fn validate_region(region: CaptureRegion) -> Result<(), String> {
    if region.width == 0 || region.height == 0 || region.width > 32_768 || region.height > 32_768 {
        return Err("长截图区域尺寸无效".into());
    }
    if u64::from(region.width) * u64::from(region.height) > MAX_LONG_CAPTURE_PIXELS {
        return Err("长截图区域像素过大".into());
    }
    Ok(())
}

fn worker_loop(
    result_id: u64,
    app: tauri::AppHandle,
    region: CaptureRegion,
    mut previous: Vec<u8>,
    receiver: mpsc::Receiver<WorkerCommand>,
    results: Arc<Mutex<HashMap<u64, StoredResult>>>,
    _cancelled: Arc<std::sync::atomic::AtomicBool>,
) {
    let mut pending = false;
    let mut deadline = Instant::now();
    let mut pending_direction: i8 = 1;
    loop {
        let timeout = if pending {
            deadline.saturating_duration_since(Instant::now())
        } else {
            Duration::from_secs(24 * 60 * 60)
        };
        match receiver.recv_timeout(timeout) {
            Ok(WorkerCommand::Wheel { direction }) => {
                // Capture at most once per interval, even if the user keeps
                // spinning the wheel. This preserves intermediate content
                // instead of waiting for a quiet period that may never come.
                if pending && Instant::now() >= deadline {
                    capture_and_merge(
                        result_id,
                        &app,
                        region,
                        &mut previous,
                        &results,
                        pending_direction,
                    );
                }
                pending = true;
                if direction != 0 {
                    pending_direction = direction;
                }
                if deadline <= Instant::now() {
                    deadline = Instant::now() + SAMPLE_INTERVAL;
                }
            }
            Ok(WorkerCommand::Stop(done)) => {
                crate::utils::logger::log(
                    "long-capture",
                    &format!("worker stop requested result_id={}", result_id),
                );
                // Always sample once at completion. The last timer tick may
                // have happened before the target finished its scroll
                // animation, and a duplicate frame is safely ignored.
                capture_and_merge(
                    result_id,
                    &app,
                    region,
                    &mut previous,
                    &results,
                    pending_direction,
                );
                set_completed(result_id, &results);
                crate::utils::logger::log(
                    "long-capture",
                    &format!("worker stop completed result_id={}", result_id),
                );
                let _ = done.send(());
                break;
            }
            Ok(WorkerCommand::Cancel(done)) => {
                let _ = done.send(());
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) if pending => {
                pending = false;
                capture_and_merge(
                    result_id,
                    &app,
                    region,
                    &mut previous,
                    &results,
                    pending_direction,
                );
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

fn capture_and_merge(
    result_id: u64,
    app: &tauri::AppHandle,
    region: CaptureRegion,
    previous: &mut Vec<u8>,
    results: &Arc<Mutex<HashMap<u64, StoredResult>>>,
    direction: i8,
) {
    // The frame remains visible while sampling, so the border does not flash.
    let captured = crate::screenshot::capture_screen_region(
        region.left,
        region.top,
        region.width,
        region.height,
    );
    let current = match captured {
        Ok(frame) => frame,
        Err(error) => {
            set_partial(result_id, results, format!("抓取新画面失败: {error}"));
            return;
        }
    };
    let current_rows = frame_row_signatures(&current, region.width);
    // For upward movement, reverse the comparison: the current frame's bottom
    // overlaps the previous frame's top, so the unique rows belong before the
    // accumulated image rather than after it.
    let overlap = if direction < 0 {
        find_overlap(&current, previous, region.width, region.height)
    } else {
        find_overlap(previous, &current, region.width, region.height)
    };
    match overlap {
        Overlap::Duplicate => {}
        Overlap::Found(overlap) => {
            let add_rows = region.height.saturating_sub(overlap);
            let mut results_guard = match results.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            let Some(result) = results_guard.get_mut(&result_id) else {
                return;
            };
            let candidate_rows = if direction < 0 {
                &current_rows[..add_rows as usize]
            } else {
                &current_rows[overlap as usize..]
            };
            let reused_rows = result.reuse_rows(candidate_rows, direction);
            let rows_to_add = add_rows.saturating_sub(reused_rows as u32);
            if rows_to_add == 0 {
                previous.clone_from(&current);
                return;
            }
            let new_height = match result.height.checked_add(rows_to_add) {
                Some(value)
                    if u64::from(value) * u64::from(result.width) <= MAX_LONG_CAPTURE_PIXELS =>
                {
                    value
                }
                _ => {
                    result.status = CaptureStatus::Partial;
                    result.message = Some("已达到长截图 30MP 上限，结果已保留".into());
                    return;
                }
            };
            let row_bytes = region.width as usize * 4;
            let unique_bytes = rows_to_add as usize * row_bytes;
            let start = if direction < 0 {
                rows_to_add as usize * row_bytes
            } else {
                (overlap as usize + reused_rows) * row_bytes
            };
            if direction < 0 {
                let Some(prefix) = current.get(..start) else {
                    set_partial(result_id, results, "长截图帧数据不完整".into());
                    return;
                };
                result.bgra_chunks.push_front(prefix.to_vec());
                result
                    .row_signatures
                    .splice(0..0, current_rows[..rows_to_add as usize].iter().copied());
            } else {
                result
                    .bgra_chunks
                    .push_back(current.get(start..).unwrap_or_default().to_vec());
                result
                    .row_signatures
                    .extend_from_slice(&current_rows[overlap as usize + reused_rows..]);
            }
            result.bgra_len += unique_bytes;
            result.height = new_height;
            result.frame_count += 1;
            previous.clone_from(&current);
        }
        Overlap::NoMatch => {
            let message = "滚动过快，未能识别相邻画面的重叠区域；请放慢滚动速度";
            set_partial(result_id, results, message.into());
            let _ = app.emit(
                "long-capture-warning",
                serde_json::json!({
                    "resultId": result_id,
                    "message": message,
                }),
            );
            // Keep the last reliable frame as the reference. Replacing it
            // with an unmatched fast-scroll frame would make recovery
            // impossible even after the user slows down.
        }
    }
}

fn set_partial(result_id: u64, results: &Arc<Mutex<HashMap<u64, StoredResult>>>, message: String) {
    if let Ok(mut results) = results.lock() {
        if let Some(result) = results.get_mut(&result_id) {
            result.status = CaptureStatus::Partial;
            result.message = Some(message);
        }
    }
}

fn set_completed(result_id: u64, results: &Arc<Mutex<HashMap<u64, StoredResult>>>) {
    if let Ok(mut results) = results.lock() {
        if let Some(result) = results.get_mut(&result_id) {
            if result.status == CaptureStatus::Capturing {
                result.status = CaptureStatus::Completed;
            }
        }
    }
}

enum Overlap {
    Duplicate,
    Found(u32),
    NoMatch,
}

fn find_overlap(previous: &[u8], current: &[u8], width: u32, height: u32) -> Overlap {
    let max_overlap = height.saturating_sub(1);
    if max_overlap == 0 {
        return if overlap_score(previous, current, width, height, height) <= 5 {
            Overlap::Duplicate
        } else {
            Overlap::NoMatch
        };
    }
    // Smooth touchpad/browser scrolling can advance by only one pixel. Keep
    // the search range valid for small but otherwise legal selections too.
    let min_overlap = (height / 20).max(1).min(max_overlap);
    let mut best: Option<(u32, u32)> = None;
    for overlap in min_overlap..=max_overlap {
        let score = overlap_score(previous, current, width, height, overlap);
        if best
            .map(|(_, best_score)| score < best_score)
            .unwrap_or(true)
        {
            best = Some((overlap, score));
        }
    }
    let full_frame_score = overlap_score(previous, current, width, height, height);
    match best {
        // A static frame may contain minor rendering noise. It is a duplicate
        // only when shifting the candidate does not improve that whole-frame
        // score; otherwise a one-pixel scroll gets incorrectly discarded.
        Some((_, score)) if full_frame_score <= 5 && score >= full_frame_score => {
            Overlap::Duplicate
        }
        Some((overlap, score)) if score <= 14 => Overlap::Found(overlap),
        _ => Overlap::NoMatch,
    }
}

fn overlap_score(previous: &[u8], current: &[u8], width: u32, height: u32, overlap: u32) -> u32 {
    // Do not let the ignored side margin consume a narrow capture entirely.
    // The command accepts any non-zero width, including a one-pixel region.
    let margin = (width / 12).min(width.saturating_sub(1) / 2);
    let usable_width = width.saturating_sub(margin * 2).max(1);
    let mut total = 0u64;
    let mut count = 0u64;
    for sample_y in 0..12u32 {
        let y = sample_y * overlap.saturating_sub(1) / 11;
        let previous_y = height - overlap + y;
        for sample_x in 0..10u32 {
            let x = margin + sample_x * usable_width.saturating_sub(1) / 9;
            let a = luma(previous, width, previous_y, x);
            let b = luma(current, width, y, x);
            total += a.abs_diff(b) as u64;
            count += 1;
        }
    }
    (total / count.max(1)) as u32
}

fn luma(data: &[u8], width: u32, y: u32, x: u32) -> u8 {
    let index = ((y as usize * width as usize) + x as usize) * 4;
    let b = data[index] as u16;
    let g = data[index + 1] as u16;
    let r = data[index + 2] as u16;
    ((r * 77 + g * 150 + b * 29) >> 8) as u8
}

pub(crate) fn encode_png_direct(bgra: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let expected = usize::try_from(u64::from(width) * u64::from(height) * 4)
        .map_err(|_| "PNG 尺寸溢出".to_string())?;
    if bgra.len() != expected {
        return Err("像素数据长度与尺寸不匹配".to_string());
    }
    let mut rgba = bgra.to_vec();
    for pixel in rgba.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    let image = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| "构造 PNG 图像失败".to_string())?;
    let mut output = Vec::new();
    image::DynamicImage::ImageRgba8(image)
        .write_to(
            &mut std::io::Cursor::new(&mut output),
            image::ImageFormat::Png,
        )
        .map_err(|error| format!("PNG 编码失败: {error}"))?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: u32, rows: &[u8]) -> Vec<u8> {
        rows.iter()
            .flat_map(|value| std::iter::repeat_n([*value, *value, *value, 255], width as usize))
            .flatten()
            .collect()
    }

    #[test]
    fn finds_vertical_overlap() {
        let previous = frame(32, &(0..80).collect::<Vec<_>>());
        let current = frame(32, &(30..110).collect::<Vec<_>>());
        assert!(matches!(
            find_overlap(&previous, &current, 32, 80),
            Overlap::Found(50)
        ));
    }

    #[test]
    fn finds_reverse_vertical_overlap() {
        // When moving upward, the new frame is before the previous frame and
        // its bottom rows overlap the previous frame's top rows.
        let current = frame(32, &(0..80).collect::<Vec<_>>());
        let previous = frame(32, &(30..110).collect::<Vec<_>>());
        assert!(matches!(
            find_overlap(&current, &previous, 32, 80),
            Overlap::Found(50)
        ));
    }

    #[test]
    fn duplicate_does_not_append() {
        let image = frame(32, &(0..80).collect::<Vec<_>>());
        assert!(matches!(
            find_overlap(&image, &image, 32, 80),
            Overlap::Duplicate
        ));
    }

    #[test]
    fn overlap_handles_a_one_pixel_wide_frame() {
        let previous = frame(1, &(0..40).collect::<Vec<_>>());
        let current = frame(1, &(10..50).collect::<Vec<_>>());
        assert!(matches!(
            find_overlap(&previous, &current, 1, 40),
            Overlap::Found(30)
        ));
    }

    #[test]
    fn overlap_accepts_a_one_pixel_scroll_delta() {
        let previous = frame(32, &(0..80).collect::<Vec<_>>());
        let current = frame(32, &(1..81).collect::<Vec<_>>());
        assert!(matches!(
            find_overlap(&previous, &current, 32, 80),
            Overlap::Found(79)
        ));
    }

    #[test]
    fn overlap_supports_small_capture_heights() {
        let previous = frame(8, &[0, 1, 2]);
        let current = frame(8, &[1, 2, 3]);
        assert!(matches!(
            find_overlap(&previous, &current, 8, 3),
            Overlap::Found(2)
        ));
    }

    #[test]
    fn stored_result_chunks_preserve_edges_and_materialize_order() {
        let mut result = StoredResult::from_initial(1, 1, vec![1, 2, 3, 4]);
        result.bgra_chunks.push_front(vec![9, 8, 7, 6]);
        result.bgra_chunks.push_back(vec![5, 4, 3, 2]);
        result.bgra_len += 8;

        assert!(result.starts_with(&[9, 8, 7, 6]));
        assert!(result.ends_with(&[5, 4, 3, 2]));
        assert_eq!(
            result.materialize(),
            vec![9, 8, 7, 6, 1, 2, 3, 4, 5, 4, 3, 2]
        );
    }

    #[test]
    fn reusable_rows_only_trusts_full_or_anchored_matches() {
        let stitched = [0u64, 1, 2, 3, 4, 5, 6, 7];

        // 整段已存在（哪怕在成图中间）：可以整段跳过，因为不会追加任何东西
        assert_eq!(reusable_rows(&[3, 4, 5], &stitched, 1), 3);

        // 1 行贴边（微滚动）仍要跳过，避免复制一行；只在中间出现则不跳过
        assert_eq!(reusable_rows(&[7], &stitched, 1), 1);
        assert_eq!(reusable_rows(&[3], &stitched, 1), 0);

        // 向下滚动：只有 candidate 的前缀贴着成图尾部时，才允许部分跳过
        assert_eq!(reusable_rows(&[5, 6, 7, 8], &stitched, 1), 3);
        // 只在中间撞上（不是尾部）→ 一行都不跳，全部追加
        assert_eq!(reusable_rows(&[3, 4, 5, 9], &stitched, 1), 0);

        // 向上滚动：只有 candidate 的后缀贴着成图头部时，才允许部分跳过
        assert_eq!(reusable_rows(&[9, 9, 0, 1, 2], &stitched, -1), 3);
        assert_eq!(reusable_rows(&[1, 2, 3, 9], &stitched, -1), 0);
    }

    #[test]
    fn repeated_rows_in_the_middle_do_not_swallow_new_rows() {
        // 成图中间有一段 8 行相同内容（空白行 / 重复表格行在真实页面很常见）。
        let mut stitched: Vec<u64> = (0..30).collect();
        for slot in &mut stitched[8..16] {
            *slot = 999;
        }

        // 新内容恰好以 3 行相同内容开头，但这 3 行只出现在成图中间。
        // 旧实现会在整图里任意位置匹配，跳过 3 行 → 丢内容；现在必须全部追加。
        assert_eq!(reusable_rows(&[999, 999, 999, 41, 42, 43], &stitched, 1), 0);
    }
}
