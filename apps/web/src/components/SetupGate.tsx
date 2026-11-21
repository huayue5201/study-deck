import type { ProviderPreset, SettingsView } from '../lib/types'
import { SettingsForm } from './SettingsForm'

interface Props {
  presets: ProviderPreset[]
  current: SettingsView
  onSaved: (view: SettingsView) => void
  onSkip: () => void
}

export function SetupGate({ presets, current, onSaved, onSkip }: Props) {
  return (
    <div className="gate">
      <div className="gate-card">
        <h1>欢迎使用 StudyDeck</h1>
        <p className="muted">
          这是一个本地学习工具：对话直接发给你自己填的模型服务商，不经过任何中转。
          填一次就能开始用。
        </p>
        <SettingsForm presets={presets} initial={current} submitLabel="保存并开始" onSaved={onSaved} />
        <button className="link" onClick={onSkip}>
          先逛逛（演示模式，返回的是脚本内容）
        </button>
      </div>
    </div>
  )
}
