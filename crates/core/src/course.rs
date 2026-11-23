use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ids::{CourseId, CourseItemId, TopicId};

fn empty_metadata() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

/// 课程：一组有顺序的专题。课表是课程条目的日期和状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Course {
    pub id: CourseId,
    pub title: String,
    pub goal: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// 每天可投入的学习分钟数。
    #[serde(default = "default_daily_minutes")]
    pub daily_minutes: i64,
    /// ISO 星期几，逗号分隔，1=周一；默认工作日。
    #[serde(default = "default_study_days")]
    pub study_days: String,
    pub created_at: DateTime<Utc>,
    #[serde(default = "empty_metadata")]
    pub metadata: serde_json::Value,
}

impl Course {
    pub fn new(title: impl Into<String>, goal: impl Into<String>) -> Self {
        Self {
            id: CourseId::new(),
            title: title.into(),
            goal: goal.into(),
            start_date: None,
            end_date: None,
            daily_minutes: default_daily_minutes(),
            study_days: default_study_days(),
            created_at: Utc::now(),
            metadata: empty_metadata(),
        }
    }
}

fn default_daily_minutes() -> i64 {
    60
}

fn default_study_days() -> String {
    "1,2,3,4,5".into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CourseItemStatus {
    Planned,
    Learning,
    Done,
}

impl CourseItemStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            CourseItemStatus::Planned => "planned",
            CourseItemStatus::Learning => "learning",
            CourseItemStatus::Done => "done",
        }
    }

    pub fn label_cn(&self) -> &'static str {
        match self {
            CourseItemStatus::Planned => "未开始",
            CourseItemStatus::Learning => "在学",
            CourseItemStatus::Done => "已完成",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "planned" => Some(CourseItemStatus::Planned),
            "learning" => Some(CourseItemStatus::Learning),
            "done" => Some(CourseItemStatus::Done),
            _ => None,
        }
    }
}

impl Default for CourseItemStatus {
    fn default() -> Self {
        CourseItemStatus::Planned
    }
}

/// 课程条目：一个专题在课程中的位置、计划和状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CourseItem {
    pub id: CourseItemId,
    pub course_id: CourseId,
    pub topic_id: TopicId,
    pub position: i64,
    pub planned_at: Option<String>,
    pub status: CourseItemStatus,
    pub note: String,
    /// 预计学习分钟数，自动排期用。
    #[serde(default = "default_daily_minutes")]
    pub estimated_minutes: i64,
    pub created_at: DateTime<Utc>,
    #[serde(default = "empty_metadata")]
    pub metadata: serde_json::Value,
}
