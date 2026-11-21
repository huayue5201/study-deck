import { useCallback, useEffect, useRef, useState } from 'react'
import { Composer } from './components/Composer'
import { MessageList } from './components/MessageList'
import { CardLayer } from './components/CardLayer'
import { GlossaryPanel } from './components/GlossaryPanel'
import { SetupGate } from './components/SetupGate'
import { SettingsPanel } from './components/SettingsPanel'
import type { OpenCardState } from './components/Card'
import {
  createSession,
  fetchHealth,
  fetchProviders,
  fetchSession,
  fetchSettings,
  listGlossary,
  deleteSession,
  listSessions,
  matchEntry,
  renameSession,
  saveGlossary,
  searchMessages,
  streamChat,
} from './lib/api'
import { readAnchor } from './lib/selection'
import {
  DEPTH_LABEL,
  MASTERY_LABEL,
  type Anchor,
  type Depth,
  type GlossaryEntry,
  type Message,
  type MessageHit,
  type ProviderPreset,
  type SessionSummary,
  type SessionView,
  type SettingsView,
} from './lib/types'

interface PendingSelection {
  anchor: Anchor
  rect: { left: number; top: number; width: number; height: number }
  sourceText: string
}

const EXAMPLES = [
  '讲讲采样定理，并指出哪些概念我现在可以不懂',
  '帮我理解 React 的 key 到底在解决什么问题',
  '我在学 Rust 所有权，给一个我能跑的小例子',
]

function stripMarkdown(text: string): string {
  return text
    .replace(/[#>*`_\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [fake, setFake] = useState(false)
  const [card, setCard] = useState<OpenCardState | null>(null)
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
  const [gateSkipped, setGateSkipped] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [hits, setHits] = useState<MessageHit[]>([])
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const sessionRef = useRef<string | null>(null)
  const assistantIdRef = useRef<string | null>(null)
  const cardIdRef = useRef<string | null>(null)

  sessionRef.current = sessionId

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
            setSessions(await listSessions().catch(() => []))
          }
          return
        }

        const id = await createSession()
        localStorage.setItem('studydeck.session', id)
        if (!cancelled) {
          setSessionId(id)
          setMessages([])
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

  useEffect(() => {
    if (sessionId) void refreshSessions()
  }, [sessionId, refreshSessions])

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
    if (!id || id === sessionRef.current) return
    try {
      const view = await fetchSession(id)
      localStorage.setItem('studydeck.session', view.id)
      setSessionId(view.id)
      setMessages(view.messages)
      setCard(null)
    } catch (err) {
      setError(String(err))
    }
  }, [])

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

  const sendMain = useCallback(async (text: string) => {
    const sid = sessionRef.current
    if (!sid) return
    setError(null)

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
      await streamChat({ session_id: sid, mode: 'main', text }, (frame) => {
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
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantIdRef.current
                ? { ...message, text: message.text + frame.text }
                : message,
            ),
          )
        }
        if (frame.type === 'error') setError(frame.message)
      })
    } catch (err) {
      setError(String(err))
    } finally {
      setStreamingId(null)
      void refreshSessions()
    }
  }, [refreshSessions])

  const runCard = useCallback(
    async (
      anchor: Anchor,
      depth: Depth,
      text: string,
      existingCardId: string | null,
      sourceText: string,
    ) => {
      const sid = sessionRef.current
      if (!sid) return
      setCard((current) =>
        current
          ? { ...current, answer: '', streaming: true, depth, question: text, sourceText }
          : current,
      )

      try {
        await streamChat(
          {
            session_id: sid,
            mode: 'card',
            text,
            anchor,
            depth,
            card_id: existingCardId ?? undefined,
          },
          (frame) => {
            if (frame.type === 'delta') {
              setCard((current) =>
                current ? { ...current, answer: current.answer + frame.text } : current,
              )
            }
            if (frame.type === 'error') {
              setCard((current) =>
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
        setCard((current) => (current ? { ...current, streaming: false } : current))
      }

      if (!existingCardId) {
        try {
          const view = await fetchSession(sid)
          const matched = view.cards
            .filter((item) => item.anchor.message_id === anchor.message_id && item.anchor.quote === anchor.quote)
            .pop()
          if (matched) cardIdRef.current = matched.id
          setCard((current) => (current ? { ...current, id: matched?.id ?? null } : current))
        } catch {
          // 拿不到 id 也能继续用，只是追问会新开一张卡片
        }
      }
    },
    [],
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
    })
  }, [])

  const openCard = useCallback(async () => {
    if (!pending) return
    const { anchor, rect, sourceText } = pending
    setPending(null)
    window.getSelection()?.removeAllRanges()
    cardIdRef.current = null

    const base = {
      id: null as string | null,
      anchor,
      question: anchor.quote,
      rect,
      sourceText,
    }

    // 命中优先：账本里已经有这个词，就先把旧结论摆出来，别再花一次钱
    try {
      const hit = await matchEntry(anchor.quote)
      if (hit) {
        setCard({
          ...base,
          depth: hit.depth,
          answer: `**已有记录**（${DEPTH_LABEL[hit.depth]} · ${MASTERY_LABEL[hit.mastery]} · 记于 ${hit.created_at.slice(0, 10)}）\n\n${hit.gist}\n\n> 这是账本里的旧结论。要重新讲一遍点「重新生成」。`,
          streaming: false,
          saved: true,
        })
        return
      }
    } catch {
      // 查不到就当新词处理
    }

    setCard({ ...base, depth: 'can_tune', answer: '', streaming: true, saved: false })
    void runCard(anchor, 'can_tune', '请解释这段内容。', null, sourceText)
  }, [pending, runCard])

  const saveCard = useCallback(async () => {
    if (!card || !card.answer.trim() || card.saved) return
    try {
      await saveGlossary({
        term: card.anchor.quote.slice(0, 80),
        gist: stripMarkdown(card.answer).slice(0, 160),
        depth: card.depth,
        anchor: card.anchor,
      })
      setCard((current) => (current ? { ...current, saved: true } : current))
      if (glossaryOpen) void refreshGlossary(query)
    } catch (err) {
      setError(String(err))
    }
  }, [card, glossaryOpen, query, refreshGlossary])

  const closeCard = useCallback(async () => {
    await saveCard()
    setCard(null)
  }, [saveCard])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (card) void closeCard()
        else setPending(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, closeCard])

  const jumpTo = useCallback(
    async (sessionId: string | null, messageId: string | null) => {
      if (!messageId) return
      if (sessionId && sessionId !== sessionRef.current) {
        try {
          const view = await fetchSession(sessionId)
          localStorage.setItem('studydeck.session', view.id)
          setSessionId(view.id)
          setMessages(view.messages)
          setCard(null)
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

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">study-deck</span>
        <span className="tagline">不懂就选中它</span>
        <span className="spacer" />
        <select
          className="session-picker"
          value={sessionId ?? ''}
          onChange={(event) => void switchSession(event.target.value)}
          title="切换会话（nvim 投递的会话也会出现在这里）"
        >
          {sessions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title || '未命名'} · {item.messages}
            </option>
          ))}
        </select>
        <button
          title="重命名当前会话"
          onClick={() => {
            const current = sessions.find((item) => item.id === sessionId)
            setRenameValue(current?.title ?? '')
            setRenaming(sessionId)
          }}
        >
          ✎
        </button>
        <button
          className={confirmDelete ? 'danger' : ''}
          title={confirmDelete ? '再点一次确认删除' : '删除当前会话'}
          onClick={() => {
            if (!sessionId) return
            if (!confirmDelete) {
              setConfirmDelete(true)
              window.setTimeout(() => setConfirmDelete(false), 3000)
              return
            }
            setConfirmDelete(false)
            void (async () => {
              await deleteSession(sessionId)
              const recent = await listSessions()
              setSessions(recent)
              const next = recent.find((item) => item.messages > 0) ?? recent[0]
              const fresh = next ? next.id : await createSession()
              const view = await fetchSession(fresh)
              localStorage.setItem('studydeck.session', view.id)
              setSessionId(view.id)
              setMessages(view.messages)
              setCard(null)
            })()
          }}
        >
          {confirmDelete ? '确认？' : '🗑'}
        </button>
        <button onClick={() => setShowSettings(true)}>设置</button>
        <button onClick={() => setGlossaryOpen((value) => !value)}>
          {glossaryOpen ? '收起账本' : '账本'}
        </button>
      </header>

      {fake && <div className="banner">演示模式：后端未配置模型，返回的是脚本内容</div>}

      <main className={`main ${glossaryOpen ? 'with-drawer' : ''}`}>
        <section className="chat">
          <MessageList
            messages={messages}
            streamingId={streamingId}
            flashId={flashId}
            onMouseUp={handleMouseUp}
          />
          <Composer disabled={!sessionId || streamingId !== null} onSend={sendMain} examples={EXAMPLES} />
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

      {pending && (
        <button
          className="explain-btn"
          style={{ left: pending.rect.left, top: Math.max(8, pending.rect.top - 40) }}
          onClick={openCard}
        >
          解释这段
        </button>
      )}

      <CardLayer
        card={card}
        onClose={() => void closeCard()}
        onDepthChange={(depth) => {
          if (!card) return
          void runCard(card.anchor, depth, card.question, cardIdRef.current ?? card.id, card.sourceText)
        }}
        onFollowUp={(text) => {
          if (!card) return
          void runCard(card.anchor, card.depth, text, cardIdRef.current ?? card.id, card.sourceText)
        }}
        onSave={() => void saveCard()}
        onRegenerate={() => {
          if (!card) return
          setCard({ ...card, saved: false })
          void runCard(card.anchor, card.depth, '请重新解释这段内容。', cardIdRef.current ?? card.id, card.sourceText)
        }}
      />

      {renaming && (
        <div className="modal-backdrop" onClick={() => setRenaming(null)}>
          <div className="modal narrow" onClick={(event) => event.stopPropagation()}>
            <header className="modal-head">
              <strong>重命名会话</strong>
              <button className="icon" onClick={() => setRenaming(null)}>
                ×
              </button>
            </header>
            <input
              className="rename-input"
              autoFocus
              value={renameValue}
              placeholder="比如：Rust 所有权"
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
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
                保存
              </button>
            </div>
          </div>
        </div>
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
