/**
 * The facts a marketplace card shows, derived from data we already hold.
 *
 * Nothing here is invented: a card says what the ask is, what the event's own box-office
 * price was, and how the two compare. All money is BigInt drops, and the comparison is done
 * in BigInt too, because a float percentage of a price is a number nobody can reproduce.
 */
import type { EventSummary, Listing } from '@/lib/api'

export type FaceDelta = { label: string; direction: 'over' | 'under' | 'at' }

/**
 * How an asking price compares with the face value, in words. Null when the event has no
 * box-office price (`primaryPriceDrops` is optional: some events were never sold at the door),
 * because "compared with nothing" is not a fact worth printing.
 *
 * Percentages truncate toward zero. A card must never claim a discount it is not quite
 * giving, so 12.9% under reads "12% under".
 */
export function faceDelta(priceDrops: string, faceDrops: string | null | undefined): FaceDelta | null {
  if (!faceDrops) return null
  const face = BigInt(faceDrops)
  if (face <= 0n) return null
  const price = BigInt(priceDrops)
  const diff = price - face
  if (diff === 0n) return { label: 'At face value', direction: 'at' }
  const pct = (diff < 0n ? -diff : diff) * 100n / face
  if (diff > 0n) {
    return { label: pct === 0n ? 'Just over face value' : `${pct}% over face value`, direction: 'over' }
  }
  return { label: pct === 0n ? 'Just under face value' : `${pct}% under face value`, direction: 'under' }
}

export type SortKey = 'soonest' | 'price'

const startsAt = (l: Listing, events: ReadonlyMap<string, EventSummary>) => {
  const e = events.get(l.ticket.event.slug)
  // An event we cannot place in time sorts last rather than first.
  return e ? new Date(e.startsAt).getTime() : Number.POSITIVE_INFINITY
}

const byBuyerPays = (a: Listing, b: Listing) => {
  const x = BigInt(a.buyerPaysDrops)
  const y = BigInt(b.buyerPaysDrops)
  return x < y ? -1 : x > y ? 1 : 0
}

/** A new array: sorting the state in place would reorder the page on every render. */
export function sortListings(
  listings: readonly Listing[],
  events: ReadonlyMap<string, EventSummary>,
  key: SortKey,
): Listing[] {
  return [...listings].sort((a, b) =>
    key === 'price'
      ? byBuyerPays(a, b)
      : startsAt(a, events) - startsAt(b, events) || byBuyerPays(a, b),
  )
}

/** The lowest total a buyer would pay across the listings, or null when there are none. */
export function cheapest(listings: readonly Listing[]): string | null {
  if (listings.length === 0) return null
  return listings.reduce((lo, l) => (BigInt(l.buyerPaysDrops) < BigInt(lo) ? l.buyerPaysDrops : lo), listings[0]!.buyerPaysDrops)
}
