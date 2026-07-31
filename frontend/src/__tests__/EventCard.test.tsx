/**
 * The poster, and what happens when there isn't one.
 *
 * Most events will have no artwork, especially early, so the no-image path is
 * the common case rather than the edge — a broken-image icon would make the
 * whole page look unfinished. The fallback has to be deterministic too: an event
 * that changed colour on every reload would read as a rendering bug.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EventCard } from '@/components/EventCard'
import type { EventSummary } from '@/lib/api'

function event(over: Partial<EventSummary> = {}): EventSummary {
  return {
    slug: 'roof-top-run',
    title: 'Roof Top Run',
    venue: 'Spagonia Square',
    startsAt: new Date('2026-08-19T23:16:00Z').toISOString(),
    imageUrl: null,
    status: 'PUBLISHED',
    ticketCount: 4,
    ticketsMinted: 4,
    organizer: { username: 'dm_drastic', displayName: null },
    ...over,
  }
}

describe('EventCard poster', () => {
  it('renders the uploaded image when there is one', () => {
    const { container } = render(
      <EventCard event={event({ imageUrl: 'https://example.test/a.jpg' })} live={false} onOpenAuction={vi.fn()} />,
    )
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://example.test/a.jpg')
  })

  it('renders no <img> at all when there is no poster', () => {
    // Not a broken image, not an empty src — nothing that could 404.
    const { container } = render(<EventCard event={event()} live={false} onOpenAuction={vi.fn()} />)
    expect(container.querySelector('img')).toBeNull()
  })

  it('gives the same event the same colour every render', () => {
    const first = render(<EventCard event={event()} live={false} onOpenAuction={vi.fn()} />)
    const a = first.container.querySelector('[style*="linear-gradient"]')?.getAttribute('style')
    first.unmount()
    const second = render(<EventCard event={event()} live={false} onOpenAuction={vi.fn()} />)
    const b = second.container.querySelector('[style*="linear-gradient"]')?.getAttribute('style')
    expect(a).toBeTruthy()
    expect(a).toBe(b)
  })

  it('gives different events different colours', () => {
    const { container: one } = render(
      <EventCard event={event({ slug: 'aaa' })} live={false} onOpenAuction={vi.fn()} />,
    )
    const { container: two } = render(
      <EventCard event={event({ slug: 'zzz-different' })} live={false} onOpenAuction={vi.fn()} />,
    )
    const a = one.querySelector('[style*="linear-gradient"]')?.getAttribute('style')
    const b = two.querySelector('[style*="linear-gradient"]')?.getAttribute('style')
    expect(a).not.toBe(b)
  })

  it("uses the title's first letter as the fallback mark", () => {
    render(<EventCard event={event({ title: '  neon district' })} live={false} onOpenAuction={vi.fn()} />)
    expect(screen.getByText('N')).toBeTruthy()
  })
})

describe('EventCard interactivity', () => {
  // Same rule the old list enforced: a control that opens an empty window is
  // worse than no control, so only a live auction makes a card activatable.
  it('is a button only when an auction is live', () => {
    render(<EventCard event={event()} live onOpenAuction={vi.fn()} />)
    expect(screen.getByRole('button', { name: /View live bidding for Roof Top Run/ })).toBeTruthy()
  })

  it('is not a button without one', () => {
    render(<EventCard event={event()} live={false} onOpenAuction={vi.fn()} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('the poster is decorative, so it does not repeat the title to a screen reader', () => {
    const { container } = render(
      <EventCard event={event({ imageUrl: 'https://example.test/a.jpg' })} live={false} onOpenAuction={vi.fn()} />,
    )
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('')
  })
})
