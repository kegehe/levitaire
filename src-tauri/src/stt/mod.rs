//! 语音输入（STT）：云端识别方案（OpenAI 兼容接口）。
//!
//! 设计对称于 tts/mod.rs：SttState 作为 Tauri managed state。
//! 识别请求发到云端（POST {base_url}/v1/audio/transcriptions），
//! 本地不存模型、不占常驻内存、不占 CPU。仅需联网 + API key。
//!
//! 支持任何 OpenAI 兼容的 STT 平台（官方 OpenAI、Groq、DeepInfra 等），
//! 用户在设置页配置 base_url + api_key + model。

use std::sync::Mutex;

use tauri::Emitter;
use tokio_util::sync::CancellationToken;

/// STT 运行状态（Tauri managed state）。
/// 云端方案无需持有模型/上下文，仅保留取消标志。
pub struct SttState {
    cancellation: Mutex<CancellationToken>,
}

impl Default for SttState {
    fn default() -> Self {
        Self {
            cancellation: Mutex::new(CancellationToken::new()),
        }
    }
}

impl SttState {
    /// 设置取消标志（中断进行中的识别）
    pub fn cancel(&self) {
        if let Ok(token) = self.cancellation.lock() {
            token.cancel();
        }
    }

    /// Starts a new request and invalidates any previous in-flight request.
    pub fn begin_request(&self) -> CancellationToken {
        let next = CancellationToken::new();
        if let Ok(mut current) = self.cancellation.lock() {
            let previous = std::mem::replace(&mut *current, next.clone());
            previous.cancel();
        }
        next
    }
}

/// 推送到前端的 stt-status 事件 payload
#[derive(serde::Serialize, Clone)]
struct SttStatus<'a> {
    phase: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
}

fn emit_error(app: &tauri::AppHandle, message: &str) {
    let _ = app.emit(
        "stt-status",
        SttStatus {
            phase: "error",
            message: Some(message),
        },
    );
}

/// 通知前端开始识别（供 commands.rs 调用，统一 payload 结构）
pub fn emit_transcribing(app: &tauri::AppHandle) {
    let _ = app.emit(
        "stt-status",
        SttStatus {
            phase: "transcribing",
            message: None,
        },
    );
}

/// 云端识别配置（运行时从 config 解析得到）
pub struct SttCloudConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    /// 识别语言，默认 "zh"
    pub language: String,
}

/// 调用云端 STT API 识别音频。
///
/// - `audio`：音频原始字节（webm/opus/wav/mp3 均可，由前端 MediaRecorder 产出）
/// - `mime`：音频 MIME 类型，如 "audio/webm"
/// - `filename`：上传文件名（含扩展名，供服务端识别格式）
///
/// 返回识别文本（已 trim）。失败时 emit stt-status error 并返回 Err。
pub async fn transcribe_cloud(
    app: &tauri::AppHandle,
    cancellation: CancellationToken,
    config: &SttCloudConfig,
    audio: Vec<u8>,
    mime: &str,
    filename: &str,
) -> Result<String, String> {
    if config.api_key.is_empty() {
        let msg = "未配置 STT API Key，请在设置中填写";
        emit_error(app, msg);
        return Err(msg.into());
    }
    if config.base_url.is_empty() {
        let msg = "未配置 STT Base URL";
        emit_error(app, msg);
        return Err(msg.into());
    }
    if config.model.is_empty() {
        let msg = "未配置 STT 模型";
        emit_error(app, msg);
        return Err(msg.into());
    }

    let url = format!(
        "{}/v1/audio/transcriptions",
        config.base_url.trim_end_matches('/')
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    // multipart/form-data：file + model + language + response_format=text
    let mut form = reqwest::multipart::Form::new()
        .text("model", config.model.clone())
        .text("response_format", "text")
        .part(
            "file",
            reqwest::multipart::Part::bytes(audio)
                .file_name(filename.to_string())
                .mime_str(mime)
                .map_err(|e| format!("设置 MIME 失败: {}", e))?,
        );
    // language 仅在非空时发送（部分平台不需要）
    if !config.language.is_empty() {
        form = form.text("language", config.language.clone());
    }

    crate::utils::logger::log(
        "stt",
        &format!("请求云端识别: {} model={}", url, config.model),
    );
    let request = client
        .post(&url)
        .bearer_auth(&config.api_key)
        .multipart(form)
        .send();
    let resp = tokio::select! {
        _ = cancellation.cancelled() => return Err("语音识别已取消".into()),
        result = request => result.map_err(|e| {
            let msg = format!("请求识别服务失败: {}", e);
            emit_error(app, &msg);
            msg
        })?,
    };

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let msg = format!("识别失败：HTTP {} {}", status, body);
        emit_error(app, &msg);
        return Err(msg);
    }

    let text = body.trim().to_string();
    if text.is_empty() {
        let msg = "识别结果为空";
        emit_error(app, msg);
        return Err(msg.into());
    }
    if cancellation.is_cancelled() {
        return Err("已取消".into());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelling_a_request_marks_its_token() {
        let state = SttState::default();
        let token = state.begin_request();
        state.cancel();
        assert!(token.is_cancelled());
    }

    #[test]
    fn starting_a_new_request_cancels_the_previous_one() {
        let state = SttState::default();
        let first = state.begin_request();
        let second = state.begin_request();
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
    }
}
