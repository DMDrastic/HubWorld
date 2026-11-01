/**
 * Fetching, storing and reading the XRP price. Written before the code.
 *
 * Real Postgres; the network is the one seam (a fetch function is passed in). Pinned: what is stored, and that a bad
 * reading stores NOTHING (so the last good one stays the latest), that one broken source does not take the others
 * down, that two instances do not both fetch, that old rows are pruned, and that a source which hangs, errors, lies
 * about its size or sends something that is not a price is treated as absent.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../src/prisma.js'
import { fetchSource, latestReading, refreshIfDue, refreshPrice, refreshPriceLeased, PRUNE_AFTER_MS, type Fetcher } from '../src/xrp-price-store.js'
import { REFRESH_MS } from '../src/xrp-price.js'

const ok = (name: string, micro: bigint): Fetcher => ({ name, fetch: async () => micro })
const none = (name: string): Fetcher => ({ name, fetch: async () => null })
const boom = (name: string): Fetcher => ({ name, fetch: async () => { throw new Error('network down') } })

beforeEach(async () => {
  await prisma.priceReading.deleteMany({})
})
afterEach(async () => {
  await prisma.priceReading.deleteMany({})
})
afterAll(async () => {
  await prisma.$disconnect()
})

describe('refreshPrice', () => {
  it('stores the middle of agreeing sources, with who said what', async () => {
    const r = await refreshPrice([ok('kraken', 1_249_500n), ok('coinbase', 1_249_450n), ok('bitstamp', 1_249_640n)])
    expect(r).toMatchObject({ ok: true, micro: 1_249_500n })
    const row = await prisma.priceReading.findFirstOrThrow()
    expect(row.microUsd).toBe(1_249_500n)
    expect(row.pair).toBe('XRPUSD')
    expect(row.detail).toMatchObject({
      used: ['bitstamp', 'coinbase', 'kraken'],
      dropped: [],
      readings: { kraken: '1249500', coinbase: '1249450', bitstamp: '1249640' },
    })
  })

  it('one source down does not stop the others', async () => {
    const r = await refreshPrice([ok('kraken', 1_250_000n), boom('coinbase'), ok('bitstamp', 1_251_000n)])
    expect(r).toMatchObject({ ok: true, micro: 1_250_500n })
    expect((await prisma.priceReading.findFirstOrThrow()).detail).toMatchObject({ failed: ['coinbase'] })
  })

  it('a source that answered with nothing usable counts as failed, not as zero', async () => {
    const r = await refreshPrice([ok('kraken', 1_250_000n), none('coinbase'), ok('bitstamp', 1_250_000n)])
    expect(r).toMatchObject({ ok: true, micro: 1_250_000n })
    expect((await prisma.priceReading.findFirstOrThrow()).detail).toMatchObject({ failed: ['coinbase'] })
  })

  it('names an outlier it dropped', async () => {
    await refreshPrice([ok('kraken', 1_250_000n), ok('coinbase', 1_251_000n), ok('bitstamp', 2_500_000n)])
    expect((await prisma.priceReading.findFirstOrThrow()).detail).toMatchObject({ dropped: ['bitstamp'] })
  })

  it('stores NOTHING when the sources disagree, and the last good reading stays the latest', async () => {
    await refreshPrice([ok('a', 1_250_000n), ok('b', 1_250_000n)])
    const r = await refreshPrice([ok('a', 1_000_000n), ok('b', 1_500_000n)])
    expect(r).toMatchObject({ ok: false })
    expect(await prisma.priceReading.count()).toBe(1)
    expect((await latestReading())?.micro).toBe(1_250_000n)
  })

  it('stores nothing when too few sources answered', async () => {
    expect(await refreshPrice([ok('a', 1_250_000n), boom('b'), none('c')])).toMatchObject({ ok: false })
    expect(await prisma.priceReading.count()).toBe(0)
  })

  it('stores nothing when there are no sources at all', async () => {
    expect(await refreshPrice([])).toMatchObject({ ok: false })
    expect(await prisma.priceReading.count()).toBe(0)
  })

  it('asks every source at once, not one after another (a slow source must not delay the rest)', async () => {
    const order: string[] = []
    const slow = (name: string, ms: number): Fetcher => ({ name, fetch: async () => { order.push(`start ${name}`); await new Promise((r) => setTimeout(r, ms)); order.push(`end ${name}`); return 1_250_000n } })
    await refreshPrice([slow('a', 60), slow('b', 20)])
    expect(order.slice(0, 2).sort()).toEqual(['start a', 'start b'])
    expect(order.indexOf('end b')).toBeLessThan(order.indexOf('end a'))
  })

  it('warns about a very large move from the last reading, but still stores it (the market can move)', async () => {
    await refreshPrice([ok('a', 1_000_000n), ok('b', 1_000_000n)])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await refreshPrice([ok('a', 1_500_000n), ok('b', 1_500_000n)])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/moved|jump|change/i)
    expect(await prisma.priceReading.count()).toBe(2)
    warn.mockClear()
    await refreshPrice([ok('a', 1_520_000n), ok('b', 1_520_000n)]) // a small move is not news
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('removes readings older than the retention period, and keeps the recent ones', async () => {
    const old = await prisma.priceReading.create({ data: { microUsd: 1_000_000n, detail: {}, createdAt: new Date(Date.now() - PRUNE_AFTER_MS - 60_000) } })
    const recent = await prisma.priceReading.create({ data: { microUsd: 1_100_000n, detail: {}, createdAt: new Date(Date.now() - PRUNE_AFTER_MS + 3_600_000) } })
    await refreshPrice([ok('a', 1_250_000n), ok('b', 1_250_000n)])
    const ids = (await prisma.priceReading.findMany()).map((r) => r.id)
    expect(ids).not.toContain(old.id)
    expect(ids).toContain(recent.id)
  })

  it('never prunes the newest reading, even if it is itself old (an outage must not delete the last known price)', async () => {
    const only = await prisma.priceReading.create({ data: { microUsd: 1_000_000n, detail: {}, createdAt: new Date(Date.now() - PRUNE_AFTER_MS * 2) } })
    await refreshPrice([ok('a', 1_000_000n)]) // too few: fails, but pruning must not run away
    expect((await prisma.priceReading.findUnique({ where: { id: only.id } }))?.id).toBe(only.id)
  })
})

describe('latestReading', () => {
  it('is the newest, with its time', async () => {
    const t1 = new Date(Date.now() - 7_200_000)
    const t2 = new Date(Date.now() - 3_600_000)
    await prisma.priceReading.create({ data: { microUsd: 1_000_000n, detail: {}, createdAt: t1 } })
    await prisma.priceReading.create({ data: { microUsd: 1_100_000n, detail: {}, createdAt: t2 } })
    expect(await latestReading()).toEqual({ micro: 1_100_000n, at: t2 })
  })
  it('is null when there is none', async () => {
    expect(await latestReading()).toBeNull()
  })
})

describe('refreshPriceLeased: two instances do not both fetch', () => {
  it('a second refresh while the first is running skips, and the sources are asked once', async () => {
    let calls = 0
    const slow: Fetcher = { name: 'a', fetch: async () => { calls++; await new Promise((r) => setTimeout(r, 80)); return 1_250_000n } }
    const slow2: Fetcher = { name: 'b', fetch: async () => { await new Promise((r) => setTimeout(r, 80)); return 1_250_000n } }
    const [x, y] = await Promise.all([refreshPriceLeased([slow, slow2]), refreshPriceLeased([slow, slow2])])
    expect(calls).toBe(1)
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1)
    expect([x, y].some((r) => !r.ok && 'skipped' in r && r.skipped)).toBe(true)
    expect(await prisma.priceReading.count()).toBe(1)
  })
})

describe('fetchSource: one public source, treated as untrusted', () => {
  const parse = (b: unknown) => ((b as { p?: string })?.p === '1.25' ? 1_250_000n : null)
  const respond = (body: string, init: { status?: number; headers?: Record<string, string> } = {}) =>
    vi.fn(async () => new Response(body, { status: init.status ?? 200, headers: init.headers }))

  it('returns the parsed price from a good response', async () => {
    const f = respond(JSON.stringify({ p: '1.25' }))
    expect(await fetchSource('https://example.test/p', parse, { fetchImpl: f as never, timeoutMs: 500 })).toBe(1_250_000n)
  })

  it('does not follow redirects (a fixed URL stays a fixed URL) and has a timeout signal', async () => {
    const f = respond(JSON.stringify({ p: '1.25' }))
    await fetchSource('https://example.test/p', parse, { fetchImpl: f as never, timeoutMs: 500 })
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([
    ['an HTTP error', () => respond('{"p":"1.25"}', { status: 503 })],
    ['a rate limit', () => respond('{"p":"1.25"}', { status: 429 })],
    ['something that is not JSON', () => respond('<html>captcha</html>')],
    ['JSON that is not a price', () => respond(JSON.stringify({ p: 'abc' }))],
    ['a body that claims to be enormous', () => respond('{"p":"1.25"}', { headers: { 'content-length': '99999999' } })],
    ['a body that is enormous without saying so', () => respond(JSON.stringify({ p: '1.25', pad: 'x'.repeat(200_000) }))],
  ])('is null for %s', async (_n, make) => {
    expect(await fetchSource('https://example.test/p', parse, { fetchImpl: make() as never, timeoutMs: 500 })).toBeNull()
  })

  it('is null when the request throws', async () => {
    const f = vi.fn(async () => { throw new Error('ECONNRESET') })
    expect(await fetchSource('https://example.test/p', parse, { fetchImpl: f as never, timeoutMs: 500 })).toBeNull()
  })

  it('gives up on a source that never answers, within the timeout', async () => {
    const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted')))))
    const t0 = Date.now()
    expect(await fetchSource('https://example.test/p', parse, { fetchImpl: hang as never, timeoutMs: 60 })).toBeNull()
    expect(Date.now() - t0).toBeLessThan(1_000)
  })
})

describe('refreshIfDue: the hourly refresh, checked every few minutes', () => {
  const counting = () => {
    let calls = 0
    const f = (name: string): Fetcher => ({ name, fetch: async () => { calls++; return 1_250_000n } })
    return { fetchers: [f('a'), f('b')], calls: () => calls }
  }

  it('fetches when there is no reading at all', async () => {
    const c = counting()
    expect(await refreshIfDue(c.fetchers)).toMatchObject({ ok: true })
    expect(c.calls()).toBe(2)
  })

  it('does NOT fetch when the newest reading is recent', async () => {
    await prisma.priceReading.create({ data: { microUsd: 1_200_000n, detail: {}, createdAt: new Date(Date.now() - 10 * 60_000) } })
    const c = counting()
    expect(await refreshIfDue(c.fetchers)).toBeNull()
    expect(c.calls()).toBe(0)
  })

  it('fetches once the newest reading is an hour old', async () => {
    await prisma.priceReading.create({ data: { microUsd: 1_200_000n, detail: {}, createdAt: new Date(Date.now() - REFRESH_MS - 1000) } })
    const c = counting()
    expect(await refreshIfDue(c.fetchers)).toMatchObject({ ok: true })
    expect(c.calls()).toBe(2)
    expect((await latestReading())?.micro).toBe(1_250_000n)
  })

  it('a failed refresh leaves it due, so the very next check tries again (no waiting out another hour)', async () => {
    await prisma.priceReading.create({ data: { microUsd: 1_200_000n, detail: {}, createdAt: new Date(Date.now() - REFRESH_MS - 1000) } })
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await refreshIfDue([boom('a'), boom('b')])).toMatchObject({ ok: false })
    const c = counting()
    expect(await refreshIfDue(c.fetchers)).toMatchObject({ ok: true })
    err.mockRestore()
  })

  it('shouts when the price has gone stale and still cannot be refreshed', async () => {
    await prisma.priceReading.create({ data: { microUsd: 1_200_000n, detail: {}, createdAt: new Date(Date.now() - 25 * 3_600_000) } })
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await refreshIfDue([boom('a'), boom('b')])
    expect(err.mock.calls.map((c) => String(c[0])).some((m) => /stale|out of date/i.test(m))).toBe(true)
    err.mockRestore()
  })
})
