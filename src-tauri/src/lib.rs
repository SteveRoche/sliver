mod commands;
#[cfg(target_os = "macos")]
mod menu;
mod state;

use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::app_menu);
    builder
        .plugin(tauri_plugin_dialog::init())
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
            commands::backlinks,
            commands::resolve_link,
            commands::link_library,
            commands::preview_main,
            commands::load_workspace,
            commands::save_workspace,
            commands::get_settings,
            commands::set_settings,
            commands::load_package,
            commands::save_package,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
