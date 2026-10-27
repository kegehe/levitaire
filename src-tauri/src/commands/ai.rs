use super::*;

/// 调用 AI 接口
#[tauri::command]
pub async fn call_ai(
    prompt: String,
    system_prompt: Option<String>,
    ai_service: State<'_, crate::ai::AiService>,
) -> Result<crate::ai::AiResponse, String> {
    crate::utils::logger::log(
        "commands",
        &format!("call_ai 命令被调用, prompt 长度: {} 字节", prompt.len()),
    );
    if prompt.len() > MAX_PROMPT_LENGTH {
        return Err(format!(
            "prompt 长度超过限制（最大 {} 字节）",
            MAX_PROMPT_LENGTH
        ));
    }
    if prompt.is_empty() {
        return Err("prompt 不能为空".to_string());
    }
    ai_service.call(&prompt, system_prompt.as_deref()).await
}

/// 流式调用 AI 接口，通过事件推送文本片段
#[tauri::command]
pub async fn call_ai_stream(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: Option<u64>,
    request_scope: Option<String>,
    prompt: String,
    system_prompt: Option<String>,
    ai_service: State<'_, crate::ai::AiService>,
) -> Result<(), String> {
    crate::utils::logger::log(
        "commands",
        &format!(
            "call_ai_stream 命令被调用, prompt 长度: {} 字节",
            prompt.len()
        ),
    );
    let request_id = request_id.unwrap_or_else(|| ai_service.next_stream_id());
    let target = tauri::EventTarget::webview_window(window.label());
    if prompt.len() > MAX_PROMPT_LENGTH {
        let _ = app.emit_to(
            target,
            "ai-stream",
            serde_json::json!({
                "type": "error",
                "data": format!("prompt 长度超过限制（最大 {} 字节）", MAX_PROMPT_LENGTH),
                "requestId": request_id,
                "requestScope": request_scope,
            }),
        );
        return Err(format!(
            "prompt 长度超过限制（最大 {} 字节）",
            MAX_PROMPT_LENGTH
        ));
    }
    if prompt.is_empty() {
        let _ = app.emit_to(
            target,
            "ai-stream",
            serde_json::json!({ "type": "error", "data": "prompt 不能为空", "requestId": request_id, "requestScope": request_scope }),
        );
        return Err("prompt 不能为空".to_string());
    }

    let app_handle = app.clone();
    let stream_target = target.clone();
    let stream_scope = request_scope.clone();
    // 请求 ID 在组件重建后会重新递增；窗口、组件实例、ID 必须共同隔离。
    let result = ai_service
        .call_stream(
            window.label(),
            request_id,
            request_scope.as_deref(),
            &prompt,
            system_prompt.as_deref(),
            move |chunk| {
                let _ = app_handle.emit_to(
                    stream_target.clone(),
                    "ai-stream",
                    serde_json::json!({ "type": "chunk", "data": chunk, "requestId": request_id, "requestScope": stream_scope }),
                );
            },
        )
        .await;

    match result {
        Ok(_) => {
            let _ = app.emit_to(
                target,
                "ai-stream",
                serde_json::json!({ "type": "done", "requestId": request_id, "requestScope": request_scope }),
            );
            Ok(())
        }
        Err(e) => {
            // 用户取消导致的提前终止同样回传消息，前端取消时已移除监听器，无副作用；
            // 若取消后重新发起了新请求，则该 error 事件被新请求的监听器屏蔽（requestId 校验）。
            let _ = app.emit_to(
                target,
                "ai-stream",
                serde_json::json!({ "type": "error", "data": &e, "requestId": request_id, "requestScope": request_scope }),
            );
            Err(e)
        }
    }
}

/// 只取消调用窗口的指定流式 AI 请求；空 ID 不影响任何请求。
#[tauri::command]
pub fn cancel_ai_stream(
    window: tauri::WebviewWindow,
    request_id: Option<u64>,
    request_scope: Option<String>,
    ai_service: State<'_, crate::ai::AiService>,
) {
    ai_service.request_cancel(window.label(), request_id, request_scope.as_deref());
}

/// 获取当前 AI 配置
#[tauri::command]
pub fn get_ai_config(
    config_manager: State<'_, ConfigManager>,
) -> Result<crate::config::AiConfig, String> {
    config_manager.get_ai_config()
}

/// 更新 AI 配置
#[tauri::command]
pub fn update_ai_config(
    new_config: crate::config::AiConfig,
    ai_service: State<'_, crate::ai::AiService>,
    config_manager: State<'_, ConfigManager>,
) -> Result<(), String> {
    crate::utils::logger::log("commands", "更新 AI 配置");
    // 先更新内存中的 AiService（如果失败可以安全返回错误，不会有不一致状态）
    ai_service.update_config(new_config.clone())?;
    // 内存更新成功后再持久化到配置文件
    config_manager.update_ai_config(new_config)?;
    Ok(())
}
