use sqlx::SqlitePool;
use chrono::Utc;
use uuid::Uuid;
use anyhow::Result;
use crate::models::{Chapter, CreateChapterInput, UpdateChapterMetaInput};

pub struct ChapterService;

impl ChapterService {
    pub async fn create(pool: &SqlitePool, input: CreateChapterInput) -> Result<Chapter> {
        let now = Utc::now().to_rfc3339();
        let chapter = Chapter {
            id: Uuid::new_v4().to_string(),
            project_id: input.project_id,
            title: input.title,
            order_index: input.order_index,
            outline_goal: input.outline_goal,
            conflict: input.conflict,
            twist: None,
            cliffhanger: None,
            draft_text: None,
            final_text: None,
            illustrations: None,
            word_count: 0,
            status: "draft".to_string(),
            created_at: now.clone(),
            updated_at: now,
            arc_id: None,
        };

        sqlx::query(
            r#"
            INSERT INTO chapters (id, project_id, title, order_index, outline_goal, conflict, twist, cliffhanger, draft_text, final_text, illustrations, word_count, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#
        )
        .bind(&chapter.id)
        .bind(&chapter.project_id)
        .bind(&chapter.title)
        .bind(chapter.order_index)
        .bind(&chapter.outline_goal)
        .bind(&chapter.conflict)
        .bind(&chapter.twist)
        .bind(&chapter.cliffhanger)
        .bind(&chapter.draft_text)
        .bind(&chapter.final_text)
        .bind(&chapter.illustrations)
        .bind(chapter.word_count)
        .bind(&chapter.status)
        .bind(&chapter.created_at)
        .bind(&chapter.updated_at)
        .execute(pool)
        .await?;

        Ok(chapter)
    }

    pub async fn get_by_project(pool: &SqlitePool, project_id: &str) -> Result<Vec<Chapter>> {
        let chapters = sqlx::query_as::<_, Chapter>(
            "SELECT * FROM chapters WHERE project_id = ? ORDER BY order_index ASC"
        )
        .bind(project_id)
        .fetch_all(pool)
        .await?;

        Ok(chapters)
    }

    pub async fn get_by_id(pool: &SqlitePool, id: &str) -> Result<Option<Chapter>> {
        let chapter = sqlx::query_as::<_, Chapter>(
            "SELECT * FROM chapters WHERE id = ?"
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;

        Ok(chapter)
    }

    /// All chapters across every project, ordered for stable export.
    pub async fn get_all(pool: &SqlitePool) -> Result<Vec<Chapter>> {
        let chapters = sqlx::query_as::<_, Chapter>(
            "SELECT * FROM chapters ORDER BY project_id, order_index ASC"
        )
        .fetch_all(pool)
        .await?;

        Ok(chapters)
    }

    /// Upsert a whole chapter (metadata + text bodies + illustrations + arc_id) from a backup.
    /// Incoming wins on conflict (mirrors Android `importBackup` merge semantics). Does NOT
    /// recompute project word counts — callers recompute once per project after a bulk import.
    pub async fn upsert<'a, E>(pool: E, input: crate::models::ImportChapter) -> Result<()>
    where E: sqlx::Executor<'a, Database = sqlx::Sqlite> {
        let now = Utc::now().to_rfc3339();
        let created_at = input.created_at.unwrap_or_else(|| now.clone());
        let updated_at = input.updated_at.unwrap_or_else(|| now.clone());
        let status = input.status.unwrap_or_else(|| "draft".to_string());

        sqlx::query(
            r#"
            INSERT INTO chapters
                (id, project_id, title, order_index, outline_goal, conflict, twist, cliffhanger,
                 draft_text, final_text, illustrations, word_count, status, created_at, updated_at, arc_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                project_id = excluded.project_id,
                title = excluded.title,
                order_index = excluded.order_index,
                outline_goal = excluded.outline_goal,
                conflict = excluded.conflict,
                twist = excluded.twist,
                cliffhanger = excluded.cliffhanger,
                draft_text = COALESCE(excluded.draft_text, chapters.draft_text),
                final_text = COALESCE(excluded.final_text, chapters.final_text),
                illustrations = COALESCE(excluded.illustrations, chapters.illustrations),
                word_count = excluded.word_count,
                status = excluded.status,
                updated_at = excluded.updated_at,
                arc_id = excluded.arc_id
            "#
        )
        .bind(&input.id)
        .bind(&input.project_id)
        .bind(&input.title)
        .bind(input.order_index)
        .bind(&input.outline_goal)
        .bind(&input.conflict)
        .bind(&input.twist)
        .bind(&input.cliffhanger)
        .bind(&input.draft_text)
        .bind(&input.final_text)
        .bind(&input.illustrations)
        .bind(input.word_count)
        .bind(&status)
        .bind(&created_at)
        .bind(&updated_at)
        .bind(&input.arc_id)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn update_text(
        pool: &SqlitePool,
        id: &str,
        draft_text: Option<String>,
        final_text: Option<String>,
        illustrations: Option<String>,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        
        // Calculate word count from final_text or draft_text
        let word_count = final_text.as_ref()
            .or(draft_text.as_ref())
            .map(|text| text.chars().filter(|c| !c.is_whitespace()).count() as i64)
            .unwrap_or(0);

        sqlx::query(
            r#"
            UPDATE chapters 
            SET draft_text = ?, final_text = ?, illustrations = COALESCE(?, illustrations), word_count = ?, updated_at = ?
            WHERE id = ?
            "#
        )
        .bind(draft_text)
        .bind(final_text)
        .bind(illustrations)
        .bind(word_count)
        .bind(now.clone())
        .bind(id)
        .execute(pool)
        .await?;

        // 获取章节的 project_id 并更新项目总字数
        if let Some(chapter) = sqlx::query_as::<_, Chapter>(
            "SELECT * FROM chapters WHERE id = ?"
        )
        .bind(id)
        .fetch_optional(pool)
        .await? {
            Self::update_project_word_count(pool, &chapter.project_id).await?;
        }

        Ok(())
    }

    /// 重新计算并更新项目的总字数
    pub async fn update_project_word_count(pool: &SqlitePool, project_id: &str) -> Result<()> {
        let total: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(word_count), 0) FROM chapters WHERE project_id = ?"
        )
        .bind(project_id)
        .fetch_one(pool)
        .await?;

        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE projects SET current_word_count = ?, updated_at = ? WHERE id = ?"
        )
        .bind(total)
        .bind(now)
        .bind(project_id)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn update_meta(
        pool: &SqlitePool,
        id: &str,
        input: UpdateChapterMetaInput,
    ) -> Result<Chapter> {
        let now = Utc::now().to_rfc3339();

        sqlx::query(
            r#"
            UPDATE chapters
            SET title = COALESCE(?, title),
                order_index = COALESCE(?, order_index),
                outline_goal = COALESCE(?, outline_goal),
                conflict = COALESCE(?, conflict),
                twist = COALESCE(?, twist),
                cliffhanger = COALESCE(?, cliffhanger),
                arc_id = COALESCE(?, arc_id),
                updated_at = ?
            WHERE id = ?
            "#
        )
        .bind(input.title)
        .bind(input.order_index)
        .bind(input.outline_goal)
        .bind(input.conflict)
        .bind(input.twist)
        .bind(input.cliffhanger)
        .bind(input.arc_id)
        .bind(&now)
        .bind(id)
        .execute(pool)
        .await?;

        Self::get_by_id(pool, id).await?
            .ok_or_else(|| anyhow::anyhow!("Chapter not found after update"))
    }

    /// 仅更新项目总字数（不修改 updated_at）
    pub async fn update_project_word_count_only(pool: &SqlitePool, project_id: &str) -> Result<()> {
        let total: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(word_count), 0) FROM chapters WHERE project_id = ?"
        )
        .bind(project_id)
        .fetch_one(pool)
        .await?;

        sqlx::query(
            "UPDATE projects SET current_word_count = ? WHERE id = ?"
        )
        .bind(total)
        .bind(project_id)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
        // 先获取 project_id
        let project_id = sqlx::query_scalar::<_, String>(
            "SELECT project_id FROM chapters WHERE id = ?"
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;

        sqlx::query("DELETE FROM chapters WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;

        // 删除后更新项目总字数
        if let Some(pid) = project_id {
            Self::update_project_word_count(pool, &pid).await?;
        }

        Ok(())
    }
}
