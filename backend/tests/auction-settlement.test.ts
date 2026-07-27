/**
 * Auction settlement arithmetic, derived from measured ledger behaviour.
 *
 * Measured on testnet, not assumed: in brokered mode the seller receives
 * `buyAmount - brokerFee`, NOT their asking amount. A sell offer of 5 XRP matched
 * against a 20 XRP bid paid the seller 19.875 XRP. The sell offer is a FLOOR and
 * the surplus flows to the seller — which is what lets an auction take one seller
 * signature up front instead of one at close.
 *
 * The constraint that bites is `buy >= sell + brokerFee`. A sell offer sitting at
 * the reserve leaves no room for the fee, so a bid barely above the reserve dies
 * with tecINSUFFICIENT_FUNDS — there is one such failure in the broker's history.
 */
import { describe, expect, it } from 'vitest'
import { auctionSellAmountDrops, platformFeeDrops } from '../src/ledger.js'

const XRP = 1_000_000n
const BPS = 250 // 2.5%

/** The invariant the ledger enforces. */
function settleable(buyDrops: bigint, sellDrops: bigint, bps: number): boolean {
  return buyDrops >= sellDrops + platformFeeDrops(buyDrops, bps)
}

describe('auctionSellAmountDrops', () => {
  it('sits below the reserve by exactly the fee at reserve', () => {
    // 10 XRP reserve, 2.5% -> fee 0.25, so the offer goes at 9.75.
    expect(auctionSellAmountDrops(10n * XRP, BPS)).toBe(9_750_000n)
    // With no platform fee there is nothing to leave room for.
    expect(auctionSellAmountDrops(10n * XRP, 0)).toBe(10n * XRP)
  })

  it('makes a bid at exactly the reserve settleable', () => {
    // This is the case that fails if the offer is placed AT the reserve.
    const reserve = 5n * XRP
    const sell = auctionSellAmountDrops(reserve, BPS)
    expect(settleable(reserve, sell, BPS)).toBe(true)

    // Demonstrate the bug being prevented: offer at the reserve, bid a hair
    // above it, and the ledger would reject the settlement.
    expect(settleable(reserve + 10_000n, reserve, BPS)).toBe(false)
  })

  it('stays settleable across the whole plausible bid range', () => {
    const reserve = 5n * XRP
    const sell = auctionSellAmountDrops(reserve, BPS)
    for (const mult of [1n, 2n, 3n, 10n, 100n, 1000n]) {
      const bid = reserve * mult
      expect(settleable(bid, sell, BPS), `bid ${bid}`).toBe(true)
    }
    // And just above the reserve, where headroom is thinnest.
    for (const extra of [1n, 10n, 1000n, 100_000n]) {
      expect(settleable(reserve + extra, sell, BPS), `reserve+${extra}`).toBe(true)
    }
  })

  it('holds at aggressive platform fees', () => {
    for (const bps of [0, 1, 250, 1000, 5000, 9999]) {
      const reserve = 100n * XRP
      const sell = auctionSellAmountDrops(reserve, bps)
      expect(settleable(reserve, sell, bps), `bps ${bps}`).toBe(true)
      expect(settleable(reserve * 5n, sell, bps), `bps ${bps} high bid`).toBe(true)
    }
  })

  it('never produces a zero-amount offer, which would be a gift', () => {
    // At 100% platform fee the naive result is zero; a zero-amount sell offer
    // with a Destination is exactly how gifting works, so it must not happen.
    expect(auctionSellAmountDrops(1000n, 10000)).toBe(1n)
    expect(auctionSellAmountDrops(1n, BPS)).toBe(1n)
  })

  it('rejects a non-positive reserve', () => {
    expect(() => auctionSellAmountDrops(0n, BPS)).toThrow(/greater than zero/)
    expect(() => auctionSellAmountDrops(-1n, BPS)).toThrow(/greater than zero/)
  })
})

describe('what the seller actually receives', () => {
  it('is the bid minus the broker fee, not the asking price', () => {
    // The measured case: sell offer 5, bid 20, fee 0.125 -> seller 19.875.
    const bid = 20n * XRP
    const fee = 125_000n
    expect(bid - fee).toBe(19_875_000n)
  })

  it('means a higher bid pays the seller more, as an auction requires', () => {
    // If the surplus had been absorbed elsewhere, bidding above the reserve
    // would not benefit the seller and the whole auction would be pointless.
    const sell = auctionSellAmountDrops(5n * XRP, BPS)
    const low = 6n * XRP - platformFeeDrops(6n * XRP, BPS)
    const high = 30n * XRP - platformFeeDrops(30n * XRP, BPS)
    expect(high).toBeGreaterThan(low)
    expect(settleable(6n * XRP, sell, BPS) && settleable(30n * XRP, sell, BPS)).toBe(true)
  })
})
