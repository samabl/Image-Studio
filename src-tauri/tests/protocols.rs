//! 离线协议测试：真实 HTTP 请求到本地服务器，无外部 API 与费用。
use gpt_image_studio_lib::{
    ai::{self, ChatEvent, ChatRequest, ImageRequest},
    native,
};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{atomic::AtomicBool, Arc, Mutex};

fn chat(protocol: &str) -> ChatRequest {
    serde_json::from_value(json!({ "protocol": protocol, "baseUrl": "https://example.test", "apiKey": "test-key", "model": "test-model",
        "messages": [{ "role": "system", "content": "保留用户要求" }, { "role": "user", "content": [
            { "type": "text", "text": "素材 1" }, { "type": "image_url", "image_url": { "url": "data:image/png;base64,YQ==" } },
            { "type": "text", "text": "素材 2" }, { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,Yg==" } }
        ] }], "maxTokens": 256,
        "tools": [{ "type": "function", "function": { "name": "edit_image", "description": "合成素材", "parameters": { "type": "object", "properties": { "prompt": { "type": "string" } }, "required": ["prompt"] } } }]
    })).unwrap()
}

fn image() -> ImageRequest {
    serde_json::from_value(json!({ "baseUrl": "https://example.test", "apiKey": "test-key", "model": "image-test", "apiMode": "gemini", "prompt": "合成两张素材，保持人物不变",
        "images": ["data:image/png;base64,YQ==", "data:image/jpeg;base64,Yg=="], "imageLabels": ["人物", "背景"], "size": "1536x1024" })).unwrap()
}

#[test]
fn anthropic_messages_preserve_image_order_and_tools() {
    let body = native::build_chat_body(&chat("anthropic"), true).unwrap();
    assert_eq!(body["system"], "保留用户要求");
    assert_eq!(body["stream"], true);
    assert_eq!(body["messages"][0]["content"][1]["source"]["data"], "YQ==");
    assert_eq!(
        body["messages"][0]["content"][3]["source"]["media_type"],
        "image/jpeg"
    );
    assert_eq!(body["tools"][0]["input_schema"]["required"][0], "prompt");
    assert!(body.get("modalities").is_none());
}

#[test]
fn native_tool_results_and_gemini_signatures_roundtrip() {
    let mut req = chat("gemini");
    req.messages.extend([
        json!({ "role": "assistant", "content": null, "tool_calls": [{ "id": "call1", "function": { "name": "edit_image", "arguments": "{\"prompt\":\"编辑\"}" }, "provider_data": { "functionCall": { "name": "edit_image", "args": { "prompt": "编辑" } }, "thoughtSignature": "signature" } }] }),
        json!({ "role": "tool", "tool_call_id": "call1", "content": "完成" }),
        json!({ "role": "user", "content": "这是结果图" }),
    ]);
    let body = native::build_chat_body(&req, false).unwrap();
    assert_eq!(
        body["contents"][0]["parts"][1]["inlineData"]["mimeType"],
        "image/png"
    );
    assert_eq!(
        body["contents"][1]["parts"][0]["thoughtSignature"],
        "signature"
    );
    assert_eq!(
        body["contents"][2]["parts"][0]["functionResponse"]["name"],
        "edit_image"
    );
    assert_eq!(body["contents"][2]["parts"][1]["text"], "这是结果图");
    req.protocol = Some("anthropic".into());
    let body = native::build_chat_body(&req, false).unwrap();
    assert_eq!(body["messages"][1]["content"][0]["type"], "tool_use");
    assert_eq!(body["messages"][2]["content"][0]["tool_use_id"], "call1");
    assert_eq!(body["messages"][2]["content"][1]["text"], "这是结果图");
}

#[test]
fn native_reply_parsing_preserves_calls_and_reasoning() {
    let reply = native::parse_reply(&json!({ "content": [
        { "type": "thinking", "thinking": "检查素材" }, { "type": "text", "text": "现在编辑" },
        { "type": "tool_use", "id": "call", "name": "edit_image", "input": { "prompt": "改色", "source_image_ids": ["b", "a"] } }
    ] }), "anthropic").unwrap();
    assert_eq!(reply.content, "现在编辑");
    assert_eq!(reply.reasoning, "检查素材");
    assert_eq!(
        serde_json::from_str::<Value>(&reply.calls[0].arguments).unwrap()["source_image_ids"],
        json!(["b", "a"])
    );
    let reply = native::parse_reply(&json!({ "candidates": [{ "content": { "parts": [{ "functionCall": { "name": "edit_image", "args": { "prompt": "组合" } }, "thoughtSignature": "signature" }] } }] }), "gemini").unwrap();
    assert_eq!(
        reply.calls[0].provider_data.as_ref().unwrap()["thoughtSignature"],
        "signature"
    );
    assert!(native::parse_reply(&json!({ "error": { "message": "拒绝" } }), "gemini").is_err());
}

#[test]
fn gemini_images_preserve_material_order_and_decode_mime() {
    let req = image();
    let body = native::build_image_body(&req).unwrap();
    assert_eq!(body["contents"][0]["parts"][1]["text"], "人物");
    assert_eq!(
        body["contents"][0]["parts"][2]["inlineData"]["data"],
        "YQ=="
    );
    assert_eq!(body["contents"][0]["parts"][3]["text"], "背景");
    assert_eq!(
        body["generationConfig"]["responseModalities"],
        json!(["TEXT", "IMAGE"])
    );
    assert_eq!(
        body["generationConfig"]["imageConfig"]["aspectRatio"],
        "3:2"
    );
    let out = native::parse_images(&json!({ "candidates": [{ "content": { "parts": [
        { "inlineData": { "mimeType": "image/jpeg", "data": "YQ==" } },
        { "inline_data": { "mime_type": "image/webp", "data": "Yg==" } }
    ] } }] }))
    .unwrap();
    assert_eq!(out[0].ext, "jpg");
    assert_eq!(out[0].bytes, b"a");
    assert_eq!(out[1].ext, "webp");
    let mut masked = req;
    masked.mask = Some("mask".into());
    assert!(native::build_image_body(&masked).is_err());
}

#[test]
fn gemini_urls_and_image_order_labels() {
    assert_eq!(
        native::gemini_url("https://example.test", "models/test-model", true).unwrap(),
        "https://example.test/v1beta/models/test-model:streamGenerateContent?alt=sse"
    );
    assert_eq!(
        native::gemini_url("https://example.test/v1beta", "test-model", false).unwrap(),
        "https://example.test/v1beta/models/test-model:generateContent"
    );
    assert!(native::gemini_url("https://example.test", "test?key=secret", false).is_err());
    let prompt = native::ordered_image_prompt(&image());
    assert!(prompt.find("image_1").unwrap() < prompt.find("image_2").unwrap());
}

fn read_request(socket: &mut TcpStream) -> String {
    socket
        .set_read_timeout(Some(std::time::Duration::from_secs(3)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        let n = socket.read(&mut chunk).unwrap();
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..n]);
        if let Some(pos) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&bytes[..pos]);
            let length = headers
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length:")
                        .map(|s| s.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            if bytes.len() >= pos + 4 + length {
                break;
            }
        }
    }
    String::from_utf8(bytes).unwrap()
}

fn server(
    content_type: &'static str,
    body: String,
    split_utf8: bool,
) -> (String, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let request = read_request(&mut socket);
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).unwrap();
        let split = if split_utf8 {
            body.find('中').unwrap() + 1
        } else {
            body.len()
        };
        socket.write_all(&body.as_bytes()[..split]).unwrap();
        socket.flush().unwrap();
        if split_utf8 {
            std::thread::sleep(std::time::Duration::from_millis(30));
            socket.write_all(&body.as_bytes()[split..]).unwrap();
        }
        request
    });
    (url, handle)
}

fn channel() -> (tauri::ipc::Channel<ChatEvent>, Arc<Mutex<Vec<ChatEvent>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    (
        tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                sink.lock().unwrap().push(serde_json::from_str(&text)?);
            }
            Ok(())
        }),
        events,
    )
}

#[tokio::test]
async fn anthropic_sse_uses_native_headers_and_accumulates_tools() {
    let sse = [
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "中文回复" } }),
        json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "tool_use", "id": "c1", "name": "edit_image", "input": {} } }),
        json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{\"prompt\":" } }),
        json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "\"编辑\"}" } }),
        json!({ "type": "message_stop" }),
    ].iter().map(|v| format!("data: {v}\n\n")).collect::<String>();
    let (base, handle) = server("text/event-stream", sse, true);
    let mut req = chat("anthropic");
    req.base_url = base;
    let (channel, events) = channel();
    ai::chat_stream(req, channel, Arc::new(AtomicBool::new(false)))
        .await
        .unwrap();
    let request = handle.join().unwrap().to_lowercase();
    assert!(request.starts_with("post /v1/messages "));
    assert!(request.contains("x-api-key: test-key"));
    assert!(request.contains("anthropic-version: 2023-06-01"));
    assert!(!request.contains("authorization:"));
    let events = events.lock().unwrap();
    assert!(matches!(&events[0], ChatEvent::Delta { text } if text == "中文回复"));
    assert!(events.iter().any(|e| matches!(e, ChatEvent::ToolCalls { calls } if calls[0].arguments == "{\"prompt\":\"编辑\"}")));
    assert!(matches!(events.last(), Some(ChatEvent::Done { .. })));
}

#[tokio::test]
async fn gemini_sse_and_openai_json_fallback_return_tools() {
    let body = format!(
        "data: {}\n\n",
        json!({ "candidates": [{ "content": { "parts": [{ "text": "中文" }, { "functionCall": { "name": "edit_image", "args": { "prompt": "改色" } }, "thoughtSignature": "s" }] } }] })
    );
    let (base, handle) = server("text/event-stream", body, true);
    let mut req = chat("gemini");
    req.base_url = base;
    let (output, events) = channel();
    ai::chat_stream(req, output, Arc::new(AtomicBool::new(false)))
        .await
        .unwrap();
    let request = handle.join().unwrap();
    assert!(request.starts_with("POST /v1beta/models/test-model:streamGenerateContent?alt=sse "));
    assert!(request.contains("x-goog-api-key: test-key"));
    assert!(events.lock().unwrap().iter().any(|event| matches!(event, ChatEvent::ToolCalls { calls } if calls[0].provider_data.as_ref().unwrap()["thoughtSignature"] == "s")));
    let body = json!({ "choices": [{ "message": { "content": "完整回复", "tool_calls": [{ "id": "c", "function": { "name": "edit_image", "arguments": "{}" } }] } }] }).to_string();
    let (base, handle) = server("application/json", body, false);
    let mut req = chat("openai");
    req.base_url = base;
    req.stream = Some(false);
    let (output, events) = channel();
    ai::chat_stream(req, output, Arc::new(AtomicBool::new(false)))
        .await
        .unwrap();
    assert!(handle
        .join()
        .unwrap()
        .contains("authorization: Bearer test-key"));
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|event| matches!(event, ChatEvent::ToolCalls { .. })));
}

#[tokio::test]
async fn openai_stream_preserves_utf8_across_network_chunks() {
    let sse = format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({ "choices": [{ "delta": { "content": "中文图片" } }] })
    );
    let (base, handle) = server("text/event-stream", sse, true);
    let mut req = chat("openai");
    req.base_url = base;
    let (output, events) = channel();
    ai::chat_stream(req, output, Arc::new(AtomicBool::new(false)))
        .await
        .unwrap();
    handle.join().unwrap();
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|event| matches!(event, ChatEvent::Delta { text } if text == "中文图片")));
}

#[tokio::test]
async fn multipart_edits_send_every_image_with_one_based_labels() {
    let (base, handle) = server(
        "application/json",
        json!({ "data": [{ "b64_json": "YQ==" }] }).to_string(),
        false,
    );
    let mut req = image();
    req.base_url = base;
    req.api_mode = Some("images".into());
    let images = ai::run_image_request(&req).await.unwrap();
    assert_eq!(images.len(), 1);
    let request = handle.join().unwrap();
    assert!(request.starts_with("POST /v1/images/edits "));
    assert_eq!(request.matches("name=\"image[]\"").count(), 2);
    assert!(request.find("image_1.png").unwrap() < request.find("image_2.jpg").unwrap());
    assert!(request.contains("输入图片 1（image_1）：人物"));
}

#[tokio::test]
async fn empty_native_stream_falls_back_once_without_losing_tools() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for i in 0..2 {
            let (mut socket, _) = listener.accept().unwrap();
            requests.push(read_request(&mut socket));
            let body = if i == 0 {
                String::new()
            } else {
                json!({ "candidates": [{ "content": { "parts": [{ "functionCall": { "name": "edit_image", "args": { "prompt": "组合" } }, "thoughtSignature": "signature" }] } }] }).to_string()
            };
            let content_type = if i == 0 {
                "text/event-stream"
            } else {
                "application/json"
            };
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
        }
        requests
    });
    let mut req = chat("gemini");
    req.base_url = base;
    let (output, events) = channel();
    ai::chat_stream(req, output, Arc::new(AtomicBool::new(false)))
        .await
        .unwrap();
    let requests = handle.join().unwrap();
    assert!(requests[0].contains(":streamGenerateContent?alt=sse"));
    assert!(requests[1].contains(":generateContent "));
    assert!(events.lock().unwrap().iter().any(
        |event| matches!(event, ChatEvent::ToolCalls { calls } if calls[0].name == "edit_image")
    ));
}

#[tokio::test]
async fn pending_request_can_be_canceled_before_headers_arrive() {
    use std::sync::atomic::Ordering;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        read_request(&mut socket);
        let mut byte = [0u8; 1];
        let _ = socket.read(&mut byte); // 客户端取消后连接关闭。
    });
    let mut req = chat("anthropic");
    req.base_url = base;
    let flag = Arc::new(AtomicBool::new(false));
    let cancel = flag.clone();
    let (output, _) = channel();
    let (result, _) = tokio::join!(
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            ai::chat_stream(req, output, flag)
        ),
        async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            cancel.store(true, Ordering::Relaxed);
        }
    );
    result.expect("取消没有及时终止请求").unwrap();
    handle.join().unwrap();
}

#[tokio::test]
async fn gateway_ignoring_stream_flag_preserves_json_tool_calls() {
    let body = json!({ "choices": [{ "message": { "content": "准备编辑", "tool_calls": [{ "id": "c", "function": { "name": "edit_image", "arguments": "{}" } }] } }] }).to_string();
    let (base, handle) = server("application/json", body, false);
    let mut req = chat("openai");
    req.base_url = base;
    req.stream = Some(true);
    let (output, events) = channel();
    ai::chat_stream(req, output, Arc::new(AtomicBool::new(false)))
        .await
        .unwrap();
    handle.join().unwrap();
    assert!(events.lock().unwrap().iter().any(
        |event| matches!(event, ChatEvent::ToolCalls { calls } if calls[0].name == "edit_image")
    ));
}
