//! Lightweight diagnostics for installed builds. The log is bounded and kept
//! in the same per-user data directory as the application configuration.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const LOG_FILE: &str = "levitaire.log";
const ROTATED_FILE: &str = "levitaire.log.1";
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const MAX_MESSAGE_BYTES: usize = 32 * 1024;
static LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn log_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Levitaire")
        .join(LOG_FILE)
}

fn write_line(tag: &str, msg: &str) {
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::metadata(&path)
        .map(|m| m.len() >= MAX_LOG_BYTES)
        .unwrap_or(false)
    {
        let rotated = path.with_file_name(ROTATED_FILE);
        let _ = fs::remove_file(&rotated);
        let _ = fs::rename(&path, rotated);
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let tag = tag.replace(['\r', '\n'], " ");
    let mut bounded = msg.replace(['\r', '\n'], " ");
    if bounded.len() > MAX_MESSAGE_BYTES {
        let mut end = MAX_MESSAGE_BYTES;
        while !bounded.is_char_boundary(end) {
            end -= 1;
        }
        bounded.truncate(end);
        bounded.push_str("... [truncated]");
    }
    let _ = writeln!(file, "[{timestamp}][{tag}] {bounded}");
}

pub fn log(tag: &str, msg: &str) {
    let lock = LOG_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    write_line(tag, msg);
}

/// Install process-level diagnostics before any WebView is created.
pub fn init() {
    static INITIALIZED: OnceLock<()> = OnceLock::new();
    INITIALIZED.get_or_init(|| {
        std::panic::set_hook(Box::new(|panic| {
            let location = panic
                .location()
                .map(|value| value.to_string())
                .unwrap_or_else(|| "<unknown>".to_string());
            log("panic", &format!("location={location}; {panic}"));
        }));
        log(
            "startup",
            &format!(
                "version={} profile={}",
                env!("CARGO_PKG_VERSION"),
                if cfg!(debug_assertions) {
                    "debug"
                } else {
                    "release"
                }
            ),
        );
    });
}
