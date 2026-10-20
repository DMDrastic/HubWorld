/**
 * A door lane moving by itself.
 *
 * Standing at a door the slow part is not the guest, it is the staff member
 * tapping "Next person" between every one of them. So the next QR appears on its
 * own. What is pinned here is what could go wrong when a screen changes without
 * being touched: a verdict must not be mistaken for the next guest's, an idle
 * screen must not spend Xaman payloads forever, and a failure must not blank what
 * staff are looking at.
 *
 * Fake timers, with requests counted against them.
 */
import { StrictMode } from 'react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { DoorPanel } from '@/components/DoorPanel'

type Verdict = { state: string; holder?: string | null; reason?: string }
let script: (payload: number, poll: number) => Verdict = () => ({ state: 'pending' })
let failCreateAfter = Infinity
/** How long making a QR takes; the flash of an old verdict lives exactly this long. */
let createDelay = 0
let creates = 0
let polls: Record<number, number> = {}
let totalPolls = 0

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  script = () => ({ state: 'pending' })
  failCreateAfter = Infinity
  createDelay = 0
  creates = 0
  polls = {}
  totalPolls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/door/events')) return json({ events: [{ slug: 'neon', title: 'Neon Night', via: 'staff', doorMode: 'SIGNATURE' }] })
      if (url.endsWith('/events/neon/door')) return json({ event: { slug: 'neon', title: 'Neon Night' }, admitted: 0, issued: 10, recent: [] })
      if (url.endsWith('/events/neon/staff')) return json({ error: 'staff only' }, 403)
      if (url.endsWith('/policy')) return json({ platformBps: 250, maxRoyaltyBps: 2000, doorCodes: false })
      if (url.endsWith('/events/neon/checkin') && method === 'POST') {
        creates += 1
        if (createDelay) await new Promise((r) => setTimeout(r, createDelay))
        if (creates > failCreateAfter) return json({ error: 'Xaman is busy right now' }, 503)
        const n = creates
        return json({ checkInId: `c${n}`, uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, next: 'n', qrPng: 'data:image/png;base64,AA', expiresAt: new Date().toISOString(), mode: 'stub', event: { slug: 'neon', title: 'Neon Night' } }, 201)
      }
      const poll = /\/checkin\/00000000-0000-4000-8000-(\d+)$/.exec(url)
      if (poll && method === 'GET') {
        const n = Number(poll[1])
        totalPolls += 1
        polls[n] = (polls[n] ?? 0) + 1
        return json({ checkInId: `c${n}`, holder: null, ticket: null, ...script(n, polls[n]) })
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    }),
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const renderPanel = () =>
  render(
    <StrictMode>
      <DoorPanel />
    </StrictMode>,
  )
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
async function startLane() {
  fireEvent.click(await screen.findByRole('button', { name: /check someone in/i }))
  await advance(100)
}
const admitted = (holder: string): Verdict => ({ state: 'redeemed', holder })

describe('a door lane that moves by itself', () => {
  it('puts the next guest\'s QR up as soon as a verdict lands, with nobody tapping', async () => {
    script = (n) => (n === 1 ? admitted('@ann') : { state: 'pending' })
    renderPanel()
    await startLane()

    await advance(3_000)

    expect(creates).toBe(2)
    expect(screen.getByAltText(/check-in qr code/i)).toBeTruthy()
  })

  it('keeps the last guest\'s verdict beside the next QR, labelled as theirs', async () => {
    script = (n) => (n === 1 ? admitted('@ann') : { state: 'pending' })
    renderPanel()
    await startLane()

    await advance(3_000)

    expect(screen.getByText(/previous guest/i)).toBeTruthy()
    expect(screen.getByText('Admitted')).toBeTruthy()
    expect(screen.getByText('@ann')).toBeTruthy()
  })

  it('never shows two verdicts at once: the new guest\'s replaces the previous one', async () => {
    // The second guest is still signing on the first poll, and approved on the next.
    script = (n, poll) => (n === 1 ? admitted('@ann') : n === 2 && poll >= 2 ? admitted('@bob') : { state: 'pending' })
    renderPanel()
    await startLane()
    await advance(3_000)
    expect(screen.getByText('@ann')).toBeTruthy()

    await advance(3_000) // payload 2's second poll lands

    expect(screen.queryByText('@ann')).toBeNull()
    expect(screen.queryByText(/previous guest/i)).toBeNull()
    expect(screen.getAllByText('Admitted')).toHaveLength(1)
    expect(screen.getByText('@bob')).toBeTruthy()
  })

  it('takes the previous guest\'s verdict off the screen after a few seconds', async () => {
    script = (n) => (n === 1 ? admitted('@ann') : { state: 'pending' })
    renderPanel()
    await startLane()
    await advance(3_000)
    expect(screen.getByText('@ann')).toBeTruthy()

    await advance(9_000)

    expect(screen.queryByText('@ann')).toBeNull()
    expect(screen.getByAltText(/check-in qr code/i)).toBeTruthy()
  })

  it('shows the handle large, since it is all staff have to check against the person in front of them', async () => {
    script = (n) => (n === 1 ? admitted('@ann') : { state: 'pending' })
    renderPanel()
    await startLane()
    await advance(2_300) // the verdict is up, the next QR is not yet

    const handle = await screen.findByText('@ann')
    expect(handle.className).toMatch(/text-lg/)
  })
})

describe('a lane nobody is using', () => {
  it('replaces a timed-out QR quietly rather than flashing "Expired" at staff', async () => {
    script = (n) => (n === 1 ? { state: 'expired' } : { state: 'pending' })
    // Making a QR is slow here, so the moment between "it timed out" and "here is a new
    // one" is long enough to see: staff must see "getting a new code", never "Expired".
    createDelay = 1_500
    renderPanel()
    await startLane()

    await advance(2_000) // the first QR is up and has timed out; its replacement is in flight
    expect(screen.queryByText('Expired')).toBeNull()
    expect(screen.getByText(/getting a new code/i)).toBeTruthy()

    createDelay = 0
    await advance(3_000)

    expect(creates).toBe(2)
    expect(screen.queryByText('Expired')).toBeNull()
    expect(screen.getByAltText(/check-in qr code/i)).toBeTruthy()
  })

  it('stops after a few idle roll-overs, because each one is a Xaman payload, and waits to be tapped', async () => {
    script = () => ({ state: 'expired' })
    renderPanel()
    await startLane()

    await advance(60_000)

    // The first QR plus three replacements, then it stops.
    expect(creates).toBe(4)
    expect(screen.getByText('Expired')).toBeTruthy()
    expect(screen.getByText(/tap to continue/i)).toBeTruthy()

    // And stays stopped.
    await advance(120_000)
    expect(creates).toBe(4)

    // Tapping Continue starts a fresh QR (and, being tapped, earns three more idle roll-overs).
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    await advance(500)
    expect(creates).toBeGreaterThan(4)
  })

  it('a real guest resets the count, so a busy door is never throttled by earlier quiet', async () => {
    // Two idle QRs, a real guest, then idle again: three more roll-overs are allowed.
    script = (n) => (n === 3 ? admitted('@ann') : n <= 2 || n >= 4 ? { state: 'expired' } : { state: 'pending' })
    renderPanel()
    await startLane()

    await advance(90_000)

    // Without the reset it would stop at 5; with it, 1 + 2 idle + 1 guest + 3 idle = 7.
    expect(creates).toBe(7)
  })
})

describe('when the next QR cannot be made', () => {
  it('keeps the verdict on screen and offers a retry, instead of blanking the lane', async () => {
    script = (n) => (n === 1 ? admitted('@ann') : { state: 'pending' })
    failCreateAfter = 1
    renderPanel()
    await startLane()

    await advance(3_000)

    expect(screen.getByText('@ann')).toBeTruthy()
    expect(screen.getByText(/xaman is busy right now/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /start over/i })).toBeNull()

    failCreateAfter = Infinity
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    await advance(500)
    expect(screen.getByAltText(/check-in qr code/i)).toBeTruthy()
  })
})

describe('leaving the lane, and pacing', () => {
  it('stops making QRs when staff press Done', async () => {
    script = () => ({ state: 'pending' })
    renderPanel()
    await startLane()

    fireEvent.click(screen.getByRole('button', { name: /done/i }))
    await advance(60_000)

    expect(creates).toBe(1)
    expect(screen.getByRole('button', { name: /check someone in/i })).toBeTruthy()
  })

  it('still lets staff move on by hand with "Next person"', async () => {
    script = () => ({ state: 'pending' })
    renderPanel()
    await startLane()

    fireEvent.click(screen.getByRole('button', { name: /next person/i }))
    await advance(500)

    expect(creates).toBe(2)
  })

  it('polls at the pace it claims while a QR waits for a guest, not on every answer', async () => {
    script = () => ({ state: 'pending' })
    renderPanel()
    await startLane()

    await advance(10_000)

    // A 2s cadence for 10s is about five polls. A loop keyed on its own result
    // would fire an order of magnitude more.
    expect(totalPolls).toBeGreaterThanOrEqual(3)
    expect(totalPolls).toBeLessThanOrEqual(8)
  })
})
