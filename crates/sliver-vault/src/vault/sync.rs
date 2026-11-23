//! Syncing a vault with the user's other devices, minus the networking: what
//! the vault holds as entries (the manifest), the plan for one round against
//! the state both sides last agreed on (the base), merging notes, and
//! applying a round's changes to the files.
//!
//! The model is state based, like Unison: each device keeps a base per paired
//! device, and an entry that differs from the base changed on that side. An
//! entry missing on one side but in the base was deleted there, so deletes
//! need no tombstones. Only the device that dials decides a round; both then
//! record the same base.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{
    DeleteMode, DiskChanges, META_DIR, Result, Vault, VaultError, ZETTELKASTEN_MARKER,
    atomic_write_in, join_folder, note_id, parent_folder, remove_path, valid_name,
};
use crate::header::{read_header, set_address, set_title};

const SYNC_DIR: &str = ".sliver/sync";
const CONFIG_FILE: &str = ".sliver/sync/config.json";
const CACHE_FILE: &str = ".sliver/sync/local.json";
const BASE_DIR: &str = ".sliver/sync/base";
const TEXTS_DIR: &str = ".sliver/sync/texts";

/// Directories under `.sliver/` whose files sync (recursively).
const SYNCED_META_DIRS: &[&str] = &["preambles", "templates", "styles"];
/// Single files under `.sliver/` that sync.
const SYNCED_META_FILES: &[&str] = &["settings.json", "references.bib"];

/// An entry's state on one side: a note (`note:<uuid>`, with its folder), a
/// file (`file:<path>`) or a folder (`dir:<path>`, no hash).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntryState {
    /// blake3 of the content, hex; empty for folders.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub hash: String,
    /// A note's folder (`""` for the vault root).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

/// Every synced entry of a vault, by key.
pub type Manifest = BTreeMap<String, EntryState>;

/// A change for one side to make. It's skipped when the entry no longer is
/// as `expected` (the side's manifest at the start of the round), since it
/// was edited meanwhile; the next round settles it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Op {
    pub key: String,
    pub expected: Option<EntryState>,
    /// The new state, or `None` to delete.
    pub state: Option<EntryState>,
}

impl Op {
    /// Whether the op carries the content (else it's a move, a delete or a
    /// folder).
    pub fn needs_body(&self) -> bool {
        match &self.state {
            Some(state) if !state.hash.is_empty() => {
                self.expected.as_ref().map(|e| &e.hash) != Some(&state.hash)
            }
            _ => false,
        }
    }
}

/// The per-vault sync setup: the vault's id (shared by its paired devices)
/// and the devices it syncs with. Never synced itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    pub vault: Uuid,
    pub peers: Vec<SyncPeer>,
    /// Set while this device has only just joined, until its first round
    /// (see `plan`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub joining: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPeer {
    /// The device's endpoint id.
    pub id: String,
    pub name: String,
    /// Unix milliseconds.
    pub paired_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync: Option<u64>,
}

/// The sync setup of the vault at `root`, if it has one.
pub fn sync_config(root: &Path) -> Result<Option<SyncConfig>> {
    match fs::read_to_string(root.join(CONFIG_FILE)) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| VaultError::Refused(format!("unreadable sync settings: {e}"))),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

pub fn save_sync_config(root: &Path, config: &SyncConfig) -> Result<()> {
    let text = serde_json::to_string_pretty(config).expect("serializable");
    atomic_write_in(root, &root.join(CONFIG_FILE), text.as_bytes())
}

/// Forgets a device's base, after it's unpaired.
pub fn forget_peer(root: &Path, peer: &str) -> Result<()> {
    match fs::remove_file(base_file(root, peer)) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.into()),
        _ => Ok(()),
    }
}

/// Prepares an empty folder to receive a vault from another device: just
/// `.sliver/`, so the first round brings everything else (a new vault's
/// starter files would otherwise compete with the other device's).
pub fn prepare_join(root: &Path, config: &SyncConfig) -> Result<()> {
    if root.exists() && fs::read_dir(root)?.next().is_some() {
        return Err(VaultError::NotEmpty(root.to_path_buf()));
    }
    fs::create_dir_all(root.join(SYNC_DIR))?;
    save_sync_config(root, config)
}

fn base_file(root: &Path, peer: &str) -> PathBuf {
    root.join(BASE_DIR).join(format!("{peer}.json"))
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// What a key names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Key<'a> {
    Note(Uuid),
    File(&'a str),
    Dir(&'a str),
}

fn parse_key(key: &str) -> Option<Key<'_>> {
    let (kind, rest) = key.split_once(':')?;
    match kind {
        "note" => Uuid::parse_str(rest).ok().map(Key::Note),
        "file" if synced_file(rest) => Some(Key::File(rest)),
        "dir" if valid_folder(rest) && !rest.is_empty() => Some(Key::Dir(rest)),
        _ => None,
    }
}

/// A folder path of valid names (`""` is the root).
fn valid_folder(folder: &str) -> bool {
    folder.is_empty() || folder.split('/').all(valid_name)
}

/// Whether a vault path is a file that syncs: anything not hidden except
/// notes (keyed by uuid), Zettelkasten markers, and the shared parts of
/// `.sliver/`. Remote keys are checked with this, so a device can't write
/// outside the vault or into the rest of `.sliver/`.
fn synced_file(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    if parts
        .iter()
        .any(|p| p.is_empty() || *p == "." || *p == ".." || p.contains('\\'))
    {
        return false;
    }
    match parts.as_slice() {
        [META_DIR, dir, rest @ ..] if SYNCED_META_DIRS.contains(dir) && !rest.is_empty() => {
            rest.iter().all(|p| !p.starts_with('.'))
        }
        [META_DIR, file] => SYNCED_META_FILES.contains(file),
        [folders @ .., last] => {
            folders.iter().all(|p| valid_name(p))
                && (*last == ZETTELKASTEN_MARKER && !folders.is_empty() || valid_name(last))
                && note_id(Path::new(last)).is_none()
        }
        [] => false,
    }
}

/// Whether a change at a vault path (`/`-separated) may need syncing:
/// notes, folders and assets (nothing hidden) and the synced files.
pub fn affects_sync(path: &str) -> bool {
    !path.is_empty() && (plain_asset(path) || synced_file(path))
}

/// A file that isn't hidden and isn't in `.sliver/`: a conflict leaves a copy
/// beside it. Hidden ones (markers, settings, preambles) keep the local
/// version instead, since a copy would be ignored.
fn plain_asset(path: &str) -> bool {
    !path.split('/').any(|p| p.starts_with('.'))
}

/// `path` as a file on disk under `root` (checked by the caller).
fn disk_path(root: &Path, path: &str) -> PathBuf {
    path.split('/')
        .fold(root.to_path_buf(), |dir, p| dir.join(p))
}

/// The hashes of files as last hashed, by vault path, so a manifest only
/// rehashes files whose stamp changed.
#[derive(Default, Serialize, Deserialize)]
struct HashCache(BTreeMap<String, (u128, u64, String)>);

impl HashCache {
    fn load(root: &Path) -> Self {
        fs::read_to_string(root.join(CACHE_FILE))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn hash(&self, fresh: &mut Self, path: &str, file: &Path) -> Result<String> {
        let meta = fs::metadata(file)?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos());
        let hash = match self.0.get(path) {
            Some((m, size, hash)) if *m == modified && *size == meta.len() && modified != 0 => {
                hash.clone()
            }
            _ => hash_bytes(&fs::read(file)?),
        };
        fresh
            .0
            .insert(path.to_owned(), (modified, meta.len(), hash.clone()));
        Ok(hash)
    }
}

/// What the dialing side decided for one entry, before any content moves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Both sides have it the same (or both lack it): only the base changes.
    Agree,
    /// The local state wins; the other side takes it.
    Local,
    /// The remote state wins.
    Remote,
    /// A note both sides kept, combined: its content from one side or merged,
    /// its folder as given.
    Note { content: Source, folder: String },
    /// A file both sides changed differently: local wins, and a plain asset
    /// gets the remote version as a copy beside it.
    ConflictFile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Local,
    Remote,
    Merge,
}

/// Decides each entry of a round from the base and both manifests.
/// `joining`: this device has only just received the vault, so what both
/// sides have without a base (starter files a vault gets on open) is the
/// other side's.
pub fn plan(
    base: &Manifest,
    local: &Manifest,
    remote: &Manifest,
    joining: bool,
) -> BTreeMap<String, Decision> {
    let keys: BTreeSet<&String> = base
        .keys()
        .chain(local.keys())
        .chain(remote.keys())
        .collect();
    keys.into_iter()
        .filter(|key| parse_key(key).is_some())
        .map(|key| {
            let (b, l, r) = (base.get(key), local.get(key), remote.get(key));
            let decision = if joining && b.is_none() && l.is_some() && r.is_some() && l != r {
                Decision::Remote
            } else {
                decide(key, b, l, r)
            };
            (key.clone(), decision)
        })
        .collect()
}

fn decide(
    key: &str,
    base: Option<&EntryState>,
    local: Option<&EntryState>,
    remote: Option<&EntryState>,
) -> Decision {
    if local == remote {
        return Decision::Agree;
    }
    let (Some(l), Some(r)) = (local, remote) else {
        // One side lacks it: a delete if the other side left it as it was,
        // else (or if it's new) the side that has it wins: an edit beats a
        // delete.
        let other = local.or(remote);
        let has_local = local.is_some();
        return if base.is_some() && base == other {
            if has_local {
                Decision::Remote
            } else {
                Decision::Local
            }
        } else if has_local {
            Decision::Local
        } else {
            Decision::Remote
        };
    };
    let local_changed = base != Some(l);
    let remote_changed = base != Some(r);
    if !remote_changed {
        return Decision::Local;
    }
    if !local_changed {
        return Decision::Remote;
    }
    if !key.starts_with("note:") {
        return Decision::ConflictFile;
    }
    let base_hash = base.map(|b| &b.hash);
    let base_folder = base.and_then(|b| b.folder.as_ref());
    let content = if l.hash == r.hash || Some(&r.hash) == base_hash {
        Source::Local
    } else if Some(&l.hash) == base_hash {
        Source::Remote
    } else {
        Source::Merge
    };
    // Both moved it: the dialing side's folder wins.
    let folder = if r.folder.as_ref() == base_folder || l.folder.as_ref() != base_folder {
        l.folder.clone()
    } else {
        r.folder.clone()
    };
    let folder = folder.unwrap_or_default();
    match content {
        Source::Local if Some(&folder) == l.folder.as_ref() => Decision::Local,
        Source::Remote if Some(&folder) == r.folder.as_ref() => Decision::Remote,
        content => Decision::Note { content, folder },
    }
}

/// The keys whose remote content a round needs, given its decisions.
pub fn needed_bodies(
    decisions: &BTreeMap<String, Decision>,
    local: &Manifest,
    remote: &Manifest,
) -> Vec<String> {
    decisions
        .iter()
        .filter(|(key, decision)| {
            let Some(r) = remote.get(*key) else {
                return false;
            };
            if r.hash.is_empty() {
                return false;
            }
            match decision {
                Decision::Remote => local.get(*key).map(|l| &l.hash) != Some(&r.hash),
                Decision::Note { content, .. } => *content != Source::Local,
                Decision::ConflictFile => plain_asset(key.trim_start_matches("file:")),
                Decision::Agree | Decision::Local => false,
            }
        })
        .map(|(key, _)| key.clone())
        .collect()
}

/// A round's changes, worked out by the dialing side once it has the remote
/// content it asked for.
#[derive(Debug, Default)]
pub struct Round {
    /// For this side to apply, with content where `needs_body`.
    pub local: Vec<(Op, Option<Vec<u8>>)>,
    /// For the other side.
    pub remote: Vec<(Op, Option<Vec<u8>>)>,
    /// The new base of each decided key, recorded by both sides unless that
    /// key's op failed on either.
    pub base: BTreeMap<String, Option<EntryState>>,
}

/// A note text that both sides changed and that couldn't be merged, as a
/// note of its own: titled as a conflict copy and without an address, which
/// the kept note has.
fn conflict_copy(text: &str, device: &str) -> String {
    let title = read_header(text)
        .ok()
        .flatten()
        .and_then(|h| h.title)
        .unwrap_or_else(|| "Untitled".to_owned());
    let text = set_title(text, &format!("{title} (conflict, {device})"))
        .unwrap_or_else(|_| text.to_owned());
    set_address(&text, None).unwrap_or(text)
}

/// A free name beside `path` for a conflict copy: `a (conflict, Laptop).png`.
fn conflict_path(path: &str, device: &str, taken: &dyn Fn(&str) -> bool) -> String {
    let device: String = device
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let folder = parent_folder(path);
    let name = super::folder_name(path);
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    (1..)
        .map(|n| {
            let suffix = if n == 1 {
                String::new()
            } else {
                format!(" {n}")
            };
            join_folder(
                folder,
                &format!("{stem} (conflict, {}){suffix}{ext}", device.trim()),
            )
        })
        .find(|candidate| !taken(candidate))
        .expect("an unbounded search finds a free name")
}

impl Vault {
    /// Every synced entry, hashed (rehashing only files whose stamp changed).
    pub fn sync_manifest(&self) -> Result<Manifest> {
        let cache = HashCache::load(&self.root);
        let mut fresh = HashCache::default();
        let mut out = Manifest::new();
        self.walk_sync(&self.root, "", &cache, &mut fresh, &mut out)?;
        for file in SYNCED_META_FILES {
            let path = format!("{META_DIR}/{file}");
            let disk = self.root.join(&path);
            if disk.is_file() {
                let hash = cache.hash(&mut fresh, &path, &disk)?;
                out.insert(format!("file:{path}"), file_state(hash));
            }
        }
        for dir in SYNCED_META_DIRS {
            self.walk_meta(&format!("{META_DIR}/{dir}"), &cache, &mut fresh, &mut out)?;
        }
        if fresh.0 != cache.0 {
            let text = serde_json::to_string(&fresh).expect("serializable");
            atomic_write_in(&self.root, &self.root.join(CACHE_FILE), text.as_bytes())?;
        }
        Ok(out)
    }

    fn walk_sync(
        &self,
        dir: &Path,
        folder: &str,
        cache: &HashCache,
        fresh: &mut HashCache,
        out: &mut Manifest,
    ) -> Result<()> {
        let mut entries: Vec<_> = fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Ok(meta) = entry.metadata() else { continue };
            let path = join_folder(folder, &name);
            if name.starts_with('.') {
                if name == ZETTELKASTEN_MARKER && meta.is_file() && !folder.is_empty() {
                    let hash = cache.hash(fresh, &path, &entry.path())?;
                    out.insert(format!("file:{path}"), file_state(hash));
                }
                continue;
            }
            if meta.is_dir() {
                if valid_name(&name) {
                    out.insert(format!("dir:{path}"), file_state(String::new()));
                    self.walk_sync(&entry.path(), &path, cache, fresh, out)?;
                }
            } else if let Some(id) = note_id(&entry.path()) {
                let key = format!("note:{id}");
                // A duplicate uuid: the first one found syncs.
                if let std::collections::btree_map::Entry::Vacant(slot) = out.entry(key) {
                    let hash = cache.hash(fresh, &path, &entry.path())?;
                    slot.insert(EntryState {
                        hash,
                        folder: Some(folder.to_owned()),
                    });
                }
            } else if synced_file(&path) {
                let hash = cache.hash(fresh, &path, &entry.path())?;
                out.insert(format!("file:{path}"), file_state(hash));
            }
        }
        Ok(())
    }

    fn walk_meta(
        &self,
        dir: &str,
        cache: &HashCache,
        fresh: &mut HashCache,
        out: &mut Manifest,
    ) -> Result<()> {
        let Ok(entries) = fs::read_dir(self.root.join(dir)) else {
            return Ok(());
        };
        let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let path = format!("{dir}/{name}");
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                self.walk_meta(&path, cache, fresh, out)?;
            } else if synced_file(&path) {
                let hash = cache.hash(fresh, &path, &entry.path())?;
                out.insert(format!("file:{path}"), file_state(hash));
            }
        }
        Ok(())
    }

    /// Where an entry's file is on disk; `None` for a key that isn't synced
    /// or a note folder that isn't valid.
    fn entry_path(&self, key: &str, state: Option<&EntryState>) -> Option<PathBuf> {
        match parse_key(key)? {
            Key::Note(id) => {
                let folder = state?.folder.as_deref()?;
                valid_folder(folder).then(|| self.file_path(folder, id))
            }
            Key::File(path) | Key::Dir(path) => Some(disk_path(&self.root, path)),
        }
    }

    /// The content of an entry as `manifest` lists it, if it's still that.
    pub fn read_entry(&self, key: &str, manifest: &Manifest) -> Option<Vec<u8>> {
        let state = manifest.get(key)?;
        let bytes = fs::read(self.entry_path(key, Some(state))?).ok()?;
        (hash_bytes(&bytes) == state.hash).then_some(bytes)
    }

    /// Works out a round from its decisions, both manifests and the remote
    /// content asked for (`needed_bodies`). An entry whose content isn't as
    /// its manifest says any more (either side edited it meanwhile) is left
    /// for the next round. `remote_name` names conflict copies.
    pub fn sync_round(
        &self,
        decisions: &BTreeMap<String, Decision>,
        base: &Manifest,
        local: &Manifest,
        remote: &Manifest,
        bodies: &HashMap<String, Vec<u8>>,
        remote_name: &str,
    ) -> Round {
        let mut round = Round::default();
        let mut taken: BTreeSet<String> = local.keys().chain(remote.keys()).cloned().collect();
        let remote_body = |key: &str| {
            let r = remote.get(key)?;
            bodies
                .get(key)
                .filter(|bytes| hash_bytes(bytes) == r.hash)
                .cloned()
        };
        for (key, decision) in decisions {
            let l = local.get(key);
            let r = remote.get(key);
            match decision {
                Decision::Agree => {
                    round.base.insert(key.clone(), l.cloned());
                }
                Decision::Local => {
                    let op = Op {
                        key: key.clone(),
                        expected: r.cloned(),
                        state: l.cloned(),
                    };
                    let body = if op.needs_body() {
                        match self.read_entry(key, local) {
                            Some(bytes) => Some(bytes),
                            None => continue,
                        }
                    } else {
                        None
                    };
                    round.remote.push((op, body));
                    round.base.insert(key.clone(), l.cloned());
                }
                Decision::Remote => {
                    let op = Op {
                        key: key.clone(),
                        expected: l.cloned(),
                        state: r.cloned(),
                    };
                    let body = if op.needs_body() {
                        match remote_body(key) {
                            Some(bytes) => Some(bytes),
                            None => continue,
                        }
                    } else {
                        None
                    };
                    round.local.push((op, body));
                    round.base.insert(key.clone(), r.cloned());
                }
                Decision::Note { content, folder } => {
                    let (Some(l), Some(r)) = (l, r) else { continue };
                    let Some(local_text) = self.read_entry(key, local) else {
                        continue;
                    };
                    let (hash, bytes) = match content {
                        Source::Local => (l.hash.clone(), local_text),
                        Source::Remote => match remote_body(key) {
                            Some(bytes) => (r.hash.clone(), bytes),
                            None => continue,
                        },
                        Source::Merge => {
                            let Some(remote_text) = remote_body(key) else {
                                continue;
                            };
                            let ancestor = base
                                .get(key)
                                .and_then(|b| self.base_text(&b.hash))
                                .unwrap_or_default();
                            let ours = String::from_utf8_lossy(&local_text);
                            let theirs = String::from_utf8_lossy(&remote_text);
                            match diffy::merge(&ancestor, &ours, &theirs) {
                                Ok(merged) => (hash_bytes(merged.as_bytes()), merged.into_bytes()),
                                Err(_) => {
                                    let copy = conflict_copy(&theirs, remote_name);
                                    let id = Uuid::new_v4();
                                    let state = EntryState {
                                        hash: hash_bytes(copy.as_bytes()),
                                        folder: Some(folder.clone()),
                                    };
                                    let copy_key = format!("note:{id}");
                                    let op = Op {
                                        key: copy_key.clone(),
                                        expected: None,
                                        state: Some(state.clone()),
                                    };
                                    let bytes = copy.into_bytes();
                                    round.local.push((op.clone(), Some(bytes.clone())));
                                    round.remote.push((op, Some(bytes)));
                                    round.base.insert(copy_key, Some(state));
                                    (l.hash.clone(), local_text)
                                }
                            }
                        }
                    };
                    let state = EntryState {
                        hash,
                        folder: Some(folder.clone()),
                    };
                    for (side, current, ops) in [
                        (l, Some(l.clone()), &mut round.local),
                        (r, Some(r.clone()), &mut round.remote),
                    ] {
                        if *side != state {
                            let op = Op {
                                key: key.clone(),
                                expected: current,
                                state: Some(state.clone()),
                            };
                            let body = op.needs_body().then(|| bytes.clone());
                            ops.push((op, body));
                        }
                    }
                    round.base.insert(key.clone(), Some(state));
                }
                Decision::ConflictFile => {
                    let (Some(l), Some(r)) = (l, r) else { continue };
                    let Some(local_bytes) = self.read_entry(key, local) else {
                        continue;
                    };
                    let path = key.trim_start_matches("file:");
                    if plain_asset(path) {
                        let Some(remote_bytes) = remote_body(key) else {
                            continue;
                        };
                        let copy = conflict_path(path, remote_name, &|candidate| {
                            taken.contains(&format!("file:{candidate}"))
                                || taken.contains(&format!("dir:{candidate}"))
                        });
                        let copy_key = format!("file:{copy}");
                        taken.insert(copy_key.clone());
                        let op = Op {
                            key: copy_key.clone(),
                            expected: None,
                            state: Some(r.clone()),
                        };
                        round.local.push((op.clone(), Some(remote_bytes.clone())));
                        round.remote.push((op, Some(remote_bytes)));
                        round.base.insert(copy_key, Some(r.clone()));
                    }
                    let op = Op {
                        key: key.clone(),
                        expected: Some(r.clone()),
                        state: Some(l.clone()),
                    };
                    round.remote.push((op, Some(local_bytes)));
                    round.base.insert(key.clone(), Some(l.clone()));
                }
            }
        }
        round
    }

    /// Applies a round's ops to the files, then rescans so the index (and the
    /// returned changes, for the frontend) include them. Returns the keys of
    /// the ops that weren't applied: the entry changed since its manifest, the
    /// key isn't one that syncs, or a write failed.
    pub fn apply_sync(
        &mut self,
        ops: Vec<(Op, Option<Vec<u8>>)>,
        delete_mode: DeleteMode,
    ) -> Result<(BTreeSet<String>, DiskChanges)> {
        let current = self.sync_manifest()?;
        let mut failed = BTreeSet::new();
        // Folders first (shallowest first), then files and notes, then
        // deletes, folders last (deepest first) once they've emptied.
        let mut ops = ops;
        ops.sort_by_key(|(op, _)| {
            let dir = op.key.starts_with("dir:");
            let depth = op.key.matches('/').count();
            match (&op.state, dir) {
                (Some(_), true) => (0, depth as isize),
                (Some(_), false) => (1, 0),
                (None, false) => (2, 0),
                (None, true) => (3, -(depth as isize)),
            }
        });
        for (op, body) in ops {
            if current.get(&op.key) != op.expected.as_ref()
                || self.apply_op(&op, body, delete_mode).is_err()
            {
                failed.insert(op.key);
            }
        }
        let changes = self.refresh()?;
        Ok((failed, changes))
    }

    fn apply_op(&mut self, op: &Op, body: Option<Vec<u8>>, mode: DeleteMode) -> Result<()> {
        let refused = || VaultError::Refused(format!("not a synced entry: {}", op.key));
        if op.needs_body() != body.is_some() {
            return Err(refused());
        }
        let key = parse_key(&op.key).ok_or_else(refused)?;
        match (&op.state, key) {
            (Some(_), Key::Dir(_)) => {
                fs::create_dir_all(self.entry_path(&op.key, None).ok_or_else(refused)?)?;
            }
            (Some(state), key) => {
                if matches!(key, Key::Note(_)) != state.folder.is_some() {
                    return Err(refused());
                }
                let target = self.entry_path(&op.key, Some(state)).ok_or_else(refused)?;
                let old = op
                    .expected
                    .as_ref()
                    .and_then(|e| self.entry_path(&op.key, Some(e)))
                    .filter(|old| *old != target);
                match body {
                    Some(bytes) => {
                        atomic_write_in(&self.root, &target, &bytes)?;
                        if let Some(old) = old {
                            fs::remove_file(old)?;
                        }
                    }
                    None => {
                        let old = old.ok_or_else(refused)?;
                        if let Some(dir) = target.parent() {
                            fs::create_dir_all(dir)?;
                        }
                        fs::rename(old, target)?;
                    }
                }
            }
            (None, Key::Dir(_)) => {
                let dir = self.entry_path(&op.key, None).ok_or_else(refused)?;
                // Only once empty: a folder the other side deleted may have
                // new notes here, which then go there instead.
                let mut leftovers = fs::read_dir(&dir)?
                    .filter_map(|e| e.ok())
                    .filter(|e| e.file_name() != ".DS_Store");
                if leftovers.next().is_some() {
                    return Err(refused());
                }
                let _ = fs::remove_file(dir.join(".DS_Store"));
                fs::remove_dir(dir)?;
            }
            (None, _) => {
                let path = self
                    .entry_path(&op.key, op.expected.as_ref())
                    .ok_or_else(refused)?;
                if remove_path(&path, mode).is_err() {
                    fs::remove_file(&path)?;
                }
            }
        }
        Ok(())
    }

    /// The base this device shares with `peer`.
    pub fn sync_base(&self, peer: &str) -> Result<Manifest> {
        match fs::read_to_string(base_file(&self.root, peer)) {
            Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_default()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Manifest::new()),
            Err(err) => Err(err.into()),
        }
    }

    /// Records the round's new base with `peer`, except the keys whose ops
    /// failed (on either side), which keep their old base. Note texts in the
    /// base are kept for merging later: from `texts` (the round's content)
    /// or else from the note's file. Texts no base needs any more are removed.
    pub fn record_sync_base(
        &self,
        peer: &str,
        updates: &BTreeMap<String, Option<EntryState>>,
        failed: &BTreeSet<String>,
        texts: &HashMap<String, Vec<u8>>,
    ) -> Result<()> {
        let mut base = self.sync_base(peer)?;
        for (key, state) in updates {
            if failed.contains(key) {
                continue;
            }
            match state {
                Some(state) => {
                    base.insert(key.clone(), state.clone());
                }
                None => {
                    base.remove(key);
                }
            }
        }
        let texts_dir = self.root.join(TEXTS_DIR);
        for (key, state) in base.iter().filter(|(key, _)| key.starts_with("note:")) {
            let file = texts_dir.join(&state.hash);
            if file.exists() {
                continue;
            }
            let bytes = texts.get(&state.hash).cloned().or_else(|| {
                let bytes = fs::read(self.entry_path(key, Some(state))?).ok()?;
                (hash_bytes(&bytes) == state.hash).then_some(bytes)
            });
            if let Some(bytes) = bytes {
                atomic_write_in(&self.root, &file, &bytes)?;
            }
        }
        let text = serde_json::to_string(&base).expect("serializable");
        atomic_write_in(&self.root, &base_file(&self.root, peer), text.as_bytes())?;
        self.collect_texts()
    }

    fn base_text(&self, hash: &str) -> Option<String> {
        if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        fs::read_to_string(self.root.join(TEXTS_DIR).join(hash)).ok()
    }

    /// Removes base texts that no device's base refers to.
    fn collect_texts(&self) -> Result<()> {
        let mut needed = BTreeSet::new();
        if let Ok(entries) = fs::read_dir(self.root.join(BASE_DIR)) {
            for entry in entries.filter_map(|e| e.ok()) {
                let base: Manifest = fs::read_to_string(entry.path())
                    .ok()
                    .and_then(|text| serde_json::from_str(&text).ok())
                    .unwrap_or_default();
                needed.extend(
                    base.into_iter()
                        .filter(|(key, _)| key.starts_with("note:"))
                        .map(|(_, state)| state.hash),
                );
            }
        }
        let Ok(entries) = fs::read_dir(self.root.join(TEXTS_DIR)) else {
            return Ok(());
        };
        for entry in entries.filter_map(|e| e.ok()) {
            if !entry
                .file_name()
                .to_str()
                .is_some_and(|name| needed.contains(name))
            {
                let _ = fs::remove_file(entry.path());
            }
        }
        Ok(())
    }
}

fn file_state(hash: String) -> EntryState {
    EntryState { hash, folder: None }
}

/// What a round changed that the vault index doesn't cover, for the
/// frontend to reload: settings, templates, references, citation styles.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct SyncedFiles {
    pub settings: bool,
    pub templates: bool,
    pub references: bool,
    pub styles: bool,
}

impl SyncedFiles {
    pub fn of<'a>(keys: impl IntoIterator<Item = &'a str>) -> Self {
        let mut out = Self::default();
        for key in keys {
            match key.strip_prefix("file:.sliver/") {
                Some("settings.json") => out.settings = true,
                Some("references.bib") => out.references = true,
                Some(rest) if rest.starts_with("templates/") => out.templates = true,
                Some(rest) if rest.starts_with("styles/") => out.styles = true,
                _ => {}
            }
        }
        out
    }

    pub fn any(&self) -> bool {
        self.settings || self.templates || self.references || self.styles
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::TempDir;
    use super::*;
    use crate::Placement;

    fn state(hash: &str, folder: Option<&str>) -> EntryState {
        EntryState {
            hash: hash.to_owned(),
            folder: folder.map(str::to_owned),
        }
    }

    fn manifest(entries: &[(&str, EntryState)]) -> Manifest {
        entries
            .iter()
            .map(|(k, s)| ((*k).to_owned(), s.clone()))
            .collect()
    }

    const NOTE: &str = "note:00000000-0000-4000-8000-000000000001";

    #[test]
    fn decides_every_case() {
        let a = state("a", Some(""));
        let b = state("b", Some(""));
        let c = state("c", Some(""));
        let d =
            |base: &[(&str, EntryState)], l: &[(&str, EntryState)], r: &[(&str, EntryState)]| {
                plan(&manifest(base), &manifest(l), &manifest(r), false)
                    .remove(NOTE)
                    .unwrap_or(Decision::Agree)
            };
        let n = |s: &EntryState| [(NOTE, s.clone())];
        // Unchanged, and changed alike.
        assert_eq!(d(&n(&a), &n(&a), &n(&a)), Decision::Agree);
        assert_eq!(d(&n(&a), &n(&b), &n(&b)), Decision::Agree);
        // One side changed.
        assert_eq!(d(&n(&a), &n(&a), &n(&b)), Decision::Remote);
        assert_eq!(d(&n(&a), &n(&b), &n(&a)), Decision::Local);
        // New on one side.
        assert_eq!(d(&[], &n(&a), &[]), Decision::Local);
        assert_eq!(d(&[], &[], &n(&a)), Decision::Remote);
        // Deleted on one side, untouched on the other.
        assert_eq!(d(&n(&a), &[], &n(&a)), Decision::Local);
        assert_eq!(d(&n(&a), &n(&a), &[]), Decision::Remote);
        // Deleted on one side, edited on the other: the edit wins.
        assert_eq!(d(&n(&a), &[], &n(&b)), Decision::Remote);
        assert_eq!(d(&n(&a), &n(&b), &[]), Decision::Local);
        // Both edited.
        assert_eq!(
            d(&n(&a), &n(&b), &n(&c)),
            Decision::Note {
                content: Source::Merge,
                folder: String::new()
            }
        );
        // Moved on one side, edited on the other.
        let moved = state("a", Some("Inbox"));
        assert_eq!(
            d(&n(&a), &n(&moved), &n(&b)),
            Decision::Note {
                content: Source::Remote,
                folder: "Inbox".into()
            }
        );
        // Both moved: the local folder wins.
        let elsewhere = state("a", Some("Archive"));
        assert_eq!(d(&n(&a), &n(&moved), &n(&elsewhere)), Decision::Local);
        // Files that both changed conflict.
        let f = |s: &str| [("file:a.png", state(s, None))];
        assert_eq!(
            plan(
                &manifest(&f("a")),
                &manifest(&f("b")),
                &manifest(&f("c")),
                false
            )["file:a.png"],
            Decision::ConflictFile
        );
    }

    #[test]
    fn checks_synced_paths() {
        assert!(synced_file("a.png"));
        assert!(synced_file("Projects/x/data.csv"));
        assert!(synced_file("Zettelkasten/.zettelkasten"));
        assert!(synced_file(".sliver/preambles/kinds/proof.typ"));
        assert!(synced_file(".sliver/settings.json"));
        assert!(!synced_file(".zettelkasten"));
        assert!(!synced_file(".sliver/workspace.json"));
        assert!(!synced_file(".sliver/sync/config.json"));
        assert!(!synced_file(".sliver/pkg/preview/x.tar.gz"));
        assert!(!synced_file("../outside.png"));
        assert!(!synced_file("a/../../b"));
        assert!(!synced_file("/abs.png"));
        assert!(!synced_file(".git/config"));
        assert!(!synced_file("00000000-0000-4000-8000-000000000001.typ"));
    }

    /// Two vaults and a full round between them, run in-process the way the
    /// network side runs it, with `a` dialing `b`.
    fn sync(a: &mut Vault, b: &mut Vault) {
        let id = |v: &Vault| v.root().file_name().unwrap().to_str().unwrap().to_owned();
        let (a_id, b_id) = (id(a), id(b));
        let (a_id, b_id) = (a_id.as_str(), b_id.as_str());
        let base = a.sync_base(b_id).unwrap();
        let local = a.sync_manifest().unwrap();
        let remote = b.sync_manifest().unwrap();
        let decisions = plan(&base, &local, &remote, false);
        let bodies: HashMap<String, Vec<u8>> = needed_bodies(&decisions, &local, &remote)
            .into_iter()
            .filter_map(|key| Some((key.clone(), b.read_entry(&key, &remote)?)))
            .collect();
        let round = a.sync_round(&decisions, &base, &local, &remote, &bodies, "B");
        let texts: HashMap<String, Vec<u8>> = round
            .local
            .iter()
            .chain(&round.remote)
            .filter_map(|(op, body)| Some((op.state.as_ref()?.hash.clone(), body.clone()?)))
            .collect();
        let (mut failed, _) = a.apply_sync(round.local, DeleteMode::Permanent).unwrap();
        let (remote_failed, _) = b.apply_sync(round.remote, DeleteMode::Permanent).unwrap();
        failed.extend(remote_failed);
        b.record_sync_base(a_id, &round.base, &failed, &texts)
            .unwrap();
        a.record_sync_base(b_id, &round.base, &failed, &texts)
            .unwrap();
    }

    fn synced_pair() -> (TempDir, TempDir, Vault, Vault) {
        let (da, db) = (TempDir::new(), TempDir::new());
        let mut a = Vault::create(&da.0).unwrap();
        a.create_note(Some("First".into()), Placement::NewSequence)
            .unwrap();
        a.create_folder("", "Inbox").unwrap();
        fs::write(da.0.join("Inbox/data.csv"), "x,y\n").unwrap();
        a.refresh().unwrap();
        prepare_join(
            &db.0,
            &SyncConfig {
                vault: Uuid::new_v4(),
                peers: vec![],
                joining: true,
            },
        )
        .unwrap();
        let mut b = Vault::open(&db.0).unwrap();
        sync(&mut a, &mut b);
        (da, db, a, b)
    }

    fn same(a: &Vault, b: &Vault) {
        assert_eq!(a.sync_manifest().unwrap(), b.sync_manifest().unwrap());
    }

    #[test]
    fn joining_takes_everything() {
        let (_da, _db, a, b) = synced_pair();
        same(&a, &b);
        assert_eq!(b.tree(), a.tree());
        // A second round has nothing to do.
        let base = a
            .sync_base(b.root().file_name().unwrap().to_str().unwrap())
            .unwrap();
        let decisions = plan(
            &base,
            &a.sync_manifest().unwrap(),
            &b.sync_manifest().unwrap(),
            false,
        );
        assert!(decisions.values().all(|d| *d == Decision::Agree));
    }

    #[test]
    fn joining_keeps_the_other_sides_starter_files() {
        let (da, db) = (TempDir::new(), TempDir::new());
        let mut a = Vault::create(&da.0).unwrap();
        let common = da.0.join(".sliver/preambles/common.typ");
        fs::write(&common, "#let mine = 1\n").unwrap();
        a.refresh().unwrap();
        prepare_join(
            &db.0,
            &SyncConfig {
                vault: Uuid::new_v4(),
                peers: vec![],
                joining: true,
            },
        )
        .unwrap();
        // Opening writes the starter preamble, which mustn't win.
        let mut b = Vault::open(&db.0).unwrap();
        let base = b.sync_base("a").unwrap();
        let (local, remote) = (b.sync_manifest().unwrap(), a.sync_manifest().unwrap());
        let decisions = plan(&base, &local, &remote, true);
        let bodies = needed_bodies(&decisions, &local, &remote)
            .into_iter()
            .filter_map(|key| Some((key.clone(), a.read_entry(&key, &remote)?)))
            .collect();
        let round = b.sync_round(&decisions, &base, &local, &remote, &bodies, "A");
        b.apply_sync(round.local, DeleteMode::Permanent).unwrap();
        a.apply_sync(round.remote, DeleteMode::Permanent).unwrap();
        same(&a, &b);
        assert_eq!(
            fs::read_to_string(db.0.join(".sliver/preambles/common.typ")).unwrap(),
            "#let mine = 1\n"
        );
    }

    #[test]
    fn edits_moves_and_deletes_both_ways() {
        let (_da, db, mut a, mut b) = synced_pair();
        let id = a.notes.keys().next().copied().unwrap();
        // b edits and moves, a adds a note and deletes the asset.
        let text = b.read_note(id).unwrap() + "\nMore.\n";
        b.write_note(id, &text).unwrap();
        b.move_to_folder(id, "Inbox").unwrap();
        let new = a
            .create_note(Some("Second".into()), Placement::NewSequence)
            .unwrap();
        a.delete_asset("Inbox/data.csv", DeleteMode::Permanent)
            .unwrap();
        // b is the one dialing this time.
        sync(&mut b, &mut a);
        same(&a, &b);
        assert!(a.read_note(id).unwrap().ends_with("More.\n"));
        assert_eq!(a.note(id).unwrap().folder, "Inbox");
        assert!(b.note(new.id).is_ok());
        assert!(!db.0.join("Inbox/data.csv").exists());
    }

    #[test]
    fn merges_or_copies_concurrent_edits() {
        let (_da, _db, mut a, mut b) = synced_pair();
        let id = a.notes.keys().next().copied().unwrap();
        let text = a.read_note(id).unwrap() + "\none\n\ntwo\n\nthree\n";
        a.write_note(id, &text).unwrap();
        sync(&mut a, &mut b);
        // Different lines merge.
        a.write_note(id, &text.replace("one", "ONE")).unwrap();
        b.write_note(id, &text.replace("three", "THREE")).unwrap();
        sync(&mut a, &mut b);
        same(&a, &b);
        let merged = a.read_note(id).unwrap();
        assert!(merged.contains("ONE") && merged.contains("THREE"));
        // The same line conflicts: local stays, remote becomes a copy.
        a.write_note(id, &merged.replace("two", "a's")).unwrap();
        b.write_note(id, &merged.replace("two", "b's")).unwrap();
        sync(&mut a, &mut b);
        same(&a, &b);
        assert!(b.read_note(id).unwrap().contains("a's"));
        let copy = a
            .notes
            .values()
            .find(|n| n.id != id)
            .expect("a conflict copy");
        assert_eq!(copy.title.as_deref(), Some("First (conflict, B)"));
        assert_eq!(copy.address, None);
        assert!(a.read_note(copy.id).unwrap().contains("b's"));
    }

    #[test]
    fn conflicting_assets_keep_both() {
        let (da, db, mut a, mut b) = synced_pair();
        fs::write(da.0.join("Inbox/data.csv"), "a\n").unwrap();
        fs::write(db.0.join("Inbox/data.csv"), "b\n").unwrap();
        a.refresh().unwrap();
        b.refresh().unwrap();
        sync(&mut a, &mut b);
        same(&a, &b);
        assert_eq!(
            fs::read_to_string(db.0.join("Inbox/data.csv")).unwrap(),
            "a\n"
        );
        assert_eq!(
            fs::read_to_string(da.0.join("Inbox/data (conflict, B).csv")).unwrap(),
            "b\n"
        );
    }

    #[test]
    fn skips_entries_edited_during_a_round() {
        let (_da, _db, mut a, mut b) = synced_pair();
        let id = a.notes.keys().next().copied().unwrap();
        let text = a.read_note(id).unwrap();
        a.write_note(id, &(text.clone() + "a\n")).unwrap();
        let base = a
            .sync_base(b.root().file_name().unwrap().to_str().unwrap())
            .unwrap();
        let local = a.sync_manifest().unwrap();
        let remote = b.sync_manifest().unwrap();
        let decisions = plan(&base, &local, &remote, false);
        let round = a.sync_round(&decisions, &base, &local, &remote, &HashMap::new(), "B");
        // b edits after sending its manifest: a's push is refused.
        b.write_note(id, &(text + "b\n")).unwrap();
        let (failed, _) = b.apply_sync(round.remote, DeleteMode::Permanent).unwrap();
        assert!(failed.contains(&format!("note:{id}")));
        assert!(b.read_note(id).unwrap().ends_with("b\n"));
    }

    #[test]
    fn refuses_unsynced_keys() {
        let (_da, db, _a, mut b) = synced_pair();
        let op = Op {
            key: "file:../escape.txt".into(),
            expected: None,
            state: Some(state(&hash_bytes(b"x"), None)),
        };
        let (failed, _) = b
            .apply_sync(vec![(op, Some(b"x".to_vec()))], DeleteMode::Permanent)
            .unwrap();
        assert_eq!(failed.len(), 1);
        assert!(!db.0.parent().unwrap().join("escape.txt").exists());
    }
}
