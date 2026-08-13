/**
 * A ticket has to look like a ticket inside a wallet.
 *
 * Every ticket minted before this was minted with NO URI — verified on mainnet:
 * `account_nfts` returned tokens whose URI field was absent entirely. A wallet
 * cannot render that as anything but an anonymous token from an unknown
 * account, which is the exact shape of the spam NFTs airdropped across the
 * XRPL, and Xaman labels it accordingly.
 *
 * The mint flags are pinned here too, because both matter and neither is
 * visible once a token exists: `tfTransferable` is what makes resale possible
 * at all, and `tfMutable` is the only chance to correct metadata later —
 * `DynamicNFT` is active on mainnet, but the flag can only be set AT MINT.
 */
import { describe, expect, it } from 'vitest'
import { convertHexToString } from 'xrpl'
import { ticketMetadata, ticketMetadataUri } from '../src/nft-metadata.js'
import { buildMintTx } from '../src/ledger.js'

const EVENT = {
  title: 'Chalice Dungeon',
  description: null,
  venue: 'The Hunter’s Dream',
  startsAt: new Date('2026-09-01T19:00:00.000Z'),
  imageUrl: 'https://cdn.example.test/poster.png',
}

describe('ticket metadata', () => {
  it('names the event, so a wallet has something to show', () => {
    const m = ticketMetadata(EVENT)

    expect(m.name).toBe('Chalice Dungeon')
    expect(m.image).toBe('https://cdn.example.test/poster.png')
    expect(m.nftType).toBe('ticket.v0')
  })

  it('describes the event even when the organizer left the field empty', () => {
    // The description is what a holder reads when deciding whether this is the
    // thing they paid for. Empty is the common case and must not render blank.
    const m = ticketMetadata(EVENT)

    expect(m.description).toContain('Chalice Dungeon')
    expect(m.description).toContain('The Hunter’s Dream')
  })

  it('omits the image rather than emitting an empty one', () => {
    // A null image key is worse than an absent one: some renderers show a
    // broken placeholder, which looks more suspicious than no art at all.
    const m = ticketMetadata({ ...EVENT, imageUrl: null })

    expect(m).not.toHaveProperty('image')
  })

  it('drops attributes it has no value for', () => {
    const m = ticketMetadata({ ...EVENT, venue: null })

    expect(m.attributes.map((a) => a.trait_type)).not.toContain('Venue')
    expect(m.attributes.map((a) => a.trait_type)).toContain('Event')
  })
})

describe('the on-ledger URI', () => {
  it('is absolute, because wallets have never heard of us', () => {
    const uri = ticketMetadataUri('chalice-dungeon')

    expect(uri).toMatch(/^https:\/\//)
    expect(uri).toContain('/api/events/chalice-dungeon/nft.json')
  })

  it('fits the 256-byte on-ledger limit with room to spare', () => {
    // buildMintTx throws above 256 bytes, so a long slug is a mint that fails
    // at signing time rather than a truncated string.
    const uri = ticketMetadataUri('a'.repeat(60))

    expect(Buffer.byteLength(uri)).toBeLessThan(256)
  })
})

describe('buildMintTx', () => {
  it('carries the URI on-ledger, hex encoded', () => {
    const tx = buildMintTx({
      issuerAddress: 'rIssuerFixture0000000000000000000',
      taxon: 1,
      royaltyBps: 500,
      uri: 'https://hubworld.app/api/events/x/nft.json',
    })

    expect(tx.URI).toBeDefined()
    expect(convertHexToString(tx.URI!)).toBe('https://hubworld.app/api/events/x/nft.json')
  })

  it('mints transferable AND mutable', () => {
    const tx = buildMintTx({ issuerAddress: 'rIssuer', taxon: 1, royaltyBps: 0 })

    // 8 = tfTransferable: without it the ticket can never be resold, which ends
    // the product. 16 = tfMutable: the only chance to correct metadata later,
    // and it can only be set at mint.
    const flags = Number(tx.Flags)
    expect(flags & 8).toBe(8)
    expect(flags & 16).toBe(16)
  })

  it('refuses a URI that will not fit on-ledger', () => {
    expect(() =>
      buildMintTx({
        issuerAddress: 'rIssuer',
        taxon: 1,
        royaltyBps: 0,
        uri: 'https://hubworld.app/' + 'x'.repeat(300),
      }),
    ).toThrow(/256/)
  })
})
