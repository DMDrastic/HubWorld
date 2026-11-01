/**
 * What a listing's money means, under each fee model, in one place.
 *
 * A listing records a price and a platform fee, and which model it was created under (`feeModel`, frozen at
 * creation, because a listing already quoted to a buyer must settle to exactly what it said).
 *
 *   BUYER_PAYS_V1  (every listing made before the new model): the seller asks `price`; the buyer pays
 *                  `price + fee`; the sell offer on the ledger is `price`.
 *   SELLER_PAYS_V2 (the new model): the buyer pays exactly `price`; the sell offer is `price - fee`; the
 *                  broker's fee is `fee`. The ledger needs buy >= sell + brokerFee, and this is an equality.
 *
 * Every place that works out what a buyer owes, what the sell offer is, or what to show a buyer asks here, so
 * the two models cannot drift apart between the route, the settlement and the screen.
 */
import type { ListingFeeModel } from '@prisma/client'
import { env, feeModelV2 } from './env.js'
import { platformFeeDrops } from './ledger.js'
import { DEFAULT_SCHEDULE, minimumResaleMinor, primaryQuote, resaleFee, type Region } from './fees.js'
import { currentXrpUsd } from './xrp-price-store.js'

type Terms = { priceDrops: bigint; platformFeeDrops: bigint; feeModel: ListingFeeModel }

/** What the buyer's bid must be. */
export function buyerPaysDrops(l: Terms): bigint {
  return l.feeModel === 'SELLER_PAYS_V2' ? l.priceDrops : l.priceDrops + l.platformFeeDrops
}

/** The amount on the seller's sell offer on the ledger. */
export function sellOfferDrops(l: Terms): bigint {
  return l.feeModel === 'SELLER_PAYS_V2' ? l.priceDrops - l.platformFeeDrops : l.priceDrops
}

export type ResaleListingTerms =
  | { ok: true; feeDrops: bigint; feeBps: number; sellOfferDrops: bigint; buyerPaysDrops: bigint }
  | { ok: false; reason: string }

/** The terms of a NEW resale listing under the new model: the seller pays the fee. */
export function resaleListingTerms(input: { priceDrops: bigint; minimumDrops: bigint }): ResaleListingTerms {
  if (input.priceDrops < input.minimumDrops) {
    return {
      ok: false,
      reason: `A resale must be at least ${xrp(input.minimumDrops)} XRP (about US$5). It can still be given to someone.`,
    }
  }
  const feeDrops = resaleFee(input.priceDrops)
  return {
    ok: true,
    feeDrops,
    feeBps: DEFAULT_SCHEDULE.resale.bps,
    sellOfferDrops: input.priceDrops - feeDrops,
    buyerPaysDrops: input.priceDrops,
  }
}

/** The US$5 resale floor in drops at the given XRP price (US cents per XRP), rounded up. */
export function minimumResaleDrops(xrpUsdCents: bigint): bigint {
  if (xrpUsdCents <= 0n) throw new Error('an XRP floor needs the current XRP price')
  return minimumResaleMinor({ currency: 'XRP', xrpUsdCents })
}

/** The floor for the XRP price this deployment is configured with. Required whenever the new model is on. */
/**
 * The US$5 floor in drops at the XRP price in force right now (fetched, or the manual number: see `xrp-price.ts`), or null
 * when there is no usable price. A caller that gets null must WAIT, not guess: refusing a new resale for a few minutes is
 * cheap, and a floor from an unchecked price is a wrong one that looks right.
 */
export async function currentMinimumResaleDrops(): Promise<bigint | null> {
  const price = await currentXrpUsd()
  return price.ok ? minimumResaleMinor({ currency: 'XRP', xrpUsdMicro: price.micro }) : null
}

/** What a client is told while there is no usable price. */
export const PRICE_UNAVAILABLE = {
  error: 'Resale pricing is temporarily unavailable. Please try again shortly.',
  code: 'PRICE_UNAVAILABLE',
} as const

/** The floor from the MANUAL number only (`XRP_USD_CENTS`). Scripts that set it themselves use this; the app uses `currentMinimumResaleDrops`. */
export function configuredMinimumResaleDrops(): bigint {
  return minimumResaleDrops(BigInt(env.XRP_USD_CENTS ?? 0))
}

/**
 * The fan fee on a first sale paid on the ledger and priced in XRP: only the proportional part (a fixed US amount
 * has no fixed value in XRP), and the founding rate for an organizer an admin flagged, on events starting before
 * the promo's end in the event's own time zone. Free tickets pay nothing.
 */
export function primaryFeeDrops(input: {
  priceDrops: bigint
  event: { startsAt: Date; timeZone: string; feeRegion: Region }
  organizerFounding: boolean
}): { feeDrops: bigint; feeBps: number; promoApplied: boolean } {
  const q = primaryQuote({
    priceMinor: input.priceDrops,
    currency: 'XRP',
    rail: 'LEDGER',
    eventStartsAt: input.event.startsAt,
    eventTimeZone: input.event.timeZone,
    region: input.event.feeRegion,
    organizerFounding: input.organizerFounding,
  })
  const line = q.promoApplied ? DEFAULT_SCHEDULE.foundingPromo.line : DEFAULT_SCHEDULE.primary
  return { feeDrops: q.fanFeeMinor, feeBps: line.bps, promoApplied: q.promoApplied }
}

/**
 * The rate of the fee on a FIRST sale paid on the ledger, under whichever model is on: the same rate `firstSaleQuote`
 * charges, so a fee shown in US cents and the fee charged on the quoted XRP agree.
 */
export function firstSaleFeeBps(input: {
  event: { startsAt: Date; timeZone: string; feeRegion: Region; platformBps?: number }
  organizerFounding: boolean
}): number {
  // Any positive price: the rate does not depend on it, but a zero price returns before the founding rate is decided.
  if (feeModelV2) return primaryFeeDrops({ priceDrops: 1_000_000n, ...input }).feeBps
  return input.event.platformBps ?? 0
}

/** Plain decimal XRP for messages, never for ledger amounts. */
function xrp(drops: bigint): string {
  return `${drops / 1_000_000n}.${(drops % 1_000_000n).toString().padStart(6, '0')}`
}

/**
 * The fee on a FIRST sale, under whichever model is on, and the rate that produced it (null under the old model, which
 * records none). The checkout charges it, the mint-with-offer listing records it and the event page shows it, all
 * through here, so the price shown and the price charged cannot drift apart.
 */
export function firstSaleQuote(input: {
  priceDrops: bigint
  event: { startsAt: Date; timeZone: string; feeRegion: Region; platformBps?: number }
  organizerFounding: boolean
}): { feeDrops: bigint; feeBps: number | null } {
  if (feeModelV2) {
    const q = primaryFeeDrops(input)
    return { feeDrops: q.feeDrops, feeBps: q.feeBps }
  }
  return { feeDrops: platformFeeDrops(input.priceDrops, input.event.platformBps ?? 0), feeBps: null }
}
