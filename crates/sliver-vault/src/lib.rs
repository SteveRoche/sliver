pub mod address;
pub mod header;
mod vault;

pub use address::{Address, AddressError};
pub use header::{HEADER_LABEL, HeaderError, NoteHeader, format_header, read_header, set_title};
pub use uuid::Uuid;
pub use vault::{DeleteMode, NoteSummary, Placement, TreeNode, Vault, VaultError};
