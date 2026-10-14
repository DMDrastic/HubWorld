/**
 * How far above face value a ticket may be resold — the real module, not a
 * reimplementation. See auction-policy.real.test.ts for why that distinction
 * matters: a test that mirrors the logic inline tests its own copy, and
 * passes whatever the shipped function actually does.
 */
import { describe, expect, it } from 'vitest'
import { checkResalePrice, resaleCeiling } from '../src/resale-policy.js'

const XRP = 1_000_000n

describe('UNRESTRICTED', () => {
  it('allows any price, with no ceiling reported', () => {
    const result = checkResalePrice({
      policy: 'UNRESTRICTED',
      capBps: null,
      capDrops: null,
      faceValueDrops: 10n * XRP,
      priceDrops: 1_000_000n * XRP,
    })
    expect(result).toEqual({ allowed: true, maxDrops: null })
  })

  it('allows a price even with no face value on record', () => {
    const result = checkResalePrice({
      policy: 'UNRESTRICTED',
      capBps: null,
      capDrops: null,
      faceValueDrops: null,
      priceDrops: 50n * XRP,
    })
    expect(result.allowed).toBe(true)
  })
})

describe('DISABLED', () => {
  it('refuses regardless of price', () => {
    const result = checkResalePrice({
      policy: 'DISABLED',
      capBps: null,
      capDrops: null,
      faceValueDrops: 10n * XRP,
      priceDrops: 1n, // even the smallest possible price
    })
    expect(result.allowed).toBe(false)
  })
})

describe('FIXED_CAP', () => {
  const params = { policy: 'FIXED_CAP' as const, capBps: null, capDrops: 100n * XRP, faceValueDrops: null }

  it('allows a price exactly at the cap', () => {
    expect(checkResalePrice({ ...params, priceDrops: 100n * XRP }).allowed).toBe(true)
  })

  it('refuses one drop above the cap', () => {
    const result = checkResalePrice({ ...params, priceDrops: 100n * XRP + 1n })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.maxDrops).toBe(100n * XRP)
  })

  it('allows a price below the cap', () => {
    expect(checkResalePrice({ ...params, priceDrops: 50n * XRP }).allowed).toBe(true)
  })

  it('does not require a face value', () => {
    expect(checkResalePrice({ ...params, priceDrops: 100n * XRP }).allowed).toBe(true)
  })
})

describe('FACE_VALUE_ONLY', () => {
  it('allows a price exactly at face value', () => {
    const result = checkResalePrice({
      policy: 'FACE_VALUE_ONLY',
      capBps: null,
      capDrops: null,
      faceValueDrops: 20n * XRP,
      priceDrops: 20n * XRP,
    })
    expect(result.allowed).toBe(true)
  })

  it('refuses one drop above face value', () => {
    const result = checkResalePrice({
      policy: 'FACE_VALUE_ONLY',
      capBps: null,
      capDrops: null,
      faceValueDrops: 20n * XRP,
      priceDrops: 20n * XRP + 1n,
    })
    expect(result.allowed).toBe(false)
  })

  it('refuses with no face value recorded, rather than falling back to unrestricted', () => {
    const result = checkResalePrice({
      policy: 'FACE_VALUE_ONLY',
      capBps: null,
      capDrops: null,
      faceValueDrops: null,
      priceDrops: 1n,
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/no recorded face value/)
  })
})

describe('PERCENTAGE_CAP', () => {
  it('120% of a 100 XRP face value allows up to 120 XRP', () => {
    const base = { policy: 'PERCENTAGE_CAP' as const, capBps: 12_000, capDrops: null, faceValueDrops: 100n * XRP }
    expect(checkResalePrice({ ...base, priceDrops: 120n * XRP }).allowed).toBe(true)
    const over = checkResalePrice({ ...base, priceDrops: 120n * XRP + 1n })
    expect(over.allowed).toBe(false)
    if (!over.allowed) expect(over.maxDrops).toBe(120n * XRP)
  })

  it('floors fractional drops rather than rounding up', () => {
    // 10000.000001 XRP face value at 100.01% — the extra should be floored
    // away, not rounded into an extra drop of allowance.
    const result = checkResalePrice({
      policy: 'PERCENTAGE_CAP',
      capBps: 10_001,
      capDrops: null,
      faceValueDrops: 3n, // 3 drops * 10001 / 10000 = 3.0003 -> floors to 3
      priceDrops: 4n,
    })
    expect(result.allowed).toBe(false)
  })

  it('refuses with no face value recorded', () => {
    const result = checkResalePrice({
      policy: 'PERCENTAGE_CAP',
      capBps: 12_000,
      capDrops: null,
      faceValueDrops: null,
      priceDrops: 1n,
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/no recorded face value/)
  })

  it('a cap below 100% permits only a discount, never a markup', () => {
    const base = { policy: 'PERCENTAGE_CAP' as const, capBps: 8_000, capDrops: null, faceValueDrops: 100n * XRP }
    expect(checkResalePrice({ ...base, priceDrops: 80n * XRP }).allowed).toBe(true)
    expect(checkResalePrice({ ...base, priceDrops: 81n * XRP }).allowed).toBe(false)
  })
})

describe('resaleCeiling', () => {
  it('reports the ceiling without needing a candidate price', () => {
    const result = resaleCeiling({
      policy: 'PERCENTAGE_CAP',
      capBps: 12_000,
      capDrops: null,
      faceValueDrops: 100n * XRP,
    })
    expect(result).toEqual({ resaleAllowed: true, maxDrops: 120n * XRP })
  })

  it('reports null maxDrops for UNRESTRICTED', () => {
    const result = resaleCeiling({ policy: 'UNRESTRICTED', capBps: null, capDrops: null, faceValueDrops: null })
    expect(result).toEqual({ resaleAllowed: true, maxDrops: null })
  })

  it('reports resaleAllowed: false for DISABLED', () => {
    const result = resaleCeiling({ policy: 'DISABLED', capBps: null, capDrops: null, faceValueDrops: 10n * XRP })
    expect(result.resaleAllowed).toBe(false)
  })

  it('reports resaleAllowed: false for a capped policy with no face value', () => {
    const result = resaleCeiling({
      policy: 'FACE_VALUE_ONLY',
      capBps: null,
      capDrops: null,
      faceValueDrops: null,
    })
    expect(result.resaleAllowed).toBe(false)
  })
})
