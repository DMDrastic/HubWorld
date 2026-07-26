/**
 * Gift polling.
 *
 * The headline test here is `paces its polling` — it exists because of a bug
 * that hit a live Xaman account. The polled state was stored INSIDE the phase
 * object, so every response produced a new object, the effect's `phase`
 * dependency changed, the effect re-ran, and its body fired the next request
 * immediately rather than after POLL_MS. One request per round-trip, as fast as
 * the network allowed, until Xaman returned 429 and the browser saw
 * "internal server error" on a gift that had in fact been signed correctly.
 *
 * Typechecking cannot catch that, and neither can a test that only asserts the
 * final state — a runaway loop still arrives at the right answer. It has to be
 * caught by counting requests against time.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { GiftPanel } from '@/components/GiftPanel'

const NFTOKEN_ID = '00081388E82223A2A5150D5AADF7D8E5F5E3AC44D31AB0D402ACCC570127D521'

const INVENTORY = {
  address: 'r4wQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf',
  verified: true,
  tickets: [
    {
      nfTokenId: NFTOKEN_ID,
      seat: null,
      tier: 'deluxe',
      status: 'MINTED',
      syncedAt: new Date().toISOString(),
      onLedger: true,
      event: {
        slug: 'neon-rooftop-session',
        title: 'Neon Rooftop Session',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    },
  ],
}

const CREATED = {
  giftId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  uuid: 'ffffffff-1111-4222-8333-444444444444',
  next: 'https://xaman.app/sign/z',
  qrPng: 'data:image/png;base64,CCCC',
  mode: 'live' as const,
}

const GIFT_TICKET = {
  nfTokenId: NFTOKEN_ID,
  seat: null,
  tier: 'deluxe',
  event: { slug: 'neon-rooftop-session', title: 'Neon Rooftop Session' },
}

function giftState(state: string, extra: Record<string, unknown> = {}) {
  return {
    state,
    giftId: CREATED.giftId,
    role: 'sender',
    from: '@dm_drastic',
    to: '@tester3',
    ticket: GIFT_TICKET,
    ...extra,
  }
}

/** Counts poll requests so pacing can be asserted, not just the end state. */
function mockApi(polls: Record<string, unknown>[]) {
  const calls = { poll: 0 }

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

      if (url.includes('/tickets/mine')) return json(INVENTORY)
      if (url.includes('/api/gifts?role=')) return json({ gifts: [] })
      if (url.includes('/gift') && method === 'POST') return json(CREATED, 201)
      if (url.match(/\/api\/gifts\/[^/]+$/) && method === 'GET') {
        const body = polls[Math.min(calls.poll, polls.length - 1)]
        calls.poll += 1
        return json(body)
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    }),
  )

  return calls
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function startGift() {
  const input = await screen.findByLabelText(/recipient handle/i)
  const { fireEvent } = await import('@testing-library/dom')
  fireEvent.change(input, { target: { value: '@tester3' } })
  screen.getByRole('button', { name: /^gift$/i }).click()
  await screen.findByAltText(/signing qr/i)
}

describe('GiftPanel polling', () => {
  it('paces its polling instead of firing one request per response', async () => {
    // Regression: this is the 429. Every poll returns a *different* object, which
    // is precisely the case that used to restart the effect and remove the delay.
    const calls = mockApi([
      giftState('pending_offer'),
      giftState('pending_offer', { signed: true }),
      giftState('offered', { awaitingRecipient: true }),
    ])

    render(
      <StrictMode>
        <GiftPanel onChanged={vi.fn()} />
      </StrictMode>,
    )
    await startGift()
    await waitFor(() => expect(calls.poll).toBeGreaterThan(0))

    // 10s at a 2.5s interval is 5 polls, and that is exactly what a correct
    // implementation produces here. With the effect keyed on an object that
    // changes every response it measured 15. The bound sits between the two:
    // loose enough to tolerate a little StrictMode noise, tight enough that
    // losing the interval fails rather than merely looking suspicious.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls.poll).toBeLessThanOrEqual(8)
  })

  it('reports the offer as live once the ledger assigns an index', async () => {
    mockApi([giftState('pending_offer'), giftState('offered', { awaitingRecipient: true })])

    render(
      <StrictMode>
        <GiftPanel onChanged={vi.fn()} />
      </StrictMode>,
    )
    await startGift()

    await vi.advanceTimersByTimeAsync(6000)
    expect(await screen.findByText(/live on-ledger/i)).toBeTruthy()
  })

  it('stops polling once the gift is accepted', async () => {
    const onChanged = vi.fn()
    const calls = mockApi([giftState('pending_offer'), giftState('accepted')])

    render(
      <StrictMode>
        <GiftPanel onChanged={onChanged} />
      </StrictMode>,
    )
    await startGift()

    await vi.advanceTimersByTimeAsync(6000)
    expect(await screen.findByText(/ticket has moved/i)).toBeTruthy()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())

    const settled = calls.poll
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls.poll).toBe(settled)
  })

  it('surfaces a withdrawal in progress', async () => {
    mockApi([giftState('cancelling')])

    render(
      <StrictMode>
        <GiftPanel onChanged={vi.fn()} />
      </StrictMode>,
    )
    await startGift()

    expect(await screen.findByText(/withdrawing/i)).toBeTruthy()
  })
})
