//! SQLite 仓储：会话 / 消息 / 卡片 / 账本。
//! 结构变更走 schema_migrations，增量式、可重放。

use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use studydeck_core::{
    Anchor, Card, Course, CourseItem, CourseItemId, CourseItemStatus, Depth, GlossaryEntry,
    Mastery, Message, MessageStatus, Role, Session, SessionId, SessionSeed, Topic, TopicEdge,
    TopicEdgeId, TopicEdgeKind, TopicNode, TopicNodeId, TopicNodeStatus,
};

const BASE_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    title      TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS ask_sessions (
    cwd        TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE TABLE IF NOT EXISTS cards (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    char_start INTEGER NOT NULL,
    char_end   INTEGER NOT NULL,
    quote      TEXT NOT NULL,
    depth      TEXT NOT NULL,
    question   TEXT NOT NULL,
    answer     TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_session ON cards(session_id);
CREATE TABLE IF NOT EXISTS glossary (
    id         TEXT PRIMARY KEY,
    term       TEXT NOT NULL,
    gist       TEXT NOT NULL,
    depth      TEXT NOT NULL,
    message_id TEXT,
    char_start INTEGER,
    char_end   INTEGER,
    quote      TEXT,
    created_at TEXT NOT NULL
);
"#;

const FTS_SCHEMA: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS glossary_fts USING fts5(term, gist, content='glossary', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS glossary_ai AFTER INSERT ON glossary BEGIN
  INSERT INTO glossary_fts(rowid, term, gist) VALUES (new.rowid, new.term, new.gist);
END;
CREATE TRIGGER IF NOT EXISTS glossary_ad AFTER DELETE ON glossary BEGIN
  INSERT INTO glossary_fts(glossary_fts, rowid, term, gist) VALUES('delete', old.rowid, old.term, old.gist);
END;
CREATE TRIGGER IF NOT EXISTS glossary_au AFTER UPDATE ON glossary BEGIN
  INSERT INTO glossary_fts(glossary_fts, rowid, term, gist) VALUES('delete', old.rowid, old.term, old.gist);
  INSERT INTO glossary_fts(rowid, term, gist) VALUES (new.rowid, new.term, new.gist);
END;
"#;

#[derive(Debug, Clone, serde::Serialize)]
pub struct TopicDeleteResult {
    pub sessions_deleted: usize,
    pub sessions_kept: usize,
    pub course_items_removed: usize,
    pub edges_removed: usize,
    pub nodes_removed: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CourseSummary {
    pub course: Course,
    pub topic_count: usize,
    pub done_count: usize,
    pub next_date: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct SessionUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub turns: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionOriginSummary {
    pub parent_session_id: String,
    pub parent_title: Option<String>,
    pub message_id: String,
    pub card_id: String,
    pub quote: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionSummary {
    pub id: String,
    pub title: Option<String>,
    pub updated_at: DateTime<Utc>,
    pub messages: usize,
    pub topic_id: Option<String>,
    pub topic_title: Option<String>,
    pub origin: Option<SessionOriginSummary>,
}

/// 一次“卡片 -> 专题会话”的升级结果。幂等：重复升级同一张卡返回同一个会话。
#[derive(Debug, Clone, serde::Serialize)]
pub struct Promotion {
    pub session_id: String,
    pub topic_id: String,
    pub topic: Topic,
    pub seed: SessionSeed,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MessageHit {
    pub session_id: String,
    pub session_title: Option<String>,
    pub message_id: String,
    pub role: String,
    pub snippet: String,
    pub created_at: DateTime<Utc>,
}

pub struct Store {
    conn: Mutex<Connection>,
    has_fts: bool,
}

fn ensure_column(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|name| name.ok())
        .any(|name| name == column);
    drop(stmt);
    if !exists {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"),
            [],
        )?;
    }
    Ok(())
}

fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
    )?;
    let current: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;

    let steps: &[(i64, fn(&Connection) -> Result<()>)] = &[
        (1, |c| c.execute_batch(BASE_SCHEMA).context("base schema")),
        (2, |c| {
            ensure_column(c, "glossary", "mastery", "TEXT NOT NULL DEFAULT 'unknown'")?;
            ensure_column(c, "glossary", "session_id", "TEXT")?;
            ensure_column(c, "glossary", "updated_at", "TEXT")?;
            ensure_column(c, "sessions", "updated_at", "TEXT")?;
            Ok(())
        }),
        (3, |c| {
            c.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_glossary_term ON glossary(term);
                 CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);",
            )?;
            Ok(())
        }),
        (4, |c| {
            ensure_column(c, "messages", "status", "TEXT NOT NULL DEFAULT 'ok'")?;
            ensure_column(c, "messages", "turn_id", "TEXT")?;
            c.execute_batch("CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages(turn_id);")?;
            Ok(())
        }),
        (5, |c| {
            ensure_column(c, "sessions", "topic_id", "TEXT")?;
            ensure_column(c, "cards", "promoted_session_id", "TEXT")?;
            c.execute_batch(
                "CREATE TABLE IF NOT EXISTS topics (
                    id         TEXT PRIMARY KEY,
                    title      TEXT NOT NULL,
                    summary    TEXT NOT NULL DEFAULT '',
                    depth_goal TEXT NOT NULL,
                    mastery    TEXT NOT NULL DEFAULT 'unknown',
                    created_at TEXT NOT NULL,
                    metadata   TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE IF NOT EXISTS session_seeds (
                    session_id         TEXT PRIMARY KEY,
                    topic_id           TEXT NOT NULL,
                    topic_title        TEXT NOT NULL,
                    source_session_id  TEXT NOT NULL,
                    source_title       TEXT,
                    source_message_id  TEXT NOT NULL,
                    card_id            TEXT NOT NULL,
                    quote              TEXT NOT NULL,
                    context            TEXT NOT NULL DEFAULT '',
                    answer             TEXT NOT NULL DEFAULT '',
                    depth              TEXT NOT NULL,
                    metadata           TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE IF NOT EXISTS session_links (
                    parent_session_id TEXT NOT NULL,
                    child_session_id  TEXT NOT NULL,
                    card_id           TEXT,
                    kind              TEXT NOT NULL,
                    metadata          TEXT NOT NULL DEFAULT '{}',
                    created_at        TEXT NOT NULL,
                    PRIMARY KEY (parent_session_id, child_session_id, kind)
                );
                CREATE INDEX IF NOT EXISTS idx_topics_created ON topics(created_at);
                CREATE INDEX IF NOT EXISTS idx_session_seeds_source ON session_seeds(source_session_id);
                CREATE INDEX IF NOT EXISTS idx_session_links_parent ON session_links(parent_session_id);",
            )?;
            Ok(())
        }),
        (6, |c| {
            ensure_column(c, "topics", "outline_md", "TEXT NOT NULL DEFAULT ''")?;
            c.execute_batch(
                "CREATE TABLE IF NOT EXISTS topic_edges (
                    id            TEXT PRIMARY KEY,
                    from_topic_id TEXT NOT NULL,
                    to_topic_id   TEXT NOT NULL,
                    kind          TEXT NOT NULL,
                    note          TEXT NOT NULL DEFAULT '',
                    created_at    TEXT NOT NULL,
                    metadata      TEXT NOT NULL DEFAULT '{}',
                    UNIQUE(from_topic_id, to_topic_id, kind)
                );
                CREATE INDEX IF NOT EXISTS idx_topic_edges_from ON topic_edges(from_topic_id);
                CREATE INDEX IF NOT EXISTS idx_topic_edges_to ON topic_edges(to_topic_id);",
            )?;
            Ok(())
        }),
        (7, |c| {
            c.execute_batch(
                "CREATE TABLE IF NOT EXISTS courses (
                    id         TEXT PRIMARY KEY,
                    title      TEXT NOT NULL,
                    goal       TEXT NOT NULL DEFAULT '',
                    start_date TEXT,
                    end_date   TEXT,
                    created_at TEXT NOT NULL,
                    metadata   TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE IF NOT EXISTS course_items (
                    id         TEXT PRIMARY KEY,
                    course_id  TEXT NOT NULL,
                    topic_id   TEXT NOT NULL,
                    position   INTEGER NOT NULL,
                    planned_at TEXT,
                    status     TEXT NOT NULL DEFAULT 'planned',
                    note       TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    metadata   TEXT NOT NULL DEFAULT '{}',
                    UNIQUE(course_id, topic_id)
                );
                CREATE INDEX IF NOT EXISTS idx_course_items_course ON course_items(course_id, position);
                CREATE INDEX IF NOT EXISTS idx_course_items_topic ON course_items(topic_id);",
            )?;
            Ok(())
        }),
        (9, |c| {
            c.execute_batch(
                "CREATE TABLE IF NOT EXISTS turn_usage (
                    turn_id           TEXT PRIMARY KEY,
                    session_id        TEXT NOT NULL,
                    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
                    completion_tokens INTEGER NOT NULL DEFAULT 0,
                    rounds            INTEGER NOT NULL DEFAULT 0,
                    created_at        TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_turn_usage_session
                    ON turn_usage(session_id);",
            )?;
            Ok(())
        }),
        (8, |c| {
            ensure_column(c, "courses", "daily_minutes", "INTEGER NOT NULL DEFAULT 60")?;
            ensure_column(
                c,
                "courses",
                "study_days",
                "TEXT NOT NULL DEFAULT '1,2,3,4,5'",
            )?;
            ensure_column(
                c,
                "course_items",
                "estimated_minutes",
                "INTEGER NOT NULL DEFAULT 60",
            )?;
            c.execute_batch(
                "CREATE TABLE IF NOT EXISTS topic_outline_nodes (
                    id         TEXT PRIMARY KEY,
                    topic_id   TEXT NOT NULL,
                    title      TEXT NOT NULL,
                    status     TEXT NOT NULL DEFAULT 'planned',
                    position   INTEGER NOT NULL,
                    note       TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    metadata   TEXT NOT NULL DEFAULT '{}'
                );
                CREATE INDEX IF NOT EXISTS idx_topic_nodes_topic
                    ON topic_outline_nodes(topic_id, position);",
            )?;
            Ok(())
        }),
    ];

    for (version, step) in steps {
        if *version > current {
            step(conn)?;
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                params![version, Utc::now().to_rfc3339()],
            )?;
        }
    }
    Ok(())
}

impl Store {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(path).context("open sqlite")?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        migrate(&conn)?;
        let has_fts = conn.execute_batch(FTS_SCHEMA).is_ok();
        Ok(Self {
            conn: Mutex::new(conn),
            has_fts,
        })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("sqlite mutex poisoned")
    }

    // ---------- sessions ----------

    pub fn create_session(&self) -> Result<Session> {
        let session = Session::new();
        self.conn().execute(
            "INSERT INTO sessions (id, title, created_at) VALUES (?1, ?2, ?3)",
            params![
                session.id.as_str(),
                session.title,
                session.created_at.to_rfc3339()
            ],
        )?;
        Ok(session)
    }

    pub fn get_session(&self, id: &str) -> Result<Option<Session>> {
        let row = self
            .conn()
            .query_row(
                "SELECT id, title, created_at FROM sessions WHERE id = ?1",
                params![id],
                |row| {
                    Ok(Session {
                        id: row.get::<_, String>(0)?.into(),
                        title: row.get(1)?,
                        created_at: parse_dt(&row.get::<_, String>(2)?),
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    pub fn rename_session(&self, id: &str, title: &str) -> Result<()> {
        let title = title.trim();
        let value = if title.is_empty() { None } else { Some(title) };
        self.conn().execute(
            "UPDATE sessions SET title = ?2 WHERE id = ?1",
            params![id, value],
        )?;
        Ok(())
    }

    /// 删会话连同它的消息、卡片、升级链接和 cwd 绑定。
    /// 账本条目保留（那是知识，不是会话）；专题只在没有其它会话时清理。
    pub fn delete_session(&self, id: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let topic_id: Option<String> = tx
            .query_row(
                "SELECT topic_id FROM sessions WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        tx.execute("DELETE FROM messages WHERE session_id = ?1", params![id])?;
        tx.execute("DELETE FROM cards WHERE session_id = ?1", params![id])?;
        tx.execute(
            "UPDATE cards SET promoted_session_id = NULL WHERE promoted_session_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM ask_sessions WHERE session_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM session_seeds WHERE session_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM session_links WHERE parent_session_id = ?1 OR child_session_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        if let Some(topic_id) = topic_id {
            let remaining: i64 = tx.query_row(
                "SELECT COUNT(*) FROM sessions WHERE topic_id = ?1",
                params![topic_id],
                |row| row.get(0),
            )?;
            if remaining == 0 {
                tx.execute("DELETE FROM topics WHERE id = ?1", params![topic_id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// 第一条用户消息自动成为标题，侧边栏才不会全是“未命名”。
    pub fn maybe_title_session(&self, id: &str, text: &str) -> Result<()> {
        let title = clean_title(text);
        if title.is_empty() {
            return Ok(());
        }
        self.conn().execute(
            "UPDATE sessions SET title = ?2
             WHERE id = ?1 AND (title IS NULL OR trim(title) = '')",
            params![id, title],
        )?;
        Ok(())
    }

    // ---------- messages ----------

    pub fn add_message(&self, message: &Message) -> Result<()> {
        self.conn().execute(
            "INSERT INTO messages (id, session_id, role, text, created_at, status, turn_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                message.id.as_str(),
                message.session_id.as_str(),
                message.role.as_str(),
                message.text,
                message.created_at.to_rfc3339(),
                message.status.as_str(),
                message.turn_id
            ],
        )?;
        let _ = self.conn().execute(
            "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
            params![message.session_id.as_str(), message.created_at.to_rfc3339()],
        );
        Ok(())
    }

    /// 只解析 cwd 已绑定的会话，不创建新会话。给编辑器/插件做归属判断用。
    pub fn resolve_cwd(&self, cwd: &str) -> Result<Option<Session>> {
        self.existing_ask_session(cwd)
    }

    /// 按 cwd 复用会话：同一仓库的提问挂在同一条时间线上。
    pub fn session_for_cwd(&self, cwd: &str) -> Result<Session> {
        if let Some(existing) = self.existing_ask_session(cwd)? {
            return Ok(existing);
        }
        let session = Session::new();
        let title = cwd
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .filter(|part| !part.is_empty())
            .unwrap_or("inbox")
            .to_string();
        let titled = Session {
            title: Some(title),
            ..session
        };
        self.conn().execute(
            "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![
                titled.id.as_str(),
                titled.title,
                titled.created_at.to_rfc3339()
            ],
        )?;
        self.conn().execute(
            "INSERT OR REPLACE INTO ask_sessions (cwd, session_id, updated_at) VALUES (?1, ?2, ?3)",
            params![cwd, titled.id.as_str(), titled.created_at.to_rfc3339()],
        )?;
        Ok(titled)
    }

    pub fn add_turn_usage(
        &self,
        turn_id: &str,
        session_id: &str,
        prompt_tokens: u32,
        completion_tokens: u32,
        rounds: u32,
    ) -> Result<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO turn_usage
             (turn_id, session_id, prompt_tokens, completion_tokens, rounds, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                turn_id,
                session_id,
                prompt_tokens as i64,
                completion_tokens as i64,
                rounds as i64,
                Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn session_usage(&self, session_id: &str) -> Result<SessionUsage> {
        let (prompt, completion, turns): (i64, i64, i64) = self.conn().query_row(
            "SELECT COALESCE(SUM(prompt_tokens), 0),
                    COALESCE(SUM(completion_tokens), 0),
                    COUNT(*)
             FROM turn_usage WHERE session_id = ?1",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        Ok(SessionUsage {
            prompt_tokens: prompt as u64,
            completion_tokens: completion as u64,
            total_tokens: (prompt + completion) as u64,
            turns: turns as u64,
        })
    }

    /// 会话绑定的项目根目录（来自 /api/ask 的 cwd），没有则 None。
    pub fn session_project_root(&self, session_id: &str) -> Result<Option<String>> {
        let cwd: Option<String> = self
            .conn()
            .query_row(
                "SELECT cwd FROM ask_sessions WHERE session_id = ?1 LIMIT 1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(cwd.filter(|value| !value.trim().is_empty() && value != "inbox"))
    }

    fn existing_ask_session(&self, cwd: &str) -> Result<Option<Session>> {
        let row = self
            .conn()
            .query_row(
                "SELECT s.id, s.title, s.created_at
                 FROM ask_sessions a JOIN sessions s ON s.id = a.session_id
                 WHERE a.cwd = ?1",
                params![cwd],
                |row| {
                    Ok(Session {
                        id: row.get::<_, String>(0)?.into(),
                        title: row.get(1)?,
                        created_at: parse_dt(&row.get::<_, String>(2)?),
                    })
                },
            )
            .optional()?;
        if row.is_some() {
            let _ = self.conn().execute(
                "UPDATE ask_sessions SET updated_at = ?2 WHERE cwd = ?1",
                params![cwd, Utc::now().to_rfc3339()],
            );
        }
        Ok(row)
    }

    /// 最近活跃的会话，供侧边栏切换。带专题和来源摘要，避免前端 N+1。
    pub fn recent_sessions(&self, limit: usize) -> Result<Vec<SessionSummary>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT s.id, s.title, s.created_at, COALESCE(s.updated_at, s.created_at) AS ts,
                    (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS n,
                    s.topic_id, t.title,
                    seed.source_session_id, seed.source_title, seed.source_message_id,
                    seed.card_id, seed.quote
             FROM sessions s
             LEFT JOIN topics t ON t.id = s.topic_id
             LEFT JOIN session_seeds seed ON seed.session_id = s.id
             ORDER BY ts DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            let source_session_id: Option<String> = row.get(7)?;
            let origin = source_session_id.map(|parent_session_id| SessionOriginSummary {
                parent_session_id,
                parent_title: row.get(8).ok().flatten(),
                message_id: row
                    .get::<_, Option<String>>(9)
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                card_id: row
                    .get::<_, Option<String>>(10)
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                quote: row
                    .get::<_, Option<String>>(11)
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
            });
            Ok(SessionSummary {
                id: row.get::<_, String>(0)?.into(),
                title: row.get(1)?,
                updated_at: parse_dt(&row.get::<_, String>(3)?),
                messages: row.get::<_, i64>(4)? as usize,
                topic_id: row.get(5)?,
                topic_title: row.get(6)?,
                origin,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn messages(&self, session_id: &str) -> Result<Vec<Message>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, text, created_at, status, turn_id
             FROM messages WHERE session_id = ?1 ORDER BY rowid ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(Message {
                id: row.get::<_, String>(0)?.into(),
                session_id: row.get::<_, String>(1)?.into(),
                role: Role::parse(&row.get::<_, String>(2)?),
                text: row.get(3)?,
                created_at: parse_dt(&row.get::<_, String>(4)?),
                status: MessageStatus::parse(
                    &row.get::<_, String>(5).unwrap_or_else(|_| "ok".into()),
                ),
                turn_id: row.get(6).ok(),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 终态：ok / error / cancelled。崩溃后靠它区分"空回答"和"失败的回答"。
    pub fn set_message_status(
        &self,
        id: &str,
        status: MessageStatus,
        text: Option<&str>,
    ) -> Result<()> {
        match text {
            Some(text) => self.conn().execute(
                "UPDATE messages SET status = ?2, text = ?3 WHERE id = ?1",
                params![id, status.as_str(), text],
            )?,
            None => self.conn().execute(
                "UPDATE messages SET status = ?2 WHERE id = ?1",
                params![id, status.as_str()],
            )?,
        };
        Ok(())
    }

    /// 启动时把上次崩溃留下的 running 行收敛成 error，避免 UI 里永远转圈。
    pub fn fail_orphan_running(&self) -> Result<usize> {
        let changed = self.conn().execute(
            "UPDATE messages SET status = 'error' WHERE status = 'running'",
            [],
        )?;
        Ok(changed)
    }

    pub fn update_message_text(&self, id: &str, text: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE messages SET text = ?2 WHERE id = ?1",
            params![id, text],
        )?;
        Ok(())
    }

    /// 全库搜消息正文（账本之外的第二个人口）。
    pub fn search_messages(&self, query: &str, limit: usize) -> Result<Vec<MessageHit>> {
        let pattern = format!("%{}%", query.trim());
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT m.id, m.session_id, s.title, m.role, m.created_at,
                    substr(m.text, max(1, instr(lower(m.text), lower(?1)) - 40), 180)
             FROM messages m LEFT JOIN sessions s ON s.id = m.session_id
             WHERE lower(m.text) LIKE lower(?2)
             ORDER BY m.created_at DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![query.trim(), pattern, limit as i64], |row| {
            Ok(MessageHit {
                message_id: row.get::<_, String>(0)?,
                session_id: row.get::<_, String>(1)?,
                session_title: row.get(2)?,
                role: row.get::<_, String>(3)?,
                snippet: row.get::<_, String>(5)?,
                created_at: parse_dt(&row.get::<_, String>(4)?),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ---------- cards ----------

    pub fn add_card(&self, card: &Card) -> Result<()> {
        self.conn().execute(
            "INSERT INTO cards (id, session_id, message_id, char_start, char_end, quote, depth, question, answer, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                card.id.as_str(),
                card.session_id.as_str(),
                card.anchor.message_id.as_str(),
                card.anchor.char_start as i64,
                card.anchor.char_end as i64,
                card.anchor.quote,
                card.depth.as_str(),
                card.question,
                card.answer,
                card.created_at.to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn update_card(&self, id: &str, answer: &str, question: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE cards SET answer = ?2, question = ?3 WHERE id = ?1",
            params![id, answer, question],
        )?;
        Ok(())
    }

    pub fn cards(&self, session_id: &str) -> Result<Vec<Card>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, message_id, char_start, char_end, quote, depth, question, answer,
                    created_at, promoted_session_id
             FROM cards WHERE session_id = ?1 ORDER BY rowid ASC",
        )?;
        let rows = stmt.query_map(params![session_id], map_card)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ---------- glossary ----------

    pub fn insert_entry(&self, entry: &GlossaryEntry) -> Result<()> {
        let anchor = entry.source_anchor.clone();
        self.conn().execute(
            "INSERT INTO glossary (id, term, gist, depth, message_id, char_start, char_end, quote, created_at, mastery, session_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                entry.id.as_str(),
                entry.term,
                entry.gist,
                entry.depth.as_str(),
                anchor.as_ref().map(|a| a.message_id.to_string()),
                anchor.as_ref().map(|a| a.char_start as i64),
                anchor.as_ref().map(|a| a.char_end as i64),
                anchor.as_ref().map(|a| a.quote.clone()),
                entry.created_at.to_rfc3339(),
                entry.mastery.as_str(),
                entry.session_id.as_ref().map(|s| s.to_string()),
                entry.created_at.to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn update_entry(
        &self,
        id: &str,
        gist: Option<&str>,
        depth: Option<Depth>,
        mastery: Option<Mastery>,
    ) -> Result<()> {
        let conn = self.conn();
        if let Some(gist) = gist {
            conn.execute(
                "UPDATE glossary SET gist = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, gist, Utc::now().to_rfc3339()],
            )?;
        }
        if let Some(depth) = depth {
            conn.execute(
                "UPDATE glossary SET depth = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, depth.as_str(), Utc::now().to_rfc3339()],
            )?;
        }
        if let Some(mastery) = mastery {
            conn.execute(
                "UPDATE glossary SET mastery = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, mastery.as_str(), Utc::now().to_rfc3339()],
            )?;
        }
        Ok(())
    }

    pub fn delete_entry(&self, id: &str) -> Result<()> {
        self.conn()
            .execute("DELETE FROM glossary WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// 合并重复条目：把 source 的结论并进 target，再删掉 source。
    pub fn merge_entries(&self, target: &str, sources: &[String]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut gist: String = tx
            .query_row(
                "SELECT gist FROM glossary WHERE id = ?1",
                params![target],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or_default();
        for source in sources {
            if source == target {
                continue;
            }
            let extra: Option<String> = tx
                .query_row(
                    "SELECT gist FROM glossary WHERE id = ?1",
                    params![source],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(extra) = extra {
                if !extra.trim().is_empty() && !gist.contains(extra.trim()) {
                    gist.push_str(" ｜ ");
                    gist.push_str(extra.trim());
                }
            }
            tx.execute("DELETE FROM glossary WHERE id = ?1", params![source])?;
        }
        tx.execute(
            "UPDATE glossary SET gist = ?2, updated_at = ?3 WHERE id = ?1",
            params![target, gist, Utc::now().to_rfc3339()],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// 命中优先：按术语找最近的条目（大小写不敏感，先精确后模糊）。
    pub fn match_entry(&self, term: &str) -> Result<Option<GlossaryEntry>> {
        let needle = term.trim();
        if needle.is_empty() {
            return Ok(None);
        }
        let exact: Option<GlossaryEntry> = self
            .conn()
            .query_row(
                "SELECT id, term, gist, depth, message_id, char_start, char_end, quote, created_at, mastery, session_id
                 FROM glossary WHERE lower(trim(term)) = lower(trim(?1))
                 ORDER BY rowid DESC LIMIT 1",
                params![needle],
                map_entry,
            )
            .optional()?;
        if exact.is_some() {
            return Ok(exact);
        }
        let fuzzy: Option<GlossaryEntry> = self
            .conn()
            .query_row(
                "SELECT id, term, gist, depth, message_id, char_start, char_end, quote, created_at, mastery, session_id
                 FROM glossary WHERE lower(term) LIKE lower(?1)
                 ORDER BY length(term) ASC, rowid DESC LIMIT 1",
                params![format!("%{}%", needle)],
                map_entry,
            )
            .optional()?;
        Ok(fuzzy)
    }

    pub fn all_entries(&self) -> Result<Vec<GlossaryEntry>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, term, gist, depth, message_id, char_start, char_end, quote, created_at, mastery, session_id
             FROM glossary ORDER BY rowid DESC",
        )?;
        let rows = stmt.query_map([], map_entry)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn search_entries(&self, query: Option<&str>, limit: usize) -> Result<Vec<GlossaryEntry>> {
        let conn = self.conn();
        let q = query.map(str::trim).filter(|q| !q.is_empty());

        let mut out = Vec::new();
        match (q, self.has_fts) {
            (Some(q), true) => {
                let mut stmt = conn.prepare(
                    "SELECT g.id, g.term, g.gist, g.depth, g.message_id, g.char_start, g.char_end, g.quote, g.created_at, g.mastery, g.session_id
                     FROM glossary_fts f JOIN glossary g ON g.rowid = f.rowid
                     WHERE glossary_fts MATCH ?1 ORDER BY rank LIMIT ?2",
                )?;
                let rows = stmt.query_map(params![format!("{}*", q), limit as i64], map_entry)?;
                for row in rows {
                    out.push(row?);
                }
            }
            (Some(q), false) => {
                let pattern = format!("%{}%", q);
                let mut stmt = conn.prepare(
                    "SELECT id, term, gist, depth, message_id, char_start, char_end, quote, created_at, mastery, session_id
                     FROM glossary WHERE term LIKE ?1 OR gist LIKE ?1 ORDER BY rowid DESC LIMIT ?2",
                )?;
                let rows = stmt.query_map(params![pattern, limit as i64], map_entry)?;
                for row in rows {
                    out.push(row?);
                }
            }
            _ => {
                let mut stmt = conn.prepare(
                    "SELECT id, term, gist, depth, message_id, char_start, char_end, quote, created_at, mastery, session_id
                     FROM glossary ORDER BY rowid DESC LIMIT ?1",
                )?;
                let rows = stmt.query_map(params![limit as i64], map_entry)?;
                for row in rows {
                    out.push(row?);
                }
            }
        }
        Ok(out)
    }

    // ---------- 专题 / 升级 ----------

    pub fn topic(&self, id: &str) -> Result<Option<Topic>> {
        load_topic(&self.conn(), id)
    }

    pub fn topic_for_session(&self, session_id: &str) -> Result<Option<Topic>> {
        load_topic_for_session(&self.conn(), session_id)
    }

    pub fn all_topics(&self) -> Result<Vec<Topic>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, title, summary, depth_goal, mastery, created_at, metadata, outline_md
             FROM topics ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], map_topic)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn create_topic(&self, topic: &Topic) -> Result<()> {
        let metadata = serde_json::to_string(&topic.metadata).unwrap_or_else(|_| "{}".into());
        self.conn().execute(
            "INSERT INTO topics (id, title, summary, depth_goal, mastery, created_at, metadata, outline_md)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                topic.id.as_str(),
                topic.title,
                topic.summary,
                topic.depth_goal.as_str(),
                topic.mastery.as_str(),
                topic.created_at.to_rfc3339(),
                metadata,
                topic.outline_md
            ],
        )?;
        Ok(())
    }

    pub fn update_topic(
        &self,
        id: &str,
        title: Option<&str>,
        summary: Option<&str>,
        depth: Option<Depth>,
        mastery: Option<Mastery>,
        outline_md: Option<&str>,
    ) -> Result<Option<Topic>> {
        let conn = self.conn();
        if let Some(value) = title {
            let value = clean_title(value);
            if !value.is_empty() {
                conn.execute(
                    "UPDATE topics SET title = ?2 WHERE id = ?1",
                    params![id, value],
                )?;
            }
        }
        if let Some(value) = summary {
            conn.execute(
                "UPDATE topics SET summary = ?2 WHERE id = ?1",
                params![id, value],
            )?;
        }
        if let Some(value) = depth {
            conn.execute(
                "UPDATE topics SET depth_goal = ?2 WHERE id = ?1",
                params![id, value.as_str()],
            )?;
        }
        if let Some(value) = mastery {
            conn.execute(
                "UPDATE topics SET mastery = ?2 WHERE id = ?1",
                params![id, value.as_str()],
            )?;
        }
        if let Some(value) = outline_md {
            conn.execute(
                "UPDATE topics SET outline_md = ?2 WHERE id = ?1",
                params![id, value],
            )?;
        }
        drop(conn);
        self.topic(id)
    }

    pub fn sessions_for_topic(&self, topic_id: &str) -> Result<Vec<SessionSummary>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT s.id, s.title, s.created_at, COALESCE(s.updated_at, s.created_at) AS ts,
                    (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS n,
                    s.topic_id, t.title,
                    seed.source_session_id, seed.source_title, seed.source_message_id,
                    seed.card_id, seed.quote
             FROM sessions s
             LEFT JOIN topics t ON t.id = s.topic_id
             LEFT JOIN session_seeds seed ON seed.session_id = s.id
             WHERE s.topic_id = ?1
             ORDER BY ts DESC",
        )?;
        let rows = stmt.query_map(params![topic_id], |row| {
            let source_session_id: Option<String> = row.get(7)?;
            let origin = source_session_id.map(|parent_session_id| SessionOriginSummary {
                parent_session_id,
                parent_title: row.get(8).ok().flatten(),
                message_id: row
                    .get::<_, Option<String>>(9)
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                card_id: row
                    .get::<_, Option<String>>(10)
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                quote: row
                    .get::<_, Option<String>>(11)
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
            });
            Ok(SessionSummary {
                id: row.get::<_, String>(0)?,
                title: row.get(1)?,
                updated_at: parse_dt(&row.get::<_, String>(3)?),
                messages: row.get::<_, i64>(4)? as usize,
                topic_id: row.get(5)?,
                topic_title: row.get(6)?,
                origin,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn create_session_in_topic(&self, topic_id: &str) -> Result<Session> {
        let topic = self
            .topic(topic_id)?
            .with_context(|| format!("topic not found: {topic_id}"))?;
        let session = Session {
            title: Some(topic.title),
            ..Session::new()
        };
        self.conn().execute(
            "INSERT INTO sessions (id, title, created_at, updated_at, topic_id)
             VALUES (?1, ?2, ?3, ?3, ?4)",
            params![
                session.id.as_str(),
                session.title,
                session.created_at.to_rfc3339(),
                topic_id
            ],
        )?;
        Ok(session)
    }

    pub fn set_session_topic(&self, session_id: &str, topic_id: Option<&str>) -> Result<()> {
        if let Some(topic_id) = topic_id {
            if self.topic(topic_id)?.is_none() {
                bail!("topic not found: {topic_id}");
            }
        }
        self.conn().execute(
            "UPDATE sessions SET topic_id = ?2 WHERE id = ?1",
            params![session_id, topic_id],
        )?;
        Ok(())
    }

    pub fn topic_seed(&self, topic_id: &str) -> Result<Option<SessionSeed>> {
        let conn = self.conn();
        let session_id: Option<String> = conn
            .query_row(
                "SELECT seed.session_id
                 FROM session_seeds seed JOIN sessions s ON s.id = seed.session_id
                 WHERE s.topic_id = ?1 ORDER BY seed.rowid LIMIT 1",
                params![topic_id],
                |row| row.get(0),
            )
            .optional()?;
        match session_id {
            Some(session_id) => load_seed(&conn, &session_id),
            None => Ok(None),
        }
    }

    pub fn edges_for_topic(&self, topic_id: &str) -> Result<Vec<TopicEdge>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, from_topic_id, to_topic_id, kind, note, created_at, metadata
             FROM topic_edges WHERE from_topic_id = ?1 OR to_topic_id = ?1
             ORDER BY rowid ASC",
        )?;
        let rows = stmt.query_map(params![topic_id], map_topic_edge)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 添加专题关系。`from` 是前置，`to` 是依赖方；prerequisite 会做环检测。
    pub fn add_topic_edge(
        &self,
        from_topic_id: &str,
        to_topic_id: &str,
        kind: TopicEdgeKind,
        note: &str,
        metadata: Option<serde_json::Value>,
    ) -> Result<TopicEdge> {
        if from_topic_id == to_topic_id {
            bail!("topic cannot relate to itself");
        }
        if self.topic(from_topic_id)?.is_none() {
            bail!("topic not found: {from_topic_id}");
        }
        if self.topic(to_topic_id)?.is_none() {
            bail!("topic not found: {to_topic_id}");
        }
        if kind == TopicEdgeKind::Prerequisite {
            let conn = self.conn();
            if prereq_reaches(&conn, to_topic_id, from_topic_id)? {
                bail!("prerequisite cycle detected");
            }
        }

        let existing: Option<TopicEdge> = self
            .conn()
            .query_row(
                "SELECT id, from_topic_id, to_topic_id, kind, note, created_at, metadata
                 FROM topic_edges WHERE from_topic_id = ?1 AND to_topic_id = ?2 AND kind = ?3",
                params![from_topic_id, to_topic_id, kind.as_str()],
                map_topic_edge,
            )
            .optional()?;
        if let Some(existing) = existing {
            return Ok(existing);
        }

        let edge = TopicEdge {
            id: TopicEdgeId::new(),
            from_topic_id: from_topic_id.into(),
            to_topic_id: to_topic_id.into(),
            kind,
            note: note.trim().to_string(),
            created_at: Utc::now(),
            metadata: metadata.unwrap_or_else(|| serde_json::json!({})),
        };
        let metadata = serde_json::to_string(&edge.metadata).unwrap_or_else(|_| "{}".into());
        self.conn().execute(
            "INSERT INTO topic_edges (id, from_topic_id, to_topic_id, kind, note, created_at, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                edge.id.as_str(),
                edge.from_topic_id.as_str(),
                edge.to_topic_id.as_str(),
                edge.kind.as_str(),
                edge.note,
                edge.created_at.to_rfc3339(),
                metadata
            ],
        )?;
        Ok(edge)
    }

    pub fn delete_topic_edge(&self, id: &str) -> Result<()> {
        self.conn()
            .execute("DELETE FROM topic_edges WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---------- 课程 / 课表 ----------

    pub fn all_courses(&self) -> Result<Vec<CourseSummary>> {
        let courses: Vec<Course> = {
            let conn = self.conn();
            let mut stmt = conn.prepare(
                "SELECT id, title, goal, start_date, end_date, created_at, metadata,
                        daily_minutes, study_days
                 FROM courses ORDER BY created_at DESC",
            )?;
            let rows = stmt.query_map([], map_course)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut out = Vec::with_capacity(courses.len());
        for course in courses {
            let topic_count: i64 = self.conn().query_row(
                "SELECT COUNT(*) FROM course_items WHERE course_id = ?1",
                params![course.id.as_str()],
                |row| row.get(0),
            )?;
            let done_count: i64 = self.conn().query_row(
                "SELECT COUNT(*) FROM course_items WHERE course_id = ?1 AND status = 'done'",
                params![course.id.as_str()],
                |row| row.get(0),
            )?;
            let next_date: Option<String> = self
                .conn()
                .query_row(
                    "SELECT MIN(planned_at) FROM course_items
                     WHERE course_id = ?1 AND planned_at IS NOT NULL AND planned_at != ''
                       AND status != 'done'",
                    params![course.id.as_str()],
                    |row| row.get(0),
                )
                .optional()?
                .flatten();
            out.push(CourseSummary {
                course,
                topic_count: topic_count as usize,
                done_count: done_count as usize,
                next_date,
            });
        }
        Ok(out)
    }

    pub fn course(&self, id: &str) -> Result<Option<Course>> {
        load_course(&self.conn(), id)
    }

    pub fn create_course(&self, course: &Course) -> Result<()> {
        let metadata = serde_json::to_string(&course.metadata).unwrap_or_else(|_| "{}".into());
        self.conn().execute(
            "INSERT INTO courses (id, title, goal, start_date, end_date, created_at, metadata,
                                  daily_minutes, study_days)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                course.id.as_str(),
                course.title,
                course.goal,
                course.start_date,
                course.end_date,
                course.created_at.to_rfc3339(),
                metadata,
                course.daily_minutes,
                course.study_days
            ],
        )?;
        Ok(())
    }

    pub fn update_course(
        &self,
        id: &str,
        title: Option<&str>,
        goal: Option<&str>,
        start_date: Option<&str>,
        end_date: Option<&str>,
        daily_minutes: Option<i64>,
        study_days: Option<&str>,
    ) -> Result<Option<Course>> {
        let conn = self.conn();
        if let Some(value) = title {
            let value = clean_title(value);
            if !value.is_empty() {
                conn.execute(
                    "UPDATE courses SET title = ?2 WHERE id = ?1",
                    params![id, value],
                )?;
            }
        }
        if let Some(value) = goal {
            conn.execute(
                "UPDATE courses SET goal = ?2 WHERE id = ?1",
                params![id, value],
            )?;
        }
        if let Some(value) = start_date {
            let value = if value.trim().is_empty() {
                None
            } else {
                Some(value.trim())
            };
            conn.execute(
                "UPDATE courses SET start_date = ?2 WHERE id = ?1",
                params![id, value],
            )?;
        }
        if let Some(value) = end_date {
            let value = if value.trim().is_empty() {
                None
            } else {
                Some(value.trim())
            };
            conn.execute(
                "UPDATE courses SET end_date = ?2 WHERE id = ?1",
                params![id, value],
            )?;
        }
        if let Some(value) = daily_minutes {
            conn.execute(
                "UPDATE courses SET daily_minutes = ?2 WHERE id = ?1",
                params![id, value.clamp(10, 1440)],
            )?;
        }
        if let Some(value) = study_days {
            conn.execute(
                "UPDATE courses SET study_days = ?2 WHERE id = ?1",
                params![id, value],
            )?;
        }
        drop(conn);
        self.course(id)
    }

    pub fn delete_course(&self, id: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM course_items WHERE course_id = ?1", params![id])?;
        tx.execute("DELETE FROM courses WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn course_items(&self, course_id: &str) -> Result<Vec<CourseItem>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, course_id, topic_id, position, planned_at, status, note,
                    created_at, metadata, estimated_minutes
             FROM course_items WHERE course_id = ?1 ORDER BY position ASC, rowid ASC",
        )?;
        let rows = stmt.query_map(params![course_id], map_course_item)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn add_course_item(
        &self,
        course_id: &str,
        topic_id: &str,
        planned_at: Option<&str>,
        position: Option<i64>,
        estimated_minutes: Option<i64>,
    ) -> Result<CourseItem> {
        if self.course(course_id)?.is_none() {
            bail!("course not found: {course_id}");
        }
        if self.topic(topic_id)?.is_none() {
            bail!("topic not found: {topic_id}");
        }
        if let Some(existing) = self
            .conn()
            .query_row(
                "SELECT id, course_id, topic_id, position, planned_at, status, note,
                        created_at, metadata, estimated_minutes
                 FROM course_items WHERE course_id = ?1 AND topic_id = ?2",
                params![course_id, topic_id],
                map_course_item,
            )
            .optional()?
        {
            return Ok(existing);
        }
        let position = match position {
            Some(value) => value,
            None => self.conn().query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM course_items WHERE course_id = ?1",
                params![course_id],
                |row| row.get(0),
            )?,
        };
        let item = CourseItem {
            id: CourseItemId::new(),
            course_id: course_id.into(),
            topic_id: topic_id.into(),
            position,
            planned_at: planned_at
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            status: CourseItemStatus::Planned,
            note: String::new(),
            estimated_minutes: estimated_minutes.unwrap_or(60).clamp(1, 1440),
            created_at: Utc::now(),
            metadata: serde_json::json!({}),
        };
        let metadata = serde_json::to_string(&item.metadata).unwrap_or_else(|_| "{}".into());
        self.conn().execute(
            "INSERT INTO course_items
                (id, course_id, topic_id, position, planned_at, status, note, created_at, metadata,
                 estimated_minutes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                item.id.as_str(),
                item.course_id.as_str(),
                item.topic_id.as_str(),
                item.position,
                item.planned_at,
                item.status.as_str(),
                item.note,
                item.created_at.to_rfc3339(),
                metadata,
                item.estimated_minutes
            ],
        )?;
        Ok(item)
    }

    pub fn update_course_item(
        &self,
        course_id: &str,
        item_id: &str,
        planned_at: Option<&str>,
        status: Option<CourseItemStatus>,
        note: Option<&str>,
        position: Option<i64>,
        estimated_minutes: Option<i64>,
    ) -> Result<Option<CourseItem>> {
        let conn = self.conn();
        if let Some(value) = planned_at {
            let value = if value.trim().is_empty() {
                None
            } else {
                Some(value.trim())
            };
            conn.execute(
                "UPDATE course_items SET planned_at = ?3 WHERE course_id = ?1 AND id = ?2",
                params![course_id, item_id, value],
            )?;
        }
        if let Some(value) = status {
            conn.execute(
                "UPDATE course_items SET status = ?3 WHERE course_id = ?1 AND id = ?2",
                params![course_id, item_id, value.as_str()],
            )?;
        }
        if let Some(value) = note {
            conn.execute(
                "UPDATE course_items SET note = ?3 WHERE course_id = ?1 AND id = ?2",
                params![course_id, item_id, value],
            )?;
        }
        if let Some(value) = position {
            conn.execute(
                "UPDATE course_items SET position = ?3 WHERE course_id = ?1 AND id = ?2",
                params![course_id, item_id, value],
            )?;
        }
        if let Some(value) = estimated_minutes {
            conn.execute(
                "UPDATE course_items SET estimated_minutes = ?3
                 WHERE course_id = ?1 AND id = ?2",
                params![course_id, item_id, value.clamp(1, 1440)],
            )?;
        }
        drop(conn);
        self.course_item(course_id, item_id)
    }

    pub fn course_item(&self, course_id: &str, item_id: &str) -> Result<Option<CourseItem>> {
        let conn = self.conn();
        Ok(conn
            .query_row(
                "SELECT id, course_id, topic_id, position, planned_at, status, note,
                        created_at, metadata, estimated_minutes
                 FROM course_items WHERE course_id = ?1 AND id = ?2",
                params![course_id, item_id],
                map_course_item,
            )
            .optional()?)
    }

    pub fn delete_course_item(&self, course_id: &str, item_id: &str) -> Result<()> {
        self.conn().execute(
            "DELETE FROM course_items WHERE course_id = ?1 AND id = ?2",
            params![course_id, item_id],
        )?;
        Ok(())
    }

    pub fn reorder_course_items(&self, course_id: &str, item_ids: &[String]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for (index, item_id) in item_ids.iter().enumerate() {
            tx.execute(
                "UPDATE course_items SET position = ?3
                 WHERE course_id = ?1 AND id = ?2",
                params![course_id, item_id, index as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn course_item_count_for_topic(&self, topic_id: &str) -> Result<usize> {
        let count: i64 = self.conn().query_row(
            "SELECT COUNT(*) FROM course_items WHERE topic_id = ?1",
            params![topic_id],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }

    /// 删除专题。默认保留会话（转为普通会话）；`delete_sessions=true` 时连同会话删除。
    pub fn delete_topic(&self, topic_id: &str, delete_sessions: bool) -> Result<TopicDeleteResult> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        if tx
            .query_row(
                "SELECT 1 FROM topics WHERE id = ?1",
                params![topic_id],
                |_| Ok(()),
            )
            .optional()?
            .is_none()
        {
            bail!("topic not found: {topic_id}");
        }

        let session_ids: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM sessions WHERE topic_id = ?1")?;
            let rows = stmt.query_map(params![topic_id], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let course_items_removed = tx.execute(
            "DELETE FROM course_items WHERE topic_id = ?1",
            params![topic_id],
        )?;
        let edges_removed = tx.execute(
            "DELETE FROM topic_edges WHERE from_topic_id = ?1 OR to_topic_id = ?1",
            params![topic_id],
        )?;
        let nodes_removed = tx.execute(
            "DELETE FROM topic_outline_nodes WHERE topic_id = ?1",
            params![topic_id],
        )?;

        if delete_sessions {
            tx.execute(
                "UPDATE cards SET promoted_session_id = NULL
                 WHERE promoted_session_id IN (SELECT id FROM sessions WHERE topic_id = ?1)",
                params![topic_id],
            )?;
            for session_id in &session_ids {
                tx.execute(
                    "DELETE FROM messages WHERE session_id = ?1",
                    params![session_id],
                )?;
                tx.execute(
                    "DELETE FROM cards WHERE session_id = ?1",
                    params![session_id],
                )?;
                tx.execute(
                    "DELETE FROM ask_sessions WHERE session_id = ?1",
                    params![session_id],
                )?;
                tx.execute(
                    "DELETE FROM session_seeds WHERE session_id = ?1",
                    params![session_id],
                )?;
                tx.execute(
                    "DELETE FROM session_links WHERE parent_session_id = ?1 OR child_session_id = ?1",
                    params![session_id],
                )?;
                tx.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])?;
            }
        } else {
            tx.execute(
                "UPDATE sessions SET topic_id = NULL WHERE topic_id = ?1",
                params![topic_id],
            )?;
        }
        tx.execute("DELETE FROM topics WHERE id = ?1", params![topic_id])?;
        tx.commit()?;
        Ok(TopicDeleteResult {
            sessions_deleted: if delete_sessions {
                session_ids.len()
            } else {
                0
            },
            sessions_kept: if delete_sessions {
                0
            } else {
                session_ids.len()
            },
            course_items_removed,
            edges_removed,
            nodes_removed,
        })
    }

    pub fn topic_nodes(&self, topic_id: &str) -> Result<Vec<TopicNode>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, topic_id, title, status, position, note, created_at, metadata
             FROM topic_outline_nodes WHERE topic_id = ?1 ORDER BY position ASC, rowid ASC",
        )?;
        let rows = stmt.query_map(params![topic_id], map_topic_node)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 用 Markdown 解析结果同步节点：
    /// - 自动节点按新大纲重建，同名节点保留状态；
    /// - `metadata.source == "manual"` 的手工节点保留，不会被解析结果冲掉。
    pub fn replace_topic_nodes(&self, topic_id: &str, titles: &[String]) -> Result<Vec<TopicNode>> {
        let existing = self.topic_nodes(topic_id)?;
        let mut status_by_title: std::collections::HashMap<String, TopicNodeStatus> = existing
            .iter()
            .map(|node| (node.title.to_lowercase(), node.status))
            .collect();
        let manual: Vec<TopicNode> = existing
            .iter()
            .filter(|node| {
                node.metadata.get("source").and_then(|value| value.as_str()) == Some("manual")
            })
            .cloned()
            .collect();
        let manual_titles: std::collections::HashSet<String> = manual
            .iter()
            .map(|node| node.title.to_lowercase())
            .collect();

        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for node in existing.iter().filter(|node| {
            node.metadata.get("source").and_then(|value| value.as_str()) != Some("manual")
        }) {
            tx.execute(
                "DELETE FROM topic_outline_nodes WHERE topic_id = ?1 AND id = ?2",
                params![topic_id, node.id.as_str()],
            )?;
        }
        let now = Utc::now().to_rfc3339();
        let mut position = 0i64;
        for title in titles {
            if manual_titles.contains(&title.to_lowercase()) {
                continue;
            }
            let status = status_by_title
                .remove(&title.to_lowercase())
                .unwrap_or_default();
            tx.execute(
                "INSERT INTO topic_outline_nodes
                    (id, topic_id, title, status, position, note, created_at, metadata)
                 VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, '{\"source\":\"outline\"}')",
                params![
                    TopicNodeId::new().as_str(),
                    topic_id,
                    title,
                    status.as_str(),
                    position,
                    now
                ],
            )?;
            position += 1;
        }
        for node in &manual {
            tx.execute(
                "UPDATE topic_outline_nodes SET position = ?3
                 WHERE topic_id = ?1 AND id = ?2",
                params![topic_id, node.id.as_str(), position],
            )?;
            position += 1;
        }
        tx.commit()?;
        drop(conn);
        self.topic_nodes(topic_id)
    }

    pub fn add_topic_node(&self, topic_id: &str, title: &str) -> Result<TopicNode> {
        if self.topic(topic_id)?.is_none() {
            bail!("topic not found: {topic_id}");
        }
        let position: i64 = self.conn().query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM topic_outline_nodes WHERE topic_id = ?1",
            params![topic_id],
            |row| row.get(0),
        )?;
        let node = TopicNode {
            id: TopicNodeId::new(),
            topic_id: topic_id.into(),
            title: title.trim().to_string(),
            status: TopicNodeStatus::Planned,
            position,
            note: String::new(),
            created_at: Utc::now(),
            metadata: serde_json::json!({ "source": "manual" }),
        };
        let metadata = serde_json::to_string(&node.metadata).unwrap_or_else(|_| "{}".into());
        self.conn().execute(
            "INSERT INTO topic_outline_nodes
                (id, topic_id, title, status, position, note, created_at, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                node.id.as_str(),
                node.topic_id.as_str(),
                node.title,
                node.status.as_str(),
                node.position,
                node.note,
                node.created_at.to_rfc3339(),
                metadata
            ],
        )?;
        Ok(node)
    }

    pub fn update_topic_node(
        &self,
        topic_id: &str,
        node_id: &str,
        title: Option<&str>,
        status: Option<TopicNodeStatus>,
        note: Option<&str>,
        position: Option<i64>,
    ) -> Result<Option<TopicNode>> {
        let conn = self.conn();
        if let Some(value) = title {
            let value = clean_title(value);
            if !value.is_empty() {
                conn.execute(
                    "UPDATE topic_outline_nodes SET title = ?3
                     WHERE topic_id = ?1 AND id = ?2",
                    params![topic_id, node_id, value],
                )?;
            }
        }
        if let Some(value) = status {
            conn.execute(
                "UPDATE topic_outline_nodes SET status = ?3
                 WHERE topic_id = ?1 AND id = ?2",
                params![topic_id, node_id, value.as_str()],
            )?;
        }
        if let Some(value) = note {
            conn.execute(
                "UPDATE topic_outline_nodes SET note = ?3
                 WHERE topic_id = ?1 AND id = ?2",
                params![topic_id, node_id, value],
            )?;
        }
        if let Some(value) = position {
            conn.execute(
                "UPDATE topic_outline_nodes SET position = ?3
                 WHERE topic_id = ?1 AND id = ?2",
                params![topic_id, node_id, value],
            )?;
        }
        drop(conn);
        Ok(self
            .topic_nodes(topic_id)?
            .into_iter()
            .find(|node| node.id.as_str() == node_id))
    }

    pub fn delete_topic_node(&self, topic_id: &str, node_id: &str) -> Result<()> {
        self.conn().execute(
            "DELETE FROM topic_outline_nodes WHERE topic_id = ?1 AND id = ?2",
            params![topic_id, node_id],
        )?;
        Ok(())
    }

    pub fn session_seed(&self, session_id: &str) -> Result<Option<SessionSeed>> {
        load_seed(&self.conn(), session_id)
    }

    /// 把一张卡片升级成“专题 + 新会话”，并保存来源链。
    /// 幂等：同一张卡重复调用返回同一个会话，不会产生重复专题。
    pub fn promote_card(
        &self,
        session_id: &str,
        card_id: &str,
        title: Option<&str>,
        depth_goal: Option<Depth>,
        metadata: Option<serde_json::Value>,
        target_topic_id: Option<&str>,
    ) -> Result<Promotion> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;

        let card =
            load_card(&tx, card_id)?.with_context(|| format!("card not found: {card_id}"))?;
        if card.session_id.as_str() != session_id {
            bail!("card {card_id} does not belong to session {session_id}");
        }

        if let Some(existing) = card.promoted_session_id.as_ref() {
            let topic = load_topic_for_session(&tx, existing.as_str())?
                .with_context(|| format!("promoted topic missing for session {existing}"))?;
            let seed = load_seed(&tx, existing.as_str())?
                .with_context(|| format!("promoted seed missing for session {existing}"))?;
            tx.commit()?;
            return Ok(Promotion {
                session_id: existing.to_string(),
                topic_id: topic.id.to_string(),
                topic,
                seed,
            });
        }

        let parent_title: Option<String> = tx
            .query_row(
                "SELECT title FROM sessions WHERE id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let source_text: Option<String> = tx
            .query_row(
                "SELECT text FROM messages WHERE id = ?1",
                params![card.anchor.message_id.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        let context = source_text
            .as_deref()
            .map(|text| card.anchor.context_window(text, 240))
            .filter(|text| !text.trim().is_empty())
            .unwrap_or_else(|| card.anchor.quote.clone());

        let depth = depth_goal.unwrap_or(card.depth);
        let topic = if let Some(topic_id) = target_topic_id {
            load_topic(&tx, topic_id)?.with_context(|| format!("topic not found: {topic_id}"))?
        } else {
            let title = clean_title(title.unwrap_or(&card.anchor.quote));
            let title = if title.is_empty() {
                "未命名专题".to_string()
            } else {
                title
            };
            let mut topic = Topic::new(title, summarize(&card.answer), depth);
            if let Some(value) = metadata {
                topic.metadata = value;
            }
            let topic_metadata =
                serde_json::to_string(&topic.metadata).unwrap_or_else(|_| "{}".into());
            tx.execute(
                "INSERT INTO topics (id, title, summary, depth_goal, mastery, created_at, metadata, outline_md)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    topic.id.as_str(),
                    topic.title,
                    topic.summary,
                    topic.depth_goal.as_str(),
                    topic.mastery.as_str(),
                    topic.created_at.to_rfc3339(),
                    topic_metadata,
                    topic.outline_md
                ],
            )?;
            topic
        };
        let topic_metadata = serde_json::to_string(&topic.metadata).unwrap_or_else(|_| "{}".into());

        let new_session = SessionId::new();
        let now = Utc::now().to_rfc3339();
        tx.execute(
            "INSERT INTO sessions (id, title, created_at, updated_at, topic_id)
             VALUES (?1, ?2, ?3, ?3, ?4)",
            params![new_session.as_str(), topic.title, now, topic.id.as_str()],
        )?;

        let seed_metadata = topic_metadata.clone();
        let seed = SessionSeed {
            session_id: new_session.clone(),
            topic_id: topic.id.clone(),
            topic_title: topic.title.clone(),
            source_session_id: card.session_id.clone(),
            source_title: parent_title,
            source_message_id: card.anchor.message_id.clone(),
            card_id: card.id.clone(),
            quote: card.anchor.quote.clone(),
            context,
            answer: card.answer.clone(),
            depth: card.depth,
            metadata: topic.metadata.clone(),
        };
        tx.execute(
            "INSERT INTO session_seeds
                (session_id, topic_id, topic_title, source_session_id, source_title,
                 source_message_id, card_id, quote, context, answer, depth, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                seed.session_id.as_str(),
                seed.topic_id.as_str(),
                seed.topic_title,
                seed.source_session_id.as_str(),
                seed.source_title,
                seed.source_message_id.as_str(),
                seed.card_id.as_str(),
                seed.quote,
                seed.context,
                seed.answer,
                seed.depth.as_str(),
                seed_metadata
            ],
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO session_links
                (parent_session_id, child_session_id, card_id, kind, metadata, created_at)
             VALUES (?1, ?2, ?3, 'promoted_from', ?4, ?5)",
            params![
                session_id,
                new_session.as_str(),
                card.id.as_str(),
                "{}",
                now
            ],
        )?;
        tx.execute(
            "UPDATE cards SET promoted_session_id = ?2 WHERE id = ?1",
            params![card.id.as_str(), new_session.as_str()],
        )?;

        tx.commit()?;
        Ok(Promotion {
            session_id: new_session.to_string(),
            topic_id: topic.id.to_string(),
            topic,
            seed,
        })
    }
}

fn map_course(row: &Row<'_>) -> rusqlite::Result<Course> {
    let metadata: String = row.get(6)?;
    Ok(Course {
        id: row.get::<_, String>(0)?.into(),
        title: row.get(1)?,
        goal: row.get(2)?,
        start_date: row.get(3)?,
        end_date: row.get(4)?,
        created_at: parse_dt(&row.get::<_, String>(5)?),
        daily_minutes: row.get(7).unwrap_or(60),
        study_days: row.get(8).unwrap_or_else(|_| "1,2,3,4,5".into()),
        metadata: serde_json::from_str(&metadata).unwrap_or_else(|_| serde_json::json!({})),
    })
}

fn load_course(conn: &Connection, id: &str) -> Result<Option<Course>> {
    Ok(conn
        .query_row(
            "SELECT id, title, goal, start_date, end_date, created_at, metadata,
                    daily_minutes, study_days
             FROM courses WHERE id = ?1",
            params![id],
            map_course,
        )
        .optional()?)
}

fn map_course_item(row: &Row<'_>) -> rusqlite::Result<CourseItem> {
    let metadata: String = row.get(8)?;
    Ok(CourseItem {
        id: row.get::<_, String>(0)?.into(),
        course_id: row.get::<_, String>(1)?.into(),
        topic_id: row.get::<_, String>(2)?.into(),
        position: row.get(3)?,
        planned_at: row.get(4)?,
        status: CourseItemStatus::parse(&row.get::<_, String>(5)?).unwrap_or_default(),
        note: row.get(6)?,
        created_at: parse_dt(&row.get::<_, String>(7)?),
        estimated_minutes: row.get(9).unwrap_or(60),
        metadata: serde_json::from_str(&metadata).unwrap_or_else(|_| serde_json::json!({})),
    })
}

fn map_topic_node(row: &Row<'_>) -> rusqlite::Result<TopicNode> {
    let metadata: String = row.get(7)?;
    Ok(TopicNode {
        id: row.get::<_, String>(0)?.into(),
        topic_id: row.get::<_, String>(1)?.into(),
        title: row.get(2)?,
        status: TopicNodeStatus::parse(&row.get::<_, String>(3)?).unwrap_or_default(),
        position: row.get(4)?,
        note: row.get(5)?,
        created_at: parse_dt(&row.get::<_, String>(6)?),
        metadata: serde_json::from_str(&metadata).unwrap_or_else(|_| serde_json::json!({})),
    })
}

fn map_topic_edge(row: &Row<'_>) -> rusqlite::Result<TopicEdge> {
    let metadata: String = row.get(6)?;
    Ok(TopicEdge {
        id: row.get::<_, String>(0)?.into(),
        from_topic_id: row.get::<_, String>(1)?.into(),
        to_topic_id: row.get::<_, String>(2)?.into(),
        kind: TopicEdgeKind::parse(&row.get::<_, String>(3)?).unwrap_or(TopicEdgeKind::Related),
        note: row.get(4)?,
        created_at: parse_dt(&row.get::<_, String>(5)?),
        metadata: serde_json::from_str(&metadata).unwrap_or_else(|_| serde_json::json!({})),
    })
}

fn prereq_reaches(conn: &Connection, start: &str, target: &str) -> Result<bool> {
    use std::collections::{HashSet, VecDeque};
    let mut queue = VecDeque::from([start.to_string()]);
    let mut seen = HashSet::new();
    while let Some(current) = queue.pop_front() {
        if current == target {
            return Ok(true);
        }
        if !seen.insert(current.clone()) {
            continue;
        }
        let mut stmt = conn.prepare(
            "SELECT to_topic_id FROM topic_edges
             WHERE from_topic_id = ?1 AND kind = 'prerequisite'",
        )?;
        let rows = stmt.query_map(params![current], |row| row.get::<_, String>(0))?;
        for row in rows {
            queue.push_back(row?);
        }
    }
    Ok(false)
}

fn map_card(row: &Row<'_>) -> rusqlite::Result<Card> {
    Ok(Card {
        id: row.get::<_, String>(0)?.into(),
        session_id: row.get::<_, String>(1)?.into(),
        anchor: Anchor {
            message_id: row.get::<_, String>(2)?.into(),
            char_start: row.get::<_, i64>(3)? as usize,
            char_end: row.get::<_, i64>(4)? as usize,
            quote: row.get(5)?,
        },
        depth: Depth::parse(&row.get::<_, String>(6)?).unwrap_or_default(),
        question: row.get(7)?,
        answer: row.get(8)?,
        created_at: parse_dt(&row.get::<_, String>(9)?),
        promoted_session_id: row.get::<_, Option<String>>(10)?.map(SessionId::from),
    })
}

fn load_card(conn: &Connection, id: &str) -> Result<Option<Card>> {
    Ok(conn
        .query_row(
            "SELECT id, session_id, message_id, char_start, char_end, quote, depth, question,
                    answer, created_at, promoted_session_id
             FROM cards WHERE id = ?1",
            params![id],
            map_card,
        )
        .optional()?)
}

fn map_topic(row: &Row<'_>) -> rusqlite::Result<Topic> {
    let metadata: String = row.get(6)?;
    Ok(Topic {
        id: row.get::<_, String>(0)?.into(),
        title: row.get(1)?,
        summary: row.get(2)?,
        depth_goal: Depth::parse(&row.get::<_, String>(3)?).unwrap_or_default(),
        mastery: Mastery::parse(&row.get::<_, String>(4)?).unwrap_or_default(),
        created_at: parse_dt(&row.get::<_, String>(5)?),
        outline_md: row.get::<_, String>(7).unwrap_or_default(),
        metadata: serde_json::from_str(&metadata).unwrap_or_else(|_| serde_json::json!({})),
    })
}

fn load_topic(conn: &Connection, id: &str) -> Result<Option<Topic>> {
    Ok(conn
        .query_row(
            "SELECT id, title, summary, depth_goal, mastery, created_at, metadata, outline_md
             FROM topics WHERE id = ?1",
            params![id],
            map_topic,
        )
        .optional()?)
}

fn load_topic_for_session(conn: &Connection, session_id: &str) -> Result<Option<Topic>> {
    Ok(conn
        .query_row(
            "SELECT t.id, t.title, t.summary, t.depth_goal, t.mastery, t.created_at, t.metadata, t.outline_md
             FROM sessions s JOIN topics t ON t.id = s.topic_id
             WHERE s.id = ?1",
            params![session_id],
            map_topic,
        )
        .optional()?)
}

fn load_seed(conn: &Connection, session_id: &str) -> Result<Option<SessionSeed>> {
    Ok(conn
        .query_row(
            "SELECT session_id, topic_id, topic_title, source_session_id, source_title,
                    source_message_id, card_id, quote, context, answer, depth, metadata
             FROM session_seeds WHERE session_id = ?1",
            params![session_id],
            |row| {
                let metadata: String = row.get(11)?;
                Ok(SessionSeed {
                    session_id: row.get::<_, String>(0)?.into(),
                    topic_id: row.get::<_, String>(1)?.into(),
                    topic_title: row.get(2)?,
                    source_session_id: row.get::<_, String>(3)?.into(),
                    source_title: row.get(4)?,
                    source_message_id: row.get::<_, String>(5)?.into(),
                    card_id: row.get::<_, String>(6)?.into(),
                    quote: row.get(7)?,
                    context: row.get(8)?,
                    answer: row.get(9)?,
                    depth: Depth::parse(&row.get::<_, String>(10)?).unwrap_or_default(),
                    metadata: serde_json::from_str(&metadata)
                        .unwrap_or_else(|_| serde_json::json!({})),
                })
            },
        )
        .optional()?)
}

fn clean_title(text: &str) -> String {
    text.lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(60)
        .collect()
}

fn summarize(text: &str) -> String {
    let clean: String = text
        .chars()
        .filter(|ch| !matches!(ch, '#' | '*' | '`' | '>'))
        .collect();
    clean
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect()
}

fn map_entry(row: &Row<'_>) -> rusqlite::Result<GlossaryEntry> {
    let message_id: Option<String> = row.get(4)?;
    let anchor = message_id.map(|id| Anchor {
        message_id: id.into(),
        char_start: row.get::<_, Option<i64>>(5).ok().flatten().unwrap_or(0) as usize,
        char_end: row.get::<_, Option<i64>>(6).ok().flatten().unwrap_or(0) as usize,
        quote: row
            .get::<_, Option<String>>(7)
            .ok()
            .flatten()
            .unwrap_or_default(),
    });
    Ok(GlossaryEntry {
        id: row.get::<_, String>(0)?.into(),
        term: row.get(1)?,
        gist: row.get(2)?,
        depth: Depth::parse(&row.get::<_, String>(3)?).unwrap_or_default(),
        mastery: Mastery::parse(&row.get::<_, String>(9)?).unwrap_or_default(),
        source_anchor: anchor,
        session_id: row.get::<_, Option<String>>(10)?.map(SessionId::from),
        created_at: parse_dt(&row.get::<_, String>(8)?),
        updated_at: None,
    })
}

fn parse_dt(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use studydeck_core::{Anchor, Card, CardId, Course, CourseItemStatus, Depth, Message, Topic};

    #[test]
    fn promote_card_creates_topic_and_is_idempotent() {
        let path = std::env::temp_dir().join(format!(
            "studydeck-promote-{}-{}.db",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let store = Store::open(&path).expect("open store");

        let session = store.create_session().expect("session");
        let assistant = Message::assistant(&session.id, "采样率决定离散化的下界。");
        store.add_message(&assistant).expect("message");
        let anchor = Anchor::new(assistant.id.clone(), 0, 3, "采样率");
        let card = Card {
            id: CardId::new(),
            session_id: session.id.clone(),
            anchor,
            depth: Depth::CanDerive,
            question: "请解释这段内容。".into(),
            answer: "**一句话定义**：采样率是每秒样本数。".into(),
            promoted_session_id: None,
            created_at: Utc::now(),
        };
        store.add_card(&card).expect("card");

        let promotion = store
            .promote_card(
                session.id.as_str(),
                card.id.as_str(),
                Some("采样率"),
                Some(Depth::CanDerive),
                None,
                None,
            )
            .expect("promote");
        assert_eq!(promotion.topic.title, "采样率");
        assert_eq!(promotion.seed.quote, "采样率");
        assert!(promotion.seed.source_session_id.as_str() == session.id.as_str());
        assert!(store
            .topic_for_session(&promotion.session_id)
            .unwrap()
            .is_some());

        let again = store
            .promote_card(
                session.id.as_str(),
                card.id.as_str(),
                None,
                None,
                None,
                None,
            )
            .expect("idempotent promote");
        assert_eq!(again.session_id, promotion.session_id);
        assert_eq!(again.topic_id, promotion.topic_id);

        store
            .delete_session(&promotion.session_id)
            .expect("delete promoted session");
        assert!(store.topic(&promotion.topic_id).unwrap().is_none());
        let recreated = store
            .promote_card(
                session.id.as_str(),
                card.id.as_str(),
                None,
                None,
                None,
                None,
            )
            .expect("re-promote after delete");
        assert_ne!(recreated.session_id, promotion.session_id);

        drop(store);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn delete_topic_can_keep_or_delete_sessions() {
        let path = std::env::temp_dir().join(format!(
            "studydeck-delete-topic-{}-{}.db",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let store = Store::open(&path).expect("open store");

        let topic = Topic::new("采样定理", "", Depth::CanTune);
        let other = Topic::new("奈奎斯特频率", "", Depth::CanTune);
        store.create_topic(&topic).expect("topic");
        store.create_topic(&other).expect("topic other");
        let session = store
            .create_session_in_topic(topic.id.as_str())
            .expect("session");
        store
            .add_message(&Message::user(&session.id, "hello"))
            .expect("message");
        store
            .add_topic_node(topic.id.as_str(), "节点")
            .expect("node");
        store
            .add_topic_edge(
                other.id.as_str(),
                topic.id.as_str(),
                TopicEdgeKind::Prerequisite,
                "",
                None,
            )
            .expect("edge");
        let course = Course::new("课程", "");
        store.create_course(&course).expect("course");
        store
            .add_course_item(course.id.as_str(), topic.id.as_str(), None, None, None)
            .expect("course item");

        let kept = store
            .delete_topic(topic.id.as_str(), false)
            .expect("delete keep");
        assert_eq!(kept.sessions_kept, 1);
        assert!(store.get_session(session.id.as_str()).unwrap().is_some());
        assert!(store
            .topic_for_session(session.id.as_str())
            .unwrap()
            .is_none());
        assert!(store.topic(topic.id.as_str()).unwrap().is_none());
        assert!(store.course_items(course.id.as_str()).unwrap().is_empty());
        assert!(store.edges_for_topic(topic.id.as_str()).unwrap().is_empty());

        let topic2 = Topic::new("混叠", "", Depth::CanTune);
        store.create_topic(&topic2).expect("topic2");
        let session2 = store
            .create_session_in_topic(topic2.id.as_str())
            .expect("session2");
        store
            .add_message(&Message::user(&session2.id, "hello"))
            .expect("message2");
        let deleted = store
            .delete_topic(topic2.id.as_str(), true)
            .expect("delete sessions");
        assert_eq!(deleted.sessions_deleted, 1);
        assert!(store.get_session(session2.id.as_str()).unwrap().is_none());
        assert!(store.messages(session2.id.as_str()).unwrap().is_empty());

        drop(store);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn outline_parse_preserves_manual_nodes() {
        let path = std::env::temp_dir().join(format!(
            "studydeck-nodes-{}-{}.db",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let store = Store::open(&path).expect("open store");
        let topic = Topic::new("采样定理", "", Depth::CanTune);
        store.create_topic(&topic).expect("topic");
        let manual = store
            .add_topic_node(topic.id.as_str(), "手工节点")
            .expect("manual node");
        store
            .update_topic_node(
                topic.id.as_str(),
                manual.id.as_str(),
                None,
                Some(TopicNodeStatus::Done),
                None,
                None,
            )
            .expect("status");

        let nodes = store
            .replace_topic_nodes(topic.id.as_str(), &["采样率".into(), "混叠".into()])
            .expect("parse");
        assert_eq!(nodes.len(), 3);
        let manual_after = nodes
            .iter()
            .find(|node| node.title == "手工节点")
            .expect("manual kept");
        assert_eq!(manual_after.status, TopicNodeStatus::Done);
        assert!(nodes.iter().any(|node| node.title == "采样率"));

        drop(store);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn course_items_reorder_and_progress() {
        let path = std::env::temp_dir().join(format!(
            "studydeck-course-{}-{}.db",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let store = Store::open(&path).expect("open store");
        let course = Course::new("数字信号处理", "掌握采样链路");
        store.create_course(&course).expect("course");

        let a = Topic::new("采样定理", "", Depth::CanTune);
        let b = Topic::new("奈奎斯特频率", "", Depth::CanTune);
        store.create_topic(&a).expect("topic a");
        store.create_topic(&b).expect("topic b");

        let first = store
            .add_course_item(
                course.id.as_str(),
                a.id.as_str(),
                Some("2026-12-10"),
                None,
                None,
            )
            .expect("add a");
        let second = store
            .add_course_item(course.id.as_str(), b.id.as_str(), None, None, None)
            .expect("add b");
        assert_eq!(first.position, 0);
        assert_eq!(second.position, 1);

        store
            .reorder_course_items(
                course.id.as_str(),
                &[second.id.to_string(), first.id.to_string()],
            )
            .expect("reorder");
        let items = store.course_items(course.id.as_str()).expect("items");
        assert_eq!(items[0].topic_id, b.id);
        assert_eq!(items[1].topic_id, a.id);

        store
            .update_course_item(
                course.id.as_str(),
                first.id.as_str(),
                Some(""),
                Some(CourseItemStatus::Done),
                None,
                None,
                None,
            )
            .expect("update");
        let summaries = store.all_courses().expect("summaries");
        assert_eq!(summaries[0].done_count, 1);
        assert_eq!(summaries[0].next_date.as_deref(), None);

        store.delete_course(course.id.as_str()).expect("delete");
        assert!(store.course(course.id.as_str()).unwrap().is_none());

        drop(store);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn usage_totals_are_aggregated_per_session() {
        let path = std::env::temp_dir().join(format!(
            "studydeck-usage-{}-{}.db",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let store = Store::open(&path).expect("open store");
        let session = store.create_session().expect("session");
        store
            .add_turn_usage("t1", session.id.as_str(), 120, 30, 1)
            .expect("usage");
        store
            .add_turn_usage("t2", session.id.as_str(), 80, 20, 2)
            .expect("usage");
        let usage = store.session_usage(session.id.as_str()).expect("totals");
        assert_eq!(usage.prompt_tokens, 200);
        assert_eq!(usage.completion_tokens, 50);
        assert_eq!(usage.total_tokens, 250);
        assert_eq!(usage.turns, 2);
        drop(store);
        let _ = std::fs::remove_file(path);
    }
}
