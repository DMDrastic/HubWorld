/**
 * Ticket selection in the sell/auction form.
 *
 * Regression: the default-selection effect picked `inv.tickets[0]` — the RAW
 * inventory response — instead of the FILTERED sellable list the dropdown is
 * actually built from. A ticket that is already LISTED or IN_AUCTION can
 * still be `inv.tickets[0]` (inventory is ordered by mint time, not by
 * sellability), so on a fresh load the form silently defaulted to a ticket
 * the dropdown doesn't even offer as an option — and submitting "List"
 * targeted that wrong, already-committed ticket instead of the one visibly
 * selected. Found live, in a browser, not by this test: this test exists
 * because that reproduction should have been a unit test from the start.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { SellPanel } from '@/components/SellPanel'

const LISTED_TICKET = '1111111111111111111111111111111111111111111111111111111111111111'.slice(0, 64)
const SELLABLE_TICKET = '2222222222222222222222222222222222222222222222222222222222222222'.slice(0, 64)

function ticket(nfTokenId: string, status: 'MINTED' | 'LISTED') {
  return {
    nfTokenId,
    seat: null,
    tier: null,
    status,
    syncedAt: new Date().toISOString(),
    onLedger: true,
    event: { slug: 'neon-rooftop-session', title: 'Neon Rooftop Session', startsAt: new Date().toISOString() },
    canAuction: false,
    auctionBlockedReason: 'This event is not sold out yet.',
    faceValueDrops: null,
    resaleAllowed: true,
    maxListingPriceDrops: null,
    maxAuctionReserveDrops: null,
    resaleBlockedReason: null,
  }
}

/**
 * Inventory ordered LISTED-first, MINTED-second — matches the real failure:
 * `/tickets/mine` orders by mint time, not sellability, so the already-listed
 * ticket (minted first, listed since) sorts ahead of the one still available.
 */
const INVENTORY = {
  address: 'r4wQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf',
  verified: true,
  tickets: [ticket(LISTED_TICKET, 'LISTED'), ticket(SELLABLE_TICKET, 'MINTED')],
}

const CREATED = {
  listingId: 'cccccccc-1111-4222-8333-444444444444',
  uuid: 'ffffffff-1111-4222-8333-444444444444',
  next: 'https://xaman.app/sign/z',
  qrPng: 'data:image/png;base64,CCCC',
  mode: 'live' as const,
}

function mockApi() {
  const listCalls: string[] = []

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
      if (url.includes('/listings/mine')) return json({ listings: [] })
      if (url === 'http://localhost/api/listings' || url.endsWith('/api/listings'))
        return json({ listings: [] })
      if (url.includes('/list') && method === 'POST') {
        listCalls.push(url)
        return json(CREATED, 201)
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    }),
  )

  return listCalls
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SellPanel ticket selection', () => {
  it('defaults to a sellable ticket, not an already-listed one that sorts first', async () => {
    mockApi()

    render(
      <StrictMode>
        <SellPanel onChanged={vi.fn()} />
      </StrictMode>,
    )

    const select = await screen.findByLabelText('ticket to sell')
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe(SELLABLE_TICKET))

    // The already-listed ticket must not even be offered as an option — it's
    // committed elsewhere, same assertion as the dropdown's own filter.
    const optionValues = Array.from(select.querySelectorAll('option')).map(
      (o) => (o as HTMLOptionElement).value,
    )
    expect(optionValues).toEqual([SELLABLE_TICKET])
  })

  it('submits the sellable ticket shown, not the stale already-listed one', async () => {
    const listCalls = mockApi()

    render(
      <StrictMode>
        <SellPanel onChanged={vi.fn()} />
      </StrictMode>,
    )

    await screen.findByLabelText('ticket to sell')
    const priceInput = await screen.findByLabelText('price in XRP')
    fireEvent.change(priceInput, { target: { value: '10' } })
    screen.getByRole('button', { name: /^List$/ }).click()

    await waitFor(() => expect(listCalls.length).toBeGreaterThan(0))
    expect(listCalls[0]).toContain(encodeURIComponent(SELLABLE_TICKET))
    expect(listCalls[0]).not.toContain(encodeURIComponent(LISTED_TICKET))
  })
})
