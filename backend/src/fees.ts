/**
 * The fee model, in one place. Nothing else in HubWorld computes a fee.
 *
 * Decisions this encodes (confirmed 2026-10-31):
 *
 *  - FIRST-TIME SALE BY CARD: fan fee = US$1.25 + 3.5% of the price, charged in US dollars, inside ONE
 *    all-in price. Card processing is passed through inside that same total and broken out only on the
 *    receipt. The total is GROSSED UP so HubWorld nets exactly the price plus its fee after the
 *    processor takes its cut, and the cut is rounded UP so we can never be left short.
 *
 *  - FIRST-TIME SALE ON THE LEDGER, PRICED IN XRP: only the 3.5%. THE DIFFERENCE FROM CARD IS
 *    DELIBERATE: a fixed US amount needs an exchange rate, and XRP has none we can freeze, so the fixed
 *    US$1.25 waits until prices can be in RLUSD (Phase 3a). Priced in RLUSD the full US$1.25 + 3.5% applies,
 *    in RLUSD. So the same dollar ticket costs US$1.25 more in fee on card or RLUSD than in XRP.
 *
 *  - FOUNDING PROMO (US$1 + 3%): only for an organizer an admin flagged as founding (the first ~10), and only
 *    for an event that STARTS before 2028-01-01 00:00 in the EVENT'S OWN time zone (America/St_Lucia for a
 *    St. Lucia event). Not UTC, and not a general date window: an 11 pm New Year's Eve fete in St. Lucia is
 *    already 2028 in UTC and is still in.
 *
 *  - RESALE: 5%, paid by the SELLER. The sell offer is price - fee and the bid is the price, so the buyer
 *    pays exactly what the page shows. (Measured on the ledger 2026-10-31.)
 *
 *  - FREE TICKETS AND COMPS: no fan fee. Their cost is 0, so the resale cap (the all-in amount the buyer
 *    paid) is 0 and they can be gifted or transferred but never resold for money.
 *
 *  - RESALE CAP: `originalCostMinor`, the full all-in amount actually paid, processing included.
 *
 *  - RESALE FLOOR: off below the equivalent of US$5 at listing time. Gifting stays available. Rounded UP
 *    in XRP so a borderline price is refused.
 *
 * CARD PROCESSING is configuration per event REGION, not one number. Stripe Canada charges 2.9% + C$0.30
 * on domestic cards, +0.8% on international cards, and +2% if currency conversion happens. Caribbean
 * events assume mostly non-Canadian cards (3.7%); Canadian events 2.9%. We assume USD is settled to a USD
 * payout account, so no 2% conversion; `currencyConversion.applies` is the switch if we cannot.
 * The fixed part is configured DIRECTLY in the charge currency (`fixedUsdCents`), so there is no
 * exchange rate in the arithmetic at all. It is set to 30 cents until we read the real figure off the
 * fee breakdown of an actual test charge: 30 is the safer upper bound (it can only slightly over-collect
 * processing, never under-collect). THE PROCESSOR RATES ARE UNVERIFIED FOR OUR ACTUAL ACCOUNT; replace
 * all three numbers (the two percentages and the fixed fee) from that breakdown.
 *
 * Minor units: USD = cents, XRP = drops, RLUSD = millionths. Money is BigInt throughout.
 */

export type Currency = 'USD' | 'XRP' | 'RLUSD'
/** How the buyer pays. CARD is always US dollars. LEDGER is an on-ledger payment. */
export type Rail = 'CARD' | 'LEDGER'
/** Which card-processing rates apply to an event. */
export type Region = 'CARIBBEAN' | 'CANADA'

/** A fee in US cents (the fixed part) and basis points (the proportional part). */
export type FeeLine = { fixedUsdCents: bigint; bps: number }

export type FeeSchedule = {
  version: 'v2'
  primary: FeeLine
  foundingPromo: {
    line: FeeLine
    /** Events starting strictly BEFORE this local wall-clock time (in the event's own zone) qualify. */
    eventsBeforeLocal: string
  }
  resale: { bps: number }
  cardProcessing: {
    regions: Record<Region, { bps: number }>
    /**
     * The processor's fixed fee per charge, in US cents (the charge currency). 30 until confirmed from
     * a real test charge's fee breakdown; the upper bound, so it can only over-collect slightly.
     */
    fixedUsdCents: bigint
    /** The extra charge if the processor must convert currency. Off: we settle USD to a USD account. */
    currencyConversion: { applies: boolean; bps: number }
  }
  /** Resale is off below this many US cents (converted to the sale's currency at listing time). */
  minimumResaleUsdCents: bigint
}

export const DEFAULT_SCHEDULE: FeeSchedule = {
  version: 'v2',
  primary: { fixedUsdCents: 125n, bps: 350 },
  foundingPromo: { line: { fixedUsdCents: 100n, bps: 300 }, eventsBeforeLocal: '2028-01-01T00:00:00' },
  resale: { bps: 500 },
  cardProcessing: {
    // 2.9% domestic + 0.8% international cards = 3.7% for the Caribbean; domestic only for Canada.
    regions: { CARIBBEAN: { bps: 370 }, CANADA: { bps: 290 } },
    fixedUsdCents: 30n,
    currencyConversion: { applies: false, bps: 200 },
  },
  minimumResaleUsdCents: 500n,
}

export type PrimaryInput = {
  priceMinor: bigint
  currency: Currency
  rail: Rail
  /** When the event starts. The promo is decided by this instant read in `eventTimeZone`. */
  eventStartsAt: Date
  /** The event's own IANA time zone, e.g. 'America/St_Lucia'. */
  eventTimeZone: string
  /** Chooses the card-processing rates. */
  region: Region
  /** Set by an admin; the first ~10 organizers. */
  organizerFounding: boolean
}

export type PrimaryQuote = {
  priceMinor: bigint
  /** HubWorld's fan fee. */
  fanFeeMinor: bigint
  /** Card processing passed through; zero off-card. Broken out on the receipt only. */
  processingMinor: bigint
  /** What the buyer pays. This is what every screen shows and what `originalCostMinor` stores. */
  allInMinor: bigint
  promoApplied: boolean
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b

/** The event's start as local wall-clock time in its own zone, as 'YYYY-MM-DDTHH:MM:SS'. */
function localWallClock(at: Date, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at)
  } catch {
    throw new Error(`unknown time zone: ${timeZone}`)
  }
  const get = (t: string) => parts.find((p) => p.type === t)!.value
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
}

/** The processor's cut of a total, rounded UP, in US cents. Never less than what they will take. */
function processorCut(total: bigint, bps: number, fixedUsdCents: bigint): bigint {
  return ceilDiv(total * BigInt(bps), 10_000n) + fixedUsdCents
}

/** The smallest total the buyer can be charged so that, after the processor's cut, `subtotal` remains. */
function grossUp(subtotal: bigint, bps: number, fixedUsdCents: bigint): bigint {
  if (bps < 0 || bps >= 10_000) throw new Error(`processing rate ${bps} bps is outside 0-9999`)
  // total - cut(total) never decreases as total grows, so the smallest total that works can be found by halving.
  let lo = subtotal
  let hi = subtotal * 2n + fixedUsdCents + 1_000n
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    if (mid - processorCut(mid, bps, fixedUsdCents) >= subtotal) hi = mid
    else lo = mid + 1n
  }
  return lo
}

export function primaryQuote(input: PrimaryInput, schedule: FeeSchedule = DEFAULT_SCHEDULE): PrimaryQuote {
  if (input.priceMinor < 0n) throw new Error('a price cannot be negative')
  if (input.rail === 'CARD' && input.currency !== 'USD') throw new Error('card sales are in US dollars')
  if (input.rail === 'LEDGER' && input.currency === 'USD') throw new Error('an on-ledger sale is priced in XRP or RLUSD, not US dollars')

  const promo =
    input.organizerFounding &&
    localWallClock(input.eventStartsAt, input.eventTimeZone) < schedule.foundingPromo.eventsBeforeLocal

  if (input.priceMinor === 0n) {
    return { priceMinor: 0n, fanFeeMinor: 0n, processingMinor: 0n, allInMinor: 0n, promoApplied: false }
  }

  const line = promo ? schedule.foundingPromo.line : schedule.primary
  // The fixed part is in US cents. In XRP it has no fixed value, so it is left out (see the header).
  const fixed =
    input.currency === 'USD' ? line.fixedUsdCents : input.currency === 'RLUSD' ? line.fixedUsdCents * 10_000n : 0n
  const fanFeeMinor = fixed + (input.priceMinor * BigInt(line.bps)) / 10_000n

  let processingMinor = 0n
  if (input.rail === 'CARD') {
    const c = schedule.cardProcessing
    const bps = c.regions[input.region].bps + (c.currencyConversion.applies ? c.currencyConversion.bps : 0)
    const subtotal = input.priceMinor + fanFeeMinor
    processingMinor = grossUp(subtotal, bps, c.fixedUsdCents) - subtotal
  }

  return {
    priceMinor: input.priceMinor,
    fanFeeMinor,
    processingMinor,
    allInMinor: input.priceMinor + fanFeeMinor + processingMinor,
    promoApplied: promo,
  }
}

/** The resale fee on a price, floored: HubWorld rounds against itself. */
export function resaleFee(priceMinor: bigint, schedule: FeeSchedule = DEFAULT_SCHEDULE): bigint {
  return (priceMinor * BigInt(schedule.resale.bps)) / 10_000n
}

export type ResaleRefusal = 'BELOW_MINIMUM' | 'ABOVE_CAP'

export type ResaleTerms =
  | { ok: true; feeMinor: bigint; sellOfferMinor: bigint; buyerPaysMinor: bigint }
  | { ok: false; reason: ResaleRefusal }

/**
 * The terms of a resale, or why it is refused. The cap is checked first: a ticket that cannot be sold
 * for money at all (a free ticket) is told so, not that its price is too small.
 */
export function resaleTerms(
  input: { priceMinor: bigint; originalCostMinor: bigint; minimumMinor: bigint },
  schedule: FeeSchedule = DEFAULT_SCHEDULE,
): ResaleTerms {
  if (input.priceMinor > input.originalCostMinor) return { ok: false, reason: 'ABOVE_CAP' }
  if (input.priceMinor < input.minimumMinor) return { ok: false, reason: 'BELOW_MINIMUM' }
  const feeMinor = resaleFee(input.priceMinor, schedule)
  return { ok: true, feeMinor, sellOfferMinor: input.priceMinor - feeMinor, buyerPaysMinor: input.priceMinor }
}

/** The US$5 floor in the sale's own currency, rounded UP so a borderline price is refused. */
export function minimumResaleMinor(
  input: { currency: Currency; xrpUsdCents?: bigint },
  schedule: FeeSchedule = DEFAULT_SCHEDULE,
): bigint {
  const cents = schedule.minimumResaleUsdCents
  if (input.currency === 'USD') return cents
  if (input.currency === 'RLUSD') return cents * 10_000n
  if (!input.xrpUsdCents || input.xrpUsdCents <= 0n) throw new Error('an XRP floor needs the current XRP price')
  return ceilDiv(cents * 1_000_000n, input.xrpUsdCents)
}

/** What an organizer's royalty really pays once the resale fee comes off first, in basis points. */
export function effectiveRoyaltyBps(royaltyBps: number, resaleFeeBps: number): number {
  return (royaltyBps * (10_000 - resaleFeeBps)) / 10_000
}
