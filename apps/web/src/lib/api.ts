import type {
  AgentFrame,
  ProviderPreset,
  MessageHit,
  SessionSummary,
  SettingsView,
  TestResult,
  TurnView,
  Anchor,
  CardProfile,
  ChatBody,
  Depth,
  EntryDetail,
  GlossaryEntry,
  Health,
  Mastery,
  ProfilesResponse,
  SessionView,
  PromotionResult,
  Topic,
  TopicDetail,
  TopicEdgeKind,
  Course,
  CourseDetail,
  CourseItem,
  CourseItemStatus,
  CourseSummary,
  TopicNode,
  TopicNodeStatus,
  Reminder,
} from './types'

const TOKEN =
  document.querySelector('meta[name="deck-token"]')?.getAttribute('content') ?? ''

/** 所有请求都带 Bearer token（后端从 index.html 注入，页面同源即可拿到）。 */
async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (TOKEN) headers.set('Authorization', `Bearer ${TOKEN}`)
  const response = await fetch(path, { ...init, headers })
  if (response.status === 401) {
    throw new Error('未授权：deck 的令牌不匹配（页面可能是旧版本，刷新一次）')
  }
  return response
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`${response.status} ${detail}`)
  }
  return (await response.json()) as T
}

export async function fetchHealth(): Promise<Health> {
  return readJson<Health>(await api('/api/health'))
}

export async function listProfiles(): Promise<ProfilesResponse> {
  return readJson<ProfilesResponse>(await api('/api/profiles'))
}

/** 以现有模板为底稿复制一份，id 由后端生成。 */
export async function createProfile(input: { from: string; label: string }): Promise<CardProfile> {
  return readJson<CardProfile>(
    await api('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
}

export async function updateProfile(
  id: string,
  input: Omit<CardProfile, 'id'>,
): Promise<CardProfile> {
  return readJson<CardProfile>(
    await api(`/api/profiles/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
}

export async function deleteProfile(id: string): Promise<void> {
  await readJson<{ ok: boolean }>(
    await api(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  )
}

export async function setActiveProfile(id: string): Promise<string> {
  const data = await readJson<{ active: string }>(
    await api('/api/profiles/active', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }),
  )
  return data.active
}

export async function createSession(): Promise<string> {
  const data = await readJson<{ id: string }>(await api('/api/sessions', { method: 'POST' }))
  return data.id
}

export async function fetchSession(id: string): Promise<SessionView> {
  return readJson<SessionView>(await api(`/api/sessions/${id}`))
}

/** 唯一的 SSE 入口：解析 `data: {...}` 帧并分发，支持取消。 */
export async function streamChat(
  body: ChatBody,
  onFrame: (frame: AgentFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await api('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok || !response.body) {
    throw new Error(`chat failed: ${response.status}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      for (const line of frame.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload) continue
        try {
          onFrame(JSON.parse(payload) as AgentFrame)
        } catch {
          // 半包或非 JSON：忽略，下一帧继续
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}

export async function listGlossary(query?: string): Promise<GlossaryEntry[]> {
  const suffix = query && query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''
  const data = await readJson<{ entries: GlossaryEntry[] }>(await api(`/api/glossary${suffix}`))
  return data.entries
}

export async function saveGlossary(input: {
  term: string
  gist: string
  depth: Depth
  anchor?: Anchor
  /** 任意档位 id：账本按模板隔离，避免跨范式串味 */
  profile_id?: string
  level?: string
  parent_card_id?: string
  card_id?: string
}): Promise<GlossaryEntry> {
  return readJson<GlossaryEntry>(
    await api('/api/glossary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
}

export async function fetchProviders(): Promise<ProviderPreset[]> {
  return readJson<ProviderPreset[]>(await api('/api/providers'))
}

export async function fetchSettings(): Promise<SettingsView> {
  return readJson<SettingsView>(await api('/api/settings'))
}

export async function updateSettings(input: {
  provider: string
  base_url: string
  model: string
  api_key?: string
}): Promise<SettingsView> {
  return readJson<SettingsView>(
    await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
}

export async function testConnection(input: {
  base_url: string
  model: string
  api_key?: string
}): Promise<TestResult> {
  return readJson<TestResult>(
    await api('/api/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: '', ...input }),
    }),
  )
}

export async function clearKey(): Promise<SettingsView> {
  return readJson<SettingsView>(await api('/api/settings/key', { method: 'DELETE' }))
}

export async function listSessions(): Promise<SessionSummary[]> {
  const data = await readJson<{ sessions: SessionSummary[] }>(await api('/api/sessions'))
  return data.sessions
}

export async function matchEntry(term: string): Promise<GlossaryEntry | null> {
  const data = await readJson<{ entry: GlossaryEntry | null }>(
    await api(`/api/glossary/match?term=${encodeURIComponent(term)}`),
  )
  return data.entry
}

export async function updateEntry(
  id: string,
  patch: { gist?: string; depth?: Depth; mastery?: Mastery },
): Promise<GlossaryEntry | null> {
  const data = await readJson<{ entry: GlossaryEntry | null }>(
    await api(`/api/glossary/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
  return data.entry
}

/** 删除一张卡片及其所有后代（面包屑上的「删除这一层」）。 */
export async function deleteCard(id: string): Promise<number> {
  const data = await readJson<{ ok: boolean; removed: number }>(
    await api(`/api/cards/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  )
  return data.removed
}

export async function deleteEntry(id: string): Promise<void> {
  await readJson<{ ok: boolean }>(await api(`/api/glossary/${encodeURIComponent(id)}`, { method: 'DELETE' }))
}

export async function mergeEntries(target: string, sources: string[]): Promise<void> {
  await readJson<{ ok: boolean }>(
    await api('/api/glossary/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, sources }),
    }),
  )
}

export async function renameSession(id: string, title: string): Promise<void> {
  await readJson<{ ok: boolean }>(
    await api(`/api/sessions/${id}/meta`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  )
}

export async function deleteSession(id: string): Promise<void> {
  await readJson<{ ok: boolean }>(await api(`/api/sessions/${id}`, { method: 'DELETE' }))
}

/** 把卡片升级成专题会话；同一张卡重复调用是幂等的。 */
export async function promoteCard(input: {
  session_id: string
  card_id: string
  title: string
  depth_goal: Depth
  topic_id?: string | null
}): Promise<PromotionResult> {
  return readJson<PromotionResult>(
    await api(`/api/sessions/${input.session_id}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        card_id: input.card_id,
        title: input.title,
        depth_goal: input.depth_goal,
        topic_id: input.topic_id ?? null,
      }),
    }),
  )
}

export async function listTopics(): Promise<Topic[]> {
  const data = await readJson<{ topics: Topic[] }>(await api('/api/topics'))
  return data.topics
}

export async function fetchTopic(id: string): Promise<TopicDetail> {
  return readJson<TopicDetail>(await api(`/api/topics/${id}`))
}

export async function createTopic(input: {
  title: string
  summary?: string
  depth_goal?: Depth
}): Promise<Topic> {
  return readJson<Topic>(
    await api('/api/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
}

export async function deleteTopic(
  id: string,
  deleteSessions: boolean,
): Promise<{
  sessions_deleted: number
  sessions_kept: number
  course_items_removed: number
  edges_removed: number
  nodes_removed: number
}> {
  return readJson(
    await api(`/api/topics/${id}?delete_sessions=${deleteSessions ? 'true' : 'false'}`, {
      method: 'DELETE',
    }),
  )
}

export async function updateTopic(
  id: string,
  patch: {
    title?: string
    summary?: string
    depth_goal?: Depth
    mastery?: Mastery
    outline_md?: string
  },
): Promise<Topic> {
  return readJson<Topic>(
    await api(`/api/topics/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
}

export async function createTopicSession(topicId: string): Promise<string> {
  const data = await readJson<{ id: string }>(
    await api(`/api/topics/${topicId}/sessions`, { method: 'POST' }),
  )
  return data.id
}

export async function setSessionTopic(
  sessionId: string,
  topicId: string | null,
): Promise<void> {
  await readJson<{ ok: boolean }>(
    await api(`/api/sessions/${sessionId}/topic`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic_id: topicId }),
    }),
  )
}

export async function addTopicEdge(input: {
  from_topic_id: string
  to_topic_id: string
  kind: TopicEdgeKind
  note?: string
}): Promise<void> {
  await readJson<unknown>(
    await api(`/api/topics/${input.to_topic_id}/edges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
}

export async function deleteTopicEdge(topicId: string, edgeId: string): Promise<void> {
  await readJson<{ ok: boolean }>(
    await api(`/api/topics/${topicId}/edges/${edgeId}`, { method: 'DELETE' }),
  )
}

export async function searchMessages(q: string): Promise<MessageHit[]> {
  const data = await readJson<{ hits: MessageHit[] }>(
    await api(`/api/search?q=${encodeURIComponent(q)}`),
  )
  return data.hits
}

export function exportUrl(format: 'md' | 'json'): string {
  return `/api/export?format=${format}`
}

/** 导出要带 token，所以不能用裸 <a href>，走 blob 下载。 */
export async function downloadExport(format: 'md' | 'json'): Promise<void> {
  const response = await api(`/api/export?format=${format}`)
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `studydeck-glossary.${format}`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export async function listTurns(activeOnly = false): Promise<TurnView[]> {
  const data = await readJson<{ turns: TurnView[] }>(
    await api(`/api/turns${activeOnly ? '?active=1' : ''}`),
  )
  return data.turns
}


export async function listCourses(): Promise<CourseSummary[]> {
  const data = await readJson<{ courses: CourseSummary[] }>(await api('/api/courses'))
  return data.courses
}

export async function createCourse(input: {
  title: string
  goal?: string
  start_date?: string
  end_date?: string
  daily_minutes?: number
  study_days?: string
}): Promise<Course> {
  return readJson<Course>(
    await api('/api/courses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
}

export async function fetchCourse(id: string): Promise<CourseDetail> {
  return readJson<CourseDetail>(await api(`/api/courses/${id}`))
}

export async function updateCourse(
  id: string,
  patch: {
    title?: string
    goal?: string
    start_date?: string
    end_date?: string
    daily_minutes?: number
    study_days?: string
  },
): Promise<Course> {
  return readJson<Course>(
    await api(`/api/courses/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
}

export async function deleteCourse(id: string): Promise<void> {
  await readJson<{ ok: boolean }>(await api(`/api/courses/${id}`, { method: 'DELETE' }))
}

export async function addCourseItem(
  courseId: string,
  input: {
    topic_id: string
    planned_at?: string | null
    position?: number
    estimated_minutes?: number
  },
): Promise<CourseItem> {
  return readJson<CourseItem>(
    await api(`/api/courses/${courseId}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
}

export async function updateCourseItem(
  courseId: string,
  itemId: string,
  patch: {
    planned_at?: string
    status?: CourseItemStatus
    note?: string
    position?: number
    estimated_minutes?: number
  },
): Promise<CourseItem> {
  return readJson<CourseItem>(
    await api(`/api/courses/${courseId}/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
}

export async function deleteCourseItem(courseId: string, itemId: string): Promise<void> {
  await readJson<{ ok: boolean }>(
    await api(`/api/courses/${courseId}/items/${itemId}`, { method: 'DELETE' }),
  )
}

export async function reorderCourse(courseId: string, itemIds: string[]): Promise<CourseDetail> {
  return readJson<CourseDetail>(
    await api(`/api/courses/${courseId}/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_ids: itemIds }),
    }),
  )
}

export async function autoOrderCourse(courseId: string): Promise<CourseDetail> {
  return readJson<CourseDetail>(
    await api(`/api/courses/${courseId}/auto-order`, { method: 'POST' }),
  )
}

export async function autoScheduleCourse(
  courseId: string,
  input: { daily_minutes?: number; study_days?: string } = {},
): Promise<CourseDetail> {
  return readJson<CourseDetail>(
    await api(`/api/courses/${courseId}/auto-schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
}

export async function listReminders(date?: string): Promise<Reminder[]> {
  const suffix = date ? `?date=${encodeURIComponent(date)}` : ''
  const data = await readJson<{ due: Reminder[] }>(await api(`/api/reminders${suffix}`))
  return data.due
}

export async function downloadCourseCalendar(courseId: string, title: string): Promise<void> {
  const response = await api(`/api/courses/${courseId}/calendar.ics`)
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${title || 'studydeck'}.ics`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export async function parseTopicOutline(
  topicId: string,
  markdown?: string,
): Promise<TopicNode[]> {
  const data = await readJson<{ nodes: TopicNode[] }>(
    await api(`/api/topics/${topicId}/outline/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: markdown ?? null }),
    }),
  )
  return data.nodes
}

export async function addTopicNode(topicId: string, title: string): Promise<TopicNode> {
  return readJson<TopicNode>(
    await api(`/api/topics/${topicId}/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  )
}

export async function updateTopicNode(
  topicId: string,
  nodeId: string,
  patch: { title?: string; status?: TopicNodeStatus; note?: string; position?: number },
): Promise<TopicNode> {
  return readJson<TopicNode>(
    await api(`/api/topics/${topicId}/nodes/${nodeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
}

export async function deleteTopicNode(topicId: string, nodeId: string): Promise<void> {
  await readJson<{ ok: boolean }>(
    await api(`/api/topics/${topicId}/nodes/${nodeId}`, { method: 'DELETE' }),
  )
}

export async function fetchEntryDetail(id: string): Promise<EntryDetail> {
  return readJson<EntryDetail>(await api(`/api/entries/${encodeURIComponent(id)}`))
}

export async function fetchDueReviews(): Promise<GlossaryEntry[]> {
  const data = await readJson<{ entries: GlossaryEntry[] }>(await api('/api/review/due'))
  return data.entries
}

export async function submitReview(id: string, remembered: boolean): Promise<GlossaryEntry> {
  return readJson<GlossaryEntry>(
    await api(`/api/review/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remembered }),
    }),
  )
}
