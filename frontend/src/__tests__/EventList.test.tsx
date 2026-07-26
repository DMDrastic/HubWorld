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

// 'peachs-castle-afterparty' is the slug wired up in lib/mock-bids.
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
    render(<EventList events={[WITH_AUCTION]} onOpenAuction={onOpen} />)

    const button = screen.getByRole('button', { name: /view live bidding for peach/i })
    button.click()
    expect(onOpen).toHaveBeenCalledWith(WITH_AUCTION)
  })

  it('renders an event without an auction as a non-interactive row', () => {
    const onOpen = vi.fn()
    render(<EventList events={[WITHOUT]} onOpenAuction={onOpen} />)

    // No button at all — nothing to click that would open an empty window.
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('Neon District Launch')).toBeTruthy()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('marks only the auction event as live', () => {
    render(<EventList events={[WITH_AUCTION, WITHOUT]} onOpenAuction={vi.fn()} />)

    expect(screen.getAllByText('auction live')).toHaveLength(1)
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('still tells you to seed when there are no events', () => {
    render(<EventList events={[]} onOpenAuction={vi.fn()} />)
    expect(screen.getByText(/db:seed/)).toBeTruthy()
  })
})
