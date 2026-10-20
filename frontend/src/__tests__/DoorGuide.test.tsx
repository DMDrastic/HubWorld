/**
 * The "At the door" guide.
 *
 * It is a guide and not a credential, so half of what is pinned here is what it
 * must NEVER show: a code, or anything that reads as "admitted". Door check-in is
 * a Xaman signature that appears on the staff device; a screen on the attendee's
 * own phone that looked like admission would be a screenshot that can be
 * forwarded.
 */
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { DoorGuide } from '@/components/DoorGuide'
import type { OwnedTicket } from '@/lib/api'

const ID = '00081388E82223A2A5150D5AADF7D8E5F5E3AC44D31AB0D402ACCC570127D521'

const ticket = (over: Partial<OwnedTicket> = {}): OwnedTicket =>
  ({
    nfTokenId: ID,
    seat: null,
    tier: null,
    status: 'MINTED',
    syncedAt: null,
    onLedger: null,
    event: { slug: 'neon', title: 'Neon Rooftop Session', startsAt: '2026-10-21T14:25:00.000Z', venue: 'Openfield Stadium', imageUrl: null },
    canAuction: false,
    auctionBlockedReason: null,
    faceValueDrops: null,
    resaleAllowed: true,
    maxListingPriceDrops: null,
    maxAuctionReserveDrops: null,
    resaleBlockedReason: null,
    ...over,
  }) as OwnedTicket

/** What the ledger-verified inventory says about this ticket, or a failure. */
function mockLedger(answer: { onLedger: boolean | null } | 'absent' | 'fail') {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (url.includes('/door-token')) {
        return new Response(
          JSON.stringify({ token: 'HWD1.a.b', expiresAt: new Date(Date.now() + 45_000).toISOString(), expiresInSeconds: 45, refreshInSeconds: 30 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (!url.includes('/tickets/mine')) throw new Error(`unexpected fetch: ${url}`)
      if (answer === 'fail') return new Response('{}', { status: 500 })
      const tickets = answer === 'absent' ? [] : [ticket({ onLedger: answer.onLedger })]
      return new Response(JSON.stringify({ address: 'rHolder', verified: true, tickets }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )
  return calls
}

const renderGuide = (t = ticket(), open = true) =>
  render(
    <StrictMode>
      <DoorGuide ticket={t} open={open} onClose={vi.fn()} />
    </StrictMode>,
  )

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('DoorGuide', () => {
  it('tells a first-timer the three things to do, in order', async () => {
    mockLedger({ onLedger: true })
    renderGuide()

    const steps = (await screen.findAllByRole('listitem')).map((li) => li.textContent)
    expect(steps).toHaveLength(3)
    expect(steps[0]).toMatch(/open xaman now/i)
    expect(steps[1]).toMatch(/tap scan/i)
    expect(steps[2]).toMatch(/door staff's screen/i)
  })

  it('says which ticket this is: event, time, place and admission', async () => {
    mockLedger({ onLedger: true })
    renderGuide(ticket({ tier: 'VIP', seat: 'A12' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/neon rooftop session/i)
    expect(dialog.textContent).toMatch(/openfield stadium/i)
    expect(dialog.textContent).toMatch(/vip · a12/i)
  })

  it('confirms the ticket from the LEDGER, asking for a verified read', async () => {
    const calls = mockLedger({ onLedger: true })
    renderGuide()

    expect(await screen.findByText(/confirmed in your wallet just now/i)).toBeTruthy()
    expect(calls.every((u) => u.includes('verify=true'))).toBe(true)
  })

  it('says so plainly, and early, when the ticket is not in the wallet', async () => {
    mockLedger({ onLedger: false })
    renderGuide()

    expect(await screen.findByText(/can't find this ticket in your wallet/i)).toBeTruthy()
    expect(screen.queryByText(/confirmed in your wallet/i)).toBeNull()
  })

  it('treats a ticket missing from a verified inventory as not in the wallet', async () => {
    mockLedger('absent')
    renderGuide()

    expect(await screen.findByText(/can't find this ticket in your wallet/i)).toBeTruthy()
  })

  it('does NOT say the ticket is gone just because the ledger could not be read', async () => {
    mockLedger('fail')
    renderGuide()

    expect(await screen.findByText(/couldn't check just now/i)).toBeTruthy()
    expect(screen.queryByText(/can't find this ticket/i)).toBeNull()
  })

  it('does not claim confirmation when the server could not verify (unknown is not "yes")', async () => {
    mockLedger({ onLedger: null })
    renderGuide()

    expect(await screen.findByText(/couldn't check just now/i)).toBeTruthy()
    expect(screen.queryByText(/confirmed in your wallet/i)).toBeNull()
  })

  it('says a used ticket is used, whatever the ledger says', async () => {
    mockLedger({ onLedger: true })
    renderGuide(ticket({ status: 'REDEEMED' }))

    expect(await screen.findByText(/already been used/i)).toBeTruthy()
    await waitFor(() => expect(screen.queryByText(/confirmed in your wallet/i)).toBeNull())
  })

  it('warns that a ticket listed for sale could still be sold before the door', async () => {
    mockLedger({ onLedger: true })
    renderGuide(ticket({ status: 'LISTED' }))

    expect(await screen.findByText(/listed for sale/i)).toBeTruthy()
  })

  it('NEVER looks like admission: no code, no image, no "admitted"', async () => {
    mockLedger({ onLedger: true })
    renderGuide()

    const dialog = await screen.findByRole('dialog')
    await screen.findByText(/confirmed in your wallet/i)
    expect(dialog.querySelector('img, canvas, svg[role="img"]')).toBeNull()
    expect(dialog.textContent).not.toMatch(/admitted|welcome|entry granted|approved entry/i)
    expect(dialog.textContent).toMatch(/nothing on this page gets you in by itself/i)
  })

  it('asks the ledger when opened, not while closed, and not again by itself', async () => {
    const calls = mockLedger({ onLedger: true })
    const { rerender } = renderGuide(ticket(), false)
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toHaveLength(0)

    rerender(
      <StrictMode>
        <DoorGuide ticket={ticket()} open={true} onClose={vi.fn()} />
      </StrictMode>,
    )
    await screen.findByText(/confirmed in your wallet/i)
    const after = calls.length
    // StrictMode runs effects twice in development; what matters is that it is bounded.
    expect(after).toBeLessThanOrEqual(2)
    await new Promise((r) => setTimeout(r, 300))
    expect(calls.length).toBe(after)
  })
})

describe('DoorGuide at an event that lets people in by code', () => {
  const byCode = (over: Partial<OwnedTicket> = {}) =>
    ticket({ ...over, event: { ...ticket().event, doorMode: 'QR' } })

  it('shows the code instead of the three Xaman steps', async () => {
    mockLedger({ onLedger: true })
    renderGuide(byCode())

    expect(await screen.findByRole('img', { name: /your entry code/i })).toBeTruthy()
    expect(screen.getByText(/hold this up to the door staff/i)).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
    expect(screen.queryByText(/open xaman now/i)).toBeNull()
  })

  it('shows no code for a ticket that has been used', async () => {
    mockLedger({ onLedger: true })
    renderGuide(byCode({ status: 'REDEEMED' }))

    expect(await screen.findByText(/already been used/i)).toBeTruthy()
    expect(screen.queryByRole('img', { name: /your entry code/i })).toBeNull()
  })

  it('still never says the holder is in: that verdict belongs on the staff device', async () => {
    mockLedger({ onLedger: true })
    renderGuide(byCode())

    const dialog = await screen.findByRole('dialog')
    await screen.findByRole('img', { name: /your entry code/i })
    // The words a verdict would use. (The footer says nothing here says you are in, which is the point.)
    expect(dialog.textContent).not.toMatch(/admitted|welcome|entry granted|you're in\b|checked in/i)
    expect(dialog.textContent).toMatch(/nothing on this page says you are in/i)
  })

  it('asks the server for a code only when the guide is opened', async () => {
    const calls = mockLedger({ onLedger: true })
    renderGuide(byCode(), false)
    await new Promise((r) => setTimeout(r, 50))

    expect(calls.some((u) => u.includes('/door-token'))).toBe(false)
  })

  it('leaves a signature-mode event alone: no code, the steps as before (positive control)', async () => {
    mockLedger({ onLedger: true })
    renderGuide(ticket())

    expect(await screen.findAllByRole('listitem')).toHaveLength(3)
    expect(screen.queryByRole('img', { name: /your entry code/i })).toBeNull()
  })
})
