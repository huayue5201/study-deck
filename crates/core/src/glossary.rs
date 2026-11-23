use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{
    anchor::Anchor,
    card::Depth,
    ids::{EntryId, SessionId},
};

/// 掌握程度：账本不只要记"是什么"，还要记"我懂了没有"。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mastery {
    Unknown,
    Learning,
    Mastered,
}

impl Mastery {
    pub fn as_str(&self) -> &'static str {
        match self {
            Mastery::Unknown => "unknown",
            Mastery::Learning => "learning",
            Mastery::Mastered => "mastered",
        }
    }

    pub fn label_cn(&self) -> &'static str {
        match self {
            Mastery::Unknown => "未标记",
            Mastery::Learning => "在学",
            Mastery::Mastered => "已掌握",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "unknown" => Some(Mastery::Unknown),
            "learning" => Some(Mastery::Learning),
            "mastered" => Some(Mastery::Mastered),
            _ => None,
        }
    }
}

impl Default for Mastery {
    fn default() -> Self {
        Mastery::Unknown
    }
}

/// 账本条目：支线探索不蒸发，下次撞见同一个词可以直接命中。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlossaryEntry {
    pub id: EntryId,
    pub term: String,
    pub gist: String,
    pub depth: Depth,
    /// 记下这一条是在哪套模板、哪一档下得到的：跨模板不互通。
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub mastery: Mastery,
    pub source_anchor: Option<Anchor>,
    /// 条目来自哪条会话：跨会话的"回到来源"需要它
    #[serde(default)]
    pub session_id: Option<SessionId>,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub updated_at: Option<DateTime<Utc>>,
    /// 这一个概念被展开过几次（每次是一个 Encounter）。
    #[serde(default)]
    pub encounter_count: u32,
    #[serde(default)]
    pub last_seen: Option<DateTime<Utc>>,
    /// 下次复习时间（间隔重复）；None = 没排期
    #[serde(default)]
    pub next_review_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub review_count: u32,
    #[serde(default)]
    pub interval_days: u32,
}

/// 一次「遇到」：在哪个上下文、用哪套模板哪一档、得到什么结论。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Encounter {
    pub id: String,
    pub entry_id: EntryId,
    pub gist: String,
    pub profile_id: Option<String>,
    pub level: Option<String>,
    pub session_id: Option<SessionId>,
    /// 若是在某张卡上展开的，记下父卡
    pub parent_card_id: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl GlossaryEntry {
    pub fn new(
        term: impl Into<String>,
        gist: impl Into<String>,
        depth: Depth,
        anchor: Option<Anchor>,
    ) -> Self {
        Self {
            id: EntryId::new(),
            term: term.into(),
            gist: gist.into(),
            depth,
            profile_id: None,
            level: None,
            mastery: Mastery::Unknown,
            source_anchor: anchor,
            session_id: None,
            created_at: Utc::now(),
            updated_at: None,
            encounter_count: 0,
            last_seen: None,
            next_review_at: None,
            review_count: 0,
            interval_days: 0,
        }
    }
}
