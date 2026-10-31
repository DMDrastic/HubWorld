/**
 * The fee model, specified by example. Written BEFORE the code, then the code was written to pass it.
 *
 * Every expected number below was worked out by hand (the arithmetic is beside it) and NOT by running
 * anything. A test whose expected value comes from the code under test cannot fail.
 *
 * Decisions covered (confirmed 2026-10-31): card fan fee US$1.25 + 3.5%; XRP-priced on-ledger sales
 * charge only the 3.5%, RLUSD-priced the full fee; founding promo US$1 + 3% for flagged organizers on events
 * starting before 2028-01-01 00:00 IN THE EVENT'S OWN TIME ZONE; card processing per region (Caribbean 3.7%,
 * Canada 2.9%, + C$0.30, +2% only if currency conversion is on) passed through inside one all-in price and
 * grossed up so HubWorld nets exactly price + fee; resale 5% paid by the seller; resale off below US$5;
 * free tickets pay no fee and are never resold for money; the resale cap is the all-in amount paid.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SCHEDULE,
  effectiveRoyaltyBps,
  minimumResaleMinor,
  primaryQuote,
  resaleTerms,
  type FeeSchedule,
  type PrimaryInput,
} from '../src/fees.js'

const base: PrimaryInput = {
  priceMinor: 3500n,
  currency: 'USD',
  rail: 'CARD',
  eventStartsAt: new Date('2027-06-15T20:00:00Z'),
  eventTimeZone: 'America/St_Lucia',
  region: 'CARIBBEAN',
  organizerFounding: false,
}
const quote = (over: Partial<PrimaryInput> = {}, schedule?: FeeSchedule) => primaryQuote({ ...base, ...over }, schedule)

/** The same schedule with the processor's currency-conversion surcharge switched on. */
const withConversion: FeeSchedule = {
  ...DEFAULT_SCHEDULE,
  cardProcessing: { ...DEFAULT_SCHEDULE.cardProcessing, currencyConversion: { applies: true, bps: 200 } },
}

describe('the schedule', () => {
  it('carries the confirmed numbers', () => {
    expect(DEFAULT_SCHEDULE.primary).toEqual({ fixedUsdCents: 125n, bps: 350 })
    expect(DEFAULT_SCHEDULE.foundingPromo.line).toEqual({ fixedUsdCents: 100n, bps: 300 })
    expect(DEFAULT_SCHEDULE.foundingPromo.eventsBeforeLocal).toBe('2028-01-01T00:00:00')
    expect(DEFAULT_SCHEDULE.resale).toEqual({ bps: 500 })
    expect(DEFAULT_SCHEDULE.minimumResaleUsdCents).toBe(500n)
  })

  it('has the processor rates per region: Caribbean 2.9% + 0.8% international, Canada 2.9%, C$0.30 fixed, no conversion', () => {
    expect(DEFAULT_SCHEDULE.cardProcessing.regions).toEqual({ CARIBBEAN: { bps: 370 }, CANADA: { bps: 290 } })
    expect(DEFAULT_SCHEDULE.cardProcessing.fixedCadCents).toBe(30n)
    expect(DEFAULT_SCHEDULE.cardProcessing.currencyConversion).toEqual({ applies: false, bps: 200 })
  })

  it('uses a conservative placeholder exchange rate for the fixed fee, which must be replaced with the real one before cards go live', () => {
    const { num, den } = DEFAULT_SCHEDULE.cardProcessing.cadToUsd
    expect(Number(num) / Number(den)).toBeGreaterThanOrEqual(0.72)
  })
})

describe('a first-time sale by card', () => {
  // The fixed C$0.30 is 22.5 US cents at the placeholder rate 0.75, rounded UP to 23.

  it('Caribbean US$35: fee 125 + floor(122.5) = 247; processing 3.7% + 23c grossed up makes the all-in 3915', () => {
    // Subtotal 3747. Smallest total T where T - (ceil(0.037 T) + 23) >= 3747 is 3915 (3914 leaves 3746).
    expect(quote()).toEqual({
      priceMinor: 3500n,
      fanFeeMinor: 247n,
      processingMinor: 168n,
      allInMinor: 3915n,
      promoApplied: false,
    })
  })

  it('Canada US$35: the same fee, domestic cards only (2.9% + 23c), so the all-in is 3883', () => {
    expect(quote({ region: 'CANADA', eventTimeZone: 'America/Toronto' })).toMatchObject({
      fanFeeMinor: 247n,
      processingMinor: 136n,
      allInMinor: 3883n,
    })
  })

  it('Caribbean US$5, US$20 and US$1000 (worked the same way)', () => {
    expect(quote({ priceMinor: 500n })).toMatchObject({ fanFeeMinor: 142n, processingMinor: 49n, allInMinor: 691n })
    expect(quote({ priceMinor: 2000n })).toMatchObject({ fanFeeMinor: 195n, processingMinor: 109n, allInMinor: 2304n })
    expect(quote({ priceMinor: 100000n })).toMatchObject({ fanFeeMinor: 3625n, processingMinor: 4006n, allInMinor: 107631n })
  })

  it('floors the proportional part, so a price of one cent still pays the fixed US$1.25', () => {
    expect(quote({ priceMinor: 1n })).toMatchObject({ fanFeeMinor: 125n, processingMinor: 29n, allInMinor: 155n })
  })

  it('adds the 2% only when the currency-conversion flag is on: Caribbean US$35 goes from 3915 to 3998', () => {
    // 5.7% + 23c: smallest T with T - (ceil(0.057 T) + 23) >= 3747 is 3998.
    expect(quote({}, withConversion)).toMatchObject({ processingMinor: 251n, allInMinor: 3998n })
    expect(quote({}).allInMinor).toBe(3915n) // and the default stays off
  })

  it('NEVER charges less processing than the processor will take, in any region, with or without conversion', () => {
    // An independent model of the processor, using the UNROUNDED real-number cut: total x rate + 22.5 cents
    // (C$0.30 at 0.75). The all-in processing must cover it exactly or more: 20000 x processing >= 2 x total x bps + 450000.
    // That is stricter than any rounding the processor applies, so a pass means we cannot lose money on processing.
    let seed = 20261031
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648)
    const cases: Array<[Partial<PrimaryInput>, FeeSchedule | undefined, bigint]> = [
      [{ region: 'CARIBBEAN' }, undefined, 370n],
      [{ region: 'CANADA' }, undefined, 290n],
      [{ region: 'CARIBBEAN' }, withConversion, 570n],
      [{ region: 'CANADA' }, withConversion, 490n],
    ]
    for (const [over, schedule, bps] of cases) {
      for (let i = 0; i < 1500; i += 1) {
        const price = BigInt((rand() % 2_000_000) + 1)
        const q = quote({ ...over, priceMinor: price, organizerFounding: rand() % 2 === 0 }, schedule)
        const total = q.allInMinor
        expect(20000n * q.processingMinor).toBeGreaterThanOrEqual(2n * total * bps + 450000n)
        // HubWorld nets its subtotal, and it is the SMALLEST total that does (one cent less would not).
        expect(q.allInMinor).toBe(q.priceMinor + q.fanFeeMinor + q.processingMinor)
        const cut = (t: bigint) => (t * bps + 9999n) / 10000n + 23n
        expect(total - cut(total)).toBeGreaterThanOrEqual(q.priceMinor + q.fanFeeMinor)
        expect(total - 1n - cut(total - 1n)).toBeLessThan(q.priceMinor + q.fanFeeMinor)
      }
    }
  })

  it('refuses a card sale that is not in US dollars', () => {
    expect(() => quote({ currency: 'XRP' })).toThrow(/US dollars/i)
    expect(() => quote({ currency: 'RLUSD' })).toThrow(/US dollars/i)
  })
})

describe('a first-time sale on the ledger', () => {
  it('priced in XRP charges ONLY the 3.5%: 20 XRP pays 0.7 XRP, with no fixed part and no processing', () => {
    // 20_000_000 x 350 / 10000 = 700_000 drops.
    expect(quote({ rail: 'LEDGER', currency: 'XRP', priceMinor: 20_000_000n })).toEqual({
      priceMinor: 20_000_000n,
      fanFeeMinor: 700_000n,
      processingMinor: 0n,
      allInMinor: 20_700_000n,
      promoApplied: false,
    })
  })

  it('priced in XRP floors the fee and has no minimum, so one drop pays nothing', () => {
    expect(quote({ rail: 'LEDGER', currency: 'XRP', priceMinor: 1n })).toMatchObject({ fanFeeMinor: 0n, allInMinor: 1n })
    expect(quote({ rail: 'LEDGER', currency: 'XRP', priceMinor: 28n })).toMatchObject({ fanFeeMinor: 0n }) // 0.98 drop
    expect(quote({ rail: 'LEDGER', currency: 'XRP', priceMinor: 29n })).toMatchObject({ fanFeeMinor: 1n }) // 1.015 drop
  })

  it('priced in RLUSD charges the full fee: 35 RLUSD pays 1.25 + 1.225 = 2.475', () => {
    // Fixed 125 cents = 1_250_000 millionths; 35_000_000 x 350 / 10000 = 1_225_000.
    expect(quote({ rail: 'LEDGER', currency: 'RLUSD', priceMinor: 35_000_000n })).toEqual({
      priceMinor: 35_000_000n,
      fanFeeMinor: 2_475_000n,
      processingMinor: 0n,
      allInMinor: 37_475_000n,
      promoApplied: false,
    })
  })

  it('refuses to price an on-ledger sale in US dollars: it is XRP or RLUSD', () => {
    expect(() => quote({ rail: 'LEDGER', currency: 'USD' })).toThrow(/XRP or RLUSD/i)
  })

  it('is NOT the same as the card fee for the same dollar value: the XRP rule drops the fixed part on purpose', () => {
    const xrp = quote({ rail: 'LEDGER', currency: 'XRP', priceMinor: 20_000_000n })
    const rlusd = quote({ rail: 'LEDGER', currency: 'RLUSD', priceMinor: 20_000_000n })
    expect(rlusd.fanFeeMinor - xrp.fanFeeMinor).toBe(1_250_000n) // exactly the fixed US$1.25
  })
})

describe('the founding promo ($1 + 3%)', () => {
  it('applies to a flagged organizer on an event inside the window: Caribbean US$35 pays 100 + 105 = 205', () => {
    // Subtotal 3705; smallest T with T - (ceil(0.037 T) + 23) >= 3705 is 3872.
    expect(quote({ organizerFounding: true })).toEqual({
      priceMinor: 3500n,
      fanFeeMinor: 205n,
      processingMinor: 167n,
      allInMinor: 3872n,
      promoApplied: true,
    })
  })

  it('applies in Canada the same way, with Canada\'s processing: all-in 3840', () => {
    expect(quote({ organizerFounding: true, region: 'CANADA', eventTimeZone: 'America/Toronto' })).toMatchObject({
      fanFeeMinor: 205n,
      processingMinor: 135n,
      allInMinor: 3840n,
    })
  })

  it('applies on the ledger too, as the proportional part only when priced in XRP: 20 XRP pays 0.6', () => {
    expect(quote({ organizerFounding: true, rail: 'LEDGER', currency: 'XRP', priceMinor: 20_000_000n })).toMatchObject({
      fanFeeMinor: 600_000n,
      promoApplied: true,
    })
  })

  it('does NOT apply to an organizer who is not flagged, even for an event inside the window', () => {
    expect(quote({ organizerFounding: false }).promoApplied).toBe(false)
  })

  describe('the window is the event\'s own local time, not UTC', () => {
    // St. Lucia is UTC-4 all year. Each instant below was worked out by hand.
    it('INCLUDES an 11 pm New Year\'s Eve St. Lucia fete, which is already 03:00 on 1 Jan in UTC', () => {
      const at = new Date('2028-01-01T03:00:00Z') // 2027-12-31 23:00 in St. Lucia
      expect(quote({ organizerFounding: true, eventStartsAt: at }).promoApplied).toBe(true)
    })

    it('EXCLUDES a 12:30 am 1 Jan St. Lucia event (04:30 UTC)', () => {
      const at = new Date('2028-01-01T04:30:00Z') // 2028-01-01 00:30 in St. Lucia
      expect(quote({ organizerFounding: true, eventStartsAt: at }).promoApplied).toBe(false)
    })

    it('EXCLUDES the stroke of midnight itself, and includes the second before it', () => {
      expect(quote({ organizerFounding: true, eventStartsAt: new Date('2028-01-01T04:00:00Z') }).promoApplied).toBe(false) // 00:00:00 local
      expect(quote({ organizerFounding: true, eventStartsAt: new Date('2028-01-01T03:59:59Z') }).promoApplied).toBe(true) // 23:59:59 local
    })

    it('INCLUDES a St. Lucia event at 20:00 on 31 Dec, which is exactly 00:00 on 1 Jan in UTC (a UTC rule would drop it)', () => {
      expect(quote({ organizerFounding: true, eventStartsAt: new Date('2028-01-01T00:00:00Z') }).promoApplied).toBe(true)
    })

    it('uses each event\'s own zone: 11:30 pm 31 Dec in Toronto (UTC-5, 04:30 UTC) is in, and is out for a St. Lucia event at that same instant', () => {
      const instant = new Date('2028-01-01T04:30:00Z')
      expect(quote({ organizerFounding: true, eventStartsAt: instant, eventTimeZone: 'America/Toronto', region: 'CANADA' }).promoApplied).toBe(true)
      expect(quote({ organizerFounding: true, eventStartsAt: instant, eventTimeZone: 'America/St_Lucia' }).promoApplied).toBe(false)
    })

    it('does not apply to anything in 2028 or later, however early it is on sale', () => {
      expect(quote({ organizerFounding: true, eventStartsAt: new Date('2028-06-01T12:00:00Z') }).promoApplied).toBe(false)
      expect(quote({ organizerFounding: true, eventStartsAt: new Date('2028-06-01T12:00:00Z') }).fanFeeMinor).toBe(247n)
    })

    it('refuses a time zone it does not know, rather than guessing', () => {
      expect(() => quote({ organizerFounding: true, eventTimeZone: 'Not/AZone' })).toThrow(/time zone/i)
    })
  })
})

describe('free tickets and comps', () => {
  it('pay no fan fee and no processing, on any rail, flagged or not', () => {
    const zero = { priceMinor: 0n, fanFeeMinor: 0n, processingMinor: 0n, allInMinor: 0n }
    expect(quote({ priceMinor: 0n })).toMatchObject(zero)
    expect(quote({ priceMinor: 0n, organizerFounding: true })).toMatchObject(zero)
    expect(quote({ priceMinor: 0n, rail: 'LEDGER', currency: 'XRP' })).toMatchObject(zero)
    expect(quote({ priceMinor: 0n, rail: 'LEDGER', currency: 'RLUSD' })).toMatchObject(zero)
  })

  it('can never be resold for money: the cap is what was paid, which was nothing', () => {
    const minimum = minimumResaleMinor({ currency: 'USD' })
    // Even at exactly the minimum price, a free ticket's cap of zero refuses it.
    expect(resaleTerms({ priceMinor: minimum, originalCostMinor: 0n, minimumMinor: minimum })).toEqual({ ok: false, reason: 'ABOVE_CAP' })
    expect(resaleTerms({ priceMinor: 100_000n, originalCostMinor: 0n, minimumMinor: minimum })).toEqual({ ok: false, reason: 'ABOVE_CAP' })
  })
})

describe('a resale, with the fee paid by the seller', () => {
  const MIN_RLUSD = 5_000_000n

  it('10 pays 0.5: the sell offer is 9.5, the bid is exactly 10, the buyer pays what the page showed', () => {
    // 10_000_000 x 500 / 10000 = 500_000.
    expect(resaleTerms({ priceMinor: 10_000_000n, originalCostMinor: 10_000_000n, minimumMinor: MIN_RLUSD })).toEqual({
      ok: true,
      feeMinor: 500_000n,
      sellOfferMinor: 9_500_000n,
      buyerPaysMinor: 10_000_000n,
    })
  })

  it('floors the fee: 101 drops pays 5, not 6', () => {
    expect(resaleTerms({ priceMinor: 101n, originalCostMinor: 1_000n, minimumMinor: 1n })).toMatchObject({
      ok: true,
      feeMinor: 5n,
      sellOfferMinor: 96n,
      buyerPaysMinor: 101n,
    })
  })

  it('turns resale off below the minimum, and allows exactly the minimum', () => {
    expect(resaleTerms({ priceMinor: 4_999_999n, originalCostMinor: 10_000_000n, minimumMinor: MIN_RLUSD })).toEqual({
      ok: false,
      reason: 'BELOW_MINIMUM',
    })
    expect(resaleTerms({ priceMinor: MIN_RLUSD, originalCostMinor: 10_000_000n, minimumMinor: MIN_RLUSD }).ok).toBe(true)
  })

  it('caps the price at the all-in amount the first buyer paid, inclusive', () => {
    expect(resaleTerms({ priceMinor: 10_000_001n, originalCostMinor: 10_000_000n, minimumMinor: MIN_RLUSD })).toEqual({
      ok: false,
      reason: 'ABOVE_CAP',
    })
    expect(resaleTerms({ priceMinor: 10_000_000n, originalCostMinor: 10_000_000n, minimumMinor: MIN_RLUSD }).ok).toBe(true)
  })

  it('the cap is the whole all-in price, processing included: a card buyer who paid 3890 may resell at 3890, not 3891', () => {
    expect(resaleTerms({ priceMinor: 3890n, originalCostMinor: 3890n, minimumMinor: 500n }).ok).toBe(true)
    expect(resaleTerms({ priceMinor: 3891n, originalCostMinor: 3890n, minimumMinor: 500n })).toEqual({ ok: false, reason: 'ABOVE_CAP' })
  })

  it('conservation: for any allowed price the buyer pays the price, the offer plus the fee IS the price, and the seller still nets something after the highest royalty', () => {
    let seed = 7
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648)
    for (let i = 0; i < 3000; i += 1) {
      const price = BigInt(5_000_000 + (rand() % 900_000_000))
      const t = resaleTerms({ priceMinor: price, originalCostMinor: price, minimumMinor: MIN_RLUSD })
      if (!t.ok) throw new Error('an allowed price was refused')
      expect(t.buyerPaysMinor).toBe(price)
      expect(t.sellOfferMinor + t.feeMinor).toBe(price)
      expect(t.feeMinor).toBe((price * 500n) / 10_000n)
      // The ledger takes the royalty from the sell offer; at the 20% maximum the seller still keeps most of it.
      const royalty = (t.sellOfferMinor * 2000n) / 10_000n
      expect(t.sellOfferMinor - royalty).toBeGreaterThan(0n)
    }
  })

  it('the buyer\'s total never exceeds the price: no fee is added on top, which is what keeps the Ontario cap simple', () => {
    const t = resaleTerms({ priceMinor: 12_345_678n, originalCostMinor: 20_000_000n, minimumMinor: MIN_RLUSD })
    expect(t.ok && t.buyerPaysMinor).toBe(12_345_678n)
  })
})

describe('the US$5 floor in the sale\'s own currency', () => {
  it('is 500 cents in USD and 5 RLUSD in RLUSD', () => {
    expect(minimumResaleMinor({ currency: 'USD' })).toBe(500n)
    expect(minimumResaleMinor({ currency: 'RLUSD' })).toBe(5_000_000n)
  })

  it('in XRP needs the price at listing time, and rounds UP so a borderline price is refused', () => {
    // 500 cents at 134 cents per XRP = 3.7313433 XRP = 3_731_343.28 drops, rounded up.
    expect(minimumResaleMinor({ currency: 'XRP', xrpUsdCents: 134n })).toBe(3_731_344n)
    expect(minimumResaleMinor({ currency: 'XRP', xrpUsdCents: 100n })).toBe(5_000_000n)
  })

  it('refuses to guess an XRP floor without a price', () => {
    expect(() => minimumResaleMinor({ currency: 'XRP' })).toThrow(/price/i)
  })
})

describe('what an organizer is shown', () => {
  it('a 5% royalty with the 5% resale fee paid first really pays 4.75%', () => {
    expect(effectiveRoyaltyBps(500, 500)).toBe(475)
  })

  it('and 20% pays 19%', () => {
    expect(effectiveRoyaltyBps(2000, 500)).toBe(1900)
  })

  it('is the nominal rate when there is no resale fee', () => {
    expect(effectiveRoyaltyBps(500, 0)).toBe(500)
  })
})

describe('integration, written alongside the implementation once these are approved', () => {
  it.todo('a resale listing created after the change is SELLER_PAYS_V2 and stores the schedule it was quoted under')
  it.todo('changing the schedule afterwards does not change an existing listing, V1 or V2')
  it.todo('an existing buyer-pays (V1) listing settles to exactly what it was quoted: golden values from today\'s suites')
  it.todo('a V2 resale settles on the stub ledger with sell offer = price - fee, bid = price, broker fee = fee')
  it.todo('an auction settles with the 5% seller-pays arithmetic it already uses')
  it.todo('an on-ledger first-time sale (price + fee, broker fee) uses the primary schedule, XRP-priced is bps only')
  it.todo('a card sale records Ticket.originalCostMinor as the all-in amount paid, processing included')
  it.todo('a free ticket can be gifted and transferred but a money listing is refused with the cap reason')
  it.todo('resale below the US$5 floor is refused, and gifting the same ticket still works')
  it.todo('the all-in price returned by the API equals what the card charge uses (one function)')
  it.todo('only an admin can flag an organizer as founding; a normal organizer cannot set it on themselves')
})
