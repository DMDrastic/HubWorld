/**
 * Mint polling. Same StrictMode discipline as SignIn — this loop shares the
 * shape that the ref bug broke, so it gets the same coverage.
 *
 * The distinct thing here is the two-phase wait: a signature is not a mint,
 * because the NFTokenID does not exist until the ledger validates. The UI has to
 * distinguish "not scanned yet" from "signed, waiting on the ledger", or a slow
 * ledger looks like a failed scan.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MintPanel } from '@/components/MintPanel'
import type { EventSummary } from '@/lib/api'

const EVENT: EventSummary = {
  slug: 'neon-rooftop-session',
  title: 'Neon Rooftop Session',
  venue: 'Hub World',
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  status: 'PUBLISHED',
  ticketCount: 10,
  ticketsMinted: 0,
  organizer: { username: 'dm_drastic', displayName: null },
}

const CREATED = {
  uuid: '99999999-8888-4777-8666-555555555555',
  next: 'https://xaman.app/sign/y',
  qrPng: 'data:image/png;base64,BBBB',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  mode: 'live' as const,
}

const TICKET = {
  id: 'ticket-1',
  nfTokenId: '00081388E82223A2A5150D5AADF7D8E5F5E3AC44D31AB0D402ACCC570127D521',
  seat: null,
  tier: 'deluxe',
  status: 'MINTED',
  ownerAddress: 'r4wQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf',
  event: { slug: EVENT.slug, title: EVENT.title },
}

function mockApi(polls: Record<string, unknown>[]) {
  const calls = { count: 0 }
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

      if (url.includes('/mint') && method === 'POST') return json(CREATED, 201)
      if (url.includes('/api/mint/') && method === 'GET') {
        const body = polls[Math.min(calls.count, polls.length - 1)]
        calls.count += 1
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

async function startMint() {
  screen.getByRole('button', { name: /mint a ticket/i }).click()
  await screen.findByAltText(/mint qr/i)
}

describe('MintPanel', () => {
  it('offers nothing to mint when you organize no events', () => {
    render(
      <StrictMode>
        <MintPanel events={[]} onMinted={vi.fn()} />
      </StrictMode>,
    )
    expect(screen.getByText(/don't organize any events/i)).toBeTruthy()
  })

  it('distinguishes signed-but-unvalidated from not-yet-scanned', async () => {
    mockApi([
      { state: 'pending' },
      { state: 'pending', signed: true },
      { state: 'minted', ticket: TICKET },
    ])

    render(
      <StrictMode>
        <MintPanel events={[EVENT]} onMinted={vi.fn()} />
      </StrictMode>,
    )
    await startMint()

    // Before signing.
    expect(await screen.findByText(/scan in xaman/i)).toBeTruthy()

    // After signing, while the ledger catches up.
    await vi.advanceTimersByTimeAsync(3000)
    expect(await screen.findByText(/waiting for the ledger/i)).toBeTruthy()
  })

  it('shows the NFTokenID once the ledger validates', async () => {
    const onMinted = vi.fn()
    mockApi([{ state: 'pending' }, { state: 'minted', ticket: TICKET }])

    render(
      <StrictMode>
        <MintPanel events={[EVENT]} onMinted={onMinted} />
      </StrictMode>,
    )
    await startMint()

    await vi.advanceTimersByTimeAsync(6000)

    // The NFTokenID is the ticket's real identity, so it must be surfaced.
    expect(await screen.findByText(TICKET.nfTokenId)).toBeTruthy()
    await waitFor(() => expect(onMinted).toHaveBeenCalled())
  })

  it('stops polling on a terminal failure', async () => {
    const calls = mockApi([{ state: 'failed', reason: 'ledger said no' }])

    render(
      <StrictMode>
        <MintPanel events={[EVENT]} onMinted={vi.fn()} />
      </StrictMode>,
    )
    await startMint()

    expect(await screen.findByText(/ledger said no/i)).toBeTruthy()
    const after = calls.count
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls.count).toBe(after)
  })
})
