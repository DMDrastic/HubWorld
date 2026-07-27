/**
 * Fixed-price resale, settled in XRPL brokered mode.
 *
 * THREE signatures on three accounts:
 *   1. seller   POST /tickets/:nfTokenId/list   → NFTokenCreateOffer (sell)
 *   2. buyer    POST /listings/:id/buy          → NFTokenCreateOffer (bid)
 *   3. Hubworld (automatic)                     → NFTokenAcceptOffer + brokerFee
 *
 * Only step 3 is signed by Hubworld, and it is the reason a platform key exists.
 * Funds never rest here: the ledger moves them buyer → seller and
 * buyer → issuer (the royalty) atomically in that one transaction.
 *
 * BOTH offers carry `Destination = broker`, and both are needed. Without it on
 * the sell side a buyer could take the offer directly; without it on the buy
 * side the seller could accept the bid — which is for price + fee — and pocket
 * Hubworld's cut. Brokerage is only enforced when neither party can settle
 * without us.
 */
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { brokerMode, xamanMode } from '../env.js'
import { tryGetPayload, xaman, SIGNIN_TTL_MINUTES } from '../xaman.js'
import { issuesOf } from '../schemas.js'
import { requireAuth } from '../session.js'
import {
  brokerSale,
  buildBuyOfferTx,
  buildCancelOfferTx,
  buildSellOfferTx,
  holdsNft,
  offerIndexFromTx,
  platformAddress,
  platformFeeDrops,
  spendableDrops,
  txSucceeded,
  XAMAN_NETWORK,
} from '../ledger.js'

export const listingsRouter = Router()

/** Unsigned-payload TTL. Not the listing's lifetime — see gift-policy.ts. */
const LIST_TTL_MINUTES = 60
const LIST_TTL_MS = LIST_TTL_MINUTES * 60 * 1000

/** States with something live on-ledger; a payload timeout must not kill these. */
const ON_LEDGER_STATES = ['ACTIVE', 'BUYER_PENDING', 'SETTLING', 'CANCELLING'] as const

const IdParams = z.object({ id: z.string().uuid() })
const NfTokenIdParams = z.object({
  nfTokenId: z.string().regex(/^[0-9A-Fa-f]{64}$/, 'not a valid NFTokenID'),
})

/**
 * Price in drops, as a string. Never a JS number: 2^53 drops is only ~9 billion
 * XRP but precision loss on money is not a risk worth taking, and the API
 * serialises BigInt as strings in both directions for consistency.
 */
const ListBody = z.object({
  priceDrops: z
    .string()
    .regex(/^[1-9][0-9]{0,17}$/, 'priceDrops must be a positive integer string of drops'),
})

function listingView(l: {
  id: string
  priceDrops: bigint
  platformFeeDrops: bigint
  status: string
  seller: { username: string }
  buyer: { username: string } | null
  ticket: { nfTokenId: string; seat: string | null; tier: string | null; event: { slug: string; title: string } }
  failureReason: string | null
}) {
  return {
    listingId: l.id,
    state: l.status.toLowerCase(),
    // What the seller asks, what Hubworld takes, and what the buyer pays.
    priceDrops: l.priceDrops.toString(),
    platformFeeDrops: l.platformFeeDrops.toString(),
    buyerPaysDrops: (l.priceDrops + l.platformFeeDrops).toString(),
    seller: `@${l.seller.username}`,
    buyer: l.buyer ? `@${l.buyer.username}` : null,
    ticket: {
      nfTokenId: l.ticket.nfTokenId,
      seat: l.ticket.seat,
      tier: l.ticket.tier,
      event: l.ticket.event,
    },
    ...(l.failureReason ? { reason: l.failureReason } : {}),
  }
}

const listingInclude = {
  seller: { select: { username: true } },
  buyer: { select: { username: true } },
  ticket: {
    include: { event: { select: { slug: true, title: true, platformBps: true } } },
  },
} as const

/**
 * POST /api/tickets/:nfTokenId/list
 * Owner-only. Returns a Xaman payload for the SELLER to sign.
 */
listingsRouter.post('/tickets/:nfTokenId/list', requireAuth, async (req, res) => {
  const params = NfTokenIdParams.safeParse(req.params)
  if (!params.success) {
    res.status(400).json({ error: 'Invalid ticket id', details: issuesOf(params.error) })
    return
  }
  const body = ListBody.safeParse(req.body ?? {})
  if (!body.success) {
    res.status(400).json({ error: 'Invalid request', details: issuesOf(body.error) })
    return
  }

  // A sale cannot settle without our signature, so refuse to create one we
  // could never complete rather than stranding the seller's offer on-ledger.
  if (brokerMode === 'disabled') {
    res.status(503).json({
      error: 'Selling is unavailable: the platform broker account is not configured',
    })
    return
  }

  const nfTokenId = params.data.nfTokenId.toUpperCase()
  const priceDrops = BigInt(body.data.priceDrops)

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
      error: 'That ticket has already been checked in and cannot be sold',
    })
    return
  }

  const clash = await prisma.$transaction([
    prisma.listing.findFirst({
      where: { ticketId: ticket.id, status: { in: [...ON_LEDGER_STATES] } },
    }),
    prisma.listing.findFirst({
      where: { ticketId: ticket.id, status: 'PENDING_OFFER', expiresAt: { gt: new Date() } },
    }),
    prisma.gift.findFirst({
      where: {
        ticketId: ticket.id,
        status: { in: ['OFFERED', 'ACCEPTING', 'CANCELLING'] },
      },
    }),
  ])
  if (clash[0] || clash[1]) {
    res.status(409).json({ error: 'This ticket is already listed' })
    return
  }
  if (clash[2]) {
    res.status(409).json({ error: 'This ticket has a gift in flight' })
    return
  }

  const fee = platformFeeDrops(priceDrops, ticket.event.platformBps)

  let txjson
  try {
    txjson = buildSellOfferTx({
      ownerAddress: me.xrplAddress,
      nfTokenId,
      amountDrops: priceDrops,
      brokerAddress: platformAddress(),
    })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not build listing' })
    return
  }

  const payload = await xaman.createPayload(txjson as unknown as Record<string, unknown>, {
    expireMinutes: LIST_TTL_MINUTES,
    forceNetwork: XAMAN_NETWORK,
  })

  const listing = await prisma.listing.create({
    data: {
      ticketId: ticket.id,
      sellerId: me.id,
      sellerAddress: me.xrplAddress,
      priceDrops,
      // Frozen at listing time: changing platformBps later must not alter the
      // terms a buyer has already been shown.
      platformFeeDrops: fee,
      listPayloadUuid: payload.uuid,
      expiresAt: new Date(Date.now() + LIST_TTL_MS),
    },
  })

  res.status(201).json({
    listingId: listing.id,
    uuid: payload.uuid,
    next: payload.next,
    qrPng: payload.qrPng,
    mode: xamanMode,
    priceDrops: priceDrops.toString(),
    platformFeeDrops: fee.toString(),
  })
})

/**
 * GET /api/listings — the marketplace. Only purchasable listings.
 */
listingsRouter.get('/listings', async (_req, res) => {
  const listings = await prisma.listing.findMany({
    // auctionId null: an auction's sell offer is priced at the FLOOR, so showing
    // it here would advertise a ticket for its reserve and let a buyer take it
    // without bidding.
    where: { status: 'ACTIVE', auctionId: null },
    include: listingInclude,
    orderBy: { listedAt: 'desc' },
    take: 100,
  })
  res.json({ listings: listings.map(listingView) })
})

/**
 * GET /api/listings/mine — what I am selling and what I am buying.
 */
listingsRouter.get('/listings/mine', requireAuth, async (req, res) => {
  const listings = await prisma.listing.findMany({
    where: {
      OR: [
        { sellerId: req.userId!, status: { in: [...ON_LEDGER_STATES, 'PENDING_OFFER'] } },
        { buyerId: req.userId!, status: { in: ['BUYER_PENDING', 'SETTLING'] } },
      ],
    },
    include: listingInclude,
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  res.json({
    listings: listings.map((l) => ({
      ...listingView(l),
      role: l.sellerId === req.userId ? 'seller' : 'buyer',
    })),
  })
})

/**
 * POST /api/listings/:id/buy
 * Returns a Xaman payload for the BUYER to sign: a bid for price + platform fee,
 * which is the amount the ledger requires for a brokered match.
 */
listingsRouter.post('/listings/:id/buy', requireAuth, async (req, res) => {
  const parsed = IdParams.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid listing id', details: issuesOf(parsed.error) })
    return
  }

  const [listing, me] = await Promise.all([
    prisma.listing.findUnique({ where: { id: parsed.data.id } }),
    prisma.user.findUnique({ where: { id: req.userId! } }),
  ])
  if (!listing) {
    res.status(404).json({ error: 'Listing not found' })
    return
  }
  if (!me) {
    res.status(404).json({ error: 'User no longer exists' })
    return
  }
  if (listing.auctionId) {
    // The bypass this guard exists for: buying at the floor instead of bidding.
    res.status(409).json({
      error: 'This ticket is being auctioned — place a bid instead of buying it outright',
      auctionId: listing.auctionId,
    })
    return
  }
  if (listing.status !== 'ACTIVE' || !listing.offerIndex) {
    res.status(409).json({ error: `Listing is ${listing.status.toLowerCase()}, not for sale` })
    return
  }
  if (listing.sellerId === me.id) {
    res.status(400).json({ error: 'You cannot buy your own listing' })
    return
  }

  let txjson
  try {
    txjson = buildBuyOfferTx({
      buyerAddress: me.xrplAddress,
      ownerAddress: listing.sellerAddress,
      nfTokenId: (await prisma.ticket.findUniqueOrThrow({ where: { id: listing.ticketId } }))
        .nfTokenId,
      // The ledger requires buy >= sell + brokerFee.
      amountDrops: listing.priceDrops + listing.platformFeeDrops,
      brokerAddress: platformAddress(),
    })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not build bid' })
    return
  }

  const payload = await xaman.createPayload(txjson as unknown as Record<string, unknown>, {
    expireMinutes: LIST_TTL_MINUTES,
    forceNetwork: XAMAN_NETWORK,
  })

  await prisma.listing.update({
    where: { id: listing.id },
    data: {
      buyerId: me.id,
      buyerAddress: me.xrplAddress,
      buyPayloadUuid: payload.uuid,
      status: 'BUYER_PENDING',
      // Refresh, or a retry is born expired.
      expiresAt: new Date(Date.now() + LIST_TTL_MS),
    },
  })

  res.status(201).json({
    listingId: listing.id,
    uuid: payload.uuid,
    next: payload.next,
    qrPng: payload.qrPng,
    mode: xamanMode,
    paysDrops: (listing.priceDrops + listing.platformFeeDrops).toString(),
  })
})

/**
 * POST /api/listings/:id/cancel — seller withdraws.
 * A local flip before signing; a signed NFTokenCancelOffer once the offer exists.
 */
listingsRouter.post('/listings/:id/cancel', requireAuth, async (req, res) => {
  const parsed = IdParams.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid listing id', details: issuesOf(parsed.error) })
    return
  }

  const listing = await prisma.listing.findUnique({ where: { id: parsed.data.id } })
  if (!listing) {
    res.status(404).json({ error: 'Listing not found' })
    return
  }
  if (listing.sellerId !== req.userId) {
    res.status(403).json({ error: 'Only the seller can withdraw a listing' })
    return
  }
  if (listing.status === 'PENDING_OFFER') {
    await prisma.listing.update({
      where: { id: listing.id },
      data: { status: 'CANCELLED', closedAt: new Date() },
    })
    res.json({ state: 'cancelled', listingId: listing.id })
    return
  }
  // SETTLING is past the point of no return: the broker transaction is already
  // in flight and the ledger, not us, decides that race.
  if (listing.status !== 'ACTIVE' || !listing.offerIndex) {
    res.status(409).json({ error: `Listing is ${listing.status.toLowerCase()} and cannot be withdrawn` })
    return
  }

  const payload = await xaman.createPayload(
    buildCancelOfferTx({
      ownerAddress: listing.sellerAddress,
      offerIndex: listing.offerIndex,
    }) as unknown as Record<string, unknown>,
    { expireMinutes: LIST_TTL_MINUTES, forceNetwork: XAMAN_NETWORK },
  )

  await prisma.listing.update({
    where: { id: listing.id },
    data: { cancelPayloadUuid: payload.uuid, expiresAt: new Date(Date.now() + LIST_TTL_MS) },
  })

  res.status(201).json({
    listingId: listing.id,
    uuid: payload.uuid,
    next: payload.next,
    qrPng: payload.qrPng,
    mode: xamanMode,
  })
})

/**
 * GET /api/listings/:id — poll target driving all three phases.
 */
listingsRouter.get('/listings/:id', requireAuth, async (req, res) => {
  const parsed = IdParams.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid listing id', details: issuesOf(parsed.error) })
    return
  }

  const listing = await prisma.listing.findUnique({
    where: { id: parsed.data.id },
    include: listingInclude,
  })
  if (!listing) {
    res.status(404).json({ error: 'Listing not found' })
    return
  }

  const view = (extra: Record<string, unknown> = {}) => ({ ...listingView(listing), ...extra })

  // Terminal states need no further work.
  if (['SOLD', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(listing.status)) {
    res.json(view())
    return
  }

  const payloadExpired = listing.expiresAt < new Date()

  // ---- phase 1: the seller's sell offer ----------------------------------
  if (listing.status === 'PENDING_OFFER') {
    const status = await tryGetPayload(listing.listPayloadUuid)
    if (status === 'unavailable') {
      res.json(view())
      return
    }
    if (status?.cancelled) {
      await prisma.listing.update({
        where: { id: listing.id },
        data: { status: 'CANCELLED', closedAt: new Date() },
      })
      res.json({ ...view(), state: 'cancelled' })
      return
    }
    if (!status?.signed) {
      // Nothing on-ledger yet, so expiring is honest.
      if (payloadExpired || status?.expired) {
        await prisma.listing.update({ where: { id: listing.id }, data: { status: 'EXPIRED' } })
        res.json({ ...view(), state: 'expired' })
        return
      }
      res.json(view())
      return
    }
    if (!status.txid) {
      res.json(view({ signed: true }))
      return
    }

    const ok = await txSucceeded(status.txid)
    if (ok === null) {
      res.json(view({ signed: true }))
      return
    }
    if (!ok) {
      await prisma.listing.update({
        where: { id: listing.id },
        data: { status: 'FAILED', listTxHash: status.txid, failureReason: 'The ledger rejected the listing' },
      })
      res.json({ ...view(), state: 'failed', reason: 'The ledger rejected the listing' })
      return
    }

    const offerIndex = await offerIndexFromTx(status.txid)
    if (!offerIndex) {
      res.json(view({ signed: true }))
      return
    }

    await prisma.$transaction([
      prisma.listing.update({
        where: { id: listing.id },
        data: { status: 'ACTIVE', listTxHash: status.txid, offerIndex, listedAt: new Date() },
      }),
      prisma.ticket.update({
        where: { id: listing.ticketId },
        data: { status: listing.auctionId ? 'IN_AUCTION' : 'LISTED' },
      }),
      // Bidding opens only now: until the sell offer exists there is nothing for
      // a winning bid to be matched against, so accepting bids earlier would be
      // taking commitments we could not settle.
      ...(listing.auctionId
        ? [
            prisma.auction.update({
              where: { id: listing.auctionId },
              data: { status: 'LIVE' },
            }),
          ]
        : []),
    ])
    res.json({ ...view(), state: 'active' })
    return
  }

  // ---- withdrawal --------------------------------------------------------
  if (listing.cancelPayloadUuid && listing.status === 'ACTIVE') {
    const cancel = await tryGetPayload(listing.cancelPayloadUuid)
    if (cancel !== 'unavailable' && cancel?.signed && cancel.txid) {
      const ok = await txSucceeded(cancel.txid)
      if (ok === null) {
        await prisma.listing.update({
          where: { id: listing.id },
          data: { status: 'CANCELLING', cancelTxHash: cancel.txid },
        })
        res.json({ ...view(), state: 'cancelling' })
        return
      }
      if (ok) {
        await prisma.$transaction([
          prisma.listing.update({
            where: { id: listing.id },
            data: { status: 'CANCELLED', cancelTxHash: cancel.txid, closedAt: new Date() },
          }),
          prisma.ticket.update({ where: { id: listing.ticketId }, data: { status: 'MINTED' } }),
        ])
        res.json({ ...view(), state: 'cancelled' })
        return
      }
    }
  }

  // ---- phase 2: the buyer's bid ------------------------------------------
  if (listing.status === 'BUYER_PENDING' && listing.buyPayloadUuid) {
    const status = await tryGetPayload(listing.buyPayloadUuid)
    if (status === 'unavailable') {
      res.json(view())
      return
    }
    if (status?.cancelled) {
      // The buyer backed out. The sell offer is untouched, so the listing
      // returns to sale rather than dying.
      await prisma.listing.update({
        where: { id: listing.id },
        data: { status: 'ACTIVE', buyerId: null, buyerAddress: null, buyPayloadUuid: null },
      })
      res.json({ ...view(), state: 'active' })
      return
    }
    if (!status?.signed) {
      if (payloadExpired || status?.expired) {
        await prisma.listing.update({
          where: { id: listing.id },
          data: { status: 'ACTIVE', buyerId: null, buyerAddress: null, buyPayloadUuid: null },
        })
        res.json({ ...view(), state: 'active' })
        return
      }
      res.json(view())
      return
    }
    if (!status.txid) {
      res.json(view({ signed: true }))
      return
    }

    const ok = await txSucceeded(status.txid)
    if (ok === null) {
      res.json(view({ signed: true }))
      return
    }
    if (!ok) {
      await prisma.listing.update({
        where: { id: listing.id },
        data: { status: 'ACTIVE', buyerId: null, buyerAddress: null, buyPayloadUuid: null, buyTxHash: status.txid },
      })
      res.json({ ...view(), state: 'active', reason: 'The ledger rejected the bid' })
      return
    }

    const buyOfferIndex = await offerIndexFromTx(status.txid)
    if (!buyOfferIndex) {
      res.json(view({ signed: true }))
      return
    }

    await prisma.listing.update({
      where: { id: listing.id },
      data: { status: 'SETTLING', buyTxHash: status.txid, buyOfferIndex },
    })
    res.json({ ...view(), state: 'settling' })
    return
  }

  // ---- phase 3: Hubworld brokers the match -------------------------------
  if (listing.status === 'SETTLING' && listing.offerIndex && listing.buyOfferIndex) {
    const owed = listing.priceDrops + listing.platformFeeDrops

    // Pre-flight the buyer's balance. A buy offer does not lock funds, so the
    // buyer can spend the money between committing and settling. Submitting
    // anyway would burn a transaction fee to learn what we can read for free.
    if (listing.buyerAddress) {
      try {
        const spendable = await spendableDrops(listing.buyerAddress)
        if (spendable < owed) {
          await prisma.listing.update({
            where: { id: listing.id },
            data: {
              failureReason: `Waiting for the buyer's balance: ${spendable.toString()} of ${owed.toString()} drops`,
            },
          })
          res.json({
            ...view(),
            state: 'settling',
            reason: "Waiting for the buyer's balance to cover the sale",
          })
          return
        }
      } catch {
        // Ledger unreachable — fall through and let the submission decide.
      }
    }

    const result = await brokerSale({
      sellOfferIndex: listing.offerIndex,
      buyOfferIndex: listing.buyOfferIndex,
      brokerFeeDrops: listing.platformFeeDrops,
    })

    if (!result.succeeded) {
      // A funding failure is NOT terminal, and treating it as such loses a real
      // sale: both offers stay live on-ledger, so the moment the buyer is paid
      // this settles. Observed for real — a listing closed as FAILED became
      // settleable when its buyer was paid by an unrelated sale. Stay in
      // SETTLING and let the next poll try again.
      const retryable = result.result === 'tecINSUFFICIENT_FUNDS'
      await prisma.listing.update({
        where: { id: listing.id },
        data: {
          status: retryable ? 'SETTLING' : 'FAILED',
          brokerTxHash: result.hash,
          failureReason: retryable
            ? `Buyer could not pay (${result.result}); will retry while the offers stand`
            : `Brokered settlement failed: ${result.result}`,
        },
      })
      res.json({
        ...view(),
        state: retryable ? 'settling' : 'failed',
        reason: retryable
          ? 'The buyer could not pay. This will settle if they fund the bid.'
          : `Brokered settlement failed: ${result.result}`,
      })
      return
    }

    // Sold. Ownership, provenance and the ticket cache move together, keyed on
    // the unique txHash so a duplicate poll cannot double-record the sale.
    await prisma.$transaction(async (tx) => {
      await tx.ticket.update({
        where: { id: listing.ticketId },
        data: {
          ownerId: listing.buyerId,
          ownerAddress: listing.buyerAddress,
          syncedAt: new Date(),
          status: 'MINTED',
        },
      })

      const already = await tx.transfer.findUnique({ where: { txHash: result.hash } })
      if (!already) {
        await tx.transfer.create({
          data: {
            ticketId: listing.ticketId,
            fromAddress: listing.sellerAddress,
            toAddress: listing.buyerAddress!,
            txHash: result.hash,
            kind: 'SALE',
            occurredAt: new Date(),
          },
        })
      }

      await tx.listing.update({
        where: { id: listing.id },
        data: { status: 'SOLD', brokerTxHash: result.hash, closedAt: new Date() },
      })
    })

    res.json({ ...view(), state: 'sold', brokerTxHash: result.hash })
    return
  }

  res.json(view())
})
