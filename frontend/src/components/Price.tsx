/**
 * A price as people read it: the dollar estimate large, the XRP it actually is small underneath. With no fresh price,
 * the XRP alone, exactly as before. Display only; the server supplied the estimate, nothing is converted here.
 */
import { dropsToXrp, type Fiat } from '@/lib/api'
import { formatFiat } from '@/lib/fiat'

export function Price({
  drops,
  fiat,
  className,
  subClassName = 'text-muted-foreground text-xs font-normal',
}: {
  drops: string
  fiat: Fiat | undefined
  className?: string
  subClassName?: string
}) {
  if (!fiat) return <span className={`tabular-nums ${className ?? ''}`}>{dropsToXrp(drops)} XRP</span>
  return (
    <span className={`inline-flex flex-col leading-tight ${className ?? ''}`}>
      <span className="tabular-nums">{formatFiat(fiat)}</span>
      <span className={`tabular-nums ${subClassName}`}>≈ {dropsToXrp(drops)} XRP</span>
    </span>
  )
}
