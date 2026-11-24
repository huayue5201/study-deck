import type { OpenCardState } from './Card'
import { Card, type CardProps } from './Card'

type Props = Omit<CardProps, 'card'> & { card: OpenCardState | null }

/** 薄封装：只负责「有卡才渲染」，其余全部透传给 Card */
export function CardLayer({ card, ...rest }: Props) {
  if (!card) return null
  return (
    <div className="card-layer">
      <Card card={card} {...rest} />
    </div>
  )
}
