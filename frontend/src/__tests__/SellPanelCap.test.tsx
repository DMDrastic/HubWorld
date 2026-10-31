/**
 * What the seller is told about the price limit, and where it comes from.
 *
 * Under the new fee model the limit can be what the ticket's buyer paid rather than the organizer's policy. The
 * seller should be told that plainly. An older server that says nothing about the source, and a limit that really
 * is the organizer's, keep the wording they have always had.
 */
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SellPanel } from '@/components/SellPanel'

const TOKEN = 'A'.repeat(64)

function inventory(over: object) {
  return {
    address: 'r4wQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf',
    verified: true,
    tickets: [
      {
        nfTokenId: TOKEN,
        seat: null,
        tier: null,
        status: 'MINTED',
        syncedAt: new Date().toISOString(),
        onLedger: true,
        event: { slug: 'neon', title: 'Neon Night', startsAt: new Date().toISOString() },
        canAuction: false,
        auctionBlockedReason: null,
        faceValueDrops: '6000000',
        resaleAllowed: true,
        maxListingPriceDrops: '8000000',
        maxAuctionReserveDrops: '8000000',
        resaleBlockedReason: null,
        ...over,
      },
    ],
  }
}

function mount(over: object) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/tickets/mine')) return json(inventory(over))
      if (url.includes('/listings')) return json({ listings: [] })
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
  render(
    <StrictMode>
      <SellPanel onChanged={() => {}} />
    </StrictMode>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the limit shown to a seller', () => {
  it('says so when the limit is what the buyer paid', async () => {
    mount({ resaleCapSource: 'PAID' })
    expect(await screen.findByText(/capped at what the buyer paid/i)).toBeTruthy()
    expect(screen.getByText(/up to 8(\.0+)? XRP/)).toBeTruthy()
    expect(screen.queryByText(/organizer resale limit/i)).toBeNull()
  })

  it('keeps the organizer wording when the limit is the organizer\'s policy', async () => {
    mount({ resaleCapSource: 'POLICY' })
    expect(await screen.findByText(/organizer resale limit/i)).toBeTruthy()
    expect(screen.queryByText(/capped at what the buyer paid/i)).toBeNull()
  })

  it('keeps the organizer wording on an older server that does not say where the limit comes from', async () => {
    mount({})
    expect(await screen.findByText(/organizer resale limit/i)).toBeTruthy()
  })

  it('tells the seller a free ticket cannot be sold for money, and that it can still be given away', async () => {
    mount({ resaleCapSource: 'PAID', maxListingPriceDrops: '0', maxAuctionReserveDrops: '0' })
    expect(await screen.findByText(/free/i)).toBeTruthy()
    expect(screen.getByText(/give/i)).toBeTruthy()
  })
})
