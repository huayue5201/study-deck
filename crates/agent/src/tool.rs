//! 服务端工具：刻意保持最小，工具越多上下文越脏。

use anyhow::Result;
use serde_json::{json, Value};

use super::provider::ToolSpec;

pub fn specs() -> Vec<ToolSpec> {
    vec![ToolSpec {
        name: "clock".into(),
        description: "返回当前本地时间。用于需要「今天/现在」的语境。".into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "timezone": { "type": "string", "description": "IANA 时区名，缺省为本地时区" }
            },
            "required": []
        }),
    }]
}

pub async fn execute(name: &str, _args: &Value) -> Result<String> {
    match name {
        "clock" => Ok(chrono::Local::now()
            .format("%Y-%m-%d %H:%M:%S %:z")
            .to_string()),
        other => Ok(format!("未知工具：{other}")),
    }
}
