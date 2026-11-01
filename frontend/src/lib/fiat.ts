/**
 * Formatting the display estimate. FORMATTING ONLY: no conversion happens in the browser. The server sends the
 * estimate in minor units (cents) beside the XRP amount; this turns "3500" into "US$35.00".
 */
import { dropsToXrp, type Fiat } from '@/lib/api'

const SYMBOL: Record<Fiat['currency'], string> = { USD: 'US$', XCD: 'EC$' }

export function formatFiat(f: Fiat): string {
  const m = f.minor.padStart(3, '0')
  const whole = m.slice(0, -2).replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${SYMBOL[f.currency]}${whole}.${m.slice(-2)}`
}

/**
 * Where someone commits: the XRP is what they pay, the dollars are an estimate. "You’ll pay 28 XRP (about US$35.00)",
 * or just "You’ll pay 28 XRP" when there is no fresh price.
 */
export function commitLine(drops: string, fiat: Fiat | undefined): string {
  return `You’ll pay ${dropsToXrp(drops)} XRP${fiat ? ` (about ${formatFiat(fiat)})` : ''}`
}

/** "28 XRP (about US$35.00)" for labels read aloud, or "28 XRP". */
export function spokenPrice(drops: string, fiat: Fiat | undefined): string {
  return `${dropsToXrp(drops)} XRP${fiat ? ` (about ${formatFiat(fiat)})` : ''}`
}
