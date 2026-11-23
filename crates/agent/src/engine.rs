//! 工具调用循环。刻意保持薄：真正的复杂度在装配与 UI 状态，不在这里。

use anyhow::Result;
use studydeck_core::{AgentEvent, ContextAssembler, Mode, TurnRequest, Usage};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    assemble::{CardAssembler, MainAssembler},
    context,
    provider::{ChatMessage, ChatRequest, FunctionCall, Provider, ToolCallPayload},
    tool,
};

#[derive(Debug, Default)]
pub struct TurnOutcome {
    pub text: String,
    pub usage: Usage,
    pub rounds: usize,
    pub cancelled: bool,
}

pub async fn run_turn(
    provider: &dyn Provider,
    request: &TurnRequest,
    tx: &mpsc::UnboundedSender<AgentEvent>,
    cancel: CancellationToken,
) -> Result<TurnOutcome> {
    let assembler: Box<dyn ContextAssembler> = match request.mode {
        Mode::Main => Box::new(MainAssembler),
        Mode::Card => Box::new(CardAssembler::new(request.profile.clone())),
    };

    let mut messages: Vec<ChatMessage> = assembler
        .assemble(request)
        .into_iter()
        .map(|block| match block.role {
            studydeck_core::BlockRole::System => ChatMessage::system(block.text),
            studydeck_core::BlockRole::User => ChatMessage::user(block.text),
            studydeck_core::BlockRole::Assistant => ChatMessage::assistant(block.text),
        })
        .collect();

    let tool_ctx = tool::ToolContext::new(request.project_root.clone());
    let specs = tool::specs(tool_ctx.enabled());
    let mut outcome = TurnOutcome::default();

    for round in 0..4 {
        if cancel.is_cancelled() {
            outcome.cancelled = true;
            break;
        }
        outcome.rounds = round + 1;

        context::fit_messages(&mut messages, context::INPUT_TOKEN_BUDGET);
        let streamed = tokio::select! {
            _ = cancel.cancelled() => {
                outcome.cancelled = true;
                break;
            }
            result = provider.chat_stream(
                ChatRequest { messages: messages.clone(), tools: specs.clone() },
                tx.clone(),
                cancel.clone(),
            ) => result?,
        };

        if cancel.is_cancelled() {
            outcome.cancelled = true;
            break;
        }

        outcome.usage.prompt_tokens += streamed.usage.prompt_tokens;
        outcome.usage.completion_tokens += streamed.usage.completion_tokens;
        outcome.text.push_str(&streamed.text);

        if streamed.tool_calls.is_empty() {
            break;
        }

        // 把 assistant 的工具调用意图写回历史，再补上工具结果
        messages.push(ChatMessage {
            role: "assistant".into(),
            content: streamed.text.clone(),
            tool_call_id: None,
            tool_calls: Some(
                streamed
                    .tool_calls
                    .iter()
                    .map(|call| ToolCallPayload {
                        id: call.id.clone(),
                        kind: "function".into(),
                        function: FunctionCall {
                            name: call.name.clone(),
                            arguments: call.arguments.to_string(),
                        },
                    })
                    .collect(),
            ),
        });

        for call in &streamed.tool_calls {
            let _ = tx.send(AgentEvent::ToolCall {
                name: call.name.clone(),
                args: call.arguments.clone(),
            });

            let (ok, result) = match tool::execute(&call.name, &call.arguments, &tool_ctx).await {
                Ok(value) => (true, value),
                Err(err) => (false, format!("工具执行失败：{err}")),
            };
            let result = context::cap_tool_output(&result, context::TOOL_RESULT_CHARS);

            let _ = tx.send(AgentEvent::ToolDone {
                name: call.name.clone(),
                ok,
                preview: result.chars().take(200).collect(),
            });
            messages.push(ChatMessage::tool(call.id.clone(), result));
        }
    }

    if outcome.cancelled {
        let _ = tx.send(AgentEvent::Done {
            usage: outcome.usage,
        });
        return Ok(outcome);
    }

    let _ = tx.send(AgentEvent::Done {
        usage: outcome.usage,
    });
    Ok(outcome)
}
