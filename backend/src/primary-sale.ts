/**
 * The lazy primary sale: a ticket is listed at the moment someone buys it.
 *
 * Listing a whole event up front puts one sell offer per ticket on the ledger,
 * and every open offer locks 0.2 XRP of the organizer's reserve — about 200 XRP
 * for 1,000 tickets. So nothing is listed until a buyer arrives. Then:
 *
 *   1. claim ONE unsold ticket for this buyer (atomically, so two buyers can
 *      never be given the same one);
 *   2. the delegate creates ONE sell offer for it, as the organizer, restricted
 *      to the broker, at the event's price;
 *   3. the buyer signs ONE buy offer, and the broker matches the pair with the
 *      existing brokered settlement.
 *
 * The offer stands only for the length of a checkout, so the reserve needed is
 * (checkouts in flight) x 0.2 XRP rather than (tickets) x 0.2 XRP.
 *
 * Every step that touches money or the ledger can fail without looking like a
 * failure, so each one fails CLOSED: a refused or half-finished checkout releases
 * its claim, and whatever is left on the ledger is inert — an offer naming the
 * broker as its only destination cannot be taken by anyone else, it merely holds
 * a little reserve until it is cancelled.
 */
import { randomUUID } from 'node:crypto'
import { prisma } from './prisma.js'
import { NETWORK } from './network.js'
import { brokerMode, xamanMode } from './env.js'
import { currentDelegate } from './delegate-account.js'
import { buildBuyOfferTx, buildSellOfferTx, platformAddress, platformFeeDrops, XAMAN_NETWORK } from './ledger.js'
import { tryGetPayload, signing } from './signing.js'
import { evaluateSoldOut } from './auction-policy.js'
import { withOrganizerLease } from './organizer-lease.js'
import type { PrimarySaleLedger, DelegatedOffer } from './primary-sale-ledger.js'
import { HOLD_MS, checkSellOffer, checkoutRoom, holdReclaimable } from './primary-sale-policy.js'

/** Statuses in which a checkout's listing still holds a ticket. */
const OPEN = ['PENDING_OFFER', 'ACTIVE', 'BUYER_PENDING', 'SETTLING'] as const

/** Result codes that mean "your sequence was stale", where nothing was submitted. */
const SEQUENCE_RACE = new Set(['tefPAST_SEQ', 'terPRE_SEQ'])
const SEQUENCE_RETRIES = 4
const SEQUENCE_RETRY_MS = 300

/** Attempts to find a ticket the organizer really still holds, before giving up. */
const CLAIM_ATTEMPTS = 3

export type CheckoutOutcome =
  | {
      kind: 'ok'
      listingId: string
      uuid: string
      next: string
      qrPng: string
      mode: 'live' | 'stub'
      paysDrops: string
      expiresAt: string
    }
  | { kind: 'refused'; status: number; error: string; code?: string; listingId?: string }

const refuse = (status: number, error: string, code?: string, listingId?: string): CheckoutOutcome => ({
  kind: 'refused',
  status,
  error,
  ...(code ? { code } : {}),
  ...(listingId ? { listingId } : {}),
})

/**
 * Atomically take one unsold ticket for this buyer.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes two simultaneous buyers get two
 * different tickets instead of both being handed the same one, and flipping the
 * status in the same statement is what makes the claim visible to everyone else.
 * The Listing is written in the same transaction, so a ticket is never claimed
 * without a row that says who it is held for.
 */
export async function claimTicket(input: {
  eventId: string
  organizerId: string
  organizerAddress: string
  brokerAddress: string
  buyerId: string
  priceDrops: bigint
  platformBps: number
  /**
   * Called inside the transaction once the claim is made, before it commits.
   * Exists so a test can hold one claim open and prove a second does not wait
   * behind it — overlap that real traffic produces only by chance.
   */
  whileHeld?: () => Promise<void>
}) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; nfTokenId: string }>>`
      UPDATE "Ticket"
         SET "status" = 'LISTED'::"TicketStatus",
             "faceValueDrops" = ${input.priceDrops},
             "updatedAt" = now()
       WHERE "id" = (
         SELECT "id" FROM "Ticket"
          WHERE "eventId" = ${input.eventId}
            AND "network" = ${NETWORK}::"XrplNetwork"
            AND "status" = 'MINTED'::"TicketStatus"
            AND "ownerId" = ${input.organizerId}
          ORDER BY "createdAt", "id"
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
      RETURNING "id", "nfTokenId"
    `
    const ticket = rows[0]
    if (!ticket) return null

    const listing = await tx.listing.create({
      data: {
        network: NETWORK,
        ticketId: ticket.id,
        sellerId: input.organizerId,
        sellerAddress: input.organizerAddress,
        // Frozen, exactly as a resale freezes it: both offers name this broker.
        brokerAddress: input.brokerAddress,
        priceDrops: input.priceDrops,
        platformFeeDrops: platformFeeDrops(input.priceDrops, input.platformBps),
        // No Xaman payload exists for a delegated offer; the column is unique and
        // required, so it carries a marker that cannot collide with a real uuid.
        listPayloadUuid: `delegate:${randomUUID()}`,
        reservedForId: input.buyerId,
        status: 'PENDING_OFFER',
        expiresAt: new Date(Date.now() + HOLD_MS),
      },
    })
    await input.whileHeld?.()
    return { ticketId: ticket.id, nfTokenId: ticket.nfTokenId, listingId: listing.id }
  })
}

/**
 * Give a held ticket back, and take its offer off the ledger if one was made.
 *
 * Idempotent: only an open hold is released, so the poll, the sweep and a retry
 * can all call it without fighting. The ledger step is best effort and happens
 * AFTER the database commit — a failure there leaves an inert offer (only the
 * broker can match it), never a ticket stuck behind a hold.
 */
export async function releaseHold(
  listingId: string,
  ledger: Pick<PrimarySaleLedger, 'cancelOffers'>,
  reason: string,
): Promise<boolean> {
  const released = await prisma.$transaction(async (tx) => {
    const listing = await tx.listing.findUnique({ where: { id: listingId } })
    if (!listing || !listing.reservedForId) return null
    if (!(OPEN as readonly string[]).includes(listing.status)) return null

    await tx.listing.update({
      where: { id: listing.id },
      data: {
        status: 'CANCELLED',
        closedAt: new Date(),
        failureReason: reason,
        buyerId: null,
        buyerAddress: null,
        buyPayloadUuid: null,
      },
    })
    // Only a ticket that is still LISTED goes back: if it moved on, it is not ours to reset.
    await tx.ticket.updateMany({
      where: { id: listing.ticketId, status: 'LISTED' },
      data: { status: 'MINTED' },
    })
    return listing
  })
  if (!released) return false

  if (released.offerIndex) {
    await ledger.cancelOffers([released.offerIndex]).catch(() => undefined)
  }
  return true
}

/**
 * Start a checkout for `buyerId` on `slug`.
 *
 * Returns the buyer's signing payload, or a refusal in words the buyer can act
 * on. Never reveals the organizer's balance: a buyer cannot do anything with it.
 */
export async function startCheckout(input: {
  slug: string
  buyerId: string
  ledger: PrimarySaleLedger
}): Promise<CheckoutOutcome> {
  const { ledger } = input

  const [event, buyer] = await Promise.all([
    prisma.event.findUnique({ where: { slug: input.slug }, include: { organizer: true } }),
    prisma.user.findUnique({ where: { id: input.buyerId } }),
  ])
  if (!event) return refuse(404, 'Event not found')
  if (!buyer) return refuse(404, 'User no longer exists')

  if (event.primaryPriceDrops === null || event.primaryPriceDrops <= 0n) {
    return refuse(409, 'This event has no box office', 'NO_PRICE')
  }
  if (event.status !== 'PUBLISHED') {
    return refuse(409, `Tickets are not on sale for a ${event.status.toLowerCase().replace('_', ' ')} event`, 'NOT_ON_SALE')
  }
  if (event.organizerId === buyer.id) {
    return refuse(400, 'You cannot buy a ticket to your own event here')
  }

  if (brokerMode !== 'live') return refuse(503, 'Sales are not available on this server')
  const delegate = currentDelegate()
  if (!delegate) return refuse(503, 'Sales are not available on this server')
  const broker = platformAddress()

  // One purchase at a time per buyer per event. A second would hold a second
  // ticket (and a second slice of the organizer's reserve) for someone who can
  // only sign one.
  const existing = await prisma.listing.findFirst({
    where: {
      reservedForId: buyer.id,
      ticket: { eventId: event.id },
      status: { in: [...OPEN] },
      expiresAt: { gt: new Date() },
    },
  })
  if (existing) {
    return refuse(409, 'You already have a purchase in progress for this event', 'IN_PROGRESS', existing.id)
  }

  // The grant is the authority, and the organizer may have withdrawn it in
  // Xaman. Closed to buyers in words that do not expose the mechanism.
  const permission = await ledger.readPermission(event.organizer.xrplAddress, delegate)
  if (permission === 'absent') return refuse(409, "Tickets for this event aren't on sale yet", 'SALES_CLOSED')
  if (permission === 'unknown') return refuse(503, 'Could not confirm this sale just now. Try again shortly.')

  const openHolds = await prisma.listing.count({
    where: { reservedForId: { not: null }, ticket: { eventId: event.id }, status: { in: [...OPEN] }, expiresAt: { gt: new Date() } },
  })
  // An unreadable balance does not block a sale; a real shortfall surfaces as a
  // failed offer, which releases the claim.
  const funding = await ledger.funding(event.organizer.xrplAddress).catch(() => null)
  const room = checkoutRoom({
    openHolds,
    spendableDrops: funding?.spendableDrops ?? BigInt(Number.MAX_SAFE_INTEGER),
    reserveIncDrops: funding?.reserveIncDrops ?? 0n,
  })
  if (!room.ok) {
    return room.reason === 'busy'
      ? refuse(503, 'Lots of people are buying right now. Try again in a moment.', 'BUSY')
      : refuse(503, 'Sales are temporarily unavailable for this event. Try again later.', 'UNAVAILABLE')
  }

  // ---- claim a ticket the organizer really still holds --------------------
  let claim: Awaited<ReturnType<typeof claimTicket>> = null
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    claim = await claimTicket({
      eventId: event.id,
      organizerId: event.organizerId,
      organizerAddress: event.organizer.xrplAddress,
      brokerAddress: broker,
      buyerId: buyer.id,
      priceDrops: event.primaryPriceDrops,
      platformBps: event.platformBps,
    })
    if (!claim) break

    // The ownership column is a cache. The organizer may have moved this ticket
    // in Xaman; offering it would burn a transaction on an offer that cannot
    // exist. An unreadable ledger is NOT a "no": carry on.
    const holds = await ledger.holds(event.organizer.xrplAddress, claim.nfTokenId)
    if (holds !== false) break

    await releaseHold(claim.listingId, ledger, 'Organizer no longer holds this ticket')
    // Take it out of circulation for sales so the next attempt cannot pick it again.
    await prisma.ticket.update({ where: { id: claim.ticketId }, data: { ownerId: null, ownerAddress: null } })
    claim = null
  }
  if (!claim) {
    await evaluateSoldOut(event.id).catch(() => undefined)
    return refuse(409, 'Sold out', 'SOLD_OUT')
  }

  // ---- the delegated sell offer -------------------------------------------
  const tx: DelegatedOffer = {
    ...buildSellOfferTx({
      ownerAddress: event.organizer.xrplAddress,
      nfTokenId: claim.nfTokenId,
      amountDrops: event.primaryPriceDrops,
      brokerAddress: broker,
    }),
    Delegate: delegate,
  }

  // The last line of defence for a permission the ledger cannot narrow: the exact
  // transaction, checked before it is signed.
  const verdict = checkSellOffer(tx, {
    organizerAddress: event.organizer.xrplAddress,
    brokerAddress: broker,
    priceDrops: event.primaryPriceDrops,
    eventTaxon: event.nftTaxon,
    nfTokenId: claim.nfTokenId,
  })
  if (!verdict.ok) {
    await releaseHold(claim.listingId, ledger, `Refused to list: ${verdict.reason}`)
    console.error(`checkout refused to sign an offer: ${verdict.reason}`)
    return refuse(500, 'Could not reserve a ticket. Nothing was charged.')
  }

  // Only the SUBMIT is one-at-a-time: it is where the organizer's sequence is read
  // and spent. The wait for validation is not, so a crowd's offers go out
  // back-to-back and validate together instead of queueing one ledger close each.
  //
  // A sequence collision (`tefPAST_SEQ`, `terPRE_SEQ`) is a race with a stale read,
  // not a verdict on the sale: nothing was submitted, so trying again with a fresh
  // read is safe. The first real mainnet run lost one of two simultaneous buyers
  // to it; a few quick attempts make that a non-event.
  let submitted = await withOrganizerLease(event.organizer.xrplAddress, () => ledger.startSellOffer(tx))
  for (
    let attempt = 1;
    attempt < SEQUENCE_RETRIES && !submitted.busy && !submitted.value.ok && SEQUENCE_RACE.has(submitted.value.code);
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, SEQUENCE_RETRY_MS))
    submitted = await withOrganizerLease(event.organizer.xrplAddress, () => ledger.startSellOffer(tx))
  }
  if (submitted.busy) {
    await releaseHold(claim.listingId, ledger, 'Organizer account was busy')
    return refuse(503, 'Lots of people are buying right now. Try again in a moment.', 'BUSY')
  }
  const created = submitted.value.ok
    ? await ledger.awaitSellOffer(submitted.value)
    : submitted.value
  if (!created.ok) {
    const code = created.code
    await releaseHold(claim.listingId, ledger, `Offer failed: ${code}`)
    if (code === 'terNO_DELEGATE_PERMISSION' || code === 'tecNO_PERMISSION') {
      return refuse(409, "Tickets for this event aren't on sale yet", 'SALES_CLOSED')
    }
    if (code === 'tecINSUFFICIENT_RESERVE' || code === 'tecUNFUNDED') {
      return refuse(503, 'Sales are temporarily unavailable for this event. Try again later.', 'UNAVAILABLE')
    }
    return refuse(502, 'Could not reserve a ticket just now. Nothing was charged. Try again.')
  }
  const offer = created

  // ---- the buyer's side: one signature ------------------------------------
  const owed = event.primaryPriceDrops + platformFeeDrops(event.primaryPriceDrops, event.platformBps)
  let payload
  try {
    const buyTx = buildBuyOfferTx({
      buyerAddress: buyer.xrplAddress,
      ownerAddress: event.organizer.xrplAddress,
      nfTokenId: claim.nfTokenId,
      // The ledger requires buy >= sell + brokerFee.
      amountDrops: owed,
      brokerAddress: broker,
    })
    payload = await signing.createPayload(buyTx as unknown as Record<string, unknown>, {
      flow: 'LISTING_BUY',
      userId: buyer.id,
      expireMinutes: Math.ceil(HOLD_MS / 60_000),
      forceNetwork: XAMAN_NETWORK,
    })
  } catch (err) {
    // The offer exists but the buyer cannot be asked to sign: give everything back.
    await prisma.listing.update({
      where: { id: claim.listingId },
      data: { offerIndex: offer.offerIndex, listTxHash: offer.txHash },
    })
    await releaseHold(claim.listingId, ledger, 'Could not create the signing request')
    console.error('checkout could not create a buyer payload:', err)
    return refuse(503, 'Signing is unavailable right now. Nothing was charged. Try again shortly.')
  }

  const expiresAt = new Date(Date.now() + HOLD_MS)
  await prisma.listing.update({
    where: { id: claim.listingId },
    data: {
      status: 'BUYER_PENDING',
      offerIndex: offer.offerIndex,
      listTxHash: offer.txHash,
      listedAt: new Date(),
      buyerId: buyer.id,
      buyerAddress: buyer.xrplAddress,
      buyPayloadUuid: payload.uuid,
      // Refreshed: the hold now lasts as long as the payload the buyer must sign.
      expiresAt,
    },
  })

  return {
    kind: 'ok',
    listingId: claim.listingId,
    uuid: payload.uuid,
    next: payload.next,
    qrPng: payload.qrPng,
    mode: xamanMode,
    paysDrops: owed.toString(),
    expiresAt: expiresAt.toISOString(),
  }
}

/**
 * Reclaim holds nobody finished.
 *
 * A buyer who closes the tab leaves a ticket claimed and an offer on the ledger.
 * Run on the sweep. A hold is left alone when the buyer has SIGNED: reclaiming a
 * ticket under a live signature would strand their offer, and settlement owns
 * what happens next.
 */
export async function releaseExpiredHolds(
  ledger: Pick<PrimarySaleLedger, 'cancelOffers'>,
  now = new Date(),
  limit = 50,
): Promise<number> {
  const stale = await prisma.listing.findMany({
    where: {
      network: NETWORK,
      reservedForId: { not: null },
      status: { in: ['PENDING_OFFER', 'ACTIVE', 'BUYER_PENDING'] },
      expiresAt: { lt: now },
    },
    orderBy: { expiresAt: 'asc' },
    take: limit,
  })

  let released = 0
  for (const listing of stale) {
    let buyerSigned = false
    if (listing.buyPayloadUuid) {
      const status = await tryGetPayload(listing.buyPayloadUuid)
      // "Unavailable" is not "unsigned": leave it for the next sweep.
      if (status === 'unavailable') continue
      buyerSigned = Boolean(status?.signed)
    }
    if (!holdReclaimable({ expiresAt: listing.expiresAt, now, buyerSigned })) continue
    if (await releaseHold(listing.id, ledger, 'Checkout expired')) released += 1
  }
  return released
}
