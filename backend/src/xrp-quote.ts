/**
 * The XRP someone pays for a US$ price (item 1b-i). MONEY: every rule here is mutation-checked.
 *
 * US$ is the canonical price an organizer sets. XRP exists only at the moment of paying: it is worked out from a FRESH
 * price, rounded up to the next drop so whoever is paid is never short, and held for `QUOTE_LOCK_MS`, after which the
 * payment must be quoted again. With no fresh price there is no XRP payment at all (card and RLUSD are unaffected).
 *
 * Deliberately separate from `fiat-display.ts` (display only). The two read the same stored price feed; only this one
 * decides an amount that is signed.
 */
import { priceFeedOn } from './env.js'
import { latestReading } from './xrp-price-store.js'

/** The feed refreshes hourly, so two hours allows one missed refresh and no more. */
export const QUOTE_MAX_AGE_MS = 2 * 60 * 60 * 1000

/** How long a quoted XRP amount stands. The checkout's hold and the signing request end with it. */
export const QUOTE_LOCK_MS = 2 * 60 * 1000

export type QuoteRate = { microUsdPerXrp: bigint; at: Date }

/** The rate a payment may be priced at, or null: no reading, the feed off, too old, or from the future. */
export function quoteRate(input: { reading: { micro: bigint; at: Date } | null; now: Date; feedOn: boolean }): QuoteRate | null {
  if (!input.feedOn || !input.reading) return null
  const age = input.now.getTime() - input.reading.at.getTime()
  if (age < 0 || age > QUOTE_MAX_AGE_MS) return null
  return { microUsdPerXrp: input.reading.micro, at: input.reading.at }
}

/**
 * US cents to drops, rounded UP. cents / 100 = US$; / (micro / 1e6) = XRP; x 1e6 = drops. So drops = cents * 1e10 / micro.
 */
export function usdMinorToDrops(cents: bigint, rate: { microUsdPerXrp: bigint }): bigint {
  if (cents < 0n) throw new Error('a price cannot be negative')
  if (rate.microUsdPerXrp <= 0n) throw new Error('an XRP price must be positive')
  const n = cents * 10_000_000_000n
  return (n + rate.microUsdPerXrp - 1n) / rate.microUsdPerXrp
}

/** The rate for a payment starting now: one database read. */
export async function currentQuoteRate(now = new Date()): Promise<QuoteRate | null> {
  if (!priceFeedOn) return null
  return quoteRate({ reading: await latestReading(), now, feedOn: true })
}
