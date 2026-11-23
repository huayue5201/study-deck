import { useI18n } from '../lib/i18n'
import type { SessionOrigin, Topic } from '../lib/types'

interface Props {
  origin: SessionOrigin
  topic: Topic | null
  canOutline: boolean
  busy: boolean
  onBack: () => void
  onOutline: () => void
}

/** 专题会话顶部：来源 + 回链 + 生成学习地图。 */
export function OriginBanner({ origin, topic, canOutline, busy, onBack, onOutline }: Props) {
  const { t } = useI18n()
  return (
    <div className="origin-banner">
      <div className="origin-main">
        <span className="origin-label">{topic ? t('专题') : t('来源')}</span>
        {topic && <strong>{topic.title}</strong>}
        <span className="origin-source">
          {t('来自')}{' '}
          <button className="link" onClick={onBack}>
            《{origin.source_title || '原会话'}》
          </button>{' '}
          的「{origin.quote.replace(/\s+/g, ' ').slice(0, 40)}」
        </span>
      </div>
      {canOutline && (
        <button className="primary" onClick={onOutline} disabled={busy}>
          生成学习地图
        </button>
      )}
    </div>
  )
}
