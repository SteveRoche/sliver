//! The main window. Created here rather than in `tauri.conf.json` so it
//! starts in the last vault's theme: one that painted in the system's theme
//! and switched when the vault's settings loaded would flash.

use std::fs;

use tauri::window::Color;
use tauri::{App, AppHandle, Theme, WebviewUrl, WebviewWindowBuilder};

use crate::state;

/// `--bg` in `App.css`, light and dark.
const LIGHT_BACKGROUND: Color = Color(0xf6, 0xf6, 0xf6, 0xff);
const DARK_BACKGROUND: Color = Color(0x2b, 0x2b, 0x2b, 0xff);

/// The last vault's `theme` setting ("system", "light" or "dark"). Read
/// straight from its settings file, which stays the only copy.
fn startup_theme(app: &AppHandle) -> &'static str {
    let saved = state::load(app)
        .last_vault
        .and_then(|root| fs::read_to_string(root.join(sliver_vault::SETTINGS_FILE)).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    match saved.as_ref().and_then(|s| s.get("theme")?.as_str()) {
        Some("light") => "light",
        Some("dark") => "dark",
        _ => "system",
    }
}

pub fn create(app: &App) -> tauri::Result<()> {
    let theme = startup_theme(app.handle());
    let native = match theme {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    };
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("Sliver")
        .inner_size(1280.0, 800.0)
        .theme(native)
        // Read by `index.html` before the first paint, and by the settings
        // until a vault's own load.
        .initialization_script(format!("window.__SLIVER_THEME__ = '{theme}';"))
        .build()?;
    let background = if window.theme()? == Theme::Dark {
        DARK_BACKGROUND
    } else {
        LIGHT_BACKGROUND
    };
    window.set_background_color(Some(background))
}
