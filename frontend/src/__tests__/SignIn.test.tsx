/**
 * Regression tests for the sign-in polling loop.
 *
 * These exist because of a real bug: the loop originally used
 * `const cancelled = useRef(false)` with a cleanup that set it true. React
 * StrictMode mounts, cleans up, then mounts again — so that ref was permanently
 * true after the first cleanup, every poll result hit an early return, and no
 * further tick was ever scheduled. Sign-in silently never completed.
 *
 * It survived manual testing because the backend was driven with curl, which
 * never exercised the React loop at all. So these tests render inside
 * <StrictMode> deliberately: that double-invocation is the thing under test,
 * and a version of this component using a ref must fail here.
 */
import { StrictMode } from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { SignIn } from '@/components/SignIn'

const CREATED = {
  uuid: '11111111-2222-4333-8444-555555555555',
  next: 'https://xaman.app/sign/x',
  qrPng: 'data:image/png;base64,AAAA',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  mode: 'live' as const,
}

const USER = {
  username: 'dm_drastic',
  displayName: null,
  xrplAddress: 'r4wQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf',
}

type Poll = Record<string, unknown>

/**
 * Fake the API. Returns each queued poll response in order, repeating the last
 * one, so a test can express "pending, pending, then authenticated".
 */
function mockApi(polls: Poll[]) {
  const pollCalls = { count: 0 }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'

    if (url.endsWith('/api/auth/signin') && method === 'POST') {
      return new Response(JSON.stringify(CREATED), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (url.includes('/api/auth/signin/') && method === 'GET') {
      const body = polls[Math.min(pollCalls.count, polls.length - 1)]
      pollCalls.count += 1
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    throw new Error(`unexpected fetch: ${method} ${url}`)
  })

  vi.stubGlobal('fetch', fetchMock)
  return pollCalls
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function startSignIn() {
  await screen.findByRole('button', { name: /sign in/i })
  screen.getByRole('button', { name: /sign in/i }).click()
  // The QR appearing means the payload was created and polling has begun.
  await screen.findByAltText(/sign-in qr/i)
}

describe('SignIn polling under StrictMode', () => {
  it('keeps polling after the first tick and completes', async () => {
    // Two pendings before success: this is what the ref bug broke. It would
    // deliver the first poll and then never schedule another.
    const calls = mockApi([
      { state: 'pending' },
      { state: 'pending' },
      { state: 'authenticated', expiresAt: CREATED.expiresAt, user: USER },
    ])

    const onAuthenticated = vi.fn()
    render(
      <StrictMode>
        <SignIn onAuthenticated={onAuthenticated} />
      </StrictMode>,
    )

    await startSignIn()

    // Drive the 2s reschedules.
    await vi.advanceTimersByTimeAsync(7000)

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1))
    expect(onAuthenticated).toHaveBeenCalledWith(USER)
    // Proof the loop rescheduled rather than stopping after one result.
    expect(calls.count).toBeGreaterThanOrEqual(3)
  })

  it('polls immediately rather than waiting out the first interval', async () => {
    // The user may already have signed by the time this mounts, so a 2s dead
    // zone before the first request would be a visible stall.
    const calls = mockApi([{ state: 'pending' }])

    render(
      <StrictMode>
        <SignIn onAuthenticated={vi.fn()} />
      </StrictMode>,
    )
    await startSignIn()

    await waitFor(() => expect(calls.count).toBeGreaterThan(0))
  })

  it('moves to handle-claiming when the wallet has no account', async () => {
    mockApi([{ state: 'needs_username', address: USER.xrplAddress }])

    render(
      <StrictMode>
        <SignIn onAuthenticated={vi.fn()} />
      </StrictMode>,
    )
    await startSignIn()

    // The proven address is shown, and a handle is requested before any
    // session exists.
    expect(await screen.findByText(USER.xrplAddress)).toBeTruthy()
    expect(screen.getByLabelText(/choose a username/i)).toBeTruthy()
  })

  it('stops polling once rejected', async () => {
    const calls = mockApi([{ state: 'rejected' }])

    render(
      <StrictMode>
        <SignIn onAuthenticated={vi.fn()} />
      </StrictMode>,
    )
    await startSignIn()

    expect(await screen.findByText(/rejected in xaman/i)).toBeTruthy()

    const after = calls.count
    await vi.advanceTimersByTimeAsync(10_000)
    // A terminal state must not keep hammering the API.
    expect(calls.count).toBe(after)
  })

  it('reports an already-used sign-in rather than issuing a session', async () => {
    // Single-use signatures: re-polling a consumed request must not mint
    // another session.
    mockApi([{ state: 'consumed' }])

    const onAuthenticated = vi.fn()
    render(
      <StrictMode>
        <SignIn onAuthenticated={onAuthenticated} />
      </StrictMode>,
    )
    await startSignIn()

    expect(await screen.findByText(/already been used|already used/i)).toBeTruthy()
    expect(onAuthenticated).not.toHaveBeenCalled()
  })
})
