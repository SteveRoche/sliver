//! Tauri commands for the vault. They are `async` so file I/O runs off the
//! main thread; errors cross to JS as their display strings.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use sliver_vault::{DeleteMode, NoteSummary, Placement, TreeNode, Uuid, Vault};
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
