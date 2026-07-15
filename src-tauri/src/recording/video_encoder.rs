//! 视频编码器：通过 ffmpeg 子进程 pipe 编码 MP4。
//! 将 BGRA 帧写入 ffmpeg stdin，编码为 H.264 MP4。

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn ffmpeg_path(extra_candidates: &[PathBuf]) -> PathBuf {
    if let Ok(path) = std::env::var("FLOAST_FFMPEG_PATH") {
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
            .arg("-vf")
            .arg("pad=ceil(iw/2)*2:ceil(ih/2)*2")
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
                    "启动 ffmpeg 失败: {}。请安装 ffmpeg，或将 ffmpeg.exe 放到 src-tauri/binaries/ffmpeg.exe，或设置 FLOAST_FFMPEG_PATH。当前路径: {}",
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
