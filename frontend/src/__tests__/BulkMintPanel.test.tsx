/**
 * The bulk-mint panel. Rendered in <StrictMode> like every polling loop here.
 *
 * Pinned beyond the happy path:
 *   - pacing, by COUNTING requests (a runaway poll still reaches the right state);
 *   - a paused run says what to do and offers Resume;
 *   - a page reload picks an open run back up instead of inviting a second.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { BulkMintPanel } from '@/components/BulkMintPanel'
import type { EventSummary } from '@/lib/api'

const EVENT: EventSummary = {
  slug: 'neon-rooftop-session',
  title: 'Neon Rooftop Session',
  venue: 'Hub World',
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  status: 'PUBLISHED',
  ticketCount: 1000,
  ticketsMinted: 0,
  organizer: { username: 'dm_drastic', displayName: null },
}

const job = (over: Partial<Record<string, unknown>> = {}) => ({
  id: '11111111-2222-4333-8444-555555555555',
  eventSlug: EVENT.slug,
  status: 'RUNNING',
  statusReason: null,
  total: 100,
  minted: 20,
  failedTxs: 0,
  cancelRequested: false,
  createdAt: new Date().toISOString(),
  finishedAt: null,
  ...over,
})

const DELEGATION = (state: 'granted' | 'not_granted') => ({
  available: true,
  state,
  delegateAddress: 'rDelegate',
  grantedAt: null,
  staleGrant: false,
})

type Calls = { polls: number; posts: string[] }

function mockApi(opts: {
  delegation?: unknown
  existing?: unknown[]
  polls?: unknown[]
  start?: unknown
  startStatus?: number
  action?: unknown
}): Calls {
  const c: Calls = { polls: 0, posts: [] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

      if (url.endsWith('/delegation/me')) return json(opts.delegation ?? DELEGATION('granted'))
      if (url.endsWith('/mint/jobs') && method === 'GET') return json({ jobs: opts.existing ?? [] })
      if (url.endsWith('/mint/bulk') && method === 'POST') {
        c.posts.push('start')
        return json(opts.start ?? job({ minted: 0, status: 'QUEUED' }), opts.startStatus ?? 201)
      }
      if (method === 'POST' && /\/mint\/jobs\/[^/]+\/(cancel|resume)$/.test(url)) {
        c.posts.push(url.split('/').pop()!)
        return json(opts.action ?? job())
      }
      if (method === 'GET' && /\/mint\/jobs\/[^/]+$/.test(url)) {
        const polls = opts.polls ?? [job()]
        const body = polls[Math.min(c.polls, polls.length - 1)]
        c.polls += 1
        return json(body)
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    }),
  )
  return c
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const renderPanel = (onChanged = vi.fn()) =>
  render(
    <StrictMode>
      <BulkMintPanel events={[EVENT]} onChanged={onChanged} />
    </StrictMode>,
  )

async function startRun(count = '100') {
  const input = await screen.findByLabelText(/how many tickets/i)
  ;(input as HTMLInputElement).focus()
  const { fireEvent } = await import('@testing-library/react')
  fireEvent.change(input, { target: { value: count } })
  ;(await screen.findByRole('button', { name: /start minting/i })).click()
}

describe('BulkMintPanel', () => {
  it('is absent where delegation is not available', async () => {
    mockApi({ delegation: { available: false, state: 'unavailable' } })
    const { container } = renderPanel()
    await waitFor(() => expect(container.textContent).toBe(''))
  })

  it('tells the organizer to approve first, and does not let them start', async () => {
    mockApi({ delegation: DELEGATION('not_granted') })
    renderPanel()

    expect(await screen.findByText(/approve minting above first/i)).toBeTruthy()
    const button = (await screen.findByRole('button', { name: /start minting/i })) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('shows live progress as an accessible progress bar', async () => {
    const calls = mockApi({
      start: job({ minted: 0, status: 'QUEUED' }),
      polls: [job({ minted: 40 }), job({ minted: 100, status: 'DONE', finishedAt: new Date().toISOString() })],
    })
    const onChanged = vi.fn()
    renderPanel(onChanged)

    await startRun()
    expect(calls.posts).toEqual(['start'])
    expect(await screen.findByText(/0 of 100 minted/i)).toBeTruthy()

    await vi.advanceTimersByTimeAsync(3100)
    const bar = await screen.findByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('40')

    await vi.advanceTimersByTimeAsync(3100)
    expect(await screen.findByText(/100 of 100 minted/i)).toBeTruthy()
    expect(await screen.findByText(/finished/i)).toBeTruthy()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('polls at the pace it claims, and stops when the run is over', async () => {
    const calls = mockApi({
      existing: [job()],
      polls: [job()],
    })
    renderPanel()

    await screen.findByText(/20 of 100 minted/i)
    await vi.advanceTimersByTimeAsync(15_000)
    // 15s at a 3s cadence: about five polls. A loop keyed on results would fire
    // an order of magnitude more.
    expect(calls.polls).toBeGreaterThanOrEqual(3)
    expect(calls.polls).toBeLessThanOrEqual(7)
  })

  it('stops polling once the run is finished', async () => {
    const calls = mockApi({
      existing: [job()],
      polls: [job({ status: 'DONE', minted: 100, finishedAt: new Date().toISOString() })],
    })
    renderPanel()

    await screen.findByText(/20 of 100 minted/i) // the open run is loaded before it is watched
    await vi.advanceTimersByTimeAsync(3100)
    await screen.findByText(/finished/i)
    const after = calls.polls
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls.polls).toBe(after)
  })

  it('picks an open run back up after a reload instead of inviting a second', async () => {
    mockApi({ existing: [job({ minted: 55 })] })
    renderPanel()

    expect(await screen.findByText(/55 of 100 minted/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /start minting/i })).toBeNull()
  })

  it('says why a run paused and offers Resume', async () => {
    const calls = mockApi({
      existing: [
        job({
          status: 'PAUSED',
          statusReason: 'Your minting permission was withdrawn. Approve it again to continue.',
        }),
      ],
      action: job({ status: 'QUEUED' }),
    })
    renderPanel()

    expect(await screen.findByText(/permission was withdrawn/i)).toBeTruthy()
    ;(await screen.findByRole('button', { name: /resume/i })).click()
    await waitFor(() => expect(calls.posts).toEqual(['resume']))
  })

  it('lets the organizer cancel, and reflects that the current batch still lands', async () => {
    const calls = mockApi({
      existing: [job()],
      action: job({ cancelRequested: true }),
    })
    renderPanel()

    ;(await screen.findByRole('button', { name: /cancel the run/i })).click()
    await waitFor(() => expect(calls.posts).toEqual(['cancel']))
    expect(await screen.findByText(/stopping after the current batch/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /cancel the run/i })).toBeNull()
  })

  it('shows the server\'s refusal in words', async () => {
    mockApi({ start: { error: 'Only 40 of this event\'s 1000 tickets are left to mint' }, startStatus: 409 })
    renderPanel()

    await startRun('100')
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/only 40 of this event/i)).toBeTruthy()
  })

  it('says how many transactions the network refused', async () => {
    mockApi({ existing: [job({ failedTxs: 3 })] })
    renderPanel()
    expect(await screen.findByText(/3 transactions were refused/i)).toBeTruthy()
  })
})
