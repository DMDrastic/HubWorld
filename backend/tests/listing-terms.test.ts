/**
 * What a listing's money means, under each fee model. Written before the code.
 *
 * A listing records a price and a platform fee. What they MEAN depends on the model it was created under:
 *   BUYER_PAYS_V1  (every listing so far): the seller asks `price`, the buyer pays `price + fee`.
 *   SELLER_PAYS_V2 (the new model)       : the buyer pays `price`, and the seller's sell offer is `price - fee`.
 * Every place that works out what a buyer owes or what the sell offer is must agree, so they all ask this
 * module. The expected numbers are worked out by hand (drops; 1 XRP = 1_000_000).
 */
import { describe, expect, it } from 'vitest'
import {
  buyerPaysDrops,
  minimumResaleDrops,
  primaryFeeDrops,
  resaleListingTerms,
  sellOfferDrops,
} from '../src/listing-terms.js'

const XRP = (n: number) => BigInt(Math.round(n * 1_000_000))

describe('what the buyer pays and what the sell offer is', () => {
  const v1 = { priceDrops: XRP(10), platformFeeDrops: XRP(0.25), feeModel: 'BUYER_PAYS_V1' as const }
  const v2 = { priceDrops: XRP(10), platformFeeDrops: XRP(0.5), feeModel: 'SELLER_PAYS_V2' as const }

  it('V1: the fee is added on top for the buyer, and the sell offer is the ask (exactly as every live listing works)', () => {
    expect(buyerPaysDrops(v1)).toBe(XRP(10.25))
    expect(sellOfferDrops(v1)).toBe(XRP(10))
  })

  it('V2: the buyer pays exactly the price, and the sell offer is the price minus the fee', () => {
    expect(buyerPaysDrops(v2)).toBe(XRP(10))
    expect(sellOfferDrops(v2)).toBe(XRP(9.5))
  })

  it('in both models the ledger rule buy >= sell + brokerFee holds with the buyer\'s payment, and V2 is an exact equality', () => {
    expect(buyerPaysDrops(v1)).toBeGreaterThanOrEqual(sellOfferDrops(v1) + v1.platformFeeDrops)
    expect(buyerPaysDrops(v2)).toBe(sellOfferDrops(v2) + v2.platformFeeDrops)
  })

  it('a listing made before the model existed reads as V1 whatever its numbers', () => {
    expect(buyerPaysDrops({ priceDrops: 1_000n, platformFeeDrops: 25n, feeModel: 'BUYER_PAYS_V1' })).toBe(1_025n)
  })
})

describe('the terms of a new resale listing', () => {
  const MIN = XRP(3.731344)

  it('10 XRP: the fee is 0.5, the buyer pays 10, the sell offer is 9.5, recorded at 500 bps', () => {
    expect(resaleListingTerms({ priceDrops: XRP(10), minimumDrops: MIN })).toEqual({
      ok: true,
      feeDrops: XRP(0.5),
      feeBps: 500,
      sellOfferDrops: XRP(9.5),
      buyerPaysDrops: XRP(10),
    })
  })

  it('floors the fee: a price of 101 drops pays 5', () => {
    expect(resaleListingTerms({ priceDrops: 101n, minimumDrops: 1n })).toMatchObject({ ok: true, feeDrops: 5n, sellOfferDrops: 96n })
  })

  it('is refused below the minimum, with a reason the seller can read, and allowed exactly at it', () => {
    const under = resaleListingTerms({ priceDrops: MIN - 1n, minimumDrops: MIN })
    expect(under).toMatchObject({ ok: false })
    expect(!under.ok && under.reason).toMatch(/at least 3\.731344 XRP/)
    expect(resaleListingTerms({ priceDrops: MIN, minimumDrops: MIN }).ok).toBe(true)
  })

  it('always leaves a sell offer of at least one drop', () => {
    for (const price of [1n, 2n, 19n, 20n, 21n, 99n, 100n]) {
      const t = resaleListingTerms({ priceDrops: price, minimumDrops: 1n })
      if (t.ok) expect(t.sellOfferDrops).toBeGreaterThanOrEqual(1n)
    }
  })
})

describe('the US$5 floor in drops', () => {
  it('at 134 cents per XRP it is 3.731344 XRP, rounded up so a borderline price is refused', () => {
    expect(minimumResaleDrops(134n)).toBe(3_731_344n)
  })

  it('at 100 cents it is exactly 5 XRP', () => {
    expect(minimumResaleDrops(100n)).toBe(5_000_000n)
  })

  it('will not guess without a price', () => {
    expect(() => minimumResaleDrops(0n)).toThrow(/XRP price/)
  })
})

describe('the first-sale fee on the ledger, priced in XRP', () => {
  const event = { startsAt: new Date('2027-06-15T20:00:00Z'), timeZone: 'America/St_Lucia', feeRegion: 'CARIBBEAN' as const }

  it('20 XRP pays 0.7 (3.5% only, no fixed part), recorded at 350 bps', () => {
    expect(primaryFeeDrops({ priceDrops: XRP(20), event, organizerFounding: false })).toEqual({ feeDrops: XRP(0.7), feeBps: 350, promoApplied: false })
  })

  it('a founding organizer\'s event inside the window pays 0.6, recorded at 300 bps', () => {
    expect(primaryFeeDrops({ priceDrops: XRP(20), event, organizerFounding: true })).toEqual({ feeDrops: XRP(0.6), feeBps: 300, promoApplied: true })
  })

  it('a founding organizer\'s event after the window pays the standard fee', () => {
    const later = { ...event, startsAt: new Date('2028-03-01T20:00:00Z') }
    expect(primaryFeeDrops({ priceDrops: XRP(20), event: later, organizerFounding: true }).feeDrops).toBe(XRP(0.7))
  })

  it('an 11 pm New Year\'s Eve St. Lucia event is still inside the window, though it is already 2028 in UTC', () => {
    const nye = { ...event, startsAt: new Date('2028-01-01T03:00:00Z') }
    expect(primaryFeeDrops({ priceDrops: XRP(20), event: nye, organizerFounding: true }).promoApplied).toBe(true)
  })

  it('a free ticket pays nothing', () => {
    expect(primaryFeeDrops({ priceDrops: 0n, event, organizerFounding: true })).toMatchObject({ feeDrops: 0n })
  })
})
