/**
 * The landing page's two honest-content features.
 *
 * The poster cloud shows REAL events and nothing else: with none there is no cloud,
 * and no poster is ever invented to fill the space. The create demo's colour is READ
 * from the poster the visitor picks, through the same code the real create page
 * uses, and it is labelled as an example because it is one.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Landing } from '@/components/Landing'
import { LandingCreateDemo } from '@/components/LandingCreateDemo'
import { LandingPosterCloud } from '@/components/LandingPosterCloud'
import { pickCloudEvents } from '@/lib/landing-events'
import type { EventSummary } from '@/lib/api'

const day = 86_400_000
function event(slug: string, over: Partial<EventSummary> = {}): EventSummary {
  return {
    slug,
    title: `Event ${slug}`,
    venue: null,
    startsAt: new Date(Date.now() + 3 * day).toISOString(),
    imageUrl: null,
    status: 'PUBLISHED',
    ticketCount: 10,
    ticketsMinted: 10,
    organizer: { username: 'o', displayName: null },
    ...over,
  }
}

describe('which events float around the headline', () => {
  it('shows only published and sold-out events, never a draft or a cancelled one', () => {
    const picked = pickCloudEvents([
      event('ok'),
      event('sold', { status: 'SOLD_OUT' }),
      event('draft', { status: 'DRAFT' }),
      event('off', { status: 'CANCELLED' }),
      event('done', { status: 'COMPLETED' }),
    ])
    expect(picked.map((e) => e.slug).sort()).toEqual(['ok', 'sold'])
  })

  it('puts events with artwork first, then the soonest', () => {
    const picked = pickCloudEvents([
      event('later', { startsAt: new Date(Date.now() + 9 * day).toISOString() }),
      event('soon', { startsAt: new Date(Date.now() + 1 * day).toISOString() }),
      event('art', { imageUrl: 'https://example.test/a.jpg', startsAt: new Date(Date.now() + 20 * day).toISOString() }),
    ])
    expect(picked.map((e) => e.slug)).toEqual(['art', 'soon', 'later'])
  })

  it('shows upcoming events ahead of past ones with the same artwork status', () => {
    const picked = pickCloudEvents([
      event('past', { startsAt: new Date(Date.now() - 30 * day).toISOString() }),
      event('next', { startsAt: new Date(Date.now() + 2 * day).toISOString() }),
    ])
    expect(picked.map((e) => e.slug)).toEqual(['next', 'past'])
  })

  it('never shows more than it has places for', () => {
    const many = Array.from({ length: 20 }, (_, i) => event(`e${i}`))
    expect(pickCloudEvents(many)).toHaveLength(8)
  })
})

describe('the poster cloud', () => {
  it('renders nothing at all when there are no events, rather than padding with invented ones', () => {
    const { container } = render(<LandingPosterCloud events={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when every event is a draft or cancelled', () => {
    const { container } = render(
      <LandingPosterCloud events={[event('d', { status: 'DRAFT' }), event('c', { status: 'CANCELLED' })]} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('names each poster by its event, as a link to the Events page', () => {
    render(<LandingPosterCloud events={[event('a', { title: 'Neon Rooftop' })]} />)
    // Both the wide and the narrow layouts render, so the link appears in each.
    const links = screen.getAllByRole('link', { name: 'Neon Rooftop' })
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) expect(link.getAttribute('href')).toBe('/events')
  })

  it('shows a real poster image where the event has one, and none where it does not', () => {
    const { container, rerender } = render(<LandingPosterCloud events={[event('a')]} />)
    expect(container.querySelector('img')).toBeNull()
    rerender(<LandingPosterCloud events={[event('a', { imageUrl: 'https://example.test/p.jpg' })]} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.test/p.jpg')
  })
})

describe('the landing headline', () => {
  it('is one h1, and the picked-out phrase is still part of its text', () => {
    render(<Landing onAuthenticated={vi.fn()} events={[]} />)
    const h1 = screen.getAllByRole('heading', { level: 1 })
    expect(h1).toHaveLength(1)
    // The gradient is paint; the words must read as one sentence to a screen reader.
    expect(h1[0]!.textContent).toBe('Your event keeps paying after the first sale.')
  })

  it('has no poster cloud, and no error, when no events were passed', () => {
    render(<Landing onAuthenticated={vi.fn()} />)
    expect(screen.queryByLabelText('Events on HubWorld')).toBeNull()
  })

  it('shows the real events it was given', () => {
    render(<Landing onAuthenticated={vi.fn()} events={[event('a', { title: 'Late Set' })]} />)
    expect(screen.getAllByRole('link', { name: 'Late Set' }).length).toBeGreaterThan(0)
  })
})

describe('the create demo', () => {
  it('says it is an example', () => {
    render(<LandingCreateDemo readTint={async () => null} />)
    expect(screen.getByText(/example event/i)).toBeTruthy()
  })

  it('offers three sample posters as one radio group, with the first chosen', () => {
    render(<LandingCreateDemo readTint={async () => null} />)
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
    expect((radios[0] as HTMLInputElement).checked).toBe(true)
  })

  it('swaps the poster when another is picked', () => {
    render(<LandingCreateDemo readTint={async () => null} />)
    const before = screen.getByAltText(/sample poster/i).getAttribute('src')
    fireEvent.click(screen.getAllByRole('radio')[2]!)
    expect(screen.getByAltText(/sample poster/i).getAttribute('src')).not.toBe(before)
  })

  it('reads the colour from the poster it is showing, not from a fixed value', async () => {
    const read = vi.fn(async (_url: string) => [255, 110, 0] as const)
    const { container } = render(<LandingCreateDemo readTint={read} />)
    await waitFor(() =>
      expect(container.querySelector('[data-demo-wash]')?.getAttribute('data-demo-wash')).toBe('on'),
    )
    const first = read.mock.calls[0]![0]
    fireEvent.click(screen.getAllByRole('radio')[1]!)
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(1))
    // A different poster means a different image was handed to the reader.
    expect(read.mock.calls.at(-1)![0]).not.toBe(first)
  })

  it('stays neutral, and keeps working, where the colour cannot be read', async () => {
    const { container } = render(<LandingCreateDemo readTint={async () => null} />)
    fireEvent.click(screen.getAllByRole('radio')[1]!)
    await waitFor(() => expect(container.querySelector('[data-demo-wash]')).not.toBeNull())
    expect(container.querySelector('[data-demo-wash]')?.getAttribute('data-demo-wash')).toBe('off')
    expect(screen.getByRole('link', { name: /create yours/i }).getAttribute('href')).toBe('#hero-signin')
  })
})
