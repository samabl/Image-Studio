use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

/// 默认对话提示词：偏工程化的助手人设，方便与图像能力衔接。
pub const DEFAULT_CHAT_SYSTEM_PROMPT: &str = "\
你是 GPT Image Studio 内置的创作助手。你可以：
1. 与用户讨论画面构思、风格、构图、光线与配色；
2. 在需要时把口语化的想法整理成结构化的英文图像提示词；
3. 当用户要求出图或改图时，调用提供的图像工具（generate_image / edit_image）。
回答保持简洁、可执行。当用户只是闲聊时正常聊天，不要强行出图。";

/// 提示词增强器的系统提示词。
pub const DEFAULT_OPTIMIZE_SYSTEM_PROMPT: &str = "\
你是资深的 AI 绘画提示词工程师。把用户的想法扩写为一条高质量的生图提示词。
要求：
- 输出英文提示词，结构顺序为：主体 → 外观细节 → 动作/姿态 → 环境背景 → 构图与镜头 → 光线 → 风格与画质；
- 保留用户指定的关键元素与文字（若用户要求画面中出现文字，用引号原样保留）；
- 补充合理的细节，但不要引入用户未暗示的无关主体；
- 只输出提示词本身，不要解释、不要 Markdown、不要引号包裹。";

/// 图生文（反推提示词）的系统提示词。
pub const DEFAULT_REVERSE_SYSTEM_PROMPT: &str = "\
你是图像分析专家。观察用户提供的图片，输出一段可直接用于文生图模型的高质量英文提示词，
准确复现画面的主体、构图、风格、光线与色调。只输出提示词本身，不要解释、不要 Markdown。";

// 子结构都加 `serde(default)`：这样以后新增字段时，
// 用户机器上的旧 config.json 依然能解析（缺失字段取默认值），不会整份被重置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatConfig {
    pub protocol: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub system_prompt: String,
    /// `None` = 不下发 `temperature`。
    /// 实测 gpt-5.6 这类推理模型会直接 400 拒绝该参数，默认不发最稳妥。
    pub temperature: Option<f64>,
    pub max_tokens: u32,
    pub stream: bool,
    pub timeout_secs: u64,
    /// 最近一次成功拉取到的模型列表，供下拉框离线使用。
    #[serde(default)]
    pub models: Vec<String>,
}

impl Default for ChatConfig {
    fn default() -> Self {
        Self {
            protocol: "openai".into(),
            base_url: "http://10.213.196.114:3000".into(),
            api_key: String::new(),
            model: "gpt-5.6-luna".into(),
            system_prompt: DEFAULT_CHAT_SYSTEM_PROMPT.into(),
            temperature: None,
            max_tokens: 4096,
            stream: true,
            timeout_secs: 300,
            models: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImageModelConfig {
    pub id: String,
    pub api_mode: String,
    pub description: String,
    pub supports_editing: Option<bool>,
    pub base_url: String,
    pub api_key: String,
}

impl Default for ImageModelConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            api_mode: "auto".into(),
            description: String::new(),
            supports_editing: None,
            base_url: String::new(),
            api_key: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImageConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// `auto` = 按模型 ID 与服务地址预判，可逐模型覆盖；
    /// `images` = 走 /images/generations 与 /images/edits；
    /// `chat`   = 走 /chat/completions 的 modalities 出图（Gemini 系图像模型）。
    pub api_mode: String,
    pub size: String,
    pub quality: String,
    pub background: String,
    pub output_format: String,
    pub n: u32,
    pub timeout_secs: u64,
    #[serde(default)]
    pub models: Vec<String>,
    pub model_pool: Vec<ImageModelConfig>,
}

impl Default for ImageConfig {
    fn default() -> Self {
        Self {
            base_url: "http://10.213.196.114:3000".into(),
            api_key: String::new(),
            model: "gpt-image-2".into(),
            api_mode: "auto".into(),
            size: "1024x1024".into(),
            // quality / background / output_format 默认 "auto" = 不下发该参数，
            // 换取对各家网关的最大兼容性，用户可在高级设置里显式指定。
            quality: "auto".into(),
            background: "auto".into(),
            output_format: "auto".into(),
            n: 1,
            // gpt-image-2.5 实测单张可超过 2 分钟，默认给足余量。
            timeout_secs: 600,
            models: Vec::new(),
            model_pool: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LinkageConfig {
    /// 总开关：关闭后对话页不再注入图像工具。
    pub enabled: bool,
    /// 使用真实 function calling 让对话模型直接触发图像生成。
    pub use_tools: bool,
    /// 发送到图像页之前自动用对话模型润色提示词。
    pub auto_optimize_prompt: bool,
    /// 反推/优化使用的模型，留空表示沿用对话模型。
    pub vision_model: String,
    pub optimize_system_prompt: String,
    pub reverse_system_prompt: String,
}

impl Default for LinkageConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            use_tools: true,
            auto_optimize_prompt: false,
            vision_model: String::new(),
            optimize_system_prompt: DEFAULT_OPTIMIZE_SYSTEM_PROMPT.into(),
            reverse_system_prompt: DEFAULT_REVERSE_SYSTEM_PROMPT.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiConfig {
    pub language: String,
    pub send_on_enter: bool,
    pub theme: String,
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            language: "zh".into(),
            send_on_enter: true,
            theme: "system".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    #[serde(default = "current_version")]
    pub version: u32,
    pub chat: ChatConfig,
    pub image: ImageConfig,
    pub linkage: LinkageConfig,
    pub jury: JuryConfig,
    pub code_runtime: CodeRuntimeConfig,
    pub ui: UiConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JuryMemberConfig {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub model: String,
    pub inherit_chat: bool,
    pub protocol: String,
    pub base_url: String,
    pub api_key: String,
    pub focus: String,
    pub models: Vec<String>,
}

impl Default for JuryMemberConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            enabled: true,
            model: String::new(),
            inherit_chat: true,
            protocol: "openai".into(),
            base_url: String::new(),
            api_key: String::new(),
            focus: String::new(),
            models: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JuryConfig {
    pub enabled: bool,
    pub include_chat: bool,
    pub members: Vec<JuryMemberConfig>,
}

impl Default for JuryConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            include_chat: true,
            members: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CodeRuntimeConfig {
    pub enabled: bool,
    pub timeout_secs: u64,
}

impl Default for CodeRuntimeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            timeout_secs: 10,
        }
    }
}

fn current_version() -> u32 {
    1
}

/// 应用数据根目录：Windows 为 %APPDATA%\com.gptimagestudio.app，
/// Android 为 /data/data/<pkg>/files。两端都不需要额外权限。
pub fn app_root(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::config(format!("无法定位应用数据目录：{e}")))?;
    Ok(dir)
}

pub fn ensure_dir(dir: &Path) -> AppResult<()> {
    if !dir.exists() {
        fs::create_dir_all(dir)?;
    }
    Ok(())
}

pub fn config_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app_root(app)?.join("config.json"))
}

pub fn load_config(app: &AppHandle) -> AppResult<AppConfig> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = fs::read_to_string(&path)?;
    match serde_json::from_str::<AppConfig>(&raw) {
        Ok(cfg) => Ok(cfg),
        Err(e) => {
            // 配置损坏时不让应用起不来：备份坏文件后回退默认值。
            let backup = path.with_extension("json.broken");
            let _ = fs::rename(&path, &backup);
            eprintln!(
                "config.json 解析失败({e})，已备份到 {} 并使用默认配置",
                backup.display()
            );
            Ok(AppConfig::default())
        }
    }
}

pub fn save_config(app: &AppHandle, cfg: &AppConfig) -> AppResult<()> {
    let path = config_path(app)?;
    ensure_dir(&app_root(app)?)?;
    let data = serde_json::to_string_pretty(cfg)?;
    // 先写临时文件再替换，避免写一半断电导致配置损坏。
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::AppConfig;

    #[test]
    fn old_config_does_not_enable_jury_or_code_execution() {
        let mut old = serde_json::to_value(AppConfig::default()).unwrap();
        let object = old.as_object_mut().unwrap();
        object.remove("jury");
        object.remove("codeRuntime");
        old["chat"]["model"] = "kept-model".into();
        let config: AppConfig = serde_json::from_value(old).unwrap();
        assert_eq!(config.chat.model, "kept-model");
        assert!(!config.jury.enabled);
        assert!(config.jury.include_chat);
        assert!(config.jury.members.is_empty());
        assert!(!config.code_runtime.enabled);
        assert_eq!(config.code_runtime.timeout_secs, 10);
    }

    #[test]
    fn multi_provider_jury_and_runtime_config_round_trip() {
        let mut value = serde_json::to_value(AppConfig::default()).unwrap();
        value["jury"] = serde_json::json!({
            "enabled": true, "includeChat": false,
            "members": [
                { "id": "a", "name": "构图", "model": "vision-a", "focus": "构图", "inheritChat": true },
                { "id": "b", "name": "细节", "model": "vision-b", "inheritChat": false, "protocol": "anthropic", "baseUrl": "https://example.invalid", "apiKey": "fixture-key" },
                { "id": "c", "model": "vision-c", "inheritChat": false, "protocol": "gemini" }
            ]
        });
        value["codeRuntime"] = serde_json::json!({ "enabled": true, "timeoutSecs": 25 });
        let config: AppConfig = serde_json::from_value(value).unwrap();
        assert!(config.jury.members[0].enabled);
        assert_eq!(config.jury.members[1].protocol, "anthropic");
        assert_eq!(config.jury.members[2].protocol, "gemini");
        let restored: AppConfig =
            serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
        assert!(restored.jury.enabled);
        assert!(!restored.jury.include_chat);
        assert_eq!(restored.jury.members[0].focus, "构图");
        assert_eq!(restored.jury.members[1].api_key, "fixture-key");
        assert!(restored.code_runtime.enabled);
        assert_eq!(restored.code_runtime.timeout_secs, 25);
    }

    #[test]
    fn old_config_keeps_connections_and_new_theme_survives_serialization() {
        let mut old = serde_json::to_value(AppConfig::default()).unwrap();
        old["ui"].as_object_mut().unwrap().remove("theme");
        old["chat"]["model"] = "existing-chat-model".into();
        old["chat"]["apiKey"] = "test-key".into();
        let mut config: AppConfig = serde_json::from_value(old).unwrap();
        assert_eq!(config.ui.theme, "system");
        assert_eq!(config.chat.model, "existing-chat-model");
        assert_eq!(config.chat.api_key, "test-key");
        config.ui.theme = "light".into();
        let saved = serde_json::to_string(&config).unwrap();
        let restored: AppConfig = serde_json::from_str(&saved).unwrap();
        assert_eq!(restored.ui.theme, "light");
        assert_eq!(restored.chat.api_key, "test-key");
    }
}
