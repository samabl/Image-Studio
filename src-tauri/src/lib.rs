// 模块对外可见，便于 `tests/live_gateway.rs` 直接对真实网关做联调测试
pub mod ai;
pub mod config;
pub mod error;
pub mod gallery;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use ai::{ChatEvent, ChatRequest, ImageRequest};
use config::AppConfig;
use error::AppResult;
use gallery::{GalleryItem, GalleryLock, SaveMeta};

/// 流式对话的取消标志表，key 为前端生成的 streamId。
#[derive(Default)]
pub struct Streams(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_config(app: AppHandle) -> AppResult<AppConfig> {
    config::load_config(&app)
}

#[tauri::command]
fn save_config(app: AppHandle, config: AppConfig) -> AppResult<AppConfig> {
    config::save_config(&app, &config)?;
    Ok(config)
}

#[tauri::command]
fn reset_config(app: AppHandle) -> AppResult<AppConfig> {
    let cfg = AppConfig::default();
    config::save_config(&app, &cfg)?;
    Ok(cfg)
}

/// 应用数据目录，前端用来告诉用户文件究竟存在哪。
#[tauri::command]
fn data_dir(app: AppHandle) -> AppResult<String> {
    Ok(config::app_root(&app)?.to_string_lossy().to_string())
}

/// 通用键值状态存取（对话历史、工作室草稿等）。
/// 放在应用数据目录而不是 localStorage，一是容量不受限，二是 Android 上同样可靠。
#[tauri::command]
fn load_state(app: AppHandle, key: String) -> AppResult<Option<String>> {
    let path = state_path(&app, &key)?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(std::fs::read_to_string(path)?))
}

#[tauri::command]
fn save_state(app: AppHandle, key: String, value: String) -> AppResult<()> {
    let path = state_path(&app, &key)?;
    if let Some(parent) = path.parent() {
        config::ensure_dir(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, value)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn state_path(app: &AppHandle, key: &str) -> AppResult<std::path::PathBuf> {
    let safe: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if safe.is_empty() {
        return Err(error::AppError::other("非法的状态键名"));
    }
    Ok(config::app_root(app)?.join("state").join(format!("{safe}.json")))
}

// ---------------------------------------------------------------------------
// 模型列表
// ---------------------------------------------------------------------------

/// 拉取 `/v1/models`。传入的 baseUrl/apiKey 允许是「还没保存」的临时值，方便配置页先测后存。
#[tauri::command]
async fn list_models(base_url: String, api_key: String) -> AppResult<Vec<String>> {
    ai::list_models(&base_url, &api_key).await
}

// ---------------------------------------------------------------------------
// 对话
// ---------------------------------------------------------------------------

#[tauri::command]
async fn chat_stream(
    streams: State<'_, Streams>,
    stream_id: String,
    request: ChatRequest,
    on_event: Channel<ChatEvent>,
) -> AppResult<()> {
    let flag = Arc::new(AtomicBool::new(false));
    streams
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(stream_id.clone(), flag.clone());

    let result = ai::chat_stream(request, on_event, flag).await;

    streams
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&stream_id);

    result
}

/// 主动中断某个流式回答。Rust 侧下一轮循环就会退出，及时止住 token 消耗。
#[tauri::command]
fn chat_cancel(streams: State<'_, Streams>, stream_id: String) {
    if let Some(flag) = streams
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&stream_id)
    {
        flag.store(true, Ordering::Relaxed);
    }
}

/// 非流式对话：用于提示词优化、图像反推等内部调用。
#[tauri::command]
async fn chat_once(request: ChatRequest) -> AppResult<String> {
    ai::chat_once(request).await
}

// ---------------------------------------------------------------------------
// 图像
// ---------------------------------------------------------------------------

#[tauri::command]
async fn generate_image(
    app: AppHandle,
    lock: State<'_, GalleryLock>,
    request: ImageRequest,
    parent_id: Option<String>,
) -> AppResult<Vec<GalleryItem>> {
    let kind = if request.images.is_empty() {
        "generate"
    } else if request.mask.as_ref().is_some_and(|m| !m.trim().is_empty()) {
        "mask"
    } else {
        "edit"
    };

    let meta = SaveMeta {
        kind: kind.to_string(),
        prompt: request.prompt.clone(),
        model: request.model.clone(),
        size: request
            .size
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "auto".into()),
        parent_id,
    };

    let images = ai::run_image_request(&request).await?;
    gallery::save_images(&app, &lock, &meta, images)
}

// ---------------------------------------------------------------------------
// 图库
// ---------------------------------------------------------------------------

#[tauri::command]
fn gallery_list(app: AppHandle) -> Vec<GalleryItem> {
    gallery::list(&app)
}

#[tauri::command]
fn gallery_delete(
    app: AppHandle,
    lock: State<'_, GalleryLock>,
    ids: Vec<String>,
) -> AppResult<usize> {
    gallery::delete(&app, &lock, &ids)
}

#[tauri::command]
fn gallery_clear(app: AppHandle, lock: State<'_, GalleryLock>) -> AppResult<usize> {
    gallery::clear(&app, &lock)
}

#[tauri::command]
fn gallery_export(app: AppHandle, id: String, target: String) -> AppResult<String> {
    gallery::export(&app, &id, &target)
}

/// asset 协议加载失败时的兜底通道。
#[tauri::command]
fn read_image_data_url(path: String) -> AppResult<String> {
    gallery::read_as_data_url(&path)
}

/// 保存任意 data URL 到磁盘并登记进图库（用于把对话里产生的图片归档）。
#[tauri::command]
fn save_data_url(
    app: AppHandle,
    lock: State<'_, GalleryLock>,
    data_url: String,
    meta: SaveMeta,
) -> AppResult<Vec<GalleryItem>> {
    let (mime, bytes) = ai::parse_data_url(&data_url)?;
    let ext = match mime.as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        _ => "png",
    };
    let raw = ai::RawImage {
        bytes,
        mime,
        ext: ext.to_string(),
        revised_prompt: None,
        source_url: None,
    };
    gallery::save_images(&app, &lock, &meta, vec![raw])
}

/// 读取本地图片文件为 data URL（拖拽导入 / 文件选择器导入用）。
#[tauri::command]
fn import_image_file(path: String) -> AppResult<String> {
    gallery::read_as_data_url(&path)
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    // 桌面端：第二次启动时不再开新进程，而是把已有窗口叫到前面。
    // 没有这层保护的话，两个实例会同时读写 config.json / sessions.json，互相覆盖。
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    builder
        .manage(GalleryLock::default())
        .manage(Streams::default())
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            reset_config,
            data_dir,
            load_state,
            save_state,
            list_models,
            chat_stream,
            chat_cancel,
            chat_once,
            generate_image,
            gallery_list,
            gallery_delete,
            gallery_clear,
            gallery_export,
            read_image_data_url,
            save_data_url,
            import_image_file,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
