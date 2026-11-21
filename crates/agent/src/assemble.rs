//! 上下文装配：主线给全量历史，卡片给「坐标 + 目标深度」。
//! 这是整个项目里最值钱的 300 行。

use studydeck_core::{Anchor, Block, ContextAssembler, Depth, Mode, Role, TurnRequest};

const MAIN_SYSTEM: &str = r#"你是学习伙伴，用中文回答，面向正在自学的人。

输出规则（严格遵守）：
1. 先给结论，再展开；不要用客套话开场。
2. 只要出现读者可能不懂的专业术语，必须列进「依赖清单」，并标注理解深度：能调（会用即可）/ 能改（知道参数与边界）/ 能推（理解原理）。
3. 正文分步，每步只使用已经建立过的概念；没有建立的，用一个短句带过并指向依赖清单。
4. 结尾给「待展开」，最多 3 条，说明为什么可以延后。
5. 不要一次灌完。目标不清楚时，先用一个反问确认，再给方案。
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

pub struct MainAssembler;
pub struct CardAssembler;

impl ContextAssembler for MainAssembler {
    fn assemble(&self, request: &TurnRequest) -> Vec<Block> {
        let mut blocks = vec![Block::system(MAIN_SYSTEM)];
        for message in &request.history {
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
        let mut system = String::from(CARD_SYSTEM);
        system.push_str("\n本张卡片的理解深度约定：");
        system.push_str(depth.directive());
        system.push('\n');

        let anchor = request.anchor.clone().unwrap_or_else(|| {
            Anchor::new(studydeck_core::MessageId("unknown".into()), 0, 0, request.text.clone())
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

        if let Some(parent) = &request.parent_card {
            user.push_str("\n【本卡片已有的解释（追问请在此基础上补充，不要重复）】\n");
            let trimmed: String = parent.answer.chars().take(600).collect();
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
