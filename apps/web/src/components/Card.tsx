import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { useI18n } from '../lib/i18n'
import { isImeComposing } from '../lib/ime'
import { DEPTH_HINT, DEPTH_LABEL, type Anchor, type Depth } from '../lib/types'

export interface OpenCardState {
  id: string | null
  anchor: Anchor
  depth: Depth
  question: string
  answer: string
  streaming: boolean
  saved: boolean
  promotedSessionId: string | null
  rect: { left: number; top: number; width: number; height: number }
  sourceText: string
}

interface Props {
  card: OpenCardState
  onClose: () => void
  onDepthChange: (depth: Depth) => void
  onFollowUp: (text: string) => void
  onSave: () => void
  onRegenerate: () => void
  onPromote: () => void
  onOpenPromoted: () => void
}

const DEPTHS: Depth[] = ['can_use', 'can_tune', 'can_derive']

const MARGIN = 8

export function Card({
  card,
  onClose,
  onDepthChange,
  onFollowUp,
  onSave,
  onRegenerate,
  onPromote,
  onOpenPromoted,
}: Props) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)

  const submit = () => {
    const text = draft.trim()
    if (!text || card.streaming) return
    setDraft('')
    onFollowUp(text)
  }

  /** 摆位：优先放在选区下方；下方放不下就翻到上方；最后夹进视口。 */
  const place = useCallback(() => {
    const el = ref.current
    const width = el?.offsetWidth ?? 480
    const height = Math.min(el?.offsetHeight ?? 460, window.innerHeight * 0.7)
    const maxLeft = Math.max(MARGIN, window.innerWidth - width - MARGIN)
    const maxTop = Math.max(MARGIN, window.innerHeight - height - MARGIN)

    const below = card.rect.top + card.rect.height + 8
    const above = card.rect.top - height - 8
    let top = below
    if (below > maxTop) top = above >= MARGIN ? above : maxTop

    const left = Math.max(MARGIN, Math.min(card.rect.left, maxLeft))
    setPos({ left, top: Math.max(MARGIN, Math.min(top, maxTop)) })
  }, [card.rect])

  useLayoutEffect(() => {
    place()
  }, [place])

  // 窗口尺寸变化后重新夹紧，避免卡片被挤出视口
  useEffect(() => {
    const onResize = () => {
      const el = ref.current
      if (!el) return
      setPos((current) => {
        if (!current) return current
        const maxLeft = Math.max(MARGIN, window.innerWidth - el.offsetWidth - MARGIN)
        const maxTop = Math.max(MARGIN, window.innerHeight - el.offsetHeight - MARGIN)
        return {
          left: Math.max(MARGIN, Math.min(current.left, maxLeft)),
          top: Math.max(MARGIN, Math.min(current.top, maxTop)),
        }
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const startDrag = (event: React.PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return
    if (!pos) return
    drag.current = { dx: event.clientX - pos.left, dy: event.clientY - pos.top }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (!drag.current) return
    const el = ref.current
    if (!el) return
    const maxLeft = Math.max(MARGIN, window.innerWidth - el.offsetWidth - MARGIN)
    const maxTop = Math.max(MARGIN, window.innerHeight - el.offsetHeight - MARGIN)
    setPos({
      left: Math.max(MARGIN, Math.min(event.clientX - drag.current.dx, maxLeft)),
      top: Math.max(MARGIN, Math.min(event.clientY - drag.current.dy, maxTop)),
    })
  }

  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <div
      className="card"
      ref={ref}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
      onMouseUp={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header
        className="card-head"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title={t('拖动卡片可移动')}
      >
        <div className="card-term" title={card.anchor.quote}>
          {card.anchor.quote.slice(0, 60)}
        </div>
        <button className="icon" onClick={onClose} title={t('关闭（Esc）')}>
          ×
        </button>
      </header>

      <div className="card-breadcrumb" title={card.sourceText}>
        {t('来自：{text}', { text: card.sourceText.replace(/\s+/g, ' ').slice(0, 40) || '主线对话' })}
      </div>

      <div className="card-depth">
        {DEPTHS.map((depth) => (
          <button
            key={depth}
            className={card.depth === depth ? 'active' : ''}
            title={t(DEPTH_HINT[depth])}
            onClick={() => onDepthChange(depth)}
            disabled={card.streaming}
          >
            {t(DEPTH_LABEL[depth])}
          </button>
        ))}
        <span className="depth-hint">{t(DEPTH_HINT[card.depth])}</span>
      </div>

      <div
        className="card-body"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(card.answer || (card.streaming ? '…' : '')) }}
      />

      <div className="card-followup">
        <input
          value={draft}
          placeholder={t('继续追问（仅限当前卡片上下文）')}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !isImeComposing(event)) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <button onClick={submit} disabled={card.streaming || !draft.trim()}>
          {t('发送')}
        </button>
      </div>

      <footer className="card-foot">
        <span className="hint">
          {card.id ? t('如需系统学习，可升级为专题') : t('生成完成后可升级为专题')}
        </span>
        <div className="actions">
          {card.saved && (
            <button onClick={onRegenerate} disabled={card.streaming}>
              {t('重新生成')}
            </button>
          )}
          <button onClick={onSave} disabled={card.saved || !card.answer}>
            {card.saved ? t('已保存') : t('保存到账本')}
          </button>
          {card.promotedSessionId ? (
            <button className="primary" onClick={onOpenPromoted}>
              {t('打开专题')}
            </button>
          ) : (
            <button
              onClick={onPromote}
              disabled={card.streaming || !card.id}
              title={!card.id ? '等卡片生成完成后再升级' : '新建一个系统学习会话'}
            >
              {t('升级为专题')}
            </button>
          )}
        </div>
      </footer>
    </div>
  )
}
