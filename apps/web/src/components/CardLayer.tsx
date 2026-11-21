import type { Depth } from '../lib/types'
import { Card, type OpenCardState } from './Card'

interface Props {
  card: OpenCardState | null
  onClose: () => void
  onDepthChange: (depth: Depth) => void
  onFollowUp: (text: string) => void
  onSave: () => void
  onRegenerate: () => void
}

export function CardLayer({ card, onClose, onDepthChange, onFollowUp, onSave, onRegenerate }: Props) {
  if (!card) return null
  return (
    <div className="card-layer">
      <Card
        card={card}
        onClose={onClose}
        onDepthChange={onDepthChange}
        onFollowUp={onFollowUp}
        onSave={onSave}
        onRegenerate={onRegenerate}
      />
    </div>
  )
}
