import { useMemo, useState } from 'react'
import { useI18n } from '../lib/i18n'
import {
  deleteEntry,
  fetchDueReviews,
  fetchEntryDetail,
  mergeEntries,
  submitReview,
  updateEntry,
} from '../lib/api'
import {
  DEPTH_LABEL,
  MASTERY_LABEL,
  type EntryDetail,
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
  /** 账本恢复：打开这张卡所属的完整线程并继续追问 */
  onResumeCard: (cardId: string) => void
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
  const [tab, setTab] = useState<'ledger' | 'review' | 'search'>('ledger')
  const [due, setDue] = useState<GlossaryEntry[]>([])
  const [reviewBusy, setReviewBusy] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [openTimeline, setOpenTimeline] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, EntryDetail>>({})

  const toggleTimeline = async (entry: GlossaryEntry) => {
    if (openTimeline === entry.id) {
      setOpenTimeline(null)
      return
    }
    setOpenTimeline(entry.id)
    if (!details[entry.id]) {
      try {
        const detail = await fetchEntryDetail(entry.id)
        setDetails((prev) => ({ ...prev, [entry.id]: detail }))
      } catch {
        // 拉不到详情不影响列表
      }
    }
  }

  const loadDue = async () => {
    try {
      setDue(await fetchDueReviews())
    } catch {
      setDue([])
    }
  }

  const answerReview = async (entry: GlossaryEntry, remembered: boolean) => {
    if (reviewBusy) return
    setReviewBusy(true)
    try {
      await submitReview(entry.id, remembered)
      setDue((prev) => prev.filter((item) => item.id !== entry.id))
      props.onChanged()
    } finally {
      setReviewBusy(false)
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
          <button
            className={tab === 'review' ? 'active' : ''}
            onClick={() => {
              setTab('review')
              void loadDue()
            }}
          >
            {t('复习')}
          </button>
          <button className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}>
            {t('搜索')}
          </button>
        </div>
        <button className="icon" onClick={props.onClose} title={t('关闭')}>
          ×
        </button>
      </header>

      {tab === 'review' ? (
        <>
          <div className="review-head">
            <span className="muted small">{t('按间隔重复排期；记得就拉长，忘了回到 1 天')}</span>
            <button onClick={() => void loadDue()}>{t('刷新')}</button>
          </div>
          <div className="entries">
            {due.length === 0 && <p className="muted">{t('今天没有到期的条目。')}</p>}
            {due.map((entry) => (
              <div key={entry.id} className="entry">
                <div className="entry-head">
                  <span className="term">{entry.term}</span>
                  <span className={`badge depth-${entry.depth}`}>{DEPTH_LABEL[entry.depth]}</span>
                  <span className="badge">{t('第 {n} 次', { n: (entry.review_count ?? 0) + 1 })}</span>
                </div>
                <p className="gist">{entry.gist}</p>
                <div className="entry-actions">
                  <button className="primary" disabled={reviewBusy} onClick={() => void answerReview(entry, true)}>
                    {t('记得')}
                  </button>
                  <button disabled={reviewBusy} onClick={() => void answerReview(entry, false)}>
                    {t('忘了')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : tab === 'ledger' ? (
        <>
          <input
            className="search"
            placeholder={t('搜索术语或结论…')}
            value={props.query}
            onChange={(event) => props.onQuery(event.target.value)}
          />
          <div className="entries">
            {props.entries.length === 0 && (
              <p className="muted">{t('还没有条目。在卡片底部点「保存到账本」才会记账。')}</p>
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

                  <p className="gist">{entry.gist}</p>

                  {openTimeline === entry.id && (
                    <div className="entry-detail">
                      {(details[entry.id]?.path.length ?? 0) > 0 && (
                        <div className="entry-path">
                          <span className="detail-label">{t('路径')}</span>
                          {details[entry.id]?.path.map((node, index) => (
                            <span key={node.id} className="path-node">
                              {index > 0 && <span className="crumb-sep">›</span>}
                              <span title={node.question}>{node.quote.slice(0, 14)}</span>
                            </span>
                          ))}
                        </div>
                      )}

                      {(details[entry.id]?.parents.length ?? 0) > 0 && (
                        <div className="entry-rel">
                          <span className="detail-label">{t('来自')}</span>
                          {details[entry.id]?.parents.map((rel) => (
                            <button
                              key={rel.id}
                              className="rel-chip"
                              onClick={() => {
                                setOpenTimeline(rel.id)
                                void fetchEntryDetail(rel.id).then((detail) =>
                                  setDetails((prev) => ({ ...prev, [rel.id]: detail })),
                                )
                              }}
                            >
                              {rel.term}
                            </button>
                          ))}
                        </div>
                      )}

                      {(details[entry.id]?.children.length ?? 0) > 0 && (
                        <div className="entry-rel">
                          <span className="detail-label">{t('衍生')}</span>
                          {details[entry.id]?.children.map((rel) => (
                            <button
                              key={rel.id}
                              className="rel-chip"
                              onClick={() => {
                                setOpenTimeline(rel.id)
                                void fetchEntryDetail(rel.id).then((detail) =>
                                  setDetails((prev) => ({ ...prev, [rel.id]: detail })),
                                )
                              }}
                            >
                              {rel.term}
                            </button>
                          ))}
                        </div>
                      )}

                      <div className="encounter-timeline">
                        {(details[entry.id]?.encounters ?? []).map((hit) => (
                          <div key={hit.id} className="encounter">
                            <span className="encounter-time">
                              {hit.created_at.slice(5, 16).replace('T', ' ')}
                            </span>
                            <span className="encounter-level">{hit.level ?? ''}</span>
                            <span className="encounter-gist">{hit.gist.slice(0, 80)}</span>
                            {hit.card_id && (
                              <button
                                className="link small"
                                onClick={() => props.onResumeCard(hit.card_id as string)}
                              >
                                {t('继续学习')}
                              </button>
                            )}
                          </div>
                        ))}
                        {(details[entry.id]?.encounters.length ?? 0) === 0 && (
                          <p className="muted small">{t('没有更早的记录。')}</p>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="entry-actions">
                    {entry.last_card_id && (
                      <button
                        className="link"
                        onClick={() => props.onResumeCard(entry.last_card_id as string)}
                      >
                        {t('继续学习')}
                      </button>
                    )}
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
