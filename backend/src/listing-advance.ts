/**
 * Moving a sale forward: the seller's offer, the buyer's bid, the brokered match.
 *
 * This was the body of `GET /listings/:id`, and that was the problem: a sale only
 * moved when somebody's browser asked it to. For a resale that is a tolerable
 * accident. For a box-office purchase it is not — a buyer signs on their phone
 * and the page that was polling is a tab on a laptop they have since closed, so
 * the ticket and the payment sat in limbo until they came back.
 *
 * So it lives here, driven by the poll AND by the sweep (`advanceStuckSales`),
 * and it takes a per-listing lease while it works. Two drivers advancing one
 * sale is the failure the lease exists for: both reach `brokerSale`, the second
 * finds the offers already consumed (`tecNO_ENTRY`), and a non-retryable result
 * marks a sale that actually completed as FAILED.
 */
import { prisma } from './prisma.js'
import { NETWORK } from './network.js'
import { withLock } from './job-lock.js'
import { tryGetPayload } from './signing.js'
import { brokerSale, offerIndexFromTx, offerOnLedgerState, spendableDrops, txSucceeded } from './ledger.js'
import { releaseHold } from './primary-sale.js'
import { buyerPaysDrops } from './listing-terms.js'
import { defaultPrimarySaleLedger } from './primary-sale-ledger.js'
import { classifyResult } from './tx-result.js'
import { CLAIM_LEASE_MS, SWEEP_GRACE_MS, isFundsShortfall, settleStrike, stuckCutoff } from './settle-policy.js'

// Used only to release a checkout's hold when its buyer backs out.
const primaryLedger = defaultPrimarySaleLedger()

/** Long enough for a brokered submit to validate; a dead holder lets it lapse. */
const LEASE_TTL_MS = 120_000

export function listingView(l: {
  id: string
  priceDrops: bigint
  platformFeeDrops: bigint
  feeModel: 'BUYER_PAYS_V1' | 'SELLER_PAYS_V2'
  status: string
  seller: { username: string }
  buyer: { username: string } | null
  ticket: { nfTokenId: string; seat: string | null; tier: string | null; event: { slug: string; title: string } }
  failureReason: string | null
}) {
  return {
    listingId: l.id,
    state: l.status.toLowerCase(),
    // What the seller asks, what Hubworld takes, and what the buyer pays. Which of the two models made the
    // listing decides whether the fee is on top of the price (BUYER_PAYS_V1) or comes out of the seller's
    // side (SELLER_PAYS_V2), so the screen is told which rather than left to guess.
    priceDrops: l.priceDrops.toString(),
    platformFeeDrops: l.platformFeeDrops.toString(),
    buyerPaysDrops: buyerPaysDrops(l).toString(),
    feeModel: l.feeModel,
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

export const listingInclude = {
  seller: { select: { username: true } },
  buyer: { select: { username: true } },
  ticket: {
    include: { event: { select: { slug: true, title: true, platformBps: true, timeZone: true } } },
  },
} as const


export type ListingView = ReturnType<typeof listingView> & Record<string, unknown>

type LoadedListing = NonNullable<Awaited<ReturnType<typeof load>>>

const load = (id: string) => prisma.listing.findUnique({ where: { id }, include: listingInclude })

const TERMINAL = ['SOLD', 'CANCELLED', 'EXPIRED', 'FAILED']

/**
 * Advance one listing as far as the ledger allows, and say where it stands.
 * Returns null when there is no such listing.
 */
export async function advanceListing(id: string): Promise<ListingView | null> {
  const listing = await load(id)
  if (!listing) return null

  // Nothing to do, and no reason to take a lease for it.
  if (TERMINAL.includes(listing.status)) return { ...listingView(listing) }

  const advanced = await withLock(`listing:${listing.id}`, LEASE_TTL_MS, () => advance(listing))
  // Another driver is mid-step on this sale. Reporting where it stands is right;
  // stepping alongside it is the double-broker.
  return advanced ?? { ...listingView(listing) }
}

/**
 * `advanceListing` WITHOUT the in-process lease.
 *
 * The lease is a courtesy that keeps two drivers from queueing up behind each other; it is not what makes a double match
 * impossible, because a lease can lapse under a slow driver and a second instance can race the first. What does is the
 * compare-and-set on the row itself, inside `advance`. This exists so that guarantee can be tested on its own, with
 * nothing in front of it.
 */
export async function advanceListingUnleased(id: string): Promise<ListingView | null> {
  const listing = await load(id)
  if (!listing) return null
  if (TERMINAL.includes(listing.status)) return { ...listingView(listing) }
  return advance(listing)
}

async function advance(listing: LoadedListing): Promise<ListingView> {
  const view = (extra: Record<string, unknown> = {}) => ({ ...listingView(listing), ...extra })

  // Terminal states need no further work.
  if (['SOLD', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(listing.status)) {
    return view()
  }

  const payloadExpired = listing.expiresAt < new Date()

  // ---- phase 1: the seller's sell offer ----------------------------------
  if (listing.status === 'PENDING_OFFER') {
    const status = await tryGetPayload(listing.listPayloadUuid)
    if (status === 'unavailable') {
      return view()
    }
    if (status?.cancelled) {
      await prisma.listing.update({
        where: { id: listing.id },
        data: { status: 'CANCELLED', closedAt: new Date() },
      })
      return { ...view(), state: 'cancelled' }
    }
    if (!status?.signed) {
      // Nothing on-ledger yet, so expiring is honest.
      if (payloadExpired || status?.expired) {
        await prisma.listing.update({ where: { id: listing.id }, data: { status: 'EXPIRED' } })
        return { ...view(), state: 'expired' }
      }
      return view()
    }
    if (!status.txid) {
      return view({ signed: true })
    }

    const ok = await txSucceeded(status.txid)
    if (ok === null) {
      return view({ signed: true })
    }
    if (!ok) {
      await prisma.listing.update({
        where: { id: listing.id },
        data: { status: 'FAILED', listTxHash: status.txid, failureReason: 'The ledger rejected the listing' },
      })
      return { ...view(), state: 'failed', reason: 'The ledger rejected the listing' }
    }

    const offerIndex = await offerIndexFromTx(status.txid)
    if (!offerIndex) {
      return view({ signed: true })
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
    return { ...view(), state: 'active' }
  }

  // ---- withdrawal --------------------------------------------------------
  //
  // CANCELLING is included deliberately, and leaving it out was a trap: the
  // status is written precisely when `txSucceeded` cannot yet see a validated
  // transaction, so the listing needs a LATER poll to finish the job — but a
  // later poll no longer matched an ACTIVE-only guard, and nothing else in the
  // codebase moves a listing out of CANCELLING. The withdrawal therefore never
  // completed: the seller's offer stayed live on-ledger, and because
  // `ON_LEDGER_STATES` counts CANCELLING, that ticket could never be listed or
  // auctioned again. A state you can enter and not leave is a leak, not a state.
  if (listing.cancelPayloadUuid && (listing.status === 'ACTIVE' || listing.status === 'CANCELLING')) {
    const cancel = await tryGetPayload(listing.cancelPayloadUuid)
    if (cancel !== 'unavailable' && cancel?.signed && cancel.txid) {
      const ok = await txSucceeded(cancel.txid)
      if (ok === null) {
        await prisma.listing.update({
          where: { id: listing.id },
          data: { status: 'CANCELLING', cancelTxHash: cancel.txid },
        })
        return { ...view(), state: 'cancelling' }
      }
      if (ok) {
        await prisma.$transaction([
          prisma.listing.update({
            where: { id: listing.id },
            data: { status: 'CANCELLED', cancelTxHash: cancel.txid, closedAt: new Date() },
          }),
          prisma.ticket.update({ where: { id: listing.ticketId }, data: { status: 'MINTED' } }),
        ])
        return { ...view(), state: 'cancelled' }
      }
      // The ledger rejected the cancellation, so the sell offer is still live
      // and the listing is still genuinely for sale. Returning it to ACTIVE is
      // what the state means; leaving it in CANCELLING would strand the ticket
      // for a withdrawal that demonstrably did not happen.
      if (listing.status === 'CANCELLING') {
        await prisma.listing.update({
          where: { id: listing.id },
          data: { status: 'ACTIVE', cancelPayloadUuid: null, cancelTxHash: null },
        })
        return { ...view(), state: 'active' }
      }
    }
  }

  // ---- phase 2: the buyer's bid ------------------------------------------
  if (listing.status === 'BUYER_PENDING' && listing.buyPayloadUuid) {
    const status = await tryGetPayload(listing.buyPayloadUuid)
    if (status === 'unavailable') {
      return view()
    }

    // A checkout's listing is ONE buyer's reserved purchase, not an open offer.
    // When that buyer backs out there is nobody to return it to sale for, so the
    // ticket is released and its offer taken off the ledger instead.
    const backOut = async (reason: string) => {
      if (!listing.reservedForId) return null
      await releaseHold(listing.id, primaryLedger, reason)
      return { ...view(), status: 'CANCELLED', state: 'cancelled', reason }
    }

    if (status?.cancelled) {
      {
        const released = await backOut('The purchase was declined')
        if (released) return released
      }
      // The buyer backed out. The sell offer is untouched, so the listing
      // returns to sale rather than dying.
      await prisma.listing.update({
        where: { id: listing.id },
        data: { status: 'ACTIVE', buyerId: null, buyerAddress: null, buyPayloadUuid: null },
      })
      return { ...view(), state: 'active' }
    }
    if (!status?.signed) {
      if (payloadExpired || status?.expired) {
        {
        const released = await backOut('The purchase expired')
        if (released) return released
      }
        await prisma.listing.update({
          where: { id: listing.id },
          data: { status: 'ACTIVE', buyerId: null, buyerAddress: null, buyPayloadUuid: null },
        })
        return { ...view(), state: 'active' }
      }
      return view()
    }
    if (!status.txid) {
      return view({ signed: true })
    }

    const ok = await txSucceeded(status.txid)
    if (ok === null) {
      return view({ signed: true })
    }
    if (!ok) {
      {
        const released = await backOut('The ledger rejected the bid')
        if (released) return released
      }
      await prisma.listing.update({
        where: { id: listing.id },
        data: { status: 'ACTIVE', buyerId: null, buyerAddress: null, buyPayloadUuid: null, buyTxHash: status.txid },
      })
      return { ...view(), state: 'active', reason: 'The ledger rejected the bid' }
    }

    const buyOfferIndex = await offerIndexFromTx(status.txid)
    if (!buyOfferIndex) {
      return view({ signed: true })
    }

    // Compare-and-set: only one driver moves the sale on, and the clock for "stuck" starts here.
    await prisma.listing.updateMany({
      where: { id: listing.id, status: 'BUYER_PENDING' },
      data: { status: 'SETTLING', buyTxHash: status.txid, buyOfferIndex, settlingSince: new Date() },
    })
    return { ...view(), state: 'settling' }
  }

  // ---- phase 3: Hubworld brokers the match -------------------------------
  if (listing.status === 'SETTLING' && listing.offerIndex && listing.buyOfferIndex) {
    // What THIS listing's buyer must hold: the price plus the fee under the old terms, the price alone under the new.
    const owed = buyerPaysDrops(listing)
    const buyOfferIndex = listing.buyOfferIndex
    const sellOfferIndex = listing.offerIndex

    // Is there still something to match? A buy offer is an object on the ledger like any other: the buyer can cancel
    // it, or it can be consumed. Matching a vanished offer burns a fee to learn what a read tells us for free, and
    // waiting on one is waiting for ever. Only a definite "gone" counts: a node that cannot be reached says nothing.
    const [buyOffer, sellOffer] = await Promise.all([offerOnLedgerState(buyOfferIndex), offerOnLedgerState(sellOfferIndex)])
    if (buyOffer === 'gone') {
      return letGo(listing, owed, "Your offer is no longer on the ledger, so the sale could not be completed. Nothing was charged.", false, view)
    }
    if (sellOffer === 'gone') return sellerOfferGone(listing, owed, view)

    // Pre-flight the buyer's balance. A buy offer does not lock funds, so the
    // buyer can spend the money between committing and settling. Submitting
    // anyway would burn a transaction fee to learn what we can read for free.
    if (listing.buyerAddress) {
      try {
        const spendable = await spendableDrops(listing.buyerAddress)
        if (spendable < owed) {
          return buyerShort(listing, owed, `Waiting for the buyer's balance: ${spendable.toString()} of ${owed.toString()} drops`, view)
        }
      } catch {
        // Ledger unreachable — fall through and let the submission decide.
      }
    }

    // Claim this attempt on the ROW. The lease above keeps drivers out of each other's way; this is what makes a second
    // match impossible when it fails to: the second would find the offers consumed (tecNO_ENTRY) and mark a sale that
    // actually completed as FAILED. One update, conditional on nobody else holding an unexpired claim.
    const now = new Date()
    const claimed = await prisma.listing.updateMany({
      where: {
        id: listing.id,
        status: 'SETTLING',
        OR: [{ settleClaimedUntil: null }, { settleClaimedUntil: { lt: now } }],
      },
      data: { settleClaimedUntil: new Date(now.getTime() + CLAIM_LEASE_MS) },
    })
    if (claimed.count === 0) return view()

    let result: Awaited<ReturnType<typeof brokerSale>>
    try {
      result = await brokerSale({ sellOfferIndex, buyOfferIndex, brokerFeeDrops: listing.platformFeeDrops })
    } catch (err) {
      // Not an answer from the ledger: hand the attempt back so the next pass is not locked out for the lease.
      await prisma.listing.updateMany({ where: { id: listing.id, status: 'SETTLING' }, data: { settleClaimedUntil: null } })
      throw err
    }

    if (!result.succeeded) {
      // A funding failure is NOT terminal, and treating it as such loses a real
      // sale: both offers stay live on-ledger, so the moment the buyer is paid
      // this settles. Observed for real — a listing closed as FAILED became
      // settleable when its buyer was paid by an unrelated sale. So wait, with
      // backoff and a cap, rather than either giving up at once or retrying for ever.
      if (isFundsShortfall(result.result)) {
        return buyerShort(listing, owed, `Buyer could not pay (${result.result}); will retry while the offers stand`, view, result.hash)
      }

      // The match found its objects missing. Work out whose is gone before deciding anything: an offer the buyer
      // withdrew releases the sale for the next buyer, one the seller withdrew ends it.
      if (classifyResult(result.result) === 'gone') {
        const [b, s2] = await Promise.all([offerOnLedgerState(buyOfferIndex), offerOnLedgerState(sellOfferIndex)])
        if (b === 'gone') {
          return letGo(listing, owed, "Your offer is no longer on the ledger, so the sale could not be completed. Nothing was charged.", false, view)
        }
        if (s2 === 'gone') return sellerOfferGone(listing, owed, view)
      }

      await prisma.listing.update({
        where: { id: listing.id },
        data: {
          status: 'FAILED',
          brokerTxHash: result.hash,
          failureReason: `Brokered settlement failed: ${result.result}`,
        },
      })
      return {
        ...view(),
        state: 'failed',
        reason: `Brokered settlement failed: ${result.result}`,
      }
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

      // The first sale under the new model fixes what the ticket cost: the ALL-IN amount its buyer paid, which
      // becomes the resale cap. Three guards, each for a different way to get it wrong:
      //  - only a FIRST sale (a resale must never move the cap),
      //  - only a listing made under the new model (`feeBps` is set only then; older listings keep old rules),
      //  - only while nothing is recorded yet (a ticket the organizer bought back keeps its original amount).
      if (listing.isPrimarySale && listing.feeBps !== null) {
        await tx.ticket.updateMany({
          where: { id: listing.ticketId, originalCostMinor: null },
          data: { originalCostMinor: buyerPaysDrops(listing), originalCostCurrency: 'XRP' },
        })
      }

      const already = await tx.transfer.findUnique({
        where: { network_txHash: { network: NETWORK, txHash: result.hash } },
      })
      if (!already) {
        await tx.transfer.create({
          data: {
            ticketId: listing.ticketId,
            network: NETWORK,
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

    return { ...view(), state: 'sold', brokerTxHash: result.hash }
  }

  return view()
}

/**
 * The buyer cannot pay right now. Wait, with backoff, up to a cap; past it, let the sale go.
 *
 * A pass that finds the money is never held back by this - only the COUNTING of strikes is spaced out, so a client
 * polling every two seconds cannot burn through the cap in a few seconds, and a buyer who funds the bid is settled on
 * the very next pass whatever the strikes so far.
 */
async function buyerShort(
  listing: LoadedListing,
  owed: bigint,
  reason: string,
  view: (extra?: Record<string, unknown>) => ListingView,
  brokerTxHash?: string,
): Promise<ListingView> {
  const now = new Date()
  const waiting = listing.settleNextAt && listing.settleNextAt.getTime() > now.getTime()
  if (waiting && !brokerTxHash) {
    return { ...view(), state: 'settling', reason: "Waiting for the buyer's balance to cover the sale" }
  }

  const strike = settleStrike(listing.settleStrikes, now)
  if (strike.dead) {
    return letGo(listing, owed, 'The bid could not be paid: the buyer did not have the funds when the sale was due. Nothing was charged.', true, view)
  }

  // The strike count is written as an absolute value, so two drivers striking together write the same one; what
  // must not happen twice (letting the sale go) is guarded in `letGo` itself.
  await prisma.listing.updateMany({
    where: { id: listing.id, status: 'SETTLING' },
    data: {
      settleStrikes: strike.strikes,
      settleNextAt: strike.nextAt,
      settleClaimedUntil: null,
      failureReason: reason,
      ...(brokerTxHash ? { brokerTxHash } : {}),
    },
  })
  return {
    ...view(),
    state: 'settling',
    reason: brokerTxHash ? 'The buyer could not pay. This will settle if they fund the bid.' : "Waiting for the buyer's balance to cover the sale",
  }
}

/**
 * Let go of a bid that can never settle, and tell the buyer.
 *
 * The listing goes back on sale for the next buyer (a box-office checkout, which was only ever one person's, is
 * released instead), the buyer's leftover offer is cancelled so it stops holding 0.2 XRP of their reserve, and a
 * notice is left for them to find. Done in one conditional update, so two drivers letting go of the same sale leave
 * one notice, not two.
 */
async function letGo(
  listing: LoadedListing,
  owed: bigint,
  reason: string,
  cancelBuyerOffer: boolean,
  view: (extra?: Record<string, unknown>) => ListingView,
): Promise<ListingView> {
  const buyerOfferIndex = listing.buyOfferIndex
  let released = false

  if (listing.reservedForId) {
    released = await releaseHold(listing.id, primaryLedger, reason)
  } else {
    released = await prisma.$transaction(async (tx) => {
      const moved = await tx.listing.updateMany({
        where: { id: listing.id, status: 'SETTLING', buyOfferIndex: buyerOfferIndex },
        data: {
          status: 'ACTIVE',
          buyerId: null,
          buyerAddress: null,
          buyPayloadUuid: null,
          buyTxHash: null,
          buyOfferIndex: null,
          settlingSince: null,
          settleStrikes: 0,
          settleNextAt: null,
          settleClaimedUntil: null,
          settleAlertedAt: null,
          failureReason: null,
        },
      })
      return moved.count === 1
    })
  }

  if (!released) return view() // another driver got there first, and left the notice

  if (listing.buyerId) {
    await prisma.listingBuyerNotice.create({ data: { listingId: listing.id, userId: listing.buyerId, reason, amountDrops: owed } })
  }
  if (cancelBuyerOffer && buyerOfferIndex) {
    // Best effort: the offer is inert (only the broker can match it) and merely holds the buyer's reserve.
    await primaryLedger.cancelOffers([buyerOfferIndex]).catch(() => undefined)
  }
  return { ...view(), state: 'failed', reason }
}

/** The SELLER's offer is gone (they cancelled it, or moved the ticket): this sale cannot happen, for anyone. */
async function sellerOfferGone(
  listing: LoadedListing,
  owed: bigint,
  view: (extra?: Record<string, unknown>) => ListingView,
): Promise<ListingView> {
  const reason = 'The seller withdrew this ticket before the sale could complete. Nothing was charged.'
  const moved = await prisma.listing.updateMany({
    where: { id: listing.id, status: 'SETTLING' },
    data: { status: 'FAILED', failureReason: reason, closedAt: new Date(), settleClaimedUntil: null },
  })
  if (moved.count === 0) return view()
  if (listing.buyerId) {
    await prisma.listingBuyerNotice.create({ data: { listingId: listing.id, userId: listing.buyerId, reason, amountDrops: owed } })
  }
  if (listing.buyOfferIndex) await primaryLedger.cancelOffers([listing.buyOfferIndex]).catch(() => undefined)
  return { ...view(), state: 'failed', reason }
}

/**
 * Drive the sales nobody is watching.
 *
 * A buyer signs on their phone; the page that was polling is a tab on a laptop they have since closed. Two kinds of
 * sale are picked up here, and only these:
 *
 *   - anything in SETTLING (both offers are on the ledger; only the broker's match is missing), box-office or ordinary
 *     resale. This used to cover box-office sales alone, so a resale whose buyer left sat in SETTLING until somebody
 *     happened to poll it.
 *   - a bid that is SIGNED but not yet seen (BUYER_PENDING), box-office or resale. Signed is read from our own record of
 *     the payload, so the sweep never spends a Xaman call finding out.
 *
 * Auctions are left to `settleAuction`: their listing is a floor price, and matching it here would sell the ticket
 * for the reserve. Anything the buyer's own client is actively polling is left alone for the first 45 seconds.
 */
export async function advanceStuckSales(now = new Date(), limit = 20): Promise<number> {
  const cut = new Date(now.getTime() - SWEEP_GRACE_MS)

  const settling = await prisma.listing.findMany({
    where: {
      network: NETWORK,
      status: 'SETTLING',
      auctionId: null,
      // `settlingSince` is the clock; rows from before it existed fall back to when they were listed.
      OR: [{ settlingSince: { lt: cut } }, { settlingSince: null, listedAt: { lt: cut } }],
      // A sale in backoff is not asked about again until its time is up.
      AND: [{ OR: [{ settleNextAt: null }, { settleNextAt: { lte: now } }] }],
    },
    orderBy: { listedAt: 'asc' },
    take: limit,
    select: { id: true },
  })

  // A checkout's hold that nobody finished: old rule, unchanged. It includes unsigned bids, because releasing an
  // expired one is the point.
  const reserved = await prisma.listing.findMany({
    where: { network: NETWORK, reservedForId: { not: null }, status: 'BUYER_PENDING', listedAt: { lt: cut } },
    orderBy: { listedAt: 'asc' },
    take: limit,
    select: { id: true },
  })

  // An ordinary resale whose buyer signed: known from the payload we already hold.
  const pending = await prisma.listing.findMany({
    where: { network: NETWORK, reservedForId: null, auctionId: null, status: 'BUYER_PENDING', buyPayloadUuid: { not: null } },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: { id: true, buyPayloadUuid: true },
  })
  const signed = pending.length
    ? await prisma.xamanPayload.findMany({
        where: { uuid: { in: pending.map((p) => p.buyPayloadUuid!) }, signed: true, fetchedAt: { lt: cut } },
        select: { uuid: true },
      })
    : []
  const signedSet = new Set(signed.map((s) => s.uuid))
  const resales = pending.filter((p) => signedSet.has(p.buyPayloadUuid!)).map((p) => ({ id: p.id }))

  const ids = [...new Map([...settling, ...reserved, ...resales].map((l) => [l.id, l])).values()].slice(0, limit)

  let moved = 0
  for (const { id } of ids) {
    try {
      const before = await prisma.listing.findUnique({ where: { id }, select: { status: true } })
      let after = await advanceListing(id)
      // The sale this pass just took from "signed" to SETTLING goes straight on to the match: its clock restarted at
      // that moment, so waiting for the next pass would mean waiting for the courtesy window it just opened.
      if (before?.status === 'BUYER_PENDING' && after?.state === 'settling') after = await advanceListing(id)
      if (after && before && after.state !== before.status.toLowerCase()) moved += 1
    } catch (err) {
      // One sale cannot be allowed to stop the others.
      console.error(`could not advance sale ${id.slice(0, 8)}:`, err)
    }
  }
  return moved
}

/**
 * Report any sale that has been SETTLING too long.
 *
 * Waiting is bounded, so a sale should leave SETTLING by finishing or being let go. One that has not is stuck for a
 * reason a person should look at (the broker unfunded, a ledger that will not answer, a bug), and nobody would
 * otherwise notice: it makes no request fail. Logged once per sale, not on every sweep.
 */
export async function reportStuckSettling(now = new Date()): Promise<string[]> {
  const cutoff = stuckCutoff(now)
  const stuck = await prisma.listing.findMany({
    where: {
      network: NETWORK,
      status: 'SETTLING',
      auctionId: null,
      settleAlertedAt: null,
      OR: [{ settlingSince: { lt: cutoff } }, { settlingSince: null, listedAt: { lt: cutoff } }],
    },
    select: { id: true, settlingSince: true, listedAt: true, settleStrikes: true, failureReason: true },
  })

  const reported: string[] = []
  for (const l of stuck) {
    const mark = await prisma.listing.updateMany({ where: { id: l.id, settleAlertedAt: null }, data: { settleAlertedAt: now } })
    if (mark.count === 0) continue // another instance reported it
    const since = l.settlingSince ?? l.listedAt ?? now
    const minutes = Math.round((now.getTime() - since.getTime()) / 60_000)
    console.error(
      `[sale-stuck] listing ${l.id.slice(0, 8)} has been SETTLING for ${minutes} min ` +
        `(${l.settleStrikes} strike(s)${l.failureReason ? `; ${l.failureReason}` : ''}). It is not finishing by itself.`,
    )
    reported.push(l.id)
  }
  return reported
}
