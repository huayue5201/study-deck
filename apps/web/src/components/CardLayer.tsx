import type { CardProfile } from '../lib/types'
import { Card, type OpenCardState } from './Card'

interface Props {
  card: OpenCardState | null
  stack: OpenCardState[]
  forward: OpenCardState[]
  profile: CardProfile
  onClose: () => void
  onPopTo: (index: number) => void
  onForward: () => void
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
  stack,
  forward,
  profile,
  onClose,
  onPopTo,
  onForward,
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
        stack={stack}
        forward={forward}
        profile={profile}
        onClose={onClose}
        onPopTo={onPopTo}
        onForward={onForward}
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
