//! Android 前台服务覆盖完整的 AI 工作流，桌面平台不需要额外服务。
use crate::error::AppResult;
use tauri::AppHandle;

#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundStatus {
    battery_optimization_ignored: bool,
    notifications_enabled: bool,
    #[serde(default)]
    active_tasks: usize,
    #[serde(default)]
    wake_lock_held: bool,
    #[serde(default)]
    network_available: bool,
    #[serde(default)]
    network_blocked: bool,
    #[serde(default)]
    last_error: Option<String>,
}

/// 锁屏、网络切换或系统暂时阻断时先等待恢复，避免空耗模型重试次数。
pub async fn wait_for_network(app: &AppHandle, timeout_secs: u64) -> AppResult<()> {
    #[cfg(target_os = "android")]
    {
        let deadline = tokio::time::Instant::now()
            + std::time::Duration::from_secs(timeout_secs.clamp(10, 60));
        loop {
            let connection = status(app).await?;
            if connection.network_available {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(crate::error::AppError::other(if connection.network_blocked {
                    "Android 已限制后台联网，等待恢复超时；请回到应用并允许后台数据及电池权限后重试"
                } else {
                    "Android 网络暂不可用，等待恢复超时；请检查 Wi-Fi、移动数据或 VPN 后重试"
                }));
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, timeout_secs);
        Ok(())
    }
}

#[cfg(target_os = "android")]
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri::Manager;
    tauri::plugin::Builder::new("background-tasks")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("app.imagestudio.background", "BackgroundTasksPlugin")?;
            app.manage(BackgroundTasks(handle));
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
struct BackgroundTasks<R: tauri::Runtime>(tauri::plugin::PluginHandle<R>);

pub async fn start(app: &AppHandle, task_id: String) -> AppResult<()> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let handle = app.state::<BackgroundTasks<tauri::Wry>>().0.clone();
        handle
            .run_mobile_plugin_async::<serde_json::Value>(
                "start",
                serde_json::json!({ "taskId": task_id }),
            )
            .await
            .map_err(|e| {
                crate::error::AppError::other(format!("无法启动 Android 后台任务：{e}"))
            })?;
    }
    #[cfg(not(target_os = "android"))]
    let _ = (app, task_id);
    Ok(())
}

pub async fn finish(app: &AppHandle, task_id: String) -> AppResult<()> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let handle = app.state::<BackgroundTasks<tauri::Wry>>().0.clone();
        handle
            .run_mobile_plugin_async::<serde_json::Value>(
                "finish",
                serde_json::json!({ "taskId": task_id }),
            )
            .await
            .map_err(|e| {
                crate::error::AppError::other(format!("无法停止 Android 后台任务：{e}"))
            })?;
    }
    #[cfg(not(target_os = "android"))]
    let _ = (app, task_id);
    Ok(())
}

pub async fn status(app: &AppHandle) -> AppResult<BackgroundStatus> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let handle = app.state::<BackgroundTasks<tauri::Wry>>().0.clone();
        return handle
            .run_mobile_plugin_async("status", serde_json::json!({}))
            .await
            .map_err(|e| crate::error::AppError::other(e.to_string()));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(BackgroundStatus::default())
    }
}

pub async fn configure(app: &AppHandle) -> AppResult<()> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let handle = app.state::<BackgroundTasks<tauri::Wry>>().0.clone();
        handle
            .run_mobile_plugin_async::<serde_json::Value>("configure", serde_json::json!({}))
            .await
            .map_err(|e| crate::error::AppError::other(e.to_string()))?;
    }
    #[cfg(not(target_os = "android"))]
    let _ = app;
    Ok(())
}

pub async fn set_theme(app: &AppHandle, theme: String, mode: String) -> AppResult<()> {
    if !matches!(theme.as_str(), "light" | "dark")
        || !matches!(mode.as_str(), "light" | "dark" | "system")
    {
        return Err(crate::error::AppError::other("不支持的主题"));
    }
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let handle = app.state::<BackgroundTasks<tauri::Wry>>().0.clone();
        handle
            .run_mobile_plugin_async::<serde_json::Value>(
                "setTheme",
                serde_json::json!({ "theme": theme, "mode": mode }),
            )
            .await
            .map_err(|e| crate::error::AppError::other(e.to_string()))?;
    }
    #[cfg(not(target_os = "android"))]
    let _ = app;
    Ok(())
}

pub async fn save_to_album(
    app: &AppHandle,
    data_url: String,
    file_name: String,
) -> AppResult<String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        #[derive(serde::Deserialize)]
        struct Saved {
            target: String,
        }
        let handle = app.state::<BackgroundTasks<tauri::Wry>>().0.clone();
        let saved: Saved = handle
            .run_mobile_plugin_async(
                "saveToAlbum",
                serde_json::json!({ "dataUrl": data_url, "fileName": file_name }),
            )
            .await
            .map_err(|e| crate::error::AppError::other(format!("保存到相册失败：{e}")))?;
        return Ok(saved.target);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, data_url, file_name);
        Err(crate::error::AppError::other(
            "当前平台请使用文件保存对话框",
        ))
    }
}
