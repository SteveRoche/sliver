//! A vault on disk: `notes/<uuid>.typ` plus a `.sliver/` directory. The note
//! files are the only source of truth; the index here is rebuilt from their
//! headers on open and kept current by every write that goes through `Vault`.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::header::{HeaderError, NoteHeader, format_header, header_in, set_title};
use crate::links::{LinkDisplay, LinkTarget, WikiLink, link_library, links_in};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::Address;

const NOTES_DIR: &str = "notes";
const META_DIR: &str = ".sliver";
const TMP_DIR: &str = ".sliver/tmp";
const PKG_DIR: &str = ".sliver/pkg";
const WORKSPACE_FILE: &str = ".sliver/workspace.json";
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TreeNode {
    #[serde(flatten)]
    pub note: NoteSummary,
    pub children: Vec<TreeNode>,
}

/// Where a new note goes in the Zettelkasten.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Placement {
    Unaddressed,
    /// The next free top-level number.
    Top,
    /// The next free sibling after `of`: `1.1a` -> `1.1b`.
    Continuation {
        of: Uuid,
    },
    /// The first free child of `of`: `1.1a` -> `1.1a1`.
    Branch {
        of: Uuid,
    },
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
            Self::NoAddress(id) => write!(f, "note {id} has no Zettelkasten address"),
            Self::Header(err) => write!(f, "{err}"),
            Self::Trash(err) => write!(f, "could not move note to trash: {err}"),
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
}

impl Vault {
    /// Initializes a vault in `root`, which must be missing or empty.
    pub fn create(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        if root.exists() && fs::read_dir(&root)?.next().is_some() {
            return Err(VaultError::NotEmpty(root));
        }
        fs::create_dir_all(root.join(NOTES_DIR))?;
        fs::create_dir_all(root.join(META_DIR))?;
        Ok(Self {
            root,
            notes: HashMap::new(),
            links: HashMap::new(),
        })
    }

    /// Opens an existing vault and indexes every note header.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        if !root.join(META_DIR).is_dir() || !root.join(NOTES_DIR).is_dir() {
            return Err(VaultError::NotAVault(root));
        }
        let mut vault = Self {
            root,
            notes: HashMap::new(),
            links: HashMap::new(),
        };
        for entry in fs::read_dir(vault.root.join(NOTES_DIR))? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some(EXTENSION) {
                continue;
            }
            let Some(id) = path
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| Uuid::parse_str(s).ok())
            else {
                continue;
            };
            vault.index(id, &fs::read_to_string(&path)?);
        }
        Ok(vault)
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

    /// Addressed notes nested under their nearest existing ancestor in address
    /// order, followed by unaddressed notes (and invalid addresses) by title.
    pub fn tree(&self) -> Vec<TreeNode> {
        let mut addressed: Vec<(Address, &NoteSummary)> = Vec::new();
        let mut loose: Vec<&NoteSummary> = Vec::new();
        for note in self.notes.values() {
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

        fn build(
            i: usize,
            addressed: &[(Address, &NoteSummary)],
            children: &[Vec<usize>],
        ) -> TreeNode {
            TreeNode {
                note: addressed[i].1.clone(),
                children: children[i]
                    .iter()
                    .map(|&c| build(c, addressed, children))
                    .collect(),
            }
        }
        roots
            .into_iter()
            .map(|i| build(i, &addressed, &children))
            .chain(loose.into_iter().map(|note| TreeNode {
                note: note.clone(),
                children: Vec::new(),
            }))
            .collect()
    }

    pub fn read_note(&self, id: Uuid) -> Result<String> {
        self.note(id)?;
        Ok(fs::read_to_string(self.note_path(id))?)
    }

    pub fn write_note(&mut self, id: Uuid, text: &str) -> Result<NoteSummary> {
        self.note(id)?;
        self.write_file(id, text)
    }

    pub fn create_note(
        &mut self,
        title: Option<String>,
        placement: Placement,
    ) -> Result<NoteSummary> {
        let address = self.allocate(placement)?.map(|a| a.to_string());
        let header = format_header(&NoteHeader {
            title,
            address,
            tags: Vec::new(),
        });
        self.write_file(Uuid::new_v4(), &format!("{header}\n\n"))
    }

    pub fn rename_note(&mut self, id: Uuid, title: &str) -> Result<NoteSummary> {
        let text = set_title(&self.read_note(id)?, title)?;
        self.write_file(id, &text)
    }

    pub fn delete_note(&mut self, id: Uuid, mode: DeleteMode) -> Result<()> {
        self.note(id)?;
        let path = self.note_path(id);
        match mode {
            DeleteMode::Trash => {
                trash::delete(&path).map_err(|e| VaultError::Trash(e.to_string()))?
            }
            DeleteMode::Permanent => fs::remove_file(&path)?,
        }
        self.notes.remove(&id);
        self.links.remove(&id);
        Ok(())
    }

    fn allocate(&self, placement: Placement) -> Result<Option<Address>> {
        let taken: HashSet<Address> = self
            .notes
            .values()
            .filter_map(|n| n.address.as_deref()?.parse().ok())
            .collect();
        let address_of = |id: Uuid| -> Result<Address> {
            self.note(id)?
                .address
                .as_deref()
                .and_then(|a| a.parse().ok())
                .ok_or(VaultError::NoAddress(id))
        };
        let mut candidate = match placement {
            Placement::Unaddressed => return Ok(None),
            Placement::Top => {
                let max = taken.iter().map(Address::top_number).max().unwrap_or(0);
                return Ok(Some(Address::top(max + 1)));
            }
            Placement::Continuation { of } => address_of(of)?.continuation(),
            Placement::Branch { of } => address_of(of)?.branch(),
        };
        while taken.contains(&candidate) {
            candidate = candidate.continuation();
        }
        Ok(Some(candidate))
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

    fn index(&mut self, id: Uuid, text: &str) -> &NoteSummary {
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
            },
        );
        &self.notes[&id]
    }

    fn note_path(&self, id: Uuid) -> PathBuf {
        self.root.join(NOTES_DIR).join(format!("{id}.{EXTENSION}"))
    }

    fn write_file(&mut self, id: Uuid, text: &str) -> Result<NoteSummary> {
        self.atomic_write(&self.note_path(id), text.as_bytes())?;
        Ok(self.index(id, text).clone())
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
        match fs::read_to_string(self.root.join(WORKSPACE_FILE)) {
            Ok(text) => Ok(Some(text)),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    pub fn save_workspace(&self, json: &str) -> Result<()> {
        self.atomic_write(&self.root.join(WORKSPACE_FILE), json.as_bytes())
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

/// Addressed notes in address order, then the rest by title; ties by id.
fn sort_key(note: &NoteSummary) -> (bool, Option<Address>, Option<&str>, Uuid) {
    let address = note.address.as_deref().and_then(|a| a.parse().ok());
    (address.is_none(), address, note.title.as_deref(), note.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("sliver-test-{}", Uuid::new_v4())))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
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
            .create_note(None, Placement::Branch { of: one.id })
            .unwrap();
        let one_two = vault
            .create_note(None, Placement::Continuation { of: one_one.id })
            .unwrap();
        let one_one_a = vault
            .create_note(None, Placement::Branch { of: one_one.id })
            .unwrap();
        // 1.2 is taken, so continuing 1.1 again moves on to 1.3.
        let one_three = vault
            .create_note(None, Placement::Continuation { of: one_one.id })
            .unwrap();
        vault
            .create_note(Some("loose".into()), Placement::Unaddressed)
            .unwrap();

        assert_eq!(two.address.as_deref(), Some("2"));
        assert_eq!(one_two.address.as_deref(), Some("1.2"));
        assert_eq!(one_one_a.address.as_deref(), Some("1.1a"));
        assert_eq!(one_three.address.as_deref(), Some("1.3"));
        assert_eq!(addresses(&vault.tree()), ["1[1.1[1.1a] 1.2 1.3]", "2", "-"]);

        let loose = vault.notes().find(|n| n.address.is_none()).unwrap().id;
        assert!(matches!(
            vault.create_note(None, Placement::Branch { of: loose }),
            Err(VaultError::NoAddress(_))
        ));
    }

    #[test]
    fn orphans_attach_to_nearest_ancestor_and_bad_headers_are_reported() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        let root = vault.create_note(None, Placement::Top).unwrap();
        let orphan = vault.create_note(None, Placement::Unaddressed).unwrap();
        vault
            .write_note(orphan.id, "#metadata((address: \"1.1a1\")) <note>")
            .unwrap();
        let broken = vault
            .write_note(root.id, "#metadata((title: 1 + 1, address: \"1\")) <note>")
            .unwrap();

        assert!(broken.header_error.is_some());
        assert_eq!(addresses(&vault.tree()), ["1.1a1", "-"]);
    }

    #[test]
    fn permanent_delete_removes_file_and_index_entry() {
        let dir = TempDir::new();
        let mut vault = Vault::create(&dir.0).unwrap();
        let note = vault.create_note(None, Placement::Unaddressed).unwrap();
        vault.delete_note(note.id, DeleteMode::Permanent).unwrap();
        assert!(matches!(
            vault.read_note(note.id),
            Err(VaultError::NoteNotFound(_))
        ));
        assert!(!vault.note_path(note.id).exists());
    }
    fn render(vault: &Vault, id: Uuid) -> (String, Vec<String>) {
        let mut engine = sliver_typst::Engine::new();
        engine
            .set_source(crate::LINKS_PATH, &vault.link_library(LinkDisplay::Title))
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
            .create_note(Some("B".into()), Placement::Branch { of: a.id })
            .unwrap();
        let loose = vault
            .create_note(Some("Loose".into()), Placement::Unaddressed)
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
            .create_note(
                Some("Quote \" title".into()),
                Placement::Branch { of: a.id },
            )
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
}
