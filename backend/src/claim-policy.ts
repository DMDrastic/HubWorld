/**
 * The rules of the FREE claim offer, as pure functions.
 *
 * A ticket can be held for someone in our database while the NFT still sits in the organizer's account (a buyer who
 * has not set up a wallet yet). Claiming hands it over: the delegate creates ONE sell offer AS the organizer, for
 * nothing, restricted to the holder's own wallet, and the holder accepts it.
 *
 * That is a deliberately different path from the paid primary sale. `checkSellOffer` refuses any offer below the
 * price, because a zero-price offer is how a ticket is given away, and it stays that way. This file is the only
 * place a zero-price offer is allowed, and it is allowed in exactly one shape. The delegate permission cannot be
 * narrowed on the ledger, so each clause below closes a specific way it could be made to hand a ticket to the wrong
 * account.
 */
import { parseNFTokenID, unixTimeToRippleTime } from 'xrpl'

/**
 * How long a claim offer stands. Short on purpose: an offer holds 0.2 XRP of the organizer's reserve for as long as
 * it exists, and a holder either accepts within minutes or does it later from a fresh one.
 */
export const CLAIM_TTL_SECONDS = 10 * 60

/** Past expiry before a stale claim is swept, so an acceptance landing at the edge is not cancelled under it. */
export const CLAIM_GRACE_MS = 60 * 1000

export type ClaimOfferTx = {
  TransactionType?: string
  Account?: string
  NFTokenID?: string
  Amount?: unknown
  Destination?: string
  Flags?: unknown
  /** Seconds since the Ripple epoch. */
  Expiration?: unknown
}

export type ClaimOfferExpectation = {
  /** The organizer: the account the offer is created AS. */
  organizerAddress: string
  /** The holder's verified wallet. Null when they have none, which refuses everything. */
  holderAddress: string | null
  eventTaxon: number
  nfTokenId: string
  /** The clock the expiration is judged against, in unix milliseconds. */
  nowMs: number
}

export type Verdict = { ok: true } | { ok: false; reason: string }

const TF_SELL_NFTOKEN = 1

/**
 * Is this exactly the free claim the holder is owed, and nothing else?
 *
 *   - **amount exactly "0".** A priced offer belongs to checkout; this path never sells.
 *   - **destination = the holder's verified wallet.** Without it the offer is open and anyone could take the ticket.
 *     A wrong destination is a stolen ticket. No verified wallet means there is nothing to compare, so it refuses.
 *   - **an expiration, in the future, within `CLAIM_TTL_SECONDS`.** Without one the offer would stand forever.
 *   - **a sell offer, as the organizer, for the claimed ticket**, which the organizer issued for this event.
 */
export function checkClaimOffer(tx: ClaimOfferTx, expected: ClaimOfferExpectation): Verdict {
  if (tx.TransactionType !== 'NFTokenCreateOffer') return { ok: false, reason: 'not an offer' }
  if (tx.Account !== expected.organizerAddress) return { ok: false, reason: 'offer is not created as the organizer' }

  if (!expected.holderAddress) return { ok: false, reason: 'the holder has no verified wallet' }
  if (expected.holderAddress === expected.organizerAddress) {
    return { ok: false, reason: 'cannot claim to the organizer\'s own account' }
  }
  if (tx.Destination !== expected.holderAddress) {
    return { ok: false, reason: 'offer destination is not the holder\'s wallet' }
  }

  const flags = typeof tx.Flags === 'number' ? tx.Flags : 0
  if ((flags & TF_SELL_NFTOKEN) !== TF_SELL_NFTOKEN) return { ok: false, reason: 'offer is not a sell offer' }

  if (tx.Amount !== '0') return { ok: false, reason: 'a claim is free: the amount must be exactly 0 drops' }

  const now = unixTimeToRippleTime(expected.nowMs)
  if (typeof tx.Expiration !== 'number' || !Number.isInteger(tx.Expiration)) {
    return { ok: false, reason: 'claim offer has no valid expiration' }
  }
  if (tx.Expiration <= now) return { ok: false, reason: 'claim offer expiration is not in the future' }
  if (tx.Expiration > now + CLAIM_TTL_SECONDS) return { ok: false, reason: 'claim offer expiration is too far away' }

  if (tx.NFTokenID !== expected.nfTokenId) return { ok: false, reason: 'offer is not for the claimed ticket' }
  let parsed: { Issuer: string; Taxon: number }
  try {
    parsed = parseNFTokenID(expected.nfTokenId)
  } catch {
    return { ok: false, reason: 'ticket id is not a valid NFTokenID' }
  }
  if (parsed.Issuer !== expected.organizerAddress) return { ok: false, reason: 'ticket was not issued by the organizer' }
  if (parsed.Taxon !== expected.eventTaxon) return { ok: false, reason: 'ticket does not belong to this event' }
  return { ok: true }
}

export type ClaimStatusName = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'CANCELLED' | 'FAILED'

export type EligibilityRefusal = 'no-holder' | 'not-the-holder' | 'no-wallet' | 'listed' | 'already-claimed' | 'not-claimable'
export type Eligibility = { ok: true } | { ok: false; reason: EligibilityRefusal }

/**
 * May this person be handed this ticket right now?
 *
 * Judged from our records, then the ledger is asked as well before anything is signed. A ticket with an open
 * listing is somebody's pending sale; one already in the holder's wallet, or with an accepted claim, has been
 * claimed. A claim that ended unsuccessfully does not stop a new one.
 */
export function claimEligibility(input: {
  ticket: { ownerId: string | null; ownerAddress: string | null; status: string }
  holder: { id: string; walletAddress: string | null }
  organizerAddress: string
  hasOpenListing: boolean
  claimStatus: ClaimStatusName | null
}): Eligibility {
  const { ticket, holder } = input
  if (ticket.ownerId === null) return { ok: false, reason: 'no-holder' }
  if (ticket.ownerId !== holder.id) return { ok: false, reason: 'not-the-holder' }
  if (!holder.walletAddress) return { ok: false, reason: 'no-wallet' }
  if (input.claimStatus === 'ACCEPTED' || ticket.ownerAddress === holder.walletAddress) {
    return { ok: false, reason: 'already-claimed' }
  }
  if (input.hasOpenListing) return { ok: false, reason: 'listed' }
  if (ticket.status !== 'MINTED') return { ok: false, reason: 'not-claimable' }
  return { ok: true }
}

export type ClaimPlan =
  | { action: 'create' }
  | { action: 'reuse' }
  | { action: 'replace'; cancelOfferIndex: string | null }
  /** Another request is submitting this claim's offer right now. */
  | { action: 'in-progress' }
  | { action: 'none' }

/**
 * What a (re)tried claim should do about the claim row that already exists, so a retry never leaves two offers.
 *
 * One live offer is reused as it stands; one that has expired (or that never got as far as the ledger) is replaced,
 * with the old offer cancelled first when there is one; a finished or failed claim starts over. A row so new it has no
 * offer yet is another request mid-flight, and is left alone.
 */
export function claimPlan(
  existing: { status: ClaimStatusName; offerIndex: string | null; expiresAt: Date; createdAt: Date } | null,
  now: Date,
): ClaimPlan {
  if (!existing) return { action: 'create' }
  if (existing.status === 'ACCEPTED') return { action: 'none' }
  if (existing.status !== 'PENDING') return { action: 'create' }
  if (existing.offerIndex !== null && existing.expiresAt.getTime() > now.getTime()) return { action: 'reuse' }
  // A row with no offer yet is most likely a request that is still submitting it; only an old one is a crash.
  if (existing.offerIndex === null && now.getTime() - existing.createdAt.getTime() <= CLAIM_GRACE_MS) {
    return { action: 'in-progress' }
  }
  return { action: 'replace', cancelOfferIndex: existing.offerIndex }
}
