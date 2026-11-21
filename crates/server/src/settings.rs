//! 用户配置：服务商 / 端点 / 模型。密钥单独放，不写进这个文件。

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub configured: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            provider: "deepseek".into(),
            base_url: "https://api.deepseek.com".into(),
            model: "deepseek-chat".into(),
            configured: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SettingsView {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub configured: bool,
    pub has_key: bool,
    pub key_in_keychain: bool,
}

#[derive(Debug, Clone)]
pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(dir: &Path) -> Self {
        Self { path: dir.join("settings.json") }
    }

    pub fn load(&self) -> Settings {
        fs::read_to_string(&self.path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, settings: &Settings) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let raw = serde_json::to_string_pretty(settings)?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, raw).context("write settings")?;
        fs::rename(&tmp, &self.path).context("replace settings")?;
        Ok(())
    }
}

/// 内置服务商预设：前端只渲染，不硬编码在 TS 里。
pub fn presets() -> serde_json::Value {
    serde_json::json!([
        {
            "id": "deepseek",
            "label": "DeepSeek",
            "base_url": "https://api.deepseek.com",
            "models": ["deepseek-chat", "deepseek-reasoner"],
            "note": "国内可直连，性价比高"
        },
        {
            "id": "openai",
            "label": "OpenAI",
            "base_url": "https://api.openai.com/v1",
            "models": ["gpt-4o-mini", "gpt-4o"],
            "note": "需要海外网络环境"
        },
        {
            "id": "openrouter",
            "label": "OpenRouter",
            "base_url": "https://openrouter.ai/api/v1",
            "models": ["deepseek/deepseek-chat", "anthropic/claude-3.5-sonnet"],
            "note": "一个 Key 用多家模型"
        },
        {
            "id": "custom",
            "label": "自定义 / 本地",
            "base_url": "http://127.0.0.1:11434/v1",
            "models": [],
            "note": "任意 OpenAI 兼容端点，如 Ollama、vLLM"
        }
    ])
}
