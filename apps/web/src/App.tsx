import { useCallback, useEffect, useRef, useState } from 'react'
import { Composer } from './components/Composer'
import { Sidebar } from './components/Sidebar'
import { OriginBanner } from './components/OriginBanner'
import { PromoteDialog } from './components/PromoteDialog'
import { TopicPage } from './components/TopicPage'
import { CoursePage } from './components/CoursePage'
import { CourseDialog } from './components/CourseDialog'
import { MessageList } from './components/MessageList'
import { CardLayer } from './components/CardLayer'
import { GlossaryPanel } from './components/GlossaryPanel'
import { SetupGate } from './components/SetupGate'
import { SettingsPanel } from './components/SettingsPanel'
import { ProfilesModal } from './components/ProfilesModal'
import type { OpenCardState } from './components/Card'
import {
  createSession,
  fetchHealth,
  fetchProviders,
  fetchSession,
  fetchSettings,
  listGlossary,
  listProfiles,
  deleteSession,
  listSessions,
  matchEntry,
  renameSession,
  saveGlossary,
  searchMessages,
  streamChat,
  promoteCard,
  listTopics,
  updateTopic,
  listCourses,
  createCourse,
  listReminders,
  parseTopicOutline,
} from './lib/api'
import { useI18n } from './lib/i18n'
import { isImeComposing } from './lib/ime'
import { readAnchor } from './lib/selection'
import {
  FALLBACK_PROFILE,
  MASTERY_LABEL,
  type Anchor,
  type CardProfile,
  type CardRecord,
  type Depth,
  type GlossaryEntry,
  type Message,
  type MessageHit,
  type ProfilesResponse,
  type ProviderPreset,
  type SessionSummary,
  type SessionUsage,
  type SessionView,
  type SessionOrigin,
  type Topic,
  type CourseSummary,
  type Reminder,
  type SettingsView,
} from './lib/types'

interface PendingSelection {
  anchor: Anchor
  rect: { left: number; top: number; width: number; height: number }
  sourceText: string
  /** 选区在卡片里时带上卡片 id（嵌套展开） */
  fromCardId?: string
}

const OUTLINE_PROMPT =
  '请基于这个专题起点，先给我一个 3–5 条的学习地图：每条只写主题、与其它条目的先修关系和目标深度；先不要展开正文，等我确认。'

const EXAMPLES = [
  '讲讲采样定理，并指出哪些概念我现在可以不懂',
  '帮我理解 React 的 key 到底在解决什么问题',
  '我在学 Rust 所有权，给一个我能跑的小例子',
]

function toolLabel(
  name: string,
  args: unknown,
  t: (zh: string, vars?: Record<string, string | number>) => string,
): string {
  const value = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const path = typeof value.path === 'string' ? value.path : ''
  const query = typeof value.query === 'string' ? value.query : ''
  switch (name) {
    case 'read_file':
      return t('正在读取 {path}…', { path: path || t('文件') })
    case 'list_dir':
      return t('正在查看目录 {path}…', { path: path || '.' })
    case 'search_text':
      return t('正在搜索「{query}」…', { query: query || t('项目') })
    case 'clock':
      return t('正在获取时间…')
    default:
      return t('正在使用 {name}…', { name })
  }
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function sameMessages(a: Message[], b: Message[]): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (message, index) =>
      message.id === b[index].id &&
      message.text === b[index].text &&
      message.status === b[index].status,
  )
}

function stripMarkdown(text: string): string {
  return text
    .replace(/[#>*`_\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 卡片档位是用户自定义的；账本仍按三档 Depth 记账，这里做一次映射。 */
function depthForLevel(profile: CardProfile, level: string): Depth {
  if (level === 'can_use' || level === 'can_tune' || level === 'can_derive') return level
  const index = profile.levels.findIndex((item) => item.id === level)
  if (index < 0) return 'can_tune'
  if (index === 0) return 'can_use'
  if (index >= profile.levels.length - 1) return 'can_derive'
  return 'can_tune'
}

function resolveLevel(profile: CardProfile, preferred?: string | null): string {
  if (preferred && profile.levels.some((level) => level.id === preferred)) return preferred
  if (profile.levels.some((level) => level.id === profile.default_level)) {
    return profile.default_level
  }
  return profile.levels[0]?.id ?? 'can_tune'
}

export default function App() {
  const { t, lang } = useI18n()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [usage, setUsage] = useState<SessionUsage | null>(null)
  const [origin, setOrigin] = useState<SessionOrigin | null>(null)
  const [topic, setTopic] = useState<Topic | null>(null)
  const [promote, setPromote] = useState<OpenCardState | null>(null)
  const [promoting, setPromoting] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 900)
  const [topics, setTopics] = useState<Topic[]>([])
  const [courses, setCourses] = useState<CourseSummary[]>([])
  const [topicPageId, setTopicPageId] = useState<string | null>(null)
  const [coursePageId, setCoursePageId] = useState<string | null>(null)
  const [showCourseDialog, setShowCourseDialog] = useState(false)
  const [creatingCourse, setCreatingCourse] = useState(false)
  const [dueReminders, setDueReminders] = useState<Reminder[]>([])
  const [reminderDismissed, setReminderDismissed] = useState(false)
  const [toolActivity, setToolActivity] = useState<{
    name: string
    args: unknown
    state: 'running' | 'done'
    ok?: boolean
  } | null>(null)
  const [fake, setFake] = useState(false)
  // 学习路径：根 → 当前（当前 = path 末尾）
  const [path, setPath] = useState<OpenCardState[]>([])
  // 会话里已经存在的卡片（用于「同一处划词直接复用」）
  const sessionCardsRef = useRef<CardRecord[]>([])
  // 分叉：父卡 key → 其它分支（每条分支是父卡之后的整条后缀链）
  const [branches, setBranches] = useState<Record<string, OpenCardState[][]>>({})
  const card = path.length > 0 ? path[path.length - 1] : null

  /** 只更新当前卡（流式输出、保存状态等） */
  const updateCurrent = useCallback((updater: (current: OpenCardState) => OpenCardState) => {
    setPath((prev) => (prev.length === 0 ? prev : [...prev.slice(0, -1), updater(prev[prev.length - 1])]))
  }, [])

  const branchKey = (target: OpenCardState) => target.id ?? `draft:${target.anchor.quote}`
  const chainSignature = (chain: OpenCardState[]) =>
    chain.map((item) => item.id ?? item.anchor.quote).join(' > ')

  /** 把一条「父卡之后」的路径登记成分支，供随时切回 */
  const rememberBranch = useCallback((parent: OpenCardState, chain: OpenCardState[]) => {
    if (chain.length === 0) return
    const key = branchKey(parent)
    const signature = chainSignature(chain)
    setBranches((prev) => {
      const list = prev[key] ?? []
      if (list.some((item) => chainSignature(item) === signature)) return prev
      return { ...prev, [key]: [chain, ...list] }
    })
  }, [])

  // 卡片栈：祖先在下，当前卡是 card
  const [pending, setPending] = useState<PendingSelection | null>(null)
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [glossaryOpen, setGlossaryOpen] = useState(false)
  const [entries, setEntries] = useState<GlossaryEntry[]>([])
  const [query, setQuery] = useState('')
  const [flashId, setFlashId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [showProfiles, setShowProfiles] = useState(false)
  const [profiles, setProfiles] = useState<CardProfile[]>([])
  const [activeProfile, setActiveProfile] = useState<CardProfile>(FALLBACK_PROFILE)
  const [gateSkipped, setGateSkipped] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [hits, setHits] = useState<MessageHit[]>([])
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const sessionRef = useRef<string | null>(null)
  const assistantIdRef = useRef<string | null>(null)
  const cardIdRef = useRef<string | null>(null)
  const toolTimerRef = useRef<number | null>(null)

  sessionRef.current = sessionId

  const beginTool = useCallback((name: string, args: unknown) => {
    if (toolTimerRef.current !== null) {
      window.clearTimeout(toolTimerRef.current)
      toolTimerRef.current = null
    }
    setToolActivity({ name, args, state: 'running' })
  }, [])

  const finishTool = useCallback((name: string, ok: boolean) => {
    setToolActivity((current) => (current ? { ...current, name, state: 'done', ok } : current))
    if (toolTimerRef.current !== null) window.clearTimeout(toolTimerRef.current)
    toolTimerRef.current = window.setTimeout(() => {
      setToolActivity(null)
      toolTimerRef.current = null
    }, 1400)
  }, [])

  const clearTool = useCallback(() => {
    if (toolTimerRef.current !== null) {
      window.clearTimeout(toolTimerRef.current)
      toolTimerRef.current = null
    }
    setToolActivity(null)
  }, [])

  useEffect(() => {
    let cancelled = false
    const boot = async () => {
      try {
        const [health, presetList, settingsView] = await Promise.all([
          fetchHealth(),
          fetchProviders(),
          fetchSettings(),
        ])
        if (!cancelled) {
          setFake(!settingsView.has_key)
          setPresets(presetList)
          setSettings(settingsView)
        }
        if (health.provider && health.provider !== 'fake') setFake(!settingsView.has_key)

        const fromUrl = new URLSearchParams(window.location.search).get('session')
        if (fromUrl) {
          try {
            const view = await fetchSession(fromUrl)
            localStorage.setItem('studydeck.session', view.id)
            if (!cancelled) {
              setSessionId(view.id)
              setMessages(view.messages)
              setOrigin(view.origin ?? null)
              setTopic(view.topic ?? null)
              const list = await listSessions().catch(() => [])
              if (!cancelled) setSessions(list)
            }
            return
          } catch {
            localStorage.removeItem('studydeck.session')
          }
        }

        const stored = localStorage.getItem('studydeck.session')

        // 优先沿用上次的会话；如果它是空的，就跳到最近有内容的会话
        // （从 nvim / 外部投递进来的会话就靠这一步出现在窗口里）
        let chosen: SessionView | null = null
        if (stored) {
          try {
            const view = await fetchSession(stored)
            if (view.messages.length > 0) chosen = view
          } catch {
            localStorage.removeItem('studydeck.session')
          }
        }
        if (!chosen) {
          try {
            const recent = await listSessions()
            const newest = recent.find((item) => item.messages > 0)
            if (newest) chosen = await fetchSession(newest.id)
          } catch {
            // 没有历史就算了
          }
        }

        if (chosen) {
          localStorage.setItem('studydeck.session', chosen.id)
          if (!cancelled) {
            setSessionId(chosen.id)
            setMessages(chosen.messages)
            setOrigin(chosen.origin ?? null)
            setTopic(chosen.topic ?? null)
            setSessions(await listSessions().catch(() => []))
          }
          return
        }

        const id = await createSession()
        localStorage.setItem('studydeck.session', id)
        if (!cancelled) {
          setSessionId(id)
          setMessages([])
          setOrigin(null)
          setTopic(null)
        }
      } catch (err) {
        if (!cancelled) setError(String(err))
      }
    }
    void boot()
    return () => {
      cancelled = true
    }
  }, [])

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await listSessions())
    } catch {
      // 列表拿不到不影响主流程
    }
  }, [])

  const refreshTopics = useCallback(async () => {
    try {
      setTopics(await listTopics())
    } catch {
      // 专题列表拿不到不影响主流程
    }
  }, [])

  const refreshCourses = useCallback(async () => {
    try {
      setCourses(await listCourses())
    } catch {
      // 课程列表拿不到不影响主流程
    }
  }, [])

  const refreshReminders = useCallback(async () => {
    try {
      setDueReminders(await listReminders())
    } catch {
      // 提醒拿不到不影响主流程
    }
  }, [])

  const refreshProfiles = useCallback(async (): Promise<ProfilesResponse | null> => {
    try {
      const data = await listProfiles()
      setProfiles(data.profiles)
      setActiveProfile(
        data.profiles.find((profile) => profile.id === data.active) ??
          data.profiles[0] ??
          FALLBACK_PROFILE,
      )
      return data
    } catch {
      // 模板接口可能还没就绪；卡片先用兜底模板继续工作
      return null
    }
  }, [])

  useEffect(() => {
    void refreshProfiles()
  }, [refreshProfiles])

  useEffect(() => {
    if (sessionId) void refreshSessions()
  }, [sessionId, refreshSessions])

  // 外部投递（例如 nvim 的 /api/ask）会直接落库，不经过这个窗口。
  // 定时 + 聚焦刷新，侧边栏才能在不重启的情况下看到新会话。
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void refreshSessions()
    }
    const timer = window.setInterval(refresh, 4000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [refreshSessions])

  // 外部投递也可能写进当前正在看的会话（同一个 cwd）。本地没有流式回答时，
  // 低频拉一次当前会话，让 nvim 的消息和状态落进正在打开的时间线。
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return
      if (topicPageId || coursePageId || streamingId) return
      const sid = sessionRef.current
      if (!sid) return
      try {
        const view = await fetchSession(sid)
        if (cancelled) return
        setMessages((current) => (sameMessages(current, view.messages) ? current : view.messages))
        setUsage(view.usage ?? null)
        setOrigin((current) =>
          JSON.stringify(current) === JSON.stringify(view.origin) ? current : view.origin,
        )
        setTopic((current) =>
          JSON.stringify(current) === JSON.stringify(view.topic) ? current : view.topic,
        )
      } catch {
        // 会话可能刚被删除；列表轮询会处理，下一次切换会重新加载
      }
    }
    const timer = window.setInterval(() => void refresh(), 2500)
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [topicPageId, coursePageId, streamingId])

  useEffect(() => {
    void refreshTopics()
    void refreshCourses()
    void refreshReminders()
    const timer = window.setInterval(() => void refreshReminders(), 5 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [refreshTopics, refreshCourses, refreshReminders])

  useEffect(() => {
    const term = searchQuery.trim()
    if (term === '') {
      setHits([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void searchMessages(term)
        .then((found) => {
          if (!cancelled) setHits(found)
        })
        .catch(() => undefined)
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [searchQuery])

  const switchSession = useCallback(async (id: string) => {
    if (!id) return
    if (id === sessionRef.current) {
      setTopicPageId(null)
      return
    }
    try {
      const view = await fetchSession(id)
      localStorage.setItem('studydeck.session', view.id)
      setSessionId(view.id)
      setMessages(view.messages)
      setOrigin(view.origin ?? null)
      setTopic(view.topic ?? null)
      setPath([])
      setTopicPageId(null)
      setCoursePageId(null)
      if (window.innerWidth <= 900) setSidebarOpen(false)
    } catch (err) {
      setError(String(err))
    }
  }, [])

  const newSession = useCallback(async () => {
    try {
      const id = await createSession()
      const view = await fetchSession(id)
      localStorage.setItem('studydeck.session', view.id)
      setSessionId(view.id)
      setMessages([])
      setOrigin(null)
      setTopic(null)
      setPath([])
      setTopicPageId(null)
      setCoursePageId(null)
      await refreshSessions()
      if (window.innerWidth <= 900) setSidebarOpen(false)
    } catch (err) {
      setError(String(err))
    }
  }, [refreshSessions])

  const deletingRef = useRef<Set<string>>(new Set())

  const handleDeleteSession = useCallback(async (id: string) => {
    if (deletingRef.current.has(id)) return
    deletingRef.current.add(id)
    // 删除前先记住"它是不是当前会话"：await 之后 sessionRef 可能已经变了
    const wasCurrent = id === sessionRef.current
    try {
      await deleteSession(id)
      const recent = await listSessions()
      setSessions(recent)
      if (!wasCurrent) return
      const next = recent.find((item) => item.messages > 0) ?? recent[0]
      const fresh = next ? next.id : await createSession()
      const view = await fetchSession(fresh)
      // 立刻同步 ref：连续删两次时，第二次不能还拿着旧 id
      sessionRef.current = view.id
      localStorage.setItem('studydeck.session', view.id)
      setSessionId(view.id)
      setMessages(view.messages)
      setOrigin(view.origin ?? null)
      setTopic(view.topic ?? null)
      setPath([])
      setTopicPageId(null)
      setCoursePageId(null)
      await refreshSessions()
    } catch (err) {
      setError(String(err))
    } finally {
      deletingRef.current.delete(id)
    }
  }, [refreshSessions])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest('.menu-wrap')) setMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const refreshGlossary = useCallback(async (search: string) => {
    try {
      setEntries(await listGlossary(search))
    } catch (err) {
      setError(String(err))
    }
  }, [])

  useEffect(() => {
    if (glossaryOpen) void refreshGlossary(query)
  }, [glossaryOpen, query, refreshGlossary])

  const openTopic = useCallback((id: string) => {
    setTopicPageId(id)
    setCoursePageId(null)
    if (window.innerWidth <= 900) setSidebarOpen(false)
  }, [])

  const openCourse = useCallback((id: string) => {
    setCoursePageId(id)
    setTopicPageId(null)
    if (window.innerWidth <= 900) setSidebarOpen(false)
  }, [])

  const refreshWorkspace = useCallback(() => {
    void refreshSessions()
    void refreshTopics()
    void refreshCourses()
    void refreshReminders()
  }, [refreshSessions, refreshTopics, refreshCourses, refreshReminders])

  const handleTopicDeleted = useCallback(
    async () => {
      setTopicPageId(null)
      await refreshSessions()
      await refreshTopics()
      await refreshCourses()
      void refreshReminders()
      const list = await listSessions()
      setSessions(list)
      const current = sessionRef.current
      const stillThere = current ? list.some((item) => item.id === current) : false
      if (!stillThere) {
        await newSession()
        return
      }
      try {
        const view = await fetchSession(current!)
        setMessages(view.messages)
        setOrigin(view.origin ?? null)
        setTopic(view.topic ?? null)
      } catch {
        await newSession()
      }
    },
    [refreshSessions, refreshTopics, refreshCourses, refreshReminders, newSession],
  )

  const submitCourse = useCallback(
    async (input: {
      title: string
      goal: string
      start_date: string
      end_date: string
      daily_minutes: number
      study_days: string
    }) => {
      setCreatingCourse(true)
      try {
        const course = await createCourse(input)
        await refreshCourses()
        setShowCourseDialog(false)
        openCourse(course.id)
      } catch (err) {
        setError(String(err))
      } finally {
        setCreatingCourse(false)
      }
    },
    [openCourse, refreshCourses],
  )

  const sendMain = useCallback(async (text: string, options?: { saveOutline?: boolean }) => {
    const sid = sessionRef.current
    if (!sid) return
    setError(null)
    let streamed = ''

    const draft: Message = {
      id: `draft-${Date.now()}`,
      session_id: sid,
      role: 'assistant',
      text: '',
      created_at: new Date().toISOString(),
    }
    setMessages((current) => [
      ...current,
      { ...draft, id: `user-${Date.now()}`, role: 'user', text },
      draft,
    ])
    assistantIdRef.current = draft.id
    setStreamingId(draft.id)

    try {
      await streamChat({ session_id: sid, mode: 'main', text, locale: lang }, (frame) => {
        if (frame.type === 'assistant_start') {
          const liveId = assistantIdRef.current
          assistantIdRef.current = frame.message_id
          setStreamingId(frame.message_id)
          setMessages((current) =>
            current.map((message) =>
              message.id === liveId ? { ...message, id: frame.message_id } : message,
            ),
          )
        }
        if (frame.type === 'delta') {
          streamed += frame.text
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantIdRef.current
                ? { ...message, text: message.text + frame.text }
                : message,
            ),
          )
        }
        if (frame.type === 'tool_call') beginTool(frame.name, frame.args)
        if (frame.type === 'tool_done') finishTool(frame.name, frame.ok)
        if (frame.type === 'error') setError(frame.message)
      })

      if (options?.saveOutline && topic?.id && streamed.trim()) {
        const updated = await updateTopic(topic.id, { outline_md: streamed })
        setTopic(updated)
        await parseTopicOutline(topic.id, streamed).catch(() => [])
        await refreshTopics()
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setStreamingId(null)
      clearTool()
      void refreshSessions()
      if (sessionRef.current) {
        void fetchSession(sessionRef.current)
          .then((view) => setUsage(view.usage ?? null))
          .catch(() => undefined)
      }
    }
  }, [refreshSessions, refreshTopics, topic, beginTool, finishTool, clearTool])

  const runCard = useCallback(
    async (
      anchor: Anchor,
      level: string,
      text: string,
      existingCardId: string | null,
      sourceText: string,
      append = false,
      cardHistory?: string,
      parentCardId?: string | null,
      parentText?: string | null,
    ) => {
      const sid = sessionRef.current
      if (!sid) return
      updateCurrent((current) =>
        current
          ? {
              ...current,
              answer:
                append && current.answer.trim()
                  ? `${current.answer}\n\n---\n\n**追问：** ${text}\n\n`
                  : '',
              streaming: true,
              level,
              question: text,
              sourceText,
            }
          : current,
      )

      try {
        await streamChat(
          {
            session_id: sid,
            mode: 'card',
            text,
            anchor,
            profile_id: activeProfile.id,
            level,
            locale: lang,
            card_id: existingCardId ?? undefined,
            card_history: cardHistory,
            parent_card_id: parentCardId ?? undefined,
            parent_text: parentText ?? undefined,
          },
          (frame) => {
            if (frame.type === 'delta') {
              updateCurrent((current) =>
                current ? { ...current, answer: current.answer + frame.text } : current,
              )
            }
            if (frame.type === 'tool_call') beginTool(frame.name, frame.args)
            if (frame.type === 'tool_done') finishTool(frame.name, frame.ok)
            if (frame.type === 'error') {
              updateCurrent((current) =>
                current
                  ? { ...current, answer: `${current.answer}\n\n**出错**：${frame.message}` }
                  : current,
              )
            }
          },
        )
      } catch (err) {
        setError(String(err))
      } finally {
        updateCurrent((current) => (current ? { ...current, streaming: false } : current))
        clearTool()
      }

      if (!existingCardId) {
        try {
          const view = await fetchSession(sid)
          sessionCardsRef.current = view.cards
          const matched = view.cards
            .filter((item) => item.anchor.message_id === anchor.message_id && item.anchor.quote === anchor.quote)
            .pop()
          if (matched) cardIdRef.current = matched.id
          updateCurrent((current) =>
            current
              ? {
                  ...current,
                  id: matched?.id ?? null,
                  promotedSessionId: matched?.promoted_session_id ?? current.promotedSessionId,
                  parentCardId: current.parentCardId,
                  parentText: current.parentText,
                }
              : current,
          )
        } catch {
          // 拿不到 id 也能继续用，只是追问会新开一张卡片
        }
      }
    },
    [activeProfile.id, beginTool, finishTool, clearTool],
  )

  const submitPromotion = useCallback(
    async ({
      title,
      depth,
      topicId,
    }: {
      title: string
      depth: Depth
      topicId: string | null
    }) => {
      if (!promote?.id || !sessionRef.current) return
      setPromoting(true)
      try {
        const result = await promoteCard({
          session_id: sessionRef.current,
          card_id: promote.id,
          title,
          depth_goal: depth,
          topic_id: topicId,
        })
        const view = await fetchSession(result.session_id)
        localStorage.setItem('studydeck.session', view.id)
        setSessionId(view.id)
        setMessages(view.messages)
        setOrigin(view.origin ?? result.seed)
        setTopic(view.topic ?? result.topic)
        setPath([])
        setPromote(null)
        setTopicPageId(null)
        await refreshSessions()
        await refreshTopics()
        if (window.innerWidth <= 900) setSidebarOpen(false)
      } catch (err) {
        setError(String(err))
      } finally {
        setPromoting(false)
      }
    },
    [promote, refreshSessions, refreshTopics],
  )

  const handleMouseUp = useCallback(() => {
    const info = readAnchor()
    if (!info) {
      setPending(null)
      return
    }
    setPending({
      anchor: info.anchor,
      rect: {
        left: info.rect.left,
        top: info.rect.top,
        width: info.rect.width,
        height: info.rect.height,
      },
      sourceText: info.sourceText,
      fromCardId: info.cardId,
    })
  }, [])


  const saveCard = useCallback(async () => {
    if (!card || !card.answer.trim() || card.saved) return
    try {
      await saveGlossary({
        term: card.anchor.quote.slice(0, 80),
        gist: stripMarkdown(card.answer).slice(0, 160),
        depth: depthForLevel(activeProfile, card.level),
        anchor: card.anchor,
        profile_id: activeProfile.id,
        level: card.level,
        parent_card_id: card.parentCardId ?? undefined,
        card_id: card.id ?? undefined,
      })
      updateCurrent((current) => (current ? { ...current, saved: true } : current))
      if (glossaryOpen) void refreshGlossary(query)
    } catch (err) {
      setError(String(err))
    }
  }, [activeProfile, card, glossaryOpen, query, refreshGlossary])

  /** 在「某个祖先」的多个分支之间切换 */
  const switchBranch = useCallback(
    async (parentIndex: number, branchIndex: number) => {
      const parent = path[parentIndex]
      if (!parent) return
      const key = branchKey(parent)
      const list = branches[key] ?? []
      const target = list[branchIndex]
      if (!target) return
      await saveCard()
      const dropped = path.slice(parentIndex + 1)
      if (dropped.length > 0) rememberBranch(parent, dropped)
      setBranches((prev) => ({
        ...prev,
        [key]: (prev[key] ?? []).filter((_, index) => index !== branchIndex),
      }))
      setPath([...path.slice(0, parentIndex + 1), ...target])
      cardIdRef.current = target[0]?.id ?? null
    },
    [branches, path, rememberBranch, saveCard],
  )
  const openCard = useCallback(async () => {
    if (!pending) return
    const { anchor, rect, sourceText, fromCardId } = pending
    setPending(null)
    window.getSelection()?.removeAllRanges()
    cardIdRef.current = null

    // 嵌套展开：把当前卡之后的旧路径存成一个分支（不丢弃），再在当前卡下开新分支
    const nestingFrom = fromCardId && card ? card : null
    if (nestingFrom) {
      await saveCard()
    }

    const base = {
      id: null as string | null,
      anchor,
      question: anchor.quote,
      rect,
      sourceText,
      promotedSessionId: null as string | null,
      parentCardId: nestingFrom?.id ?? null,
      parentText: nestingFrom?.answer ?? null,
    }

    // 同一处划词已经在卡片里展开过：直接打开那张卡，不重复生成、不覆盖
    const parentId = nestingFrom?.id ?? null
    const existing = sessionCardsRef.current.find(
      (item) =>
        (item.parent_card_id ?? null) === parentId &&
        item.anchor.message_id === anchor.message_id &&
        item.anchor.char_start === anchor.char_start &&
        item.anchor.char_end === anchor.char_end,
    )
    if (existing) {
      cardIdRef.current = existing.id
      // 已经在当前路径上：直接跳过去，不重复挂节点
      const inPath = path.findIndex((item) => item.id === existing.id)
      if (inPath >= 0) {
        await saveCard()
        const dropped = path.slice(inPath + 1)
        if (dropped.length > 0) rememberBranch(path[inPath], dropped)
        setPath(path.slice(0, inPath + 1))
        return
      }
      // 在某个分支里：切到那条分支
      for (const [key, list] of Object.entries(branches)) {
        const branchIndex = list.findIndex((chain) => chain.some((item) => item.id === existing.id))
        if (branchIndex < 0) continue
        const parentIndex = path.findIndex((item) => branchKey(item) === key)
        if (parentIndex >= 0) {
          await switchBranch(parentIndex, branchIndex)
          return
        }
      }
      // 都不在：作为新节点接到当前卡后面（内容直接复用，不重新生成）
      setPath((prev) => [
        ...prev,
        {
          ...base,
          id: existing.id,
          level: existing.level ?? resolveLevel(activeProfile),
          answer: existing.answer,
          streaming: false,
          saved: true,
          promotedSessionId: existing.promoted_session_id ?? null,
        },
      ])
      return
    }

    // 命中优先：账本里已经有这个词，就先把旧结论摆出来，别再花一次钱
    try {
      const hit = await matchEntry(anchor.quote)
      if (hit) {
        const level = resolveLevel(activeProfile, hit.depth)
        setPath((prev) => [...prev, {
          ...base,
          level,
          answer: `**已有记录**（${activeProfile.levels.find((item) => item.id === level)?.label ?? hit.depth} · ${MASTERY_LABEL[hit.mastery]} · 记于 ${hit.created_at.slice(0, 10)}）\n\n${hit.gist}\n\n> 这是账本里的旧结论。要重新讲一遍点「重新生成」。`,
          streaming: false,
          saved: true,
        }])
        return
      }
    } catch {
      // 查不到就当新词处理
    }

    const level = resolveLevel(activeProfile)
    setPath((prev) => [...prev, { ...base, level, answer: '', streaming: true, saved: false }])
    void runCard(
      anchor,
      level,
      t('请解释这段内容。'),
      null,
      sourceText,
      false,
      undefined,
      base.parentCardId,
      base.parentText,
    )
  }, [activeProfile, card, pending, runCard, saveCard, t])

  const closeCard = useCallback(async () => {
    await saveCard()
    setPath([])
    setBranches({})
  }, [saveCard])

  const chain = path
  const activeIndex = path.length - 1

  /** 跳到链上第 k 层；被跳过的更深卡会变成这条路径上的一个分支，不会丢 */
  const jumpToLayer = useCallback(
    async (k: number) => {
      const target = path[k]
      if (!target || k === activeIndex) return
      await saveCard()
      const dropped = path.slice(k + 1)
      if (dropped.length > 0) rememberBranch(target, dropped)
      setPath(path.slice(0, k + 1))
      cardIdRef.current = target.id
    },
    [activeIndex, path, rememberBranch, saveCard],
  )

  const backToMain = useCallback(async () => {
    await saveCard()
    setPath([])
    setBranches({})
  }, [saveCard])

  // Esc 关闭卡片由 Card 自己处理（它要先播退场动画），这里只负责取消划词浮层
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !card) setPending(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card])

  const jumpTo = useCallback(
    async (sessionId: string | null, messageId: string | null) => {
      if (!messageId) return
      setTopicPageId(null)
      if (sessionId && sessionId !== sessionRef.current) {
        try {
          const view = await fetchSession(sessionId)
          localStorage.setItem('studydeck.session', view.id)
          setSessionId(view.id)
          setMessages(view.messages)
          setPath([])
          setTopicPageId(null)
          setCoursePageId(null)
        } catch (err) {
          setError(String(err))
          return
        }
      }
      window.setTimeout(() => {
        setFlashId(messageId)
        window.setTimeout(() => setFlashId(null), 2000)
      }, 60)
    },
    [],
  )

  if (settings && !gateSkipped && (!settings.configured || !settings.has_key)) {
    return (
      <SetupGate
        presets={presets}
        current={settings}
        onSaved={(view) => {
          setSettings(view)
          setFake(!view.has_key)
        }}
        onSkip={() => setGateSkipped(true)}
      />
    )
  }

  const currentTopic = topicPageId
    ? topics.find((item) => item.id === topicPageId)
    : null
  const currentCourse = coursePageId
    ? courses.find((item) => item.course.id === coursePageId)?.course
    : null
  const currentTitle =
    currentCourse?.title ||
    currentTopic?.title ||
    sessions.find((item) => item.id === sessionId)?.title ||
    topic?.title ||
    t('未命名')

  return (
    <div className="app">
      {sidebarOpen && (
        <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
      )}

      <Sidebar
        sessions={sessions}
        topics={topics}
        courses={courses}
        activeId={topicPageId || coursePageId ? null : sessionId}
        activeTopicId={topicPageId}
        activeCourseId={coursePageId}
        open={sidebarOpen}
        onSelect={(id) => void switchSession(id)}
        onOpenTopic={openTopic}
        onOpenCourse={openCourse}
        onNew={() => void newSession()}
        onNewCourse={() => setShowCourseDialog(true)}
        onRename={(id) => {
          const current = sessions.find((item) => item.id === id)
          setRenameValue(current?.title ?? '')
          setRenaming(id)
        }}
        onDelete={(id) => void handleDeleteSession(id)}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="workspace">
        <header className="topbar">
          <button
            className="icon"
            title={t('会话侧边栏')}
            onClick={() => setSidebarOpen((value) => !value)}
          >
            ☰
          </button>

          <div className="topbar-context">
            <span className="topbar-kicker">
              {coursePageId ? t('课程') : topicPageId ? t('专题') : t('会话')}
            </span>
            <span className="current-title" title={currentTitle}>
              {currentTitle}
            </span>
            {!topicPageId && topic && <span className="topic-chip">{t('专题')}</span>}
          </div>

          <div className="topbar-actions">
            {!topicPageId && !coursePageId && (
              <button
                className={glossaryOpen ? 'ghost active' : 'ghost'}
                onClick={() => setGlossaryOpen((value) => !value)}
              >
                {glossaryOpen ? t('收起账本') : t('账本')}
              </button>
            )}
            <div className="menu-wrap">
              <button
                className={menuOpen ? 'ghost active' : 'ghost'}
                title={t('更多')}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((value) => !value)}
              >
                ⋯
              </button>
              {menuOpen && (
                <div className="menu" role="menu">
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      setShowProfiles(true)
                    }}
                  >
                    {t('卡片模板')}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      setShowSettings(true)
                    }}
                  >
                    {t('设置')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {fake && <div className="banner">{t('演示模式：后端未配置模型，返回的是脚本内容')}</div>}

        {toolActivity && (
          <div className={`tool-activity ${toolActivity.state}`} role="status" aria-live="polite">
            <span className="tool-spinner" />
            <span>
              {toolActivity.state === 'running'
                ? toolLabel(toolActivity.name, toolActivity.args, t)
                : toolActivity.ok
                  ? t('已完成项目读取')
                  : t('项目读取失败')}
            </span>
          </div>
        )}

        {dueReminders.length > 0 && !reminderDismissed && (
          <div className="reminder-banner">
            <span>
              {t('今天有 {n} 个学习任务待完成：', { n: dueReminders.length })}
              {dueReminders
                .slice(0, 3)
                .map((item) => item.topic?.title || item.course_title)
                .join('、')}
              {dueReminders.length > 3 ? '…' : ''}
            </span>
            <button
              onClick={() => {
                openCourse(dueReminders[0].course_id)
                setReminderDismissed(true)
              }}
            >
              {t('查看')}
            </button>
            <button className="icon" onClick={() => setReminderDismissed(true)}>
              ×
            </button>
          </div>
        )}

        {coursePageId ? (
          <CoursePage
            courseId={coursePageId}
            topics={topics}
            onBack={() => setCoursePageId(null)}
            onOpenTopic={openTopic}
            onChanged={refreshWorkspace}
          />
        ) : topicPageId ? (
          <TopicPage
            topicId={topicPageId}
            sessions={sessions}
            topics={topics}
            onBack={() => setTopicPageId(null)}
            onOpenSession={(id) => void switchSession(id)}
            onJump={(sid, mid) => void jumpTo(sid, mid)}
            onChanged={refreshWorkspace}
            onDeleted={() => void handleTopicDeleted()}
          />
        ) : (
          <>
            {origin && (
              <OriginBanner
                origin={origin}
                topic={topic}
                canOutline={!!topic && messages.length === 0}
                busy={streamingId !== null}
                onBack={() => void jumpTo(origin.source_session_id, origin.source_message_id)}
                onOutline={() => void sendMain(t(OUTLINE_PROMPT), { saveOutline: true })}
              />
            )}

            <main className={`main ${glossaryOpen ? 'with-drawer' : ''}`}>
        <section className="chat">
          <MessageList
            messages={messages}
            streamingId={streamingId}
            flashId={flashId}
            onMouseUp={handleMouseUp}
          />
          <Composer
            disabled={!sessionId || streamingId !== null}
            onSend={sendMain}
            examples={EXAMPLES.map((item) => t(item))}
            status={
              <>
                <span className="status-model" title={t('当前对话模型')}>
                  <span className="status-dot" />
                  {settings?.model || t('未配置模型')}
                </span>
                {usage && usage.total_tokens > 0 && (
                  <span className="status-usage" title={t('本会话累计 token')}>
                    {formatTokens(usage.total_tokens)} tokens
                  </span>
                )}
              </>
            }
          />
        </section>

        {glossaryOpen && (
          <GlossaryPanel
            entries={entries}
            query={query}
            onQuery={setQuery}
            onClose={() => setGlossaryOpen(false)}
            onJump={(sessionId, messageId) => void jumpTo(sessionId, messageId)}
            onChanged={() => void refreshGlossary(query)}
            hits={hits}
            searchQuery={searchQuery}
            onSearchQuery={setSearchQuery}
          />
        )}
            </main>
          </>
        )}
      </div>

      {pending && (
        <button
          className="explain-btn"
          style={{
            left: Math.min(
              Math.max(8, pending.rect.left),
              window.innerWidth - 140,
            ),
            top:
              pending.rect.top < 56
                ? Math.min(
                    Math.max(8, pending.rect.top + pending.rect.height + 8),
                    window.innerHeight - 48,
                  )
                : Math.max(8, pending.rect.top - 8),
            transform: pending.rect.top < 56 ? 'none' : 'translateY(-100%)',
          }}
          onClick={openCard}
        >
          {t('解释选中内容')}
        </button>
      )}

      <CardLayer
        card={card}
        chain={chain}
        activeIndex={activeIndex}
        branches={branches}
        profile={activeProfile}
        onClose={() => void closeCard()}
        onJump={(index) => void jumpToLayer(index)}
        onSwitchBranch={(parentIndex, branchIndex) => void switchBranch(parentIndex, branchIndex)}
        onBackToMain={() => void backToMain()}
        onSelectInCard={handleMouseUp}
        onDepthChange={(level) => {
          if (!card) return
          void runCard(card.anchor, level, card.question, cardIdRef.current ?? card.id, card.sourceText)
        }}
        onFollowUp={(text) => {
          if (!card) return
          void runCard(
            card.anchor,
            resolveLevel(activeProfile, card.level),
            text,
            cardIdRef.current ?? card.id,
            card.sourceText,
            true,
            card.answer,
          )
        }}
        onSave={() => void saveCard()}
        onRegenerate={() => {
          if (!card) return
          updateCurrent((current) => ({ ...current, saved: false }))
          void runCard(
            card.anchor,
            resolveLevel(activeProfile, card.level),
            t('请重新解释这段内容。'),
            cardIdRef.current ?? card.id,
            card.sourceText,
          )
        }}
        onPromote={() => {
          if (card) setPromote(card)
        }}
        onOpenPromoted={() => {
          if (!card?.promotedSessionId) return
          const id = card.promotedSessionId
          setPath([])
          void switchSession(id)
        }}
      />

      {promote && (
        <PromoteDialog
          card={promote}
          initialDepth={depthForLevel(activeProfile, promote.level)}
          parentTitle={sessions.find((item) => item.id === sessionId)?.title ?? ''}
          topics={topics}
          busy={promoting}
          onCancel={() => setPromote(null)}
          onSubmit={(input) => void submitPromotion(input)}
        />
      )}

      {showCourseDialog && (
        <CourseDialog
          busy={creatingCourse}
          onCancel={() => setShowCourseDialog(false)}
          onSubmit={(input) => void submitCourse(input)}
        />
      )}

      {renaming && (
        <div className="modal-backdrop" onClick={() => setRenaming(null)}>
          <div className="modal narrow" onClick={(event) => event.stopPropagation()}>
            <header className="modal-head">
              <strong>{t('重命名会话')}</strong>
              <button className="icon" onClick={() => setRenaming(null)}>
                ×
              </button>
            </header>
            <input
              className="rename-input"
              autoFocus
              value={renameValue}
              placeholder={t('比如：Rust 所有权')}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !isImeComposing(event)) {
                  void (async () => {
                    await renameSession(renaming, renameValue)
                    setRenaming(null)
                    setSessions(await listSessions())
                  })()
                }
              }}
            />
            <div className="form-actions">
              <button
                className="primary"
                onClick={() => {
                  void (async () => {
                    await renameSession(renaming, renameValue)
                    setRenaming(null)
                    setSessions(await listSessions())
                  })()
                }}
              >
                {t('保存')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showProfiles && (
        <ProfilesModal
          profiles={profiles}
          activeId={activeProfile.id}
          onReload={refreshProfiles}
          onClose={() => setShowProfiles(false)}
        />
      )}

      {showSettings && settings && (
        <SettingsPanel
          presets={presets}
          settings={settings}
          onSaved={(view) => {
            setSettings(view)
            setFake(!view.has_key)
          }}
          onClose={() => setShowSettings(false)}
        />
      )}

      {error && (
        <div className="toast" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </div>
  )
}
