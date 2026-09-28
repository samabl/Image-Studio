//! 真实网关联调测试：直接打你的 OpenAI 兼容端点，验证 Rust 侧的协议实现是否真的能跑通。
//!
//! 未设置 `GIS_TEST_BASE` / `GIS_TEST_KEY` 时所有联网用例会自动跳过，
//! 所以 `cargo test` 在没配置的环境里也是安全的。
//!
//! 运行方式（PowerShell）：
//! ```powershell
//! $env:GIS_TEST_BASE         = "http://10.213.196.114:3000"
//! $env:GIS_TEST_KEY          = "sk-..."
//! $env:GIS_TEST_CHAT_MODEL   = "gpt-5.6-luna"
//! $env:GIS_TEST_IMAGE_MODEL  = "gpt-image-2"
//! cargo test --test live_gateway -- --nocapture --test-threads=1
//! ```

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

// ---------------------------------------------------------------------------

/// 纯本地用例：Base URL 三种写法都要被正确正规化（不联网，永远运行）。
#[test]
fn url_normalization() {
    let cases = [
        ("http://h:3000", "http://h:3000/v1/chat/completions"),
        ("http://h:3000/", "http://h:3000/v1/chat/completions"),
        ("http://h:3000/v1", "http://h:3000/v1/chat/completions"),
        ("http://h:3000/v1/", "http://h:3000/v1/chat/completions"),
        (
            "http://h:3000/v1/chat/completions",
            "http://h:3000/v1/chat/completions",
        ),
        ("https://api.example.com", "https://api.example.com/v1/chat/completions"),
    ];
    for (input, expect) in cases {
        let got = ai::build_url(input, "/chat/completions").expect("应当解析成功");
        assert_eq!(got, expect, "输入 {input}");
    }

    // 图像端点同样规则
    assert_eq!(
        ai::build_url("http://h:3000", "/images/generations").unwrap(),
        "http://h:3000/v1/images/generations"
    );
    assert_eq!(
        ai::build_url("http://h:3000/v1", "/images/edits").unwrap(),
        "http://h:3000/v1/images/edits"
    );

    // 非法输入要报错而不是拼出奇怪的 URL
    assert!(ai::build_url("", "/models").is_err());
    assert!(ai::build_url("h:3000", "/models").is_err());
}

/// data URL 解析：含空白的 base64、非图片 MIME 都要能正确处理。
#[test]
fn data_url_parsing() {
    // 1x1 透明 PNG
    const PNG_1PX: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk\
YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    let url = format!("data:image/png;base64,{PNG_1PX}");
    let (mime, bytes) = ai::parse_data_url(&url).expect("应当解析成功");
    assert_eq!(mime, "image/png");
    assert_eq!(&bytes[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);

    // 带换行/空格的 base64 也要能解
    let messy = format!("data:image/jpeg;base64,{}\n", PNG_1PX);
    assert!(ai::parse_data_url(&messy).is_ok());

    // 非 data URL 要报错
    assert!(ai::parse_data_url("http://x/y.png").is_err());
    assert!(ai::parse_data_url("data:image/png,notbase64").is_err());
}

#[tokio::test]
async fn list_models() {
    let cfg = cfg_or_skip!();
    let models = ai::list_models(&cfg.base, &cfg.key).await.expect("拉取模型列表失败");
    assert!(!models.is_empty(), "模型列表为空");
    println!("拿到 {} 个模型", models.len());
    for m in models.iter().take(50) {
        println!("  - {m}");
    }
}

#[tokio::test]
async fn chat_once_roundtrip() {
    let cfg = cfg_or_skip!();
    let text = ai::chat_once(chat_req(&cfg, "只回复两个字：可用"))
        .await
        .expect("非流式对话失败");
    println!("模型回答：{text}");
    assert!(!text.trim().is_empty());
}

#[tokio::test]
async fn chat_stream_roundtrip() {
    use std::sync::{Arc, Mutex};
    use std::sync::atomic::AtomicBool;

    let cfg = cfg_or_skip!();

    let collected = Arc::new(Mutex::new(String::new()));
    let sink = collected.clone();

    // Channel 在没有 Tauri App 的情况下也能构造，直接把事件收进 Vec 里
    let channel = tauri::ipc::Channel::new(move |body| {
        let tauri::ipc::InvokeResponseBody::Json(s) = body else {
            return Ok(());
        };
        let ev: ChatEvent = serde_json::from_str(&s)?;
        match ev {
            ChatEvent::Delta { text } => sink.lock().unwrap().push_str(&text),
            ChatEvent::Error { message } => panic!("流式返回错误：{message}"),
            _ => {}
        }
        Ok(())
    });

    let mut req = chat_req(&cfg, "从 1 数到 5，用顿号分隔");
    req.max_tokens = Some(64);
    ai::chat_stream(req, channel, Arc::new(AtomicBool::new(false)))
        .await
        .expect("流式对话失败");

    let out = collected.lock().unwrap().clone();
    println!("流式拼接结果：{out}");
    assert!(!out.trim().is_empty(), "没有收到任何增量内容");
}

#[tokio::test]
async fn tool_calling_roundtrip() {
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};

    let cfg = cfg_or_skip!();

    let calls: Arc<Mutex<Vec<ai::ToolCall>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = calls.clone();

    let channel = tauri::ipc::Channel::new(move |body| {
        let tauri::ipc::InvokeResponseBody::Json(s) = body else {
            return Ok(());
        };
        let ev: ChatEvent = serde_json::from_str(&s)?;
        if let ChatEvent::ToolCalls { calls } = ev {
            sink.lock().unwrap().extend(calls);
        }
        Ok(())
    });

    let tools = vec![serde_json::json!({
        "type": "function",
        "function": {
            "name": "generate_image",
            "description": "Generate an image from a prompt",
            "parameters": {
                "type": "object",
                "properties": { "prompt": { "type": "string" } },
                "required": ["prompt"]
            }
        }
    })];

    let mut req = chat_req(&cfg, "帮我画一只在阳光下打盹的橘猫，请调用 generate_image 工具");
    req.tools = Some(tools);
    req.max_tokens = Some(300);

    ai::chat_stream(req, channel, Arc::new(AtomicBool::new(false)))
        .await
        .expect("流式工具调用失败");

    let got = calls.lock().unwrap().clone();
    assert!(
        !got.is_empty(),
        "模型没有返回 tool_calls —— 对话驱动出图依赖这条链路，必须跑通"
    );
    for c in &got {
        println!("tool_call -> name={} args={}", c.name, c.arguments);
        assert_eq!(c.name, "generate_image");
        // 参数必须是完整可解析的 JSON：流式分片累积逻辑对不对，全看这里
        let parsed: serde_json::Value =
            serde_json::from_str(&c.arguments).expect("tool_call 参数不是合法 JSON，分片累积有 bug");
        assert!(
            parsed
                .get("prompt")
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.is_empty()),
            "tool_call 缺少 prompt 参数"
        );
    }
}

/// 兼容性兜底：故意发一个模型不支持的参数，请求应当自动降级并成功。
#[tokio::test]
async fn unsupported_parameter_is_retried() {
    let cfg = cfg_or_skip!();
    let mut req = chat_req(&cfg, "只回复两个字：可用");
    req.temperature = Some(0.99); // gpt-5.6 系列会因此返回 400

    let text = ai::chat_once(req)
        .await
        .expect("自动降级重试后仍然失败，说明兜底逻辑没生效");
    println!("降级重试后成功：{text}");
    assert!(!text.trim().is_empty());
}

/// 纯本地：错误文案解析（不联网）。
#[test]
fn unsupported_param_detection() {
    use ai::unsupported_param;
    assert_eq!(
        unsupported_param(r#"{"error":{"message":"Unsupported parameter: 'temperature' is not supported with this model."}}"#)
            .as_deref(),
        Some("temperature")
    );
    assert_eq!(
        unsupported_param(r#"Unknown parameter: "top_p""#).as_deref(),
        Some("top_p")
    );
    assert_eq!(
        unsupported_param("Unrecognized request argument supplied: max_tokens").as_deref(),
        Some("max_tokens")
    );
    assert_eq!(unsupported_param("model not found"), None);
    assert_eq!(unsupported_param(""), None);
}

/// 全链路：文生图 -> 把结果丢回给 /images/edits 做图生图 -> 再走一次蒙版编辑。
#[tokio::test]
async fn image_pipeline() {
    let cfg = cfg_or_skip!();

    let gen_req = ImageRequest {
        base_url: cfg.base.clone(),
        api_key: cfg.key.clone(),
        model: cfg.image_model.clone(),
        api_mode: Some("images".into()),
        prompt: "a single red apple on a plain white background, studio photo".into(),
        images: vec![],
        mask: None,
        n: Some(1),
        size: Some("1024x1024".into()),
        quality: Some("auto".into()),
        background: Some("auto".into()),
        output_format: Some("auto".into()),
        extra_body: None,
        timeout_secs: Some(600),
    };

    let generated = ai::run_image_request(&gen_req).await.expect("文生图失败");
    assert_eq!(generated.len(), 1);
    let first = &generated[0];
    println!(
        "文生图 OK：{} bytes, mime={}, 尺寸头={:?}",
        first.bytes.len(),
        first.mime,
        &first.bytes[..8]
    );
    assert!(first.bytes.len() > 1024, "返回的图像太小，可能不是真图");

    // 把生成的图作为参考图，走图生图
    let source = ai::to_data_url(&first.mime, &first.bytes);
    let edit_req = ImageRequest {
        base_url: cfg.base.clone(),
        api_key: cfg.key.clone(),
        model: cfg.image_model.clone(),
        api_mode: Some("images".into()),
        prompt: "change the apple to a green pear, keep everything else the same".into(),
        images: vec![source.clone()],
        mask: None,
        n: Some(1),
        size: Some("1024x1024".into()),
        quality: Some("auto".into()),
        background: Some("auto".into()),
        output_format: Some("auto".into()),
        extra_body: None,
        timeout_secs: Some(600),
    };

    let edited = ai::run_image_request(&edit_req).await.expect("图生图失败");
    assert_eq!(edited.len(), 1);
    println!("图生图 OK：{} bytes", edited[0].bytes.len());
    assert_ne!(
        edited[0].bytes, first.bytes,
        "编辑后的图片与原图完全相同，编辑可能没有生效"
    );

    // ---- 蒙版局部重绘：只有涂抹区域（alpha=0）允许被改动 ----
    // 用居中一个透明圆盘当蒙版，其余区域保持不透明黑。
    let mask_png = make_png(1024, 1024, |x, y| {
        let dx = x as i64 - 512;
        let dy = y as i64 - 512;
        if dx * dx + dy * dy < 260 * 260 {
            0
        } else {
            255
        }
    });
    let mask_data_url = ai::to_data_url("image/png", &mask_png);

    let masked_req = ImageRequest {
        base_url: cfg.base.clone(),
        api_key: cfg.key.clone(),
        model: cfg.image_model.clone(),
        api_mode: Some("images".into()),
        prompt: "a glowing golden coin".into(),
        images: vec![source],
        mask: Some(mask_data_url),
        n: Some(1),
        size: Some("1024x1024".into()),
        quality: Some("auto".into()),
        background: Some("auto".into()),
        output_format: Some("auto".into()),
        extra_body: None,
        timeout_secs: Some(600),
    };

    let masked = ai::run_image_request(&masked_req).await.expect("蒙版局部重绘失败");
    assert_eq!(masked.len(), 1);
    println!("蒙版重绘 OK：{} bytes", masked[0].bytes.len());
    assert!(masked[0].bytes.len() > 1024);
}

// ---------------------------------------------------------------------------
// 手工构造 PNG，用于蒙版测试（不为测试引入图像编解码库）
// ---------------------------------------------------------------------------

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

/// 生成 w×h 的 8bit RGBA PNG，`alpha(x, y)` 给出每个像素的 alpha 值。
fn make_png<F: Fn(u32, u32) -> u8>(w: u32, h: u32, alpha: F) -> Vec<u8> {
    use std::io::Write;

    let mut raw = Vec::with_capacity(((w * 4 + 1) * h) as usize);
    for y in 0..h {
        raw.push(0); // filter type: None
        for x in 0..w {
            raw.extend_from_slice(&[0, 0, 0, alpha(x, y)]);
        }
    }
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    enc.write_all(&raw).expect("压缩失败");
    let compressed = enc.finish().expect("压缩收尾失败");

    let mut out = Vec::new();
    out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);

    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 位深 8、颜色类型 6 = RGBA
    png_chunk(&mut out, b"IHDR", &ihdr);
    png_chunk(&mut out, b"IDAT", &compressed);
    png_chunk(&mut out, b"IEND", &[]);
    out
}

/// 本地用例：构造出来的蒙版必须是结构合法的 PNG（不联网）。
#[test]
fn mask_png_is_valid() {
    let png = make_png(64, 64, |x, y| {
        let dx = x as i64 - 32;
        let dy = y as i64 - 32;
        if dx * dx + dy * dy < 400 {
            0
        } else {
            255
        }
    });
    assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
    assert_eq!(&png[12..16], b"IHDR");
    assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 64);
    assert_eq!(u32::from_be_bytes(png[20..24].try_into().unwrap()), 64);
    assert_eq!(png[24], 8, "位深应为 8");
    assert_eq!(png[25], 6, "颜色类型应为 RGBA");
    assert!(png.len() > 100);
}
