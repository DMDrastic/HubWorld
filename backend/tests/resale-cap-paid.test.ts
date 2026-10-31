/**
 * The resale cap under the new fee model: the LOWER of the organizer's policy and what the buyer paid.
 *
 * Written before the code. Every number is a hand-worked example in drops (1 XRP = 1_000_000).
 *
 * The rule (confirmed 2026-11-01): the effective cap is min(organizer's policy ceiling, the all-in amount the
 * buyer actually paid). DISABLED stays disabled. It applies ONLY to the new terms, meaning a ticket with a
 * recorded all-in amount while the new fee model is on. A ticket with no recorded amount, and everything
 * while the fee model is off, keeps its current policy EXACTLY: those cases are pinned here so the old
 * behaviour cannot drift.
 */
import { describe, expect, it } from 'vitest'
import { checkResalePrice, resaleCeiling } from '../src/resale-policy.js'

const XRP = (n: number) => BigInt(Math.round(n * 1_000_000))
const paidXrp = (n: number) => ({ minor: XRP(n), currency: 'XRP' as const })

const policy = (over: object = {}) => ({
  policy: 'UNRESTRICTED' as const,
  capBps: null,
  capDrops: null,
  faceValueDrops: XRP(6) as bigint | null,
  ...over,
})

describe('the policy is STRICTER than what was paid: the policy wins', () => {
  const p = policy({ policy: 'FIXED_CAP', capDrops: XRP(5) })

  it('a fixed cap of 5 on a ticket whose buyer paid 8 caps at 5', () => {
    expect(resaleCeiling({ ...p, paid: paidXrp(8) })).toEqual({ resaleAllowed: true, maxDrops: XRP(5) })
    expect(checkResalePrice({ ...p, paid: paidXrp(8), priceDrops: XRP(5) })).toMatchObject({ allowed: true })
    expect(checkResalePrice({ ...p, paid: paidXrp(8), priceDrops: XRP(5) + 1n })).toMatchObject({ allowed: false })
  })

  it('and the refusal blames the organizer\'s limit, not the amount paid', () => {
    const r = checkResalePrice({ ...p, paid: paidXrp(8), priceDrops: XRP(7) })
    expect(r.allowed).toBe(false)
    expect(!r.allowed && r.reason).toMatch(/organizer has limited resale prices to 5\.000000 XRP/)
  })

  it('face value only on a face of 4 against 8 paid caps at 4', () => {
    const q = policy({ policy: 'FACE_VALUE_ONLY', faceValueDrops: XRP(4) })
    expect(resaleCeiling({ ...q, paid: paidXrp(8) })).toEqual({ resaleAllowed: true, maxDrops: XRP(4) })
  })
})

describe('the policy is LOOSER than what was paid: the amount paid wins', () => {
  it('unrestricted, 8 paid, caps at 8: a price of 8 is allowed and one drop more is not', () => {
    const p = policy({ policy: 'UNRESTRICTED' })
    expect(resaleCeiling({ ...p, paid: paidXrp(8) })).toEqual({ resaleAllowed: true, maxDrops: XRP(8) })
    expect(checkResalePrice({ ...p, paid: paidXrp(8), priceDrops: XRP(8) })).toMatchObject({ allowed: true, maxDrops: XRP(8) })
    expect(checkResalePrice({ ...p, paid: paidXrp(8), priceDrops: XRP(8) + 1n })).toMatchObject({ allowed: false, maxDrops: XRP(8) })
  })

  it('and the refusal says it is what the buyer paid', () => {
    const r = checkResalePrice({ ...policy(), paid: paidXrp(8), priceDrops: XRP(9) })
    expect(!r.allowed && r.reason).toMatch(/what (its|the) buyer paid.*8\.000000 XRP/i)
  })

  it('a 150% percentage cap on a face of 6 (9) against 8 paid caps at 8', () => {
    const p = policy({ policy: 'PERCENTAGE_CAP', capBps: 15_000 })
    expect(resaleCeiling({ ...p, paid: paidXrp(8) })).toEqual({ resaleAllowed: true, maxDrops: XRP(8) })
  })

  it('a fixed cap of 20 against 8 paid caps at 8', () => {
    const p = policy({ policy: 'FIXED_CAP', capDrops: XRP(20) })
    expect(resaleCeiling({ ...p, paid: paidXrp(8) })).toEqual({ resaleAllowed: true, maxDrops: XRP(8) })
  })

  it('when the two are equal, that is the cap', () => {
    const p = policy({ policy: 'FIXED_CAP', capDrops: XRP(8) })
    expect(resaleCeiling({ ...p, paid: paidXrp(8) })).toEqual({ resaleAllowed: true, maxDrops: XRP(8) })
  })
})

describe('DISABLED stays disabled', () => {
  it('whatever was paid', () => {
    const p = policy({ policy: 'DISABLED' })
    expect(resaleCeiling({ ...p, paid: paidXrp(8) })).toEqual({ resaleAllowed: false, reason: 'This event does not allow resale.' })
    expect(checkResalePrice({ ...p, paid: paidXrp(8), priceDrops: 1n })).toMatchObject({ allowed: false })
  })
})

describe('a ticket with no recorded all-in amount keeps its policy EXACTLY', () => {
  const noAmount = { minor: null, currency: null }

  it('unrestricted stays unrestricted, with no ceiling at all', () => {
    expect(resaleCeiling({ ...policy(), paid: noAmount })).toEqual({ resaleAllowed: true, maxDrops: null })
    expect(checkResalePrice({ ...policy(), paid: noAmount, priceDrops: XRP(1_000_000) })).toMatchObject({ allowed: true })
  })

  it('percentage and fixed caps behave as they always did', () => {
    expect(resaleCeiling({ ...policy({ policy: 'PERCENTAGE_CAP', capBps: 12_000 }), paid: noAmount })).toEqual({ resaleAllowed: true, maxDrops: XRP(7.2) })
    expect(resaleCeiling({ ...policy({ policy: 'FIXED_CAP', capDrops: XRP(20) }), paid: noAmount })).toEqual({ resaleAllowed: true, maxDrops: XRP(20) })
  })

  it('is the same as passing nothing at all (the fee model off): the old function, unchanged', () => {
    for (const p of [
      policy(),
      policy({ policy: 'PERCENTAGE_CAP', capBps: 12_000 }),
      policy({ policy: 'FIXED_CAP', capDrops: XRP(20) }),
      policy({ policy: 'FACE_VALUE_ONLY' }),
      policy({ policy: 'DISABLED' }),
    ]) {
      expect(resaleCeiling({ ...p, paid: noAmount })).toEqual(resaleCeiling(p))
      expect(resaleCeiling({ ...p, paid: undefined })).toEqual(resaleCeiling(p))
      expect(checkResalePrice({ ...p, paid: noAmount, priceDrops: XRP(7) })).toEqual(checkResalePrice({ ...p, priceDrops: XRP(7) }))
    }
  })

  it('a refusal for a missing face value is still that refusal, not replaced by the amount paid', () => {
    const p = policy({ policy: 'FACE_VALUE_ONLY', faceValueDrops: null })
    expect(resaleCeiling({ ...p, paid: paidXrp(8) })).toMatchObject({ resaleAllowed: false, reason: expect.stringMatching(/no recorded face value/) })
  })
})

describe('a ticket that cost nothing', () => {
  it('cannot be resold for money under any policy that allows resale: its cap is zero', () => {
    for (const p of [policy(), policy({ policy: 'PERCENTAGE_CAP', capBps: 15_000 }), policy({ policy: 'FIXED_CAP', capDrops: XRP(20) })]) {
      expect(resaleCeiling({ ...p, paid: paidXrp(0) })).toEqual({ resaleAllowed: true, maxDrops: 0n })
      expect(checkResalePrice({ ...p, paid: paidXrp(0), priceDrops: 1n })).toMatchObject({ allowed: false, maxDrops: 0n })
    }
  })

  it('and says why in plain words', () => {
    const r = checkResalePrice({ ...policy(), paid: paidXrp(0), priceDrops: XRP(5) })
    expect(!r.allowed && r.reason).toMatch(/nothing|free|no money/i)
  })
})

describe('a ticket bought in another currency', () => {
  it('is not guessed at: it must be resold in the currency it was bought in', () => {
    const r = resaleCeiling({ ...policy(), paid: { minor: 3890n, currency: 'USD' } })
    expect(r).toMatchObject({ resaleAllowed: false, reason: expect.stringMatching(/bought in USD/i) })
  })
})
