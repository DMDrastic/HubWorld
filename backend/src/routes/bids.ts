/**
 * Placing bids.
 *
 * A bid is an XRPL **buy offer** (`NFTokenCreateOffer` with `Destination` = the
 * broker), not an escrow. The reasoning is in CLAUDE.md; the short version is
 * that `NFTokenAcceptOffer` moves the NFT and the XRP atomically while an Escrow
 * releases on a timer that knows nothing about the ticket.
 *
 * `Destination` = broker matters twice over: it stops anyone but Hubworld
 * matching the bid, and it makes a losing bid inert on-ledger rather than a live
 * order someone could take later.
 *
 * Funds are NOT locked. Balance is checked here and must be re-checked at
 * settlement, because a bidder can spend the money in between.
 */
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { brokerMode, xamanMode } from '../env.js'
import { tryGetPayload, xaman } from '../xaman.js'
import { trackPayload } from '../payload-store.js'
import { issuesOf } from '../schemas.js'
import { requireAuth } from '../session.js'
import { publishAuctionEvent } from '../realtime.js'
import { signedByOtherAccount } from '../signer.js'
import {
  buildBuyOfferTx,
  offerIndexFromTx,
  platformAddress,
  spendableDrops,
  txSucceeded,
  XAMAN_NETWORK,
} from '../ledger.js'

export const bidsRouter = Router()

/** Unsigned-payload TTL. Short: an unsigned bid is stale almost immediately. */
const BID_TTL_MINUTES = 10
const BID_TTL_MS = BID_TTL_MINUTES * 60 * 1000

const IdParams = z.object({ id: z.string().uuid() })

const BidBody = z.object({
  amountDrops: z
    .string()
    .regex(/^[1-9][0-9]{0,17}$/, 'amountDrops must be a positive integer string of drops'),
})

/** Statuses whose money is actually committed on-ledger. */
const COMMITTED_STATUSES = ['COMMITTED', 'OUTBID', 'WON'] as const

/**
 * POST /api/auctions/:id/bid
 * Returns a Xaman payload for the BIDDER to sign.
 */
bidsRouter.post('/auctions/:id/bid', requireAuth, async (req, res) => {
  const params = IdParams.safeParse(req.params)
  if (!params.success) {
    res.status(400).json({ error: 'Invalid auction id', details: issuesOf(params.error) })
    return
  }
  const body = BidBody.safeParse(req.body ?? {})
  if (!body.success) {
    res.status(400).json({ error: 'Invalid request', details: issuesOf(body.error) })
    return
  }

  // Settlement needs our signature, so refuse a bid we could never honour
  // rather than leaving an unmatchable offer on the ledger.
  if (brokerMode === 'disabled') {
    res.status(503).json({
      error: 'Bidding is unavailable: the platform broker account is not configured',
    })
    return
  }

  const amountDrops = BigInt(body.data.amountDrops)

  const [auction, me] = await Promise.all([
    prisma.auction.findUnique({
      where: { id: params.data.id },
      include: { ticket: { include: { owner: true } } },
    }),
    prisma.user.findUnique({ where: { id: req.userId! } }),
  ])

  if (!auction) {
    res.status(404).json({ error: 'Auction not found' })
    return
  }
  if (!me) {
    res.status(404).json({ error: 'User no longer exists' })
    return
  }
  if (auction.status !== 'LIVE') {
    res.status(409).json({ error: `Auction is ${auction.status.toLowerCase()}, not accepting bids` })
    return
  }
  if (auction.endsAt <= new Date()) {
    res.status(409).json({ error: 'This auction has closed' })
    return
  }
  if (!auction.ticket.ownerAddress) {
    res.status(409).json({ error: 'The ticket has no known owner to bid against' })
    return
  }
  if (auction.ticket.ownerId === me.id) {
    res.status(400).json({ error: 'You cannot bid on your own ticket' })
    return
  }

  // Must beat the reserve and the standing bid. Checked against COMMITTED bids
  // only — an unsigned bid is not a price and must not block anyone.
  const top = await prisma.bid.findFirst({
    where: { auctionId: auction.id, status: { in: [...COMMITTED_STATUSES] } },
    orderBy: { amountDrops: 'desc' },
  })
  const floor = auction.reserveDrops ?? 0n
  if (amountDrops < floor) {
    res.status(400).json({
      error: `Bid is below the reserve of ${floor.toString()} drops`,
      reserveDrops: floor.toString(),
    })
    return
  }
  if (top && amountDrops <= top.amountDrops) {
    res.status(409).json({
      error: `Bid must exceed the current bid of ${top.amountDrops.toString()} drops`,
      currentBidDrops: top.amountDrops.toString(),
    })
    return
  }

  // Funds are not locked by a buy offer, so the least we can do is refuse a bid
  // the bidder demonstrably cannot honour right now.
  let spendable: bigint | null = null
  try {
    spendable = await spendableDrops(me.xrplAddress)
  } catch {
    // A ledger hiccup must not block bidding outright; settlement re-checks.
    spendable = null
  }
  if (spendable !== null && spendable < amountDrops) {
    res.status(400).json({
      error: 'Your spendable balance is below this bid',
      spendableDrops: spendable.toString(),
    })
    return
  }

  let txjson
  try {
    txjson = buildBuyOfferTx({
      buyerAddress: me.xrplAddress,
      ownerAddress: auction.ticket.ownerAddress,
      nfTokenId: auction.ticket.nfTokenId,
      amountDrops,
      brokerAddress: platformAddress(),
    })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not build the bid' })
    return
  }

  const payload = await xaman.createPayload(txjson as unknown as Record<string, unknown>, {
    expireMinutes: BID_TTL_MINUTES,
    forceNetwork: XAMAN_NETWORK,
  })
  // Registered before it can resolve, so a webhook callback finds it and
  // reconciliation can spot one whose callback never arrived.
  await trackPayload(payload.uuid)

  const bid = await prisma.bid.create({
    data: {
      auctionId: auction.id,
      bidderId: me.id,
      bidderAddress: me.xrplAddress,
      amountDrops,
      bidPayloadUuid: payload.uuid,
      expiresAt: new Date(Date.now() + BID_TTL_MS),
    },
  })

  res.status(201).json({
    bidId: bid.id,
    uuid: payload.uuid,
    next: payload.next,
    qrPng: payload.qrPng,
    mode: xamanMode,
    amountDrops: amountDrops.toString(),
  })
})

/**
 * GET /api/bids/:id — poll one bid until its offer is on-ledger.
 */
bidsRouter.get('/bids/:id', requireAuth, async (req, res) => {
  const parsed = IdParams.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid bid id', details: issuesOf(parsed.error) })
    return
  }

  const bid = await prisma.bid.findUnique({
    where: { id: parsed.data.id },
    include: { bidder: { select: { username: true } } },
  })
  if (!bid) {
    res.status(404).json({ error: 'Bid not found' })
    return
  }
  if (bid.bidderId !== req.userId) {
    res.status(403).json({ error: 'Not your bid' })
    return
  }

  const view = (extra: Record<string, unknown> = {}) => ({
    bidId: bid.id,
    state: bid.status.toLowerCase(),
    amountDrops: bid.amountDrops.toString(),
    bidder: `@${bid.bidder.username}`,
    ...(bid.failureReason ? { reason: bid.failureReason } : {}),
    ...extra,
  })

  // Terminal, or already committed — nothing further to ask Xaman.
  if (bid.status !== 'PENDING' || !bid.bidPayloadUuid) {
    res.json(view())
    return
  }

  const status = await tryGetPayload(bid.bidPayloadUuid)
  if (status === 'unavailable') {
    res.json(view())
    return
  }
  if (status?.cancelled) {
    await prisma.bid.update({ where: { id: bid.id }, data: { status: 'CANCELLED' } })
    res.json({ ...view(), state: 'cancelled' })
    return
  }
  if (!status?.signed) {
    // Nothing on-ledger yet, so expiring is honest.
    if ((bid.expiresAt && bid.expiresAt < new Date()) || status?.expired) {
      await prisma.bid.update({ where: { id: bid.id }, data: { status: 'CANCELLED' } })
      res.json({ ...view(), state: 'cancelled' })
      return
    }
    res.json(view())
    return
  }
  // A payload is BUILT for one account, but Xaman signs with whichever account
  // the user has selected in the app — nothing in the signature ties it to the
  // account we intended. So the signer has to be checked here, or the ledger and
  // this row describe different people.
  //
  // Observed for real on testnet: a bid started while signed in as one user was
  // signed with a different wallet, and committed under the first user's name.
  // The consequences are not cosmetic. `Bid.bidderAddress` is what settlement
  // reads spendable balance from, so it would check an account that is not
  // paying; the `Transfer` provenance row would name the wrong party; and
  // `Ticket.ownerId` would disagree with the ledger until `ledger:sync` ran.
  //
  // Worst of all it is an integrity hole in the auction: `auction-policy` stops
  // an organizer AUCTIONING their own allocation, but this let the issuer BID on
  // one while appearing to be somebody else — and XRPL silently skips
  // `TransferFee` when the issuer is party to a trade, so that bid would also
  // have paid no royalty.
  if (signedByOtherAccount(bid.bidderAddress, status.account)) {
    await prisma.bid.update({
      where: { id: bid.id },
      data: {
        status: 'FAILED',
        buyTxHash: status.txid ?? null,
        failureReason: 'Signed by a different account than the bidder',
      },
    })
    res.json({
      ...view(),
      state: 'failed',
      reason: 'Signed by a different account than the bidder',
    })
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
    await prisma.bid.update({
      where: { id: bid.id },
      data: { status: 'FAILED', buyTxHash: status.txid, failureReason: 'The ledger rejected the bid' },
    })
    res.json({ ...view(), state: 'failed', reason: 'The ledger rejected the bid' })
    return
  }

  const buyOfferIndex = await offerIndexFromTx(status.txid)
  if (!buyOfferIndex) {
    res.json(view({ signed: true }))
    return
  }

  // Committed. Demote any lower committed bid in the same transaction, so the
  // leader is unambiguous even if two bids land close together.
  await prisma.$transaction(async (tx) => {
    await tx.bid.update({
      where: { id: bid.id },
      data: {
        status: 'COMMITTED',
        buyTxHash: status.txid,
        buyOfferIndex,
        committedAt: new Date(),
      },
    })
    await tx.bid.updateMany({
      where: {
        auctionId: bid.auctionId,
        id: { not: bid.id },
        status: 'COMMITTED',
        amountDrops: { lt: bid.amountDrops },
      },
      data: { status: 'OUTBID' },
    })
  })

  // Push to everyone watching. Only committed bids are announced, for the same
  // reason only committed bids set the price: an unfunded bid must not move what
  // viewers see.
  publishAuctionEvent({
    type: 'bid',
    auctionId: bid.auctionId,
    amountDrops: bid.amountDrops.toString(),
    bidder: `@${bid.bidder.username}`,
    placedAt: new Date().toISOString(),
  })

  res.json({ ...view(), state: 'committed' })
})
