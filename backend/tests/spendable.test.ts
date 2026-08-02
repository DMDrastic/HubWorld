/**
 * Reserve arithmetic.
 *
 * A buy-offer bid does not lock funds, so the only defence against a bid the
 * bidder cannot honour is checking what they can actually spend. That is NOT the
 * account balance: XRPL withholds a base reserve plus an increment for every
 * object owned, so an account holding an NFT and a few open offers can look
 * wealthy and be unable to pay.
 */
import { describe, expect, it } from 'vitest'
import { bidHeadroom, spendableFrom } from '../src/ledger.js'

const XRP = 1_000_000n
// Current testnet values, confirmed from server_info.
const NET = { reserveBaseXrp: 1, reserveIncXrp: 0.2 }

describe('spendableFrom', () => {
  it('subtracts the base reserve from an account owning nothing', () => {
    expect(spendableFrom({ balanceDrops: 100n * XRP, ownerCount: 0, ...NET })).toBe(99n * XRP)
  })

  it('subtracts an increment for each owned object', () => {
    // @pot's real shape: 100 XRP holding one NFT -> 1 + 0.2 reserved.
    expect(spendableFrom({ balanceDrops: 100n * XRP, ownerCount: 1, ...NET })).toBe(98_800_000n)
    expect(spendableFrom({ balanceDrops: 100n * XRP, ownerCount: 5, ...NET })).toBe(98_000_000n)
  })

  it('clamps to zero rather than reporting a negative balance', () => {
    // An account can sit below its reserve; it has nothing spendable, not less
    // than nothing, and a negative would sail through a `< amount` comparison.
    expect(spendableFrom({ balanceDrops: 500_000n, ownerCount: 0, ...NET })).toBe(0n)
    expect(spendableFrom({ balanceDrops: 0n, ownerCount: 3, ...NET })).toBe(0n)
  })

  it('reads reserve values from the network rather than assuming them', () => {
    // Reserves are network parameters and have changed historically, so a
    // different setting must be honoured.
    expect(
      spendableFrom({
        balanceDrops: 100n * XRP,
        ownerCount: 2,
        reserveBaseXrp: 10,
        reserveIncXrp: 2,
      }),
    ).toBe(86n * XRP)
  })

  it('stays exact on amounts beyond a JS number', () => {
    const huge = 90_000_000_000n * XRP
    expect(spendableFrom({ balanceDrops: huge, ownerCount: 0, ...NET })).toBe(huge - 1n * XRP)
  })

  it('handles a fractional increment without floating-point drift', () => {
    // 0.2 XRP is not representable in binary floating point; the conversion
    // rounds to whole drops so the result must be exact.
    expect(spendableFrom({ balanceDrops: 10n * XRP, ownerCount: 3, ...NET })).toBe(8_400_000n)
  })
})

/**
 * Headroom is a different question from affordability, and the gap between them
 * is where money was actually lost: `spendable >= amount` accepts a bid that
 * cannot possibly settle, because the buy offer is itself an owned object and
 * paying for it lowers spendable the instant the bid exists.
 */
describe('bidHeadroom', () => {
  const INC = 200_000n // 0.2 XRP, the current owner reserve increment

  it('leaves the bid amount plus the offer reserve behind', () => {
    const h = bidHeadroom({ spendableDrops: 100n * XRP, reserveIncDrops: INC, amountDrops: 10n * XRP })
    expect(h.affordable).toBe(true)
    // 100 - 10 - 0.2
    expect(h.afterBidDrops).toBe(89_800_000n)
    expect(h.tight).toBe(false)
  })

  /**
   * The bug this function exists for. Bidding the whole spendable balance used
   * to pass `spendable < amount`, and was then guaranteed to fail at settlement
   * — short by exactly the reserve the bid's own offer locked.
   */
  it('refuses a bid of the entire spendable balance', () => {
    const h = bidHeadroom({ spendableDrops: 50n * XRP, reserveIncDrops: INC, amountDrops: 50n * XRP })
    expect(h.affordable).toBe(false)
    expect(h.afterBidDrops).toBe(-INC) // short by exactly the increment
    expect(h.tight).toBe(false) // never a warning when it is a refusal
  })

  it('accepts the largest bid that still covers the offer reserve', () => {
    // The boundary is exact: one drop more and the offer cannot be paid for.
    const spendableDrops = 50n * XRP
    const exact = bidHeadroom({ spendableDrops, reserveIncDrops: INC, amountDrops: spendableDrops - INC })
    expect(exact.affordable).toBe(true)
    expect(exact.afterBidDrops).toBe(0n)

    const oneMore = bidHeadroom({
      spendableDrops,
      reserveIncDrops: INC,
      amountDrops: spendableDrops - INC + 1n,
    })
    expect(oneMore.affordable).toBe(false)
  })

  it('warns when under a tenth of the bid is left', () => {
    // 10 XRP bid leaving 0.9 XRP: any ordinary spend breaks the commitment, and
    // settlement then falls through to the runner-up.
    const tight = bidHeadroom({
      spendableDrops: 11_100_000n,
      reserveIncDrops: INC,
      amountDrops: 10n * XRP,
    })
    expect(tight.affordable).toBe(true)
    expect(tight.afterBidDrops).toBe(900_000n)
    expect(tight.tight).toBe(true)

    // Exactly a tenth is not tight — the boundary is strict.
    const boundary = bidHeadroom({
      spendableDrops: 11_200_000n,
      reserveIncDrops: INC,
      amountDrops: 10n * XRP,
    })
    expect(boundary.afterBidDrops).toBe(1n * XRP)
    expect(boundary.tight).toBe(false)
  })

  it('treats a zero balance as unaffordable rather than merely tight', () => {
    const h = bidHeadroom({ spendableDrops: 0n, reserveIncDrops: INC, amountDrops: 1n })
    expect(h.affordable).toBe(false)
    expect(h.tight).toBe(false)
  })

  it('honours a network increment other than 0.2 XRP', () => {
    // The increment is a network parameter and has changed historically, so it
    // must come from the caller rather than being assumed here.
    const h = bidHeadroom({ spendableDrops: 10n * XRP, reserveIncDrops: 2n * XRP, amountDrops: 8n * XRP })
    expect(h.affordable).toBe(true)
    expect(h.afterBidDrops).toBe(0n)
  })

  it('stays exact on amounts beyond a JS number', () => {
    const huge = 90_000_000_000n * XRP
    const h = bidHeadroom({ spendableDrops: huge, reserveIncDrops: INC, amountDrops: huge / 2n })
    expect(h.afterBidDrops).toBe(huge / 2n - INC)
    expect(h.tight).toBe(false)
  })
})
