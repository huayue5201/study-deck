import { useState } from 'react'

interface Props {
  disabled: boolean
  onSend: (text: string) => void
  examples?: string[]
}

export function Composer({ disabled, onSend, examples = [] }: Props) {
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
          placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
          rows={3}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <button className="send" onClick={submit} disabled={disabled || !value.trim()}>
          发送
        </button>
      </div>
    </div>
  )
}
