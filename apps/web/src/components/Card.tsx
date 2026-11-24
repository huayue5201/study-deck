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
  /** 整条链：祖先 → 当前 → 可前进 */
  chain: OpenCardState[]
  activeIndex: number
  profile: CardProfile
  onClose: () => void
  /** 跳到链上第 index 层 */
  onJump: (index: number) => void
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
  chain,
  activeIndex,
  profile,
  onClose,
  onJump,
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
  // 卡片堆开合（Cover Flow）
  const [deckOpen, setDeckOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)

  const cardKey = card.anchor.quote + (card.parentCardId ?? '')
  const prevKey = useRef(cardKey)
  const [switching, setSwitching] = useState(false)
  useEffect(() => {
    if (prevKey.current === cardKey) return
    prevKey.current = cardKey
    setSwitching(true)
    const timer = window.setTimeout(() => setSwitching(false), 220)
    return () => window.clearTimeout(timer)
  }, [cardKey])

  // 视口尺寸：决定扇开幅度，避免封面溢出软件边框
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }))
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

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

  // 只在卡片首次出现时定位；之后切层不再重新计算，避免卡片位置跳动
  const placedRef = useRef(false)
  useLayoutEffect(() => {
    if (placedRef.current) return
    placedRef.current = true
    place()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // 固定高度后，正文在卡片内部滚动；流式输出时自动跟到底
  const bodyRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = bodyRef.current
    if (!el || !card.streaming) return
    el.scrollTop = el.scrollHeight
  }, [card.answer, card.streaming])

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

  const stack = chain.slice(0, activeIndex)
  const forward = chain.slice(activeIndex + 1)
  const depth = activeIndex + 1

  // 祖先卡做成斜置封面：索引直接对应链上的层号
  const covers = stack.slice(-4).map((ancestor, index) => {
    const k = stack.length - Math.min(stack.length, 4) + index
    return { ancestor, index: k, order: stack.length - k }
  })
  const hiddenCovers = Math.max(0, stack.length - 4)

  // 左/右可用宽度（卡片位置固定后就不变），保证封面不溢出窗口
  const leftRoom = pos ? Math.max(0, pos.left - 12) : 320
  const rightRoom = pos ? Math.max(0, viewport.w - pos.left - 510 - 12) : 320
  const spreadLeft = stack.length
    ? Math.max(54, Math.min(118, (leftRoom - 300) / Math.max(1, Math.min(stack.length, 4))))
    : 118
  const spreadRight = forward.length
    ? Math.max(54, Math.min(118, (rightRoom - 300) / Math.max(1, Math.min(forward.length, 3))))
    : 118
  const showForward = rightRoom > 200

  // 入场动画从「被划的那段文字」位置长出来
  const enterOrigin = pos
    ? `${Math.max(0, Math.min(card.rect.left + card.rect.width / 2 - pos.left, 510))}px ${
        Math.max(-40, Math.min(card.rect.top - pos.top, 420))
      }px`
    : '50% 0%'

  return (
    <div
      className="card-stack"
      style={
        pos
          ? { left: pos.left, top: pos.top }
          : { visibility: 'hidden' }
      }
      onWheel={(event) => event.stopPropagation()}
    >
      {chain.length > 1 && (
        <nav className="card-rail" aria-label={t('卡片链')}>
          {chain.map((item, k) => (
            <button
              key={`rail-${item.id ?? item.anchor.quote}-${k}`}
              className={`rail-item ${k === activeIndex ? 'active' : ''}`}
              onClick={() => onJump(k)}
              title={t('第 {n} 层：{text}', { n: k + 1, text: item.anchor.quote })}
            >
              <span className="rail-num">L{k + 1}</span>
              <span className="rail-quote">{item.anchor.quote.slice(0, 20)}</span>
            </button>
          ))}
        </nav>
      )}

      <div
        className={`card-deck ${deckOpen ? 'deck-fan' : ''}`}
        style={
          {
            '--spread-l': `${spreadLeft}px`,
            '--spread-r': `${spreadRight}px`,
          } as React.CSSProperties
        }
      >
        {showForward &&
          forward.map((item, index) => (
          <button
            key={`fwd-${item.id ?? item.anchor.quote}-${index}`}
            className="card-cover forward"
            style={{ '--d': index + 1 } as React.CSSProperties}
            onClick={() => onJump(activeIndex + 1 + index)}
            title={t('前进到：{text}', { text: item.anchor.quote.slice(0, 40) })}
          >
              <span className="cover-head">
                <span className="cover-level">L{activeIndex + 2 + index}</span>
                <span className="cover-tab">{item.anchor.quote.slice(0, 8)}</span>
              </span>
              <span className="cover-quote">{item.anchor.quote.slice(0, 42)}</span>
              <span className="cover-gist">
                {item.answer.replace(/[#*>`_~\-]/g, ' ').replace(/\s+/g, ' ').slice(0, 110)}
              </span>
            </button>
          ))}
        {stack.length > 0 && (
          <div
            className="pile-hotspot"
            onMouseEnter={() => setDeckOpen(true)}
            onMouseLeave={() => setDeckOpen(false)}
            title={t('掀开卡片堆')}
          />
        )}
        {covers.map(({ ancestor, index, order }) => (
          <button
            key={`${ancestor.id ?? ancestor.anchor.quote}-${index}`}
            className="card-cover"
            style={{ '--d': order } as React.CSSProperties}
            onClick={() => onJump(index)}
            title={t('回到：{text}', { text: ancestor.anchor.quote.slice(0, 40) })}
          >
            <span className="cover-head">
              <span className="cover-level">L{index + 1}</span>
              <span className="cover-tab">{ancestor.anchor.quote.slice(0, 8)}</span>
              {hiddenCovers > 0 && index === 0 && (
                <span className="cover-more">+{hiddenCovers}</span>
              )}
            </span>
            <span className="cover-quote">{ancestor.anchor.quote.slice(0, 42)}</span>
            <span className="cover-gist">
              {ancestor.answer
                .replace(/[#*>`_~\-]/g, ' ')
                .replace(/\s+/g, ' ')
                .slice(0, 110)}
            </span>
          </button>
        ))}

      <div
        className={`card ${switching ? 'card-switch' : ''}`}
        ref={ref}
        style={{ '--enter-origin': enterOrigin } as React.CSSProperties}
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
        <button
          className={`card-depth-badge ${deckOpen ? 'active' : ''}`}
          onClick={() => setDeckOpen((value) => !value)}
          title={t('卡片堆（{n} 层）', { n: stack.length + 1 })}
        >
          {t('第 {n} 层', { n: depth })}
        </button>
        {forward.length > 0 && (
          <button
            className="card-forward"
            onClick={() => onJump(activeIndex + 1)}
            title={t('前进：回到刚才退下来的卡')}
          >
            {t('前进 {n}', { n: forward.length })}
          </button>
        )}
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
            <button className="crumb" onClick={() => onJump(index)}>
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
        ref={bodyRef}
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
    </div>
  )
}
