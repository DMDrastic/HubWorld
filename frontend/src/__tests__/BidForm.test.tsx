/**
 * The bid headroom warning.
 *
 * A bid is a buy offer, not an escrow, so nothing stops the bidder spending the
 * money afterwards. Settlement re-reads their spendable balance and falls
 * through to the runner-up if it has dropped — the bidder wins the auction and
 * then silently loses it, with no message beyond having lost.
 *
 * The warning is therefore about a consequence the UI cannot otherwise show,
 * and its timing is the whole point: it has to appear while the bid can still
 * be changed, which means on the signing screen, before the QR is scanned.
 *
 * Rendered under `<StrictMode>` like the other panels here — the double
 * invocation is deliberate, see GiftPanel.test for what it once caught.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { BidForm } from '@/components/BidForm'
import type { Auction } from '@/lib/api'

const XRP = 1_000_000
const NOW = Date.now()

const AUCTION: Auction = {
  id: 'auction-1',
  eventTitle: 'Neon Rooftop Session',
  eventSlug: 'neon-rooftop-session',
  state: 'live',
  startsAt: new Date(NOW - 3_600_000).toISOString(),
  endsAt: new Date(NOW + 1_200_000).toISOString(),
  reserveDrops: String(12 * XRP),
  ticket: { nfTokenId: 'A'.repeat(64), seat: null, tier: 'deluxe' },
  bids: [],
}

/** The 201 from POST /auctions/:id/bid, plus whatever headroom fields apply. */
function mockApi(created: Record<string, unknown>) {
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

      if (url.includes('/bid') && method === 'POST') return json(created, 201)
      // Keep the bid pending so the signing screen stays put for assertions.
      if (url.match(/\/api\/bids\/[^/]+$/)) {
        return json({ bidId: 'bid-1', state: 'pending', amountDrops: String(20 * XRP), bidder: '@me' })
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    }),
  )
}

function baseCreated(extra: Record<string, unknown> = {}) {
  return {
    bidId: 'bid-1',
    uuid: 'a-uuid',
    next: 'https://xumm.app/sign/x',
    qrPng: 'https://xumm.app/sign/x.png',
    mode: 'stub',
    amountDrops: String(20 * XRP),
    ...extra,
  }
}

/** JSX breaks the sentence across lines, so compare on normalised whitespace. */
function textOf(el: HTMLElement) {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

async function placeBid() {
  fireEvent.change(screen.getByLabelText(/bid amount in XRP/i), { target: { value: '20' } })
  screen.getByRole('button', { name: /^bid$/i }).click()
  await screen.findByAltText(/xaman bid qr/i)
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('BidForm headroom warning', () => {
  it('warns, with the amount left, when the bid is tight', async () => {
    mockApi(baseCreated({ afterBidDrops: String(0.9 * XRP), tight: true }))

    render(
      <StrictMode>
        <BidForm auction={AUCTION} onPlaced={vi.fn()} />
      </StrictMode>,
    )
    await placeBid()

    const warning = await screen.findByRole('status')
    expect(textOf(warning)).toMatch(/0\.9 XRP spendable/i)
    // The consequence, not just the number — "you have 0.9 XRP left" means
    // nothing to someone who believes their bid is escrowed.
    expect(textOf(warning)).toMatch(/next bidder/i)
  })

  it('stays silent when the bid leaves room', async () => {
    mockApi(baseCreated({ afterBidDrops: String(80 * XRP), tight: false }))

    render(
      <StrictMode>
        <BidForm auction={AUCTION} onPlaced={vi.fn()} />
      </StrictMode>,
    )
    await placeBid()

    expect(screen.queryByRole('status')).toBeNull()
  })

  /**
   * The server omits both fields when it could not read the ledger. "We do not
   * know" must not render as "you have nothing left" — a warning shown on no
   * evidence trains people to dismiss the ones that matter.
   */
  it('says nothing when the ledger could not be read', async () => {
    mockApi(baseCreated())

    render(
      <StrictMode>
        <BidForm auction={AUCTION} onPlaced={vi.fn()} />
      </StrictMode>,
    )
    await placeBid()

    expect(screen.queryByRole('status')).toBeNull()
    // Still a working signing screen, not a broken one.
    expect(screen.getByAltText(/xaman bid qr/i)).toBeTruthy()
  })

  /**
   * The warning is worthless after signing, so it must be on the screen that
   * still has the QR — not surfaced once the bid is already committed.
   */
  it('shows the warning alongside the QR, while the bid can still be changed', async () => {
    mockApi(baseCreated({ afterBidDrops: String(0.5 * XRP), tight: true }))

    render(
      <StrictMode>
        <BidForm auction={AUCTION} onPlaced={vi.fn()} />
      </StrictMode>,
    )
    await placeBid()

    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    expect(screen.getByAltText(/xaman bid qr/i)).toBeTruthy()
  })
})
