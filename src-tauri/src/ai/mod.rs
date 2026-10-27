use crate::config::AiConfig;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

/// AI 响应结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiResponse {
    /// AI 回复的文本内容
    pub content: String,
    /// AI 的思考过程（仅当模型支持 extended thinking 时有值）
    pub thinking: Option<String>,
    /// 使用的模型名称
    pub model: String,
}

/// AI 客户端封装（内部使用 Mutex 实现线程安全的配置更新）
pub struct AiService {
    inner: Mutex<AiServiceInner>,
    /// 每个请求独立的取消令牌；取消时唤醒网络等待并丢弃请求 future，释放连接。
    stream_cancellations: Mutex<StreamCancellationState>,
    next_stream_id: AtomicU64,
}

struct StreamCancellationState {
    active: HashMap<StreamRequestKey, Arc<CancellationToken>>,
    cancelled_before_start: HashSet<StreamRequestKey>,
}

/// Frontend counters restart when a Hook is remounted or a window reloads.
#[derive(Clone, PartialEq, Eq, Hash)]
struct StreamRequestKey {
    window_label: String,
    request_scope: String,
    request_id: u64,
}

impl StreamRequestKey {
    fn new(window_label: &str, request_id: u64, request_scope: Option<&str>) -> Self {
        Self {
            window_label: window_label.to_string(),
            request_scope: request_scope.unwrap_or_default().to_string(),
            request_id,
        }
    }
}

/// AI 服务内部实现
struct AiServiceInner {
    config: AiConfig,
    /// 延迟初始化的 HTTP 客户端（首次调用时创建，避免启动时 TLS 初始化开销）
    /// 外层 Mutex<AiServiceInner> 已提供互斥保护，无需再嵌套 Mutex
    http_client: Option<reqwest::Client>,
}

struct StreamCancellationGuard<'a> {
    service: &'a AiService,
    request_key: StreamRequestKey,
    token: Arc<CancellationToken>,
}

impl Drop for StreamCancellationGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.service.stream_cancellations.lock() {
            if guard
                .active
                .get(&self.request_key)
                .is_some_and(|token| Arc::ptr_eq(token, &self.token))
            {
                guard.active.remove(&self.request_key);
            }
        }
    }
}

impl AiServiceInner {
    /// 获取或延迟创建 HTTP 客户端
    fn get_client(&mut self) -> Result<reqwest::Client, String> {
        if let Some(ref client) = self.http_client {
            return Ok(client.clone());
        }
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| format!("无法创建 HTTP 客户端: {}", e))?;
        self.http_client = Some(client.clone());
        Ok(client)
    }
}

// ─── 请求构建（纯函数）────────────────────────────────────────

/// 根据 API 类型构建请求体
fn build_request_body(
    api_type: &str,
    model: &str,
    prompt: &str,
    system_prompt: Option<&str>,
) -> serde_json::Value {
    match api_type {
        "openai" => {
            let mut messages: Vec<serde_json::Value> = Vec::new();
            if let Some(sys) = system_prompt {
                if !sys.is_empty() {
                    messages.push(serde_json::json!({ "role": "system", "content": sys }));
                }
            }
            messages.push(serde_json::json!({ "role": "user", "content": prompt }));
            serde_json::json!({ "model": model, "messages": messages, "max_tokens": 4096 })
        }
        _ => {
            let mut body = serde_json::json!({
                "model": model,
                "max_tokens": 4096,
                "messages": [{ "role": "user", "content": prompt }]
            });
            if let Some(sys) = system_prompt {
                if !sys.is_empty() {
                    body["system"] = serde_json::Value::String(sys.to_string());
                }
            }
            body
        }
    }
}

/// 根据 API 类型构建请求头
fn build_headers(api_type: &str, api_key: &str) -> Vec<(String, String)> {
    match api_type {
        "openai" => vec![("Authorization".to_string(), format!("Bearer {}", api_key))],
        _ => vec![
            ("x-api-key".to_string(), api_key.to_string()),
            ("anthropic-version".to_string(), "2023-06-01".to_string()),
        ],
    }
}

/// 根据 API 类型解析响应中的 content 和 thinking
fn extract_content_and_thinking(
    parsed: &serde_json::Value,
    api_type: &str,
) -> (String, Option<String>) {
    match api_type {
        "openai" => {
            let content = parsed
                .get("choices")
                .and_then(|c| c.as_array())
                .and_then(|arr| arr.first())
                .and_then(|choice| choice.get("message"))
                .and_then(|msg| msg.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            (content, None)
        }
        _ => {
            let content_blocks = parsed.get("content").and_then(|c| c.as_array());
            let content = content_blocks
                .and_then(|arr| {
                    arr.iter()
                        .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                        .and_then(|b| b.get("text"))
                        .and_then(|t| t.as_str())
                })
                .unwrap_or("")
                .to_string();
            let thinking = content_blocks
                .and_then(|arr| {
                    arr.iter()
                        .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("thinking"))
                        .and_then(|b| b.get("thinking"))
                        .and_then(|t| t.as_str())
                })
                .map(|s| s.to_string());
            (content, thinking)
        }
    }
}

/// 解析 SSE 数据中的文本增量
fn parse_sse_data(data: &str, api_type: &str) -> Result<Option<String>, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(data).map_err(|e| format!("JSON 解析失败: {}", e))?;

    match api_type {
        "openai" => {
            // OpenAI 流式错误事件
            if let Some(error) = parsed.get("error") {
                let error_msg = error
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("未知流式错误");
                return Err(error_msg.to_string());
            }
            // OpenAI: choices[0].delta.content
            let delta_content = parsed
                .get("choices")
                .and_then(|c| c.as_array())
                .and_then(|arr| arr.first())
                .and_then(|choice| choice.get("delta"))
                .and_then(|delta| delta.get("content"))
                .and_then(|c| c.as_str());

            Ok(delta_content.map(|s| s.to_string()))
        }
        _ => {
            // Anthropic: content_block_delta -> delta.text
            let event_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match event_type {
                "content_block_delta" => {
                    let delta = parsed.get("delta").and_then(|d| d.get("text"));
                    Ok(delta.and_then(|t| t.as_str()).map(|s| s.to_string()))
                }
                "error" => {
                    // Anthropic 流式错误事件
                    let error_msg = parsed
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("未知流式错误");
                    Err(error_msg.to_string())
                }
                "message_stop"
                | "message_start"
                | "content_block_start"
                | "content_block_stop"
                | "ping" => Ok(None),
                _ => Ok(None),
            }
        }
    }
}

fn process_sse_line<F>(
    line: &str,
    api_type: &str,
    full_content: &mut String,
    on_chunk: &F,
) -> Result<(), String>
where
    F: Fn(&str),
{
    let line = line.trim_end_matches('\r');
    let Some(rest) = line.strip_prefix("data:") else {
        return Ok(());
    };
    let data = rest.trim();
    if data == "[DONE]" || data.is_empty() {
        return Ok(());
    }

    if let Some(delta_text) = parse_sse_data(data, api_type)? {
        full_content.push_str(&delta_text);
        on_chunk(&delta_text);
    }
    Ok(())
}

// ─── AiService 实现 ──────────────────────────────────────────

impl AiService {
    pub fn new(config: AiConfig) -> Self {
        crate::utils::logger::log(
            "ai",
            &format!(
                "AI 服务初始化, base_url: {}, model: {}",
                config.base_url, config.model
            ),
        );
        Self {
            inner: Mutex::new(AiServiceInner {
                config,
                http_client: None,
            }),
            stream_cancellations: Mutex::new(StreamCancellationState {
                active: HashMap::new(),
                cancelled_before_start: HashSet::new(),
            }),
            next_stream_id: AtomicU64::new(1),
        }
    }

    /// 为没有指定 ID 的流式调用分配 ID。
    pub fn next_stream_id(&self) -> u64 {
        self.next_stream_id.fetch_add(1, Ordering::SeqCst)
    }

    /// 只取消来源窗口的指定请求；空 ID 表示没有活动请求。
    pub fn request_cancel(
        &self,
        window_label: &str,
        request_id: Option<u64>,
        request_scope: Option<&str>,
    ) {
        let Some(request_id) = request_id else {
            return;
        };
        let request_key = StreamRequestKey::new(window_label, request_id, request_scope);
        if let Ok(mut guard) = self.stream_cancellations.lock() {
            if let Some(token) = guard.active.get(&request_key) {
                token.cancel();
            } else {
                if guard.cancelled_before_start.len() >= 1024 {
                    if let Some(key) = guard.cancelled_before_start.iter().next().cloned() {
                        guard.cancelled_before_start.remove(&key);
                    }
                }
                guard.cancelled_before_start.insert(request_key);
            }
        }
        crate::utils::logger::log("ai", "cancel requested for streaming call");
    }

    fn register_stream(
        &self,
        window_label: &str,
        request_id: u64,
        request_scope: Option<&str>,
    ) -> Result<StreamCancellationGuard<'_>, String> {
        let request_key = StreamRequestKey::new(window_label, request_id, request_scope);
        let token = Arc::new(CancellationToken::new());
        let mut guard = self
            .stream_cancellations
            .lock()
            .map_err(|_| "AI 流式请求取消状态不可用".to_string())?;
        if guard.cancelled_before_start.remove(&request_key) {
            return Err("已取消".to_string());
        }
        if guard.active.contains_key(&request_key) {
            return Err(format!("AI 请求 id 已在使用中: {}", request_id));
        }
        guard.active.insert(request_key.clone(), Arc::clone(&token));
        Ok(StreamCancellationGuard {
            service: self,
            request_key,
            token,
        })
    }

    /// 更新 AI 配置。
    pub fn update_config(&self, config: AiConfig) -> Result<(), String> {
        crate::utils::logger::log("ai", "AI 服务配置已更新");
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| format!("获取 AI 服务锁失败: {}", e))?;
        inner.config = config;
        // 重置 HTTP 客户端，确保新配置（如 base_url）生效
        inner.http_client = None;
        Ok(())
    }

    /// 调用 AI 接口，发送 prompt 并获取回复
    pub async fn call(
        &self,
        prompt: &str,
        system_prompt: Option<&str>,
    ) -> Result<AiResponse, String> {
        crate::utils::logger::log(
            "ai",
            &format!("调用 AI, prompt 长度: {} 字节", prompt.len()),
        );

        // 在锁内克隆所需数据，避免跨 await 持有锁
        let (url, api_key, model, api_type, http_client) = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|e| format!("获取 AI 服务锁失败: {}", e))?;
            let api_type = inner.config.api_type.clone();
            // 将 0.0.0.0 替换为 127.0.0.1，因为 0.0.0.0 仅用于服务端绑定，不能作为客户端请求地址
            let base_url = inner
                .config
                .base_url
                .trim_end_matches('/')
                .replace("://0.0.0.0", "://127.0.0.1");
            let url = match api_type.as_str() {
                "openai" => format!("{}/v1/chat/completions", base_url),
                _ => format!("{}/v1/messages", base_url),
            };
            (
                url,
                inner.config.api_key.clone(),
                inner.config.model.clone(),
                api_type,
                inner.get_client()?,
            )
        };

        // Do not persist the endpoint: providers may put credentials in query
        // parameters, and the prompt/response can contain user content.
        crate::utils::logger::log("ai", &format!("request api_type: {}", api_type));

        // 构建请求
        let request_body = build_request_body(&api_type, &model, prompt, system_prompt);
        let headers = build_headers(&api_type, &api_key);

        // 发送请求
        let (status, body_text) = self
            .send_request(&http_client, &url, &headers, &request_body)
            .await?;
        crate::utils::logger::log("ai", &format!("响应状态码: {}", status));

        // 解析响应
        let parsed: serde_json::Value =
            serde_json::from_str(&body_text).map_err(|e| format!("解析 AI 响应失败: {}", e))?;

        let (content, thinking) = extract_content_and_thinking(&parsed, &api_type);

        if content.is_empty() {
            crate::utils::logger::log(
                "ai",
                &format!("response contained no content ({} bytes)", body_text.len()),
            );
        }

        if let Some(ref t) = thinking {
            crate::utils::logger::log("ai", &format!("AI 思考过程长度: {} 字节", t.len()));
        }

        let response_model = parsed
            .get("model")
            .and_then(|m| m.as_str())
            .unwrap_or(&model)
            .to_string();
        crate::utils::logger::log("ai", &format!("响应成功, 内容长度: {} 字节", content.len()));

        Ok(AiResponse {
            content,
            thinking,
            model: response_model,
        })
    }

    /// 发送 POST 请求并获取响应文本，统一错误处理
    async fn send_request(
        &self,
        client: &reqwest::Client,
        url: &str,
        headers: &[(String, String)],
        body: &serde_json::Value,
    ) -> Result<(reqwest::StatusCode, String), String> {
        let mut req = client.post(url).header("Content-Type", "application/json");
        for (key, value) in headers {
            req = req.header(key.as_str(), value.as_str());
        }

        let response = req.json(body).send().await.map_err(|e| {
            crate::utils::logger::log("ai", &format!("HTTP 请求失败: {}", e));
            format!("AI 请求失败: {}", e)
        })?;

        let status = response.status();
        let body_text = response.text().await.map_err(|e| {
            crate::utils::logger::log("ai", &format!("读取响应体失败: {}", e));
            format!("读取响应失败: {}", e)
        })?;

        if !status.is_success() {
            crate::utils::logger::log(
                "ai",
                &format!(
                    "request failed with status {} ({} bytes)",
                    status,
                    body_text.len()
                ),
            );
            return Err(format!("AI 请求错误 ({}): {}", status, body_text));
        }

        Ok((status, body_text))
    }

    /// 流式调用 AI 接口，通过回调逐块推送文本
    pub async fn call_stream<F>(
        &self,
        window_label: &str,
        request_id: u64,
        request_scope: Option<&str>,
        prompt: &str,
        system_prompt: Option<&str>,
        on_chunk: F,
    ) -> Result<String, String>
    where
        F: Fn(&str) + Send + 'static,
    {
        let stream_guard = self.register_stream(window_label, request_id, request_scope)?;
        // The cancellation branch must wake even if the provider sends nothing.
        // Dropping the losing future releases a pending HTTP request/body stream.
        tokio::select! {
            biased;
            _ = stream_guard.token.cancelled() => Err("已取消".to_string()),
            result = self.call_stream_request(prompt, system_prompt, on_chunk, &stream_guard.token) => result,
        }
    }

    async fn call_stream_request<F>(
        &self,
        prompt: &str,
        system_prompt: Option<&str>,
        on_chunk: F,
        cancel_token: &CancellationToken,
    ) -> Result<String, String>
    where
        F: Fn(&str) + Send + 'static,
    {
        crate::utils::logger::log(
            "ai",
            &format!("流式调用 AI, prompt 长度: {} 字节", prompt.len()),
        );

        let (url, api_key, model, api_type, http_client) = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|e| format!("获取 AI 服务锁失败: {}", e))?;
            let api_type = inner.config.api_type.clone();
            let base_url = inner
                .config
                .base_url
                .trim_end_matches('/')
                .replace("://0.0.0.0", "://127.0.0.1");
            let url = match api_type.as_str() {
                "openai" => format!("{}/v1/chat/completions", base_url),
                _ => format!("{}/v1/messages", base_url),
            };
            (
                url,
                inner.config.api_key.clone(),
                inner.config.model.clone(),
                api_type,
                inner.get_client()?,
            )
        };

        crate::utils::logger::log("ai", &format!("stream request api_type: {}", api_type));

        // 构建流式请求体（添加 stream: true）
        let mut request_body = build_request_body(&api_type, &model, prompt, system_prompt);
        request_body["stream"] = serde_json::Value::Bool(true);

        let headers = build_headers(&api_type, &api_key);

        // 发送请求
        let mut req = http_client
            .post(&url)
            .header("Content-Type", "application/json");
        for (key, value) in &headers {
            req = req.header(key.as_str(), value.as_str());
        }

        let response = req.json(&request_body).send().await.map_err(|e| {
            crate::utils::logger::log("ai", &format!("流式 HTTP 请求失败: {}", e));
            format!("AI 请求失败: {}", e)
        })?;

        let status = response.status();
        if !status.is_success() {
            let body_text = response.text().await.unwrap_or_default();
            crate::utils::logger::log(
                "ai",
                &format!(
                    "stream request failed with status {} ({} bytes)",
                    status,
                    body_text.len()
                ),
            );
            return Err(format!("AI 请求错误 ({}): {}", status, body_text));
        }

        crate::utils::logger::log("ai", &format!("流式响应状态码: {}", status));

        // 逐块读取 SSE 流
        let mut stream = response.bytes_stream();
        // Buffer raw bytes until a full SSE line arrives. Decoding individual
        // network chunks corrupts UTF-8 when a multi-byte character is split.
        let mut buffer: Vec<u8> = Vec::new();
        let mut full_content = String::new();

        while let Some(chunk_result) = stream.next().await {
            // 用户已取消流式调用 → 立即终止并丢弃剩余数据，避免白耗网络/CPU 与 token。
            // drop response 会断开底层连接；前端取消后已移除监听器，安全性无影响。
            if cancel_token.is_cancelled() {
                crate::utils::logger::log("ai", "streaming call cancelled, aborting read");
                return Err("已取消".to_string());
            }
            let chunk = chunk_result.map_err(|e| format!("读取流数据失败: {}", e))?;
            buffer.extend_from_slice(&chunk);

            // SSE 按行解析
            while let Some(newline_pos) = buffer.iter().position(|&byte| byte == b'\n') {
                let line_bytes: Vec<u8> = buffer.drain(..newline_pos).collect();
                buffer.drain(..1);
                let line = std::str::from_utf8(&line_bytes)
                    .map_err(|e| format!("流式响应不是有效 UTF-8: {}", e))?;
                if let Err(e) = process_sse_line(line, &api_type, &mut full_content, &on_chunk) {
                    crate::utils::logger::log("ai", &format!("流式 API 错误: {}", e));
                    return Err(e);
                }
            }
        }

        // Providers normally terminate SSE lines with a newline, but preserving
        // the final complete line makes the parser resilient to truncated framing.
        if !buffer.is_empty() {
            let line = std::str::from_utf8(&buffer)
                .map_err(|e| format!("流式响应不是有效 UTF-8: {}", e))?;
            if let Err(e) = process_sse_line(line, &api_type, &mut full_content, &on_chunk) {
                crate::utils::logger::log("ai", &format!("流式 API 错误: {}", e));
                return Err(e);
            }
        }

        crate::utils::logger::log(
            "ai",
            &format!("流式响应完成, 内容长度: {} 字节", full_content.len()),
        );
        Ok(full_content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn assert_stalled_stream_is_cancelled(response_headers: Option<&'static str>) {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::time::Duration;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let sends_chunk =
            response_headers.is_some_and(|headers| headers.starts_with("HTTP/1.1 200"));
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (chunk_tx, chunk_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = socket.read(&mut buffer).unwrap();
                assert_ne!(count, 0);
                request.extend_from_slice(&buffer[..count]);
            }
            if let Some(headers) = response_headers {
                socket.write_all(headers.as_bytes()).unwrap();
                if sends_chunk {
                    let data = b"data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n";
                    write!(socket, "{:X}\r\n", data.len()).unwrap();
                    socket.write_all(data).unwrap();
                    socket.write_all(b"\r\n").unwrap();
                }
                socket.flush().unwrap();
            }
            let _ = ready_tx.send(());
            // Keep the connection open without sending the next response bytes.
            let _ = release_rx.recv_timeout(Duration::from_secs(10));
        });
        let service = Arc::new(AiService::new(AiConfig {
            api_key: "test-key".into(),
            base_url: format!("http://{}", address),
            model: "test-model".into(),
            api_type: "openai".into(),
        }));
        service.inner.lock().unwrap().http_client =
            Some(reqwest::Client::builder().no_proxy().build().unwrap());
        let request_service = Arc::clone(&service);
        let chunk_tx = Mutex::new(Some(chunk_tx));
        let mut pending = tokio::spawn(async move {
            request_service
                .call_stream("toolbar", 1, Some("stalled"), "test", None, move |_| {
                    if let Some(sender) = chunk_tx.lock().unwrap().take() {
                        let _ = sender.send(());
                    }
                })
                .await
        });
        let ready = tokio::time::timeout(Duration::from_secs(5), ready_rx).await;
        if !matches!(ready, Ok(Ok(()))) {
            pending.abort();
            let _ = release_tx.send(());
            panic!("loopback server did not receive the request: {:?}", ready);
        }
        if sends_chunk {
            // Observe a real parsed chunk before cancelling so this case tests
            // the body-read phase, rather than another wait for response headers.
            let chunk = tokio::time::timeout(Duration::from_secs(5), chunk_rx).await;
            if !matches!(chunk, Ok(Ok(()))) {
                pending.abort();
                let _ = release_tx.send(());
                server.join().unwrap();
                panic!(
                    "loopback stream did not deliver its first chunk: {:?}",
                    chunk
                );
            }
        }
        tokio::task::yield_now().await;
        service.request_cancel("toolbar", Some(1), Some("stalled"));
        let result = tokio::time::timeout(Duration::from_secs(2), &mut pending).await;
        // Always release the local server before asserting, including on timeout.
        let _ = release_tx.send(());
        server.join().unwrap();
        if result.is_err() {
            pending.abort();
            let _ = pending.await;
        }
        assert!(
            matches!(result, Ok(Ok(Err(ref error))) if error == "已取消"),
            "cancel must wake a stalled request, got {:?}",
            result
        );
        assert!(service
            .stream_cancellations
            .lock()
            .unwrap()
            .active
            .is_empty());
    }

    #[tokio::test]
    async fn test_cancel_while_waiting_for_response_headers() {
        assert_stalled_stream_is_cancelled(None).await;
    }

    #[tokio::test]
    async fn test_cancel_while_waiting_for_stream_data() {
        assert_stalled_stream_is_cancelled(Some(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
        )).await;
    }

    #[tokio::test]
    async fn test_cancel_while_waiting_for_error_body() {
        assert_stalled_stream_is_cancelled(Some(
            "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 100\r\n\r\n",
        ))
        .await;
    }

    #[test]
    fn test_remounted_hook_with_same_id_is_isolated() {
        let service = AiService::new(AiConfig::default());
        let old = service
            .register_stream("toolbar", 1, Some("old-hook"))
            .unwrap();
        let current = service
            .register_stream("toolbar", 1, Some("new-hook"))
            .unwrap();
        // A cancellation without the instance scope cannot match a scoped request.
        service.request_cancel("toolbar", Some(1), None);
        assert!(!old.token.is_cancelled());
        assert!(!current.token.is_cancelled());
        service.request_cancel("toolbar", Some(1), Some("old-hook"));
        assert!(old.token.is_cancelled());
        assert!(!current.token.is_cancelled());
        drop(old);
        assert_eq!(service.stream_cancellations.lock().unwrap().active.len(), 1);
        service.request_cancel("toolbar", Some(1), Some("new-hook"));
        assert!(current.token.is_cancelled());
    }

    #[test]
    fn test_delayed_cancel_cannot_poison_replacement_hook() {
        let service = AiService::new(AiConfig::default());
        // Cancellation arrives after the old request has already left the map.
        service.request_cancel("toolbar", Some(1), Some("old-hook"));
        let current = service
            .register_stream("toolbar", 1, Some("new-hook"))
            .unwrap();
        assert!(!current.token.is_cancelled());
        assert!(
            matches!(service.register_stream("toolbar", 1, Some("old-hook")), Err(e) if e == "已取消")
        );
    }

    #[test]
    fn test_idle_cancel_does_not_cancel_any_stream() {
        let service = AiService::new(AiConfig::default());
        let toolbar = service.register_stream("toolbar", 1, None).unwrap();
        let ocr = service.register_stream("pin-ocr-result", 1, None).unwrap();
        service.request_cancel("toolbar", None, None);
        assert!(!toolbar.token.is_cancelled());
        assert!(!ocr.token.is_cancelled());
        assert!(service
            .stream_cancellations
            .lock()
            .unwrap()
            .cancelled_before_start
            .is_empty());
    }

    #[test]
    fn test_cancel_is_scoped_to_window_and_request() {
        let service = AiService::new(AiConfig::default());
        let toolbar = service.register_stream("toolbar", 1, None).unwrap();
        let next_toolbar = service.register_stream("toolbar", 2, None).unwrap();
        let ocr = service.register_stream("pin-ocr-result", 1, None).unwrap();
        service.request_cancel("toolbar", Some(1), None);
        service.request_cancel("toolbar", Some(1), None);
        assert!(toolbar.token.is_cancelled());
        assert!(!next_toolbar.token.is_cancelled());
        assert!(!ocr.token.is_cancelled());
    }

    #[test]
    fn test_early_cancel_is_scoped_and_consumed() {
        let service = AiService::new(AiConfig::default());
        service.request_cancel("toolbar", Some(1), None);
        let ocr = service.register_stream("pin-ocr-result", 1, None).unwrap();
        assert!(matches!(service.register_stream("toolbar", 1, None), Err(e) if e == "已取消"));
        assert!(!ocr.token.is_cancelled());
        // The early cancellation is consumed and cannot poison a future stream.
        assert!(service.register_stream("toolbar", 1, None).is_ok());
    }

    #[test]
    fn test_stream_guard_cleans_up_only_its_request() {
        let service = AiService::new(AiConfig::default());
        let toolbar = service.register_stream("toolbar", 1, None).unwrap();
        let ocr = service.register_stream("pin-ocr-result", 1, None).unwrap();
        assert!(service.register_stream("toolbar", 1, None).is_err());
        drop(toolbar);
        assert!(service.register_stream("toolbar", 1, None).is_ok());
        assert_eq!(service.stream_cancellations.lock().unwrap().active.len(), 1);
        service.request_cancel("pin-ocr-result", Some(1), None);
        assert!(ocr.token.is_cancelled());
        drop(ocr);
        assert!(service
            .stream_cancellations
            .lock()
            .unwrap()
            .active
            .is_empty());
    }

    #[test]
    fn test_build_request_body_anthropic() {
        let body = build_request_body("anthropic", "claude-3", "hello", Some("system msg"));
        assert_eq!(body["model"], "claude-3");
        assert_eq!(body["system"], "system msg");
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "hello");
    }

    #[test]
    fn test_build_request_body_openai() {
        let body = build_request_body("openai", "gpt-4", "hello", Some("sys"));
        assert_eq!(body["messages"].as_array().unwrap().len(), 2);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["role"], "user");
    }

    #[test]
    fn test_build_request_body_no_system() {
        let body = build_request_body("anthropic", "m", "p", None);
        assert!(body.get("system").is_none());
    }

    #[test]
    fn test_build_request_body_empty_system() {
        let body = build_request_body("openai", "m", "p", Some(""));
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_build_headers_anthropic() {
        let headers = build_headers("anthropic", "sk-123");
        assert_eq!(headers.len(), 2);
        assert_eq!(headers[0], ("x-api-key".into(), "sk-123".into()));
        assert_eq!(
            headers[1],
            ("anthropic-version".into(), "2023-06-01".into())
        );
    }

    #[test]
    fn test_build_headers_openai() {
        let headers = build_headers("openai", "sk-456");
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0], ("Authorization".into(), "Bearer sk-456".into()));
    }

    #[test]
    fn test_extract_anthropic_content() {
        let parsed = serde_json::json!({
            "content": [
                { "type": "text", "text": "hello" }
            ],
            "model": "claude-3"
        });
        let (content, thinking) = extract_content_and_thinking(&parsed, "anthropic");
        assert_eq!(content, "hello");
        assert!(thinking.is_none());
    }

    #[test]
    fn test_extract_anthropic_with_thinking() {
        let parsed = serde_json::json!({
            "content": [
                { "type": "thinking", "thinking": "let me think" },
                { "type": "text", "text": "answer" }
            ]
        });
        let (content, thinking) = extract_content_and_thinking(&parsed, "anthropic");
        assert_eq!(content, "answer");
        assert_eq!(thinking.unwrap(), "let me think");
    }

    #[test]
    fn test_extract_openai_content() {
        let parsed = serde_json::json!({
            "choices": [{ "message": { "content": "42" } }],
            "model": "gpt-4"
        });
        let (content, thinking) = extract_content_and_thinking(&parsed, "openai");
        assert_eq!(content, "42");
        assert!(thinking.is_none());
    }

    #[test]
    fn test_extract_openai_empty() {
        let parsed = serde_json::json!({ "choices": [] });
        let (content, _) = extract_content_and_thinking(&parsed, "openai");
        assert!(content.is_empty());
    }

    #[test]
    fn test_parse_sse_data_anthropic_content_block_delta() {
        let data = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}"#;
        let result = parse_sse_data(data, "anthropic").unwrap();
        assert_eq!(result, Some("你好".to_string()));
    }

    #[test]
    fn test_parse_sse_data_anthropic_empty_text() {
        let data =
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}"#;
        let result = parse_sse_data(data, "anthropic").unwrap();
        assert_eq!(result, Some("".to_string()));
    }

    #[test]
    fn test_parse_sse_data_anthropic_message_start() {
        let data = r#"{"type":"message_start","message":{"id":"msg_123","model":"claude-sonnet"}}"#;
        let result = parse_sse_data(data, "anthropic").unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn test_parse_sse_data_anthropic_ping() {
        let data = r#"{"type":"ping"}"#;
        let result = parse_sse_data(data, "anthropic").unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn test_parse_sse_data_anthropic_error() {
        let data = r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#;
        let result = parse_sse_data(data, "anthropic");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Overloaded"));
    }

    #[test]
    fn test_parse_sse_data_openai_delta_content() {
        let data = r#"{"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}"#;
        let result = parse_sse_data(data, "openai").unwrap();
        assert_eq!(result, Some("Hello".to_string()));
    }

    #[test]
    fn test_parse_sse_data_openai_role_only() {
        // 首个 chunk 通常只含 role，不含 content
        let data = r#"{"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}"#;
        let result = parse_sse_data(data, "openai").unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn test_parse_sse_data_openai_finish() {
        let data = r#"{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#;
        let result = parse_sse_data(data, "openai").unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn test_parse_sse_data_openai_error() {
        let data = r#"{"error":{"message":"Rate limit exceeded","type":"rate_limit_error"}}"#;
        let result = parse_sse_data(data, "openai");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Rate limit exceeded"));
    }

    #[test]
    fn test_process_sse_line_preserves_unicode_delta() {
        let content = std::sync::Mutex::new(String::new());
        let mut full_content = String::new();
        process_sse_line(
            r#"data: {"choices":[{"delta":{"content":"中文"}}]}"#,
            "openai",
            &mut full_content,
            &|chunk| content.lock().unwrap().push_str(chunk),
        )
        .unwrap();
        assert_eq!(full_content, "中文");
        assert_eq!(*content.lock().unwrap(), "中文");
    }

    #[test]
    fn test_parse_sse_data_invalid_json() {
        let result = parse_sse_data("not valid json", "openai");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_sse_data_anthropic_multi_char_unicode() {
        let data = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"🎉你好世界🌍"}}"#;
        let result = parse_sse_data(data, "anthropic").unwrap();
        assert_eq!(result, Some("🎉你好世界🌍".to_string()));
    }

    #[test]
    fn test_parse_sse_data_openai_empty_choices() {
        let data = r#"{"choices":[]}"#;
        let result = parse_sse_data(data, "openai").unwrap();
        assert_eq!(result, None);
    }

    #[tokio::test]
    #[ignore]
    async fn test_ai_call() {
        let api_key =
            std::env::var("LEVITAIRE_AI_API_KEY").expect("请设置环境变量 LEVITAIRE_AI_API_KEY");
        let base_url = std::env::var("LEVITAIRE_AI_BASE_URL")
            .unwrap_or_else(|_| "https://api.anthropic.com".to_string());
        let model =
            std::env::var("LEVITAIRE_AI_MODEL").unwrap_or_else(|_| "claude-sonnet-5".to_string());

        let config = AiConfig {
            api_key,
            base_url,
            model,
            api_type: "anthropic".to_string(),
        };
        let service = AiService::new(config);
        let result = service.call("请用一句话回答：1+1等于几？", None).await;

        match &result {
            Ok(response) => {
                println!(
                    "AI 响应成功！模型: {}, 内容: {}",
                    response.model, response.content
                );
                assert!(!response.content.is_empty(), "AI 响应内容不应为空");
            }
            Err(e) => panic!("AI 调用失败: {}", e),
        }
    }
}
