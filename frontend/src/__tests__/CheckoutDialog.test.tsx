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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CheckoutDialog } from '@/components/CheckoutDialog'
import { PolicyContext } from '@/lib/policy-context'
import { reviewer } from '@/lib/sign-review-loader'
import type { EventSummary, Policy } from '@/lib/api'
import { WALLET, WithRuntime, fakeRuntime } from './fakeRuntime'
import { priced } from './usd'

// US$ beside each amount, as the server sends it with a fresh price: fans see US$ only.
const EVENT: EventSummary = priced({
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
})

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

type Calls = { checkouts: number; polls: number; signatures: unknown[] }

function mockApi(opts: { checkout?: unknown; checkoutStatus?: number; polls?: unknown[]; checkouts?: Array<{ body: unknown; status: number }> }): Calls {
  const c: Calls = { checkouts: 0, polls: 0, signatures: [] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

      if (url.includes('/signatures/') && method === 'POST') {
        c.signatures.push(JSON.parse(String(init?.body)))
        return json({ txid: 'T'.repeat(64), replay: false }, 202)
      }
      if (url.endsWith('/checkout') && method === 'POST') {
        c.checkouts += 1
        const queued = opts.checkouts?.[Math.min(c.checkouts - 1, opts.checkouts.length - 1)]
        if (queued) return json(queued.body, queued.status)
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

const press = async () => (await screen.findByRole('button', { name: /buy a ticket for US\$25\.00/i })).click()

describe('CheckoutDialog', () => {
  it('holds nothing until the button is pressed, and says what pressing does', async () => {
    const calls = mockApi({})
    renderDialog()

    expect(await screen.findByText(/holds one ticket for you/i)).toBeTruthy()
    expect(screen.getByText(/US\$25\.00 per ticket/i)).toBeTruthy()
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
    // On the Xaman path the exact amount being signed is named beside the QR (Xaman shows it too). Fans see US$ elsewhere.
    expect(screen.getByText('Scan in Xaman to approve. Exact amount: 25.625 XRP.')).toBeTruthy()
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


// ------------------------------------------------- a wallet the person owns --

const BROKER = 'rBrokerAddress0000000000000000'
const OWN_SIGN = { tx: { TransactionType: 'NFTokenCreateOffer', Account: WALLET.address }, hash: 'AB'.repeat(32), account: WALLET.address }
const OWN_CREATED = { ...CREATED, qrPng: '', next: '', sign: OWN_SIGN }
const review = vi.fn()

function renderOwn(over: { onSold?: () => void } = {}) {
  const runtime = fakeRuntime()
  render(
    <StrictMode>
      <PolicyContext.Provider value={{ platformBps: 250, maxRoyaltyBps: 2000, brokerAddress: BROKER } as Policy}>
        <WithRuntime runtime={runtime}>
          <CheckoutDialog event={EVENT} open signedIn onOpenChange={vi.fn()} onSold={over.onSold ?? vi.fn()} />
        </WithRuntime>
      </PolicyContext.Provider>
    </StrictMode>,
  )
  return runtime
}

describe('CheckoutDialog with a wallet the person owns', () => {
  beforeEach(() => {
    vi.spyOn(reviewer, 'load').mockResolvedValue({ reviewSignRequest: (...a: unknown[]) => review(...a) } as never)
    review.mockResolvedValue({ ok: true, title: 'Buy 1 ticket to Neon Rooftop Session for 25.625 XRP', lines: ['You pay 25.625 XRP.'] })
  })
  afterEach(() => review.mockReset())

  it('shows the plain-words approval instead of a QR, checked against the price the buyer was shown', async () => {
    mockApi({ checkout: OWN_CREATED })
    renderOwn()
    await press()

    expect(await screen.findByText('Buy 1 ticket to Neon Rooftop Session for 25.625 XRP')).toBeTruthy()
    expect(screen.queryByAltText(/purchase qr/i)).toBeNull()
    expect(screen.queryByText(/scan in xaman/i)).toBeNull()
    // The review was told exactly what this page showed: the all-in amount from the checkout, and the event.
    expect(review).toHaveBeenCalledWith(
      OWN_SIGN,
      expect.objectContaining({ broker: BROKER, action: { kind: 'buy', amountDrops: '25625000', label: 'Neon Rooftop Session' } }),
    )
  })

  it('approving sends the signature, waits for the network, and then walks to sold like any purchase', async () => {
    const onSold = vi.fn()
    const calls = mockApi({ checkout: OWN_CREATED, polls: [listing('buyer_pending'), listing('sold')] })
    const runtime = renderOwn({ onSold })
    await press()

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(calls.signatures).toEqual([{ signature: 'ab'.repeat(64) }]))
    expect(runtime.calls.signHash).toEqual([[WALLET.address, OWN_SIGN.hash]])
    expect(await screen.findByText(/approved\. waiting for the network/i)).toBeTruthy()

    await vi.advanceTimersByTimeAsync(2600)
    await vi.advanceTimersByTimeAsync(2600)
    expect(await screen.findByText(/the ticket is yours/i)).toBeTruthy()
    await waitFor(() => expect(onSold).toHaveBeenCalled())
  })

  it('a refused review leaves no way to approve', async () => {
    review.mockResolvedValue({ ok: false, reason: 'The amount is not what was shown to you, so we won’t ask you to approve it.' })
    const calls = mockApi({ checkout: OWN_CREATED })
    renderOwn()
    await press()
    expect(await screen.findByText(/not what was shown to you/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(calls.signatures).toHaveLength(0)
  })
})

describe('CheckoutDialog when the wallet cannot pay', () => {
  const NEEDS = {
    error: 'Your wallet needs more XRP before it can pay for this.',
    code: 'WALLET_NEEDS_FUNDS',
    address: 'rEmptyWallet000000000000000000',
    network: 'testnet',
    neededDrops: '27175000',
    haveDrops: '0',
    canFund: true,
  }

  it('shows the wallet\'s address and what it needs, instead of a bare error, and offers test XRP on testnet', async () => {
    const calls = mockApi({ checkouts: [{ body: NEEDS, status: 409 }] })
    renderDialog()
    await press()

    expect(await screen.findByText('rEmptyWallet000000000000000000')).toBeTruthy()
    expect(screen.getByText(/needs about 27\.175 XRP/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /get test xrp/i })).toBeTruthy()
    expect(calls.checkouts).toBe(1)
  })

  it('on mainnet there is no test XRP button, only the instruction', async () => {
    mockApi({ checkouts: [{ body: { ...NEEDS, network: 'mainnet', canFund: false }, status: 409 }] })
    renderDialog()
    await press()
    expect(await screen.findByText(/send at least 27\.175 XRP to this address/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /get test xrp/i })).toBeNull()
  })

  it('"check again" starts the purchase again, and this time it goes through', async () => {
    const calls = mockApi({ checkouts: [{ body: { ...NEEDS, network: 'mainnet', canFund: false }, status: 409 }, { body: CREATED, status: 201 }] })
    renderDialog()
    await press()
    fireEvent.click(await screen.findByRole('button', { name: /check again/i }))
    expect(await screen.findByAltText(/purchase qr/i)).toBeTruthy()
    expect(calls.checkouts).toBe(2)
  })
})
