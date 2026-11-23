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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    pub id: CardId,
    pub session_id: SessionId,
    pub anchor: Anchor,
    pub depth: Depth,
    /// 生成这张卡片用的模板；老数据为 None（按内置 tech 处理）。
    #[serde(default)]
    pub profile_id: Option<String>,
    /// 用户当时选的档位 id；老数据为 None（按 depth 映射）。
    #[serde(default)]
    pub level: Option<String>,
    pub question: String,
    pub answer: String,
    /// 这张卡片升级成的专题会话；None 表示还没升级。
    #[serde(default)]
    pub promoted_session_id: Option<SessionId>,
    pub created_at: DateTime<Utc>,
}
