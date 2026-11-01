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
import { NETWORK } from '../network.js'
import { brokerMode, xamanMode, feeModelV2 } from '../env.js'
import { signing, SIGNIN_TTL_MINUTES, signingFor } from '../signing.js'
import { issuesOf } from '../schemas.js'
import { requireAuth } from '../session.js'
import { advanceListing, listingInclude, listingView } from '../listing-advance.js'
import { checkResalePrice, maxAskForCap, isPrimarySale } from '../resale-policy.js'
import { paidCostOf } from '../paid-cost.js'
import { PRICE_UNAVAILABLE, buyerPaysDrops, currentMinimumResaleDrops, primaryFeeDrops, resaleListingTerms } from '../listing-terms.js'
import {
  buildBuyOfferTx,
  buildCancelOfferTx,
  buildSellOfferTx,
  holdsNft,
  platformAddress,
  platformFeeDrops,
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
    prisma.ticket.findUnique({
      where: { network_nfTokenId: { network: NETWORK, nfTokenId } },
      include: { event: true },
    }),
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

  // See isPrimarySale's doc comment in resale-policy.ts for why this is NOT
  // simply "the seller is the organizer". The actual write happens below,
  // together with the Listing — not here, where a later failure (building
  // the tx, Xaman's payload quota) would freeze a face value with no listing
  // to show for it, unrecoverable since there is no event/ticket-edit route.
  const primarySale = isPrimarySale({
    organizerId: ticket.event.organizerId,
    sellerId: me.id,
    faceValueDrops: ticket.faceValueDrops,
  })

  // The terms this listing is created under, frozen on it. Which fee model applies is decided HERE, once:
  // a listing already quoted to a buyer must settle to exactly what it said, whatever the rules become later.
  //  - Old model (the default): the buyer pays the fee ON TOP of the ask.
  //  - New model, a FIRST sale: the same shape, with the new fan fee (only the proportional part in XRP).
  //  - New model, a RESALE: the SELLER pays. The buyer pays exactly the price; the sell offer is price - fee.
  let fee: bigint
  let feeModel: 'BUYER_PAYS_V1' | 'SELLER_PAYS_V2' = 'BUYER_PAYS_V1'
  let feeBps: number | null = null
  let sellOfferAmount = priceDrops
  if (!feeModelV2) {
    fee = platformFeeDrops(priceDrops, ticket.event.platformBps)
  } else if (primarySale) {
    const f = primaryFeeDrops({ priceDrops, event: ticket.event, organizerFounding: me.foundingOrganizer })
    fee = f.feeDrops
    feeBps = f.feeBps
  } else {
    const minimumDrops = await currentMinimumResaleDrops()
    if (minimumDrops === null) {
      // No usable XRP price, so no floor can be worked out. Wait; do not guess.
      res.status(503).json(PRICE_UNAVAILABLE)
      return
    }
    const terms = resaleListingTerms({ priceDrops, minimumDrops })
    if (!terms.ok) {
      // The cap below is checked first for a ticket that cannot be sold for money at all; a price too small to
      // be worth listing is told so here.
      const cap = checkResalePrice({
        policy: ticket.event.resalePolicy,
        capBps: ticket.event.resaleCapBps,
        capDrops: ticket.event.resaleCapDrops,
        faceValueDrops: ticket.faceValueDrops,
        paid: paidCostOf(ticket),
        priceDrops,
      })
      if (!cap.allowed) {
        res.status(400).json({ error: cap.reason, maxResaleDrops: cap.maxDrops?.toString() ?? null })
        return
      }
      res.status(400).json({ error: terms.reason })
      return
    }
    fee = terms.feeDrops
    feeModel = 'SELLER_PAYS_V2'
    feeBps = terms.feeBps
    sellOfferAmount = terms.sellOfferDrops
  }

  if (!primarySale) {
    // Checked against what the BUYER actually pays. Under the old terms that is the ask plus the fee, so the
    // fee lets the final price creep past the organizer's cap unless it is counted. Under the new terms the
    // buyer pays exactly the price, so the price is compared as it stands. Auctions/bids need no adjustment
    // either way; a bid amount already IS the buyer's total.
    const buyerTotal = feeModel === 'SELLER_PAYS_V2' ? priceDrops : priceDrops + fee
    const cap = checkResalePrice({
      policy: ticket.event.resalePolicy,
      capBps: ticket.event.resaleCapBps,
      capDrops: ticket.event.resaleCapDrops,
      faceValueDrops: ticket.faceValueDrops,
      paid: paidCostOf(ticket),
      priceDrops: buyerTotal,
    })
    if (!cap.allowed) {
      res.status(400).json({
        error: cap.reason,
        maxResaleDrops:
          cap.maxDrops === null
            ? null
            : feeModel === 'SELLER_PAYS_V2'
              ? cap.maxDrops.toString()
              : maxAskForCap(cap.maxDrops, ticket.event.platformBps).toString(),
      })
      return
    }
  }

  // Resolved ONCE and recorded on the Listing, because this address is baked
  // into the offer's `Destination` and only this account can ever settle it.
  const brokerAddress = platformAddress()

  let txjson
  try {
    txjson = buildSellOfferTx({
      ownerAddress: me.xrplAddress,
      nfTokenId,
      // The seller's side of the match: their ask under the old terms, price - fee under the new.
      amountDrops: sellOfferAmount,
      brokerAddress,
    })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not build listing' })
    return
  }

  const payload = await (await signingFor(me.id, 'LISTING_CREATE')).createPayload(txjson as unknown as Record<string, unknown>, {
    flow: 'LISTING_CREATE',
    userId: me.id,
    expireMinutes: LIST_TTL_MINUTES,
    forceNetwork: XAMAN_NETWORK,
  })

  // Backfilling face value and creating the Listing happen together: if
  // either failed alone, either a wrong face value could be frozen with
  // nothing to show for it, or a primary sale could lack the face value it
  // was supposed to establish.
  const listing = await prisma.$transaction(async (tx) => {
    if (primarySale) {
      // Conditional on STILL being null, not just an update — `primarySale`
      // was computed from a snapshot read, so a concurrent double-submit (a
      // double-click, a client retry) could otherwise have both requests see
      // faceValueDrops as null and race to overwrite it with different
      // prices. Whichever transaction commits first wins; the second is a
      // no-op here rather than a silent overwrite of a value nothing can
      // ever correct afterward.
      await tx.ticket.updateMany({
        where: { id: ticket.id, faceValueDrops: null },
        data: { faceValueDrops: priceDrops },
      })
    }
    return tx.listing.create({
      data: {
        ticketId: ticket.id,
        network: NETWORK,
        sellerId: me.id,
        sellerAddress: me.xrplAddress,
        brokerAddress,
        priceDrops,
        // Frozen at listing time: changing platformBps later must not alter
        // the terms a buyer has already been shown.
        platformFeeDrops: fee,
        feeModel,
        feeBps,
        isPrimarySale: primarySale,
        listPayloadUuid: payload.uuid,
        expiresAt: new Date(Date.now() + LIST_TTL_MS),
      },
    })
  })

  res.status(201).json({
    listingId: listing.id,
    uuid: payload.uuid,
    next: payload.next,
    qrPng: payload.qrPng,
    mode: xamanMode,
    priceDrops: priceDrops.toString(),
    platformFeeDrops: fee.toString(),
    feeModel,
    buyerPaysDrops: (feeModel === 'SELLER_PAYS_V2' ? priceDrops : priceDrops + fee).toString(),
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
    //
    // reservedForId null: a checkout's listing belongs to ONE buyer for the length
    // of their hold. It is not an open offer, and advertising it would invite a
    // second buyer to bid on a ticket already spoken for.
    where: { status: 'ACTIVE', auctionId: null, reservedForId: null },
    include: listingInclude,
    orderBy: { listedAt: 'desc' },
    take: 100,
  })
  res.json({ listings: listings.map(listingView) })
})

/**
 * GET /api/listings/mine — what I am selling and what I am buying.
 */
const NOTICE_DAYS = 7

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

  // Bids that were let go (the buyer could not pay, or their offer vanished). The sale went back on sale for the next
  // buyer, so it is no longer theirs; this is the record of what happened to theirs, for a week.
  const notices = await prisma.listingBuyerNotice.findMany({
    where: { userId: req.userId!, createdAt: { gt: new Date(Date.now() - NOTICE_DAYS * 86_400_000) } },
    include: { listing: { include: listingInclude } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })

  res.json({
    listings: [
      ...listings.map((l) => ({
        ...listingView(l),
        role: l.sellerId === req.userId ? 'seller' : 'buyer',
      })),
      ...notices.map((n) => ({
        ...listingView(n.listing),
        state: 'failed',
        reason: n.reason,
        // What THEY had offered, which is no longer what the listing asks.
        buyerPaysDrops: n.amountDrops.toString(),
        role: 'buyer',
      })),
    ],
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
  if (listing.reservedForId) {
    // A checkout's listing is one person's reserved purchase. It is made by the
    // checkout, which also creates the buyer's payload, so there is nothing for
    // anyone to buy through here.
    res.status(409).json({ error: 'This ticket is reserved for another buyer' })
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

  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: listing.ticketId } })

  // The ledger, not our own status column.
  //
  // A seller can cancel their offer or move the ticket in Xaman without ever
  // touching HubWorld, and `Listing.status` keeps saying ACTIVE. Buying against
  // that costs the buyer a Xaman payload AND locks 0.2 XRP of owner reserve on
  // an offer that can never match — and they find out only when settlement
  // fails, long after they signed.
  //
  // `ledger:sync` already reports this drift, but it reconciles AFTER the fact.
  // This is the one moment where checking prevents someone spending money, so
  // the round trip is worth it. Every other write path that acts on a ticket
  // already re-reads: gift, list, and auction-open all call holdsNft first.
  //
  // Unreachable ledger is NOT treated as absent: an unknown answer must not
  // block a legitimate purchase, the same rule the door follows when it admits
  // an attendee on a cached claim rather than turning away a real one.
  const sellerStillHolds = await holdsNft(listing.sellerAddress, ticket.nfTokenId).catch(() => null)
  if (sellerStillHolds === false) {
    await prisma.listing.update({
      where: { id: listing.id },
      data: { status: 'CANCELLED' },
    })
    res.status(409).json({
      error: 'The seller no longer holds this ticket — the listing has been withdrawn',
    })
    return
  }

  let txjson
  try {
    txjson = buildBuyOfferTx({
      buyerAddress: me.xrplAddress,
      ownerAddress: listing.sellerAddress,
      nfTokenId: ticket.nfTokenId,
      // The ledger requires buy >= sell + brokerFee. What the buyer owes depends on the terms THIS listing was
      // created under: the price plus the fee (old), or exactly the price (new).
      amountDrops: buyerPaysDrops(listing),
      // The LISTING's broker, not whatever is configured now. Both offers must
      // name the same `Destination` or the pair can never be brokered — and if
      // the platform key has rotated since the seller listed, "now" is a
      // different account from the one their offer already names.
      brokerAddress: listing.brokerAddress ?? platformAddress(),
    })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not build bid' })
    return
  }

  const payload = await (await signingFor(me.id, 'LISTING_BUY')).createPayload(txjson as unknown as Record<string, unknown>, {
    flow: 'LISTING_BUY',
    userId: me.id,
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
    paysDrops: buyerPaysDrops(listing).toString(),
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

  const payload = await (await signingFor(req.userId, 'LISTING_CANCEL')).createPayload(
    buildCancelOfferTx({
      ownerAddress: listing.sellerAddress,
      offerIndex: listing.offerIndex,
    }) as unknown as Record<string, unknown>,
    { flow: 'LISTING_CANCEL', userId: req.userId, expireMinutes: LIST_TTL_MINUTES, forceNetwork: XAMAN_NETWORK },
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
 *
 * The phases themselves live in `advanceListing`, because they must also be driven
 * when nobody is polling: a buyer who signs and closes the tab would otherwise
 * strand a paid-for sale until they came back.
 */
listingsRouter.get('/listings/:id', requireAuth, async (req, res) => {
  const parsed = IdParams.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid listing id', details: issuesOf(parsed.error) })
    return
  }

  const result = await advanceListing(parsed.data.id)
  if (!result) {
    res.status(404).json({ error: 'Listing not found' })
    return
  }
  res.json(result)
})
