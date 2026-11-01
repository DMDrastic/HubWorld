/**
 * What an event row must say even when it says nothing visually.
 *
 * Carried over from the poster this replaces, case for case, because each of
 * these was a regression found in review rather than by any existing test, and
 * deleting a component must not quietly delete the coverage of behaviour that
 * still exists.
 *
 * 1. The title has to be in the accessibility tree. `getByRole('heading')` is
 *    deliberate: unlike `getByText` it respects `aria-hidden`, so it fails when
 *    the only copy of the title sits inside decorative artwork.
 *
 * 2. Every abnormal status has to be visible. `GET /api/events` applies no
 *    default filter, so DRAFT, COMPLETED and CANCELLED all arrive.
 *
 * WHAT THESE CANNOT CHECK: jsdom loads no stylesheet, so `hidden` and `sr-only`
 * are indistinguishable here. Computed visibility belongs in `e2e/`.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EventRow } from '@/components/EventRow'
import type { EventSummary } from '@/lib/api'
import { priced } from './usd'

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

const row = (e: EventSummary, live = false, onBuy?: (e: EventSummary) => void) =>
  render(
    <ol>
      <EventRow event={e} live={live} onOpenAuction={vi.fn()} onBuy={onBuy} />
    </ol>,
  )

describe('the title reaches the accessibility tree', () => {
  it('exposes a heading for an event with NO artwork', () => {
    row(event())
    expect(screen.getByRole('heading', { name: 'Roof Top Run' })).toBeTruthy()
  })

  it('exposes a heading for an event WITH artwork', () => {
    // The control: without it the case above could pass on a component that
    // renders headings for nobody.
    row(event({ imageUrl: 'https://example.test/a.jpg' }))
    expect(screen.getByRole('heading', { name: 'Roof Top Run' })).toBeTruthy()
  })

  it('keeps the heading when the row has a live auction', () => {
    // The button's aria-label names the CONTROL, not the event, and vanishes
    // the moment the auction ends.
    row(event(), true)
    expect(screen.getByRole('heading', { name: 'Roof Top Run' })).toBeTruthy()
  })

  it('says the event name exactly once in text, so nothing reads it twice', () => {
    // The fallback thumbnail paints the date and nothing else.
    row(event())
    expect(screen.getAllByText('Roof Top Run')).toHaveLength(1)
  })
})

describe('dates say enough to tell two events apart', () => {
  it('omits the year for an event this year', () => {
    const thisYear = new Date()
    thisYear.setMonth(11, 25)
    row(event({ startsAt: thisYear.toISOString() }))
    expect(screen.queryByText(new RegExp(String(thisYear.getFullYear())))).toBeNull()
  })

  it('shows the year for an event in a different one', () => {
    // Past and upcoming views can hold events a year apart that would both
    // read "Aug 16".
    const later = new Date()
    later.setFullYear(later.getFullYear() + 2)
    row(event({ startsAt: later.toISOString() }))
    expect(screen.getAllByText(new RegExp(String(later.getFullYear()))).length).toBeGreaterThan(0)
  })
})

describe('an abnormal status is never silent', () => {
  it.each([
    ['SOLD_OUT', 'sold out'],
    ['CANCELLED', 'cancelled'],
    ['DRAFT', 'draft'],
    ['COMPLETED', 'completed'],
  ] as const)('badges %s', (status, label) => {
    row(event({ status }))
    expect(screen.getByText(label)).toBeTruthy()
  })

  it('says nothing extra for an ordinary published event', () => {
    // A badge that appears on everything is not a status, it is decoration.
    row(event())
    expect(screen.queryByText('published')).toBeNull()
    expect(screen.queryByText('sold out')).toBeNull()
  })

  it('lets a live auction take the chip from a status', () => {
    row(event({ status: 'SOLD_OUT' }), true)
    expect(screen.getByText('auction live')).toBeTruthy()
    expect(screen.queryByText('sold out')).toBeNull()
  })
})

describe('the thumbnail, and the fallback when there is none', () => {
  it('renders the uploaded image when there is one', () => {
    const { container } = row(event({ imageUrl: 'https://example.test/a.jpg' }))
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.test/a.jpg')
  })

  it('renders no <img> at all when there is no poster', () => {
    // Not a broken image, not an empty src: nothing that could 404.
    const { container } = row(event())
    expect(container.querySelector('img')).toBeNull()
  })

  it('gives the same event the same colour every render', () => {
    const first = row(event())
    const a = first.container.querySelector('[data-fallback]')?.getAttribute('style')
    first.unmount()
    const second = row(event())
    const b = second.container.querySelector('[data-fallback]')?.getAttribute('style')

    expect(a).toBeTruthy()
    expect(a).toBe(b)
  })

  it('gives similar slugs DISTANT colours, not merely different ones', () => {
    // "Different" proves nothing: plain `hash % 360` also yields different hues,
    // just adjacent ones, and five of six real slugs landed inside a 44 degree
    // band of green so a run of fallbacks read as one event repeated.
    const hueOf = (slug: string): number => {
      const { container, unmount } = row(event({ slug }))
      const style = container.querySelector('[data-fallback]')!.getAttribute('style')!
      unmount()
      // The hue is the third component. Matched loosely because jsdom normalises
      // CSS numbers, so the authored `0.30` comes back as `0.3`.
      return Number(/oklch\([\d.]+\s+[\d.]+\s+([\d.]+)/.exec(style)![1])
    }

    const a = hueOf('roof-top-run')
    const b = hueOf('roof-top-rug')
    const apart = Math.abs(a - b)
    expect(Math.min(apart, 360 - apart)).toBeGreaterThan(40)
  })
})

describe('only a live auction makes a row act on its own', () => {
  it('has a button when an auction is live', () => {
    row(event(), true)
    expect(screen.getByRole('button', { name: /view live bidding for roof top run/i })).toBeTruthy()
  })

  it('has no button without one', () => {
    row(event())
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('opens the auction for this event', () => {
    const onOpen = vi.fn()
    const e = event()
    render(
      <ol>
        <EventRow event={e} live onOpenAuction={onOpen} />
      </ol>,
    )
    screen.getByRole('button', { name: /live bidding/i }).click()
    expect(onOpen).toHaveBeenCalledWith(e)
  })
})

/**
 * The Buy control appears only when buying can actually work, and it is a
 * SEPARATE control: never nested in the live-auction button, never sharing its
 * tab stop.
 */
describe('Buy', () => {
  const ON_SALE = priced(
    event({
      slug: 'neon-rooftop-session',
      title: 'Neon Rooftop Session',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      primaryPriceDrops: '25000000',
      ticketsForSale: 12,
    }),
  )

  const buyRow = (over: Partial<EventSummary> = {}, live = false, onBuy = vi.fn()) => {
    row({ ...ON_SALE, ...over }, live, onBuy)
    return onBuy
  }

  it('offers the price and how many are left, with a name that says what it does', () => {
    buyRow()
    const button = screen.getByRole('button', { name: /buy a ticket to neon rooftop session for US\$25\.00/i })
    expect(button.textContent).toMatch(/US\$25\.00/)
    expect(button.textContent).not.toMatch(/XRP/)
    expect(button.textContent).toMatch(/12 left/)
  })

  it('opens the box office for this event', () => {
    const onBuy = buyRow()
    screen.getByRole('button', { name: /buy a ticket/i }).click()
    expect(onBuy).toHaveBeenCalledWith(expect.objectContaining({ slug: ON_SALE.slug }))
  })

  it.each([
    ['has no price', { primaryPriceDrops: null }],
    ['has nothing left', { ticketsForSale: 0 }],
    ['does not report stock', { ticketsForSale: undefined }],
    ['is a draft', { status: 'DRAFT' as const }],
    ['is cancelled', { status: 'CANCELLED' as const }],
    ['is sold out', { status: 'SOLD_OUT' as const }],
  ])('offers nothing when the event %s', (_label, over) => {
    buyRow(over)
    expect(screen.queryByRole('button', { name: /buy a ticket/i })).toBeNull()
  })

  it('offers nothing while an auction is live: bidding is the way in then', () => {
    buyRow({}, true)
    expect(screen.queryByRole('button', { name: /buy a ticket/i })).toBeNull()
    expect(screen.getByRole('button', { name: /live bidding/i })).toBeTruthy()
  })

  it('offers nothing where no handler was given', () => {
    row(ON_SALE)
    expect(screen.queryByRole('button', { name: /buy a ticket/i })).toBeNull()
  })
})
