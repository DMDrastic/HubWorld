/**
 * Moving box-office prices from XRP to US$, once, at a recorded rate (item 1b-i). Used by `scripts/price-in-usd.ts`.
 *
 * Dry run unless `apply`. Applying sets the US$ price (the canonical one from then on), keeps the XRP price as history,
 * and writes a PriceConversion row with the rate and the time it was read, in the same transaction as the change. Events
 * already in US$, or with no price, are left alone, so running it again does nothing. A price that would round to
 * US$0.00 is skipped and reported rather than turned into a free event.
 */
import { prisma } from './prisma.js'
import { NETWORK } from './network.js'

export type Conversion = { eventId: string; slug: string; fromDrops: bigint; toCents: bigint; applied: boolean; skipped?: string }

/** Drops to US cents at a rate, to the NEAREST cent (half up): this re-states a price, it does not charge anyone. */
export function dropsToUsdCents(drops: bigint, microUsdPerXrp: bigint): bigint {
  return (drops * microUsdPerXrp + 5_000_000_000n) / 10_000_000_000n
}

export async function convertEventPricesToUsd(input: { apply: boolean; rate: { microUsdPerXrp: bigint; at: Date } }): Promise<Conversion[]> {
  const events = await prisma.event.findMany({
    where: { network: NETWORK, primaryPriceDrops: { not: null }, primaryPriceCurrency: null },
    select: { id: true, slug: true, primaryPriceDrops: true },
    orderBy: { createdAt: 'asc' },
  })
  const out: Conversion[] = []
  for (const e of events) {
    const fromDrops = e.primaryPriceDrops!
    const toCents = dropsToUsdCents(fromDrops, input.rate.microUsdPerXrp)
    if (toCents <= 0n) {
      out.push({ eventId: e.id, slug: e.slug, fromDrops, toCents, applied: false, skipped: 'rounds to US$0.00' })
      continue
    }
    if (input.apply) {
      const changed = await prisma.$transaction(async (tx) => {
        // Conditional, so two runs at once cannot both convert the same event; the log is written only by the one that did.
        const { count } = await tx.event.updateMany({
          where: { id: e.id, primaryPriceCurrency: null },
          data: { primaryPriceMinor: toCents, primaryPriceCurrency: 'USD' },
        })
        if (count === 0) return false
        await tx.priceConversion.create({
          data: {
            subject: 'Event.primaryPrice',
            subjectId: e.id,
            fromCurrency: 'XRP',
            fromMinor: fromDrops,
            toCurrency: 'USD',
            toMinor: toCents,
            microUsdPerXrp: input.rate.microUsdPerXrp,
            rateAt: input.rate.at,
          },
        })
        return true
      })
      if (!changed) continue
    }
    out.push({ eventId: e.id, slug: e.slug, fromDrops, toCents, applied: input.apply })
  }
  return out
}
