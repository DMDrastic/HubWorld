/**
 * Which broker a listing's offers name.
 *
 * Both the sell offer and the buy offer carry `Destination` = the broker, and
 * ONLY that account can match them. So the pair must agree. If the seller's
 * offer names broker A and the buyer's names broker B, nothing is wrong at
 * submission time — both transactions succeed — and the sale simply becomes
 * unsettleable, discovered later by a settlement that can never work.
 *
 * That is why the broker is recorded on the Listing rather than resolved
 * globally at each step. Resolving it globally is correct only while
 * `PLATFORM_SEED` has never changed; the moment it rotates, every live offer
 * names an account we no longer use, and nothing in our data says which.
 *
 * These tests pin the resolution rule itself, without a database or a network,
 * because the rule is the part that decides whether a sale can ever settle.
 */
import { describe, expect, it } from 'vitest'
import { buildBuyOfferTx, buildSellOfferTx } from '../src/ledger.js'

const SELLER = 'r4wQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf'
const BUYER = 'rw47D5hmU3ibf6uc8SuSmzcAHbH5FnA7rn'
const NFTOKEN_ID = '00081388E82223A2A5150D5AADF7D8E5F5E3AC44D31AB0D402ACCC570127D521'

/** The broker in use when the listing was created. */
const BROKER_THEN = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'
/** A different platform key, as after a rotation. */
const BROKER_NOW = 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w'

/** Exactly the expression the buy routes use. */
const resolve = (recorded: string | null, current: string) => recorded ?? current

describe('a listing records the broker its offers name', () => {
  it('sends both sides to the same destination', () => {
    const sell = buildSellOfferTx({
      ownerAddress: SELLER,
      nfTokenId: NFTOKEN_ID,
      amountDrops: 10_000_000n,
      brokerAddress: BROKER_THEN,
    })
    const buy = buildBuyOfferTx({
      buyerAddress: BUYER,
      ownerAddress: SELLER,
      nfTokenId: NFTOKEN_ID,
      amountDrops: 10_250_000n,
      brokerAddress: resolve(BROKER_THEN, BROKER_NOW),
    })

    expect(sell.Destination).toBe(BROKER_THEN)
    expect(buy.Destination).toBe(BROKER_THEN)
    // The property that actually matters — brokerage is only possible when one
    // account can take both offers.
    expect(buy.Destination).toBe(sell.Destination)
  })

  /**
   * The regression this column exists for. A key rotation between listing and
   * purchase used to send the buyer's offer to the NEW broker while the
   * seller's already named the old one. Both transactions succeed; the sale
   * silently becomes impossible to settle.
   */
  it('survives a platform key rotation between listing and purchase', () => {
    const sell = buildSellOfferTx({
      ownerAddress: SELLER,
      nfTokenId: NFTOKEN_ID,
      amountDrops: 10_000_000n,
      brokerAddress: BROKER_THEN,
    })

    // The buyer arrives after rotation. Resolving "the broker" globally now
    // would give BROKER_NOW and strand the pair.
    const buy = buildBuyOfferTx({
      buyerAddress: BUYER,
      ownerAddress: SELLER,
      nfTokenId: NFTOKEN_ID,
      amountDrops: 10_250_000n,
      brokerAddress: resolve(BROKER_THEN, BROKER_NOW),
    })

    expect(buy.Destination).toBe(BROKER_THEN)
    expect(buy.Destination).not.toBe(BROKER_NOW)
    expect(buy.Destination).toBe(sell.Destination)
  })

  /**
   * Rows written before the column existed carry null. Falling back to the
   * current address is right for them, because they were created under a key
   * that has not changed yet — and `npm run broker:backfill` stamps them so the
   * fallback stops being load-bearing before any rotation.
   */
  it('falls back to the current broker for pre-column listings', () => {
    expect(resolve(null, BROKER_NOW)).toBe(BROKER_NOW)
  })

  it('prefers the recorded broker over the current one whenever it exists', () => {
    expect(resolve(BROKER_THEN, BROKER_NOW)).toBe(BROKER_THEN)
    // Including when they happen to agree — no special-casing.
    expect(resolve(BROKER_NOW, BROKER_NOW)).toBe(BROKER_NOW)
  })
})
