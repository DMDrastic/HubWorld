/**
 * The Buy control on a poster. It appears only when buying can actually work, and
 * it is a SEPARATE control — never nested in the live-auction button, never
 * sharing its tab stop.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EventPoster } from '@/components/EventPoster'
import type { EventSummary } from '@/lib/api'

const EVENT: EventSummary = {
  slug: 'neon-rooftop-session',
  title: 'Neon Rooftop Session',
  venue: 'Hub World',
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  status: 'PUBLISHED',
  ticketCount: 100,
  ticketsMinted: 100,
  primaryPriceDrops: '25000000',
  ticketsForSale: 12,
  organizer: { username: 'dm_drastic', displayName: null },
}

const poster = (over: Partial<EventSummary> = {}, live = false, onBuy = vi.fn()) => {
  render(<EventPoster event={{ ...EVENT, ...over }} live={live} onOpenAuction={vi.fn()} onBuy={onBuy} />)
  return onBuy
}

describe('EventPoster Buy', () => {
  it('offers the price and how many are left, with a name that says what it does', () => {
    poster()
    const button = screen.getByRole('button', { name: /buy a ticket to neon rooftop session for 25 xrp/i })
    expect(button.textContent).toMatch(/25 XRP/)
    expect(button.textContent).toMatch(/12 left/)
  })

  it('opens the box office for this event', () => {
    const onBuy = poster()
    screen.getByRole('button', { name: /buy a ticket/i }).click()
    expect(onBuy).toHaveBeenCalledWith(expect.objectContaining({ slug: EVENT.slug }))
  })

  it.each([
    ['has no price', { primaryPriceDrops: null }],
    ['has nothing left', { ticketsForSale: 0 }],
    ['does not report stock', { ticketsForSale: undefined }],
    ['is a draft', { status: 'DRAFT' as const }],
    ['is cancelled', { status: 'CANCELLED' as const }],
    ['is sold out', { status: 'SOLD_OUT' as const }],
  ])('offers nothing when the event %s', (_label, over) => {
    poster(over)
    expect(screen.queryByRole('button', { name: /buy a ticket/i })).toBeNull()
  })

  it('offers nothing while an auction is live — bidding is the way in then', () => {
    poster({}, true)
    expect(screen.queryByRole('button', { name: /buy a ticket/i })).toBeNull()
    expect(screen.getByRole('button', { name: /live bidding/i })).toBeTruthy()
  })

  it('offers nothing where no handler was given', () => {
    render(<EventPoster event={EVENT} live={false} onOpenAuction={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /buy a ticket/i })).toBeNull()
  })
})
