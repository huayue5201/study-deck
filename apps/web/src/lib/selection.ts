import type { Anchor } from './types'

export interface SelectionInfo {
  anchor: Anchor
  rect: DOMRect
  sourceText: string
  /** 选区落在某张卡片里时，带上它的 id（用于嵌套展开） */
  cardId?: string
}

function closestMessage(node: Node): HTMLElement | null {
  let current: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode
  while (current && current !== document.body) {
    if (current instanceof HTMLElement && (current.dataset.messageId || current.dataset.cardId)) {
      return current
    }
    current = current.parentNode
  }
  return null
}

function charOffset(root: HTMLElement, container: Node, offset: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let accumulated = 0
  let node: Node | null = walker.nextNode()
  while (node) {
    if (node === container) return accumulated + offset
    accumulated += node.textContent?.length ?? 0
    node = walker.nextNode()
  }
  // 选区边界落在元素上时，用 Range 文本长度兜底
  if (container instanceof Element) {
    const range = document.createRange()
    range.setStart(root, 0)
    range.setEnd(container, Math.min(offset, container.childNodes.length))
    return range.toString().length
  }
  return accumulated
}

/**
 * 把浏览器选区换算成「相对某条消息的字符区间」。
 * 全项目只在这里做这个换算——其他地方一律用 Anchor。
 */
export function readAnchor(): SelectionInfo | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  const quote = selection.toString().trim()
  if (!quote) return null

  const root = closestMessage(range.commonAncestorContainer)
  if (!root) return null

  const cardId = root.dataset.cardId
  const messageId = root.dataset.messageId ?? (cardId ? `card:${cardId}` : undefined)
  if (!messageId) return null

  const start = charOffset(root, range.startContainer, range.startOffset)
  const end = charOffset(root, range.endContainer, range.endOffset)
  if (end <= start) return null

  return {
    anchor: {
      message_id: messageId,
      char_start: start,
      char_end: end,
      quote,
    },
    rect: range.getBoundingClientRect(),
    sourceText: root.textContent ?? '',
    cardId,
  }
}
