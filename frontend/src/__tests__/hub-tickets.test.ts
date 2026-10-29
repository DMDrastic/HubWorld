import { describe, expect, it } from 'vitest'
import { FEATURED_MAX, groupTickets } from '@/lib/hub-tickets'
import type { OwnedTicket } from '@/lib/api'

const NOW = new Date('2026-10-29T21:00:00').getTime()
const day = 864e5

function ticket(id: string, startsInDays: number, status = 'MINTED'): OwnedTicket {
  return {
    nfTokenId: id,
    seat: null,
    tier: null,
    status,
    syncedAt: null,
    onLedger: true,
    event: { slug: id, title: id, startsAt: new Date(NOW + startsInDays * day).toISOString() },
    canAuction: false,
    auctionBlockedReason: null,
    faceValueDrops: null,
    resaleAllowed: true,
    maxListingPriceDrops: null,
    maxAuctionReserveDrops: null,
    resaleBlockedReason: null,
  }
}
const ids = (ts: OwnedTicket[]) => ts.map((t) => t.nfTokenId)

describe('groupTickets', () => {
  it('lets at most four tickets float, the soonest ones', () => {
    const g = groupTickets([1, 2, 3, 4, 5, 6].map((n) => ticket(`t${n}`, n)), NOW)
    expect(FEATURED_MAX).toBe(4)
    expect(ids(g.featured)).toEqual(['t1', 't2', 't3', 't4'])
  })

  it('sends everything past the fourth to the timeline, still soonest first', () => {
    const g = groupTickets([9, 3, 7, 1, 5, 2].map((n) => ticket(`t${n}`, n)), NOW)
    expect(ids(g.featured)).toEqual(['t1', 't2', 't3', 't5'])
    expect(ids(g.upcoming)).toEqual(['t7', 't9'])
  })

  it('floats all of them when there are four or fewer, leaving the timeline empty', () => {
    const g = groupTickets([ticket('a', 2), ticket('b', 1)], NOW)
    expect(ids(g.featured)).toEqual(['b', 'a'])
    expect(g.upcoming).toEqual([])
  })

  it('treats a ticket for tonight as still ahead, even after it has started', () => {
    const tonightAt7 = new Date('2026-10-29T19:00:00').getTime()
    const t = { ...ticket('tonight', 0), event: { slug: 's', title: 't', startsAt: new Date(tonightAt7).toISOString() } }
    expect(ids(groupTickets([t], NOW).featured)).toEqual(['tonight'])
  })

  it('files a used ticket under past, however soon its night is', () => {
    const g = groupTickets([ticket('used', 1, 'REDEEMED'), ticket('live', 2)], NOW)
    expect(ids(g.featured)).toEqual(['live'])
    expect(ids(g.past)).toEqual(['used'])
  })

  it('files an unused ticket for a night that has gone under past', () => {
    const g = groupTickets([ticket('gone', -3), ticket('live', 2)], NOW)
    expect(ids(g.past)).toEqual(['gone'])
  })

  it('orders the past most recent first', () => {
    const g = groupTickets([ticket('old', -30), ticket('recent', -2), ticket('mid', -10)], NOW)
    expect(ids(g.past)).toEqual(['recent', 'mid', 'old'])
  })

  it('keeps a listed or in-auction ticket in play, since it is still yours until it sells', () => {
    const g = groupTickets([ticket('l', 2, 'LISTED'), ticket('a', 1, 'IN_AUCTION')], NOW)
    expect(ids(g.featured)).toEqual(['a', 'l'])
  })

  it('does not reorder the array it was given', () => {
    const input = [ticket('b', 5), ticket('a', 1)]
    groupTickets(input, NOW)
    expect(ids(input)).toEqual(['b', 'a'])
  })

  it('is three empty groups for no tickets', () => {
    expect(groupTickets([], NOW)).toEqual({ featured: [], upcoming: [], past: [] })
  })
})
