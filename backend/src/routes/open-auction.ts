/**
 * Opening an auction.
 *
 * An auction is a bidding layer on top of an ordinary sell offer. Settlement
 * brokers the winning bid against that offer, so opening an auction creates two
 * rows and asks the holder for ONE signature:
 *
 *   Auction  — reserve and close time, the bidding rules
 *   Listing  — the on-ledger sell offer settlement matches against
 *
 * The sell offer is placed BELOW the reserve by the fee-at-reserve
 * (`auctionSellAmountDrops`), because the ledger enforces
 * `buy >= sell + brokerFee` and an offer sitting at the reserve leaves a bid at
 * the reserve no headroom for the fee.
 *
 * That offer is deliberately hidden from the marketplace and from direct
 * purchase: its amount is the auction FLOOR, so buying it outright would take the
 * ticket for the reserve and bypass the bidding entirely. `Listing.auctionId` is
 * what marks it, and both `GET /listings` and `POST /listings/:id/buy` exclude it.
 *
 * Auctions are gated on scarcity — a sold-out event, and a holder who is not the
 * organizer. See `auction-policy.ts` for why that is derived rather than read
 * from `Event.status`.
 */
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { brokerMode, xamanMode } from '../env.js'
import { xaman } from '../xaman.js'
import { trackPayload } from '../payload-store.js'
import { issuesOf } from '../schemas.js'
import { requireAuth } from '../session.js'
import { canAuction } from '../auction-policy.js'
import {
  auctionSellAmountDrops,
  buildSellOfferTx,
  holdsNft,
  platformAddress,
  platformFeeDrops,
  XAMAN_NETWORK,
} from '../ledger.js'

export const openAuctionRouter = Router()

const OFFER_TTL_MINUTES = 60

const NfTokenIdParams = z.object({
  nfTokenId: z.string().regex(/^[0-9A-Fa-f]{64}$/, 'not a valid NFTokenID'),
})

const OpenBody = z.object({
  reserveDrops: z
    .string()
    .regex(/^[1-9][0-9]{0,17}$/, 'reserveDrops must be a positive integer string of drops'),
  // Bounded deliberately: a one-minute auction cannot be bid on, and an open-
  // ended one leaves the holder's ticket encumbered indefinitely.
  minutes: z.coerce.number().int().min(5).max(60 * 24 * 14).default(60),
})

/**
 * POST /api/tickets/:nfTokenId/auction
 * Holder-only. Returns a Xaman payload for the HOLDER to sign.
 */
openAuctionRouter.post('/tickets/:nfTokenId/auction', requireAuth, async (req, res) => {
  const params = NfTokenIdParams.safeParse(req.params)
  if (!params.success) {
    res.status(400).json({ error: 'Invalid ticket id', details: issuesOf(params.error) })
    return
  }
  const body = OpenBody.safeParse(req.body ?? {})
  if (!body.success) {
    res.status(400).json({ error: 'Invalid request', details: issuesOf(body.error) })
    return
  }

  if (brokerMode === 'disabled') {
    res.status(503).json({
      error: 'Auctions are unavailable: the platform broker account is not configured',
    })
    return
  }

  const nfTokenId = params.data.nfTokenId.toUpperCase()
  const reserveDrops = BigInt(body.data.reserveDrops)

  const [ticket, me] = await Promise.all([
    prisma.ticket.findUnique({ where: { nfTokenId }, include: { event: true } }),
    prisma.user.findUnique({ where: { id: req.userId! } }),
  ])

  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found' })
    return
  }
  if (!me) {
    res.status(404).json({ error: 'User no longer exists' })
    return
  }

  // The ledger decides ownership, not our cache.
  if (!(await holdsNft(me.xrplAddress, nfTokenId))) {
    if (ticket.ownerId === me.id) {
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { ownerId: null, ownerAddress: null, syncedAt: new Date() },
      })
    }
    res.status(403).json({ error: 'The ledger says you do not hold this ticket' })
    return
  }

  if (ticket.status === 'REDEEMED') {
    res.status(409).json({
      error: 'That ticket has already been checked in and cannot be auctioned',
    })
    return
  }

  // Auctions are the secondary market for a sold-out event. Before that, the
  // organizer still has inventory at face value and an auction would just be
  // bidding against a price anyone can pay.
  const eligible = await canAuction({
    eventId: ticket.eventId,
    organizerId: ticket.event.organizerId,
    holderId: me.id,
  })
  if (!eligible.allowed) {
    res.status(409).json({ error: eligible.reason, ...(eligible.detail ?? {}) })
    return
  }

  const [liveAuction, liveListing, liveGift] = await prisma.$transaction([
    prisma.auction.findFirst({
      where: { ticketId: ticket.id, status: { in: ['SCHEDULED', 'LIVE', 'SETTLING'] } },
    }),
    prisma.listing.findFirst({
      where: {
        ticketId: ticket.id,
        status: { in: ['ACTIVE', 'BUYER_PENDING', 'SETTLING', 'CANCELLING'] },
      },
    }),
    prisma.gift.findFirst({
      where: { ticketId: ticket.id, status: { in: ['OFFERED', 'ACCEPTING', 'CANCELLING'] } },
    }),
  ])
  if (liveAuction) {
    res.status(409).json({ error: 'This ticket already has an auction' })
    return
  }
  if (liveListing) {
    res.status(409).json({ error: 'This ticket is already listed for sale' })
    return
  }
  if (liveGift) {
    res.status(409).json({ error: 'This ticket has a gift in flight' })
    return
  }

  const platformBps = ticket.event.platformBps
  // Recorded on the Listing below: only this account can settle these offers.
  const brokerAddress = platformAddress()

  let sellAmount: bigint
  let txjson
  try {
    // Below the reserve by the fee-at-reserve, so a bid AT the reserve still
    // satisfies buy >= sell + brokerFee.
    sellAmount = auctionSellAmountDrops(reserveDrops, platformBps)
    txjson = buildSellOfferTx({
      ownerAddress: me.xrplAddress,
      nfTokenId,
      amountDrops: sellAmount,
      brokerAddress,
    })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not open the auction' })
    return
  }

  const payload = await xaman.createPayload(txjson as unknown as Record<string, unknown>, {
    expireMinutes: OFFER_TTL_MINUTES,
    forceNetwork: XAMAN_NETWORK,
  })
  // Registered before it can resolve, so a webhook callback finds it and
  // reconciliation can spot one whose callback never arrived.
  await trackPayload(payload.uuid)

  const now = Date.now()
  const endsAt = new Date(now + body.data.minutes * 60_000)

  // Both rows together: an Auction without its sell offer cannot settle, and a
  // Listing without its auction would be a plain sale at the floor price.
  const { auction, listing } = await prisma.$transaction(async (tx) => {
    const auction = await tx.auction.create({
      data: {
        ticketId: ticket.id,
        startsAt: new Date(now),
        endsAt,
        reserveDrops,
        // SCHEDULED until the sell offer is actually on-ledger; bidding opens
        // only when there is something for a winner to be matched against.
        status: 'SCHEDULED',
      },
    })
    const listing = await tx.listing.create({
      data: {
        ticketId: ticket.id,
        sellerId: me.id,
        sellerAddress: me.xrplAddress,
        brokerAddress,
        priceDrops: sellAmount,
        platformFeeDrops: platformFeeDrops(reserveDrops, platformBps),
        listPayloadUuid: payload.uuid,
        expiresAt: new Date(now + OFFER_TTL_MINUTES * 60_000),
        auctionId: auction.id,
      },
    })
    return { auction, listing }
  })

  res.status(201).json({
    auctionId: auction.id,
    listingId: listing.id,
    uuid: payload.uuid,
    next: payload.next,
    qrPng: payload.qrPng,
    mode: xamanMode,
    reserveDrops: reserveDrops.toString(),
    sellOfferDrops: sellAmount.toString(),
    endsAt: endsAt.toISOString(),
  })
})
