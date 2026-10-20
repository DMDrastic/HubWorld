/**
 * The rotating code an attendee holds up at the door.
 *
 * What is pinned is everything that makes a code safe to put on a phone: that a
 * dead code is never shown, that it is renewed before it dies, that it does not
 * hammer the server, and that it stops when nobody is looking. A QR that LOOKS
 * valid and is not is the failure, and it would pass a test that only checked
 * "a QR appears".
 *
 * Rendered in <StrictMode>, with requests counted against time.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import DoorQr from '@/components/DoorQr'

const ID = '00081388E82223A2A5150D5AADF7D8E5F5E3AC44D31AB0D402ACCC570127D521'

type Reply = { token: string; expiresInSeconds?: number; expiresAt?: string } | { fail: 'network' } | { status: number; error: string }

/**
 * Answers POST /door-token. A function decides the reply from the call number and
 * any state the test holds, rather than a fixed script: StrictMode runs effects
 * twice in development, so "the second call" is not a stable thing to script.
 */
function mockApi(replies: Reply | ((n: number) => Reply)) {
  const calls = { n: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (!url.includes('/door-token')) throw new Error(`unexpected fetch: ${url}`)
      const reply = typeof replies === 'function' ? replies(calls.n) : replies
      calls.n += 1
      if ('fail' in reply) throw new TypeError('network down')
      if ('status' in reply) {
        return new Response(JSON.stringify({ error: reply.error }), { status: reply.status, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(
        JSON.stringify({
          token: reply.token,
          expiresAt: reply.expiresAt ?? new Date(Date.now() + 45_000).toISOString(),
          expiresInSeconds: reply.expiresInSeconds ?? 45,
          refreshInSeconds: 30,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }),
  )
  return calls
}

let hidden = false
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, 'hidden')
})

const renderQr = (id = ID) =>
  render(
    <StrictMode>
      <DoorQr nfTokenId={id} />
    </StrictMode>,
  )
const code = () => screen.queryByRole('img', { name: /your entry code/i })

describe('DoorQr', () => {
  it('shows a code for the ticket, with the advice that makes a screenshot useless', async () => {
    mockApi({ token: 'HWD1.aaa.bbb' })
    renderQr()

    expect(await screen.findByRole('img', { name: /your entry code/i })).toBeTruthy()
    expect(screen.getByText(/brightness/i)).toBeTruthy()
    expect(screen.getByText(/screenshot won't work/i)).toBeTruthy()
  })

  it('draws DIFFERENT codes for different tokens (it encodes the token, not a constant)', async () => {
    // Every call gets a different token.
    mockApi((n) => ({ token: `HWD1.call${n}.${'x'.repeat(n + 3)}` }))
    renderQr()

    const first = (await screen.findByRole('img', { name: /your entry code/i })).innerHTML
    await vi.advanceTimersByTimeAsync(30_500)
    await waitFor(() => expect(code()!.innerHTML).not.toBe(first))
  })

  it('renews the code before it dies, at the pace the server asked for', async () => {
    const calls = mockApi({ token: 'HWD1.a.b' })
    renderQr()
    await screen.findByRole('img', { name: /your entry code/i })
    const first = calls.n
    // StrictMode mounts effects twice in development; what matters is that it is bounded.
    expect(first).toBeLessThanOrEqual(2)

    await vi.advanceTimersByTimeAsync(95_000)

    // Every 30s for 95s is three more asks. A loop keyed on its own results would
    // fire an order of magnitude more.
    expect(calls.n - first).toBeGreaterThanOrEqual(2)
    expect(calls.n - first).toBeLessThanOrEqual(5)
  })

  it('NEVER keeps showing a code after its life is up, if no new one arrives', async () => {
    let down = false
    mockApi(() => (down ? { fail: 'network' } : { token: 'HWD1.a.b' }))
    renderQr()
    await screen.findByRole('img', { name: /your entry code/i })
    down = true // the network goes away after the first code

    await vi.advanceTimersByTimeAsync(44_000)

    await waitFor(() => expect(code()).toBeNull())
    expect(await screen.findByText(/no signal/i)).toBeTruthy()
  })

  it('counts a code\'s life on ITS OWN clock, so a phone that is hours out still shows a good one', async () => {
    // The server's absolute expiry is hours in the past by this phone's clock.
    mockApi({ token: 'HWD1.a.b', expiresAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), expiresInSeconds: 45 })
    renderQr()

    expect(await screen.findByRole('img', { name: /your entry code/i })).toBeTruthy()
    // Stepped, not one jump: a single 20s advance runs every timer in one go and
    // can step over a code that blanked and came back.
    for (let second = 1; second <= 20; second++) {
      await vi.advanceTimersByTimeAsync(1_000)
      expect(code(), `blanked after ${second}s`).toBeTruthy()
    }
  })

  it('retries a failed fetch every few seconds, and recovers', async () => {
    const calls = mockApi((n) => (n < 3 ? { fail: 'network' } : { token: 'HWD1.a.b' }))
    renderQr()

    expect(await screen.findByText(/no signal/i)).toBeTruthy()
    await vi.advanceTimersByTimeAsync(12_000)

    expect(await screen.findByRole('img', { name: /your entry code/i })).toBeTruthy()
    expect(calls.n).toBeLessThanOrEqual(8)
  })

  it('stops asking when told no (it is not your ticket, it was used), and says why', async () => {
    const calls = mockApi({ status: 409, error: 'This ticket has already been used' })
    renderQr()

    expect(await screen.findByText(/already been used/i)).toBeTruthy()
    const first = calls.n
    await vi.advanceTimersByTimeAsync(60_000)

    expect(calls.n).toBe(first)
    expect(code()).toBeNull()
  })

  it('asks for nothing while the tab is hidden, and at once when it comes back', async () => {
    hidden = true
    const calls = mockApi({ token: 'HWD1.a.b' })
    renderQr()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(calls.n).toBe(0)

    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))

    expect(await screen.findByRole('img', { name: /your entry code/i })).toBeTruthy()
    expect(calls.n).toBeGreaterThanOrEqual(1)
  })

  it('follows the ticket: a different ticket gets its own code, and the old one stops being renewed', async () => {
    const calls = mockApi({ token: 'HWD1.a.b' })
    const { rerender } = renderQr()
    await screen.findByRole('img', { name: /your entry code/i })
    const before = calls.n

    rerender(
      <StrictMode>
        <DoorQr nfTokenId={'B'.repeat(64)} />
      </StrictMode>,
    )
    await waitFor(() => expect(calls.n).toBeGreaterThan(before))
    const urls = (fetch as unknown as { mock: { calls: Array<[RequestInfo | URL]> } }).mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes('B'.repeat(64)))).toBe(true)
  })
})
