//! Tauri commands for the vault. They are `async` so file I/O runs off the
//! main thread; errors cross to JS as their display strings.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use sliver_vault::{
    CitationOptions, CitationStyle, DeleteMode, FolderNode, LinkDisplay, MovePlan, Moved,
    NoteSummary, PathPlan, Placement, Preamble, PreambleWarning, Reference, Template, Uuid, Vault,
};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::state;
use crate::watch;
use crate::zotero::{self, Pick};

pub struct OpenVault(pub Mutex<Option<Vault>>);

type CommandResult<T> = Result<T, String>;

pub fn lock(open: &OpenVault) -> MutexGuard<'_, Option<Vault>> {
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
    watch::watch(app, vault.root());
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
    body: Option<String>,
) -> CommandResult<NoteSummary> {
    with_vault(&open, |vault| {
        vault.create_note_of_kind(title, placement, kind, body.as_deref().unwrap_or(""))
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
) -> CommandResult<Moved> {
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

/// The default text of a preamble or (with `template`) a note template,
/// common (`kind` `None`) or a kind's.
#[tauri::command]
pub fn default_text(kind: Option<String>, template: bool) -> String {
    sliver_vault::default_text(kind.as_deref(), template)
}

/// The default note template, then one per kind of note.
#[tauri::command]
pub async fn list_templates(open: State<'_, OpenVault>) -> CommandResult<Vec<Template>> {
    with_vault(&open, |vault| vault.templates())
}

/// Saves a note template (`kind` `None` is the default one).
#[tauri::command]
pub async fn save_template(
    open: State<'_, OpenVault>,
    kind: Option<String>,
    text: String,
) -> CommandResult<()> {
    with_vault(&open, |vault| vault.save_template(kind.as_deref(), &text))
}

/// What a new note of `kind` starts with, placeholders unexpanded.
#[tauri::command]
pub async fn note_template(
    open: State<'_, OpenVault>,
    kind: Option<String>,
) -> CommandResult<String> {
    with_vault(&open, |vault| vault.note_template(kind.as_deref()))
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

// --- citations ---

#[derive(serde::Serialize)]
pub struct References {
    path: String,
    text: String,
    entries: Vec<Reference>,
}

/// `.sliver/references.bib` and the keys and titles of its entries.
#[tauri::command]
pub async fn references(open: State<'_, OpenVault>) -> CommandResult<References> {
    with_vault(&open, |vault| {
        Ok(References {
            path: sliver_vault::REFERENCES_PATH.to_owned(),
            text: vault.references()?,
            entries: vault.reference_list()?,
        })
    })
}

/// The generated `/.sliver/citations.typ`; `styles` are the style names a
/// note may use, `enabled` false when `references.bib` doesn't parse.
#[tauri::command]
pub async fn citation_library(
    open: State<'_, OpenVault>,
    style: String,
    styles: Vec<String>,
    show_references: bool,
    enabled: bool,
) -> CommandResult<SourceFile> {
    with_vault(&open, |vault| {
        let entries = vault.reference_list()?;
        Ok(SourceFile {
            path: sliver_vault::CITATIONS_PATH.to_owned(),
            text: sliver_vault::citation_library(
                entries.iter().map(|e| e.key.as_str()),
                &CitationOptions {
                    style: &style,
                    styles: &styles,
                    show_references,
                    enabled,
                },
            ),
        })
    })
}

/// The custom CSL styles in `.sliver/styles/`.
#[tauri::command]
pub async fn citation_styles(open: State<'_, OpenVault>) -> CommandResult<Vec<CitationStyle>> {
    with_vault(&open, |vault| vault.citation_styles())
}

async fn export(keys: Vec<String>) -> Result<String, zotero::ZoteroError> {
    tauri::async_runtime::spawn_blocking(move || zotero::export(&keys))
        .await
        .map_err(|e| zotero::ZoteroError::Failed(e.to_string()))?
}

#[derive(serde::Serialize)]
pub struct Refreshed {
    /// Whether `references.bib` changed.
    changed: bool,
    /// False when Zotero couldn't be reached; nothing changed then.
    reachable: bool,
}

/// Fetches entries from Zotero into `references.bib`: with `all`, every
/// cited key (picking up edits made in Zotero) and dropping entries no note
/// cites; otherwise only cited keys it has no entry for. The vault isn't
/// locked while Zotero answers.
#[tauri::command]
pub async fn refresh_references(open: State<'_, OpenVault>, all: bool) -> CommandResult<Refreshed> {
    let keys = with_vault(&open, |vault| {
        Ok(if all {
            vault.cited_keys()
        } else {
            vault.missing_references()
        })
    })?;
    if keys.is_empty() && !all {
        return Ok(Refreshed {
            changed: false,
            reachable: true,
        });
    }
    let exported = match export(keys.into_iter().collect()).await {
        Ok(exported) => exported,
        Err(zotero::ZoteroError::Unavailable) => {
            return Ok(Refreshed {
                changed: false,
                reachable: false,
            });
        }
        Err(error) => return Err(error.to_string()),
    };
    let changed = with_vault(&open, |vault| vault.update_references(&exported, all))?;
    Ok(Refreshed {
        changed,
        reachable: true,
    })
}

#[tauri::command]
pub async fn zotero_ready() -> bool {
    tauri::async_runtime::spawn_blocking(zotero::ready)
        .await
        .unwrap_or(false)
}

/// Quits the app, once the webview has saved unsaved edits (after Quit in
/// the macOS menu).
#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}

/// Items in the Zotero library matching `query`, for `@` completion; none
/// while Zotero isn't running.
#[tauri::command]
pub async fn zotero_search(query: String) -> Vec<zotero::Found> {
    tauri::async_runtime::spawn_blocking(move || zotero::search(&query))
        .await
        .unwrap_or_default()
}

/// Opens Zotero's citation picker; the picked entries are added to
/// `references.bib` before this returns. Brings the app back to the front.
#[tauri::command]
pub async fn zotero_pick(app: AppHandle, open: State<'_, OpenVault>) -> CommandResult<Vec<Pick>> {
    let picked = tauri::async_runtime::spawn_blocking(zotero::pick)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }
    let picks = picked.map_err(|e| e.to_string())?;
    if !picks.is_empty() {
        let keys = picks.iter().map(|p| p.citation_key.clone()).collect();
        let exported = export(keys).await.map_err(|e| e.to_string())?;
        with_vault(&open, |vault| vault.update_references(&exported, false))?;
    }
    Ok(picks)
}

/// Selects the item with citation key `key` in Zotero (starting it if needed).
#[tauri::command]
pub async fn open_in_zotero(app: AppHandle, key: String) -> CommandResult<()> {
    let url = tauri::async_runtime::spawn_blocking(move || zotero::select_url(&key))
        .await
        .map_err(|e| e.to_string())?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

// --- assets ---

/// Any file in the vault by its vault path (`/a/b.png`), as raw bytes; an
/// error if it doesn't exist.
#[tauri::command]
pub async fn read_file(open: State<'_, OpenVault>, path: String) -> CommandResult<Response> {
    with_vault(&open, |vault| vault.read_file(&path)).map(Response::new)
}

/// Decodes a header value the webview percent-encoded (`encodeURIComponent`),
/// since header values must be ASCII.
fn header_text(request: &Request<'_>, name: &str) -> CommandResult<String> {
    let raw = request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("missing {name} header"))?;
    let mut bytes = Vec::with_capacity(raw.len());
    let mut rest = raw.as_bytes();
    while let Some((&b, tail)) = rest.split_first() {
        if b == b'%' && tail.len() >= 2 {
            let hex = std::str::from_utf8(&tail[..2]).map_err(|e| e.to_string())?;
            bytes.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            rest = &tail[2..];
        } else {
            bytes.push(b);
            rest = tail;
        }
    }
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

/// Saves a new asset (e.g. a pasted image). The raw body is the file; the
/// folder and name come in the `x-folder` and `x-name` headers. Returns its
/// vault path, which may have a number added to the name.
#[tauri::command]
pub async fn add_asset(open: State<'_, OpenVault>, request: Request<'_>) -> CommandResult<String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw file body".into());
    };
    let folder = header_text(&request, "x-folder")?;
    let name = header_text(&request, "x-name")?;
    with_vault(&open, |vault| vault.add_asset(&folder, &name, bytes))
}

/// Copies a file from outside the vault (dropped from Finder) into `folder`.
#[tauri::command]
pub async fn import_asset(
    open: State<'_, OpenVault>,
    folder: String,
    source: PathBuf,
) -> CommandResult<String> {
    with_vault(&open, |vault| vault.import_asset(&folder, &source))
}

#[tauri::command]
pub async fn plan_path_move(
    open: State<'_, OpenVault>,
    from: String,
    to: String,
) -> CommandResult<PathPlan> {
    with_vault(&open, |vault| vault.plan_path_move(&from, &to))
}

#[tauri::command]
pub async fn rename_asset(
    open: State<'_, OpenVault>,
    path: String,
    name: String,
) -> CommandResult<Moved> {
    with_vault(&open, |vault| vault.rename_asset(&path, &name))
}

#[tauri::command]
pub async fn move_asset(
    open: State<'_, OpenVault>,
    path: String,
    folder: String,
) -> CommandResult<Moved> {
    with_vault(&open, |vault| vault.move_asset(&path, &folder))
}

#[tauri::command]
pub async fn delete_asset(
    open: State<'_, OpenVault>,
    path: String,
    mode: Option<DeleteMode>,
) -> CommandResult<()> {
    with_vault(&open, |vault| {
        vault.delete_asset(&path, mode.unwrap_or_default())
    })
}

/// Opens an asset in the system's default app for it.
#[tauri::command]
pub async fn open_asset(
    app: AppHandle,
    open: State<'_, OpenVault>,
    path: String,
) -> CommandResult<()> {
    let file = with_vault(&open, |vault| vault.asset_file(&path))?;
    app.opener()
        .open_path(file.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Opens a web or mail link from the preview in the default browser or
/// mail app; nothing else (no `file:` or app schemes).
#[tauri::command]
pub async fn open_url(app: AppHandle, url: String) -> CommandResult<()> {
    let allowed = ["https://", "http://", "mailto:"]
        .iter()
        .any(|scheme| url.to_ascii_lowercase().starts_with(scheme));
    if !allowed {
        return Err(format!("not a web or mail link: {url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Writes a note whose file was deleted outside the app back to disk.
#[tauri::command]
pub async fn restore_note(
    open: State<'_, OpenVault>,
    id: Uuid,
    folder: String,
    text: String,
) -> CommandResult<NoteSummary> {
    with_vault(&open, |vault| vault.restore_note(id, &folder, &text))
}
