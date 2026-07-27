/**
 * When a ticket may go to auction.
 *
 * Auctions exist for scarcity: a sold-out event has demand the organizer can no
 * longer meet, so holders bid against each other. Both rules follow from that.
 *
 * Auctioning while the organizer still has stock means a fan bidding 30 XRP for
 * something anyone can buy at 10 — not scarcity, just confusion. And an organizer
 * auctioning their own allocation is an organizer bidding up their own event,
 * which is precisely what a ticketing platform should prevent.
 */
import { describe, expect, it } from 'vitest'

/** Mirrors evaluateSoldOut's decision. */
function soldOut(s: { ticketCount: number; minted: number; organizerHolds: number }): boolean {
  return s.ticketCount > 0 && s.minted >= s.ticketCount && s.organizerHolds === 0
}

describe('sold out requires BOTH halves', () => {
  it('is true only when everything is issued and none is held back', () => {
    expect(soldOut({ ticketCount: 10, minted: 10, organizerHolds: 0 })).toBe(true)
  })

  it('is false while tickets remain unissued', () => {
    // The real state of neon-rooftop-session: 3 of 10 minted.
    expect(soldOut({ ticketCount: 10, minted: 3, organizerHolds: 0 })).toBe(false)
  })

  it('is false while the organizer still holds stock', () => {
    // All minted, but four are unsold — buyers can still pay face value, so
    // there is nothing scarce to bid over.
    expect(soldOut({ ticketCount: 10, minted: 10, organizerHolds: 4 })).toBe(false)
  })

  it('is false for an event with no declared cap', () => {
    // ticketCount 0 means unbounded issuance. Without this guard a brand-new
    // event with no tickets would qualify as sold out immediately.
    expect(soldOut({ ticketCount: 0, minted: 0, organizerHolds: 0 })).toBe(false)
  })

  it('holds when more were minted than promised', () => {
    // Overshooting the cap is still sold out; the comparison is >=, not ===.
    expect(soldOut({ ticketCount: 10, minted: 12, organizerHolds: 0 })).toBe(true)
  })
})

describe('why it is derived rather than read from Event.status', () => {
  it('ignores a status that contradicts the facts', () => {
    // peachs-castle-afterparty is seeded SOLD_OUT with zero tickets minted.
    // Gating on a settable field would let anyone open auctions on an event
    // that never sold anything.
    const claimed = 'SOLD_OUT'
    const facts = { ticketCount: 200, minted: 0, organizerHolds: 0 }
    expect(claimed).toBe('SOLD_OUT')
    expect(soldOut(facts)).toBe(false)
  })
})

describe('the organizer cannot auction their own allocation', () => {
  /** Mirrors canAuction's first check, which runs before the sold-out test. */
  const organizerBlocked = (holderId: string, organizerId: string) => holderId === organizerId

  it('blocks the organizer even on a sold-out event', () => {
    // Checked first deliberately: "you are the organizer" is the permanent
    // answer, and telling them to wait for a sell-out they already have would
    // be misleading.
    expect(organizerBlocked('u1', 'u1')).toBe(true)
  })

  it('allows any other holder', () => {
    expect(organizerBlocked('u2', 'u1')).toBe(false)
  })
})
