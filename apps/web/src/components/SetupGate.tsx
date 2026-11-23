import type { ProviderPreset, SettingsView } from '../lib/types'
import { useI18n } from '../lib/i18n'
import { SettingsForm } from './SettingsForm'

interface Props {
  presets: ProviderPreset[]
  current: SettingsView
  onSaved: (view: SettingsView) => void
  onSkip: () => void
}

export function SetupGate({ presets, current, onSaved, onSkip }: Props) {
  const { lang, setLang, t } = useI18n()
  return (
    <div className="gate">
      <div className="gate-card">
        <select
          className="gate-language"
          value={lang}
          onChange={(event) => setLang(event.target.value as 'zh' | 'en')}
          aria-label={t('界面语言')}
        >
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
        <h1>{t('欢迎使用 StudyDeck')}</h1>
        <p className="muted">
          {t('这是一个本地学习工具：对话直接发给你自己填的模型服务商，不经过任何中转。填一次就能开始用。')}
        </p>
        <SettingsForm presets={presets} initial={current} submitLabel={t('保存并开始')} onSaved={onSaved} />
        <button className="link" onClick={onSkip}>
          {t('先逛逛（演示模式，返回的是脚本内容）')}
        </button>
      </div>
    </div>
  )
}
