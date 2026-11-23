import { useState } from 'react'
import { useI18n } from '../lib/i18n'
interface Props {
  busy: boolean
  onCancel: () => void
  onSubmit: (input: {
    title: string
    goal: string
    start_date: string
    end_date: string
    daily_minutes: number
    study_days: string
  }) => void
}

export function CourseDialog({ busy, onCancel, onSubmit }: Props) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [daily, setDaily] = useState(60)
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5])
  const toggleDay = (day: number) =>
    setDays((current) =>
      current.includes(day) ? current.filter((item) => item !== day) : [...current, day].sort(),
    )

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal narrow" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <strong>{t('新建课程')}</strong>
          <button className="icon" onClick={onCancel} disabled={busy}>
            ×
          </button>
        </header>
        <p className="muted promote-note">{t('课程只组织专题，不复制会话或账本。')}</p>
        <label className="promote-field">
          <span>{t('课程名')}</span>
          <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t('比如：数字信号处理')} />
        </label>
        <label className="promote-field">
          <span>{t('目标')}</span>
          <input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={t('学完能做什么')} />
        </label>
        <div className="course-dates">
          <label className="promote-field">
            <span>{t('开始')}</span>
            <input type="date" value={start} onChange={(event) => setStart(event.target.value)} />
          </label>
          <label className="promote-field">
            <span>{t('结束')}</span>
            <input type="date" value={end} onChange={(event) => setEnd(event.target.value)} />
          </label>
        </div>
        <label className="promote-field">
          <span>{t('每天可用分钟')}</span>
          <input
            type="number"
            min={10}
            max={1440}
            step={10}
            value={daily}
            onChange={(event) => setDaily(Number(event.target.value))}
          />
        </label>
        <div className="promote-field">
          <span>{t('学习日')}</span>
          <div className="weekday-picker">
            {[
              [1, '一'],
              [2, '二'],
              [3, '三'],
              [4, '四'],
              [5, '五'],
              [6, '六'],
              [7, '日'],
            ].map(([day, label]) => (
              <button
                key={String(day)}
                className={days.includes(Number(day)) ? 'active' : ''}
                onClick={() => toggleDay(Number(day))}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="form-actions">
          <button onClick={onCancel} disabled={busy}>
            {t('取消')}
          </button>
          <button
            className="primary"
            disabled={busy || !title.trim()}
            onClick={() =>
              onSubmit({
                title: title.trim(),
                goal,
                start_date: start,
                end_date: end,
                daily_minutes: daily,
                study_days: days.join(','),
              })
            }
          >
            {busy ? t('创建中…') : t('创建课程')}
          </button>
        </div>
      </div>
    </div>
  )
}
