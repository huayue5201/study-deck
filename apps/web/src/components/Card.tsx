import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown, stripMarkdown } from '../lib/markdown'
import { useI18n } from '../lib/i18n'
import { isImeComposing } from '../lib/ime'
import type { Anchor, CardProfile } from '../lib/types'

export interface OpenCardState {
  /** 稳定的客户端身份：id 还没回来时也能区分卡片 */
  localId: string
  id: string | null
  anchor: Anchor
  level: string
  question: string
  answer: string
  streaming: boolean
  saved: boolean
  promotedSessionId: string | null
  /** 嵌套展开时的父卡 id（真实落库 id） */
  parentCardId: string | null
  /** 嵌套展开时的父卡本地 id（父卡还没落库时用它连树） */
  parentLocalId: string | null
  /** 父卡的回答（账本命中卡没有 id，用它给上下文） */
  parentText: string | null
  rect: { left: number; top: number; width: number; height: number }
  sourceText: string
}

export interface CardProps {
  card: OpenCardState
  /** 整条链：祖先 → 当前 */
  chain: OpenCardState[]
  activeIndex: number
  /** 每一层「往下走」的其它选择（= 分支），与 chain 同下标 */
  branchLists: OpenCardState[][]
  /** 整棵树的所有节点（dock 大纲用） */
  treeCards: OpenCardState[]
  profile: CardProfile
  onClose: () => void
  /** 跳到链上第 index 层 */
  onJump: (index: number) => void
  /** 切到某个祖先下的另一条分支（直接给目标节点的 localId） */
  onFocusNode: (localId: string) => void
  onSwitchBranch: (parentIndex: number, targetLocalId: string) => void
  /** 在同一处内容上再问一个：新开一条兄弟分支 */
  onBranch: (text: string) => void
  onDeleteNode: (localId: string) => void
  /** 钉到右侧（dock）/ 恢复浮层 */
  docked: boolean
  onToggleDock: () => void
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
  branchLists,
  treeCards,
  profile,
  onClose,
  onJump,
  onFocusNode,
  onSwitchBranch,
  onBranch,
  onDeleteNode,
  docked,
  onToggleDock,
  onBackToMain,
  onSelectInCard,
  onDepthChange,
  onFollowUp,
  onSave,
  onRegenerate,
  onPromote,
  onOpenPromoted,
}: CardProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  // 「在同一处再问一个」的内联输入
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [branching, setBranching] = useState(false)
  const [branchDraft, setBranchDraft] = useState('')
  const ref = useRef<HTMLDivElement | null>(null)
  const stackRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)

  const bodyRef = useRef<HTMLDivElement | null>(null)
  // 流式跟随的开关：用户上翻就暂停，回到底部再恢复
  const followRef = useRef(true)
  const lastScrollRef = useRef(0)
  // 用「链上位置 + 卡片身份」作为切换标识：同名引文、id 到达都不算切换
  const cardKey = `${activeIndex}:${card.localId}`
  const prevKey = useRef(cardKey)
  const [closing, setClosing] = useState(false)
  const [ghost, setGhost] = useState<OpenCardState | null>(null)
  const ghostTimer = useRef<number | null>(null)
  const prevCard = useRef<OpenCardState | null>(null)

  // 切层：旧卡做一层「影子」淡出，新卡淡入；正文回到顶部
  useEffect(() => {
    if (prevKey.current === cardKey) {
      prevCard.current = card
      return
    }
    prevKey.current = cardKey
    const previous = prevCard.current
    prevCard.current = card
    if (bodyRef.current) bodyRef.current.scrollTop = 0
    followRef.current = true
    lastScrollRef.current = 0
    // 跨层不重挂载：输入草稿属于「这一层」，必须跟着重置
    setDraft('')
    setBranching(false)
    setBranchDraft('')
    // 只让「影子」淡出：卡片本身保持不透明，避免透出背后的聊天内容造成闪烁感
    if (previous) {
      setGhost(previous)
      // 定时器放 ref：流式更新会让 card 换引用、effect 重跑，
      // 若把 clearTimeout 挂在 effect 清理里，影子会永远清不掉
      if (ghostTimer.current !== null) window.clearTimeout(ghostTimer.current)
      ghostTimer.current = window.setTimeout(() => {
        setGhost(null)
        ghostTimer.current = null
      }, 240)
    }
  }, [card, cardKey])
  useEffect(
    () => () => {
      if (ghostTimer.current !== null) window.clearTimeout(ghostTimer.current)
    },
    [],
  )

  // 关卡片：先播退场，再交给上层卸载
  const closeTimer = useRef<number | null>(null)
  const requestClose = useCallback(() => {
    if (closeTimer.current !== null) return
    setClosing(true)
    closeTimer.current = window.setTimeout(onClose, 160)
  }, [onClose])
  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    },
    [],
  )

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
      if (!el || docked) return
      setPos((current) =>
        current
          ? clampToViewport(current.left, current.top, el.offsetWidth, el.offsetHeight)
          : current,
      )
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [docked])

  // 流式输出会让卡片变高；尺寸一变就重新夹紧，不能等到用户手动拖回来。
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      // dock 时尺寸由 CSS 决定，不能拿它去夹浮层坐标
      if (docked) return
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
  }, [docked])

  // 卡片高度 = 内容高度（有上下限），短内容不留白、长内容到顶后内部滚动
  const [cardHeight, setCardHeight] = useState<number | null>(null)
  const innerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    const body = bodyRef.current
    const inner = innerRef.current
    if (!el || !body || !inner) return
    const frame = window.requestAnimationFrame(() => {
      const maxHeight = Math.min(window.innerHeight * 0.66, 620)
      const style = window.getComputedStyle(body)
      const bodyPad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      // 卡片固定部分（头部 / 追问 / 底部）的高度
      const chrome = el.offsetHeight - body.offsetHeight
      const desired = Math.min(Math.max(inner.offsetHeight + bodyPad + chrome, 360), maxHeight)
      setCardHeight((prev) => (prev !== null && Math.abs(prev - desired) < 2 ? prev : desired))
    })
    return () => window.cancelAnimationFrame(frame)
  }, [card.answer, cardKey, viewport.h])

  // 流式输出时正文缓动跟到底；用户主动上翻时暂停，别把人拽回去
  useEffect(() => {
    if (!card.streaming) return
    let frame = 0
    const follow = () => {
      const el = bodyRef.current
      if (el && followRef.current) {
        const gap = el.scrollHeight - el.clientHeight - el.scrollTop
        if (gap > 1) el.scrollTop += Math.max(1, gap * 0.24)
      }
      frame = window.requestAnimationFrame(follow)
    }
    frame = window.requestAnimationFrame(follow)
    return () => window.cancelAnimationFrame(frame)
  }, [card.streaming])

  // 卡片打开时的键盘：Esc 关、←/→ 在链上翻层、1–9 切档；输入框里全部让路
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return
      const target = event.target as HTMLElement | null
      // 上层有弹窗时不抢键，避免改到弹窗背后的卡片
      if (target?.closest('.modal-backdrop')) return
      const tag = target?.tagName
      const typing =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target?.isContentEditable)

      if (event.key === 'Escape') {
        event.preventDefault()
        requestClose()
        return
      }
      if (typing) return

      if (event.key === 'ArrowLeft' && activeIndex > 0) {
        event.preventDefault()
        onJump(activeIndex - 1)
        return
      }
      if (event.key === 'ArrowRight' && activeIndex < chain.length - 1) {
        event.preventDefault()
        onJump(activeIndex + 1)
        return
      }
      if (!/^[1-9]$/.test(event.key) || card.streaming) return
      const level = levels[Number(event.key) - 1]
      if (!level) return
      event.preventDefault()
      onDepthChange(level.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeIndex, card.streaming, chain.length, levels, onDepthChange, onJump, requestClose])

  const startDrag = (event: React.PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return
    if (docked || !pos) return
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

  const depth = activeIndex + 1

  // 与 CSS 的 .card 宽度保持一致（dock 时 CSS 会另行覆盖）
  const cardWidth = Math.min(510, viewport.w - 16)

  // 入场动画从「被划的那段文字」位置长出来
  const defaultQuestion = t('请解释这段内容。')
  /** 分支标签：优先用「这一支在问什么」，默认问题或空则退回引文 */
  const labelBase = (node: OpenCardState, limit = 20) => {
    const question = (node.question ?? '').trim()
    const text =
      question && question !== defaultQuestion
        ? question
        : node.anchor.quote.replace(/\s+/g, ' ').trim()
    return text.length > limit ? `${text.slice(0, limit)}…` : text
  }
  /** 同一个词分出的多支，标签会撞车：给它们编号 1/2、2/2 */
  const labelInfo = useMemo(() => {
    const total = new Map<string, number>()
    const ordinal = new Map<string, number>()
    for (const node of treeCards) {
      const base = labelBase(node)
      ordinal.set(node.localId, (total.get(base) ?? 0) + 1)
      total.set(base, (total.get(base) ?? 0) + 1)
    }
    return { total, ordinal }
  }, [treeCards])
  const labelOf = (node: OpenCardState, limit = 20) => {
    const base = labelBase(node, limit)
    const count = labelInfo.total.get(base) ?? 1
    return count > 1 ? `${base} ${labelInfo.ordinal.get(node.localId)}/${count}` : base
  }
  /** 某一层下面一共有多少后代（删除确认时要说清楚会连带删掉多少） */
  const descendantCount = (localId: string) => {
    let count = 0
    let frontier = [localId]
    while (frontier.length) {
      const next: string[] = []
      for (const node of treeCards) {
        if (node.parentLocalId && frontier.includes(node.parentLocalId)) {
          next.push(node.localId)
          count += 1
        }
      }
      frontier = next
    }
    return count
  }

  const gistOf = (node: OpenCardState) =>
    stripMarkdown(node.answer).replace(/\s+/g, ' ').trim().slice(0, 64)

  const childrenOf = useMemo(() => {
    const map = new Map<string | null, OpenCardState[]>()
    for (const node of treeCards) {
      const list = map.get(node.parentLocalId) ?? []
      list.push(node)
      map.set(node.parentLocalId, list)
    }
    return map
  }, [treeCards])
  const roots = childrenOf.get(null) ?? []
  const hasFork = useMemo(
    () => [...childrenOf.values()].some((list) => list.length > 1),
    [childrenOf],
  )
  const treeRows = useMemo(() => {
    const rows: Array<{ node: OpenCardState; depth: number }> = []
    const walk = (parent: string | null, depth: number) => {
      for (const node of childrenOf.get(parent) ?? []) {
        rows.push({ node, depth })
        walk(node.localId, depth + 1)
      }
    }
    walk(null, 0)
    return rows
  }, [childrenOf])

  /** 面包屑上的分叉弹层：root = 主线下的平行根卡，level = 某层下的其它分支 */
  const [pop, setPop] = useState<{ key: 'root' } | { key: 'level'; index: number } | null>(null)
  const [popCursor, setPopCursor] = useState(0)
  const popRef = useRef<HTMLDivElement | null>(null)
  const popRows = useMemo(() => {
    if (!pop) return [] as OpenCardState[]
    if (pop.key === 'root') return roots
    const index = pop.index
    const next = chain[index + 1]
    return [...(next ? [next] : []), ...(branchLists[index] ?? [])]
  }, [pop, roots, chain, branchLists])

  useEffect(() => {
    if (!pop) return
    setPopCursor(0)
    const onDown = (event: PointerEvent) => {
      if (!popRef.current?.contains(event.target as Node)) setPop(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [pop])

  const choosePop = (node: OpenCardState) => {
    if (pop) {
      if (pop.key === 'root') onSwitchBranch(-1, node.localId)
      else onSwitchBranch(pop.index, node.localId)
    }
    setPop(null)
  }

  const enterOrigin = pos
    ? `${Math.max(0, Math.min(card.rect.left + card.rect.width / 2 - pos.left, cardWidth))}px ${
        Math.max(-40, Math.min(card.rect.top - pos.top, 420))
      }px`
    : '50% 0%'

  return (
    <div
      ref={stackRef}
      className={`card-stack${docked ? ' docked' : ''}${docked && hasFork ? ' with-tree' : ''}${closing ? ' closing' : ''}`}
      style={
        docked
          ? undefined
          : pos
            ? { left: pos.left, top: pos.top }
            : { visibility: 'hidden' }
      }
      onWheel={(event) => event.stopPropagation()}
    >
      {docked && hasFork && (
        <aside className="card-tree" aria-label={t('卡片树')}>
          <div className="card-tree-head">{t('卡片树')} · {treeRows.length}</div>
          {treeRows.map(({ node, depth }) => (
            <button
              key={node.localId}
              className={`tree-node${node.localId === card.localId ? ' current' : ''}${
                node.streaming ? ' streaming' : ''
              }`}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => onFocusNode(node.localId)}
              title={node.anchor.quote}
            >
              <span className="tree-dot" />
              <span className="tree-label">{labelOf(node)}</span>
            </button>
          ))}
        </aside>
      )}

      <div
        className="card"
        ref={ref}
        style={
          {
            '--enter-origin': enterOrigin,
            height: docked ? undefined : cardHeight ?? undefined,
          } as React.CSSProperties
        }
        onMouseUp={(event) => {
          event.stopPropagation()
          const selection = window.getSelection()
          if (!selection || selection.isCollapsed || !selection.toString().trim()) return
          // 只认卡片正文里的选区：避免点卡片时误用聊天区残留的选区
          const node = selection.anchorNode
          if (!node || !bodyRef.current?.contains(node)) return
          onSelectInCard()
        }}
      >
      {ghost && (
        <div className="card-ghost" aria-hidden="true">
          <div className="card-ghost-head">{ghost.anchor.quote.slice(0, 60)}</div>
          <div
            className="card-ghost-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(ghost.answer) }}
          />
        </div>
      )}

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
        <span className="card-depth-badge" title={t('当前深度')}>
          {t('第 {n} 层', { n: depth })}
        </span>
        <button
          className={`icon card-dock${docked ? ' active' : ''}`}
          onClick={onToggleDock}
          title={docked ? t('取消固定') : t('固定到右侧')}
        >
          {docked ? '⇤' : '⇥'}
        </button>
        <button className="icon" onClick={requestClose} title={t('关闭整叠（Esc）')}>
          ×
        </button>
      </header>

      <nav
        className={`card-crumbs${chain.length === 1 ? ' single' : ''}`}
        aria-label={t('卡片链')}
      >
        <button className="crumb home" onClick={onBackToMain}>
          {t('主线')}
        </button>
        {roots.length > 1 && (
          <button
            className={`crumb-caret${pop?.key === 'root' ? ' open' : ''}`}
            onClick={() => setPop(pop?.key === 'root' ? null : { key: 'root' })}
            title={t('{n} 张平行卡片', { n: roots.length })}
            aria-expanded={pop?.key === 'root'}
          >
            ⌄{roots.length}
          </button>
        )}
        {chain.map((node, index) => {
          const next = chain[index + 1]
          const total = branchLists[index].length + (next ? 1 : 0)
          // 有「其它分支」才显示分叉标记；只有一条下行路径时不需要
          const forked = branchLists[index].length > 0
          const open = pop?.key === 'level' && pop.index === index
          return (
            <span key={node.localId} className="crumb-group">
              <span className="crumb-sep">›</span>
              <button
                className={`crumb${index === activeIndex ? ' current' : ''}`}
                onClick={() => onJump(index)}
                title={`${node.anchor.quote}\n${node.question}`}
              >
                <span className="crumb-num">L{index + 1}</span>
                {labelOf(node, chain.length === 1 ? 80 : 20)}
              </button>
              <button
                className={`crumb-del${confirmDelete === node.localId ? ' active' : ''}`}
                onClick={(event) => {
                  event.stopPropagation()
                  setConfirmDelete(confirmDelete === node.localId ? null : node.localId)
                }}
                title={t('删除这一层')}
                aria-label={t('删除这一层')}
              >
                ×
              </button>
              {confirmDelete === node.localId && (
                <div
                  className="crumb-del-pop"
                  onClick={(event) => event.stopPropagation()}
                  role="dialog"
                >
                  <div className="crumb-del-text">
                    {descendantCount(node.localId) > 0
                      ? t('删除「{label}」及它下面的 {n} 层？', {
                          label: labelOf(node),
                          n: descendantCount(node.localId),
                        })
                      : t('删除「{label}」？', { label: labelOf(node) })}
                  </div>
                  <div className="crumb-del-actions">
                    <button
                      className="danger"
                      onClick={() => {
                        setConfirmDelete(null)
                        onDeleteNode(node.localId)
                      }}
                    >
                      {t('删除')}
                    </button>
                    <button onClick={() => setConfirmDelete(null)}>{t('取消')}</button>
                  </div>
                </div>
              )}
              {forked && (
                <button
                  className={`crumb-caret${open ? ' open' : ''}`}
                  onClick={() =>
                    setPop(open ? null : { key: 'level', index })
                  }
                  title={t('{n} 个分支', { n: total })}
                  aria-expanded={open}
                >
                  ⌄{total}
                </button>
              )}
            </span>
          )
        })}
        <button
          className={`crumb-add${branching ? ' active' : ''}`}
          onClick={() => setBranching((value) => !value)}
          disabled={card.streaming}
          title={t('在同一处内容上再问一个（新分支）')}
        >
          ＋
        </button>
        {pop && popRows.length > 1 && (
          <div
            className="crumb-pop"
            ref={popRef}
            role="menu"
            onKeyDown={(event) => {
              const last = popRows.length - 1
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setPopCursor((value) => (value >= last ? 0 : value + 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setPopCursor((value) => (value <= 0 ? last : value - 1))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                choosePop(popRows[popCursor])
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                setPop(null)
              }
            }}
          >
            <div className="crumb-pop-head">
              {pop.key === 'root'
                ? t('同一处内容的 {n} 张卡片', { n: popRows.length })
                : t('第 {n} 层 · {m} 个分支', {
                    n: pop.key === 'level' ? pop.index + 2 : 1,
                    m: popRows.length,
                  })}
            </div>
            {popRows.map((node, rowIndex) => (
              <button
                key={node.localId}
                role="menuitem"
                className={`crumb-pop-row${rowIndex === popCursor ? ' cursor' : ''}${
                  node.localId === card.localId ? ' current' : ''
                }`}
                onMouseEnter={() => setPopCursor(rowIndex)}
                onClick={() => choosePop(node)}
              >
                <span className={`crumb-pop-dot${node.streaming ? ' streaming' : ''}`} />
                <span className="crumb-pop-text">
                  <span className="crumb-pop-label">{labelOf(node)}</span>
                  <span className="crumb-pop-gist">
                    {node.streaming ? t('生成中…') : gistOf(node) || t('（暂无内容）')}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </nav>

      {branching && (
        <div className="card-branch-ask">
          <input
            autoFocus
            value={branchDraft}
            placeholder={t('针对「{text}」再问一个…', { text: card.anchor.quote.slice(0, 18) })}
            onChange={(event) => setBranchDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setBranching(false)
                setBranchDraft('')
                return
              }
              if (event.key === 'Enter' && !isImeComposing(event)) {
                event.preventDefault()
                const text = branchDraft.trim()
                if (!text) return
                setBranching(false)
                setBranchDraft('')
                onBranch(text)
              }
            }}
          />
        </div>
      )}

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

      <div className="card-body" ref={bodyRef} data-card-id={card.id ?? card.localId}
        onScroll={() => {
          const el = bodyRef.current
          if (!el || !card.streaming) return
          const top = el.scrollTop
          const gap = el.scrollHeight - el.clientHeight - top
          // 只把「向上滚」当用户接管；程序自己的向下滚动不会误判
          if (top < lastScrollRef.current - 2 && gap > 24) followRef.current = false
          else if (gap < 8) followRef.current = true
          lastScrollRef.current = top
        }}
      >
        <div
          className="card-body-inner"
          ref={innerRef}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(card.answer || (card.streaming ? '…' : '')) }}
        />
      </div>

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
          <button onClick={onSave} disabled={card.saved || card.streaming || !card.answer}>
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
