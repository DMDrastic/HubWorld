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
import { spendableFrom } from '../src/ledger.js'

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
