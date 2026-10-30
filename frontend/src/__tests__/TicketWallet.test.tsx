/**
 * The tickets a holder keeps, drawn as tickets.
 *
 * The page this lives on used to be a gift form and a handle lookup, so a holder
 * with a ticket saw two utility cards and nothing that said "you have one". What
 * is pinned here is the thing that was missing: a ticket is on the page, says
 * what it is and whether it is good, and is the way into gifting it.
 *
 * Rendered in <StrictMode> like every data-loading component here.
 */
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { TicketWallet } from '@/components/TicketWallet'

const ticket = (over: Record<string, unknown> = {}, event: Record<string, unknown> = {}) => ({
  nfTokenId: '00081388E82223A2A5150D5AADF7D8E5F5E3AC44D31AB0D402ACCC570127D521',
  seat: null,
  tier: null,
  status: 'MINTED',
  syncedAt: null,
  onLedger: null,
  event: {
    slug: 'neon-rooftop-session',
    title: 'Neon Rooftop Session',
    startsAt: '2026-10-21T14:25:00.000Z',
    venue: null,
    imageUrl: null,
    ...event,
  },
  canAuction: false,
  auctionBlockedReason: null,
  faceValueDrops: null,
  resaleAllowed: true,
  maxListingPriceDrops: null,
  maxAuctionReserveDrops: null,
  resaleBlockedReason: null,
  ...over,
})

function mockInventory(tickets: unknown[] | 'fail') {
  const calls = { inventory: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/tickets/mine')) {
        calls.inventory += 1
        if (tickets === 'fail') return new Response('{}', { status: 500 })
        return new Response(JSON.stringify({ address: 'rHolder', verified: false, tickets }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
  return calls
}

const renderWallet = (onGift = vi.fn(), version = 0) =>
  render(
    <StrictMode>
      <TicketWallet version={version} onGift={onGift} />
    </StrictMode>,
  )

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('TicketWallet', () => {
  it('shows a held ticket as a ticket, and says there is one', async () => {
    mockInventory([ticket()])
    renderWallet()

    expect(await screen.findByRole('heading', { name: /you have 1 ticket$/i })).toBeTruthy()
    const card = screen.getByRole('article', { name: /ticket for neon rooftop session/i })
    expect(card.textContent).toMatch(/admit one/i)
    expect(card.textContent).toMatch(/valid/i)
    expect(card.textContent).toMatch(/general admission/i)
    expect(card.textContent).toMatch(/oct/i)
  })

  it('counts several tickets and draws each one', async () => {
    mockInventory([
      ticket({ nfTokenId: 'A'.repeat(64) }),
      ticket({ nfTokenId: 'B'.repeat(64) }, { slug: 'other-night', title: 'Other Night' }),
    ])
    renderWallet()

    expect(await screen.findByRole('heading', { name: /you have 2 tickets/i })).toBeTruthy()
    expect(screen.getAllByRole('article')).toHaveLength(2)
  })

  it('shows the place and the seat when there are any, and not their absence', async () => {
    mockInventory([ticket({ tier: 'VIP', seat: 'A12' }, { venue: 'Openfield Stadium' })])
    renderWallet()

    const card = await screen.findByRole('article')
    expect(card.textContent).toMatch(/openfield stadium/i)
    expect(card.textContent).toMatch(/vip · a12/i)
    expect(card.textContent).not.toMatch(/general admission/i)
  })

  it('carries the event artwork as a thumbnail when there is some, and nothing when there is not', async () => {
    mockInventory([
      ticket({ nfTokenId: 'A'.repeat(64) }, { slug: 'has-art', title: 'Has Art', imageUrl: 'https://img.example/poster.png' }),
      ticket({ nfTokenId: 'B'.repeat(64) }, { slug: 'no-art', title: 'No Art', imageUrl: null }),
    ])
    renderWallet()

    const withArt = await screen.findByRole('article', { name: /ticket for has art/i })
    const withoutArt = screen.getByRole('article', { name: /ticket for no art/i })
    expect(withArt.querySelector('img')?.getAttribute('src')).toBe('https://img.example/poster.png')
    expect(withoutArt.querySelector('img')).toBeNull()
  })

  it('offers the Gift button on a valid ticket and hands back WHICH ticket', async () => {
    const onGift = vi.fn()
    mockInventory([ticket({ nfTokenId: 'C'.repeat(64) })])
    renderWallet(onGift)

    const button = (await screen.findByRole('button', { name: /gift the neon rooftop session ticket/i })) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    button.click()

    expect(onGift).toHaveBeenCalledExactlyOnceWith('C'.repeat(64))
  })

  it('says a used ticket is used and does not offer to gift it (positive control above)', async () => {
    mockInventory([ticket({ status: 'REDEEMED' })])
    renderWallet()

    const card = await screen.findByRole('article')
    expect(card.textContent).toMatch(/used/i)
    expect(card.textContent).not.toMatch(/\bvalid\b/i)
    expect((screen.getByRole('button', { name: /gift the/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says a ticket on sale is on sale, and will not gift it', async () => {
    mockInventory([ticket({ status: 'LISTED' })])
    renderWallet()

    expect((await screen.findByRole('article')).textContent).toMatch(/listed for sale/i)
    expect((screen.getByRole('button', { name: /gift the/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('warns when the ledger disagrees that the ticket is in the wallet', async () => {
    mockInventory([ticket({ onLedger: false })])
    renderWallet()

    expect((await screen.findByRole('article')).textContent).toMatch(/can't find this ticket in your wallet/i)
  })

  it('does not show a burned ticket', async () => {
    mockInventory([ticket({ status: 'BURNED' })])
    renderWallet()

    expect(await screen.findByText(/no tickets yet/i)).toBeTruthy()
    expect(screen.queryByRole('article')).toBeNull()
  })

  it('invites a holder with none to browse events, rather than showing an empty page', async () => {
    mockInventory([])
    renderWallet()

    expect(await screen.findByText(/no tickets yet/i)).toBeTruthy()
    expect((screen.getByRole('link', { name: /browse events/i }) as HTMLAnchorElement).getAttribute('href')).toBe('/events')
  })

  it('does not call a failed load "no tickets" (unknown is not "none")', async () => {
    mockInventory('fail')
    renderWallet()

    expect(await screen.findByText(/couldn't load your tickets/i)).toBeTruthy()
    expect(screen.queryByText(/no tickets yet/i)).toBeNull()
  })

  it('loads once, and again only when the page says something may have moved', async () => {
    const calls = mockInventory([ticket()])
    const { rerender } = renderWallet(vi.fn(), 0)
    await screen.findByRole('article')
    // StrictMode mounts effects twice in development; what matters is that it is bounded.
    const first = calls.inventory
    expect(first).toBeLessThanOrEqual(2)

    rerender(
      <StrictMode>
        <TicketWallet version={0} onGift={vi.fn()} />
      </StrictMode>,
    )
    expect(calls.inventory).toBe(first)

    rerender(
      <StrictMode>
        <TicketWallet version={1} onGift={vi.fn()} />
      </StrictMode>,
    )
    await waitFor(() => expect(calls.inventory).toBeGreaterThan(first))
  })

  describe('showing it at the door', () => {
    const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

    it('offers "Show at the door" on a valid ticket and opens the guide', async () => {
      mockInventory([ticket({}, { startsAt: inHours(48) })])
      renderWallet()

      ;(await screen.findByRole('button', { name: /show the neon rooftop session ticket at the door/i })).click()

      expect(await screen.findByRole('dialog', { name: /at the door/i })).toBeTruthy()
    })

    it('does not offer it on a ticket that has been used (positive control above)', async () => {
      mockInventory([ticket({ status: 'REDEEMED' }, { startsAt: inHours(48) })])
      renderWallet()

      await screen.findByRole('article')
      expect(screen.queryByRole('button', { name: /at the door/i })).toBeNull()
    })

    it('treats the day around the event as "soon", and a far-off one as not', async () => {
      mockInventory([
        ticket({ nfTokenId: 'A'.repeat(64) }, { slug: 'tonight', title: 'Tonight', startsAt: inHours(5) }),
        ticket({ nfTokenId: 'B'.repeat(64) }, { slug: 'later', title: 'Later', startsAt: inHours(24 * 30) }),
        ticket({ nfTokenId: 'C'.repeat(64) }, { slug: 'long-ago', title: 'Long Ago', startsAt: inHours(-24 * 3) }),
      ])
      renderWallet()

      expect((await screen.findByRole('article', { name: /ticket for tonight/i })).getAttribute('data-soon')).toBe('true')
      expect(screen.getByRole('article', { name: /ticket for later/i }).getAttribute('data-soon')).toBe('false')
      expect(screen.getByRole('article', { name: /ticket for long ago/i }).getAttribute('data-soon')).toBe('false')
    })
  })
})

describe('TicketWallet: ordering, timing and resale context', () => {
  const day = 864e5
  const inDays = (n: number) => new Date(Date.now() + n * day + 2 * 36e5).toISOString()
  const t = (id: string, startsInDays: number, over: Record<string, unknown> = {}, ev: Record<string, unknown> = {}) =>
    ticket(
      { nfTokenId: id.padEnd(64, 'A'), ...over },
      { slug: id, title: `Event ${id}`, startsAt: inDays(startsInDays), ...ev },
    )
  const titles = () => screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)

  it('puts the soonest night first, whatever order the tickets were minted in', async () => {
    mockInventory([t('later', 9), t('soon', 1), t('mid', 4)])
    render(
      <StrictMode>
        <TicketWallet version={0} onGift={vi.fn()} />
      </StrictMode>,
    )
    await screen.findByRole('heading', { name: 'Event soon', level: 3 })
    expect(titles()).toEqual(['Event soon', 'Event mid', 'Event later'])
  })

  it('keeps used and finished tickets, after the upcoming ones and under their own heading', async () => {
    mockInventory([t('old', -20), t('used', 2, { status: 'REDEEMED' }), t('soon', 1)])
    render(
      <StrictMode>
        <TicketWallet version={0} onGift={vi.fn()} />
      </StrictMode>,
    )
    await screen.findByRole('heading', { name: 'Event soon', level: 3 })
    expect(screen.getByText('Past')).toBeTruthy()
    // Nothing is hidden: this is the page that holds all of them, soonest night first.
    expect(titles()).toHaveLength(3)
    expect(titles()[0]).toBe('Event soon')
  })

  it('names the next night and when it is, from real dates', async () => {
    mockInventory([t('soon', 1), t('later', 6)])
    render(
      <StrictMode>
        <TicketWallet version={0} onGift={vi.fn()} />
      </StrictMode>,
    )
    expect(await screen.findByText(/Next:/)).toBeTruthy()
    expect(screen.getByText(/Next:/).textContent).toContain('Event soon, tomorrow')
  })

  it('marks an upcoming ticket with how far off it is, and a used one with nothing', async () => {
    mockInventory([t('soon', 1), t('used', 1, { status: 'REDEEMED' })])
    render(
      <StrictMode>
        <TicketWallet version={0} onGift={vi.fn()} />
      </StrictMode>,
    )
    await screen.findByRole('heading', { name: 'Event soon', level: 3 })
    // One chip, on the ticket that can still be used.
    expect(screen.getAllByText('Tomorrow')).toHaveLength(1)
  })

  it('says what the box office and the organizer allow, only when they are known', async () => {
    mockInventory([
      t('priced', 2, { faceValueDrops: '25000000', maxListingPriceDrops: '30000000' }),
      t('bare', 3),
    ])
    render(
      <StrictMode>
        <TicketWallet version={0} onGift={vi.fn()} />
      </StrictMode>,
    )
    expect(await screen.findByText('Face value 25 XRP · resale up to 30 XRP')).toBeTruthy()
    // The ticket with no known terms says nothing, rather than "0 XRP".
    expect(screen.getAllByText(/face value/i)).toHaveLength(1)
  })

  it('says resale is not allowed, in place of a price, when the organizer forbids it', async () => {
    mockInventory([t('shut', 2, { resaleAllowed: false, faceValueDrops: '25000000' })])
    render(
      <StrictMode>
        <TicketWallet version={0} onGift={vi.fn()} />
      </StrictMode>,
    )
    expect(await screen.findByText('Resale is not allowed for this event')).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Sell the Event shut ticket/ })).toBeNull()
  })

  it('offers to sell a ticket you could sell, on the marketplace, and not one that is listed or used', async () => {
    mockInventory([t('ok', 2), t('listed', 3, { status: 'LISTED' }), t('used', 4, { status: 'REDEEMED' })])
    render(
      <StrictMode>
        <TicketWallet version={0} onGift={vi.fn()} />
      </StrictMode>,
    )
    const sell = await screen.findByRole('link', { name: 'Sell the Event ok ticket' })
    expect(sell.getAttribute('href')).toBe('/market')
    expect(screen.getAllByRole('link', { name: /^Sell the / })).toHaveLength(1)
  })
})
