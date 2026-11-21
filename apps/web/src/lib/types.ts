export type Depth = 'can_use' | 'can_tune' | 'can_derive'

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
}

export interface SessionView {
  id: string
  messages: Message[]
  cards: CardRecord[]
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
  card_id?: string
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
