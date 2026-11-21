import { useMemo, useState } from 'react'
import {
  deleteEntry,
  mergeEntries,
  updateEntry,
} from '../lib/api'
import {
  DEPTH_LABEL,
  MASTERY_LABEL,
  type GlossaryEntry,
  type Mastery,
  type MessageHit,
} from '../lib/types'

interface Props {
  entries: GlossaryEntry[]
  query: string
  onQuery: (value: string) => void
  onClose: () => void
  onJump: (sessionId: string | null, messageId: string | null) => void
  onChanged: () => void
  hits: MessageHit[]
  searchQuery: string
  onSearchQuery: (value: string) => void
}

const MASTERY_NEXT: Record<Mastery, Mastery> = {
  unknown: 'learning',
  learning: 'mastered',
  mastered: 'unknown',
}

const norm = (term: string) => term.trim().toLowerCase()

export function GlossaryPanel(props: Props) {
  const [tab, setTab] = useState<'ledger' | 'search'>('ledger')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)

  // 同名（忽略大小写）出现多条 → 可以合并
  const duplicates = useMemo(() => {
    const groups = new Map<string, GlossaryEntry[]>()
    for (const entry of props.entries) {
      const key = norm(entry.term)
      groups.set(key, [...(groups.get(key) ?? []), entry])
    }
    return groups
  }, [props.entries])

  const saveGist = async (entry: GlossaryEntry) => {
    const gist = draft.trim()
    setEditing(null)
    if (!gist || gist === entry.gist) return
    await updateEntry(entry.id, { gist })
    props.onChanged()
  }

  const cycleMastery = async (entry: GlossaryEntry) => {
    await updateEntry(entry.id, { mastery: MASTERY_NEXT[entry.mastery] })
    props.onChanged()
  }

  const remove = async (entry: GlossaryEntry) => {
    if (confirming !== entry.id) {
      setConfirming(entry.id)
      return
    }
    setConfirming(null)
    await deleteEntry(entry.id)
    props.onChanged()
  }

  const merge = async (entry: GlossaryEntry) => {
    const group = duplicates.get(norm(entry.term)) ?? []
    const sources = group.filter((item) => item.id !== entry.id).map((item) => item.id)
    if (sources.length === 0) return
    await mergeEntries(entry.id, sources)
    props.onChanged()
  }

  return (
    <aside className="drawer">
      <header>
        <div className="tabs">
          <button className={tab === 'ledger' ? 'active' : ''} onClick={() => setTab('ledger')}>
            账本 {props.entries.length > 0 ? props.entries.length : ''}
          </button>
          <button className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}>
            搜索
          </button>
        </div>
        <button className="icon" onClick={props.onClose} title="关闭">
          ×
        </button>
      </header>

      {tab === 'ledger' ? (
        <>
          <input
            className="search"
            placeholder="搜索术语或结论…"
            value={props.query}
            onChange={(event) => props.onQuery(event.target.value)}
          />
          <div className="entries">
            {props.entries.length === 0 && (
              <p className="muted">还没有条目。关掉一张卡片就会自动记账。</p>
            )}
            {props.entries.map((entry) => {
              const group = duplicates.get(norm(entry.term)) ?? []
              return (
                <div key={entry.id} className="entry">
                  <div className="entry-head">
                    <span className="term">{entry.term}</span>
                    <span className={`badge depth-${entry.depth}`}>{DEPTH_LABEL[entry.depth]}</span>
                    <button
                      className={`badge mastery-${entry.mastery}`}
                      title="点击切换掌握程度"
                      onClick={() => void cycleMastery(entry)}
                    >
                      {MASTERY_LABEL[entry.mastery]}
                    </button>
                  </div>

                  {editing === entry.id ? (
                    <div className="edit">
                      <textarea
                        value={draft}
                        rows={4}
                        onChange={(event) => setDraft(event.target.value)}
                      />
                      <div className="edit-actions">
                        <button onClick={() => void saveGist(entry)}>保存</button>
                        <button onClick={() => setEditing(null)}>取消</button>
                      </div>
                    </div>
                  ) : (
                    <p className="gist">{entry.gist}</p>
                  )}

                  <div className="entry-actions">
                    {entry.source_anchor && (
                      <button
                        className="link"
                        onClick={() =>
                          props.onJump(entry.session_id, entry.source_anchor?.message_id ?? null)
                        }
                      >
                        回到来源
                      </button>
                    )}
                    <button
                      className="link"
                      onClick={() => {
                        setEditing(entry.id)
                        setDraft(entry.gist)
                      }}
                    >
                      编辑
                    </button>
                    {group.length > 1 && (
                      <button className="link" onClick={() => void merge(entry)}>
                        合并 {group.length} 条
                      </button>
                    )}
                    <button
                      className={`link ${confirming === entry.id ? 'danger' : ''}`}
                      onClick={() => void remove(entry)}
                    >
                      {confirming === entry.id ? '确认删除？' : '删除'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      ) : (
        <>
          <input
            className="search"
            placeholder="搜索所有对话内容…"
            value={props.searchQuery}
            onChange={(event) => props.onSearchQuery(event.target.value)}
          />
          <div className="entries">
            {props.searchQuery.trim() !== '' && props.hits.length === 0 && (
              <p className="muted">没有匹配的消息。</p>
            )}
            {props.hits.map((hit) => (
              <div key={hit.message_id} className="entry">
                <div className="entry-head">
                  <span className="term">{hit.session_title || '未命名会话'}</span>
                  <span className="badge">{hit.role === 'user' ? '你' : '助教'}</span>
                </div>
                <p className="gist">{hit.snippet.replace(/\s+/g, ' ')}</p>
                <button className="link" onClick={() => props.onJump(hit.session_id, hit.message_id)}>
                  跳到这段
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  )
}
