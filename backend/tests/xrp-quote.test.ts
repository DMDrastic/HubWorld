/**
 * Turning a US$ price into the XRP someone pays. MONEY, so written first and mutation-checked.
 *
 * US$ is the canonical price (item 1b-i). XRP exists only at the moment of paying: worked out from a FRESH price, rounded
 * so the seller is never short, and held for a short window, after which it must be worked out again.
 */
import { describe, expect, it } from 'vitest'
import { QUOTE_LOCK_MS, QUOTE_MAX_AGE_MS, quoteRate, usdMinorToDrops } from '../src/xrp-quote.js'

const NOW = new Date('2026-11-14T18:00:00Z')
const fresh = { micro: 1_250_000n, at: new Date(NOW.getTime() - 60_000) } // US$1.25 per XRP

describe('which rate may price a payment', () => {
  it('a fresh feed reading', () => {
    expect(quoteRate({ reading: fresh, now: NOW, feedOn: true })).toEqual({ microUsdPerXrp: 1_250_000n, at: fresh.at })
  })

  it('nothing older than two hours (the feed refreshes hourly: one missed refresh, no more)', () => {
    expect(QUOTE_MAX_AGE_MS).toBe(2 * 60 * 60 * 1000)
    expect(quoteRate({ reading: { ...fresh, at: new Date(NOW.getTime() - QUOTE_MAX_AGE_MS) }, now: NOW, feedOn: true })).not.toBeNull()
    expect(quoteRate({ reading: { ...fresh, at: new Date(NOW.getTime() - QUOTE_MAX_AGE_MS - 1) }, now: NOW, feedOn: true })).toBeNull()
  })

  it('no reading, the feed off, or a reading from the future: no rate, so no XRP payment', () => {
    expect(quoteRate({ reading: null, now: NOW, feedOn: true })).toBeNull()
    expect(quoteRate({ reading: fresh, now: NOW, feedOn: false })).toBeNull()
    expect(quoteRate({ reading: { ...fresh, at: new Date(NOW.getTime() + 60_000) }, now: NOW, feedOn: true })).toBeNull()
  })

  it('a quote is held for two minutes', () => {
    expect(QUOTE_LOCK_MS).toBe(2 * 60 * 1000)
  })
})

describe('US cents to drops', () => {
  const rate = { microUsdPerXrp: 1_250_000n }

  it('US$35.00 at US$1.25 is exactly 28 XRP', () => {
    expect(usdMinorToDrops(3500n, rate)).toBe(28_000_000n)
  })

  it('rounds UP to the next drop, so the amount paid is never worth less than the price', () => {
    // US$0.01 at 1.25 = 0.008 XRP exactly; at 1.30 it is 0.0076923... XRP -> 7693 drops, not 7692
    expect(usdMinorToDrops(1n, rate)).toBe(8_000n)
    expect(usdMinorToDrops(1n, { microUsdPerXrp: 1_300_000n })).toBe(7_693n)
    // and is never more than one drop over
    const d = usdMinorToDrops(1999n, { microUsdPerXrp: 1_234_567n })
    expect(d * 1_234_567n >= 1999n * 10_000_000_000n).toBe(true)
    expect((d - 1n) * 1_234_567n < 1999n * 10_000_000_000n).toBe(true)
  })

  it('the same US$ price is more XRP when XRP is cheaper, less when it is dearer', () => {
    expect(usdMinorToDrops(3500n, { microUsdPerXrp: 700_000n })).toBe(50_000_000n)
    expect(usdMinorToDrops(3500n, { microUsdPerXrp: 3_500_000n })).toBe(10_000_000n)
  })

  it('zero is zero, and a negative price or a non-positive rate is refused', () => {
    expect(usdMinorToDrops(0n, rate)).toBe(0n)
    expect(() => usdMinorToDrops(-1n, rate)).toThrow()
    expect(() => usdMinorToDrops(100n, { microUsdPerXrp: 0n })).toThrow()
  })
})
