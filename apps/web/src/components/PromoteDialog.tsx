import { useState } from 'react'
import { useI18n } from '../lib/i18n'
import { isImeComposing } from '../lib/ime'

import type { OpenCardState } from './Card'

interface Props {
  card: OpenCardState
  parentTitle: string
  busy: boolean
  onCancel: () => void
  onSubmit: (input: { title: string }) => void
}

/** 展开确认层：把当前这张卡带进一个独立新会话，不创建专题、不复制追问链。 */
export function PromoteDialog({
  card,
  parentTitle,
  busy,
  onCancel,
  onSubmit,
}: Props) {
  const { t } = useI18n()
  const [title, setTitle] = useState(
    (card.kind === 'ask' && card.question.trim() ? card.question : card.anchor.quote)
      .trim()
      .slice(0, 80),
  )

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal narrow" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <strong>{t('展开学习')}</strong>
          <button className="icon" onClick={onCancel} disabled={busy}>
            ×
          </button>
        </header>

        <p className="muted promote-note">
          {t('会新开一个独立会话，只带这张卡的问题、回答、引文和起点上下文；不包含追问链或其他分支，也不归入任何专题。原卡片和来源消息都会保留回链。', {
            parent: parentTitle || t('原会话'),
            quote: card.anchor.quote.slice(0, 40),
          })}
        </p>

        <label className="promote-field">
          <span>{t('新会话名')}</span>
          <input
              autoFocus
              value={title}
              maxLength={80}
              placeholder={t('比如：采样定理')}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !isImeComposing(event) && title.trim() && !busy) {
                  onSubmit({ title: title.trim() })
                }
              }}
            />
        </label>

        <div className="promote-tip">
          {t('新会话会出现在左侧普通会话里，之后可以继续追问。')}
        </div>

        <div className="form-actions">
          <button onClick={onCancel} disabled={busy}>
            {t('取消')}
          </button>
          <button
            className="primary"
            disabled={busy || !title.trim()}
            onClick={() => onSubmit({ title: title.trim() })}
          >
            {busy ? t('创建中…') : t('新开会话')}
          </button>
        </div>
      </div>
    </div>
  )
}
