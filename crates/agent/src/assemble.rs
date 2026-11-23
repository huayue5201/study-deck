//! 上下文装配：主线给全量历史，卡片给「坐标 + 目标深度」。
//! 这是整个项目里最值钱的 300 行。

use studydeck_core::{
    profiles::CardProfile,
    Anchor, Block, ContextAssembler, Depth, Message, Mode, Role, SessionSeed, Topic, TurnRequest,
};

use crate::context;

const MAIN_SYSTEM: &str = r#"你是学习伙伴，用中文回答，面向正在自学的人。

先判断这一问属于哪种，再决定形状——不要所有问题都套同一个模板：

A. 范围 / 选型（"能干嘛""该不该用""A 和 B 怎么选""值不值得学"）
   不要分步，不要依赖清单。给一张 3–6 行的地图：能干什么 / 不干什么 / 和谁搭配，
   然后给一个默认推荐路径，或反问一句"你想走哪条"。

B. 理解 / 方案（"这段代码为什么…""这个功能怎么做"）
   先给结论，再按依赖分步；出现读者可能不懂的术语时，用「依赖清单」标注深度。
   每步只使用已经建立过的概念，没建立的用一句短话带过。

C. 单点问题（一个概念、一句话能答）
   直接答。不要为了凑模板加标题、加表格。

共同规则：
- 不要用客套话开场。
- 术语只在真的会出现时才列；不要为了填满「依赖清单」硬造表格。
- 需要标注深度时：能调（会用即可）/ 能改（知道参数与边界）/ 能推（理解原理）。
- 不要一次灌完。目标不清楚时，先用一个反问确认，再展开。
- 结尾的「待展开」是可选的，别硬凑。
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

/// 回答语言：界面是英文就讲英文，别让卡片和 UI 说两种话。
fn language_line(locale: Option<&str>) -> &'static str {
    match locale {
        Some("en") => "\n用英文回答（专有名词可保留原文）。\n",
        _ => "\n用中文回答。\n",
    }
}

pub struct MainAssembler;

/// 卡片装配器：范式（轴/档位/小节/系统提示词）来自模板，机制不变。
pub struct CardAssembler {
    profile: CardProfile,
}

impl CardAssembler {
    pub fn new(profile: Option<CardProfile>) -> Self {
        let profile = profile
            .filter(|candidate| candidate.is_valid())
            .unwrap_or_else(CardProfile::builtin_tech);
        Self { profile }
    }
}

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
        let profile = &self.profile;
        let level = profile.resolved_level(request.level.as_deref());

        let mut system = String::new();
        if follow_up {
            // 卡片内的追问：不复述模板小节，像对话一样答
            system.push_str(CARD_CHAT_SYSTEM);
        } else {
            system.push_str(&profile.system);
            system.push('\n');
            if !profile.sections.is_empty() {
                system.push_str("\n严格按以下小节输出（每段标题加粗）：\n");
                for (index, section) in profile.sections.iter().enumerate() {
                    system.push_str(&format!("{}. {section}\n", index + 1));
                }
            }
            system.push_str(&format!(
                "\n全文控制在 {} 字以内。只展开一层：出现新的前置概念时只报名字，绝不继续解释。\n",
                profile.max_chars
            ));
        }

        if let Some(level) = level {
            let parenthetical = if profile.axis_label.trim().is_empty() {
                String::new()
            } else {
                format!("（{}）", profile.axis_label)
            };
            system.push_str(&format!(
                "\n本次档位：{}{}\n讲解停在这里：{}\n",
                level.label,
                parenthetical,
                if level.stop.trim().is_empty() { "按该档位的常识边界收住" } else { &level.stop }
            ));
        } else {
            system.push_str("\n本张卡片的理解深度约定：");
            system.push_str(depth.directive());
            system.push('\n');
        }

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
        if level.is_none() {
            user.push_str("\n\n【读者要的理解深度】");
            user.push_str(depth.label_cn());
            user.push('\n');
        }

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

        system.push_str(language_line(request.locale.as_deref()));
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
    use studydeck_core::{
    profiles::CardProfile,BlockRole, CardId, MessageId, SessionId, TopicId};

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
            profile: None,
            level: None,
            locale: None,
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
            profile: None,
            level: None,
            locale: None,
            history: Vec::new(),
        };
        let blocks = CardAssembler::new(None).assemble(&request);
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
            profile: None,
            level: None,
            locale: None,
            history: Vec::new(),
        };
        let blocks = CardAssembler::new(None).assemble(&request);
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
            profile: None,
            level: None,
            locale: None,
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

#[cfg(test)]
mod profile_tests {
    use super::*;

    fn card_request(profile: Option<CardProfile>, level: Option<&str>) -> TurnRequest {
        TurnRequest {
            mode: Mode::Card,
            text: "这句话什么意思".into(),
            anchor: Some(Anchor::new(
                studydeck_core::MessageId("m1".into()),
                0,
                4,
                "采样率",
            )),
            depth: Some(Depth::CanTune),
            profile,
            level: level.map(|value| value.to_string()),
            locale: None,
            parent_card: None,
            card_history: None,
            topic: None,
            seed: None,
            project_root: None,
            history: vec![],
        }
    }

    #[test]
    fn card_system_follows_profile_level_and_sections() {
        let profile = CardProfile::builtin_language_en();
        let request = card_request(Some(profile), Some("register"));
        let blocks = CardAssembler::new(request.profile.clone()).assemble(&request);
        let system = &blocks.first().expect("system block").text;

        assert!(system.contains("词性与常见搭配"), "小节来自模板: {system}");
        assert!(system.contains("用得对"), "档位名来自模板: {system}");
        assert!(system.contains("语域"), "档位停止条件来自模板: {system}");
        assert!(!system.contains("能调"), "不应混入 tech 范式: {system}");
    }

    #[test]
    fn unknown_level_falls_back_to_default_level() {
        let profile = CardProfile::builtin_language_en();
        let request = card_request(Some(profile), Some("does-not-exist"));
        let blocks = CardAssembler::new(request.profile.clone()).assemble(&request);
        let system = &blocks.first().expect("system block").text;
        // 默认档是 use
        assert!(system.contains("会用"), "回落到 default_level: {system}");
    }

    #[test]
    fn english_locale_asks_for_an_english_answer() {
        let profile = CardProfile::builtin_language_en();
        let mut request = card_request(Some(profile), Some("use"));
        request.locale = Some("en".into());
        let blocks = CardAssembler::new(request.profile.clone()).assemble(&request);
        let system = &blocks.first().expect("system block").text;
        assert!(system.contains("用英文回答"), "英文界面应要求英文回答: {system}");
    }

    #[test]
    fn blank_axis_label_does_not_leave_empty_brackets() {
        let mut profile = CardProfile::builtin_language_en();
        profile.axis_label = String::new();
        let request = card_request(Some(profile), Some("use"));
        let blocks = CardAssembler::new(request.profile.clone()).assemble(&request);
        let system = &blocks.first().expect("system block").text;
        assert!(!system.contains("（）"), "空轴名不应留下空括号: {system}");
    }

    #[test]
    fn invalid_profile_falls_back_to_tech() {
        let mut broken = CardProfile::builtin_language_en();
        broken.levels.clear();
        let request = card_request(Some(broken), Some("register"));
        let blocks = CardAssembler::new(request.profile.clone()).assemble(&request);
        let system = &blocks.first().expect("system block").text;
        assert!(system.contains("前置依赖（一层）"), "空模板应回落到内置 tech: {system}");
    }
}
