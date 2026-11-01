/**
 * Listing, buying, auctioning and withdrawing with a wallet the person owns. Written before the change.
 *
 * Every signing screen in the marketplace goes through the shared prompt, so each is checked the same way: the approval is
 * shown in plain words instead of a QR, and the review is told what THIS PAGE knows the person asked for (the price they
 * typed, the amount on the card they pressed), never a number taken from the server's reply. And a wallet that cannot pay
 * is told so, with its address, instead of a bare error.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SellPanel } from '@/components/SellPanel'
import { PolicyContext } from '@/lib/policy-context'
import { reviewer } from '@/lib/sign-review-loader'
import type { Policy } from '@/lib/api'
import { WALLET, WithRuntime, fakeRuntime, json } from './fakeRuntime'
import { priced } from './usd'

const BROKER = 'rBrokerAddress0000000000000000'
const NFT = '2222222222222222222222222222222222222222222222222222222222222222'
const review = vi.fn()

const TICKET = {
  nfTokenId: NFT, seat: null, tier: null, status: 'MINTED', syncedAt: new Date().toISOString(), onLedger: true,
  event: { slug: 'neon-rooftop-session', title: 'Neon Rooftop Session', startsAt: new Date().toISOString() },
  canAuction: true, auctionBlockedReason: null, faceValueDrops: null, resaleAllowed: true,
  maxListingPriceDrops: null, maxAuctionReserveDrops: null, resaleBlockedReason: null,
}
// US$ beside each amount, as the server sends it with a fresh price: fans see US$ only.
const listing = (over: Record<string, unknown> = {}) => priced({
  listingId: 'cccccccc-1111-4222-8333-444444444444', state: 'active',
  priceDrops: '10000000', platformFeeDrops: '500000', buyerPaysDrops: '10000000', feeModel: 'SELLER_PAYS_V2',
  seller: '@ayo', buyer: null,
  ticket: { nfTokenId: 'A'.repeat(64), seat: null, tier: null, event: { slug: 'neon-rooftop-session', title: 'Neon Rooftop Session' } },
  ...over,
})
const SIGN = (type = 'NFTokenCreateOffer') => ({ tx: { TransactionType: type, Account: WALLET.address }, hash: 'AB'.repeat(32), account: WALLET.address })
const created = (over: Record<string, unknown> = {}) => ({
  listingId: 'dddddddd-1111-4222-8333-444444444444', uuid: 'ffffffff-1111-4222-8333-444444444444',
  next: '', qrPng: '', mode: 'live', sign: SIGN(), ...over,
})

type Routes = Record<string, (init?: RequestInit) => Response>
function mockApi(routes: Routes = {}, extra: { market?: unknown[]; mine?: unknown[] } = {}) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url.replace(/^https?:\/\/[^/]+/, '')}`)
    for (const [pattern, handler] of Object.entries(routes)) {
      if (`${method} ${url}`.match(new RegExp(pattern))) return handler(init)
    }
    if (url.includes('/tickets/mine')) return json({ address: WALLET.address, verified: true, tickets: [TICKET] })
    if (url.includes('/listings/mine')) return json({ listings: extra.mine ?? [] })
    if (url.endsWith('/api/listings')) return json({ listings: extra.market ?? [] })
    if (url.match(/\/api\/listings\/[^/]+$/) && method === 'GET') return json(listing({ state: 'pending_offer' }))
    if (url.includes('/signatures/')) return json({ txid: 'T'.repeat(64), replay: false }, 202)
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
          <SellPanel onChanged={vi.fn()} />
        </WithRuntime>
      </PolicyContext.Provider>
    </StrictMode>,
  )
  return runtime
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.spyOn(reviewer, 'load').mockResolvedValue({ reviewSignRequest: (...a: unknown[]) => review(...a) } as never)
  review.mockResolvedValue({ ok: true, title: 'A plain summary', lines: ['It does what it says.'] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  review.mockReset()
})

describe('listing a ticket', () => {
  it('shows the approval in words (no QR), checked against the PRICE THE SELLER TYPED', async () => {
    mockApi({ 'POST .*/list$': () => json(created(), 201) })
    mount()
    fireEvent.change(await screen.findByLabelText('price in XRP'), { target: { value: '10' } })
    screen.getByRole('button', { name: /^List$/ }).click()

    expect(await screen.findByText('A plain summary')).toBeTruthy()
    expect(screen.queryByAltText(/qr/i)).toBeNull()
    expect(review).toHaveBeenCalledWith(
      SIGN(),
      expect.objectContaining({ broker: BROKER, action: { kind: 'list', askDrops: '10000000', label: 'Neon Rooftop Session' } }),
    )
  })

  it('is checked against what the seller TYPED even when the server\u2019s reply claims a different price', async () => {
    mockApi({ 'POST .*/list$': () => json(created({ priceDrops: '99000000' }), 201) })
    mount()
    fireEvent.change(await screen.findByLabelText('price in XRP'), { target: { value: '10' } })
    screen.getByRole('button', { name: /^List$/ }).click()
    await screen.findByText('A plain summary')
    expect(review).toHaveBeenCalledWith(SIGN(), expect.objectContaining({ action: expect.objectContaining({ kind: 'list', askDrops: '10000000' }) }))
  })

  it('a Xaman seller still gets the QR and no approval screen', async () => {
    mockApi({ 'POST .*/list$': () => json(created({ sign: undefined, qrPng: 'data:image/png;base64,CCCC', next: 'https://xaman.app/sign/z' }), 201) })
    mount()
    fireEvent.change(await screen.findByLabelText('price in XRP'), { target: { value: '10' } })
    screen.getByRole('button', { name: /^List$/ }).click()
    expect(await screen.findByAltText('Xaman signing QR code')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(review).not.toHaveBeenCalled()
  })

  it('approving sends only the signature and says it is waiting for the network', async () => {
    const calls = mockApi({ 'POST .*/list$': () => json(created(), 201) })
    mount()
    fireEvent.change(await screen.findByLabelText('price in XRP'), { target: { value: '10' } })
    screen.getByRole('button', { name: /^List$/ }).click()
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    expect(await screen.findByText(/approved\. waiting for the network/i)).toBeTruthy()
    expect(calls.some((c) => c.startsWith('POST /api/signatures/'))).toBe(true)
  })
})

describe('opening an auction', () => {
  it('is checked against the RESERVE the seller typed', async () => {
    mockApi({
      'POST .*/auction$': () =>
        json({ auctionId: 'a1', listingId: 'dddddddd-1111-4222-8333-444444444444', uuid: 'u', next: '', qrPng: '', mode: 'live', reserveDrops: '20000000', sellOfferDrops: '19000000', endsAt: new Date().toISOString(), sign: SIGN() }, 201),
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /auction instead/i }))
    fireEvent.change(await screen.findByLabelText('reserve in XRP'), { target: { value: '20' } })
    screen.getByRole('button', { name: /^Open$/ }).click()
    expect(await screen.findByText('A plain summary')).toBeTruthy()
    expect(review).toHaveBeenCalledWith(
      SIGN(),
      expect.objectContaining({ action: { kind: 'auction', reserveDrops: '20000000', label: 'Neon Rooftop Session' } }),
    )
  })
})

describe('buying from the marketplace', () => {
  it('is checked against the amount on the card the buyer PRESSED, not the amount in the server’s reply', async () => {
    // The server's reply claims a different "paysDrops": it is never what the review is told.
    mockApi({ 'POST .*/buy$': () => json(created({ paysDrops: '99000000' }), 201) }, { market: [listing()] })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /^Buy Neon Rooftop Session for US\$10\.00$/ }))
    expect(await screen.findByText('A plain summary')).toBeTruthy()
    expect(review).toHaveBeenCalledWith(
      SIGN(),
      expect.objectContaining({ broker: BROKER, action: { kind: 'buy', amountDrops: '10000000', label: 'Neon Rooftop Session' } }),
    )
  })

  it('a wallet that cannot pay sees its address and the amount, and the sale is still on the shelf', async () => {
    mockApi(
      {
        'POST .*/buy$': () =>
          json({ error: 'Your wallet needs more XRP before it can pay for this.', code: 'WALLET_NEEDS_FUNDS', address: 'rEmptyWallet000000000000000000', network: 'testnet', neededDrops: '11300000', haveDrops: '0', canFund: true }, 409),
      },
      { market: [listing()] },
    )
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /^Buy Neon Rooftop Session for US\$10\.00$/ }))
    expect(await screen.findByText('rEmptyWallet000000000000000000')).toBeTruthy()
    expect(screen.getByText(/needs about 11\.3 XRP/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /get test xrp/i })).toBeTruthy()
  })

  it('"try again" after funding buys the same listing again', async () => {
    let n = 0
    const calls = mockApi(
      {
        'POST .*/buy$': () => {
          n += 1
          return n === 1
            ? json({ error: 'x', code: 'WALLET_NEEDS_FUNDS', address: 'rEmptyWallet000000000000000000', network: 'mainnet', neededDrops: '11300000', haveDrops: '0', canFund: false }, 409)
            : json(created(), 201)
        },
      },
      { market: [listing()] },
    )
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /^Buy Neon Rooftop Session for US\$10\.00$/ }))
    fireEvent.click(await screen.findByRole('button', { name: /check again/i }))
    expect(await screen.findByText('A plain summary')).toBeTruthy()
    expect(calls.filter((c) => c.includes('/buy'))).toHaveLength(2)
  })
})

describe('taking a listing off sale', () => {
  it('shows the withdrawal in words, checked as a withdrawal', async () => {
    mockApi(
      { 'POST .*/cancel$': () => json(created({ sign: SIGN('NFTokenCancelOffer') }), 201) },
      { mine: [listing({ role: 'seller' })] },
    )
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /withdraw/i }))
    expect(await screen.findByText('A plain summary')).toBeTruthy()
    await waitFor(() =>
      expect(review).toHaveBeenCalledWith(SIGN('NFTokenCancelOffer'), expect.objectContaining({ action: { kind: 'withdraw', label: 'Neon Rooftop Session' } })),
    )
  })
})
