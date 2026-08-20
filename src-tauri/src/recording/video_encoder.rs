//! 视频编码器：通过 ffmpeg 子进程 pipe 编码 MP4。
//! 将 BGRA 帧写入 ffmpeg stdin，编码为 H.264 MP4。

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn ffmpeg_path(extra_candidates: &[PathBuf]) -> PathBuf {
    if let Ok(path) = std::env::var("LEVITAIRE_FFMPEG_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return path;
        }
    }

    for candidate in extra_candidates {
        if candidate.is_file() {
            return candidate.clone();
        }
    }

    let candidates = [
        PathBuf::from("ffmpeg.exe"),
        PathBuf::from("src-tauri/binaries/ffmpeg.exe"),
        PathBuf::from("src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe"),
        PathBuf::from("binaries/ffmpeg.exe"),
        PathBuf::from("binaries/ffmpeg-x86_64-pc-windows-msvc.exe"),
    ];
    for candidate in candidates {
        if candidate.is_file() {
            return candidate;
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["ffmpeg.exe", "ffmpeg-x86_64-pc-windows-msvc.exe"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }

    PathBuf::from("ffmpeg")
}

/// ffmpeg 编码器，通过 pipe 接收原始帧数据
pub struct FfmpegEncoder {
    child: Child,
    frame_size: usize,
}

impl FfmpegEncoder {
    /// 创建新的 ffmpeg 编码器
    /// - width/height: 视频尺寸
    /// - fps: 帧率
    /// - output_path: 输出文件路径
    pub fn new(
        width: u32,
        height: u32,
        fps: u32,
        output_path: &std::path::Path,
        extra_candidates: &[PathBuf],
    ) -> Result<Self, String> {
        let frame_size = (width as usize) * (height as usize) * 4; // BGRA

        let encoder_path = ffmpeg_path(extra_candidates);
        crate::utils::logger::log(
            "recording",
            &format!("using ffmpeg binary: {}", encoder_path.to_string_lossy()),
        );

        let mut child = Command::new(&encoder_path)
            .arg("-y") // 覆盖已有文件
            .arg("-loglevel")
            .arg("error")
            .arg("-f")
            .arg("rawvideo")
            .arg("-pix_fmt")
            .arg("bgra")
            .arg("-s")
            .arg(format!("{}x{}", width, height))
            .arg("-r")
            .arg(fps.to_string())
            .arg("-i")
            .arg("-") // 从 stdin 读取
            .arg("-c:v")
            .arg("libx264")
            .arg("-preset")
            .arg("ultrafast")
            .arg("-crf")
            .arg("23")
            // H.264 yuv420p 要求偶数宽高；奇数尺寸时裁剪最右一列/最下一行，
            // 而不是 pad 补黑边，避免成片右侧/底部出现黑边。
            .arg("-vf")
            .arg("crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0")
            .arg("-pix_fmt")
            .arg("yuv420p")
            .arg("-movflags")
            .arg("+faststart")
            .arg(output_path.to_string_lossy().as_ref())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                format!(
                    "启动 ffmpeg 失败: {}。请安装 ffmpeg，或将 ffmpeg.exe 放到 src-tauri/binaries/ffmpeg.exe，或设置 LEVITAIRE_FFMPEG_PATH。当前路径: {}",
                    e,
                    encoder_path.to_string_lossy()
                )
            })?;

        // 验证 stdin 可用
        if child.stdin.is_none() {
            let _ = child.kill();
            return Err("无法获取 ffmpeg stdin".to_string());
        }

        Ok(Self { child, frame_size })
    }

    /// 写入一帧 BGRA 数据
    pub fn write_frame(&mut self, bgra: &[u8]) -> Result<(), String> {
        if bgra.len() != self.frame_size {
            return Err(format!(
                "帧大小不匹配: 期望 {}, 实际 {}",
                self.frame_size,
                bgra.len()
            ));
        }
        if let Some(ref mut stdin) = self.child.stdin {
            stdin
                .write_all(bgra)
                .map_err(|e| format!("写入 ffmpeg 失败: {}", e))
        } else {
            Err("ffmpeg stdin 不可用".to_string())
        }
    }

    /// 完成编码：关闭 stdin 并等待 ffmpeg 退出
    pub fn finish(self, timeout: Duration) -> Result<(), String> {
        self.finish_with_cancel(timeout, || false)
    }

    /// 完成编码，并允许调用方在等待期间取消 ffmpeg。
    pub fn finish_with_cancel<F>(mut self, timeout: Duration, mut should_cancel: F) -> Result<(), String>
    where
        F: FnMut() -> bool,
    {
        // 关闭 stdin 通知 ffmpeg 输入结束
        drop(self.child.stdin.take());

        let started = Instant::now();
        let status = loop {
            if should_cancel() {
                let _ = self.child.kill();
                let _ = self.child.wait();
                return Err("ffmpeg 编码已取消".to_string());
            }
            match self.child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {
                    if started.elapsed() >= timeout {
                        let _ = self.child.kill();
                        let _ = self.child.wait();
                        return Err(format!("ffmpeg 编码超时（超过 {} 秒）", timeout.as_secs()));
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(format!("等待 ffmpeg 退出失败: {}", e)),
            }
        };

        if !status.success() {
            return Err(format!("ffmpeg 退出码: {}", status));
        }

        Ok(())
    }
}

impl Drop for FfmpegEncoder {
    fn drop(&mut self) {
        // 仅在子进程尚未退出时 kill，避免对已正常退出的 ffmpeg 二次操作
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── ffmpeg_path 测试 ──────────────────────────────────────────

    #[test]
    fn ffmpeg_path_uses_env_var_when_set() {
        // 创建一个临时文件模拟 ffmpeg
        let tmp = std::env::temp_dir().join("_levitaire_test_ffmpeg_env.exe");
        std::fs::write(&tmp, b"").ok();
        std::env::set_var("LEVITAIRE_FFMPEG_PATH", tmp.to_string_lossy().as_ref());
        let result = ffmpeg_path(&[]);
        // 清理放在断言之前，确保即使断言失败也不会残留环境变量
        std::env::remove_var("LEVITAIRE_FFMPEG_PATH");
        let _ = std::fs::remove_file(&tmp);
        assert_eq!(result, tmp);
    }

    #[test]
    fn ffmpeg_path_falls_back_to_candidates() {
        std::env::remove_var("LEVITAIRE_FFMPEG_PATH");
        // 传入一个不存在的候选路径，但当前目录或 exe 目录可能存在 ffmpeg，
        // 因此只验证函数不会 panic，返回值为某个 PathBuf
        let non_existent = PathBuf::from("_ certainly_not_exists_ffmpeg_xyz.exe");
        let result = ffmpeg_path(&[non_existent]);
        // 至少返回一个路径，不会 panic
        assert!(!result.as_os_str().is_empty());
    }

    #[test]
    fn ffmpeg_path_uses_extra_candidate_when_present() {
        std::env::remove_var("LEVITAIRE_FFMPEG_PATH");
        let tmp = std::env::temp_dir().join("_levitaire_test_extra_ffmpeg.exe");
        std::fs::write(&tmp, b"").ok();
        let result = ffmpeg_path(&[tmp.clone()]);
        let _ = std::fs::remove_file(&tmp);
        assert_eq!(result, tmp);
    }

    // ── write_frame 帧大小校验 ─────────────────────────────────────

    #[test]
    fn write_frame_rejects_wrong_sized_data() {
        // 创建一个真实的子进程，用 echo 替代 ffmpeg
        let child = std::process::Command::new("cmd")
            .arg("/c")
            .arg("echo")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("cmd /c echo should be available on Windows");

        let mut encoder = FfmpegEncoder {
            child,
            frame_size: 16, // 期望 4×4×4 = 16 字节
        };

        // 大小不匹配
        assert!(encoder.write_frame(&[0u8; 10]).is_err());
        // 大小匹配
        assert!(encoder.write_frame(&[0u8; 16]).is_ok());
        // drop 会 kill 子进程
    }

    #[test]
    fn write_frame_fails_when_stdin_is_none() {
        let mut child = std::process::Command::new("cmd")
            .arg("/c")
            .arg("echo")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("cmd /c echo should be available on Windows");

        let stdin = child.stdin.take().unwrap();
        drop(stdin); // 关闭 stdin 句柄，使 child.stdin 变为 None

        let mut encoder = FfmpegEncoder {
            child,
            frame_size: 4,
        };

        assert!(encoder.write_frame(&[0u8; 4]).is_err());
    }

    // ── finish / finish_with_cancel 测试 ────────────────────────────

    #[test]
    fn finish_waits_for_child_exit() {
        // cmd /c echo 会立即退出
        let child = std::process::Command::new("cmd")
            .arg("/c").arg("echo").arg("hello")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("cmd /c echo should be available on Windows");

        let encoder = FfmpegEncoder {
            child,
            frame_size: 16,
        };

        // echo 立即退出，finish 应该很快完成
        let result = encoder.finish(std::time::Duration::from_secs(5));
        assert!(result.is_ok());
    }

    #[test]
    fn finish_with_cancel_stops_waiting_when_canceled() {
        // 使用一个不会立即退出的进程: cmd /c timeout /t 60
        let child = std::process::Command::new("cmd")
            .arg("/c")
            .arg("timeout")
            .arg("/t")
            .arg("60")
            .arg("/nobreak")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("cmd /c timeout should be available on Windows");

        let encoder = FfmpegEncoder {
            child,
            frame_size: 16,
        };

        // 立即触发取消
        let result = encoder.finish_with_cancel(
            std::time::Duration::from_secs(30),
            || true, // 立即取消
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("已取消"));
    }

    #[test]
    fn finish_timouts_when_child_hangs() {
        // 使用 PowerShell Start-Sleep 模拟长时间挂起（stdin 为 piped 时不会提前退出）
        let child = std::process::Command::new("powershell")
            .arg("-NoProfile")
            .arg("-Command")
            .arg("Start-Sleep -Seconds 300")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("powershell should be available on Windows");

        let encoder = FfmpegEncoder {
            child,
            frame_size: 16,
        };

        let result = encoder.finish(std::time::Duration::from_millis(500));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("超时"));
    }

    // ── Drop 安全退出测试 ─────────────────────────────────────────

    #[test]
    fn drop_handles_already_exited_process() {
        // cmd /c echo 会立即退出
        let child = std::process::Command::new("cmd")
            .arg("/c").arg("echo")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("cmd /c echo should be available on Windows");

        let encoder = FfmpegEncoder {
            child,
            frame_size: 16,
        };

        // 先正常 finish（子进程退出）
        encoder.finish(std::time::Duration::from_secs(5)).ok();

        // drop 不应 panic（子进程已退出，try_wait 返回 Some）
        // 这个测试通过不 panic 来验证
    }

    #[test]
    fn drop_kills_running_process() {
        // 使用 PowerShell Start-Sleep 确保进程在 drop 时仍在运行
        let child = std::process::Command::new("powershell")
            .arg("-NoProfile")
            .arg("-Command")
            .arg("Start-Sleep -Seconds 300")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("powershell should be available on Windows");

        let encoder = FfmpegEncoder {
            child,
            frame_size: 16,
        };

        // 直接 drop，不应 panic，且子进程应被 kill
        drop(encoder);
        // 通过不 panic 来验证正确性
    }
}
