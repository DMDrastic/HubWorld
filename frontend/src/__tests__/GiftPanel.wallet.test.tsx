/**
 * Giving, accepting and taking back a ticket with a wallet the person owns. Written before the change.
 *
 * Each goes through the shared approval screen instead of a QR, and the review is told what THIS page knows: the handle the giver
 * typed, the gift the recipient pressed Accept on. If the server names a different recipient than the one typed, nothing is sent
 * for approval at all.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GiftPanel } from '@/components/GiftPanel'
import { PolicyContext } from '@/lib/policy-context'
import { reviewer } from '@/lib/sign-review-loader'
import type { Policy } from '@/lib/api'
import { WALLET, WithRuntime, fakeRuntime, json } from './fakeRuntime'

const NFT = '00081388E82223A2A5150D5AADF7D8E5F5E3AC44D31AB0D402ACCC570127D521'
const FRIEND = 'rFriendWallet00000000000000000'
const OFFER = 'AD'.repeat(32)
const review = vi.fn()

const TICKET = {
  nfTokenId: NFT, seat: null, tier: null, status: 'MINTED', syncedAt: new Date().toISOString(), onLedger: true,
  event: { slug: 'neon', title: 'Neon Rooftop Session', startsAt: new Date(Date.now() + 864e5).toISOString() },
  canAuction: false, auctionBlockedReason: null, faceValueDrops: null, resaleAllowed: true,
  maxListingPriceDrops: null, maxAuctionReserveDrops: null, resaleBlockedReason: null,
}
const GIFT_TICKET = { nfTokenId: NFT, seat: null, tier: null, event: { slug: 'neon', title: 'Neon Rooftop Session' } }
const SIGN = (type: string) => ({ tx: { TransactionType: type, Account: WALLET.address }, hash: 'AB'.repeat(32), account: WALLET.address })
const created = (over: Record<string, unknown> = {}) => ({
  giftId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', uuid: 'ffffffff-1111-4222-8333-444444444444', next: '', qrPng: '', mode: 'live', ...over,
})
const item = (over: Record<string, unknown> = {}) => ({
  giftId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', state: 'offered', from: '@giver', to: '@me', expiresAt: new Date(Date.now() + 1e6).toISOString(), ticket: GIFT_TICKET, ...over,
})

function mockApi(routes: Record<string, () => Response>, lists: { incoming?: unknown[]; outgoing?: unknown[] } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    for (const [pattern, handler] of Object.entries(routes)) if (`${method} ${url}`.match(new RegExp(pattern))) return handler()
    if (url.includes('/tickets/mine')) return json({ address: WALLET.address, verified: true, tickets: [TICKET] })
    if (url.includes('role=incoming')) return json({ gifts: lists.incoming ?? [] })
    if (url.includes('role=outgoing')) return json({ gifts: lists.outgoing ?? [] })
    if (url.match(/\/api\/gifts\/[^/?]+$/) && method === 'GET') return json({ state: 'pending_offer', giftId: 'x', role: 'sender', from: '@me', to: '@friend', ticket: GIFT_TICKET })
    if (url.includes('/signatures/')) return json({ txid: 'T'.repeat(64), replay: false }, 202)
    throw new Error(`unexpected fetch: ${method} ${url}`)
  }))
}

function mount() {
  render(
    <StrictMode>
      <PolicyContext.Provider value={{ platformBps: 250, maxRoyaltyBps: 2000, brokerAddress: 'rBroker' } as Policy}>
        <WithRuntime runtime={fakeRuntime()}>
          <GiftPanel onChanged={vi.fn()} />
        </WithRuntime>
      </PolicyContext.Provider>
    </StrictMode>,
  )
}
async function give(handle = '@Friend') {
  fireEvent.change(await screen.findByLabelText(/recipient handle/i), { target: { value: handle } })
  fireEvent.click(screen.getByRole('button', { name: /^gift$/i }))
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

describe('giving a ticket', () => {
  it('shows the approval in words, checked against the person the giver TYPED and the wallet looked up for them', async () => {
    mockApi({ 'POST .*/gift$': () => json(created({ sign: SIGN('NFTokenCreateOffer'), to: { username: 'friend', xrplAddress: FRIEND } }), 201) })
    mount()
    await give('@Friend')
    expect(await screen.findByText('A plain summary')).toBeTruthy()
    expect(screen.queryByAltText(/qr/i)).toBeNull()
    expect(review).toHaveBeenCalledWith(
      SIGN('NFTokenCreateOffer'),
      expect.objectContaining({ action: { kind: 'gift', recipientAddress: FRIEND, recipientHandle: 'friend', label: 'Neon Rooftop Session' } }),
    )
  })

  it('if the server names a DIFFERENT person than the one typed, nothing goes for approval', async () => {
    mockApi({ 'POST .*/gift$': () => json(created({ sign: SIGN('NFTokenCreateOffer'), to: { username: 'mallory', xrplAddress: 'rMallory000000000000000000000' } }), 201) })
    mount()
    await give('@friend')
    expect(await screen.findByText(/different person/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(review).not.toHaveBeenCalled()
  })

  it('if the server does not say who the gift is for, nothing goes for approval', async () => {
    mockApi({ 'POST .*/gift$': () => json(created({ sign: SIGN('NFTokenCreateOffer') }), 201) })
    mount()
    await give('@friend')
    expect(await screen.findByText(/could not confirm who/i)).toBeTruthy()
    expect(review).not.toHaveBeenCalled()
  })

  it('a Xaman giver still gets the QR', async () => {
    mockApi({ 'POST .*/gift$': () => json(created({ qrPng: 'data:image/png;base64,CCCC', next: 'https://xaman.app/sign/z' }), 201) })
    mount()
    await give('@friend')
    expect(await screen.findByAltText(/signing qr/i)).toBeTruthy()
    expect(review).not.toHaveBeenCalled()
  })

  it('a wallet that cannot carry the offer is told so, with its address', async () => {
    mockApi({
      'POST .*/gift$': () =>
        json({ error: 'Your wallet needs more XRP before it can pay for this.', code: 'WALLET_NEEDS_FUNDS', address: 'rEmptyWallet000000000000000000', network: 'testnet', neededDrops: '300000', haveDrops: '0', canFund: true }, 409),
    })
    mount()
    await give('@friend')
    expect(await screen.findByText('rEmptyWallet000000000000000000')).toBeTruthy()
  })
})

describe('accepting a ticket someone gave you', () => {
  it('checks the accept against THE gift pressed: its offer, who it is from, what it is for', async () => {
    mockApi({ 'POST .*/accept$': () => json(created({ sign: SIGN('NFTokenAcceptOffer'), offer: { index: OFFER } }), 201) }, { incoming: [item()] })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(await screen.findByText('A plain summary')).toBeTruthy()
    expect(review).toHaveBeenCalledWith(
      SIGN('NFTokenAcceptOffer'),
      expect.objectContaining({ action: { kind: 'acceptGift', offerIndex: OFFER, fromHandle: '@giver', label: 'Neon Rooftop Session' } }),
    )
  })

  it('a new wallet that cannot hold the ticket yet sees its address and the faucet, and "try again" accepts the same gift', async () => {
    let n = 0
    mockApi(
      {
        'POST .*/accept$': () => {
          n += 1
          return n === 1
            ? json({ error: 'x', code: 'WALLET_NEEDS_FUNDS', address: 'rNewWallet0000000000000000000', network: 'testnet', neededDrops: '1300000', haveDrops: '0', canFund: true }, 409)
            : json(created({ sign: SIGN('NFTokenAcceptOffer'), offer: { index: OFFER } }), 201)
        },
        'POST .*/wallet/fund$': () => json({ ok: true, amountXrp: 100 }),
        // The faucet's XRP has landed: the way on opens only once the ledger shows it.
        'GET .*/wallet/status$': () =>
          json({ address: 'rNewWallet0000000000000000000', network: 'testnet', exists: true, balanceDrops: '100000000', spendableDrops: '99000000', activationDrops: '1000000', canFund: true, signer: 'PRIVY' }),
      },
      { incoming: [item()] },
    )
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(await screen.findByText('rNewWallet0000000000000000000')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /get test xrp/i }))
    await screen.findByText(/on its way/i)
    await vi.advanceTimersByTimeAsync(2_500)
    fireEvent.click(await screen.findByRole('button', { name: /^continue$/i }))
    expect(await screen.findByText('A plain summary')).toBeTruthy()
    await waitFor(() => expect(n).toBe(2))
  })
})

describe('taking back a gift', () => {
  it('is checked as taking back that gift', async () => {
    mockApi({ 'POST .*/cancel$': () => json(created({ sign: SIGN('NFTokenCancelOffer') }), 201) }, { outgoing: [item({ from: '@me', to: '@friend' })] })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }))
    expect(await screen.findByText('A plain summary')).toBeTruthy()
    expect(review).toHaveBeenCalledWith(SIGN('NFTokenCancelOffer'), expect.objectContaining({ action: { kind: 'cancelGift', label: 'Neon Rooftop Session' } }))
  })
})
