use serde::Deserialize;
use sqlx::SqlitePool;
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptChapterInput {
    pub project_id: String, pub chapter_id: String, pub expected_draft: String,
    pub expected_final: String, pub body: String,
}
/// Compare-and-swap prevents a delayed review from overwriting a concurrently edited chapter.
#[tauri::command]
pub async fn adopt_chapter_candidate(pool: State<'_, SqlitePool>, input: AdoptChapterInput) -> Result<(), String> {
    adopt_candidate_transaction(pool.inner(), input).await
}

async fn adopt_candidate_transaction(pool: &SqlitePool, input: AdoptChapterInput) -> Result<(), String> {
    if input.body.trim().is_empty() || input.body.len() > 4 * 1024 * 1024 { return Err("候选正文为空或超过4MiB限制".into()); }
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let count = input.body.chars().filter(|c| !c.is_whitespace()).count() as i64;
    let result = sqlx::query("UPDATE chapters SET draft_text = ?, final_text = ?, word_count = ?, status = 'final', updated_at = ? WHERE id = ? AND project_id = ? AND COALESCE(draft_text, '') = ? AND COALESCE(final_text, '') = ?")
        .bind(&input.body).bind(&input.body).bind(count).bind(chrono::Utc::now().to_rfc3339())
        .bind(&input.chapter_id).bind(&input.project_id).bind(&input.expected_draft).bind(&input.expected_final)
        .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    if result.rows_affected() != 1 { return Err("正文已经变化或章节已删除，未覆盖当前内容；请重新生成或核对".into()); }
    sqlx::query("UPDATE projects SET current_word_count = (SELECT COALESCE(SUM(word_count), 0) FROM chapters WHERE project_id = ?), updated_at = ? WHERE id = ?")
        .bind(&input.project_id).bind(chrono::Utc::now().to_rfc3339()).bind(&input.project_id)
        .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn seeded_pool() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1).connect("sqlite::memory:").await.unwrap();
        crate::db::schema::run_migrations(&pool).await.unwrap();
        sqlx::query("INSERT INTO projects (id, title, current_word_count, created_at, updated_at) VALUES ('p', '原作', 4, 'old', 'old'), ('other', '其他项目', 0, 'old', 'old')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapters (id, project_id, title, order_index, draft_text, final_text, illustrations, word_count, created_at, updated_at) VALUES ('c', 'p', '待审核章', 0, '旧稿', '原文', '[{\"paragraphIndex\":1}]', 2, 'old', 'old'), ('sibling', 'p', '相邻章', 1, '续章', '续章', NULL, 2, 'old', 'old')")
            .execute(&pool).await.unwrap();
        pool
    }

    fn candidate(project_id: &str) -> AdoptChapterInput {
        AdoptChapterInput {
            project_id: project_id.into(), chapter_id: "c".into(),
            expected_draft: "旧稿".into(), expected_final: "原文".into(),
            body: " 新 文🌙 \n".into(),
        }
    }

    #[tokio::test]
    async fn adopted_candidate_updates_both_versions_and_project_total() {
        let pool = seeded_pool().await;
        let input = candidate("p");
        let body = input.body.clone();
        adopt_candidate_transaction(&pool, input).await.unwrap();
        let (draft, final_text, count, status, images, updated): (String, String, i64, String, String, String) =
            sqlx::query_as("SELECT draft_text, final_text, word_count, status, illustrations, updated_at FROM chapters WHERE id = 'c'")
                .fetch_one(&pool).await.unwrap();
        assert_eq!((draft, final_text), (body.clone(), body));
        assert_eq!((count, status.as_str()), (3, "final"));
        assert_eq!(images, "[{\"paragraphIndex\":1}]");
        assert_ne!(updated, "old");
        let total: i64 = sqlx::query_scalar("SELECT current_word_count FROM projects WHERE id = 'p'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(total, 5);
        let sibling: String = sqlx::query_scalar("SELECT final_text FROM chapters WHERE id = 'sibling'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(sibling, "续章");
    }

    #[tokio::test]
    async fn concurrently_edited_prose_rejects_stale_candidate_without_mutation() {
        let pool = seeded_pool().await;
        let input = candidate("p");
        sqlx::query("UPDATE chapters SET draft_text = '用户正在编辑', final_text = '用户新正文', word_count = 5, updated_at = 'user-edit' WHERE id = 'c'")
            .execute(&pool).await.unwrap();
        sqlx::query("UPDATE projects SET current_word_count = 7, updated_at = 'user-project-edit' WHERE id = 'p'")
            .execute(&pool).await.unwrap();
        assert!(adopt_candidate_transaction(&pool, input).await.is_err());
        let state: (String, String, i64, String, String, String) =
            sqlx::query_as("SELECT draft_text, final_text, word_count, status, illustrations, updated_at FROM chapters WHERE id = 'c'")
                .fetch_one(&pool).await.unwrap();
        assert_eq!(state, ("用户正在编辑".into(), "用户新正文".into(), 5, "draft".into(), "[{\"paragraphIndex\":1}]".into(), "user-edit".into()));
        let project: (i64, String) = sqlx::query_as("SELECT current_word_count, updated_at FROM projects WHERE id = 'p'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(project, (7, "user-project-edit".into()));
    }

    #[tokio::test]
    async fn wrong_project_cannot_adopt_even_when_both_expected_versions_match() {
        let pool = seeded_pool().await;
        assert!(adopt_candidate_transaction(&pool, candidate("other")).await.is_err());
        let original: (String, String, String, i64, String) =
            sqlx::query_as("SELECT project_id, draft_text, final_text, word_count, updated_at FROM chapters WHERE id = 'c'")
                .fetch_one(&pool).await.unwrap();
        assert_eq!(original, ("p".into(), "旧稿".into(), "原文".into(), 2, "old".into()));
        let totals: Vec<(String, i64, String)> = sqlx::query_as("SELECT id, current_word_count, updated_at FROM projects ORDER BY id")
            .fetch_all(&pool).await.unwrap();
        assert_eq!(totals, vec![("other".into(), 0, "old".into()), ("p".into(), 4, "old".into())]);
    }
}
