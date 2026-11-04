//! Tauri commands for the vault. They are `async` so file I/O runs off the
//! main thread; errors cross to JS as their display strings.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use sliver_vault::{DeleteMode, LinkDisplay, NoteSummary, Placement, TreeNode, Uuid, Vault};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, State};

use crate::state;

pub struct OpenVault(pub Mutex<Option<Vault>>);

type CommandResult<T> = Result<T, String>;

fn lock(open: &OpenVault) -> MutexGuard<'_, Option<Vault>> {
    open.0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn with_vault<T>(
    open: &OpenVault,
    f: impl FnOnce(&mut Vault) -> Result<T, sliver_vault::VaultError>,
) -> CommandResult<T> {
    let mut guard = lock(open);
    let vault = guard.as_mut().ok_or("no vault is open")?;
    f(vault).map_err(|e| e.to_string())
}

fn activate(app: &AppHandle, open: &OpenVault, vault: Vault) -> CommandResult<Vec<TreeNode>> {
    let tree = vault.tree();
    let mut app_state = state::load(app);
    app_state.last_vault = Some(vault.root().to_path_buf());
    state::save(app, &app_state)?;
    *lock(open) = Some(vault);
    Ok(tree)
}

#[tauri::command]
pub async fn create_vault(
    app: AppHandle,
    open: State<'_, OpenVault>,
    path: PathBuf,
) -> CommandResult<Vec<TreeNode>> {
    let vault = Vault::create(path).map_err(|e| e.to_string())?;
    activate(&app, &open, vault)
}

#[tauri::command]
pub async fn open_vault(
    app: AppHandle,
    open: State<'_, OpenVault>,
    path: PathBuf,
) -> CommandResult<Vec<TreeNode>> {
    let vault = Vault::open(path).map_err(|e| e.to_string())?;
    activate(&app, &open, vault)
}

/// The last opened vault, if it still exists on disk.
#[tauri::command]
pub async fn last_vault(app: AppHandle) -> Option<PathBuf> {
    state::load(&app).last_vault.filter(|p| p.is_dir())
}

#[tauri::command]
pub async fn list_tree(open: State<'_, OpenVault>) -> CommandResult<Vec<TreeNode>> {
    with_vault(&open, |vault| Ok(vault.tree()))
}

#[tauri::command]
pub async fn create_note(
    open: State<'_, OpenVault>,
    title: Option<String>,
    placement: Placement,
) -> CommandResult<NoteSummary> {
    with_vault(&open, |vault| vault.create_note(title, placement))
}

#[tauri::command]
pub async fn read_note(open: State<'_, OpenVault>, id: Uuid) -> CommandResult<String> {
    with_vault(&open, |vault| vault.read_note(id))
}

#[tauri::command]
pub async fn write_note(
    open: State<'_, OpenVault>,
    id: Uuid,
    text: String,
) -> CommandResult<NoteSummary> {
    with_vault(&open, |vault| vault.write_note(id, &text))
}

#[tauri::command]
pub async fn rename_note(
    open: State<'_, OpenVault>,
    id: Uuid,
    title: String,
) -> CommandResult<NoteSummary> {
    with_vault(&open, |vault| vault.rename_note(id, &title))
}

/// `mode` defaults to the OS trash; the settings view will choose it later.
#[tauri::command]
pub async fn delete_note(
    open: State<'_, OpenVault>,
    id: Uuid,
    mode: Option<DeleteMode>,
) -> CommandResult<()> {
    with_vault(&open, |vault| {
        vault.delete_note(id, mode.unwrap_or_default())
    })
}

#[tauri::command]
pub async fn backlinks(open: State<'_, OpenVault>, id: Uuid) -> CommandResult<Vec<NoteSummary>> {
    with_vault(&open, |vault| vault.backlinks(id))
}

/// Resolves a wikilink target (address or uuid) to a note id.
#[tauri::command]
pub async fn resolve_link(
    open: State<'_, OpenVault>,
    target: String,
) -> CommandResult<Option<Uuid>> {
    with_vault(&open, |vault| Ok(vault.resolve(&target)))
}

#[derive(serde::Serialize)]
pub struct SourceFile {
    path: String,
    text: String,
}

/// The generated `/.sliver/links.typ` (link table + `wikilinks` show rule).
#[tauri::command]
pub async fn link_library(
    open: State<'_, OpenVault>,
    show_addresses: Option<bool>,
) -> CommandResult<SourceFile> {
    let display = if show_addresses.unwrap_or(false) {
        LinkDisplay::Address
    } else {
        LinkDisplay::Title
    };
    with_vault(&open, |vault| {
        Ok(SourceFile {
            path: sliver_vault::LINKS_PATH.to_owned(),
            text: vault.link_library(display),
        })
    })
}

/// The wrapper main the preview compiles for note `id`.
#[tauri::command]
pub async fn preview_main(open: State<'_, OpenVault>, id: Uuid) -> CommandResult<SourceFile> {
    with_vault(&open, |vault| {
        vault.note(id)?;
        let id = id.to_string();
        Ok(SourceFile {
            path: sliver_vault::preview_main_path(&id),
            text: sliver_vault::preview_main(&id),
        })
    })
}

#[tauri::command]
pub async fn load_workspace(open: State<'_, OpenVault>) -> CommandResult<Option<String>> {
    with_vault(&open, |vault| vault.load_workspace())
}

#[tauri::command]
pub async fn save_workspace(open: State<'_, OpenVault>, json: String) -> CommandResult<()> {
    with_vault(&open, |vault| vault.save_workspace(&json))
}

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> serde_json::Value {
    state::load(&app).settings
}

#[tauri::command]
pub async fn set_settings(app: AppHandle, settings: serde_json::Value) -> CommandResult<()> {
    let mut app_state = state::load(&app);
    app_state.settings = settings;
    state::save(&app, &app_state)
}

/// The vault's cached `.tar.gz` for a package as raw bytes; empty if there is
/// none or no vault is open (the worker then downloads it).
#[tauri::command]
pub async fn load_package(open: State<'_, OpenVault>, spec: String) -> CommandResult<Response> {
    let bytes = match lock(&open).as_ref() {
        Some(vault) => vault.load_package(&spec).map_err(|e| e.to_string())?,
        None => None,
    };
    Ok(Response::new(bytes.unwrap_or_default()))
}

/// Caches a downloaded package. The raw body is the `.tar.gz`; the spec comes
/// in the `x-package-spec` header. A no-op when no vault is open.
#[tauri::command]
pub async fn save_package(open: State<'_, OpenVault>, request: Request<'_>) -> CommandResult<()> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw package body".into());
    };
    let spec = request
        .headers()
        .get("x-package-spec")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-package-spec header")?;
    match lock(&open).as_ref() {
        Some(vault) => vault.save_package(spec, bytes).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}
