/**
 * Claiming a ticket that our records say someone holds.
 *
 * A buyer can hold a ticket in the database before they have a wallet; the NFT stays in the organizer's account until
 * they do. Claiming hands it over for nothing: the organizer's delegate creates ONE sell offer AS the organizer, at
 * amount 0, restricted to the holder's own wallet and expiring in minutes, and the holder accepts it.
 *
 * The rules that make that safe live in `claim-policy.ts` (the exact transaction, who is eligible, what a retry does);
 * this file is the orchestration around them, kept apart from `primary-sale.ts` on purpose. The paid sale's check
 * refuses a zero-price offer and still does.
 *
 * ONE ROW PER TICKET (`TicketClaim.ticketId` is unique). That is what makes a retry safe: it reuses or replaces its
 * row, so two offers can never both be live for one ticket.
 */
import { Prisma } from '@prisma/client'
import { rippleTimeToUnixTime, unixTimeToRippleTime } from 'xrpl'
import { prisma } from './prisma.js'
import { NETWORK } from './network.js'
import { currentDelegate } from './delegate-account.js'
import { withOrganizerLease } from './organizer-lease.js'
import type { DelegatedOffer, PrimarySaleLedger } from './primary-sale-ledger.js'
import {
  CLAIM_GRACE_MS,
  CLAIM_TTL_SECONDS,
  checkClaimOffer,
  claimEligibility,
  claimPlan,
  type EligibilityRefusal,
} from './claim-policy.js'

const TF_SELL_NFTOKEN = 1
const SEQUENCE_RACE = new Set(['tefPAST_SEQ', 'terPRE_SEQ'])
const SEQUENCE_RETRIES = 4
const SEQUENCE_RETRY_MS = 300
const OPEN_LISTING = ['PENDING_OFFER', 'ACTIVE', 'BUYER_PENDING', 'SETTLING'] as const

export type ClaimOutcome =
  | { kind: 'ok'; claimId: string; offerIndex: string; expiresAt: string; reused: boolean }
  | { kind: 'refused'; status: number; error: string; code?: string }

const refuse = (status: number, error: string, code?: string): ClaimOutcome => ({ kind: 'refused', status, error, code })

const ELIGIBILITY: Record<EligibilityRefusal, { status: number; error: string; code: string }> = {
  'no-holder': { status: 409, error: 'Nobody holds this ticket', code: 'NO_HOLDER' },
  'not-the-holder': { status: 403, error: 'This ticket is not yours to claim', code: 'NOT_THE_HOLDER' },
  'no-wallet': { status: 409, error: 'Set up your wallet before claiming this ticket', code: 'NO_WALLET' },
  listed: { status: 409, error: 'This ticket has an open listing. Withdraw it first.', code: 'LISTED' },
  'already-claimed': { status: 409, error: 'This ticket is already in your wallet', code: 'ALREADY_CLAIMED' },
  'not-claimable': { status: 409, error: 'This ticket cannot be moved now', code: 'NOT_CLAIMABLE' },
}

/**
 * Hand a held ticket to its holder's wallet: make (or reuse) the one free claim offer.
 *
 * Returns the offer for the holder to accept, or a refusal in words they can act on.
 */
export async function startClaim(input: {
  nfTokenId: string
  holderId: string
  ledger: PrimarySaleLedger
  now?: Date
}): Promise<ClaimOutcome> {
  const { ledger } = input
  const now = input.now ?? new Date()

  const ticket = await prisma.ticket.findUnique({
    where: { network_nfTokenId: { network: NETWORK, nfTokenId: input.nfTokenId } },
    include: { event: { include: { organizer: true } }, claim: true },
  })
  if (!ticket) return refuse(404, 'Ticket not found')

  // The verified wallet is the Wallet row: a sign-in proved control of it. The legacy address column is not enough.
  const wallet = await prisma.wallet.findUnique({ where: { userId: input.holderId } })
  const openListing = await prisma.listing.findFirst({
    where: { ticketId: ticket.id, network: NETWORK, status: { in: [...OPEN_LISTING] } },
    select: { id: true },
  })
  const organizerAddress = ticket.event.organizer.xrplAddress

  const eligible = claimEligibility({
    ticket: { ownerId: ticket.ownerId, ownerAddress: ticket.ownerAddress, status: ticket.status },
    holder: { id: input.holderId, walletAddress: wallet?.xrplAddress ?? null },
    organizerAddress,
    hasOpenListing: openListing !== null,
    claimStatus: ticket.claim?.status ?? null,
  })
  if (!eligible.ok) {
    const r = ELIGIBILITY[eligible.reason]
    return refuse(r.status, r.error, r.code)
  }
  const holderAddress = wallet!.xrplAddress

  const delegate = currentDelegate()
  if (!delegate) return refuse(503, 'Claiming is not available on this server')

  const plan = claimPlan(ticket.claim, now)
  if (plan.action === 'none') return refuse(409, 'This ticket is already in your wallet', 'ALREADY_CLAIMED')
  if (plan.action === 'in-progress') return refuse(409, 'Your claim is being prepared. Try again in a moment.', 'IN_PROGRESS')
  if (plan.action === 'reuse') {
    const c = ticket.claim!
    return { kind: 'ok', claimId: c.id, offerIndex: c.offerIndex!, expiresAt: c.expiresAt.toISOString(), reused: true }
  }

  // The grant is the authority, and the organizer may have withdrawn it.
  const permission = await ledger.readPermission(organizerAddress, delegate)
  if (permission === 'absent') return refuse(409, 'The organizer has not allowed tickets to be handed over yet', 'NOT_GRANTED')
  if (permission === 'unknown') return refuse(503, 'Could not confirm this just now. Try again shortly.')

  // The ownership column is a cache. An unreadable ledger is not a "no".
  if ((await ledger.holds(organizerAddress, ticket.nfTokenId)) === false) {
    return refuse(409, 'This ticket is no longer where we expected it', 'NOT_HELD')
  }

  // A lapsed offer is cancelled BEFORE its replacement exists, so two are never live. If it cannot be cancelled now,
  // stop: the next attempt (or the sweep) will try again.
  if (plan.action === 'replace' && plan.cancelOfferIndex) {
    try {
      await ledger.cancelOffers([plan.cancelOfferIndex])
    } catch {
      return refuse(503, 'Could not clear your earlier offer just now. Try again shortly.')
    }
  }

  // The ledger counts expiry in whole seconds, so the row records exactly the second the OFFER stops working rather
  // than a millisecond figure that could differ from it by up to a second.
  const expiration = unixTimeToRippleTime(now.getTime() + CLAIM_TTL_SECONDS * 1000)
  const expiresAt = new Date(rippleTimeToUnixTime(expiration))

  // Take the row. Atomic, so two requests racing for one ticket cannot both go on to make an offer.
  let claimId: string
  if (!ticket.claim) {
    try {
      const row = await prisma.ticketClaim.create({
        data: { network: NETWORK, ticketId: ticket.id, holderId: input.holderId, holderAddress, status: 'PENDING', expiresAt },
      })
      claimId = row.id
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return refuse(409, 'Your claim is being prepared. Try again in a moment.', 'IN_PROGRESS')
      }
      throw err
    }
  } else {
    const old = ticket.claim
    const taken = await prisma.ticketClaim.updateMany({
      // Only the row exactly as we read it: if another request changed it first, this one stands down.
      where: { id: old.id, status: old.status, offerIndex: old.offerIndex, updatedAt: old.updatedAt },
      data: {
        status: 'PENDING',
        holderId: input.holderId,
        holderAddress,
        offerIndex: null,
        offerTxHash: null,
        failureReason: null,
        expiresAt,
        createdAt: now,
      },
    })
    if (taken.count === 0) return refuse(409, 'Your claim is being prepared. Try again in a moment.', 'IN_PROGRESS')
    claimId = old.id
  }

  const fail = async (reason: string) => {
    await prisma.ticketClaim.update({ where: { id: claimId }, data: { status: 'FAILED', failureReason: reason } })
  }

  const tx: DelegatedOffer = {
    TransactionType: 'NFTokenCreateOffer',
    Account: organizerAddress,
    NFTokenID: ticket.nfTokenId,
    Amount: '0',
    Destination: holderAddress,
    Flags: TF_SELL_NFTOKEN,
    Expiration: expiration,
    Delegate: delegate,
  }

  // The last line of defence for a permission the ledger cannot narrow: the exact transaction, before it is signed.
  const verdict = checkClaimOffer(tx, {
    organizerAddress,
    holderAddress,
    eventTaxon: ticket.event.nftTaxon,
    nfTokenId: ticket.nfTokenId,
    nowMs: now.getTime(),
  })
  if (!verdict.ok) {
    await fail(`Refused to sign: ${verdict.reason}`)
    console.error(`claim refused to sign an offer: ${verdict.reason}`)
    return refuse(500, 'Could not hand over this ticket just now.')
  }

  let submitted = await withOrganizerLease(organizerAddress, () => ledger.startSellOffer(tx))
  for (
    let attempt = 1;
    attempt < SEQUENCE_RETRIES && !submitted.busy && !submitted.value.ok && SEQUENCE_RACE.has(submitted.value.code);
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, SEQUENCE_RETRY_MS))
    submitted = await withOrganizerLease(organizerAddress, () => ledger.startSellOffer(tx))
  }
  if (submitted.busy) {
    await fail('Organizer account was busy')
    return refuse(503, 'Busy right now. Try again in a moment.', 'BUSY')
  }
  const created = submitted.value.ok ? await ledger.awaitSellOffer(submitted.value) : submitted.value
  if (!created.ok) {
    await fail(`Offer failed: ${created.code}`)
    if (created.code === 'terNO_DELEGATE_PERMISSION' || created.code === 'tecNO_PERMISSION') {
      return refuse(409, 'The organizer has not allowed tickets to be handed over yet', 'NOT_GRANTED')
    }
    return refuse(502, 'Could not hand over this ticket just now. Try again.')
  }

  await prisma.ticketClaim.update({
    where: { id: claimId },
    data: { offerIndex: created.offerIndex, offerTxHash: created.txHash },
  })
  return { kind: 'ok', claimId, offerIndex: created.offerIndex, expiresAt: expiresAt.toISOString(), reused: false }
}

/**
 * Record that the holder now has the ticket: the claim is done, and our cache of who holds the NFT catches up.
 *
 * `acceptTxHash` is known when the holder signed through us; the sweep finds out later from the ledger alone and has
 * no hash, in which case ownership is still corrected but no provenance row is invented.
 */
export async function completeClaim(claimId: string, acceptTxHash: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claim = await tx.ticketClaim.findUnique({ where: { id: claimId } })
    if (!claim || claim.status === 'ACCEPTED') return
    await tx.ticketClaim.update({ where: { id: claimId }, data: { status: 'ACCEPTED', acceptTxHash } })
    await tx.ticket.update({
      where: { id: claim.ticketId },
      data: { ownerId: claim.holderId, ownerAddress: claim.holderAddress, syncedAt: new Date() },
    })
    if (acceptTxHash) {
      const exists = await tx.transfer.findUnique({ where: { network_txHash: { network: NETWORK, txHash: acceptTxHash } } })
      if (!exists) {
        const ticket = await tx.ticket.findUniqueOrThrow({ where: { id: claim.ticketId }, include: { event: { include: { organizer: true } } } })
        await tx.transfer.create({
          data: {
            ticketId: claim.ticketId,
            network: NETWORK,
            fromAddress: ticket.event.organizer.xrplAddress,
            toAddress: claim.holderAddress,
            txHash: acceptTxHash,
            kind: 'CLAIM',
            occurredAt: new Date(),
          },
        })
      }
    }
  })
}

/**
 * Sweep claims nobody finished.
 *
 * An offer past its expiry can no longer be accepted, but it still sits in the organizer's account holding 0.2 XRP of
 * reserve until something removes it. Run on the sweep. Before cancelling, the ledger is asked whether the holder
 * accepted at the last moment: cancelling a claim that completed would be wrong, and merely recording it is right.
 * A cancel that fails leaves the claim pending, so the next sweep tries again.
 */
export async function expireClaims(
  ledger: Pick<PrimarySaleLedger, 'cancelOffers' | 'holds'>,
  now = new Date(),
  limit = 50,
): Promise<number> {
  const stale = await prisma.ticketClaim.findMany({
    where: { network: NETWORK, status: 'PENDING', expiresAt: { lt: new Date(now.getTime() - CLAIM_GRACE_MS) } },
    orderBy: { expiresAt: 'asc' },
    take: limit,
    include: { ticket: true },
  })

  let expired = 0
  for (const claim of stale) {
    if ((await ledger.holds(claim.holderAddress, claim.ticket.nfTokenId)) === true) {
      await completeClaim(claim.id, null)
      continue
    }
    if (claim.offerIndex) {
      try {
        await ledger.cancelOffers([claim.offerIndex])
      } catch {
        continue
      }
    }
    const done = await prisma.ticketClaim.updateMany({ where: { id: claim.id, status: 'PENDING' }, data: { status: 'EXPIRED' } })
    expired += done.count
  }
  return expired
}
