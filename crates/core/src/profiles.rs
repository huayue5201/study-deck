//! 卡片模板（profile）：一套「怎么拆解一个问题」的配置。
//!
//! 核心机制（锚定 / 叠加 / 单层 / 回流）不在这里——这里只描述可替换的**范式**：
//! 轴叫什么、分几档、每档讲到哪停、卡片按哪些小节输出、用哪段系统提示词。

use serde::{Deserialize, Serialize};

/// 一个档位。`stop` 是这一档的**停止条件**：讲到满足它为止，多讲就是噪音。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardLevel {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub stop: String,
}

/// 一套卡片模板。档位数量由用户决定（2–9 档都可以）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardProfile {
    /// 更新请求里可以不带 id（从路径取），所以给个默认值。
    #[serde(default)]
    pub id: String,
    pub label: String,
    /// 轴的名字：「理解深度」「你要拿它做什么」「参与层次」……
    #[serde(default)]
    pub axis_label: String,
    #[serde(default)]
    pub default_level: String,
    #[serde(default = "default_max_chars")]
    pub max_chars: usize,
    /// 卡片按这些小节输出（可为空 = 自由格式）
    #[serde(default)]
    pub sections: Vec<String>,
    pub levels: Vec<CardLevel>,
    #[serde(default)]
    pub system: String,
}

fn default_max_chars() -> usize {
    260
}

fn uuid_like() -> String {
    // 避免为一个小工具引入依赖：时间 + 进程内计数足够区分
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{nanos:09x}")
}

impl CardProfile {
    pub fn level(&self, id: &str) -> Option<&CardLevel> {
        self.levels.iter().find(|level| level.id == id)
    }

    /// 请求里带的档位优先；无效或缺失时退回模板默认档，再退回第一档。
    pub fn resolved_level(&self, requested: Option<&str>) -> Option<&CardLevel> {
        requested
            .and_then(|id| self.level(id))
            .or_else(|| self.level(&self.default_level))
            .or_else(|| self.levels.first())
    }

    pub fn is_valid(&self) -> bool {
        !self.levels.is_empty() && self.levels.len() <= 9
    }

    /// 从 label 造一个稳定的 id（新建模板时用）。
    pub fn slug(label: &str) -> String {
        let mut out = String::new();
        for ch in label.chars() {
            if ch.is_ascii_alphanumeric() {
                out.push(ch.to_ascii_lowercase());
            } else if ch.is_whitespace() || ch == '-' || ch == '_' || ch == '/' {
                if !out.ends_with('-') {
                    out.push('-');
                }
            }
        }
        let trimmed = out.trim_matches('-').to_string();
        if trimmed.is_empty() {
            // 纯中文等无法 ASCII 化的名字：给个短随机后缀，别让所有模板都叫 profile
            format!("p-{}", &uuid_like()[..6])
        } else {
            trimmed
        }
    }

    /// 内置：编程 / 技术（就是原来那套「能调 / 能改 / 能推」）。
    pub fn builtin_tech() -> Self {
        Self {
            id: "tech".into(),
            label: "编程 / 技术".into(),
            axis_label: "理解深度".into(),
            default_level: "can_tune".into(),
            max_chars: 260,
            sections: vec![
                "一句话定义".into(),
                "在当前位置的角色".into(),
                "需要的理解深度".into(),
                "前置依赖（一层）".into(),
                "下一步".into(),
            ],
            levels: vec![
                CardLevel {
                    id: "can_use".into(),
                    label: "能调".into(),
                    stop: "读者只需要「会用」：一句话定义 + 它在当前方案里的角色 + 一个最小用法。不讲实现原理，不展开前置概念。".into(),
                },
                CardLevel {
                    id: "can_tune".into(),
                    label: "能改".into(),
                    stop: "读者需要「能改」：讲清关键参数、边界条件和常见误用，说明改动它牵动什么。不推导公式、不做证明。".into(),
                },
                CardLevel {
                    id: "can_derive".into(),
                    label: "能推".into(),
                    stop: "读者需要「能推」：给出核心机制的推导骨架，说明它为什么成立，并指出哪些前置概念必需。".into(),
                },
            ],
            system: "你是「卡片」：用户在主线对话里选中了一段文字，要就地展开解释。回答显示在一张浮层卡片里，不替换主线对话。".into(),
        }
    }

    /// 内置：英语（按「产出能力 + 语域」拆，而不是按难度）。
    pub fn builtin_language_en() -> Self {
        Self {
            id: "language-en".into(),
            label: "英语".into(),
            axis_label: "你要拿它做什么".into(),
            default_level: "use".into(),
            max_chars: 320,
            sections: vec![
                "此语境释义".into(),
                "词性与常见搭配".into(),
                "例句".into(),
                "易混 / 语域".into(),
                "下一步".into(),
            ],
            levels: vec![
                CardLevel {
                    id: "recognize".into(),
                    label: "认得".into(),
                    stop: "只需读到时不卡住：给此语境的一句话释义 + 一个例句。不给词源、不列多个义项、不辨析近义词。".into(),
                },
                CardLevel {
                    id: "use".into(),
                    label: "会用".into(),
                    stop: "要能自己造句：给词性、2–3 个高频搭配、一个自然例句（可给中文对照）。不展开语域细节。".into(),
                },
                CardLevel {
                    id: "register".into(),
                    label: "用得对".into(),
                    stop: "要说得体：给语域（正式/口语/冒犯）、易混词差异、常见误用，必要时指出搭配限制。".into(),
                },
            ],
            system: "你是英语学习卡片：解释用户选中的词或短语在**这句话里**的意思与用法。回答显示在浮层卡片里，不替换主线对话。".into(),
        }
    }

    pub fn builtins() -> Vec<Self> {
        vec![Self::builtin_tech(), Self::builtin_language_en()]
    }
}
