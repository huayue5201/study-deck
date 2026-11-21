import type {
  AgentFrame,
  ProviderPreset,
  MessageHit,
  SessionSummary,
  SettingsView,
  TestResult,
  TurnView,
  Anchor,
  ChatBody,
  Depth,
  GlossaryEntry,
  Health,
  Mastery,
  SessionView,
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
    await api(`/api/glossary/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
  return data.entry
}

export async function deleteEntry(id: string): Promise<void> {
  await readJson<{ ok: boolean }>(await api(`/api/glossary/${id}`, { method: 'DELETE' }))
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
