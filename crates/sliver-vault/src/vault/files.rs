//! Files that aren't notes (assets: images, data, PDFs, ...), the paths that
//! point at them, and picking up changes made to the vault outside the app.
//!
//! Notes refer to assets by vault-absolute path (`#image("/Projects/a.png")`),
//! so moving a note breaks nothing, while moving or renaming an asset (or a
//! folder holding one) rewrites the string literals naming it in notes,
//! preambles and templates.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;
use uuid::Uuid;

use super::{
    DeleteMode, LinkEdits, NoteSummary, Result, Vault, VaultError, folder_name, join_folder,
    parent_folder, remove_path, valid_name,
};
use crate::links::WikiLink;
use crate::paths::{path_edits, rewrite_paths};
use crate::preambles::{PREAMBLES_DIR, TEMPLATES_DIR};

/// When a file last changed, and its size: enough to tell whether it needs
/// rereading.
pub(super) type Stamp = (Option<SystemTime>, u64);

pub(super) fn stamp_of(meta: &fs::Metadata) -> Stamp {
    (meta.modified().ok(), meta.len())
}

pub(super) fn hash_text(text: &str) -> u64 {
    let mut state = DefaultHasher::new();
    text.hash(&mut state);
    state.finish()
}

/// The index as it was before a rescan, for reusing unchanged notes.
#[derive(Default)]
pub(super) struct Previous {
    pub notes: HashMap<Uuid, NoteSummary>,
    pub links: HashMap<Uuid, Vec<WikiLink>>,
    pub citations: HashMap<Uuid, BTreeSet<String>>,
    pub stamps: HashMap<Uuid, Stamp>,
    pub hashes: HashMap<Uuid, u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AssetNode {
    pub name: String,
    /// Relative to the vault root, `/`-separated.
    pub path: String,
}

/// What a rescan found changed on disk since the index last saw it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct DiskChanges {
    /// Notes whose text changed.
    pub changed: Vec<Uuid>,
    /// Notes whose file is gone.
    pub removed: Vec<Uuid>,
    /// Assets added, changed or removed, as vault paths.
    pub assets: Vec<String>,
    /// Whether the sidebar tree changed.
    pub tree: bool,
    /// Whether a preamble changed.
    pub preambles: bool,
}

impl DiskChanges {
    pub fn is_empty(&self) -> bool {
        self.changed.is_empty()
            && self.removed.is_empty()
            && self.assets.is_empty()
            && !self.tree
            && !self.preambles
    }
}

/// Where an asset or folder went, and the notes whose paths were rewritten.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Moved {
    pub path: String,
    pub changed: Vec<Uuid>,
}

/// What moving a path would rewrite, for a confirmation prompt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PathPlan {
    pub notes: Vec<LinkEdits>,
    /// Preambles and templates, as vault paths.
    pub files: Vec<String>,
}

impl Vault {
    /// Rescans the vault for changes made outside the app (another editor,
    /// sync, git), rereading only files whose stamp changed, and updates the
    /// index. Changes the app made itself aren't reported.
    pub fn refresh(&mut self) -> Result<DiskChanges> {
        let tree_before = self.tree();
        let assets_before = std::mem::take(&mut self.assets);
        let mut previous = Previous {
            notes: std::mem::take(&mut self.notes),
            links: std::mem::take(&mut self.links),
            citations: std::mem::take(&mut self.citations),
            stamps: std::mem::take(&mut self.stamps),
            hashes: std::mem::take(&mut self.hashes),
        };
        self.folders.clear();
        self.zettelkasten = None;
        self.extra_zettelkasten.clear();
        self.duplicates.clear();
        let root = self.root.clone();
        self.scan(&root, "", &mut previous)?;
        self.scan_kinds()?;
        self.reference_keys = crate::citations::bib_entries(&self.references()?)
            .into_iter()
            .map(|e| e.key.to_owned())
            .collect();

        let mut changed: Vec<Uuid> = self
            .hashes
            .iter()
            .filter(|(id, hash)| previous.hashes.get(id).is_some_and(|old| old != *hash))
            .map(|(id, _)| *id)
            .collect();
        changed.sort();
        let mut removed: Vec<Uuid> = previous
            .hashes
            .keys()
            .filter(|id| !self.notes.contains_key(id))
            .copied()
            .collect();
        removed.sort();
        let assets: Vec<String> = assets_before
            .keys()
            .chain(self.assets.keys())
            .filter(|path| assets_before.get(*path) != self.assets.get(*path))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .cloned()
            .collect();
        let digest = self.digest_preambles();
        let preambles = digest != self.preambles_digest;
        self.preambles_digest = digest;
        Ok(DiskChanges {
            changed,
            removed,
            assets,
            tree: self.tree() != tree_before,
            preambles,
        })
    }

    /// A hash of every preamble's text.
    pub(super) fn digest_preambles(&self) -> u64 {
        let mut state = DefaultHasher::new();
        for path in self.files_under(PREAMBLES_DIR) {
            path.hash(&mut state);
            fs::read(self.root.join(&path)).ok().hash(&mut state);
        }
        state.finish()
    }

    /// Vault paths of the `.typ` files directly in `dir` and in its `kinds/`.
    fn files_under(&self, dir: &str) -> Vec<String> {
        let mut out = Vec::new();
        for dir in [dir.to_owned(), format!("{dir}/kinds")] {
            let Ok(entries) = fs::read_dir(self.root.join(&dir)) else {
                continue;
            };
            let mut names: Vec<String> = entries
                .filter_map(|e| e.ok()?.file_name().into_string().ok())
                .filter(|name| name.ends_with(".typ"))
                .collect();
            names.sort();
            out.extend(names.into_iter().map(|name| format!("{dir}/{name}")));
        }
        out
    }

    pub(super) fn assets_in(&self, folder: &str) -> Vec<AssetNode> {
        let mut assets: Vec<AssetNode> = self
            .assets
            .keys()
            .filter(|path| parent_folder(path) == folder)
            .map(|path| AssetNode {
                name: folder_name(path).to_owned(),
                path: path.clone(),
            })
            .collect();
        assets.sort_by_key(|a| (a.name.to_lowercase(), a.name.clone()));
        assets
    }

    /// A vault path (`a/b.png`, a leading slash allowed) as a path on disk,
    /// if it names something inside the vault.
    fn vault_file(&self, path: &str) -> Result<PathBuf> {
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        if parts
            .iter()
            .any(|p| p.is_empty() || *p == "." || *p == "..")
        {
            return Err(VaultError::FileNotFound(path.to_owned()));
        }
        Ok(parts
            .iter()
            .fold(self.root.clone(), |dir, part| dir.join(part)))
    }

    /// Any file in the vault by its vault path, e.g. for the compiler.
    pub fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        let file = self.vault_file(path)?;
        fs::read(&file).map_err(|err| match err.kind() {
            std::io::ErrorKind::NotFound => VaultError::FileNotFound(path.to_owned()),
            _ => err.into(),
        })
    }

    /// Where asset `path` is on disk, e.g. to open it in another app.
    pub fn asset_file(&self, path: &str) -> Result<PathBuf> {
        self.require_asset(path)?;
        self.vault_file(path)
    }

    fn require_asset(&self, path: &str) -> Result<()> {
        if self.assets.contains_key(path) {
            Ok(())
        } else {
            Err(VaultError::FileNotFound(path.to_owned()))
        }
    }

    /// `name`, or `name 1`, `name 2`, ... (before the extension), whichever
    /// is free in `folder`.
    fn free_name(&self, folder: &str, name: &str) -> String {
        let dir = self.folder_dir(folder);
        let (stem, extension) = match name.rsplit_once('.') {
            Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
            _ => (name, String::new()),
        };
        (0..)
            .map(|i| match i {
                0 => name.to_owned(),
                i => format!("{stem} {i}{extension}"),
            })
            .find(|candidate| !dir.join(candidate).exists())
            .expect("some name is free")
    }

    /// Creates `folder` and any missing parents.
    fn ensure_folder(&mut self, folder: &str) -> Result<()> {
        if folder.is_empty() || self.folders.contains(folder) {
            return Ok(());
        }
        for part in folder.split('/') {
            if !valid_name(part) {
                return Err(VaultError::InvalidFolderName(part.to_owned()));
            }
        }
        if let Some(zk) = &self.zettelkasten
            && folder.starts_with(&format!("{zk}/"))
        {
            return Err(VaultError::Refused(
                "the Zettelkasten can't contain folders".into(),
            ));
        }
        fs::create_dir_all(self.folder_dir(folder))?;
        let mut path = String::new();
        for part in folder.split('/') {
            path = join_folder(&path, part);
            self.folders.insert(path.clone());
        }
        Ok(())
    }

    /// Writes a new asset called `name` (or `name 1`, ... if taken) into
    /// `folder`, created if missing, and returns its vault path.
    pub fn add_asset(&mut self, folder: &str, name: &str, bytes: &[u8]) -> Result<String> {
        if !valid_name(name) {
            return Err(VaultError::InvalidFileName(name.to_owned()));
        }
        self.ensure_folder(folder)?;
        let name = self.free_name(folder, name);
        let file = self.folder_dir(folder).join(&name);
        self.atomic_write(&file, bytes)?;
        let path = join_folder(folder, &name);
        self.assets
            .insert(path.clone(), stamp_of(&fs::metadata(&file)?));
        Ok(path)
    }

    /// Copies the file at `source` (outside the vault, say) into `folder`.
    pub fn import_asset(&mut self, folder: &str, source: &Path) -> Result<String> {
        if !source.is_file() {
            return Err(VaultError::Refused("only files can be added".into()));
        }
        let name = source
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| VaultError::InvalidFileName(source.display().to_string()))?;
        let bytes = fs::read(source)?;
        self.add_asset(folder, name, &bytes)
    }

    /// What moving `from` (an asset or a folder) to `to` would rewrite.
    pub fn plan_path_move(&self, from: &str, to: &str) -> Result<PathPlan> {
        let mut notes: Vec<LinkEdits> = self
            .notes
            .keys()
            .filter_map(|&id| {
                let count = path_edits(&self.read_note(id).ok()?, from, to).len();
                (count > 0).then_some(LinkEdits { id, count })
            })
            .collect();
        notes.sort_by_key(|e| e.id);
        let files = self
            .code_files()
            .into_iter()
            .filter(|path| {
                fs::read_to_string(self.root.join(path))
                    .is_ok_and(|text| !path_edits(&text, from, to).is_empty())
            })
            .collect();
        Ok(PathPlan { notes, files })
    }

    /// Preambles and templates: Typst code outside notes that may name paths.
    fn code_files(&self) -> Vec<String> {
        let mut files = self.files_under(PREAMBLES_DIR);
        files.extend(self.files_under(TEMPLATES_DIR));
        files
    }

    /// Rewrites every path naming `from` (or something under it) to `to`, in
    /// notes, preambles and templates. Returns the notes changed.
    pub(super) fn rewrite_paths(&mut self, from: &str, to: &str) -> Result<Vec<Uuid>> {
        let mut ids: Vec<Uuid> = self.notes.keys().copied().collect();
        ids.sort();
        let mut changed = Vec::new();
        for id in ids {
            if let Some(text) = rewrite_paths(&self.read_note(id)?, from, to) {
                self.write_note(id, &text)?;
                changed.push(id);
            }
        }
        for path in self.code_files() {
            let file = self.root.join(&path);
            if let Ok(text) = fs::read_to_string(&file)
                && let Some(text) = rewrite_paths(&text, from, to)
            {
                self.atomic_write(&file, text.as_bytes())?;
            }
        }
        self.preambles_digest = self.digest_preambles();
        Ok(changed)
    }

    fn relocate_asset(&mut self, path: &str, to: String) -> Result<Moved> {
        self.require_asset(path)?;
        if to == path {
            return Ok(Moved {
                path: to,
                changed: Vec::new(),
            });
        }
        let target = self.vault_file(&to)?;
        // A rename that only changes case finds the file itself.
        if target.exists() && to.to_lowercase() != path.to_lowercase() {
            return Err(VaultError::FileExists(folder_name(&to).to_owned()));
        }
        fs::rename(self.vault_file(path)?, &target)?;
        self.assets.remove(path);
        self.assets
            .insert(to.clone(), stamp_of(&fs::metadata(&target)?));
        let changed = self.rewrite_paths(path, &to)?;
        Ok(Moved { path: to, changed })
    }

    pub fn rename_asset(&mut self, path: &str, name: &str) -> Result<Moved> {
        if !valid_name(name) {
            return Err(VaultError::InvalidFileName(name.to_owned()));
        }
        self.relocate_asset(path, join_folder(parent_folder(path), name))
    }

    pub fn move_asset(&mut self, path: &str, folder: &str) -> Result<Moved> {
        self.require_folder(folder)?;
        self.relocate_asset(path, join_folder(folder, folder_name(path)))
    }

    pub fn delete_asset(&mut self, path: &str, mode: DeleteMode) -> Result<()> {
        self.require_asset(path)?;
        remove_path(&self.vault_file(path)?, mode)?;
        self.assets.remove(path);
        Ok(())
    }

    /// Writes note `id` back into `folder` after its file was deleted
    /// outside the app while it had unsaved edits.
    pub fn restore_note(&mut self, id: Uuid, folder: &str, text: &str) -> Result<NoteSummary> {
        if self.notes.contains_key(&id) {
            return self.write_note(id, text);
        }
        let folder = if self.folders.contains(folder) {
            folder
        } else {
            ""
        };
        self.write_file(id, folder, text)
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::TempDir;
    use super::*;

    #[test]
    fn assets_are_listed_moved_and_rewritten() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        let a = vault.add_asset("Images", "logo.png", b"png").unwrap();
        assert_eq!(a, "Images/logo.png");
        assert_eq!(
            vault.add_asset("Images", "logo.png", b"png").unwrap(),
            "Images/logo 1.png"
        );
        let tree = vault.tree();
        let images = tree.folders.iter().find(|f| f.path == "Images").unwrap();
        assert_eq!(
            images
                .assets
                .iter()
                .map(|a| a.name.as_str())
                .collect::<Vec<_>>(),
            ["logo 1.png", "logo.png"]
        );

        let note = vault
            .create_note_of_kind(
                Some("A".into()),
                crate::Placement::Unaddressed {
                    folder: String::new(),
                },
                None,
                "#image(\"/Images/logo.png\")\n",
            )
            .unwrap();
        let plan = vault.plan_path_move("Images", "Pictures").unwrap();
        assert_eq!(
            plan.notes,
            vec![LinkEdits {
                id: note.id,
                count: 1
            }]
        );

        let moved = vault.rename_folder("Images", "Pictures").unwrap();
        assert_eq!(moved.changed, vec![note.id]);
        assert!(
            vault
                .read_note(note.id)
                .unwrap()
                .contains("\"/Pictures/logo.png\"")
        );
        let moved = vault.rename_asset("Pictures/logo.png", "mark.png").unwrap();
        assert_eq!(moved.path, "Pictures/mark.png");
        assert!(
            vault
                .read_note(note.id)
                .unwrap()
                .contains("\"/Pictures/mark.png\"")
        );
        assert_eq!(vault.read_file("/Pictures/mark.png").unwrap(), b"png");
        assert!(vault.read_file("/../outside").is_err());
    }

    #[test]
    fn refresh_reports_only_outside_changes() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        let note = vault
            .create_note_of_kind(
                Some("A".into()),
                crate::Placement::Unaddressed {
                    folder: String::new(),
                },
                None,
                "",
            )
            .unwrap();
        vault
            .write_note(note.id, "#metadata((title: \"B\",)) <note>\n")
            .unwrap();
        assert!(vault.refresh().unwrap().is_empty());

        let file = dir.0.join(format!("{}.typ", note.id));
        fs::write(&file, "#metadata((title: \"C\",)) <note>\nchanged").unwrap();
        fs::write(dir.0.join("data.csv"), "a,b").unwrap();
        let changes = vault.refresh().unwrap();
        assert_eq!(changes.changed, vec![note.id]);
        assert_eq!(changes.assets, vec!["data.csv".to_owned()]);
        assert!(changes.tree);
        assert_eq!(vault.note(note.id).unwrap().title.as_deref(), Some("C"));

        fs::remove_file(&file).unwrap();
        let changes = vault.refresh().unwrap();
        assert_eq!(changes.removed, vec![note.id]);
    }
}
