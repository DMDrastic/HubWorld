/**
 * The XRP price behind the US$5 resale floor.
 *
 * The floor is "US$5 in XRP", so it is only as good as the price. A number set by hand drifts, a single source can be wrong
 * or briefly broken, and a stale price is worse than none, because it looks authoritative. So:
 *
 *   - several independent public sources are asked (`fetchers`, below);
 *   - a reading counts only when at least two AGREE within `MAX_SPREAD_BPS` of the middle value, and the outliers are
 *     named and dropped rather than averaged into a number nobody reported;
 *   - the result is stored, and a stored reading older than `MAX_AGE_MS` is never used: new resale listings are refused
 *     until a fresh one arrives, instead of pricing against a number nobody has checked for days.
 *
 * Money in this file is millionths of a US dollar per XRP, as BigInt, parsed from the source's own decimal text with no
 * floating point anywhere.
 *
 * This file holds the rules (pure, pinned by `xrp-price.test.ts`). The fetching and storing sit below them.
 */

/** A reading must be backed by at least this many sources that agree. One alone has nothing to be checked against. */
export const MIN_SOURCES = 2

/** How far a source may sit from the middle value and still count as agreeing, in basis points (5%). */
export const MAX_SPREAD_BPS = 500

/** A stored reading older than this is not used. A day: it rides out a source outage, but not a market move. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000

/** How often the price is refreshed. */
export const REFRESH_MS = 60 * 60 * 1000

/** What XRP could plausibly cost. Wide enough for a real market, narrow enough to catch a unit error or a wrong pair. */
export const MIN_USD_PER_XRP_MICRO = 10_000n // US$0.01
export const MAX_USD_PER_XRP_MICRO = 1_000_000_000n // US$1,000

/**
 * A plain decimal string ("1.24945") as millionths of a dollar, exactly. Extra digits round half up. Null for anything
 * that is not digits with at most one decimal point between them, and for a value that rounds to nothing.
 */
export function parseUsdToMicro(text: unknown): bigint | null {
  if (typeof text !== 'string') return null
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text)
  if (!m) return null
  const whole = BigInt(m[1]!)
  const frac = m[2] ?? ''
  let micro = whole * 1_000_000n + BigInt(frac.slice(0, 6).padEnd(6, '0'))
  if (frac.length > 6 && frac.charCodeAt(6) >= 53 /* '5' */) micro += 1n
  return micro > 0n ? micro : null
}

const plausible = (micro: bigint | null): bigint | null =>
  micro !== null && micro >= MIN_USD_PER_XRP_MICRO && micro <= MAX_USD_PER_XRP_MICRO ? micro : null

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

/** Kraken `Ticker?pair=XRPUSD`: the last trade, `result.XXRPZUSD.c[0]`. A body that carries an error is refused whole. */
export function parseKraken(body: unknown): bigint | null {
  const b = obj(body)
  if (!b) return null
  if (Array.isArray(b.error) && b.error.length > 0) return null
  const pair = obj(obj(b.result)?.XXRPZUSD)
  const c = pair?.c
  return plausible(Array.isArray(c) ? parseUsdToMicro(c[0]) : null)
}

/** Coinbase `prices/XRP-USD/spot`: `data.amount`, and only if it says it is XRP in USD. */
export function parseCoinbase(body: unknown): bigint | null {
  const d = obj(obj(body)?.data)
  if (!d || d.base !== 'XRP' || d.currency !== 'USD') return null
  return plausible(parseUsdToMicro(d.amount))
}

/** Bitstamp `ticker/xrpusd`: `last`. */
export function parseBitstamp(body: unknown): bigint | null {
  return plausible(parseUsdToMicro(obj(body)?.last))
}

export type SourceReading = { source: string; micro: bigint }

export type Combined =
  | { ok: true; micro: bigint; used: string[]; dropped: string[] }
  | { ok: false; reason: string }

const median = (sorted: bigint[]): bigint => {
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2n
}

/**
 * One price from several sources, or a refusal.
 *
 * Out-of-range readings never count. The middle value of what is left is the reference; a source further from it than
 * `MAX_SPREAD_BPS` is dropped and named. If fewer than `MIN_SOURCES` remain the whole reading is refused: two sources that
 * disagree are not averaged into a number neither reported. The price is the middle of the sources that agreed.
 */
export function combineReadings(readings: SourceReading[]): Combined {
  const valid = readings.filter((r) => plausible(r.micro) !== null)
  if (valid.length < MIN_SOURCES) {
    return { ok: false, reason: `only ${valid.length} usable price source(s); at least ${MIN_SOURCES} are needed` }
  }
  const ref = median(valid.map((r) => r.micro).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
  const near = (m: bigint) => {
    const diff = m > ref ? m - ref : ref - m
    return diff * 10_000n <= BigInt(MAX_SPREAD_BPS) * ref
  }
  const kept = valid.filter((r) => near(r.micro))
  if (kept.length < MIN_SOURCES) {
    return { ok: false, reason: `the price sources do not agree (fewer than ${MIN_SOURCES} within ${MAX_SPREAD_BPS / 100}% of each other)` }
  }
  const keptNames = new Set(kept.map((r) => r.source))
  return {
    ok: true,
    micro: median(kept.map((r) => r.micro).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))),
    used: kept.map((r) => r.source).sort(),
    dropped: readings.filter((r) => !keptNames.has(r.source)).map((r) => r.source).sort(),
  }
}

export type PriceChoice =
  | { ok: true; micro: bigint; source: 'feed' | 'fallback' | 'manual' }
  | { ok: false; reason: string }

/**
 * Which price the floor uses right now, or that there is none.
 *
 * Feed off: the manual number, anywhere (the "review it monthly" option). Feed on: a fresh stored reading; failing that,
 * the manual number as a fallback on a TEST network only. On mainnet a stale reading is never papered over with a number
 * somebody typed once: the answer is "unavailable", and new resale listings wait.
 */
export function resolveXrpUsd(input: {
  feedOn: boolean
  reading: { micro: bigint; at: Date } | null
  envCents: number | undefined
  network: 'testnet' | 'devnet' | 'mainnet'
  now: Date
}): PriceChoice {
  const manual = input.envCents !== undefined ? BigInt(input.envCents) * 10_000n : null
  if (!input.feedOn) {
    return manual !== null ? { ok: true, micro: manual, source: 'manual' } : { ok: false, reason: 'no XRP price is configured' }
  }
  const age = input.reading ? input.now.getTime() - input.reading.at.getTime() : null
  if (input.reading && age !== null && age <= MAX_AGE_MS) return { ok: true, micro: input.reading.micro, source: 'feed' }
  if (manual !== null && input.network !== 'mainnet') return { ok: true, micro: manual, source: 'fallback' }
  return {
    ok: false,
    reason: input.reading ? 'the XRP price is out of date and could not be refreshed' : 'no XRP price has been fetched yet',
  }
}

/** Millionths of a dollar as a plain decimal string with six places ("1.249500"). */
export function formatMicroUsd(micro: bigint): string {
  return `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, '0')}`
}

export type PriceDescription =
  | { mode: 'feed'; status: 'ok' | 'stale'; usdPerXrp: string; ageMinutes: number }
  | { mode: 'feed'; status: 'unavailable' }
  | { mode: 'manual'; status: 'ok'; usdPerXrp: string }
  | { mode: 'none'; status: 'unavailable' }

/** What `/api/health` says about the price, so a stale one is visible from outside before it blocks anyone. */
export function describePrice(input: {
  feedOn: boolean
  reading: { micro: bigint; at: Date } | null
  envCents: number | undefined
  now: Date
}): PriceDescription {
  if (input.feedOn) {
    if (!input.reading) return { mode: 'feed', status: 'unavailable' }
    const age = input.now.getTime() - input.reading.at.getTime()
    return {
      mode: 'feed',
      status: age <= MAX_AGE_MS ? 'ok' : 'stale',
      usdPerXrp: formatMicroUsd(input.reading.micro),
      ageMinutes: Math.floor(age / 60_000),
    }
  }
  if (input.envCents !== undefined) {
    return { mode: 'manual', status: 'ok', usdPerXrp: formatMicroUsd(BigInt(input.envCents) * 10_000n) }
  }
  return { mode: 'none', status: 'unavailable' }
}
