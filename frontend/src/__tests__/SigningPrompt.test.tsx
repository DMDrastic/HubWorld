/**
 * One component decides how a person approves: in their browser if the wallet is theirs, or by QR in Xaman. Written before the code.
 *
 * The review itself is pinned in sign-review.actions.test.ts; here it is a controlled input, so what is under test is the
 * CHOICE and the hand-off: a request with a transaction to approve never shows a QR, one without never shows the approve
 * screen, HubWorld's broker comes from the policy (not from the request), and a refused review leaves no way to approve.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const review = vi.fn()

import { SigningPrompt } from '@/components/SigningPrompt'
import { PolicyContext } from '@/lib/policy-context'
import { reviewer } from '@/lib/sign-review-loader'
import type { Policy } from '@/lib/api'
import { WALLET, WithRuntime, fakeRuntime, json } from './fakeRuntime'

const BROKER = 'rBrokerAddress0000000000000000'
const policy = (over: Partial<Policy> = {}): Policy => ({ platformBps: 250, maxRoyaltyBps: 2000, brokerAddress: BROKER, ...over }) as Policy

const SIGN = { tx: { TransactionType: 'NFTokenCreateOffer', Account: WALLET.address }, hash: 'AB'.repeat(32), account: WALLET.address }
const QR = { uuid: '11111111-2222-4333-8444-555555555555', next: 'https://xumm.app/sign/x', qrPng: 'data:image/png;base64,AAAA', mode: 'live' as const }
const OK = { ok: true as const, title: 'Buy 1 ticket to Neon Night for 10 XRP', lines: ['You pay 10 XRP.'] }
const ACTION = { kind: 'buy' as const, amountDrops: '10000000', label: 'Neon Night' }

beforeEach(() => {
  vi.spyOn(reviewer, 'load').mockResolvedValue({ reviewSignRequest: (...a: unknown[]) => review(...a) } as never)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  review.mockReset()
})

function mount(payload: Record<string, unknown>, opts: { runtime?: ReturnType<typeof fakeRuntime> | null; policy?: Policy | null } = {}) {
  const onSubmitted = vi.fn()
  const onCancel = vi.fn()
  render(
    <StrictMode>
      <PolicyContext.Provider value={opts.policy === undefined ? policy() : opts.policy}>
        <WithRuntime runtime={opts.runtime === undefined ? fakeRuntime() : opts.runtime}>
          <SigningPrompt
            payload={payload as never}
            action={ACTION}
            qrAlt="Xaman purchase QR code"
            qrHint="Scan in Xaman to pay 10 XRP."
            onSubmitted={onSubmitted}
            onCancel={onCancel}
          />
        </WithRuntime>
      </PolicyContext.Provider>
    </StrictMode>,
  )
  return { onSubmitted, onCancel }
}

describe('a wallet the person owns (the request carries a transaction)', () => {
  it('shows the approve screen with the summary, and NO QR code', async () => {
    review.mockResolvedValue(OK)
    mount({ ...QR, sign: SIGN })
    expect(await screen.findByText('Buy 1 ticket to Neon Night for 10 XRP')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.queryByAltText('Xaman purchase QR code')).toBeNull()
    expect(screen.queryByText(/scan in xaman/i)).toBeNull()
  })

  it('reviews it against what the PAGE asked for and the broker from the POLICY, not anything in the request', async () => {
    review.mockResolvedValue(OK)
    mount({ ...QR, sign: SIGN })
    await screen.findByText('Buy 1 ticket to Neon Night for 10 XRP')
    expect(review).toHaveBeenCalledWith(SIGN, expect.objectContaining({ account: WALLET.address, broker: BROKER, action: ACTION }))
  })

  it('a policy that does not name a broker is passed on as unknown, so the review refuses rather than guesses', async () => {
    review.mockResolvedValue({ ok: false, reason: 'We couldn’t confirm HubWorld’s account, so we won’t ask you to approve this.' })
    mount({ ...QR, sign: SIGN }, { policy: policy({ brokerAddress: undefined }) })
    expect(await screen.findByText(/couldn’t confirm/i)).toBeTruthy()
    expect(review).toHaveBeenCalledWith(SIGN, expect.objectContaining({ broker: null }))
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('no policy loaded at all is the same: unknown broker, no way to approve', async () => {
    review.mockResolvedValue({ ok: false, reason: 'We couldn’t confirm HubWorld’s account, so we won’t ask you to approve this.' })
    mount({ ...QR, sign: SIGN }, { policy: null })
    await screen.findByText(/couldn’t confirm/i)
    expect(review).toHaveBeenCalledWith(SIGN, expect.objectContaining({ broker: null }))
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('a refused review leaves only the reason and a way out', async () => {
    review.mockResolvedValue({ ok: false, reason: 'The amount is not what was shown to you, so we won’t ask you to approve it.' })
    const { onCancel } = mount({ ...QR, sign: SIGN })
    expect(await screen.findByText(/not what was shown/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('approving sends only the signature, then says it is waiting for the network and tells the caller', async () => {
    review.mockResolvedValue(OK)
    const posts: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)))
      return json({ txid: 'T'.repeat(64), replay: false }, 202)
    }))
    const runtime = fakeRuntime()
    const { onSubmitted } = mount({ ...QR, sign: SIGN }, { runtime })
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('T'.repeat(64)))
    expect(posts).toEqual([{ signature: 'ab'.repeat(64) }])
    expect(runtime.calls.signHash).toEqual([[WALLET.address, SIGN.hash]])
    expect(await screen.findByText(/approved\. waiting for the network/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull() // cannot be approved twice
  })

  it('asks them to sign in again if their email session has gone, and signs nothing', async () => {
    review.mockResolvedValue(OK)
    const runtime = fakeRuntime({ authenticated: false, walletAddress: null })
    mount({ ...QR, sign: SIGN }, { runtime })
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(runtime.calls.signHash).toHaveLength(0)
  })
})

describe('a Xaman wallet (no transaction in the request)', () => {
  it('shows the QR code and the hint, and never the approve screen or the review', async () => {
    mount({ ...QR })
    expect(screen.getByAltText('Xaman purchase QR code')).toBeTruthy()
    expect(screen.getByText('Scan in Xaman to pay 10 XRP.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(review).not.toHaveBeenCalled()
  })

  it('works with no email runtime loaded at all (the Privy code was never fetched)', () => {
    mount({ ...QR }, { runtime: null })
    expect(screen.getByAltText('Xaman purchase QR code')).toBeTruthy()
  })

  it('offers Cancel when the caller gave a way to', () => {
    const { onCancel } = mount({ ...QR })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })
})
