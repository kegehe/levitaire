//! 在线更新后端：后台周期检测 → **静默下载** → 就绪后提示用户一键安装。
//!
//! 用户视角的完整流程：
//! 1. 启动后延迟 5s 检查一次 `latest.json`，之后每 24h 复检（检查失败 60s 后重试）。
//! 2. 发现新版本**不打扰用户**：不弹窗、不问询，直接在后台把安装包下完、验签、落盘。
//!    进度只通过 `update-status` 事件对外播报（设置页开着时才看得见）。
//! 3. 安装包就绪后才创建/显示右上角提示窗，用户点「立即更新」即可安装 ——
//!    此时不需要再联网，**本次运行内断网也能装**（`install_update` 只读本地缓存包）。
//!    ⚠️ 边界（插件 API 限制，不是本地状态能绕过的）：就绪态只在内存里 ——
//!    `Update` 的 `config` 字段是私有的，插件没有提供「离线构造 `Update`」的入口，
//!    因此**重启后必须先联网成功 `check()` 一次**才会重新认出磁盘上那个包
//!    （走 `adopt_cached`，不会再下载）。断网重启时更新不会被提供出来。
//! 4. 「稍后」只隐藏提示窗并记下版本号（本次运行不再提示），安装包保留；
//!    下次启动标记自然清空，会重新提示。
//!
//! 与「检测到就弹窗、点了才下载」的旧实现相比，差别只在两点：下载提前到就绪之前
//! 并在后台完成；安装退化成「读本地包 + 验签 + 交给安装器」。
//!
//! dev 模式（未发布、updater 未初始化）下 check() 会抛错，此处一律静默
//! 吞掉，不阻塞启动、不弹窗、不崩溃。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 后台周期检测间隔（24h）
const UPDATE_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// 启动时网络尚未就绪、代理初始化等导致检查失败时，不能直接等待下一个 24h 周期。
/// 保持应用运行即可在一分钟后自动重试；成功后恢复常规检查间隔。
const FAILED_CHECK_RETRY_INTERVAL: Duration = Duration::from_secs(60);
/// 静默下载中断（断网、代理抖动）后的重试间隔。
///
/// 刻意比检查失败长得多：安装包约 96MB，按 60s 重试会在弱网下反复吃掉带宽，
/// 而用户完全看不见这条后台链路，无从判断"它在刷流量"。
const FAILED_DOWNLOAD_RETRY_INTERVAL: Duration = Duration::from_secs(30 * 60);
/// 应用启动后首次延迟（秒），给应用/网络就绪留余量
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(5);
/// 建立连接的超时：网络不可达、代理未启动时快速失败，避免长时间挂起
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 读空闲超时：相邻数据块间隔超过该值即判定连接已失效。
/// 这里用 read_timeout 而非整体超时，避免大安装包在慢速链路上被误杀。
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// 进度上报的字节粒度：仅在服务端没给 `Content-Length` 时用作兜底刻度
const PROGRESS_REPORT_STEP_BYTES: u64 = 1024 * 1024;

/// 更新流程阶段。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdatePhase {
    /// 没有待处理的更新
    #[default]
    Idle,
    /// 正在后台静默下载安装包
    Downloading,
    /// 已下载、已验签、已落盘，等待用户点击安装
    Ready,
    /// 检查 / 下载 / 安装失败（静默期不打扰用户，只在设置页可见）
    Failed,
}

/// 更新状态快照。提示窗与设置页读同一份数据，避免两处各记一套状态。
#[derive(Clone, Debug, Default, Serialize)]
pub struct UpdateStatus {
    /// 目标版本号（检测到新版本后即有值）
    pub version: Option<String>,
    /// 该版本的更新说明
    pub notes: String,
    pub phase: UpdatePhase,
    /// 已接收字节数（`downloading` 阶段有意义）
    pub received: u64,
    /// 总字节数（服务端未给出 `Content-Length` 时为 None）
    pub total: Option<u64>,
    /// 失败原因（`failed` 阶段有意义）
    pub error: Option<String>,
}

/// 可变状态：快照 + 已就绪的更新对象。
///
/// 两块信息必须**同锁同改**：`ready` 是快照里 `phase == Ready` 的凭据，分开成两个
/// Mutex 就可能出现「快照说已就绪、但取不出安装对象」的错位（本仓库在
/// `monitorWorkAreaRef` 上踩过同类双轨失同步的坑）。
#[derive(Default)]
struct UpdaterInner {
    status: UpdateStatus,
    /// 已完成下载、验签并落盘的更新对象。
    ///
    /// 留着它有两个用途：① 安装时无需再联网取官方签名与安装参数；
    /// ② 安装前用它携带的签名复核磁盘上那份安装包（见 `install_update`）。
    ready: Option<Update>,
}

/// 全局更新状态
#[derive(Default)]
pub struct UpdaterState {
    inner: Mutex<UpdaterInner>,
    /// 本次运行已忽略的版本号（该版本本次运行不再弹提示窗；安装包保留）
    dismissed_version: Mutex<Option<String>>,
    /// 安装是否已在途 —— **跨窗口**的重入闸门。
    ///
    /// `Update::install` 会先写临时文件、再 `ShellExecuteW` 拉起安装器，最后才
    /// `exit(0)`：中间有 1~3 秒的窗口期。三个入口（提示窗 / 设置页 / 托盘菜单）
    /// 各自只挡得住**本窗口**的重复点击（局部 state / ref），挡不住「点完提示窗
    /// 立刻右键托盘再点一次」，于是可能同时拉起两个安装器装同一个包。
    installing: AtomicBool,
}

/// 取锁时忽略 poison。
///
/// 本状态的临界区只是读写几个字段，不存在需要感知的中间态；若因别处 panic 令锁被
/// poison，继续用 `lock().unwrap()` 会让此后**所有**更新命令连带 panic（状态查询、
/// 忽略版本、下载安装全都会挂）。这里与 `sticky_note` 的取锁风格保持一致。
fn lock_ignore_poison<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 状态是否仍指向「该版本的下载中」。
///
/// 所有由**后台下载任务**写入的状态（进度、就绪、失败）都必须先过这一关：一次下载要跑
/// 几分钟，期间状态可能已被更新的版本接管，走完的旧任务不得再写终态。
fn is_current_download(status: &UpdateStatus, version: &str) -> bool {
    status.phase == UpdatePhase::Downloading && status.version.as_deref() == Some(version)
}

/// 「关闭 / 稍后」是否该记下版本号。
///
/// **只认已就绪态**：提示窗上的「关闭」在失败卡上也存在，若不看 phase 就记，
/// 一次下载失败后点「关闭」会把本轮的 30 分钟重试与 24 小时复检一并掐掉。
fn should_record_dismissal(status: &UpdateStatus) -> bool {
    status.phase == UpdatePhase::Ready && status.version.is_some()
}

/// 写入就绪态。`finish_download` 与 `adopt_cached` 共用，保证两条路径字段一致。
fn write_ready(inner: &mut UpdaterInner, version: &str, notes: &str, update: Update, total: u64) {
    inner.status = UpdateStatus {
        version: Some(version.to_string()),
        notes: notes.to_string(),
        phase: UpdatePhase::Ready,
        received: total,
        total: Some(total),
        error: None,
    };
    inner.ready = Some(update);
}

/// 写入失败态（保留更新说明与已接收字节，界面据此能显示「下到一半失败了」的语境）。
fn write_failed(inner: &mut UpdaterInner, version: &str, message: String) {
    let previous = std::mem::take(&mut inner.status);
    inner.ready = None;
    inner.status = UpdateStatus {
        version: Some(version.to_string()),
        notes: previous.notes,
        phase: UpdatePhase::Failed,
        received: previous.received,
        total: previous.total,
        error: Some(message),
    };
}

impl UpdaterState {
    fn snapshot(&self) -> UpdateStatus {
        lock_ignore_poison(&self.inner).status.clone()
    }

    /// 抢占「开始下载该版本」的权利，并切到下载态。
    ///
    /// 返回 `false` 表示同一个版本的下载已经在跑，调用方必须放弃（别再开第二条）。
    ///
    /// ⚠️ **判定与置位必须在同一把锁内**：周期检查和手动检查是两条并发路径
    /// （用户可能正好在后台下载时点「检查更新」，两个入口也可能同时点），
    /// 若先 `is_downloading()` 判断、出锁后再 `begin_download()`，
    /// 两条路径都能看到「没在下载」→ 同时下 96MB（白耗一份流量，且两个任务
    /// 写同一个 `.part`/rename 目标）。
    ///
    /// 换版本则放行（旧任务会被 `is_current_download` 的守卫挡在终态写入之外），
    /// 连同上一版已就绪的安装对象一起清掉。
    fn try_begin_download(&self, version: &str, notes: &str) -> bool {
        let mut inner = lock_ignore_poison(&self.inner);
        if is_current_download(&inner.status, version) {
            return false;
        }
        inner.ready = None;
        inner.status = UpdateStatus {
            version: Some(version.to_string()),
            notes: notes.to_string(),
            phase: UpdatePhase::Downloading,
            received: 0,
            total: None,
            error: None,
        };
        true
    }

    /// 上报下载进度。
    ///
    /// **只接受当前下载版本的回调**（同 `is_current_download`）：下载是后台任务，
    /// 换版本或失败复位后排空中的旧回调仍可能到达，直接写入就会把新版本的进度覆盖成旧值。
    fn report_progress(&self, version: &str, received: u64, total: Option<u64>) {
        let mut inner = lock_ignore_poison(&self.inner);
        if !is_current_download(&inner.status, version) {
            return;
        }
        inner.status.received = received;
        inner.status.total = total;
    }

    /// 下载完成、验签通过且已落盘 → 就绪态。
    ///
    /// **带版本守卫**：只有当状态仍指向本次下载的版本、且仍处于下载中时才写入；
    /// 返回 `true` 表示生效 —— 也就意味着该由本任务去弹提示窗。
    ///
    /// 为什么必须守卫：一次下载要跑几分钟，期间状态可能已经翻篇（发版途中服务端改口成
    /// 更新的版本，用户又点了一次「检查更新」，新版本的下载随即开始）。走完的旧任务若
    /// 照样写入，就会把正在下载的新版本按回旧版本；而新版本的进度回调会因版本不匹配被
    /// `report_progress` 丢弃 —— 用户看到「已就绪 v0.1.6」却永远等不到它下完。
    fn finish_download(&self, version: &str, notes: &str, update: Update, total: u64) -> bool {
        let mut inner = lock_ignore_poison(&self.inner);
        if !is_current_download(&inner.status, version) {
            return false;
        }
        write_ready(&mut inner, version, notes, update, total);
        true
    }

    /// 复用磁盘上已有的缓存包时直接进就绪态。
    ///
    /// 不加下载守卫：调用方刚 `check()` 过、并确认缓存里就是该版本的包，
    /// 此刻并没有「属于该版本的下载任务」在跑。
    fn adopt_cached(&self, version: &str, notes: &str, update: Update, total: u64) {
        let mut inner = lock_ignore_poison(&self.inner);
        write_ready(&mut inner, version, notes, update, total);
    }

    /// 下载失败（连接中断 / 缓存写不进去）。版本守卫同 `finish_download`。
    fn fail_download(&self, version: &str, message: String) -> bool {
        let mut inner = lock_ignore_poison(&self.inner);
        if !is_current_download(&inner.status, version) {
            return false;
        }
        write_failed(&mut inner, version, message);
        true
    }

    /// 安装准备失败（缓存包读不到 / 验签不过）。
    ///
    /// 守卫只要求「版本仍匹配」：这条路进来时状态是 `Ready`，不是 `Downloading`；
    /// 只要期间没有换成别的版本，就该把失败落在界面上（否则用户点重试也没线索）。
    fn fail_install(&self, version: &str, message: String) -> bool {
        let mut inner = lock_ignore_poison(&self.inner);
        if inner.status.version.as_deref() != Some(version) {
            return false;
        }
        write_failed(&mut inner, version, message);
        true
    }

    /// 复位到「无待处理更新」（本轮没有新版本时使用）。
    fn clear(&self) {
        let mut inner = lock_ignore_poison(&self.inner);
        inner.ready = None;
        inner.status = UpdateStatus::default();
    }

    /// 该版本是否已下载完成、可以安装
    fn is_ready_for(&self, version: &str) -> bool {
        let inner = lock_ignore_poison(&self.inner);
        inner.status.phase == UpdatePhase::Ready && inner.status.version.as_deref() == Some(version)
    }

    /// 状态里当前的目标版本号。
    ///
    /// 后台任务发现自己已被更新的版本取代时，用它作为 `prune_packages` 的 `keep`，
    /// 清掉自己刚写的那个包（别留 96MB 垃圾）而保住后来者的目标。
    fn current_version(&self) -> Option<String> {
        lock_ignore_poison(&self.inner).status.version.clone()
    }

    /// 取已就绪的更新对象（克隆而非移走：安装失败时它还要留在状态里供重试）
    fn ready_update(&self) -> Option<Update> {
        lock_ignore_poison(&self.inner).ready.clone()
    }

    fn dismissed(&self) -> Option<String> {
        lock_ignore_poison(&self.dismissed_version).clone()
    }

    fn set_dismissed(&self, version: Option<String>) {
        *lock_ignore_poison(&self.dismissed_version) = version;
    }

    /// 「本次运行不再提示」的判定与置位。
    ///
    /// **只在已就绪时生效**：失败卡上的「关闭」也走这条路径，若不加 phase 判断，
    /// 一次下载/安装失败后点「关闭」就会把本轮的 30 分钟重试与 24 小时复检一并掐掉
    /// （`dismissed` 直到重启才清空），而用户以为自己只是关掉了一张卡片。
    /// 返回 `true` = 确实记下了。
    fn dismiss_current(&self) -> bool {
        let snapshot = self.snapshot();
        if !should_record_dismissal(&snapshot) {
            return false;
        }
        self.set_dismissed(snapshot.version);
        true
    }

    /// 抢占「开始安装」的权利；返回 `false` 表示已有安装在跑，调用方必须放弃。
    ///
    /// 判定与置位在同一条 `compare_exchange` 上，不存在「都看到没人装」的竞态。
    /// 与 `try_begin_download` 一样是**跨窗口**唯一的重入防线：前端那三个入口
    /// 的守卫都是各窗口自己的局部状态。
    fn try_begin_install(&self) -> bool {
        self.installing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// 放弃安装权（**只在失败路径调用**）。
    ///
    /// 成功路径不需要释放：`install()` 之后进程就 `exit(0)` 了，标志随进程消失。
    /// 失败路径必须释放，否则一次「读包失败 / 验签失败」会把标志永久留在 true 上，
    /// 用户此后点「重试」只会得到「正在安装更新」而永远装不上。
    fn release_install(&self) {
        self.installing.store(false, Ordering::SeqCst);
    }
}

/// 广播当前状态。
///
/// 提示窗与设置页都只认这一条事件（不再有单独的 `update-available` / `update-progress`）：
/// 状态本就是一份快照，拆成多条事件只会让两处各自拼装、各自漂移。
fn publish(app: &AppHandle) -> UpdateStatus {
    let status = app.state::<UpdaterState>().snapshot();
    let _ = app.emit("update-status", &status);
    status
}

/// 下载字节累加器 + 上报节流。
///
/// `Update::download` 的 `on_chunk` 回调首参是「本次分块长度」，不是累计已接收
/// 字节数。直接透传给前端会让百分比恒为 0（单块 16KB / 安装包 96MB ≈ 0%），
/// 必须累加后再上报；此处集中承担该语义，避免再次出现理解偏差。
///
/// 节流是静默升级新增的：96MB 的包按 16KB 分块约有 6000 次回调，每次都 emit
/// 等于序列化一份快照并广播给所有窗口。旧实现只在用户点了「更新」之后下载
/// （弹窗里盯着进度条，重复 emit 尚可忍受），现在下载全程无人观看，更没有理由
/// 为每 16KB 付一次 IPC。这里只在跨过一个「上报刻度」时才上报。
#[derive(Default)]
struct DownloadProgress {
    received: u64,
    /// 上次上报的刻度：总量已知时是整数百分比，未知时是按 MiB 计的里程碑
    last_tick: Option<u64>,
}

impl DownloadProgress {
    /// 累加一个分块，返回累计已接收字节数
    fn push(&mut self, chunk_length: usize) -> u64 {
        self.received = self.received.saturating_add(chunk_length as u64);
        self.received
    }

    /// 累加分块；仅当跨过一个上报刻度时返回累计字节数（`None` = 本次不必上报）。
    fn push_reportable(&mut self, chunk_length: usize, total: Option<u64>) -> Option<u64> {
        let received = self.push(chunk_length);
        let tick = match total {
            Some(total) if total > 0 => received.saturating_mul(100) / total,
            // 服务端没给 Content-Length 时退回按字节里程碑节流
            _ => received / PROGRESS_REPORT_STEP_BYTES,
        };
        if self.last_tick == Some(tick) {
            return None;
        }
        self.last_tick = Some(tick);
        Some(received)
    }
}

/// 构建带超时保护的 updater 实例。
///
/// tauri-plugin-updater 在构造 `Update` 时把 timeout 硬编码为 `None`，导致
/// `UpdaterBuilder::timeout` 对 `download()` 不生效；下载一旦卡住（系统代理未
/// 生效时的典型表现：连接已建立但响应体始终不来）就会无限等待且不报错。
/// 这里统一通过 `configure_client` 注入连接超时与读空闲超时兜底 —— `check()` 与
/// `download()` 都会走这个钩子（插件 updater.rs 里两处都调了 `configure_client`）。
///
/// 代理方面不在此处显式设置：`reqwest 0.13` 的 `system-proxy` 特性已在
/// Cargo.toml 中开启，客户端会自动读取 Windows 系统代理设置。
fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    app.updater_builder()
        .configure_client(|builder| {
            builder
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(READ_TIMEOUT)
        })
        .build()
        .map_err(|e| format!("updater 初始化失败: {e}"))
}

/// 本轮检查的收尾方式，决定下一次检查的间隔。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CheckOutcome {
    /// 无事可做（无更新 / 已就绪 / 正在下载 / 已忽略）或下载已成功
    Settled,
    /// 静默下载失败（原因已记进状态，等重试间隔到了再来）
    DownloadFailed,
}

/// 启动后台周期检测任务。调用方（main.rs setup）负责 app.manage(UpdaterState)。
pub fn start_periodic_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            let next_check = match detect_and_download(&app, false).await {
                Ok(CheckOutcome::Settled) => UPDATE_INTERVAL,
                // 下载失败不能等满 24h：弱网下用户可能一整天都装不上新版本
                Ok(CheckOutcome::DownloadFailed) => FAILED_DOWNLOAD_RETRY_INTERVAL,
                Err(_) => FAILED_CHECK_RETRY_INTERVAL,
            };
            tokio::time::sleep(next_check).await;
        }
    });
}

/// 检查一次远程是否有新版本；有则**静默下载**（全程不弹任何 UI）。
///
/// `manual` = 用户主动点了「检查更新」：
/// - 不受「本次已忽略」标记影响 —— 用户主动要，就必须给结果；
/// - 下载交给后台任务后立刻返回，让设置页马上能显示进度，而不是干等 96MB 下完。
///
/// 周期检查（`manual = false`）则原地等下载收尾，这样「下一轮隔多久」可以由返回值
/// 精确决定，不必再维护第二套定时器。
///
/// 返回 `Err` 只表示**联网检查**失败（供手动路径把原因透给设置页）；下载失败会记进
/// 状态快照（`phase = failed`），静默期不打扰用户。
async fn detect_and_download(app: &AppHandle, manual: bool) -> Result<CheckOutcome, String> {
    let updater = build_updater(app)?;
    let found = match updater.check().await {
        Ok(found) => found,
        Err(error) => {
            crate::utils::logger::log(
                "updater",
                &format!("检测失败（若为 dev 模式属预期，忽略）: {error}"),
            );
            return Err(format!("检测失败: {error}"));
        }
    };

    let Some(update) = found else {
        // 无新版本：清空待更新状态与过期缓存，避免旧数据残留
        let state = app.state::<UpdaterState>();
        if state.snapshot().phase != UpdatePhase::Idle {
            state.clear();
            publish(app);
        }
        prune_packages(None);
        return Ok(CheckOutcome::Settled);
    };

    let version = update.version.clone();
    let notes = update.body.clone().unwrap_or_default();
    let state = app.state::<UpdaterState>();
    let cached = package_path(&version);

    // 本次运行是否已忽略这个版本。用户点「稍后」的语义是「别烦我」：既不重新弹窗，
    // 也不再为它吃一遍 96MB 流量。手动点「检查更新」不受此限（用户主动要，就得给结果）。
    let dismissed = !manual && state.dismissed().as_deref() == Some(version.as_str());

    // 该版本已经「就绪」：可能是本次会话刚下好（状态里记着），也可能是上一次运行
    // 下好了留在缓存里（磁盘上躺着）。两种情况都直接复用 —— 静默下载的意义就是
    // 只下一次，重启应用不该再花一遍 96MB。
    // 缓存文件只由 `store_package` 先写 `.part` 再 rename，所以 `pending-*.exe`
    // 一旦存在就一定是完整包（真伪另由安装前的验签兜底）。
    if state.is_ready_for(&version) || cached.exists() {
        prune_packages(Some(&version));
        if !state.is_ready_for(&version) {
            // 磁盘复用这条路径必须把刚拿到的 Update 补进状态：它携带官方签名与安装
            // 参数，`install_update` 靠它组装安装器调用并复核缓存包。
            let total = std::fs::metadata(&cached)
                .map(|meta| meta.len())
                .unwrap_or(0);
            state.adopt_cached(&version, &notes, update.clone(), total);
            publish(app);
        }
        // 已忽略过就不再弹窗，但状态仍是「已就绪」—— 设置页与托盘菜单照旧显示它，
        // 用户想装随时能装。
        if !dismissed {
            if let Err(error) = show_update_prompt(app) {
                crate::utils::logger::log("updater", &format!("更新提示窗口显示失败: {error}"));
            }
        }
        return Ok(CheckOutcome::Settled);
    }

    if dismissed {
        return Ok(CheckOutcome::Settled);
    }

    // 抢占下载权并**在同一步**切到下载态：手动路径会立刻读快照回给设置页，
    // 若等后台任务起来再切，设置页会先闪一下「已是最新版本」。
    // 抢占失败说明同一版本已经在下载（手动点「检查更新」撞上后台下载时会走到这里），
    // 直接返回，别开第二条 96MB。
    if !state.try_begin_download(&version, &notes) {
        return Ok(CheckOutcome::Settled);
    }
    // 换版本了，旧版本的缓存包作废。放在抢占成功之后：没抢到就不该去动
    // 别人正在写的那份（`store_package` 的 `.part` 与 rename 目标都在这个目录里）。
    prune_packages(Some(&version));
    publish(app);

    // 刻意**不**在这里显示提示窗：静默升级的承诺就是下载阶段不打扰用户。
    // 提示窗只在 `run_silent_download` 的 finish_download 之后出现（守卫见文件末尾）。
    if manual {
        tauri::async_runtime::spawn(run_silent_download(app.clone(), update));
        Ok(CheckOutcome::Settled)
    } else {
        match run_silent_download(app.clone(), update).await {
            Ok(()) => Ok(CheckOutcome::Settled),
            Err(_) => Ok(CheckOutcome::DownloadFailed),
        }
    }
}

/// 静默下载 → 验签（由插件在 `download` 内完成）→ 原子落盘 → 就绪并提示用户。
///
/// 进入本函数时状态已是 `Downloading`（由 `detect_and_download` 置好）。
async fn run_silent_download(app: AppHandle, update: Update) -> Result<(), String> {
    let version = update.version.clone();
    let notes = update.body.clone().unwrap_or_default();

    let app_for_chunk = app.clone();
    let version_for_chunk = version.clone();
    let mut progress = DownloadProgress::default();
    let downloaded = update
        .download(
            move |chunk_length, total| {
                let Some(received) = progress.push_reportable(chunk_length, total) else {
                    return;
                };
                app_for_chunk.state::<UpdaterState>().report_progress(
                    &version_for_chunk,
                    received,
                    total,
                );
                publish(&app_for_chunk);
            },
            || {},
        )
        .await;

    let bytes = match downloaded {
        Ok(bytes) => bytes,
        Err(error) => {
            let message = format!("下载失败: {error}");
            crate::utils::logger::log("updater", &format!("v{version} {message}"));
            // 失败态同样带版本守卫：这轮下载若已被更新的版本取代，别把新版本标成失败，
            // 也不必为此广播（状态没变）。
            if app
                .state::<UpdaterState>()
                .fail_download(&version, message.clone())
            {
                publish(&app);
            }
            return Err(message);
        }
    };

    let total = bytes.len() as u64;
    // 先落盘再改状态：缓存写不进去就不能对外宣称「已就绪」，
    // 否则用户点了「立即更新」只会拿到一个读不到文件的错误。
    if let Err(message) = store_package(&version, &bytes) {
        // 先释放 96MB，再动状态 —— 失败路径上没必要多占一份内存
        drop(bytes);
        if app
            .state::<UpdaterState>()
            .fail_download(&version, message.clone())
        {
            publish(&app);
        }
        return Err(message);
    }
    // 安装包到此用完即弃：真正要在安装时读的是磁盘上那份。常驻内存再留一份
    // 会让这个托盘工具的占用凭空多出 96MB，且用户可能挂着几天不点更新。
    drop(bytes);

    if !app
        .state::<UpdaterState>()
        .finish_download(&version, &notes, update, total)
    {
        // 抢跑输了：这轮下载在途中已被更新的版本取代（状态里现在是新版本）。
        // 丢弃刚写的包，别让 96MB 垃圾留到下一次检查 —— `keep` 取当前状态里的版本，
        // 那是后来者正在下的目标，不能误删。
        let live = app.state::<UpdaterState>().current_version();
        prune_packages(live.as_deref());
        crate::utils::logger::log(
            "updater",
            &format!("v{version} 下载完成时已被更新的版本取代，丢弃该安装包"),
        );
        return Ok(());
    }
    publish(&app);
    crate::utils::logger::log(
        "updater",
        &format!("v{version} 已下载并验签完成（{total} 字节），等待用户安装"),
    );

    // 只有走到这一步才提示用户 —— 「下载已完成、点一下就能装」正是静默升级的核心体验。
    if let Err(error) = show_update_prompt(&app) {
        crate::utils::logger::log("updater", &format!("更新提示窗口显示失败: {error}"));
    }
    Ok(())
}

// ── 安装包落盘缓存 ───────────────────────────────────────────────
//
// 静默下载把「下载」与「安装」拆成了两个时间点，中间隔着用户点击、甚至一次重启，
// 所以安装包必须落盘而不是留在内存里。目录与 config.json / 便签图片同一个数据根：
// `%APPDATA%/levitaire/updates`。
//
// 缓存的可信度：`pending-*.exe` 只由 `store_package` 产生 —— 先写 `.part` 再 rename，
// 所以这个文件名一旦出现就一定是完整文件；安装前还会用官方签名再复核一次
// （见 `verify_package`），校验不过就删掉缓存重新下载。

fn cache_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("levitaire")
        .join("updates")
}

/// 缓存文件名。版本号既是唯一的版本标识，也是跨重启复用同一份包的依据。
///
/// 读写两侧都只经这里拼名字：只改一处的话，表现是「下载成功、点更新时读不到文件」，
/// 而且只在用户真去点的时候才暴露（守卫 `package_path_is_single_sourced`）。
fn package_file_name(version: &str) -> String {
    format!("pending-{version}.exe")
}

fn package_path(version: &str) -> PathBuf {
    cache_dir().join(package_file_name(version))
}

/// 原子落盘：先写 `.part` 再 rename，避免中途断电留下半截文件被当成完整安装包。
fn store_package(version: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = cache_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建更新缓存目录失败: {e}"))?;
    let final_path = package_path(version);
    let part_path = final_path.with_extension("exe.part");
    std::fs::write(&part_path, bytes).map_err(|e| format!("写入安装包失败: {e}"))?;
    std::fs::rename(&part_path, &final_path).map_err(|e| format!("落盘安装包失败: {e}"))?;
    Ok(final_path)
}

/// 清掉除 `keep` 之外的安装包与残留的 `.part` 分片。
///
/// 调用点：本轮检查没有新版本（缓存已无意义）、检查到别的版本（旧缓存作废）、
/// 以及安装前验签失败（缓存不可信）。
fn prune_packages(keep: Option<&str>) {
    let keep_name = keep.map(package_file_name);
    let Ok(entries) = std::fs::read_dir(cache_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // 目录是专用的，但仍只删自己命名的文件，避免将来往这里放别的东西被误删
        if !name.starts_with("pending-") || keep_name.as_deref() == Some(name.as_str()) {
            continue;
        }
        let _ = std::fs::remove_file(entry.path());
    }
}

/// 用 tauri.conf.json 里配置的 updater 公钥复核安装包签名。
///
/// 为什么需要：`Update::download` 会验签，但插件公开的 `Update::install` **不验签**
/// （校验写死在 download 里）。启用静默升级后，安装包会先在磁盘上躺一段时间，
/// 「读回来直接装」这条路就绕过了校验 —— 落盘或读回过程中的任何损坏都可能被执行。
/// 这里补上同一套校验，步骤与插件 updater.rs 的 `verify_signature` 完全一致：
/// 先把 base64 还原成 minisign 文本，再 `PublicKey` / `Signature::decode`。
fn verify_package(bytes: &[u8], signature: &str, pubkey: &str) -> Result<(), String> {
    fn decode_minisign_text(raw: &str) -> Result<String, String> {
        let decoded = STANDARD
            .decode(raw)
            .map_err(|e| format!("签名数据不是合法 base64: {e}"))?;
        String::from_utf8(decoded).map_err(|_| "签名数据不是合法 UTF-8".to_string())
    }

    let public_key = minisign_verify::PublicKey::decode(&decode_minisign_text(pubkey)?)
        .map_err(|e| format!("更新公钥解析失败: {e}"))?;
    let signature = minisign_verify::Signature::decode(&decode_minisign_text(signature)?)
        .map_err(|e| format!("更新签名解析失败: {e}"))?;

    public_key
        .verify(bytes, &signature, true)
        .map_err(|e| format!("安装包签名校验失败: {e}"))
}

/// 取 `plugins.updater.pubkey`。
///
/// 读的是 `tauri.conf.json` 在**编译期**被 `generate_context!` 嵌进二进制的那份配置，
/// 不是磁盘上的文件 —— 与插件内部读的是同一份，外部改不了它（否则「验签」就成了摆设：
/// 改配置文件就能换掉公钥）。
fn configured_pubkey(app: &AppHandle) -> Result<String, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|pubkey| pubkey.as_str())
        .map(str::to_string)
        .ok_or_else(|| "未在 tauri.conf.json 的 plugins.updater 中配置 pubkey".to_string())
}

// ── 更新就绪提示窗 ───────────────────────────────────────────────

/// 更新提示面板（卡片本体）的逻辑尺寸。
const UPDATE_PROMPT_PANEL_WIDTH: f64 = 360.0;
const UPDATE_PROMPT_PANEL_HEIGHT: f64 = 200.0;

/// 更新提示窗口四周的透明留白（逻辑像素）。
///
/// 窗口尺寸 = 面板 + 2×留白。窗口尺寸若等于面板尺寸，面板的 CSS 投影没有任何
/// 展开空间，只在面板圆角的「缺口」里露出一小块，并被窗口边界硬切成直角。
///
/// ⚠️ 必须与前端 `src/utils/panelWindow.ts` 的 `PANEL_SHADOW_MARGIN` 及
///    `UpdatePrompt.css` 里 `body.update-prompt-window` 的 padding 一致。
const UPDATE_PROMPT_SHADOW_MARGIN: f64 = 20.0;

/// 创建 / 显示右上角更新提示窗口（常驻，关闭=隐藏）。
///
/// ⚠️ 只在安装包**已就绪**时调用：下载阶段弹这个窗就等于把静默升级改回了打扰
/// （守卫 `update_prompt_only_shows_after_download_finishes` 钉住这一点）。
pub fn show_update_prompt(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("update-prompt") {
        win.show()
            .map_err(|e| format!("显示 update-prompt 失败: {e}"))?;
        win.set_focus().ok();
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(app, "update-prompt", WebviewUrl::App("index.html".into()))
        .title("Levitaire 更新")
        .inner_size(
            UPDATE_PROMPT_PANEL_WIDTH + 2.0 * UPDATE_PROMPT_SHADOW_MARGIN,
            UPDATE_PROMPT_PANEL_HEIGHT + 2.0 * UPDATE_PROMPT_SHADOW_MARGIN,
        )
        .resizable(false)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(false)
        .focusable(true)
        .visible(false)
        .background_color(tauri::webview::Color(0, 0, 0, 0))
        .build()
        .map_err(|e| format!("创建 update-prompt 窗口失败: {e}"))?;

    // 窗口创建后定位到主屏右上角（物理像素）。
    // 留白参与窗口坐标：要让「卡片本体」保持距屏幕右边/上边 24px 的原位置，
    // 含留白的窗口左上角必须再向左、向上各让出一个留白。
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale: f64 = monitor.scale_factor();
        let pos = monitor.position();
        let size = monitor.size();
        let mw: f64 = size.width as f64;
        let margin: f64 = UPDATE_PROMPT_SHADOW_MARGIN * scale;
        let w: f64 = (UPDATE_PROMPT_PANEL_WIDTH + 2.0 * UPDATE_PROMPT_SHADOW_MARGIN) * scale;
        let x: i32 = (pos.x as f64 + mw - w - 24.0 * scale + margin) as i32;
        let y: i32 = (pos.y as f64 + 24.0 * scale - margin) as i32;
        let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            x, y,
        )));
    }
    win.show()
        .map_err(|e| format!("显示 update-prompt 失败: {e}"))?;
    win.set_focus().ok();
    Ok(())
}

// ── Tauri 命令 ───────────────────────────────────────────

/// 查询当前更新状态（提示窗启动时兜底同步，设置页展示同一份）。
#[tauri::command]
pub fn get_update_status(state: tauri::State<'_, UpdaterState>) -> UpdateStatus {
    state.snapshot()
}

/// 手动检查更新（设置页「检查更新」）。
///
/// 发现新版本会立刻在后台开始静默下载并马上返回当前快照 —— 设置页据此显示进度，
/// 不会为了 96MB 的安装包干等到下载结束。检查失败会把原因透出去。
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateStatus, String> {
    detect_and_download(&app, true).await?;
    Ok(app.state::<UpdaterState>().snapshot())
}

/// 本次运行不再提示该版本（提示窗「稍后」）。
///
/// 只记标记、**不删缓存**：包已经下好了，丢掉只会让下次再花一遍流量。
/// 重启后标记清空，会重新提示。
///
/// ⚠️ **只认「已就绪」态**：失败卡上的「关闭」也走这条命令，若不加 phase 判断，
/// 一次下载失败后点「关闭」就会连带把本轮的 30 分钟重试与 24 小时复检一并掐掉
/// （`dismissed` 直到重启才清空），而用户以为自己只是关掉了一张卡片。
#[tauri::command]
pub fn dismiss_update(state: tauri::State<'_, UpdaterState>) {
    state.dismiss_current();
}

/// 安装已就绪的更新。
///
/// 与旧实现的关键差别：**这里不再下载**。下载在后台静默阶段就完成了，本命令只做
/// 「读缓存包 → 复核签名 → 交给安装器」，因此点击后几乎立刻开始安装，本次运行内断网也能装
/// （旧实现在这里重新 `check()` 再重新下载，离线点更新必然失败）。
///
/// ⚠️ 结构约定：拿到安装权之后，**所有失败路径都只能走末尾那一个收口**（`match` 的
/// `Err` 分支）—— 任何 `?` 或新的 `return Err` 都会绕过 `release_install()`，
/// 让安装权永久卡死。源码级守卫 `install_failure_paths_release_the_install_token` 盯着这点。
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let state = app.state::<UpdaterState>();
    let status = state.snapshot();
    let version = status
        .version
        .clone()
        .ok_or_else(|| "没有可用的更新".to_string())?;
    if status.phase != UpdatePhase::Ready {
        return Err("更新包尚未下载完成，请稍候".to_string());
    }
    // 必须有一个 `Update` 在手：它携带官方签名与安装参数（安装模式、重启参数等
    // 都由插件按这份数据组装）。本会话内下完时会留下它，从磁盘缓存复用时由
    // `detect_and_download` 用刚 `check()` 到的那份补上 —— 两种情况下都取得到。
    let update = state
        .ready_update()
        .ok_or_else(|| "更新信息已失效，请重新检查更新".to_string())?;

    // 安装不可重入：三个入口（提示窗 / 设置页 / 托盘菜单）的守卫都是各窗口**局部**状态，
    // 挡不住「点完提示窗立刻右键托盘再点一次」这种跨窗口的并发，会同时拉起两个安装器
    // 装同一个包。见 `UpdaterState::installing` 的说明。
    if !state.try_begin_install() {
        // 抢不到说明别的窗口正在装：这里还没拿到权，不需要释放
        return Err("正在安装更新，请稍候".to_string());
    }

    // 唯一的收口：成功时 `install()` 之后进程就 exit(0) 了，权随进程消失；
    // 失败则必须在这里放开，否则用户点「重试」只会一直看到「正在安装更新」。
    match prepare_and_install(&app, &version, &update).await {
        Ok(()) => Ok(()),
        Err(message) => {
            app.state::<UpdaterState>().release_install();
            Err(message)
        }
    }
}

/// 读本地缓存包 → 复核签名 → 交给安装器。
///
/// 从 `install_update` 里抽出来，是为了让「安装权」只有一处释放点：本函数内部可以随便
/// `?`，权由调用方的收口统一管理。
async fn prepare_and_install(
    app: &AppHandle,
    version: &str,
    update: &Update,
) -> Result<(), String> {
    let path = package_path(version);
    let signature = update.signature.clone();
    let pubkey = configured_pubkey(app)?;

    // 读盘 + 验签都按耗时操作处理：96MB 的读取与哈希放阻塞线程池，
    // 别占着 async worker（与截图/长截图走 spawn_blocking 的理由一致）。
    let loaded = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let bytes = std::fs::read(&path).map_err(|e| format!("读取已下载的安装包失败: {e}"))?;
        // 磁盘上这份必须重新验签：插件公开的 install() 不验签，
        // 「下载时验过」不等于「此刻磁盘上还是那一份」。
        verify_package(&bytes, &signature, &pubkey)?;
        Ok(bytes)
    })
    .await
    .map_err(|e| format!("安装准备失败: {e}"))?;

    let bytes = match loaded {
        Ok(bytes) => bytes,
        Err(message) => {
            // 缓存不可信：清掉并置为失败态，让下一轮检查重新下载，
            // 而不是留下一个「点更新就报错」的死局。
            prune_packages(None);
            let state = app.state::<UpdaterState>();
            if state.fail_install(version, message.clone()) {
                publish(app);
            }
            return Err(message);
        }
    };

    crate::utils::logger::log(
        "updater",
        &format!("开始安装 v{version}（本地缓存 {} 字节）", bytes.len()),
    );

    // 安装器一拉起，进程随后就 exit(0)，走不到 exit_app / 托盘 quit 那两条收尾路径。
    // 窗口置顶写在**目标窗口**身上，不在这里还原就会永久残留 —— 新版本起来时内存
    // 清单已是空的，再也认不回那几个窗口。
    crate::window_pin::cleanup();

    // install() 内部会把包写到临时文件、ShellExecute 拉起安装器，随后立刻
    // std::process::exit(0)。正常路径下这一句不会返回 —— 旧实现里紧随其后的
    // app.restart() 同样不可达，这不是遗漏，而是插件的设计。
    update.install(&bytes).map_err(|e| format!("安装失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归：进度必须是累计值，而非最后一次回调的分块长度
    #[test]
    fn test_progress_accumulates_chunk_lengths() {
        let mut progress = DownloadProgress::default();
        // 模拟连续三次分块回调
        assert_eq!(progress.push(16_384), 16_384);
        assert_eq!(progress.push(16_384), 32_768);
        assert_eq!(progress.push(8_192), 40_960);
        assert_eq!(progress.received, 40_960);
    }

    /// 回归：不能被误认为「单块长度即进度」——单块相对安装包极小，
    /// 若透传则前端百分比长期为 0
    #[test]
    fn test_single_chunk_is_far_below_one_percent() {
        let mut progress = DownloadProgress::default();
        let received = progress.push(16_384);
        // 0.1.4 安装包实测 96,023,891 字节
        let total = 96_023_891u64;
        assert_eq!(received * 100 / total, 0, "单块占比为 0%，故必须累加");
        // 累加到一半时才应出现非零百分比
        for _ in 0..(total / 2 / 16_384) {
            progress.push(16_384);
        }
        assert!(progress.received * 100 / total > 40);
    }

    /// 累加溢出时饱和而非 panic（debug 构建下溢出会 panic）
    #[test]
    fn test_progress_saturates_on_overflow() {
        let mut progress = DownloadProgress {
            received: u64::MAX - 1,
            ..DownloadProgress::default()
        };
        assert_eq!(progress.push(1024), u64::MAX);
    }

    /// 节流：总量已知时每个整数百分比只上报一次，不是每块都上报
    #[test]
    fn test_progress_reports_once_per_percent() {
        let total = 96_000_000u64;
        let chunk = 16_384usize;
        let mut progress = DownloadProgress::default();
        let mut reports = 0usize;
        while progress.received < total {
            if progress.push_reportable(chunk, Some(total)).is_some() {
                reports += 1;
            }
        }
        // 96MB / 16KB ≈ 5859 次回调，若逐块上报会得到约 5859 次
        assert!(reports <= 101, "上报 {reports} 次，节流没生效");
        assert!(
            reports >= 99,
            "上报 {reports} 次，进度过于粗糙（应覆盖 0%~100%）"
        );
    }

    /// 节流：总量未知时退回按 MiB 里程碑上报，而不是每块都报
    #[test]
    fn test_progress_falls_back_to_byte_milestones_without_total() {
        let chunk = 16_384usize;
        let mut progress = DownloadProgress::default();
        let mut reports = 0usize;
        // 走 8MiB
        for _ in 0..(8 * 1024 * 1024 / chunk) {
            if progress.push_reportable(chunk, None).is_some() {
                reports += 1;
            }
        }
        assert!(
            (8..=10).contains(&reports),
            "8MiB 应约上报 9 次（0/1/…/8），实际 {reports} 次"
        );
    }

    /// 节流：首块必须上报，否则进度条会停在 0% 直到第一个整数百分比
    #[test]
    fn test_progress_reports_first_chunk() {
        let mut progress = DownloadProgress::default();
        assert_eq!(
            progress.push_reportable(16_384, Some(96_000_000)),
            Some(16_384)
        );
    }

    /// 下载权必须「判定 + 置位」一次完成：同一版本的第二个抢占者必须失败。
    ///
    /// 回归的是并发路径（周期检查 + 手动检查可能同时进来）：先 `is_downloading()` 判断、
    /// 出锁后再置位的话，两条路径都能看到「没在下载」→ 同时下两份 96MB，
    /// 而且在同一个 `.part` / rename 目标上互相踩。
    #[test]
    fn try_begin_download_is_exclusive_per_version() {
        let state = UpdaterState::default();

        assert!(
            state.try_begin_download("0.1.6", "说明"),
            "首次应当抢到下载权"
        );
        assert!(
            !state.try_begin_download("0.1.6", "说明"),
            "同一版本第二次抢占必须被拒（否则会并发下两份）"
        );

        // 换版本可以重新抢：新版本不该被旧版本的下载挡住
        assert!(state.try_begin_download("0.1.7", "说明"));
        let snapshot = state.snapshot();
        assert_eq!(snapshot.version.as_deref(), Some("0.1.7"));
        assert_eq!(snapshot.phase, UpdatePhase::Downloading);
        assert_eq!(snapshot.received, 0, "换版本后进度必须归零");
    }

    /// 「关闭 / 稍后」只该在**已就绪**时记版本号。
    ///
    /// 提示窗失败卡上的「关闭」也走 `dismiss_update`：若它把版本记进 `dismissed`，
    /// 本轮的 30 分钟下载重试与 24 小时复检都会被 `detect_and_download` 的
    /// `if dismissed { return Settled }` 跳过，而用户以为自己只是关掉了一张卡片。
    #[test]
    fn dismissal_is_recorded_only_when_ready() {
        let ready = UpdateStatus {
            version: Some("0.1.6".into()),
            phase: UpdatePhase::Ready,
            ..Default::default()
        };
        assert!(should_record_dismissal(&ready), "已就绪时应当记下版本号");

        for phase in [
            UpdatePhase::Idle,
            UpdatePhase::Downloading,
            UpdatePhase::Failed,
        ] {
            let status = UpdateStatus {
                version: Some("0.1.6".into()),
                phase,
                ..Default::default()
            };
            assert!(
                !should_record_dismissal(&status),
                "{phase:?} 阶段不该记 dismissed（会把本轮的自动重试一并掐掉）"
            );
        }

        // 已就绪但状态里没有版本号（不该出现）：不记，别把 None 写进去
        let no_version = UpdateStatus {
            phase: UpdatePhase::Ready,
            ..Default::default()
        };
        assert!(!should_record_dismissal(&no_version));
    }

    /// 安装不可重入：并发触发只能有一个拿到安装权；失败释放后必须还能重试。
    #[test]
    fn install_token_is_exclusive_and_releasable() {
        let state = UpdaterState::default();

        assert!(state.try_begin_install(), "首次应当抢到安装权");
        assert!(
            !state.try_begin_install(),
            "第二次必须被拒 —— 否则点完提示窗立刻右键托盘再点一次会同时拉起两个安装器"
        );

        // 失败路径释放后，用户点「重试」必须还能装
        state.release_install();
        assert!(
            state.try_begin_install(),
            "释放之后必须能再次抢占（标志卡死 = 永远装不上）"
        );
    }

    /// 旧版本迟到的进度回调不得写进新版本的状态。
    ///
    /// 下载是后台任务：换版本（或失败复位）后，排空中的旧回调仍可能到达。
    #[test]
    fn stale_progress_from_an_older_version_is_ignored() {
        let state = UpdaterState::default();
        state.try_begin_download("0.1.6", "");
        state.report_progress("0.1.6", 1_000, Some(2_000));
        assert_eq!(state.snapshot().received, 1_000);

        // 换版本 → 旧版本的回调随后到达
        state.try_begin_download("0.1.7", "");
        state.report_progress("0.1.6", 1_990, Some(2_000));
        let snapshot = state.snapshot();
        assert_eq!(snapshot.received, 0, "旧回调不该写进新版本的进度");
        assert_eq!(snapshot.version.as_deref(), Some("0.1.7"));

        // 版本对了但阶段已不是 downloading（例如已失败）同样不该被改写
        let state = UpdaterState::default();
        state.try_begin_download("0.1.6", "");
        assert!(state.fail_download("0.1.6", "下载失败: x".to_string()));
        state.report_progress("0.1.6", 512, Some(2_000));
        assert_eq!(state.snapshot().phase, UpdatePhase::Failed);
        assert_eq!(state.snapshot().received, 0);
    }

    /// 陈旧下载任务连**终态**也不能写：失败与就绪都必须过 `is_current_download` 守卫。
    ///
    /// 反例场景（虽然罕见但真实存在）：v0.1.6 正在下载，期间服务端改口成 v0.1.7、
    /// 用户又点了一次「检查更新」，新版本的下载随即接管。这时 v0.1.6 的任务才跑完 ——
    /// 若它照样写「已就绪 v0.1.6」，用户看到的就是一个永远等不到下完的旧版本
    /// （新版本的进度回调会被版本守卫丢弃）。
    #[test]
    fn stale_download_task_cannot_write_terminal_state() {
        let state = UpdaterState::default();
        state.try_begin_download("0.1.6", "");
        // 新版本接管
        assert!(state.try_begin_download("0.1.7", ""));

        assert!(
            !state.fail_download("0.1.6", "下载失败: 连接超时".to_string()),
            "旧任务的失败不该生效"
        );
        let snapshot = state.snapshot();
        assert_eq!(snapshot.version.as_deref(), Some("0.1.7"));
        assert_eq!(snapshot.phase, UpdatePhase::Downloading);
        assert!(snapshot.error.is_none(), "旧任务的失败原因不该写进新版本");
    }

    /// 安装失败的守卫：只要求版本匹配（这条路进来时状态是 `Ready`，不是 `Downloading`）。
    #[test]
    fn install_failure_requires_a_matching_version() {
        let state = UpdaterState::default();
        state.try_begin_download("0.1.6", "");

        assert!(!state.fail_install("0.1.5", "缓存包读不到".to_string()));
        assert_eq!(
            state.snapshot().phase,
            UpdatePhase::Downloading,
            "版本不匹配时不该改写状态"
        );

        assert!(state.fail_install("0.1.6", "缓存包读不到".to_string()));
        let snapshot = state.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Failed);
        assert_eq!(snapshot.error.as_deref(), Some("缓存包读不到"));
    }

    /// `is_current_download` 必须同时看「版本」与「阶段」。
    #[test]
    fn current_download_predicate_checks_version_and_phase() {
        let downloading = UpdateStatus {
            version: Some("0.1.6".to_string()),
            phase: UpdatePhase::Downloading,
            ..UpdateStatus::default()
        };
        assert!(is_current_download(&downloading, "0.1.6"));
        assert!(
            !is_current_download(&downloading, "0.1.7"),
            "换版本后已不是当前下载"
        );

        let ready = UpdateStatus {
            version: Some("0.1.6".to_string()),
            phase: UpdatePhase::Ready,
            ..UpdateStatus::default()
        };
        assert!(
            !is_current_download(&ready, "0.1.6"),
            "已就绪不再是「下载中」"
        );
    }

    /// 源码级守卫：由后台下载任务写状态的三处出口都必须把 `is_current_download`
    /// 用作**条件守卫**。
    ///
    /// 将来新增任何一处「下载任务写状态」的出口时，漏掉守卫就退回「陈旧任务覆盖
    /// 新版本」的老问题 —— 而那个场景在功能测试里几乎造不出来。
    ///
    /// ⚠️ 本守卫的假绿踩了两个坑，都已修掉：
    /// ① 只断言函数体里**出现过** `is_current_download(`：`let _ = is_current_download(...)`
    ///    （调一下、结果丢掉）就能骗过 → 现在要求它出现在条件里。
    /// ② `function_body` 以前按「列 0 的 `}`」切收尾，而 `impl` 里的方法用**缩进** `}`
    ///    收尾 → 切出来的"方法体"一路吃到 impl 末尾，被 `finish_download` 里的守卫写法
    ///    满足 → 现在按「与声明同缩进的 `}`」切，并有 `function_body_stops_at_the_same_indent_closing_brace` 钉住。
    #[test]
    fn background_download_writers_are_version_guarded() {
        for decl in [
            "fn report_progress(",
            "fn finish_download(",
            "fn fail_download(",
        ] {
            let body: String = function_body(include_str!("mod.rs"), decl)
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect();
            // 只断言「出现过 `is_current_download(`」是不够的 —— 实测过：
            // `let _ = is_current_download(&inner.status, version);` 这种写法
            // （调用一下、结果丢掉）能让那条断言假绿，守卫形同虚设。
            // 必须要求它出现在**条件**里（两种极性都算），才算真的拦住了写入。
            assert!(
                body.contains("if!is_current_download(") || body.contains("ifis_current_download("),
                "{decl} 没有把 is_current_download 用作条件守卫：陈旧任务可能覆盖新版本的状态"
            );
        }
    }

    /// 守卫切分器自身的回归：函数体不得把「邻居」也包进来。
    ///
    /// 这正是上面那条守卫假绿的根因 —— `impl` 里的方法用缩进 `}` 收尾，按「列 0 的 `}`」
    /// 切会一路吃到 impl 末尾。把它单独钉住，免得以后改 `function_body` 时又退化。
    #[test]
    fn function_body_stops_at_the_same_indent_closing_brace() {
        let source = include_str!("mod.rs");

        // 方法：必须止于自己那行 `}`，不能带上后面的方法
        let method = function_body(source, "fn report_progress(");
        assert!(method.contains("fn report_progress("), "切分起点不对");
        assert!(
            !method.contains("fn finish_download("),
            "方法体切多了：后续方法被包进来后，它里面的守卫写法会误判本方法合规"
        );
        assert!(!method.contains("fn fail_download("));

        // 顶层函数：同样不能带上后面的测试模块
        let top_level = function_body(source, "pub async fn install_update(");
        assert!(top_level.contains("pub async fn install_update("));
        assert!(
            !top_level.contains("mod tests"),
            "顶层函数体切多了：把测试模块也包了进来"
        );
    }

    /// 「未就绪」的判定必须认得清版本：换版本后旧版本的「已就绪」不能顶用。
    #[test]
    fn readiness_is_scoped_to_the_exact_version() {
        let state = UpdaterState::default();
        assert!(!state.is_ready_for("0.1.6"), "初始态不该有任何就绪版本");

        // 下载态 ≠ 就绪态：抢到下载权只代表「正在下」
        state.try_begin_download("0.1.6", "");
        assert!(
            !state.is_ready_for("0.1.6"),
            "正在下载时不能算已就绪，否则用户点安装会读不到完整包"
        );
    }

    /// tauri.conf.json 里钉住的那把更新公钥必须能解析成合法的 minisign 公钥。
    ///
    /// 公钥写错了的表现很隐蔽：检查、下载照常（验签在插件内部走的是同一份配置，
    /// 会直接失败），但如果哪天有人把它改成非法值，我们**自己**新增的安装前复核
    /// 会先报「公钥解析失败」—— 与其在用户点「立即更新」时才炸，不如在这里拦下。
    #[test]
    fn pinned_updater_pubkey_parses() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
            .expect("tauri.conf.json 不是合法 JSON");
        let pubkey = config["plugins"]["updater"]["pubkey"]
            .as_str()
            .expect("tauri.conf.json 缺少 plugins.updater.pubkey");

        let decoded = STANDARD.decode(pubkey).expect("更新公钥不是合法 base64");
        let text = String::from_utf8(decoded).expect("更新公钥不是合法 UTF-8");
        minisign_verify::PublicKey::decode(&text).expect("更新公钥不是合法的 minisign 公钥");
    }

    /// 验签必须「失败即拒」：数据被改动后同一份签名不能再通过。
    ///
    /// 正向用例（真实签名 + 真实安装包）见 `verify_package_accepts_local_signed_installer`
    /// —— 那需要发版产物，默认忽略。
    #[test]
    fn verify_package_rejects_tampered_data() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let pubkey = config["plugins"]["updater"]["pubkey"].as_str().unwrap();
        // 用 latest.json 里那份真实签名去验一段伪造数据：必须失败
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../latest.json")).unwrap();
        let signature = manifest["platforms"]["windows-x86_64"]["signature"]
            .as_str()
            .expect("latest.json 缺少 windows-x86_64 签名");

        let error = verify_package(b"not the real installer", signature, pubkey)
            .expect_err("伪造数据居然通过了验签");
        assert!(
            error.contains("签名校验失败"),
            "失败原因应指向签名校验，实际: {error}"
        );
    }

    /// 非法签名/公钥一律拒绝，不能静默放行。
    #[test]
    fn verify_package_rejects_garbage_signature() {
        let error = verify_package(b"whatever", "!!!not-base64!!!", "also-not-base64")
            .expect_err("非法签名居然通过了验签");
        assert!(error.contains("base64"), "实际错误: {error}");
    }

    /// 端到端正向验签：用本机 `target/release/bundle/nsis` 下真实的已签名安装包
    /// 跑一遍 `verify_package`，确认我们复刻的校验逻辑与发版签名完全对得上。
    ///
    /// 默认忽略：CI 上没有构建产物。手动执行：
    /// `cargo test verify_package_accepts_local_signed_installer -- --ignored --nocapture`
    #[test]
    #[ignore = "需要本机已有的签名安装包（target/release/bundle/nsis）"]
    fn verify_package_accepts_local_signed_installer() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let pubkey = config["plugins"]["updater"]["pubkey"].as_str().unwrap();

        let bundle = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/release/bundle/nsis")
            .join(format!(
                "Levitaire_{}_x64-setup.exe",
                env!("CARGO_PKG_VERSION")
            ));
        if !bundle.exists() {
            println!("跳过：本机没有 {}", bundle.display());
            return;
        }
        let signature = std::fs::read_to_string(bundle.with_extension("exe.sig"))
            .expect("找不到配套 .sig")
            .trim()
            .to_string();
        let bytes = std::fs::read(&bundle).unwrap();
        verify_package(&bytes, &signature, pubkey).expect("真实签名未通过复核");
        println!("验签通过：{}（{} 字节）", bundle.display(), bytes.len());

        // 反向断言：换一枚字节就必须失败，证明上面的通过不是「恒真」
        let mut tampered = bytes.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xFF;
        assert!(verify_package(&tampered, &signature, pubkey).is_err());
    }

    /// 取源码里某个函数的函数体（从声明行到**与声明同缩进**的收尾 `}`）。
    ///
    /// 只服务于本模块的源码级守卫。
    ///
    /// ⚠️ 收尾判定不能只找「列 0 的 `}`」：`impl` 里的方法用**缩进**的 `}` 收尾，
    /// 那样切出来的"函数体"会一路吃到 impl 末尾，把**后面那些方法**的写法也算进来。
    /// 实测踩过：`fn report_progress` 的守卫因此被 `fn finish_download` 里的
    /// `if !is_current_download(` 满足，成了假绿（变异验证时该报红却没报）。
    fn function_body<'a>(source: &'a str, decl: &str) -> &'a str {
        let start = source
            .find(decl)
            .unwrap_or_else(|| panic!("找不到函数声明：{decl}（守卫会空转）"));
        // 声明所在行的缩进：顶层函数为 0，impl 内的方法为其缩进值
        let line_start = source[..start].rfind('\n').map_or(0, |index| index + 1);
        let indent = start - line_start;
        let rest = &source[start..];
        let closing = format!("\n{}}}", " ".repeat(indent));
        let end = rest
            .find(&closing)
            .map(|index| index + closing.len())
            .unwrap_or(rest.len());
        let body = &rest[..end];
        assert!(
            body.len() > decl.len() + 20,
            "函数体切分失败（{decl}），守卫会空转"
        );
        // 反向断言：切出来的这段必须真的以收尾 `}` 结束（否则就是切多了/切少了）
        assert!(
            body.trim_end().ends_with('}'),
            "函数体切分异常（{decl}），守卫会空转"
        );
        body
    }

    /// 静默升级的核心承诺：**下载阶段绝不弹提示窗**。
    ///
    /// 守卫把提示窗调用钉在落盘（`finish_download(`）之后 —— 有人若图省事把
    /// `show_update_prompt` 挪到检测到版本的地方（或下载 await 之前），用户就会在下
    /// 96MB 的过程中先看到一个「新版本可用」的窗，静默升级立刻退化回旧行为，
    /// 而功能测试很难发现。
    #[test]
    fn update_prompt_only_shows_after_download_finishes() {
        // 去掉全部空白再比对：方法链换行不该让「先后顺序」判错（同 install_path_never_downloads）
        let compact = |source: &str, decl: &str| -> String {
            function_body(source, decl)
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect()
        };

        let body = compact(include_str!("mod.rs"), "async fn run_silent_download(");
        let prompt_at = body
            .find("show_update_prompt(")
            .unwrap_or_else(|| panic!("下载流程里没有显示提示窗的调用，守卫失效"));
        let ready_at = body
            .find("finish_download(")
            .unwrap_or_else(|| panic!("下载流程里没有 finish_download，守卫失效"));
        assert!(
            prompt_at > ready_at,
            "提示窗必须在安装包就绪（finish_download）之后才显示，否则下载阶段就会打扰用户"
        );
        assert_eq!(
            body.matches("show_update_prompt(").count(),
            1,
            "下载流程里只应在收尾处显示一次提示窗"
        );

        // 检测入口同样不得在「开始下载」附近弹窗：只有「已就绪、重新提示」那条分支可以。
        let detect = compact(include_str!("mod.rs"), "async fn detect_and_download(");
        assert_eq!(
            detect.matches("show_update_prompt(").count(),
            1,
            "检测入口只允许在「该版本已就绪」分支里重新显示提示窗"
        );
    }

    /// 守卫：安装路径不得再触发下载。
    ///
    /// 静默升级的前提是「点击时包已在本地」。这里若退回 `download()`，
    /// 断网点「立即更新」必然失败，而且白等一遍 96MB —— 正是本次要消除的行为。
    ///
    /// 安装路径由两个函数合力完成（`install_update` 管守卫与安装权、`prepare_and_install`
    /// 管读包 → 验签 → 交给安装器），所以把两份函数体合起来看。
    #[test]
    fn install_path_never_downloads() {
        let source = include_str!("mod.rs");
        let body = format!(
            "{}{}",
            function_body(source, "pub async fn install_update("),
            function_body(source, "async fn prepare_and_install("),
        );
        // 去掉全部空白再比对：方法链换行（`update` / `.install(…)`）不该让守卫漏判，
        // 否则「换个 rustfmt 版本」就能让这条断言静默失效。
        let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
        assert!(
            !compact.contains(".download("),
            "安装路径必须只用本地缓存包，不得重新下载"
        );
        assert!(
            compact.contains("update.install("),
            "反向断言：安装路径必须仍然把包交给插件安装"
        );
        assert!(
            compact.contains("verify_package("),
            "反向断言：安装前必须复核缓存包签名（install() 自身不验签）"
        );
    }

    /// 守卫：拿到安装权之后的每个失败出口都必须释放它。
    ///
    /// `installing` 是跨窗口唯一的安装重入闸门。漏释放的后果比不加锁更糟：
    /// 一次「读包失败 / 验签失败」之后标志永久留在 `true`，用户此后点「重试」
    /// 只会得到「正在安装更新，请稍候」，**再也装不上**。
    ///
    /// 因此把 `install_update` 的结构约定钉死：安装权之后**只有末尾一个收口**，
    /// 不许再出现 `?` 或新的 `return Err`（两者都会绕过释放）。
    #[test]
    fn install_failure_paths_release_the_install_token() {
        let source = include_str!("mod.rs");
        let body = function_body(source, "pub async fn install_update(");
        let tail = body
            .split("try_begin_install()")
            .nth(1)
            .expect("install_update 必须通过 try_begin_install() 抢安装权 —— 本守卫依赖它划界");
        // 跳过「抢不到就直接返回」那个 if 块：它发生在**拿到权之前**，不属于收口范围。
        //
        // 切分只认「行首 4 空格缩进的收尾 `}`」，**不写死尾随换行**：CI 跑在
        // windows-latest，仓库又没有 `.gitattributes`，`core.autocrlf=true` 会把检出
        // 的文件变成 CRLF，写死 `\n    }\n` 会在这里直接 panic（本地工作区是 LF，测不出来）。
        let post = tail
            .split_once("\n    }")
            .map(|(_, rest)| rest.trim_start_matches(['\r', '\n']))
            .expect(
                "try_begin_install() 之后应紧跟「抢不到就返回」的 if 块 —— 结构变了请同步本守卫",
            );
        assert_eq!(
            post.matches("release_install()").count(),
            1,
            "持有安装权之后必须恰好有一个释放点（少写会卡死，多写会掩盖漏释放）"
        );
        assert!(
            !post.contains("return Err("),
            "持有安装权之后不得再出现 return Err —— 请把失败路径收进末尾那个 match 的 Err 分支，否则会绕过 release_install()"
        );
        assert!(
            !post.contains("?;"),
            "持有安装权之后不得再用 `?` —— 它会在收口之前提前返回，导致安装权永不释放"
        );
        // 反向断言：读包/验签确实被抽到了 prepare_and_install 里（否则上面几条会因
        // 「整段流程都不在这个函数体里」而假绿）
        assert!(
            function_body(source, "async fn prepare_and_install(").contains("verify_package("),
            "读包与验签应当在 prepare_and_install 里"
        );
    }

    /// 守卫：缓存文件名规则单点定义。
    ///
    /// `store_package` 写出的名字与 `prune_packages` 保留的名字必须是同一个函数算出来的；
    /// 一旦有人只改一处，表现是「下载成功但安装时读不到文件」，而且只在用户点更新时暴露。
    #[test]
    fn package_path_is_single_sourced() {
        let source = include_str!("mod.rs");
        // 生产区（测试模块之前）里，拼接缓存文件名的字面量只允许出现在 package_file_name 中
        let production = source.split("#[cfg(test)]").next().unwrap();
        assert_eq!(
            production.matches("pending-{version}.exe").count(),
            1,
            "缓存文件名的拼装只允许在 package_file_name 里出现一次"
        );
    }
}
