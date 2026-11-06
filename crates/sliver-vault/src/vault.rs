//! A vault on disk: notes as `<uuid>.typ` files in folders (plain
//! directories at any depth), plus a `.sliver/` directory. One folder, marked
//! by a `.zettelkasten` file, is the Zettelkasten: the only place notes have
//! addresses. The note files are the only source of truth; the index here is
//! rebuilt from their headers on open and kept current by every write that
//! goes through `Vault`.

mod files;
mod moves;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::citations::{
    REFERENCES_FILE, STYLES_DIR, bib_entries, citations_in, entry_title, merge_references,
};
use crate::header::{HeaderError, NoteHeader, format_header, header_in, set_kind, set_title};
use crate::links::{LinkTarget, WikiLink, link_table, links_in};
use crate::preambles::{
    COMMON_FILE, KINDS_DIR, PreambleWarning, defines_template, note_prefix, preamble_file,
    preamble_path, preamble_warnings, template_file,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::Address;

pub use files::{AssetNode, DiskChanges, Moved, PathPlan};
use files::{Previous, Stamp, stamp_of};
pub use moves::{AddressChange, LinkEdits, MovePlan};

const META_DIR: &str = ".sliver";
const TMP_DIR: &str = ".sliver/tmp";
const PKG_DIR: &str = ".sliver/pkg";
const WORKSPACE_FILE: &str = ".sliver/workspace.json";
/// The vault's settings, relative to its root.
pub const SETTINGS_FILE: &str = ".sliver/settings.json";
const THEME_FILE: &str = ".sliver/theme.typ";
const ZETTELKASTEN_MARKER: &str = ".zettelkasten";
const DEFAULT_ZETTELKASTEN: &str = "Zettelkasten";
const EXTENSION: &str = "typ";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: Uuid,
    pub title: Option<String>,
    /// As written in the header, even if it doesn't parse as an [`Address`].
    pub address: Option<String>,
    pub tags: Vec<String>,
    /// Set when the header exists but can't be read; the note is then listed as untitled.
    pub header_error: Option<String>,
    /// The note's directory relative to the vault root, `/`-separated; `""` is the root.
    pub folder: String,
    /// The note's kind, which picks its kind preamble.
    pub kind: Option<String>,
}

/// A preamble as the settings view edits it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Preamble {
    /// `None` for the common preamble.
    pub kind: Option<String>,
    /// As Typst sees it, with the vault as root.
    pub path: String,
    /// Empty if the file doesn't exist yet.
    pub text: String,
    pub exists: bool,
    pub warnings: Vec<PreambleWarning>,
}

/// A note template as the settings view edits it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Template {
    /// `None` for the default template.
    pub kind: Option<String>,
    /// As Typst sees it, with the vault as root.
    pub path: String,
    /// Empty if the file doesn't exist yet.
    pub text: String,
}

/// An entry of `references.bib`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Reference {
    pub key: String,
    pub title: Option<String>,
}

/// A custom CSL style file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CitationStyle {
    pub name: String,
    /// As Typst sees it, with the vault as root.
    pub path: String,
    pub text: String,
}

/// What the preview compiles for a note: the wrapper main's source and the
/// hidden lines that go before the note's own source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NotePreview {
    pub main: String,
    pub prefix: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TreeNode {
    #[serde(flatten)]
    pub note: NoteSummary,
    /// Something about the note's place in the vault looks wrong.
    pub warning: Option<String>,
    pub children: Vec<TreeNode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FolderKind {
    Plain,
    Zettelkasten,
}

/// A folder in the sidebar: subfolders, then notes. The Zettelkasten's notes
/// form the address tree (unaddressed ones last); other folders are flat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FolderNode {
    pub name: String,
    pub path: String,
    pub kind: FolderKind,
    pub warning: Option<String>,
    pub folders: Vec<FolderNode>,
    pub notes: Vec<TreeNode>,
    /// Files that aren't notes, by name.
    pub assets: Vec<AssetNode>,
}

/// Where [`Vault::place_for_address`] puts a note: the next note of `of`, or
/// a new top-level number without it, at `address`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AddressPlace {
    pub of: Option<Uuid>,
    pub address: String,
}

/// Where a new note goes: a Zettelkasten address, or a folder without one.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Placement {
    Unaddressed {
        #[serde(default)]
        folder: String,
    },
    /// The next free top-level number.
    Top,
    /// An aside to `of`: its next free sibling, `1.1a` -> `1.1b`.
    Aside { of: Uuid },
    /// The next note after `of`, one level deeper: `1.1a` -> `1.1a1`.
    Next { of: Uuid },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeleteMode {
    /// Move to the OS trash (Finder, Recycle Bin, freedesktop trash).
    #[default]
    Trash,
    Permanent,
}

#[derive(Debug)]
pub enum VaultError {
    Io(io::Error),
    NotAVault(PathBuf),
    NotEmpty(PathBuf),
    NoteNotFound(Uuid),
    NoAddress(Uuid),
    NoZettelkasten,
    FolderNotFound(String),
    InvalidFolderName(String),
    FolderExists(String),
    InvalidFileName(String),
    FileExists(String),
    FileNotFound(String),
    InvalidKindName(String),
    KindExists(String),
    KindNotFound(String),
    /// An operation that would break the vault's rules, with the reason.
    Refused(String),
    Header(HeaderError),
    Trash(String),
    InvalidPackage(String),
}

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(err) => write!(f, "{err}"),
            Self::NotAVault(path) => write!(f, "{} is not a Sliver vault", path.display()),
            Self::NotEmpty(path) => write!(
                f,
                "{} is not empty; pick an empty folder for a new vault",
                path.display()
            ),
            Self::NoteNotFound(id) => write!(f, "note {id} not found"),
            Self::NoAddress(id) => {
                write!(f, "note {id} has no address in the Zettelkasten")
            }
            Self::NoZettelkasten => write!(
                f,
                "this vault has no Zettelkasten folder; set one from a folder's menu"
            ),
            Self::FolderNotFound(path) => write!(f, "folder {path:?} not found"),
            Self::InvalidFolderName(name) => write!(f, "{name:?} is not a valid folder name"),
            Self::FolderExists(name) => write!(f, "a folder named {name:?} already exists"),
            Self::InvalidFileName(name) => write!(f, "{name:?} is not a valid file name"),
            Self::FileExists(name) => write!(f, "a file named {name:?} already exists"),
            Self::FileNotFound(path) => write!(f, "file {path:?} not found"),
            Self::InvalidKindName(name) => write!(f, "{name:?} is not a valid kind name"),
            Self::KindExists(name) => write!(f, "a kind named {name:?} already exists"),
            Self::KindNotFound(name) => write!(f, "there is no kind named {name:?}"),
            Self::Refused(reason) => write!(f, "{reason}"),
            Self::Header(err) => write!(f, "{err}"),
            Self::Trash(err) => write!(f, "could not move to trash: {err}"),
            Self::InvalidPackage(spec) => write!(f, "invalid package spec: {spec}"),
        }
    }
}

impl std::error::Error for VaultError {}

impl From<io::Error> for VaultError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

impl From<HeaderError> for VaultError {
    fn from(err: HeaderError) -> Self {
        Self::Header(err)
    }
}

pub type Result<T> = std::result::Result<T, VaultError>;

pub struct Vault {
    root: PathBuf,
    notes: HashMap<Uuid, NoteSummary>,
    /// Outgoing wikilinks per note, for backlinks.
    links: HashMap<Uuid, Vec<WikiLink>>,
    /// Citation keys per note.
    citations: HashMap<Uuid, BTreeSet<String>>,
    /// Keys of the entries in `references.bib`.
    reference_keys: BTreeSet<String>,
    /// Every folder (not the root), including empty ones.
    folders: BTreeSet<String>,
    zettelkasten: Option<String>,
    /// Further folders with a marker; only the first one found counts.
    extra_zettelkasten: Vec<String>,
    /// Files whose uuid was already taken by an earlier file, per uuid.
    duplicates: HashMap<Uuid, Vec<String>>,
    /// Kinds of notes: the files in the kind preambles' directory.
    kinds: BTreeSet<String>,
    /// Every file that isn't a note (and isn't hidden), by vault path.
    assets: BTreeMap<String, Stamp>,
    /// Each note file as last read or written: its stamp and its text's hash,
    /// so a rescan rereads only changed files and reports only real changes.
    stamps: HashMap<Uuid, Stamp>,
    hashes: HashMap<Uuid, u64>,
    /// The preambles' contents as last read or written, likewise.
    preambles_digest: u64,
}

impl Vault {
    fn empty(root: PathBuf) -> Self {
        Self {
            root,
            notes: HashMap::new(),
            links: HashMap::new(),
            citations: HashMap::new(),
            reference_keys: BTreeSet::new(),
            folders: BTreeSet::new(),
            zettelkasten: None,
            extra_zettelkasten: Vec::new(),
            duplicates: HashMap::new(),
            kinds: BTreeSet::new(),
            assets: BTreeMap::new(),
            stamps: HashMap::new(),
            hashes: HashMap::new(),
            preambles_digest: 0,
        }
    }

    /// Initializes a vault in `root`, which must be missing or empty, with
    /// an empty Zettelkasten folder.
    pub fn create(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        if root.exists() && fs::read_dir(&root)?.next().is_some() {
            return Err(VaultError::NotEmpty(root));
        }
        fs::create_dir_all(root.join(META_DIR))?;
        fs::create_dir_all(root.join(DEFAULT_ZETTELKASTEN))?;
        fs::write(
            root.join(DEFAULT_ZETTELKASTEN).join(ZETTELKASTEN_MARKER),
            "",
        )?;
        let mut vault = Self::empty(root);
        vault.folders.insert(DEFAULT_ZETTELKASTEN.to_owned());
        vault.zettelkasten = Some(DEFAULT_ZETTELKASTEN.to_owned());
        vault.write_theme_file()?;
        vault.write_common_preamble()?;
        vault.preambles_digest = vault.digest_preambles();
        // Only a new vault gets it: an existing vault may have removed it on purpose.
        vault.atomic_write(
            &vault.root.join(template_file(None)),
            crate::preambles::DEFAULT_TEMPLATE.as_bytes(),
        )?;
        Ok(vault)
    }

    /// Opens an existing vault and indexes every note header.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        if !root.join(META_DIR).is_dir() {
            return Err(VaultError::NotAVault(root));
        }
        let mut vault = Self::empty(root);
        vault.scan(&mut Previous::default())?;
        vault.scan_kinds()?;
        vault.reference_keys = bib_entries(&vault.references()?)
            .into_iter()
            .map(|e| e.key.to_owned())
            .collect();
        vault.write_theme_file()?;
        vault.write_common_preamble()?;
        vault.preambles_digest = vault.digest_preambles();
        Ok(vault)
    }

    /// Keeps `.sliver/theme.typ` (light colours) current for notes that
    /// import it outside the app; rewritten only when it differs, to spare
    /// sync tools a change on every open.
    fn write_theme_file(&self) -> Result<()> {
        let text = crate::theme_library(false);
        if fs::read_to_string(self.root.join(THEME_FILE))
            .ok()
            .as_deref()
            != Some(text.as_str())
        {
            self.atomic_write(&self.root.join(THEME_FILE), text.as_bytes())?;
        }
        Ok(())
    }

    /// Gives a vault without a common preamble the default one. An existing
    /// file, even an empty one, is the user's and stays as it is.
    fn write_common_preamble(&self) -> Result<()> {
        let path = self.root.join(COMMON_FILE);
        if !path.exists() {
            self.atomic_write(&path, crate::preambles::starter(None).as_bytes())?;
        }
        Ok(())
    }

    /// Indexes the vault: walks it depth first in name order (so "first
    /// found" is stable), then reads and parses the notes in parallel.
    /// Anything starting with a dot (`.sliver`, `.git`, markers) is skipped,
    /// and so is an entry that can't be read (it may be going away). Notes
    /// unchanged since `previous` are taken from it instead of reread.
    fn scan(&mut self, previous: &mut Previous) -> Result<()> {
        let mut found = Vec::new();
        let mut seen = HashSet::new();
        let root = self.root.clone();
        self.walk(&root, "", &mut seen, &mut found)?;
        let mut fresh = Vec::new();
        for note in found {
            if previous.stamps.get(&note.id) == Some(&note.stamp)
                && let Some(summary) = previous.notes.remove(&note.id)
            {
                let id = note.id;
                self.notes.insert(
                    id,
                    NoteSummary {
                        folder: note.folder,
                        ..summary
                    },
                );
                self.links
                    .insert(id, previous.links.remove(&id).unwrap_or_default());
                self.citations
                    .insert(id, previous.citations.remove(&id).unwrap_or_default());
                if let Some(hash) = previous.hashes.get(&id) {
                    self.hashes.insert(id, *hash);
                }
                self.stamps.insert(id, note.stamp);
            } else {
                fresh.push(note);
            }
        }
        let parsed = parse_all(&fresh);
        for (note, parsed) in fresh.into_iter().zip(parsed) {
            if let Some(parsed) = parsed {
                self.insert_parsed(parsed);
                self.stamps.insert(note.id, note.stamp);
            }
        }
        Ok(())
    }

    /// Records `dir`'s folders, markers and assets, and lists its notes in
    /// `found` (a uuid already `seen` is a duplicate).
    fn walk(
        &mut self,
        dir: &Path,
        folder: &str,
        seen: &mut HashSet<Uuid>,
        found: &mut Vec<FoundNote>,
    ) -> Result<()> {
        let mut entries: Vec<_> = fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                let sub = join_folder(folder, name);
                self.folders.insert(sub.clone());
                if path.join(ZETTELKASTEN_MARKER).is_file() {
                    if self.zettelkasten.is_none() {
                        self.zettelkasten = Some(sub.clone());
                    } else {
                        self.extra_zettelkasten.push(sub.clone());
                    }
                }
                let _ = self.walk(&path, &sub, seen, found);
            } else if !meta.is_file() {
                continue;
            } else if let Some(id) = note_id(&path) {
                if !seen.insert(id) {
                    self.duplicates
                        .entry(id)
                        .or_default()
                        .push(join_folder(folder, name));
                    continue;
                }
                found.push(FoundNote {
                    id,
                    folder: folder.to_owned(),
                    path,
                    stamp: stamp_of(&meta),
                });
            } else {
                self.assets
                    .insert(join_folder(folder, name), stamp_of(&meta));
            }
        }
        Ok(())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn note(&self, id: Uuid) -> Result<&NoteSummary> {
        self.notes.get(&id).ok_or(VaultError::NoteNotFound(id))
    }

    pub fn notes(&self) -> impl Iterator<Item = &NoteSummary> {
        self.notes.values()
    }

    /// The Zettelkasten folder's path.
    pub fn zettelkasten(&self) -> Result<&str> {
        self.zettelkasten
            .as_deref()
            .ok_or(VaultError::NoZettelkasten)
    }

    fn in_zettelkasten(&self, note: &NoteSummary) -> bool {
        self.zettelkasten.as_deref() == Some(note.folder.as_str())
    }

    /// The note's address, if it parses and the note is in the Zettelkasten.
    fn address_of(&self, note: &NoteSummary) -> Option<Address> {
        if !self.in_zettelkasten(note) {
            return None;
        }
        note.address.as_deref()?.parse().ok()
    }

    /// The whole vault as a folder tree rooted at the vault root (name `""`).
    pub fn tree(&self) -> FolderNode {
        let mut by_folder: HashMap<&str, Vec<&NoteSummary>> = HashMap::new();
        for note in self.notes.values() {
            by_folder.entry(&note.folder).or_default().push(note);
        }
        self.folder_node("", &by_folder)
    }

    fn folder_node(&self, path: &str, by_folder: &HashMap<&str, Vec<&NoteSummary>>) -> FolderNode {
        let is_zettelkasten = self.zettelkasten.as_deref() == Some(path);
        let mut subfolders: Vec<&String> = self
            .folders
            .iter()
            .filter(|f| parent_folder(f) == path)
            .collect();
        subfolders.sort_by_key(|f| (folder_name(f).to_lowercase(), *f));
        let notes = by_folder.get(path).map_or(&[][..], Vec::as_slice);
        let warning = if self.extra_zettelkasten.iter().any(|f| f == path) {
            Some(format!(
                "Only one folder can be the Zettelkasten; this vault uses {:?}",
                self.zettelkasten.as_deref().unwrap_or_default()
            ))
        } else if let Some(zk) = &self.zettelkasten
            && path.starts_with(&format!("{zk}/"))
        {
            Some("Folders inside the Zettelkasten aren't part of it".to_owned())
        } else {
            None
        };
        FolderNode {
            name: folder_name(path).to_owned(),
            path: path.to_owned(),
            kind: if is_zettelkasten {
                FolderKind::Zettelkasten
            } else {
                FolderKind::Plain
            },
            warning,
            folders: subfolders
                .into_iter()
                .map(|f| self.folder_node(f, by_folder))
                .collect(),
            notes: if is_zettelkasten {
                self.address_tree(notes)
            } else {
                let mut notes = notes.to_vec();
                notes.sort_by(|x, y| x.title.cmp(&y.title).then(x.id.cmp(&y.id)));
                notes.into_iter().map(|n| self.leaf(n)).collect()
            },
            assets: self.assets_in(path),
        }
    }

    fn leaf(&self, note: &NoteSummary) -> TreeNode {
        let warning = if let Some(paths) = self.duplicates.get(&note.id) {
            Some(format!(
                "Other files with this note's id are ignored: {}",
                paths.join(", ")
            ))
        } else if note.address.is_some() && !self.in_zettelkasten(note) {
            Some("Has an address but isn't in the Zettelkasten".to_owned())
        } else if let Some(kind) = &note.kind
            && !self.kinds.contains(kind)
        {
            Some(format!(
                "Its kind {kind:?} has no preamble; only the common one applies"
            ))
        } else {
            None
        };
        TreeNode {
            note: note.clone(),
            warning,
            children: Vec::new(),
        }
    }

    /// Addressed notes nested under their nearest existing ancestor in address
    /// order, followed by unaddressed notes (and invalid addresses) by title.
    fn address_tree(&self, notes: &[&NoteSummary]) -> Vec<TreeNode> {
        let mut addressed: Vec<(Address, &NoteSummary)> = Vec::new();
        let mut loose: Vec<&NoteSummary> = Vec::new();
        for &note in notes {
            match note.address.as_deref().and_then(|a| a.parse().ok()) {
                Some(address) => addressed.push((address, note)),
                None => loose.push(note),
            }
        }
        addressed.sort_by(|(a, x), (b, y)| a.cmp(b).then(x.id.cmp(&y.id)));
        loose.sort_by(|x, y| x.title.cmp(&y.title).then(x.id.cmp(&y.id)));

        let index_of: HashMap<&Address, usize> = addressed
            .iter()
            .enumerate()
            .map(|(i, (address, _))| (address, i))
            .collect();
        let mut children: Vec<Vec<usize>> = vec![Vec::new(); addressed.len()];
        let mut roots = Vec::new();
        for (i, (address, _)) in addressed.iter().enumerate() {
            let mut ancestor = address.parent();
            let parent = loop {
                match ancestor {
                    Some(a) => match index_of.get(&a) {
                        Some(&p) => break Some(p),
                        None => ancestor = a.parent(),
                    },
                    None => break None,
                }
            };
            match parent {
                Some(p) => children[p].push(i),
                None => roots.push(i),
            }
        }

        let build = |i: usize| -> TreeNode {
            fn go(
                vault: &Vault,
                i: usize,
                addressed: &[(Address, &NoteSummary)],
                children: &[Vec<usize>],
            ) -> TreeNode {
                TreeNode {
                    children: children[i]
                        .iter()
                        .map(|&c| go(vault, c, addressed, children))
                        .collect(),
                    ..vault.leaf(addressed[i].1)
                }
            }
            go(self, i, &addressed, &children)
        };
        roots
            .into_iter()
            .map(build)
            .chain(loose.into_iter().map(|note| self.leaf(note)))
            .collect()
    }

    pub fn read_note(&self, id: Uuid) -> Result<String> {
        Ok(fs::read_to_string(self.note_path(id)?)?)
    }

    pub fn write_note(&mut self, id: Uuid, text: &str) -> Result<NoteSummary> {
        let folder = self.note(id)?.folder.clone();
        self.write_file(id, &folder, text)
    }

    pub fn create_note(
        &mut self,
        title: Option<String>,
        placement: Placement,
    ) -> Result<NoteSummary> {
        self.create_note_of_kind(title, placement, None, "")
    }

    /// Like [`Vault::create_note`], with `kind` in the new note's header and
    /// `body` (e.g. an expanded template) below it.
    pub fn create_note_of_kind(
        &mut self,
        title: Option<String>,
        placement: Placement,
        kind: Option<String>,
        body: &str,
    ) -> Result<NoteSummary> {
        if let Some(kind) = &kind {
            self.require_kind(kind)?;
        }
        let (folder, address) = match placement {
            Placement::Unaddressed { folder } => {
                self.require_folder(&folder)?;
                (folder, None)
            }
            placement => {
                let taken = self.taken_addresses(&HashSet::new());
                let address = self.allocate(&placement, &taken)?;
                (self.zettelkasten()?.to_owned(), Some(address.to_string()))
            }
        };
        let header = format_header(&NoteHeader {
            title,
            address,
            tags: Vec::new(),
            kind,
        });
        // Trailing blank lines stay: a template's cursor may be on one.
        let body = body.trim_start_matches('\n');
        let text = if body.is_empty() || body.ends_with('\n') {
            format!("{header}\n\n{body}")
        } else {
            format!("{header}\n\n{body}\n")
        };
        self.write_file(Uuid::new_v4(), &folder, &text)
    }

    pub fn rename_note(&mut self, id: Uuid, title: &str) -> Result<NoteSummary> {
        let text = set_title(&self.read_note(id)?, title)?;
        self.write_note(id, &text)
    }

    pub fn delete_note(&mut self, id: Uuid, mode: DeleteMode) -> Result<()> {
        remove_path(&self.note_path(id)?, mode)?;
        self.forget(id);
        Ok(())
    }

    /// Addresses of every note except `except`, wherever they are: a stray
    /// address outside the Zettelkasten still shouldn't be handed out twice.
    fn taken_addresses(&self, except: &HashSet<Uuid>) -> Vec<Address> {
        self.notes
            .values()
            .filter(|n| !except.contains(&n.id))
            .filter_map(|n| n.address.as_deref()?.parse().ok())
            .collect()
    }

    /// The first free address for `placement`. A candidate is free only if no
    /// taken address is it or lies under it (an orphan such as `3.2a1` blocks
    /// `3.2a`), so a subtree moved there can't collide.
    fn allocate(&self, placement: &Placement, taken: &[Address]) -> Result<Address> {
        let anchor = |id: Uuid| -> Result<Address> {
            self.address_of(self.note(id)?)
                .ok_or(VaultError::NoAddress(id))
        };
        let mut candidate = match placement {
            Placement::Unaddressed { .. } => {
                return Err(VaultError::Refused(
                    "an unaddressed note has no place in the Zettelkasten".into(),
                ));
            }
            Placement::Top => {
                let max = taken.iter().map(Address::top_number).max().unwrap_or(0);
                Address::top(max + 1)
            }
            Placement::Aside { of } => anchor(*of)?.next_sibling(),
            Placement::Next { of } => anchor(*of)?.first_child(),
        };
        while taken.iter().any(|t| t.starts_with(&candidate)) {
            candidate = candidate.next_sibling();
        }
        Ok(candidate)
    }

    /// Where a new note for a link to `target` goes, if `target` is an
    /// address: as the next note of its nearest existing ancestor (the next
    /// top-level number without one), at the address that allocation gives.
    /// That's `target` itself only when it leaves no gap; notes are never
    /// created at an address whose parent or earlier siblings are missing.
    pub fn place_for_address(&self, target: &str) -> Result<Option<AddressPlace>> {
        let Ok(address) = target.trim().parse::<Address>() else {
            return Ok(None);
        };
        self.zettelkasten()?;
        let mut ancestor = address.parent();
        let of = loop {
            let Some(candidate) = ancestor else {
                break None;
            };
            if let Some(note) = self
                .notes
                .values()
                .find(|n| self.address_of(n).as_ref() == Some(&candidate))
            {
                break Some(note.id);
            }
            ancestor = candidate.parent();
        };
        let placement = match of {
            Some(of) => Placement::Next { of },
            None => Placement::Top,
        };
        let taken = self.taken_addresses(&HashSet::new());
        let address = self.allocate(&placement, &taken)?.to_string();
        Ok(Some(AddressPlace { of, address }))
    }

    /// Resolves a wikilink target: an address first, then a uuid.
    pub fn resolve(&self, target: &str) -> Option<Uuid> {
        if let Ok(address) = target.parse::<Address>() {
            let mut matches: Vec<Uuid> = self
                .notes
                .values()
                .filter(|n| {
                    n.address.as_deref().and_then(|a| a.parse().ok()) == Some(address.clone())
                })
                .map(|n| n.id)
                .collect();
            matches.sort();
            return matches.first().copied();
        }
        let id = Uuid::parse_str(target).ok()?;
        self.notes.contains_key(&id).then_some(id)
    }

    pub fn links_from(&self, id: Uuid) -> Result<&[WikiLink]> {
        self.note(id)?;
        Ok(self.links.get(&id).map_or(&[], Vec::as_slice))
    }

    /// Notes with at least one wikilink resolving to `id`, in tree order.
    pub fn backlinks(&self, id: Uuid) -> Result<Vec<NoteSummary>> {
        self.note(id)?;
        let mut sources: Vec<NoteSummary> = self
            .links
            .iter()
            .filter(|(source, links)| {
                **source != id && links.iter().any(|l| self.resolve(&l.target) == Some(id))
            })
            .map(|(source, _)| self.notes[source].clone())
            .collect();
        sources.sort_by(|a, b| sort_key(a).cmp(&sort_key(b)));
        Ok(sources)
    }

    /// Source of a note's link table for `targets` (as written in its
    /// links); see [`link_table`].
    pub fn link_table(&self, targets: &[String]) -> String {
        let mut seen = HashSet::new();
        link_table(targets.iter().filter_map(|target| {
            if !seen.insert(target.as_str()) {
                return None;
            }
            let note = self.notes.get(&self.resolve(target)?)?;
            Some((
                target.as_str(),
                LinkTarget {
                    id: note.id.to_string(),
                    title: note.title.as_deref(),
                    address: note.address.as_deref(),
                },
            ))
        }))
    }

    // --- citations ---

    /// Every citation key the vault's notes use.
    pub fn cited_keys(&self) -> BTreeSet<String> {
        self.citations.values().flatten().cloned().collect()
    }

    /// Cited keys with no entry in `references.bib`.
    pub fn missing_references(&self) -> BTreeSet<String> {
        self.citations
            .values()
            .flatten()
            .filter(|key| !self.reference_keys.contains(*key))
            .cloned()
            .collect()
    }

    /// The text of `references.bib`; empty if there is none yet.
    pub fn references(&self) -> Result<String> {
        Ok(self.read_optional(REFERENCES_FILE)?.unwrap_or_default())
    }

    /// The keys and titles of the entries in `references.bib`.
    pub fn reference_list(&self) -> Result<Vec<Reference>> {
        Ok(bib_entries(&self.references()?)
            .into_iter()
            .map(|e| Reference {
                key: e.key.to_owned(),
                title: entry_title(e.text),
            })
            .collect())
    }

    /// Merges entries exported from Zotero into `references.bib`; with
    /// `prune`, entries no note cites any more are dropped. Returns whether
    /// the file changed.
    pub fn update_references(&mut self, exported: &str, prune: bool) -> Result<bool> {
        let existing = self.references()?;
        let keep = prune.then(|| self.cited_keys());
        let merged = merge_references(&existing, exported, keep.as_ref());
        if merged == existing || (existing.is_empty() && bib_entries(&merged).is_empty()) {
            return Ok(false);
        }
        self.atomic_write(&self.root.join(REFERENCES_FILE), merged.as_bytes())?;
        self.reference_keys = bib_entries(&merged)
            .into_iter()
            .map(|e| e.key.to_owned())
            .collect();
        Ok(true)
    }

    /// The custom CSL styles in `.sliver/styles/`, by name.
    pub fn citation_styles(&self) -> Result<Vec<CitationStyle>> {
        let entries = match fs::read_dir(self.root.join(STYLES_DIR)) {
            Ok(entries) => entries,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(err.into()),
        };
        let mut styles = Vec::new();
        for entry in entries {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("csl") {
                continue;
            }
            let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            styles.push(CitationStyle {
                name: name.to_owned(),
                path: format!("/{STYLES_DIR}/{name}.csl"),
                text: fs::read_to_string(&path)?,
            });
        }
        styles.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(styles)
    }

    // --- templates ---

    /// The default template, then one per kind.
    pub fn templates(&mut self) -> Result<Vec<Template>> {
        self.scan_kinds()?;
        let kinds: Vec<Option<String>> = std::iter::once(None)
            .chain(self.kinds.iter().cloned().map(Some))
            .collect();
        kinds
            .into_iter()
            .map(|kind| {
                let file = template_file(kind.as_deref());
                Ok(Template {
                    text: self.read_optional(&file)?.unwrap_or_default(),
                    path: format!("/{file}"),
                    kind,
                })
            })
            .collect()
    }

    pub fn save_template(&mut self, kind: Option<&str>, text: &str) -> Result<()> {
        if let Some(kind) = kind {
            self.require_kind(kind)?;
        }
        self.atomic_write(&self.root.join(template_file(kind)), text.as_bytes())
    }

    /// What a new note of `kind` starts with (placeholders unexpanded): the
    /// kind's template, or the default one where it has none (or it's blank).
    pub fn note_template(&self, kind: Option<&str>) -> Result<String> {
        if let Some(kind) = kind
            && let Some(text) = self.read_optional(&template_file(Some(kind)))?
            && !text.trim().is_empty()
        {
            return Ok(text);
        }
        Ok(self
            .read_optional(&template_file(None))?
            .unwrap_or_default())
    }

    // --- preambles ---

    /// Rereads which kinds exist; their files may change outside the app.
    fn scan_kinds(&mut self) -> Result<()> {
        self.kinds.clear();
        let dir = self.root.join(KINDS_DIR);
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err.into()),
        };
        for entry in entries {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) == Some(EXTENSION)
                && let Some(name) = path.file_stem().and_then(|s| s.to_str())
                && validate_folder_name(name).is_ok()
            {
                self.kinds.insert(name.to_owned());
            }
        }
        Ok(())
    }

    /// Kinds of notes, in name order.
    pub fn kinds(&self) -> impl Iterator<Item = &str> {
        self.kinds.iter().map(String::as_str)
    }

    fn require_kind(&self, kind: &str) -> Result<()> {
        if self.kinds.contains(kind) {
            Ok(())
        } else {
            Err(VaultError::KindNotFound(kind.to_owned()))
        }
    }

    fn preamble_text(&self, kind: Option<&str>) -> Result<Option<String>> {
        self.read_optional(&preamble_file(kind))
    }

    /// The common preamble, then one per kind. Rescans the kinds first.
    pub fn preambles(&mut self) -> Result<Vec<Preamble>> {
        self.scan_kinds()?;
        let kinds: Vec<Option<String>> = std::iter::once(None)
            .chain(self.kinds.iter().cloned().map(Some))
            .collect();
        kinds
            .into_iter()
            .map(|kind| {
                let text = self.preamble_text(kind.as_deref())?;
                let exists = text.is_some();
                let text = text.unwrap_or_default();
                Ok(Preamble {
                    path: preamble_path(kind.as_deref()),
                    warnings: preamble_warnings(&text),
                    kind,
                    text,
                    exists,
                })
            })
            .collect()
    }

    /// Writes a preamble and returns what it should be warned about.
    pub fn save_preamble(
        &mut self,
        kind: Option<&str>,
        text: &str,
    ) -> Result<Vec<PreambleWarning>> {
        if let Some(kind) = kind {
            self.require_kind(kind)?;
        }
        self.atomic_write(&self.root.join(preamble_file(kind)), text.as_bytes())?;
        self.preambles_digest = self.digest_preambles();
        Ok(preamble_warnings(text))
    }

    fn check_free_kind(&self, name: &str, except: Option<&str>) -> Result<()> {
        validate_folder_name(name).map_err(|_| VaultError::InvalidKindName(name.to_owned()))?;
        if self
            .kinds
            .iter()
            .any(|k| Some(k.as_str()) != except && k.to_lowercase() == name.to_lowercase())
        {
            return Err(VaultError::KindExists(name.to_owned()));
        }
        Ok(())
    }

    /// Adds a kind with a starter preamble.
    pub fn create_kind(&mut self, name: &str) -> Result<()> {
        self.scan_kinds()?;
        self.check_free_kind(name, None)?;
        let starter = crate::preambles::starter(Some(name));
        self.atomic_write(
            &self.root.join(preamble_file(Some(name))),
            starter.as_bytes(),
        )?;
        self.kinds.insert(name.to_owned());
        self.preambles_digest = self.digest_preambles();
        Ok(())
    }

    /// Renames a kind and rewrites the `kind` of every note that has it;
    /// returns those notes' ids.
    pub fn rename_kind(&mut self, from: &str, to: &str) -> Result<Vec<Uuid>> {
        self.scan_kinds()?;
        self.require_kind(from)?;
        self.check_free_kind(to, Some(from))?;
        if from == to {
            return Ok(Vec::new());
        }
        fs::rename(
            self.root.join(preamble_file(Some(from))),
            self.root.join(preamble_file(Some(to))),
        )?;
        let template = self.root.join(template_file(Some(from)));
        if template.exists() {
            fs::rename(template, self.root.join(template_file(Some(to))))?;
        }
        self.kinds.remove(from);
        self.kinds.insert(to.to_owned());
        let ids: Vec<Uuid> = self
            .notes
            .values()
            .filter(|n| n.kind.as_deref() == Some(from))
            .map(|n| n.id)
            .collect();
        for &id in &ids {
            self.set_kind(id, Some(to))?;
        }
        self.preambles_digest = self.digest_preambles();
        Ok(ids)
    }

    /// Deletes a kind's preamble. Notes keep their `kind` (and get a warning).
    pub fn delete_kind(&mut self, name: &str, mode: DeleteMode) -> Result<()> {
        self.scan_kinds()?;
        self.require_kind(name)?;
        remove_path(&self.root.join(preamble_file(Some(name))), mode)?;
        let template = self.root.join(template_file(Some(name)));
        if template.exists() {
            remove_path(&template, mode)?;
        }
        self.kinds.remove(name);
        self.preambles_digest = self.digest_preambles();
        Ok(())
    }

    /// Sets or (with `None`) removes a note's kind.
    pub fn set_kind(&mut self, id: Uuid, kind: Option<&str>) -> Result<NoteSummary> {
        if let Some(kind) = kind {
            self.require_kind(kind)?;
        }
        let text = set_kind(&self.read_note(id)?, kind)?;
        self.write_note(id, &text)
    }

    /// The wrapper main and hidden prefix the preview compiles note `id` with.
    pub fn preview(&self, id: Uuid) -> Result<NotePreview> {
        let note = self.note(id)?;
        let kind = note.kind.as_deref().filter(|k| self.kinds.contains(*k));
        let mut imports = Vec::new();
        let mut templates = Vec::new();
        for kind in std::iter::once(None).chain(kind.map(Some)) {
            let Some(text) = self.preamble_text(kind)? else {
                continue;
            };
            let path = preamble_path(kind);
            if defines_template(&text) {
                templates.push(path.clone());
            }
            imports.push(path);
        }
        Ok(NotePreview {
            main: crate::preview_main(&id.to_string(), &templates),
            prefix: note_prefix(&imports),
        })
    }

    // --- folders ---

    fn require_folder(&self, path: &str) -> Result<()> {
        if path.is_empty() || self.folders.contains(path) {
            Ok(())
        } else {
            Err(VaultError::FolderNotFound(path.to_owned()))
        }
    }

    /// Fails if `parent` already has a subfolder called `name`, ignoring case
    /// (the macOS and Windows filesystems do). `except` is a folder allowed
    /// to match, for renames that only change case.
    fn check_free_name(&self, parent: &str, name: &str, except: Option<&str>) -> Result<()> {
        validate_folder_name(name)?;
        let clash = self.folders.iter().any(|f| {
            parent_folder(f) == parent
                && Some(f.as_str()) != except
                && folder_name(f).to_lowercase() == name.to_lowercase()
        });
        if clash {
            return Err(VaultError::FolderExists(name.to_owned()));
        }
        Ok(())
    }

    /// Creates folder `name` in `parent` (`""` for the root) and returns its path.
    pub fn create_folder(&mut self, parent: &str, name: &str) -> Result<String> {
        self.require_folder(parent)?;
        if self.zettelkasten.as_deref() == Some(parent) {
            return Err(VaultError::Refused(
                "the Zettelkasten can't contain folders".into(),
            ));
        }
        self.check_free_name(parent, name, None)?;
        let path = join_folder(parent, name);
        fs::create_dir(self.folder_dir(&path))?;
        self.folders.insert(path.clone());
        Ok(path)
    }

    /// Renames a folder in place and returns its new path. Renaming the
    /// Zettelkasten is fine: its marker moves with it.
    /// Paths in notes, preambles and templates that pointed into the folder
    /// are rewritten (see [`Vault::plan_path_move`]).
    pub fn rename_folder(&mut self, path: &str, name: &str) -> Result<Moved> {
        if path.is_empty() {
            return Err(VaultError::Refused(
                "the vault root can't be renamed".into(),
            ));
        }
        self.require_folder(path)?;
        let parent = parent_folder(path).to_owned();
        self.check_free_name(&parent, name, Some(path))?;
        let new_path = join_folder(&parent, name);
        if new_path == path {
            return Ok(Moved {
                path: new_path,
                changed: Vec::new(),
            });
        }
        fs::rename(self.folder_dir(path), self.folder_dir(&new_path))?;
        let rebase = |f: &str| rebase_folder(f, path, &new_path).unwrap_or_else(|| f.to_owned());
        self.folders = self.folders.iter().map(|f| rebase(f)).collect();
        self.assets = std::mem::take(&mut self.assets)
            .into_iter()
            .map(|(a, stamp)| (rebase(&a), stamp))
            .collect();
        for note in self.notes.values_mut() {
            note.folder = rebase(&note.folder);
        }
        if let Some(zk) = &mut self.zettelkasten {
            *zk = rebase(zk);
        }
        for f in &mut self.extra_zettelkasten {
            *f = rebase(f);
        }
        let changed = self.rewrite_paths(path, &new_path)?;
        Ok(Moved {
            path: new_path,
            changed,
        })
    }

    /// Deletes a folder with everything in it and returns the ids of the
    /// notes that went with it. The Zettelkasten can't be deleted.
    pub fn delete_folder(&mut self, path: &str, mode: DeleteMode) -> Result<Vec<Uuid>> {
        if path.is_empty() {
            return Err(VaultError::Refused(
                "the vault root can't be deleted".into(),
            ));
        }
        self.require_folder(path)?;
        if self
            .zettelkasten
            .as_deref()
            .is_some_and(|zk| rebase_folder(zk, path, "").is_some())
        {
            return Err(VaultError::Refused(
                "the Zettelkasten (or a folder holding it) can't be deleted".into(),
            ));
        }
        remove_path(&self.folder_dir(path), mode)?;
        let inside = |f: &str| rebase_folder(f, path, "").is_some();
        let removed: Vec<Uuid> = self
            .notes
            .values()
            .filter(|n| inside(&n.folder))
            .map(|n| n.id)
            .collect();
        for id in &removed {
            self.forget(*id);
        }
        self.folders.retain(|f| !inside(f));
        self.assets.retain(|a, _| !inside(parent_folder(a)));
        self.extra_zettelkasten.retain(|f| !inside(f));
        Ok(removed)
    }

    /// Makes `path` the Zettelkasten. Only for vaults that have none.
    pub fn set_zettelkasten(&mut self, path: &str) -> Result<()> {
        if path.is_empty() {
            return Err(VaultError::Refused(
                "the vault root can't be the Zettelkasten".into(),
            ));
        }
        self.require_folder(path)?;
        if self.zettelkasten.is_some() {
            return Err(VaultError::Refused(
                "this vault already has a Zettelkasten".into(),
            ));
        }
        fs::write(self.folder_dir(path).join(ZETTELKASTEN_MARKER), "")?;
        self.zettelkasten = Some(path.to_owned());
        Ok(())
    }

    /// Moves a note's file into `folder` (same volume, so an atomic rename).
    fn relocate(&mut self, id: Uuid, folder: &str) -> Result<()> {
        let from = self.note_path(id)?;
        let to = self.file_path(folder, id);
        if from != to {
            fs::rename(&from, &to)?;
            self.stamps.insert(id, stamp_of(&fs::metadata(&to)?));
            if let Some(note) = self.notes.get_mut(&id) {
                note.folder = folder.to_owned();
            }
        }
        Ok(())
    }

    // --- files ---

    /// Drops note `id` from the index.
    fn forget(&mut self, id: Uuid) {
        self.notes.remove(&id);
        self.links.remove(&id);
        self.citations.remove(&id);
        self.stamps.remove(&id);
        self.hashes.remove(&id);
    }

    fn index(&mut self, id: Uuid, folder: &str, text: &str) -> &NoteSummary {
        self.insert_parsed(parse_note(id, folder, text));
        &self.notes[&id]
    }

    fn insert_parsed(&mut self, parsed: ParsedNote) {
        let id = parsed.summary.id;
        self.hashes.insert(id, parsed.hash);
        self.links.insert(id, parsed.links);
        self.citations.insert(id, parsed.citations);
        self.notes.insert(id, parsed.summary);
    }

    fn folder_dir(&self, folder: &str) -> PathBuf {
        folder
            .split('/')
            .filter(|s| !s.is_empty())
            .fold(self.root.clone(), |dir, part| dir.join(part))
    }

    fn file_path(&self, folder: &str, id: Uuid) -> PathBuf {
        self.folder_dir(folder).join(format!("{id}.{EXTENSION}"))
    }

    fn note_path(&self, id: Uuid) -> Result<PathBuf> {
        Ok(self.file_path(&self.note(id)?.folder, id))
    }

    fn write_file(&mut self, id: Uuid, folder: &str, text: &str) -> Result<NoteSummary> {
        let path = self.file_path(folder, id);
        self.atomic_write(&path, text.as_bytes())?;
        self.stamps.insert(id, stamp_of(&fs::metadata(&path)?));
        Ok(self.index(id, folder, text).clone())
    }

    /// Writes via a temp file in `.sliver/tmp/` and a rename (same volume), so
    /// a crash never leaves a half-written file.
    fn atomic_write(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        let tmp_dir = self.root.join(TMP_DIR);
        fs::create_dir_all(&tmp_dir)?;
        let tmp = tmp_dir.join(Uuid::new_v4().to_string());
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::rename(&tmp, path)?;
        Ok(())
    }

    /// `.sliver/pkg/<namespace>/<name>-<version>.tar.gz`, as downloaded.
    fn package_path(&self, spec: &str) -> Result<PathBuf> {
        let spec: typst_syntax::package::PackageSpec = spec
            .parse()
            .map_err(|_| VaultError::InvalidPackage(spec.to_owned()))?;
        Ok(self
            .root
            .join(PKG_DIR)
            .join(spec.namespace.as_str())
            .join(format!("{}-{}.tar.gz", spec.name, spec.version)))
    }

    /// Per-vault UI state (open tabs and so on) as JSON owned by the frontend.
    pub fn load_workspace(&self) -> Result<Option<String>> {
        self.read_optional(WORKSPACE_FILE)
    }

    pub fn save_workspace(&self, json: &str) -> Result<()> {
        self.atomic_write(&self.root.join(WORKSPACE_FILE), json.as_bytes())
    }

    /// Per-vault settings as JSON owned by the frontend.
    pub fn load_settings(&self) -> Result<Option<String>> {
        self.read_optional(SETTINGS_FILE)
    }

    pub fn save_settings(&self, json: &str) -> Result<()> {
        self.atomic_write(&self.root.join(SETTINGS_FILE), json.as_bytes())
    }

    fn read_optional(&self, path: &str) -> Result<Option<String>> {
        match fs::read_to_string(self.root.join(path)) {
            Ok(text) => Ok(Some(text)),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    /// The cached `.tar.gz` for `spec`, if this vault has downloaded it before.
    pub fn load_package(&self, spec: &str) -> Result<Option<Vec<u8>>> {
        match fs::read(self.package_path(spec)?) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    pub fn save_package(&self, spec: &str, tar_gz: &[u8]) -> Result<()> {
        self.atomic_write(&self.package_path(spec)?, tar_gz)
    }
}

fn remove_path(path: &Path, mode: DeleteMode) -> Result<()> {
    match mode {
        DeleteMode::Trash => trash::delete(path).map_err(|e| VaultError::Trash(e.to_string())),
        DeleteMode::Permanent if path.is_dir() => Ok(fs::remove_dir_all(path)?),
        DeleteMode::Permanent => Ok(fs::remove_file(path)?),
    }
}

fn join_folder(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}/{name}")
    }
}

fn parent_folder(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

fn folder_name(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, name)| name)
}

/// `path` moved from under `from` to under `to`, or `None` if it isn't `from`
/// or inside it.
fn rebase_folder(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        return Some(to.to_owned());
    }
    let rest = path.strip_prefix(from)?.strip_prefix('/')?;
    Some(join_folder(to, rest))
}

/// A single path component that works on every desktop filesystem.
fn valid_name(name: &str) -> bool {
    !(name.is_empty()
        || name.starts_with('.')
        || name.ends_with(' ')
        || name.ends_with('.')
        || name.trim() != name
        || name.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*')
        }))
}

fn validate_folder_name(name: &str) -> Result<()> {
    if !valid_name(name) {
        return Err(VaultError::InvalidFolderName(name.to_owned()));
    }
    Ok(())
}

/// A note file the walk found, before it's read.
struct FoundNote {
    id: Uuid,
    folder: String,
    path: PathBuf,
    stamp: Stamp,
}

/// What the index keeps of a note, from its text.
struct ParsedNote {
    summary: NoteSummary,
    links: Vec<WikiLink>,
    citations: BTreeSet<String>,
    hash: u64,
}

/// Parses a note's text (its header, wikilinks and citations).
fn parse_note(id: Uuid, folder: &str, text: &str) -> ParsedNote {
    let root = typst_syntax::parse(text);
    let (header, header_error) = match header_in(&root) {
        Ok(header) => (header.unwrap_or_default(), None),
        Err(err) => (NoteHeader::default(), Some(err.to_string())),
    };
    ParsedNote {
        summary: NoteSummary {
            id,
            title: header.title,
            address: header.address,
            tags: header.tags,
            header_error,
            folder: folder.to_owned(),
            kind: header.kind,
        },
        links: links_in(&root),
        citations: citations_in(&root).into_iter().map(|c| c.key).collect(),
        hash: files::hash_text(text),
    }
}

/// Below this many notes, parsing on one thread is about as fast.
const PARALLEL_MIN: usize = 64;

/// Reads and parses `notes` on every core, in order; `None` for a file that
/// can't be read. Parsing every note's whole text is most of opening a vault.
fn parse_all(notes: &[FoundNote]) -> Vec<Option<ParsedNote>> {
    let parse = |note: &FoundNote| {
        let text = fs::read_to_string(&note.path).ok()?;
        Some(parse_note(note.id, &note.folder, &text))
    };
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get());
    if notes.len() < PARALLEL_MIN || threads < 2 {
        return notes.iter().map(parse).collect();
    }
    let chunk = notes.len().div_ceil(threads);
    std::thread::scope(|scope| {
        let handles: Vec<_> = notes
            .chunks(chunk)
            .map(|part| {
                (
                    part.len(),
                    scope.spawn(move || part.iter().map(parse).collect()),
                )
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|(len, handle)| {
                handle
                    .join()
                    .unwrap_or_else(|_| (0..len).map(|_| None).collect::<Vec<_>>())
            })
            .collect()
    })
}

/// The uuid of a note file (`<uuid>.typ`), if `path` is one.
fn note_id(path: &Path) -> Option<Uuid> {
    if path.extension().and_then(|e| e.to_str()) != Some(EXTENSION) {
        return None;
    }
    Uuid::parse_str(path.file_stem()?.to_str()?).ok()
}

/// Addressed notes in address order, then the rest by title; ties by id.
fn sort_key(note: &NoteSummary) -> (bool, Option<Address>, Option<&str>, Uuid) {
    let address = note.address.as_deref().and_then(|a| a.parse().ok());
    (address.is_none(), address, note.title.as_deref(), note.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) struct TempDir(pub(super) PathBuf);

    impl TempDir {
        pub(super) fn new() -> Self {
            Self(std::env::temp_dir().join(format!("sliver-test-{}", Uuid::new_v4())))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn zettelkasten(tree: &FolderNode) -> &FolderNode {
        tree.folders
            .iter()
            .find(|f| f.kind == FolderKind::Zettelkasten)
            .unwrap()
    }

    fn addresses(tree: &[TreeNode]) -> Vec<String> {
        tree.iter()
            .map(|node| {
                let own = node.note.address.clone().unwrap_or_else(|| "-".into());
                let kids = addresses(&node.children);
                if kids.is_empty() {
                    own
                } else {
                    format!("{own}[{}]", kids.join(" "))
                }
            })
            .collect()
    }

    #[test]
    fn create_requires_an_empty_folder() {
        let dir = TempDir::new();
        fs::create_dir_all(&dir.0).unwrap();
        fs::write(dir.0.join("x"), "").unwrap();
        assert!(matches!(
            Vault::create(&dir.0),
            Err(VaultError::NotEmpty(_))
        ));
        assert!(matches!(Vault::open(&dir.0), Err(VaultError::NotAVault(_))));
    }

    #[test]
    fn notes_round_trip_through_disk() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        let note = vault
            .create_note(Some("First".into()), Placement::Top)
            .unwrap();
        assert_eq!(note.address.as_deref(), Some("1"));

        let body = format!("{}\n\nHello", vault.read_note(note.id).unwrap().trim_end());
        vault.write_note(note.id, &body).unwrap();
        let renamed = vault.rename_note(note.id, "Second \"thoughts\"").unwrap();
        assert_eq!(renamed.title.as_deref(), Some("Second \"thoughts\""));

        let reopened = Vault::open(&dir.0).unwrap();
        assert_eq!(reopened.note(note.id).unwrap(), &renamed);
        assert!(reopened.read_note(note.id).unwrap().ends_with("Hello"));
        assert!(
            !dir.0
                .join(TMP_DIR)
                .join(format!("{}.typ", note.id))
                .exists()
        );
    }

    #[test]
    fn places_link_notes_without_gaps() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        let one = vault.create_note(None, Placement::Top).unwrap();
        let one_one = vault
            .create_note(None, Placement::Next { of: one.id })
            .unwrap();
        let place = |vault: &Vault, target: &str| vault.place_for_address(target).unwrap();
        // The next note of an existing parent: exactly the target.
        assert_eq!(
            place(&vault, "1.1a"),
            Some(AddressPlace {
                of: Some(one_one.id),
                address: "1.1a".into()
            })
        );
        assert_eq!(
            place(&vault, "2"),
            Some(AddressPlace {
                of: None,
                address: "2".into()
            })
        );
        // A missing parent, a skipped sibling and a skipped number each get
        // the address that leaves no gap.
        assert_eq!(
            place(&vault, "1.1a1"),
            Some(AddressPlace {
                of: Some(one_one.id),
                address: "1.1a".into()
            })
        );
        assert_eq!(
            place(&vault, "1.3"),
            Some(AddressPlace {
                of: Some(one.id),
                address: "1.2".into()
            })
        );
        assert_eq!(
            place(&vault, "7.2"),
            Some(AddressPlace {
                of: None,
                address: "2".into()
            })
        );
        assert_eq!(place(&vault, "Some title"), None);
    }

    #[test]
    fn allocates_addresses_and_builds_the_tree() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        let one = vault.create_note(None, Placement::Top).unwrap();
        let two = vault.create_note(None, Placement::Top).unwrap();
        let one_one = vault
            .create_note(None, Placement::Next { of: one.id })
            .unwrap();
        let one_two = vault
            .create_note(None, Placement::Aside { of: one_one.id })
            .unwrap();
        let one_one_a = vault
            .create_note(None, Placement::Next { of: one_one.id })
            .unwrap();
        // 1.2 is taken, so another aside to 1.1 moves on to 1.3.
        let one_three = vault
            .create_note(None, Placement::Aside { of: one_one.id })
            .unwrap();
        vault
            .create_note(
                Some("loose".into()),
                Placement::Unaddressed {
                    folder: String::new(),
                },
            )
            .unwrap();

        assert_eq!(two.address.as_deref(), Some("2"));
        assert_eq!(one_two.address.as_deref(), Some("1.2"));
        assert_eq!(one_one_a.address.as_deref(), Some("1.1a"));
        assert_eq!(one_three.address.as_deref(), Some("1.3"));
        let tree = vault.tree();
        assert_eq!(
            addresses(&zettelkasten(&tree).notes),
            ["1[1.1[1.1a] 1.2 1.3]", "2"]
        );
        assert_eq!(tree.notes.len(), 1, "the unaddressed note is in the root");

        let loose = vault.notes().find(|n| n.address.is_none()).unwrap().id;
        assert!(matches!(
            vault.create_note(None, Placement::Next { of: loose }),
            Err(VaultError::NoAddress(_))
        ));
    }

    #[test]
    fn orphans_attach_to_nearest_ancestor_and_bad_headers_are_reported() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        let root = vault.create_note(None, Placement::Top).unwrap();
        let orphan = vault.create_note(None, Placement::Top).unwrap();
        vault
            .write_note(orphan.id, "#metadata((address: \"1.1a1\")) <note>")
            .unwrap();
        let broken = vault
            .write_note(root.id, "#metadata((title: 1 + 1, address: \"1\")) <note>")
            .unwrap();

        assert!(broken.header_error.is_some());
        assert_eq!(
            addresses(&zettelkasten(&vault.tree()).notes),
            ["1.1a1", "-"]
        );
    }

    #[test]
    fn permanent_delete_removes_file_and_index_entry() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        let note = vault
            .create_note(
                None,
                Placement::Unaddressed {
                    folder: String::new(),
                },
            )
            .unwrap();
        vault.delete_note(note.id, DeleteMode::Permanent).unwrap();
        assert!(matches!(
            vault.read_note(note.id),
            Err(VaultError::NoteNotFound(_))
        ));
        assert!(!dir.0.join(format!("{}.typ", note.id)).exists());
    }
    fn render(vault: &Vault, id: Uuid) -> (String, Vec<String>) {
        render_themed(vault, id, false)
    }

    fn render_themed(vault: &Vault, id: Uuid, dark: bool) -> (String, Vec<String>) {
        let mut engine = sliver_typst::Engine::new();
        engine
            .set_source(
                crate::LINKS_PATH,
                &crate::link_library(crate::LinkDisplay::Title),
            )
            .unwrap();
        let targets: Vec<String> = vault
            .links_from(id)
            .unwrap()
            .iter()
            .map(|l| l.target.clone())
            .collect();
        engine
            .set_source(
                &crate::link_table_path(&id.to_string()),
                &vault.link_table(&targets),
            )
            .unwrap();
        engine
            .set_source(
                &crate::page_path(&id.to_string()),
                "#let page-width = 400pt",
            )
            .unwrap();
        engine
            .set_source(crate::THEME_PATH, &crate::theme_library(dark))
            .unwrap();
        for note in vault.notes() {
            let path = format!("/notes/{}.typ", note.id);
            engine
                .set_source(&path, &vault.read_note(note.id).unwrap())
                .unwrap();
        }
        for kind in std::iter::once(None).chain(vault.kinds().map(Some)) {
            if let Some(text) = vault.preamble_text(kind).unwrap() {
                engine.set_source(&preamble_path(kind), &text).unwrap();
            }
        }
        let references = vault.references().unwrap();
        let keys = crate::citations::bib_entries(&references);
        engine
            .set_source(crate::REFERENCES_PATH, &references)
            .unwrap();
        engine
            .set_source(
                crate::CITATIONS_PATH,
                &crate::citation_library(
                    keys.iter().map(|e| e.key),
                    &crate::CitationOptions {
                        style: "apa",
                        styles: &["apa".into(), "ieee".into()],
                        show_references: true,
                        enabled: true,
                    },
                ),
            )
            .unwrap();
        let preview = vault.preview(id).unwrap();
        engine
            .set_prefix(&format!("/notes/{id}.typ"), &preview.prefix)
            .unwrap();
        engine
            .set_source("/.sliver/main.typ", &preview.main)
            .unwrap();
        let out = engine.compile("/.sliver/main.typ", true).unwrap();
        let messages = out.diagnostics.iter().map(|d| d.message.clone()).collect();
        let svg = match out.pages {
            Some(_) => engine.page_svgs("/.sliver/main.typ").unwrap().concat(),
            None => String::new(),
        };
        (svg, messages)
    }

    #[test]
    fn resolves_links_and_computes_backlinks() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        let a = vault.create_note(Some("A".into()), Placement::Top).unwrap();
        let b = vault
            .create_note(Some("B".into()), Placement::Next { of: a.id })
            .unwrap();
        let loose = vault
            .create_note(
                Some("Loose".into()),
                Placement::Unaddressed {
                    folder: String::new(),
                },
            )
            .unwrap();
        vault
            .write_note(
                a.id,
                &format!(
                    "#metadata((address: \"1\")) <note>\n[[1.1]] and [[{}|loose one]] and [[9.9]]",
                    loose.id
                ),
            )
            .unwrap();
        vault
            .write_note(
                b.id,
                "#metadata((address: \"1.1\")) <note>\n[[1]] and `[[1.1]]`",
            )
            .unwrap();

        assert_eq!(vault.resolve("1.1"), Some(b.id));
        assert_eq!(vault.resolve(&loose.id.to_string()), Some(loose.id));
        assert_eq!(vault.resolve("9.9"), None);
        assert_eq!(vault.links_from(a.id).unwrap().len(), 3);
        let ids = |notes: Vec<NoteSummary>| notes.into_iter().map(|n| n.id).collect::<Vec<_>>();
        assert_eq!(ids(vault.backlinks(b.id).unwrap()), vec![a.id]);
        assert_eq!(ids(vault.backlinks(loose.id).unwrap()), vec![a.id]);
        assert_eq!(ids(vault.backlinks(a.id).unwrap()), vec![b.id]);

        let reopened = Vault::open(&dir.0).unwrap();
        assert_eq!(ids(reopened.backlinks(b.id).unwrap()), vec![a.id]);
    }

    #[test]
    fn preview_renders_wikilinks_as_note_links() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        let a = vault.create_note(Some("A".into()), Placement::Top).unwrap();
        let b = vault
            .create_note(Some("Quote \" title".into()), Placement::Next { of: a.id })
            .unwrap();
        vault
            .write_note(
                a.id,
                "#metadata((title: \"A\", address: \"1\")) <note>\n[[1.1]] [[1.1|custom]] [[9.9]] `[[1.1]]`",
            )
            .unwrap();

        let (svg, diagnostics) = render(&vault, a.id);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let href = format!("href=\"sliver://{}\"", b.id);
        // Typst SVG writes each link as two anchors (href and xlink:href).
        assert_eq!(svg.matches(&href).count(), 2 * 2, "only the two real links");
        assert!(!svg.contains("sliver://9.9"));

        let before = svg.clone();
        vault.rename_note(b.id, "Renamed").unwrap();
        assert_ne!(
            render(&vault, a.id).0,
            before,
            "title change re-renders the link"
        );
    }
    #[test]
    fn stores_packages_by_spec() {
        let dir = TempDir::new();
        let vault = Vault::create(&dir.0).unwrap();
        assert_eq!(vault.load_package("@preview/demo:0.1.0").unwrap(), None);
        vault.save_package("@preview/demo:0.1.0", b"gz").unwrap();
        assert_eq!(
            vault.load_package("@preview/demo:0.1.0").unwrap(),
            Some(b"gz".to_vec())
        );
        assert!(
            dir.0
                .join(".sliver/pkg/preview/demo-0.1.0.tar.gz")
                .is_file()
        );
        for bad in ["demo", "@preview/../x:0.1.0", "@preview/demo:latest"] {
            assert!(
                matches!(
                    vault.save_package(bad, b""),
                    Err(VaultError::InvalidPackage(_))
                ),
                "{bad}"
            );
        }
    }

    fn folder_paths(folder: &FolderNode) -> Vec<String> {
        folder
            .folders
            .iter()
            .flat_map(|f| [vec![f.path.clone()], folder_paths(f)].concat())
            .collect()
    }

    #[test]
    fn folders_are_directories_and_survive_reopening() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        assert!(dir.0.join("Zettelkasten/.zettelkasten").is_file());
        vault.create_folder("", "Projects").unwrap();
        vault.create_folder("Projects", "Sliver").unwrap();
        vault.create_folder("", "Inbox").unwrap();
        let in_project = vault
            .create_note(
                Some("Plan".into()),
                Placement::Unaddressed {
                    folder: "Projects/Sliver".into(),
                },
            )
            .unwrap();
        let filed = vault.create_note(None, Placement::Top).unwrap();
        assert!(
            dir.0
                .join(format!("Projects/Sliver/{}.typ", in_project.id))
                .is_file()
        );
        assert_eq!(filed.folder, "Zettelkasten");

        for bad in ["", ".hidden", "a/b", "a\\b", "trailing.", " padded", "q?"] {
            assert!(
                matches!(
                    vault.create_folder("", bad),
                    Err(VaultError::InvalidFolderName(_))
                ),
                "{bad:?}"
            );
        }
        assert!(matches!(
            vault.create_folder("", "inbox"),
            Err(VaultError::FolderExists(_))
        ));
        assert!(matches!(
            vault.create_folder("Zettelkasten", "Sub"),
            Err(VaultError::Refused(_))
        ));

        assert_eq!(
            vault.rename_folder("Projects", "Work").unwrap().path,
            "Work"
        );
        assert_eq!(vault.note(in_project.id).unwrap().folder, "Work/Sliver");
        assert_eq!(
            vault
                .rename_folder("Zettelkasten", "Slip box")
                .unwrap()
                .path,
            "Slip box"
        );
        assert_eq!(vault.zettelkasten().unwrap(), "Slip box");
        vault.move_to_folder(in_project.id, "Inbox").unwrap();

        let reopened = Vault::open(&dir.0).unwrap();
        let tree = reopened.tree();
        assert_eq!(
            folder_paths(&tree),
            ["Inbox", "Slip box", "Work", "Work/Sliver"]
        );
        assert_eq!(reopened.zettelkasten().unwrap(), "Slip box");
        assert_eq!(addresses(&zettelkasten(&tree).notes), ["1"]);
        assert_eq!(reopened.note(in_project.id).unwrap().folder, "Inbox");
        assert_eq!(
            reopened.read_note(in_project.id).unwrap(),
            vault.read_note(in_project.id).unwrap()
        );
    }

    #[test]
    fn deleting_a_folder_removes_its_notes_but_never_the_zettelkasten() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        vault.create_folder("", "Old").unwrap();
        vault.create_folder("Old", "Deeper").unwrap();
        let gone = vault
            .create_note(
                None,
                Placement::Unaddressed {
                    folder: "Old/Deeper".into(),
                },
            )
            .unwrap();
        vault.create_note(None, Placement::Top).unwrap();

        assert!(matches!(
            vault.delete_folder("Zettelkasten", DeleteMode::Permanent),
            Err(VaultError::Refused(_))
        ));
        assert_eq!(
            vault.delete_folder("Old", DeleteMode::Permanent).unwrap(),
            vec![gone.id]
        );
        assert!(!dir.0.join("Old").exists());
        assert!(vault.note(gone.id).is_err());
        assert_eq!(folder_paths(&vault.tree()), ["Zettelkasten"]);
    }

    #[test]
    fn a_vault_without_a_marker_needs_a_zettelkasten_set() {
        let dir = TempDir::new();
        Vault::create(&dir.0).unwrap();
        fs::remove_file(dir.0.join("Zettelkasten/.zettelkasten")).unwrap();
        fs::create_dir_all(dir.0.join(".git/objects")).unwrap();
        fs::write(dir.0.join(format!(".git/{}.typ", Uuid::new_v4())), "").unwrap();
        let mut vault = Vault::open(&dir.0).unwrap();
        assert!(matches!(
            vault.create_note(None, Placement::Top),
            Err(VaultError::NoZettelkasten)
        ));
        assert_eq!(folder_paths(&vault.tree()), ["Zettelkasten"]);
        assert_eq!(vault.notes().count(), 0, "dot directories are skipped");

        vault.set_zettelkasten("Zettelkasten").unwrap();
        assert!(matches!(
            vault.set_zettelkasten("Zettelkasten"),
            Err(VaultError::Refused(_))
        ));
        assert_eq!(
            vault
                .create_note(None, Placement::Top)
                .unwrap()
                .address
                .as_deref(),
            Some("1")
        );
    }

    #[test]
    fn preambles_reach_notes_by_kind() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        let common = vault.preambles().unwrap();
        assert_eq!(common.len(), 1);
        assert!(common[0].exists && common[0].warnings.is_empty());
        vault
            .save_preamble(
                None,
                "#let shout(x) = upper(x)\n#let template(body) = { set text(fill: rgb(\"#123456\")); body }",
            )
            .unwrap();

        vault.create_kind("Literature").unwrap();
        assert!(matches!(
            vault.create_kind("literature"),
            Err(VaultError::KindExists(_))
        ));
        assert!(matches!(
            vault.create_kind(".hidden"),
            Err(VaultError::InvalidKindName(_))
        ));
        let warnings = vault
            .save_preamble(
                Some("Literature"),
                "#let template(body) = { set text(fill: rgb(\"#654321\")); body }\n#let cited = [cited]\n#set text(red)",
            )
            .unwrap();
        assert_eq!(warnings.len(), 1, "top-level set rule");

        let note = vault
            .create_note_of_kind(
                Some("Paper".into()),
                Placement::Unaddressed {
                    folder: String::new(),
                },
                Some("Literature".into()),
                "",
            )
            .unwrap();
        assert_eq!(note.kind.as_deref(), Some("Literature"));
        let text = vault.read_note(note.id).unwrap();
        vault
            .write_note(note.id, &format!("{text}#shout[a] #cited"))
            .unwrap();
        let preview = vault.preview(note.id).unwrap();
        assert_eq!(preview.prefix.lines().count(), 2);
        let (svg, diagnostics) = render(&vault, note.id);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        assert!(svg.contains("#654321"), "the kind's template wins");

        assert_eq!(
            vault.rename_kind("Literature", "Reading").unwrap(),
            vec![note.id]
        );
        assert_eq!(
            vault.note(note.id).unwrap().kind.as_deref(),
            Some("Reading")
        );
        assert!(
            vault
                .read_note(note.id)
                .unwrap()
                .contains("kind: \"Reading\"")
        );
        assert_eq!(
            Vault::open(&dir.0).unwrap().kinds().collect::<Vec<_>>(),
            ["Reading"]
        );

        vault.delete_kind("Reading", DeleteMode::Permanent).unwrap();
        assert_eq!(vault.preview(note.id).unwrap().prefix.lines().count(), 1);
        let tree = vault.tree();
        assert!(
            tree.notes[0]
                .warning
                .as_deref()
                .unwrap()
                .contains("Reading")
        );
        vault.set_kind(note.id, None).unwrap();
        assert_eq!(vault.note(note.id).unwrap().kind, None);
        assert!(vault.tree().notes[0].warning.is_none());
    }

    #[test]
    fn preview_follows_the_theme_unless_a_note_opts_out() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        assert_eq!(
            fs::read_to_string(dir.0.join(THEME_FILE)).unwrap(),
            crate::theme_library(false)
        );
        let themed = vault.create_note(None, Placement::Top).unwrap().id;
        vault
            .write_note(themed, "#metadata((title: \"Themed\")) <note>\nSome text")
            .unwrap();
        let plain = vault.create_note(None, Placement::Top).unwrap().id;
        vault
            .write_note(
                plain,
                "#metadata((title: \"Plain\", theme: false)) <note>\n#import \"/.sliver/theme.typ\": untheme\nText #untheme[x] #table[a]",
            )
            .unwrap();

        let (light, diagnostics) = render_themed(&vault, themed, false);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (dark, diagnostics) = render_themed(&vault, themed, true);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        assert!(
            light.contains("#ffffff") && dark.contains("#232323"),
            "page fill"
        );
        assert!(dark.contains("#e8e8e8"), "dark ink");
        vault
            .write_note(
                themed,
                "#metadata((title: \"Themed\")) <note>\n#link(\"https://typst.app\")[x]",
            )
            .unwrap();
        let (linked, diagnostics) = render_themed(&vault, themed, true);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        assert!(linked.contains("#6d9bff"), "links in the accent colour");

        let (opted_out, diagnostics) = render_themed(&vault, plain, true);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        assert!(opted_out.contains("#0f0f0f") && !opted_out.contains("#e8e8e8"));
    }

    #[test]
    fn citations_render_and_unknown_keys_never_fail() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        let note = vault
            .create_note(
                Some("Cites".into()),
                Placement::Unaddressed {
                    folder: String::new(),
                },
            )
            .unwrap();
        let header = vault.read_note(note.id).unwrap();
        vault
            .write_note(
                note.id,
                &format!("{header}#set heading(numbering: \"1.\")\n= Intro <intro>\nSee @doe2020 @roe2021, @intro and @missing.\n"),
            )
            .unwrap();
        assert_eq!(
            vault.missing_references(),
            BTreeSet::from(["doe2020".into(), "missing".into(), "roe2021".into()])
        );

        // Nothing fetched yet: every citation is unknown, and still renders.
        let (svg, messages) = render(&vault, note.id);
        assert!(messages.is_empty(), "{messages:?}");
        assert!(!svg.contains("sliver-cite:"));

        let exported = "@article{doe2020, title = {A Study}, author = {Doe, Jane}, date = {2020}, file = {/x.pdf}}\n\
            @book{roe2021, title = {A Book}, author = {Roe, Rick}, date = {2021}}\n\
            @book{unused, title = {Unused}}\n";
        assert!(vault.update_references(exported, true).unwrap());
        assert!(!vault.update_references(exported, true).unwrap());
        assert_eq!(
            vault
                .reference_list()
                .unwrap()
                .into_iter()
                .map(|r| r.key)
                .collect::<Vec<_>>(),
            ["doe2020", "roe2021"]
        );
        assert_eq!(
            vault.missing_references(),
            BTreeSet::from(["missing".into()])
        );
        assert!(!vault.references().unwrap().contains("x.pdf"));

        let (svg, messages) = render(&vault, note.id);
        assert!(messages.is_empty(), "{messages:?}");
        assert!(svg.contains("sliver-cite:doe2020"));

        // A note's own style wins; an unknown one is ignored, with a notice.
        let text = vault.read_note(note.id).unwrap();
        vault
            .write_note(
                note.id,
                &text.replacen("))", ", citation-style: \"ieee\"))", 1),
            )
            .unwrap();
        let (_, messages) = render(&vault, note.id);
        assert!(messages.is_empty(), "{messages:?}");
        let text = vault.read_note(note.id).unwrap();
        vault
            .write_note(note.id, &text.replace("\"ieee\"", "\"nope\""))
            .unwrap();
        let (_, messages) = render(&vault, note.id);
        assert!(messages.is_empty(), "{messages:?}");
    }

    #[test]
    fn templates_fall_back_to_the_default_and_follow_their_kind() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        vault.create_kind("Paper").unwrap();
        assert_eq!(
            vault.note_template(Some("Paper")).unwrap(),
            crate::preambles::DEFAULT_TEMPLATE
        );
        vault.save_template(None, "").unwrap();
        assert_eq!(vault.note_template(Some("Paper")).unwrap(), "");
        vault.save_template(None, "= {{title}}\n").unwrap();
        assert_eq!(vault.note_template(Some("Paper")).unwrap(), "= {{title}}\n");
        vault
            .save_template(Some("Paper"), "Read on {{date}}.")
            .unwrap();
        assert_eq!(
            vault.note_template(Some("Paper")).unwrap(),
            "Read on {{date}}."
        );
        assert_eq!(vault.templates().unwrap().len(), 2);

        vault.rename_kind("Paper", "Article").unwrap();
        assert_eq!(
            vault.note_template(Some("Article")).unwrap(),
            "Read on {{date}}."
        );
        vault.delete_kind("Article", DeleteMode::Permanent).unwrap();
        assert!(!dir.0.join(template_file(Some("Article"))).exists());

        let note = vault
            .create_note_of_kind(
                Some("A".into()),
                Placement::Unaddressed {
                    folder: String::new(),
                },
                None,
                "= A\n\nBody.\n",
            )
            .unwrap();
        assert!(
            vault
                .read_note(note.id)
                .unwrap()
                .ends_with("<note>\n\n= A\n\nBody.\n")
        );
    }
}
