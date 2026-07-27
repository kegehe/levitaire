/// 统一日志模块
///
/// - 仅在 debug 构建时启用日志写入
/// - 日志写入应用数据目录下的 floatory-debug.log（而非相对路径）
/// - Release 构建中 log() 为空操作，不会泄露用户数据
#[cfg(debug_assertions)]
use std::io::Write;

#[cfg(debug_assertions)]
pub fn log(tag: &str, msg: &str) {
    let log_dir = dirs::data_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let log_path = log_dir.join("floatory-debug.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| format!("{}.{:03}", d.as_secs(), d.subsec_millis()))
            .unwrap_or_default();
        let _ = writeln!(f, "[{}][{}] {}", timestamp, tag, msg);
    }
}

#[cfg(not(debug_assertions))]
pub fn log(_tag: &str, _msg: &str) {
    // Release 构建中不写日志，避免隐私泄露和性能开销
}
