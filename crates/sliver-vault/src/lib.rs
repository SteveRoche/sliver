pub mod address;
pub mod header;
pub mod links;
mod vault;

pub use address::{Address, AddressError};
pub use header::{
    HEADER_LABEL, HeaderError, NoteHeader, format_header, header_in, read_header, set_title,
};
pub use links::{
    LINK_SCHEME, LINKS_PATH, LinkDisplay, WikiLink, link_library, links_in, preview_main,
    preview_main_path,
};
pub use uuid::Uuid;
pub use vault::{DeleteMode, NoteSummary, Placement, TreeNode, Vault, VaultError};
