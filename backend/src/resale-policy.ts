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

import type { PriceCurrency, ResalePolicy } from '@prisma/client'
import { platformFeeDrops } from './ledger.js'

/**
 * What the ticket's buyer actually paid, all in (price, fan fee and card processing).
 *
 * Callers pass this ONLY while the new fee model is on, and `minor: null` means no amount was ever
 * recorded (a ticket sold before this existed, or never sold). That case, and passing nothing at all,
 * leave the organizer's policy exactly as it was: the new cap applies to the new terms and to nothing older.
 */
export type PaidCost = { minor: bigint | null; currency: PriceCurrency | null }

/**
 * A PRIMARY sale — exempt from the cap, and the moment face value is
 * established — is the organizer selling a ticket that has never had a price
 * recorded. It is NOT simply "the seller is the organizer": nothing stops the
 * organizer from being the BUYER on someone else's capped listing (only
 * buying your OWN listing is refused), so without the face-value condition
 * they could buy back a ticket at the cap and relist it for anything. Once a
 * face value exists, every later listing is a resale, including one where the
 * organizer happens to be holding the ticket again.
 *
 * One shared predicate rather than one copy in the enforcement path
 * (`listings.ts`) and another in the display path (`tickets.ts`) — the two
 * drifting apart would mean the UI advertises a cap the server doesn't
 * actually enforce, or refuses one it would actually allow.
 */
export function isPrimarySale(params: {
  organizerId: string
  sellerId: string
  faceValueDrops: bigint | null
}): boolean {
  return params.sellerId === params.organizerId && params.faceValueDrops === null
}

/** `bound` says which rule set the limit: the organizer's policy, or what the buyer paid. */
type Ceiling =
  | { ok: true; maxDrops: bigint | null; bound: 'POLICY' | 'PAID' }
  | { ok: false; reason: string }

/**
 * The policy's limit, with no price to check against yet. Shared by
 * `checkResalePrice` (which additionally compares a candidate price) and
 * `resaleCeiling` (which just reports the limit) — a single source of the
 * actual branching, rather than one of them deriving it from the other via a
 * sentinel value. `maxDrops: null` only ever means UNRESTRICTED; every
 * refusal path returns `ok: false` with its own reason instead.
 */
function ceilingFor(params: {
  policy: ResalePolicy
  capBps: number | null
  capDrops: bigint | null
  faceValueDrops: bigint | null
  paid?: PaidCost | undefined
}): Ceiling {
  const base = policyCeiling(params)
  if (!base.ok) return base // DISABLED, or a policy that cannot be evaluated: stays exactly as it was

  const { paid } = params
  // No amount recorded, or the new model is off: the organizer's policy and nothing else.
  if (!paid || paid.minor === null) return base

  // The cap is in drops, so it can only be compared with a ticket bought in XRP. Guessing an exchange rate
  // would let a resale slip past the cap by whatever the guess was off by.
  if (paid.currency !== 'XRP') {
    return {
      ok: false,
      reason: `This ticket was bought in ${paid.currency ?? 'another currency'}, so it has to be resold in that currency.`,
    }
  }

  // The LOWER of the two. An unrestricted policy has no limit of its own, so what was paid is the limit.
  if (base.maxDrops !== null && base.maxDrops <= paid.minor) return base
  return { ok: true, maxDrops: paid.minor, bound: 'PAID' }
}

/** The organizer's policy on its own, with no regard for what anyone paid. This is today's logic, unchanged. */
function policyCeiling(params: {
  policy: ResalePolicy
  capBps: number | null
  capDrops: bigint | null
  faceValueDrops: bigint | null
}): Ceiling {
  const { policy, capBps, capDrops, faceValueDrops } = params

  if (policy === 'DISABLED') {
    return { ok: false, reason: 'This event does not allow resale.' }
  }

  if (policy === 'UNRESTRICTED') {
    return { ok: true, maxDrops: null, bound: 'POLICY' }
  }

  if (policy === 'FIXED_CAP') {
    // Schema/route validation guarantees this is set whenever policy is
    // FIXED_CAP; treated as a programmer error, not a user-facing refusal.
    if (capDrops === null) throw new Error('FIXED_CAP policy with no resaleCapDrops configured')
    return { ok: true, maxDrops: capDrops, bound: 'POLICY' }
  }

  // PERCENTAGE_CAP and FACE_VALUE_ONLY both need a face value to compare
  // against, and neither has one to fall back on.
  if (faceValueDrops === null) {
    return {
      ok: false,
      reason: "This ticket has no recorded face value, so it can't be resold under this event's policy.",
    }
  }

  const maxDrops =
    policy === 'FACE_VALUE_ONLY' ? faceValueDrops : (faceValueDrops * BigInt(capBpsOrThrow(capBps))) / 10_000n
  return { ok: true, maxDrops, bound: 'POLICY' }
}

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
  paid?: PaidCost | undefined
}): ResaleCapResult {
  const ceiling = ceilingFor(params)
  if (!ceiling.ok) return { allowed: false, reason: ceiling.reason, maxDrops: null }
  if (ceiling.maxDrops === null) return { allowed: true, maxDrops: null } // UNRESTRICTED

  return params.priceDrops <= ceiling.maxDrops
    ? { allowed: true, maxDrops: ceiling.maxDrops }
    : {
        allowed: false,
        reason:
          ceiling.bound === 'POLICY'
            ? `This event's organizer has limited resale prices to ${dropsToXrpString(ceiling.maxDrops)} XRP.`
            : ceiling.maxDrops === 0n
              ? "This ticket was free, so it can't be resold for money. It can still be given to someone."
              : `A ticket can be resold for at most what its buyer paid, ${dropsToXrpString(ceiling.maxDrops)} XRP.`,
        maxDrops: ceiling.maxDrops,
      }
}

export type ResaleCeiling =
  | { resaleAllowed: true; maxDrops: bigint | null }
  | { resaleAllowed: false; reason: string }

/**
 * The limit itself, with no candidate price to check yet — what the frontend
 * shows next to a price input before the seller has typed anything.
 */
export function resaleCeiling(params: {
  policy: ResalePolicy
  capBps: number | null
  capDrops: bigint | null
  faceValueDrops: bigint | null
  paid?: PaidCost | undefined
}): ResaleCeiling {
  const ceiling = ceilingFor(params)
  return ceiling.ok
    ? { resaleAllowed: true, maxDrops: ceiling.maxDrops }
    : { resaleAllowed: false, reason: ceiling.reason }
}

/**
 * Which rule is setting the limit right now: the organizer's policy, what the buyer paid, or nothing.
 * For showing a seller WHY a price is capped; the limit itself comes from `resaleCeiling`.
 */
export function capSource(params: {
  policy: ResalePolicy
  capBps: number | null
  capDrops: bigint | null
  faceValueDrops: bigint | null
  paid?: PaidCost | undefined
}): 'POLICY' | 'PAID' | 'NONE' {
  const c = ceilingFor(params)
  if (!c.ok || c.maxDrops === null) return 'NONE'
  return c.bound
}

/**
 * Only for fixed-price LISTINGS, never auctions.
 *
 * A listing's `priceDrops` is the seller's ASK — the buyer actually pays
 * `priceDrops + platformFeeDrops(priceDrops, platformBps)` (see
 * `listings.ts`'s `buyerPaysDrops`), so capping the ask alone lets the final
 * price creep past the organizer's stated limit by the platform fee. This
 * backs the fee out of `maxTotalDrops` to find the largest ask that still
 * keeps the buyer's TOTAL at or under the cap — what the organizer's "maximum
 * resale price" is actually supposed to mean.
 *
 * Auctions need none of this: a bid amount already IS what the bidder pays
 * (the fee comes out of the seller's cut instead, via `auctionSellAmountDrops`),
 * so the raw cap is already the right number to compare against there.
 *
 * The division only approximates the answer (integer flooring both ways), so
 * the result is nudged down until it actually satisfies the constraint —
 * never up, since this feeds a REFUSAL boundary and erring the other way
 * would let a buyer's total exceed the organizer's cap by a drop or two.
 */
export function maxAskForCap(maxTotalDrops: bigint, platformBps: number): bigint {
  let ask = (maxTotalDrops * 10_000n) / (10_000n + BigInt(platformBps))
  while (ask > 0n && ask + platformFeeDrops(ask, platformBps) > maxTotalDrops) ask -= 1n
  return ask > 0n ? ask : 0n
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
