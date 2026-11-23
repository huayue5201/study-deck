use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::{
    anchor::Anchor,
    card::{Card, Depth},
    profiles::CardProfile,
    session::Message,
    topic::{SessionSeed, Topic},
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
    /// 卡片模板；None 时退回内置 tech 范式。
    pub profile: Option<CardProfile>,
    /// 用户选的档位 id（profile 内有效）。
    pub level: Option<String>,
    /// 已经存在的卡片，用于卡片内的追问
    pub parent_card: Option<Card>,
    /// 卡片内此前的追问/回答，用于多轮卡片对话。
    pub card_history: Option<String>,
    /// 当前会话所属专题；普通会话为 None。
    pub topic: Option<Topic>,
    /// 从阅读支线升级到专题时携带的起点包；普通会话为 None。
    pub seed: Option<SessionSeed>,
    /// 本次会话所属项目根目录；存在时开放只读文件工具。
    pub project_root: Option<PathBuf>,
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
        Self {
            role: BlockRole::System,
            text: text.into(),
        }
    }
    pub fn user(text: impl Into<String>) -> Self {
        Self {
            role: BlockRole::User,
            text: text.into(),
        }
    }
    pub fn assistant(text: impl Into<String>) -> Self {
        Self {
            role: BlockRole::Assistant,
            text: text.into(),
        }
    }
}

/// 主线与卡片的差别只体现在装配策略上，不在 UI 里。
pub trait ContextAssembler: Send + Sync {
    fn assemble(&self, request: &TurnRequest) -> Vec<Block>;
}
