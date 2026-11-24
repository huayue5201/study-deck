import type { CardProfile } from '../lib/types'
import { Card, type OpenCardState } from './Card'

interface Props {
  card: OpenCardState | null
  /** 整条链：祖先 → 当前 → 可前进 */
  chain: OpenCardState[]
  activeIndex: number
  profile: CardProfile
  onClose: () => void
  onJump: (index: number) => void
  onBackToMain: () => void
  onSelectInCard: () => void
  onDepthChange: (level: string) => void
  onFollowUp: (text: string) => void
  onSave: () => void
  onRegenerate: () => void
  onPromote: () => void
  onOpenPromoted: () => void
}

export function CardLayer({
  card,
  chain,
  activeIndex,
  profile,
  onClose,
  onJump,
  onBackToMain,
  onSelectInCard,
  onDepthChange,
  onFollowUp,
  onSave,
  onRegenerate,
  onPromote,
  onOpenPromoted,
}: Props) {
  if (!card) return null
  return (
    <div className="card-layer">
      <Card
        card={card}
        chain={chain}
        activeIndex={activeIndex}
        profile={profile}
        onClose={onClose}
        onJump={onJump}
        onBackToMain={onBackToMain}
        onSelectInCard={onSelectInCard}
        onDepthChange={onDepthChange}
        onFollowUp={onFollowUp}
        onSave={onSave}
        onRegenerate={onRegenerate}
        onPromote={onPromote}
        onOpenPromoted={onOpenPromoted}
      />
    </div>
  )
}
