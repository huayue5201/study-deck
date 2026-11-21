//! 一轮对话的登记表：它是 cancel / replay / 外部观察（nvim）共同的地基。
//!
//! 之前"这一轮有没有结束"只编码在一条 HTTP 连接的存亡里——连接一断，
//! 谁都不知道它跑完了还是挂了。这里把状态搬到进程里，并落一份终态到 DB。

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::{DateTime, Utc};
use serde::Serialize;
use studydeck_core::AgentEvent;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

/// 单轮事件缓冲上限：溢出丢最老的。delta 本来就不能拼接重放，丢了不心疼。
const BACKLOG_CAP: usize = 2000;
/// 完成态在内存里保留多久（之后只靠 DB 的 messages.status）。
const RETAIN: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnState {
    Running,
    Ok,
    Error,
    Cancelled,
}

impl TurnState {
    pub fn as_str(&self) -> &'static str {
        match self {
            TurnState::Running => "running",
            TurnState::Ok => "ok",
            TurnState::Error => "error",
            TurnState::Cancelled => "cancelled",
        }
    }
}

pub struct Turn {
    pub id: String,
    pub session_id: String,
    pub state: TurnState,
    pub seq: u64,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub question: String,
    pub error: Option<String>,
    pub message_id: Option<String>,
    pub cancel: CancellationToken,
    backlog: VecDeque<(u64, AgentEvent)>,
    bus: broadcast::Sender<(u64, AgentEvent)>,
}

impl Turn {
    fn new(id: String, session_id: String, question: String) -> Self {
        let (bus, _) = broadcast::channel(256);
        Self {
            id,
            session_id,
            state: TurnState::Running,
            seq: 0,
            started_at: Utc::now(),
            finished_at: None,
            question,
            error: None,
            message_id: None,
            cancel: CancellationToken::new(),
            backlog: VecDeque::with_capacity(64),
            bus,
        }
    }

    /// 记一条事件并广播，返回它的序号。
    pub fn emit(&mut self, event: AgentEvent) -> u64 {
        self.seq += 1;
        let seq = self.seq;
        if self.backlog.len() >= BACKLOG_CAP {
            self.backlog.pop_front();
        }
        self.backlog.push_back((seq, event.clone()));
        let _ = self.bus.send((seq, event));
        seq
    }

    pub fn subscribe(&self) -> broadcast::Receiver<(u64, AgentEvent)> {
        self.bus.subscribe()
    }

    pub fn backlog_since(&self, since: u64) -> Vec<(u64, AgentEvent)> {
        self.backlog
            .iter()
            .filter(|(seq, _)| *seq > since)
            .cloned()
            .collect()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TurnView {
    pub id: String,
    pub session_id: String,
    pub state: TurnState,
    pub seq: u64,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub question: String,
    pub error: Option<String>,
    pub message_id: Option<String>,
}

/// 进程内的轮次登记表 + 每会话的互斥（同一会话不允许两条腿同时跑）。
#[derive(Default)]
pub struct Registry {
    turns: Mutex<HashMap<String, Arc<Mutex<Turn>>>>,
    active: Mutex<HashMap<String, String>>,
}

impl Registry {
    pub fn open(&self, session_id: &str, question: &str) -> Result<Arc<Mutex<Turn>>, String> {
        let mut active = self.active.lock().expect("active poisoned");
        if let Some(existing) = active.get(session_id) {
            let running = self
                .turns
                .lock()
                .expect("turns poisoned")
                .get(existing)
                .map(|turn| turn.lock().expect("turn poisoned").state == TurnState::Running)
                .unwrap_or(false);
            if running {
                return Err(existing.clone());
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let turn = Arc::new(Mutex::new(Turn::new(id.clone(), session_id.to_string(), question.to_string())));
        self.turns.lock().expect("turns poisoned").insert(id.clone(), turn.clone());
        active.insert(session_id.to_string(), id);
        Ok(turn)
    }

    pub fn get(&self, id: &str) -> Option<Arc<Mutex<Turn>>> {
        self.turns.lock().expect("turns poisoned").get(id).cloned()
    }

    pub fn sweep_now(&self) {
        self.sweep();
    }

    /// 终止：写终态、释放会话、安排清理。
    pub fn finish(&self, turn: &Arc<Mutex<Turn>>, state: TurnState, error: Option<String>) {
        let (id, session_id) = {
            let mut guard = turn.lock().expect("turn poisoned");
            guard.state = state;
            guard.finished_at = Some(Utc::now());
            guard.error = error;
            (guard.id.clone(), guard.session_id.clone())
        };
        self.active.lock().expect("active poisoned").remove(&session_id);

        let _ = id;
    }

    pub fn cancel(&self, id: &str) -> bool {
        match self.get(id) {
            Some(turn) => {
                let guard = turn.lock().expect("turn poisoned");
                if guard.state != TurnState::Running {
                    return false;
                }
                guard.cancel.cancel();
                true
            }
            None => false,
        }
    }

    pub fn list(&self, only_active: bool) -> Vec<TurnView> {
        let turns: Vec<_> = {
            let map = self.turns.lock().expect("turns poisoned");
            map.values().cloned().collect()
        };
        let mut out: Vec<TurnView> = turns
            .iter()
            .filter_map(|turn| {
                let guard = turn.lock().ok()?;
                if only_active && guard.state != TurnState::Running {
                    return None;
                }
                Some(TurnView {
                    id: guard.id.clone(),
                    session_id: guard.session_id.clone(),
                    state: guard.state,
                    seq: guard.seq,
                    started_at: guard.started_at,
                    finished_at: guard.finished_at,
                    question: guard.question.clone(),
                    error: guard.error.clone(),
                    message_id: guard.message_id.clone(),
                })
            })
            .collect();
        out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        out
    }

    /// 清理过了保留期的完成轮次。
    pub fn sweep(&self) {
        let now = Utc::now();
        let mut map = self.turns.lock().expect("turns poisoned");
        map.retain(|_, turn| {
            let guard = match turn.lock() {
                Ok(guard) => guard,
                Err(_) => return false,
            };
            match guard.finished_at {
                None => true,
                Some(done) => (now - done).to_std().unwrap_or_default() < RETAIN,
            }
        });
    }
}
