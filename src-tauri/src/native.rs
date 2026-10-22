//! Anthropic Messages 与 Gemini GenerateContent 的原生协议适配。
use crate::{
    ai::{self, ChatEvent, ChatRequest, ImageRequest, RawImage, ToolCall},
    error::{api_error, AppError, AppResult},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::ipc::Channel;

pub async fn wait_cancel(flag: Arc<AtomicBool>) {
    while !flag.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn gemini_root(base: &str) -> AppResult<String> {
    ai::build_url(base, "/models")?; // 复用 URL 格式校验。
    let base = base.trim().trim_end_matches('/');
    if let Some((root, _)) = base.split_once("/models/") {
        return Ok(root.into());
    }
    if base.ends_with("/v1beta") || base.ends_with("/v1") {
        return Ok(base.into());
    }
    Ok(format!("{base}/v1beta"))
}

pub fn gemini_url(base: &str, model: &str, stream: bool) -> AppResult<String> {
    let model = model.trim().trim_start_matches("models/");
    if model.is_empty() || model.contains(['/', '?', '#']) {
        return Err(AppError::config("Gemini 模型 ID 无效"));
    }
    let action = if stream {
        "streamGenerateContent?alt=sse"
    } else {
        "generateContent"
    };
    Ok(format!("{}/models/{model}:{action}", gemini_root(base)?))
}

fn text(value: &Value) -> String {
    if let Some(s) = value.as_str() {
        return s.into();
    }
    value
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn image_block(part: &Value, protocol: &str) -> AppResult<Option<Value>> {
    let Some(url) = part
        .get("image_url")
        .and_then(|image| image.get("url"))
        .and_then(Value::as_str)
    else {
        return Ok(None);
    };
    let (mime, bytes) = ai::parse_data_url(url)?;
    if protocol == "anthropic" {
        Ok(Some(
            json!({ "type": "image", "source": { "type": "base64", "media_type": mime, "data": STANDARD.encode(bytes) } }),
        ))
    } else {
        Ok(Some(
            json!({ "inlineData": { "mimeType": mime, "data": STANDARD.encode(bytes) } }),
        ))
    }
}

fn user_parts(content: &Value, protocol: &str) -> AppResult<Vec<Value>> {
    let mut out = Vec::new();
    if let Some(parts) = content.as_array() {
        for part in parts {
            if let Some(image) = image_block(part, protocol)? {
                out.push(image);
            } else if let Some(t) = part.get("text").and_then(Value::as_str) {
                out.push(if protocol == "anthropic" {
                    json!({ "type": "text", "text": t })
                } else {
                    json!({ "text": t })
                });
            }
        }
    } else if let Some(t) = content.as_str().filter(|t| !t.is_empty()) {
        out.push(if protocol == "anthropic" {
            json!({ "type": "text", "text": t })
        } else {
            json!({ "text": t })
        });
    }
    Ok(out)
}

pub fn build_chat_body(req: &ChatRequest, stream: bool) -> AppResult<Value> {
    let protocol = req.protocol.as_deref().unwrap_or("openai");
    if protocol == "openai" {
        let mut body = json!({ "model": req.model, "messages": req.messages, "stream": stream });
        if let Some(v) = req.temperature {
            body["temperature"] = json!(v);
        }
        if let Some(v) = req.max_tokens {
            body["max_tokens"] = json!(v);
        }
        if let Some(v) = &req.tools {
            body["tools"] = json!(v);
        }
        if let Some(v) = &req.tool_choice {
            body["tool_choice"] = v.clone();
        }
        merge_extra(&mut body, &req.extra_body);
        return Ok(body);
    }
    if protocol != "anthropic" && protocol != "gemini" {
        return Err(AppError::config(format!("不支持的对话协议：{protocol}")));
    }
    let mut system = Vec::new();
    let mut messages: Vec<Value> = Vec::new();
    let mut call_names = HashMap::<String, String>::new();
    for m in &req.messages {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("user");
        if role == "system" || role == "developer" {
            system.push(text(&m["content"]));
            continue;
        }
        let mut parts = user_parts(&m["content"], protocol)?;
        if role == "assistant" {
            if let Some(calls) = m.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let name = call["function"]["name"].as_str().unwrap_or_default();
                    let id = call["id"].as_str().unwrap_or_default();
                    let input: Value = serde_json::from_str(
                        call["function"]["arguments"].as_str().unwrap_or("{}"),
                    )?;
                    call_names.insert(id.into(), name.into());
                    parts.push(if protocol == "anthropic" {
                        json!({ "type": "tool_use", "id": id, "name": name, "input": input })
                    } else {
                        call.get("provider_data").cloned().unwrap_or_else(
                            || json!({ "functionCall": { "name": name, "args": input } }),
                        )
                    });
                }
            }
        } else if role == "tool" {
            let id = m["tool_call_id"].as_str().unwrap_or_default();
            parts = vec![if protocol == "anthropic" {
                json!({ "type": "tool_result", "tool_use_id": id, "content": text(&m["content"]) })
            } else {
                json!({ "functionResponse": { "name": call_names.get(id).ok_or_else(|| AppError::other("工具结果缺少对应的调用名称"))?, "response": { "result": text(&m["content"]) } } })
            }];
        }
        if parts.is_empty() {
            continue;
        }
        let field = if protocol == "anthropic" {
            "content"
        } else {
            "parts"
        };
        let native_role = if role == "assistant" {
            if protocol == "gemini" {
                "model"
            } else {
                "assistant"
            }
        } else {
            "user"
        };
        // 原生协议合并连续 user/tool 结果，保持 tool_result 在 user 文本/图像之前。
        if messages.last().is_some_and(|m| m["role"] == native_role) {
            messages.last_mut().unwrap()[field]
                .as_array_mut()
                .unwrap()
                .extend(parts);
        } else {
            messages.push(json!({ "role": native_role, field: parts }));
        }
    }
    let mut body = if protocol == "anthropic" {
        json!({ "model": req.model, "messages": messages, "max_tokens": req.max_tokens.unwrap_or(4096), "stream": stream })
    } else {
        json!({ "contents": messages, "generationConfig": {} })
    };
    if !system.is_empty() {
        if protocol == "anthropic" {
            body["system"] = json!(system.join("\n\n"));
        } else {
            body["systemInstruction"] = json!({ "parts": [{ "text": system.join("\n\n") }] });
        }
    }
    if let Some(t) = req.temperature {
        if protocol == "anthropic" {
            body["temperature"] = json!(t.clamp(0.0, 1.0));
        } else {
            body["generationConfig"]["temperature"] = json!(t);
        }
    }
    if protocol == "gemini" {
        if let Some(n) = req.max_tokens {
            body["generationConfig"]["maxOutputTokens"] = json!(n);
        }
    }
    if let Some(tools) = &req.tools {
        let converted: Vec<Value> = tools.iter().filter_map(|tool| tool.get("function")).map(|function| {
            if protocol == "anthropic" { json!({ "name": function["name"], "description": function["description"], "input_schema": function["parameters"] }) }
            else { json!({ "name": function["name"], "description": function["description"], "parameters": function["parameters"] }) }
        }).collect();
        if !converted.is_empty() {
            body["tools"] = if protocol == "anthropic" {
                json!(converted)
            } else {
                json!([{ "functionDeclarations": converted }])
            };
        }
    }
    merge_extra(&mut body, &req.extra_body);
    Ok(body)
}

fn merge_extra(body: &mut Value, extra: &Option<Value>) {
    if let Some(extra) = extra.as_ref().and_then(Value::as_object) {
        for (key, value) in extra {
            if value.is_null() {
                body.as_object_mut().unwrap().remove(key);
            } else {
                body[key] = value.clone();
            }
        }
    }
}

async fn send_chat(req: &ChatRequest, stream: bool) -> AppResult<reqwest::Response> {
    let protocol = req.protocol.as_deref().unwrap_or("openai");
    let url = if protocol == "gemini" {
        gemini_url(&req.base_url, &req.model, stream)?
    } else {
        ai::build_url(
            &req.base_url,
            if protocol == "anthropic" {
                "/messages"
            } else {
                "/chat/completions"
            },
        )?
    };
    let client = ai::client(req.timeout_secs.unwrap_or(300))?;
    if protocol == "openai" {
        let mut body = ai::build_chat_body(req, stream);
        return ai::post_json(&client, &url, &req.api_key, &mut body, stream).await;
    }
    let builder = client.post(url).json(&build_chat_body(req, stream)?);
    let builder = match protocol {
        "anthropic" => builder
            .header("x-api-key", req.api_key.trim())
            .header("anthropic-version", "2023-06-01"),
        "gemini" => builder.header("x-goog-api-key", req.api_key.trim()),
        _ => builder.bearer_auth(req.api_key.trim()),
    };
    let response = builder.send().await?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    Ok(response)
}

#[derive(Default)]
pub struct Reply {
    pub content: String,
    pub reasoning: String,
    pub calls: Vec<ToolCall>,
    pub usage: Option<Value>,
}

pub fn parse_reply(value: &Value, protocol: &str) -> AppResult<Reply> {
    if let Some(error) = value.get("error") {
        return Err(AppError::other(text(&error["message"])));
    }
    let mut reply = Reply::default();
    match protocol {
        "anthropic" => {
            if let Some(parts) = value["content"].as_array() {
                for part in parts {
                    match part["type"].as_str().unwrap_or_default() {
                        "text" => reply.content.push_str(&text(&part["text"])),
                        "thinking" => reply.reasoning.push_str(&text(&part["thinking"])),
                        "tool_use" => reply.calls.push(ToolCall {
                            provider_data: None,
                            id: part["id"].as_str().unwrap_or_default().into(),
                            name: part["name"].as_str().unwrap_or_default().into(),
                            arguments: part["input"].to_string(),
                        }),
                        _ => {}
                    }
                }
            }
            reply.usage = value.get("usage").cloned();
        }
        "gemini" => {
            if let Some(parts) = value["candidates"][0]["content"]["parts"].as_array() {
                for part in parts {
                    if let Some(t) = part["text"].as_str() {
                        if part["thought"].as_bool() == Some(true) {
                            reply.reasoning.push_str(t);
                        } else {
                            reply.content.push_str(t);
                        }
                    }
                    if let Some(call) = part.get("functionCall") {
                        reply.calls.push(ToolCall {
                            provider_data: Some(part.clone()),
                            id: format!("call_{}", uuid::Uuid::new_v4().simple()),
                            name: call["name"].as_str().unwrap_or_default().into(),
                            arguments: call.get("args").cloned().unwrap_or(json!({})).to_string(),
                        });
                    }
                }
            }
            reply.usage = value.get("usageMetadata").cloned();
        }
        _ => {
            let message = &value["choices"][0]["message"];
            reply.content = text(&message["content"]);
            reply.reasoning = text(&message["reasoning_content"]);
            if let Some(calls) = message["tool_calls"].as_array() {
                for call in calls {
                    reply.calls.push(ToolCall {
                        provider_data: None,
                        id: call["id"].as_str().unwrap_or_default().into(),
                        name: call["function"]["name"].as_str().unwrap_or_default().into(),
                        arguments: call["function"]["arguments"]
                            .as_str()
                            .unwrap_or("{}")
                            .into(),
                    });
                }
            }
            reply.usage = value.get("usage").cloned();
        }
    }
    if reply.content.is_empty() && reply.calls.is_empty() && reply.reasoning.is_empty() {
        return Err(AppError::other(
            "模型未返回内容，可能被安全策略拦截或模型不支持当前请求",
        ));
    }
    Ok(reply)
}

pub async fn chat_once(req: ChatRequest) -> AppResult<String> {
    let response = send_chat(&req, false).await?;
    let reply = parse_reply(
        &response.json::<Value>().await?,
        req.protocol.as_deref().unwrap_or("openai"),
    )?;
    if reply.content.is_empty() {
        return Err(AppError::other("模型返回了空内容"));
    }
    Ok(reply.content.trim().into())
}

pub async fn chat_stream(
    req: ChatRequest,
    channel: Channel<ChatEvent>,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    let protocol = req.protocol.as_deref().unwrap_or("openai");
    let stream = req.stream.unwrap_or(true) && protocol != "openai";
    let response = tokio::select! {
        response = send_chat(&req, stream) => response?,
        _ = wait_cancel(cancel.clone()) => return Ok(()),
    };
    let mut calls = Vec::new();
    let mut usage = None;
    let mut got_content = false;
    if response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.contains("text/event-stream"))
    {
        let mut bytes = response.bytes_stream();
        let mut buffer = Vec::<u8>::new();
        let mut tools = BTreeMap::<u64, ToolCall>::new();
        while let Some(chunk) = tokio::select! {
            chunk = bytes.next() => chunk,
            _ = wait_cancel(cancel.clone()) => return Ok(()),
        } {
            buffer.extend_from_slice(&chunk?);
            while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
                let raw = buffer.drain(..=pos).collect::<Vec<_>>();
                let line = String::from_utf8_lossy(&raw);
                let Some(data) = line.trim().strip_prefix("data:").map(str::trim) else {
                    continue;
                };
                if data == "[DONE]" {
                    continue;
                }
                let value: Value = serde_json::from_str(data)?;
                if value.get("error").is_some() {
                    return Err(AppError::other(text(&value["error"]["message"])));
                }
                if protocol == "gemini" {
                    let reply = parse_reply(&value, protocol);
                    if let Ok(reply) = reply {
                        if !reply.content.is_empty() {
                            got_content = true;
                            channel.send(ChatEvent::Delta {
                                text: reply.content,
                            })?;
                        }
                        if !reply.reasoning.is_empty() {
                            channel.send(ChatEvent::Reasoning {
                                text: reply.reasoning,
                            })?;
                        }
                        calls.extend(reply.calls);
                        if reply.usage.is_some() {
                            usage = reply.usage;
                        }
                    }
                } else {
                    let index = value["index"].as_u64().unwrap_or(0);
                    match value["type"].as_str().unwrap_or_default() {
                        "message_start" => usage = value["message"].get("usage").cloned(),
                        "content_block_start" if value["content_block"]["type"] == "tool_use" => {
                            let block = &value["content_block"];
                            tools.insert(
                                index,
                                ToolCall {
                                    provider_data: None,
                                    id: block["id"].as_str().unwrap_or_default().into(),
                                    name: block["name"].as_str().unwrap_or_default().into(),
                                    arguments: String::new(),
                                },
                            );
                        }
                        "content_block_delta" => {
                            let delta = &value["delta"];
                            if let Some(t) = delta["text"].as_str() {
                                got_content = true;
                                channel.send(ChatEvent::Delta { text: t.into() })?;
                            }
                            if let Some(t) = delta["thinking"].as_str() {
                                channel.send(ChatEvent::Reasoning { text: t.into() })?;
                            }
                            if let Some(t) = delta["partial_json"].as_str() {
                                if let Some(call) = tools.get_mut(&index) {
                                    call.arguments.push_str(t);
                                }
                            }
                        }
                        "message_delta" => {
                            if let Some(new_usage) = value.get("usage").and_then(Value::as_object) {
                                let acc = usage.get_or_insert_with(|| json!({}));
                                for (key, value) in new_usage {
                                    acc[key] = value.clone();
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        calls.extend(tools.into_values().map(|mut call| {
            if call.arguments.is_empty() {
                call.arguments = "{}".into();
            }
            call
        }));
    } else {
        let value = tokio::select! { value = response.json::<Value>() => value?, _ = wait_cancel(cancel.clone()) => return Ok(()) };
        let reply = parse_reply(&value, protocol)?;
        if !reply.content.is_empty() {
            got_content = true;
            channel.send(ChatEvent::Delta {
                text: reply.content,
            })?;
        }
        if !reply.reasoning.is_empty() {
            channel.send(ChatEvent::Reasoning {
                text: reply.reasoning,
            })?;
        }
        calls = reply.calls;
        usage = reply.usage;
    }
    // 有些原生网关声明 SSE，却直接关闭空响应；尚未输出或执行工具时，回退一次非流式请求。
    if !got_content && calls.is_empty() && stream {
        let response = tokio::select! {
            response = send_chat(&req, false) => response?,
            _ = wait_cancel(cancel.clone()) => return Ok(()),
        };
        let value = tokio::select! { value = response.json::<Value>() => value?, _ = wait_cancel(cancel.clone()) => return Ok(()) };
        let reply = parse_reply(&value, protocol)?;
        if !reply.content.is_empty() {
            got_content = true;
            channel.send(ChatEvent::Delta {
                text: reply.content,
            })?;
        }
        if !reply.reasoning.is_empty() {
            channel.send(ChatEvent::Reasoning {
                text: reply.reasoning,
            })?;
        }
        calls = reply.calls;
        usage = reply.usage;
    }
    if !got_content && calls.is_empty() {
        return Err(AppError::other("模型未返回内容"));
    }
    if !calls.is_empty() {
        channel.send(ChatEvent::ToolCalls { calls })?;
    }
    if let Some(usage) = usage {
        channel.send(ChatEvent::Usage { usage })?;
    }
    channel.send(ChatEvent::Done {
        finish_reason: Some("stop".into()),
    })?;
    Ok(())
}

pub async fn list_models(base: &str, key: &str, protocol: &str) -> AppResult<Vec<String>> {
    if protocol == "openai" {
        return ai::list_models(base, key).await;
    }
    if protocol != "anthropic" && protocol != "gemini" {
        return Err(AppError::config("不支持的模型列表协议"));
    }
    let endpoint = if protocol == "gemini" {
        format!("{}/models", gemini_root(base)?)
    } else {
        ai::build_url(base, "/models")?
    };
    let client = ai::client(60)?;
    let mut url = reqwest::Url::parse(&endpoint).map_err(|e| AppError::other(e.to_string()))?;
    let mut ids = Vec::new();
    for _ in 0..100 {
        let builder = client.get(url.clone());
        let builder = if protocol == "gemini" {
            builder.header("x-goog-api-key", key.trim())
        } else {
            builder
                .header("x-api-key", key.trim())
                .header("anthropic-version", "2023-06-01")
        };
        let response = builder.send().await?;
        if !response.status().is_success() {
            return Err(api_error(response).await);
        }
        let value: Value = response.json().await?;
        if let Some(models) = value[if protocol == "gemini" {
            "models"
        } else {
            "data"
        }]
        .as_array()
        {
            ids.extend(
                models
                    .iter()
                    .filter_map(|m| m[if protocol == "gemini" { "name" } else { "id" }].as_str())
                    .map(|id| id.trim_start_matches("models/").to_string()),
            );
        }
        url.query_pairs_mut().clear();
        if protocol == "gemini" {
            let Some(token) = value["nextPageToken"].as_str().filter(|s| !s.is_empty()) else {
                break;
            };
            url.query_pairs_mut().append_pair("pageToken", token);
        } else {
            if value["has_more"] != true {
                break;
            }
            let Some(last) = value["last_id"].as_str() else {
                break;
            };
            url.query_pairs_mut().append_pair("after_id", last);
        }
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}

pub fn image_label(req: &ImageRequest, i: usize) -> String {
    req.image_labels
        .get(i)
        .cloned()
        .unwrap_or_else(|| format!("素材 {}", i + 1))
}

pub fn ordered_image_prompt(req: &ImageRequest) -> String {
    let labels: Vec<String> = req
        .images
        .iter()
        .enumerate()
        .map(|(i, _)| {
            format!(
                "输入图片 {}（image_{}）：{}",
                i + 1,
                i + 1,
                image_label(req, i)
            )
        })
        .collect();
    format!(
        "{}\n\n图片输入顺序（下列标签对应原消息里的素材；第一张为编辑基底）：\n{}",
        req.prompt,
        labels.join("\n")
    )
}

pub fn build_image_body(req: &ImageRequest) -> AppResult<Value> {
    if req.mask.as_ref().is_some_and(|mask| !mask.is_empty()) {
        return Err(AppError::config(
            "Gemini 原生协议不支持蒙版参数，请使用 images 协议进行局部重绘",
        ));
    }
    let mut parts = vec![json!({ "text": req.prompt })];
    for (i, image) in req.images.iter().enumerate() {
        let (mime, bytes) = ai::parse_data_url(image)?;
        parts.push(json!({ "text": image_label(req, i) }));
        parts.push(json!({ "inlineData": { "mimeType": mime, "data": STANDARD.encode(bytes) } }));
    }
    let mut body = json!({ "contents": [{ "role": "user", "parts": parts }], "generationConfig": { "responseModalities": ["TEXT", "IMAGE"] } });
    if let Some((ratio, resolution)) = image_dimensions(req.size.as_deref())? {
        let mut config = json!({ "aspectRatio": ratio });
        if let Some(resolution) = resolution {
            config["imageSize"] = json!(resolution);
        }
        body["generationConfig"]["imageConfig"] = config;
    }
    merge_extra(&mut body, &req.extra_body);
    Ok(body)
}

/// 原生/兼容 Gemini 使用比例与分辨率档位，无法保证逐像素尺寸。
pub fn image_dimensions(
    size: Option<&str>,
) -> AppResult<Option<(&'static str, Option<&'static str>)>> {
    let Some(size) = size
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "auto")
    else {
        return Ok(None);
    };
    let size = size.to_ascii_lowercase().replace('×', "x");
    let (width, height) = size
        .split_once('x')
        .ok_or_else(|| AppError::config("图像尺寸应为宽x高"))?;
    let width = width
        .parse::<u32>()
        .ok()
        .filter(|v| *v > 0 && *v <= 99999)
        .ok_or_else(|| AppError::config("图像宽度无效"))?;
    let height = height
        .parse::<u32>()
        .ok()
        .filter(|v| *v > 0 && *v <= 99999)
        .ok_or_else(|| AppError::config("图像高度无效"))?;
    let desired = width as f64 / height as f64;
    let ratios = [
        ("1:1", 1.0),
        ("2:3", 2.0 / 3.0),
        ("3:2", 3.0 / 2.0),
        ("3:4", 3.0 / 4.0),
        ("4:3", 4.0 / 3.0),
        ("4:5", 4.0 / 5.0),
        ("5:4", 5.0 / 4.0),
        ("9:16", 9.0 / 16.0),
        ("16:9", 16.0 / 9.0),
        ("21:9", 21.0 / 9.0),
    ];
    let ratio = ratios
        .iter()
        .min_by(|a, b| {
            (a.1 / desired)
                .ln()
                .abs()
                .total_cmp(&(b.1 / desired).ln().abs())
        })
        .unwrap()
        .0;
    let pixels = width as u64 * height as u64;
    // 常规 1K 使用模型默认档位，避免旧模型拒绝 imageSize。
    let resolution = if pixels >= 7_000_000 {
        Some("4K")
    } else if pixels >= 3_000_000 {
        Some("2K")
    } else {
        None
    };
    Ok(Some((ratio, resolution)))
}

pub fn parse_images(value: &Value) -> AppResult<Vec<RawImage>> {
    if let Some(error) = value.get("error") {
        return Err(AppError::other(text(&error["message"])));
    }
    let mut out = Vec::new();
    if let Some(candidates) = value["candidates"].as_array() {
        for candidate in candidates {
            if let Some(parts) = candidate["content"]["parts"].as_array() {
                for part in parts {
                    if part["thought"] == true {
                        continue;
                    }
                    let Some(image) = part.get("inlineData").or_else(|| part.get("inline_data"))
                    else {
                        continue;
                    };
                    let mime = image
                        .get("mimeType")
                        .or_else(|| image.get("mime_type"))
                        .and_then(Value::as_str)
                        .unwrap_or("image/png");
                    let Some(data) = image["data"].as_str() else {
                        continue;
                    };
                    let (mime, bytes) = ai::parse_data_url(&format!("data:{mime};base64,{data}"))?;
                    let ext = match mime.as_str() {
                        "image/jpeg" => "jpg",
                        "image/webp" => "webp",
                        _ => "png",
                    };
                    out.push(RawImage {
                        bytes,
                        mime,
                        ext: ext.into(),
                        revised_prompt: None,
                        source_url: None,
                    });
                }
            }
        }
    }
    if out.is_empty() {
        return Err(AppError::other(
            "Gemini 未返回图像，请确认模型支持图像输出，或检查安全策略拦截",
        ));
    }
    Ok(out)
}

pub async fn generate_images(
    req: &ImageRequest,
    client: &reqwest::Client,
) -> AppResult<Vec<RawImage>> {
    let body = build_image_body(req)?;
    let url = gemini_url(&req.base_url, &req.model, false)?;
    let mut out = Vec::new();
    for _ in 0..req.n.unwrap_or(1).clamp(1, 10) {
        let response = client
            .post(&url)
            .header("x-goog-api-key", req.api_key.trim())
            .json(&body)
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(api_error(response).await);
        }
        out.extend(parse_images(&response.json::<Value>().await?)?);
    }
    Ok(out)
}
