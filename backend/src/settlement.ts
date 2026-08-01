/**
 * Auction settlement.
 *
 * Closing an auction is brokered exactly like a fixed-price sale: the ledger
 * matches the holder's sell offer against the winner's buy offer and pays
 * everyone in one atomic transaction. Everything here rests on behaviour that was
 * measured on testnet rather than assumed:
 *
 *  - The seller receives `buyAmount - brokerFee`, **not** their asking amount, so
 *    a sell offer is a FLOOR and the surplus reaches the seller. That is why the
 *    holder signs once when the auction opens and never again.
 *  - `buy >= sell + brokerFee` is enforced by the ledger, so the sell offer is
 *    placed below the reserve by the fee-at-reserve (`auctionSellAmountDrops`).
 *  - `tecINSUFFICIENT_FUNDS` is **retryable, not terminal**. A buy offer does not
 *    lock funds, and a bidder who is briefly broke may be paid a minute later —
 *    observed for real on a fixed-price sale. So a winner who cannot pay is
 *    demoted and the next-highest bid is tried, rather than the auction failing.
 */
import { prisma } from './prisma.js'
import { brokerCancelOffers, brokerSale, platformFeeDrops, spendableDrops } from './ledger.js'
import { publishAuctionEvent } from './realtime.js'
import { withLock } from './job-lock.js'

/** Bid statuses backed by a live buy offer on-ledger. */
export const COMMITTED_BID_STATUSES = ['COMMITTED', 'OUTBID'] as const

/**
 * One lease per auction, rather than one lease over the whole sweep.
 *
 * The old design took a single `auction-sweep` lease around everything. Two
 * problems followed. A settlement that stalled on a ledger call held that lease
 * for its full TTL, so no process could settle ANY auction until it lapsed —
 * head-of-line blocking across the entire system. And a second instance could
 * never help, because the lock was all-or-nothing rather than per-item.
 *
 * Naming the lease after the auction fixes both: a stuck auction blocks only
 * itself, and instances divide the queue instead of one taking all of it.
 */
export function auctionLockName(auctionId: string): string {
  return `auction:${auctionId}`
}

/** Comfortably longer than settling one auction, which may walk several bids. */
export const AUCTION_LOCK_TTL_MS = 2 * 60_000

/**
 * The broker account is the real serialisation point, and it is NOT the auction.
 *
 * `brokerSale` calls `autofill`, which reads the platform account's current
 * `Sequence` from the ledger. Two settlements submitting at the same time — same
 * process or different instances — would autofill the SAME sequence, and the
 * loser fails. Per-auction leases alone would therefore have made concurrency
 * unsafe rather than faster.
 *
 * So submission takes a second, global lease held only around the submit itself.
 * Everything before it (reading spendable balances, choosing a candidate) still
 * runs concurrently across auctions; only the one operation that must be serial
 * is serialised. Solving this properly means managing the broker's sequence
 * explicitly, or using more than one broker account.
 */
export const BROKER_LOCK = 'broker-submit'
/** Must exceed a submit-and-validate round trip, which is seconds not minutes. */
const BROKER_LOCK_TTL_MS = 60_000

export type SettlementOutcome =
  | { kind: 'not-due'; endsAt: Date }
  | { kind: 'no-bids' }
  | { kind: 'reserve-not-met'; topDrops: bigint; reserveDrops: bigint }
  | { kind: 'no-sell-offer' }
  | { kind: 'settled'; winnerId: string; amountDrops: bigint; feeDrops: bigint; txHash: string }
  | { kind: 'failed'; reason: string }
  /** Another process holds the broker. Nothing was changed; the next sweep retries. */
  | { kind: 'broker-busy' }
  /** Already SETTLED or CANCELLED. Re-running would undo a finished auction. */
  | { kind: 'already-resolved'; status: string }

/**
 * Settle one auction.
 *
 * Walks candidate bids from highest down, skipping any whose bidder can no longer
 * pay. Only the bid that actually settles wins; the rest are marked LOST. Nothing
 * is refunded because nothing was ever locked.
 */
export async function settleAuction(auctionId: string): Promise<SettlementOutcome> {
  const auction = await prisma.auction.findUnique({
    where: { id: auctionId },
    include: {
      ticket: true,
      bids: {
        where: { status: { in: [...COMMITTED_BID_STATUSES] } },
        orderBy: { amountDrops: 'desc' },
        include: { bidder: { select: { id: true, username: true } } },
      },
    },
  })
  if (!auction) return { kind: 'failed', reason: 'Auction not found' }

  // Re-read the status rather than trusting the id we were handed.
  //
  // This matters far more with per-auction leases than it did with one global
  // one. Two sweeps can now each hold a due-auction list built a moment apart:
  // the first settles and releases, and the second arrives with an id that is
  // already finished. Without this guard it would find no COMMITTED bids left,
  // take the no-bids path, and CANCEL an auction that had just sold — moving the
  // ticket back and marking the winner's bid LOST.
  if (auction.status !== 'LIVE' && auction.status !== 'SETTLING') {
    return { kind: 'already-resolved', status: auction.status }
  }

  if (auction.endsAt > new Date()) return { kind: 'not-due', endsAt: auction.endsAt }

  const reserve = auction.reserveDrops ?? 0n

  const close = async (status: 'SETTLED' | 'CANCELLED', ticketStatus: 'MINTED' = 'MINTED') => {
    await prisma.$transaction([
      prisma.auction.update({ where: { id: auction.id }, data: { status } }),
      prisma.bid.updateMany({
        where: { auctionId: auction.id, status: { in: [...COMMITTED_BID_STATUSES] } },
        data: { status: 'LOST' },
      }),
      prisma.ticket.update({ where: { id: auction.ticketId }, data: { status: ticketStatus } }),
    ])
  }

  if (auction.bids.length === 0) {
    await close('CANCELLED')
    publishAuctionEvent({ type: 'closed', auctionId: auction.id, reason: 'no-bids' })
    return { kind: 'no-bids' }
  }

  const top = auction.bids[0]!
  if (top.amountDrops < reserve) {
    // The reserve exists precisely so the holder is not forced to sell cheap.
    await close('CANCELLED')
    publishAuctionEvent({ type: 'closed', auctionId: auction.id, reason: 'reserve-not-met' })
    return { kind: 'reserve-not-met', topDrops: top.amountDrops, reserveDrops: reserve }
  }

  // The holder's sell offer. Without it there is nothing to broker against, and
  // that is a setup failure rather than an auction outcome.
  const listing = await prisma.listing.findFirst({
    where: { ticketId: auction.ticketId, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
  })
  if (!listing?.offerIndex) {
    await prisma.auction.update({ where: { id: auction.id }, data: { status: 'SETTLING' } })
    return { kind: 'no-sell-offer' }
  }

  await prisma.auction.update({ where: { id: auction.id }, data: { status: 'SETTLING' } })

  const platformBps = await prisma.event
    .findFirstOrThrow({ where: { tickets: { some: { id: auction.ticketId } } } })
    .then((e) => e.platformBps)

  for (const bid of auction.bids) {
    if (bid.amountDrops < reserve || !bid.buyOfferIndex) continue

    // The fee is a share of what actually won, not of the reserve.
    const fee = platformFeeDrops(bid.amountDrops, platformBps)

    // Read before submitting: funds are not locked, so the winner may have spent
    // them. Cheaper to check than to burn a transaction fee finding out.
    if (bid.bidderAddress) {
      try {
        const spendable = await spendableDrops(bid.bidderAddress)
        if (spendable < bid.amountDrops) {
          await prisma.bid.update({
            where: { id: bid.id },
            data: {
              status: 'LOST',
              failureReason: `Could not pay at settlement: ${spendable.toString()} of ${bid.amountDrops.toString()} drops`,
            },
          })
          continue
        }
      } catch {
        // Ledger unreachable — let the submission be the judge.
      }
    }

    // Captured before the closure: both were narrowed to non-null above, but
    // that narrowing does not survive into a callback, since TypeScript cannot
    // know the values still hold by the time it runs.
    const sellOfferIndex = listing.offerIndex
    const buyOfferIndex = bid.buyOfferIndex

    // Serialised on the broker account, not on this auction — see BROKER_LOCK.
    const result = await withLock(BROKER_LOCK, BROKER_LOCK_TTL_MS, () =>
      brokerSale({ sellOfferIndex, buyOfferIndex, brokerFeeDrops: fee }),
    )

    // Someone else is mid-submission. Crucially this returns BEFORE touching any
    // bid: nothing was attempted, so marking this bidder LOST would be a lie and
    // would discard a perfectly good bid. The auction keeps its state and the
    // next sweep tries again.
    if (result === null) return { kind: 'broker-busy' }

    if (!result.succeeded) {
      // This bidder cannot pay after all. Demote and fall through to the next —
      // an auction with a flaky top bidder should still sell to the runner-up.
      await prisma.bid.update({
        where: { id: bid.id },
        data: {
          status: 'LOST',
          buyTxHash: result.hash,
          failureReason: `Settlement failed: ${result.result}`,
        },
      })
      continue
    }

    // Won. Ownership, provenance, the losing bids and both records move together,
    // keyed on the unique txHash so a repeat call cannot double-record it.
    await prisma.$transaction(async (tx) => {
      await tx.bid.update({
        where: { id: bid.id },
        data: { status: 'WON', buyTxHash: result.hash },
      })
      await tx.bid.updateMany({
        where: {
          auctionId: auction.id,
          id: { not: bid.id },
          status: { in: [...COMMITTED_BID_STATUSES] },
        },
        data: { status: 'LOST' },
      })
      await tx.ticket.update({
        where: { id: auction.ticketId },
        data: {
          ownerId: bid.bidder.id,
          ownerAddress: bid.bidderAddress,
          syncedAt: new Date(),
          status: 'MINTED',
        },
      })
      const already = await tx.transfer.findUnique({ where: { txHash: result.hash } })
      if (!already) {
        await tx.transfer.create({
          data: {
            ticketId: auction.ticketId,
            fromAddress: listing.sellerAddress,
            toAddress: bid.bidderAddress!,
            txHash: result.hash,
            kind: 'AUCTION_SETTLE',
            occurredAt: new Date(),
          },
        })
      }
      await tx.listing.update({
        where: { id: listing.id },
        data: { status: 'SOLD', brokerTxHash: result.hash, closedAt: new Date() },
      })
      await tx.auction.update({ where: { id: auction.id }, data: { status: 'SETTLED' } })
    })

    // Tidy up the losers' offers. Each holds 0.2 XRP of its bidder's reserve and
    // is inert after settlement, and the broker can cancel them because it is
    // their Destination — verified on testnet. Best-effort: a failure here must
    // not undo a completed sale.
    try {
      const losing = auction.bids
        .filter((b) => b.id !== bid.id && b.buyOfferIndex)
        .map((b) => b.buyOfferIndex!)
      await brokerCancelOffers(losing)
    } catch {
      // Reserves stay held until someone cancels; nothing is unsafe.
    }

    publishAuctionEvent({
      type: 'settled',
      auctionId: auction.id,
      amountDrops: bid.amountDrops.toString(),
      winner: `@${bid.bidder.username}`,
      txHash: result.hash,
    })

    return {
      kind: 'settled',
      winnerId: bid.bidder.id,
      amountDrops: bid.amountDrops,
      feeDrops: fee,
      txHash: result.hash,
    }
  }

  // Every candidate failed to pay. The offers stand, so this is not terminal:
  // leave it SETTLING and let a later sweep try again.
  return { kind: 'failed', reason: 'No bidder could pay; will retry while the offers stand' }
}

/** Settle every auction whose close time has passed. */
export async function settleDueAuctions(): Promise<
  Array<{ auctionId: string; outcome: SettlementOutcome }>
> {
  const due = await prisma.auction.findMany({
    where: { status: { in: ['LIVE', 'SETTLING'] }, endsAt: { lte: new Date() } },
    select: { id: true },
    orderBy: { endsAt: 'asc' },
    take: 25,
  })

  const results = []
  for (const a of due) {
    // The lease lives here rather than inside settleAuction, so it is taken
    // exactly once: both callers — the sweep and `npm run auction:settle` —
    // arrive through this function. That also closes a real hole, because the
    // script previously took NO lock at all, so running it while the server was
    // sweeping could have had two processes settling the same auction.
    const outcome = await withLock(auctionLockName(a.id), AUCTION_LOCK_TTL_MS, () =>
      settleAuction(a.id),
    )
    // null means another process already has this one. A skipped auction is not
    // a result — reporting it would make routine contention look like an event.
    if (outcome !== null) results.push({ auctionId: a.id, outcome })
  }
  return results
}
