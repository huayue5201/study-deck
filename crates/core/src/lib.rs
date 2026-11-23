//! 纯领域模型：无 I/O、无 async、无 UI 依赖。
//! 依赖方向：apps/* -> agent -> core，store 实现 core 的仓储语义。

pub mod anchor;
pub mod card;
pub mod context;
pub mod course;
pub mod event;
pub mod glossary;
pub mod ids;
pub mod policy;
pub mod profiles;
pub mod session;
pub mod topic;

pub use anchor::Anchor;
pub use card::{Card, Depth};
pub use context::{Block, BlockRole, ContextAssembler, Mode, TurnRequest};
pub use course::{Course, CourseItem, CourseItemStatus};
pub use event::{AgentEvent, Usage};
pub use glossary::{GlossaryEntry, Mastery};
pub use ids::{
    CardId, CourseId, CourseItemId, EntryId, MessageId, SessionId, TopicEdgeId, TopicId,
    TopicNodeId,
};
pub use policy::NestingPolicy;
pub use profiles::{CardLevel, CardProfile};
pub use session::{Message, MessageStatus, Role, Session};
pub use topic::{SessionSeed, Topic, TopicEdge, TopicEdgeKind, TopicNode, TopicNodeStatus};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid anchor: {0}")]
    InvalidAnchor(String),
    #[error("invalid depth: {0}")]
    InvalidDepth(String),
}
