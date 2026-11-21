import { useEffect, useRef } from 'react'
import type { Message } from '../lib/types'
import { renderMarkdown } from '../lib/markdown'

interface Props {
  messages: Message[]
  streamingId: string | null
  flashId: string | null
  onMouseUp: () => void
}

export function MessageList({ messages, streamingId, flashId, onMouseUp }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!flashId) return
    const el = containerRef.current?.querySelector(`[data-message-id="${flashId}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [flashId])

  useEffect(() => {
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  return (
    <div className="messages" ref={containerRef} onMouseUp={onMouseUp}>
      {messages.length === 0 && (
        <div className="empty">
          <h2>从一句你真正卡住的问题开始</h2>
          <p>
            回答里出现不懂的词，直接选中它 —— 会浮出一张卡片，就地展开，主线不受影响。
          </p>
        </div>
      )}
      {messages.map((message) => (
        <div
          key={message.id}
          className={`msg msg-${message.role} ${flashId === message.id ? 'flash' : ''}`}
        >
          <div className="msg-role">{message.role === 'user' ? '你' : '助教'}</div>
          <div
            className={`msg-body ${streamingId === message.id ? 'streaming' : ''}`}
            data-message-id={message.role === 'assistant' ? message.id : undefined}
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(
                message.text ||
                  (message.status === 'error'
                    ? '_这一轮失败了（没有内容）。_'
                    : message.status === 'cancelled'
                      ? '_这一轮已取消。_'
                      : ''),
              ),
            }}
          />
          {message.status && message.status !== 'ok' && (
            <div className={`msg-status status-${message.status}`}>
              {message.status === 'error' ? '失败' : message.status === 'cancelled' ? '已取消' : '进行中'}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
