import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  addTopicEdge,
  addTopicNode,
  createTopic,
  createTopicSession,
  deleteTopic,
  deleteTopicEdge,
  deleteTopicNode,
  fetchTopic,
  parseTopicOutline,
  setSessionTopic,
  updateTopic,
  updateTopicNode,
} from '../lib/api'
import { useI18n } from '../lib/i18n'
import { isImeComposing } from '../lib/ime'
import { renderMarkdown } from '../lib/markdown'
import {
  DEPTH_LABEL,
  MASTERY_LABEL,
  type Mastery,
  type SessionSummary,
  type Topic,
  type TopicDetail,
  type TopicEdgeKind,
  type TopicNodeStatus,
} from '../lib/types'

interface Props {
  topicId: string
  sessions: SessionSummary[]
  topics: Topic[]
  onBack: () => void
  onOpenSession: (id: string) => void
  onJump: (sessionId: string, messageId: string) => void
  onChanged: () => void
  onDeleted: (deleteSessions: boolean) => void
}

const MASTERY: Mastery[] = ['unknown', 'learning', 'mastered']

/** 专题工作区：概览、会话归属、学习地图、先修/相关关系。 */
export function TopicPage({
  topicId,
  sessions,
  topics,
  onBack,
  onOpenSession,
  onJump,
  onChanged,
  onDeleted,
}: Props) {
  const { t } = useI18n()
  const [detail, setDetail] = useState<TopicDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [outline, setOutline] = useState('')
  const [outlineDirty, setOutlineDirty] = useState(false)
  const [relationTitle, setRelationTitle] = useState('')
  const [relationKind, setRelationKind] = useState<TopicEdgeKind>('prerequisite')
  const [attachId, setAttachId] = useState('')
  const [nodeTitle, setNodeTitle] = useState('')
  const [showDelete, setShowDelete] = useState(false)
  const [deleteSessions, setDeleteSessions] = useState(false)

  const reload = useCallback(async () => {
    try {
      const data = await fetchTopic(topicId)
      setDetail(data)
      if (!outlineDirty) setOutline(data.topic.outline_md)
    } catch (err) {
      setError(String(err))
    }
  }, [topicId, outlineDirty])

  useEffect(() => {
    setDetail(null)
    setOutline('')
    setOutlineDirty(false)
    void reload()
  }, [topicId]) // eslint-disable-line react-hooks/exhaustive-deps

  const updateLocalTopic = (topic: Topic) => {
    setDetail((current) => (current ? { ...current, topic } : current))
  }

  const changeMastery = async (mastery: Mastery) => {
    if (!detail) return
    setBusy('mastery')
    try {
      const topic = await updateTopic(topicId, { mastery })
      updateLocalTopic(topic)
      onChanged()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const saveOutline = async () => {
    setBusy('outline')
    try {
      const topic = await updateTopic(topicId, { outline_md: outline })
      updateLocalTopic(topic)
      setOutlineDirty(false)
      onChanged()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const newSession = async () => {
    setBusy('new')
    try {
      const id = await createTopicSession(topicId)
      onChanged()
      onOpenSession(id)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const attach = async () => {
    if (!attachId) return
    setBusy('attach')
    try {
      await setSessionTopic(attachId, topicId)
      setAttachId('')
      await reload()
      onChanged()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const detach = async (sessionId: string) => {
    setBusy(`detach-${sessionId}`)
    try {
      await setSessionTopic(sessionId, null)
      await reload()
      onChanged()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const addRelation = async (rawTitle: string, kind: TopicEdgeKind) => {
    const title = rawTitle.trim()
    if (!title || !detail) return
    setBusy('relation')
    try {
      let target = topics.find(
        (item) => item.id !== topicId && item.title.toLowerCase() === title.toLowerCase(),
      )
      if (!target) {
        target = await createTopic({ title, depth_goal: detail.topic.depth_goal })
      }
      if (kind === 'prerequisite') {
        await addTopicEdge({
          from_topic_id: target.id,
          to_topic_id: topicId,
          kind,
        })
      } else {
        await addTopicEdge({
          from_topic_id: topicId,
          to_topic_id: target.id,
          kind,
        })
      }
      setRelationTitle('')
      await reload()
      onChanged()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const removeRelation = async (edgeId: string) => {
    setBusy(`edge-${edgeId}`)
    try {
      await deleteTopicEdge(topicId, edgeId)
      await reload()
      onChanged()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const parseNodes = async () => {
    setBusy('parse')
    try {
      const nodes = await parseTopicOutline(topicId, outline || detail?.topic.outline_md)
      setDetail((current) => (current ? { ...current, nodes } : current))
      onChanged()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const addNode = async () => {
    const title = nodeTitle.trim()
    if (!title) return
    setBusy('node')
    try {
      const node = await addTopicNode(topicId, title)
      setDetail((current) =>
        current ? { ...current, nodes: [...current.nodes, node] } : current,
      )
      setNodeTitle('')
      onChanged()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const setNodeStatus = async (nodeId: string, status: TopicNodeStatus) => {
    setBusy(`node-${nodeId}`)
    try {
      const node = await updateTopicNode(topicId, nodeId, { status })
      setDetail((current) =>
        current
          ? {
              ...current,
              nodes: current.nodes.map((item) => (item.id === nodeId ? node : item)),
            }
          : current,
      )
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const removeNode = async (nodeId: string) => {
    setBusy(`node-${nodeId}`)
    try {
      await deleteTopicNode(topicId, nodeId)
      setDetail((current) =>
        current
          ? { ...current, nodes: current.nodes.filter((item) => item.id !== nodeId) }
          : current,
      )
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const unattached = useMemo(
    () => sessions.filter((item) => !detail?.sessions.some((own) => own.id === item.id)),
    [sessions, detail],
  )

  if (!detail) {
    return (
      <section className="topic-page">
        <button className="link" onClick={onBack}>
          ← {t('返回会话')}
        </button>
        {error ? <p className="err-msg">{error}</p> : <p className="muted">{t('加载专题…')}</p>}
      </section>
    )
  }

  const { topic, relations } = detail
  const prerequisites = relations.filter(
    (item) => item.kind === 'prerequisite' && item.direction === 'incoming',
  )
  const dependents = relations.filter(
    (item) => item.kind === 'prerequisite' && item.direction === 'outgoing',
  )
  const related = relations.filter((item) => item.kind === 'related')
  const others = relations.filter(
    (item) => item.kind !== 'prerequisite' && item.kind !== 'related',
  )

  return (
    <section className="topic-page">
      <div className="topic-top">
        <button className="link" onClick={onBack}>
          ← {t('返回会话')}
        </button>
        <span className="muted">{t('{n} 个会话', { n: detail.sessions.length })}</span>
      </div>

      <header className="topic-head">
        <div>
          <h1>{topic.title}</h1>
          <div className="topic-badges">
            <span className="badge">{t('目标 {depth}', { depth: t(DEPTH_LABEL[topic.depth_goal]) })}</span>
            <span className={`badge mastery-${topic.mastery}`}>{t(MASTERY_LABEL[topic.mastery])}</span>
          </div>
          {topic.summary && <p className="topic-summary">{topic.summary}</p>}
        </div>
        <div className="topic-head-actions">
          <div className="topic-mastery">
            {MASTERY.map((item) => (
              <button
                key={item}
                className={topic.mastery === item ? 'active' : ''}
                disabled={busy !== null}
                onClick={() => void changeMastery(item)}
              >
                {t(MASTERY_LABEL[item])}
              </button>
            ))}
          </div>
          <button className="danger" onClick={() => setShowDelete(true)} disabled={busy !== null}>
            {t('删除专题')}
          </button>
        </div>
      </header>

      {detail.source ? (
        <div className="topic-source">
          <span>
            {t('来源：{title} 中的「{quote}」', {
              title: detail.source.source_title || t('原会话'),
              quote: detail.source.quote.replace(/\s+/g, ' ').slice(0, 48),
            })}
          </span>
          <button
            className="link"
            onClick={() =>
              onJump(detail.source!.source_session_id, detail.source!.source_message_id)
            }
          >
            {t('回到来源')}
          </button>
        </div>
      ) : (
        <div className="topic-source muted">{t('手动创建的专题，没有阅读来源。')}</div>
      )}

      <div className="topic-grid">
        <section className="topic-panel">
          <header className="topic-panel-head">
            <strong>{t('会话')}</strong>
            <button onClick={() => void newSession()} disabled={busy !== null}>
              ＋ {t('新建')}
            </button>
          </header>
          <div className="topic-sessions">
            {detail.sessions.length === 0 && <p className="muted">{t('还没有会话。')}</p>}
            {detail.sessions.map((session) => (
              <div key={session.id} className="topic-session">
                <button className="topic-session-main" onClick={() => onOpenSession(session.id)}>
                  <span>{session.title || t('未命名')}</span>
                  <span className="muted">{session.messages} {t('条')}</span>
                </button>
                <button
                  className="link"
                  disabled={busy !== null}
                  onClick={() => void detach(session.id)}
                >
                  {t('移出')}
                </button>
              </div>
            ))}
          </div>
          <div className="topic-attach">
            <select value={attachId} onChange={(event) => setAttachId(event.target.value)}>
              <option value="">{t('关联已有会话…')}</option>
              {unattached.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title || '未命名'}
                  {session.topic_id ? t('（其它专题）') : ''}
                </option>
              ))}
            </select>
            <button onClick={() => void attach()} disabled={!attachId || busy !== null}>
              {t('关联')}
            </button>
          </div>
        </section>

        <section className="topic-panel">
          <header className="topic-panel-head">
            <strong>{t('学习地图')}</strong>
            <button onClick={() => void saveOutline()} disabled={busy !== null || !outlineDirty}>
              {busy === 'outline' ? t('保存中…') : t('保存')}
            </button>
          </header>
          <textarea
            className="topic-outline-edit"
            value={outline}
            placeholder={t('先生成一个学习地图，或在这里手写：3–5 条路线、先修关系、目标深度。')}
            onChange={(event) => {
              setOutline(event.target.value)
              setOutlineDirty(true)
            }}
          />
          {outline.trim() && (
            <div
              className="topic-outline-preview"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(outline) }}
            />
          )}

          <div className="topic-nodes">
            <header className="topic-panel-head">
              <strong>{t('学习节点')}</strong>
              <button onClick={() => void parseNodes()} disabled={busy !== null}>
                {t('从地图拆成节点')}
              </button>
            </header>
            {detail.nodes.length === 0 && (
              <p className="muted">{t('还没有节点。生成地图后点「从地图拆成节点」。')}</p>
            )}
            {detail.nodes.map((node) => (
              <div key={node.id} className={`topic-node-item status-${node.status}`}>
                <button
                  className="node-status"
                  disabled={busy !== null}
                  onClick={() =>
                    void setNodeStatus(
                      node.id,
                      node.status === 'planned'
                        ? 'learning'
                        : node.status === 'learning'
                          ? 'done'
                          : 'planned',
                    )
                  }
                  title={t('点击切换状态')}
                >
                  {node.status === 'done' ? '✓' : node.status === 'learning' ? '◐' : '○'}
                </button>
                <span>{node.title}</span>
                <button
                  className="link"
                  disabled={busy !== null}
                  onClick={() => void removeNode(node.id)}
                >
                  {t('删除')}
                </button>
              </div>
            ))}
            <div className="node-add">
              <input
                value={nodeTitle}
                placeholder={t('添加一个学习节点')}
                onChange={(event) => setNodeTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !isImeComposing(event)) void addNode()
                }}
              />
              <button onClick={() => void addNode()} disabled={!nodeTitle.trim() || busy !== null}>
                {t('添加')}
              </button>
            </div>
          </div>
        </section>

        <section className="topic-panel">
          <header className="topic-panel-head">
            <strong>{t('关系')}</strong>
          </header>

          {detail.suggestions.length > 0 && (
            <div className="relation-suggestions">
              <span className="muted">{t('来自卡片的前置依赖：')}</span>
              {detail.suggestions.map((item) => (
                <button
                  key={item.title}
                  className="chip"
                  disabled={busy !== null}
                  onClick={() => void addRelation(item.title, 'prerequisite')}
                >
                  ＋ {item.title}
                </button>
              ))}
            </div>
          )}

          <div className="relation-add">
            <input
              value={relationTitle}
              placeholder={t('专题名，不存在会自动创建')}
              onChange={(event) => setRelationTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !isImeComposing(event)) void addRelation(relationTitle, relationKind)
              }}
            />
            <select
              value={relationKind}
              onChange={(event) => setRelationKind(event.target.value as TopicEdgeKind)}
            >
              <option value="prerequisite">{t('先修')}</option>
              <option value="related">{t('相关')}</option>
            </select>
            <button
              onClick={() => void addRelation(relationTitle, relationKind)}
              disabled={!relationTitle.trim() || busy !== null}
            >
              {t('添加')}
            </button>
          </div>

          <RelationList
            title={t('先修')}
            items={prerequisites}
            busy={busy}
            onRemove={(id) => void removeRelation(id)}
          />
          <RelationList
            title={t('后续')}
            items={dependents}
            busy={busy}
            onRemove={(id) => void removeRelation(id)}
          />
          <RelationList
            title={t('相关')}
            items={related}
            busy={busy}
            onRemove={(id) => void removeRelation(id)}
          />
          <RelationList
            title={t('其它')}
            items={others}
            busy={busy}
            onRemove={(id) => void removeRelation(id)}
          />
        </section>
      </div>

      {showDelete && (
        <div className="modal-backdrop" onClick={() => setShowDelete(false)}>
          <div className="modal narrow" onClick={(event) => event.stopPropagation()}>
            <header className="modal-head">
              <strong>{t('删除专题《{title}》', { title: topic.title })}</strong>
              <button className="icon" onClick={() => setShowDelete(false)}>
                ×
              </button>
            </header>
            <p className="muted promote-note">
              {t('将删除 {nodes} 个学习节点、{relations} 条关系。账本条目会保留。', {
                nodes: detail.nodes.length,
                relations: detail.relations.length,
              })}
            </p>
            <label className="delete-option">
              <input
                type="radio"
                checked={!deleteSessions}
                onChange={() => setDeleteSessions(false)}
              />
              <span>
                {t('保留 {n} 个会话，转为普通会话', { n: detail.sessions.length })}
                <small>{t('推荐；对话、卡片和账本都不删除。')}</small>
              </span>
            </label>
            <label className="delete-option">
              <input
                type="radio"
                checked={deleteSessions}
                onChange={() => setDeleteSessions(true)}
              />
              <span>
                {t('同时删除 {n} 个会话', { n: detail.sessions.length })}
                <small>{t('会删除这些会话的消息和卡片；账本保留。')}</small>
              </span>
            </label>
            <div className="form-actions">
              <button onClick={() => setShowDelete(false)}>{t('取消')}</button>
              <button
                className="danger"
                disabled={busy !== null}
                onClick={() => {
                  setBusy('delete-topic')
                  void deleteTopic(topicId, deleteSessions)
                    .then(() => onDeleted(deleteSessions))
                    .catch((err) => setError(String(err)))
                    .finally(() => setBusy(null))
                }}
              >
                {t('确认删除')}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="toast" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </section>
  )
}

function RelationList({
  title,
  items,
  busy,
  onRemove,
}: {
  title: string
  items: TopicDetail['relations']
  busy: string | null
  onRemove: (id: string) => void
}) {
  const { t } = useI18n()
  if (items.length === 0) return null
  return (
    <div className="relation-group">
      <div className="relation-label">{title}</div>
      {items.map((item) => (
        <div key={item.id} className="relation-item">
          <span>{item.other?.title || t('已删除专题')}</span>
          <button className="link" disabled={busy !== null} onClick={() => onRemove(item.id)}>
            {t('移除')}
          </button>
        </div>
      ))}
    </div>
  )
}
