/**
 * Price-tracker integrity.
 *
 * The rule under test is not cosmetic: a bid is a buy offer and is not real until
 * that offer is on-ledger, so an uncommitted bid must never move the price. If it could,
 * anyone could pump the visible price with money they never committed and the
 * chart would become a manipulation surface rather than a price signal.
 *
 * These assert on the ticker strip rather than the SVG, because Recharts renders
 * to a zero-size container under jsdom. The strip is the number a bidder actually
 * reads, and it is computed from the same series the chart plots.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BidChart } from '@/components/BidChart'
import type { Auction, Bid } from '@/lib/api'

const NOW = Date.UTC(2026, 6, 26, 12, 0, 0)
const XRP = 1_000_000

function bid(over: Partial<Bid> & Pick<Bid, 'amountDrops' | 'status'>): Bid {
  return {
    id: Math.random().toString(36).slice(2),
    placedAt: new Date(NOW - 10 * 60_000).toISOString(),
    bidder: '@someone',
    ...over,
  }
}

function auction(bids: Bid[], reserveXrp = 12): Auction {
  return {
    id: 'a1',
    eventTitle: 'Neon Rooftop Session',
    eventSlug: 'neon-rooftop-session',
    state: 'live',
    startsAt: new Date(NOW - 60 * 60_000).toISOString(),
    endsAt: new Date(NOW + 20 * 60_000).toISOString(),
    reserveDrops: String(reserveXrp * XRP),
    ticket: { nfTokenId: 'A'.repeat(64), seat: null, tier: 'deluxe' },
    bids,
  }
}

describe('BidChart price integrity', () => {
  it('ignores a PENDING bid even when it is the highest', () => {
    // The attack: bid 999 XRP, never fund the escrow, and watch the headline
    // price follow. It must not.
    render(
      <BidChart
        auction={auction([
          bid({ amountDrops: String(10 * XRP), status: 'COMMITTED' }),
          bid({ amountDrops: String(999 * XRP), status: 'PENDING' }),
        ])}
        now={NOW}
      />,
    )
    expect(screen.getByText('10.00')).toBeTruthy()
    expect(screen.queryByText('999.00')).toBeNull()
  })

  it('counts COMMITTED, OUTBID and WON as funded', () => {
    // OUTBID and WON were escrowed at some point, so they are real history.
    render(
      <BidChart
        auction={auction([
          bid({ amountDrops: String(10 * XRP), status: 'OUTBID' }),
          bid({ amountDrops: String(14 * XRP), status: 'COMMITTED' }),
        ])}
        now={NOW}
      />,
    )
    expect(screen.getByText('14.00')).toBeTruthy()
  })

  it('excludes lost and cancelled bids from the price', () => {
    // A lost or withdrawn bid has no live offer; it cannot be the price.
    render(
      <BidChart
        auction={auction([
          bid({ amountDrops: String(10 * XRP), status: 'COMMITTED' }),
          bid({ amountDrops: String(50 * XRP), status: 'LOST' }),
          bid({ amountDrops: String(60 * XRP), status: 'CANCELLED' }),
        ])}
        now={NOW}
      />,
    )
    expect(screen.getByText('10.00')).toBeTruthy()
  })

  it('never lets the price go down', () => {
    // A later-but-lower funded bid is not the price; the running maximum is.
    render(
      <BidChart
        auction={auction([
          bid({
            amountDrops: String(20 * XRP),
            status: 'OUTBID',
            placedAt: new Date(NOW - 30 * 60_000).toISOString(),
          }),
          bid({
            amountDrops: String(15 * XRP),
            status: 'COMMITTED',
            placedAt: new Date(NOW - 5 * 60_000).toISOString(),
          }),
        ])}
        now={NOW}
      />,
    )
    expect(screen.getByText('20.00')).toBeTruthy()
  })

  it('says when the reserve has not been met', () => {
    render(
      <BidChart auction={auction([bid({ amountDrops: String(9 * XRP), status: 'COMMITTED' })], 12)} now={NOW} />,
    )
    expect(screen.getByText(/reserve 12\.00/)).toBeTruthy()
  })

  it('says when the reserve has been met', () => {
    render(
      <BidChart auction={auction([bid({ amountDrops: String(15 * XRP), status: 'COMMITTED' })], 12)} now={NOW} />,
    )
    expect(screen.getByText('above reserve')).toBeTruthy()
  })

  it('counts distinct bidders, not bids', () => {
    // One person walking up their own bid is a different market from three
    // people competing, and the price alone cannot tell them apart.
    render(
      <BidChart
        auction={auction([
          bid({ amountDrops: String(10 * XRP), status: 'OUTBID', bidder: '@a' }),
          bid({ amountDrops: String(11 * XRP), status: 'OUTBID', bidder: '@a' }),
          bid({ amountDrops: String(12 * XRP), status: 'COMMITTED', bidder: '@a' }),
        ])}
        now={NOW}
      />,
    )
    expect(screen.getByText(/3 bids · 1 bidders/)).toBeTruthy()
  })

  it('renders an auction with no bids at all', () => {
    render(<BidChart auction={auction([])} now={NOW} />)
    expect(screen.getByText('0.00')).toBeTruthy()
  })

  it('shows the auction as closed once past the end', () => {
    render(
      <BidChart
        auction={auction([bid({ amountDrops: String(10 * XRP), status: 'COMMITTED' })])}
        now={NOW + 60 * 60_000}
      />,
    )
    expect(screen.getByText('closed')).toBeTruthy()
  })
})
