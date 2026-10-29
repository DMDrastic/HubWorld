/**
 * Your tickets on the Hub: up to four that float, a timeline for the rest.
 *
 * Rendered inside <StrictMode>, and with tickets that arrive AFTER first paint, because that is
 * how the page really loads: a default captured on the first render, when the lists are still
 * empty, once left the timeline on "Past" and showed last month before next week.
 */
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { Hub } from '@/components/Hub'
import { TicketStage, TicketTimeline } from '@/components/HubTickets'
import type { OwnedTicket, User } from '@/lib/api'

const day = 864e5

function ticket(id: string, startsInDays: number, over: Partial<OwnedTicket> = {}, eventOver = {}): OwnedTicket {
  return {
    nfTokenId: id.padEnd(64, 'a'),
    seat: null,
    tier: null,
    status: 'MINTED',
    syncedAt: null,
    onLedger: true,
    event: {
      slug: id,
      title: `Event ${id}`,
      startsAt: new Date(Date.now() + startsInDays * day + 3 * 36e5).toISOString(),
      ...eventOver,
    },
    canAuction: false,
    auctionBlockedReason: null,
    faceValueDrops: null,
    resaleAllowed: true,
    maxListingPriceDrops: null,
    maxAuctionReserveDrops: null,
    resaleBlockedReason: null,
    ...over,
  }
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

const me: User = {
  username: 'majula',
  displayName: null,
  xrplAddress: 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w',
  createdAt: new Date().toISOString(),
  role: 'ORGANIZER',
  ticketsOwned: 0,
}

function renderHub(tickets: OwnedTicket[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/auctions')) return json({ auctions: [] })
      return json({ address: 'r', verified: false, tickets })
    }),
  )
  return render(
    <StrictMode>
      <Hub me={me} onOpenAuction={vi.fn()} />
    </StrictMode>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the floating tickets', () => {
  it('floats at most four, however many tickets there are, soonest first', async () => {
    renderHub([6, 2, 5, 1, 4, 3].map((n) => ticket(`t${n}`, n)))
    const stage = await screen.findByRole('list', { name: 'Your next tickets' })
    const titles = within(stage)
      .getAllByRole('link')
      .map((a) => a.textContent)
    expect(titles).toHaveLength(4)
    expect(titles[0]).toContain('Event t1')
    expect(titles[3]).toContain('Event t4')
  })

  it('sends the rest to the timeline, not nowhere', async () => {
    renderHub([6, 2, 5, 1, 4, 3].map((n) => ticket(`t${n}`, n)))
    await screen.findByRole('list', { name: 'Your next tickets' })
    expect(await screen.findByRole('heading', { name: 'Event t5', level: 3 })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Event t6', level: 3 })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Event t4', level: 3 })).toBeNull()
  })

  it('shows no timeline at all when four or fewer tickets all float', async () => {
    renderHub([ticket('a', 1), ticket('b', 2)])
    await screen.findByRole('list', { name: 'Your next tickets' })
    expect(screen.queryByText('More tickets')).toBeNull()
    expect(screen.queryByText('Past tickets')).toBeNull()
  })

  it('says a ticket is listed or in auction in words, on the poster', () => {
    render(
      <TicketStage
        tickets={[ticket('l', 1, { status: 'LISTED' }), ticket('a', 2, { status: 'IN_AUCTION' }), ticket('n', 3)]}
      />,
    )
    expect(screen.getByText('listed')).toBeTruthy()
    expect(screen.getByText('in auction')).toBeTruthy()
    expect(screen.queryByText('used')).toBeNull()
  })

  it('shows the event poster where there is one, and the date tile where there is not', () => {
    const { container } = render(
      <TicketStage
        tickets={[ticket('art', 1, {}, { imageUrl: 'https://example.test/p.jpg' }), ticket('bare', 2)]}
      />,
    )
    const items = container.querySelectorAll('li')
    expect(items[0]!.querySelector('img')?.getAttribute('src')).toBe('https://example.test/p.jpg')
    expect(items[1]!.querySelector('img')).toBeNull()
    expect(items[1]!.querySelector('[data-fallback]')).not.toBeNull()
  })

  it('keeps each tilt on the outer element and the drift on a wrapper inside it', () => {
    const { container } = render(<TicketStage tickets={[ticket('a', 1), ticket('b', 2), ticket('c', 3)]} />)
    for (const li of container.querySelectorAll('li')) {
      expect((li as HTMLElement).style.transform).toMatch(/rotate\(-?\d+deg\)/)
      const drift = li.querySelector('.float-y') as HTMLElement
      expect(drift).not.toBeNull()
      expect(drift.style.transform).toBe('')
    }
  })

  it('gives every poster its own rhythm, so none rises with another', () => {
    const { container } = render(<TicketStage tickets={[1, 2, 3, 4].map((n) => ticket(`t${n}`, n))} />)
    const timings = [...container.querySelectorAll('.float-y')].map(
      (el) => `${(el as HTMLElement).style.getPropertyValue('--float-duration')}|${(el as HTMLElement).style.animationDelay}`,
    )
    expect(new Set(timings).size).toBe(4)
  })

  it('links each ticket to the page that holds the door code', () => {
    render(<TicketStage tickets={[ticket('a', 1)]} />)
    expect(screen.getByRole('link', { name: /Event a/ }).getAttribute('href')).toBe('/tickets')
  })
})

describe('the timeline', () => {
  it('opens on Upcoming when there are both, even though the tickets arrive after first paint', async () => {
    // The bug: a default chosen while both lists were empty stuck on "past".
    renderHub([...[1, 2, 3, 4, 5, 6].map((n) => ticket(`t${n}`, n)), ticket('old', -30, { status: 'REDEEMED' })])
    expect(await screen.findByRole('heading', { name: 'Event t5', level: 3 })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Upcoming', selected: true })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Event old', level: 3 })).toBeNull()
  })

  it('switches to Past on request, and shows a used ticket as used', async () => {
    renderHub([...[1, 2, 3, 4, 5].map((n) => ticket(`t${n}`, n)), ticket('old', -30, { status: 'REDEEMED' })])
    await screen.findByRole('heading', { name: 'Event t5', level: 3 })
    fireEvent.click(screen.getByRole('tab', { name: 'Past' }))
    expect(screen.getByRole('heading', { name: 'Event old', level: 3 })).toBeTruthy()
    expect(screen.getByText('used')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Event t5', level: 3 })).toBeNull()
  })

  it('offers no tabs when only one side has anything, and names it for what it is', () => {
    const { rerender } = render(<TicketTimeline upcoming={[]} past={[ticket('old', -9)]} />)
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByText('Past tickets')).toBeTruthy()
    rerender(<TicketTimeline upcoming={[ticket('x', 9)]} past={[]} />)
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByText('More tickets')).toBeTruthy()
  })

  it('prints a date once for tickets on the same day', () => {
    const same = new Date(Date.now() + 9 * day).toISOString()
    const { container } = render(
      <TicketTimeline
        upcoming={[
          ticket('p', 9, {}, { startsAt: same }),
          ticket('q', 9, {}, { startsAt: same }),
          ticket('r', 20),
        ]}
        past={[]}
      />,
    )
    // Wide layout date column: first of each day carries it, the second of a day does not.
    const dateCells = [...container.querySelectorAll('li > div:first-child')].map((d) => d.textContent)
    expect(dateCells.filter(Boolean)).toHaveLength(2)
  })
})

describe('an empty hub', () => {
  it('still says so, and offers the way out, when there are no tickets at all', async () => {
    renderHub([])
    expect(await screen.findByText('Your hub is empty')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Your next tickets' })).toBeNull()
  })

  it('is not "empty" when all there is, is history', async () => {
    renderHub([ticket('old', -9, { status: 'REDEEMED' })])
    expect(await screen.findByText('Past tickets')).toBeTruthy()
    expect(screen.queryByText('Your hub is empty')).toBeNull()
  })
})
