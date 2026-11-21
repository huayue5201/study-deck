use serde::{Deserialize, Serialize};

/// 前后端唯一契约：UI 只认这个枚举，不认任何 provider 的原始格式。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// 一轮的开始：turn_id 是这一轮的身份，session_id 让外部调用方知道它落在哪条会话里。
    /// 永远第一条，客户端据此拿到后续 ?since= 续传所需的坐标。
    TurnStarted { turn_id: String, session_id: String },
    /// 主线模式：告诉前端正在流式写入的那条 assistant 消息 id
    AssistantStart { message_id: String },
    Delta { text: String },
    ToolCall { name: String, args: serde_json::Value },
    ToolDone { name: String, ok: bool, preview: String },
    Done { usage: Usage },
    Error { message: String },
    /// 被用户/客户端取消：和 Error 区分开，否则分不清"失败"和"我停了"
    Cancelled { reason: String },
    /// 永远最后一条，前端收到后关闭流
    End,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

impl AgentEvent {
    pub fn delta(text: impl Into<String>) -> Self {
        AgentEvent::Delta { text: text.into() }
    }
}
