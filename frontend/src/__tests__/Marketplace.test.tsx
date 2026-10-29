/**
 * The marketplace page: what is for sale, what is being bid on, and what each card says.
 *
 * Every fact on a card is one the page already holds, so these pin that each is shown when it
 * exists and OMITTED (not guessed) when it does not: a card that invents a face value or a date
 * for an event it knows nothing about is worse than a plain one.
 */
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { SellPanel } from '@/components/SellPanel'
import type { AuctionSummary, EventSummary, Listing } from '@/lib/api'

const XRP = (n: number) => String(Math.round(n * 1_000_000))
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

function event(slug: string, over: Partial<EventSummary> = {}): EventSummary {
  return {
    slug,
    title: `Event ${slug}`,
    venue: null,
    startsAt: new Date(Date.now() + 5 * 864e5).toISOString(),
    imageUrl: null,
    status: 'SOLD_OUT',
    ticketCount: 10,
    ticketsMinted: 10,
    primaryPriceDrops: null,
    organizer: { username: 'o', displayName: null },
    ...over,
  }
}

function listing(id: string, slug: string, price: number, fee = 0, over: Partial<Listing> = {}): Listing {
  return {
    listingId: id,
    state: 'active',
    priceDrops: XRP(price),
    platformFeeDrops: XRP(fee),
    buyerPaysDrops: XRP(price + fee),
    seller: '@ayo',
    buyer: null,
    ticket: { nfTokenId: id.padEnd(64, 'a'), seat: null, tier: null, event: { slug, title: `Event ${slug}` } },
    ...over,
  }
}

function mockApi(market: Listing[], mine: Listing[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/tickets/mine')) return json({ address: 'r', verified: true, tickets: [] })
      if (url.includes('/listings/mine')) return json({ listings: mine })
      if (url.endsWith('/api/listings')) return json({ listings: market })
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

const auction = (over: Partial<AuctionSummary> = {}): AuctionSummary => ({
  id: 'a1',
  eventSlug: 'neon',
  eventTitle: 'Neon Rooftop Session',
  state: 'LIVE',
  endsAt: new Date(Date.now() + 36e5).toISOString(),
  reserveDrops: XRP(20),
  topBidDrops: XRP(34),
  bidCount: 7,
  ...over,
})

const renderPanel = (props: Partial<React.ComponentProps<typeof SellPanel>> = {}) =>
  render(
    <StrictMode>
      <SellPanel onChanged={vi.fn()} {...props} />
    </StrictMode>,
  )

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('tickets for sale', () => {
  it('shows what a buyer pays, and how that is made up', async () => {
    mockApi([listing('l1', 'neon', 30, 0.75)])
    renderPanel({ events: [event('neon')] })
    const card = (await screen.findByRole('heading', { name: 'Event neon', level: 3 })).closest('li')!
    expect(within(card).getByText('30.75')).toBeTruthy()
    expect(within(card).getByText(/30 \+ 0\.75 platform fee/)).toBeTruthy()
    expect(within(card).getByText('Sold by @ayo')).toBeTruthy()
  })

  it('compares the ask with the event\'s face value, in words and with the figure', async () => {
    mockApi([listing('l1', 'neon', 30, 0.75), listing('l2', 'block', 17, 0.4)])
    renderPanel({
      events: [event('neon', { primaryPriceDrops: XRP(25) }), event('block', { primaryPriceDrops: XRP(20) })],
    })
    expect(await screen.findByText('20% over face value')).toBeTruthy()
    expect(screen.getByText('15% under face value')).toBeTruthy()
    expect(screen.getByText('(25 XRP)')).toBeTruthy()
  })

  it('leaves the comparison out when the event has no face value, rather than guessing', async () => {
    mockApi([listing('l1', 'neon', 30)])
    renderPanel({ events: [event('neon', { primaryPriceDrops: null })] })
    await screen.findByText('30')
    expect(screen.queryByText(/face value/i)).toBeNull()
  })

  it('still renders a listing whose event it cannot find, with no date, venue or poster', async () => {
    mockApi([listing('l1', 'ghost', 12)])
    renderPanel({ events: [] })
    const card = (await screen.findByRole('heading', { name: 'Event ghost', level: 3 })).closest('li')!
    expect(within(card).getByText('12')).toBeTruthy()
    expect(card.querySelector('img')).toBeNull()
    expect(within(card).queryByText(/face value/i)).toBeNull()
  })

  it('shows the poster when the event has one, and the date and venue beside it', async () => {
    mockApi([listing('l1', 'neon', 30)])
    renderPanel({ events: [event('neon', { imageUrl: 'https://example.test/p.jpg', venue: 'The Rooftop' })] })
    const card = (await screen.findByRole('heading', { name: 'Event neon', level: 3 })).closest('li')!
    expect(card.querySelector('img')?.getAttribute('src')).toBe('https://example.test/p.jpg')
    expect(within(card).getByText('The Rooftop')).toBeTruthy()
  })

  it('summarises the market in one line from the real data', async () => {
    mockApi([listing('l1', 'a', 30), listing('l2', 'a', 5)])
    renderPanel({ events: [event('a')], auctions: [auction()] })
    expect(await screen.findByText(/2 tickets for sale · 1 live auction · from 5 XRP/)).toBeTruthy()
  })

  it('sorts by lowest price on request, and by soonest event by default', async () => {
    mockApi([listing('later', 'late', 5), listing('soon', 'early', 50)])
    renderPanel({
      events: [
        event('early', { startsAt: new Date(Date.now() + 864e5).toISOString() }),
        event('late', { startsAt: new Date(Date.now() + 9 * 864e5).toISOString() }),
      ],
    })
    const order = () => screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    await screen.findByText('Event early')
    expect(order()).toEqual(['Event early', 'Event late'])
    fireEvent.click(screen.getByRole('tab', { name: 'Lowest price' }))
    expect(order()).toEqual(['Event late', 'Event early'])
  })

  it('says plainly when nothing is for sale, and offers no sort control', async () => {
    mockApi([])
    renderPanel()
    expect(await screen.findByText('Nothing for sale right now')).toBeTruthy()
    expect(screen.queryByRole('tab', { name: 'Lowest price' })).toBeNull()
  })

  it('names each Buy button for its ticket and price', async () => {
    mockApi([listing('l1', 'neon', 30, 0.75)])
    renderPanel({ events: [event('neon')] })
    expect(await screen.findByRole('button', { name: 'Buy Event neon for 30.75 XRP' })).toBeTruthy()
  })
})

describe('live auctions', () => {
  it('shows a live auction with its top bid, and opens the bidding', async () => {
    mockApi([])
    const onOpenAuction = vi.fn()
    renderPanel({ auctions: [auction()], onOpenAuction, events: [event('neon')] })
    expect(await screen.findByText(/Top bid 34 XRP · 7 bids/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View live bidding for Neon Rooftop Session' }))
    expect(onOpenAuction).toHaveBeenCalledWith('neon')
  })

  it('says reserve and no bids yet, rather than a top bid of zero', async () => {
    mockApi([])
    renderPanel({ auctions: [auction({ bidCount: 0, topBidDrops: '0' })], onOpenAuction: vi.fn() })
    expect(await screen.findByText(/Reserve 20 XRP · no bids yet/)).toBeTruthy()
    expect(screen.queryByText(/Top bid/)).toBeNull()
  })

  it('does not offer a watch control it cannot honour', async () => {
    mockApi([])
    renderPanel({ auctions: [auction()] })
    await screen.findByText('Nothing for sale right now')
    expect(screen.queryByText('Live auctions')).toBeNull()
  })
})

describe('your listings', () => {
  it('lists them with their state in words, and lets you withdraw only what you are selling', async () => {
    mockApi([], [listing('m1', 'neon', 22, 0.5, { role: 'seller' }), listing('m2', 'block', 9, 0, { role: 'buyer', state: 'buyer_pending' })])
    renderPanel({ events: [event('neon'), event('block')] })
    await screen.findByText('Your listings')
    expect(screen.getByText(/buyer pending · buying/)).toBeTruthy()
    // One Withdraw: the seller's own listing, never the one you are buying.
    expect(screen.getAllByRole('button', { name: 'Withdraw' })).toHaveLength(1)
  })
})
