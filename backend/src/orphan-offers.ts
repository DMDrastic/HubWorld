/**
 * Offers on an organizer's account that nothing on our side accounts for.
 *
 * With the lazy primary sale the delegate creates sell offers AS the organizer,
 * so the organizer's account now holds offers it never signed. Every one should
 * match a Listing we wrote. One that does not is either a bug (an offer created,
 * then lost before its index was recorded) or — the case that matters — a
 * delegate being used to list something it was not asked to. The ledger cannot
 * narrow `NFTokenCreateOffer`, and `checkSellOffer` runs only inside OUR code, so
 * this is the check that notices when something else is holding the key.
 *
 * Pure, so the classification can be pinned exactly: the difference between
 * "inert, clean it up" and "someone may be able to take a ticket" is the whole
 * point, and it must not depend on a network.
 */

/** One `NFTokenOffer` ledger object, as read from `account_objects`. */
export type LedgerOffer = {
  index: string
  /** The NFT the offer is for. */
  nfTokenId: string
  isSell: boolean
  /** XRP drops as a string; anything else (an issued currency / MPT) is an object. */
  amount: unknown
  destination: string | null
  /** The account that owns the offer object (whose reserve it locks). */
  owner: string
}

/** What our database says about an offer index. */
export type KnownOffer = { status: string }

export type OrphanKind =
  /** Only the broker can match it: nobody can take the ticket, it just holds reserve. Safe to cancel. */
  | 'inert'
  /** Open, or destined for another account. Someone other than the broker may be able to take the ticket. */
  | 'exposed'
  /** Our record of the sale is finished (sold/cancelled/failed) but the offer is still standing. */
  | 'stale'

export type Orphan = {
  offer: LedgerOffer
  kind: OrphanKind
  /** Words for whoever reads the report. */
  why: string
}

/** Statuses in which a standing offer is expected. */
const LIVE_STATUSES = new Set(['ACTIVE', 'BUYER_PENDING', 'SETTLING', 'CANCELLING', 'PENDING_OFFER'])

/**
 * Which of an organizer's offers are unaccounted for?
 *
 * `known` maps offer index -> the listing that owns it (sell side or buy side).
 * An offer with a live listing is expected. One with a FINISHED listing, or none
 * at all, is reported — and classified by what it could let someone do, because
 * that decides whether it is housekeeping or an incident.
 */
export function findOrphanOffers(input: {
  offers: readonly LedgerOffer[]
  known: ReadonlyMap<string, KnownOffer>
  brokerAddress: string
}): Orphan[] {
  const orphans: Orphan[] = []

  for (const offer of input.offers) {
    const listing = input.known.get(offer.index)
    if (listing && LIVE_STATUSES.has(listing.status)) continue

    // Only the broker can match an offer destined for it, so it cannot be taken
    // by anyone else. An offer with no destination is open to everyone, and one
    // destined elsewhere to someone who is not us.
    const onlyBroker = offer.destination === input.brokerAddress

    if (offer.isSell && !onlyBroker) {
      orphans.push({
        offer,
        kind: 'exposed',
        why: offer.destination
          ? `sell offer destined for ${offer.destination}, not the broker`
          : 'sell offer open to anyone',
      })
      continue
    }

    if (listing) {
      orphans.push({
        offer,
        kind: 'stale',
        why: `listing is ${listing.status} but the offer is still standing`,
      })
      continue
    }

    orphans.push({
      offer,
      kind: 'inert',
      why: offer.isSell
        ? 'broker-only sell offer with no listing (holds reserve; cancellable by the broker)'
        : 'buy offer with no listing',
    })
  }

  return orphans
}

/**
 * Which of them can Hubworld clean up itself?
 *
 * Only an offer whose `Destination` is the broker: that account may cancel it
 * (verified on testnet). An exposed offer names someone else, so the only cancel
 * we can issue is the organizer's — which is a human's decision, not a cron job's.
 */
export function cancellableByBroker(orphan: Orphan, brokerAddress: string): boolean {
  return orphan.offer.destination === brokerAddress && orphan.kind !== 'exposed'
}
