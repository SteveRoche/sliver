//! A vault on disk: notes as `<uuid>.typ` files in folders (plain
//! directories at any depth), plus a `.sliver/` directory. One folder, marked
//! by a `.zettelkasten` file, is the Zettelkasten: the only place notes have
//! addresses. The note files are the only source of truth; the index here is
//! rebuilt from their headers on open and kept current by every write that
//! goes through `Vault`.

mod moves;

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::header::{HeaderError, NoteHeader, format_header, header_in, set_title};
use crate::links::{LinkDisplay, LinkTarget, WikiLink, link_library, links_in};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::Address;

pub use moves::{AddressChange, LinkEdits, MovePlan};

const META_DIR: &str = ".sliver";
const TMP_DIR: &str = ".sliver/tmp";
const PKG_DIR: &str = ".sliver/pkg";
const WORKSPACE_FILE: &str = ".sliver/workspace.json";
const SETTINGS_FILE: &str = ".sliver/settings.json";
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
    /// Every folder (not the root), including empty ones.
    folders: BTreeSet<String>,
    zettelkasten: Option<String>,
    /// Further folders with a marker; only the first one found counts.
    extra_zettelkasten: Vec<String>,
    /// Files whose uuid was already taken by an earlier file, per uuid.
    duplicates: HashMap<Uuid, Vec<String>>,
}

impl Vault {
    fn empty(root: PathBuf) -> Self {
        Self {
            root,
            notes: HashMap::new(),
            links: HashMap::new(),
            folders: BTreeSet::new(),
            zettelkasten: None,
            extra_zettelkasten: Vec::new(),
            duplicates: HashMap::new(),
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
        Ok(vault)
    }

    /// Opens an existing vault and indexes every note header.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        if !root.join(META_DIR).is_dir() {
            return Err(VaultError::NotAVault(root));
        }
        let mut vault = Self::empty(root);
        let root = vault.root.clone();
        vault.scan(&root, "")?;
        vault.write_theme_file()?;
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

    /// Indexes `dir` depth first in name order, so "first found" is stable.
    /// Anything starting with a dot (`.sliver`, `.git`, markers) is skipped.
    fn scan(&mut self, dir: &Path, folder: &str) -> Result<()> {
        let mut entries = fs::read_dir(dir)?.collect::<io::Result<Vec<_>>>()?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let kind = entry.file_type()?;
            if kind.is_dir() {
                let sub = join_folder(folder, name);
                self.folders.insert(sub.clone());
                if path.join(ZETTELKASTEN_MARKER).is_file() {
                    if self.zettelkasten.is_none() {
                        self.zettelkasten = Some(sub.clone());
                    } else {
                        self.extra_zettelkasten.push(sub.clone());
                    }
                }
                self.scan(&path, &sub)?;
            } else if kind.is_file()
                && path.extension().and_then(|e| e.to_str()) == Some(EXTENSION)
                && let Some(id) = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .and_then(|s| Uuid::parse_str(s).ok())
            {
                if self.notes.contains_key(&id) {
                    self.duplicates
                        .entry(id)
                        .or_default()
                        .push(join_folder(folder, name));
                    continue;
                }
                self.index(id, folder, &fs::read_to_string(&path)?);
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
        });
        self.write_file(Uuid::new_v4(), &folder, &format!("{header}\n\n"))
    }

    pub fn rename_note(&mut self, id: Uuid, title: &str) -> Result<NoteSummary> {
        let text = set_title(&self.read_note(id)?, title)?;
        self.write_note(id, &text)
    }

    pub fn delete_note(&mut self, id: Uuid, mode: DeleteMode) -> Result<()> {
        remove_path(&self.note_path(id)?, mode)?;
        self.notes.remove(&id);
        self.links.remove(&id);
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

    /// Source of `/.sliver/links.typ` for the preview; see [`link_library`].
    pub fn link_library(&self, display: LinkDisplay) -> String {
        let mut notes: Vec<&NoteSummary> = self.notes.values().collect();
        notes.sort_by(|a, b| sort_key(a).cmp(&sort_key(b)));
        link_library(
            notes.into_iter().map(|n| LinkTarget {
                id: n.id.to_string(),
                title: n.title.as_deref(),
                address: n.address.as_deref(),
            }),
            display,
        )
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
    pub fn rename_folder(&mut self, path: &str, name: &str) -> Result<String> {
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
            return Ok(new_path);
        }
        fs::rename(self.folder_dir(path), self.folder_dir(&new_path))?;
        let rebase = |f: &str| rebase_folder(f, path, &new_path).unwrap_or_else(|| f.to_owned());
        self.folders = self.folders.iter().map(|f| rebase(f)).collect();
        for note in self.notes.values_mut() {
            note.folder = rebase(&note.folder);
        }
        if let Some(zk) = &mut self.zettelkasten {
            *zk = rebase(zk);
        }
        for f in &mut self.extra_zettelkasten {
            *f = rebase(f);
        }
        Ok(new_path)
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
            self.notes.remove(id);
            self.links.remove(id);
        }
        self.folders.retain(|f| !inside(f));
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
            if let Some(note) = self.notes.get_mut(&id) {
                note.folder = folder.to_owned();
            }
        }
        Ok(())
    }

    // --- files ---

    fn index(&mut self, id: Uuid, folder: &str, text: &str) -> &NoteSummary {
        let root = typst_syntax::parse(text);
        let (header, header_error) = match header_in(&root) {
            Ok(header) => (header.unwrap_or_default(), None),
            Err(err) => (NoteHeader::default(), Some(err.to_string())),
        };
        self.links.insert(id, links_in(&root));
        self.notes.insert(
            id,
            NoteSummary {
                id,
                title: header.title,
                address: header.address,
                tags: header.tags,
                header_error,
                folder: folder.to_owned(),
            },
        );
        &self.notes[&id]
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
        self.atomic_write(&self.file_path(folder, id), text.as_bytes())?;
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
fn validate_folder_name(name: &str) -> Result<()> {
    let invalid = name.is_empty()
        || name.starts_with('.')
        || name.ends_with(' ')
        || name.ends_with('.')
        || name.trim() != name
        || name.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*')
        });
    if invalid {
        return Err(VaultError::InvalidFolderName(name.to_owned()));
    }
    Ok(())
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
            .set_source(crate::LINKS_PATH, &vault.link_library(LinkDisplay::Title))
            .unwrap();
        engine
            .set_source(crate::PAGE_PATH, "#let page-width = 400pt")
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
        engine
            .set_source("/.sliver/main.typ", &crate::preview_main(&id.to_string()))
            .unwrap();
        let out = engine.compile("/.sliver/main.typ").unwrap();
        let messages = out.diagnostics.iter().map(|d| d.message.clone()).collect();
        (out.pages.concat(), messages)
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

        assert_eq!(vault.rename_folder("Projects", "Work").unwrap(), "Work");
        assert_eq!(vault.note(in_project.id).unwrap().folder, "Work/Sliver");
        assert_eq!(
            vault.rename_folder("Zettelkasten", "Slip box").unwrap(),
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
            light.contains("#ffffff") && dark.contains("#2b2b2b"),
            "page fill"
        );
        assert!(dark.contains("#e8e8e8"), "dark ink");

        let (opted_out, diagnostics) = render_themed(&vault, plain, true);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        assert!(opted_out.contains("#0f0f0f") && !opted_out.contains("#e8e8e8"));
    }
}
