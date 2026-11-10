mod commands;
mod compiler;
#[cfg(target_os = "macos")]
mod menu;
mod state;
mod watch;
mod window;
mod zotero;

use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(menu::app_menu)
        .on_menu_event(menu::on_menu_event);
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(commands::OpenVault(Mutex::new(None)))
        .manage(compiler::Compiler::default())
        .manage(watch::VaultWatcher::default())
        .setup(|app| Ok(window::create(app)?))
        .invoke_handler(tauri::generate_handler![
            compiler::typst_set_source,
            compiler::typst_set_prefix,
            compiler::typst_remove_source,
            compiler::typst_affected_mains,
            compiler::typst_forget_file,
            compiler::typst_add_package,
            compiler::typst_has_package,
            compiler::typst_compile,
            compiler::typst_complete,
            compiler::typst_tooltip,
            compiler::typst_signature,
            compiler::typst_jump_from_click,
            compiler::typst_jump_from_cursor,
            compiler::typst_metadata_text,
            compiler::typst_standalone,
            compiler::typst_citation_marks,
            compiler::typst_citation_styles,
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
            commands::place_for_address,
            commands::mark_section,
            commands::rename_section,
            commands::unmark_section,
            commands::apply_move,
            commands::backlinks,
            commands::link_library,
            commands::link_table,
            commands::preview_main,
            commands::default_text,
            commands::list_templates,
            commands::save_template,
            commands::note_template,
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
            commands::references,
            commands::citation_library,
            commands::citation_styles,
            commands::refresh_references,
            commands::zotero_ready,
            commands::zotero_search,
            commands::zotero_pick,
            commands::open_in_zotero,
            commands::quit,
            commands::read_file,
            commands::add_asset,
            commands::import_asset,
            commands::plan_path_move,
            commands::rename_asset,
            commands::move_asset,
            commands::delete_asset,
            commands::open_asset,
            commands::open_url,
            commands::restore_note,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
