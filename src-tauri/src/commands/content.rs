use tauri::State;
use sqlx::SqlitePool;
use crate::models::{ImportContentInput, ExportContent};

/// Legacy callers (including append-only manuscript import) also receive all-or-nothing writes.
#[tauri::command]
pub async fn import_novel_content(pool: State<'_, SqlitePool>, input: ImportContentInput) -> Result<(), String> {
    super::backup::import_transaction(pool.inner(), input, None).await.map(|_| ())
}

/// Read both tables from one consistent SQLite snapshot.
#[tauri::command]
pub async fn export_novel_content(pool: State<'_, SqlitePool>) -> Result<ExportContent, String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let projects = sqlx::query_as("SELECT * FROM projects ORDER BY created_at")
        .fetch_all(&mut *tx).await.map_err(|e| e.to_string())?;
    let chapters = sqlx::query_as("SELECT * FROM chapters ORDER BY project_id, order_index")
        .fetch_all(&mut *tx).await.map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(ExportContent { projects, chapters })
}
