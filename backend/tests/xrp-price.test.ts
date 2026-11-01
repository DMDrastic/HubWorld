/**
 * The XRP price that sets the US$5 resale floor, as pure rules. Written before the code.
 *
 * The floor is "US$5 in XRP", so it is only as good as the price behind it. A single source can be wrong, stale or
 * briefly broken, and a manually set number drifts. So: several independent public sources, a reading only counts when
 * enough of them AGREE, the middle value is used, and a reading that has gone stale is never guessed at.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_AGE_MS,
  MAX_SPREAD_BPS,
  MAX_USD_PER_XRP_MICRO,
  MIN_SOURCES,
  MIN_USD_PER_XRP_MICRO,
  combineReadings,
  describePrice,
  formatMicroUsd,
  parseBitstamp,
  parseCoinbase,
  parseKraken,
  parseUsdToMicro,
  resolveXrpUsd,
} from '../src/xrp-price.js'
import { minimumResaleMinor } from '../src/fees.js'

describe('parseUsdToMicro: a decimal string to millionths of a dollar, exactly', () => {
  it.each([
    ['1.24945', 1_249_450n],
    ['1.2', 1_200_000n],
    ['2', 2_000_000n],
    ['0.000001', 1n],
    ['10.5', 10_500_000n],
    ['1.24950000', 1_249_500n], // Kraken sends eight decimals
  ])('%s -> %s', (text, micro) => {
    expect(parseUsdToMicro(text)).toBe(micro)
  })

  it('rounds extra digits to the nearest millionth (half up)', () => {
    expect(parseUsdToMicro('1.2494516')).toBe(1_249_452n)
    expect(parseUsdToMicro('1.2494514')).toBe(1_249_451n)
    expect(parseUsdToMicro('1.0000005')).toBe(1_000_001n)
  })

  it.each(['', ' ', 'abc', '-1', '+1', '1e3', '1.2.3', ' 1.2', '1.2 ', '1,2', '.5', '5.', 'NaN', 'Infinity', '0x10', '1_000'])(
    'refuses %j (anything that is not plain digits with one optional decimal point)',
    (text) => {
      expect(parseUsdToMicro(text)).toBeNull()
    },
  )

  it('refuses zero, and anything that is not a string', () => {
    expect(parseUsdToMicro('0')).toBeNull()
    expect(parseUsdToMicro('0.0000001')).toBeNull() // rounds to nothing
    for (const v of [1.2, null, undefined, {}, [], true]) expect(parseUsdToMicro(v)).toBeNull()
  })

  it('does not lose precision on a long number (no floating point)', () => {
    expect(parseUsdToMicro('123456789.123456')).toBe(123_456_789_123_456n)
  })
})

describe('the three source parsers', () => {
  it('Kraken: the last trade price', () => {
    expect(parseKraken({ error: [], result: { XXRPZUSD: { c: ['1.24950000', '13.19'] } } })).toBe(1_249_500n)
  })
  it('Coinbase: the spot amount', () => {
    expect(parseCoinbase({ data: { amount: '1.24945', base: 'XRP', currency: 'USD' } })).toBe(1_249_450n)
  })
  it('Bitstamp: the last price', () => {
    expect(parseBitstamp({ last: '1.24964', bid: '1.2' })).toBe(1_249_640n)
  })

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['an empty object', {}],
    ['an error body', { error: ['EQuery:Unknown asset pair'] }],
  ])('every parser returns null for %s', (_n, body) => {
    expect(parseKraken(body)).toBeNull()
    expect(parseCoinbase(body)).toBeNull()
    expect(parseBitstamp(body)).toBeNull()
  })

  it('Kraken refuses a body that carries an error even if a price is also present', () => {
    expect(parseKraken({ error: ['EGeneral:Internal error'], result: { XXRPZUSD: { c: ['1.2', '1'] } } })).toBeNull()
  })

  it('Coinbase refuses the wrong pair or currency (a response for a different asset must never become the XRP price)', () => {
    expect(parseCoinbase({ data: { amount: '60000', base: 'BTC', currency: 'USD' } })).toBeNull()
    expect(parseCoinbase({ data: { amount: '1.2', base: 'XRP', currency: 'EUR' } })).toBeNull()
  })

  it('Kraken refuses a result for another pair', () => {
    expect(parseKraken({ error: [], result: { XXBTZUSD: { c: ['60000.0', '1'] } } })).toBeNull()
  })

  it('refuses a price outside what XRP could plausibly be (a decimal slip, a stablecoin pair, a broken feed)', () => {
    expect(parseCoinbase({ data: { amount: '0.001', base: 'XRP', currency: 'USD' } })).toBeNull()
    expect(parseCoinbase({ data: { amount: '5000', base: 'XRP', currency: 'USD' } })).toBeNull()
    expect(parseBitstamp({ last: '124.9' })).not.toBeNull() // $124.90 is odd but possible; bounds are wide on purpose
  })

  it('the plausible range is wide enough for a real market and narrow enough to catch a unit error', () => {
    expect(MIN_USD_PER_XRP_MICRO).toBeLessThanOrEqual(10_000n) // $0.01
    expect(MAX_USD_PER_XRP_MICRO).toBeGreaterThanOrEqual(1_000_000_000n) // $1,000
    expect(MAX_USD_PER_XRP_MICRO).toBeLessThanOrEqual(10_000_000_000n)
  })
})

describe('combineReadings: only what several sources agree on', () => {
  const r = (source: string, micro: bigint) => ({ source, micro })

  it('three agreeing sources give the middle one', () => {
    const c = combineReadings([r('kraken', 1_249_500n), r('coinbase', 1_249_450n), r('bitstamp', 1_249_640n)])
    expect(c).toMatchObject({ ok: true, micro: 1_249_500n })
    expect(c.ok && c.used.sort()).toEqual(['bitstamp', 'coinbase', 'kraken'])
  })

  it('two sources are enough (one was down), and the price is their midpoint', () => {
    const c = combineReadings([r('kraken', 1_200_000n), r('coinbase', 1_250_000n)])
    expect(c).toMatchObject({ ok: true, micro: 1_225_000n })
  })

  it('one source alone is NOT enough: there is nothing to check it against', () => {
    expect(MIN_SOURCES).toBeGreaterThanOrEqual(2)
    expect(combineReadings([r('kraken', 1_250_000n)])).toMatchObject({ ok: false })
    expect(combineReadings([])).toMatchObject({ ok: false })
  })

  it('an outlier among three is dropped and named, and the two that agree carry on', () => {
    const c = combineReadings([r('kraken', 1_250_000n), r('coinbase', 1_251_000n), r('bitstamp', 2_500_000n)])
    expect(c).toMatchObject({ ok: true, micro: 1_250_500n })
    expect(c.ok && c.dropped).toEqual(['bitstamp'])
  })

  it('two sources that disagree are not averaged into a number nobody reported', () => {
    expect(combineReadings([r('kraken', 1_000_000n), r('coinbase', 1_500_000n)])).toMatchObject({ ok: false })
  })

  it('three that all disagree are refused', () => {
    expect(combineReadings([r('a', 1_000_000n), r('b', 1_500_000n), r('c', 2_000_000n)])).toMatchObject({ ok: false })
  })

  it('agreement is judged against the median, exactly at the limit', () => {
    expect(MAX_SPREAD_BPS).toBe(500)
    // median 1_000_000; 5% either way is the edge.
    const inside = combineReadings([r('a', 1_000_000n), r('b', 1_000_000n), r('c', 1_050_000n)])
    expect(inside).toMatchObject({ ok: true, micro: 1_000_000n })
    expect(inside.ok && inside.dropped).toEqual([])
    const outside = combineReadings([r('a', 1_000_000n), r('b', 1_000_000n), r('c', 1_050_001n)])
    expect(outside.ok && outside.dropped).toEqual(['c'])
  })

  it('a reading out of the plausible range never counts, however many others agree with each other', () => {
    expect(combineReadings([r('a', 1n), r('b', 1n)])).toMatchObject({ ok: false })
    expect(combineReadings([r('a', 1_250_000n), r('b', 1n)])).toMatchObject({ ok: false }) // only one valid left
  })

  it('does not depend on the order the sources answered in', () => {
    const rs = [r('a', 1_249_500n), r('b', 1_249_450n), r('c', 1_249_640n)]
    expect(combineReadings([...rs].reverse())).toEqual(combineReadings(rs))
  })

  it('the reason is given in words when it refuses', () => {
    const c = combineReadings([r('kraken', 1_000_000n), r('coinbase', 1_500_000n)])
    expect(!c.ok && c.reason).toMatch(/agree/i)
    const d = combineReadings([r('kraken', 1_000_000n)])
    expect(!d.ok && d.reason).toMatch(/source/i)
  })
})

describe('resolveXrpUsd: which price the floor uses, or that there is none', () => {
  const NOW = new Date('2026-11-01T12:00:00Z')
  const at = (msAgo: number) => ({ micro: 1_250_000n, at: new Date(NOW.getTime() - msAgo) })
  const base = { feedOn: true, reading: at(60_000), envCents: undefined as number | undefined, network: 'testnet' as const, now: NOW }

  it('feed on, fresh reading: the reading, with its source named', () => {
    expect(resolveXrpUsd(base)).toEqual({ ok: true, micro: 1_250_000n, source: 'feed' })
  })

  it('a reading exactly at the age limit is still fresh; one millisecond past is stale', () => {
    expect(resolveXrpUsd({ ...base, reading: at(MAX_AGE_MS) })).toMatchObject({ ok: true, source: 'feed' })
    expect(resolveXrpUsd({ ...base, reading: at(MAX_AGE_MS + 1) })).toMatchObject({ ok: false })
  })

  it('the age limit is a day: long enough to ride out an outage of the sources, short enough to matter', () => {
    expect(MAX_AGE_MS).toBe(24 * 60 * 60 * 1000)
  })

  it('feed on, stale or no reading, on a TEST network: falls back to the manual number if there is one', () => {
    expect(resolveXrpUsd({ ...base, reading: null, envCents: 134 })).toEqual({ ok: true, micro: 1_340_000n, source: 'fallback' })
    expect(resolveXrpUsd({ ...base, reading: at(MAX_AGE_MS + 1), envCents: 134, network: 'devnet' })).toMatchObject({ source: 'fallback' })
  })

  it('feed on, stale or no reading, on MAINNET: no fallback. A stale price is not guessed at', () => {
    const r = resolveXrpUsd({ ...base, reading: null, envCents: 134, network: 'mainnet' })
    expect(r).toMatchObject({ ok: false })
    expect(resolveXrpUsd({ ...base, reading: at(MAX_AGE_MS + 1), envCents: 134, network: 'mainnet' })).toMatchObject({ ok: false })
  })

  it('feed on, nothing at all: unavailable, with a reason', () => {
    const r = resolveXrpUsd({ ...base, reading: null })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/price/i)
  })

  it('feed OFF: the manual number, on any network (the monthly-review option)', () => {
    for (const network of ['testnet', 'devnet', 'mainnet'] as const) {
      expect(resolveXrpUsd({ ...base, feedOn: false, reading: null, envCents: 134, network })).toEqual({ ok: true, micro: 1_340_000n, source: 'manual' })
    }
  })

  it('feed OFF ignores any reading in the table: switching the feed off means off', () => {
    expect(resolveXrpUsd({ ...base, feedOn: false, envCents: 134 })).toMatchObject({ source: 'manual', micro: 1_340_000n })
  })

  it('feed off and no manual number: unavailable', () => {
    expect(resolveXrpUsd({ ...base, feedOn: false, reading: null })).toMatchObject({ ok: false })
  })

  it('a fresh reading wins over the manual number', () => {
    expect(resolveXrpUsd({ ...base, envCents: 999 })).toMatchObject({ source: 'feed', micro: 1_250_000n })
  })
})

describe('the floor at a real price keeps its precision', () => {
  it('US$5 at $1.2495 is 4,001,601 drops, rounded UP; rounding the price to whole cents would have given a different floor', () => {
    expect(minimumResaleMinor({ currency: 'XRP', xrpUsdMicro: 1_249_500n })).toBe(4_001_601n)
    expect(minimumResaleMinor({ currency: 'XRP', xrpUsdCents: 125n })).not.toBe(4_001_601n)
  })
  it('agrees with the whole-cents path where both apply', () => {
    expect(minimumResaleMinor({ currency: 'XRP', xrpUsdMicro: 1_340_000n })).toBe(minimumResaleMinor({ currency: 'XRP', xrpUsdCents: 134n }))
    expect(minimumResaleMinor({ currency: 'XRP', xrpUsdMicro: 1_000_000n })).toBe(5_000_000n)
  })
  it('refuses a missing or zero price rather than returning a floor of nothing', () => {
    expect(() => minimumResaleMinor({ currency: 'XRP', xrpUsdMicro: 0n })).toThrow(/XRP price/)
    expect(() => minimumResaleMinor({ currency: 'XRP' })).toThrow(/XRP price/)
  })
})

describe('formatMicroUsd', () => {
  it.each([
    [1_249_500n, '1.249500'],
    [5n, '0.000005'],
    [2_000_000n, '2.000000'],
    [123_456_789_123_456n, '123456789.123456'],
  ])('%s -> %s', (micro, text) => {
    expect(formatMicroUsd(micro)).toBe(text)
  })
})

describe('describePrice: what the health endpoint says about the price', () => {
  const NOW = new Date('2026-11-01T12:00:00Z')
  const ago = (ms: number) => ({ micro: 1_250_000n, at: new Date(NOW.getTime() - ms) })

  it('feed on, fresh: the price, how old it is, and ok', () => {
    expect(describePrice({ feedOn: true, reading: ago(5 * 60_000), envCents: undefined, now: NOW })).toEqual({
      mode: 'feed', status: 'ok', usdPerXrp: '1.250000', ageMinutes: 5,
    })
  })

  it('feed on, older than a day: still reports the price and its age, but as stale', () => {
    expect(describePrice({ feedOn: true, reading: ago(MAX_AGE_MS + 60_000), envCents: undefined, now: NOW })).toMatchObject({
      mode: 'feed', status: 'stale', usdPerXrp: '1.250000',
    })
  })

  it('feed on, nothing fetched yet: unavailable, with no price invented', () => {
    const d = describePrice({ feedOn: true, reading: null, envCents: 134, now: NOW })
    expect(d).toEqual({ mode: 'feed', status: 'unavailable' })
  })

  it('feed off with a manual number: the number, as manual', () => {
    expect(describePrice({ feedOn: false, reading: null, envCents: 134, now: NOW })).toEqual({ mode: 'manual', status: 'ok', usdPerXrp: '1.340000' })
  })

  it('feed off with nothing set: none', () => {
    expect(describePrice({ feedOn: false, reading: null, envCents: undefined, now: NOW })).toEqual({ mode: 'none', status: 'unavailable' })
  })

  it('feed off ignores a stored reading', () => {
    expect(describePrice({ feedOn: false, reading: ago(1000), envCents: undefined, now: NOW })).toMatchObject({ mode: 'none' })
  })
})
