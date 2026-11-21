import { clearKey, downloadExport } from '../lib/api'
import type { ProviderPreset, SettingsView } from '../lib/types'
import { SettingsForm } from './SettingsForm'

interface Props {
  presets: ProviderPreset[]
  settings: SettingsView
  onSaved: (view: SettingsView) => void
  onClose: () => void
}

export function SettingsPanel({ presets, settings, onSaved, onClose }: Props) {
  const removeKey = async () => {
    const view = await clearKey()
    onSaved(view)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <strong>设置</strong>
          <button className="icon" onClick={onClose}>
            ×
          </button>
        </header>
        <SettingsForm presets={presets} initial={settings} submitLabel="保存" onSaved={onSaved} />
        <div className="export-row">
          <span className="muted small">导出账本：</span>
          <button className="link" onClick={() => void downloadExport('md')}>
            Markdown
          </button>
          <button className="link" onClick={() => void downloadExport('json')}>
            JSON
          </button>
        </div>
        <div className="modal-foot">
          <span className="muted small">数据只存在本机。</span>
          <button onClick={() => void removeKey()} disabled={!settings.has_key}>
            清除已保存的 Key
          </button>
        </div>
      </div>
    </div>
  )
}
