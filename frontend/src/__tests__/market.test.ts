import { describe, expect, it } from 'vitest'
import { cheapest, faceDelta, sortListings } from '@/lib/market'
import type { EventSummary, Listing } from '@/lib/api'

const XRP = (n: number) => String(n * 1_000_000)

describe('faceDelta', () => {
  it('says nothing when the event has no box-office price', () => {
    expect(faceDelta(XRP(30), null)).toBeNull()
    expect(faceDelta(XRP(30), undefined)).toBeNull()
    expect(faceDelta(XRP(30), '0')).toBeNull()
  })

  it('names an ask at face value as exactly that', () => {
    expect(faceDelta(XRP(25), XRP(25))).toEqual({ label: 'At face value', direction: 'at' })
  })

  it('states the markup and the discount as whole percentages', () => {
    expect(faceDelta(XRP(30), XRP(25))).toEqual({ label: '20% over face value', direction: 'over' })
    expect(faceDelta(XRP(20), XRP(25))).toEqual({ label: '20% under face value', direction: 'under' })
  })

  it('never rounds toward a better-looking deal', () => {
    // 12.9% under must not read as 13%: a card may not claim a discount it is not giving.
    expect(faceDelta('21775000', XRP(25))?.label).toBe('12% under face value')
    // ...and 12.9% over must not read as 13% over either, in the other direction.
    expect(faceDelta('28225000', XRP(25))?.label).toBe('12% over face value')
  })

  it('does not print "0%" for a price that is a hair off face value', () => {
    expect(faceDelta('25000001', XRP(25))?.label).toBe('Just over face value')
    expect(faceDelta('24999999', XRP(25))?.label).toBe('Just under face value')
  })

  it('stays exact on amounts a float cannot hold', () => {
    const big = '9007199254740993000' // beyond Number.MAX_SAFE_INTEGER
    expect(faceDelta(big, big)?.direction).toBe('at')
  })
})

function listing(id: string, slug: string, buyerPays: number): Listing {
  return {
    listingId: id,
    state: 'active',
    priceDrops: XRP(buyerPays),
    platformFeeDrops: '0',
    buyerPaysDrops: XRP(buyerPays),
    seller: '@s',
    buyer: null,
    ticket: { nfTokenId: id, seat: null, tier: null, event: { slug, title: slug } },
  }
}

function event(slug: string, daysAhead: number): EventSummary {
  return {
    slug,
    title: slug,
    venue: null,
    startsAt: new Date(Date.now() + daysAhead * 864e5).toISOString(),
    status: 'PUBLISHED',
    ticketCount: 10,
    ticketsMinted: 10,
    organizer: { username: 'o', displayName: null },
  }
}

describe('sortListings', () => {
  const events = new Map([event('soon', 1), event('later', 9)].map((e) => [e.slug, e]))
  const ls = [listing('a', 'later', 5), listing('b', 'soon', 50), listing('c', 'unknown', 1)]

  it('puts the soonest event first, and an event it cannot place last', () => {
    expect(sortListings(ls, events, 'soonest').map((l) => l.listingId)).toEqual(['b', 'a', 'c'])
  })

  it('orders by what the buyer actually pays', () => {
    expect(sortListings(ls, events, 'price').map((l) => l.listingId)).toEqual(['c', 'a', 'b'])
  })

  it('does not reorder the array it was given', () => {
    const copy = ls.map((l) => l.listingId)
    sortListings(ls, events, 'price')
    expect(ls.map((l) => l.listingId)).toEqual(copy)
  })
})

describe('cheapest', () => {
  it('is null with nothing for sale, never "0"', () => {
    expect(cheapest([])).toBeNull()
  })
  it('is the lowest total a buyer pays', () => {
    expect(cheapest([listing('a', 'x', 5), listing('b', 'x', 2), listing('c', 'x', 9)])).toBe(XRP(2))
  })
})
