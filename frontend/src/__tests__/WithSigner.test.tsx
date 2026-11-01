/**
 * The email wallet's code must not load for anyone who does not need it, and loading it must not disturb the page.
 *
 * The runtime module is replaced by one that counts how often it is evaluated, which is exactly what a fetched chunk is.
 *
 * The Privy host does NOT wrap the page: it is loaded beside it and reports its runtime upward into a context that is
 * always there. Wrapping would remount everything under it the moment the chunk arrived (a different parent means a
 * new tree), which once the host is on every page would throw away whatever the person was in the middle of.
 */
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import type { SignerRuntime } from '@/lib/signer-runtime'
import { useSignerRuntime } from '@/lib/signer-runtime'

const loaded = vi.hoisted(() => ({ count: 0, report: null as null | ((r: SignerRuntime) => void), props: [] as unknown[] }))
vi.mock('@/components/PrivyRuntime', () => {
  loaded.count += 1
  return {
    default: function Host(props: { appId: string; onRuntime: (r: SignerRuntime) => void }) {
      loaded.props.push(props.appId)
      loaded.report = props.onRuntime
      return <div data-testid="host" />
    },
  }
})

import { WithSigner } from '@/components/WithSigner'

const RUNTIME = { ready: true, authenticated: true, walletAddress: 'rWallet' } as unknown as SignerRuntime

beforeEach(() => {
  loaded.count = 0
  loaded.report = null
  loaded.props = []
})
afterEach(() => vi.restoreAllMocks())

function Probe() {
  const runtime = useSignerRuntime()
  return <p data-testid="probe">{runtime ? `wallet:${(runtime as unknown as { walletAddress: string }).walletAddress}` : 'no runtime'}</p>
}

describe('WithSigner', () => {
  it('is a plain pass-through, and loads nothing, when it is switched off', () => {
    render(<WithSigner enabled={false} appId="cmapp"><p>page</p></WithSigner>)
    expect(screen.getByText('page')).toBeTruthy()
    expect(screen.queryByTestId('host')).toBeNull()
    expect(loaded.count).toBe(0)
  })

  it('also loads nothing when it is on but the server gave no app id', () => {
    render(<WithSigner enabled={true} appId={undefined}><p>page</p></WithSigner>)
    expect(screen.getByText('page')).toBeTruthy()
    expect(loaded.count).toBe(0)
  })

  it('loads the host beside the page when it is on, once, with the app id', async () => {
    render(<WithSigner enabled={true} appId="cmapp"><p>page</p></WithSigner>)
    expect(await screen.findByTestId('host')).toBeTruthy()
    expect(screen.getByText('page')).toBeTruthy()
    expect(loaded.count).toBe(1)
    expect(loaded.props[0]).toBe('cmapp')
  })

  it('shows the page at once, without waiting for the host', () => {
    render(<WithSigner enabled={true} appId="cmapp"><p>page</p></WithSigner>)
    expect(screen.getByText('page')).toBeTruthy() // synchronously, before the chunk resolves
  })

  it('gives the page NO runtime until the host reports one, then the one it reports', async () => {
    render(<WithSigner enabled={true} appId="cmapp"><Probe /></WithSigner>)
    expect(screen.getByTestId('probe').textContent).toBe('no runtime')
    await screen.findByTestId('host')
    await act(async () => loaded.report!(RUNTIME))
    expect(screen.getByTestId('probe').textContent).toBe('wallet:rWallet')
  })

  it('follows the host when its runtime changes (a sign-in completing)', async () => {
    render(<WithSigner enabled={true} appId="cmapp"><Probe /></WithSigner>)
    await screen.findByTestId('host')
    await act(async () => loaded.report!(RUNTIME))
    await act(async () => loaded.report!({ ...RUNTIME, walletAddress: 'rOther' } as unknown as SignerRuntime))
    expect(screen.getByTestId('probe').textContent).toBe('wallet:rOther')
  })

  it('does NOT remount the page when the host arrives (whatever the person was doing is kept)', async () => {
    let mounts = 0
    function Counted() {
      const once = useRef(false)
      useEffect(() => {
        if (!once.current) {
          once.current = true
          mounts += 1
        }
      }, [])
      return <input aria-label="draft" />
    }
    render(<WithSigner enabled={true} appId="cmapp"><Counted /></WithSigner>)
    const before = screen.getByLabelText('draft')
    await screen.findByTestId('host')
    await act(async () => loaded.report!(RUNTIME))
    expect(screen.getByLabelText('draft')).toBe(before) // the very same DOM node
    expect(mounts).toBe(1)
  })

  it('with the host switched off, the page sees no runtime at all', () => {
    render(<WithSigner enabled={false} appId="cmapp"><Probe /></WithSigner>)
    expect(screen.getByTestId('probe').textContent).toBe('no runtime')
  })
})
