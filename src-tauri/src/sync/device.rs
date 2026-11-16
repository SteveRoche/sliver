//! This device's sync identity, per machine (in the app config dir, never in
//! a vault, so a vault copied by other means never shares it): the iroh
//! secret key, whose public half is the device's id, and its name.

use std::fs;
use std::path::PathBuf;

use iroh::SecretKey;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

/// The device's key, created on first use.
pub fn secret_key(app: &AppHandle) -> Result<SecretKey, String> {
    let path = dir(app)?.join("device.key");
    if let Ok(bytes) = fs::read(&path)
        && let Ok(bytes) = <[u8; 32]>::try_from(bytes.as_slice())
    {
        return Ok(SecretKey::from_bytes(&bytes));
    }
    let key = SecretKey::generate();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, key.to_bytes()).map_err(|e| e.to_string())?;
    restrict(&path);
    Ok(key)
}

#[cfg(unix)]
fn restrict(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &std::path::Path) {}

#[derive(Default, Serialize, Deserialize)]
struct DeviceFile {
    name: Option<String>,
}

/// The name other devices see (in their device list and conflict copies).
pub fn name(app: &AppHandle) -> String {
    dir(app)
        .ok()
        .and_then(|dir| fs::read_to_string(dir.join("device.json")).ok())
        .and_then(|text| serde_json::from_str::<DeviceFile>(&text).ok())
        .and_then(|file| file.name)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(default_name)
}

pub fn set_name(app: &AppHandle, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.contains(['\n', '\r']) {
        return Err("a device name is one line of text".into());
    }
    let dir = dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&DeviceFile {
        name: Some(name.to_owned()),
    })
    .map_err(|e| e.to_string())?;
    fs::write(dir.join("device.json"), text).map_err(|e| e.to_string())
}

/// The computer's name, as the system shows it where that's cheap to get.
fn default_name() -> String {
    let from_env = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok();
    #[cfg(target_os = "macos")]
    let from_system = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok());
    #[cfg(not(target_os = "macos"))]
    let from_system = fs::read_to_string("/etc/hostname").ok();
    from_env
        .or(from_system)
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "This device".to_owned())
}
