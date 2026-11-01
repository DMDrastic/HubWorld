/**
 * Pressing "Sign out" in the real app ends the email wallet's session too. Written before the wiring.
 *
 * The email wallet remembers who signed in. Before this, signing out of HubWorld left that memory, so the email button went straight
 * back in as the same person (observed: it would only ever sign in as @privytester, even after signing out). The Privy host is
 * replaced by one that reports a runtime whose `logout` is a spy, which is exactly the part that matters here.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SignerRuntime } from '@/lib/signer-runtime'

const wallet = vi.hoisted(() => ({ logout: null as null | (() => Promise<void>) }))
vi.mock('@/components/PrivyRuntime', async () => {
  const React = await import('react')
  return {
    default: function Host({ onRuntime }: { onRuntime: (r: SignerRuntime) => void }) {
      React.useEffect(() => {
        onRuntime({
          ready: true,
          authenticated: true,
          walletAddress: 'rWallet',
          openLogin: () => {},
          getTokens: async () => null,
          ensureWallet: async () => ({ address: 'rWallet', publicKey: '02' }),
          signHash: async () => '',
          logout: () => wallet.logout!(),
        } as SignerRuntime)
      }, [onRuntime])
      return null
    },
  }
})

import App from '@/App'

const HEALTH = { status: 'ok', db: 'connected', uptime: 1, timestamp: '' }
const ME = { username: 'privytester', displayName: null, xrplAddress: 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w', createdAt: new Date().toISOString(), role: 'USER', ticketsOwned: 0 }

function mockApi(opts: { privy: boolean; signOutStatus?: number }) {
  const calls = { signout: 0 }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.includes('/api/health')) return json(HEALTH)
    if (url.includes('/api/events')) return json({ events: [] })
    if (url.includes('/api/auctions')) return json({ auctions: [] })
    if (url.includes('/api/policy')) {
      return json({ platformBps: 250, maxRoyaltyBps: 2000, ...(opts.privy ? { signers: ['xaman', 'privy'], privyAppId: 'cmapp' } : {}) })
    }
    if (url.includes('/api/auth/me')) return json(ME)
    if (url.includes('/api/door/events')) return json({ events: [] })
    if (url.includes('/api/auth/signout') && method === 'POST') {
      calls.signout += 1
      return opts.signOutStatus && opts.signOutStatus !== 200 ? json({ error: 'nope' }, opts.signOutStatus) : json({ revoked: true })
    }
    throw new Error(`unexpected fetch: ${method} ${url}`)
  }))
  return calls
}

beforeEach(() => {
  wallet.logout = vi.fn(async () => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const signOut = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /sign out/i }))
}

describe('Sign out in the app', () => {
  it('ends the HubWorld session AND the email wallet’s', async () => {
    const calls = mockApi({ privy: true })
    render(<StrictMode><App /></StrictMode>)
    await signOut()
    await waitFor(() => expect(calls.signout).toBe(1))
    await waitFor(() => expect(wallet.logout).toHaveBeenCalledTimes(1))
  })

  it('signs the wallet out even when the server refuses the sign-out', async () => {
    const calls = mockApi({ privy: true, signOutStatus: 500 })
    render(<StrictMode><App /></StrictMode>)
    await signOut()
    await waitFor(() => expect(calls.signout).toBe(1))
    await waitFor(() => expect(wallet.logout).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/sign-out failed/i)).toBeTruthy() // and the failure is still reported
  })

  it('with no email wallet on this deployment it signs out exactly as before', async () => {
    const calls = mockApi({ privy: false })
    render(<StrictMode><App /></StrictMode>)
    await signOut()
    await waitFor(() => expect(calls.signout).toBe(1))
    expect(wallet.logout).not.toHaveBeenCalled()
  })
})
