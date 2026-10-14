/**
 * How far above face value a ticket may be resold.
 *
 * Organizers set one `ResalePolicy` per event, at creation (see
 * `routes/organizers.ts` — there is no event-edit route, same as
 * `royaltyBps`/`platformBps`/`ticketCount`). This module is the one place that
 * decides whether a PRICE is allowed; it knows nothing about ownership, auction
 * eligibility, or affordability — those stay in `auction-policy.ts` and each
 * route's existing checks. Called from all three places a resale price can be
 * SET (`listings.ts` list-create, `open-auction.ts` reserve, `bids.ts` bid
 * amount) so a seller/bidder cannot circumvent the cap through any one path.
 *
 * Deliberately separate from gifting: `DISABLED` refuses a resale listing or
 * auction, never a gift, and nothing here is ever consulted by `gifts.ts`.
 */

import type { ResalePolicy } from '@prisma/client'

export type ResaleCapResult =
  | { allowed: true; maxDrops: bigint | null }
  | { allowed: false; reason: string; maxDrops: bigint | null }

/**
 * Is `priceDrops` allowed under this event's resale policy?
 *
 * `faceValueDrops` is required (and the resale refused) for
 * `PERCENTAGE_CAP`/`FACE_VALUE_ONLY` when null — a ticket minted or gifted
 * with no recorded price has nothing to compare against, and treating that as
 * "unrestricted" would silently defeat the organizer's policy for every
 * comp'd or gifted ticket. Refusing with a clear reason is the honest answer.
 */
export function checkResalePrice(params: {
  policy: ResalePolicy
  capBps: number | null
  capDrops: bigint | null
  faceValueDrops: bigint | null
  priceDrops: bigint
}): ResaleCapResult {
  const { policy, capBps, capDrops, faceValueDrops, priceDrops } = params

  if (policy === 'DISABLED') {
    return { allowed: false, reason: 'This event does not allow resale.', maxDrops: null }
  }

  if (policy === 'UNRESTRICTED') {
    return { allowed: true, maxDrops: null }
  }

  if (policy === 'FIXED_CAP') {
    // Schema/route validation guarantees this is set whenever policy is
    // FIXED_CAP; treated as a programmer error, not a user-facing refusal.
    if (capDrops === null) throw new Error('FIXED_CAP policy with no resaleCapDrops configured')
    return priceDrops <= capDrops
      ? { allowed: true, maxDrops: capDrops }
      : {
          allowed: false,
          reason: `This event's organizer has limited resale prices to ${dropsToXrpString(capDrops)} XRP.`,
          maxDrops: capDrops,
        }
  }

  // PERCENTAGE_CAP and FACE_VALUE_ONLY both need a face value to compare
  // against, and neither has one to fall back on.
  if (faceValueDrops === null) {
    return {
      allowed: false,
      reason: "This ticket has no recorded face value, so it can't be resold under this event's policy.",
      maxDrops: null,
    }
  }

  const maxDrops =
    policy === 'FACE_VALUE_ONLY' ? faceValueDrops : (faceValueDrops * BigInt(capBpsOrThrow(capBps))) / 10_000n

  return priceDrops <= maxDrops
    ? { allowed: true, maxDrops }
    : {
        allowed: false,
        reason: `This event's organizer has limited resale prices to ${dropsToXrpString(maxDrops)} XRP.`,
        maxDrops,
      }
}

export type ResaleCeiling =
  | { resaleAllowed: true; maxDrops: bigint | null }
  | { resaleAllowed: false; reason: string }

/**
 * The limit itself, with no candidate price to check yet — what the frontend
 * shows next to a price input before the seller has typed anything.
 *
 * Reuses `checkResalePrice` with a zero probe price rather than duplicating
 * its branches: zero never exceeds a real cap, so `allowed` there means
 * exactly "resale is possible at all" (false only for `DISABLED` or a missing
 * face value, both of which are price-independent refusals).
 */
export function resaleCeiling(params: {
  policy: ResalePolicy
  capBps: number | null
  capDrops: bigint | null
  faceValueDrops: bigint | null
}): ResaleCeiling {
  const probe = checkResalePrice({ ...params, priceDrops: 0n })
  return probe.allowed
    ? { resaleAllowed: true, maxDrops: probe.maxDrops }
    : { resaleAllowed: false, reason: probe.reason }
}

function capBpsOrThrow(capBps: number | null): number {
  if (capBps === null) throw new Error('PERCENTAGE_CAP policy with no resaleCapBps configured')
  return capBps
}

/** Plain decimal XRP, for error messages — never used for ledger amounts. */
function dropsToXrpString(drops: bigint): string {
  const whole = drops / 1_000_000n
  const frac = (drops % 1_000_000n).toString().padStart(6, '0')
  return `${whole}.${frac}`
}
