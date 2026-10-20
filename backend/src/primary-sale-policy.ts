/**
 * The rules of the lazy primary sale, as pure functions.
 *
 * At checkout Hubworld's delegate account creates ONE sell offer for ONE ticket,
 * as the organizer. The permission that allows it, `NFTokenCreateOffer`, is far
 * more dangerous than minting: it lets the delegate list ANY ticket in the
 * organizer's account at ANY price to ANY destination, and a zero-price offer to
 * itself returns `tesSUCCESS`. The ledger cannot narrow it. So the narrowing
 * lives here, checked on the exact transaction before it is signed — which is
 * the only place left to enforce "this is the offer the checkout asked for and
 * nothing else". These functions are pure so they can be pinned exactly and
 * mutation-tested; a guard buried in route code is a guard nobody can prove.
 */
import { parseNFTokenID } from 'xrpl'

/**
 * How long a buyer's hold lasts.
 *
 * Long enough to find a phone and sign, short enough that an abandoned checkout
 * does not keep a ticket (and 0.2 XRP of the organizer's reserve) out of
 * circulation. The same order as a Xaman payload's life.
 */
export const HOLD_MS = 5 * 60 * 1000

/** Past expiry before a hold is reclaimed, so a signature landing at the edge is not stolen. */
export const HOLD_GRACE_MS = 60 * 1000

/**
 * Most simultaneous checkouts per event.
 *
 * Every open sell offer is an owned object, so it locks 0.2 XRP of the
 * organizer's reserve for as long as it stands. This bounds that exposure: 100
 * concurrent holds is 20 XRP at most, against ~200 XRP to list 1,000 tickets up
 * front, which is the whole point of listing lazily.
 */
export const MAX_CONCURRENT_HOLDS = 100

/** XRP kept spendable beyond the next offer's reserve, so fees cannot be what runs it dry. */
export const FEE_HEADROOM_DROPS = 100_000n

export type OfferTx = {
  TransactionType?: string
  Account?: string
  NFTokenID?: string
  Amount?: unknown
  Destination?: string
  /** Anything but a plain number is treated as no flags at all, which is refused. */
  Flags?: unknown
  Owner?: string
}

export type OfferExpectation = {
  /** The organizer: the account the offer is created AS. */
  organizerAddress: string
  /** The broker: the ONLY account allowed to match it. */
  brokerAddress: string
  /** What the checkout asked for, in drops. */
  priceDrops: bigint
  /** The event's taxon: the ticket must belong to it. */
  eventTaxon: number
  /** The ticket the checkout claimed. */
  nfTokenId: string
}

const TF_SELL_NFTOKEN = 1

export type Verdict = { ok: true } | { ok: false; reason: string }

/**
 * Is this exactly the offer the checkout asked for?
 *
 * Every clause closes a specific way a delegate holding this permission could be
 * made to do something the organizer never agreed to:
 *
 *   - **destination = the broker.** Without it the offer is open: anyone could
 *     take the ticket directly, bypassing the platform fee — or, with the
 *     delegate itself as destination, the ticket could be given away.
 *   - **a sell offer, as the organizer.** A buy offer, or an offer created as
 *     some other account, is not a listing.
 *   - **amount >= the price.** A zero or discounted offer is a gift.
 *   - **the claimed ticket, issued by the organizer, from this event.** The
 *     delegate can reach every NFT in the account, including ones from other
 *     events or ones the organizer received from someone else; only this event's
 *     own tickets may be listed here.
 */
export function checkSellOffer(tx: OfferTx, expected: OfferExpectation): Verdict {
  if (tx.TransactionType !== 'NFTokenCreateOffer') {
    return { ok: false, reason: 'not an offer' }
  }
  if (tx.Account !== expected.organizerAddress) {
    return { ok: false, reason: 'offer is not created as the organizer' }
  }
  if (tx.Destination !== expected.brokerAddress) {
    return { ok: false, reason: 'offer is not restricted to the broker' }
  }
  const flags = typeof tx.Flags === 'number' ? tx.Flags : 0
  if ((flags & TF_SELL_NFTOKEN) !== TF_SELL_NFTOKEN) {
    return { ok: false, reason: 'offer is not a sell offer' }
  }
  if (typeof tx.Amount !== 'string' || !/^[0-9]+$/.test(tx.Amount)) {
    // An object amount is an issued currency or an MPT; the sale is in XRP drops.
    return { ok: false, reason: 'offer amount is not an XRP amount in drops' }
  }
  if (BigInt(tx.Amount) < expected.priceDrops || BigInt(tx.Amount) <= 0n) {
    return { ok: false, reason: 'offer is below the ticket price' }
  }
  if (tx.NFTokenID !== expected.nfTokenId) {
    return { ok: false, reason: 'offer is not for the claimed ticket' }
  }

  let parsed: { Issuer: string; Taxon: number }
  try {
    parsed = parseNFTokenID(expected.nfTokenId)
  } catch {
    return { ok: false, reason: 'ticket id is not a valid NFTokenID' }
  }
  if (parsed.Issuer !== expected.organizerAddress) {
    return { ok: false, reason: 'ticket was not issued by the organizer' }
  }
  if (parsed.Taxon !== expected.eventTaxon) {
    return { ok: false, reason: 'ticket does not belong to this event' }
  }
  return { ok: true }
}

export type CheckoutRoom =
  | { ok: true }
  | { ok: false; reason: 'busy' | 'organizer-underfunded' }

/**
 * Can another checkout open right now?
 *
 * Declined as "busy" or "underfunded", never with the organizer's balance: that
 * is theirs, and a buyer cannot act on it anyway.
 */
export function checkoutRoom(input: {
  openHolds: number
  spendableDrops: bigint
  reserveIncDrops: bigint
}): CheckoutRoom {
  if (input.openHolds >= MAX_CONCURRENT_HOLDS) return { ok: false, reason: 'busy' }
  // The offer is an owned object, so it costs one increment the moment it exists.
  if (input.spendableDrops < input.reserveIncDrops + FEE_HEADROOM_DROPS) {
    return { ok: false, reason: 'organizer-underfunded' }
  }
  return { ok: true }
}

/**
 * Whether a hold can be reclaimed.
 *
 * Only after expiry PLUS a grace period, and never while a signature may exist:
 * reclaiming a ticket a buyer has just signed for strands their offer.
 */
export function holdReclaimable(input: {
  expiresAt: Date
  now: Date
  buyerSigned: boolean
}): boolean {
  if (input.buyerSigned) return false
  return input.now.getTime() > input.expiresAt.getTime() + HOLD_GRACE_MS
}
