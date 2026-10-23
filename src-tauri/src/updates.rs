//! 只检查本仓库的稳定 Release；安装交由系统浏览器和平台安装器确认。
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::{cmp::Ordering, time::Duration};

pub const RELEASE_API: &str = "https://api.github.com/repos/samabl/Image-Studio/releases/latest";
pub const RELEASE_URL: &str = "https://github.com/samabl/Image-Studio/releases/latest";

#[derive(Debug, Deserialize)]
pub struct ReleaseAsset {
    pub name: String,
    pub browser_download_url: String,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Deserialize)]
pub struct Release {
    pub tag_name: String,
    pub html_url: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownload {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub recommended: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareUpdate {
    pub current_version: String,
    pub latest_version: String,
    pub available: bool,
    pub release_name: String,
    pub release_url: String,
    pub published_at: Option<String>,
    pub notes: String,
    pub platform: String,
    pub downloads: Vec<UpdateDownload>,
}

#[derive(Debug)]
struct Version {
    core: [u64; 3],
    pre: Vec<String>,
}

fn identifiers(s: &str) -> Option<Vec<String>> {
    let parts: Vec<_> = s.split('.').collect();
    if parts
        .iter()
        .any(|p| p.is_empty() || !p.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'))
    {
        return None;
    }
    Some(parts.into_iter().map(str::to_string).collect())
}

fn version(s: &str) -> Option<Version> {
    let s = s.trim().strip_prefix('v').unwrap_or(s.trim());
    let (s, build) = s.split_once('+').map_or((s, None), |(v, b)| (v, Some(b)));
    if build.is_some_and(|b| identifiers(b).is_none()) {
        return None;
    }
    let (core, pre) = s
        .split_once('-')
        .map_or((s, Vec::new()), |(v, p)| (v, vec![p.to_string()]));
    let parts: Vec<_> = core.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut numbers = [0; 3];
    for (i, p) in parts.into_iter().enumerate() {
        if p.is_empty()
            || !p.bytes().all(|c| c.is_ascii_digit())
            || (p.len() > 1 && p.starts_with('0'))
        {
            return None;
        }
        numbers[i] = p.parse().ok()?;
    }
    let pre = if let Some(p) = pre.first() {
        identifiers(p)?
    } else {
        Vec::new()
    };
    if pre
        .iter()
        .any(|p| p.bytes().all(|c| c.is_ascii_digit()) && p.len() > 1 && p.starts_with('0'))
    {
        return None;
    }
    Some(Version { core: numbers, pre })
}

/// 数字版本比较，避免把 0.2.10 当成比 0.2.9 旧；build metadata 不参与比较。
pub fn compare_versions(a: &str, b: &str) -> AppResult<Ordering> {
    let a = version(a).ok_or_else(|| AppError::other("无法识别 Release 版本号"))?;
    let b = version(b).ok_or_else(|| AppError::other("无法识别当前应用版本号"))?;
    let core = a.core.cmp(&b.core);
    if core != Ordering::Equal {
        return Ok(core);
    }
    match (a.pre.is_empty(), b.pre.is_empty()) {
        (true, false) => return Ok(Ordering::Greater),
        (false, true) => return Ok(Ordering::Less),
        _ => (),
    }
    for (a, b) in a.pre.iter().zip(&b.pre) {
        let numeric_a = a.bytes().all(|c| c.is_ascii_digit());
        let numeric_b = b.bytes().all(|c| c.is_ascii_digit());
        let order = match (numeric_a, numeric_b) {
            (true, true) => a.len().cmp(&b.len()).then_with(|| a.cmp(b)),
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            _ => a.cmp(b),
        };
        if order != Ordering::Equal {
            return Ok(order);
        }
    }
    Ok(a.pre.len().cmp(&b.pre.len()))
}

pub fn trusted_release_url(value: &str, download: bool) -> bool {
    let lower = value.to_ascii_lowercase();
    if value
        .chars()
        .any(|c| c.is_control() || matches!(c, '\\' | '?' | '#'))
        || lower.contains("%2f")
        || lower.contains("%5c")
    {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    let prefix = if download {
        "/samabl/Image-Studio/releases/download/"
    } else {
        "/samabl/Image-Studio/releases/tag/"
    };
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().strip_prefix(prefix).is_some_and(|path| {
            let segments: Vec<_> = path.split('/').collect();
            segments.len() == if download { 2 } else { 1 }
                && segments.iter().all(|segment| !segment.is_empty())
        })
}

fn supports_asset(name: &str, os: &str, arch: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let arch = match (os, arch) {
        ("android", "aarch64") => "arm64-v8a",
        ("android", "arm") => "armeabi-v7a",
        ("windows", "x86_64") => "x64",
        ("windows", "aarch64") => "arm64",
        (_, arch) => arch,
    };
    let stem = format!("-{os}-{arch}");
    match os {
        "android" => name.ends_with(&format!("{stem}.apk")),
        "windows" => {
            name.ends_with(&format!("{stem}-setup.exe"))
                || name.ends_with(&format!("{stem}.exe"))
                || name.ends_with(&format!("{stem}.msi"))
        }
        "linux" => {
            name.ends_with(&format!("{stem}.appimage")) || name.ends_with(&format!("{stem}.deb"))
        }
        "macos" => name.ends_with(&format!("{stem}.dmg")),
        _ => false,
    }
}

pub fn release_info(
    release: Release,
    current: &str,
    os: &str,
    arch: &str,
) -> AppResult<SoftwareUpdate> {
    if release.draft || release.prerelease || !trusted_release_url(&release.html_url, false) {
        return Err(AppError::other("更新接口未返回本仓库的稳定 Release"));
    }
    let available = compare_versions(&release.tag_name, current)? == Ordering::Greater;
    let mut downloads: Vec<_> = release
        .assets
        .into_iter()
        .filter(|a| {
            supports_asset(&a.name, os, arch) && trusted_release_url(&a.browser_download_url, true)
        })
        .map(|a| UpdateDownload {
            name: a.name,
            url: a.browser_download_url,
            size: a.size,
            recommended: false,
        })
        .collect();
    downloads.sort_by_key(|a| (!a.name.ends_with("-setup.exe"), a.name.clone()));
    if let Some(first) = downloads.first_mut() {
        first.recommended = true;
    }
    Ok(SoftwareUpdate {
        current_version: current.into(),
        latest_version: release.tag_name.trim_start_matches('v').into(),
        available,
        release_name: release
            .name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(release.tag_name),
        release_url: RELEASE_URL.into(),
        published_at: release.published_at,
        notes: release
            .body
            .unwrap_or_default()
            .chars()
            .take(8000)
            .collect(),
        platform: format!("{os} / {arch}"),
        downloads,
    })
}

const MAX_RELEASE_BYTES: usize = 1024 * 1024;

async fn fetch_release(client: &reqwest::Client, url: &str) -> AppResult<Release> {
    let mut response = client
        .get(url)
        .header(
            "User-Agent",
            concat!("Image-Studio/", env!("CARGO_PKG_VERSION")),
        )
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        return Err(AppError::other(match status {
            403 | 429 => "GitHub 限流或访问被拒绝，请稍后重试或直接打开最新 Release 页面".into(),
            404 => "本仓库暂无可用的稳定 Release".into(),
            _ => format!("检查更新失败（GitHub HTTP {status}），可直接打开最新 Release 页面"),
        }));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RELEASE_BYTES as u64)
    {
        return Err(AppError::other("更新接口响应过大"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > MAX_RELEASE_BYTES {
            return Err(AppError::other("更新接口响应过大"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&bytes)?)
}

pub async fn check() -> AppResult<SoftwareUpdate> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let release = fetch_release(&client, RELEASE_API).await?;
    release_info(
        release,
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn release() -> Release {
        serde_json::from_value(json!({"tag_name":"v0.2.10","html_url":"https://github.com/samabl/Image-Studio/releases/tag/v0.2.10","assets":[
            {"name":"app-v0.2.10-windows-x64.exe","browser_download_url":"https://github.com/samabl/Image-Studio/releases/download/v0.2.10/app-v0.2.10-windows-x64.exe"},
            {"name":"app-v0.2.10-windows-x64-setup.exe","browser_download_url":"https://github.com/samabl/Image-Studio/releases/download/v0.2.10/app-v0.2.10-windows-x64-setup.exe"},
            {"name":"app-v0.2.10-android-arm64-v8a.apk","browser_download_url":"https://github.com/samabl/Image-Studio/releases/download/v0.2.10/app-v0.2.10-android-arm64-v8a.apk"},
            {"name":"app-v0.2.10-android-armeabi-v7a.apk","browser_download_url":"https://github.com/samabl/Image-Studio/releases/download/v0.2.10/app-v0.2.10-android-armeabi-v7a.apk"}
        ]})).unwrap()
    }

    #[test]
    fn numeric_versions_and_prereleases() {
        assert_eq!(
            compare_versions("v0.2.10", "0.2.9").unwrap(),
            Ordering::Greater
        );
        assert_eq!(compare_versions("0.2.5", "0.2.5").unwrap(), Ordering::Equal);
        assert_eq!(compare_versions("0.2.4", "0.2.5").unwrap(), Ordering::Less);
        assert_eq!(
            compare_versions("1.0.0", "1.0.0-rc.1").unwrap(),
            Ordering::Greater
        );
        assert_eq!(
            compare_versions("1.0.0-rc.10", "1.0.0-rc.9").unwrap(),
            Ordering::Greater
        );
        assert_eq!(
            compare_versions("1.0.0+local", "1.0.0+release").unwrap(),
            Ordering::Equal
        );
        assert!(compare_versions("banana", "0.2.5").is_err());
        assert!(compare_versions("1.02.0", "0.2.5").is_err());
        assert!(compare_versions("1.0.0-rc.01", "0.2.5").is_err());
    }

    #[test]
    fn matching_installers_only_and_no_downgrades() {
        let windows = release_info(release(), "0.2.5", "windows", "x86_64").unwrap();
        assert!(windows.available);
        assert_eq!(windows.downloads.len(), 2);
        assert!(windows.downloads[0].name.ends_with("-setup.exe"));
        assert!(windows.downloads[0].recommended);
        let android = release_info(release(), "0.2.10", "android", "aarch64").unwrap();
        assert!(!android.available);
        assert_eq!(android.downloads.len(), 1);
        assert!(android.downloads[0].name.ends_with("-arm64-v8a.apk"));
        assert!(release_info(release(), "0.3.0", "linux", "x86_64")
            .unwrap()
            .downloads
            .is_empty());
        assert!(
            !release_info(release(), "0.3.0", "windows", "x86_64")
                .unwrap()
                .available
        );
    }

    #[test]
    fn untrusted_urls_and_unstable_releases_rejected() {
        for url in [
            "http://github.com/samabl/Image-Studio/releases/tag/v1.0.0",
            "https://github.com.evil.test/samabl/Image-Studio/releases/tag/v1.0.0",
            "https://github.com/other/Image-Studio/releases/tag/v1.0.0",
            "https://user@github.com/samabl/Image-Studio/releases/tag/v1.0.0",
            "https://github.com:444/samabl/Image-Studio/releases/tag/v1.0.0",
        ] {
            assert!(!trusted_release_url(url, false));
        }
        let mut r = release();
        r.prerelease = true;
        assert!(release_info(r, "0.2.5", "windows", "x86_64").is_err());
        let mut r = release();
        r.assets[0].browser_download_url = "https://evil.test/app.exe".into();
        assert_eq!(
            release_info(r, "0.2.5", "windows", "x86_64")
                .unwrap()
                .downloads
                .len(),
            1
        );
    }

    #[test]
    fn update_url_trust_matches_frontend_fixtures() {
        let fixtures: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../scripts/fixtures/update-urls.json")).unwrap();
        for fixture in fixtures {
            let url = fixture["url"].as_str().unwrap();
            assert_eq!(
                trusted_release_url(url, false),
                fixture["page"].as_bool().unwrap(),
                "{url}"
            );
            assert_eq!(
                trusted_release_url(url, true),
                fixture["download"].as_bool().unwrap(),
                "{url}"
            );
        }
    }

    #[test]
    fn semver_precedence_and_release_metadata_are_bounded() {
        let precedence = [
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
        ];
        for pair in precedence.windows(2) {
            assert_eq!(
                compare_versions(pair[1], pair[0]).unwrap(),
                Ordering::Greater
            );
        }
        for invalid in [
            "",
            "1.0",
            "1.0.0.0",
            "-1.0.0",
            "1.0.0-",
            "1.0.0+",
            "1.0.0-alpha..1",
            "1.0.0+bad!",
            "18446744073709551616.0.0",
        ] {
            assert!(compare_versions(invalid, "0.2.5").is_err(), "{invalid}");
        }
        let mut r = release();
        r.name = Some("  ".into());
        r.body = Some("说明".repeat(9000));
        let info = release_info(r, "0.2.5", "windows", "x86_64").unwrap();
        assert_eq!(info.release_name, "v0.2.10");
        assert_eq!(info.notes.chars().count(), 8000);
        assert_eq!(info.release_url, RELEASE_URL);
        let json = serde_json::to_value(info).unwrap();
        assert_eq!(json["latestVersion"], "0.2.10");
        assert_eq!(json["currentVersion"], "0.2.5");
        let mut r = release();
        r.draft = true;
        assert!(release_info(r, "0.2.5", "windows", "x86_64").is_err());
        assert!(release_info(release(), "0.2.5", "windows", "aarch64")
            .unwrap()
            .downloads
            .is_empty());
        assert!(release_info(release(), "0.2.5", "android", "x86_64")
            .unwrap()
            .downloads
            .is_empty());
    }

    // Production request/parsing against loopback HTTP; no public API or test credentials.
    fn http_fixture(
        status: u16,
        headers: &str,
        body: Vec<u8>,
    ) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/releases/latest", listener.local_addr().unwrap());
        let headers = headers.to_string();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = socket.read(&mut buffer).unwrap();
                assert_ne!(count, 0);
                request.extend_from_slice(&buffer[..count]);
            }
            let length =
                if headers.contains("Transfer-Encoding:") || headers.contains("Content-Length:") {
                    String::new()
                } else {
                    format!("Content-Length: {}\r\n", body.len())
                };
            let response =
                format!("HTTP/1.1 {status} Test\r\nConnection: close\r\n{headers}{length}\r\n");
            let _ = socket.write_all(response.as_bytes());
            let _ = socket.write_all(&body);
            String::from_utf8(request).unwrap()
        });
        (url, handle)
    }

    fn test_client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn update_fetch_is_unauthenticated_and_rejects_http_errors_without_redirecting() {
        let client = test_client();
        let body = serde_json::to_vec(&json!({"tag_name":"v0.2.10","html_url":"https://github.com/samabl/Image-Studio/releases/tag/v0.2.10"})).unwrap();
        let (url, server) = http_fixture(200, "Content-Type: application/json\r\n", body);
        let r = fetch_release(&client, &url).await.unwrap();
        assert_eq!(r.tag_name, "v0.2.10");
        let request = server.join().unwrap().to_ascii_lowercase();
        assert!(request.contains("get /releases/latest http/1.1"));
        assert!(request.contains("user-agent: image-studio/"));
        assert!(request.contains("accept: application/vnd.github+json"));
        assert!(!request.contains("authorization:") && !request.contains("cookie:"));
        for (status, expected) in [
            (403, "限流"),
            (429, "限流"),
            (404, "暂无"),
            (500, "HTTP 500"),
            (302, "HTTP 302"),
        ] {
            let (url, server) = http_fixture(
                status,
                "Location: http://127.0.0.1:1/must-not-follow\r\n",
                Vec::new(),
            );
            assert!(fetch_release(&client, &url)
                .await
                .unwrap_err()
                .to_string()
                .contains(expected));
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn update_fetch_rejects_oversized_and_invalid_json_responses() {
        let client = test_client();
        let (url, server) = http_fixture(200, "", vec![b' '; MAX_RELEASE_BYTES + 1]);
        assert!(fetch_release(&client, &url)
            .await
            .unwrap_err()
            .to_string()
            .contains("响应过大"));
        server.join().unwrap();
        let mut chunks = Vec::new();
        for size in [MAX_RELEASE_BYTES / 2, MAX_RELEASE_BYTES / 2, 1] {
            chunks.extend_from_slice(format!("{size:x}\r\n").as_bytes());
            chunks.extend(vec![b' '; size]);
            chunks.extend_from_slice(b"\r\n");
        }
        chunks.extend_from_slice(b"0\r\n\r\n");
        let (url, server) = http_fixture(200, "Transfer-Encoding: chunked\r\n", chunks);
        assert!(fetch_release(&client, &url)
            .await
            .unwrap_err()
            .to_string()
            .contains("响应过大"));
        server.join().unwrap();
        let (url, server) = http_fixture(200, "", b"not JSON".to_vec());
        assert!(fetch_release(&client, &url)
            .await
            .unwrap_err()
            .to_string()
            .contains("响应解析失败"));
        server.join().unwrap();
        let (url, server) = http_fixture(200, "", b"{}".to_vec());
        assert!(fetch_release(&client, &url).await.is_err());
        server.join().unwrap();
    }
}
