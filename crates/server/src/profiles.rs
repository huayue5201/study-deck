//! 卡片模板的存取：模板是**文件**（`<data>/profiles/*.json`），不是代码。
//! 这样它可以被备份、被分享、被版本化——扩展发生在数据层，不动架构。

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use studydeck_core::CardProfile;

use crate::settings::{Settings, SettingsStore};

pub struct Profiles {
    dir: PathBuf,
    settings: SettingsStore,
}

impl Profiles {
    pub fn new(dir: &Path, settings: SettingsStore) -> Self {
        let profiles = Self { dir: dir.to_path_buf(), settings };
        profiles.seed();
        profiles
    }

    /// 首次启动写入内置模板；已存在的不覆盖（用户可能改过）。
    fn seed(&self) {
        let _ = fs::create_dir_all(&self.dir);
        for profile in CardProfile::builtins() {
            let path = self.path(&profile.id);
            if !path.exists() {
                let _ = write_profile(&path, &profile);
            }
        }
    }

    fn path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    pub fn list(&self) -> Vec<CardProfile> {
        let mut out = Vec::new();
        if let Ok(entries) = fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|value| value.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(raw) = fs::read_to_string(&path) {
                    if let Ok(profile) = serde_json::from_str::<CardProfile>(&raw) {
                        if profile.is_valid() {
                            out.push(profile);
                        }
                    }
                }
            }
        }
        out.sort_by(|a, b| a.label.cmp(&b.label));
        out
    }

    pub fn get(&self, id: &str) -> Option<CardProfile> {
        let raw = fs::read_to_string(self.path(id)).ok()?;
        serde_json::from_str(&raw).ok()
    }

    pub fn save(&self, profile: &CardProfile) -> Result<()> {
        fs::create_dir_all(&self.dir)?;
        write_profile(&self.path(&profile.id), profile)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        fs::remove_file(self.path(id)).context("delete profile")?;
        Ok(())
    }

    /// 当前默认模板：设置里的 active；无效或缺失时退回第一个可用模板。
    pub fn active_id(&self) -> String {
        let settings = self.settings.load();
        if let Some(id) = settings.active_profile {
            if self.get(&id).is_some() {
                return id;
            }
        }
        // 没显式设过默认时，固定回到 tech，而不是"按字母序第一个"——
        // 否则新建一个模板就会悄悄改变默认，用户会莫名其妙。
        if self.get("tech").is_some() {
            return "tech".to_string();
        }
        self.list()
            .first()
            .map(|profile| profile.id.clone())
            .unwrap_or_else(|| "tech".to_string())
    }

    pub fn active(&self) -> Option<CardProfile> {
        self.get(&self.active_id())
    }

    pub fn set_active(&self, id: &str) -> Result<()> {
        if self.get(id).is_none() {
            anyhow::bail!("模板不存在：{id}");
        }
        let settings = self.settings.load();
        self.settings.save(&Settings { active_profile: Some(id.to_string()), ..settings })?;
        Ok(())
    }

    /// 造一个不与现有模板冲突的 id。
    pub fn unique_id(&self, label: &str) -> String {
        let base = CardProfile::slug(label);
        if self.get(&base).is_none() {
            return base;
        }
        for index in 2..100 {
            let candidate = format!("{base}-{index}");
            if self.get(&candidate).is_none() {
                return candidate;
            }
        }
        format!("{base}-{}", uuid::Uuid::new_v4().simple())
    }
}

fn write_profile(path: &Path, profile: &CardProfile) -> Result<()> {
    let raw = serde_json::to_string_pretty(profile)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw).context("write profile")?;
    fs::rename(&tmp, path).context("replace profile")?;
    Ok(())
}
