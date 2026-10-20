/**
 * The grant / revoke panel. Rendered inside <StrictMode> on purpose, like every
 * polling loop here: the double-invocation is the thing under test.
 *
 * Two behaviours are worth pinning beyond the happy path:
 *   - pacing, by COUNTING requests. A runaway poll still reaches the right final
 *     state, so no state-based assertion would notice it.
 *   - an unreadable ledger is never worded as a revocation.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { DelegationPanel } from '@/components/DelegationPanel'

const CREATED = {
  uuid: '99999999-8888-4777-8666-555555555555',
  next: 'https://xaman.app/sign/d',
  qrPng: 'data:image/png;base64,CCCC',
  expiresAt: new Date(Date.now() + 180_000).toISOString(),
  mode: 'live' as const,
}

const ME = (state: 'granted' | 'not_granted' | 'unknown', extra: object = {}) => ({
  available: true as const,
  state,
  delegateAddress: 'rDelegate',
  grantedAt: null,
  staleGrant: false,
  ...extra,
})

type Counters = { me: number; polls: number; posts: string[] }

/**
 * `meSequence` is consumed one per GET /delegation/me, the last repeating.
 * StrictMode mounts the effect twice, so the first state needs listing twice.
 */
function mockApi(meSequence: unknown[], polls: unknown[] = [{ state: 'pending' }]): Counters {
  const c: Counters = { me: 0, polls: 0, posts: [] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })

      if (url.endsWith('/delegation/me')) {
        const body = meSequence[Math.min(c.me, meSequence.length - 1)]
        c.me += 1
        return json(body)
      }
      if (method === 'POST' && /\/delegation\/(grant|revoke)$/.test(url)) {
        c.posts.push(url.split('/').pop()!)
        return json(CREATED, 201)
      }
      if (method === 'GET' && url.includes('/api/delegation/')) {
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

function renderPanel() {
  return render(
    <StrictMode>
      <DelegationPanel />
    </StrictMode>,
  )
}

describe('DelegationPanel', () => {
  it('renders nothing where the network cannot do it', async () => {
    const calls = mockApi([{ available: false, state: 'unavailable' }])
    const { container } = renderPanel()

    await waitFor(() => expect(calls.me).toBeGreaterThan(0))
    // Absent, not disabled: a greyed-out control still advertises a capability.
    expect(container.textContent).toBe('')
  })

  it('states the limit of what is granted before asking for a signature', async () => {
    mockApi([ME('not_granted')])
    renderPanel()

    expect(await screen.findByText(/can only create tickets/i)).toBeTruthy()
    expect(screen.getByText(/turn it off here at any time/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /allow hubworld to create tickets/i })).toBeTruthy()
  })

  it('offers revoking as prominently as granting once granted', async () => {
    mockApi([ME('granted')])
    renderPanel()

    expect(await screen.findByText(/can create tickets for you/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /turn off ticket creation/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /allow hubworld to create tickets/i })).toBeNull()
  })

  it('never words an unreadable ledger as a revocation', async () => {
    mockApi([ME('unknown')])
    renderPanel()

    expect(await screen.findByText(/couldn't read your account/i)).toBeTruthy()
    expect(screen.getByText(/hasn't changed/i)).toBeTruthy()
    expect(screen.queryByText(/can't create tickets for you/i)).toBeNull()
    expect(screen.getByRole('button', { name: /check again/i })).toBeTruthy()
  })

  it('grants: QR, then signed-but-unconfirmed, then granted', async () => {
    const calls = mockApi(
      [ME('not_granted'), ME('not_granted'), ME('granted')],
      [{ state: 'pending' }, { state: 'pending', signed: true }, { state: 'granted' }],
    )
    renderPanel()

    ;(await screen.findByRole('button', { name: /allow hubworld to create tickets/i })).click()
    await screen.findByAltText(/approval qr/i)
    expect(calls.posts).toEqual(['grant'])
    expect(await screen.findByText(/scan in xaman to approve/i)).toBeTruthy()

    // A signature is not a grant: say so while the ledger catches up.
    await vi.advanceTimersByTimeAsync(3000)
    expect(await screen.findByText(/waiting for the ledger/i)).toBeTruthy()

    await vi.advanceTimersByTimeAsync(3000)
    expect(await screen.findByText(/can create tickets for you/i)).toBeTruthy()
  })

  it('revokes through its own endpoint and ends not-granted', async () => {
    const calls = mockApi([ME('granted'), ME('granted'), ME('not_granted')], [{ state: 'revoked' }])
    renderPanel()

    ;(await screen.findByRole('button', { name: /turn off ticket creation/i })).click()
    await screen.findByAltText(/revoke qr/i)
    expect(calls.posts).toEqual(['revoke'])

    expect(await screen.findByText(/can't create tickets for you yet/i)).toBeTruthy()
  })

  it('polls at the pace it claims, not on every response', async () => {
    const calls = mockApi([ME('not_granted')], [{ state: 'pending' }])
    renderPanel()

    ;(await screen.findByRole('button', { name: /allow hubworld to create tickets/i })).click()
    await screen.findByAltText(/approval qr/i)

    // 10s at a 2.5s cadence: the first immediate poll plus about four more. A
    // loop keyed on poll results would fire an order of magnitude more.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls.polls).toBeGreaterThanOrEqual(3)
    expect(calls.polls).toBeLessThanOrEqual(7)
  })

  it('stops polling on a terminal failure and shows the reason', async () => {
    const calls = mockApi([ME('not_granted')], [{ state: 'failed', reason: 'ledger said no' }])
    renderPanel()

    ;(await screen.findByRole('button', { name: /allow hubworld to create tickets/i })).click()
    expect(await screen.findByText(/ledger said no/i)).toBeTruthy()

    const after = calls.polls
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls.polls).toBe(after)
  })

  it('does not keep polling a declined request', async () => {
    const calls = mockApi([ME('not_granted')], [{ state: 'rejected' }])
    renderPanel()

    ;(await screen.findByRole('button', { name: /allow hubworld to create tickets/i })).click()
    expect(await screen.findByText(/declined in xaman/i)).toBeTruthy()

    const after = calls.polls
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls.polls).toBe(after)
  })

  it('tells the organizer when an earlier approval names a replaced account', async () => {
    mockApi([ME('not_granted', { staleGrant: true })])
    renderPanel()

    expect(await screen.findByText(/has since replaced/i)).toBeTruthy()
  })
})

// -------------------------------------------------------- two permissions --

const ME2 = (mint: 'granted' | 'not_granted' | 'unknown', offers: 'granted' | 'not_granted' | 'unknown') => ({
  available: true as const,
  state: mint,
  permissions: { mint, offers },
  delegateAddress: 'rDelegate',
  grantedAt: null,
  staleGrant: false,
})

function mockTwo(meSequence: unknown[], polls: unknown[] = [{ state: 'pending' }]) {
  const bodies: Array<{ path: string; body: unknown }> = []
  let me = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/delegation/me')) {
        const b = meSequence[Math.min(me, meSequence.length - 1)]
        me += 1
        return json(b)
      }
      if (method === 'POST' && /\/delegation\/(grant|revoke)$/.test(url)) {
        bodies.push({ path: url.split('/').pop()!, body: JSON.parse(String(init?.body)) })
        return json(CREATED, 201)
      }
      if (method === 'GET' && url.includes('/api/delegation/')) return json(polls[0])
      throw new Error(`unexpected fetch: ${method} ${url}`)
    }),
  )
  return bodies
}

describe('DelegationPanel: minting and selling are separate', () => {
  it('shows a card for each, and states what selling can do before asking', async () => {
    mockTwo([ME2('granted', 'not_granted')])
    renderPanel()

    expect(await screen.findByText(/can create tickets for you/i)).toBeTruthy()
    expect(screen.getByText(/can't sell tickets for you yet/i)).toBeTruthy()
    // The larger trust says so in words: it can list ANY ticket in the account.
    expect(screen.getByText(/can list any ticket in your account/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /allow hubworld to sell tickets/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /turn off ticket creation/i })).toBeTruthy()
  })

  it('asks for selling WITHOUT touching minting', async () => {
    const bodies = mockTwo([ME2('granted', 'not_granted'), ME2('granted', 'not_granted'), ME2('granted', 'granted')], [{ state: 'granted' }])
    renderPanel()

    ;(await screen.findByRole('button', { name: /allow hubworld to sell tickets/i })).click()
    await screen.findByAltText(/selling approval qr/i)

    expect(bodies).toEqual([{ path: 'grant', body: { permission: 'offers' } }])
    expect(await screen.findByText(/can sell tickets for you/i)).toBeTruthy()
    // Minting is untouched by it.
    expect(screen.getByText(/can create tickets for you/i)).toBeTruthy()
  })

  it('revokes minting only, naming the permission so selling stays', async () => {
    const bodies = mockTwo([ME2('granted', 'granted'), ME2('granted', 'granted'), ME2('not_granted', 'granted')], [{ state: 'revoked' }])
    renderPanel()

    ;(await screen.findByRole('button', { name: /turn off ticket creation/i })).click()
    await screen.findByAltText(/revoke qr/i)

    expect(bodies).toEqual([{ path: 'revoke', body: { permission: 'mint' } }])
    expect(await screen.findByText(/can't create tickets for you yet/i)).toBeTruthy()
    expect(screen.getByText(/can sell tickets for you/i)).toBeTruthy()
  })

  it('shows only minting against a server that predates the second permission', async () => {
    mockTwo([
      { available: true, state: 'granted', delegateAddress: 'rD', grantedAt: null, staleGrant: false },
    ])
    renderPanel()

    expect(await screen.findByText(/can create tickets for you/i)).toBeTruthy()
    expect(screen.queryByText(/selling tickets/i)).toBeNull()
  })

  it('does not word an unreadable ledger as a revocation on either card', async () => {
    mockTwo([ME2('unknown', 'unknown')])
    renderPanel()

    expect((await screen.findAllByText(/couldn't read your account/i)).length).toBe(2)
    expect(screen.queryByText(/can't create tickets for you/i)).toBeNull()
    expect(screen.queryByText(/can't sell tickets/i)).toBeNull()
  })
})
