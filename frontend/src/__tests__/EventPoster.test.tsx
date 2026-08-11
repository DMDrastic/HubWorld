/**
 * What the poster must say even when it says nothing visually.
 *
 * These two properties were both REGRESSIONS against `EventCard`, introduced by
 * the poster redesign and caught in review rather than by any existing test —
 * `getByText` ignores `aria-hidden`, so the whole suite stayed green while a
 * screen reader got nothing.
 *
 * 1. The title has to be in the accessibility tree. `FallbackPoster` is
 *    `aria-hidden`, so an image-less event whose only title lived inside it had
 *    no name at all: a user heard the date and the venue and moved on, and
 *    heading navigation found nothing on a page that is entirely a list of
 *    events.
 *
 * 2. Every abnormal status has to be visible. `GET /api/events` applies no
 *    default filter, so DRAFT, COMPLETED and CANCELLED events are all in the
 *    response, and only SOLD_OUT was badged — a cancelled event rendered
 *    identically to one you could still attend.
 *
 * WHAT THESE CANNOT CHECK, stated so nobody assumes otherwise. jsdom loads no
 * stylesheet, so `sr-only` and `hidden` are indistinguishable here — both are
 * just a class string. That difference matters enormously (`hidden` is
 * `display:none`, which takes the heading away from screen readers again, i.e.
 * silently reintroduces the exact bug), and swapping one for the other leaves
 * all nine of these passing. Verified by mutation rather than assumed.
 *
 * What IS pinned is that the element exists in the document for both cases,
 * which is the regression that actually happened. Anything about computed
 * visibility belongs in `e2e/`, per the rule that Playwright exists only for
 * what jsdom structurally cannot answer.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EventPoster } from '@/components/EventPoster'
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

describe('the title reaches the accessibility tree', () => {
  it('exposes a heading for an event with NO artwork', () => {
    // The case that was broken. `getByRole('heading')` is deliberate: unlike
    // getByText it respects aria-hidden, so it fails when the only copy of the
    // title is inside the decorative fallback poster.
    render(<EventPoster event={event()} live={false} onOpenAuction={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Roof Top Run' })).toBeTruthy()
  })

  it('exposes a heading for an event WITH artwork', () => {
    // The control. Without it the test above could pass on a component that
    // renders headings for nobody.
    render(
      <EventPoster
        event={event({ imageUrl: 'https://example.test/a.jpg' })}
        live={false}
        onOpenAuction={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Roof Top Run' })).toBeTruthy()
  })

  it('keeps the heading when the poster is a button', () => {
    // A live auction wraps the whole thing in a button with its own aria-label.
    // That label is not a substitute: it names the CONTROL, not the event, and
    // it disappears the moment the auction ends.
    render(<EventPoster event={event()} live onOpenAuction={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Roof Top Run' })).toBeTruthy()
  })
})

describe('the surrounding layout can take over naming the event', () => {
  it('renders no heading at all when titled is false', () => {
    // The single-auction feature layout sets its own text-3xl heading beside the
    // poster. Without this the name appeared twice, adjacent — and since one
    // live auction is the ordinary case, that was the DEFAULT rendering.
    render(
      <EventPoster event={event()} live interactive={false} titled={false} onOpenAuction={vi.fn()} />,
    )

    expect(screen.queryByRole('heading')).toBeNull()
    // Nowhere at all, not merely un-headed: the fallback poster paints the title
    // as artwork, and leaving that would still show it twice on screen.
    expect(screen.queryByText('Roof Top Run')).toBeNull()
  })

  it('still shows the date and venue, which the poster owns either way', () => {
    render(
      <EventPoster event={event()} live interactive={false} titled={false} onOpenAuction={vi.fn()} />,
    )

    // getAllBy, because the venue legitimately appears twice on a fallback: set
    // in mono on the poster as part of the artwork, and again in the caption.
    // Unlike the title that is intended — it is a detail, not the name of the
    // thing, and the poster would look unfinished without it.
    expect(screen.getAllByText(/Spagonia Square/).length).toBeGreaterThan(0)
  })
})

describe('dates say enough to tell two events apart', () => {
  it('omits the year for an event this year', () => {
    // Noise on the 90% of events happening within a few months.
    const thisYear = new Date()
    thisYear.setMonth(11, 25)
    render(
      <EventPoster
        event={event({ startsAt: thisYear.toISOString() })}
        live={false}
        onOpenAuction={vi.fn()}
      />,
    )

    expect(screen.queryByText(new RegExp(String(thisYear.getFullYear())))).toBeNull()
  })

  it('shows the year for an event in a different one', () => {
    // /events is not filtered by date, so two events a year apart sit in the
    // same grid — and both read "16 Aug" with nothing to distinguish them.
    const nextYear = new Date()
    nextYear.setFullYear(nextYear.getFullYear() + 2)
    render(
      <EventPoster
        event={event({ startsAt: nextYear.toISOString() })}
        live={false}
        onOpenAuction={vi.fn()}
      />,
    )

    expect(screen.getAllByText(new RegExp(String(nextYear.getFullYear()))).length).toBeGreaterThan(0)
  })
})

describe('an abnormal status is never silent', () => {
  it.each([
    ['SOLD_OUT', 'sold out'],
    ['CANCELLED', 'cancelled'],
    ['DRAFT', 'draft'],
    ['COMPLETED', 'completed'],
  ] as const)('badges %s', (status, label) => {
    render(
      <EventPoster event={event({ status })} live={false} onOpenAuction={vi.fn()} />,
    )

    expect(screen.getByText(label)).toBeTruthy()
  })

  it('says nothing extra for an ordinary published event', () => {
    // The control for the four above: a badge that appears on everything is not
    // a status, it is decoration.
    render(<EventPoster event={event()} live={false} onOpenAuction={vi.fn()} />)

    expect(screen.queryByText('published')).toBeNull()
    expect(screen.queryByText('sold out')).toBeNull()
  })

  it('lets a live auction take the corner from a status badge', () => {
    // One badge, not two in the same place. The auction is the more urgent
    // fact, and it already implies the event is not on general sale.
    render(<EventPoster event={event({ status: 'SOLD_OUT' })} live onOpenAuction={vi.fn()} />)

    expect(screen.getByText('auction live')).toBeTruthy()
    expect(screen.queryByText('sold out')).toBeNull()
  })
})
