use std::fs;
use std::path::{Path, PathBuf};
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

fn outputs_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app_root(app)?.join("outputs").join("images"))
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

/// 过程图落盘以便对话恢复和继续编辑，但不进入用户图库。
pub fn save_outputs(
    app: &AppHandle,
    meta: &SaveMeta,
    images: Vec<RawImage>,
) -> AppResult<Vec<GalleryItem>> {
    store_images(&outputs_dir(app)?, meta, images)
}

/// 校验运行时输出后再落盘；前端限制不能代替原生 IPC 边界的校验。
pub fn parse_code_outputs(data_urls: Vec<String>) -> AppResult<Vec<RawImage>> {
    const MAX_DATA_URL: usize = 90 * 1024 * 1024;
    const MAX_TOTAL_PIXELS: u64 = 48 * 1024 * 1024;
    if data_urls.is_empty() || data_urls.len() > 4 {
        return Err(AppError::other("代码输出必须为 1–4 张图片"));
    }
    if data_urls.iter().any(|url| url.len() > MAX_DATA_URL)
        || data_urls.iter().map(String::len).sum::<usize>() > MAX_DATA_URL * 3
    {
        return Err(AppError::other("代码图像文件过大"));
    }
    let mut total_pixels = 0_u64;
    data_urls
        .into_iter()
        .map(|data_url| {
            let (mime, bytes) = crate::ai::parse_data_url(&data_url)?;
            if mime != "image/png" {
                return Err(AppError::other("代码输出必须为 PNG 图片"));
            }
            let (width, height) = validate_code_png(&bytes)?;
            total_pixels += u64::from(width) * u64::from(height);
            if total_pixels > MAX_TOTAL_PIXELS {
                return Err(AppError::other("代码输出累计超过像素预算"));
            }
            Ok(RawImage {
                bytes,
                mime,
                ext: "png".into(),
                revised_prompt: None,
                source_url: None,
            })
        })
        .collect()
}

/// 检查 PNG 头、尺寸和分块边界；不解压像素，也不把伪造的文件头当作完整图片。
fn validate_code_png(bytes: &[u8]) -> AppResult<(u32, u32)> {
    let invalid = || AppError::other("代码输出不是有效的 PNG 图片");
    if bytes.len() < 45
        || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes[8..12] != 13_u32.to_be_bytes()
        || &bytes[12..16] != b"IHDR"
    {
        return Err(invalid());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().map_err(|_| invalid())?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().map_err(|_| invalid())?);
    if width == 0
        || height == 0
        || width > 4096
        || height > 4096
        || u64::from(width) * u64::from(height) > 16 * 1024 * 1024
    {
        return Err(AppError::other("代码图像边长须为 1–4096"));
    }
    let valid_depth = match bytes[25] {
        0 => matches!(bytes[24], 1 | 2 | 4 | 8 | 16),
        2 | 4 | 6 => matches!(bytes[24], 8 | 16),
        3 => matches!(bytes[24], 1 | 2 | 4 | 8),
        _ => false,
    };
    if !valid_depth || bytes[26] != 0 || bytes[27] != 0 || bytes[28] > 1 {
        return Err(invalid());
    }
    let mut position = 33_usize;
    let mut has_image_data = false;
    while position + 12 <= bytes.len() {
        let length = u32::from_be_bytes(
            bytes[position..position + 4]
                .try_into()
                .map_err(|_| invalid())?,
        ) as usize;
        let end = position
            .checked_add(length)
            .and_then(|end| end.checked_add(12))
            .ok_or_else(invalid)?;
        if end > bytes.len() {
            return Err(invalid());
        }
        match &bytes[position + 4..position + 8] {
            b"IHDR" => return Err(invalid()),
            b"IDAT" => has_image_data |= length > 0,
            b"IEND" => {
                return if length == 0 && has_image_data && end == bytes.len() {
                    Ok((width, height))
                } else {
                    Err(invalid())
                }
            }
            _ => {}
        }
        position = end;
    }
    Err(invalid())
}

fn store_images(dir: &Path, meta: &SaveMeta, images: Vec<RawImage>) -> AppResult<Vec<GalleryItem>> {
    ensure_dir(dir)?;

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
            size: meta.size.clone(),
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

    Ok(created)
}

/// 用户明确保存 data URL 时才写入图库索引。
pub fn save_images(
    app: &AppHandle,
    lock: &GalleryLock,
    meta: &SaveMeta,
    images: Vec<RawImage>,
) -> AppResult<Vec<GalleryItem>> {
    let created = store_images(&images_dir(app)?, meta, images)?;

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

/// 复制用户选中的结果，保留原始过程文件；删图库不会破坏对话里的图片。
pub fn archive(app: &AppHandle, lock: &GalleryLock, item: GalleryItem) -> AppResult<GalleryItem> {
    let _guard = lock.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut index = read_index(app);
    if let Some(existing) = index
        .iter()
        .find(|saved| saved.id == item.id && Path::new(&saved.path).is_file())
    {
        return Ok(existing.clone());
    }
    let source = fs::canonicalize(&item.path)?;
    let saved = archive_into(item, &outputs_dir(app)?, &images_dir(app)?)?;
    let copied = fs::canonicalize(&saved.path)? != source;
    index.retain(|old| old.id != saved.id);
    index.insert(0, saved.clone());
    if let Err(error) = write_index(app, &index) {
        if copied {
            let _ = fs::remove_file(&saved.path);
        }
        return Err(error);
    }
    Ok(saved)
}

fn archive_into(mut item: GalleryItem, outputs: &Path, gallery: &Path) -> AppResult<GalleryItem> {
    if item.id.is_empty()
        || !item
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(AppError::other("图片 ID 无效"));
    }
    let source = fs::canonicalize(&item.path)?;
    // canonicalize 同时排除 .. 和指向应用目录外的符号链接。
    let allowed = [outputs, gallery]
        .iter()
        .filter_map(|dir| fs::canonicalize(dir).ok())
        .any(|root| source.starts_with(root));
    if !allowed || !source.is_file() {
        return Err(AppError::other("只能归档应用中的图像结果"));
    }
    let ext = source
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "webp", "gif", "bmp"].contains(&ext.as_str()) {
        return Err(AppError::other("不支持的图片格式"));
    }
    ensure_dir(gallery)?;
    let file_name = format!("{}.{ext}", item.id);
    let target = gallery.join(&file_name);
    let same_file = fs::canonicalize(&target).is_ok_and(|path| path == source);
    if !same_file {
        // create_new 防止元数据错误或并发操作覆盖已有文件。
        let mut destination = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)?;
        if let Err(error) = std::io::copy(&mut fs::File::open(&source)?, &mut destination) {
            drop(destination);
            let _ = fs::remove_file(&target);
            return Err(error.into());
        }
    }
    item.file_name = file_name;
    item.path = target.to_string_lossy().to_string();
    item.data_url = None;
    if let Some((width, height)) = read_dimensions(&item.path) {
        item.size = format!("{width}x{height}");
    }
    Ok(item)
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
            if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC
            {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        use std::io::Write;
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut chunk = |kind: &[u8; 4], data: &[u8]| {
            bytes.extend_from_slice(&(data.len() as u32).to_be_bytes());
            bytes.extend_from_slice(kind);
            bytes.extend_from_slice(data);
            let mut crc = crc32fast::Hasher::new();
            crc.update(kind);
            crc.update(data);
            bytes.extend_from_slice(&crc.finalize().to_be_bytes());
        };
        let mut header = Vec::from(width.to_be_bytes());
        header.extend_from_slice(&height.to_be_bytes());
        header.extend_from_slice(&[8, 6, 0, 0, 0]);
        chunk(b"IHDR", &header);
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&[0, 0, 0, 0, 255]).unwrap();
        chunk(b"IDAT", &encoder.finish().unwrap());
        chunk(b"IEND", &[]);
        bytes
    }

    #[test]
    fn code_outputs_accept_png_and_preserve_exact_bytes() {
        let bytes = png(1, 1);
        let outputs = parse_code_outputs(vec![to_data_url("image/png", &bytes)]).unwrap();
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].bytes, bytes);
        assert_eq!(outputs[0].ext, "png");
        assert_eq!(validate_code_png(&outputs[0].bytes).unwrap(), (1, 1));
    }

    #[test]
    fn code_outputs_reject_empty_excess_and_non_png_images() {
        let url = to_data_url("image/png", &png(1, 1));
        assert!(parse_code_outputs(Vec::new()).is_err());
        assert!(parse_code_outputs(vec![url.clone(); 5]).is_err());
        assert!(parse_code_outputs(vec![to_data_url("image/jpeg", &png(1, 1))]).is_err());
        assert!(parse_code_outputs(vec!["data:image/png;base64,not-base64".into()]).is_err());
        assert_eq!(parse_code_outputs(vec![url; 4]).unwrap().len(), 4);
    }

    #[test]
    fn code_outputs_reject_zero_excess_dimensions_and_aggregate_pixels() {
        for (width, height) in [(0, 1), (1, 0), (4097, 1), (1, 4097)] {
            assert!(validate_code_png(&png(width, height)).is_err());
        }
        assert_eq!(validate_code_png(&png(4096, 4096)).unwrap(), (4096, 4096));
        let url = to_data_url("image/png", &png(4000, 4000));
        assert_eq!(parse_code_outputs(vec![url.clone(); 3]).unwrap().len(), 3);
        assert!(parse_code_outputs(vec![url; 4]).is_err());
    }

    #[test]
    fn code_outputs_reject_forged_headers_and_truncated_chunks() {
        assert!(validate_code_png(b"\x89PNG\r\n\x1a\n").is_err());
        let good = png(1, 1);
        let mut bad = good.clone();
        bad[8..12].copy_from_slice(&12_u32.to_be_bytes());
        assert!(validate_code_png(&bad).is_err());
        let mut bad = good.clone();
        bad[33..37].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(validate_code_png(&bad).is_err());
        assert!(validate_code_png(&good[..good.len() - 1]).is_err());
        let mut bad = good.clone();
        bad[25] = 7;
        assert!(validate_code_png(&bad).is_err());
        let mut bad = good;
        bad.extend_from_slice(b"trailing-data");
        assert!(validate_code_png(&bad).is_err());
    }

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "image-studio-gallery-test-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn output(root: &Path) -> GalleryItem {
        let mut bytes = vec![0; 32];
        bytes[..4].copy_from_slice(&[0x89, b'P', b'N', b'G']);
        bytes[16..20].copy_from_slice(&640_u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&480_u32.to_be_bytes());
        let meta = SaveMeta {
            kind: "edit".into(),
            prompt: "保留中文".into(),
            model: "test".into(),
            size: "auto".into(),
            parent_id: Some("parent".into()),
        };
        store_images(
            &root.join("outputs/images"),
            &meta,
            vec![RawImage {
                bytes,
                mime: "image/png".into(),
                ext: "png".into(),
                revised_prompt: Some("revised".into()),
                source_url: None,
            }],
        )
        .unwrap()
        .remove(0)
    }

    #[test]
    fn generated_outputs_do_not_create_gallery_or_index() {
        let root = TestDir::new();
        let item = output(&root.0);
        assert!(Path::new(&item.path).is_file());
        assert_eq!(item.size, "640x480");
        assert!(!root.0.join("gallery").exists());
        assert!(!root.0.join("outputs/index.json").exists());
    }

    #[test]
    fn selected_output_is_copied_and_preserves_metadata_and_history() {
        let root = TestDir::new();
        let item = output(&root.0);
        let saved = archive_into(
            item.clone(),
            &root.0.join("outputs/images"),
            &root.0.join("gallery/images"),
        )
        .unwrap();
        assert_eq!(saved.id, item.id);
        assert_eq!(saved.prompt, item.prompt);
        assert_eq!(saved.parent_id, item.parent_id);
        assert_eq!(saved.revised_prompt, item.revised_prompt);
        assert!(saved.data_url.is_none());
        assert_eq!(
            fs::read(&saved.path).unwrap(),
            fs::read(&item.path).unwrap()
        );
        fs::remove_file(&saved.path).unwrap();
        assert!(Path::new(&item.path).is_file());
    }

    #[test]
    fn archive_rejects_external_paths_and_unsafe_ids_without_overwriting() {
        let root = TestDir::new();
        let mut item = output(&root.0);
        let outside = root.0.join("outside.png");
        fs::copy(&item.path, &outside).unwrap();
        let valid_path = item.path.clone();
        item.path = outside.to_string_lossy().to_string();
        assert!(archive_into(
            item.clone(),
            &root.0.join("outputs/images"),
            &root.0.join("gallery/images")
        )
        .is_err());
        item.path = valid_path;
        item.id = "../escape".into();
        assert!(archive_into(
            item,
            &root.0.join("outputs/images"),
            &root.0.join("gallery/images")
        )
        .is_err());
        assert!(!root.0.join("gallery").exists());
    }
}
