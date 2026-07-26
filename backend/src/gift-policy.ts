/**
 * Gift lifetime rules, extracted so they are testable without a database or a
 * live Xaman — and so the route and the tests cannot drift apart.
 *
 * The rule worth stating once: an XRPL `NFTokenOffer` has **no expiry**. Once it
 * exists on-ledger it lives until accepted or cancelled. Our `expiresAt` is the
 * lifetime of an *unsigned Xaman payload*, nothing more.
 *
 * Conflating the two shipped a real bug: an `OFFERED` gift was marked `expired`
 * once the payload TTL passed, while its offer stayed live and acceptable in
 * Xaman. The recipient could accept it there, ownership would move, and
 * Hubworld — believing the gift dead — would never write the `GIFT` provenance
 * row. That is the hole `Transfer` exists to prevent.
 */
import type { GiftStatus } from '@prisma/client'

/** States with something live on-ledger, which no timeout may kill. */
export const ON_LEDGER_STATES = ['OFFERED', 'ACCEPTING', 'CANCELLING'] as const

export function isOnLedger(status: GiftStatus): boolean {
  return (ON_LEDGER_STATES as readonly string[]).includes(status)
}

/**
 * Whether the payload TTL is allowed to expire this gift. Only true before
 * anything has reached the ledger.
 */
export function mayExpire(status: GiftStatus): boolean {
  return !isOnLedger(status)
}

/**
 * Whether a gift should still be listed and actionable. An on-ledger offer stays
 * live indefinitely; an unsigned one dies with its payload.
 */
export function isLiveGift(status: GiftStatus, payloadExpired: boolean): boolean {
  if (isOnLedger(status)) return true
  return status === 'PENDING_OFFER' && !payloadExpired
}
