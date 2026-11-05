pub mod address;
pub mod header;
pub mod links;
pub mod preambles;
pub mod syntax;
pub mod theme;
mod vault;

pub use address::{Address, AddressError};
pub use header::{
    HEADER_LABEL, HeaderError, NoteHeader, format_header, header_in, read_header, set_address,
    set_kind, set_title,
};
pub use links::{
    LINK_SCHEME, LINKS_PATH, LinkDisplay, WikiLink, link_library, links_in, page_path,
    preview_main, preview_main_path,
};
pub use preambles::{PreambleWarning, preamble_path};
pub use syntax::{Analysis, LinkRange, analyze};
pub use theme::{THEME_PATH, theme_library};
pub use uuid::Uuid;
pub use vault::{
    AddressChange, DeleteMode, FolderKind, FolderNode, LinkEdits, MovePlan, NotePreview,
    NoteSummary, Placement, Preamble, TreeNode, Vault, VaultError,
};
