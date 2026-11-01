// @vitest-environment node
/**
 * Reading a gift before approving it: giving one, accepting one, taking one back. Written before the code.
 *
 * A gift is the one offer that is FREE, so it is the one a hostile server would most like to tamper with: send it to a different
 * person, or attach a price. The review checks the transaction against what this page knows: the person the giver typed, and the
 * offer the recipient was shown. The amount of an ACCEPTED offer is not in the accept transaction at all; the server checks it on
 * the ledger before asking (see the gift route), and the summary says so plainly rather than claiming to have checked it here.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ECDSA, Wallet, encodeForSigning } from 'xrpl'
import { reviewSignRequest, type ReviewAction, type ReviewContext } from '@/lib/sign-review'
import type { SignBlock } from '@/lib/api'

const me = Wallet.generate(ECDSA.secp256k1)
const FRIEND = Wallet.generate(ECDSA.secp256k1).classicAddress
const OTHER = Wallet.generate(ECDSA.secp256k1).classicAddress
const BROKER = Wallet.generate(ECDSA.secp256k1).classicAddress
const NFT = '000800005A4E2B5E0F7D3E6C1A2B3C4D5E6F708192A3B4C5D6E7F80900001234'
const OFFER = 'AD'.repeat(32)

const hashOf = (tx: Record<string, unknown>) => {
  try {
    return createHash('sha512').update(Buffer.from(encodeForSigning(tx as never), 'hex')).digest().subarray(0, 32).toString('hex').toUpperCase()
  } catch {
    return 'CD'.repeat(32)
  }
}
const common = { Account: me.classicAddress, Fee: '12', Sequence: 7, LastLedgerSequence: 5_000, SigningPubKey: me.publicKey }
const give = (over: Record<string, unknown> = {}) =>
  ({ TransactionType: 'NFTokenCreateOffer', ...common, NFTokenID: NFT, Amount: '0', Destination: FRIEND, Flags: 1, ...over }) as Record<string, unknown>
const accept = (over: Record<string, unknown> = {}) => ({ TransactionType: 'NFTokenAcceptOffer', ...common, NFTokenSellOffer: OFFER, ...over }) as Record<string, unknown>
const takeBack = (over: Record<string, unknown> = {}) => ({ TransactionType: 'NFTokenCancelOffer', ...common, NFTokenOffers: [OFFER], ...over }) as Record<string, unknown>

const block = (tx: Record<string, unknown>, over: Partial<SignBlock> = {}): SignBlock => ({ tx, hash: hashOf(tx), account: me.classicAddress, ...over })
const ctx = (action: ReviewAction, over: Partial<ReviewContext> = {}): ReviewContext => ({ account: me.classicAddress, hubworldDelegate: null, broker: BROKER, action, ...over })
const review = (tx: Record<string, unknown>, action: ReviewAction, over: Partial<SignBlock> = {}, c: Partial<ReviewContext> = {}) =>
  reviewSignRequest(block(tx, over), ctx(action, c))
const refused = async (tx: Record<string, unknown>, action: ReviewAction, over: Partial<SignBlock> = {}) => {
  const r = await review(tx, action, over)
  return r.ok ? null : r.reason
}

const GIVE: ReviewAction = { kind: 'gift', recipientAddress: FRIEND, recipientHandle: 'friend', label: 'Neon Night' }
const ACCEPT: ReviewAction = { kind: 'acceptGift', offerIndex: OFFER, fromHandle: '@giver', label: 'Neon Night' }
const TAKE_BACK: ReviewAction = { kind: 'cancelGift', label: 'Neon Night' }

describe('giving a ticket', () => {
  it('ALLOWED: says who it goes to, that it is free, that they must accept it, and names their wallet in full', async () => {
    const r = await review(give(), GIVE)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.title).toBe('Give your ticket to Neon Night to @friend')
    const text = r.lines.join('\n')
    expect(text).toMatch(/free/i)
    expect(text).toMatch(/until they accept/i)
    expect(text).toContain(FRIEND)
    expect(text).toMatch(/1234/)
  })

  it.each([
    ['to a different person than the one typed', give({ Destination: OTHER }), /not the person you chose/i],
    ['to nobody in particular (anyone could take it)', (() => { const t = give(); delete t.Destination; return t })(), /not the person you chose/i],
    ['for money (that is a sale, not a gift)', give({ Amount: '1000000' }), /free/i],
    ['as a buy offer', give({ Flags: 0 }), /not a gift/i],
    ['naming an owner, as only a purchase does', give({ Owner: OTHER }), /not a gift/i],
  ])('REFUSED: %s', async (_n, tx, why) => {
    expect(await refused(tx, GIVE)).toMatch(why)
  })

  it('REFUSED: to HubWorld’s own broker', async () => {
    expect(await refused(give({ Destination: BROKER }), { ...GIVE, recipientAddress: BROKER })).toMatch(/HubWorld/)
  })

  it('REFUSED: to yourself', async () => {
    expect(await refused(give({ Destination: me.classicAddress }), { ...GIVE, recipientAddress: me.classicAddress })).toMatch(/yourself/i)
  })

  it('REFUSED: when the hash sent is not the hash of this transaction', async () => {
    expect(await refused(give(), GIVE, { hash: 'AB'.repeat(32) })).toMatch(/does not match/i)
  })

  it('REFUSED: when it is not for the signed-in wallet', async () => {
    expect(await refused(give({ Account: OTHER }), GIVE)).toMatch(/not for your account/i)
  })
})

describe('accepting a ticket someone gave you', () => {
  it('ALLOWED: says what it does, who it is from, and states plainly that the amount was checked by HubWorld, not here', async () => {
    const r = await review(accept(), ACCEPT)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.title).toBe('Accept the ticket to Neon Night from @giver')
    const text = r.lines.join('\n')
    expect(text).toMatch(/into your wallet/i)
    expect(text).toMatch(/HubWorld checked on the ledger/i)
  })

  it.each([
    ['accepting a different offer than the gift shown', accept({ NFTokenSellOffer: 'CD'.repeat(32) }), /not the gift/i],
    ['a BUY offer (that would sell your own ticket)', (() => { const t = accept(); delete t.NFTokenSellOffer; return { ...t, NFTokenBuyOffer: OFFER } })(), /can’t describe|not the gift/i],
    ['a brokered accept', accept({ NFTokenBrokerFee: '1' }), /can’t describe/i],
  ])('REFUSED: %s', async (_n, tx, why) => {
    expect(await refused(tx, ACCEPT)).toMatch(why)
  })

  it('REFUSED: when the page was expecting something else', async () => {
    expect(await refused(accept(), GIVE)).toBeTruthy()
    expect(await refused(give(), ACCEPT)).toBeTruthy()
  })

  it('needs no broker (nothing is sold)', async () => {
    expect((await review(accept(), ACCEPT, {}, { broker: null })).ok).toBe(true)
  })
})

describe('taking back a gift you offered', () => {
  it('ALLOWED: says the ticket stays with you', async () => {
    const r = await review(takeBack(), TAKE_BACK)
    expect(r.ok && r.title).toBe('Take back your gift of a ticket to Neon Night')
    expect(r.ok && r.lines.join('\n')).toMatch(/stays in your wallet/i)
  })

  it('REFUSED: cancelling more than one offer', async () => {
    expect(await refused(takeBack({ NFTokenOffers: [OFFER, 'CD'.repeat(32)] }), TAKE_BACK)).toBeTruthy()
  })
})
