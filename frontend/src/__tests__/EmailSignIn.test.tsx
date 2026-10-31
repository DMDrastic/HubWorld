/**
 * Signing in with an email. Privy's login is a modal that finishes some time after the click, so
 * the page moves on when the runtime says it is signed in. Rendered inside <StrictMode> because the
 * step after login fires from an effect, and a double-run must not make two login requests.
 */
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EmailSignIn } from '@/components/EmailSignIn'
import type { SignerRuntime } from '@/lib/signer-runtime'
import { WALLET, WithRuntime, fakeRuntime, json } from './fakeRuntime'

const USER = { username: 'host', displayName: null, xrplAddress: WALLET.address }
const AUTHED = { state: 'authenticated', expiresAt: new Date(Date.now() + 1e6).toISOString(), user: USER }

afterEach(() => vi.unstubAllGlobals())

type Call = { url: string; body: Record<string, unknown> }
function mockApi(handler: (url: string, n: number) => Response): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} })
      return handler(url, calls.length)
    }),
  )
  return calls
}

function mount(runtime: SignerRuntime | null, retryMs = 1) {
  const onAuthenticated = vi.fn()
  const view = render(
    <StrictMode>
      <WithRuntime runtime={runtime}>
        <EmailSignIn onAuthenticated={onAuthenticated} retryMs={retryMs} />
      </WithRuntime>
    </StrictMode>,
  )
  return { onAuthenticated, ...view }
}

describe('where the email wallet is not loaded', () => {
  it('draws nothing at all', () => {
    const { container } = mount(null)
    expect(container.textContent).toBe('')
  })
})

describe('a returning person already signed in to Privy', () => {
  it('goes straight through: one login request, and the wallet key goes with it', async () => {
    const calls = mockApi(() => json(AUTHED))
    const { onAuthenticated } = mount(fakeRuntime())
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with email' }))
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(USER))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toMatch(/\/auth\/privy$/)
    expect(calls[0]!.body).toMatchObject({ publicKey: WALLET.publicKey })
  })
})

describe('someone who has to log in first', () => {
  it('opens the login, then carries on by itself when it completes', async () => {
    const calls = mockApi(() => json(AUTHED))
    const runtime = fakeRuntime({ authenticated: false })
    const { onAuthenticated, rerender } = mount(runtime)

    fireEvent.click(await screen.findByRole('button', { name: 'Continue with email' }))
    expect(runtime.calls.openLogin).toBe(1)
    expect(calls).toHaveLength(0) // nothing is asked of the server until Privy says they are in

    const signedIn = { ...runtime, authenticated: true }
    rerender(
      <StrictMode>
        <WithRuntime runtime={signedIn}>
          <EmailSignIn onAuthenticated={onAuthenticated} retryMs={1} />
        </WithRuntime>
      </StrictMode>,
    )
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(USER))
    expect(calls).toHaveLength(1)
  })
})

describe('a new person', () => {
  it('is asked for a handle, then claims it', async () => {
    const calls = mockApi((url) => (url.endsWith('/auth/privy') ? json({ state: 'needs_username' }) : json(AUTHED, 201)))
    const { onAuthenticated } = mount(fakeRuntime())
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with email' }))

    fireEvent.change(await screen.findByLabelText('choose a username'), { target: { value: '@host' } })
    fireEvent.click(screen.getByRole('button', { name: 'Claim' }))
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(USER))
    const claim = calls.find((c) => c.url.endsWith('/auth/privy/claim'))!
    // The leading @ is not part of the handle, and the key still goes with it.
    expect(claim.body).toMatchObject({ username: 'host', publicKey: WALLET.publicKey })
  })

  it('shows the server\'s reason when the handle is taken', async () => {
    mockApi((url) => (url.endsWith('/auth/privy') ? json({ state: 'needs_username' }) : json({ error: '@host is taken' }, 409)))
    mount(fakeRuntime())
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with email' }))
    fireEvent.change(await screen.findByLabelText('choose a username'), { target: { value: 'host' } })
    fireEvent.click(screen.getByRole('button', { name: 'Claim' }))
    expect(await screen.findByText('@host is taken')).toBeTruthy()
  })

  it('waits for a just-made wallet to appear in the token instead of giving up', async () => {
    const calls = mockApi((_url, n) =>
      n < 3 ? json({ error: 'No XRPL wallet came with your sign-in yet.', code: 'no_wallet' }, 409) : json(AUTHED),
    )
    const { onAuthenticated } = mount(fakeRuntime())
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with email' }))
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(USER))
    expect(calls).toHaveLength(3)
  })

  it('gives up with the reason after a bounded number of tries', async () => {
    const calls = mockApi(() => json({ error: 'No XRPL wallet came with your sign-in yet.', code: 'no_wallet' }, 409))
    mount(fakeRuntime())
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with email' }))
    expect(await screen.findByText(/No XRPL wallet came/)).toBeTruthy()
    expect(calls).toHaveLength(5) // the first try plus four more, never unbounded
  })
})

describe('failures', () => {
  it('lets the person switch to another email when this one cannot get through', async () => {
    mockApi(() => json({ error: 'That wallet already has an account.', code: 'address_taken' }, 409))
    const runtime = fakeRuntime()
    mount(runtime)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with email' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use a different email' }))
    // They are signed out of Privy, not merely returned to the same screen as the same person.
    expect(runtime.logout).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('button', { name: 'Continue with email' })).toBeTruthy()
  })

  it('shows a refused login and lets the person start again', async () => {
    mockApi(() => json({ error: 'Your sign-in could not be verified. Sign in again.' }, 401))
    mount(fakeRuntime())
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with email' }))
    expect(await screen.findByText(/could not be verified/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})
