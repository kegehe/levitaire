use crate::config::AiConfig;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

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
}

/// AI 服务内部实现
struct AiServiceInner {
    config: AiConfig,
    http_client: reqwest::Client,
}

// ─── 请求构建（纯函数）────────────────────────────────────────

/// 根据 API 类型构建请求体
fn build_request_body(api_type: &str, model: &str, prompt: &str, system_prompt: Option<&str>) -> serde_json::Value {
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
        "openai" => vec![
            ("Authorization".to_string(), format!("Bearer {}", api_key)),
        ],
        _ => vec![
            ("x-api-key".to_string(), api_key.to_string()),
            ("anthropic-version".to_string(), "2023-06-01".to_string()),
        ],
    }
}

/// 根据 API 类型解析响应中的 content 和 thinking
fn extract_content_and_thinking(parsed: &serde_json::Value, api_type: &str) -> (String, Option<String>) {
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
    let parsed: serde_json::Value = serde_json::from_str(data)
        .map_err(|e| format!("JSON 解析失败: {}", e))?;

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
                "message_stop" | "message_start" | "content_block_start" | "content_block_stop" | "ping" => {
                    Ok(None)
                }
                _ => {
                    Ok(None)
                }
            }
        }
    }
}

// ─── AiService 实现 ──────────────────────────────────────────

impl AiService {
    pub fn new(config: AiConfig) -> Self {
        crate::utils::logger::log("ai", &format!("AI 服务初始化, base_url: {}, model: {}", config.base_url, config.model));
        let http_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .expect("无法创建 HTTP 客户端");
        Self {
            inner: Mutex::new(AiServiceInner { config, http_client }),
        }
    }

    pub fn update_config(&self, config: AiConfig) -> Result<(), String> {
        crate::utils::logger::log("ai", "AI 服务配置已更新");
        let mut inner = self.inner.lock().map_err(|e| format!("获取 AI 服务锁失败: {}", e))?;
        inner.config = config;
        Ok(())
    }

    /// 调用 AI 接口，发送 prompt 并获取回复
    pub async fn call(&self, prompt: &str, system_prompt: Option<&str>) -> Result<AiResponse, String> {
        crate::utils::logger::log("ai", &format!("调用 AI, prompt 长度: {} 字节", prompt.len()));

        // 在锁内克隆所需数据，避免跨 await 持有锁
        let (url, api_key, model, api_type, http_client) = {
            let inner = self.inner.lock().map_err(|e| format!("获取 AI 服务锁失败: {}", e))?;
            let api_type = inner.config.api_type.clone();
            // 将 0.0.0.0 替换为 127.0.0.1，因为 0.0.0.0 仅用于服务端绑定，不能作为客户端请求地址
            let base_url = inner.config.base_url.trim_end_matches('/').replace("://0.0.0.0", "://127.0.0.1");
            let url = match api_type.as_str() {
                "openai" => format!("{}/v1/chat/completions", base_url),
                _ => format!("{}/v1/messages", base_url),
            };
            (url, inner.config.api_key.clone(), inner.config.model.clone(), api_type, inner.http_client.clone())
        };

        crate::utils::logger::log("ai", &format!("请求 URL: {}, api_type: {}", url, api_type));

        // 构建请求
        let request_body = build_request_body(&api_type, &model, prompt, system_prompt);
        let headers = build_headers(&api_type, &api_key);

        // 发送请求
        let (status, body_text) = self.send_request(&http_client, &url, &headers, &request_body).await?;
        crate::utils::logger::log("ai", &format!("响应状态码: {}", status));

        // 解析响应
        let parsed: serde_json::Value = serde_json::from_str(&body_text)
            .map_err(|e| format!("解析 AI 响应失败: {}", e))?;

        let (content, thinking) = extract_content_and_thinking(&parsed, &api_type);

        if content.is_empty() {
            crate::utils::logger::log("ai", &format!("响应中未找到内容, 原始响应: {}", body_text));
        }

        if let Some(ref t) = thinking {
            crate::utils::logger::log("ai", &format!("AI 思考过程长度: {} 字节", t.len()));
        }

        let response_model = parsed.get("model").and_then(|m| m.as_str()).unwrap_or(&model).to_string();
        crate::utils::logger::log("ai", &format!("响应成功, 内容长度: {} 字节", content.len()));

        Ok(AiResponse { content, thinking, model: response_model })
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
            crate::utils::logger::log("ai", &format!("请求错误, 状态码: {}, 响应: {}", status, body_text));
            return Err(format!("AI 请求错误 ({}): {}", status, body_text));
        }

        Ok((status, body_text))
    }

    /// 流式调用 AI 接口，通过回调逐块推送文本
    pub async fn call_stream<F>(
        &self,
        prompt: &str,
        system_prompt: Option<&str>,
        on_chunk: F,
    ) -> Result<String, String>
    where
        F: Fn(&str) + Send + 'static,
    {
        crate::utils::logger::log("ai", &format!("流式调用 AI, prompt 长度: {} 字节", prompt.len()));

        let (url, api_key, model, api_type, http_client) = {
            let inner = self.inner.lock().map_err(|e| format!("获取 AI 服务锁失败: {}", e))?;
            let api_type = inner.config.api_type.clone();
            let base_url = inner.config.base_url.trim_end_matches('/').replace("://0.0.0.0", "://127.0.0.1");
            let url = match api_type.as_str() {
                "openai" => format!("{}/v1/chat/completions", base_url),
                _ => format!("{}/v1/messages", base_url),
            };
            (url, inner.config.api_key.clone(), inner.config.model.clone(), api_type, inner.http_client.clone())
        };

        crate::utils::logger::log("ai", &format!("流式请求 URL: {}, api_type: {}", url, api_type));

        // 构建流式请求体（添加 stream: true）
        let mut request_body = build_request_body(&api_type, &model, prompt, system_prompt);
        request_body["stream"] = serde_json::Value::Bool(true);

        let headers = build_headers(&api_type, &api_key);

        // 发送请求
        let mut req = http_client.post(&url).header("Content-Type", "application/json");
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
            crate::utils::logger::log("ai", &format!("流式请求错误, 状态码: {}, 响应: {}", status, body_text));
            return Err(format!("AI 请求错误 ({}): {}", status, body_text));
        }

        crate::utils::logger::log("ai", &format!("流式响应状态码: {}", status));

        // 逐块读取 SSE 流
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut full_content = String::new();

        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| format!("读取流数据失败: {}", e))?;
            let text = String::from_utf8_lossy(&chunk);
            buffer.push_str(&text);

            // SSE 按行解析
            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].trim_end_matches('\r').to_string();
                buffer = buffer[newline_pos + 1..].to_string();

                if line.is_empty() {
                    continue;
                }

                // 处理 data 行（SSE 规范：字段名后跟冒号，可选空格）
                if let Some(rest) = line.strip_prefix("data:") {
                    let data = rest.trim();
                    if data == "[DONE]" {
                        continue;
                    }

                    // 解析 SSE 数据
                    match parse_sse_data(data, &api_type) {
                        Ok(Some(delta_text)) => {
                            full_content.push_str(&delta_text);
                            on_chunk(&delta_text);
                        }
                        Ok(None) => {} // 非文本内容（如 thinking），跳过
                        Err(e) => {
                            crate::utils::logger::log("ai", &format!("流式 API 错误: {}", e));
                            return Err(e);
                        }
                    }
                }
            }
        }

        crate::utils::logger::log("ai", &format!("流式响应完成, 内容长度: {} 字节", full_content.len()));
        Ok(full_content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(headers[1], ("anthropic-version".into(), "2023-06-01".into()));
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
        let data = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}"#;
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
        let api_key = std::env::var("FLOAST_AI_API_KEY")
            .expect("请设置环境变量 FLOAST_AI_API_KEY");
        let base_url = std::env::var("FLOAST_AI_BASE_URL")
            .unwrap_or_else(|_| "https://api.anthropic.com".to_string());
        let model = std::env::var("FLOAST_AI_MODEL")
            .unwrap_or_else(|_| "claude-sonnet-4-20250514".to_string());

        let config = AiConfig { api_key, base_url, model, api_type: "anthropic".to_string() };
        let service = AiService::new(config);
        let result = service.call("请用一句话回答：1+1等于几？", None).await;

        match &result {
            Ok(response) => {
                println!("AI 响应成功！模型: {}, 内容: {}", response.model, response.content);
                assert!(!response.content.is_empty(), "AI 响应内容不应为空");
            }
            Err(e) => panic!("AI 调用失败: {}", e),
        }
    }
}
