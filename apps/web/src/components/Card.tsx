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
  /** 嵌套展开时的父卡 id */
  parentCardId: string | null
  /** 父卡的回答（账本命中卡没有 id，用它给上下文） */
  parentText: string | null
  rect: { left: number; top: number; width: number; height: number }
  sourceText: string
}

interface Props {
  card: OpenCardState
  /** 祖先卡片（栈底在前），用于扇形叠放与面包屑 */
  stack: OpenCardState[]
  profile: CardProfile
  onClose: () => void
  /** 回到第 index 个祖先（0 = 最外层） */
  onPopTo: (index: number) => void
  onBackToMain: () => void
  /** 在卡片正文里划词，准备嵌套展开 */
  onSelectInCard: () => void
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
  stack,
  profile,
  onClose,
  onPopTo,
  onBackToMain,
  onSelectInCard,
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

  const depth = stack.length + 1
  // 只露最上面 2 层，更多用 +N 表示——堆太厚反而看不清
  const visiblePeeks = stack.slice(-2).map((ancestor, index) => ({
    ancestor,
    index: stack.length - Math.min(stack.length, 2) + index,
    offset: 2 - Math.min(stack.length, 2) + index + 1,
  }))
  const hiddenAbove = Math.max(0, stack.length - 2)

  return (
    <div
      className="card-stack"
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
      onWheel={(event) => event.stopPropagation()}
    >
      {visiblePeeks.map(({ ancestor, index, offset }) => (
        <button
          key={`${ancestor.id ?? ancestor.anchor.quote}-${index}`}
          className="card-peek"
          style={{
            left: 12 + offset * 9,
            right: 12 + offset * 9,
            transform: `translateY(${-offset * 11}px)`,
            opacity: 0.45 + offset * 0.15,
            zIndex: 10 - offset,
          }}
          onClick={() => onPopTo(index)}
          title={t('回到：{text}', { text: ancestor.anchor.quote.slice(0, 40) })}
        >
          {hiddenAbove > 0 && offset === 2 ? `+${hiddenAbove}` : ''}
        </button>
      ))}

      <div
        className="card"
        ref={ref}
        onMouseUp={(event) => {
          event.stopPropagation()
          onSelectInCard()
        }}
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
        <span className="card-depth-badge">{t('第 {n} 层', { n: depth })}</span>
        <button className="icon" onClick={onClose} title={t('关闭整叠（Esc）')}>
          ×
        </button>
      </header>

      <div className="card-breadcrumb">
        <button className="crumb" onClick={onBackToMain}>
          {t('主线')}
        </button>
        {stack.map((ancestor, index) => (
          <span key={`${ancestor.id ?? index}`} className="crumb-wrap">
            <span className="crumb-sep">›</span>
            <button className="crumb" onClick={() => onPopTo(index)}>
              {ancestor.anchor.quote.slice(0, 14)}
            </button>
          </span>
        ))}
        <span className="crumb-sep">›</span>
        <span className="crumb current">{card.anchor.quote.slice(0, 14)}</span>
      </div>

      {depth >= 5 && (
        <div className="card-warning">
          {t('已深入 {n} 层，注意上下文与成本', { n: depth })}
        </div>
      )}

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
        data-card-id={card.id ?? 'draft'}
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
    </div>
  )
}
