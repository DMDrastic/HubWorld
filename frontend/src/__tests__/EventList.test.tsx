/**
 * Auction gating on the event list.
 *
 * The rule: only an event with a live auction is interactive. Making every row
 * clickable would open an empty auction window, and a control that does nothing
 * is worse than no control — so the absence of a button on a normal event is the
 * thing being asserted, not an implementation detail.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EventList } from '@/App'
import type { EventSummary } from '@/lib/api'

// Which slugs have a live auction now comes from GET /api/auctions, so the test
// states it explicitly rather than depending on fixture data.
const LIVE = new Set(['peachs-castle-afterparty'])

function event(slug: string, title: string, status: EventSummary['status'] = 'PUBLISHED'): EventSummary {
  return {
    slug,
    title,
    venue: 'Hub World',
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    status,
    ticketCount: 200,
    ticketsMinted: 200,
    organizer: { username: 'stationsquare', displayName: null },
  }
}

const WITH_AUCTION = event('peachs-castle-afterparty', "Peach's Castle Afterparty", 'SOLD_OUT')
const WITHOUT = event('neon-district-launch', 'Neon District Launch')

describe('EventList auction gating', () => {
  it('makes an event with a live auction activatable', () => {
    const onOpen = vi.fn()
    render(<EventList events={[WITH_AUCTION]} auctionSlugs={LIVE} onOpenAuction={onOpen} />)

    const button = screen.getByRole('button', { name: /view live bidding for peach/i })
    button.click()
    expect(onOpen).toHaveBeenCalledWith(WITH_AUCTION)
  })

  it('renders an event without an auction as a non-interactive row', () => {
    const onOpen = vi.fn()
    render(<EventList events={[WITHOUT]} auctionSlugs={LIVE} onOpenAuction={onOpen} />)

    // No button at all — nothing to click that would open an empty window.
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('Neon District Launch')).toBeTruthy()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('marks only the auction event as live', () => {
    render(<EventList events={[WITH_AUCTION, WITHOUT]} auctionSlugs={LIVE} onOpenAuction={vi.fn()} />)

    expect(screen.getAllByText('auction live')).toHaveLength(1)
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('treats an empty auction set as no auctions anywhere', () => {
    // Guards the failure mode where the auctions request fails and every event
    // silently becomes clickable.
    render(
      <EventList events={[WITH_AUCTION, WITHOUT]} auctionSlugs={new Set()} onOpenAuction={vi.fn()} />,
    )
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText('auction live')).toBeNull()
  })

  it('still tells you to seed when there are no events', () => {
    render(<EventList events={[]} auctionSlugs={LIVE} onOpenAuction={vi.fn()} />)
    expect(screen.getByText(/db:seed/)).toBeTruthy()
  })
})
