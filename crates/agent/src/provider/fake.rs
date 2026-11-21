//! 演示 provider：无网络、无模型，用于在没有 API Key 时验证整条链路。

use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;
use studydeck_core::{AgentEvent, Usage};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{ChatRequest, Provider, StreamOutcome};

pub struct FakeProvider;

impl FakeProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for FakeProvider {
    fn default() -> Self {
        Self::new()
    }
}

fn fake_card() -> String {
    "**一句话定义**：采样定理描述的是「用离散样本完整还原连续信号」所需的采样率下限。\n\n\
     **在当前位置的角色**：它决定了数字链路里 ADC 采样率的下界；没有它，后面看到的「混叠」无从解释。\n\n\
     **需要的理解深度**：能改 —— 你要会判断给定带宽下采样率取多少，以及滤波器截止频率怎么放。\n\n\
     **前置依赖（一层）**：奈奎斯特频率、频谱搬移。\n\n\
     **下一步**：要不要用「4 kHz 带宽 + 8 kHz 采样」做一道判断题？"
        .to_string()
}

fn fake_main() -> String {
    "先把结论放前面：**这个方案的核心是「把连续问题离散化，再在离散域上做线性运算」**。\n\n\
     ### 依赖清单\n\n\
     | 概念 | 你需要懂到什么程度 |\n\
     |---|---|\n\
     | 采样率 | 能改（会算下界、会判断混叠） |\n\
     | 频谱 | 能调（知道它是频率的函数即可） |\n\
     | 线性时不变系统 | 能调（记住叠加性就够） |\n\n\
     ### 分步\n\
     1. 先确定信号带宽，它给出采样率的下界。\n\
     2. 采样后频谱周期延拓，相邻副本不能重叠——这就是为什么要低通滤波。\n\
     3. 重建时用一个理想低通把副本滤掉，只留基带。\n\n\
     > 表格里第二、三行是**可延后**的，你现在只需要第一个。\n\n\
     要不要我出一道题，先让你自己判断采样率够不够？"
        .to_string()
}

#[async_trait]
impl Provider for FakeProvider {
    fn name(&self) -> &'static str {
        "fake"
    }

    async fn chat_stream(
        &self,
        request: ChatRequest,
        tx: mpsc::UnboundedSender<AgentEvent>,
        cancel: CancellationToken,
    ) -> Result<StreamOutcome> {
        let card_mode = request
            .messages
            .iter()
            .any(|m| m.role == "system" && m.content.contains("卡片"));

        let body = if card_mode { fake_card() } else { fake_main() };

        if !card_mode {
            let _ = tx.send(AgentEvent::ToolCall {
                name: "clock".into(),
                args: serde_json::json!({ "timezone": "local" }),
            });
            tokio::time::sleep(Duration::from_millis(120)).await;
            let _ = tx.send(AgentEvent::ToolDone {
                name: "clock".into(),
                ok: true,
                preview: chrono::Local::now().format("%Y-%m-%d %H:%M").to_string(),
            });
        }

        let mut text = String::new();
        for chunk in chunk_text(&body, 24) {
            if cancel.is_cancelled() {
                return Ok(StreamOutcome { text, tool_calls: Vec::new(), usage: Usage::default() });
            }
            text.push_str(&chunk);
            let _ = tx.send(AgentEvent::Delta { text: chunk });
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(18)) => {}
                _ = cancel.cancelled() => {
                    return Ok(StreamOutcome { text, tool_calls: Vec::new(), usage: Usage::default() });
                }
            }
        }

        Ok(StreamOutcome {
            text,
            tool_calls: Vec::new(),
            usage: Usage { prompt_tokens: 0, completion_tokens: 0 },
        })
    }
}

fn chunk_text(text: &str, size: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    chars
        .chunks(size)
        .map(|chunk| chunk.iter().collect::<String>())
        .collect()
}
