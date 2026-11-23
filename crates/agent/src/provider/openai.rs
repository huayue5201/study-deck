//! OpenAI 兼容 provider：DeepSeek / OpenAI / OpenRouter / 本地推理服务都走这里。

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{json, Value};
use studydeck_core::{AgentEvent, Usage};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{ChatRequest, Provider, StreamOutcome, ToolCall};

pub struct OpenAiCompat {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    model: String,
    temperature: f32,
}

impl OpenAiCompat {
    pub fn new(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: base_url.into(),
            api_key: api_key.into(),
            model: model.into(),
            temperature: 0.4,
        }
    }

    fn endpoint(&self) -> String {
        format!("{}/chat/completions", self.base_url.trim_end_matches('/'))
    }
}

#[async_trait]
impl Provider for OpenAiCompat {
    fn name(&self) -> &'static str {
        "openai_compat"
    }

    async fn chat_stream(
        &self,
        request: ChatRequest,
        tx: mpsc::UnboundedSender<AgentEvent>,
        cancel: CancellationToken,
    ) -> Result<StreamOutcome> {
        let mut body = json!({
            "model": self.model,
            "stream": true,
            "temperature": self.temperature,
            "max_tokens": 4096,
            "messages": request.messages,
        });

        if !request.tools.is_empty() {
            let tools: Vec<Value> = request
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        }
                    })
                })
                .collect();
            body["tools"] = Value::Array(tools);
        }

        let response = self
            .client
            .post(self.endpoint())
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|err| anyhow!("connect provider: {err}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            return Err(anyhow!(
                "provider returned {status}: {}",
                detail.chars().take(400).collect::<String>()
            ));
        }

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut outcome = StreamOutcome::default();
        // (id, name, arguments) 按 index 累积
        let mut pending: Vec<(String, String, String)> = Vec::new();

        loop {
            let next = tokio::select! {
                _ = cancel.cancelled() => break,
                next = stream.next() => next,
            };
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(|err| anyhow!("read stream: {err}"))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            buffer = buffer.replace("\r\n", "\n");

            while let Some(pos) = buffer.find("\n\n") {
                let frame: String = buffer.drain(..pos + 2).collect();
                for line in frame.lines() {
                    let Some(data) = line.trim().strip_prefix("data:") else {
                        continue;
                    };
                    let data = data.trim();
                    if data.is_empty() || data == "[DONE]" {
                        continue;
                    }
                    let Ok(value) = serde_json::from_str::<Value>(data) else {
                        continue;
                    };

                    if let Some(usage) = value.get("usage") {
                        outcome.usage = Usage {
                            prompt_tokens: usage["prompt_tokens"].as_u64().unwrap_or(0) as u32,
                            completion_tokens: usage["completion_tokens"].as_u64().unwrap_or(0)
                                as u32,
                        };
                    }

                    let Some(choice) = value["choices"].get(0) else {
                        continue;
                    };

                    if let Some(content) = choice["delta"]["content"].as_str() {
                        if !content.is_empty() {
                            outcome.text.push_str(content);
                            let _ = tx.send(AgentEvent::Delta {
                                text: content.to_string(),
                            });
                        }
                    }

                    if let Some(calls) = choice["delta"]["tool_calls"].as_array() {
                        for call in calls {
                            let index = call["index"].as_u64().unwrap_or(0) as usize;
                            while pending.len() <= index {
                                pending.push((String::new(), String::new(), String::new()));
                            }
                            if let Some(id) = call["id"].as_str() {
                                if !id.is_empty() {
                                    pending[index].0 = id.to_string();
                                }
                            }
                            if let Some(name) = call["function"]["name"].as_str() {
                                if !name.is_empty() {
                                    pending[index].1.push_str(name);
                                }
                            }
                            if let Some(args) = call["function"]["arguments"].as_str() {
                                pending[index].2.push_str(args);
                            }
                        }
                    }
                }
            }
        }

        for (index, (id, name, args)) in pending.into_iter().enumerate() {
            if name.is_empty() {
                continue;
            }
            outcome.tool_calls.push(ToolCall {
                id: if id.is_empty() {
                    format!("call_{index}")
                } else {
                    id
                },
                name,
                arguments: serde_json::from_str(&args).unwrap_or(Value::Null),
            });
        }

        Ok(outcome)
    }
}
