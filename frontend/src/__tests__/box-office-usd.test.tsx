/**
 * A box office priced in US$ (item 1b-i), in the browser. Written before the change.
 *
 * The organizer sets the price in US$. Fans see that US$ price whatever XRP is doing. Paying in XRP is quoted when the
 * purchase starts and held for two minutes; with no fresh XRP price only "Pay with XRP" is unavailable, never the price.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CheckoutDialog } from '@/components/CheckoutDialog'
import { EventRow } from '@/components/EventRow'
import { OrganizerPanel } from '@/components/OrganizerPanel'
import type { EventSummary } from '@/lib/api'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const EVENT = (xrpPayable = true): EventSummary => ({
  slug: 'neon',
  title: 'Neon Rooftop Session',
  venue: null,
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  status: 'PUBLISHED',
  ticketCount: 100,
  ticketsMinted: 100,
  primaryPriceDrops: null,
  primaryFeeDrops: null,
  primaryAllInDrops: null,
  ticketsForSale: 12,
  organizer: { username: 'org', displayName: null },
  fiat: {},
  boxOffice: { currency: 'USD', priceMinor: '3500', feeMinor: '122', allInMinor: '3622', xrpPayable },
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the organizer sets the price in US$', () => {
  function mockApi() {
    const created: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/policy')) return json({ platformBps: 250, maxRoyaltyBps: 2000, looseResalePolicies: false })
      if (url.endsWith('/organizers/me')) return json({ role: 'ORGANIZER', application: null })
      if (url.endsWith('/events') && init?.method === 'POST') {
        created.push(JSON.parse(String(init.body)))
        return json({ slug: 'neon', title: 'Neon', startsAt: new Date().toISOString(), ticketCount: 100, royaltyBps: 500, platformBps: 250, nftTaxon: 1, resalePolicy: 'FACE_VALUE_ONLY', doorMode: 'QR' }, 201)
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))
    return created
  }
  const create = async (price: string) => {
    render(<StrictMode><OrganizerPanel role="ORGANIZER" onChanged={vi.fn()} /></StrictMode>)
    fireEvent.change(await screen.findByLabelText('event title'), { target: { value: 'Neon' } })
    fireEvent.change(screen.getByLabelText('starts at'), { target: { value: '2030-01-01T20:00' } })
    fireEvent.change(screen.getByLabelText('ticket price in US$'), { target: { value: price } })
    fireEvent.click(screen.getByRole('button', { name: /create event/i }))
  }

  it.each([
    ['35', '3500'],
    ['35.5', '3550'],
    ['35.50', '3550'],
    ['0.99', '99'],
  ])('"%s" is sent as %s US cents, and no XRP price', async (typed, cents) => {
    const created = mockApi()
    await create(typed)
    await waitFor(() => expect(created).toHaveLength(1))
    expect(created[0]).toMatchObject({ primaryPriceUsdCents: cents })
    expect(created[0]).not.toHaveProperty('primaryPriceDrops')
  })

  it.each(['35.555', '0', 'abc', '-5'])('refuses "%s" in words, and sends nothing', async (typed) => {
    const created = mockApi()
    await create(typed)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(created).toHaveLength(0)
  })

  it('does not offer a fixed resale cap with a US$ price (it is still in XRP until resale moves to US$)', async () => {
    mockApi()
    render(<StrictMode><OrganizerPanel role="ORGANIZER" onChanged={vi.fn()} /></StrictMode>)
    const policy = (await screen.findByLabelText('resale policy')) as HTMLSelectElement
    expect([...policy.options].map((o) => o.value)).toContain('FIXED_CAP')
    fireEvent.change(screen.getByLabelText('ticket price in US$'), { target: { value: '35' } })
    expect([...policy.options].map((o) => o.value)).not.toContain('FIXED_CAP')
  })
})

describe('the event row shows the US$ price whatever XRP is doing', () => {
  it.each([true, false])('XRP payable now: %s', (xrpPayable) => {
    const { container } = render(<ol><EventRow event={EVENT(xrpPayable)} live={false} onOpenAuction={vi.fn()} onBuy={vi.fn()} /></ol>)
    expect(screen.getByRole('button', { name: /buy a ticket to neon rooftop session for US\$36\.22/i })).toBeTruthy()
    expect(container.textContent).not.toMatch(/XRP|unavailable/i)
  })
})

describe('the checkout', () => {
  type Calls = { checkouts: number }
  function mockApi(opts: { checkout?: () => Response; polls?: unknown[] } = {}): Calls {
    const c = { checkouts: 0, polls: 0 }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/checkout') && init?.method === 'POST') {
        c.checkouts += 1
        return opts.checkout ? opts.checkout() : json(CREATED, 201)
      }
      if (/\/listings\/[^/]+$/.test(url)) {
        const polls = opts.polls ?? [{ state: 'buyer_pending' }]
        const p = polls[Math.min(c.polls++, polls.length - 1)] as Record<string, unknown>
        return json({ listingId: 'l-1', priceDrops: '28000000', platformFeeDrops: '980000', buyerPaysDrops: '28980000', seller: '@org', buyer: '@me', ticket: { nfTokenId: 'AB', seat: null, tier: null, event: { slug: 'neon', title: 'Neon' } }, ...p })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))
    return c
  }
  const CREATED = {
    listingId: 'l-1', uuid: '11111111-2222-4333-8444-555555555555', next: 'https://xaman.app/sign/z', qrPng: 'data:image/png;base64,AA==', mode: 'live',
    paysDrops: '28980000', expiresAt: new Date(Date.now() + 120_000).toISOString(),
    quote: { currency: 'USD', priceMinor: '3500', microUsdPerXrp: '1250000', rateAt: new Date().toISOString() },
    fiat: { paysDrops: { currency: 'USD', minor: '3622' } },
  }
  const open = (e: EventSummary) =>
    render(<StrictMode><CheckoutDialog event={e} open signedIn onOpenChange={vi.fn()} onSold={vi.fn()} /></StrictMode>)

  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))

  it('shows the US$ price and fee, and offers "Pay with XRP"', async () => {
    mockApi()
    open(EVENT())
    expect(await screen.findByText(/US\$36\.22 per ticket/)).toBeTruthy()
    expect(screen.getByText(/includes a US\$1\.22 HubWorld fee/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Pay with XRP' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('with no fresh XRP price: still the US$ price, and only "Pay with XRP" is unavailable, in words', async () => {
    const c = mockApi()
    open(EVENT(false))
    expect(await screen.findByText(/US\$36\.22 per ticket/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Pay with XRP' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('XRP payment unavailable right now')).toBeTruthy()
    expect(c.checkouts).toBe(0)
  })

  it('if the price goes stale between page and press, the server\'s refusal is shown the same way', async () => {
    mockApi({ checkout: () => json({ error: 'XRP payment unavailable right now', code: 'XRP_PRICE_UNAVAILABLE' }, 503) })
    open(EVENT())
    fireEvent.click(await screen.findByRole('button', { name: 'Pay with XRP' }))
    expect(await screen.findByText('XRP payment unavailable right now')).toBeTruthy()
  })

  it('says the XRP amount is held for two minutes', async () => {
    mockApi()
    open(EVENT())
    fireEvent.click(await screen.findByRole('button', { name: 'Pay with XRP' }))
    expect(await screen.findByText(/held for 2 minutes/i)).toBeTruthy()
  })

  it('when the two minutes pass: nothing was charged, and one press gets a new quote', async () => {
    const c = mockApi({ polls: [{ state: 'buyer_pending' }, { state: 'expired' }] })
    open(EVENT())
    fireEvent.click(await screen.findByRole('button', { name: 'Pay with XRP' }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await screen.findByText(/quote expired.*nothing was charged/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Get a new quote' }))
    await waitFor(() => expect(c.checkouts).toBe(2))
  })
})
