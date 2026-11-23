import { useCallback, useEffect, useMemo, useState } from 'react'
import { useI18n } from '../lib/i18n'
import { isImeComposing } from '../lib/ime'
import {
  addCourseItem,
  autoOrderCourse,
  autoScheduleCourse,
  deleteCourse,
  deleteCourseItem,
  downloadCourseCalendar,
  fetchCourse,
  reorderCourse,
  updateCourse,
  updateCourseItem,
} from '../lib/api'
import {
  type CourseDetail,
  type CourseDetailItem,
  type CourseItemStatus,
  type Topic,
} from '../lib/types'

interface Props {
  courseId: string
  topics: Topic[]
  onBack: () => void
  onOpenTopic: (id: string) => void
  onChanged: () => void
}

const STATUS_LABEL: Record<CourseItemStatus, string> = {
  planned: '未开始',
  learning: '在学',
  done: '已完成',
}

const STATUS_ORDER: CourseItemStatus[] = ['planned', 'learning', 'done']

/** 课程页：路径（可排序）+ 课表（按日期分组）。 */
export function CoursePage({ courseId, topics, onBack, onOpenTopic, onChanged }: Props) {
  const { t } = useI18n()
  const [detail, setDetail] = useState<CourseDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'path' | 'schedule'>('path')
  const [selectedTopic, setSelectedTopic] = useState('')
  const [plannedAt, setPlannedAt] = useState('')
  const [daily, setDaily] = useState(60)
  const [days, setDays] = useState('1,2,3,4,5')
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  const reload = useCallback(async () => {
    try {
      const data = await fetchCourse(courseId)
      setDetail(data)
      setDaily(data.course.daily_minutes)
      setDays(data.course.study_days)
    } catch (err) {
      setError(String(err))
    }
  }, [courseId])

  useEffect(() => {
    setDetail(null)
    void reload()
  }, [courseId]) // eslint-disable-line react-hooks/exhaustive-deps

  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
      await reload()
      onChanged()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const available = useMemo(() => {
    const used = new Set(detail?.items.map((entry) => entry.item.topic_id))
    return topics.filter((topic) => !used.has(topic.id))
  }, [detail, topics])

  if (!detail) {
    return (
      <section className="topic-page">
        <button className="link" onClick={onBack}>
          ← {t('返回会话')}
        </button>
        {error ? <p className="err-msg">{error}</p> : <p className="muted">{t('加载课程…')}</p>}
      </section>
    )
  }

  const { course, items, progress } = detail

  const add = () =>
    void mutate(async () => {
      if (!selectedTopic) return
      await addCourseItem(courseId, {
        topic_id: selectedTopic,
        planned_at: plannedAt || null,
      })
      setSelectedTopic('')
      setPlannedAt('')
    })

  const moveTo = (from: number, to: number) => {
    if (from === to || to < 0 || to >= items.length) return
    const ids = items.map((entry) => entry.item.id)
    const [moved] = ids.splice(from, 1)
    ids.splice(to, 0, moved)
    void mutate(async () => {
      const updated = await reorderCourse(courseId, ids)
      setDetail(updated)
    })
  }

  const move = (index: number, delta: number) => moveTo(index, index + delta)

  const saveSettings = () =>
    void mutate(() => updateCourse(courseId, { daily_minutes: daily, study_days: days }))

  const patch = (
    entry: CourseDetailItem,
    value: Partial<{
      planned_at: string
      status: CourseItemStatus
      estimated_minutes: number
    }>,
  ) =>
    void mutate(() => updateCourseItem(courseId, entry.item.id, value))

  const remove = (entry: CourseDetailItem) =>
    void mutate(() => deleteCourseItem(courseId, entry.item.id))

  const removeCourse = async () => {
    if (!window.confirm(t('删除课程《{title}》？专题和会话不会被删除。', { title: course.title }))) return
    setBusy(true)
    try {
      await deleteCourse(courseId)
      onChanged()
      onBack()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const sortedItems = [...items].sort((a, b) => a.item.position - b.item.position)
  const groups = new Map<string, CourseDetailItem[]>()
  for (const entry of sortedItems) {
    const key = entry.item.planned_at || '未排期'
    const list = groups.get(key) ?? []
    list.push(entry)
    groups.set(key, list)
  }
  const dates = [...groups.keys()].sort((a, b) => {
    if (a === '未排期') return 1
    if (b === '未排期') return -1
    return a.localeCompare(b)
  })

  return (
    <section className="topic-page">
      <div className="topic-top">
        <button className="link" onClick={onBack}>
          ← {t('返回会话')}
        </button>
        <span className="muted">
          {t('{done}/{total} 完成', { done: progress.done, total: progress.total })}
        </span>
      </div>

      <header className="topic-head">
        <div>
          <h1>{course.title}</h1>
          {course.goal && <p className="topic-summary">{course.goal}</p>}
          <div className="topic-badges">
            {course.start_date && <span className="badge">{t('开始 {date}', { date: course.start_date })}</span>}
            {course.end_date && <span className="badge">{t('结束 {date}', { date: course.end_date })}</span>}
          </div>
        </div>
        <div className="course-actions">
          <button
            onClick={() => void mutate(async () => setDetail(await autoOrderCourse(courseId)))}
            disabled={busy || items.length < 2}
            title={t('按先修排序')}
          >
            {t('按先修排序')}
          </button>
          <button
            onClick={() =>
              void mutate(async () => {
                await autoScheduleCourse(courseId)
                setTab('schedule')
              })
            }
            disabled={busy || items.length === 0}
            title={t('自动排期')}
          >
            {t('自动排期')}
          </button>
          <button className="danger" disabled={busy} onClick={() => void removeCourse()}>
            {t('删除课程')}
          </button>
        </div>
      </header>

      <div className="progress-line">
        <div style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
      </div>

      <div className="schedule-settings">
        <span className="muted">{t('排期设置')}</span>
        <label>
          {t('每天')}
          <input
            type="number"
            min={10}
            max={1440}
            step={10}
            value={daily}
            onChange={(event) => setDaily(Number(event.target.value))}
          />
          {t('分钟')}
        </label>
        <label>
          {t('学习日')}
          <input
            value={days}
            onChange={(event) => setDays(event.target.value)}
            placeholder="1,2,3,4,5"
            title="ISO 星期几，1=周一"
          />
        </label>
        <button onClick={saveSettings} disabled={busy}>
          {t('保存')}
        </button>
        <span className="spacer" />
        <button onClick={() => void downloadCourseCalendar(courseId, course.title)}>
          {t('导出到日历')}
        </button>
      </div>

      <div className="course-tabs">
        <button className={tab === 'path' ? 'active' : ''} onClick={() => setTab('path')}>
          {t('学习路径')}
        </button>
        <button className={tab === 'schedule' ? 'active' : ''} onClick={() => setTab('schedule')}>
          {t('课表')}
        </button>
      </div>

      {tab === 'path' && (
        <>
          <div className="course-add">
            <select
              value={selectedTopic}
              onChange={(event) => setSelectedTopic(event.target.value)}
            >
              <option value="">{t('选择专题加入课程…')}</option>
              {available.map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {topic.title}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={plannedAt}
              onChange={(event) => setPlannedAt(event.target.value)}
              title={t('计划日期，可留空')}
            />
            <button onClick={add} disabled={!selectedTopic || busy}>
              {t('加入')}
            </button>
          </div>

          {sortedItems.length === 0 && <p className="muted">{t('课程还是空的，先加入一个专题。')}</p>}
          <div className="course-list">
            {sortedItems.map((entry, index) => (
              <div
                key={entry.item.id}
                className={`course-row status-${entry.item.status} ${
                  dragIndex === index ? 'dragging' : ''
                }`}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  if (dragIndex !== null) moveTo(dragIndex, index)
                  setDragIndex(null)
                }}
              >
                <div className="course-order">
                  <span
                    className="drag-handle"
                    draggable
                    title={t('拖动排序')}
                    onDragStart={() => setDragIndex(index)}
                    onDragEnd={() => setDragIndex(null)}
                  >
                    ≡
                  </span>
                  <button className="icon" disabled={index === 0 || busy} onClick={() => move(index, -1)}>
                    ↑
                  </button>
                  <button
                    className="icon"
                    disabled={index === sortedItems.length - 1 || busy}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>
                  <span className="course-index">{index + 1}</span>
                </div>
                <div className="course-main">
                  <button className="course-title" onClick={() => onOpenTopic(entry.item.topic_id)}>
                    {entry.topic?.title || t('已删除专题')}
                  </button>
                  {entry.prerequisites.some((item) => item.warning) && (
                    <div className="course-warning">
                      {t('先修未满足：')}
                      {entry.prerequisites
                        .filter((item) => item.warning)
                        .map((item) => `${item.title}（${item.warning}）`)
                        .join('、')}
                    </div>
                  )}
                </div>
                <select
                  value={entry.item.status}
                  disabled={busy}
                  onChange={(event) =>
                    patch(entry, { status: event.target.value as CourseItemStatus })
                  }
                >
                  {STATUS_ORDER.map((status) => (
                    <option key={status} value={status}>
                      {STATUS_LABEL[status]}
                    </option>
                  ))}
                </select>
                <input
                  key={`${entry.item.id}-${entry.item.estimated_minutes}`}
                  type="number"
                  min={1}
                  max={1440}
                  defaultValue={entry.item.estimated_minutes}
                  disabled={busy}
                  title={t('预计分钟')}
                  className="minutes-input"
                  onBlur={(event) =>
                    patch(entry, { estimated_minutes: Number(event.target.value) })
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !isImeComposing(event)) event.currentTarget.blur()
                  }}
                />
                <input
                  type="date"
                  value={entry.item.planned_at || ''}
                  disabled={busy}
                  onChange={(event) => patch(entry, { planned_at: event.target.value })}
                />
                <button
                  className="link danger"
                  disabled={busy}
                  onClick={() => remove(entry)}
                  title={t('从课程移除，不删除专题')}
                >
                  {t('移除')}
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {tab === 'schedule' && (
        <div className="schedule">
          {dates.length === 0 && <p className="muted">{t('还没有排期。先在学习路径里加入专题并设置日期。')}</p>}
          {dates.map((date) => (
            <section key={date} className="schedule-group">
              <header>
                <strong>{date === '未排期' ? t('未排期') : date}</strong>
                <span className="muted">{groups.get(date)?.length ?? 0} {t('项')}</span>
              </header>
              {(groups.get(date) ?? []).map((entry) => (
                <div key={entry.item.id} className={`schedule-item status-${entry.item.status}`}>
                  <span>{entry.topic?.title || t('已删除专题')}</span>
                  <span className="muted">{t(STATUS_LABEL[entry.item.status])}</span>
                </div>
              ))}
            </section>
          ))}
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
