//! 纯领域模型：无 I/O、无 async、无 UI 依赖。
//! 依赖方向：apps/* -> agent -> core，store 实现 core 的仓储语义。

pub mod anchor;
pub mod card;
pub mod context;
pub mod event;
pub mod glossary;
pub mod ids;
pub mod policy;
pub mod session;

pub use anchor::Anchor;
pub use card::{Card, Depth};
pub use context::{Block, BlockRole, ContextAssembler, Mode, TurnRequest};
pub use event::{AgentEvent, Usage};
pub use glossary::{GlossaryEntry, Mastery};
pub use ids::{CardId, EntryId, MessageId, SessionId};
pub use policy::NestingPolicy;
pub use session::{Message, MessageStatus, Role, Session};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid anchor: {0}")]
    InvalidAnchor(String),
    #[error("invalid depth: {0}")]
    InvalidDepth(String),
}
