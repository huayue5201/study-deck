import type { CardProfile } from '../lib/types'
import { Card, type OpenCardState } from './Card'

interface Props {
  card: OpenCardState | null
  profile: CardProfile
  onClose: () => void
  onDepthChange: (level: string) => void
  onFollowUp: (text: string) => void
  onSave: () => void
  onRegenerate: () => void
  onPromote: () => void
  onOpenPromoted: () => void
}

export function CardLayer({
  card,
  profile,
  onClose,
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
        profile={profile}
        onClose={onClose}
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
