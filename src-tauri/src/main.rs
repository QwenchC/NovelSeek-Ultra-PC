// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod api;
mod services;
mod models;
mod commands;

use tauri::Manager;

#[tokio::main]
async fn main() {
    env_logger::init();

    tauri::Builder::default()
        .setup(|app| {
            // Initialize database
            let app_handle = app.handle();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = db::init_database(&app_handle).await {
                    log::error!("Failed to initialize database: {}", e);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::project::create_project,
            commands::project::get_projects,
            commands::project::get_project,
            commands::project::update_project,
            commands::project::delete_project,
            commands::chapter::create_chapter,
            commands::chapter::get_chapters,
            commands::chapter::update_chapter,
            commands::chapter::update_chapter_meta,
            commands::chapter::delete_chapter,
            commands::chapter::recalculate_project_word_count,
            commands::chapter::get_chapter_counts,
            commands::content::import_novel_content,
            commands::content::export_novel_content,
            commands::backup::import_backup_atomic,
            commands::backup::get_pending_backup_metadata,
            commands::backup::ack_backup_metadata,
            commands::snapshot::snapshot_create,
            commands::snapshot::snapshot_list,
            commands::snapshot::snapshot_get,
            commands::snapshot::snapshot_rename,
            commands::snapshot::snapshot_delete,
            commands::tts::edge_tts_synthesize,
            commands::ai::ai_chat,
            commands::scoped_ai::request_scoped_ai,
            commands::scoped_ai::cancel_scoped_ai,
            commands::writing::adopt_chapter_candidate,
            commands::illustration::update_chapter_illustrations,
            commands::ai::generate_outline,
            commands::ai::generate_chapter,
            commands::ai::generate_image,
            commands::ai::generate_prologue,
            commands::ai::generate_revision,
            commands::ai::generate_character_appearance,
            commands::ai::generate_plot_arc,
            commands::ai::generate_character_portrait_prompt,
            commands::ai::test_deepseek_connection,
            commands::ai::test_text_connection,
            commands::ai::test_pollinations_connection,
            commands::ai::test_comfyui_connection,
            commands::stream::generate_outline_stream,
            commands::stream::generate_prologue_stream,
            commands::stream::generate_chapter_stream,
            commands::stream::generate_long_novel_outline_stream,
            commands::stream::continue_outline_stream,
            commands::stream::generate_character_relationships_stream,
            commands::stream::generate_character_events_stream,
            commands::stream::generate_characters_from_outline_stream,
            commands::stream::generate_chapter_outline_stream,
            commands::stream::generate_arc_mini_outline_stream,
            commands::stream::cancel_generation,
            commands::stream::generate_illustration_prompt,
            commands::stream::generate_chapter_promo,
            commands::stream::generate_promo_image,
            commands::system::list_system_fonts,
            commands::system::get_system_font_base64,
            commands::system::set_window_theme,
            commands::knowledge::kb_index_chapter,
            commands::knowledge::kb_retrieve_context,
            commands::knowledge::kb_forget_source,
            commands::knowledge::kb_test_embedding,
            commands::knowledge::kb_get_stats,
            commands::knowledge::kb_generate_chapter_summary,
            commands::knowledge::kb_generate_arc_summary,
            commands::knowledge::kb_generate_book_summary,
            commands::knowledge::kb_list_summaries,
            commands::knowledge::kb_mark_rollups_stale,
            commands::knowledge::kb_forget_summary,
            commands::knowledge::kb_extract_entities,
            commands::knowledge::kb_list_entities,
            commands::knowledge::kb_set_entity_status,
            commands::knowledge::kb_handle_chapter_deletion,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
