import type { CardProfile } from '../lib/types'
import { Card, type OpenCardState } from './Card'

interface Props {
  card: OpenCardState | null
  /** 整条链：祖先 → 当前 */
  chain: OpenCardState[]
  activeIndex: number
  /** 父卡 key → 其它分支（每条是父卡之后的整条后缀链） */
  branches: Record<string, OpenCardState[][]>
  profile: CardProfile
  onClose: () => void
  onJump: (index: number) => void
  onSwitchBranch: (parentIndex: number, branchIndex: number) => void
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
  branches,
  profile,
  onClose,
  onJump,
  onSwitchBranch,
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
        branches={branches}
        profile={profile}
        onClose={onClose}
        onJump={onJump}
        onSwitchBranch={onSwitchBranch}
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
