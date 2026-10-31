/**
 * Granting access with a wallet the person owns: the same panel, the same poll, a different way
 * to sign. The review is a controlled input here (see SignStep.test.tsx); what is pinned is that
 * the panel shows the approval screen instead of a QR, only signs after the person approves,
 * sends nothing but the signature, and still finishes through its ordinary poll.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const review = vi.fn()

import { DelegationPanel } from '@/components/DelegationPanel'
import { reviewer } from '@/lib/sign-review-loader'
import { WALLET, WithRuntime, fakeRuntime, json } from './fakeRuntime'

const UUID = '99999999-8888-4777-8666-555555555555'
const SIGN = { tx: { TransactionType: 'DelegateSet', Account: WALLET.address }, hash: 'CD'.repeat(32), account: WALLET.address }
const CREATED = {
  uuid: UUID,
  next: '',
  qrPng: '',
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  mode: 'live' as const,
  sign: SIGN,
}
const ME = (state: 'granted' | 'not_granted', extra: object = {}) => ({
  available: true as const,
  state,
  permissions: { mint: state, offers: 'not_granted' as const },
  delegateAddress: 'rDelegate',
  grantedAt: null,
  staleGrant: false,
  ...extra,
})

type Seen = { posts: Array<{ url: string; body: unknown }>; polls: number; me: number }
function mockApi(polls: unknown[]): Seen {
  const seen: Seen = { posts: [], polls: 0, me: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (url.endsWith('/delegation/me')) {
        seen.me += 1
        return json(ME(seen.me > 2 ? 'granted' : 'not_granted'))
      }
      if (method === 'POST' && url.endsWith('/delegation/grant')) return json(CREATED, 201)
      if (method === 'POST' && url.includes('/signatures/')) {
        seen.posts.push({ url, body: JSON.parse(String(init?.body)) })
        return json({ txid: 'T'.repeat(64), replay: false }, 202)
      }
      if (method === 'GET' && url.includes('/api/delegation/')) {
        const body = polls[Math.min(seen.polls, polls.length - 1)]
        seen.polls += 1
        return json(body)
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    }),
  )
  return seen
}

beforeEach(() => {
  vi.spyOn(reviewer, 'load').mockResolvedValue({ reviewSignRequest: (...a: unknown[]) => review(...a) } as never)
  vi.useFakeTimers({ shouldAdvanceTime: true })
  review.mockResolvedValue({ ok: true, title: 'Allow HubWorld to create tickets for you', lines: ['After this, HubWorld will be able to:'] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  review.mockReset()
})

const mount = (runtime = fakeRuntime()) =>
  render(
    <StrictMode>
      <WithRuntime runtime={runtime}>
        <DelegationPanel />
      </WithRuntime>
    </StrictMode>,
  )

describe('granting with your own wallet', () => {
  it('shows the approval screen instead of a QR, signs on approval, and finishes through the normal poll', async () => {
    const seen = mockApi([{ state: 'pending' }, { state: 'pending', signed: true }, { state: 'granted' }])
    const runtime = fakeRuntime()
    mount(runtime)

    ;(await screen.findByRole('button', { name: /allow hubworld to create tickets/i })).click()
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.queryByAltText(/qr/i)).toBeNull()
    expect(screen.queryByText(/scan in xaman/i)).toBeNull()
    expect(runtime.calls.signHash).toHaveLength(0) // looking is not signing

    // The review is told what was asked for and what is held today, to check the result against.
    const [, ctx] = review.mock.calls[0]!
    expect(ctx).toMatchObject({
      account: WALLET.address,
      hubworldDelegate: 'rDelegate',
      delegation: { action: 'grant', scope: 'mint', held: { mint: false, offers: false } },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(seen.posts).toHaveLength(1))
    expect(seen.posts[0]!.url).toContain(`/signatures/${UUID}`)
    expect(seen.posts[0]!.body).toEqual({ signature: 'ab'.repeat(64) })
    expect(runtime.calls.signHash).toEqual([[WALLET.address, SIGN.hash]])

    expect(await screen.findByText(/waiting for the ledger/i)).toBeTruthy()
    await vi.advanceTimersByTimeAsync(10_000)
    await waitFor(() => expect(screen.queryByText(/waiting for the ledger/i)).toBeNull())
    // Paced by the clock, not by how often the page re-rendered.
    expect(seen.polls).toBeLessThanOrEqual(5)
  })

  it('offers no approval when the request does not check out', async () => {
    mockApi([{ state: 'pending' }])
    review.mockResolvedValue({ ok: false, reason: 'This would authorise an account that is not HubWorld’s. Do not approve it.' })
    const runtime = fakeRuntime()
    mount(runtime)

    ;(await screen.findByRole('button', { name: /allow hubworld to create tickets/i })).click()
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(runtime.calls.signHash).toHaveLength(0)
  })

  it('leaves a Xaman account on the QR, exactly as before', async () => {
    mockApi([{ state: 'pending' }])
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/delegation/me')) return json(ME('not_granted'))
        if ((init?.method ?? 'GET') === 'POST') {
          return json({ ...CREATED, sign: undefined, next: 'https://xaman.app/sign/x', qrPng: 'data:image/png;base64,AAAA' }, 201)
        }
        return json({ state: 'pending' })
      }),
    )
    mount(null as never)

    ;(await screen.findByRole('button', { name: /allow hubworld to create tickets/i })).click()
    expect(await screen.findByAltText(/approval qr/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(review).not.toHaveBeenCalled()
  })
})
