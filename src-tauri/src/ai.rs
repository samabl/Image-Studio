use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::ipc::Channel;

use crate::error::{api_error, AppError, AppResult};

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

/// 把用户填的 Base URL 正规化成完整端点。
///
/// 三种写法都支持，避免用户纠结要不要带 `/v1`：
///   `http://host:3000`          -> `http://host:3000/v1/chat/completions`
///   `http://host:3000/v1`       -> `http://host:3000/v1/chat/completions`
///   `http://host:3000/v1/chat/completions`（原样使用）
pub fn build_url(base: &str, path: &str) -> AppResult<String> {
    let b = base.trim().trim_end_matches('/');
    if b.is_empty() {
        return Err(AppError::config("Base URL 未配置"));
    }
    if !b.starts_with("http://") && !b.starts_with("https://") {
        return Err(AppError::config(
            "Base URL 必须以 http:// 或 https:// 开头，例如 http://10.0.0.1:3000/v1",
        ));
    }
    if b.ends_with(path) {
        return Ok(b.to_string());
    }
    if b.ends_with("/v1") {
        return Ok(format!("{b}{path}"));
    }
    Ok(format!("{b}/v1{path}"))
}

fn client(timeout_secs: u64) -> AppResult<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(timeout_secs.clamp(10, 3600)))
        .user_agent(concat!("GPT-Image-Studio/", env!("CARGO_PKG_VERSION")))
        .build()?)
}

/// 流式请求专用：不设总超时（长回答可能几分钟），只靠每次读块的 idle 超时兜底。
fn stream_client() -> AppResult<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .user_agent(concat!("GPT-Image-Studio/", env!("CARGO_PKG_VERSION")))
        .build()?)
}

/// 解析 `data:image/png;base64,xxxx`，返回 (mime, bytes)。
pub fn parse_data_url(input: &str) -> AppResult<(String, Vec<u8>)> {
    let s = input.trim();
    let rest = s
        .strip_prefix("data:")
        .ok_or_else(|| AppError::other("图像必须是 data URL 形式"))?;
    let (meta, b64) = rest
        .split_once(',')
        .ok_or_else(|| AppError::other("data URL 缺少逗号分隔符"))?;
    if !meta.contains("base64") {
        return Err(AppError::other("仅支持 base64 编码的 data URL"));
    }
    let mime = meta
        .split(';')
        .next()
        .filter(|m| m.starts_with("image/"))
        .unwrap_or("image/png")
        .to_string();
    let bytes = STANDARD
        .decode(b64.trim().replace(['\n', '\r', ' '], ""))
        .map_err(|e| AppError::other(format!("Base64 解码失败：{e}")))?;
    Ok((mime, bytes))
}

pub fn to_data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", STANDARD.encode(bytes))
}

fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        _ => "png",
    }
}

// ---------------------------------------------------------------------------
// 参数兼容性：自动摘掉网关不认识的字段后重试
// ---------------------------------------------------------------------------

/// 从错误响应里认出「不支持某个参数」并取出参数名。
///
/// 各家网关措辞不一，这里覆盖 OpenAI 官方的
/// `Unsupported parameter: 'x'` 以及常见的 `Unknown parameter` /
/// `Unrecognized request argument supplied: x`。
pub fn unsupported_param(text: &str) -> Option<String> {
    const MARKERS: [&str; 5] = [
        "Unsupported parameter: '",
        "Unsupported parameter: \"",
        "Unknown parameter: '",
        "Unknown parameter: \"",
        "Unrecognized request argument supplied: ",
    ];
    for marker in MARKERS {
        let Some(i) = text.find(marker) else { continue };
        let rest = &text[i + marker.len()..];
        let end = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.'))
            .unwrap_or(rest.len());
        let name = &rest[..end];
        if !name.is_empty() && name.len() < 64 {
            return Some(name.to_string());
        }
    }
    None
}

/// POST JSON，并在网关拒绝某个参数时自动降级重试。
///
/// 为什么需要这个：新版推理模型（如 gpt-5.6 系列）普遍不再接受 `temperature`，
/// 部分网关把 `max_tokens` 换成了 `max_completion_tokens`。与其在设置页堆一堆
/// 「是否发送某参数」的开关，不如让请求自己适配 —— 命中一次 400 就摘掉该字段重发，
/// 对用户完全透明。
async fn post_json(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: &mut Value,
    sse: bool,
) -> AppResult<reqwest::Response> {
    const MAX_RETRY: usize = 3;

    for attempt in 0..=MAX_RETRY {
        let mut rb = client.post(url).bearer_auth(api_key.trim());
        if sse {
            rb = rb.header("Accept", "text/event-stream");
        }
        let resp = rb.json(&*body).send().await?;

        if resp.status().is_success() {
            return Ok(resp);
        }

        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();

        if attempt < MAX_RETRY {
            if let Some(param) = unsupported_param(&text) {
                if let Some(obj) = body.as_object_mut() {
                    let changed = if param == "max_tokens"
                        && obj.contains_key("max_tokens")
                        && !obj.contains_key("max_completion_tokens")
                    {
                        // 新旧命名的等价替换，保留用户的长度限制
                        let v = obj.remove("max_tokens").expect("刚刚检查过存在");
                        obj.insert("max_completion_tokens".into(), v);
                        true
                    } else {
                        obj.remove(&param).is_some()
                    };
                    if changed {
                        eprintln!("网关不支持参数 `{param}`，已自动调整后重试（第 {} 次）", attempt + 1);
                        continue;
                    }
                }
            }
        }

        return Err(AppError::Api {
            status,
            body: crate::ai::truncate(&text, 1200),
        });
    }

    unreachable!("循环内必定 return")
}

/// 从各种形态的 content 字段里抽出纯文本（字符串 / 分片数组 / 嵌套对象都兼容）。
fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().map(text_of).collect::<Vec<_>>().join(""),
        Value::Object(map) => map
            .get("text")
            .map(text_of)
            .or_else(|| map.get("content").map(text_of))
            .unwrap_or_default(),
        Value::Null => String::new(),
        other => other.as_str().map(str::to_string).unwrap_or_default(),
    }
}

// ---------------------------------------------------------------------------
// 模型列表
// ---------------------------------------------------------------------------

pub async fn list_models(base_url: &str, api_key: &str) -> AppResult<Vec<String>> {
    let url = build_url(base_url, "/models")?;
    let resp = client(60)?
        .get(&url)
        .bearer_auth(api_key.trim())
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let body: Value = resp.json().await?;
    let mut ids: Vec<String> = body
        .get("data")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    m.get("id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| m.as_str().map(str::to_string))
                })
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

// ---------------------------------------------------------------------------
// 对话（流式）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// 直接透传 OpenAI 格式的 messages，多模态只需前端组装 content 数组。
    pub messages: Vec<Value>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub tools: Option<Vec<Value>>,
    #[serde(default)]
    pub tool_choice: Option<Value>,
    /// 附加/覆盖请求体字段，用于兼容各网关的私有参数。
    #[serde(default)]
    pub extra_body: Option<Value>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatEvent {
    Delta { text: String },
    Reasoning { text: String },
    ToolCalls { calls: Vec<ToolCall> },
    Usage { usage: Value },
    Done { finish_reason: Option<String> },
    Error { message: String },
}

#[derive(Default, Clone)]
struct ToolCallAcc {
    id: String,
    name: String,
    arguments: String,
}

fn build_chat_body(req: &ChatRequest, stream: bool) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), json!(req.model));
    body.insert("messages".into(), json!(req.messages));
    body.insert("stream".into(), json!(stream));
    if let Some(t) = req.temperature {
        body.insert("temperature".into(), json!(t));
    }
    if let Some(m) = req.max_tokens {
        if m > 0 {
            body.insert("max_tokens".into(), json!(m));
        }
    }
    if let Some(tools) = &req.tools {
        if !tools.is_empty() {
            body.insert("tools".into(), json!(tools));
        }
    }
    if let Some(tc) = &req.tool_choice {
        if !tc.is_null() {
            body.insert("tool_choice".into(), tc.clone());
        }
    }
    // 网关私有参数合并（放在最后，允许覆盖上面任何字段）
    if let Some(Value::Object(extra)) = &req.extra_body {
        for (k, v) in extra {
            if v.is_null() || v.as_str() == Some("") {
                body.remove(k);
            } else {
                body.insert(k.clone(), v.clone());
            }
        }
    }
    Value::Object(body)
}

/// 流式对话：通过 `Channel` 把增量推给前端。
///
/// `cancel` 由 `chat_cancel` 命令置位；`on_event.send` 失败说明前端已经卸载监听
/// （组件被关掉 / 页面切换），两种情况都立刻停止读取，不再浪费 token。
#[allow(unused_assignments)] // emit! 里 closed 的赋值在函数收尾处不一定再被读取
pub async fn chat_stream(
    req: ChatRequest,
    on_event: Channel<ChatEvent>,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    let url = build_url(&req.base_url, "/chat/completions")?;
    let idle = Duration::from_secs(req.timeout_secs.unwrap_or(300).clamp(30, 1800));
    let mut body = build_chat_body(&req, true);
    let client = stream_client()?;

    let resp = match post_json(&client, &url, &req.api_key, &mut body, true).await {
        Ok(r) => r,
        Err(err) => {
            let _ = on_event.send(ChatEvent::Error {
                message: err.to_string(),
            });
            return Ok(());
        }
    };

    // 通道断开（前端组件卸载）或用户点了「停止」时置位，循环顶部统一检查
    let mut closed = false;
    macro_rules! emit {
        ($ev:expr) => {
            if !closed && on_event.send($ev).is_err() {
                closed = true;
            }
        };
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut tool_accs: Vec<ToolCallAcc> = Vec::new();
    let mut finish_reason: Option<String> = None;
    let mut usage: Option<Value> = None;
    let mut got_any = false;

    loop {
        if closed || cancel.load(Ordering::Relaxed) {
            break;
        }
        let next = tokio::time::timeout(idle, stream.next()).await;
        let chunk = match next {
            Err(_) => {
                emit!(ChatEvent::Error {
                    message: format!("等待服务端响应超过 {} 秒，已中断", idle.as_secs()),
                });
                break;
            }
            Ok(None) => break,
            Ok(Some(Err(e))) => {
                emit!(ChatEvent::Error {
                    message: format!("读取流式响应失败：{e}"),
                });
                break;
            }
            Ok(Some(Ok(c))) => c,
        };

        buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = buf.find('\n') {
            let raw: String = buf.drain(..=pos).collect();
            let line = raw.trim_end_matches(['\n', '\r']).trim();
            if line.is_empty() || line.starts_with(':') || line.starts_with("event:") {
                continue;
            }
            let payload = match line.strip_prefix("data:") {
                Some(p) => p.trim(),
                None => continue,
            };
            if payload == "[DONE]" {
                continue;
            }
            let v: Value = match serde_json::from_str(payload) {
                Ok(v) => v,
                // 少数网关会插入心跳等非 JSON 行，跳过即可
                Err(_) => continue,
            };

            if let Some(err) = v.get("error") {
                let msg = err
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| err.to_string());
                emit!(ChatEvent::Error { message: msg });
                return Ok(());
            }

            if let Some(u) = v.get("usage") {
                if !u.is_null() {
                    usage = Some(u.clone());
                }
            }

            let Some(choices) = v.get("choices").and_then(Value::as_array) else {
                continue;
            };

            for choice in choices {
                if let Some(fr) = choice.get("finish_reason").and_then(Value::as_str) {
                    finish_reason = Some(fr.to_string());
                }

                // 非流式兜底：有的网关无视 stream=true 直接返回完整 message
                if let Some(msg) = choice.get("message") {
                    let text = text_of(&msg.get("content").cloned().unwrap_or(Value::Null));
                    if !text.is_empty() {
                        got_any = true;
                        emit!(ChatEvent::Delta { text });
                    }
                }

                let Some(delta) = choice.get("delta") else {
                    continue;
                };

                for key in ["reasoning_content", "reasoning"] {
                    if let Some(t) = delta.get(key) {
                        let t = text_of(t);
                        if !t.is_empty() {
                            emit!(ChatEvent::Reasoning { text: t });
                        }
                    }
                }

                if let Some(c) = delta.get("content") {
                    let t = text_of(c);
                    if !t.is_empty() {
                        got_any = true;
                        emit!(ChatEvent::Delta { text: t });
                    }
                }

                if let Some(tcs) = delta.get("tool_calls").and_then(Value::as_array) {
                    for tc in tcs {
                        let idx = tc.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                        while tool_accs.len() <= idx {
                            tool_accs.push(ToolCallAcc::default());
                        }
                        let acc = &mut tool_accs[idx];
                        if let Some(id) = tc.get("id").and_then(Value::as_str) {
                            if !id.is_empty() && acc.id.is_empty() {
                                acc.id = id.to_string();
                            }
                        }
                        if let Some(func) = tc.get("function") {
                            if let Some(n) = func.get("name").and_then(Value::as_str) {
                                acc.name.push_str(n);
                            }
                            if let Some(a) = func.get("arguments").and_then(Value::as_str) {
                                acc.arguments.push_str(a);
                            }
                        }
                    }
                }
            }
        }
    }

    if !tool_accs.is_empty() {
        let calls: Vec<ToolCall> = tool_accs
            .into_iter()
            .filter(|a| !a.name.is_empty())
            .map(|a| ToolCall {
                id: if a.id.is_empty() {
                    format!("call_{}", uuid::Uuid::new_v4().simple())
                } else {
                    a.id
                },
                name: a.name,
                arguments: a.arguments,
            })
            .collect();
        if !calls.is_empty() {
            emit!(ChatEvent::ToolCalls { calls });
        }
    }

    if let Some(u) = usage {
        emit!(ChatEvent::Usage { usage: u });
    }

    emit!(ChatEvent::Done {
        finish_reason: finish_reason.or_else(|| {
            if got_any {
                Some("stop".into())
            } else {
                None
            }
        }),
    });

    Ok(())
}

/// 非流式对话，返回纯文本。用于提示词优化 / 反推等内部工具调用。
pub async fn chat_once(req: ChatRequest) -> AppResult<String> {
    let url = build_url(&req.base_url, "/chat/completions")?;
    let client = client(req.timeout_secs.unwrap_or(180))?;
    let mut body = build_chat_body(&req, false);

    let resp = post_json(&client, &url, &req.api_key, &mut body, false).await?;
    let v: Value = resp.json().await?;
    if let Some(err) = v.get("error") {
        return Err(AppError::other(
            err.get("message")
                .and_then(Value::as_str)
                .unwrap_or("接口返回错误")
                .to_string(),
        ));
    }
    let text = v
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .map(|c| {
            c.get("message")
                .map(|m| text_of(&m.get("content").cloned().unwrap_or(Value::Null)))
                .unwrap_or_default()
        })
        .unwrap_or_default();

    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(AppError::other("模型返回了空内容"));
    }
    Ok(text)
}

// ---------------------------------------------------------------------------
// 图像生成 / 编辑
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// `images` | `chat`
    #[serde(default)]
    pub api_mode: Option<String>,
    pub prompt: String,
    /// data URL 列表：文生图为空，图生图/编辑为参考图
    #[serde(default)]
    pub images: Vec<String>,
    /// data URL，蒙版（透明区域 = 待编辑区域）
    #[serde(default)]
    pub mask: Option<String>,
    #[serde(default)]
    pub n: Option<u32>,
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub background: Option<String>,
    #[serde(default)]
    pub output_format: Option<String>,
    #[serde(default)]
    pub extra_body: Option<Value>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

/// 尚未落盘的图像结果。
pub struct RawImage {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub ext: String,
    pub revised_prompt: Option<String>,
    /// 图床直链（当接口返回的是 URL 而不是 base64 时记录，便于排查问题）
    #[allow(dead_code)]
    pub source_url: Option<String>,
}

/// `auto` / 空值表示「不下发这个参数」，以最大化兼容各家网关。
fn opt_str(v: &Option<String>) -> Option<String> {
    v.as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && *s != "auto" && *s != "default")
        .map(str::to_string)
}

fn collect_images_from_json(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(map) => {
            if let Some(url) = map
                .get("image_url")
                .and_then(|x| x.get("url"))
                .and_then(Value::as_str)
            {
                out.push(url.to_string());
            }
            if let Some(b64) = map.get("b64_json").and_then(Value::as_str) {
                out.push(format!("data:image/png;base64,{b64}"));
            }
            if let Some(url) = map.get("url").and_then(Value::as_str) {
                if url.starts_with("data:image") || url.starts_with("http") {
                    out.push(url.to_string());
                }
            }
            for value in map.values() {
                collect_images_from_json(value, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_images_from_json(item, out);
            }
        }
        _ => {}
    }
}

/// 从纯文本里捞出 data URL / Markdown 图片链接。
/// Gemini 系图像模型会把结果以 `![image](data:image/jpeg;base64,...)` 塞进 content。
fn extract_urls_from_text(text: &str) -> Vec<String> {
    let mut out = Vec::new();

    let mut rest = text;
    while let Some(idx) = rest.find("data:image/") {
        let tail = &rest[idx..];
        let end = tail
            .find(|c: char| {
                matches!(c, ')' | '"' | '\'' | ']' | '<' | '>') || c.is_whitespace()
            })
            .unwrap_or(tail.len());
        out.push(tail[..end].to_string());
        rest = &tail[end..];
    }

    let mut rest = text;
    while let Some(idx) = rest.find("](http") {
        let tail = &rest[idx + 2..];
        let end = tail
            .find(|c: char| matches!(c, ')' | '"' | '\'' | ']' | '<' | '>') || c.is_whitespace())
            .unwrap_or(tail.len());
        out.push(tail[..end].to_string());
        rest = &tail[end..];
    }

    out
}

async fn download(client: &reqwest::Client, url: &str, api_key: &str) -> AppResult<RawImage> {
    let mut rb = client.get(url);
    // 只有同源网关才带 key，避免把密钥泄漏给第三方图床
    rb = rb.bearer_auth(api_key.trim());
    let resp = rb.send().await?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or("image/png").trim().to_string())
        .filter(|m| m.starts_with("image/"))
        .unwrap_or_else(|| "image/png".into());
    let bytes = resp.bytes().await?.to_vec();
    let ext = ext_for_mime(&mime).to_string();
    Ok(RawImage {
        bytes,
        mime,
        ext,
        revised_prompt: None,
        source_url: Some(url.to_string()),
    })
}

/// 走 `/images/generations`（文生图）。
async fn generate_via_images(req: &ImageRequest, client: &reqwest::Client) -> AppResult<Vec<RawImage>> {
    let url = build_url(&req.base_url, "/images/generations")?;

    let mut body = Map::new();
    body.insert("model".into(), json!(req.model));
    body.insert("prompt".into(), json!(req.prompt));
    body.insert("n".into(), json!(req.n.unwrap_or(1).clamp(1, 10)));
    if let Some(s) = opt_str(&req.size) {
        body.insert("size".into(), json!(s));
    }
    if let Some(s) = opt_str(&req.quality) {
        body.insert("quality".into(), json!(s));
    }
    if let Some(s) = opt_str(&req.background) {
        body.insert("background".into(), json!(s));
    }
    if let Some(s) = opt_str(&req.output_format) {
        body.insert("output_format".into(), json!(s));
    }
    if let Some(Value::Object(extra)) = &req.extra_body {
        for (k, v) in extra {
            if v.is_null() || v.as_str() == Some("") {
                body.remove(k);
            } else {
                body.insert(k.clone(), v.clone());
            }
        }
    }

    let mut body = Value::Object(body);
    let resp = post_json(client, &url, &req.api_key, &mut body, false).await?;
    let v: Value = resp.json().await?;
    if let Some(err) = v.get("error") {
        return Err(AppError::other(
            err.get("message")
                .and_then(Value::as_str)
                .unwrap_or("接口返回错误")
                .to_string(),
        ));
    }

    let mut out = Vec::new();
    if let Some(items) = v.get("data").and_then(Value::as_array) {
        for item in items {
            let revised = item
                .get("revised_prompt")
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(b64) = item.get("b64_json").and_then(Value::as_str) {
                let (mime, bytes) = parse_data_url(&format!("data:image/png;base64,{b64}"))
                    .map_err(|e| AppError::other(format!("返回的图像无法解码：{e}")))?;
                out.push(RawImage {
                    bytes,
                    ext: ext_for_mime(&mime).to_string(),
                    mime,
                    revised_prompt: revised,
                    source_url: None,
                });
            } else if let Some(u) = item.get("url").and_then(Value::as_str) {
                let mut img = download(client, u, &req.api_key).await?;
                img.revised_prompt = revised;
                out.push(img);
            }
        }
    }
    if out.is_empty() {
        return Err(AppError::other(format!(
            "接口未返回图像，原始响应：{}",
            truncate(&v.to_string(), 600)
        )));
    }
    Ok(out)
}

/// 走 `/chat/completions` + `modalities:["image","text"]`（Gemini 系图像模型）。
async fn generate_via_chat(req: &ImageRequest, client: &reqwest::Client) -> AppResult<Vec<RawImage>> {
    let url = build_url(&req.base_url, "/chat/completions")?;

    let mut content: Vec<Value> = vec![json!({ "type": "text", "text": req.prompt })];
    for img in &req.images {
        content.push(json!({
            "type": "image_url",
            "image_url": { "url": img }
        }));
    }

    let mut body = Map::new();
    body.insert("model".into(), json!(req.model));
    body.insert(
        "messages".into(),
        json!([{ "role": "user", "content": content }]),
    );
    body.insert("modalities".into(), json!(["image", "text"]));
    if let Some(Value::Object(extra)) = &req.extra_body {
        for (k, v) in extra {
            if v.is_null() || v.as_str() == Some("") {
                body.remove(k);
            } else {
                body.insert(k.clone(), v.clone());
            }
        }
    }

    let mut body = Value::Object(body);
    let resp = post_json(client, &url, &req.api_key, &mut body, false).await?;
    let v: Value = resp.json().await?;
    if let Some(err) = v.get("error") {
        return Err(AppError::other(
            err.get("message")
                .and_then(Value::as_str)
                .unwrap_or("接口返回错误")
                .to_string(),
        ));
    }

    let mut urls = Vec::new();
    collect_images_from_json(&v, &mut urls);
    // content 里以 Markdown 形式内嵌图片的情况
    if let Some(choices) = v.get("choices").and_then(Value::as_array) {
        for c in choices {
            if let Some(content) = c.get("message").and_then(|m| m.get("content")) {
                urls.extend(extract_urls_from_text(&text_of(content)));
            }
        }
    }
    urls.retain(|u| u.starts_with("data:image") || u.starts_with("http"));
    urls.dedup();

    let mut out = Vec::new();
    for u in urls {
        if u.starts_with("data:image") {
            let (mime, bytes) = parse_data_url(&u)?;
            out.push(RawImage {
                ext: ext_for_mime(&mime).to_string(),
                bytes,
                mime,
                revised_prompt: None,
                source_url: None,
            });
        } else if u.starts_with("http") {
            out.push(download(client, &u, &req.api_key).await?);
        }
    }
    if out.is_empty() {
        return Err(AppError::other(format!(
            "模型未返回图像（当前模型可能不支持 modalities 出图），原始响应：{}",
            truncate(&v.to_string(), 600)
        )));
    }
    Ok(out)
}

/// 走 `/images/edits`（multipart），支持单图/多图与蒙版。
async fn edit_via_images(req: &ImageRequest, client: &reqwest::Client) -> AppResult<Vec<RawImage>> {
    let url = build_url(&req.base_url, "/images/edits")?;

    let mut form = reqwest::multipart::Form::new()
        .text("model", req.model.clone())
        .text("prompt", req.prompt.clone())
        .text("n", req.n.unwrap_or(1).clamp(1, 10).to_string());

    if let Some(s) = opt_str(&req.size) {
        form = form.text("size", s);
    }
    if let Some(s) = opt_str(&req.quality) {
        form = form.text("quality", s);
    }
    if let Some(s) = opt_str(&req.background) {
        form = form.text("background", s);
    }
    if let Some(s) = opt_str(&req.output_format) {
        form = form.text("output_format", s);
    }

    // 单图用 `image`，多图用 `image[]`（OpenAI 官方多图编辑的字段名）
    let multi = req.images.len() > 1;
    for (i, data_url) in req.images.iter().enumerate() {
        let (mime, bytes) = parse_data_url(data_url)?;
        let ext = ext_for_mime(&mime);
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(format!("image_{i}.{ext}"))
            .mime_str(&mime)?;
        form = if multi {
            form.part("image[]", part)
        } else {
            form.part("image", part)
        };
    }

    if let Some(mask) = req.mask.as_ref().filter(|m| !m.trim().is_empty()) {
        let (mime, bytes) = parse_data_url(mask)?;
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(format!("mask.{}", ext_for_mime(&mime)))
            .mime_str(&mime)?;
        form = form.part("mask", part);
    }

    let resp = client
        .post(&url)
        .bearer_auth(req.api_key.trim())
        .multipart(form)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let v: Value = resp.json().await?;
    if let Some(err) = v.get("error") {
        return Err(AppError::other(
            err.get("message")
                .and_then(Value::as_str)
                .unwrap_or("接口返回错误")
                .to_string(),
        ));
    }

    let mut out = Vec::new();
    if let Some(items) = v.get("data").and_then(Value::as_array) {
        for item in items {
            let revised = item
                .get("revised_prompt")
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(b64) = item.get("b64_json").and_then(Value::as_str) {
                let (mime, bytes) = parse_data_url(&format!("data:image/png;base64,{b64}"))?;
                out.push(RawImage {
                    ext: ext_for_mime(&mime).to_string(),
                    bytes,
                    mime,
                    revised_prompt: revised,
                    source_url: None,
                });
            } else if let Some(u) = item.get("url").and_then(Value::as_str) {
                let mut img = download(client, u, &req.api_key).await?;
                img.revised_prompt = revised;
                out.push(img);
            }
        }
    }
    if out.is_empty() {
        return Err(AppError::other(format!(
            "接口未返回图像，原始响应：{}",
            truncate(&v.to_string(), 600)
        )));
    }
    Ok(out)
}

/// 统一入口：按 apiMode 与是否带参考图自动选择端点。
pub async fn run_image_request(req: &ImageRequest) -> AppResult<Vec<RawImage>> {
    let client = client(req.timeout_secs.unwrap_or(600))?;
    let mode = req.api_mode.as_deref().unwrap_or("images");

    if mode == "chat" {
        return generate_via_chat(req, &client).await;
    }
    if req.images.is_empty() {
        generate_via_images(req, &client).await
    } else {
        edit_via_images(req, &client).await
    }
}

pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let t: String = s.chars().take(max).collect();
    format!("{t}…")
}
