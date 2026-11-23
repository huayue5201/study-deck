use serde::{Deserialize, Serialize};

use crate::ids::MessageId;

/// 锚点：逻辑位置（字符区间）+ 原文快照。
/// 绝不存像素坐标——滚动、缩放、字体变化后仍然可以还原。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Anchor {
    pub message_id: MessageId,
    pub char_start: usize,
    pub char_end: usize,
    pub quote: String,
}

impl Anchor {
    pub fn new(
        message_id: MessageId,
        char_start: usize,
        char_end: usize,
        quote: impl Into<String>,
    ) -> Self {
        let (char_start, char_end) = if char_start <= char_end {
            (char_start, char_end)
        } else {
            (char_end, char_start)
        };
        Self {
            message_id,
            char_start,
            char_end,
            quote: quote.into(),
        }
    }

    /// 按源文本把区间夹到合法范围并落在 char 边界上。
    pub fn normalized(&self, source: &str) -> Self {
        let mut start = self.char_start.min(source.chars().count());
        let mut end = self.char_end.min(source.chars().count());
        if start > end {
            std::mem::swap(&mut start, &mut end);
        }
        let quote: String = source
            .chars()
            .skip(start)
            .take(end.saturating_sub(start))
            .collect();
        Self {
            message_id: self.message_id.clone(),
            char_start: start,
            char_end: end,
            quote: if quote.trim().is_empty() {
                self.quote.clone()
            } else {
                quote
            },
        }
    }

    /// 在源文本里定位锚点：先用字符区间，切片对不上再退回子串搜索。
    /// 前端给的是「渲染后文本」的偏移，而源文本是 Markdown，两者可能错位。
    pub fn locate(&self, source: &str) -> Option<(usize, usize)> {
        let chars: Vec<char> = source.chars().collect();
        let start = self.char_start.min(chars.len());
        let end = self.char_end.min(chars.len());
        let slice: String = chars[start..end].iter().collect();
        let quote = self.quote.trim();
        if quote.is_empty() || slice.trim() == quote {
            return Some((start, end.max(start)));
        }
        let position = source.find(quote)?;
        let char_start = source[..position].chars().count();
        Some((char_start, char_start + quote.chars().count()))
    }

    /// 锚点前后各取 `radius` 个字符，供卡片装配上下文用。
    pub fn context_window(&self, source: &str, radius: usize) -> String {
        let chars: Vec<char> = source.chars().collect();
        let (start, end) = self.locate(source).unwrap_or((
            self.char_start.min(chars.len()),
            self.char_end.min(chars.len()),
        ));
        let from = start.saturating_sub(radius);
        let to = (end + radius).min(chars.len());
        if from >= to {
            return String::new();
        }
        chars[from..to].iter().collect()
    }

    pub fn is_empty(&self) -> bool {
        self.quote.trim().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg() -> MessageId {
        MessageId("m1".into())
    }

    #[test]
    fn normalize_clamps_and_extracts_quote() {
        let a = Anchor::new(msg(), 2, 99, "x");
        let normalized = a.normalized("abcdef");
        assert_eq!(normalized.char_start, 2);
        assert_eq!(normalized.char_end, 6);
        assert_eq!(normalized.quote, "cdef");
    }

    #[test]
    fn normalize_swaps_reversed_range() {
        let a = Anchor::new(msg(), 4, 2, "");
        let normalized = a.normalized("abcdef");
        assert_eq!(normalized.char_start, 2);
        assert_eq!(normalized.char_end, 4);
        assert_eq!(normalized.quote, "cd");
    }

    #[test]
    fn context_window_is_clamped() {
        let a = Anchor::new(msg(), 3, 4, "d");
        assert_eq!(a.context_window("abcdefgh", 2), "bcdef");
    }
}
