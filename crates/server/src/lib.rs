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
    AgentEvent, Anchor, Card, CardId, Depth, GlossaryEntry, Mastery, Message, MessageStatus, Mode,
    SessionId, TurnRequest,
};
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::BroadcastStream;
use tokio_util::sync::CancellationToken;

mod secrets;
mod settings;
mod turn;

use turn::{Registry, Turn, TurnState, TurnView};

pub use settings::{presets, Settings, SettingsStore, SettingsView};

/// 能力自述：外部客户端据此做降级，而不是 try-and-fail。
pub const API_VERSION: u32 = 2;
pub const CAPS: &[&str] = &["turns", "events", "cancel", "sessions", "glossary", "export", "token"];

#[derive(rust_embed::RustEmbed)]
#[folder = "../../apps/web/dist"]
struct Assets;

struct AppState {
    store: Arc<Store>,
    data_dir: PathBuf,
    settings: SettingsStore,
    provider: RwLock<Arc<dyn Provider>>,
    registry: Registry,
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

pub fn init_tracing(log_dir: Option<PathBuf>) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
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

    let state = Arc::new(AppState {
        store: Arc::new(store),
        data_dir: data_dir.clone(),
        settings: settings_store,
        provider: RwLock::new(provider),
        registry: Registry::default(),
        token,
    });

    let token_for_auth = state.clone();
    let protected = Router::new()
        .route("/api/providers", get(provider_presets))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/settings/test", post(test_connection))
        .route("/api/settings/key", axum::routing::delete(clear_key))
        .route("/api/sessions", get(list_sessions).post(create_session))
        .route("/api/sessions/{id}", get(get_session).delete(delete_session))
        .route("/api/sessions/{id}/meta", axum::routing::patch(rename_session))
        .route("/api/chat", post(chat))
        .route("/api/ask", post(ask))
        .route("/api/turns", get(list_turns))
        .route("/api/turns/{id}", get(get_turn))
        .route("/api/turns/{id}/events", get(turn_events))
        .route("/api/turns/{id}/cancel", post(cancel_turn))
        .route("/api/glossary", get(list_glossary).post(add_glossary))
        .route("/api/glossary/match", get(match_glossary))
        .route("/api/glossary/merge", post(merge_glossary))
        .route("/api/glossary/{id}", axum::routing::delete(delete_glossary).put(update_glossary))
        .route("/api/search", get(search_messages))
        .route("/api/export", get(export_glossary))
        .route_layer(middleware::from_fn_with_state(token_for_auth, require_token));

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
        api_error(StatusCode::UNAUTHORIZED, "缺少或错误的 Bearer token（见数据目录的 port 文件）")
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

    let settings = Settings {
        provider: body.provider,
        base_url,
        model,
        configured: true,
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
    match provider.chat_stream(request, tx, CancellationToken::new()).await {
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
    let _ = state.settings.save(&Settings { configured: false, ..settings });
    state.rebuild_provider();
    Json(state.view())
}

// ---------- 会话 ----------

async fn create_session(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.store.create_session() {
        Ok(session) => Json(json!({ "id": session.id })).into_response(),
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
    Json(json!({
        "id": session.id,
        "messages": messages,
        "cards": cards,
        "active_turn": state.registry.list(true).into_iter()
            .find(|turn| turn.session_id == id)
            .map(|turn| turn.id),
    }))
    .into_response()
}

async fn list_sessions(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.store.recent_sessions(30) {
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
fn turn_stream(turn: &Arc<std::sync::Mutex<Turn>>, since: u64) -> Pin<Box<dyn futures_util::Stream<Item = Result<Event, Infallible>> + Send>> {
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
fn take_through_end<S>(inner: S) -> Pin<Box<dyn futures_util::Stream<Item = Result<Event, Infallible>> + Send>>
where
    S: futures_util::Stream<Item = (bool, Result<Event, Infallible>)> + Send + 'static,
{
    struct State<S> {
        inner: Pin<Box<S>>,
        done: bool,
    }
    Box::pin(stream::unfold(
        State { inner: Box::pin(inner), done: false },
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

    // 卡片模式只有卡记录；主线模式建 user + assistant 两行
    let (assistant_id, card_id) = match spec.mode {
        Mode::Main => {
            let mut user = Message::user(&spec.session_id, spec.text.clone());
            let mut assistant = Message::assistant(&spec.session_id, "");
            user.turn_id = Some(turn.lock().expect("turn poisoned").id.clone());
            assistant.turn_id = user.turn_id.clone();
            assistant.status = MessageStatus::Running;
            if let Err(err) = state.store.add_message(&user) {
                state.registry.finish(&turn, TurnState::Error, Some(err.to_string()));
                return Err(api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()));
            }
            if let Err(err) = state.store.add_message(&assistant) {
                return Err(api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()));
            }
            (Some(assistant.id.0.clone()), None)
        }
        Mode::Card => {
            let anchor = spec.anchor.clone().unwrap_or_else(|| {
                Anchor::new(studydeck_core::MessageId("unknown".into()), 0, 0, spec.text.clone())
            });
            let card = Card {
                id: CardId::new(),
                session_id: spec.session_id.clone(),
                anchor,
                depth: spec.depth.unwrap_or_default(),
                question: spec.text.clone(),
                answer: String::new(),
                created_at: Utc::now(),
            };
            if let Err(err) = state.store.add_card(&card) {
                return Err(api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()));
            }
            (None, Some(card.id))
        }
    };

    let parent_card = spec.card_id.as_ref().and_then(|id| {
        state
            .store
            .cards(&session_key)
            .ok()
            .and_then(|cards| cards.into_iter().find(|card| card.id.as_str() == id.as_str()))
    });
    let request = TurnRequest {
        mode: spec.mode,
        text: spec.text.clone(),
        anchor: spec.anchor.clone(),
        depth: spec.depth,
        parent_card,
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
        guard.emit(AgentEvent::TurnStarted { turn_id, session_id });
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
                    } else if let Some(id) = card.as_ref() {
                        let _ = store.update_card(id.as_str(), &buffer, &question);
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
        let question = request.text.clone();
        let request = request.clone();
        let sender = tx.clone();
        let progress = progress.clone();

        tokio::spawn(async move {
            let outcome = agent::run_turn(provider.as_ref(), &request, &sender, cancel.clone()).await;
            let (final_state, mut text, error) = match outcome {
                Ok(result) if result.cancelled => (TurnState::Cancelled, result.text, None),
                Ok(result) => (TurnState::Ok, result.text, None),
                Err(err) => (TurnState::Error, String::new(), Some(err.to_string())),
            };
            if text.is_empty() {
                if let Ok(partial) = progress.lock() {
                    text = partial.clone();
                }
            }

            if matches!(final_state, TurnState::Cancelled) {
                let mut guard = turn.lock().expect("turn poisoned");
                guard.emit(AgentEvent::Cancelled { reason: "cancelled".into() });
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
            if let Some(id) = card.as_ref() {
                let _ = state.store.update_card(id.as_str(), &text, &question);
            }
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

    Ok(StartedTurn { turn, stream, drop_guard })
}

fn respond_with_turn(started: StartedTurn) -> Response {
    let StartedTurn { turn, stream, drop_guard } = started;
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

    let mode = if body.mode == "card" { Mode::Card } else { Mode::Main };
    let spec = TurnSpec {
        session_id: body.session_id.into(),
        mode,
        text: body.text,
        anchor: body.anchor,
        depth: body.depth.as_deref().and_then(Depth::parse),
        card_id: body.card_id,
    };
    match begin_turn(&state, spec) {
        Ok(started) => respond_with_turn(started),
        Err(response) => response,
    }
}

#[derive(Debug, Deserialize)]
struct AskBody {
    text: String,
    cwd: Option<String>,
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

    let session = match state.store.session_for_cwd(&cwd) {
        Ok(session) => session,
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    };

    let spec = TurnSpec {
        session_id: session.id,
        mode: Mode::Main,
        text: body.text,
        anchor: None,
        depth: None,
        card_id: None,
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

async fn list_turns(State(state): State<Arc<AppState>>, Query(query): Query<TurnsQuery>) -> impl IntoResponse {
    state.registry.sweep_now();
    let turns: Vec<TurnView> = state.registry.list(query.active.unwrap_or(0) == 1);
    Json(json!({ "turns": turns }))
}

async fn get_turn(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> impl IntoResponse {
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

async fn cancel_turn(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> impl IntoResponse {
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
    depth: Option<String>,
    anchor: Option<Anchor>,
    session_id: Option<String>,
    mastery: Option<String>,
}

async fn add_glossary(State(state): State<Arc<AppState>>, Json(body): Json<GlossaryBody>) -> impl IntoResponse {
    let mut entry = GlossaryEntry::new(
        body.term,
        body.gist,
        body.depth.as_deref().and_then(Depth::parse).unwrap_or_default(),
        body.anchor,
    );
    entry.session_id = body.session_id.map(SessionId::from);
    entry.mastery = body.mastery.as_deref().and_then(Mastery::parse).unwrap_or_default();
    match state.store.insert_entry(&entry) {
        Ok(()) => (StatusCode::CREATED, Json(json!(entry))).into_response(),
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
    match state.store.update_entry(&id, body.gist.as_deref(), depth, mastery) {
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

async fn delete_glossary(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> impl IntoResponse {
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

async fn merge_glossary(State(state): State<Arc<AppState>>, Json(body): Json<MergeBody>) -> impl IntoResponse {
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

async fn search_messages(State(state): State<Arc<AppState>>, Query(query): Query<SearchQuery>) -> impl IntoResponse {
    if query.q.trim().is_empty() {
        return Json(json!({ "hits": [] })).into_response();
    }
    match state.store.search_messages(&query.q, query.limit.unwrap_or(30).min(100)) {
        Ok(hits) => Json(json!({ "hits": hits })).into_response(),
        Err(err) => api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct ExportQuery {
    format: Option<String>,
}

async fn export_glossary(State(state): State<Arc<AppState>>, Query(query): Query<ExportQuery>) -> Response {
    let entries = match state.store.all_entries() {
        Ok(entries) => entries,
        Err(err) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    };

    let format = query.format.unwrap_or_else(|| "md".into());
    if format == "json" {
        let body = serde_json::to_string_pretty(&entries).unwrap_or_else(|_| "[]".into());
        return (
            [
                (header::CONTENT_TYPE, "application/json; charset=utf-8".to_string()),
                (header::CONTENT_DISPOSITION, "attachment; filename=\"studydeck-glossary.json\"".to_string()),
            ],
            body,
        )
            .into_response();
    }

    let mut out = String::from("# StudyDeck 账本\n\n");
    out.push_str(&format!("导出时间：{}\n\n", chrono::Local::now().format("%Y-%m-%d %H:%M")));
    for entry in &entries {
        out.push_str(&format!(
            "## {}\n\n- 深度：{}\n- 掌握：{}\n- 记录：{}\n",
            entry.term,
            entry.depth.label_cn(),
            entry.mastery.label_cn(),
            entry.created_at.with_timezone(&chrono::Local).format("%Y-%m-%d")
        ));
        if let Some(anchor) = &entry.source_anchor {
            out.push_str(&format!("- 来源：`{}`\n", anchor.quote.lines().next().unwrap_or("")));
        }
        out.push_str(&format!("\n{}\n\n", entry.gist));
    }

    (
        [
            (header::CONTENT_TYPE, "text/markdown; charset=utf-8".to_string()),
            (header::CONTENT_DISPOSITION, "attachment; filename=\"studydeck-glossary.md\"".to_string()),
        ],
        out,
    )
        .into_response()
}

fn api_error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}
