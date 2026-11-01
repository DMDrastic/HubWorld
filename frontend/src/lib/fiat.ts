/**
 * Formatting the display estimate. FORMATTING ONLY: no conversion happens in the browser. The server sends the
 * estimate in minor units (cents) beside the XRP amount; this turns "3500" into "US$35.00".
 */
import type { Fiat } from '@/lib/api'

const SYMBOL: Record<Fiat['currency'], string> = { USD: 'US$', XCD: 'EC$' }

export function formatFiat(f: Fiat): string {
  const m = f.minor.padStart(3, '0')
  const whole = m.slice(0, -2).replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${SYMBOL[f.currency]}${whole}.${m.slice(-2)}`
}

/** What a fan sees when there is no fresh price for an XRP-priced event: never XRP, never an old dollar figure. */
export const PRICE_UNAVAILABLE = 'Price unavailable right now'
