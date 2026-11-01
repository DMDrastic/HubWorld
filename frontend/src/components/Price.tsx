/**
 * A price as a fan reads it: US$ only. With no fresh price, a plain note instead; never XRP, never an old dollar figure.
 * Display only; the server supplied the figure, nothing is converted here.
 */
import type { Fiat } from '@/lib/api'
import { PRICE_UNAVAILABLE, formatFiat } from '@/lib/fiat'

export function Price({ fiat, className }: { fiat: Fiat | undefined; className?: string }) {
  if (!fiat) return <span className={`text-muted-foreground ${className ?? ''}`}>{PRICE_UNAVAILABLE}</span>
  return <span className={`tabular-nums ${className ?? ''}`}>{formatFiat(fiat)}</span>
}
