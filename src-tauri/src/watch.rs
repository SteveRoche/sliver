//! Watches the open vault for changes made outside the app (another editor,
//! Finder, sync, git) and tells the webview what changed (`vault-changed`).
//! The app's own writes cause events too; `Vault::refresh` finds those
//! unchanged and they aren't reported.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::{OpenVault, lock};

/// The watcher of the open vault; replacing it stops the old one.
#[derive(Default)]
pub struct VaultWatcher(Mutex<Option<Debouncer<RecommendedWatcher, RecommendedCache>>>);

const DEBOUNCE: Duration = Duration::from_millis(300);

pub fn watch(app: &AppHandle, root: &Path) {
    // Events carry canonical paths (`/private/var/...` on macOS).
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let handle = app.clone();
    let watched = root.clone();
    let watcher = new_debouncer(DEBOUNCE, None, move |result: DebounceEventResult| {
        let Ok(events) = result else { return };
        if events
            .iter()
            .flat_map(|event| &event.paths)
            .any(|path| relevant(&watched, path))
        {
            refresh(&handle, &watched);
        }
    })
    .and_then(|mut debouncer| {
        debouncer.watch(&root, RecursiveMode::Recursive)?;
        Ok(debouncer)
    })
    .inspect_err(|err| eprintln!("could not watch {}: {err}", root.display()))
    .ok();
    *app.state::<VaultWatcher>()
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = watcher;
}

/// Notes, folders and assets (nothing hidden), Zettelkasten markers and
/// preambles; not the rest of `.sliver/` (temp files, packages, the
/// workspace), which only the app writes.
fn relevant(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let parts: Vec<&str> = relative
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    match parts.as_slice() {
        [] => false,
        [".sliver", "preambles", ..] => true,
        [.., ".zettelkasten"] => !parts[..parts.len() - 1].iter().any(|p| p.starts_with('.')),
        parts => !parts.iter().any(|p| p.starts_with('.')),
    }
}

fn refresh(app: &AppHandle, root: &PathBuf) {
    let open = app.state::<OpenVault>();
    let changes = {
        let mut guard = lock(&open);
        let Some(vault) = guard.as_mut() else { return };
        let current = vault.root().canonicalize().ok();
        if current.as_ref() != Some(root) {
            return;
        }
        match vault.refresh() {
            Ok(changes) => changes,
            Err(err) => {
                eprintln!("could not rescan the vault: {err}");
                return;
            }
        }
    };
    if !changes.is_empty() {
        let _ = app.emit("vault-changed", changes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_hidden_and_app_files() {
        let root = Path::new("/v");
        let yes = |p: &str| relevant(root, Path::new(p));
        assert!(yes("/v/Inbox/a.typ"));
        assert!(yes("/v/Zettelkasten/.zettelkasten"));
        assert!(yes("/v/.sliver/preambles/common.typ"));
        assert!(!yes("/v/.sliver/workspace.json"));
        assert!(!yes("/v/.git/index"));
        assert!(!yes("/v/a/.DS_Store"));
        assert!(!yes("/elsewhere/a.typ"));
    }
}
