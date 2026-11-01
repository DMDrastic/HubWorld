/**
 * Bidding with a wallet the person owns, and bidding with a wallet that cannot pay. Written before the change.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BidForm } from '@/components/BidForm'
import { PolicyContext } from '@/lib/policy-context'
import { reviewer } from '@/lib/sign-review-loader'
import type { Auction, Policy } from '@/lib/api'
import { WALLET, WithRuntime, fakeRuntime, json } from './fakeRuntime'

const XRP = 1_000_000
const NOW = Date.now()
const BROKER = 'rBrokerAddress0000000000000000'
const review = vi.fn()

const AUCTION: Auction = {
  id: 'auction-1', eventTitle: 'Neon Rooftop Session', eventSlug: 'neon-rooftop-session', state: 'live',
  startsAt: new Date(NOW - 3_600_000).toISOString(), endsAt: new Date(NOW + 1_200_000).toISOString(),
  reserveDrops: String(12 * XRP), maxBidDrops: null, ticket: { nfTokenId: 'A'.repeat(64), seat: null, tier: null }, bids: [],
}
const SIGN = { tx: { TransactionType: 'NFTokenCreateOffer', Account: WALLET.address }, hash: 'AB'.repeat(32), account: WALLET.address }
const created = (extra: Record<string, unknown> = {}) => ({
  bidId: 'bid-1', uuid: 'a-uuid', next: '', qrPng: '', mode: 'live', amountDrops: String(20 * XRP), sign: SIGN, ...extra,
})

function mockApi(bidResponses: Array<{ body: unknown; status: number }>) {
  const calls = { bids: 0, signatures: 0 }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    if (url.includes('/signatures/') && method === 'POST') {
      calls.signatures += 1
      return json({ txid: 'T'.repeat(64), replay: false }, 202)
    }
    if (url.includes('/bid') && method === 'POST') {
      const r = bidResponses[Math.min(calls.bids, bidResponses.length - 1)]!
      calls.bids += 1
      return json(r.body, r.status)
    }
    if (url.match(/\/api\/bids\/[^/]+$/)) return json({ bidId: 'bid-1', state: 'pending', amountDrops: String(20 * XRP), bidder: '@me' })
    throw new Error(`unexpected fetch: ${method} ${url}`)
  }))
  return calls
}

function mount() {
  const runtime = fakeRuntime()
  render(
    <StrictMode>
      <PolicyContext.Provider value={{ platformBps: 250, maxRoyaltyBps: 2000, brokerAddress: BROKER } as Policy}>
        <WithRuntime runtime={runtime}>
          <BidForm auction={AUCTION} onPlaced={vi.fn()} />
        </WithRuntime>
      </PolicyContext.Provider>
    </StrictMode>,
  )
}
async function bid(amount = '20') {
  fireEvent.change(screen.getByLabelText(/bid amount in XRP/i), { target: { value: amount } })
  fireEvent.click(screen.getByRole('button', { name: 'Bid' }))
}

beforeEach(() => {
  vi.spyOn(reviewer, 'load').mockResolvedValue({ reviewSignRequest: (...a: unknown[]) => review(...a) } as never)
  review.mockResolvedValue({ ok: true, title: 'Bid 20 XRP on a ticket to Neon Rooftop Session', lines: ['You offer 20 XRP.'] })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  review.mockReset()
})

describe('a bid with a wallet the person owns', () => {
  it('shows the approval in words instead of a QR, checked against the amount the bidder TYPED', async () => {
    // The server's reply claims a different amount: it is never what the review is told.
    mockApi([{ body: created({ amountDrops: String(30 * XRP) }), status: 201 }])
    mount()
    await bid('20')

    expect(await screen.findByText('Bid 20 XRP on a ticket to Neon Rooftop Session')).toBeTruthy()
    expect(screen.queryByAltText(/qr/i)).toBeNull()
    expect(review).toHaveBeenCalledWith(
      SIGN,
      expect.objectContaining({ broker: BROKER, action: { kind: 'bid', amountDrops: '20000000', label: 'Neon Rooftop Session' } }),
    )
  })

  it('still shows the warning about a bid with little behind it, BEFORE it is approved', async () => {
    mockApi([{ body: created({ tight: true, afterBidDrops: String(1 * XRP) }), status: 201 }])
    mount()
    await bid()
    expect(await screen.findByText(/leaves 1 XRP spendable/i)).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeTruthy()
  })

  it('approving sends only the signature', async () => {
    const calls = mockApi([{ body: created(), status: 201 }])
    mount()
    await bid()
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(calls.signatures).toBe(1))
  })

  it('a Xaman bidder still gets the QR', async () => {
    mockApi([{ body: created({ sign: undefined, qrPng: 'https://xumm.app/sign/x.png', next: 'https://xumm.app/sign/x' }), status: 201 }])
    mount()
    await bid()
    expect(await screen.findByAltText('Xaman bid QR code')).toBeTruthy()
    expect(review).not.toHaveBeenCalled()
  })
})

describe('a bid from a wallet that cannot pay', () => {
  const NEEDS = {
    error: 'Your wallet needs more XRP before it can pay for this.', code: 'WALLET_NEEDS_FUNDS',
    address: 'rEmptyWallet000000000000000000', network: 'testnet', neededDrops: '21300000', haveDrops: '0', canFund: true,
  }

  it('shows the wallet’s address and what it needs, with test XRP on testnet', async () => {
    mockApi([{ body: NEEDS, status: 409 }])
    mount()
    await bid()
    expect(await screen.findByText('rEmptyWallet000000000000000000')).toBeTruthy()
    expect(screen.getByText(/needs about 21\.3 XRP/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /get test xrp/i })).toBeTruthy()
  })

  it('also for a wallet that exists but is short (the older 400), so the person is never left with a bare error', async () => {
    mockApi([{ body: { ...NEEDS, error: 'Your spendable balance is below this bid', haveDrops: '5000000' }, status: 400 }])
    mount()
    await bid()
    expect(await screen.findByText(/has 5 XRP/i)).toBeTruthy()
  })

  it('"try again" places the SAME bid again, and this time the approval appears', async () => {
    const calls = mockApi([{ body: { ...NEEDS, network: 'mainnet', canFund: false }, status: 409 }, { body: created(), status: 201 }])
    mount()
    await bid('20')
    fireEvent.click(await screen.findByRole('button', { name: /check again/i }))
    expect(await screen.findByText('Bid 20 XRP on a ticket to Neon Rooftop Session')).toBeTruthy()
    expect(calls.bids).toBe(2)
  })
})
