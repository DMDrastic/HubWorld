/**
 * The US$ (or EC$) figure shown next to an XRP price. DISPLAY ONLY.
 *
 * Settlement, caps, fees and every recorded amount stay in XRP drops exactly as before. Nothing in this file is
 * charged, capped, stored or signed, and nothing that charges, caps, stores or signs imports it. The browser does no
 * conversion: the server sends the XRP amount and this estimate side by side, and the page only formats them.
 *
 * **A price that is not fresh is not shown.** An old dollar figure looks authoritative and is wrong in exactly the
 * way nobody notices, so a stale or missing feed means XRP alone, never a remembered number. That is also why the
 * manual `XRP_USD_CENTS` fallback is never displayed: it is a number someone typed once.
 *
 * True USD pricing (USD as the price an organizer sets, RLUSD settlement, card payments) is Phase 3a; this is the
 * bridge until then and must not grow into a second pricing model (ROADMAP §5e).
 */
import { env, priceFeedOn } from './env.js'
import { latestReading } from './xrp-price-store.js'

/** The feed refreshes hourly, so two hours allows one missed refresh and no more. Tighter than the resale floor's day. */
export const DISPLAY_MAX_AGE_MS = 2 * 60 * 60 * 1000

/** EC$ is pegged to the US$ at 2.70. Fixed, never fetched. */
export const XCD_PER_USD = '2.70'
const XCD_PER_USD_HUNDREDTHS = 270n

export type FiatCurrency = 'USD' | 'XCD'
export type Fiat = { currency: FiatCurrency; minor: string }
export type DisplayRate = { microUsdPerXrp: bigint } | null

/** Which reading may be shown, if any. */
export function displayRate(input: {
  reading: { micro: bigint; at: Date } | null
  now: Date
  feedOn: boolean
}): DisplayRate {
  if (!input.feedOn || !input.reading) return null
  const age = input.now.getTime() - input.reading.at.getTime()
  // A reading from the future is a clock gone wrong, not a fresh price.
  if (age < 0 || age > DISPLAY_MAX_AGE_MS) return null
  return { microUsdPerXrp: input.reading.micro }
}

/**
 * Drops to cents (or EC cents), rounded half up from the unrounded amount.
 * drops / 1e6 = XRP; x micro / 1e6 = US$; x 100 = cents. So cents = drops * micro / 1e10.
 */
export function toFiat(drops: bigint | string | null | undefined, rate: DisplayRate, currency: FiatCurrency): Fiat | null {
  if (rate === null || drops === null || drops === undefined) return null
  const d = typeof drops === 'bigint' ? drops : BigInt(drops)
  const scaled = d * rate.microUsdPerXrp
  const minor =
    currency === 'USD'
      ? (scaled + 5_000_000_000n) / 10_000_000_000n
      : (scaled * XCD_PER_USD_HUNDREDTHS + 500_000_000_000n) / 1_000_000_000_000n
  return { currency, minor: minor.toString() }
}

/** The figures for the named amount fields of one response object, keyed by field name. Nulls are left out. */
export function fiatOf<T extends Record<string, unknown>>(
  row: T,
  keys: readonly (keyof T & string)[],
  rate: DisplayRate,
  currency: FiatCurrency,
): Partial<Record<keyof T & string, Fiat>> {
  const out: Partial<Record<keyof T & string, Fiat>> = {}
  for (const k of keys) {
    const v = row[k]
    if (typeof v !== 'bigint' && typeof v !== 'string') continue
    const f = toFiat(v, rate, currency)
    if (f) out[k] = f
  }
  return out
}

/**
 * The currency hook: EC$ for St. Lucia events, only when `DISPLAY_XCD=on`. Off by default, so every event shows US$
 * until it is deliberately turned on.
 */
export function displayCurrency(event: { timeZone: string }, opts: { xcdOn: boolean } = { xcdOn: env.DISPLAY_XCD === 'on' }): FiatCurrency {
  return opts.xcdOn && event.timeZone === 'America/St_Lucia' ? 'XCD' : 'USD'
}

/** The rate for this request: one database read. */
export async function currentDisplayRate(now = new Date()): Promise<DisplayRate> {
  if (!priceFeedOn) return null
  return displayRate({ reading: await latestReading(), now, feedOn: true })
}
