//! Independent, cancellable model requests. Cancelling a workbench request never cancels
//! an unrelated editor or agent request; every event carries its owner request ID.
use std::{collections::HashMap, time::{Duration, Instant}};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use futures_util::StreamExt;
use tokio::sync::{Mutex, watch};
use tauri::Window;
use crate::models::TextModelConfigInput;

lazy_static::lazy_static! {
    static ref REQUESTS: Mutex<HashMap<String, (String, watch::Sender<bool>)>> = Mutex::new(HashMap::new());
    static ref CANCELLED: Mutex<HashMap<String, (String, Instant)>> = Mutex::new(HashMap::new());
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedAIInput {
    pub request_id: String, pub system: String, pub user: String,
    pub text_config: TextModelConfigInput, pub max_tokens: Option<u32>, pub reasoning_level: Option<String>,
    pub response_format: Option<String>,
}
#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: Option<u64>, pub completion_tokens: Option<u64>, pub cache_hit_tokens: Option<u64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedAIResult { pub text: String, pub finish_reason: String, pub usage: Option<TokenUsage> }

fn usage(value: &Value) -> Option<TokenUsage> {
    let obj = value.get("usage")?.as_object()?;
    let count = |k: &str| obj.get(k).and_then(Value::as_u64);
    let hit = count("prompt_cache_hit_tokens").or_else(|| obj.get("prompt_tokens_details")?.get("cached_tokens")?.as_u64());
    Some(TokenUsage { prompt_tokens: count("prompt_tokens"), completion_tokens: count("completion_tokens"), cache_hit_tokens: hit })
}
fn apply_response(value: &Value, text: &mut String, finish: &mut String, tokens: &mut Option<TokenUsage>, window: &Window, id: &str, streaming: bool) -> Result<(), String> {
    if value.get("error").is_some() { return Err("模型服务返回错误，未采用不完整结果".into()); }
    if let Some(observed) = usage(value) { *tokens = Some(observed); }
    if let Some(choice) = value.get("choices").and_then(Value::as_array).and_then(|c| c.first()) {
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) { *finish = reason.into(); }
        let key = if streaming { "delta" } else { "message" };
        if let Some(delta) = choice.get(key).and_then(|d| d.get("content")).and_then(Value::as_str) {
            if text.len().saturating_add(delta.len()) > 4 * 1024 * 1024 { return Err("单次生成超过4MiB限制".into()); }
            text.push_str(delta);
            let _ = window.emit("writing-stream", json!({"requestId":id,"delta":delta}));
        }
    }
    Ok(())
}
async fn execute(window: Window, input: ScopedAIInput) -> Result<ScopedAIResult, String> {
    input.text_config.validate()?;
    if input.system.len().saturating_add(input.user.len()) > 2 * 1024 * 1024 { return Err("模型输入超过2MiB限制".into()); }
    let depth = match input.reasoning_level.as_deref() {
        Some("low") => "简要核对后执行，避免冗余规划。",
        Some("high") => "充分核对约束、任务依赖及结果证据，发现矛盾先解决；不要输出思维链。",
        _ => "核对任务约束与结果证据后执行；不要输出思维链。",
    };
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300)).build().map_err(|e| e.to_string())?;
    let mut body = json!({"model":input.text_config.model,
        "messages":[{"role":"system","content":format!("{}\n{}", input.system, depth)}, {"role":"user","content":input.user}],
        "max_tokens":input.max_tokens.unwrap_or(8192).clamp(256,32768),
        "temperature":input.text_config.normalized_temperature(0.7), "stream":true,
        "stream_options":{"include_usage":true}});
    if input.response_format.as_deref() == Some("json") {
        body["response_format"] = json!({"type":"json_object"});
    }
    let response = client.post(input.text_config.chat_completions_url())
        .bearer_auth(&input.text_config.api_key).json(&body).send().await.map_err(|e| format!("模型请求失败：{e}"))?;
    if !response.status().is_success() { return Err(format!("模型服务 HTTP {}（请检查模型与连接配置）", response.status().as_u16())); }
    let sse = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map_or(false, |s| s.contains("text/event-stream"));
    let mut stream = response.bytes_stream();
    let mut pending = Vec::<u8>::new();
    let mut text = String::new(); let mut finish = String::new(); let mut tokens = None; let mut done = false;
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(90), stream.next()).await.map_err(|_| "模型连续90秒无数据，任务已中断，可重试")? {
        let chunk = chunk.map_err(|e| format!("读取模型输出中断：{e}"))?;
        pending.extend_from_slice(&chunk);
        if pending.len() > 4 * 1024 * 1024 { return Err("模型响应单项超过限制".into()); }
        if !sse { continue; }
        while let Some(pos) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = pending.drain(..=pos).collect();
            let line = std::str::from_utf8(&line).map_err(|_| "模型输出不是UTF-8")?.trim();
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim(); if data == "[DONE]" { done = true; continue; }
                if !data.is_empty() {
                    let value: Value = serde_json::from_str(data).map_err(|_| "模型流返回无效JSON")?;
                    apply_response(&value, &mut text, &mut finish, &mut tokens, &window, &input.request_id, true)?;
                }
            }
        }
        if done { break; }
    }
    if !sse {
        let value: Value = serde_json::from_slice(&pending).map_err(|_| "模型返回无效JSON")?;
        apply_response(&value, &mut text, &mut finish, &mut tokens, &window, &input.request_id, false)?;
    }
    if finish != "stop" && finish != "length" {
        return Err(if finish.is_empty() { "连接结束但缺少生成完成标记，未采用不完整输出".into() } else { format!("模型未正常完成：{finish}") });
    }
    if text.trim().is_empty() { return Err("模型返回空文本".into()); }
    Ok(ScopedAIResult { text, finish_reason: finish, usage: tokens })
}
#[tauri::command]
pub async fn request_scoped_ai(window: Window, input: ScopedAIInput) -> Result<ScopedAIResult, String> {
    let id = input.request_id.clone();
    let owner = window.label().to_string();
    if id.is_empty() || id.len() > 120 { return Err("无效请求ID".into()); }
    let (sender, mut receiver) = watch::channel(false);
    {
        let mut registry = REQUESTS.lock().await;
        let mut cancelled = CANCELLED.lock().await;
        cancelled.retain(|_, (_, time)| time.elapsed() < Duration::from_secs(60));
        if cancelled.get(&id).map_or(false, |(window, _)| window == &owner) {
            cancelled.remove(&id); return Err("请求在启动前已经中断".into());
        }
        if registry.contains_key(&id) { return Err("该请求仍在运行".into()); }
        if registry.len() >= 8 { return Err("并发请求过多，请等待其他任务完成".into()); }
        registry.insert(id.clone(), (owner, sender));
    }
    let result = tokio::select! {
        result = execute(window, input) => result,
        _ = receiver.changed() => Err("生成已中断，已保存的场景仍保留".into()),
    };
    REQUESTS.lock().await.remove(&id);
    result
}
#[tauri::command]
pub async fn cancel_scoped_ai(window: Window, request_id: String) {
    if request_id.is_empty() || request_id.len() > 120 { return; }
    let registry = REQUESTS.lock().await;
    if let Some((owner, sender)) = registry.get(&request_id) {
        if owner == window.label() { let _ = sender.send(true); }
    } else {
        let mut cancelled = CANCELLED.lock().await;
        cancelled.retain(|_, (_, time)| time.elapsed() < Duration::from_secs(60));
        if cancelled.len() < 64 { cancelled.insert(request_id, (window.label().into(), Instant::now())); }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn unknown_cache_is_not_zero() {
        let u = usage(&json!({"usage":{"prompt_tokens":20,"completion_tokens":4}})).unwrap();
        assert_eq!(u.cache_hit_tokens, None);
    }
    #[test] fn both_provider_cache_shapes() {
        assert_eq!(usage(&json!({"usage":{"prompt_cache_hit_tokens":12}})).unwrap().cache_hit_tokens, Some(12));
        assert_eq!(usage(&json!({"usage":{"prompt_tokens_details":{"cached_tokens":9}}})).unwrap().cache_hit_tokens, Some(9));
    }
}
