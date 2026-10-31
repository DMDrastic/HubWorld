/**
 * The email wallet's code must not load for anyone who does not need it. The runtime module is
 * replaced by one that counts how often it is evaluated, which is exactly what a fetched chunk is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const loaded = vi.hoisted(() => ({ count: 0 }))
vi.mock('@/components/PrivyRuntime', () => {
  loaded.count += 1
  return { default: ({ children }: { children: React.ReactNode }) => <div data-testid="runtime">{children}</div> }
})

import { WithSigner } from '@/components/WithSigner'

beforeEach(() => {
  loaded.count = 0
})
afterEach(() => vi.restoreAllMocks())

describe('WithSigner', () => {
  it('is a plain pass-through, and loads nothing, when it is switched off', () => {
    render(<WithSigner enabled={false} appId="cmapp"><p>page</p></WithSigner>)
    expect(screen.getByText('page')).toBeTruthy()
    expect(screen.queryByTestId('runtime')).toBeNull()
    expect(loaded.count).toBe(0)
  })

  it('also loads nothing when it is on but the server gave no app id', () => {
    render(<WithSigner enabled={true} appId={undefined}><p>page</p></WithSigner>)
    expect(screen.getByText('page')).toBeTruthy()
    expect(loaded.count).toBe(0)
  })

  it('wraps the page in the runtime when it is on', async () => {
    render(<WithSigner enabled={true} appId="cmapp"><p>page</p></WithSigner>)
    expect(await screen.findByTestId('runtime')).toBeTruthy()
    expect(screen.getByText('page')).toBeTruthy()
    expect(loaded.count).toBe(1)
  })
})
