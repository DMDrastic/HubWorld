/**
 * The USD figure shown next to an XRP price. DISPLAY ONLY: nothing here is charged, capped, recorded or signed.
 * Written before the code.
 *
 * The rule that matters most: a price that is not fresh is not shown at all. An old dollar figure looks authoritative
 * and is wrong in exactly the way nobody notices, so a stale or missing feed means XRP alone, never a remembered number.
 */
import { describe, expect, it } from 'vitest'
import { DISPLAY_MAX_AGE_MS, XCD_PER_USD, displayCurrency, displayRate, fiatOf, toFiat } from '../src/fiat-display.js'

const NOW = new Date('2026-11-14T18:00:00Z')
const fresh = { micro: 1_250_000n, at: new Date(NOW.getTime() - 60_000) } // US$1.25 per XRP, a minute old

describe('which rate may be shown', () => {
  it('a fresh feed reading is shown', () => {
    expect(displayRate({ reading: fresh, now: NOW, feedOn: true })).toEqual({ microUsdPerXrp: 1_250_000n })
  })

  it('a reading older than the display limit is NOT shown (no remembered number)', () => {
    const old = { ...fresh, at: new Date(NOW.getTime() - DISPLAY_MAX_AGE_MS - 1) }
    expect(displayRate({ reading: old, now: NOW, feedOn: true })).toBeNull()
    const edge = { ...fresh, at: new Date(NOW.getTime() - DISPLAY_MAX_AGE_MS) }
    expect(displayRate({ reading: edge, now: NOW, feedOn: true })).not.toBeNull()
  })

  it('the display limit is tighter than the resale floor\'s day: two hours, against an hourly refresh', () => {
    expect(DISPLAY_MAX_AGE_MS).toBe(2 * 60 * 60 * 1000)
  })

  it('no reading, or the feed switched off, shows nothing (the manual XRP_USD_CENTS number is never displayed)', () => {
    expect(displayRate({ reading: null, now: NOW, feedOn: true })).toBeNull()
    expect(displayRate({ reading: fresh, now: NOW, feedOn: false })).toBeNull()
  })

  it('a reading from the future (a clock gone wrong) is not shown', () => {
    expect(displayRate({ reading: { ...fresh, at: new Date(NOW.getTime() + 10 * 60_000) }, now: NOW, feedOn: true })).toBeNull()
  })
})

describe('converting, on the server only', () => {
  const rate = { microUsdPerXrp: 1_250_000n }

  it('28 XRP at US$1.25 is US$35.00, in cents', () => {
    expect(toFiat(28_000_000n, rate, 'USD')).toEqual({ currency: 'USD', minor: '3500' })
  })

  it('rounds to the nearest cent, half up', () => {
    // 0.000004 XRP * 1.25 = US$0.000005: below half a cent, so 0
    expect(toFiat(4n, rate, 'USD')).toEqual({ currency: 'USD', minor: '0' })
    // 1.004 XRP * 1.25 = 1.255 -> 1.26 (half up)
    expect(toFiat(1_004_000n, rate, 'USD')).toEqual({ currency: 'USD', minor: '126' })
    // 1.0039 XRP * 1.25 = 1.254875 -> 1.25
    expect(toFiat(1_003_900n, rate, 'USD')).toEqual({ currency: 'USD', minor: '125' })
  })

  it('EC$ is fixed at 2.70 per US$, from the unrounded dollar amount', () => {
    expect(XCD_PER_USD).toBe('2.70')
    // US$35.00 -> EC$94.50
    expect(toFiat(28_000_000n, rate, 'XCD')).toEqual({ currency: 'XCD', minor: '9450' })
    // 1.003 XRP * 1.25 = US$1.25375 -> EC$3.385125 -> 3.39 (rounding the dollars first would give 3.38)
    expect(toFiat(1_003_000n, rate, 'XCD')).toEqual({ currency: 'XCD', minor: '339' })
  })

  it('no rate or no amount is no figure', () => {
    expect(toFiat(28_000_000n, null, 'USD')).toBeNull()
    expect(toFiat(null, rate, 'USD')).toBeNull()
  })

  it('accepts the drops as the API serialises them (a string)', () => {
    expect(toFiat('28000000', rate, 'USD')).toEqual({ currency: 'USD', minor: '3500' })
  })

  it('builds the per-response map from the amount fields present, skipping nulls', () => {
    const row = { priceDrops: 28_000_000n, feeDrops: null as bigint | null, other: 'x' }
    expect(fiatOf(row, ['priceDrops', 'feeDrops'], rate, 'USD')).toEqual({ priceDrops: { currency: 'USD', minor: '3500' } })
    expect(fiatOf(row, ['priceDrops'], null, 'USD')).toEqual({})
  })
})

describe('the EC$ hook is off by default', () => {
  it('a St. Lucia event shows US$ unless the hook is on', () => {
    expect(displayCurrency({ timeZone: 'America/St_Lucia' }, { xcdOn: false })).toBe('USD')
    expect(displayCurrency({ timeZone: 'America/St_Lucia' }, { xcdOn: true })).toBe('XCD')
  })

  it('with the hook on, only St. Lucia events show EC$', () => {
    expect(displayCurrency({ timeZone: 'America/Toronto' }, { xcdOn: true })).toBe('USD')
  })
})

describe('nothing that charges, caps, records or signs can see the estimate', () => {
  it('only the read and response routes import it', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []))
    const importers = walk('src')
      .filter((f) => /from '\.{1,2}\/(\.\.\/)?fiat-display\.js'/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(/\\/g, '/'))
      .sort()
    expect(importers).toEqual([
      'src/routes/auctions.ts',
      'src/routes/checkout.ts',
      'src/routes/events.ts',
      'src/routes/listings.ts',
      'src/routes/price.ts',
      'src/routes/tickets.ts',
    ])
  })
})
