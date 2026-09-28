use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::ai::{to_data_url, RawImage};
use crate::config::{app_root, ensure_dir};
use crate::error::{AppError, AppResult};

/// 图库索引的读写锁：并发生成多张图时避免 index.json 互相覆盖。
#[derive(Default)]
pub struct GalleryLock(pub Mutex<()>);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryItem {
    pub id: String,
    pub file_name: String,
    /// 绝对路径，前端用 convertFileSrc 加载
    pub path: String,
    /// generate | edit | chat
    pub kind: String,
    pub prompt: String,
    pub model: String,
    pub size: String,
    pub created_at: i64,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub revised_prompt: Option<String>,
    /// 仅新生成时回填，供前端立即显示；历史列表里为 None
    #[serde(default)]
    pub data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMeta {
    pub kind: String,
    pub prompt: String,
    pub model: String,
    pub size: String,
    #[serde(default)]
    pub parent_id: Option<String>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn gallery_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app_root(app)?.join("gallery"))
}

fn images_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(gallery_dir(app)?.join("images"))
}

fn index_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(gallery_dir(app)?.join("index.json"))
}

fn read_index(app: &AppHandle) -> Vec<GalleryItem> {
    let Ok(path) = index_path(app) else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<GalleryItem>>(&raw).unwrap_or_default()
}

fn write_index(app: &AppHandle, items: &[GalleryItem]) -> AppResult<()> {
    let dir = gallery_dir(app)?;
    ensure_dir(&dir)?;
    let path = index_path(app)?;
    let data = serde_json::to_string_pretty(items)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// 落盘保存一组图像，并写入索引。返回带 dataUrl 的完整条目。
pub fn save_images(
    app: &AppHandle,
    lock: &GalleryLock,
    meta: &SaveMeta,
    images: Vec<RawImage>,
) -> AppResult<Vec<GalleryItem>> {
    let dir = images_dir(app)?;
    ensure_dir(&dir)?;

    let mut created = Vec::with_capacity(images.len());

    for img in images {
        let id = format!("{}_{}", now_ms(), uuid::Uuid::new_v4().simple());
        let file_name = format!("{id}.{}", img.ext);
        let path = dir.join(&file_name);
        fs::write(&path, &img.bytes)?;

        created.push(GalleryItem {
            id,
            file_name,
            path: path.to_string_lossy().to_string(),
            kind: meta.kind.clone(),
            prompt: meta.prompt.clone(),
            model: meta.model.clone(),
            size: format!("{}x{}", meta.size, 0), // 占位，稍后用真实尺寸覆盖
            created_at: now_ms(),
            parent_id: meta.parent_id.clone(),
            revised_prompt: img.revised_prompt.clone(),
            data_url: Some(to_data_url(&img.mime, &img.bytes)),
        });
    }

    // 尺寸从 PNG/JPEG 头部读出来，避免为了元数据引入 image 解码库
    for item in &mut created {
        if let Some((w, h)) = read_dimensions(&item.path) {
            item.size = format!("{w}x{h}");
        } else {
            item.size = meta.size.clone();
        }
    }

    let _guard = lock.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut index = read_index(app);
    index.splice(0..0, created.iter().cloned());
    // 索引里的条目不需要常驻 dataUrl，避免文件膨胀
    let slim: Vec<GalleryItem> = index
        .into_iter()
        .map(|mut i| {
            i.data_url = None;
            i
        })
        .collect();
    write_index(app, &slim)?;

    Ok(created)
}

pub fn list(app: &AppHandle) -> Vec<GalleryItem> {
    let mut items = read_index(app);
    items.retain(|i| std::path::Path::new(&i.path).exists());
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    items
}

pub fn delete(app: &AppHandle, lock: &GalleryLock, ids: &[String]) -> AppResult<usize> {
    let _guard = lock.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut index = read_index(app);
    let mut removed = 0usize;
    index.retain(|item| {
        if ids.contains(&item.id) {
            let _ = fs::remove_file(&item.path);
            removed += 1;
            false
        } else {
            true
        }
    });
    write_index(app, &index)?;
    Ok(removed)
}

pub fn clear(app: &AppHandle, lock: &GalleryLock) -> AppResult<usize> {
    let _guard = lock.0.lock().unwrap_or_else(|e| e.into_inner());
    let index = read_index(app);
    let count = index.len();
    for item in &index {
        let _ = fs::remove_file(&item.path);
    }
    write_index(app, &[])?;
    Ok(count)
}

/// 把图库里的图片导出到用户选定路径。
pub fn export(app: &AppHandle, id: &str, target: &str) -> AppResult<String> {
    let index = read_index(app);
    let item = index
        .iter()
        .find(|i| i.id == id)
        .ok_or_else(|| AppError::other("图库中找不到该图片"))?;
    let src = PathBuf::from(&item.path);
    if !src.exists() {
        return Err(AppError::other("源文件已不存在"));
    }
    let mut dst = PathBuf::from(target);
    if dst.is_dir() {
        dst = dst.join(&item.file_name);
    }
    if let Some(parent) = dst.parent() {
        ensure_dir(parent)?;
    }
    fs::copy(&src, &dst)?;
    Ok(dst.to_string_lossy().to_string())
}

/// 兜底方案：把磁盘图片读成 data URL（asset 协议不可用时前端会走这里）。
pub fn read_as_data_url(path: &str) -> AppResult<String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err(AppError::other("文件不存在"));
    }
    let bytes = fs::read(&p)?;
    let mime = match p
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "image/png",
    };
    Ok(to_data_url(mime, &bytes))
}

/// 从 PNG / JPEG / WEBP 文件头解析宽高，不依赖解码库。
pub fn read_dimensions(path: &str) -> Option<(u32, u32)> {
    let bytes = fs::read(path).ok()?;
    // PNG: 8 字节签名 + IHDR
    if bytes.len() > 24 && bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        return Some((w, h));
    }
    // JPEG: 扫描 SOFn 段
    if bytes.len() > 4 && bytes[0] == 0xFF && bytes[1] == 0xD8 {
        let mut i = 2usize;
        while i + 9 < bytes.len() {
            if bytes[i] != 0xFF {
                i += 1;
                continue;
            }
            let marker = bytes[i + 1];
            if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
                let h = u16::from_be_bytes(bytes[i + 5..i + 7].try_into().ok()?) as u32;
                let w = u16::from_be_bytes(bytes[i + 7..i + 9].try_into().ok()?) as u32;
                return Some((w, h));
            }
            let len = u16::from_be_bytes(bytes[i + 2..i + 4].try_into().ok()?) as usize;
            i += 2 + len;
        }
        return None;
    }
    // WEBP (VP8X)
    if bytes.len() > 30 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        if &bytes[12..16] == b"VP8X" {
            let w = 1 + u32::from_le_bytes([bytes[24], bytes[25], bytes[26], 0]);
            let h = 1 + u32::from_le_bytes([bytes[27], bytes[28], bytes[29], 0]);
            return Some((w, h));
        }
    }
    None
}
