/**
 * The price on screen is the price that is charged. Written before the change.
 *
 * Under the new fee model the server sends the all-in amount (`primaryAllInDrops`, and `buyerPaysDrops` on a
 * listing). The screen shows it and does no fee arithmetic of its own. Against a server that predates the fields
 * everything falls back to what it showed before.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { EventRow } from '@/components/EventRow'
import { CheckoutDialog } from '@/components/CheckoutDialog'
import { ListingCard, MyListingRow } from '@/components/MarketCards'
import type { EventSummary, Listing } from '@/lib/api'
import { priced } from './usd'

const XRP = (n: number) => String(Math.round(n * 1_000_000))

function event(over: Partial<EventSummary> = {}): EventSummary {
  // US$ beside every amount, as the server sends it with a fresh price (fans see US$ only).
  return priced({
    slug: 'neon',
    title: 'Neon Rooftop Session',
    venue: null,
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    status: 'PUBLISHED',
    ticketCount: 100,
    ticketsMinted: 100,
    primaryPriceDrops: XRP(25),
    ticketsForSale: 12,
    organizer: { username: 'o', displayName: null },
    ...over,
  })
}

const NEW_PRICES = { primaryFeeDrops: XRP(0.875), primaryAllInDrops: XRP(25.875) }

function listing(over: Partial<Listing> = {}): Listing {
  return priced({
    listingId: 'l1',
    state: 'active',
    priceDrops: XRP(10),
    platformFeeDrops: XRP(0.5),
    buyerPaysDrops: XRP(10),
    feeModel: 'SELLER_PAYS_V2',
    seller: '@ayo',
    buyer: null,
    ticket: { nfTokenId: 'a'.repeat(64), seat: null, tier: null, event: { slug: 'neon', title: 'Neon Rooftop Session' } },
    ...over,
  })
}

describe('the event row', () => {
  const row = (e: EventSummary) =>
    render(
      <ol>
        <EventRow event={e} live={false} onOpenAuction={vi.fn()} onBuy={vi.fn()} />
      </ol>,
    )

  it('puts the ALL-IN price on the buy button, not the bare ticket price', () => {
    row(event(NEW_PRICES))
    const button = screen.getByRole('button', { name: /buy a ticket/i })
    expect(button.textContent).toContain('US$25.87')
    expect(button.textContent).not.toMatch(/US\$25\.00|XRP/)
    expect(button.getAttribute('aria-label')).toContain('US$25.87')
  })

  it('falls back to the ticket price against a server that sends no all-in price', () => {
    row(event())
    expect(screen.getByRole('button', { name: /buy a ticket/i }).textContent).toContain('US$25.00')
  })
})

describe('the checkout dialog', () => {
  const dialog = (e: EventSummary) =>
    render(
      <StrictMode>
        <CheckoutDialog event={e} open signedIn onOpenChange={vi.fn()} onSold={vi.fn()} />
      </StrictMode>,
    )

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('names the all-in price on the button and the heading line, and says the fee is inside it', async () => {
    dialog(event(NEW_PRICES))
    expect(await screen.findByRole('button', { name: 'Buy a ticket for US$25.87' })).toBeTruthy()
    expect(screen.getByText(/US\$25\.87 per ticket/)).toBeTruthy()
    expect(screen.getByText(/includes a US\$0\.87 HubWorld fee/i)).toBeTruthy()
    // The old wording promised a fee "added" later, which an all-in price makes untrue.
    expect(screen.queryByText(/fee is added/i)).toBeNull()
  })

  it('keeps the old wording against a server that sends no all-in price', async () => {
    dialog(event())
    expect(await screen.findByRole('button', { name: 'Buy a ticket for US$25.00' })).toBeTruthy()
    expect(screen.getByText(/small HubWorld fee is added/i)).toBeTruthy()
  })
})

describe('a resale card under the new terms', () => {
  const card = (l: Listing) =>
    render(
      <ul>
        <ListingCard listing={l} event={event()} busy={false} onBuy={vi.fn()} />
      </ul>,
    )

  it('shows the price the buyer pays and does not claim a fee is added on top', () => {
    card(listing())
    const li = screen.getByRole('heading', { name: 'Neon Rooftop Session' }).closest('li')!
    expect(within(li).getByText('US$10.00')).toBeTruthy()
    expect(within(li).getByText(/fees included/i)).toBeTruthy()
    expect(within(li).queryByText(/platform fee/i)).toBeNull()
  })

  it('keeps "price + platform fee" for a listing made under the old terms', () => {
    card(listing({ feeModel: 'BUYER_PAYS_V1', buyerPaysDrops: XRP(10.5) }))
    const li = screen.getByRole('heading', { name: 'Neon Rooftop Session' }).closest('li')!
    expect(within(li).getByText('US$10.50')).toBeTruthy()
    expect(within(li).getByText(/US\$10\.00 \+ US\$0\.50 platform fee/)).toBeTruthy()
  })

  it('treats a listing from a server that sends no model as the old terms', () => {
    card(listing({ feeModel: undefined, buyerPaysDrops: XRP(10.5) }))
    const li = screen.getByRole('heading', { name: 'Neon Rooftop Session' }).closest('li')!
    expect(within(li).getByText(/US\$10\.00 \+ US\$0\.50 platform fee/)).toBeTruthy()
  })
})

describe('my own listing under the new terms', () => {
  const mine = (l: Listing) =>
    render(
      <ul>
        <MyListingRow listing={l} event={event()} busy={false} onCheck={vi.fn()} onWithdraw={vi.fn()} />
      </ul>,
    )

  it('tells the seller what comes off: the fee, and so what they receive before royalty', () => {
    mine(listing({ role: 'seller' }))
    expect(screen.getByText(/you receive US\$9\.50 before royalty/i)).toBeTruthy()
    expect(screen.queryByText(/buyer pays/i)).toBeNull()
  })

  it('says nothing about a seller\'s share to the BUYER of that listing', () => {
    mine(listing({ role: 'buyer' }))
    expect(screen.queryByText(/you receive/i)).toBeNull()
  })

  it('keeps "buyer pays" for a listing made under the old terms', () => {
    mine(listing({ role: 'seller', feeModel: 'BUYER_PAYS_V1', buyerPaysDrops: XRP(10.5) }))
    expect(screen.getByText(/buyer pays US\$10\.50/i)).toBeTruthy()
  })
})
