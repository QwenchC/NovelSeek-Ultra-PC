use tauri::State;
use sqlx::SqlitePool;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use crate::models::{ImportContentInput, ImportProject, ImportChapter};
use crate::services::{ProjectService, ChapterService};

fn stub_project(id: String) -> ImportProject {
    ImportProject { id, title: "导入的项目 / Imported".into(), author: None, genre: None,
        description: None, language: None, target_word_count: None, current_word_count: 0,
        status: None, created_at: None, updated_at: None, cover_images: None, default_cover_id: None }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtomicBackupRequest {
    pub projects: Vec<ImportProject>, pub chapters: Vec<ImportChapter>, pub metadata_json: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReceipt {
    pub revision: String, pub imported_projects: usize, pub imported_chapters: usize,
}
#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PendingMetadata { pub revision: String, pub metadata_json: String }

pub async fn import_transaction(pool: &SqlitePool, input: ImportContentInput, metadata: Option<String>) -> Result<ImportReceipt, String> {
    let imported_projects = input.projects.len();
    let imported_chapters = input.chapters.len();
    let mut seen = HashSet::new();
    for p in &input.projects {
        if p.id.trim().is_empty() || !seen.insert(&p.id) { return Err("项目ID为空或重复".into()); }
    }
    seen.clear();
    for c in &input.chapters {
        if c.id.trim().is_empty() || c.project_id.trim().is_empty() || !seen.insert(&c.id) {
            return Err("章节ID为空或重复".into());
        }
    }
    if let Some(ref json) = metadata {
        if json.len() > 512 * 1024 * 1024 { return Err("导入元数据超过大小限制".into()); }
        let value: serde_json::Value = serde_json::from_str(json).map_err(|_| "导入元数据不是有效JSON")?;
        if !value.is_object() { return Err("导入元数据必须是对象".into()); }
    }
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM backup_metadata_outbox")
        .fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
    if pending > 0 { return Err("上次导入元数据尚未恢复，请重新打开软件或设置页面完成恢复后再导入".into()); }
    let existing: Vec<String> = sqlx::query_scalar("SELECT id FROM projects")
        .fetch_all(&mut *tx).await.map_err(|e| e.to_string())?;
    let mut known: HashSet<String> = existing.into_iter().collect();
    for p in input.projects {
        known.insert(p.id.clone());
        ProjectService::upsert(&mut *tx, p).await.map_err(|e| e.to_string())?;
    }
    let mut affected = HashSet::new();
    for mut c in input.chapters {
        if !known.contains(&c.project_id) {
            ProjectService::upsert(&mut *tx, stub_project(c.project_id.clone())).await.map_err(|e| e.to_string())?;
            known.insert(c.project_id.clone());
        }
        let owner: Option<String> = sqlx::query_scalar("SELECT project_id FROM chapters WHERE id = ?")
            .bind(&c.id).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?;
        if owner.as_deref().map_or(false, |pid| pid != c.project_id) {
            return Err(format!("章节 {} 与现有项目归属冲突", c.id));
        }
        let body = c.final_text.as_deref().filter(|s| !s.trim().is_empty()).or(c.draft_text.as_deref()).unwrap_or("");
        c.word_count = body.chars().filter(|c| !c.is_whitespace()).count() as i64;
        affected.insert(c.project_id.clone());
        let chapter_id = c.id.clone();
        ChapterService::upsert(&mut *tx, c).await.map_err(|e| e.to_string())?;
        let (draft, final_text): (Option<String>, Option<String>) = sqlx::query_as("SELECT draft_text, final_text FROM chapters WHERE id = ?")
            .bind(&chapter_id).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
        let body = final_text.as_deref().filter(|s| !s.trim().is_empty()).or(draft.as_deref()).unwrap_or("");
        sqlx::query("UPDATE chapters SET word_count = ? WHERE id = ?")
            .bind(body.chars().filter(|c| !c.is_whitespace()).count() as i64).bind(&chapter_id)
            .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    }
    for id in affected {
        sqlx::query("UPDATE projects SET current_word_count = (SELECT COALESCE(SUM(word_count), 0) FROM chapters WHERE project_id = ?) WHERE id = ?")
            .bind(&id).bind(&id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    }
    let revision = uuid::Uuid::new_v4().to_string();
    if let Some(json) = metadata {
        sqlx::query("INSERT INTO backup_metadata_outbox(singleton, revision, metadata_json) VALUES (1, ?, ?)")
            .bind(&revision).bind(json).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(ImportReceipt { revision, imported_projects, imported_chapters })
}
#[tauri::command]
pub async fn import_backup_atomic(pool: State<'_, SqlitePool>, request: AtomicBackupRequest) -> Result<ImportReceipt, String> {
    import_transaction(pool.inner(), ImportContentInput { projects: request.projects, chapters: request.chapters }, Some(request.metadata_json)).await
}
#[tauri::command]
pub async fn get_pending_backup_metadata(pool: State<'_, SqlitePool>) -> Result<Option<PendingMetadata>, String> {
    sqlx::query_as("SELECT revision, metadata_json FROM backup_metadata_outbox WHERE singleton = 1")
        .fetch_optional(pool.inner()).await.map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn ack_backup_metadata(pool: State<'_, SqlitePool>, revision: String) -> Result<(), String> {
    sqlx::query("DELETE FROM backup_metadata_outbox WHERE singleton = 1 AND revision = ?")
        .bind(revision).execute(pool.inner()).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn pool() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        crate::db::schema::run_migrations(&pool).await.unwrap(); pool
    }
    fn input(pid: &str, cid: &str) -> ImportContentInput {
        serde_json::from_value(serde_json::json!({"projects":[{"id":pid,"title":"原作"}],
            "chapters":[{"id":cid,"project_id":pid,"title":"章","order_index":0,"draft_text":"中文正文"}]})).unwrap()
    }
    #[tokio::test]
    async fn content_and_metadata_commit_together() {
        let pool = pool().await;
        let receipt = import_transaction(&pool, input("p", "c"), Some("{\"workspace\":1}".into())).await.unwrap();
        let json: String = sqlx::query_scalar("SELECT metadata_json FROM backup_metadata_outbox WHERE revision = ?")
            .bind(&receipt.revision).fetch_one(&pool).await.unwrap();
        assert_eq!(json, "{\"workspace\":1}");
        let count: i64 = sqlx::query_scalar("SELECT word_count FROM chapters").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 4);
        assert!(import_transaction(&pool, input("p2", "c2"), None).await.is_err());
    }
    #[tokio::test]
    async fn conflicting_chapter_rolls_back_all_imported_rows() {
        let pool = pool().await;
        import_transaction(&pool, input("p", "c"), None).await.unwrap();
        assert!(import_transaction(&pool, input("other", "c"), Some("{}".into())).await.is_err());
        let projects: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects").fetch_one(&pool).await.unwrap();
        let metadata: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM backup_metadata_outbox").fetch_one(&pool).await.unwrap();
        assert_eq!((projects, metadata), (1, 0));
    }
    #[tokio::test]
    async fn legacy_metadata_only_does_not_erase_existing_body() {
        let pool = pool().await;
        import_transaction(&pool, input("p", "c"), None).await.unwrap();
        let mut old = input("p", "c"); old.chapters[0].draft_text = None;
        import_transaction(&pool, old, None).await.unwrap();
        let body: String = sqlx::query_scalar("SELECT draft_text FROM chapters WHERE id = 'c'").fetch_one(&pool).await.unwrap();
        assert_eq!(body, "中文正文");
    }
}
