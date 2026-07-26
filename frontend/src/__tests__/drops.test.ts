/**
 * Drops <-> XRP conversion.
 *
 * These are display and input helpers only, but a bug here mis-prices a real
 * listing: `xrpToDrops` feeds the amount the seller signs and the buyer pays.
 * 1 XRP = 1_000_000 drops, and drops are indivisible.
 */
import { describe, expect, it } from 'vitest'
import { dropsToXrp, xrpToDrops } from '@/lib/api'

describe('dropsToXrp', () => {
  it('converts whole XRP without a decimal point', () => {
    expect(dropsToXrp('1000000')).toBe('1')
    expect(dropsToXrp('100000000')).toBe('100')
    expect(dropsToXrp('0')).toBe('0')
  })

  it('trims trailing zeros in the fraction', () => {
    expect(dropsToXrp('1500000')).toBe('1.5')
    expect(dropsToXrp('2500000')).toBe('2.5')
    expect(dropsToXrp('1100000')).toBe('1.1')
  })

  it('keeps sub-drop precision down to a single drop', () => {
    expect(dropsToXrp('1')).toBe('0.000001')
    expect(dropsToXrp('10')).toBe('0.00001')
    expect(dropsToXrp('1000001')).toBe('1.000001')
  })

  it('stays exact past 2^53, where a JS number would not', () => {
    // 90 billion XRP in drops. Number() would round this; BigInt must not.
    const drops = '90000000000000000'
    expect(dropsToXrp(drops)).toBe('90000000000')
    expect(Number.isSafeInteger(Number(drops))).toBe(false)
  })
})

describe('xrpToDrops', () => {
  it('converts whole and fractional XRP', () => {
    expect(xrpToDrops('1')).toBe('1000000')
    expect(xrpToDrops('100')).toBe('100000000')
    expect(xrpToDrops('1.5')).toBe('1500000')
    expect(xrpToDrops('0.000001')).toBe('1')
  })

  it('pads a short fraction rather than misreading its magnitude', () => {
    // "1.5" must be 1.5 XRP, not 1.000005 — the fraction is left-aligned.
    expect(xrpToDrops('1.5')).toBe('1500000')
    expect(xrpToDrops('1.05')).toBe('1050000')
    expect(xrpToDrops('1.000001')).toBe('1000001')
  })

  it('truncates beyond drop precision instead of throwing', () => {
    // A drop is the smallest unit; extra digits cannot be represented.
    expect(xrpToDrops('1.0000019')).toBe('1000001')
  })

  it('tolerates surrounding whitespace and a bare decimal', () => {
    expect(xrpToDrops('  2  ')).toBe('2000000')
    expect(xrpToDrops('.5')).toBe('500000')
  })

  it('round-trips values a user would actually type', () => {
    for (const xrp of ['1', '2.5', '100', '0.5', '12.345678']) {
      const drops = xrpToDrops(xrp)
      // Round-tripping normalises (12.345678 has 6dp, so it survives exactly).
      expect(xrpToDrops(dropsToXrp(drops))).toBe(drops)
    }
  })
})
