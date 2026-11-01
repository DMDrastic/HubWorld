/**
 * Ticket inventory.
 *
 * These reads are served from Postgres, which is a CACHE of ledger ownership.
 * `syncedAt` is returned alongside every ticket so a client can tell how stale
 * that claim is. Anything that acts on ownership (gifting, listing, settling an
 * auction) must re-read the ledger instead — see `holdsNft` in ledger.ts.
 */
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { issuesOf } from '../schemas.js'
import { requireAuth } from '../session.js'
import { accountNfts } from '../ledger.js'
import { canAuction } from '../auction-policy.js'
import { resaleCeiling, maxAskForCap, isPrimarySale, capSource } from '../resale-policy.js'
import { paidCostOf } from '../paid-cost.js'
import { feeModelV2 } from '../env.js'
import { currentDisplayRate, displayCurrency, fiatOf } from '../fiat-display.js'

export const ticketsRouter = Router()

const MineQuery = z.object({
  // Opt-in ledger reconciliation. Off by default because it costs a network
  // round-trip; on when the client is about to act on ownership.
  verify: z.enum(['true', 'false']).default('false'),
})

/** GET /api/tickets/mine?verify=true */
ticketsRouter.get('/tickets/mine', requireAuth, async (req, res) => {
  const parsed = MineQuery.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', details: issuesOf(parsed.error) })
    return
  }

  const me = await prisma.user.findUnique({ where: { id: req.userId! } })
  if (!me) {
    res.status(404).json({ error: 'User no longer exists' })
    return
  }

  const tickets = await prisma.ticket.findMany({
    where: { ownerId: me.id },
    include: {
      event: {
        select: {
          id: true,
          slug: true,
          title: true,
          venue: true,
          imageUrl: true,
          doorMode: true,
          startsAt: true,
          organizerId: true,
          resalePolicy: true,
          resaleCapBps: true,
          resaleCapDrops: true,
          platformBps: true,
          timeZone: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  // Auction eligibility per event, so the UI can explain WHY rather than
  // offering a control that 409s. Computed once per event, not per ticket.
  const eligibility = new Map<string, Awaited<ReturnType<typeof canAuction>>>()
  for (const t of tickets) {
    if (eligibility.has(t.event.id)) continue
    eligibility.set(
      t.event.id,
      await canAuction({
        eventId: t.event.id,
        organizerId: t.event.organizerId,
        holderId: me.id,
      }),
    )
  }

  let heldOnLedger: Set<string> | null = null
  if (parsed.data.verify === 'true') {
    try {
      const nfts = await accountNfts(me.xrplAddress)
      heldOnLedger = new Set(nfts.map((n) => n.NFTokenID))
    } catch {
      // A ledger hiccup must not break the inventory view — fall back to the
      // cache and say so via `verified: false`.
      heldOnLedger = null
    }
  }

  const rate = await currentDisplayRate()
  res.json({
    address: me.xrplAddress,
    verified: heldOnLedger !== null,
    tickets: tickets.map((t) => ({
      nfTokenId: t.nfTokenId,
      seat: t.seat,
      tier: t.tier,
      status: t.status,
      syncedAt: t.syncedAt?.toISOString() ?? null,
      // Null when unverified; false means the ledger disagrees with our cache,
      // which is the case worth showing a user.
      onLedger: heldOnLedger === null ? null : heldOnLedger.has(t.nfTokenId),
      event: {
        slug: t.event.slug,
        title: t.event.title,
        venue: t.event.venue,
        imageUrl: t.event.imageUrl,
        doorMode: t.event.doorMode,
        startsAt: t.event.startsAt.toISOString(),
      },
      canAuction: eligibility.get(t.event.id)?.allowed ?? false,
      auctionBlockedReason:
        eligibility.get(t.event.id)?.allowed === false
          ? (eligibility.get(t.event.id) as { reason: string }).reason
          : null,
      faceValueDrops: t.faceValueDrops?.toString() ?? null,
      // Same predicate listings.ts enforces with — see isPrimarySale's doc
      // comment in resale-policy.ts. One shared function so the display here
      // can never drift from what the server would actually accept.
      ...(isPrimarySale({ organizerId: t.event.organizerId, sellerId: me.id, faceValueDrops: t.faceValueDrops })
        ? {
            resaleAllowed: true,
            maxListingPriceDrops: null,
            maxAuctionReserveDrops: null,
            resaleBlockedReason: null,
          }
        : (() => {
            const capInput = {
              policy: t.event.resalePolicy,
              capBps: t.event.resaleCapBps,
              capDrops: t.event.resaleCapDrops,
              faceValueDrops: t.faceValueDrops,
              paid: paidCostOf(t),
            }
            const ceiling = resaleCeiling(capInput)
            if (!ceiling.resaleAllowed) {
              return {
                resaleAllowed: false,
                maxListingPriceDrops: null,
                maxAuctionReserveDrops: null,
                resaleBlockedReason: ceiling.reason,
              }
            }
            // A listing's ask has the platform fee added on top for the
            // buyer, so the ask itself must be capped below the organizer's
            // stated limit — an auction reserve/bid IS the buyer's total
            // already, so it compares against the raw cap unadjusted. Same
            // split as listings.ts vs. open-auction.ts/bids.ts.
            return {
              resaleAllowed: true,
              // Under the new terms the buyer pays exactly the price, so the cap is the most that can be listed; under the
              // old terms the fee is added on top of the ask, so it is backed out of the cap first.
              maxListingPriceDrops:
                ceiling.maxDrops === null
                  ? null
                  : feeModelV2
                    ? ceiling.maxDrops.toString()
                    : maxAskForCap(ceiling.maxDrops, t.event.platformBps).toString(),
              maxAuctionReserveDrops: ceiling.maxDrops?.toString() ?? null,
              resaleBlockedReason: null,
              // Why the limit is what it is, so the seller is told "capped at what the buyer paid"
              // rather than left to wonder where the number came from.
              resaleCapSource: capSource(capInput),
            }
          })()),
    })).map((view, i) => ({
      ...view,
      // Display only: the estimate beside each XRP amount, absent when the price is not fresh.
      fiat: fiatOf(view, ['faceValueDrops', 'maxListingPriceDrops', 'maxAuctionReserveDrops'], rate, displayCurrency(tickets[i]!.event)),
    })),
  })
})
