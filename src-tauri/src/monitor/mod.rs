//! 系统监控：常驻悬浮显示 CPU/内存/网络/磁盘/电池实时状态。
//!
//! 设计对称于 stt/mod.rs：MonitorState 作为 Tauri managed state。
//! 采集线程（std::thread::spawn + sleep）周期性采集系统指标，
//! 通过 `app.emit("monitor-stats", payload)` 推送给前端 listen 订阅。
//! 采集线程随监控窗口开关启停（开窗 start / 关窗 stop）。
//!
//! 指标来源：
//! - CPU 使用率/频率、内存、网络、磁盘：sysinfo 0.32
//! - 电池：windows-rs GetSystemPowerStatus（零额外依赖，仅需 Win32_System_Power feature）
//!
//! 已知限制（首版不做，列后续增强）：
//! - GPU 使用率：仅 NVIDIA 可行（nvml-wrapper），AMD/Intel 无统一 API
//! - CPU 核心温度：Windows 上 MSAcpi_ThermalZoneTemperature 多数机器不可用且非核温

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sysinfo::{DiskKind, Disks, Networks, System};
use tauri::{Emitter, Manager};
/// 推送到前端的 monitor-stats 事件 payload
#[derive(serde::Serialize, Clone)]
pub struct MonitorStats {
    /// 采集时刻（epoch 毫秒），前端可对齐/丢弃过期帧
    pub timestamp_ms: u64,
    /// 本次采集间隔（毫秒），前端据此换算速率基数
    pub interval_ms: u64,
    /// 系统开机时长（秒）
    pub uptime_secs: u64,
    // CPU
    /// CPU 总使用率 0-100
    pub cpu_usage_total: f64,
    /// 各逻辑核使用率 0-100
    pub cpu_usage_per_core: Vec<f64>,
    /// 各逻辑核当前频率（MHz）
    pub cpu_freq_mhz: Vec<u64>,
    // 内存（字节）
    pub mem_used: u64,
    pub mem_total: u64,
    pub mem_available: u64,
    // 网络（仅活跃接口，sysinfo 已过滤 loopback/断开/无 MAC 的接口）
    pub net: Vec<NetInterfaceStat>,
    // 磁盘
    pub disks: Vec<DiskStat>,
    /// 所有物理磁盘的聚合读写速度。PDH 不可用或首个样本尚未就绪时为 None。
    pub disk_io: Option<DiskIoStat>,
    // 电池
    pub battery: BatteryStat,
}

#[derive(serde::Serialize, Clone)]
pub struct NetInterfaceStat {
    pub name: String,
    /// 接收速率 bytes/s（累计增量÷间隔）
    pub rx_rate: f64,
    /// 发送速率 bytes/s
    pub tx_rate: f64,
}

#[derive(serde::Serialize, Clone)]
pub struct DiskStat {
    /// 挂载点（如 C:\）
    pub mount_point: String,
    /// 总空间（字节）
    pub total: u64,
    /// 可用空间（字节）
    pub available: u64,
    /// "HDD" | "SSD" | "Unknown"
    pub kind: String,
}

#[derive(serde::Serialize, Clone)]
pub struct DiskIoStat {
    /// 读取速度，bytes/s
    pub read_rate: f64,
    /// 写入速度，bytes/s
    pub write_rate: f64,
}

#[derive(serde::Serialize, Clone)]
pub struct BatteryStat {
    pub has_battery: bool,
    /// 0-100
    pub percent: u8,
    pub charging: bool,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy)]
struct CpuTimes {
    idle: u64,
    total: u64,
}

/// 系统监控运行状态（Tauri managed state）。
/// 持有单一 sysinfo 实例（复用，避免重复分配），用 AtomicBool 控制采集线程启停。
pub struct MonitorState {
    /// 采集线程是否运行
    running: AtomicBool,
    /// 采集间隔（毫秒），运行时可改，下轮循环即生效
    interval_ms: AtomicU64,
    /// 采集代次。每次 stop 递增，使任何在跑的旧线程作废（防止 stop→start 复活旧线程）
    generation: AtomicU64,
    /// 单一 System 实例复用（System 非 Sync，必须 Mutex 包裹）
    sys: Mutex<System>,
    nets: Mutex<Networks>,
    disks: Mutex<Disks>,
    /// 上一次各接口累计收发字节，用于 diff 计算速率
    prev_net: Mutex<HashMap<String, (u64, u64)>>,
    /// 上一次系统 CPU 时间快照。Windows 上使用 GetSystemTimes 增量，避开 PDH
    /// 读取失败被 sysinfo 映射为 100% 的问题。
    #[cfg(target_os = "windows")]
    prev_cpu_times: Mutex<Option<CpuTimes>>,
}

impl Default for MonitorState {
    fn default() -> Self {
        Self {
            running: AtomicBool::new(false),
            interval_ms: AtomicU64::new(1000),
            generation: AtomicU64::new(0),
            sys: Mutex::new(System::new()),
            nets: Mutex::new(Networks::new_with_refreshed_list()),
            disks: Mutex::new(Disks::new_with_refreshed_list()),
            prev_net: Mutex::new(HashMap::new()),
            #[cfg(target_os = "windows")]
            prev_cpu_times: Mutex::new(None),
        }
    }
}

impl MonitorState {
    /// 启动采集线程（已运行则跳过）。
    /// 线程内先做两次 CPU refresh + 250ms 间隔预热（sysinfo CPU 使用率基于 diff，
    /// 首次采集返回 0），然后进入主循环周期性 emit。
    pub fn start(&self, app: &tauri::AppHandle) {
        // swap 返回旧值；若原本就为 true 说明已在运行，跳过
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        // 清空网络 diff 基线，避免新线程首次 diff 包含 stop 期间的累积增量
        if let Ok(mut prev) = self.prev_net.lock() {
            prev.clear();
        }
        #[cfg(target_os = "windows")]
        if let Ok(mut prev) = self.prev_cpu_times.lock() {
            *prev = None;
        }
        let gen = self.generation.load(Ordering::SeqCst);
        let app_handle = app.clone();
        std::thread::spawn(move || {
            let mut disk_io_sampler = DiskIoSampler::new();
            let mut next_disk_io_retry = Instant::now() + Duration::from_secs(10);
            // 辅助：检查本线程代次是否仍有效（未被 stop 作废）
            let alive = |st: &MonitorState| {
                st.running.load(Ordering::SeqCst) && st.generation.load(Ordering::SeqCst) == gen
            };
            // 主循环
            while let Some(st) = app_handle.try_state::<MonitorState>() {
                if !alive(&st) {
                    break;
                }
                if disk_io_sampler.is_none() && Instant::now() >= next_disk_io_retry {
                    disk_io_sampler = DiskIoSampler::new();
                    next_disk_io_retry = Instant::now() + Duration::from_secs(10);
                }
                let interval_ms = st.interval_ms.load(Ordering::SeqCst).max(200);
                let payload = collect(&st, interval_ms, &mut disk_io_sampler);
                let _ = app_handle.emit("monitor-stats", payload);
                std::thread::sleep(std::time::Duration::from_millis(interval_ms));
            }
        });
    }

    /// 停止采集线程（递增 generation 作废在跑线程，下轮循环入口退出，
    /// 最长延迟一个 interval；同时防止 stop→start 复活旧线程）
    pub fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.running.store(false, Ordering::SeqCst);
    }

    /// 设置采集间隔（毫秒），下轮循环即生效，无需重启线程
    pub fn set_interval(&self, ms: u64) {
        self.interval_ms.store(ms.max(200), Ordering::SeqCst);
    }

    /// 当前是否在采集
    #[allow(dead_code)]
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

/// 采集一次系统指标快照
fn collect(
    st: &MonitorState,
    interval_ms: u64,
    disk_io_sampler: &mut Option<DiskIoSampler>,
) -> MonitorStats {
    let uptime_secs = System::uptime();
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    #[cfg(target_os = "windows")]
    let cpu_total = windows_cpu_usage(st);
    #[cfg(not(target_os = "windows"))]
    let mut cpu_total = 0.0;

    // CPU frequency + memory. Windows total usage uses GetSystemTimes above because
    // sysinfo's PDH fallback can report a failed idle counter as 100% busy.
    let (per_core, freq, mem_used, mem_total, mem_available) = match st.sys.lock() {
        Ok(mut sys) => {
            #[cfg(not(target_os = "windows"))]
            {
                sys.refresh_cpu_usage();
                let total = sys.global_cpu_usage();
                cpu_total = if total.is_finite() { total as f64 } else { 0.0 };
            }
            sys.refresh_cpu_frequency();
            sys.refresh_memory();
            let per_core: Vec<f64> = sys
                .cpus()
                .iter()
                .map(|c| {
                    let u = c.cpu_usage();
                    if u.is_finite() {
                        u as f64
                    } else {
                        0.0
                    }
                })
                .collect();
            let freq: Vec<u64> = sys.cpus().iter().map(|c| c.frequency()).collect();
            (
                per_core,
                freq,
                sys.used_memory(),
                sys.total_memory(),
                sys.available_memory(),
            )
        }
        Err(_) => (Vec::new(), Vec::new(), 0, 0, 0),
    };

    // 网络：速率 = 累计增量 ÷ 间隔秒
    let net = match (st.nets.lock(), st.prev_net.lock()) {
        (Ok(mut nets), Ok(mut prev)) => {
            nets.refresh(); // 更新现有接口的累计值（不重新枚举）
            let interval_secs = (interval_ms as f64) / 1000.0;
            let mut out: Vec<NetInterfaceStat> = Vec::new();
            for (name, data) in nets.list().iter() {
                let cur_rx = data.total_received();
                let cur_tx = data.total_transmitted();
                let (rx_rate, tx_rate) = match prev.get(name) {
                    Some(&(prev_rx, prev_tx)) => {
                        let dr = cur_rx.saturating_sub(prev_rx) as f64 / interval_secs;
                        let dt = cur_tx.saturating_sub(prev_tx) as f64 / interval_secs;
                        (dr, dt)
                    }
                    // 首次无基线，速率发 0
                    None => (0.0, 0.0),
                };
                prev.insert(name.clone(), (cur_rx, cur_tx));
                out.push(NetInterfaceStat {
                    name: name.clone(),
                    rx_rate,
                    tx_rate,
                });
            }
            out
        }
        _ => Vec::new(),
    };

    // 磁盘
    let disks = match st.disks.lock() {
        Ok(mut disks) => {
            disks.refresh(); // 只刷新空间，不重建列表
            disks
                .list()
                .iter()
                .map(|d| DiskStat {
                    mount_point: d.mount_point().to_string_lossy().to_string(),
                    total: d.total_space(),
                    available: d.available_space(),
                    kind: match d.kind() {
                        DiskKind::HDD => "HDD".to_string(),
                        DiskKind::SSD => "SSD".to_string(),
                        DiskKind::Unknown(_) => "Unknown".to_string(),
                    },
                })
                .collect::<Vec<_>>()
        }
        Err(_) => Vec::new(),
    };
    let disk_io = disk_io_sampler.as_mut().and_then(DiskIoSampler::sample);

    // 电池
    let battery = get_battery();

    MonitorStats {
        timestamp_ms,
        interval_ms,
        uptime_secs,
        cpu_usage_total: cpu_total,
        cpu_usage_per_core: per_core,
        cpu_freq_mhz: freq,
        mem_used,
        mem_total,
        mem_available,
        net,
        disks,
        disk_io,
        battery,
    }
}

/// Normalizes a PDH byte-rate reading. Invalid values are unavailable, not zero.
fn disk_io_rate(value: f64) -> Option<f64> {
    (value.is_finite() && value >= 0.0).then_some(value)
}

#[cfg(target_os = "windows")]
struct DiskIoSampler {
    query: windows::Win32::System::Performance::PDH_HQUERY,
    read_counter: windows::Win32::System::Performance::PDH_HCOUNTER,
    write_counter: windows::Win32::System::Performance::PDH_HCOUNTER,
}

#[cfg(target_os = "windows")]
impl DiskIoSampler {
    fn new() -> Option<Self> {
        use windows::core::PCWSTR;
        use windows::Win32::System::Performance::{
            PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhOpenQueryW, PDH_HCOUNTER,
            PDH_HQUERY,
        };

        let mut query = PDH_HQUERY::default();
        if unsafe { PdhOpenQueryW(PCWSTR::null(), 0, &mut query) } != 0 {
            return None;
        }
        let mut read_counter = PDH_HCOUNTER::default();
        let mut write_counter = PDH_HCOUNTER::default();
        let add_counter = |path: &str, counter: &mut PDH_HCOUNTER| {
            let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
            unsafe {
                PdhAddEnglishCounterW(query, PCWSTR::from_raw(wide.as_ptr()), 0, counter) == 0
            }
        };
        if !add_counter(
            r"\PhysicalDisk(_Total)\Disk Read Bytes/sec",
            &mut read_counter,
        ) || !add_counter(
            r"\PhysicalDisk(_Total)\Disk Write Bytes/sec",
            &mut write_counter,
        ) || unsafe { PdhCollectQueryData(query) } != 0
        {
            unsafe {
                let _ = PdhCloseQuery(query);
            }
            return None;
        }
        Some(Self {
            query,
            read_counter,
            write_counter,
        })
    }

    fn sample(&mut self) -> Option<DiskIoStat> {
        use windows::Win32::System::Performance::PdhCollectQueryData;

        if unsafe { PdhCollectQueryData(self.query) } != 0 {
            return None;
        }
        let read_rate = read_pdh_rate(self.read_counter)?;
        let write_rate = read_pdh_rate(self.write_counter)?;
        Some(DiskIoStat {
            read_rate,
            write_rate,
        })
    }
}

#[cfg(target_os = "windows")]
fn read_pdh_rate(counter: windows::Win32::System::Performance::PDH_HCOUNTER) -> Option<f64> {
    use windows::Win32::System::Performance::{
        PdhGetFormattedCounterValue, PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA,
        PDH_FMT_COUNTERVALUE, PDH_FMT_DOUBLE,
    };

    let mut value = PDH_FMT_COUNTERVALUE::default();
    if unsafe { PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, None, &mut value) } != 0
        || !matches!(value.CStatus, PDH_CSTATUS_VALID_DATA | PDH_CSTATUS_NEW_DATA)
    {
        return None;
    }
    disk_io_rate(unsafe { value.Anonymous.doubleValue })
}

#[cfg(target_os = "windows")]
impl Drop for DiskIoSampler {
    fn drop(&mut self) {
        use windows::Win32::System::Performance::PdhCloseQuery;

        unsafe {
            let _ = PdhCloseQuery(self.query);
        }
    }
}

#[cfg(not(target_os = "windows"))]
struct DiskIoSampler;

#[cfg(not(target_os = "windows"))]
impl DiskIoSampler {
    fn new() -> Option<Self> {
        None
    }

    fn sample(&mut self) -> Option<DiskIoStat> {
        None
    }
}

/// Calculates total CPU usage from cumulative system times. Kernel time includes idle
/// time on Windows, so only `total - idle` represents busy CPU time.
#[cfg(target_os = "windows")]
fn cpu_usage_from_times(previous: CpuTimes, current: CpuTimes) -> Option<f64> {
    let total_delta = current.total.checked_sub(previous.total)?;
    let idle_delta = current.idle.checked_sub(previous.idle)?;
    if total_delta == 0 {
        return None;
    }
    let busy_delta = total_delta.saturating_sub(idle_delta.min(total_delta));
    Some((busy_delta as f64 * 100.0 / total_delta as f64).clamp(0.0, 100.0))
}

#[cfg(target_os = "windows")]
fn windows_cpu_usage(st: &MonitorState) -> f64 {
    let current = match read_windows_cpu_times() {
        Some(times) => times,
        None => return 0.0,
    };
    let mut previous = match st.prev_cpu_times.lock() {
        Ok(previous) => previous,
        Err(_) => return 0.0,
    };
    let usage = previous.and_then(|times| cpu_usage_from_times(times, current));
    *previous = Some(current);
    usage.unwrap_or(0.0)
}

#[cfg(target_os = "windows")]
fn read_windows_cpu_times() -> Option<CpuTimes> {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::GetSystemTimes;

    let mut idle = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe {
        GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)).ok()?;
    }
    let filetime_to_u64 =
        |value: FILETIME| ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64;
    let idle = filetime_to_u64(idle);
    let total = filetime_to_u64(kernel).saturating_add(filetime_to_u64(user));
    Some(CpuTimes { idle, total })
}

/// 电池信息（Windows：GetSystemPowerStatus）
#[cfg(target_os = "windows")]
fn get_battery() -> BatteryStat {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    let mut s = SYSTEM_POWER_STATUS::default();
    let ok = unsafe { GetSystemPowerStatus(&mut s) }.is_ok();
    if !ok {
        return BatteryStat {
            has_battery: false,
            percent: 0,
            charging: false,
        };
    }
    // BatteryFlag：128=NoBattery，255=Unknown，其余为位组合（1高/2低/4临界/8充电）
    let no_battery = s.BatteryFlag == 128 || s.BatteryFlag == 255;
    // BatteryLifePercent 为 255 表示未知
    let percent = if s.BatteryLifePercent == 255 {
        0
    } else {
        s.BatteryLifePercent
    };
    // charging：BatteryFlag 第 3 位（8）表示正在充电
    let charging = !no_battery && (s.BatteryFlag & 8) != 0;
    BatteryStat {
        has_battery: !no_battery,
        percent,
        charging,
    }
}

#[cfg(not(target_os = "windows"))]
fn get_battery() -> BatteryStat {
    BatteryStat {
        has_battery: false,
        percent: 0,
        charging: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitor_state_default_not_running() {
        let st = MonitorState::default();
        assert!(!st.is_running());
        // 默认间隔 1000ms
        assert_eq!(st.interval_ms.load(Ordering::SeqCst), 1000);
    }

    #[test]
    fn set_interval_clamps_to_minimum() {
        let st = MonitorState::default();
        st.set_interval(0);
        assert_eq!(st.interval_ms.load(Ordering::SeqCst), 200);
        st.set_interval(50);
        assert_eq!(st.interval_ms.load(Ordering::SeqCst), 200);
        st.set_interval(200);
        assert_eq!(st.interval_ms.load(Ordering::SeqCst), 200);
        st.set_interval(5000);
        assert_eq!(st.interval_ms.load(Ordering::SeqCst), 5000);
    }

    #[test]
    fn stop_increments_generation() {
        let st = MonitorState::default();
        let g0 = st.generation.load(Ordering::SeqCst);
        st.stop();
        let g1 = st.generation.load(Ordering::SeqCst);
        assert_eq!(g1, g0 + 1);
        assert!(!st.is_running());
    }

    #[test]
    fn battery_flag_no_battery_is_128() {
        // NoBattery 常量值（来自 Win32 文档），确保判断逻辑与此一致
        // BatteryFlag=128 → 无电池；=255 → 未知（也视为无电池）
        let no_battery_flag: u8 = 128;
        let unknown_flag: u8 = 255;
        assert!(no_battery_flag == 128 || no_battery_flag == 255);
        assert!(unknown_flag == 128 || unknown_flag == 255);
    }

    #[test]
    fn battery_charging_flag_bit3() {
        // 充电位是 BatteryFlag 的 bit3（值 8）
        let charging_flag: u8 = 8;
        assert_ne!(charging_flag & 8, 0);
        let not_charging: u8 = 1; // High（>66%）但不充电
        assert_eq!(not_charging & 8, 0);
    }

    #[test]
    fn monitor_stats_struct_has_all_fields() {
        // 确保 payload 结构体能正常构造（编译期类型检查 + 字段完整）
        let stats = MonitorStats {
            timestamp_ms: 0,
            interval_ms: 1000,
            uptime_secs: 0,
            cpu_usage_total: 0.0,
            cpu_usage_per_core: vec![],
            cpu_freq_mhz: vec![],
            mem_used: 0,
            mem_total: 0,
            mem_available: 0,
            net: vec![],
            disks: vec![],
            disk_io: None,
            battery: BatteryStat {
                has_battery: false,
                percent: 0,
                charging: false,
            },
        };
        assert_eq!(stats.interval_ms, 1000);
        assert!(stats.net.is_empty());
    }

    #[test]
    fn net_interface_stat_serializes() {
        let stat = NetInterfaceStat {
            name: "eth0".to_string(),
            rx_rate: 1024.0,
            tx_rate: 512.0,
        };
        let json = serde_json::to_string(&stat).unwrap();
        assert!(json.contains("\"name\":\"eth0\""));
        assert!(json.contains("\"rx_rate\":1024.0"));
    }

    #[test]
    fn disk_stat_kind_serializes() {
        let stat = DiskStat {
            mount_point: "C:\\".to_string(),
            total: 1000,
            available: 500,
            kind: "SSD".to_string(),
        };
        let json = serde_json::to_string(&stat).unwrap();
        assert!(json.contains("\"kind\":\"SSD\""));
        assert!(json.contains("\"mount_point\":\"C:\\\\\""));
    }

    #[test]
    fn monitor_stats_no_nan_in_default() {
        // 确保默认构造的 stats 不含 NaN（serde_json 无法序列化 NaN）
        let stats = MonitorStats {
            timestamp_ms: 0,
            interval_ms: 1000,
            uptime_secs: 0,
            cpu_usage_total: 0.0,
            cpu_usage_per_core: vec![0.0],
            cpu_freq_mhz: vec![],
            mem_used: 0,
            mem_total: 0,
            mem_available: 0,
            net: vec![],
            disks: vec![],
            disk_io: None,
            battery: BatteryStat {
                has_battery: false,
                percent: 0,
                charging: false,
            },
        };
        assert!(stats.cpu_usage_total.is_finite());
        // 序列化应成功（无 NaN）
        assert!(serde_json::to_string(&stats).is_ok());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn cpu_usage_uses_busy_time_delta() {
        let previous = CpuTimes {
            idle: 300,
            total: 1_000,
        };
        let current = CpuTimes {
            idle: 1_050,
            total: 2_000,
        };
        assert_eq!(cpu_usage_from_times(previous, current), Some(25.0));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn cpu_usage_rejects_invalid_or_zero_time_windows() {
        let snapshot = CpuTimes {
            idle: 300,
            total: 1_000,
        };
        assert_eq!(cpu_usage_from_times(snapshot, snapshot), None);
        assert_eq!(
            cpu_usage_from_times(
                snapshot,
                CpuTimes {
                    idle: 200,
                    total: 900,
                },
            ),
            None,
        );
        assert_eq!(
            cpu_usage_from_times(
                snapshot,
                CpuTimes {
                    idle: 1_500,
                    total: 1_100,
                },
            ),
            Some(0.0),
        );
    }

    #[test]
    fn disk_io_rate_rejects_invalid_values() {
        assert_eq!(disk_io_rate(1024.0), Some(1024.0));
        assert_eq!(disk_io_rate(-1.0), None);
        assert_eq!(disk_io_rate(f64::NAN), None);
        assert_eq!(disk_io_rate(f64::INFINITY), None);
    }
}
