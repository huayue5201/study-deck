use serde::{Deserialize, Serialize};

use crate::{
    anchor::Anchor,
    card::{Card, Depth},
    session::Message,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Main,
    Card,
}

#[derive(Debug, Clone)]
pub struct TurnRequest {
    pub mode: Mode,
    pub text: String,
    pub anchor: Option<Anchor>,
    pub depth: Option<Depth>,
    /// 已经存在的卡片，用于卡片内的追问
    pub parent_card: Option<Card>,
    pub history: Vec<Message>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockRole {
    System,
    User,
    Assistant,
}

impl BlockRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            BlockRole::System => "system",
            BlockRole::User => "user",
            BlockRole::Assistant => "assistant",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Block {
    pub role: BlockRole,
    pub text: String,
}

impl Block {
    pub fn system(text: impl Into<String>) -> Self {
        Self { role: BlockRole::System, text: text.into() }
    }
    pub fn user(text: impl Into<String>) -> Self {
        Self { role: BlockRole::User, text: text.into() }
    }
    pub fn assistant(text: impl Into<String>) -> Self {
        Self { role: BlockRole::Assistant, text: text.into() }
    }
}

/// 主线与卡片的差别只体现在装配策略上，不在 UI 里。
pub trait ContextAssembler: Send + Sync {
    fn assemble(&self, request: &TurnRequest) -> Vec<Block>;
}
