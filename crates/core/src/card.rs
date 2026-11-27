use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{
    anchor::Anchor,
    ids::{CardId, SessionId},
};

/// 理解深度契约：不是所有术语都要懂到一样深。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Depth {
    #[serde(rename = "can_use")]
    CanUse,
    #[serde(rename = "can_tune")]
    CanTune,
    #[serde(rename = "can_derive")]
    CanDerive,
}

impl Depth {
    pub fn as_str(&self) -> &'static str {
        match self {
            Depth::CanUse => "can_use",
            Depth::CanTune => "can_tune",
            Depth::CanDerive => "can_derive",
        }
    }

    pub fn label_cn(&self) -> &'static str {
        match self {
            Depth::CanUse => "能调",
            Depth::CanTune => "能改",
            Depth::CanDerive => "能推",
        }
    }

    /// 注入 prompt 的深度指令，控制解释的终止条件。
    pub fn directive(&self) -> &'static str {
        match self {
            Depth::CanUse => {
                "读者只需要「会用」：给一句话定义 + 它在当前方案里承担什么角色 + 一个最小用法。不要讲实现原理、不要展开前置概念。"
            }
            Depth::CanTune => {
                "读者需要「能改」：讲清楚关键参数、边界条件和常见误用，说明改动它会牵动什么。不要推导公式或证明。"
            }
            Depth::CanDerive => {
                "读者需要「能推」：给出核心机制的推导骨架，说明它为什么成立，并指出哪些前置概念是必需的。"
            }
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "can_use" => Some(Depth::CanUse),
            "can_tune" => Some(Depth::CanTune),
            "can_derive" => Some(Depth::CanDerive),
            _ => None,
        }
    }
}

impl Default for Depth {
    fn default() -> Self {
        Depth::CanTune
    }
}

/// 卡片类型：模板解释 vs 用户手动提问（不套模板）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CardKind {
    Explain,
    Ask,
}

impl CardKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            CardKind::Explain => "explain",
            CardKind::Ask => "ask",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "explain" => Some(CardKind::Explain),
            "ask" => Some(CardKind::Ask),
            _ => None,
        }
    }
}

impl Default for CardKind {
    fn default() -> Self {
        CardKind::Explain
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    pub id: CardId,
    pub session_id: SessionId,
    pub anchor: Anchor,
    pub depth: Depth,
    /// 解释卡 / 手动问答卡；老数据按 explain 处理。
    #[serde(default)]
    pub kind: CardKind,
    /// 生成这张卡片用的模板；老数据为 None（按内置 tech 处理）。
    #[serde(default)]
    pub profile_id: Option<String>,
    /// 用户当时选的档位 id；老数据为 None（按 depth 映射）。
    #[serde(default)]
    pub level: Option<String>,
    pub question: String,
    pub answer: String,
    /// 这张卡片展开成的专题会话；None 表示还没展开。
    #[serde(default)]
    pub promoted_session_id: Option<SessionId>,
    /// 这张卡是在哪张卡的文字上展开的；None = 直接从主线消息展开。
    #[serde(default)]
    pub parent_card_id: Option<CardId>,
    /// 栈深：从主线展开的卡 = 0。
    #[serde(default)]
    pub stack_depth: u32,
    pub created_at: DateTime<Utc>,
}

/// 卡片线程里的一轮发言。追问不再拼进 answer 字符串，而是独立成行。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnRole {
    User,
    Assistant,
}

impl TurnRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            TurnRole::User => "user",
            TurnRole::Assistant => "assistant",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "user" => Some(TurnRole::User),
            "assistant" => Some(TurnRole::Assistant),
            _ => None,
        }
    }
}

/// 一轮的状态：写到一半 / 正常结束 / 出错 / 被取消。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnStatus {
    Streaming,
    Done,
    Error,
    Aborted,
}

impl TurnStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TurnStatus::Streaming => "streaming",
            TurnStatus::Done => "done",
            TurnStatus::Error => "error",
            TurnStatus::Aborted => "aborted",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "streaming" => Some(TurnStatus::Streaming),
            "done" => Some(TurnStatus::Done),
            "error" => Some(TurnStatus::Error),
            "aborted" => Some(TurnStatus::Aborted),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardTurn {
    pub id: String,
    pub card_id: CardId,
    pub seq: u32,
    pub role: TurnRole,
    pub text: String,
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
    pub status: TurnStatus,
    pub created_at: DateTime<Utc>,
}
