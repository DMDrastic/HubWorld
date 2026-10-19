/**
 * The box-office dialog. Rendered in <StrictMode> like every polling loop here.
 *
 * Pinned beyond the happy path:
 *   - nothing is held until the button is pressed;
 *   - the amount the buyer will sign for is shown BEFORE they scan;
 *   - pacing, by COUNTING requests;
 *   - every refusal is shown in the server's own words, and a hold that lapses
 *     says nothing was charged.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { CheckoutDialog } from '@/components/CheckoutDialog'
import type { EventSummary } from '@/lib/api'

const EVENT: EventSummary = {
  slug: 'neon-rooftop-session',
  title: 'Neon Rooftop Session',
  venue: 'Hub World',
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  status: 'PUBLISHED',
  ticketCount: 100,
  ticketsMinted: 100,
  primaryPriceDrops: '25000000',
  ticketsForSale: 12,
  organizer: { username: 'dm_drastic', displayName: null },
}

const CREATED = {
  listingId: 'l-1',
  uuid: '11111111-2222-4333-8444-555555555555',
  next: 'https://xaman.app/sign/z',
  qrPng: 'data:image/png;base64,DDDD',
  mode: 'live' as const,
  paysDrops: '25625000',
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
}

const listing = (state: string, extra: object = {}) => ({
  listingId: 'l-1',
  state,
  priceDrops: '25000000',
  platformFeeDrops: '625000',
  buyerPaysDrops: '25625000',
  seller: '@org',
  buyer: '@me',
  ticket: { nfTokenId: 'AB', seat: null, tier: null, event: { slug: EVENT.slug, title: EVENT.title } },
  ...extra,
})

type Calls = { checkouts: number; polls: number }

function mockApi(opts: { checkout?: unknown; checkoutStatus?: number; polls?: unknown[] }): Calls {
  const c: Calls = { checkouts: 0, polls: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

      if (url.endsWith('/checkout') && method === 'POST') {
        c.checkouts += 1
        return json(opts.checkout ?? CREATED, opts.checkoutStatus ?? 201)
      }
      if (method === 'GET' && /\/listings\/[^/]+$/.test(url)) {
        const polls = opts.polls ?? [listing('buyer_pending')]
        const body = polls[Math.min(c.polls, polls.length - 1)]
        c.polls += 1
        return json(body)
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    }),
  )
  return c
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const renderDialog = (over: Partial<{ signedIn: boolean; onSold: () => void }> = {}) =>
  render(
    <StrictMode>
      <CheckoutDialog
        event={EVENT}
        open={true}
        signedIn={over.signedIn ?? true}
        onOpenChange={vi.fn()}
        onSold={over.onSold ?? vi.fn()}
      />
    </StrictMode>,
  )

const press = async () => (await screen.findByRole('button', { name: /buy a ticket for 25 xrp/i })).click()

describe('CheckoutDialog', () => {
  it('holds nothing until the button is pressed, and says what pressing does', async () => {
    const calls = mockApi({})
    renderDialog()

    expect(await screen.findByText(/holds one ticket for you/i)).toBeTruthy()
    expect(screen.getByText(/25 XRP per ticket/i)).toBeTruthy()
    expect(calls.checkouts).toBe(0)
  })

  it('asks a signed-out visitor to sign in instead of offering the button', async () => {
    const calls = mockApi({})
    renderDialog({ signedIn: false })

    expect(await screen.findByText(/sign in to buy a ticket/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /buy a ticket/i })).toBeNull()
    expect(calls.checkouts).toBe(0)
  })

  it('shows the exact amount to sign for BEFORE the buyer scans, and that the ticket is held', async () => {
    mockApi({})
    renderDialog()

    await press()

    expect(await screen.findByAltText(/purchase qr/i)).toBeTruthy()
    // 25 XRP + the 2.5% fee, in drops-exact terms.
    expect(screen.getByText(/pay 25\.625 xrp/i)).toBeTruthy()
    expect(screen.getByText(/held for a few minutes/i)).toBeTruthy()
    expect(screen.getByText(/nothing is charged/i)).toBeTruthy()
  })

  it('walks from signing to settling to sold, and tells the page', async () => {
    const onSold = vi.fn()
    mockApi({ polls: [listing('buyer_pending'), listing('settling'), listing('sold')] })
    renderDialog({ onSold })

    await press()
    await screen.findByAltText(/purchase qr/i)

    await vi.advanceTimersByTimeAsync(2600) // first poll: still waiting for the signature
    await vi.advanceTimersByTimeAsync(2600) // second poll: signed, settling
    expect(await screen.findByText(/completing your purchase/i)).toBeTruthy()
    expect(screen.queryByAltText(/purchase qr/i)).toBeNull()

    await vi.advanceTimersByTimeAsync(2600)
    expect(await screen.findByText(/the ticket is yours/i)).toBeTruthy()
    await waitFor(() => expect(onSold).toHaveBeenCalled())
  })

  it('polls at the pace it claims, and stops when the purchase is over', async () => {
    const calls = mockApi({ polls: [listing('buyer_pending')] })
    renderDialog()

    await press()
    await screen.findByAltText(/purchase qr/i)
    await vi.advanceTimersByTimeAsync(10_000)

    // 10s at a 2.5s cadence: about four polls. A loop keyed on results would
    // fire an order of magnitude more.
    expect(calls.polls).toBeGreaterThanOrEqual(3)
    expect(calls.polls).toBeLessThanOrEqual(6)
  })

  it('stops polling once sold', async () => {
    const calls = mockApi({ polls: [listing('sold')] })
    renderDialog()

    await press()
    await vi.advanceTimersByTimeAsync(2600)
    await screen.findByText(/the ticket is yours/i)
    const after = calls.polls
    await vi.advanceTimersByTimeAsync(15_000)
    expect(calls.polls).toBe(after)
  })

  it('says nothing was charged when the hold lapses', async () => {
    mockApi({ polls: [listing('cancelled')] })
    renderDialog()

    await press()
    await vi.advanceTimersByTimeAsync(2600)

    expect(await screen.findByText(/hold ran out/i)).toBeTruthy()
    expect(screen.getByText(/nothing was charged/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /back/i })).toBeTruthy()
  })

  it('shows a refusal in the server\'s own words', async () => {
    mockApi({ checkout: { error: 'Sold out', code: 'SOLD_OUT' }, checkoutStatus: 409 })
    renderDialog()

    await press()

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Sold out')).toBeTruthy()
  })

  it('explains an unfinished earlier purchase instead of starting a second', async () => {
    mockApi({
      checkout: { error: 'You already have a purchase in progress for this event', code: 'IN_PROGRESS', listingId: 'l-0' },
      checkoutStatus: 409,
    })
    renderDialog()

    await press()

    expect(await screen.findByText(/already have a purchase in progress/i)).toBeTruthy()
    expect(screen.queryByAltText(/purchase qr/i)).toBeNull()
  })

  it('surfaces a failed purchase\'s reason', async () => {
    mockApi({ polls: [listing('failed', { reason: 'The ledger rejected the bid' })] })
    renderDialog()

    await press()
    await vi.advanceTimersByTimeAsync(2600)

    expect(await screen.findByText(/the ledger rejected the bid/i)).toBeTruthy()
  })
})
