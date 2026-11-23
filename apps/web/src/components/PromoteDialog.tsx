import { useState } from 'react'
import { useI18n } from '../lib/i18n'
import { isImeComposing } from '../lib/ime'
import { DEPTH_HINT, DEPTH_LABEL, type Depth, type Topic } from '../lib/types'
import type { OpenCardState } from './Card'

interface Props {
  card: OpenCardState
  initialDepth: Depth
  parentTitle: string
  topics: Topic[]
  busy: boolean
  onCancel: () => void
  onSubmit: (input: { title: string; depth: Depth; topicId: string | null }) => void
}

const DEPTHS: Depth[] = ['can_use', 'can_tune', 'can_derive']

/** 升级确认层：只问“专题叫什么、要学多深”，不复制父会话。 */
export function PromoteDialog({
  card,
  initialDepth,
  parentTitle,
  topics,
  busy,
  onCancel,
  onSubmit,
}: Props) {
  const { t } = useI18n()
  const [title, setTitle] = useState(card.anchor.quote.trim().slice(0, 80))
  const [depth, setDepth] = useState<Depth>(initialDepth)
  const [topicId, setTopicId] = useState('')

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal narrow" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <strong>{t('升级为专题')}</strong>
          <button className="icon" onClick={onCancel} disabled={busy}>
            ×
          </button>
        </header>

        <p className="muted promote-note">
          {t('会新建一个主线会话，并从《{parent}》的「{quote}」带上起点上下文。原卡片和来源消息都会保留回链。', {
            parent: parentTitle || t('原会话'),
            quote: card.anchor.quote.slice(0, 40),
          })}
        </p>

        <label className="promote-field">
          <span>{t('归入专题')}</span>
          <select
            value={topicId}
            onChange={(event) => setTopicId(event.target.value)}
            disabled={busy}
          >
            <option value="">{t('新建专题')}</option>
            {topics.map((topic) => (
              <option key={topic.id} value={topic.id}>
                {topic.title}
              </option>
            ))}
          </select>
        </label>

        {!topicId && (
          <label className="promote-field">
            <span>{t('新专题名')}</span>
            <input
              autoFocus
              value={title}
              maxLength={80}
              placeholder={t('比如：采样定理')}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !isImeComposing(event) && title.trim() && !busy) {
                  onSubmit({ title: title.trim(), depth, topicId: null })
                }
              }}
            />
          </label>
        )}

        <div className="promote-field">
          <span>{t('目标深度')}</span>
          <div className="promote-depths">
            {DEPTHS.map((item) => (
              <button
                key={item}
                className={depth === item ? 'active' : ''}
                title={t(DEPTH_HINT[item])}
                onClick={() => setDepth(item)}
                disabled={busy}
              >
                {t(DEPTH_LABEL[item])}
              </button>
            ))}
          </div>
        </div>

        <div className="promote-tip">
          {topicId
            ? t('会在这个专题下新建一个会话，并保留这张卡片的来源。')
            : t('会新建专题和会话。创建后可在顶部点「生成学习地图」。')}
        </div>

        <div className="form-actions">
          <button onClick={onCancel} disabled={busy}>
            {t('取消')}
          </button>
          <button
            className="primary"
            disabled={busy || (!topicId && !title.trim())}
            onClick={() => onSubmit({ title: title.trim(), depth, topicId: topicId || null })}
          >
            {busy ? t('创建中…') : topicId ? t('新建会话') : t('创建专题')}
          </button>
        </div>
      </div>
    </div>
  )
}
