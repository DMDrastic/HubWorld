/**
 * The guard on the dangerous permission.
 *
 * `NFTokenCreateOffer` delegated to Hubworld can list any ticket in an
 * organizer's account at any price to any destination — the ledger cannot narrow
 * it. `checkSellOffer` is what does, on the exact transaction before it is signed,
 * so every clause is pinned on its own: a clause that stopped being checked would
 * not fail loudly, it would quietly widen what every organizer agreed to.
 */
import { Wallet } from 'xrpl'
import { describe, expect, it } from 'vitest'
import {
  FEE_HEADROOM_DROPS,
  HOLD_GRACE_MS,
  HOLD_MS,
  MAX_CONCURRENT_HOLDS,
  checkSellOffer,
  checkoutRoom,
  holdReclaimable,
  type OfferTx,
} from '../src/primary-sale-policy.js'
import { makeNftId } from './nft-id.js'

const ORGANIZER = Wallet.generate().classicAddress
const BROKER = Wallet.generate().classicAddress
const OTHER = Wallet.generate().classicAddress
const TAXON = 4321
const NFT = makeNftId(ORGANIZER, TAXON)
const PRICE = 25_000_000n

const good: OfferTx = {
  TransactionType: 'NFTokenCreateOffer',
  Account: ORGANIZER,
  NFTokenID: NFT,
  Amount: PRICE.toString(),
  Destination: BROKER,
  Flags: 1,
}
const expected = { organizerAddress: ORGANIZER, brokerAddress: BROKER, priceDrops: PRICE, eventTaxon: TAXON, nfTokenId: NFT }

const refused = (tx: OfferTx, over: Partial<typeof expected> = {}) => {
  const v = checkSellOffer(tx, { ...expected, ...over })
  return v.ok ? null : v.reason
}

describe('checkSellOffer', () => {
  it('accepts exactly the offer the checkout asked for', () => {
    expect(checkSellOffer(good, expected)).toEqual({ ok: true })
  })

  it('refuses an offer that is not restricted to the broker', () => {
    // Open, anyone could take the ticket directly and skip the platform fee.
    expect(refused({ ...good, Destination: undefined })).toMatch(/restricted to the broker/)
    // Destined for someone else — including the delegate itself, which would be a gift.
    expect(refused({ ...good, Destination: OTHER })).toMatch(/restricted to the broker/)
  })

  it('refuses anything but a sell offer', () => {
    expect(refused({ ...good, Flags: 0 })).toMatch(/not a sell offer/)
    expect(refused({ ...good, Flags: undefined })).toMatch(/not a sell offer/)
    // The object form of flags is not a plain number, so it is not trusted.
    expect(refused({ ...good, Flags: { tfSellNFToken: true } })).toMatch(/not a sell offer/)
    // The sell bit survives alongside others.
    expect(checkSellOffer({ ...good, Flags: 1 | 2 }, expected)).toEqual({ ok: true })
  })

  it('refuses another transaction type', () => {
    expect(refused({ ...good, TransactionType: 'Payment' })).toMatch(/not an offer/)
    expect(refused({ ...good, TransactionType: 'NFTokenAcceptOffer' })).toMatch(/not an offer/)
  })

  it('refuses an offer created as anyone but the organizer', () => {
    expect(refused({ ...good, Account: OTHER })).toMatch(/not created as the organizer/)
  })

  it('refuses a price below the ticket price, and a free offer', () => {
    expect(refused({ ...good, Amount: (PRICE - 1n).toString() })).toMatch(/below the ticket price/)
    expect(refused({ ...good, Amount: '0' }, { priceDrops: 0n })).toMatch(/below the ticket price/)
    // At the price exactly, and above it, is fine (the surplus goes to the seller).
    expect(checkSellOffer({ ...good, Amount: PRICE.toString() }, expected)).toEqual({ ok: true })
    expect(checkSellOffer({ ...good, Amount: (PRICE + 1n).toString() }, expected)).toEqual({ ok: true })
  })

  it('refuses an amount that is not plain XRP drops', () => {
    expect(refused({ ...good, Amount: { currency: 'USD', issuer: OTHER, value: '99999' } })).toMatch(/not an XRP amount/)
    expect(refused({ ...good, Amount: { mpt_issuance_id: 'AB', value: '1' } })).toMatch(/not an XRP amount/)
    expect(refused({ ...good, Amount: '12.5' })).toMatch(/not an XRP amount/)
    expect(refused({ ...good, Amount: undefined })).toMatch(/not an XRP amount/)
  })

  it('refuses any ticket but the one the checkout claimed', () => {
    expect(refused({ ...good, NFTokenID: makeNftId(ORGANIZER, TAXON, 2) })).toMatch(/not for the claimed ticket/)
  })

  it('refuses a ticket the organizer did not issue', () => {
    // The delegate can reach every NFT in the account, including ones received
    // from somebody else.
    const foreign = makeNftId(OTHER, TAXON)
    expect(refused({ ...good, NFTokenID: foreign }, { nfTokenId: foreign })).toMatch(/not issued by the organizer/)
  })

  it('refuses a ticket from a different event', () => {
    const otherEvent = makeNftId(ORGANIZER, TAXON + 1)
    expect(refused({ ...good, NFTokenID: otherEvent }, { nfTokenId: otherEvent })).toMatch(/does not belong to this event/)
  })

  it('refuses an id that is not an NFTokenID at all', () => {
    expect(refused({ ...good, NFTokenID: 'nonsense' }, { nfTokenId: 'nonsense' })).toMatch(/not a valid NFTokenID/)
  })
})

describe('checkoutRoom', () => {
  const INC = 200_000n

  it('has room until the concurrent-hold ceiling, exclusive', () => {
    const ok = { spendableDrops: 10_000_000n, reserveIncDrops: INC }
    expect(checkoutRoom({ ...ok, openHolds: MAX_CONCURRENT_HOLDS - 1 })).toEqual({ ok: true })
    expect(checkoutRoom({ ...ok, openHolds: MAX_CONCURRENT_HOLDS })).toEqual({ ok: false, reason: 'busy' })
  })

  it('needs one more reserve increment plus fee headroom, to the drop', () => {
    const need = INC + FEE_HEADROOM_DROPS
    expect(checkoutRoom({ openHolds: 0, spendableDrops: need, reserveIncDrops: INC })).toEqual({ ok: true })
    expect(checkoutRoom({ openHolds: 0, spendableDrops: need - 1n, reserveIncDrops: INC })).toEqual({
      ok: false,
      reason: 'organizer-underfunded',
    })
  })

  it('bounds the reserve a rush can lock to a small multiple, not the whole event', () => {
    // 100 concurrent x 0.2 XRP = 20 XRP, against ~200 XRP to list 1,000 up front.
    expect(BigInt(MAX_CONCURRENT_HOLDS) * INC).toBe(20_000_000n)
  })
})

describe('holdReclaimable', () => {
  const expiresAt = new Date('2026-10-19T12:00:00Z')
  const at = (ms: number) => new Date(expiresAt.getTime() + ms)

  it('waits out expiry plus a grace period, to the millisecond', () => {
    expect(holdReclaimable({ expiresAt, now: at(HOLD_GRACE_MS), buyerSigned: false })).toBe(false)
    expect(holdReclaimable({ expiresAt, now: at(HOLD_GRACE_MS + 1), buyerSigned: false })).toBe(true)
    expect(holdReclaimable({ expiresAt, now: at(-1000), buyerSigned: false })).toBe(false)
  })

  it('never reclaims under a live signature', () => {
    expect(holdReclaimable({ expiresAt, now: at(HOLD_GRACE_MS * 100), buyerSigned: true })).toBe(false)
  })

  it('a hold lasts about as long as a signing request', () => {
    expect(HOLD_MS).toBe(5 * 60 * 1000)
  })
})
