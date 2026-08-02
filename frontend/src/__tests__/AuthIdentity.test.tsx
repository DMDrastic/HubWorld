/**
 * Whose session is this page actually using?
 *
 * Observed 2026-08-02 and unexplained until now: the header named one signed-in
 * account while requests were being attributed to another, and "Sign out"
 * revoked no session. There was no mystery in the end — the page asked
 * `/auth/me` exactly twice, at mount and just after a sign-in, and nothing ever
 * asked again. The cookie is server state and moves without this tab's
 * involvement (another tab signing in as a different account, a session
 * expiring, one revoked), so `me` was a snapshot that could quietly disagree
 * with the credential every request was actually sending.
 *
 * Both symptoms follow from that one gap, so both are pinned here. Each test
 * was confirmed to fail with its fix reverted — a UI naming the wrong
 * signed-in user is a trust problem, and trust is the pitch.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import App from '@/App'

const HEALTH = { status: 'ok', db: 'connected', uptime: 1, timestamp: '' }

function user(username: string) {
  return {
    username,
    displayName: null,
    xrplAddress: 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w',
    createdAt: new Date().toISOString(),
    role: 'USER' as const,
    ticketsOwned: 0,
  }
}

/**
 * A fake backend whose idea of "who is signed in" can be changed mid-test, the
 * way the real cookie changes when another tab signs in.
 *
 * `calls.me` is counted because revalidation must be event-driven: a
 * revalidation that re-armed itself would still reach the right answer, so only
 * counting requests can tell the two apart.
 */
function mockApi(initial: { me: string | null }) {
  const server = {
    me: initial.me,
    /** Set to fail an ordinary authenticated call while /auth/me still answers. */
    doorStatus: 200,
    /** Set to make fetch reject outright — a dead backend, not a dead session. */
    offline: false,
    signOutRevoked: true,
  }
  const calls = { me: 0, signout: 0 }

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

      if (server.offline) throw new TypeError('Failed to fetch')

      if (url.includes('/api/health')) return json(HEALTH)
      if (url.includes('/api/events')) return json({ events: [] })
      if (url.includes('/api/auctions')) return json({ auctions: [] })

      if (url.includes('/api/auth/me')) {
        calls.me += 1
        return server.me ? json(user(server.me)) : json({ error: 'Not signed in' }, 401)
      }

      if (url.includes('/api/auth/signout') && method === 'POST') {
        calls.signout += 1
        return json({ revoked: server.signOutRevoked })
      }

      if (url.includes('/api/door/events')) {
        return server.doorStatus === 200
          ? json({ events: [] })
          : json({ error: 'Invalid or expired session' }, server.doorStatus)
      }

      throw new Error(`unexpected fetch: ${method} ${url}`)
    }),
  )

  return { server, calls }
}

function renderApp() {
  return render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

/** The header is the thing that was lying, so assertions read it directly. */
const shownAs = (handle: string) => screen.findAllByText(`@${handle}`)

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the header cannot outlive the session it names', () => {
  it('retires the identity when any authenticated call comes back 401', async () => {
    const { server } = mockApi({ me: 'alpha' })
    renderApp()
    expect((await shownAs('alpha')).length).toBeGreaterThan(0)

    // The exact divergence that was observed: /auth/me keeps answering with the
    // account this page already believes in, while an ordinary authenticated
    // call is being refused. The 401 is the honest signal and it has to win —
    // even though the caller here swallows the error to empty its own list.
    server.doorStatus = 401
    window.dispatchEvent(new Event('focus'))

    // Nothing may still be claiming @alpha once a 401 has landed.
    await waitFor(() => expect(screen.queryByText('@alpha')).toBeNull())
  })

  it('picks up an account switch made in another tab', async () => {
    // Nothing tells this tab that the cookie now belongs to someone else, so
    // coming back to it is the only moment there is to notice.
    const { server } = mockApi({ me: 'alpha' })
    renderApp()
    expect((await shownAs('alpha')).length).toBeGreaterThan(0)

    server.me = 'beta'
    window.dispatchEvent(new Event('focus'))

    expect((await shownAs('beta')).length).toBeGreaterThan(0)
    expect(screen.queryByText('@alpha')).toBeNull()
  })

  it('does not sign anyone out because the backend blinked', async () => {
    // A transport failure carries no status and says nothing about identity.
    // Treating it as a 401 would sign someone out over a dropped packet, which
    // is the same mistake the door check-in refuses to make with the ledger.
    const { server } = mockApi({ me: 'alpha' })
    renderApp()
    expect((await shownAs('alpha')).length).toBeGreaterThan(0)

    server.offline = true
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(1000)

    expect((await shownAs('alpha')).length).toBeGreaterThan(0)
  })

  it('revalidates on an event, never on a timer', async () => {
    // A revalidation that re-armed itself would pass every test above and
    // quietly hammer /auth/me forever, so the bound is on request COUNT. Only
    // the mount fetches are allowed to have happened.
    const { calls } = mockApi({ me: 'alpha' })
    renderApp()
    await waitFor(() => expect(calls.me).toBeGreaterThan(0))
    const afterMount = calls.me

    await vi.advanceTimersByTimeAsync(60_000)

    expect(calls.me).toBe(afterMount)
  })
})

describe('signing out reports what it actually did', () => {
  it('says so when there was no live session to end', async () => {
    // This is the "sign out revoked no session" half. It happens when the
    // cookie belongs to someone other than the account on screen, so rendering
    // it as success is how the divergence stayed invisible.
    const { server, calls } = mockApi({ me: 'alpha' })
    server.signOutRevoked = false

    renderApp()
    const signOut = await screen.findByRole('button', { name: /sign out/i })
    signOut.click()

    await waitFor(() => expect(calls.signout).toBe(1))
    await screen.findByText(/no active session was found/i)
    // Cleared locally regardless: continuing to render a session we just tried
    // to end is the failure being fixed.
    expect(screen.queryByText('@alpha')).toBeNull()
  })

  it('stays quiet when it really did revoke one', async () => {
    const { calls } = mockApi({ me: 'alpha' })
    renderApp()
    const signOut = await screen.findByRole('button', { name: /sign out/i })
    signOut.click()

    await waitFor(() => expect(calls.signout).toBe(1))
    expect(screen.queryByText(/no active session was found/i)).toBeNull()
  })
})
