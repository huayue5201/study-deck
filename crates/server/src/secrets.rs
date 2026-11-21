//! 密钥存储：优先系统钥匙串；钥匙串不可用时退化成 0600 权限文件（并在 UI 里提示）。

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const SERVICE: &str = "dev.studydeck.app";
const ACCOUNT: &str = "openai_api_key";

fn entry() -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT)
}

pub fn save_key(dir: &Path, key: &str) -> anyhow::Result<bool> {
    let key = key.trim();
    if key.is_empty() {
        return Ok(true);
    }
    if let Ok(entry) = entry() {
        if entry.set_password(key).is_ok() {
            // 钥匙串成功时清掉旧的文件副本
            let _ = fs::remove_file(file_path(dir));
            return Ok(true);
        }
    }
    write_fallback(dir, key)?;
    Ok(false)
}

pub fn load_key(dir: &Path) -> Option<String> {
    if let Ok(entry) = entry() {
        if let Ok(value) = entry.get_password() {
            if !value.trim().is_empty() {
                return Some(value);
            }
        }
    }
    fs::read_to_string(file_path(dir))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn clear_key(dir: &Path) {
    if let Ok(entry) = entry() {
        let _ = entry.delete_credential();
    }
    let _ = fs::remove_file(file_path(dir));
}

fn file_path(dir: &Path) -> PathBuf {
    dir.join("secret.key")
}

fn write_fallback(dir: &Path, key: &str) -> anyhow::Result<()> {
    fs::create_dir_all(dir)?;
    let path = file_path(dir);
    let mut file = fs::File::create(&path)?;
    file.write_all(key.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}
