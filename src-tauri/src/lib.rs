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
        .plugin(tauri_plugin_window_state::Builder::new().build())
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
            commands::create_folder,
            commands::rename_folder,
            commands::delete_folder,
            commands::set_zettelkasten,
            commands::move_to_folder,
            commands::plan_move,
            commands::apply_move,
            commands::backlinks,
            commands::resolve_link,
            commands::link_library,
            commands::preview_main,
            commands::list_preambles,
            commands::save_preamble,
            commands::create_kind,
            commands::rename_kind,
            commands::delete_kind,
            commands::set_kind,
            commands::theme_library,
            commands::analyze,
            commands::load_workspace,
            commands::save_workspace,
            commands::load_settings,
            commands::save_settings,
            commands::load_package,
            commands::save_package,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
