//! 服务端工具：默认只有 clock；当会话绑定项目根目录时，开放只读文件工具。
//!
//! 文件工具只允许在本次会话的 project root 内工作。所有路径先 canonicalize，
//! 再检查仍在 root 下，避免 `..` 和 symlink 逃逸。

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use super::provider::ToolSpec;

const MAX_READ_BYTES: u64 = 512 * 1024;
const MAX_READ_LINES: usize = 400;
const MAX_LIST_ENTRIES: usize = 200;
const MAX_SEARCH_FILES: usize = 2000;
const MAX_SEARCH_BYTES: u64 = 256 * 1024;
const MAX_SEARCH_HITS: usize = 50;
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
];

#[derive(Debug, Clone, Default)]
pub struct ToolContext {
    root: Option<PathBuf>,
}

impl ToolContext {
    /// `root` 必须存在、是目录，并且不能是 `/` 或用户 home 根目录。
    pub fn new(root: Option<PathBuf>) -> Self {
        let root = root.and_then(|path| {
            let path = path.canonicalize().ok()?;
            if !path.is_dir() || path == Path::new("/") {
                return None;
            }
            if let Ok(home) = std::env::var("HOME") {
                if path == Path::new(&home) {
                    return None;
                }
            }
            Some(path)
        });
        Self { root }
    }

    pub fn enabled(&self) -> bool {
        self.root.is_some()
    }

    fn root(&self) -> Result<&Path> {
        self.root.as_deref().context("当前会话没有绑定项目根目录")
    }

    fn resolve(&self, value: &str) -> Result<PathBuf> {
        let root = self.root()?;
        let candidate = Path::new(value);
        let joined = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            root.join(candidate)
        };
        let path = joined
            .canonicalize()
            .with_context(|| format!("路径不存在或无法访问：{value}"))?;
        if !path.starts_with(root) {
            bail!("路径超出项目根目录：{value}");
        }
        if is_sensitive(&path, root) {
            bail!("拒绝读取敏感文件：{value}");
        }
        Ok(path)
    }

    fn relative(&self, path: &Path) -> String {
        path.strip_prefix(self.root().unwrap_or(Path::new("/")))
            .unwrap_or(path)
            .display()
            .to_string()
    }
}

fn is_sensitive(path: &Path, root: &Path) -> bool {
    let relative = path.strip_prefix(root).unwrap_or(path);
    for component in relative.components() {
        let name = component.as_os_str().to_string_lossy().to_lowercase();
        if matches!(
            name.as_str(),
            ".env"
                | ".ssh"
                | ".aws"
                | ".gnupg"
                | "secret.key"
                | "id_rsa"
                | "id_ed25519"
                | "credentials"
                | ".npmrc"
                | ".pypirc"
                | "secrets.json"
        ) {
            return true;
        }
        if name.starts_with(".env.") {
            return true;
        }
    }
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str(),
        "pem" | "key" | "p12" | "pfx"
    )
}

fn is_skipped_dir(name: &str) -> bool {
    SKIP_DIRS.iter().any(|dir| name.eq_ignore_ascii_case(dir))
}

fn line_arg(args: &Value, key: &str, default: usize, max: usize) -> usize {
    args.get(key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(default)
        .clamp(1, max)
}

pub fn specs(file_tools: bool) -> Vec<ToolSpec> {
    let mut out = vec![ToolSpec {
        name: "clock".into(),
        description: "返回当前本地时间。用于需要「今天/现在」的语境。".into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "timezone": { "type": "string", "description": "IANA 时区名，缺省为本地时区" }
            },
            "required": []
        }),
    }];
    if file_tools {
        out.push(ToolSpec {
            name: "read_file".into(),
            description: "只读读取项目内文本文件，返回带行号的内容。路径相对于项目根目录。".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "项目内路径，如 src/main.rs" },
                    "start_line": { "type": "integer", "description": "起始行，从 1 开始" },
                    "max_lines": { "type": "integer", "description": "最多读取行数，默认 200" }
                },
                "required": ["path"]
            }),
        });
        out.push(ToolSpec {
            name: "list_dir".into(),
            description: "列出项目内某个目录的一层内容；不递归。".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "相对项目根目录，默认 ." }
                },
                "required": []
            }),
        });
        out.push(ToolSpec {
            name: "search_text".into(),
            description: "在项目内只读搜索文本，返回 path:line 命中。适用于找定义、调用点。".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "要搜索的文本" },
                    "glob": { "type": "string", "description": "可选文件名过滤，如 .rs 或 *.ts" },
                    "max_results": { "type": "integer", "description": "最多命中数，默认 50" }
                },
                "required": ["query"]
            }),
        });
    }
    out
}

pub async fn execute(name: &str, args: &Value, ctx: &ToolContext) -> Result<String> {
    match name {
        "clock" => Ok(chrono::Local::now()
            .format("%Y-%m-%d %H:%M:%S %:z")
            .to_string()),
        "read_file" => read_file(args, ctx),
        "list_dir" => list_dir(args, ctx),
        "search_text" => search_text(args, ctx),
        other => Ok(format!("未知工具：{other}")),
    }
}

fn read_file(args: &Value, ctx: &ToolContext) -> Result<String> {
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .context("read_file 缺少 path")?;
    let path = ctx.resolve(path)?;
    if !path.is_file() {
        bail!("不是文件：{}", path.display());
    }
    let size = std::fs::metadata(&path)?.len();
    if size > MAX_READ_BYTES {
        bail!(
            "文件过大（{} KB），请用 start_line/max_lines 读取片段",
            size / 1024
        );
    }
    let bytes = std::fs::read(&path)?;
    if bytes.contains(&0) {
        bail!("二进制文件不支持读取");
    }
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    let start = line_arg(args, "start_line", 1, total.max(1));
    let max = line_arg(args, "max_lines", 200, MAX_READ_LINES);
    let end = (start + max - 1).min(total.max(1));
    let body = if total == 0 {
        "(empty file)".to_string()
    } else {
        lines[start - 1..end]
            .iter()
            .enumerate()
            .map(|(index, line)| format!("{:>6} | {}", start + index, line))
            .collect::<Vec<_>>()
            .join("\n")
    };
    Ok(format!(
        "{}\nlines {}-{} of {}\n{}",
        ctx.relative(&path),
        start,
        end,
        total,
        body
    ))
}

fn list_dir(args: &Value, ctx: &ToolContext) -> Result<String> {
    let raw = args.get("path").and_then(Value::as_str).unwrap_or(".");
    let path = ctx.resolve(raw)?;
    if !path.is_dir() {
        bail!("不是目录：{raw}");
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&path)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if is_sensitive(&entry.path(), ctx.root()?) || is_skipped_dir(&name) {
            continue;
        }
        let is_dir = entry.file_type()?.is_dir();
        entries.push((!is_dir, name, is_dir));
        if entries.len() >= MAX_LIST_ENTRIES {
            break;
        }
    }
    entries.sort();
    let body = entries
        .into_iter()
        .map(|(_, name, is_dir)| if is_dir { format!("{name}/") } else { name })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!(
        "{}\n{}",
        ctx.relative(&path),
        if body.is_empty() { "(empty)" } else { &body }
    ))
}

fn search_text(args: &Value, ctx: &ToolContext) -> Result<String> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .context("search_text 缺少 query")?;
    let needle = query.to_lowercase();
    let glob = args
        .get("glob")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .trim_start_matches('*')
        .to_lowercase();
    let max = line_arg(args, "max_results", 50, MAX_SEARCH_HITS);
    let root = ctx.root()?.to_path_buf();
    let mut hits = Vec::new();
    let mut files = 0usize;
    let mut seen = HashSet::new();
    let mut stack = vec![(root.clone(), 0usize)];

    while let Some((dir, depth)) = stack.pop() {
        if depth > 8 || files >= MAX_SEARCH_FILES || hits.len() >= max {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if files >= MAX_SEARCH_FILES || hits.len() >= max {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            if is_sensitive(&path, &root) || is_skipped_dir(&name) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push((path, depth + 1));
                continue;
            }
            if !glob.is_empty() && !name.to_lowercase().ends_with(&glob) {
                continue;
            }
            if std::fs::metadata(&path)
                .map(|m| m.len() > MAX_SEARCH_BYTES)
                .unwrap_or(true)
            {
                continue;
            }
            if !seen.insert(path.clone()) {
                continue;
            }
            files += 1;
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            if bytes.contains(&0) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            for (index, line) in text.lines().enumerate() {
                if line.to_lowercase().contains(&needle) {
                    let snippet: String = line.trim().chars().take(200).collect();
                    hits.push(format!(
                        "{}:{}: {}",
                        path.strip_prefix(&root).unwrap_or(&path).display(),
                        index + 1,
                        snippet
                    ));
                    if hits.len() >= max {
                        break;
                    }
                }
            }
        }
    }

    if hits.is_empty() {
        return Ok(format!("没有找到：{query}"));
    }
    Ok(hits.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_project() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "studydeck-tools-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("src/a.rs"),
            "fn main() {\n    println!(\"hi\");\n}\n",
        )
        .unwrap();
        std::fs::write(root.join(".env"), "SECRET=1\n").unwrap();
        root
    }

    #[tokio::test]
    async fn read_list_search_and_guard() {
        let root = temp_project();
        let ctx = ToolContext::new(Some(root.clone()));
        assert!(ctx.enabled());
        let text = execute("read_file", &json!({"path":"src/a.rs"}), &ctx)
            .await
            .unwrap();
        assert!(text.contains("fn main"));
        assert!(text.contains("    1 |"));
        assert!(execute("read_file", &json!({"path":".env"}), &ctx)
            .await
            .is_err());
        assert!(execute("read_file", &json!({"path":"../outside"}), &ctx)
            .await
            .is_err());
        let list = execute("list_dir", &json!({}), &ctx).await.unwrap();
        assert!(list.contains("src/"));
        assert!(!list.contains(".env"));
        let hits = execute("search_text", &json!({"query":"println"}), &ctx)
            .await
            .unwrap();
        assert!(hits.contains("src/a.rs:2"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn no_root_disables_file_tools() {
        let ctx = ToolContext::new(None);
        assert!(!ctx.enabled());
        assert_eq!(specs(false).len(), 1);
        assert_eq!(specs(true).len(), 4);
    }
}
