import { clearKey, downloadExport } from '../lib/api'
import { useI18n } from '../lib/i18n'
import type { ProviderPreset, SettingsView } from '../lib/types'
import { SettingsForm } from './SettingsForm'

interface Props {
  presets: ProviderPreset[]
  settings: SettingsView
  onSaved: (view: SettingsView) => void
  onClose: () => void
}

export function SettingsPanel({ presets, settings, onSaved, onClose }: Props) {
  const { lang, setLang, t } = useI18n()
  const removeKey = async () => {
    const view = await clearKey()
    onSaved(view)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <strong>{t('设置')}</strong>
          <button className="icon" onClick={onClose}>
            ×
          </button>
        </header>
        <label className="settings-language">
          <span>{t('界面语言')}</span>
          <select value={lang} onChange={(event) => setLang(event.target.value as 'zh' | 'en')}>
            <option value="zh">{t('中文')}</option>
            <option value="en">English</option>
          </select>
        </label>
        <SettingsForm presets={presets} initial={settings} submitLabel={t('保存')} onSaved={onSaved} />
        <div className="export-row">
          <span className="muted small">{t('导出账本：')}</span>
          <button className="link" onClick={() => void downloadExport('md')}>
            Markdown
          </button>
          <button className="link" onClick={() => void downloadExport('json')}>
            JSON
          </button>
        </div>
        <div className="modal-foot">
          <span className="muted small">{t('数据只存在本机。')}</span>
          <button onClick={() => void removeKey()} disabled={!settings.has_key}>
            {t('清除已保存的 Key')}
          </button>
        </div>
      </div>
    </div>
  )
}
