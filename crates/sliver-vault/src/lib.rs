pub mod address;
pub mod citations;
pub mod header;
pub mod links;
pub mod paths;
pub mod preambles;
pub mod syntax;
pub mod theme;
mod vault;

pub use address::{Address, AddressError};
pub use citations::{
    CITATIONS_PATH, CITE_SCHEME, Citation, CitationOptions, REFERENCES_PATH, citation_library,
    citations_in,
};
pub use header::{
    HEADER_LABEL, HeaderError, NoteHeader, format_header, header_in, read_header, set_address,
    set_kind, set_title,
};
pub use links::{
    LINK_SCHEME, LINKS_PATH, LinkDisplay, WikiLink, link_library, links_in, page_path,
    preview_main, preview_main_path,
};
pub use preambles::{PreambleWarning, default_text, preamble_path};
pub use syntax::{Analysis, CitationRange, LinkRange, analyze};
pub use theme::{THEME_PATH, theme_library};
pub use uuid::Uuid;
pub use vault::{
    AddressChange, AssetNode, CitationStyle, DeleteMode, DiskChanges, FolderKind, FolderNode,
    LinkEdits, MovePlan, Moved, NotePreview, NoteSummary, PathPlan, Placement, Preamble, Reference,
    SETTINGS_FILE, Template, TreeNode, Vault, VaultError,
};
