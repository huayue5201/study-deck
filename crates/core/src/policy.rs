/// 深度预算：把「要不要继续钻」从情绪决定变成规则决定。
#[derive(Debug, Clone, Copy)]
pub struct NestingPolicy {
    pub max_card_depth: u8,
    pub max_context_chars: usize,
}

impl Default for NestingPolicy {
    fn default() -> Self {
        Self { max_card_depth: 1, max_context_chars: 1200 }
    }
}

impl NestingPolicy {
    pub fn allows_child(&self, parent_depth: u8) -> bool {
        parent_depth < self.max_card_depth
    }
}
