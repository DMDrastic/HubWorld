/**
 * Ledger transaction construction.
 *
 * These are the values that decide who gets paid and whether a ticket can move
 * at all. A wrong constant here is not a crash — it is a silently wrong royalty
 * or an NFT permanently stuck with its issuer, discovered only on mainnet.
 */
import { describe, expect, it } from 'vitest'
import { convertStringToHex } from 'xrpl'
import {
  bpsToTransferFee,
  buildAcceptOfferTx,
  buildCancelOfferTx,
  buildGiftOfferTx,
  buildMintTx,
} from '../src/ledger.js'

const ISSUER = 'r4wQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf'
const OTHER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'
const NFTOKEN_ID = '00081388E82223A2A5150D5AADF7D8E5F5E3AC44D31AB0D402ACCC570127D521'
const OFFER_INDEX = 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90'

describe('bpsToTransferFee', () => {
  // XRPL TransferFee is units of 1/100_000; our royalties are basis points.
  it('scales basis points by 10', () => {
    expect(bpsToTransferFee(0)).toBe(0)
    expect(bpsToTransferFee(1)).toBe(10)
    expect(bpsToTransferFee(500)).toBe(5000) // 5%
    expect(bpsToTransferFee(5000)).toBe(50000) // 50%, the ledger maximum
  })

  it('rejects anything above the 50% ceiling', () => {
    expect(() => bpsToTransferFee(5001)).toThrow(/outside/)
    expect(() => bpsToTransferFee(10000)).toThrow(/outside/)
  })

  it('rejects negative royalties', () => {
    expect(() => bpsToTransferFee(-1)).toThrow(/outside/)
  })
})

describe('buildMintTx', () => {
  it('sets tfTransferable', () => {
    // Without flag 8 the NFT can only ever move to or from the issuer, which
    // would make both gifting and resale impossible.
    expect(buildMintTx({ issuerAddress: ISSUER, taxon: 1003, royaltyBps: 500 }).Flags).toBe(8)
  })

  it('mints from the issuer with the event taxon', () => {
    const tx = buildMintTx({ issuerAddress: ISSUER, taxon: 1003, royaltyBps: 500 })
    expect(tx.TransactionType).toBe('NFTokenMint')
    expect(tx.Account).toBe(ISSUER)
    expect(tx.NFTokenTaxon).toBe(1003)
    expect(tx.TransferFee).toBe(5000)
  })

  it('omits TransferFee entirely at zero royalty', () => {
    // A TransferFee of 0 and no TransferFee are equivalent on-ledger, but
    // sending the field only when it is meaningful keeps payloads honest.
    const tx = buildMintTx({ issuerAddress: ISSUER, taxon: 1, royaltyBps: 0 })
    expect(tx.TransferFee).toBeUndefined()
    expect('TransferFee' in tx).toBe(false)
  })

  it('hex-encodes the URI', () => {
    const tx = buildMintTx({
      issuerAddress: ISSUER,
      taxon: 1,
      royaltyBps: 0,
      uri: 'ipfs://abc',
    })
    expect(tx.URI).toBe(convertStringToHex('ipfs://abc'))
  })

  it('rejects a URI over the 256-byte on-ledger limit', () => {
    expect(() =>
      buildMintTx({ issuerAddress: ISSUER, taxon: 1, royaltyBps: 0, uri: 'x'.repeat(257) }),
    ).toThrow(/256-byte/)
  })

  it('accepts a URI exactly at the limit', () => {
    expect(() =>
      buildMintTx({ issuerAddress: ISSUER, taxon: 1, royaltyBps: 0, uri: 'x'.repeat(256) }),
    ).not.toThrow()
  })

  it('refuses a royalty the ledger cannot express', () => {
    expect(() => buildMintTx({ issuerAddress: ISSUER, taxon: 1, royaltyBps: 6000 })).toThrow()
  })
})

describe('buildGiftOfferTx', () => {
  it('is a zero-amount sell offer locked to one destination', () => {
    const tx = buildGiftOfferTx({
      ownerAddress: ISSUER,
      nfTokenId: NFTOKEN_ID,
      destinationAddress: OTHER,
    })
    expect(tx.TransactionType).toBe('NFTokenCreateOffer')
    expect(tx.Account).toBe(ISSUER)
    expect(tx.NFTokenID).toBe(NFTOKEN_ID)
    // Free, and claimable by nobody but the named recipient.
    expect(tx.Amount).toBe('0')
    expect(tx.Destination).toBe(OTHER)
    // tfSellNFToken — without it this would read as a bid, not an offer.
    expect(tx.Flags).toBe(1)
  })

  it('refuses a gift to yourself', () => {
    expect(() =>
      buildGiftOfferTx({
        ownerAddress: ISSUER,
        nfTokenId: NFTOKEN_ID,
        destinationAddress: ISSUER,
      }),
    ).toThrow(/yourself/)
  })
})

describe('buildAcceptOfferTx', () => {
  it('accepts as a sell offer, signed by the recipient', () => {
    const tx = buildAcceptOfferTx({ accepterAddress: OTHER, offerIndex: OFFER_INDEX })
    expect(tx.TransactionType).toBe('NFTokenAcceptOffer')
    // The recipient signs, so their address is the one that must appear here.
    expect(tx.Account).toBe(OTHER)
    // NFTokenSellOffer, not NFTokenBuyOffer — the gift was created as a sell.
    expect(tx.NFTokenSellOffer).toBe(OFFER_INDEX)
    expect(tx.NFTokenBuyOffer).toBeUndefined()
  })
})

describe('buildCancelOfferTx', () => {
  it('cancels as the offer creator', () => {
    const tx = buildCancelOfferTx({ ownerAddress: ISSUER, offerIndex: OFFER_INDEX })
    expect(tx.TransactionType).toBe('NFTokenCancelOffer')
    expect(tx.Account).toBe(ISSUER)
    expect(tx.NFTokenOffers).toEqual([OFFER_INDEX])
  })
})
