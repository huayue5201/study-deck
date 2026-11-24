import { useEffect, useState } from 'react'
import {
  clearKey,
  downloadExport,
  maintainStorage,
  storageStats,
  type MaintenanceReport,
  type StorageCounts,
} from '../lib/api'
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
  const [counts, setCounts] = useState<StorageCounts | null>(null)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<MaintenanceReport | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void storageStats()
      .then((data) => {
        if (alive) setCounts(data)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const runMaintain = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      const result = await maintainStorage()
      setReport(result.report)
      setCounts(result.counts)
    } catch (error) {
      setErr(String(error))
    } finally {
      setBusy(false)
    }
  }

  const kb = counts ? Math.max(1, Math.round(counts.db_bytes / 1024)) : null
  const removeKey = async () => {
    setErr(null)
    try {
      const view = await clearKey()
      onSaved(view)
    } catch (error) {
      setErr(String(error))
    }
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
        <div className="storage-block">
          <div className="storage-head">
            <span>{t('存储')}</span>
            <span className="muted small">
              {kb === null
                ? t('读取中…')
                : `${kb} KB · ${counts?.cards ?? 0} ${t('张卡')} · ${counts?.messages ?? 0} ${t('条消息')} · ${counts?.entries ?? 0} ${t('条账本')}`}
            </span>
          </div>
          <p className="muted small">
            {t('启动时自动清理：空会话（7 天以上）、指向已删会话/卡片的孤儿记录、90 天前的 token 用量。')}
          </p>
          {err && <p className="small" style={{ color: '#ff9aa6' }}>{err}</p>}
          <div className="storage-actions">
            <button onClick={() => void runMaintain()} disabled={busy}>
              {busy ? t('清理中…') : t('清理并压缩')}
            </button>
            <span className="muted small">
              {report
                ? t('已清理 {n} 项，压缩完成', {
                    n:
                      report.empty_sessions +
                      report.orphan_encounters +
                      report.orphan_links +
                      report.old_turn_usage +
                      report.reattached_cards,
                  })
                : t('VACUUM 会把数据库文件真正缩小')}
            </span>
          </div>
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
