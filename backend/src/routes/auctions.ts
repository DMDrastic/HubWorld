/**
 * Auction reads.
 *
 * This is the display half only — it serves the price tracker and says nothing
 * about how a bid is committed on-ledger. That settlement mechanism is a separate
 * decision (see the note in CLAUDE.md), and keeping the read path independent of
 * it means the chart can run on real data before that is settled.
 *
 * Bids are public: an auction where you cannot see the competing bids is not an
 * auction. Bidder handles are shown rather than r-addresses, per the username
 * system.
 */
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { issuesOf, slugSchema } from '../schemas.js'

export const auctionsRouter = Router()

const SlugParams = z.object({ slug: slugSchema })

/** Statuses whose money is actually committed on-ledger. */
const COMMITTED_BID_STATUSES = ['COMMITTED', 'OUTBID', 'WON'] as const

/**
 * GET /api/events/:slug/auction
 *
 * The live auction for an event, or 404. Returns every bid, including PENDING
 * ones — the client distinguishes them, because an unfunded bid must never count
 * toward the displayed price (see the price-tracker notes).
 */
auctionsRouter.get('/events/:slug/auction', async (req, res) => {
  const parsed = SlugParams.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid slug', details: issuesOf(parsed.error) })
    return
  }

  const auction = await prisma.auction.findFirst({
    where: {
      ticket: { event: { slug: parsed.data.slug } },
      status: { in: ['SCHEDULED', 'LIVE', 'SETTLING'] },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      ticket: {
        include: { event: { select: { slug: true, title: true } } },
      },
      bids: {
        // Matches @@index([auctionId, placedAt]) — the index exists for this.
        orderBy: { placedAt: 'asc' },
        include: { bidder: { select: { username: true } } },
        take: 500,
      },
    },
  })

  if (!auction) {
    res.status(404).json({ error: 'No live auction for this event' })
    return
  }

  res.json({
    id: auction.id,
    eventTitle: auction.ticket.event.title,
    eventSlug: auction.ticket.event.slug,
    state: auction.status.toLowerCase(),
    startsAt: auction.startsAt.toISOString(),
    endsAt: auction.endsAt.toISOString(),
    // BigInt would throw in JSON.stringify; the app-level replacer handles it,
    // but being explicit here keeps the contract obvious.
    reserveDrops: (auction.reserveDrops ?? 0n).toString(),
    ticket: {
      nfTokenId: auction.ticket.nfTokenId,
      seat: auction.ticket.seat,
      tier: auction.ticket.tier,
    },
    bids: auction.bids.map((b) => ({
      id: b.id,
      amountDrops: b.amountDrops.toString(),
      placedAt: b.placedAt.toISOString(),
      bidder: `@${b.bidder.username}`,
      status: b.status,
    })),
  })
})

/**
 * GET /api/auctions — which events currently have a live auction.
 * Lets a listing page mark them without fetching each auction in turn.
 */
auctionsRouter.get('/auctions', async (_req, res) => {
  const auctions = await prisma.auction.findMany({
    where: { status: { in: ['SCHEDULED', 'LIVE'] } },
    orderBy: { endsAt: 'asc' },
    take: 100,
    include: {
      ticket: { include: { event: { select: { slug: true, title: true } } } },
      bids: {
        where: { status: { in: [...COMMITTED_BID_STATUSES] } },
        orderBy: { amountDrops: 'desc' },
        take: 1,
      },
      _count: { select: { bids: true } },
    },
  })

  res.json({
    auctions: auctions.map((a) => ({
      id: a.id,
      eventSlug: a.ticket.event.slug,
      eventTitle: a.ticket.event.title,
      state: a.status.toLowerCase(),
      endsAt: a.endsAt.toISOString(),
      reserveDrops: (a.reserveDrops ?? 0n).toString(),
      // Highest FUNDED bid — an unfunded one is not a price.
      topBidDrops: a.bids[0]?.amountDrops.toString() ?? '0',
      bidCount: a._count.bids,
    })),
  })
})
