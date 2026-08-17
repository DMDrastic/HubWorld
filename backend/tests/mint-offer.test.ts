/**
 * Minting and listing in one signature.
 *
 * The mainnet rehearsal measured a ticket sold at ~3 Xaman payloads — mint,
 * list, buy — and payload count, not ledger cost, is what caps event size:
 * a 20-ticket event is ~100 payloads against a cap hit at ~77. `NFTokenMintOffer`
 * is enabled on mainnet, so folding the list into the mint removes a third of
 * that with no amendment left to wait for. Proved end to end on testnet in
 * `scripts/mint-offer-spike.ts`, including brokered settlement.
 *
 * What must NOT be given up in the process is the reason a sell offer names the
 * broker at all: without `Destination`, a buyer takes the offer directly and the
 * platform fee is bypassable. Brokerage is only enforced when neither party can
 * settle alone, so that is asserted here rather than assumed.
 */
import { describe, expect, it } from 'vitest'
import { buildMintTx } from '../src/ledger.js'

const ISSUER = 'r4wQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf'
const BROKER = 'rp6hU3DAfsgCVD9Jt6r8P4fAFDKzGaS1TD'

describe('buildMintTx with a mint-time sale', () => {
  it('carries the price and the broker, so mint and list are one signature', () => {
    const tx = buildMintTx({
      issuerAddress: ISSUER,
      taxon: 1,
      royaltyBps: 500,
      sellOffer: { amountDrops: 1_000_000n, destinationAddress: BROKER },
    })

    expect(tx.Amount).toBe('1000000')
    expect(tx.Destination).toBe(BROKER)
    // Still a normal ticket in every other respect.
    expect(Number(tx.Flags) & 8).toBe(8)
    expect(tx.TransferFee).toBe(5000)
  })

  it('omits both fields entirely when no price is given', () => {
    // Minting to HOLD — a gift, a comp, an allocation to sell later — must stay
    // exactly as it was. An Amount of "0" would be a free public offer.
    const tx = buildMintTx({ issuerAddress: ISSUER, taxon: 1, royaltyBps: 0 })

    expect(tx.Amount).toBeUndefined()
    expect(tx.Destination).toBeUndefined()
    expect('Amount' in tx).toBe(false)
    expect('Destination' in tx).toBe(false)
  })

  it('refuses to sell to the issuer, which would bypass brokerage', () => {
    // The offer would then be matchable by the issuer alone, and the platform
    // fee — taken from the spread by the broker — is simply skipped.
    expect(() =>
      buildMintTx({
        issuerAddress: ISSUER,
        taxon: 1,
        royaltyBps: 0,
        sellOffer: { amountDrops: 1_000_000n, destinationAddress: ISSUER },
      }),
    ).toThrow(/broker/i)
  })

  it('refuses a zero price', () => {
    // Zero is not "free", it is an offer anyone can take. A giveaway goes
    // through the gift flow, which names its recipient.
    expect(() =>
      buildMintTx({
        issuerAddress: ISSUER,
        taxon: 1,
        royaltyBps: 0,
        sellOffer: { amountDrops: 0n, destinationAddress: BROKER },
      }),
    ).toThrow(/greater than zero/i)
  })

  it('still carries the metadata URI alongside the sale', () => {
    // The two changes are independent and must not have traded off against each
    // other: a ticket listed at mint is still a ticket a wallet can render.
    const tx = buildMintTx({
      issuerAddress: ISSUER,
      taxon: 1,
      royaltyBps: 0,
      uri: 'https://hubworld.app/api/events/x/nft.json',
      sellOffer: { amountDrops: 1_000_000n, destinationAddress: BROKER },
    })

    expect(tx.URI).toBeDefined()
    expect(tx.Amount).toBe('1000000')
  })
})
