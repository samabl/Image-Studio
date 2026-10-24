use serde::{Serialize, Serializer};

/// 统一错误类型：所有命令都返回 `Result<T, AppError>`，
/// 序列化成字符串后前端 `invoke` 的 catch 里直接可读。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("网络请求失败：{0}")]
    Http(String),

    #[error("接口返回 {status}：{body}")]
    Api { status: u16, body: String },

    #[error("响应解析失败：{0}")]
    Json(#[from] serde_json::Error),

    #[error("文件读写失败：{0}")]
    Io(#[from] std::io::Error),

    #[error("配置错误：{0}")]
    Config(String),

    #[error("{0}")]
    Other(String),
}

impl AppError {
    pub fn other(msg: impl Into<String>) -> Self {
        AppError::Other(msg.into())
    }

    pub fn config(msg: impl Into<String>) -> Self {
        AppError::Config(msg.into())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(value: reqwest::Error) -> Self {
        // reqwest 的 Display 往往只有 error sending request，真正的 DNS/TLS/断连原因在 source 链。
        // URL 可能带连接信息，保留底层原因但不把请求地址反射进错误。
        let value = value.without_url();
        let mut details = vec![value.to_string()];
        let mut source = std::error::Error::source(&value);
        for _ in 0..6 {
            let Some(cause) = source else {
                break;
            };
            let text = cause.to_string();
            if !details.contains(&text) {
                details.push(text);
            }
            source = cause.source();
        }
        AppError::Http(details.join("："))
    }
}

impl From<tauri::Error> for AppError {
    fn from(value: tauri::Error) -> Self {
        AppError::Other(value.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

/// 把接口返回的非 2xx 响应体裁剪到可读长度，避免超长 HTML 错误页刷屏。
pub async fn api_error(resp: reqwest::Response) -> AppError {
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    let body = body.trim();
    let body = if body.chars().count() > 1200 {
        let truncated: String = body.chars().take(1200).collect();
        format!("{truncated}…")
    } else {
        body.to_string()
    };
    AppError::Api { status, body }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connection_error_preserves_cause_without_request_url() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let url = format!("http://{address}/private-request?key=fixture-secret");
        let error = reqwest::Client::new().get(&url).send().await.unwrap_err();
        let message = AppError::from(error).to_string();
        assert!(message.contains("网络请求失败"));
        assert!(message.contains("tcp connect") || message.contains("connection") || message.contains("连接"), "{message}");
        assert!(!message.contains("fixture-secret"));
        assert!(!message.contains("private-request"));
    }
}
