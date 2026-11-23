//! 上下文装配：主线给全量历史，卡片给「坐标 + 目标深度」。
//! 这是整个项目里最值钱的 300 行。

use studydeck_core::{
    Anchor, Block, ContextAssembler, Depth, Message, Mode, Role, SessionSeed, Topic, TurnRequest,
};

use crate::context;

const MAIN_SYSTEM: &str = r#"你是学习伙伴，用中文回答，面向正在自学的人。

输出规则（严格遵守）：
1. 先给结论，再展开；不要用客套话开场。
2. 只要出现读者可能不懂的专业术语，必须列进「依赖清单」，并标注理解深度：能调（会用即可）/ 能改（知道参数与边界）/ 能推（理解原理）。
3. 正文分步，每步只使用已经建立过的概念；没有建立的，用一个短句带过并指向依赖清单。
4. 结尾给「待展开」，最多 3 条，说明为什么可以延后。
5. 不要一次灌完。目标不清楚时，先用一个反问确认，再给方案。
"#;

const CARD_CHAT_SYSTEM: &str = r#"你是卡片里的学习对话助手。用户正在就同一个概念继续追问。

直接回答当前问题，像对话一样自然：
- 不要套用固定的五段模板；
- 不要每次重复定义或复述卡片开头；
- 2–4 段以内，必要时用短列表；
- 只围绕当前问题，需要引用前文时一句话带过；
- 保持当前理解深度，不要突然展开成教科书。
"#;

const CARD_SYSTEM: &str = r#"你是「卡片」：用户在主线对话里选中了一段文字，要就地展开解释。
你的回答会显示在一张浮层卡片里，不替换主线对话。

严格按五段输出（每段标题加粗）：
**一句话定义** —— 不超过 30 字。
**在当前位置的角色** —— 它在用户当前这一步承担什么；如果拿掉它会怎样。
**需要的理解深度** —— 只说读者需要到什么程度，以及为什么。
**前置依赖（一层）** —— 只列名字，绝不继续解释。
**下一步** —— 一句话，可选给一个小问题。

规则：
- 不要复述整段主线。
- 只展开一层：出现新的前置概念时，只报名字。
- 全文控制在 260 字以内。
"#;

/// 老的完整历史不再整段发送：只保留关键线索，避免长会话每轮重复付费。
fn compact_history(messages: &[Message], max_chars: usize) -> String {
    let mut out = String::from("【较早对话已压缩，保留关键线索】\n");
    for message in messages {
        let role = match message.role {
            Role::User => "用户",
            Role::Assistant => "助教",
            Role::System => continue,
        };
        let text: String = message.text.chars().take(160).collect();
        let line = format!("{role}：{text}\n");
        if out.chars().count() + line.chars().count() > max_chars {
            break;
        }
        out.push_str(&line);
    }
    out
}

pub struct MainAssembler;
pub struct CardAssembler;

fn topic_block(topic: &Topic) -> String {
    let mut out = format!("当前会话属于专题《{}》。\n", topic.title);
    if !topic.summary.trim().is_empty() {
        out.push_str(&format!("专题摘要：{}\n", topic.summary));
    }
    out.push_str(&format!("目标深度：{}。\n", topic.depth_goal.label_cn()));
    if !topic.outline_md.trim().is_empty() {
        let outline: String = topic.outline_md.chars().take(1200).collect();
        out.push_str(&format!("已保存的学习地图：\n{outline}\n"));
    }
    out.push_str("围绕这个专题的长期目标回答；不要重复已经有定论的内容。\n");
    out
}

fn seed_block(seed: &SessionSeed, first_turn: bool, wants_map: bool) -> String {
    let mut out = String::from("本会话是从一次阅读支线升级而来的专题，不是普通闲聊。\n");
    out.push_str(&format!("专题：{}\n", seed.topic_title));
    out.push_str(&format!(
        "来源：{} 中的「{}」\n",
        seed.source_title.as_deref().unwrap_or("原会话"),
        seed.quote
    ));
    if !seed.context.trim().is_empty() {
        out.push_str(&format!("\n【起点上下文】\n{}\n", seed.context));
    }
    if !seed.answer.trim().is_empty() {
        let answer: String = seed.answer.chars().take(800).collect();
        out.push_str(&format!("\n【卡片已有解释（不要重复）】\n{answer}\n"));
    }
    out.push_str(&format!("\n目标深度：{}。\n", seed.depth.label_cn()));
    if first_turn && wants_map {
        out.push_str(
            "先给出 3–5 条学习地图：每条只写主题、与其它条目的先修关系和目标深度；不要展开正文。等用户确认后再逐条讲。\n",
        );
    } else if first_turn {
        out.push_str("先回答用户当前的问题；不要强行先给学习地图。用户明确要“学习地图”时再给。\n");
    } else {
        out.push_str("继续围绕这个专题回答，保持与学习地图一致，不要重复卡片已有解释。\n");
    }
    out
}

impl ContextAssembler for MainAssembler {
    fn assemble(&self, request: &TurnRequest) -> Vec<Block> {
        let mut system = vec![Block::system(MAIN_SYSTEM)];
        if let Some(topic) = &request.topic {
            system.push(Block::system(topic_block(topic)));
        }
        if let Some(seed) = &request.seed {
            system.push(Block::system(seed_block(
                seed,
                request.history.is_empty(),
                request.text.contains("学习地图"),
            )));
        }
        if let Some(root) = &request.project_root {
            system.push(Block::system(format!(
                "你可以只读访问本次会话的项目根目录：\n{}\n需要看代码时用 read_file / list_dir / search_text；不要读取 .env、密钥等敏感文件，也不要尝试写文件。",
                root.display()
            )));
        }

        let fixed: usize = system
            .iter()
            .map(|block| context::estimate_tokens(&block.text) + 4)
            .sum();
        // 给工具 schema、当前问题和输出留余量；历史只在剩余空间里放。
        let available = context::INPUT_TOKEN_BUDGET
            .saturating_sub(fixed)
            .saturating_sub(context::estimate_tokens(&request.text) + 4)
            .saturating_sub(1_200);
        let history = &request.history;
        let mut keep_start = history.len();
        let mut used = 0usize;
        for index in (0..history.len()).rev() {
            let message = &history[index];
            let cost = context::estimate_tokens(&message.text) + 4;
            if used + cost > available {
                break;
            }
            used += cost;
            keep_start = index;
        }

        let mut blocks = system;
        if keep_start > 0 {
            blocks.push(Block::system(compact_history(
                &history[..keep_start],
                context::HISTORY_DIGEST_CHARS,
            )));
        }
        for message in &history[keep_start..] {
            match message.role {
                Role::User => blocks.push(Block::user(message.text.clone())),
                Role::Assistant => blocks.push(Block::assistant(message.text.clone())),
                Role::System => {}
            }
        }
        blocks.push(Block::user(request.text.clone()));
        blocks
    }
}

impl ContextAssembler for CardAssembler {
    fn assemble(&self, request: &TurnRequest) -> Vec<Block> {
        let depth = request.depth.unwrap_or(Depth::CanTune);
        let follow_up = request.card_history.is_some();
        let mut system = String::from(if follow_up {
            CARD_CHAT_SYSTEM
        } else {
            CARD_SYSTEM
        });
        system.push_str("\n本张卡片的理解深度约定：");
        system.push_str(depth.directive());
        system.push('\n');

        let anchor = request.anchor.clone().unwrap_or_else(|| {
            Anchor::new(
                studydeck_core::MessageId("unknown".into()),
                0,
                0,
                request.text.clone(),
            )
        });

        let source = request
            .history
            .iter()
            .find(|message| message.id == anchor.message_id)
            .map(|message| message.text.clone())
            .unwrap_or_default();

        let window = if source.is_empty() {
            anchor.quote.clone()
        } else {
            anchor.context_window(&source, 240)
        };

        let mut user = String::new();
        user.push_str("【目标术语】\n");
        user.push_str(&anchor.quote);
        user.push_str("\n\n【它出现的位置（前后文）】\n");
        user.push_str(&window);
        user.push_str("\n\n【读者要的理解深度】");
        user.push_str(depth.label_cn());
        user.push('\n');

        if let Some(history) = &request.card_history {
            let trimmed: String = history.chars().take(3_000).collect();
            user.push_str("\n【这张卡片此前的追问与回答（继续对话，不要重复）】\n");
            user.push_str(&trimmed);
            user.push('\n');
        } else if let Some(parent) = &request.parent_card {
            user.push_str("\n【本卡片已有的解释（追问请在此基础上补充，不要重复）】\n");
            let trimmed: String = parent.answer.chars().take(500).collect();
            user.push_str(&trimmed);
            user.push('\n');
        }

        user.push_str("\n【用户的问题】\n");
        user.push_str(&request.text);

        vec![Block::system(system), Block::user(user)]
    }
}

/// 供诊断用的装配摘要（不含全文，避免日志爆量）。
pub fn describe(mode: Mode) -> &'static str {
    match mode {
        Mode::Main => "main: full history",
        Mode::Card => "card: anchor + window + depth",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use studydeck_core::{BlockRole, CardId, MessageId, SessionId, TopicId};

    fn seed() -> SessionSeed {
        SessionSeed {
            session_id: SessionId::from("child"),
            topic_id: TopicId::from("topic"),
            topic_title: "采样定理".into(),
            source_session_id: SessionId::from("parent"),
            source_title: Some("数字信号处理".into()),
            source_message_id: MessageId::from("message"),
            card_id: CardId::from("card"),
            quote: "采样率".into(),
            context: "采样率决定离散化的下界。".into(),
            answer: "采样率是每秒样本数。".into(),
            depth: Depth::CanDerive,
            metadata: serde_json::json!({}),
        }
    }

    fn request(text: &str) -> TurnRequest {
        TurnRequest {
            mode: Mode::Main,
            text: text.into(),
            anchor: None,
            depth: None,
            parent_card: None,
            card_history: None,
            topic: None,
            seed: Some(seed()),
            project_root: None,
            history: Vec::new(),
        }
    }

    #[test]
    fn seed_adds_context_and_only_forces_map_when_asked() {
        let blocks = MainAssembler.assemble(&request("生成学习地图"));
        let system: String = blocks
            .iter()
            .filter(|block| block.role == BlockRole::System)
            .map(|block| block.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(system.contains("数字信号处理"));
        assert!(system.contains("采样率"));
        assert!(system.contains("3–5 条学习地图"));

        let normal = MainAssembler.assemble(&request("这个参数怎么调？"));
        let normal_system: String = normal
            .iter()
            .filter(|block| block.role == BlockRole::System)
            .map(|block| block.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!normal_system.contains("3–5 条学习地图"));
        assert!(normal_system.contains("先回答用户当前的问题"));
    }

    #[test]
    fn card_follow_up_is_conversational_not_templated() {
        let request = TurnRequest {
            mode: Mode::Card,
            text: "为什么？".into(),
            anchor: Some(Anchor::new(MessageId::from("m1"), 0, 2, "SQL")),
            depth: Some(Depth::CanTune),
            parent_card: None,
            card_history: Some("问：为什么？\n答：因为边界条件。".into()),
            topic: None,
            seed: None,
            project_root: None,
            history: Vec::new(),
        };
        let blocks = CardAssembler.assemble(&request);
        let system = blocks
            .iter()
            .filter(|block| block.role == studydeck_core::BlockRole::System)
            .map(|block| block.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(system.contains("直接回答当前问题"));
        assert!(!system.contains("严格按五段输出"));
    }

    #[test]
    fn card_history_is_included_in_the_card_prompt() {
        let request = TurnRequest {
            mode: Mode::Card,
            text: "再展开一点".into(),
            anchor: Some(Anchor::new(MessageId::from("m1"), 0, 2, "SQL")),
            depth: Some(Depth::CanTune),
            parent_card: None,
            card_history: Some("问：为什么？\n答：因为边界条件。".into()),
            topic: None,
            seed: None,
            project_root: None,
            history: Vec::new(),
        };
        let blocks = CardAssembler.assemble(&request);
        let text: String = blocks
            .iter()
            .map(|block| block.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("这张卡片此前的追问与回答"));
        assert!(text.contains("因为边界条件"));
    }

    #[test]
    fn long_history_is_compacted_into_a_digest() {
        let mut request = request("现在继续");
        request.seed = None;
        request.history = (0..80)
            .map(|index| {
                let text = format!("第 {index} 轮：") + &"这是一段很长的历史内容。".repeat(100);
                if index % 2 == 0 {
                    Message::user(&SessionId::from("s"), text)
                } else {
                    Message::assistant(&SessionId::from("s"), text)
                }
            })
            .collect();
        let blocks = MainAssembler.assemble(&request);
        let system: String = blocks
            .iter()
            .filter(|block| block.role == BlockRole::System)
            .map(|block| block.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(system.contains("较早对话已压缩"), "old turns are compacted");
        let estimated: usize = blocks
            .iter()
            .map(|block| context::estimate_tokens(&block.text) + 4)
            .sum();
        assert!(
            estimated < context::INPUT_TOKEN_BUDGET + 2_000,
            "assembled prompt stays near budget, got {estimated}"
        );
    }

    #[test]
    fn topic_context_is_injected_without_a_seed() {
        let topic = Topic::new("采样定理", "离散化基础", Depth::CanDerive);
        let request = TurnRequest {
            mode: Mode::Main,
            text: "这个参数怎么调？".into(),
            anchor: None,
            depth: None,
            parent_card: None,
            card_history: None,
            topic: Some(topic),
            seed: None,
            project_root: None,
            history: Vec::new(),
        };
        let blocks = MainAssembler.assemble(&request);
        let system: String = blocks
            .iter()
            .filter(|block| block.role == BlockRole::System)
            .map(|block| block.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(system.contains("当前会话属于专题《采样定理》"));
        assert!(system.contains("离散化基础"));
    }
}
