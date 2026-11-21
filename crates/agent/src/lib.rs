//! agent 运行时：唯一允许碰网络与子进程的领域 crate。

pub mod assemble;
pub mod engine;
pub mod provider;
pub mod tool;

pub use engine::run_turn;
pub use provider::{ChatMessage, ChatRequest, Provider, StreamOutcome, ToolCall};
