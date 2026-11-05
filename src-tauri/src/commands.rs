//! Tauri commands for the vault. They are `async` so file I/O runs off the
//! main thread; errors cross to JS as their display strings.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use sliver_vault::{
    DeleteMode, FolderNode, LinkDisplay, MovePlan, NoteSummary, Placement, Preamble,
    PreambleWarning, Uuid, Vault,
};
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

fn activate(app: &AppHandle, open: &OpenVault, vault: Vault) -> CommandResult<FolderNode> {
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
) -> CommandResult<FolderNode> {
    let vault = Vault::create(path).map_err(|e| e.to_string())?;
    activate(&app, &open, vault)
}

#[tauri::command]
pub async fn open_vault(
    app: AppHandle,
    open: State<'_, OpenVault>,
    path: PathBuf,
) -> CommandResult<FolderNode> {
    let vault = Vault::open(path).map_err(|e| e.to_string())?;
    activate(&app, &open, vault)
}

/// The last opened vault, if it still exists on disk.
#[tauri::command]
pub async fn last_vault(app: AppHandle) -> Option<PathBuf> {
    state::load(&app).last_vault.filter(|p| p.is_dir())
}

#[tauri::command]
pub async fn list_tree(open: State<'_, OpenVault>) -> CommandResult<FolderNode> {
    with_vault(&open, |vault| Ok(vault.tree()))
}

#[tauri::command]
pub async fn create_note(
    open: State<'_, OpenVault>,
    title: Option<String>,
    placement: Placement,
    kind: Option<String>,
) -> CommandResult<NoteSummary> {
    with_vault(&open, |vault| {
        vault.create_note_of_kind(title, placement, kind)
    })
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
pub async fn create_folder(
    open: State<'_, OpenVault>,
    parent: String,
    name: String,
) -> CommandResult<String> {
    with_vault(&open, |vault| vault.create_folder(&parent, &name))
}

#[tauri::command]
pub async fn rename_folder(
    open: State<'_, OpenVault>,
    path: String,
    name: String,
) -> CommandResult<String> {
    with_vault(&open, |vault| vault.rename_folder(&path, &name))
}

/// Returns the ids of the notes deleted with the folder.
#[tauri::command]
pub async fn delete_folder(
    open: State<'_, OpenVault>,
    path: String,
    mode: Option<DeleteMode>,
) -> CommandResult<Vec<Uuid>> {
    with_vault(&open, |vault| {
        vault.delete_folder(&path, mode.unwrap_or_default())
    })
}

#[tauri::command]
pub async fn set_zettelkasten(open: State<'_, OpenVault>, path: String) -> CommandResult<()> {
    with_vault(&open, |vault| vault.set_zettelkasten(&path))
}

/// Returns the ids of every note whose file changed.
#[tauri::command]
pub async fn move_to_folder(
    open: State<'_, OpenVault>,
    id: Uuid,
    folder: String,
) -> CommandResult<Vec<Uuid>> {
    with_vault(&open, |vault| vault.move_to_folder(id, &folder))
}

#[tauri::command]
pub async fn plan_move(
    open: State<'_, OpenVault>,
    id: Uuid,
    placement: Placement,
) -> CommandResult<MovePlan> {
    with_vault(&open, |vault| vault.plan_move(id, &placement))
}

/// Returns the ids of every note whose file changed.
#[tauri::command]
pub async fn apply_move(
    open: State<'_, OpenVault>,
    id: Uuid,
    placement: Placement,
) -> CommandResult<Vec<Uuid>> {
    with_vault(&open, |vault| vault.apply_move(id, &placement))
}

#[tauri::command]
pub async fn backlinks(open: State<'_, OpenVault>, id: Uuid) -> CommandResult<Vec<NoteSummary>> {
    with_vault(&open, |vault| vault.backlinks(id))
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

/// Highlighting and wikilink ranges for the editor. Doesn't need a vault.
#[tauri::command]
pub async fn analyze(text: String) -> sliver_vault::Analysis {
    sliver_vault::analyze(&text)
}

/// `/.sliver/theme.typ` for the preview: the current app theme's colours.
#[tauri::command]
pub async fn theme_library(dark: bool) -> SourceFile {
    SourceFile {
        path: sliver_vault::THEME_PATH.to_owned(),
        text: sliver_vault::theme_library(dark),
    }
}

#[derive(serde::Serialize)]
pub struct PreviewMain {
    path: String,
    text: String,
    /// Hidden lines the engine compiles before the note's own text.
    prefix: String,
}

/// The wrapper main the preview compiles for note `id`, and its note's prefix.
#[tauri::command]
pub async fn preview_main(open: State<'_, OpenVault>, id: Uuid) -> CommandResult<PreviewMain> {
    with_vault(&open, |vault| {
        let preview = vault.preview(id)?;
        Ok(PreviewMain {
            path: sliver_vault::preview_main_path(&id.to_string()),
            text: preview.main,
            prefix: preview.prefix,
        })
    })
}

/// The common preamble, then one per kind of note.
#[tauri::command]
pub async fn list_preambles(open: State<'_, OpenVault>) -> CommandResult<Vec<Preamble>> {
    with_vault(&open, |vault| vault.preambles())
}

/// Saves a preamble (`kind` `None` is the common one); returns its warnings.
#[tauri::command]
pub async fn save_preamble(
    open: State<'_, OpenVault>,
    kind: Option<String>,
    text: String,
) -> CommandResult<Vec<PreambleWarning>> {
    with_vault(&open, |vault| vault.save_preamble(kind.as_deref(), &text))
}

#[tauri::command]
pub async fn create_kind(open: State<'_, OpenVault>, name: String) -> CommandResult<()> {
    with_vault(&open, |vault| vault.create_kind(&name))
}

/// Returns the ids of the notes whose `kind` was rewritten.
#[tauri::command]
pub async fn rename_kind(
    open: State<'_, OpenVault>,
    from: String,
    to: String,
) -> CommandResult<Vec<Uuid>> {
    with_vault(&open, |vault| vault.rename_kind(&from, &to))
}

#[tauri::command]
pub async fn delete_kind(
    open: State<'_, OpenVault>,
    name: String,
    mode: Option<DeleteMode>,
) -> CommandResult<()> {
    with_vault(&open, |vault| {
        vault.delete_kind(&name, mode.unwrap_or_default())
    })
}

#[tauri::command]
pub async fn set_kind(
    open: State<'_, OpenVault>,
    id: Uuid,
    kind: Option<String>,
) -> CommandResult<NoteSummary> {
    with_vault(&open, |vault| vault.set_kind(id, kind.as_deref()))
}

#[tauri::command]
pub async fn load_workspace(open: State<'_, OpenVault>) -> CommandResult<Option<String>> {
    with_vault(&open, |vault| vault.load_workspace())
}

#[tauri::command]
pub async fn save_workspace(open: State<'_, OpenVault>, json: String) -> CommandResult<()> {
    with_vault(&open, |vault| vault.save_workspace(&json))
}

/// The open vault's settings as JSON; the schema (and defaults) belong to the frontend.
#[tauri::command]
pub async fn load_settings(open: State<'_, OpenVault>) -> CommandResult<Option<String>> {
    with_vault(&open, |vault| vault.load_settings())
}

#[tauri::command]
pub async fn save_settings(open: State<'_, OpenVault>, json: String) -> CommandResult<()> {
    with_vault(&open, |vault| vault.save_settings(&json))
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
