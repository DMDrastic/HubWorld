/**
 * Fetching, storing and reading the XRP price. The rules live in `xrp-price.ts`; this is the part that touches the world.
 *
 * Every source is a public HTTP endpoint and is treated as untrusted: a fixed URL that is never redirected, a short
 * timeout, a size limit, strict parsing, and any failure means "this source said nothing", never "the price is zero".
 */
import { prisma } from './prisma.js'
import { env, priceFeedOn } from './env.js'
import { withLock } from './job-lock.js'
import {
  MAX_AGE_MS,
  REFRESH_MS,
  combineReadings,
  describePrice,
  parseBitstamp,
  parseCoinbase,
  parseKraken,
  resolveXrpUsd,
  type PriceChoice,
  type PriceDescription,
  type SourceReading,
} from './xrp-price.js'

export type Fetcher = { name: string; fetch: () => Promise<bigint | null> }

/** Readings older than this are deleted (the newest is always kept). */
export const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000

/** A move bigger than this since the last reading is logged. Still stored: the market can move. */
const JUMP_WARN_BPS = 2_500n

const SOURCE_TIMEOUT_MS = 5_000
const MAX_BODY_BYTES = 64 * 1024

/** Read a response body, giving up (null) if it is larger than `MAX_BODY_BYTES`, whatever it says about itself. */
async function readLimited(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null
  if (!res.body) return null
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** One source: the price it reports, or null for anything short of a clean, parseable answer. */
export async function fetchSource(
  url: string,
  parse: (body: unknown) => bigint | null,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<bigint | null> {
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const res = await doFetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? SOURCE_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const text = await readLimited(res)
    if (text === null) return null
    return parse(JSON.parse(text))
  } catch {
    return null
  }
}

export function defaultFetchers(): Fetcher[] {
  return [
    { name: 'kraken', fetch: () => fetchSource('https://api.kraken.com/0/public/Ticker?pair=XRPUSD', parseKraken) },
    { name: 'coinbase', fetch: () => fetchSource('https://api.coinbase.com/v2/prices/XRP-USD/spot', parseCoinbase) },
    { name: 'bitstamp', fetch: () => fetchSource('https://www.bitstamp.net/api/v2/ticker/xrpusd/', parseBitstamp) },
  ]
}

export type RefreshResult =
  | { ok: true; micro: bigint; used: string[]; dropped: string[]; failed: string[] }
  | { ok: false; reason: string; skipped?: true }

/** The newest stored reading, with the time it was taken. */
export async function latestReading(): Promise<{ micro: bigint; at: Date } | null> {
  const row = await prisma.priceReading.findFirst({ where: { pair: 'XRPUSD' }, orderBy: { createdAt: 'desc' } })
  return row ? { micro: row.microUsd, at: row.createdAt } : null
}

/**
 * Ask every source at once, and store the result if enough of them agree. Stores NOTHING otherwise, so the last good
 * reading stays the latest and simply ages: it is `resolveXrpUsd` that decides when it is too old to use.
 */
export async function refreshPrice(fetchers: Fetcher[], now = new Date()): Promise<RefreshResult> {
  const results = await Promise.all(
    fetchers.map(async (f) => {
      try {
        return { name: f.name, micro: await f.fetch() }
      } catch {
        return { name: f.name, micro: null }
      }
    }),
  )
  const readings: SourceReading[] = results.filter((r) => r.micro !== null).map((r) => ({ source: r.name, micro: r.micro! }))
  const failed = results.filter((r) => r.micro === null).map((r) => r.name).sort()

  const combined = combineReadings(readings)
  if (!combined.ok) {
    console.error(`[price-feed] refused a reading: ${combined.reason}${failed.length ? ` (no answer from ${failed.join(', ')})` : ''}`)
    return { ok: false, reason: combined.reason }
  }

  const previous = await latestReading()
  if (previous) {
    const diff = combined.micro > previous.micro ? combined.micro - previous.micro : previous.micro - combined.micro
    if (diff * 10_000n > JUMP_WARN_BPS * previous.micro) {
      console.warn(`[price-feed] XRP price moved a lot since the last reading: ${previous.micro} -> ${combined.micro} (millionths of a dollar)`)
    }
  }

  await prisma.priceReading.create({
    data: {
      microUsd: combined.micro,
      createdAt: now,
      detail: {
        used: combined.used,
        dropped: combined.dropped,
        failed,
        readings: Object.fromEntries(readings.map((r) => [r.source, r.micro.toString()])),
      },
    },
  })
  // Old rows go, but only after a good one is safely stored, so an outage can never delete the last known price.
  await prisma.priceReading.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - PRUNE_AFTER_MS) } } })
  return { ok: true, micro: combined.micro, used: combined.used, dropped: combined.dropped, failed }
}

/** `refreshPrice` under a lease, so several instances do not all call the sources every hour. */
export async function refreshPriceLeased(fetchers: Fetcher[]): Promise<RefreshResult> {
  const out = await withLock('price-feed', 5 * 60_000, () => refreshPrice(fetchers))
  return out ?? { ok: false, reason: 'another instance is refreshing the price', skipped: true }
}

/** The price the floor should use right now, or why there is none. */
export async function currentXrpUsd(now = new Date()): Promise<PriceChoice> {
  return resolveXrpUsd({
    feedOn: priceFeedOn,
    reading: priceFeedOn ? await latestReading() : null,
    envCents: env.XRP_USD_CENTS,
    network: env.XRPL_NETWORK,
    now,
  })
}

/**
 * Refresh only if the newest reading is an hour old (or there is none). Called every few minutes, so a failed refresh
 * is retried at the next check rather than waited out for another hour. Null when nothing was due.
 */
export async function refreshIfDue(fetchers: Fetcher[], now = new Date()): Promise<RefreshResult | null> {
  const latest = await latestReading()
  if (latest && now.getTime() - latest.at.getTime() < REFRESH_MS) return null
  const result = await refreshPriceLeased(fetchers)
  if (!result.ok && !result.skipped && latest && now.getTime() - latest.at.getTime() > MAX_AGE_MS) {
    console.error(
      `[price-feed] the XRP price is stale (last good reading ${Math.round((now.getTime() - latest.at.getTime()) / 3_600_000)}h ago) ` +
        'and could not be refreshed: new resale listings are being refused until it is.',
    )
  }
  return result
}

/** For `/api/health`. Never throws: a database that cannot be read is reported by the rest of that endpoint. */
export async function priceHealth(now = new Date()): Promise<PriceDescription | { mode: 'feed' | 'manual' | 'none'; status: 'unknown' }> {
  try {
    return describePrice({ feedOn: priceFeedOn, reading: priceFeedOn ? await latestReading() : null, envCents: env.XRP_USD_CENTS, now })
  } catch {
    return { mode: priceFeedOn ? 'feed' : env.XRP_USD_CENTS !== undefined ? 'manual' : 'none', status: 'unknown' }
  }
}
