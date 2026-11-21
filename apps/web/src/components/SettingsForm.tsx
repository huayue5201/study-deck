import { useMemo, useState } from 'react'
import { testConnection, updateSettings } from '../lib/api'
import type { ProviderPreset, SettingsView } from '../lib/types'

interface Props {
  presets: ProviderPreset[]
  initial: SettingsView
  submitLabel: string
  onSaved: (view: SettingsView) => void
}

export function SettingsForm({ presets, initial, submitLabel, onSaved }: Props) {
  const matched = presets.find((preset) => preset.id === initial.provider)
  const [provider, setProvider] = useState(initial.provider || 'deepseek')
  const [baseUrl, setBaseUrl] = useState(initial.base_url || matched?.base_url || '')
  const [model, setModel] = useState(initial.model || matched?.models[0] || '')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [ok, setOk] = useState(false)

  const preset = useMemo(() => presets.find((item) => item.id === provider), [presets, provider])

  const applyPreset = (id: string) => {
    const next = presets.find((item) => item.id === id)
    setProvider(id)
    setBaseUrl(next?.base_url ?? '')
    setModel(next?.models[0] ?? '')
    setMessage(null)
  }

  const runTest = async () => {
    setBusy(true)
    setMessage('测试中…')
    try {
      const result = await testConnection({ base_url: baseUrl, model, api_key: apiKey })
      setOk(result.ok)
      setMessage(
        result.elapsed_ms ? `${result.message}（${result.elapsed_ms}ms）` : result.message,
      )
    } catch (err) {
      setOk(false)
      setMessage(String(err))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    try {
      const view = await updateSettings({
        provider,
        base_url: baseUrl,
        model,
        api_key: apiKey.trim() ? apiKey : undefined,
      })
      onSaved(view)
    } catch (err) {
      setOk(false)
      setMessage(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-form">
      <label>
        <span>服务商</span>
        <select value={provider} onChange={(event) => applyPreset(event.target.value)}>
          {presets.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      {preset?.note && <p className="muted small">{preset.note}</p>}

      <label>
        <span>接口地址</span>
        <input
          value={baseUrl}
          placeholder="https://api.deepseek.com"
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </label>

      <label>
        <span>模型</span>
        <input
          value={model}
          list="model-options"
          placeholder="deepseek-chat"
          onChange={(event) => setModel(event.target.value)}
        />
        <datalist id="model-options">
          {preset?.models.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
      </label>

      <label>
        <span>API Key</span>
        <input
          type="password"
          value={apiKey}
          placeholder={initial.has_key ? '已保存，留空表示不修改' : 'sk-…'}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>

      <p className="muted small">
        Key 只存在这台机器：优先写入系统钥匙串
        {initial.has_key && !initial.key_in_keychain ? '（当前为本地文件，权限 600）' : ''}
        。
      </p>

      {message && <p className={ok ? 'ok-msg' : 'err-msg'}>{message}</p>}

      <div className="form-actions">
        <button onClick={() => void runTest()} disabled={busy || !baseUrl || !model}>
          测试连接
        </button>
        <button className="primary" onClick={() => void save()} disabled={busy || !baseUrl || !model}>
          {submitLabel}
        </button>
      </div>
    </div>
  )
}
