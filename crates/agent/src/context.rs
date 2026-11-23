//! 上下文预算：所有进入模型的文本先估算 token，再按预算裁剪。
//!
//! 这不是精确 tokenizer：中文按字、ASCII 按 4 字符/token 估算，偏保守。
//! 目的不是计费，而是保证长会话不会无限膨胀、工具结果不会撑爆上下文。

use crate::provider::ChatMessage;

/// 单次请求的输入预算（token）。给 64K/128K 模型留出足够输出空间，也避免长会话变贵。
pub const INPUT_TOKEN_BUDGET: usize = 32_000;
/// 单个工具结果最多保留的字符数，超出部分截断。
pub const TOOL_RESULT_CHARS: usize = 12_000;
/// 历史压缩摘要最多保留的字符数。
pub const HISTORY_DIGEST_CHARS: usize = 1_600;

/// 粗估 token：ASCII 约 4 字符/token，非 ASCII 约 1 字符/token，另加消息开销。
pub fn estimate_tokens(text: &str) -> usize {
    let mut ascii = 0usize;
    let mut wide = 0usize;
    for ch in text.chars() {
        if ch.is_ascii() {
            ascii += 1;
        } else {
            wide += 1;
        }
    }
    (ascii + 3) / 4 + wide + 1
}

pub fn estimate_message(message: &ChatMessage) -> usize {
    estimate_tokens(&message.content) + 4
}

pub fn estimate_messages(messages: &[ChatMessage]) -> usize {
    messages.iter().map(estimate_message).sum()
}

/// 截断工具结果，保留开头和结尾，避免模型只看到一半上下文却不知道被截断。
pub fn cap_tool_output(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let head: String = text.chars().take(max_chars * 2 / 3).collect();
    let tail: String = text
        .chars()
        .rev()
        .take(max_chars / 3)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("{head}\n\n…（工具结果过长，中间已截断）…\n\n{tail}")
}

/// 在发给 provider 前裁剪消息：
/// - 保留系统前缀（稳定的 prompt cache 前缀）
/// - 保留最后一个 user 消息及其后的工具调用链
/// - 从中间的历史里从旧到新删除，直到回到预算内
/// - 仍超预算时，截断最长的 tool 结果
pub fn fit_messages(messages: &mut Vec<ChatMessage>, max_tokens: usize) {
    let mut total = estimate_messages(messages);
    if total <= max_tokens {
        return;
    }

    let system_end = messages
        .iter()
        .position(|message| message.role != "system")
        .unwrap_or(messages.len());
    let last_user = messages
        .iter()
        .rposition(|message| message.role == "user")
        .unwrap_or(messages.len());

    if last_user > system_end {
        let mut prefix = messages[..system_end].to_vec();
        let mut middle = messages[system_end..last_user].to_vec();
        let tail = messages[last_user..].to_vec();

        while total > max_tokens && !middle.is_empty() {
            let dropped = middle.remove(0);
            total = total.saturating_sub(estimate_message(&dropped));
        }

        let mut next = Vec::with_capacity(prefix.len() + middle.len() + tail.len());
        next.append(&mut prefix);
        next.extend(middle);
        next.extend(tail);
        *messages = next;
    }

    // 工具结果通常是最长的单条消息；截断它们比丢掉整轮工具调用安全。
    while total > max_tokens {
        let Some((index, _)) = messages
            .iter()
            .enumerate()
            .filter(|(_, message)| {
                message.role == "tool" && message.content.chars().count() > 2_000
            })
            .max_by_key(|(_, message)| message.content.chars().count())
        else {
            break;
        };
        let capped = cap_tool_output(&messages[index].content, 6_000);
        total = total.saturating_sub(estimate_message(&messages[index]));
        messages[index].content = capped;
        total += estimate_message(&messages[index]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ChatMessage;

    #[test]
    fn estimator_is_monotonic_and_counts_chinese_wider_than_ascii() {
        assert!(estimate_tokens("你好") > estimate_tokens("hi"));
        assert!(estimate_tokens("a long sentence") > estimate_tokens("short"));
    }

    #[test]
    fn fit_keeps_system_and_current_user_and_drops_old_history() {
        let mut messages = vec![ChatMessage::system("system prompt")];
        for index in 0..30 {
            messages.push(ChatMessage::user(format!("old {index} ").repeat(100)));
            messages.push(ChatMessage::assistant("answer ".repeat(100)));
        }
        messages.push(ChatMessage::user("current question"));
        let before = estimate_messages(&messages);
        fit_messages(&mut messages, 2_000);
        assert!(estimate_messages(&messages) <= 2_000);
        assert!(before > estimate_messages(&messages));
        assert_eq!(messages.first().map(|m| m.role.as_str()), Some("system"));
        assert_eq!(
            messages.last().map(|m| m.content.as_str()),
            Some("current question")
        );
    }

    #[test]
    fn tool_output_is_capped_with_a_marker() {
        let text = "x".repeat(20_000);
        let capped = cap_tool_output(&text, 1_000);
        assert!(capped.chars().count() < 2_000);
        assert!(capped.contains("中间已截断"));
    }
}
