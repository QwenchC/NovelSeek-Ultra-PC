use sqlx::{SqlitePool, Row};
use anyhow::Result;

pub async fn run_migrations(pool: &SqlitePool) -> Result<()> {
    // Durable bridge between SQLite content and the frontend metadata store. Never overwrite
    // an unacknowledged import: the frontend must recover it before the next import.
    sqlx::query("CREATE TABLE IF NOT EXISTS backup_metadata_outbox (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision TEXT NOT NULL, metadata_json TEXT NOT NULL)")
        .execute(pool).await?;
    // Enable foreign keys
    sqlx::query("PRAGMA foreign_keys = ON;")
        .execute(pool)
        .await?;

    // Projects table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            author TEXT,
            genre TEXT,
            description TEXT,
            language TEXT NOT NULL DEFAULT 'zh',
            target_word_count INTEGER,
            current_word_count INTEGER DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'draft',
            cover_images TEXT,
            default_cover_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        "#
    )
    .execute(pool)
    .await?;

    // Ensure new columns exist for older databases
    let project_columns = sqlx::query("PRAGMA table_info(projects);")
        .fetch_all(pool)
        .await?;
    let has_cover_images = project_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "cover_images");
    if !has_cover_images {
        sqlx::query("ALTER TABLE projects ADD COLUMN cover_images TEXT")
            .execute(pool)
            .await?;
    }
    let has_default_cover_id = project_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "default_cover_id");
    if !has_default_cover_id {
        sqlx::query("ALTER TABLE projects ADD COLUMN default_cover_id TEXT")
            .execute(pool)
            .await?;
    }
    let has_language = project_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "language");
    if !has_language {
        sqlx::query("ALTER TABLE projects ADD COLUMN language TEXT NOT NULL DEFAULT 'zh'")
            .execute(pool)
            .await?;
    }

    // Chapters table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS chapters (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            title TEXT NOT NULL,
            order_index INTEGER NOT NULL,
            outline_goal TEXT,
            conflict TEXT,
            twist TEXT,
            cliffhanger TEXT,
            draft_text TEXT,
            final_text TEXT,
            illustrations TEXT,
            word_count INTEGER DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'draft',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
        "#
    )
    .execute(pool)
    .await?;

    // Ensure new columns exist for older databases
    let chapter_columns = sqlx::query("PRAGMA table_info(chapters);")
        .fetch_all(pool)
        .await?;
    let has_illustrations = chapter_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "illustrations");
    if !has_illustrations {
        sqlx::query("ALTER TABLE chapters ADD COLUMN illustrations TEXT")
            .execute(pool)
            .await?;
    }
    // The 剧情弧线 (PlotArc) a chapter belongs to — preserved for round-trip with the Android
    // backup (which stores `Chapter.arcId`).
    let has_arc_id = chapter_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "arc_id");
    if !has_arc_id {
        sqlx::query("ALTER TABLE chapters ADD COLUMN arc_id TEXT")
            .execute(pool)
            .await?;
    }

    // Characters table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS characters (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            role TEXT,
            description TEXT,
            personality TEXT,
            background TEXT,
            motivation TEXT,
            voice_style TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
        "#
    )
    .execute(pool)
    .await?;

    // World building / Lore table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS lore (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            category TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
        "#
    )
    .execute(pool)
    .await?;

    // Timeline events table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS timeline_events (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            event_time TEXT,
            order_index INTEGER,
            created_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
        "#
    )
    .execute(pool)
    .await?;

    // Generation tasks table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS generation_tasks (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            task_type TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            input_params TEXT NOT NULL,
            output_result TEXT,
            error_message TEXT,
            token_count INTEGER,
            cost REAL,
            created_at TEXT NOT NULL,
            completed_at TEXT,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
        "#
    )
    .execute(pool)
    .await?;

    // Snapshots table (version control)
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS snapshots (
            id TEXT PRIMARY KEY,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            content TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            note TEXT,
            created_at TEXT NOT NULL
        )
        "#
    )
    .execute(pool)
    .await?;

    // Assets table (images, covers, etc.)
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS assets (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            asset_type TEXT NOT NULL,
            file_path TEXT NOT NULL,
            linked_to_type TEXT,
            linked_to_id TEXT,
            metadata TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
        "#
    )
    .execute(pool)
    .await?;

    // Create indexes
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id);")
        .execute(pool)
        .await?;
    
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_characters_project ON characters(project_id);")
        .execute(pool)
        .await?;
    
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_tasks_project ON generation_tasks(project_id);")
        .execute(pool)
        .await?;

    // Knowledge base: text chunks with embeddings (BLOB-based, in-memory cosine retrieval)
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS kb_chunks (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            source_type TEXT NOT NULL,
            source_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            text TEXT NOT NULL,
            embedding BLOB NOT NULL,
            embedding_dim INTEGER NOT NULL,
            embedding_model TEXT NOT NULL,
            token_count INTEGER,
            created_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
        "#
    )
    .execute(pool)
    .await?;

    // Index state: tracks which sources were already embedded (by content hash) so we can skip re-embedding
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS kb_index_state (
            project_id TEXT NOT NULL,
            source_type TEXT NOT NULL,
            source_id TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            embedding_model TEXT NOT NULL,
            indexed_at TEXT NOT NULL,
            PRIMARY KEY (project_id, source_type, source_id),
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
        "#
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_kb_chunks_project ON kb_chunks(project_id);")
        .execute(pool)
        .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_kb_chunks_source ON kb_chunks(project_id, source_type, source_id);"
    )
        .execute(pool)
        .await?;

    // ── v2.0: hierarchical summaries (chapter / arc / book) ────
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS kb_summaries (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            scope_type TEXT NOT NULL,
            scope_id TEXT NOT NULL DEFAULT '',
            summary_text TEXT NOT NULL,
            source_hash TEXT NOT NULL,
            is_stale INTEGER NOT NULL DEFAULT 0,
            embedding BLOB,
            embedding_dim INTEGER,
            embedding_model TEXT,
            word_count INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
        "#
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_summaries_scope ON kb_summaries(project_id, scope_type, scope_id);"
    )
        .execute(pool)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_kb_summaries_project ON kb_summaries(project_id);")
        .execute(pool)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_kb_summaries_stale ON kb_summaries(project_id, is_stale);")
        .execute(pool)
        .await?;

    // ── v2.1: extracted entities (characters / foreshadowing / locations / events) ──
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS kb_entities (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            canonical_name TEXT NOT NULL,
            aliases TEXT,
            summary TEXT,
            status TEXT NOT NULL DEFAULT 'open',
            first_seen_chapter_id TEXT,
            last_seen_chapter_id TEXT,
            embedding BLOB,
            embedding_dim INTEGER,
            embedding_model TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
        "#
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_kb_entities_project ON kb_entities(project_id);")
        .execute(pool)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_kb_entities_type ON kb_entities(project_id, entity_type);")
        .execute(pool)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_kb_entities_status ON kb_entities(project_id, status);")
        .execute(pool)
        .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS kb_entity_appearances (
            id TEXT PRIMARY KEY,
            entity_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            chapter_id TEXT NOT NULL,
            excerpt TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (entity_id) REFERENCES kb_entities(id) ON DELETE CASCADE,
            FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
        )
        "#
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_kb_appearances_entity ON kb_entity_appearances(entity_id);")
        .execute(pool)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_kb_appearances_chapter ON kb_entity_appearances(chapter_id);")
        .execute(pool)
        .await?;

    log::info!("Database migrations completed");
    Ok(())
}
