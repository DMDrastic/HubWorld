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
import { tryGetPayload } from './xaman.js'
import { brokerSale, offerIndexFromTx, spendableDrops, txSucceeded } from './ledger.js'
import { releaseHold } from './primary-sale.js'
import { defaultPrimarySaleLedger } from './primary-sale-ledger.js'

// Used only to release a checkout's hold when its buyer backs out.
const primaryLedger = defaultPrimarySaleLedger()

/** Long enough for a brokered submit to validate; a dead holder lets it lapse. */
const LEASE_TTL_MS = 120_000

export function listingView(l: {
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

export const listingInclude = {
  seller: { select: { username: true } },
  buyer: { select: { username: true } },
  ticket: {
    include: { event: { select: { slug: true, title: true, platformBps: true } } },
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

    await prisma.listing.update({
      where: { id: listing.id },
      data: { status: 'SETTLING', buyTxHash: status.txid, buyOfferIndex },
    })
    return { ...view(), state: 'settling' }
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
          return {
            ...view(),
            state: 'settling',
            reason: "Waiting for the buyer's balance to cover the sale",
          }
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
      return {
        ...view(),
        state: retryable ? 'settling' : 'failed',
        reason: retryable
          ? 'The buyer could not pay. This will settle if they fund the bid.'
          : `Brokered settlement failed: ${result.result}`,
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
 * Drive the box-office sales nobody is watching.
 *
 * A reserved listing whose buyer has signed — or whose two offers are both on the
 * ledger — only needs the next step taken; it does not need the buyer. Anything
 * the buyer is actively polling is left to their poll for the first 45 seconds,
 * so this is a safety net rather than a second poller on every sale (each pending
 * step may ask Xaman, and a crowd would be a lot of asking).
 */
export async function advanceStuckSales(now = new Date(), limit = 20): Promise<number> {
  const stuck = await prisma.listing.findMany({
    where: {
      network: NETWORK,
      reservedForId: { not: null },
      status: { in: ['BUYER_PENDING', 'SETTLING'] },
      // `listedAt` is set when the checkout's offer validates.
      listedAt: { lt: new Date(now.getTime() - 45_000) },
    },
    orderBy: { listedAt: 'asc' },
    take: limit,
    select: { id: true },
  })

  let moved = 0
  for (const { id } of stuck) {
    try {
      const before = await prisma.listing.findUnique({ where: { id }, select: { status: true } })
      const after = await advanceListing(id)
      if (after && before && after.state !== before.status.toLowerCase()) moved += 1
    } catch (err) {
      // One sale cannot be allowed to stop the others.
      console.error(`could not advance sale ${id.slice(0, 8)}:`, err)
    }
  }
  return moved
}
