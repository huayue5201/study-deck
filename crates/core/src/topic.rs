use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{
    card::Depth,
    glossary::Mastery,
    ids::{CardId, MessageId, SessionId, TopicEdgeId, TopicId, TopicNodeId},
};

fn empty_metadata() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

/// 系统化知识单元。会话围绕 Topic 展开，Topic 可以挂多个会话。
/// `metadata` 是扩展点：插件可写入自己的数据，不需要改表结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Topic {
    pub id: TopicId,
    pub title: String,
    pub summary: String,
    pub depth_goal: Depth,
    pub mastery: Mastery,
    pub created_at: DateTime<Utc>,
    /// 保存下来的学习地图（Markdown）。v1 先用文本，后续可升级为结构化节点。
    #[serde(default)]
    pub outline_md: String,
    #[serde(default = "empty_metadata")]
    pub metadata: serde_json::Value,
}

impl Topic {
    pub fn new(title: impl Into<String>, summary: impl Into<String>, depth_goal: Depth) -> Self {
        Self {
            id: TopicId::new(),
            title: title.into(),
            summary: summary.into(),
            depth_goal,
            mastery: Mastery::Unknown,
            created_at: Utc::now(),
            outline_md: String::new(),
            metadata: empty_metadata(),
        }
    }
}

/// 专题之间的关系。方向按“学习顺序”定义：
/// `from` 是先修/前置，`to` 是依赖方。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TopicEdgeKind {
    Prerequisite,
    PartOf,
    Related,
}

impl TopicEdgeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TopicEdgeKind::Prerequisite => "prerequisite",
            TopicEdgeKind::PartOf => "part_of",
            TopicEdgeKind::Related => "related",
        }
    }

    pub fn label_cn(&self) -> &'static str {
        match self {
            TopicEdgeKind::Prerequisite => "先修",
            TopicEdgeKind::PartOf => "包含",
            TopicEdgeKind::Related => "相关",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "prerequisite" => Some(TopicEdgeKind::Prerequisite),
            "part_of" => Some(TopicEdgeKind::PartOf),
            "related" => Some(TopicEdgeKind::Related),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopicEdge {
    pub id: TopicEdgeId,
    pub from_topic_id: TopicId,
    pub to_topic_id: TopicId,
    pub kind: TopicEdgeKind,
    pub note: String,
    pub created_at: DateTime<Utc>,
    #[serde(default = "empty_metadata")]
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TopicNodeStatus {
    Planned,
    Learning,
    Done,
}

impl TopicNodeStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TopicNodeStatus::Planned => "planned",
            TopicNodeStatus::Learning => "learning",
            TopicNodeStatus::Done => "done",
        }
    }

    pub fn label_cn(&self) -> &'static str {
        match self {
            TopicNodeStatus::Planned => "未开始",
            TopicNodeStatus::Learning => "在学",
            TopicNodeStatus::Done => "已完成",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "planned" => Some(TopicNodeStatus::Planned),
            "learning" => Some(TopicNodeStatus::Learning),
            "done" => Some(TopicNodeStatus::Done),
            _ => None,
        }
    }
}

impl Default for TopicNodeStatus {
    fn default() -> Self {
        TopicNodeStatus::Planned
    }
}

/// 结构化学习地图节点。Markdown 大纲是它的来源，节点是可勾选、可排序的视图。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopicNode {
    pub id: TopicNodeId,
    pub topic_id: TopicId,
    pub title: String,
    pub status: TopicNodeStatus,
    pub position: i64,
    pub note: String,
    pub created_at: DateTime<Utc>,
    #[serde(default = "empty_metadata")]
    pub metadata: serde_json::Value,
}

/// 从阅读支线展开成专题时保存的“起点包”。
/// 只带锚点附近的内容，不复制整段父会话历史。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSeed {
    pub session_id: SessionId,
    pub topic_id: TopicId,
    pub topic_title: String,
    pub source_session_id: SessionId,
    pub source_title: Option<String>,
    pub source_message_id: MessageId,
    pub card_id: CardId,
    pub quote: String,
    pub context: String,
    /// 这张卡自己的问题（ask 卡必带；解释卡可为空）
    #[serde(default)]
    pub question: String,
    pub answer: String,
    pub depth: Depth,
    #[serde(default = "empty_metadata")]
    pub metadata: serde_json::Value,
}
