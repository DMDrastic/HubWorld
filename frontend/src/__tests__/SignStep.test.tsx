/**
 * Approving something with your own wallet.
 *
 * The review itself (decoding, hashing, every refusal) is pinned in sign-review.test.ts, in the
 * node environment because jsdom's separate Uint8Array breaks the signing libraries. Here the
 * review is a controlled input, so what is under test is what the SCREEN does with its answer:
 * above all, that a refusal leaves no way to approve, and that only a signature goes back.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const review = vi.fn()

import { SignStep } from '@/components/SignStep'
import { reviewer } from '@/lib/sign-review-loader'
import { WALLET, WithRuntime, fakeRuntime, json } from './fakeRuntime'

const SIGN = { tx: { TransactionType: 'DelegateSet', Account: WALLET.address }, hash: 'AB'.repeat(32), account: WALLET.address }
const OK = { ok: true as const, title: 'Allow HubWorld to create tickets for you', lines: ['After this, HubWorld will be able to:', 'Authorising this account: rDelegate'] }

beforeEach(() => {
  // The review is a controlled input here; its own logic is pinned in sign-review.test.ts.
  vi.spyOn(reviewer, 'load').mockResolvedValue({ reviewSignRequest: (...a: unknown[]) => review(...a) } as never)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  review.mockReset()
})

function mount(runtime = fakeRuntime(), props: Partial<React.ComponentProps<typeof SignStep>> = {}) {
  const onSubmitted = vi.fn()
  const onCancel = vi.fn()
  render(
    <StrictMode>
      <WithRuntime runtime={runtime}>
        <SignStep
          uuid="11111111-2222-4333-8444-555555555555"
          sign={SIGN}
          context={{ hubworldDelegate: 'rDelegate' }}
          onSubmitted={onSubmitted}
          onCancel={onCancel}
          {...props}
        />
      </WithRuntime>
    </StrictMode>,
  )
  return { runtime, onSubmitted, onCancel }
}

describe('a request that checks out', () => {
  it('shows what it does in words, and signs only after the person approves', async () => {
    review.mockResolvedValue(OK)
    const posts: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)))
      return json({ txid: 'T'.repeat(64), replay: false }, 202)
    }))
    const { runtime, onSubmitted } = mount()

    expect(await screen.findByText('Allow HubWorld to create tickets for you')).toBeTruthy()
    expect(screen.getByText(/Authorising this account: rDelegate/)).toBeTruthy()
    // Nothing is signed just by looking at it.
    expect(runtime.calls.signHash).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('T'.repeat(64)))
    // The wallet was asked to sign the hash that was reviewed, for this account.
    expect(runtime.calls.signHash).toEqual([[WALLET.address, SIGN.hash]])
    // And ONLY the signature went back: no transaction, no hash, nothing else to tamper with.
    expect(posts).toEqual([{ signature: 'ab'.repeat(64) }])
  })

  it('reviews it for the wallet that is signed in, not an account the server named', async () => {
    review.mockResolvedValue(OK)
    // The server names some other account; the review must still be made against the wallet that
    // is actually signed in, or "this is your account" would be the server grading its own work.
    mount(fakeRuntime(), { sign: { ...SIGN, account: 'rServerNamedAnotherAccount000000' } })
    await screen.findByText('Allow HubWorld to create tickets for you')
    const [, ctx] = review.mock.calls[0]!
    expect(ctx.account).toBe(WALLET.address)
  })

  it('does not approve twice on a double click', async () => {
    review.mockResolvedValue(OK)
    vi.stubGlobal('fetch', vi.fn(async () => json({ txid: 'T'.repeat(64), replay: false }, 202)))
    const { runtime } = mount()
    const button = await screen.findByRole('button', { name: 'Approve' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(runtime.calls.signHash.length).toBeGreaterThan(0))
    expect(runtime.calls.signHash).toHaveLength(1)
  })

  it('says what went wrong, and lets the person try again', async () => {
    review.mockResolvedValue(OK)
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'That request has expired. Start again.' }, 410)))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    expect(await screen.findByText(/has expired/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('a request that does not check out', () => {
  it('shows the reason and offers no way to approve it', async () => {
    review.mockResolvedValue({ ok: false, reason: 'This would authorise an account that is not HubWorld’s. Do not approve it.' })
    const { runtime } = mount()
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/not HubWorld’s/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(runtime.calls.signHash).toHaveLength(0)
  })

  it('cancels', async () => {
    review.mockResolvedValue({ ok: false, reason: 'No.' })
    const { onCancel } = mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })
})

describe('when the person is not signed in to their wallet', () => {
  it('asks them to sign in again instead of showing an approval it cannot complete', async () => {
    review.mockResolvedValue(OK)
    const runtime = fakeRuntime({ authenticated: false, walletAddress: null })
    mount(runtime)
    expect(await screen.findByText(/Sign in with your email again/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(runtime.calls.openLogin).toBe(1)
  })

  it('does the same where the page has no wallet runtime at all', async () => {
    review.mockResolvedValue(OK)
    render(
      <WithRuntime runtime={null}>
        <SignStep uuid="u" sign={SIGN} context={{ hubworldDelegate: null }} onSubmitted={() => {}} onCancel={() => {}} />
      </WithRuntime>,
    )
    expect(await screen.findByText(/Sign in with your email again/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })
})
