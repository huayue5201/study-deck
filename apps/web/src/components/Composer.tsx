import { useState } from 'react'
import { useI18n } from '../lib/i18n'
import { isImeComposing } from '../lib/ime'

interface Props {
  disabled: boolean
  onSend: (text: string) => void
  examples?: string[]
}

export function Composer({ disabled, onSend, examples = [] }: Props) {
  const { t } = useI18n()
  const [value, setValue] = useState('')

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
    </div>
  )
}
