//! 通过 GIS_TEST_* 显式开启的原生协议与多素材联调。
use gpt_image_studio_lib::ai::{self, ChatEvent, ChatRequest, ImageRequest};
struct Cfg {
    base: String,
    key: String,
    chat_model: String,
    image_model: String,
}

impl Cfg {
    fn load() -> Option<Self> {
        let base = std::env::var("GIS_TEST_BASE").ok()?;
        let key = std::env::var("GIS_TEST_KEY").ok()?;
        if base.trim().is_empty() || key.trim().is_empty() {
            return None;
        }
        Some(Self {
            base,
            key,
            chat_model: std::env::var("GIS_TEST_CHAT_MODEL")
                .unwrap_or_else(|_| "gpt-5.6-luna".into()),
            image_model: std::env::var("GIS_TEST_IMAGE_MODEL")
                .unwrap_or_else(|_| "gpt-image-2".into()),
        })
    }
}

macro_rules! cfg_or_skip {
    () => {
        match Cfg::load() {
            Some(c) => c,
            None => {
                eprintln!("跳过：未设置 GIS_TEST_BASE / GIS_TEST_KEY");
                return;
            }
        }
    };
}

fn chat_req(cfg: &Cfg, prompt: &str) -> ChatRequest {
    ChatRequest {
        protocol: None,
        stream: None,
        base_url: cfg.base.clone(),
        api_key: cfg.key.clone(),
        model: cfg.chat_model.clone(),
        messages: vec![serde_json::json!({ "role": "user", "content": prompt })],
        temperature: None,
        max_tokens: Some(120),
        tools: None,
        tool_choice: None,
        extra_body: None,
        timeout_secs: Some(180),
    }
}

fn png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    let mut hasher = crc32fast::Hasher::new();
    hasher.update(&crc_input);
    out.extend_from_slice(&hasher.finalize().to_be_bytes());
}

fn solid_png(color: [u8; 3]) -> String {
    use flate2::{write::ZlibEncoder, Compression};
    use std::io::Write;
    let mut raw = Vec::new();
    for _ in 0..64 {
        raw.push(0);
        for _ in 0..64 {
            raw.extend_from_slice(&[color[0], color[1], color[2], 255]);
        }
    }
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&raw).unwrap();
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut header = Vec::new();
    header.extend_from_slice(&64u32.to_be_bytes());
    header.extend_from_slice(&64u32.to_be_bytes());
    header.extend_from_slice(&[8, 6, 0, 0, 0]);
    png_chunk(&mut png, b"IHDR", &header);
    png_chunk(&mut png, b"IDAT", &encoder.finish().unwrap());
    png_chunk(&mut png, b"IEND", &[]);
    ai::to_data_url("image/png", &png)
}

/// 原生协议使用同一测试网关；显式开启 GIS_TEST_NATIVE=1，避免默认增加调用。
#[tokio::test]
async fn native_protocols_with_images_and_tools() {
    if std::env::var("GIS_TEST_NATIVE").as_deref() != Ok("1") {
        return;
    }
    let cfg = cfg_or_skip!();
    for (protocol, model) in [
        ("anthropic", "claude-opus-4-8"),
        ("gemini", "gemini-3.8-flash"),
    ] {
        let mut req = chat_req(&cfg, "");
        req.protocol = Some(protocol.into());
        req.model = model.into();
        req.max_tokens = Some(1000);
        req.messages = vec![serde_json::json!({ "role": "user", "content": [
            { "type": "text", "text": "素材 1（ID:red）是红色图片，素材 2（ID:blue）是蓝色图片。请调用 edit_image 组合两张图片，source_image_ids 顺序必须是 blue、red。" },
            { "type": "text", "text": "素材 1（ID:red）" }, { "type": "image_url", "image_url": { "url": solid_png([255, 0, 0]) } },
            { "type": "text", "text": "素材 2（ID:blue）" }, { "type": "image_url", "image_url": { "url": solid_png([0, 0, 255]) } }
        ] })];
        req.tools = Some(vec![
            serde_json::json!({ "type": "function", "function": { "name": "edit_image", "description": "合成参考图片", "parameters": {
            "type": "object", "properties": { "prompt": { "type": "string" }, "source_image_ids": { "type": "array", "items": { "type": "string" } } }, "required": ["prompt", "source_image_ids"]
        } } }),
        ]);
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = calls.clone();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(s) = body {
                if let ChatEvent::ToolCalls { calls } = serde_json::from_str(&s)? {
                    sink.lock().unwrap().extend(calls);
                }
            }
            Ok(())
        });
        ai::chat_stream(
            req,
            channel,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .await
        .expect("原生多图工具调用失败");
        let calls = calls.lock().unwrap();
        assert!(!calls.is_empty(), "{protocol} 没有调用工具");
        let args: serde_json::Value = serde_json::from_str(&calls[0].arguments).unwrap();
        assert_eq!(args["source_image_ids"], serde_json::json!(["blue", "red"]));
        println!("{protocol} 原生多图 + 工具调用顺序 OK");
    }
}

#[tokio::test]
async fn multi_image_generation() {
    if std::env::var("GIS_TEST_MULTI_IMAGE").as_deref() != Ok("1") {
        return;
    }
    let cfg = cfg_or_skip!();
    let mode = std::env::var("GIS_TEST_IMAGE_MODE").unwrap_or("images".into());
    let req: ImageRequest = serde_json::from_value(serde_json::json!({
        "baseUrl": cfg.base, "apiKey": cfg.key, "model": cfg.image_model, "apiMode": mode,
        "prompt": "Combine both input images into one minimalist poster: material 1 red on the left, material 2 blue on the right, with a clear dividing line. Keep these two colors.",
        "images": [solid_png([255, 0, 0]), solid_png([0, 0, 255])], "imageLabels": ["素材 1：红色", "素材 2：蓝色"], "n": 1, "size": "1024x1024", "timeoutSecs": 600
    })).unwrap();
    let images = ai::run_image_request(&req).await.expect("多素材出图失败");
    assert!(!images.is_empty());
    assert!(images[0].bytes.len() > 1024);
    println!(
        "{mode} 多素材出图 OK：{} 张，首图 {} bytes",
        images.len(),
        images[0].bytes.len()
    );
}
