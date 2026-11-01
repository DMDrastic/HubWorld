/**
 * An event's box-office price, whichever currency it is stored in.
 *
 * US$ is the canonical price since 2026-11-01 (`primaryPriceMinor` + `primaryPriceCurrency`). Events not yet converted
 * still carry XRP (`primaryPriceDrops`) and sell exactly as before. One reader, so the checkout and the event pages
 * cannot disagree about which price an event has.
 */
import type { Region } from './fees.js'
import { firstSaleFeeBps } from './listing-terms.js'

export type BoxOfficePrice = { currency: 'USD'; minor: bigint } | { currency: 'XRP'; drops: bigint }

export function boxOfficePrice(e: {
  primaryPriceMinor: bigint | null
  primaryPriceCurrency: 'USD' | 'XRP' | 'RLUSD' | null
  primaryPriceDrops: bigint | null
}): BoxOfficePrice | null {
  if (e.primaryPriceMinor !== null && e.primaryPriceCurrency === 'USD') {
    return e.primaryPriceMinor > 0n ? { currency: 'USD', minor: e.primaryPriceMinor } : null
  }
  if (e.primaryPriceDrops !== null && e.primaryPriceDrops > 0n) return { currency: 'XRP', drops: e.primaryPriceDrops }
  return null
}

/**
 * What the event pages show for a US$ price: the price, the fee on it and the all-in, in US cents, and whether XRP can
 * be paid right now. The fee is the XRP rail's (the only way to pay until card checkout), at the same rate the checkout
 * charges on the quoted XRP, floored like every fee.
 */
export function boxOfficeView(
  price: { currency: 'USD'; minor: bigint },
  event: { startsAt: Date; timeZone: string; feeRegion: Region; platformBps: number },
  organizerFounding: boolean,
  xrpPayable: boolean,
) {
  const feeMinor = (price.minor * BigInt(firstSaleFeeBps({ event, organizerFounding }))) / 10_000n
  return {
    currency: 'USD' as const,
    priceMinor: price.minor.toString(),
    feeMinor: feeMinor.toString(),
    allInMinor: (price.minor + feeMinor).toString(),
    xrpPayable,
  }
}
