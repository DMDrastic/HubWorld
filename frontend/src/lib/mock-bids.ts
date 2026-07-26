/**
 * PLACEHOLDER bid data for developing the price tracker before the auction
 * backend exists.
 *
 * The shapes here deliberately mirror the Prisma `Bid` model and `BidStatus`
 * enum, so swapping this for a real `GET /api/auctions/:id/bids` is a change of
 * data source and nothing else. Delete this file once that endpoint lands.
 */

/** Mirrors Prisma's BidStatus. */
export type BidStatus = 'PENDING' | 'ESCROWED' | 'OUTBID' | 'WON' | 'REFUNDED' | 'CANCELLED'

export type Bid = {
  id: string
  /** Drops, as a string. Never a JS number — see the money rule in CLAUDE.md. */
  amountDrops: string
  placedAt: string
  bidder: string
  status: BidStatus
}

export type Auction = {
  id: string
  eventTitle: string
  startsAt: string
  endsAt: string
  reserveDrops: string
  bids: Bid[]
}

const XRP = 1_000_000n

/**
 * Generates a plausible auction: slow early bidding, then a rush near the close.
 * Real auctions are back-loaded, and a uniform distribution would make the
 * velocity chart look pointless when its whole purpose is showing that rush.
 */
export function mockAuction(now = Date.now()): Auction {
  const endsAt = now + 22 * 60 * 1000
  const startsAt = now - 98 * 60 * 1000
  const span = endsAt - startsAt

  const bidders = ['@tester3', '@majula', '@peachcastle', '@dm_drastic', '@tester4']
  const bids: Bid[] = []

  let price = 8n * XRP
  // Cubic bias packs bids toward the close.
  const count = 17
  for (let i = 0; i < count; i++) {
    const t = (i + 1) / (count + 1)
    const at = startsAt + span * Math.pow(t, 2.6)
    if (at > now) break

    // Rising increments, larger as competition heats up.
    const step = BigInt(Math.round((0.25 + Math.random() * 0.9 + i * 0.11) * 1_000_000))
    price += step

    bids.push({
      id: `bid-${i}`,
      amountDrops: price.toString(),
      placedAt: new Date(at).toISOString(),
      bidder: bidders[i % bidders.length]!,
      // Every settled bid is ESCROWED or OUTBID; the leader is the last one.
      status: 'OUTBID',
    })
  }

  if (bids.length > 0) {
    bids[bids.length - 1]!.status = 'ESCROWED'
    // One unfunded bid in flight, to exercise the ghosted-pending rendering.
    // A PENDING bid has no escrow yet and must NOT count as price.
    const leader = BigInt(bids[bids.length - 1]!.amountDrops)
    bids.push({
      id: 'bid-pending',
      amountDrops: (leader + 2n * XRP).toString(),
      placedAt: new Date(now - 25_000).toISOString(),
      bidder: '@majula',
      status: 'PENDING',
    })
  }

  return {
    id: 'auction-mock',
    eventTitle: 'Neon Rooftop Session',
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    reserveDrops: (12n * XRP).toString(),
    bids,
  }
}

/** Appends one higher bid, for simulating live arrivals. */
export function nextMockBid(auction: Auction): Bid {
  const escrowed = auction.bids.filter((b) => b.status !== 'PENDING')
  const top = escrowed.reduce((m, b) => (BigInt(b.amountDrops) > m ? BigInt(b.amountDrops) : m), 0n)
  const bidders = ['@tester3', '@majula', '@peachcastle', '@tester4']
  return {
    id: `bid-live-${Date.now()}`,
    amountDrops: (top + BigInt(Math.round((0.4 + Math.random() * 1.6) * 1_000_000))).toString(),
    placedAt: new Date().toISOString(),
    bidder: bidders[Math.floor(Math.random() * bidders.length)]!,
    status: 'ESCROWED',
  }
}
