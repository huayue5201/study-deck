export type Depth = 'can_use' | 'can_tune' | 'can_derive'

export interface CardLevel {
  id: string
  label: string
  stop: string
}

export interface CardProfile {
  id: string
  label: string
  axis_label: string
  default_level: string
  max_chars: number
  sections: string[]
  levels: CardLevel[]
  system: string
}

export interface ProfilesResponse {
  active: string
  profiles: CardProfile[]
}

/** 后端还没就绪时的兜底模板：保证卡片始终有档位可渲染。 */
export const FALLBACK_PROFILE: CardProfile = {
  id: 'tech',
  label: '编程 / 技术',
  axis_label: '理解深度',
  default_level: 'can_tune',
  max_chars: 260,
  sections: ['一句话定义', '在当前位置的角色', '需要的理解深度', '前置依赖（一层）', '下一步'],
  levels: [
    { id: 'can_use', label: '能调', stop: '只要会用：一句话定义 + 它在这里承担什么角色' },
    { id: 'can_tune', label: '能改', stop: '要能改：关键参数、边界条件、常见误用' },
    { id: 'can_derive', label: '能推', stop: '要能推：核心机制的推导骨架' },
  ],
  system: '你是「卡片」：围绕用户选中的一小段内容就地解释，严格按给定小节输出，不要扩写成教程。',
}

export interface Anchor {
  message_id: string
  char_start: number
  char_end: number
  quote: string
}

export type MessageStatus = 'running' | 'ok' | 'error' | 'cancelled'

export interface Message {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  created_at: string
  status?: MessageStatus
  turn_id?: string | null
}

export interface CardRecord {
  id: string
  session_id: string
  anchor: Anchor
  depth: Depth
  question: string
  answer: string
  created_at: string
  promoted_session_id?: string | null
}

export interface Topic {
  id: string
  title: string
  summary: string
  depth_goal: Depth
  mastery: Mastery
  created_at: string
  outline_md: string
  metadata?: Record<string, unknown>
}

export type TopicEdgeKind = 'prerequisite' | 'part_of' | 'related'

export interface TopicRelation {
  id: string
  kind: TopicEdgeKind
  kind_label: string
  direction: 'incoming' | 'outgoing' | 'related'
  note: string
  other: Topic | null
}

export interface TopicSuggestion {
  title: string
  topic_id: string | null
}

export interface TopicDetail {
  topic: Topic
  sessions: SessionSummary[]
  relations: TopicRelation[]
  suggestions: TopicSuggestion[]
  source: SessionOrigin | null
  nodes: TopicNode[]
  course_count: number
}

export type TopicNodeStatus = 'planned' | 'learning' | 'done'

export interface TopicNode {
  id: string
  topic_id: string
  title: string
  status: TopicNodeStatus
  position: number
  note: string
  created_at: string
}

export interface SessionOrigin {
  session_id: string
  topic_id: string
  topic_title: string
  source_session_id: string
  source_title: string | null
  source_message_id: string
  card_id: string
  quote: string
  context: string
  answer: string
  depth: Depth
  metadata?: Record<string, unknown>
}

export interface SessionUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  turns: number
}

export interface SessionView {
  id: string
  messages: Message[]
  cards: CardRecord[]
  topic: Topic | null
  origin: SessionOrigin | null
  usage?: SessionUsage
}

export type Mastery = 'unknown' | 'learning' | 'mastered'

export interface GlossaryEntry {
  id: string
  term: string
  gist: string
  depth: Depth
  mastery: Mastery
  source_anchor: Anchor | null
  session_id: string | null
  created_at: string
  updated_at?: string | null
  encounter_count?: number
  last_seen?: string | null
}

export interface Encounter {
  id: string
  entry_id: string
  gist: string
  profile_id: string | null
  level: string | null
  session_id: string | null
  parent_card_id: string | null
  created_at: string
}

export interface MessageHit {
  session_id: string
  session_title: string | null
  message_id: string
  role: string
  snippet: string
  created_at: string
}

export const MASTERY_LABEL: Record<Mastery, string> = {
  unknown: '未标记',
  learning: '在学',
  mastered: '已掌握',
}

export type AgentFrame =
  | { type: 'assistant_start'; message_id: string }
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; name: string; args: unknown }
  | { type: 'tool_done'; name: string; ok: boolean; preview: string }
  | { type: 'done'; usage: { prompt_tokens: number; completion_tokens: number } }
  | { type: 'error'; message: string }
  | { type: 'end' }

export interface ChatBody {
  session_id: string
  mode: 'main' | 'card'
  text: string
  anchor?: Anchor
  depth?: Depth
  profile_id?: string
  level?: string
  card_id?: string
  card_history?: string
  /** 回答语言：跟随界面 */
  locale?: string
  /** 在上一张卡上展开 */
  parent_card_id?: string
}

export interface Health {
  ok: boolean
  fake: boolean
  provider: string
}

export const DEPTH_LABEL: Record<Depth, string> = {
  can_use: '能调',
  can_tune: '能改',
  can_derive: '能推',
}

export const DEPTH_HINT: Record<Depth, string> = {
  can_use: '只要会用：一句话定义 + 它在这里承担什么角色',
  can_tune: '要能改：关键参数、边界条件、常见误用',
  can_derive: '要能推：核心机制的推导骨架',
}

export interface ProviderPreset {
  id: string
  label: string
  base_url: string
  models: string[]
  note: string
}

export interface SettingsView {
  provider: string
  base_url: string
  model: string
  configured: boolean
  has_key: boolean
  key_in_keychain: boolean
}

export interface TestResult {
  ok: boolean
  message: string
  elapsed_ms?: number
}

export interface SessionSummary {
  id: string
  title: string | null
  updated_at: string
  messages: number
  topic_id: string | null
  topic_title: string | null
  origin: {
    parent_session_id: string
    parent_title: string | null
    message_id: string
    card_id: string
    quote: string
  } | null
}

export interface PromotionResult {
  session_id: string
  topic_id: string
  topic: Topic
  seed: SessionOrigin
}

export interface TurnView {
  id: string
  session_id: string
  state: 'running' | 'ok' | 'error' | 'cancelled'
  seq: number
  started_at: string
  finished_at: string | null
  question: string
  error: string | null
  message_id: string | null
}

export type CourseItemStatus = 'planned' | 'learning' | 'done'

export interface Course {
  id: string
  title: string
  goal: string
  start_date: string | null
  end_date: string | null
  daily_minutes: number
  study_days: string
  created_at: string
  metadata?: Record<string, unknown>
}

export interface CourseItem {
  id: string
  course_id: string
  topic_id: string
  position: number
  planned_at: string | null
  status: CourseItemStatus
  note: string
  estimated_minutes: number
  created_at: string
  metadata?: Record<string, unknown>
}

export interface CoursePrerequisite {
  topic_id: string
  title: string
  in_course: boolean
  warning: string
}

export interface CourseDetailItem {
  item: CourseItem
  topic: Topic | null
  prerequisites: CoursePrerequisite[]
}

export interface CourseSummary {
  course: Course
  topic_count: number
  done_count: number
  next_date: string | null
}

export interface CourseDetail {
  course: Course
  items: CourseDetailItem[]
  progress: { total: number; done: number }
}

export interface Reminder {
  course_id: string
  course_title: string
  item: CourseItem
  topic: Topic | null
}
