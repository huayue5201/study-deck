import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../lib/i18n'
import { isImeComposing } from '../lib/ime'

interface Props {
  disabled: boolean
  onSend: (text: string) => void
  examples?: string[]
  /** 输入框下方的状态行：模型、token 等 */
  status?: ReactNode
  /** 外部填入一段草稿（例如“就选中内容追问”），id 变化才覆盖 */
  prefill?: { id: number; text: string } | null
}

export function Composer({ disabled, onSend, examples = [], status, prefill }: Props) {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!prefill) return
    setValue(prefill.text)
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.setSelectionRange(prefill.text.length, prefill.text.length)
  }, [prefill])

  const submit = () => {
    const text = value.trim()
    if (!text || disabled) return
    setValue('')
    onSend(text)
  }

  return (
    <div className="composer">
      {examples.length > 0 && (
        <div className="examples">
          {examples.map((example) => (
            <button key={example} onClick={() => setValue(example)}>
              {example}
            </button>
          ))}
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={inputRef}
          value={value}
          placeholder={t('输入问题…（Enter 发送，Shift+Enter 换行）')}
          rows={3}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !isImeComposing(event)) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <button className="send" onClick={submit} disabled={disabled || !value.trim()}>
          {t('发送')}
        </button>
      </div>
      {status && <div className="composer-status">{status}</div>}
    </div>
  )
}
