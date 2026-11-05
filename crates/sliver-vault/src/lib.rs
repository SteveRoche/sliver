pub mod address;
pub mod header;
pub mod links;
pub mod theme;
mod vault;

pub use address::{Address, AddressError};
pub use header::{
    HEADER_LABEL, HeaderError, NoteHeader, format_header, header_in, read_header, set_address,
    set_title,
};
pub use links::{
    LINK_SCHEME, LINKS_PATH, LinkDisplay, PAGE_PATH, WikiLink, link_library, links_in,
    preview_main, preview_main_path,
};
pub use theme::{THEME_PATH, theme_library};
pub use uuid::Uuid;
pub use vault::{
    AddressChange, DeleteMode, FolderKind, FolderNode, LinkEdits, MovePlan, NoteSummary, Placement,
    TreeNode, Vault, VaultError,
};
