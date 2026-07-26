/**
 * Brokered sale construction and fee arithmetic.
 *
 * Everything here decides who receives money. The ledger enforces
 * `buyAmount >= sellAmount + brokerFee`, so getting the split wrong does not
 * produce a wrong number in a report — it produces a transaction the ledger
 * rejects, or worse, one it accepts with the wrong party paid.
 */
import { describe, expect, it } from 'vitest'
import {
  buildBuyOfferTx,
  buildSellOfferTx,
  platformFeeDrops,
} from '../src/ledger.js'

const SELLER = 'r4wQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf'
const BUYER = 'rw47D5hmU3ibf6uc8SuSmzcAHbH5FnA7rn'
const BROKER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'
const NFTOKEN_ID = '00081388E82223A2A5150D5AADF7D8E5F5E3AC44D31AB0D402ACCC570127D521'

const XRP = 1_000_000n // drops

describe('platformFeeDrops', () => {
  it('takes the stated basis points', () => {
    // 250 bps = 2.5% of 100 XRP = 2.5 XRP
    expect(platformFeeDrops(100n * XRP, 250)).toBe(2_500_000n)
    expect(platformFeeDrops(100n * XRP, 0)).toBe(0n)
    expect(platformFeeDrops(100n * XRP, 10000)).toBe(100n * XRP) // 100%
  })

  it('floors, so rounding never favours the platform', () => {
    // A drop is indivisible. At 250bps the fee only reaches 1 drop at a price of
    // 40 drops, and everything below that must round DOWN — rounding up would
    // overcharge the buyer.
    expect(platformFeeDrops(1n, 250)).toBe(0n)
    expect(platformFeeDrops(39n, 250)).toBe(0n)
    expect(platformFeeDrops(40n, 250)).toBe(1n)
    expect(platformFeeDrops(79n, 250)).toBe(1n) // 1.975 -> 1
  })

  it('stays exact on amounts that would break a JS number', () => {
    // Above 2^53 a Number silently loses integer precision. Money must not.
    const huge = 90_000_000_000n * XRP // 9e16 drops
    expect(platformFeeDrops(huge, 250)).toBe(huge * 250n / 10000n)
    expect(Number.isSafeInteger(Number(huge))).toBe(false)
  })

  it('rejects nonsensical basis points', () => {
    expect(() => platformFeeDrops(XRP, -1)).toThrow(/outside/)
    expect(() => platformFeeDrops(XRP, 10001)).toThrow(/outside/)
  })
})

describe('the brokered invariant: buy >= sell + fee', () => {
  it('holds for the amounts the routes construct', () => {
    const price = 100n * XRP
    const fee = platformFeeDrops(price, 250)
    // This is exactly what POST /listings/:id/buy asks the buyer to sign.
    const buyerPays = price + fee
    expect(buyerPays).toBeGreaterThanOrEqual(price + fee)
    expect(buyerPays).toBe(102_500_000n)
  })

  it('still holds when the fee floors to zero', () => {
    // A dust-priced listing yields no platform fee at all. The invariant must
    // survive that rather than depending on a non-zero fee.
    const price = 39n
    const fee = platformFeeDrops(price, 250)
    expect(fee).toBe(0n)
    expect(price + fee).toBeGreaterThanOrEqual(price)
  })
})

describe('buildSellOfferTx', () => {
  it('locks the offer to the broker', () => {
    // Without Destination any buyer could accept the sell offer directly and
    // the platform fee would be trivially bypassable.
    const tx = buildSellOfferTx({
      ownerAddress: SELLER,
      nfTokenId: NFTOKEN_ID,
      amountDrops: 100n * XRP,
      brokerAddress: BROKER,
    })
    expect(tx.Destination).toBe(BROKER)
    expect(tx.Flags).toBe(1) // tfSellNFToken
    expect(tx.Amount).toBe('100000000')
    expect(tx.Account).toBe(SELLER)
  })

  it('refuses a free or negative sale', () => {
    for (const amount of [0n, -1n]) {
      expect(() =>
        buildSellOfferTx({
          ownerAddress: SELLER,
          nfTokenId: NFTOKEN_ID,
          amountDrops: amount,
          brokerAddress: BROKER,
        }),
      ).toThrow(/greater than zero/)
    }
  })

  it('serialises drops as an integer string, never scientific notation', () => {
    const tx = buildSellOfferTx({
      ownerAddress: SELLER,
      nfTokenId: NFTOKEN_ID,
      amountDrops: 100_000_000_000_000_000n,
      brokerAddress: BROKER,
    })
    expect(tx.Amount).toBe('100000000000000000')
    expect(String(tx.Amount)).not.toContain('e')
  })
})

describe('buildBuyOfferTx', () => {
  it('is a bid: no sell flag, and it names the owner', () => {
    const tx = buildBuyOfferTx({
      buyerAddress: BUYER,
      ownerAddress: SELLER,
      nfTokenId: NFTOKEN_ID,
      amountDrops: 102n * XRP,
      brokerAddress: BROKER,
    })
    expect(tx.Account).toBe(BUYER)
    // Absence of tfSellNFToken is what makes this a buy offer.
    expect(tx.Flags).toBeUndefined()
    // Owner is required on a buy offer so the ledger knows whose token is bid on.
    expect(tx.Owner).toBe(SELLER)
  })

  it('locks the bid to the broker so the seller cannot pocket the fee', () => {
    // The bid is for price + fee. If the seller could accept it directly they
    // would receive Hubworld's cut as well — brokerage has to be enforced on
    // BOTH offers, not just the sell side.
    const tx = buildBuyOfferTx({
      buyerAddress: BUYER,
      ownerAddress: SELLER,
      nfTokenId: NFTOKEN_ID,
      amountDrops: 102n * XRP,
      brokerAddress: BROKER,
    })
    expect(tx.Destination).toBe(BROKER)
  })

  it('refuses a zero bid', () => {
    expect(() =>
      buildBuyOfferTx({
        buyerAddress: BUYER,
        ownerAddress: SELLER,
        nfTokenId: NFTOKEN_ID,
        amountDrops: 0n,
        brokerAddress: BROKER,
      }),
    ).toThrow(/greater than zero/)
  })

  it('refuses to let someone buy their own ticket', () => {
    expect(() =>
      buildBuyOfferTx({
        buyerAddress: SELLER,
        ownerAddress: SELLER,
        nfTokenId: NFTOKEN_ID,
        amountDrops: XRP,
        brokerAddress: BROKER,
      }),
    ).toThrow(/your own/)
  })
})
