import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { useI18n } from '../lib/i18n'
import { isImeComposing } from '../lib/ime'
import type { Anchor, CardProfile } from '../lib/types'

export interface OpenCardState {
  id: string | null
  anchor: Anchor
  level: string
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
  profile: CardProfile
  onClose: () => void
  onDepthChange: (level: string) => void
  onFollowUp: (text: string) => void
  onSave: () => void
  onRegenerate: () => void
  onPromote: () => void
  onOpenPromoted: () => void
}

const MARGIN = 8

/** 把坐标夹进视口；宽高取卡片当前真实尺寸。 */
function clampToViewport(
  left: number,
  top: number,
  width: number,
  height: number,
): { left: number; top: number } {
  const maxLeft = Math.max(MARGIN, window.innerWidth - width - MARGIN)
  const maxTop = Math.max(MARGIN, window.innerHeight - height - MARGIN)
  return {
    left: Math.max(MARGIN, Math.min(left, maxLeft)),
    top: Math.max(MARGIN, Math.min(top, maxTop)),
  }
}

export function Card({
  card,
  profile,
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

  const levels = profile.levels
  const selectedLevel =
    levels.find((level) => level.id === card.level) ??
    levels.find((level) => level.id === profile.default_level) ??
    levels[0]
  const longList = levels.length > 4

  const submit = () => {
    const text = draft.trim()
    if (!text || card.streaming) return
    setDraft('')
    onFollowUp(text)
  }

  /** 摆位：优先放在选区下方；下方放不下就翻到上方；最后夹进视口。 */
  const place = useCallback(() => {
    const el = ref.current
    const width = el?.offsetWidth ?? 510
    const height = el?.offsetHeight ?? Math.min(460, window.innerHeight * 0.7)
    const maxTop = Math.max(MARGIN, window.innerHeight - height - MARGIN)

    const below = card.rect.top + card.rect.height + 8
    const above = card.rect.top - height - 8
    let top = below
    if (below > maxTop) top = above >= MARGIN ? above : maxTop

    setPos(clampToViewport(card.rect.left, top, width, height))
  }, [card.rect])

  useLayoutEffect(() => {
    place()
  }, [place])

  // 窗口尺寸变化后重新夹紧，避免卡片被挤出视口
  useEffect(() => {
    const onResize = () => {
      const el = ref.current
      if (!el) return
      setPos((current) =>
        current
          ? clampToViewport(current.left, current.top, el.offsetWidth, el.offsetHeight)
          : current,
      )
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 流式输出会让卡片变高；尺寸一变就重新夹紧，不能等到用户手动拖回来。
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const width = el.offsetWidth
      const height = el.offsetHeight
      setPos((current) => {
        if (!current) return current
        const next = clampToViewport(current.left, current.top, width, height)
        return next.left === current.left && next.top === current.top ? current : next
      })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // 卡片打开时，1–9 直接切档；输入框 / 文本域里不抢数字键。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return
      if (!/^[1-9]$/.test(event.key)) return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return
      }
      // 上层有弹窗时不抢数字键，避免改到弹窗背后的卡片。
      if (target?.closest('.modal-backdrop')) return
      const level = levels[Number(event.key) - 1]
      if (!level || card.streaming) return
      event.preventDefault()
      onDepthChange(level.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [levels, card.streaming, onDepthChange])

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
    setPos(clampToViewport(event.clientX - drag.current.dx, event.clientY - drag.current.dy, el.offsetWidth, el.offsetHeight))
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

      {longList ? (
        <div className="card-depth long">
          <select
            value={selectedLevel?.id ?? ''}
            title={selectedLevel?.stop ?? profile.axis_label}
            disabled={card.streaming}
            onChange={(event) => onDepthChange(event.target.value)}
          >
            {levels.map((level, index) => (
              <option key={level.id} value={level.id} title={level.stop}>
                {index + 1}. {level.label}
              </option>
            ))}
          </select>
          {selectedLevel && <span className="depth-hint">{selectedLevel.stop}</span>}
        </div>
      ) : (
        <div className="card-depth">
          {levels.map((level) => (
            <button
              key={level.id}
              className={selectedLevel?.id === level.id ? 'active' : ''}
              title={level.stop}
              onClick={() => onDepthChange(level.id)}
              disabled={card.streaming}
            >
              {level.label}
            </button>
          ))}
        </div>
      )}

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
