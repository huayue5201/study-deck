import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { type OpenCardState } from './components/Card'
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

let localCardSeq = 0
const newLocalId = () =>
  `lc_${Date.now().toString(36)}_${(localCardSeq++).toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 6)}`

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
  // 卡片树：localId → 节点，父子关系靠 parentLocalId；focusId 指向当前聚焦的卡。
  // 层级不再用 path + branches 两套状态：路径由 parent 链派生，分支就是兄弟节点。
  const [cards, setCards] = useState<Record<string, OpenCardState>>({})
  const [focusId, setFocusId] = useState<string | null>(null)
  // 每棵子树上次看到的最深处：切分支时能回到原位
  const rememberedFocusRef = useRef<Record<string, string>>({})
  // 会话里已经存在的卡片（用于「同一处划词直接复用」）
  const sessionCardsRef = useRef<CardRecord[]>([])

  // 换会话时清空卡片树；关闭卡片栈不清（同会话内再打开还能切回分支）
  useEffect(() => {
    setCards({})
    setFocusId(null)
    rememberedFocusRef.current = {}
    // 冷启动也要有账本缓存，否则同锚点复用永远不命中，每次重开都白花一次模型调用
    if (!sessionId) {
      sessionCardsRef.current = []
      return
    }
    let alive = true
    void fetchSession(sessionId)
      .then((view) => {
        if (alive) sessionCardsRef.current = view.cards
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [sessionId])

  // 当前路径 = 从焦点往上走到根
  const chain = useMemo(() => {
    const out: OpenCardState[] = []
    let cursor = focusId
    const seen = new Set<string>()
    while (cursor && cards[cursor] && !seen.has(cursor)) {
      seen.add(cursor)
      const node = cards[cursor]
      out.unshift(node)
      cursor = node.parentLocalId
    }
    return out
  }, [cards, focusId])
  const card = chain.length > 0 ? chain[chain.length - 1] : null
  const activeIndex = chain.length - 1

  /** 每层「往下走」的其它选择（= 分支）。分支就是树的子节点，不需要另存快照 */
  const branchLists = useMemo(() => {
    const byParent = new Map<string | null, OpenCardState[]>()
    for (const node of Object.values(cards)) {
      const list = byParent.get(node.parentLocalId) ?? []
      list.push(node)
      byParent.set(node.parentLocalId, list)
    }
    return chain.map((node, index) => {
      const next = chain[index + 1]
      return (byParent.get(node.localId) ?? []).filter((item) => item.localId !== next?.localId)
    })
  }, [cards, chain])

  // 同一处划词的其它根卡（第 1 层的「分支」没有父节点可挂，单独列出来）
  const rootBranches = useMemo(
    () =>
      Object.values(cards).filter(
        (item) => item.parentLocalId === null && item.localId !== chain[0]?.localId,
      ),
    [cards, chain],
  )

  const addCard = useCallback((node: OpenCardState) => {
    setCards((prev) => ({ ...prev, [node.localId]: node }))
  }, [])

  /** 只更新某一个节点——流式中切层/切分支也不会写错卡 */
  const updateCard = useCallback(
    (localId: string, updater: (current: OpenCardState) => OpenCardState) => {
      setCards((prev) => {
        const current = prev[localId]
        if (!current) return prev
        const next = updater(current)
        return next === current ? prev : { ...prev, [localId]: next }
      })
    },
    [],
  )

  /** 卡片落库拿到 id 后：补上自己的 id，并把子卡指向真实父 id（内存树靠 parentLocalId，不受影响） */
  const relink = useCallback((localId: string, realId: string) => {
    setCards((prev) => {
      let changed = false
      const next = { ...prev }
      const self = next[localId]
      if (self && self.id !== realId) {
        next[localId] = { ...self, id: realId }
        changed = true
      }
      for (const [key, node] of Object.entries(next)) {
        if (node.parentLocalId === localId && node.parentCardId !== realId) {
          next[key] = { ...node, parentCardId: realId }
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  /** 聚焦某张卡：记住它所在子树的最深处，切回来时回到原位 */
  const focusOn = useCallback(
    (localId: string | null) => {
      if (!localId) {
        setFocusId(null)
        return
      }
      setFocusId(localId)
      let root = localId
      let cursor = cards[localId]?.parentLocalId ?? null
      const seen = new Set<string>([localId])
      while (cursor && cards[cursor] && !seen.has(cursor)) {
        seen.add(cursor)
        root = cursor
        cursor = cards[cursor].parentLocalId
      }
      rememberedFocusRef.current[root] = localId
    },
    [cards],
  )

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
      targetLocalId: string,
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
      updateCard(targetLocalId, (current) => ({
        ...current,
        answer:
          append && current.answer.trim()
            ? `${current.answer}\n\n---\n\n**追问：** ${text}\n\n`
            : '',
        streaming: true,
        level,
        question: text,
        sourceText,
      }))

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
              updateCard(targetLocalId, (current) => ({
                ...current,
                answer: current.answer + frame.text,
              }))
            }
            if (frame.type === 'tool_call') beginTool(frame.name, frame.args)
            if (frame.type === 'tool_done') finishTool(frame.name, frame.ok)
            if (frame.type === 'error') {
              updateCard(targetLocalId, (current) => ({
                ...current,
                answer: `${current.answer}\n\n**出错**：${frame.message}`,
              }))
            }
          },
        )
      } catch (err) {
        setError(String(err))
      } finally {
        updateCard(targetLocalId, (current) => ({ ...current, streaming: false }))
        clearTool()
      }

      if (!existingCardId) {
        try {
          const view = await fetchSession(sid)
          sessionCardsRef.current = view.cards
          const matched = view.cards
            .filter((item) => item.anchor.message_id === anchor.message_id && item.anchor.quote === anchor.quote)
            .pop()
          if (matched) {
            relink(targetLocalId, matched.id)
            updateCard(targetLocalId, (current) => ({
              ...current,
              promotedSessionId: matched.promoted_session_id ?? current.promotedSessionId,
            }))
          }
        } catch {
          // 拿不到 id 也能继续用，只是追问会新开一张卡片
        }
      }
    },
    [activeProfile.id, beginTool, finishTool, clearTool, lang, updateCard, relink],
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
    // 流式中的答案不完整，别写进账本（服务端会自己持久化卡片正文）
    if (!card || card.streaming || !card.answer.trim() || card.saved) return
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
      updateCard(card.localId, (current) => ({ ...current, saved: true }))
      if (glossaryOpen) void refreshGlossary(query)
    } catch (err) {
      setError(String(err))
    }
  }, [activeProfile, card, glossaryOpen, query, refreshGlossary])

  /** 在「某个祖先」的多个分支之间切换 */
  /** 在某个祖先的多个分支之间切换（分支 = 兄弟节点，切过去就是聚焦它上次的位置） */
  const switchBranch = useCallback(
    (parentIndex: number, targetLocalId: string) => {
      const list = parentIndex < 0 ? rootBranches : branchLists[parentIndex]
      if (!list?.some((item) => item.localId === targetLocalId)) return
      focusOn(rememberedFocusRef.current[targetLocalId] ?? targetLocalId)
    },
    [branchLists, focusOn, rootBranches],
  )

  /** 在同一处内容上再问一个：在当前卡的父节点下新开一条兄弟分支 */
  const branchFrom = useCallback(
    (text: string) => {
      if (!card) return
      const parent = chain[activeIndex - 1] ?? null
      const level = resolveLevel(activeProfile, card.level)
      const node: OpenCardState = {
        localId: newLocalId(),
        id: null,
        anchor: card.anchor,
        level,
        answer: '',
        streaming: true,
        saved: false,
        promotedSessionId: null,
        parentCardId: parent?.id ?? null,
        parentLocalId: parent?.localId ?? null,
        parentText: parent?.answer ?? null,
        question: text,
        rect: card.rect,
        sourceText: card.sourceText,
      }
      addCard(node)
      focusOn(node.localId)
      void runCard(
        node.localId,
        node.anchor,
        level,
        text,
        null,
        node.sourceText,
        false,
        undefined,
        node.parentCardId,
        node.parentText,
      )
    },
    [activeIndex, activeProfile, addCard, card, chain, focusOn, runCard],
  )
  const openCard = useCallback(async () => {
    if (!pending) return
    const { anchor, rect, sourceText, fromCardId } = pending
    setPending(null)
    window.getSelection()?.removeAllRanges()

    // 嵌套展开：选区在当前卡里。父卡可能还没落库（id 为空），用 localId 连树
    const nestingFrom = fromCardId && card ? card : null
    const parentLocalId = nestingFrom?.localId ?? null
    const parentCardId = nestingFrom?.id ?? null
    if (nestingFrom) await saveCard()

    const sameAnchor = (item: OpenCardState) =>
      item.anchor.message_id === anchor.message_id &&
      item.anchor.quote === anchor.quote &&
      item.anchor.char_start === anchor.char_start &&
      item.anchor.char_end === anchor.char_end

    /** 这张卡已经在树里：直接聚焦过去，0 次模型调用 */
    const land = (predicate: (item: OpenCardState) => boolean): boolean => {
      const hit = Object.values(cards).find(predicate)
      if (!hit) return false
      focusOn(hit.localId)
      return true
    }

    // 1) 内存里已经有同一处划词（同父卡）：直接跳，0 次模型调用
    const memoryHit = Object.values(cards).find(
      (item) => item.parentLocalId === parentLocalId && sameAnchor(item),
    )
    if (memoryHit && land((item) => item.localId === memoryHit.localId)) return

    // 2) 数据库里已有同一处划词（父卡已经有真实 id 才能可靠比对）
    if (!nestingFrom || parentCardId) {
      const existing = sessionCardsRef.current.find(
        (item) =>
          item.session_id === sessionRef.current &&
          (item.parent_card_id ?? null) === parentCardId &&
          item.anchor.message_id === anchor.message_id &&
          item.anchor.quote === anchor.quote &&
          item.anchor.char_start === anchor.char_start &&
          item.anchor.char_end === anchor.char_end,
      )
      if (existing) {
        if (land((item) => item.id === existing.id)) return
        // 不在内存树里：作为新节点接在后面，内容直接复用
        const reused: OpenCardState = {
          localId: newLocalId(),
          id: existing.id,
          anchor,
          level: existing.level ?? resolveLevel(activeProfile),
          answer: existing.answer,
          streaming: false,
          saved: true,
          promotedSessionId: existing.promoted_session_id ?? null,
          parentCardId,
          parentLocalId,
          parentText: nestingFrom?.answer ?? null,
          question: anchor.quote,
          rect,
          sourceText,
        }
        addCard(reused)
        focusOn(reused.localId)
        return
      }
    }

    // 3) 账本里已经有这个词：先把旧结论摆出来，别再花一次钱
    try {
      const hit = await matchEntry(anchor.quote)
      if (hit) {
        const level = resolveLevel(activeProfile, hit.depth)
        const reused: OpenCardState = {
          localId: newLocalId(),
          id: null,
          anchor,
          level,
          answer: `**已有记录**（${activeProfile.levels.find((item) => item.id === level)?.label ?? hit.depth} · ${MASTERY_LABEL[hit.mastery]} · 记于 ${hit.created_at.slice(0, 10)}）\n\n${hit.gist}\n\n> 这是账本里的旧结论。要重新讲一遍点「重新生成」。`,
          streaming: false,
          saved: true,
          promotedSessionId: null,
          parentCardId,
          parentLocalId,
          parentText: nestingFrom?.answer ?? null,
          question: anchor.quote,
          rect,
          sourceText,
        }
        addCard(reused)
        focusOn(reused.localId)
        return
      }
    } catch {
      // 查不到就当新词处理
    }

    // 4) 新卡：先挂节点（有自己的 localId），再发起流式请求
    const level = resolveLevel(activeProfile)
    const node: OpenCardState = {
      localId: newLocalId(),
      id: null,
      anchor,
      level,
      answer: '',
      streaming: true,
      saved: false,
      promotedSessionId: null,
      parentCardId,
      parentLocalId,
      parentText: nestingFrom?.answer ?? null,
      question: anchor.quote,
      rect,
      sourceText,
    }
    addCard(node)
    focusOn(node.localId)
    void runCard(
      node.localId,
      anchor,
      level,
      t('请解释这段内容。'),
      null,
      sourceText,
      false,
      undefined,
      parentCardId,
      nestingFrom?.answer ?? null,
    )
  }, [activeProfile, addCard, card, cards, focusOn, pending, runCard, saveCard, t])

  const closeCard = useCallback(async () => {
    await saveCard()
    setFocusId(null)
  }, [saveCard])

  /** 跳到链上第 k 层；跳过的更深层留在树里当分支，随时能切回 */
  const jumpToLayer = useCallback(
    (k: number) => {
      const target = chain[k]
      if (!target || k === activeIndex) return
      focusOn(target.localId)
    },
    [activeIndex, chain, focusOn],
  )

  const backToMain = useCallback(async () => {
    await saveCard()
    setFocusId(null)
  }, [saveCard])

  // 深度 ≥3 自动钉到右侧，或用户手动钉住
  const [pinned, setPinned] = useState(false)
  const docked = Boolean(card) && (pinned || chain.length >= 3)

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
    <div className={`app${docked ? ' with-dock' : ''}`}>
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
        branchLists={branchLists}
        rootBranches={rootBranches}
        docked={docked}
        profile={activeProfile}
        onClose={() => void closeCard()}
        onJump={(index) => void jumpToLayer(index)}
        onSwitchBranch={switchBranch}
        onToggleDock={() => setPinned((value) => !value)}
        onBranch={branchFrom}
        onBackToMain={() => void backToMain()}
        onSelectInCard={handleMouseUp}
        onDepthChange={(level) => {
          if (!card) return
          void runCard(card.localId, card.anchor, level, card.question, card.id, card.sourceText)
        }}
        onFollowUp={(text) => {
          if (!card) return
          void runCard(
            card.localId,
            card.anchor,
            resolveLevel(activeProfile, card.level),
            text,
            card.id,
            card.sourceText,
            true,
            card.answer,
          )
        }}
        onSave={() => void saveCard()}
        onRegenerate={() => {
          if (!card) return
          updateCard(card.localId, (current) => ({ ...current, saved: false }))
          void runCard(
            card.localId,
            card.anchor,
            resolveLevel(activeProfile, card.level),
            t('请重新解释这段内容。'),
            card.id,
            card.sourceText,
          )
        }}
        onPromote={() => {
          if (card) setPromote(card)
        }}
        onOpenPromoted={() => {
          if (!card?.promotedSessionId) return
          const id = card.promotedSessionId
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
