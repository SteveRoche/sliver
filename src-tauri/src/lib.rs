mod commands;
mod state;

use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::OpenVault(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            commands::create_vault,
            commands::open_vault,
            commands::last_vault,
            commands::list_tree,
            commands::create_note,
            commands::read_note,
            commands::write_note,
            commands::rename_note,
            commands::delete_note,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
