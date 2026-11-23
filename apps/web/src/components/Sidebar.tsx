import { useMemo, useState } from 'react'
import { useI18n } from '../lib/i18n'
import type { CourseSummary, SessionSummary, Topic } from '../lib/types'

interface Props {
  sessions: SessionSummary[]
  topics: Topic[]
  courses: CourseSummary[]
  activeId: string | null
  activeTopicId: string | null
  activeCourseId: string | null
  open: boolean
  onSelect: (id: string) => void
  onOpenTopic: (id: string) => void
  onOpenCourse: (id: string) => void
  onNew: () => void
  onNewCourse: () => void
  onRename: (id: string) => void
  onDelete: (id: string) => void
  onClose: () => void
}

function relative(
  iso: string,
  t: (zh: string, vars?: Record<string, string | number>) => string,
  lang: string,
): string {
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return ''
  const minutes = Math.floor((Date.now() - time) / 60000)
  if (minutes < 1) return t('刚刚')
  if (minutes < 60) return t('{n} 分钟前', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('{n} 小时前', { n: hours })
  const days = Math.floor(hours / 24)
  return days < 30
    ? t('{n} 天前', { n: days })
    : new Date(iso).toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-CN')
}

/** 会话工作区：专题 > 会话，加普通会话。课程层以后加在这里。 */
export function Sidebar({
  sessions,
  topics,
  courses,
  activeId,
  activeTopicId,
  activeCourseId,
  open,
  onSelect,
  onOpenTopic,
  onOpenCourse,
  onNew,
  onNewCourse,
  onRename,
  onDelete,
  onClose,
}: Props) {
  const { t, lang } = useI18n()
  const [query, setQuery] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return { topics, sessions, courses }
    return {
      topics: topics.filter((topic) => topic.title.toLowerCase().includes(term)),
      sessions: sessions.filter(
        (session) =>
          (session.title || '未命名').toLowerCase().includes(term) ||
          (session.topic_title ?? '').toLowerCase().includes(term),
      ),
      courses: courses.filter((item) => item.course.title.toLowerCase().includes(term)),
    }
  }, [sessions, topics, courses, query])

  const normal = filtered.sessions.filter((item) => !item.topic_id)

  const item = (session: SessionSummary, nested = false) => (
    <div
      key={session.id}
      className={`session-item ${nested ? 'nested' : ''} ${
        session.id === activeId ? 'active' : ''
      }`}
      onClick={() => onSelect(session.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onSelect(session.id)
      }}
    >
      <div className="session-line">
        <span className="session-name">{session.title || '未命名'}</span>
        <div className="session-actions">
          <button
            className="icon"
            title={t('重命名')}
            onClick={(event) => {
              event.stopPropagation()
              onRename(session.id)
            }}
          >
            ✎
          </button>
          <button
            className={`icon ${confirmId === session.id ? 'danger' : ''}`}
            title={confirmId === session.id ? t('再点一次确认删除') : t('删除')}
            onClick={(event) => {
              event.stopPropagation()
              if (confirmId !== session.id) {
                setConfirmId(session.id)
                window.setTimeout(() => setConfirmId(null), 3000)
                return
              }
              setConfirmId(null)
              onDelete(session.id)
            }}
          >
            {confirmId === session.id ? t('确认') : '🗑'}
          </button>
        </div>
      </div>
      <div className="session-meta">
        {session.origin && (
          <span className="session-badge" title={t('来自：{title}', { title: session.origin.parent_title || t('会话') })}>
            ↗ {t('支线')}
          </span>
        )}
        <span>{session.messages} {t('条')}</span>
        <span>{relative(session.updated_at, t, lang)}</span>
      </div>
    </div>
  )

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <header className="sidebar-head">
        <div>
          <div className="brand">study-deck</div>
          <div className="tagline">{t('选中即解释，理解可沉淀')}</div>
        </div>
        <button className="icon sidebar-close" title="收起侧边栏" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="sidebar-new-row">
        <button className="new-session" onClick={onNew}>
          ＋ {t('新会话')}
        </button>
        <button className="new-session" onClick={onNewCourse}>
          ＋ {t('新课程')}
        </button>
      </div>
      <input
        className="sidebar-search"
        value={query}
        placeholder={t('搜索专题或会话')}
        onChange={(event) => setQuery(event.target.value)}
      />

      <div className="session-list">
        {filtered.courses.length > 0 && (
          <>
            <div className="session-group">{t('课程')}</div>
            {filtered.courses.map(({ course, topic_count, done_count, next_date }) => (
              <button
                key={course.id}
                className={`course-node ${course.id === activeCourseId ? 'active' : ''}`}
                onClick={() => onOpenCourse(course.id)}
                title={course.goal || course.title}
              >
                <span className="course-node-name">{course.title}</span>
                <span className="course-node-meta">
                  {done_count}/{topic_count}
                  {next_date ? ` · ${next_date}` : ''}
                </span>
              </button>
            ))}
          </>
        )}

        {filtered.topics.length > 0 && (
          <>
            <div className="session-group">{t('专题')}</div>
            {filtered.topics.map((topic) => {
              const children = filtered.sessions.filter((item) => item.topic_id === topic.id)
              return (
                <div key={topic.id} className="topic-group">
                  <button
                    className={`topic-node ${topic.id === activeTopicId ? 'active' : ''}`}
                    onClick={() => onOpenTopic(topic.id)}
                    title={topic.summary || topic.title}
                  >
                    <span className="topic-node-name">{topic.title}</span>
                    <span className="topic-node-count">{children.length}</span>
                  </button>
                  {children.map((session) => item(session, true))}
                </div>
              )
            })}
          </>
        )}

        <div className="session-group">{t('最近')}</div>
        {normal.length === 0 && filtered.topics.length === 0 && (
          <div className="sidebar-empty">{t('还没有会话')}</div>
        )}
        {normal.map((session) => item(session))}
      </div>
      <footer className="sidebar-foot">
        <span className="status-dot" />
        {t('本地工作区 · 自动保存')}
      </footer>
    </aside>
  )
}
