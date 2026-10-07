use serde::Deserialize;
use sqlx::SqlitePool;
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IllustrationInput {
    pub project_id: String,
    pub chapter_id: String,
    pub expected_draft: String,
    pub expected_final: String,
    pub expected_illustrations: String,
    pub illustrations: String,
}

pub async fn update_illustrations(pool: &SqlitePool, input: IllustrationInput) -> Result<(), String> {
    if input.illustrations.len() > 64 * 1024 * 1024 {
        return Err("插图数据超过64MiB限制".into());
    }
    let value: serde_json::Value = serde_json::from_str(&input.illustrations)
        .map_err(|_| "插图数据不是有效JSON")?;
    if !value.is_array() { return Err("插图数据必须是数组".into()); }
    // Never resend the old chapter body after a slow image request. The paragraph anchor
    // and previous image list must still match, or the author must review the new source.
    let result = sqlx::query("UPDATE chapters SET illustrations = ?, updated_at = ? WHERE id = ? AND project_id = ? AND COALESCE(draft_text, '') = ? AND COALESCE(final_text, '') = ? AND COALESCE(illustrations, '') = ?")
        .bind(&input.illustrations).bind(chrono::Utc::now().to_rfc3339())
        .bind(&input.chapter_id).bind(&input.project_id)
        .bind(&input.expected_draft).bind(&input.expected_final).bind(&input.expected_illustrations)
        .execute(pool).await.map_err(|e| e.to_string())?;
    if result.rows_affected() != 1 {
        return Err("正文或插图已经变化，未覆盖当前内容；请核对后重新生成插图".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn update_chapter_illustrations(pool: State<'_, SqlitePool>, input: IllustrationInput) -> Result<(), String> {
    update_illustrations(pool.inner(), input).await
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn pool() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        crate::db::schema::run_migrations(&pool).await.unwrap();
        sqlx::query("INSERT INTO projects(id,title,created_at,updated_at) VALUES ('p','书','old','old')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapters(id,project_id,title,order_index,draft_text,final_text,word_count,created_at,updated_at) VALUES ('c','p','章',1,'草稿','定稿',2,'old','old')").execute(&pool).await.unwrap();
        pool
    }
    fn input() -> IllustrationInput {
        IllustrationInput { project_id: "p".into(), chapter_id: "c".into(), expected_draft: "草稿".into(),
            expected_final: "定稿".into(), expected_illustrations: "".into(), illustrations: "[{\"id\":\"image\"}]".into() }
    }
    #[tokio::test]
    async fn images_do_not_replace_draft_with_final_body() {
        let pool = pool().await;
        update_illustrations(&pool, input()).await.unwrap();
        let row: (String, String, i64, String) = sqlx::query_as("SELECT draft_text, final_text, word_count, illustrations FROM chapters").fetch_one(&pool).await.unwrap();
        assert_eq!(row, ("草稿".into(), "定稿".into(), 2, "[{\"id\":\"image\"}]".into()));
    }
    #[tokio::test]
    async fn changed_body_rejects_stale_paragraph_anchor() {
        let pool = pool().await;
        sqlx::query("UPDATE chapters SET draft_text = '新草稿'").execute(&pool).await.unwrap();
        assert!(update_illustrations(&pool, input()).await.is_err());
        let row: (String, Option<String>) = sqlx::query_as("SELECT draft_text, illustrations FROM chapters").fetch_one(&pool).await.unwrap();
        assert_eq!(row, ("新草稿".into(), None));
    }
    #[tokio::test]
    async fn concurrent_images_are_not_lost() {
        let pool = pool().await;
        sqlx::query("UPDATE chapters SET illustrations = '[{\"id\":\"other\"}]'").execute(&pool).await.unwrap();
        assert!(update_illustrations(&pool, input()).await.is_err());
        let images: String = sqlx::query_scalar("SELECT illustrations FROM chapters").fetch_one(&pool).await.unwrap();
        assert_eq!(images, "[{\"id\":\"other\"}]");
    }
}
