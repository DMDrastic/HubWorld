/**
 * The Privy host reports its runtime upward; that must settle, not loop. Written after it did loop, before the fix.
 *
 * The real SDK hands back NEW function identities on every render (`login`, `logout`, `getAccessToken`, the wallet hooks). A host
 * that put those in the runtime it reports would produce a "different" runtime on every render, report it, re-render the page,
 * re-render itself, and so on until React gave up with "Maximum update depth exceeded". The earlier WithSigner tests replaced the
 * host with a stub, so they could not see this. This one runs the REAL host against SDK stand-ins that behave the way the SDK does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { useSignerRuntime } from '@/lib/signer-runtime'

const sdk = vi.hoisted(() => ({ state: { ready: true, authenticated: false, user: null as unknown } }))

vi.mock('@privy-io/react-auth', () => ({
  PrivyProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  getIdentityToken: async () => 'identity',
  // Fresh function identities on EVERY call, exactly as the real hook does.
  usePrivy: () => ({
    ready: sdk.state.ready,
    authenticated: sdk.state.authenticated,
    user: sdk.state.user,
    login: () => {},
    logout: async () => {},
    getAccessToken: async () => 'access',
  }),
}))
vi.mock('@privy-io/react-auth/extended-chains', () => ({
  useCreateWallet: () => ({ createWallet: async () => ({ wallet: {} }) }),
  useSignRawHash: () => ({ signRawHash: async () => ({ signature: '0xab' }) }),
}))

import { WithSigner } from '@/components/WithSigner'

afterEach(() => vi.restoreAllMocks())

const renders = { n: 0 }
function Probe() {
  const runtime = useSignerRuntime()
  renders.n += 1
  return <p data-testid="probe">{runtime ? `ready:${runtime.ready} auth:${runtime.authenticated}` : 'no runtime'}</p>
}

describe('the real Privy host', () => {
  it('settles: the page renders a handful of times, not until React gives up', async () => {
    renders.n = 0
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<WithSigner enabled appId="cmapp"><Probe /></WithSigner>)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200))
    })
    expect(screen.getByTestId('probe').textContent).toBe('ready:true auth:false')
    expect(renders.n).toBeLessThan(10)
    expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/Maximum update depth/)
  })

  it('still passes on a real change: when the person signs in, the page sees it', async () => {
    sdk.state = { ready: true, authenticated: false, user: null }
    const { rerender } = render(<WithSigner enabled appId="cmapp"><Probe /></WithSigner>)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100))
    })
    expect(screen.getByTestId('probe').textContent).toBe('ready:true auth:false')
    sdk.state = { ready: true, authenticated: true, user: { linkedAccounts: [] } }
    rerender(<WithSigner enabled appId="cmapp"><Probe /></WithSigner>)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100))
    })
    expect(screen.getByTestId('probe').textContent).toBe('ready:true auth:true')
  })
})
