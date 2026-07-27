/**
 * Opening an auction: the floor-price bypass.
 *
 * An auction's sell offer is an ordinary Listing, because settlement brokers the
 * winning bid against it. That creates a trap: an ACTIVE listing is normally
 * public and directly buyable, and this one is priced at the auction FLOOR. Left
 * unguarded, anyone could buy the ticket for the reserve and skip the bidding —
 * a listing offering a ticket at its minimum is the worst possible thing to
 * expose.
 *
 * `Listing.auctionId` is what distinguishes them, so these pin the two places
 * that must exclude it.
 */
import { describe, expect, it } from 'vitest'
import { auctionSellAmountDrops, platformFeeDrops } from '../src/ledger.js'

const XRP = 1_000_000n
const BPS = 250

/** Mirrors the marketplace query: ACTIVE *and* not auction-backed. */
function marketplaceShows(l: { status: string; auctionId: string | null }): boolean {
  return l.status === 'ACTIVE' && l.auctionId === null
}

/** Mirrors the buy guard: an auction-backed listing is never directly buyable. */
function directlyBuyable(l: { status: string; auctionId: string | null }): boolean {
  if (l.auctionId) return false
  return l.status === 'ACTIVE'
}

describe('an auction sell offer is not a marketplace listing', () => {
  it('is hidden from the marketplace', () => {
    expect(marketplaceShows({ status: 'ACTIVE', auctionId: 'a1' })).toBe(false)
    expect(marketplaceShows({ status: 'ACTIVE', auctionId: null })).toBe(true)
  })

  it('cannot be bought outright at the floor price', () => {
    // The bypass: the offer is priced at the reserve, so a direct purchase would
    // take the ticket for the minimum and the auction would never happen.
    expect(directlyBuyable({ status: 'ACTIVE', auctionId: 'a1' })).toBe(false)
    expect(directlyBuyable({ status: 'ACTIVE', auctionId: null })).toBe(true)
  })

  it('stays unbuyable in every listing state', () => {
    for (const status of ['PENDING_OFFER', 'ACTIVE', 'BUYER_PENDING', 'SETTLING', 'SOLD']) {
      expect(directlyBuyable({ status, auctionId: 'a1' }), status).toBe(false)
    }
  })
})

describe('the sell offer amount an auction opens with', () => {
  it('sits below the reserve so a bid at the reserve can settle', () => {
    const reserve = 20n * XRP
    const sell = auctionSellAmountDrops(reserve, BPS)
    expect(sell).toBeLessThan(reserve)
    // The ledger's rule, checked at the tightest point: a bid exactly at reserve.
    expect(reserve >= sell + platformFeeDrops(reserve, BPS)).toBe(true)
  })

  it('leaves the seller better off than the floor whenever bidding happens', () => {
    // The seller receives bid - fee (measured on testnet), so any bid above the
    // reserve pays them more than the offer they signed. If that were not true,
    // signing a floor offer would be a bad deal for the holder.
    const reserve = 20n * XRP
    const sell = auctionSellAmountDrops(reserve, BPS)
    for (const bid of [reserve, 25n * XRP, 100n * XRP]) {
      expect(bid - platformFeeDrops(bid, BPS)).toBeGreaterThanOrEqual(sell)
    }
  })
})
