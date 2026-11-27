use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ids::{MessageId, SessionId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    System,
}

impl Role {
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::System => "system",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "user" => Role::User,
            "assistant" => Role::Assistant,
            _ => Role::System,
        }
    }
}

/// 一条消息的生命周期：running 只在流式期间成立。
/// 落库而不是只放内存，是为了崩溃/强退后还能区分"空的回答"和"失败的回答"。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageStatus {
    Running,
    Ok,
    Error,
    Cancelled,
}

impl MessageStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            MessageStatus::Running => "running",
            MessageStatus::Ok => "ok",
            MessageStatus::Error => "error",
            MessageStatus::Cancelled => "cancelled",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "running" => MessageStatus::Running,
            "error" => MessageStatus::Error,
            "cancelled" => MessageStatus::Cancelled,
            _ => MessageStatus::Ok,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: MessageId,
    pub session_id: SessionId,
    pub role: Role,
    pub text: String,
    pub created_at: DateTime<Utc>,
    #[serde(default = "default_status")]
    pub status: MessageStatus,
    #[serde(default)]
    pub turn_id: Option<String>,
}

fn default_status() -> MessageStatus {
    MessageStatus::Ok
}

impl Message {
    pub fn user(session_id: &SessionId, text: impl Into<String>) -> Self {
        Self {
            id: MessageId::new(),
            session_id: session_id.clone(),
            role: Role::User,
            text: text.into(),
            created_at: Utc::now(),
            status: MessageStatus::Ok,
            turn_id: None,
        }
    }

    pub fn assistant(session_id: &SessionId, text: impl Into<String>) -> Self {
        Self {
            id: MessageId::new(),
            session_id: session_id.clone(),
            role: Role::Assistant,
            text: text.into(),
            created_at: Utc::now(),
            status: MessageStatus::Running,
            turn_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: SessionId,
    pub title: Option<String>,
    /// 本会话使用的卡片模板；为空时回落到全局默认模板。
    #[serde(default)]
    pub profile_id: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl Session {
    pub fn new() -> Self {
        Self {
            id: SessionId::new(),
            title: None,
            profile_id: None,
            created_at: Utc::now(),
        }
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}
