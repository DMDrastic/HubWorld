/**
 * TODAY'S fee behaviour, pinned as literal numbers BEFORE the fee model changes.
 *
 * Why this exists: the new model (seller-pays resale, a fan fee on first sales) must not alter what
 * is already live. Existing listings were created under "the buyer pays the fee on top" and have
 * their fee frozen; they must settle to exactly what they were quoted. These values were captured by
 * RUNNING the current `platformFeeDrops`, `auctionSellAmountDrops` and `maxAskForCap` on
 * 2026-10-31 and pasted here as literals. Do not regenerate them from the code under test: a golden
 * table that is recomputed from the thing it guards can never fail.
 *
 * If one of these fails after the change, the old behaviour moved. That is either a bug or a decision
 * to change what already-quoted listings pay, and it must not happen silently.
 *
 * The flows built on these numbers are pinned by existing suites, which must also pass UNCHANGED
 * through the whole fee work: sale.test.ts, listing-advance.test.ts, listing-withdrawal.test.ts,
 * stale-listing-guard.test.ts, resale-cap.routes.test.ts, resale-policy.test.ts, primary-sale.test.ts,
 * auction-open.test.ts, auction-settlement.test.ts and settlement.integration.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { auctionSellAmountDrops, platformFeeDrops } from '../src/ledger.js'
import { maxAskForCap } from '../src/resale-policy.js'

const PRICES = [1n, 2n, 99n, 100n, 101n, 9999n, 10000n, 1000000n, 12345678n, 20000000n, 999999999n, 1152921504606846983n]
const BPS = [0, 1, 250, 500, 1000]

/** platformFeeDrops(price, bps), floored. Columns follow PRICES. */
const FEE: Record<number, bigint[]> = {
  0: [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
  1: [0n, 0n, 0n, 0n, 0n, 0n, 1n, 100n, 1234n, 2000n, 99999n, 115292150460684n],
  250: [0n, 0n, 2n, 2n, 2n, 249n, 250n, 25000n, 308641n, 500000n, 24999999n, 28823037615171174n],
  500: [0n, 0n, 4n, 5n, 5n, 499n, 500n, 50000n, 617283n, 1000000n, 49999999n, 57646075230342349n],
  1000: [0n, 0n, 9n, 10n, 10n, 999n, 1000n, 100000n, 1234567n, 2000000n, 99999999n, 115292150460684698n],
}

/** auctionSellAmountDrops(reserve, bps): the reserve minus the fee, never below one drop. */
const AUCTION_SELL: Record<number, bigint[]> = {
  0: [1n, 2n, 99n, 100n, 101n, 9999n, 10000n, 1000000n, 12345678n, 20000000n, 999999999n, 1152921504606846983n],
  1: [1n, 2n, 99n, 100n, 101n, 9999n, 9999n, 999900n, 12344444n, 19998000n, 999900000n, 1152806212456386299n],
  250: [1n, 2n, 97n, 98n, 99n, 9750n, 9750n, 975000n, 12037037n, 19500000n, 975000000n, 1124098466991675809n],
  500: [1n, 2n, 95n, 95n, 96n, 9500n, 9500n, 950000n, 11728395n, 19000000n, 950000000n, 1095275429376504634n],
  1000: [1n, 2n, 90n, 90n, 91n, 9000n, 9000n, 900000n, 11111111n, 18000000n, 900000000n, 1037629354146162285n],
}

/** maxAskForCap(maxTotal, bps): the largest ask whose ask + fee stays within the cap. */
const MAX_ASK: Record<number, bigint[]> = {
  0: [1n, 2n, 99n, 100n, 101n, 9999n, 10000n, 1000000n, 12345678n, 20000000n, 999999999n, 1152921504606846983n],
  1: [0n, 1n, 98n, 99n, 100n, 9998n, 9999n, 999900n, 12344443n, 19998000n, 999900008n, 1152806223984448538n],
  250: [0n, 1n, 96n, 97n, 98n, 9755n, 9756n, 975609n, 12044563n, 19512195n, 975609755n, 1124801467909119007n],
  500: [0n, 1n, 94n, 95n, 96n, 9522n, 9523n, 952380n, 11757788n, 19047619n, 952380951n, 1098020480577949507n],
  1000: [0n, 1n, 90n, 90n, 91n, 9090n, 9090n, 909090n, 11223343n, 18181818n, 909090908n, 1048110458733497257n],
}

describe('the fee as it is today (buyer pays on top)', () => {
  for (const bps of BPS) {
    it(`platformFeeDrops at ${bps} bps matches the captured values for every price`, () => {
      expect(PRICES.map((p) => platformFeeDrops(p, bps))).toEqual(FEE[bps])
    })

    it(`auctionSellAmountDrops at ${bps} bps matches the captured values`, () => {
      expect(PRICES.map((p) => auctionSellAmountDrops(p, bps))).toEqual(AUCTION_SELL[bps])
    })

    it(`maxAskForCap at ${bps} bps matches the captured values`, () => {
      expect(PRICES.map((p) => maxAskForCap(p, bps))).toEqual(MAX_ASK[bps])
    })
  }

  it('is the arithmetic the live listings were quoted with: 250 bps on 20 XRP is 0.5 XRP, so the buyer pays 20.5', () => {
    const price = 20_000_000n
    const fee = platformFeeDrops(price, 250)
    expect(fee).toBe(500_000n)
    expect(price + fee).toBe(20_500_000n)
  })

  it('rounds against HubWorld: a sub-drop fee is zero, never rounded up', () => {
    expect(platformFeeDrops(39n, 250)).toBe(0n)
    expect(platformFeeDrops(40n, 250)).toBe(1n)
  })
})
