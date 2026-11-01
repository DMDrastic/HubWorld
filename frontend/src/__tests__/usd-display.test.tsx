/**
 * Fans see US$ only (strategy handoff §13.1). Written before the change.
 *
 * Event pages, checkout, My Tickets and resale listings show the dollar figure and nothing in XRP. The one exception is
 * the approval screen: it still shows the exact on-ledger amount being signed, as a small "Details" line under the
 * dollar figure, built from the decoded transaction. Every event is still priced in XRP today (USD pricing is item 1b),
 * so with no fresh price there is no honest dollar figure: buying pauses on that listing or event, and nothing in XRP or
 * any old dollar figure is shown instead.
 */
import { StrictMode } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CheckoutDialog } from '@/components/CheckoutDialog'
import { EventRow } from '@/components/EventRow'
import { AuctionPlate, ListingCard } from '@/components/MarketCards'
import { SignStep } from '@/components/SignStep'
import { formatFiat } from '@/lib/fiat'
import { PolicyContext } from '@/lib/policy-context'
import { reviewer } from '@/lib/sign-review-loader'
import type { AuctionSummary, EventSummary, Listing, Policy } from '@/lib/api'
import { WALLET, WithRuntime, fakeRuntime, json } from './fakeRuntime'

const USD = (minor: string) => ({ currency: 'USD' as const, minor })

const EVENT: EventSummary = {
  slug: 'neon',
  title: 'Neon Rooftop Session',
  venue: 'Hub World',
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  status: 'PUBLISHED',
  ticketCount: 100,
  ticketsMinted: 100,
  primaryPriceDrops: '27000000',
  primaryFeeDrops: '1000000',
  primaryAllInDrops: '28000000',
  ticketsForSale: 12,
  organizer: { username: 'org', displayName: null },
  fiat: { primaryAllInDrops: USD('3500'), primaryPriceDrops: USD('3375'), primaryFeeDrops: USD('125') },
}
const STALE: EventSummary = { ...EVENT, fiat: {} }

const LISTING: Listing = {
  listingId: 'l-1',
  state: 'active',
  priceDrops: '28000000',
  platformFeeDrops: '1400000',
  buyerPaysDrops: '28000000',
  feeModel: 'SELLER_PAYS_V2',
  seller: '@seller',
  buyer: null,
  ticket: { nfTokenId: 'AB', seat: null, tier: null, event: { slug: 'neon', title: 'Neon Rooftop Session' } },
  fiat: { priceDrops: USD('3500'), platformFeeDrops: USD('175'), buyerPaysDrops: USD('3500') },
}

const noXrp = (el: Element | null) => expect(el?.textContent ?? '').not.toMatch(/XRP|≈/)

describe('formatting, not converting', () => {
  it('formats minor units as US$ or EC$, with grouping', () => {
    expect(formatFiat(USD('3500'))).toBe('US$35.00')
    expect(formatFiat(USD('5'))).toBe('US$0.05')
    expect(formatFiat(USD('123456789'))).toBe('US$1,234,567.89')
    expect(formatFiat({ currency: 'XCD', minor: '9450' })).toBe('EC$94.50')
  })
})

describe('the event row', () => {
  const row = (e: EventSummary) =>
    render(
      <ol>
        <EventRow event={e} live={false} onOpenAuction={vi.fn()} onBuy={vi.fn()} />
      </ol>,
    )

  it('prices the ticket in US$ only', () => {
    const { container } = row(EVENT)
    const buy = screen.getByRole('button', { name: /buy a ticket to neon rooftop session for US\$35\.00/i })
    expect(buy.textContent).toContain('US$35.00')
    noXrp(container)
  })

  it('with no fresh price: no buy button, a plain note, and no XRP or old figure', () => {
    const { container } = row(STALE)
    expect(screen.queryByRole('button', { name: /buy/i })).toBeNull()
    expect(screen.getByText(/price unavailable right now/i)).toBeTruthy()
    noXrp(container)
    expect(container.textContent).not.toMatch(/\$/)
  })
})

describe('the marketplace', () => {
  it('a listing is priced in US$, with its fee breakdown in US$, and no XRP', () => {
    const { container } = render(<ol><ListingCard listing={LISTING} event={EVENT} busy={false} onBuy={vi.fn()} /></ol>)
    expect(screen.getByText('US$35.00')).toBeTruthy()
    expect(screen.getByRole('button', { name: /buy neon rooftop session for US\$35\.00/i })).toBeTruthy()
    noXrp(container)
  })

  it('a listing with no fresh price cannot be bought, and shows no XRP', () => {
    const { container } = render(<ol><ListingCard listing={{ ...LISTING, fiat: {} }} event={STALE} busy={false} onBuy={vi.fn()} /></ol>)
    expect(screen.getByText(/price unavailable right now/i)).toBeTruthy()
    expect((screen.getByRole('button', { name: /buy/i }) as HTMLButtonElement).disabled).toBe(true)
    noXrp(container)
  })

  it('an auction shows its top bid in US$, or just its bid count when there is no fresh price', () => {
    const a: AuctionSummary = { id: 'a', eventSlug: 'neon', eventTitle: 'Neon', state: 'live', endsAt: new Date(Date.now() + 3_600_000).toISOString(), reserveDrops: '20000000', topBidDrops: '28000000', bidCount: 2, fiat: { topBidDrops: USD('3500'), reserveDrops: USD('2500') } }
    const fresh = render(<ol><AuctionPlate auction={a} event={undefined} onWatch={vi.fn()} /></ol>)
    expect(fresh.container.textContent).toContain('Top bid US$35.00')
    noXrp(fresh.container)
    fresh.unmount()
    const stale = render(<ol><AuctionPlate auction={{ ...a, fiat: {} }} event={undefined} onWatch={vi.fn()} /></ol>)
    expect(stale.container.textContent).toContain('2 bids')
    noXrp(stale.container)
  })
})

describe('the checkout', () => {
  const review = vi.fn()
  const CREATED = {
    listingId: 'l-1', uuid: '11111111-2222-4333-8444-555555555555', next: '', qrPng: '', mode: 'live' as const,
    paysDrops: '28000000', expiresAt: new Date(Date.now() + 300_000).toISOString(),
    sign: { tx: { TransactionType: 'NFTokenCreateOffer', Account: WALLET.address }, hash: 'AB'.repeat(32), account: WALLET.address },
  }
  const mount = (event: EventSummary, created: object) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/checkout') && init?.method === 'POST') return json(created, 201)
      if (/\/listings\/[^/]+$/.test(url)) return json({ ...LISTING, state: 'buyer_pending' })
      throw new Error(`unexpected fetch: ${url}`)
    }))
    return render(
      <StrictMode>
        <PolicyContext.Provider value={{ platformBps: 250, maxRoyaltyBps: 2000, brokerAddress: 'rBroker' } as Policy}>
          <WithRuntime runtime={fakeRuntime()}>
            <CheckoutDialog event={event} open signedIn onOpenChange={vi.fn()} onSold={vi.fn()} />
          </WithRuntime>
        </PolicyContext.Provider>
      </StrictMode>,
    )
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(reviewer, 'load').mockResolvedValue({ reviewSignRequest: (...a: unknown[]) => review(...a) } as never)
    review.mockResolvedValue({ ok: true, title: 'Buy 1 ticket to Neon Rooftop Session', lines: ['You pay 28 XRP. Nothing else leaves your wallet apart from a tiny network fee.'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    review.mockReset()
  })

  it('before buying: US$ only', async () => {
    mount(EVENT, CREATED)
    expect(await screen.findByRole('button', { name: 'Buy a ticket for US$35.00' })).toBeTruthy()
    noXrp(screen.getByRole('dialog'))
  })

  it('at the approval: the US$ figure large, the exact XRP in Details, and the review handed the XRP drops', async () => {
    mount(EVENT, { ...CREATED, fiat: { paysDrops: USD('3600') } })
    fireEvent.click(await screen.findByRole('button', { name: /buy a ticket/i }))
    // The HELD amount's own figure (the price moved since the list loaded), not the list's.
    expect(await screen.findByText('US$36.00')).toBeTruthy()
    expect(screen.getByText('Details')).toBeTruthy()
    expect(screen.getByText(/You pay 28 XRP/)).toBeTruthy()
    expect(review.mock.calls[0]![1]).toMatchObject({ action: { kind: 'buy', amountDrops: '28000000' } })
    expect(JSON.stringify(review.mock.calls[0])).not.toMatch(/3600|USD|fiat/)
  })

  it('with no fresh price: says so, offers no buy button, and shows no XRP', async () => {
    mount(STALE, CREATED)
    expect(await screen.findByText(/price unavailable right now/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /buy a ticket/i })).toBeNull()
    noXrp(screen.getByRole('dialog'))
  })
})

describe('the approval screen always shows the exact amount being signed', () => {
  const sign = { tx: { TransactionType: 'NFTokenCreateOffer', Account: WALLET.address }, hash: 'AB'.repeat(32), account: WALLET.address }
  afterEach(() => vi.restoreAllMocks())

  it.each([
    ['with a dollar figure', 'US$35.00'],
    ['without one', undefined],
  ])('%s: the review\'s lines (which carry the signed XRP) are under "Details"', async (_n, shownPrice) => {
    vi.spyOn(reviewer, 'load').mockResolvedValue({
      reviewSignRequest: async () => ({ ok: true, title: 'Buy 1 ticket', lines: ['You pay 28 XRP. Nothing else leaves your wallet.'] }),
    } as never)
    render(
      <WithRuntime runtime={fakeRuntime()}>
        <SignStep uuid="u" sign={sign} context={{ hubworldDelegate: null, broker: 'rBroker' }} shownPrice={shownPrice} onSubmitted={vi.fn()} onCancel={vi.fn()} />
      </WithRuntime>,
    )
    expect(await screen.findByText('Details')).toBeTruthy()
    expect(screen.getByText(/You pay 28 XRP/)).toBeTruthy()
    if (shownPrice) expect(screen.getByText(shownPrice)).toBeTruthy()
  })
})

describe('the review code does not know an estimate exists', () => {
  it.each(['lib/sign-review.ts', 'components/SignStep.tsx', 'components/SigningPrompt.tsx'])('%s mentions no fiat, USD or EC$', (file) => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8')
    expect(src).not.toMatch(/fiat|usd|xcd|EC\$|US\$/i)
  })
})
