import { useMemo, useState } from 'react'
import { useI18n } from '../lib/i18n'
import {
  deleteEntry,
  fetchEntryDetail,
  mergeEntries,
  updateEntry,
} from '../lib/api'
import {
  DEPTH_LABEL,
  MASTERY_LABEL,
  type Encounter,
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
  const { t } = useI18n()
  const [tab, setTab] = useState<'ledger' | 'search'>('ledger')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [openTimeline, setOpenTimeline] = useState<string | null>(null)
  const [timelines, setTimelines] = useState<Record<string, Encounter[]>>({})

  const toggleTimeline = async (entry: GlossaryEntry) => {
    if (openTimeline === entry.id) {
      setOpenTimeline(null)
      return
    }
    setOpenTimeline(entry.id)
    if (!timelines[entry.id]) {
      try {
        const detail = await fetchEntryDetail(entry.id)
        setTimelines((prev) => ({ ...prev, [entry.id]: detail.encounters }))
      } catch {
        // 拉不到时间线不影响列表
      }
    }
  }

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
            {t('账本')} {props.entries.length > 0 ? props.entries.length : ''}
          </button>
          <button className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}>
            {t('搜索')}
          </button>
        </div>
        <button className="icon" onClick={props.onClose} title={t('关闭')}>
          ×
        </button>
      </header>

      {tab === 'ledger' ? (
        <>
          <input
            className="search"
            placeholder={t('搜索术语或结论…')}
            value={props.query}
            onChange={(event) => props.onQuery(event.target.value)}
          />
          <div className="entries">
            {props.entries.length === 0 && (
              <p className="muted">{t('还没有条目。关掉一张卡片就会自动记账。')}</p>
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
                      title={t('点击切换掌握程度')}
                      onClick={() => void cycleMastery(entry)}
                    >
                      {MASTERY_LABEL[entry.mastery]}
                    </button>
                    {(entry.encounter_count ?? 0) > 1 && (
                      <button
                        className="badge encounters"
                        title={t('遇到过 {n} 次', { n: entry.encounter_count ?? 0 })}
                        onClick={() => void toggleTimeline(entry)}
                      >
                        ×{entry.encounter_count}
                      </button>
                    )}
                  </div>

                  {editing === entry.id ? (
                    <div className="edit">
                      <textarea
                        value={draft}
                        rows={4}
                        onChange={(event) => setDraft(event.target.value)}
                      />
                      <div className="edit-actions">
                        <button onClick={() => void saveGist(entry)}>{t('保存')}</button>
                        <button onClick={() => setEditing(null)}>{t('取消')}</button>
                      </div>
                    </div>
                  ) : (
                    <p className="gist">{entry.gist}</p>
                  )}

                  {openTimeline === entry.id && (
                    <div className="encounter-timeline">
                      {(timelines[entry.id] ?? []).map((hit) => (
                        <div key={hit.id} className="encounter">
                          <span className="encounter-time">
                            {hit.created_at.slice(5, 16).replace('T', ' ')}
                          </span>
                          <span className="encounter-level">{hit.level ?? ''}</span>
                          <span className="encounter-gist">{hit.gist.slice(0, 80)}</span>
                        </div>
                      ))}
                      {(timelines[entry.id] ?? []).length === 0 && (
                        <p className="muted small">没有更早的记录。</p>
                      )}
                    </div>
                  )}

                  <div className="entry-actions">
                    {entry.source_anchor && (
                      <button
                        className="link"
                        onClick={() =>
                          props.onJump(entry.session_id, entry.source_anchor?.message_id ?? null)
                        }
                      >
                        {t('回到来源')}
                      </button>
                    )}
                    <button
                      className="link"
                      onClick={() => {
                        setEditing(entry.id)
                        setDraft(entry.gist)
                      }}
                    >
                      {t('编辑')}
                    </button>
                    {group.length > 1 && (
                      <button className="link" onClick={() => void merge(entry)}>
                        {t('合并 {n} 条', { n: group.length })}
                      </button>
                    )}
                    <button
                      className={`link ${confirming === entry.id ? 'danger' : ''}`}
                      onClick={() => void remove(entry)}
                    >
                      {confirming === entry.id ? t('确认删除？') : t('删除')}
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
            placeholder={t('搜索所有对话内容…')}
            value={props.searchQuery}
            onChange={(event) => props.onSearchQuery(event.target.value)}
          />
          <div className="entries">
            {props.searchQuery.trim() !== '' && props.hits.length === 0 && (
              <p className="muted">{t('没有匹配的消息。')}</p>
            )}
            {props.hits.map((hit) => (
              <div key={hit.message_id} className="entry">
                <div className="entry-head">
                  <span className="term">{hit.session_title || t('未命名会话')}</span>
                  <span className="badge">{hit.role === 'user' ? t('你') : t('助教')}</span>
                </div>
                <p className="gist">{hit.snippet.replace(/\s+/g, ' ')}</p>
                <button className="link" onClick={() => props.onJump(hit.session_id, hit.message_id)}>
                  {t('跳到这段')}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  )
}
