//! SQLite 仓储：会话 / 消息 / 卡片 / 账本。
//! 结构变更走 schema_migrations，增量式、可重放。

use std::sync::Mutex;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use studydeck_core::{
    Anchor, Card, Depth, GlossaryEntry, Mastery, Message, MessageStatus, Role, Session, SessionId,
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
pub struct SessionSummary {
    pub id: String,
    pub title: Option<String>,
    pub updated_at: DateTime<Utc>,
    pub messages: usize,
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
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"), [])?;
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
            c.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages(turn_id);",
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
        Ok(Self { conn: Mutex::new(conn), has_fts })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("sqlite mutex poisoned")
    }

    // ---------- sessions ----------

    pub fn create_session(&self) -> Result<Session> {
        let session = Session::new();
        self.conn().execute(
            "INSERT INTO sessions (id, title, created_at) VALUES (?1, ?2, ?3)",
            params![session.id.as_str(), session.title, session.created_at.to_rfc3339()],
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

    /// 删会话连同它的消息、卡片、cwd 绑定。账本条目保留（那是知识，不是会话）。
    pub fn delete_session(&self, id: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute("DELETE FROM messages WHERE session_id = ?1", params![id])?;
        conn.execute("DELETE FROM cards WHERE session_id = ?1", params![id])?;
        conn.execute("DELETE FROM ask_sessions WHERE session_id = ?1", params![id])?;
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
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
        let titled = Session { title: Some(title), ..session };
        self.conn().execute(
            "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![titled.id.as_str(), titled.title, titled.created_at.to_rfc3339()],
        )?;
        self.conn().execute(
            "INSERT OR REPLACE INTO ask_sessions (cwd, session_id, updated_at) VALUES (?1, ?2, ?3)",
            params![cwd, titled.id.as_str(), titled.created_at.to_rfc3339()],
        )?;
        Ok(titled)
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

    /// 最近活跃的会话，供 UI 切换。
    pub fn recent_sessions(&self, limit: usize) -> Result<Vec<SessionSummary>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT s.id, s.title, s.created_at, COALESCE(s.updated_at, s.created_at) AS ts,
                    (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS n
             FROM sessions s ORDER BY ts DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok(SessionSummary {
                id: row.get::<_, String>(0)?.into(),
                title: row.get(1)?,
                updated_at: parse_dt(&row.get::<_, String>(3)?),
                messages: row.get::<_, i64>(4)? as usize,
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
                status: MessageStatus::parse(&row.get::<_, String>(5).unwrap_or_else(|_| "ok".into())),
                turn_id: row.get(6).ok(),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 终态：ok / error / cancelled。崩溃后靠它区分"空回答"和"失败的回答"。
    pub fn set_message_status(&self, id: &str, status: MessageStatus, text: Option<&str>) -> Result<()> {
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
            "SELECT id, session_id, message_id, char_start, char_end, quote, depth, question, answer, created_at
             FROM cards WHERE session_id = ?1 ORDER BY rowid ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
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
            })
        })?;
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
        self.conn().execute("DELETE FROM glossary WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// 合并重复条目：把 source 的结论并进 target，再删掉 source。
    pub fn merge_entries(&self, target: &str, sources: &[String]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut gist: String = tx
            .query_row("SELECT gist FROM glossary WHERE id = ?1", params![target], |row| row.get(0))
            .optional()?
            .unwrap_or_default();
        for source in sources {
            if source == target {
                continue;
            }
            let extra: Option<String> = tx
                .query_row("SELECT gist FROM glossary WHERE id = ?1", params![source], |row| row.get(0))
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
}

fn map_entry(row: &Row<'_>) -> rusqlite::Result<GlossaryEntry> {
    let message_id: Option<String> = row.get(4)?;
    let anchor = message_id.map(|id| Anchor {
        message_id: id.into(),
        char_start: row.get::<_, Option<i64>>(5).ok().flatten().unwrap_or(0) as usize,
        char_end: row.get::<_, Option<i64>>(6).ok().flatten().unwrap_or(0) as usize,
        quote: row.get::<_, Option<String>>(7).ok().flatten().unwrap_or_default(),
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
