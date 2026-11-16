//! Peer-to-peer sync of the open vault with the user's other devices, over
//! iroh (feature `sync`). Devices pair once with a ticket; then each change
//! (and a periodic check) runs a round with every paired device that's
//! reachable. The vault side of a round (manifest, plan, merge, applying)
//! is `sliver_vault::sync`; this is the networking and the commands.
//!
//! Without the feature the commands exist but report sync as unavailable.

#[cfg(feature = "sync")]
mod device;
#[cfg(feature = "sync")]
mod pair;
#[cfg(feature = "sync")]
mod protocol;
#[cfg(feature = "sync")]
mod service;

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

type CommandResult<T> = Result<T, String>;

#[cfg(not(feature = "sync"))]
const UNAVAILABLE: &str = "sync isn't part of this build";

/// What the frontend shows: this device and each paired one.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub available: bool,
    /// Whether this device is online for sync (a vault with paired devices,
    /// or one being paired, is open).
    pub running: bool,
    pub device_name: String,
    pub device_id: Option<String>,
    pub peers: Vec<PeerStatus>,
    /// The ticket of a pairing in progress.
    pub pairing: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerStatus {
    pub id: String,
    pub name: String,
    /// `idle`, `syncing`, `offline` or `error`.
    pub state: &'static str,
    /// Unix milliseconds.
    pub last_sync: Option<u64>,
    pub error: Option<String>,
}

/// Sets up the sync state; call once at startup.
pub fn init(app: &AppHandle) {
    #[cfg(feature = "sync")]
    service::init(app);
    #[cfg(not(feature = "sync"))]
    let _ = app;
}

/// A vault was opened: sync it if it has paired devices.
pub fn vault_opened(app: &AppHandle, root: &Path) {
    #[cfg(feature = "sync")]
    service::vault_opened(app, root.to_path_buf());
    #[cfg(not(feature = "sync"))]
    let _ = (app, root);
}

/// Something changed in the open vault (any write, the app's own too).
pub fn local_change(app: &AppHandle) {
    #[cfg(feature = "sync")]
    service::local_change(app);
    #[cfg(not(feature = "sync"))]
    let _ = app;
}

/// Whether a change at a vault path may need syncing.
pub fn affects_sync(path: &str) -> bool {
    cfg!(feature = "sync") && sliver_vault::sync::affects_sync(path)
}

#[tauri::command]
pub fn sync_available() -> bool {
    cfg!(feature = "sync")
}

#[tauri::command]
pub async fn sync_status(app: AppHandle) -> SyncStatus {
    #[cfg(feature = "sync")]
    return service::status(&app);
    #[cfg(not(feature = "sync"))]
    {
        let _ = app;
        SyncStatus::default()
    }
}

/// Runs a round with every paired device now.
#[tauri::command]
pub async fn sync_now(app: AppHandle) -> CommandResult<()> {
    #[cfg(feature = "sync")]
    return service::sync_now(&app).await;
    #[cfg(not(feature = "sync"))]
    {
        let _ = app;
        Err(UNAVAILABLE.into())
    }
}

/// Starts pairing a device with the open vault; returns the ticket to enter
/// on the other device. It's valid once, for a few minutes.
#[tauri::command]
pub async fn sync_pair_start(app: AppHandle) -> CommandResult<String> {
    #[cfg(feature = "sync")]
    return pair::start(&app).await;
    #[cfg(not(feature = "sync"))]
    {
        let _ = app;
        Err(UNAVAILABLE.into())
    }
}

#[tauri::command]
pub async fn sync_pair_cancel(app: AppHandle) {
    #[cfg(feature = "sync")]
    pair::cancel(&app);
    #[cfg(not(feature = "sync"))]
    let _ = app;
}

/// Pairs with the device that showed `ticket` and prepares `folder` (empty)
/// to receive its vault; the frontend then opens it, and the first round
/// brings the notes.
#[tauri::command]
pub async fn sync_join(app: AppHandle, ticket: String, folder: PathBuf) -> CommandResult<()> {
    #[cfg(feature = "sync")]
    return pair::join(&app, &ticket, &folder).await;
    #[cfg(not(feature = "sync"))]
    {
        let _ = (app, ticket, folder);
        Err(UNAVAILABLE.into())
    }
}

/// Unpairs a device from the open vault.
#[tauri::command]
pub async fn sync_remove_device(app: AppHandle, id: String) -> CommandResult<()> {
    #[cfg(feature = "sync")]
    return service::remove_device(&app, &id).await;
    #[cfg(not(feature = "sync"))]
    {
        let _ = (app, id);
        Err(UNAVAILABLE.into())
    }
}

#[tauri::command]
pub async fn sync_set_device_name(app: AppHandle, name: String) -> CommandResult<()> {
    #[cfg(feature = "sync")]
    return service::set_device_name(&app, &name);
    #[cfg(not(feature = "sync"))]
    {
        let _ = (app, name);
        Err(UNAVAILABLE.into())
    }
}
