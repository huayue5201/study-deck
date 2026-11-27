//! HTTP 层：薄。只做「读请求 → 起一轮 → 推事件 → 落库」。

use std::{
    convert::Infallible,
    net::SocketAddr,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};

use agent::provider::{fake::FakeProvider, openai::OpenAiCompat, Provider};
use axum::{
    body::Body,
    extract::{Path as AxumPath, Query, State},
    http::{header, Request, StatusCode, Uri},
    middleware::{self, Next},
    response::{
        sse::{Event, Sse},
        IntoResponse, Json, Response,
    },
    routing::{get, post},
    Router,
};
use chrono::Utc;
use futures_util::{stream, StreamExt};
use serde::Deserialize;
use serde_json::json;
use store::Store;
use studydeck_core::{
    AgentEvent, Anchor, Card, CardId, CardProfile, CardTurn, Depth, Mastery, Message,
    MessageStatus, Mode, SessionId, Topic, TopicEdgeKind, TopicNodeStatus, TurnRequest, TurnRole,
    TurnStatus, Usage,
};
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::BroadcastStream;
use tokio_util::sync::CancellationToken;

mod profiles;
mod secrets;
mod settings;
mod turn;

use profiles::Profiles;
use turn::{Registry, Turn, TurnState, TurnView};

pub use settings::{presets, Settings, SettingsStore, SettingsView};

/// 能力自述：外部客户端据此做降级，而不是 try-and-fail。
pub const API_VERSION: u32 = 2;
pub const CAPS: &[&str] = &[
    "turns",
    "events",
    "cancel",
    "sessions",
    "glossary",
    "export",
    "token",
    "promote",
    "topics",
    "relations",
    "outline",
    "nodes",
    "resolve",
    "files",
    "storage",
];

#[derive(rust_embed::RustEmbed)]
#[folder = "../../apps/web/dist"]
struct Assets;

struct AppState {
    store: Arc<Store>,
    data_dir: PathBuf,
    settings: SettingsStore,
    provider: RwLock<Arc<dyn Provider>>,
    registry: Registry,
    profiles: Profiles,
    token: String,
}

impl AppState {
    fn provider(&self) -> Arc<dyn Provider> {
        self.provider
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn is_fake(&self) -> bool {
        self.provider().name() == "fake"
    }

    fn view(&self) -> SettingsView {
        let settings = self.settings.load();
        let has_key = secrets::load_key(&self.data_dir).is_some();
        SettingsView {
            provider: settings.provider,
            base_url: settings.base_url,
            model: settings.model,
            configured: settings.configured,
            has_key,
            key_in_keychain: has_key && !self.data_dir.join("secret.key").exists(),
        }
    }

    fn rebuild_provider(&self) {
        let settings = self.settings.load();
        let key = secrets::load_key(&self.data_dir).unwrap_or_default();
        let provider = build_provider(&settings, &key);
        *self
            .provider
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = provider;
    }
}

fn build_provider(settings: &Settings, key: &str) -> Arc<dyn Provider> {
    if key.trim().is_empty() {
        return Arc::new(FakeProvider::new());
    }
    Arc::new(OpenAiCompat::new(
        settings.base_url.clone(),
        key.to_string(),
        settings.model.clone(),
    ))
}

pub fn init_tracing(
    log_dir: Option<PathBuf>,
) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    let filter =
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    match log_dir {
        Some(dir) => {
            std::fs::create_dir_all(&dir).ok();
            let appender = tracing_appender::rolling::daily(dir, "studydeck.log");
            let (writer, guard) = tracing_appender::non_blocking(appender);
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_writer(writer)
                .with_ansi(false)
                .init();
            Some(guard)
        }
        None => {
            tracing_subscriber::fmt().with_env_filter(filter).init();
            None
        }
    }
}

pub async fn run(addr: SocketAddr, data_dir: PathBuf) -> anyhow::Result<()> {
    run_with_ready(addr, data_dir, None).await
}

pub async fn run_with_ready(
    addr: SocketAddr,
    data_dir: PathBuf,
    ready: Option<oneshot::Sender<SocketAddr>>,
) -> anyhow::Result<()> {
    std::fs::create_dir_all(&data_dir).ok();
    let store = Store::open(data_dir.join("studydeck.db"))?;
    // 上次崩溃留下的 running 行收敛成 error，避免永远转圈
    if let Ok(count) = store.fail_orphan_running() {
        if count > 0 {
            tracing::warn!("{count} 条未完成的回答被标记为 error");
        }
    }
    // 每次启动做一次轻量清理（不压缩文件）：空会话、孤儿遭遇、过期 token 用量
    match store.maintain(false) {
        Ok(report) => {
            let total = report.empty_sessions
                + report.orphan_encounters
                + report.orphan_links
                + report.old_turn_usage
                + report.reattached_cards;
            if total > 0 {
                tracing::info!(
                    "启动清理：空会话 {} / 孤儿遭遇 {} / 悬空卡片 {} / 断链 {} / 过期用量 {}",
                    report.empty_sessions,
                    report.orphan_encounters,
                    report.dangling_cards,
                    report.orphan_links,
                    report.old_turn_usage
                );
            }
        }
        Err(err) => tracing::warn!("启动清理失败：{err}"),
    }

    let settings_store = SettingsStore::new(&data_dir);
    let settings = settings_store.load();
    let key = secrets::load_key(&data_dir).unwrap_or_default();
    let provider = build_provider(&settings, &key);
    if provider.name() == "fake" {
        tracing::warn!("未配置 API Key：进入演示模式，等待首次配置");
    }

    let token = std::env::var("STUDYDECK_TOKEN").unwrap_or_else(|_| {
        if std::env::var("STUDYDECK_NO_AUTH").is_ok() {
            String::new()
        } else {
            uuid::Uuid::new_v4().simple().to_string()
        }
    });

    let settings_for_profiles = settings_store.clone();
    let state = Arc::new(AppState {
        store: Arc::new(store),
        data_dir: data_dir.clone(),
        settings: settings_store,
        provider: RwLock::new(provider),
        registry: Registry::default(),
        profiles: Profiles::new(&data_dir.join("profiles"), settings_for_profiles),
        token,
    });

    let token_for_auth = state.clone();
    let protected = Router::new()
        .route("/api/providers", get(provider_presets))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/settings/test", post(test_connection))
        .route("/api/settings/key", axum::routing::delete(clear_key))
        .route("/api/profiles", get(list_profiles).post(create_profile))
        .route(
            "/api/profiles/active",
            axum::routing::put(set_active_profile),
        )
        .route(
            "/api/profiles/{id}",
            axum::routing::put(update_profile).delete(delete_profile),
        )
        .route("/api/storage", get(storage_stats).post(maintain_storage))
        .route("/api/sessions", get(list_sessions).post(create_session))
        .route("/api/sessions/resolve", get(resolve_session_cwd))
        .route(
            "/api/sessions/{id}",
            get(get_session).delete(delete_session),
        )
        .route(
            "/api/sessions/{id}/meta",
            axum::routing::patch(rename_session),
        )
        .route("/api/sessions/{id}/promote", post(promote_session))
        .route(
            "/api/sessions/{id}/topic",
            axum::routing::patch(set_session_topic),
        )
        .route(
            "/api/sessions/{id}/profile",
            axum::routing::patch(set_session_profile),
        )
        .route("/api/topics", get(list_topics).post(create_topic))
        .route(
            "/api/topics/{id}",
            get(get_topic).patch(update_topic).delete(delete_topic),
        )
        .route("/api/topics/{id}/sessions", post(create_topic_session))
        .route("/api/topics/{id}/edges", post(add_topic_edge))
        .route(
            "/api/topics/{id}/edges/{edge_id}",
            axum::routing::delete(delete_topic_edge),
        )
        .route("/api/topics/{id}/nodes", post(add_topic_node))
        .route(
            "/api/topics/{id}/nodes/{node_id}",
            axum::routing::patch(update_topic_node).delete(delete_topic_node),
        )
        .route("/api/topics/{id}/outline/parse", post(parse_topic_outline))
        .route("/api/chat", post(chat))
        .route("/api/ask", post(ask))
        .route("/api/turns", get(list_turns))
        .route("/api/turns/{id}", get(get_turn))
        .route("/api/turns/{id}/events", get(turn_events))
        .route("/api/turns/{id}/cancel", post(cancel_turn))
        .route("/api/cards/{id}", get(card_detail).delete(delete_card))
        .route("/api/glossary", get(list_glossary).post(add_glossary))
        .route("/api/glossary/match", get(match_glossary))
        .route("/api/entries/{id}", get(entry_detail))
        .route("/api/review/due", get(due_reviews))
        .route("/api/review/{id}", post(review_entry))
        .route("/api/glossary/merge", post(merge_glossary))
        .route(
            "/api/glossary/{id}",
            axum::routing::delete(delete_glossary).put(update_glossary),
        )
        .route("/api/search", get(search_messages))
        .route("/api/export", get(export_glossary))
        .route_layer(middleware::from_fn_with_state(
            token_for_auth,
            require_token,
        ));

    let app = Router::new()
        .route("/api/health", get(health))
        .merge(protected)
        .fallback(static_handler)
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind(addr).await?;
    let local = listener.local_addr()?;
    tracing::info!("listening on http://{local}");

    // 握手文件：端口是系统分配的，外部客户端靠这个文件找到实例、能力与令牌。
    let handle = json!({
        "port": local.port(),
        "pid": std::process::id(),
        "api": API_VERSION,
        "caps": CAPS,
        "token": state.token,
    });
    let _ = std::fs::write(data_dir.join("port"), handle.to_string());

    if let Some(sender) = ready {
        let _ = sender.send(local);
    }
    axum::serve(listener, app).await?;
    Ok(())
}

// ---------- 认证 ----------

async fn require_token(
    State(state): State<Arc<AppState>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if state.token.is_empty() {
        return next.run(request).await;
    }
    let authorized = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| value.trim() == state.token)
        .unwrap_or(false);

    if authorized {
        next.run(request).await
    } else {
        api_error(
            StatusCode::UNAUTHORIZED,
            "缺少或错误的 Bearer token（见数据目录的 port 文件）",
        )
    }
}

// ---------- 静态资源 ----------

async fn static_handler(State(state): State<Arc<AppState>>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    // 未知 /api/* 必须 404，而不是掉进 SPA fallback 返回 200 HTML
    if path.starts_with("api/") {
        return api_error(StatusCode::NOT_FOUND, format!("unknown endpoint: /{path}"));
    }

    if let Some(file) = Assets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        let mut body = file.data.into_owned();
        if path == "index.html" {
            body = inject_token(body, &state.token);
        }
        return ([(header::CONTENT_TYPE, mime.as_ref().to_string())], body).into_response();
    }

    match Assets::get("index.html") {
        Some(file) => (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8".to_string())],
            inject_token(file.data.into_owned(), &state.token),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "web assets missing").into_response(),
    }
}

/// 把访问令牌塞进首页：SPA 与页面同源，天然能拿到，不需要额外分发。
fn inject_token(html: Vec<u8>, token: &str) -> Vec<u8> {
    if token.is_empty() {
        return html;
    }
    let text = String::from_utf8_lossy(&html).to_string();
    let meta = format!(r#"<meta name="deck-token" content="{token}">"#);
    if let Some(index) = text.find("</head>") {
        let mut out = String::with_capacity(text.len() + meta.len());
        out.push_str(&text[..index]);
        out.push_str(&meta);
        out.push_str(&text[index..]);
        return out.into_bytes();
    }
    html
}

// ---------- 配置 ----------

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let view = state.view();
    Json(json!({
        "ok": true,
        "fake": state.is_fake(),
        "provider": state.provider().name(),
        "configured": view.configured && view.has_key,
        "api": API_VERSION,
        "caps": CAPS,
        "busy": !state.registry.list(true).is_empty(),
    }))
}

async fn provider_presets() -> impl IntoResponse {
    Json(settings::presets())
}

async fn get_settings(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.view())
}

#[derive(Debug, Deserialize)]
struct SettingsUpdate {
    provider: String,
    base_url: String,
    model: String,
    api_key: Option<String>,
}

async fn put_settings(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SettingsUpdate>,
) -> impl IntoResponse {
    let base_url = body.base_url.trim().to_string();
    let model = body.model.trim().to_string();
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        return api_error(StatusCode::BAD_REQUEST, "base_url 必须是 http(s) 地址");
    }
    if model.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "model 不能为空");
    }

    if let Some(key) = body.api_key.as_deref() {
        if !key.trim().is_empty() {
            match secrets::save_key(&state.data_dir, key) {
                Ok(in_keychain) => {
                    if !in_keychain {
                        tracing::warn!("系统钥匙串不可用，密钥写入 0600 文件");
                    }
                }
                Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
            }
        }
    }

    let previous = state.settings.load();
    let settings = Settings {
        provider: body.provider,
        base_url,
        model,
        configured: true,
        active_profile: previous.active_profile,
    };
    if let Err(err) = state.settings.save(&settings) {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }
    state.rebuild_provider();
    Json(state.view()).into_response()
}

#[derive(Debug, Deserialize)]
struct ConnectionTest {
    base_url: String,
    model: String,
    api_key: String,
}

async fn test_connection(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ConnectionTest>,
) -> impl IntoResponse {
    let key = if body.api_key.trim().is_empty() {
        secrets::load_key(&state.data_dir).unwrap_or_default()
    } else {
        body.api_key.clone()
    };
    if key.trim().is_empty() {
        return Json(json!({ "ok": false, "message": "没有 API Key" }));
    }

    let provider = OpenAiCompat::new(body.base_url.clone(), key, body.model.clone());
    let (tx, mut rx) = mpsc::unbounded_channel();
    tokio::spawn(async move { while rx.recv().await.is_some() {} });

    let request = agent::ChatRequest {
        messages: vec![agent::ChatMessage::user("ping")],
        tools: Vec::new(),
    };

    let started = Instant::now();
    match provider
        .chat_stream(request, tx, CancellationToken::new())
        .await
    {
        Ok(outcome) => Json(json!({
            "ok": true,
            "message": format!("连接成功，返回 {} 字", outcome.text.chars().count()),
            "elapsed_ms": started.elapsed().as_millis() as u64,
        })),
        Err(err) => Json(json!({
            "ok": false,
            "message": format!("{err}"),
            "elapsed_ms": started.elapsed().as_millis() as u64,
        })),
    }
}

async fn clear_key(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    secrets::clear_key(&state.data_dir);
    let settings = state.settings.load();
    let _ = state.settings.save(&Settings {
        configured: false,
        ..settings
    });
    state.rebuild_provider();
    Json(state.view())
}

// ---------- 会话 ----------

async fn create_session(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.store.create_session() {
        Ok(session) => {
            let profile_id = state.profiles.active_id();
            let _ = state
                .store
                .set_session_profile(session.id.as_str(), Some(&profile_id));
            Json(json!({ "id": session.id, "profile_id": profile_id })).into_response()
        }
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn get_session(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    let Ok(Some(session)) = state.store.get_session(&id) else {
        return api_error(StatusCode::NOT_FOUND, "session not found");
    };
    let (Ok(messages), Ok(cards)) = (state.store.messages(&id), state.store.cards(&id)) else {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, "failed to load session");
    };
    let topic = state.store.topic_for_session(&id).ok().flatten();
    let origin = state.store.session_seed(&id).ok().flatten();
    let usage = state.store.session_usage(&id).unwrap_or_default();
    Json(json!({
        "id": session.id,
        "profile_id": session.profile_id,
        "messages": messages,
        "cards": cards,
        "topic": topic,
        "origin": origin,
        "usage": usage,
        "active_turn": state.registry.list(true).into_iter()
            .find(|turn| turn.session_id == id)
            .map(|turn| turn.id),
    }))
    .into_response()
}

async fn list_sessions(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.store.recent_sessions(50) {
        Ok(sessions) => Json(json!({ "sessions": sessions })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct SessionRename {
    title: String,
}

async fn rename_session(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<SessionRename>,
) -> impl IntoResponse {
    match state.store.rename_session(&id, &body.title) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct PromoteBody {
    card_id: String,
    title: Option<String>,
    depth_goal: Option<String>,
    /// 指定则并入已有专题；不指定则新建专题。
    topic_id: Option<String>,
    #[serde(default)]
    metadata: Option<serde_json::Value>,
}

/// 卡片 -> 专题会话。幂等：同一张卡重复调用不会产生重复专题。
async fn promote_session(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<PromoteBody>,
) -> Response {
    let depth = body.depth_goal.as_deref().and_then(Depth::parse);
    match state.store.promote_card(
        &id,
        &body.card_id,
        body.title.as_deref(),
        depth,
        body.metadata,
        body.topic_id.as_deref(),
    ) {
        Ok(promotion) => (StatusCode::CREATED, Json(promotion)).into_response(),
        Err(err) => api_error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

async fn list_topics(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.store.all_topics() {
        Ok(topics) => Json(json!({ "topics": topics })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct TopicCreate {
    title: String,
    summary: Option<String>,
    depth_goal: Option<String>,
}

async fn create_topic(
    State(state): State<Arc<AppState>>,
    Json(body): Json<TopicCreate>,
) -> Response {
    let title = body.title.trim();
    if title.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "title 不能为空");
    }
    let topic = Topic::new(
        title,
        body.summary.unwrap_or_default(),
        body.depth_goal
            .as_deref()
            .and_then(Depth::parse)
            .unwrap_or_default(),
    );
    match state.store.create_topic(&topic) {
        Ok(()) => (StatusCode::CREATED, Json(topic)).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn get_topic(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let Some(topic) = state.store.topic(&id).ok().flatten() else {
        return api_error(StatusCode::NOT_FOUND, "topic not found");
    };
    let sessions = state.store.sessions_for_topic(&id).unwrap_or_default();
    let edges = state.store.edges_for_topic(&id).unwrap_or_default();
    let topics = state.store.all_topics().unwrap_or_default();
    let by_id: std::collections::HashMap<String, Topic> = topics
        .into_iter()
        .map(|topic| (topic.id.to_string(), topic))
        .collect();

    let relations: Vec<serde_json::Value> = edges
        .into_iter()
        .map(|edge| {
            let incoming = edge.to_topic_id.as_str() == id;
            let other_id = if incoming {
                edge.from_topic_id.as_str()
            } else {
                edge.to_topic_id.as_str()
            };
            let direction = match edge.kind {
                TopicEdgeKind::Related => "related",
                _ if incoming => "incoming",
                _ => "outgoing",
            };
            json!({
                "id": edge.id,
                "kind": edge.kind.as_str(),
                "kind_label": edge.kind.label_cn(),
                "direction": direction,
                "note": edge.note,
                "other": by_id.get(other_id),
            })
        })
        .collect();

    let suggestions = topic_suggestions(&state.store, &id).unwrap_or_default();
    let source = state.store.topic_seed(&id).ok().flatten();
    let nodes = state.store.topic_nodes(&id).unwrap_or_default();
    Json(json!({
        "topic": topic,
        "sessions": sessions,
        "relations": relations,
        "suggestions": suggestions,
        "source": source,
        "nodes": nodes,
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
struct TopicUpdate {
    title: Option<String>,
    summary: Option<String>,
    depth_goal: Option<String>,
    mastery: Option<String>,
    outline_md: Option<String>,
}

async fn update_topic(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<TopicUpdate>,
) -> Response {
    let depth = body.depth_goal.as_deref().and_then(Depth::parse);
    let mastery = body.mastery.as_deref().and_then(Mastery::parse);
    match state.store.update_topic(
        &id,
        body.title.as_deref(),
        body.summary.as_deref(),
        depth,
        mastery,
        body.outline_md.as_deref(),
    ) {
        Ok(Some(topic)) => Json(topic).into_response(),
        Ok(None) => api_error(StatusCode::NOT_FOUND, "topic not found"),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct DeleteTopicQuery {
    #[serde(default)]
    delete_sessions: bool,
}

async fn delete_topic(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<DeleteTopicQuery>,
) -> Response {
    match state.store.delete_topic(&id, query.delete_sessions) {
        Ok(result) => Json(result).into_response(),
        Err(err) => api_error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

async fn create_topic_session(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    match state.store.create_session_in_topic(&id) {
        Ok(session) => {
            let profile_id = state.profiles.active_id();
            let _ = state
                .store
                .set_session_profile(session.id.as_str(), Some(&profile_id));
            (
                StatusCode::CREATED,
                Json(json!({
                    "id": session.id,
                    "title": session.title,
                    "profile_id": profile_id,
                })),
            )
                .into_response()
        }
        Err(err) => api_error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct SessionProfileBody {
    profile_id: Option<String>,
}

async fn set_session_profile(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<SessionProfileBody>,
) -> impl IntoResponse {
    if state.store.get_session(&id).ok().flatten().is_none() {
        return api_error(StatusCode::NOT_FOUND, "session not found");
    }
    if let Some(profile_id) = body.profile_id.as_deref() {
        if state.profiles.get(profile_id).is_none() {
            return api_error(StatusCode::BAD_REQUEST, "profile not found");
        }
    }
    match state
        .store
        .set_session_profile(&id, body.profile_id.as_deref())
    {
        Ok(()) => Json(json!({ "ok": true, "profile_id": body.profile_id })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct SessionTopicBody {
    topic_id: Option<String>,
}

async fn set_session_topic(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<SessionTopicBody>,
) -> Response {
    match state.store.set_session_topic(&id, body.topic_id.as_deref()) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => api_error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct EdgeBody {
    from_topic_id: String,
    to_topic_id: String,
    kind: String,
    note: Option<String>,
}

async fn add_topic_edge(
    State(state): State<Arc<AppState>>,
    AxumPath(_id): AxumPath<String>,
    Json(body): Json<EdgeBody>,
) -> Response {
    let Some(kind) = TopicEdgeKind::parse(&body.kind) else {
        return api_error(StatusCode::BAD_REQUEST, "未知的关系类型");
    };
    match state.store.add_topic_edge(
        &body.from_topic_id,
        &body.to_topic_id,
        kind,
        body.note.as_deref().unwrap_or(""),
        None,
    ) {
        Ok(edge) => (StatusCode::CREATED, Json(edge)).into_response(),
        Err(err) => api_error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

async fn delete_topic_edge(
    State(state): State<Arc<AppState>>,
    AxumPath((_id, edge_id)): AxumPath<(String, String)>,
) -> Response {
    match state.store.delete_topic_edge(&edge_id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct TopicNodeCreate {
    title: String,
}

async fn add_topic_node(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<TopicNodeCreate>,
) -> Response {
    let title = body.title.trim();
    if title.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "title 不能为空");
    }
    match state.store.add_topic_node(&id, title) {
        Ok(node) => (StatusCode::CREATED, Json(node)).into_response(),
        Err(err) => api_error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct TopicNodeUpdate {
    title: Option<String>,
    status: Option<String>,
    note: Option<String>,
    position: Option<i64>,
}

async fn update_topic_node(
    State(state): State<Arc<AppState>>,
    AxumPath((id, node_id)): AxumPath<(String, String)>,
    Json(body): Json<TopicNodeUpdate>,
) -> Response {
    let status = body.status.as_deref().and_then(TopicNodeStatus::parse);
    match state.store.update_topic_node(
        &id,
        &node_id,
        body.title.as_deref(),
        status,
        body.note.as_deref(),
        body.position,
    ) {
        Ok(Some(node)) => Json(node).into_response(),
        Ok(None) => api_error(StatusCode::NOT_FOUND, "node not found"),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn delete_topic_node(
    State(state): State<Arc<AppState>>,
    AxumPath((id, node_id)): AxumPath<(String, String)>,
) -> Response {
    match state.store.delete_topic_node(&id, &node_id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct OutlineParseBody {
    markdown: Option<String>,
}

async fn parse_topic_outline(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<OutlineParseBody>,
) -> Response {
    let topic = match state.store.topic(&id) {
        Ok(Some(topic)) => topic,
        Ok(None) => return api_error(StatusCode::NOT_FOUND, "topic not found"),
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    };
    let markdown = body.markdown.unwrap_or(topic.outline_md);
    let titles = parse_outline_nodes(&markdown);
    if titles.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "没有从学习地图里识别出节点");
    }
    match state.store.replace_topic_nodes(&id, &titles) {
        Ok(nodes) => Json(json!({ "nodes": nodes })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn parse_outline_nodes(markdown: &str) -> Vec<String> {
    let mut out = Vec::new();
    for raw in markdown.lines() {
        let mut line = raw.trim();
        if line.is_empty() || line.starts_with("```") || line.starts_with('|') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("- ") {
            line = rest;
        } else if let Some(rest) = line.strip_prefix("* ") {
            line = rest;
        } else if let Some(rest) = line.strip_prefix("+ ") {
            line = rest;
        } else {
            let numbered = line
                .trim_start_matches(|ch: char| ch.is_ascii_digit())
                .trim_start_matches(['.', ')', '、']);
            if numbered.len() != line.len() {
                line = numbered;
            } else if let Some(rest) = line.strip_prefix("## ") {
                line = rest;
            } else if let Some(rest) = line.strip_prefix("# ") {
                line = rest;
            } else {
                continue;
            }
        }
        let title: String = line
            .chars()
            .filter(|ch| !matches!(ch, '*' | '`' | '>' | '#'))
            .collect();
        let title = title
            .trim()
            .trim_start_matches(['-', '—', '·'])
            .trim()
            .to_string();
        if !title.is_empty() && title.chars().count() <= 80 && !out.contains(&title) {
            out.push(title);
        }
        if out.len() >= 12 {
            break;
        }
    }
    out
}

fn topic_suggestions(store: &Store, topic_id: &str) -> anyhow::Result<Vec<serde_json::Value>> {
    let Some(seed) = store.topic_seed(topic_id)? else {
        return Ok(Vec::new());
    };
    let names = parse_prerequisites(&seed.answer);
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let topics = store.all_topics()?;
    let edges = store.edges_for_topic(topic_id)?;
    let connected: std::collections::HashSet<String> = edges
        .iter()
        .map(|edge| {
            if edge.to_topic_id.as_str() == topic_id {
                edge.from_topic_id.to_string()
            } else {
                edge.to_topic_id.to_string()
            }
        })
        .collect();

    let mut out = Vec::new();
    for name in names {
        if let Some(existing) = topics
            .iter()
            .find(|topic| topic.title.eq_ignore_ascii_case(&name))
        {
            if existing.id.as_str() == topic_id || connected.contains(existing.id.as_str()) {
                continue;
            }
            out.push(json!({ "title": name, "topic_id": existing.id }));
        } else {
            out.push(json!({ "title": name, "topic_id": null }));
        }
        if out.len() >= 8 {
            break;
        }
    }
    Ok(out)
}

fn parse_prerequisites(answer: &str) -> Vec<String> {
    let Some(index) = answer.find("前置依赖") else {
        return Vec::new();
    };
    let rest = &answer[index..];
    let line = rest.lines().next().unwrap_or(rest);
    let line = line.split(['：', ':']).nth(1).unwrap_or(line);
    let mut out = Vec::new();
    for part in line.split(['、', ',', '，', ';', '；', '/', '|']) {
        let name: String = part
            .chars()
            .filter(|ch| !matches!(ch, '*' | '`' | '#' | '>' | '（' | '）' | '(' | ')'))
            .collect();
        let name = name.trim().trim_matches('。').trim().to_string();
        if !name.is_empty() && !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

async fn delete_session(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    match state.store.delete_session(&id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

// ---------- 一轮对话 ----------

struct TurnSpec {
    session_id: SessionId,
    mode: Mode,
    text: String,
    anchor: Option<Anchor>,
    depth: Option<Depth>,
    card_id: Option<String>,
    card_history: Option<String>,
    project_root: Option<PathBuf>,
    /// 回答语言：Some("en") 跟随英文界面
    locale: Option<String>,
    /// 卡片模板 id；None = 用当前默认模板
    profile_id: Option<String>,
    /// 用户选的档位 id
    level: Option<String>,
    /// 嵌套展开：父卡 id
    nest_from: Option<String>,
    /// 嵌套展开：父文本（父卡没有记录时用）
    nest_text: Option<String>,
}

struct StartedTurn {
    turn: Arc<std::sync::Mutex<Turn>>,
    stream: Pin<Box<dyn futures_util::Stream<Item = Result<Event, Infallible>> + Send>>,
    drop_guard: oneshot::Sender<()>,
}

fn sse_item((seq, event): (u64, AgentEvent)) -> (bool, Result<Event, Infallible>) {
    let end = matches!(event, AgentEvent::End);
    let payload = serde_json::to_string(&event).unwrap_or_else(|_| "{}".into());
    (end, Ok(Event::default().id(seq.to_string()).data(payload)))
}

/// 回放 + 实时：先补 backlog，再挂广播；订阅在快照之前，所以中间不会漏事件。
fn turn_stream(
    turn: &Arc<std::sync::Mutex<Turn>>,
    since: u64,
) -> Pin<Box<dyn futures_util::Stream<Item = Result<Event, Infallible>> + Send>> {
    let (snapshot, receiver) = {
        let guard = turn.lock().expect("turn poisoned");
        (guard.backlog_since(since), guard.subscribe())
    };
    let last = snapshot.last().map(|(seq, _)| *seq).unwrap_or(since);

    let replay = stream::iter(snapshot.into_iter().map(sse_item));
    let live = BroadcastStream::new(receiver).filter_map(move |item| async move {
        let (seq, event) = item.ok()?;
        if seq <= last {
            return None;
        }
        Some(sse_item((seq, event)))
    });

    take_through_end(replay.chain(live))
}

/// 让流在 End 之后自然结束（take_while 会把 End 本身也吞掉，所以用 unfold）。
fn take_through_end<S>(
    inner: S,
) -> Pin<Box<dyn futures_util::Stream<Item = Result<Event, Infallible>> + Send>>
where
    S: futures_util::Stream<Item = (bool, Result<Event, Infallible>)> + Send + 'static,
{
    struct State<S> {
        inner: Pin<Box<S>>,
        done: bool,
    }
    Box::pin(stream::unfold(
        State {
            inner: Box::pin(inner),
            done: false,
        },
        |mut state| async move {
            if state.done {
                return None;
            }
            let (is_end, item) = state.inner.next().await?;
            if is_end {
                state.done = true;
            }
            Some((item, state))
        },
    ))
}

/// 卡片档位 → 三档深度；以实际使用的模板为准，避免前端用全局模板算错。
fn depth_for_level(profile: &CardProfile, level: Option<&str>) -> Depth {
    let Some(level) = level.and_then(|id| profile.level(id)) else {
        return Depth::CanTune;
    };
    let index = profile
        .levels
        .iter()
        .position(|item| item.id == level.id)
        .unwrap_or(0);
    if index == 0 {
        Depth::CanUse
    } else if index + 1 >= profile.levels.len() {
        Depth::CanDerive
    } else {
        Depth::CanTune
    }
}

fn begin_turn(state: &Arc<AppState>, spec: TurnSpec) -> Result<StartedTurn, Response> {
    let session_key = spec.session_id.to_string();
    let turn = match state.registry.open(&session_key, &spec.text) {
        Ok(turn) => turn,
        Err(active) => {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({ "error": "这个会话还有一轮在跑", "active_turn": active })),
            )
                .into_response())
        }
    };

    let history = state.store.messages(&session_key).unwrap_or_default();
    let topic = state.store.topic_for_session(&session_key).ok().flatten();
    let seed = state.store.session_seed(&session_key).ok().flatten();
    // 续写同一张卡时，卡自己的范式/档位优先，避免跨领域追问被当前默认模板带跑。
    let existing_card = spec
        .card_id
        .as_ref()
        .filter(|_| spec.card_history.is_some())
        .and_then(|id| state.store.card_by_id(id).ok().flatten())
        .filter(|card| card.session_id == spec.session_id);
    let session_profile = state.store.session_profile(&session_key).ok().flatten();

    // 第一轮用户消息自动成为标题，侧边栏才不会全是“未命名”。
    if spec.mode == Mode::Main {
        let _ = state.store.maybe_title_session(&session_key, &spec.text);
    }

    // 卡片模式只有卡记录；主线模式建 user + assistant 两行
    // 卡片模板与档位：请求显式指定 > 当前默认模板 > 内置 tech
    let (resolved_profile, resolved_level) = match spec.mode {
        Mode::Card => {
            let card_profile = existing_card
                .as_ref()
                .and_then(|card| card.profile_id.as_deref());
            // 优先级：卡片自身 → 会话模板 → 请求指定 → 全局默认
            let profile = card_profile
                .and_then(|id| state.profiles.get(id))
                .or_else(|| {
                    session_profile
                        .as_deref()
                        .and_then(|id| state.profiles.get(id))
                })
                .or_else(|| {
                    spec.profile_id
                        .as_deref()
                        .and_then(|id| state.profiles.get(id))
                })
                .or_else(|| state.profiles.active())
                .unwrap_or_else(CardProfile::builtin_tech);
            let requested_level = existing_card
                .as_ref()
                .and_then(|card| card.level.as_deref())
                .or(spec.level.as_deref());
            let level = profile
                .resolved_level(requested_level)
                .map(|level| level.id.clone());
            (Some(profile), level)
        }
        Mode::Main => (None, None),
    };

    let resolved_depth = match spec.mode {
        Mode::Card => resolved_profile
            .as_ref()
            .map(|profile| depth_for_level(profile, resolved_level.as_deref()))
            .or(spec.depth),
        Mode::Main => spec.depth,
    };

    // 嵌套展开的父卡（在主线上展开时为 None）
    let nest_parent = spec
        .nest_from
        .as_ref()
        .and_then(|id| state.store.card_by_id(id).ok().flatten());

    let (assistant_id, card_id, card_is_new) = match spec.mode {
        Mode::Main => {
            let mut user = Message::user(&spec.session_id, spec.text.clone());
            let mut assistant = Message::assistant(&spec.session_id, "");
            user.turn_id = Some(turn.lock().expect("turn poisoned").id.clone());
            assistant.turn_id = user.turn_id.clone();
            assistant.status = MessageStatus::Running;
            if let Err(err) = state.store.add_message(&user) {
                state
                    .registry
                    .finish(&turn, TurnState::Error, Some(err.to_string()));
                return Err(api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    err.to_string(),
                ));
            }
            if let Err(err) = state.store.add_message(&assistant) {
                return Err(api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    err.to_string(),
                ));
            }
            (Some(assistant.id.0.clone()), None, false)
        }
        Mode::Card => {
            // 追问续写同一张卡：卡就是一条探索线程，不再每轮新建
            // 只有「追问」（带 card_history）才续写原卡；换档/重新生成仍按旧逻辑建新卡
            if let Some(card) = existing_card.clone() {
                (None, Some(card.id), false)
            } else {
                let anchor = spec.anchor.clone().unwrap_or_else(|| {
                    Anchor::new(
                        studydeck_core::MessageId("unknown".into()),
                        0,
                        0,
                        spec.text.clone(),
                    )
                });
                let stack_depth = nest_parent
                    .as_ref()
                    .map(|card| card.stack_depth + 1)
                    .unwrap_or(0);
                let card = Card {
                    id: CardId::new(),
                    session_id: spec.session_id.clone(),
                    anchor,
                    depth: resolved_depth.unwrap_or_default(),
                    profile_id: resolved_profile.as_ref().map(|profile| profile.id.clone()),
                    level: resolved_level.clone(),
                    parent_card_id: nest_parent.as_ref().map(|card| card.id.clone()),
                    stack_depth,
                    question: spec.text.clone(),
                    answer: String::new(),
                    promoted_session_id: None,
                    created_at: Utc::now(),
                };
                if let Err(err) = state.store.add_card(&card) {
                    return Err(api_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        err.to_string(),
                    ));
                }
                (None, Some(card.id), true)
            }
        }
    };

    // 续写时以库里的轮次为准；同时给老卡懒回填 card_turns
    let mut card_history = spec.card_history.clone();
    let mut turn_ids: Option<(String, String)> = None;
    if let Some(id) = card_id.as_ref() {
        let existing_turns = state
            .store
            .card_by_id(id.as_str())
            .ok()
            .flatten()
            .and_then(|card| state.store.ensure_card_turns(&card).ok())
            .unwrap_or_default();
        if !card_is_new {
            card_history = Some(thread_history(&existing_turns));
        }

        let now = Utc::now();
        let seq = state.store.next_turn_seq(id.as_str()).unwrap_or(0);
        let user_turn = CardTurn {
            id: uuid::Uuid::new_v4().simple().to_string(),
            card_id: id.clone(),
            seq,
            role: TurnRole::User,
            text: spec.text.clone(),
            level: resolved_level.clone(),
            profile_id: resolved_profile.as_ref().map(|profile| profile.id.clone()),
            status: TurnStatus::Done,
            created_at: now,
        };
        let assistant_turn = CardTurn {
            id: uuid::Uuid::new_v4().simple().to_string(),
            card_id: id.clone(),
            seq: seq + 1,
            role: TurnRole::Assistant,
            text: String::new(),
            level: resolved_level.clone(),
            profile_id: resolved_profile.as_ref().map(|profile| profile.id.clone()),
            status: TurnStatus::Streaming,
            created_at: now,
        };
        let _ = state.store.add_card_turn(&user_turn);
        let _ = state.store.add_card_turn(&assistant_turn);
        turn_ids = Some((user_turn.id, assistant_turn.id));
    }

    let parent_card = spec.card_id.as_ref().and_then(|id| {
        state.store.cards(&session_key).ok().and_then(|cards| {
            cards
                .into_iter()
                .find(|card| card.id.as_str() == id.as_str())
        })
    });
    let project_root = spec.project_root.or_else(|| {
        state
            .store
            .session_project_root(&session_key)
            .ok()
            .flatten()
            .map(PathBuf::from)
    });
    let request = TurnRequest {
        mode: spec.mode,
        text: spec.text.clone(),
        anchor: spec.anchor.clone(),
        depth: resolved_depth,
        parent_card: nest_parent.clone().or(parent_card),
        card_history,
        topic,
        seed,
        project_root,
        profile: resolved_profile,
        level: Some(resolved_level.unwrap_or_default()).filter(|value| !value.is_empty()),
        locale: spec.locale,
        nest_source: spec
            .nest_text
            .clone()
            .or_else(|| nest_parent.as_ref().map(|card| card.answer.clone())),
        history,
    };

    // 第一条事件就是坐标：外部客户端靠它拿到 turn/session
    {
        let (turn_id, session_id) = {
            let guard = turn.lock().expect("turn poisoned");
            (guard.id.clone(), guard.session_id.clone())
        };
        let mut guard = turn.lock().expect("turn poisoned");
        guard.message_id = assistant_id.clone();
        guard.emit(AgentEvent::TurnStarted {
            turn_id,
            session_id,
        });
    }

    let (tx, rx) = mpsc::unbounded_channel::<AgentEvent>();
    let cancel = turn.lock().expect("turn poisoned").cancel.clone();
    // 已经推给客户端的内容：取消/出错时用它兜底，别把用户看到的答案抹掉
    let progress = Arc::new(std::sync::Mutex::new(String::new()));

    // 转发器：把 engine 的事件接进登记表（分配 seq、进 backlog、广播），顺带节流落库
    {
        let turn = turn.clone();
        let store = state.store.clone();
        let assistant = assistant_id.clone();
        let card = card_id.clone();
        let turn_ids = turn_ids.clone();
        let progress = progress.clone();
        let question = spec.text.clone();
        tokio::spawn(async move {
            let mut receiver = rx;
            let mut buffer = String::new();
            let mut last_write = Instant::now();
            while let Some(event) = receiver.recv().await {
                if let AgentEvent::Delta { text } = &event {
                    buffer.push_str(text);
                    if let Ok(mut guard) = progress.lock() {
                        guard.push_str(text);
                    }
                }
                {
                    let mut guard = turn.lock().expect("turn poisoned");
                    guard.emit(event);
                }
                if last_write.elapsed() > Duration::from_secs(2) {
                    last_write = Instant::now();
                    if let Some(id) = assistant.as_deref() {
                        let _ = store.update_message_text(id, &buffer);
                    } else {
                        if let Some((_, aid)) = turn_ids.as_ref() {
                            let _ = store.update_card_turn(aid, &buffer, "streaming");
                        }
                        if card_is_new {
                            if let Some(id) = card.as_ref() {
                                let _ = store.update_card(id.as_str(), &buffer, &question);
                            }
                        }
                    }
                }
            }
            let _ = buffer;
        });
    }

    // 执行器
    {
        let turn = turn.clone();
        let app: Arc<AppState> = state.clone();
        let state = app.clone();
        let provider = state.provider();
        let assistant = assistant_id.clone();
        let card = card_id.clone();
        let turn_ids = turn_ids.clone();
        let question = request.text.clone();
        let request = request.clone();
        let sender = tx.clone();
        let progress = progress.clone();

        tokio::spawn(async move {
            let outcome =
                agent::run_turn(provider.as_ref(), &request, &sender, cancel.clone()).await;
            let (final_state, mut text, error, usage, rounds) = match outcome {
                Ok(result) if result.cancelled => (
                    TurnState::Cancelled,
                    result.text,
                    None,
                    result.usage,
                    result.rounds,
                ),
                Ok(result) => (
                    TurnState::Ok,
                    result.text,
                    None,
                    result.usage,
                    result.rounds,
                ),
                Err(err) => (
                    TurnState::Error,
                    String::new(),
                    Some(err.to_string()),
                    Usage::default(),
                    0,
                ),
            };
            if text.is_empty() {
                if let Ok(partial) = progress.lock() {
                    text = partial.clone();
                }
            }

            if matches!(final_state, TurnState::Cancelled) {
                let mut guard = turn.lock().expect("turn poisoned");
                guard.emit(AgentEvent::Cancelled {
                    reason: "cancelled".into(),
                });
                guard.emit(AgentEvent::End);
            } else if let Some(message) = error.clone() {
                let mut guard = turn.lock().expect("turn poisoned");
                guard.emit(AgentEvent::Error { message });
                guard.emit(AgentEvent::End);
            } else {
                turn.lock().expect("turn poisoned").emit(AgentEvent::End);
            }

            let status = match final_state {
                TurnState::Ok => MessageStatus::Ok,
                TurnState::Cancelled => MessageStatus::Cancelled,
                _ => MessageStatus::Error,
            };
            if let Some(id) = assistant.as_deref() {
                let _ = state.store.set_message_status(id, status, Some(&text));
            }
            if let Some((_, aid)) = turn_ids.as_ref() {
                let turn_status = match final_state {
                    TurnState::Ok => "done",
                    TurnState::Cancelled => "aborted",
                    _ => "error",
                };
                let _ = state.store.update_card_turn(aid, &text, turn_status);
            }
            if card_is_new {
                if let Some(id) = card.as_ref() {
                    let _ = state.store.update_card(id.as_str(), &text, &question);
                }
            }
            let (turn_id, session_id) = {
                let guard = turn.lock().expect("turn poisoned");
                (guard.id.clone(), guard.session_id.clone())
            };
            let _ = state.store.add_turn_usage(
                &turn_id,
                &session_id,
                usage.prompt_tokens,
                usage.completion_tokens,
                rounds as u32,
            );
            state.registry.finish(&turn, final_state, error);
        });
    }

    let stream = turn_stream(&turn, 0);
    let (drop_guard, dropped) = oneshot::channel::<()>();
    {
        let turn = turn.clone();
        let app: Arc<AppState> = state.clone();
        tokio::spawn(async move {
            let _ = dropped.await;
            let guard = turn.lock().expect("turn poisoned");
            if guard.state == TurnState::Running {
                guard.cancel.cancel();
            }
            drop(guard);
            app.registry.sweep_now();
        });
    }

    Ok(StartedTurn {
        turn,
        stream,
        drop_guard,
    })
}

fn respond_with_turn(started: StartedTurn) -> Response {
    let StartedTurn {
        turn,
        stream,
        drop_guard,
    } = started;
    let (turn_id, session_id) = {
        let guard = turn.lock().expect("turn poisoned");
        (guard.id.clone(), guard.session_id.clone())
    };

    // 连接断开即取消：客户端走了没人要结果，别继续烧 key
    let stream = stream.map(move |item| {
        let _keep_alive = &drop_guard;
        item
    });

    let mut response = Sse::new(stream)
        .keep_alive(axum::response::sse::KeepAlive::default())
        .into_response();
    if let Ok(value) = header::HeaderValue::from_str(&turn_id) {
        response.headers_mut().insert("x-deck-turn", value);
    }
    if let Ok(value) = header::HeaderValue::from_str(&session_id) {
        response.headers_mut().insert("x-deck-session", value);
    }
    response
}

#[derive(Debug, Deserialize)]
struct ChatBody {
    session_id: String,
    #[serde(default = "default_mode")]
    mode: String,
    text: String,
    anchor: Option<Anchor>,
    depth: Option<String>,
    card_id: Option<String>,
    #[serde(default)]
    card_history: Option<String>,
    /// 卡片模板 id（不传 = 当前默认模板）
    profile_id: Option<String>,
    /// 档位 id（不传 = 模板默认档）
    level: Option<String>,
    /// 在哪张卡的文字上展开（嵌套）；不传 = 从主线消息展开
    parent_card_id: Option<String>,
    /// 父卡的回答文本（账本命中卡没有 card 记录时靠它给上下文）
    parent_text: Option<String>,
    /// 回答语言（zh/en）
    locale: Option<String>,
}

fn default_mode() -> String {
    "main".into()
}

async fn chat(State(state): State<Arc<AppState>>, Json(body): Json<ChatBody>) -> Response {
    let Ok(Some(_session)) = state.store.get_session(&body.session_id) else {
        return api_error(StatusCode::NOT_FOUND, "session not found");
    };
    if body.text.trim().is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "text 不能为空");
    }

    let mode = if body.mode == "card" {
        Mode::Card
    } else {
        Mode::Main
    };
    let spec = TurnSpec {
        session_id: body.session_id.into(),
        mode,
        text: body.text,
        anchor: body.anchor,
        depth: body.depth.as_deref().and_then(Depth::parse),
        card_id: body.card_id,
        card_history: body.card_history,
        project_root: None,
        profile_id: body.profile_id,
        level: body.level,
        nest_from: body.parent_card_id,
        nest_text: body.parent_text,
        locale: body.locale,
    };
    match begin_turn(&state, spec) {
        Ok(started) => respond_with_turn(started),
        Err(response) => response,
    }
}

#[derive(Debug, Deserialize)]
struct ResolveQuery {
    cwd: String,
}

async fn resolve_session_cwd(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ResolveQuery>,
) -> Response {
    let cwd = query.cwd.trim();
    if cwd.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "cwd 不能为空");
    }
    match state.store.resolve_cwd(cwd) {
        Ok(Some(session)) => {
            let topic = state
                .store
                .topic_for_session(session.id.as_str())
                .ok()
                .flatten();
            Json(json!({
                "cwd": cwd,
                "session_id": session.id,
                "title": session.title,
                "topic": topic,
            }))
            .into_response()
        }
        Ok(None) => Json(json!({
            "cwd": cwd,
            "session_id": null,
            "title": null,
            "topic": null,
        }))
        .into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct AskBody {
    text: String,
    cwd: Option<String>,
    /// 显式指定会话；不传时按 cwd 的 ask_sessions 映射。
    session_id: Option<String>,
}

async fn ask(State(state): State<Arc<AppState>>, Json(body): Json<AskBody>) -> Response {
    if body.text.trim().is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "text 不能为空");
    }
    let cwd = body
        .cwd
        .clone()
        .or_else(|| extract_cwd(&body.text))
        .unwrap_or_else(|| "inbox".to_string());

    let session = if let Some(session_id) = body.session_id.as_deref() {
        match state.store.get_session(session_id) {
            Ok(Some(session)) => session,
            Ok(None) => return api_error(StatusCode::NOT_FOUND, "session not found"),
            Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
        }
    } else {
        match state.store.session_for_cwd(&cwd) {
            Ok(session) => session,
            Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
        }
    };

    let spec = TurnSpec {
        session_id: session.id,
        mode: Mode::Main,
        text: body.text,
        anchor: None,
        depth: None,
        card_id: None,
        card_history: None,
        project_root: if cwd == "inbox" {
            None
        } else {
            Some(PathBuf::from(cwd))
        },
        profile_id: None,
        level: None,
        nest_from: None,
        nest_text: None,
        locale: None,
    };
    match begin_turn(&state, spec) {
        Ok(started) => respond_with_turn(started),
        Err(response) => response,
    }
}

fn extract_cwd(text: &str) -> Option<String> {
    text.lines()
        .find_map(|line| line.strip_prefix("cwd: "))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

// ---------- 轮次 ----------

#[derive(Debug, Deserialize)]
struct TurnsQuery {
    active: Option<u8>,
}

async fn list_turns(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TurnsQuery>,
) -> impl IntoResponse {
    state.registry.sweep_now();
    let turns: Vec<TurnView> = state.registry.list(query.active.unwrap_or(0) == 1);
    Json(json!({ "turns": turns }))
}

async fn get_turn(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    match state.registry.get(&id) {
        Some(turn) => {
            let guard = turn.lock().expect("turn poisoned");
            Json(json!(TurnView {
                id: guard.id.clone(),
                session_id: guard.session_id.clone(),
                state: guard.state,
                seq: guard.seq,
                started_at: guard.started_at,
                finished_at: guard.finished_at,
                question: guard.question.clone(),
                error: guard.error.clone(),
                message_id: guard.message_id.clone(),
            }))
            .into_response()
        }
        None => api_error(StatusCode::NOT_FOUND, "turn not found"),
    }
}

#[derive(Debug, Deserialize)]
struct EventsQuery {
    since: Option<u64>,
}

async fn turn_events(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<EventsQuery>,
    headers: axum::http::HeaderMap,
) -> Response {
    let Some(turn) = state.registry.get(&id) else {
        return api_error(StatusCode::NOT_FOUND, "turn not found");
    };
    let since = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .or(query.since)
        .unwrap_or(0);

    Sse::new(turn_stream(&turn, since))
        .keep_alive(axum::response::sse::KeepAlive::default())
        .into_response()
}

async fn cancel_turn(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    if state.registry.cancel(&id) {
        Json(json!({ "ok": true, "state": "cancelling" })).into_response()
    } else {
        api_error(StatusCode::NOT_FOUND, "turn not running")
    }
}

// ---------- 账本 ----------

async fn list_glossary(
    State(state): State<Arc<AppState>>,
    Query(query): Query<GlossaryQuery>,
) -> impl IntoResponse {
    let limit = query.limit.unwrap_or(100).min(500);
    match state.store.search_entries(query.q.as_deref(), limit) {
        Ok(entries) => Json(json!({ "entries": entries })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct GlossaryQuery {
    q: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct GlossaryBody {
    term: String,
    gist: String,
    anchor: Option<Anchor>,
    session_id: Option<String>,
    profile_id: Option<String>,
    level: Option<String>,
    /// 若是在某张卡上展开的，记下父卡
    parent_card_id: Option<String>,
    /// 这条结论来自哪张卡（用于路径/关系图）
    card_id: Option<String>,
}

async fn add_glossary(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GlossaryBody>,
) -> impl IntoResponse {
    let session_id = body.session_id.map(SessionId::from);
    // 账本条目是「概念」，不是一整段话：取第一行并裁到 40 字
    let raw = body.term.trim();
    let first_line = raw.lines().next().unwrap_or("").trim();
    let term: String = if first_line.chars().count() > 40 {
        first_line.chars().take(40).collect()
    } else {
        first_line.to_string()
    };
    if term.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "term 不能为空");
    }
    // 账本按卡片的领域归属，而不是当前全局默认模板；否则跨领域会记错范式/档位。
    let mut profile_id = body.profile_id.clone();
    let mut level = body.level.clone();
    if let Some(card_id) = body.card_id.as_deref() {
        if let Ok(Some(card)) = state.store.card_by_id(card_id) {
            profile_id = card.profile_id.clone();
            level = card.level.clone();
        }
    }
    match state.store.record_encounter(
        &term,
        &body.gist,
        profile_id.as_deref(),
        level.as_deref(),
        body.anchor.as_ref(),
        session_id.as_ref(),
        body.parent_card_id.as_deref(),
        body.card_id.as_deref(),
    ) {
        Ok(()) => match state.store.match_entry(&term).ok().flatten() {
            Some(entry) => (StatusCode::CREATED, Json(json!(entry))).into_response(),
            None => (StatusCode::CREATED, Json(json!({ "ok": true }))).into_response(),
        },
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct GlossaryMatchQuery {
    term: String,
}

async fn match_glossary(
    State(state): State<Arc<AppState>>,
    Query(query): Query<GlossaryMatchQuery>,
) -> impl IntoResponse {
    match state.store.match_entry(&query.term) {
        Ok(Some(entry)) => Json(json!({ "entry": entry })).into_response(),
        Ok(None) => Json(json!({ "entry": null })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct GlossaryUpdate {
    gist: Option<String>,
    depth: Option<String>,
    mastery: Option<String>,
}

async fn update_glossary(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<GlossaryUpdate>,
) -> impl IntoResponse {
    let depth = body.depth.as_deref().and_then(Depth::parse);
    let mastery = body.mastery.as_deref().and_then(Mastery::parse);
    match state
        .store
        .update_entry(&id, body.gist.as_deref(), depth, mastery)
    {
        Ok(()) => match state.store.all_entries() {
            Ok(entries) => {
                let found = entries.into_iter().find(|entry| entry.id.as_str() == id);
                Json(json!({ "entry": found })).into_response()
            }
            Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
        },
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn delete_glossary(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    match state.store.delete_entry(&id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct MergeBody {
    target: String,
    sources: Vec<String>,
}

async fn storage_stats(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.store.storage_counts() {
        Ok(counts) => Json(json!({ "ok": true, "counts": counts })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn maintain_storage(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    // VACUUM 会长时间持有全局 sqlite 锁：扔到阻塞线程池，别卡住 tokio worker
    let store = state.store.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let report = store.maintain(true)?;
        let counts = store.storage_counts()?;
        Ok((report, counts))
    })
    .await;
    match result {
        Ok(Ok((report, counts))) => {
            Json(json!({ "ok": true, "report": report, "counts": counts })).into_response()
        }
        Ok(Err(err)) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

/// 把线程压成给模型看的上下文；只用于续写，不落库。
fn thread_history(turns: &[CardTurn]) -> String {
    let mut out = String::new();
    for turn in turns {
        match turn.role {
            TurnRole::User => {
                out.push_str("\n\n【追问】\n");
                out.push_str(turn.text.trim());
            }
            TurnRole::Assistant => {
                out.push_str("\n\n【");
                out.push_str(if out.is_empty() { "解释" } else { "回答" });
                out.push_str("】\n");
                out.push_str(turn.text.trim());
            }
        }
        out.push('\n');
    }
    out
}

async fn card_detail(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    match state.store.card_by_id(&id) {
        Ok(None) => api_error(StatusCode::NOT_FOUND, "卡片不存在").into_response(),
        Ok(Some(card)) => match state.store.ensure_card_turns(&card) {
            Ok(turns) => Json(json!({ "card": card, "turns": turns })).into_response(),
            Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
        },
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn delete_card(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    match state.store.card_by_id(&id) {
        Ok(None) => api_error(StatusCode::NOT_FOUND, "卡片不存在").into_response(),
        Ok(Some(_)) => match state.store.delete_card_tree(&id) {
            Ok(removed) => Json(json!({ "ok": true, "removed": removed })).into_response(),
            Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
        },
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn merge_glossary(
    State(state): State<Arc<AppState>>,
    Json(body): Json<MergeBody>,
) -> impl IntoResponse {
    match state.store.merge_entries(&body.target, &body.sources) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    q: String,
    limit: Option<usize>,
}

async fn search_messages(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SearchQuery>,
) -> impl IntoResponse {
    if query.q.trim().is_empty() {
        return Json(json!({ "hits": [] })).into_response();
    }
    match state
        .store
        .search_messages(&query.q, query.limit.unwrap_or(30).min(100))
    {
        Ok(hits) => Json(json!({ "hits": hits })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct ExportQuery {
    format: Option<String>,
}

async fn export_glossary(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ExportQuery>,
) -> Response {
    let entries = match state.store.all_entries() {
        Ok(entries) => entries,
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    };

    let format = query.format.unwrap_or_else(|| "md".into());
    if format == "json" {
        let body = serde_json::to_string_pretty(&entries).unwrap_or_else(|_| "[]".into());
        return (
            [
                (
                    header::CONTENT_TYPE,
                    "application/json; charset=utf-8".to_string(),
                ),
                (
                    header::CONTENT_DISPOSITION,
                    "attachment; filename=\"studydeck-glossary.json\"".to_string(),
                ),
            ],
            body,
        )
            .into_response();
    }

    let mut out = String::from("# StudyDeck 账本\n\n");
    out.push_str(&format!(
        "导出时间：{}\n\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M")
    ));
    for entry in &entries {
        out.push_str(&format!(
            "## {}\n\n- 深度：{}\n- 掌握：{}\n- 记录：{}\n",
            entry.term,
            entry.depth.label_cn(),
            entry.mastery.label_cn(),
            entry
                .created_at
                .with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
        ));
        if let Some(anchor) = &entry.source_anchor {
            out.push_str(&format!(
                "- 来源：`{}`\n",
                anchor.quote.lines().next().unwrap_or("")
            ));
        }
        out.push_str(&format!("\n{}\n\n", entry.gist));
    }

    (
        [
            (
                header::CONTENT_TYPE,
                "text/markdown; charset=utf-8".to_string(),
            ),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"studydeck-glossary.md\"".to_string(),
            ),
        ],
        out,
    )
        .into_response()
}

// ---------- 卡片模板 ----------

fn valid_profile(profile: &CardProfile) -> std::result::Result<(), String> {
    if profile.label.trim().is_empty() {
        return Err("模板名不能为空".into());
    }
    if profile.levels.is_empty() {
        return Err("至少要有一个档位".into());
    }
    if profile.levels.len() > 9 {
        return Err("最多 9 个档位".into());
    }
    let mut seen = std::collections::HashSet::new();
    for level in &profile.levels {
        let id = level.id.trim();
        if id.is_empty()
            || !id
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_')
        {
            return Err(format!("档位 id 只能用小写字母/数字/-/_：{}", level.label));
        }
        if !seen.insert(id.to_string()) {
            return Err(format!("档位 id 重复：{id}"));
        }
        if level.label.trim().is_empty() {
            return Err("档位名不能为空".into());
        }
    }
    Ok(())
}

async fn list_profiles(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(json!({
        "active": state.profiles.active_id(),
        "profiles": state.profiles.list(),
    }))
}

#[derive(Debug, Deserialize)]
struct ProfileCreate {
    from: Option<String>,
    label: Option<String>,
}

async fn create_profile(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProfileCreate>,
) -> impl IntoResponse {
    let base = body
        .from
        .as_deref()
        .and_then(|id| state.profiles.get(id))
        .or_else(|| state.profiles.active())
        .unwrap_or_else(CardProfile::builtin_tech);

    let label = body
        .label
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("{} 副本", base.label));

    let mut profile = base;
    profile.id = state.profiles.unique_id(&label);
    profile.label = label;

    if let Err(err) = state.profiles.save(&profile) {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }
    (StatusCode::CREATED, Json(json!(profile))).into_response()
}

async fn update_profile(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(mut body): Json<CardProfile>,
) -> impl IntoResponse {
    if state.profiles.get(&id).is_none() {
        return api_error(StatusCode::NOT_FOUND, "模板不存在");
    }
    body.id = id;
    if let Err(err) = valid_profile(&body) {
        return api_error(StatusCode::BAD_REQUEST, err);
    }
    if let Err(err) = state.profiles.save(&body) {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }
    Json(json!(body)).into_response()
}

async fn delete_profile(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    if state.profiles.active_id() == id {
        return api_error(StatusCode::CONFLICT, "不能删除当前默认模板");
    }
    if state.profiles.list().len() <= 1 {
        return api_error(StatusCode::CONFLICT, "至少要保留一个模板");
    }
    match state.profiles.delete(&id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => api_error(StatusCode::NOT_FOUND, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct ActiveProfileBody {
    id: String,
}

async fn set_active_profile(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ActiveProfileBody>,
) -> impl IntoResponse {
    match state.profiles.set_active(&body.id) {
        Ok(()) => Json(json!({ "active": body.id })).into_response(),
        Err(err) => api_error(StatusCode::NOT_FOUND, err.to_string()),
    }
}

async fn entry_detail(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    let entry = match state.store.all_entries() {
        Ok(entries) => entries.into_iter().find(|entry| entry.id.as_str() == id),
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    };
    let Some(entry) = entry else {
        return api_error(StatusCode::NOT_FOUND, "entry not found");
    };
    let encounters = match state.store.entry_encounters(&id) {
        Ok(encounters) => encounters,
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    };
    let path = state
        .store
        .entry_path(&id)
        .unwrap_or_default()
        .into_iter()
        .map(|card| {
            json!({
                "id": card.id,
                "quote": card.anchor.quote,
                "question": card.question,
                "depth": card.stack_depth,
            })
        })
        .collect::<Vec<_>>();
    let (parents, children) = state.store.entry_relations(&id).unwrap_or_default();
    let all = state.store.all_entries().unwrap_or_default();
    let brief = |ids: Vec<String>| -> Vec<serde_json::Value> {
        ids.into_iter()
            .filter_map(|entry_id| {
                all.iter()
                    .find(|item| item.id.as_str() == entry_id)
                    .map(|item| json!({ "id": item.id, "term": item.term }))
            })
            .collect()
    };

    Json(json!({
        "entry": entry,
        "encounters": encounters,
        "path": path,
        "parents": brief(parents),
        "children": brief(children),
    }))
    .into_response()
}

async fn due_reviews(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.store.due_entries(50) {
        Ok(entries) => Json(json!({ "entries": entries })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct ReviewBody {
    remembered: bool,
}

async fn review_entry(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<ReviewBody>,
) -> impl IntoResponse {
    match state.store.review_entry(&id, body.remembered) {
        Ok(Some(entry)) => Json(json!(entry)).into_response(),
        Ok(None) => api_error(StatusCode::NOT_FOUND, "entry not found"),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn api_error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}
