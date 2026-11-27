import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Composer } from './components/Composer'
import { Sidebar } from './components/Sidebar'
import { OriginBanner } from './components/OriginBanner'
import { PromoteDialog } from './components/PromoteDialog'
import { TopicPage } from './components/TopicPage'
import { MessageList } from './components/MessageList'
import { CardLayer } from './components/CardLayer'
import { GlossaryPanel } from './components/GlossaryPanel'
import { SetupGate } from './components/SetupGate'
import { SettingsPanel } from './components/SettingsPanel'
import { ProfilesModal } from './components/ProfilesModal'
import { type OpenCardState } from './components/Card'
import {
  createSession,
  fetchCardThread,
  fetchHealth,
  fetchProviders,
  fetchSession,
  fetchSettings,
  listGlossary,
  listProfiles,
  deleteCard,
  deleteSession,
  listSessions,
  matchEntry,
  renameSession,
  setSessionProfile,
  saveGlossary,
  searchMessages,
  streamChat,
  promoteCard,
  listTopics,
  updateTopic,
  parseTopicOutline,
} from './lib/api'
import { useI18n } from './lib/i18n'
import { isImeComposing } from './lib/ime'
import { readAnchor } from './lib/selection'
import { stripMarkdown } from './lib/markdown'
import {
  FALLBACK_PROFILE,
  MASTERY_LABEL,
  type Anchor,
  type CardProfile,
  type CardRecord,
  type CardTurn,
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

/** 同一处划词：锚点四件套 + 父卡都要一致，否则会误复用/误删别的卡 */
function sameAnchorRecord(record: CardRecord, anchor: Anchor, parentCardId: string | null): boolean {
  return (
    record.anchor.message_id === anchor.message_id &&
    record.anchor.quote === anchor.quote &&
    record.anchor.char_start === anchor.char_start &&
    record.anchor.char_end === anchor.char_end &&
    (record.parent_card_id ?? null) === parentCardId
  )
}

/** 账本标题：优先取引文的第一个短句（整段长句塞进 term 会变成垃圾条目） */
function suggestTerm(quote: string): string {
  const text = quote.replace(/\s+/g, ' ').trim()
  const cut = text.slice(0, 40).search(/[，。；：、,.;:!?！？]/)
  if (cut >= 4) return text.slice(0, cut)
  return text.slice(0, 24)
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

/** 把 card_turns 还原成卡片正文：首答 + 每轮「追问/回答」，和流式时的拼接格式一致。 */
function threadToAnswer(initial: string, turns: CardTurn[]): string {
  if (!turns.length) return initial
  const first = turns.find((turn) => turn.role === 'assistant')
  let out = first?.text || initial
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i]
    if (turn.role !== 'user') continue
    const next = turns[i + 1]
    const answer = next && next.role === 'assistant' ? next.text : ''
    out += `\n\n---\n\n**追问：** ${turn.text}\n\n${answer}`
    i += 1
  }
  return out
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
  const [topicPageId, setTopicPageId] = useState<string | null>(null)
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
  /** 流式生成中被删掉的卡：等拿到真实 id 后补一次服务端删除，避免留下孤儿行 */
  const pendingDeleteRef = useRef<Set<string>>(new Set())
  // 会话里已经存在的卡片（用于「同一处划词直接复用」）
  const sessionCardsRef = useRef<CardRecord[]>([])
  // cards 的同步镜像：addCard 之后要立刻能读到新节点（focusOn 靠它找根）
  const cardsRef = useRef<Record<string, OpenCardState>>({})
  // 正在进行的流式请求：切会话/删会话时统一中止，别把旧会话的 token 写进新会话
  const abortersRef = useRef<Set<AbortController>>(new Set())
  // openCard 互斥：连着划两段词时只认第一个，避免两张卡抢焦点
  const openingRef = useRef(false)
  // 从账本恢复：等目标会话渲染完再挂节点，避免被「切会话清空卡片树」的 effect 冲掉
  const pendingRestoreRef = useRef<{ sessionId: string; card: OpenCardState } | null>(null)

  // 换会话时清空卡片树；关闭卡片栈不清（同会话内再打开还能切回分支）
  useEffect(() => {
    setCards({})
    setFocusId(null)
    rememberedFocusRef.current = {}
    const pendingRestore = pendingRestoreRef.current
    if (pendingRestore && pendingRestore.sessionId === sessionId) {
      pendingRestoreRef.current = null
      const restored = { [pendingRestore.card.localId]: pendingRestore.card }
      cardsRef.current = restored
      setCards(restored)
      setFocusId(pendingRestore.card.localId)
    }
    // 深层路径记忆只在本次运行内有效：里面存的是 localId，重启后对不上
    if (!sessionId) {
      sessionCardsRef.current = []
      return
    }
    let alive = true
    void fetchSession(sessionId)
      .then((view) => {
        if (!alive) return
        // 冷启动也要有账本缓存，否则同锚点复用永远不命中，每次重开都白花一次模型调用
        sessionCardsRef.current = view.cards
        // 只把卡片记录留作「内容复用」的缓存；**不铺进树**。
        // 历史卡的子孙属于当时的上下文，换个上下文再打开不该继承。
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

  /**
   * 当前节点之后的下行路径。两条来源，缺一不可：
   * 1) 上次走过的那条（点回祖先时，刚刚的路径不能凭空消失）；
   * 2) 没走过时，沿「唯一子卡」往下补（只有一个去处 = 没有歧义，直接摆出来）。
   * 多个去处时只接上「探得最深」的一支，其余在下一层的 rail「同层」里。
   */
  const descendantPath = useMemo(() => {
    if (!card) return [] as OpenCardState[]
    const out: OpenCardState[] = []
    const seen = new Set<string>([card.localId])

    const root = chain[0]?.localId
    const deepest = root ? rememberedFocusRef.current[root] : null
    if (deepest && cards[deepest]) {
      const up: OpenCardState[] = []
      let cursor: string | null = deepest
      const guard = new Set<string>()
      while (cursor && cards[cursor] && !guard.has(cursor)) {
        guard.add(cursor)
        up.unshift(cards[cursor])
        cursor = cards[cursor].parentLocalId
      }
      const at = up.findIndex((node) => node.localId === card.localId)
      if (at >= 0) {
        for (const node of up.slice(at + 1)) {
          out.push(node)
          seen.add(node.localId)
        }
      }
    }

    // 没走过、又有多个子卡时：先接上「探得最深」的那一支，避免站在祖先上下不去。
    // 另一支就在下钻后的 rail「同层」里，一次点击可达。
    if (out.length === 0) {
      const kids = Object.values(cards).filter(
        (node) => node.parentLocalId === card.localId && !seen.has(node.localId),
      )
      if (kids.length > 1) {
        const weight = (id: string): number => {
          const list = Object.values(cards).filter((node) => node.parentLocalId === id)
          return list.length + list.reduce((sum, node) => sum + weight(node.localId), 0)
        }
        const best = kids.reduce((a, b) => (weight(b.localId) >= weight(a.localId) ? b : a))
        out.push(best)
        seen.add(best.localId)
      }
    }

    let cursor = out.length > 0 ? out[out.length - 1].localId : card.localId
    for (let step = 0; step < 8; step += 1) {
      const kids = Object.values(cards).filter(
        (node) => node.parentLocalId === cursor && !seen.has(node.localId),
      )
      if (kids.length !== 1) break
      out.push(kids[0])
      seen.add(kids[0].localId)
      cursor = kids[0].localId
    }
    return out
  }, [cards, card, chain, focusId])
  const activeIndex = chain.length - 1

  /** 这一层打开过、但已经删掉的卡：别再从缓存里捞回来 */
  const deletedIdsRef = useRef<Set<string>>(new Set())

  /**
   * 只补当前层的「平级」卡片，作为叶子节点（内容可复用、不带子孙）。
   * 历史卡的子树属于当时的上下文，换个上下文打开时不能继承。
   */
  useEffect(() => {
    if (!card?.id || !card.parentLocalId) return
    const parentId = card.parentCardId ?? null
    const records = sessionCardsRef.current.filter(
      (record) =>
        record.session_id === sessionRef.current &&
        (record.parent_card_id ?? null) === parentId &&
        record.id !== card.id &&
        !deletedIdsRef.current.has(record.id),
    )
    if (records.length === 0) return
    setCards((prev) => {
      const known = new Set(Object.values(prev).map((node) => node.id).filter(Boolean))
      const missing = records.filter((record) => !known.has(record.id))
      if (missing.length === 0) return prev
      const next: Record<string, OpenCardState> = { ...prev }
      for (const record of missing) {
        next[record.id] = {
          localId: record.id,
          id: record.id,
          anchor: record.anchor,
          level: record.level ?? '',
          question: record.question,
          answer: record.answer,
          streaming: false,
          saved: false,
          promotedSessionId: record.promoted_session_id ?? null,
          parentCardId: parentId,
          // 挂到内存里的父节点键上（可能是还没落库的 localId）
          parentLocalId: card.parentLocalId,
          parentText: null,
          rect: { left: 0, top: 0, width: 0, height: 0 },
          sourceText: '',
        }
      }
      cardsRef.current = next
      return next
    })
  }, [card])

  /** 当前卡的平级卡片（同一父节点下的其它卡） */
  const siblings = useMemo(() => {
    // 根卡（L1）没有「平级」一说：它们来自聊天里不同的选区，不是同一层的兄弟
    if (!card || !card.parentLocalId) return [] as OpenCardState[]
    return Object.values(cards).filter(
      (item) => item.parentLocalId === card.parentLocalId && item.localId !== card.localId,
    )
  }, [cards, card])
  // 同一处划词的其它根卡（第 1 层的「分支」没有父节点可挂，单独列出来）
  const treeCards = useMemo(() => Object.values(cards), [cards])
  const hasFork = useMemo(() => {
    const counts = new Map<string | null, number>()
    for (const node of treeCards) {
      counts.set(node.parentLocalId, (counts.get(node.parentLocalId) ?? 0) + 1)
    }
    return [...counts.values()].some((count) => count > 1)
  }, [treeCards])
  const addCard = useCallback((node: OpenCardState) => {
    setCards((prev) => {
      const next = { ...prev, [node.localId]: node }
      cardsRef.current = next
      return next
    })
  }, [])

  /** 只更新某一个节点——流式中切层/切分支也不会写错卡 */
  const updateCard = useCallback(
    (localId: string, updater: (current: OpenCardState) => OpenCardState) => {
      setCards((prev) => {
        const current = prev[localId]
        if (!current) return prev
        const next = updater(current)
        if (next === current) return prev
        const merged = { ...prev, [localId]: next }
        cardsRef.current = merged
        return merged
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
        // parentLocalId 是内存树的键，永远保持 localId 不变（改了会断链）；
        // 只有 parentCardId（发给接口的库 id）跟着父卡更新
        if (node.parentLocalId === localId && node.parentCardId !== realId) {
          next[key] = { ...node, parentCardId: realId }
          changed = true
        }
      }
      cardsRef.current = next
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
      const tree = cardsRef.current
      let root = localId
      let cursor = tree[localId]?.parentLocalId ?? null
      const seen = new Set<string>([localId])
      while (cursor && tree[cursor] && !seen.has(cursor)) {
        seen.add(cursor)
        root = cursor
        cursor = tree[cursor].parentLocalId
      }
      // 只记「更深」的那次：点回祖先时，之前的深层路径还能从面包屑走回去
      const previous = rememberedFocusRef.current[root]
      const depthOf = (id: string | undefined) => {
        let depth = 0
        let cursor = id ?? null
        const seen = new Set<string>()
        while (cursor && tree[cursor] && !seen.has(cursor)) {
          seen.add(cursor)
          depth += 1
          cursor = tree[cursor].parentLocalId
        }
        return depth
      }
      if (!previous || depthOf(localId) >= depthOf(previous)) {
        rememberedFocusRef.current[root] = localId
      }
    },
    [],
  )

  // 卡片栈：祖先在下，当前卡是 card
  const [pending, setPending] = useState<PendingSelection | null>(null)
  const [streamingId, setStreamingId] = useState<string | null>(null)
  /** 中止所有在跑的流（切会话/删会话）：否则旧流的 token 会写进新会话 */
  const abortStreams = useCallback(() => {
    for (const controller of abortersRef.current) controller.abort()
    abortersRef.current.clear()
    setStreamingId(null)
  }, [])
  const [glossaryOpen, setGlossaryOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
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
  const [sessionProfileId, setSessionProfileId] = useState<string | null>(null)
  const sessionProfile = useMemo(
    () => profiles.find((item) => item.id === sessionProfileId) ?? activeProfile,
    [profiles, sessionProfileId, activeProfile],
  )
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
              setSessionProfileId(view.profile_id ?? null)
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
            setSessionProfileId(chosen.profile_id ?? null)
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
      if (topicPageId || streamingId) return
      const sid = sessionRef.current
      if (!sid) return
      try {
        const view = await fetchSession(sid)
        // 请求期间切了会话：别把旧会话的消息盖到新会话上
        if (cancelled || sid !== sessionRef.current) return
        setMessages((current) => (sameMessages(current, view.messages) ? current : view.messages))
        setSessionProfileId((current) => (current === (view.profile_id ?? null) ? current : view.profile_id ?? null))
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
  }, [topicPageId, streamingId, sessionId])

  useEffect(() => {
    void refreshTopics()
  }, [refreshTopics])

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

  const switchSession = useCallback(async (id: string): Promise<boolean> => {
    if (!id) return false
    if (id === sessionRef.current) {
      setTopicPageId(null)
      return true
    }
    abortStreams()
    try {
      const view = await fetchSession(id)
      localStorage.setItem('studydeck.session', view.id)
      setSessionId(view.id)
      setMessages(view.messages)
      setOrigin(view.origin ?? null)
      setTopic(view.topic ?? null)
      setSessionProfileId(view.profile_id ?? null)
      setTopicPageId(null)
      if (window.innerWidth <= 900) setSidebarOpen(false)
      return true
    } catch (err) {
      setError(String(err))
      return false
    }
  }, [abortStreams])

  const newSession = useCallback(async () => {
    abortStreams()
    try {
      const id = await createSession()
      const view = await fetchSession(id)
      localStorage.setItem('studydeck.session', view.id)
      setSessionId(view.id)
      setMessages([])
      setOrigin(null)
      setTopic(null)
      setSessionProfileId(view.profile_id ?? null)
      setTopicPageId(null)
      await refreshSessions()
      if (window.innerWidth <= 900) setSidebarOpen(false)
    } catch (err) {
      setError(String(err))
    }
  }, [abortStreams, refreshSessions])

  const deletingRef = useRef<Set<string>>(new Set())

  const handleDeleteSession = useCallback(async (id: string) => {
    if (deletingRef.current.has(id)) return
    deletingRef.current.add(id)
    // 删除前先记住"它是不是当前会话"：await 之后 sessionRef 可能已经变了
    const wasCurrent = id === sessionRef.current
    if (wasCurrent) abortStreams()
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
      setSessionProfileId(view.profile_id ?? null)
      setTopicPageId(null)
      await refreshSessions()
    } catch (err) {
      setError(String(err))
    } finally {
      deletingRef.current.delete(id)
    }
  }, [abortStreams, refreshSessions])

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
    if (window.innerWidth <= 900) setSidebarOpen(false)
  }, [])

  const refreshWorkspace = useCallback(() => {
    void refreshSessions()
    void refreshTopics()
  }, [refreshSessions, refreshTopics])

  const handleTopicDeleted = useCallback(
    async (deletedTopicId: string) => {
      setTopicPageId(null)
      // 先本地摘掉，避免侧边栏等接口往返时还显示刚删的专题；
      // 刷新后再过滤一次，防止并发请求把旧列表带回来。
      setTopics((current) => current.filter((item) => item.id !== deletedTopicId))
      await refreshSessions()
      await refreshTopics()
      setTopics((current) => current.filter((item) => item.id !== deletedTopicId))
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
        setSessionProfileId(view.profile_id ?? null)
              } catch {
        await newSession()
      }
    },
    [refreshSessions, refreshTopics, newSession],
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
    const controller = new AbortController()
    abortersRef.current.add(controller)

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
      }, controller.signal)

      if (options?.saveOutline && topic?.id && streamed.trim()) {
        const updated = await updateTopic(topic.id, { outline_md: streamed })
        setTopic(updated)
        await parseTopicOutline(topic.id, streamed).catch(() => [])
        await refreshTopics()
      }
    } catch (err) {
      if (!controller.signal.aborted) setError(String(err))
    } finally {
      abortersRef.current.delete(controller)
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
      const controller = new AbortController()
      abortersRef.current.add(controller)
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
            profile_id: sessionProfile.id,
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
          controller.signal,
        )
      } catch (err) {
        if (!controller.signal.aborted) setError(String(err))
      } finally {
        abortersRef.current.delete(controller)
        updateCard(targetLocalId, (current) => ({ ...current, streaming: false }))
        clearTool()
      }

      if (!existingCardId) {
        try {
          const view = await fetchSession(sid)
          sessionCardsRef.current = view.cards
          // 精确到偏移和父卡，并按时间取最新一条（同一段文字可能出现多次）
          const matched = view.cards
            .filter(
              (item) =>
                item.session_id === sid && sameAnchorRecord(item, anchor, parentCardId ?? null),
            )
            .sort((a, b) => a.created_at.localeCompare(b.created_at))
            .pop()
          if (matched) {
            if (pendingDeleteRef.current.has(targetLocalId)) {
              pendingDeleteRef.current.delete(targetLocalId)
              void deleteCard(matched.id).catch(() => undefined)
              return
            }
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
    [sessionProfile.id, beginTool, finishTool, clearTool, lang, updateCard, relink],
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
        setSessionProfileId(view.profile_id ?? null)
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


  const changeSessionProfile = useCallback(async (profileId: string) => {
    const sid = sessionRef.current
    if (!sid) return
    try {
      await setSessionProfile(sid, profileId)
      setSessionProfileId(profileId)
    } catch (err) {
      setError(String(err))
    }
  }, [])

  const saveCard = useCallback(async () => {
    // 流式中的答案不完整，别写进账本（服务端会自己持久化卡片正文）
    if (!card || card.streaming || !card.answer.trim() || card.saved) return
    try {
      await saveGlossary({
        term: suggestTerm(card.anchor.quote),
        gist: stripMarkdown(card.answer).slice(0, 160),
        depth: depthForLevel(sessionProfile, card.level),
        anchor: card.anchor,
        profile_id: sessionProfile.id,
        level: card.level,
        parent_card_id: card.parentCardId ?? undefined,
        card_id: card.id ?? undefined,
      })
      updateCard(card.localId, (current) => ({ ...current, saved: true }))
      if (glossaryOpen) void refreshGlossary(query)
    } catch (err) {
      setError(String(err))
    }
  }, [sessionProfile, card, glossaryOpen, query, refreshGlossary])

  /** 在同一处内容上再问一个：在当前卡的父节点下新开一条兄弟分支 */
  const branchFrom = useCallback(
    (text: string) => {
      if (!card) return
      const parent = chain[activeIndex - 1] ?? null
      const level = resolveLevel(sessionProfile, card.level)
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
    [activeIndex, sessionProfile, addCard, card, chain, focusOn, runCard],
  )
  /** 删除一张卡及其所有子卡；焦点退回最近的存活祖先 */
  const deleteNode = useCallback(
    (localId: string) => {
      const tree = cardsRef.current
      const node = tree[localId]
      if (!node) return
      const doomed = new Set<string>()
      const stack = [localId]
      while (stack.length > 0) {
        const id = stack.pop() as string
        if (doomed.has(id)) continue
        doomed.add(id)
        for (const item of Object.values(tree)) {
          if (item.parentLocalId === id) stack.push(item.localId)
        }
      }
      const doomedDbIds = new Set<string>()
      for (const id of doomed) {
        const item = tree[id]
        if (!item) continue
        // 记下来：之后 seedSiblings / 复用缓存都别再把这些卡捞回来
        deletedIdsRef.current.add(item.id ?? item.localId)
        if (item.id) doomedDbIds.add(item.id)
      }
      for (const [root, deepest] of Object.entries(rememberedFocusRef.current)) {
        if (doomed.has(deepest) || doomed.has(root)) delete rememberedFocusRef.current[root]
      }
      setCards((prev) => {
        const next = { ...prev }
        for (const id of doomed) delete next[id]
        cardsRef.current = next
        return next
      })
      sessionCardsRef.current = sessionCardsRef.current.filter((item) => !doomedDbIds.has(item.id))
      if (focusId && doomed.has(focusId)) {
        let cursor: string | null = node.parentLocalId
        while (cursor && doomed.has(cursor)) {
          cursor = tree[cursor]?.parentLocalId ?? null
        }
        // 祖先可能已经不在树里（历史卡），退到最上层可用节点
        if (cursor && !tree[cursor]) cursor = null
        setFocusId(cursor)
      }
      for (const id of doomedDbIds) {
        // 服务端会级联删子树；失败不回滚 UI，但别吞成 unhandled rejection
        void deleteCard(id).catch(() => undefined)
      }
      if (!node.id && node.streaming) {
        // 还没落库（id 未知）：等 runCard 拿到 id 后再删，别让它留成孤儿
        pendingDeleteRef.current.add(localId)
      }
    },
    [focusId],
  )

  const openCard = useCallback(async () => {
    if (!pending || openingRef.current) return
    openingRef.current = true
    try {
    const { anchor, rect, sourceText, fromCardId } = pending
    setPending(null)
    window.getSelection()?.removeAllRanges()

    // 嵌套展开：选区确实来自当前这张卡（否则说明已经切层了，别挂错父卡）
    const nestingFrom =
      fromCardId && card && (fromCardId === card.id || fromCardId === card.localId) ? card : null
    const parentLocalId = nestingFrom?.localId ?? null
    const parentCardId = nestingFrom?.id ?? null

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
        (item) => item.session_id === sessionRef.current && sameAnchorRecord(item, anchor, parentCardId),
      )
      if (existing) {
        if (land((item) => item.id === existing.id)) return
        // 不在内存树里：作为新节点接在后面，内容直接复用
        let reusedAnswer = existing.answer
        try {
          const thread = await fetchCardThread(existing.id)
          reusedAnswer = threadToAnswer(thread.card.answer, thread.turns)
        } catch {
          // 取线程失败就退回 cards.answer，别阻断打开
        }
        const reused: OpenCardState = {
          localId: newLocalId(),
          id: existing.id,
          anchor,
          level: existing.level ?? resolveLevel(sessionProfile),
          answer: reusedAnswer,
          streaming: false,
          // 有卡片不代表已记账：账本条目只由用户点「保存到账本」产生
          saved: false,
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
      const hit = await matchEntry(suggestTerm(anchor.quote))
      if (hit) {
        const level = resolveLevel(sessionProfile, hit.depth)
        const reused: OpenCardState = {
          localId: newLocalId(),
          id: null,
          anchor,
          level,
          answer: `**已有记录**（${sessionProfile.levels.find((item) => item.id === level)?.label ?? hit.depth} · ${MASTERY_LABEL[hit.mastery]} · 记于 ${hit.created_at.slice(0, 10)}）\n\n${hit.gist}\n\n> 这是账本里的旧结论。要重新讲一遍点「重新生成」。`,
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
    const level = resolveLevel(sessionProfile)
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
    } finally {
      openingRef.current = false
    }
  }, [sessionProfile, addCard, card, cards, focusOn, pending, runCard, t])

  /** 从账本恢复：切到卡片所属会话，把整条线程按原样重新挂出来 */
  const resumeCard = useCallback(
    async (cardId: string) => {
      try {
        const thread = await fetchCardThread(cardId)
        const node: OpenCardState = {
          localId: newLocalId(),
          id: thread.card.id,
          anchor: thread.card.anchor,
          level: thread.card.level ?? resolveLevel(sessionProfile, thread.card.depth),
          answer: threadToAnswer(thread.card.answer, thread.turns),
          streaming: false,
          saved: true,
          promotedSessionId: thread.card.promoted_session_id ?? null,
          parentCardId: null,
          parentLocalId: null,
          parentText: null,
          question: thread.card.question,
          // 旧卡没有当前选区坐标：Card 内部会居中摆放
          rect: { left: 0, top: 0, width: 0, height: 0 },
          sourceText: thread.card.anchor.quote,
        }
        const target = thread.card.session_id
        if (target && target !== sessionRef.current) {
          pendingRestoreRef.current = { sessionId: target, card: node }
          const switched = await switchSession(target)
          if (switched) return
          pendingRestoreRef.current = null
        }
        addCard(node)
        focusOn(node.localId)
      } catch (err) {
        setError(String(err))
      }
    },
    [sessionProfile, addCard, focusOn, switchSession],
  )

  // 关卡片只收起界面：账本只认用户点「保存到账本」，不做自动记账
  const closeCard = useCallback(() => {
    setFocusId(null)
    setPinned(false)
  }, [])

  /** 跳到链上第 k 层；跳过的更深层留在树里当分支，随时能切回 */
  const jumpToLayer = useCallback(
    (k: number) => {
      const target = chain[k]
      if (!target || k === activeIndex) return
      focusOn(target.localId)
    },
    [activeIndex, chain, focusOn],
  )

  // 「回到主线」和关闭卡片是同一件事，别再留两份实现
  const backToMain = closeCard

  // 只有手动钉住才进 dock（不再按层数自动切）
  const docked = Boolean(card) && pinned

  // 切层/关卡后，之前那一下划词就不算数了：否则会把新卡挂到别的卡下面
  useEffect(() => {
    setPending(null)
  }, [focusId])

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
          setSessionProfileId(view.profile_id ?? null)
          setTopicPageId(null)
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
  const currentTitle =
    currentTopic?.title ||
    sessions.find((item) => item.id === sessionId)?.title ||
    topic?.title ||
    t('未命名')

  return (
    <div className={`app${docked ? ' with-dock' : ''}${docked && hasFork ? ' with-tree' : ''}`}>
      {sidebarOpen && (
        <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
      )}

      <Sidebar
        sessions={sessions}
        topics={topics}
        activeId={topicPageId ? null : sessionId}
        activeTopicId={topicPageId}
        open={sidebarOpen}
        onSelect={(id) => void switchSession(id)}
        onOpenTopic={openTopic}
        onNew={() => void newSession()}
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
              {topicPageId ? t('专题') : t('会话')}
            </span>
            <span className="current-title" title={currentTitle}>
              {currentTitle}
            </span>
            {!topicPageId && topic && <span className="topic-chip">{t('专题')}</span>}
          </div>

          <div className="topbar-actions">
            {!topicPageId && sessionId && profiles.length > 0 && (
              <label className="profile-picker" title={t('本会话卡片模板')}>
                <span>{t('本会话模板')}</span>
                <select
                  value={sessionProfile.id}
                  aria-label={t('本会话卡片模板')}
                  onChange={(event) => void changeSessionProfile(event.target.value)}
                >
                  {profiles.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!topicPageId && (
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

        {topicPageId ? (
          <TopicPage
            topicId={topicPageId}
            sessions={sessions}
            topics={topics}
            onBack={() => {
              setTopicPageId(null)
                      }}
            onOpenSession={(id) => void switchSession(id)}
            onJump={(sid, mid) => void jumpTo(sid, mid)}
            onChanged={refreshWorkspace}
            onDeleted={() => void handleTopicDeleted(topicPageId)}
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

            <main className="main">
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
            onResumeCard={(cardId) => void resumeCard(cardId)}
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
        descendantPath={descendantPath}
        siblings={siblings}
        treeCards={treeCards}
        onFocusNode={focusOn}
        docked={docked}
        profile={sessionProfile}
        onClose={() => void closeCard()}
        onJump={(index) => void jumpToLayer(index)}
        onToggleDock={() => setPinned((value) => !value)}
        onDeleteNode={deleteNode}
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
            resolveLevel(sessionProfile, card.level),
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
            resolveLevel(sessionProfile, card.level),
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
          initialDepth={depthForLevel(sessionProfile, promote.level)}
          parentTitle={sessions.find((item) => item.id === sessionId)?.title ?? ''}
          topics={topics}
          busy={promoting}
          onCancel={() => setPromote(null)}
          onSubmit={(input) => void submitPromotion(input)}
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
