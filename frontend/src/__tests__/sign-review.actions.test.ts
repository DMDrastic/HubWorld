// @vitest-environment node
/**
 * Reading what you sign when the action is a purchase, a bid, a listing, an auction or a withdrawal. Written before the code.
 *
 * Same discipline as the organizer's review: the summary is written FROM THE TRANSACTION, the hash is worked out here by a
 * different route from the page's, and anything not fully understood is refused. What is new is that the page also knows
 * what the person asked for (the price they saw, the bid they typed), and the review checks the transaction against that: a
 * server that quietly changed an amount, or pointed an offer at a different account, is caught before the wallet is asked.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ECDSA, Wallet, encodeForSigning } from 'xrpl'
import { reviewSignRequest, type ReviewAction, type ReviewContext } from '@/lib/sign-review'
import type { SignBlock } from '@/lib/api'

const me = Wallet.generate(ECDSA.secp256k1)
const SELLER = Wallet.generate(ECDSA.secp256k1).classicAddress
const BROKER = Wallet.generate(ECDSA.secp256k1).classicAddress
const OTHER = Wallet.generate(ECDSA.secp256k1).classicAddress
const NFT = '000800005A4E2B5E0F7D3E6C1A2B3C4D5E6F708192A3B4C5D6E7F80900001234'
const OFFER = 'AB'.repeat(32)
const XRP = 1_000_000n
const drops = (n: number) => (BigInt(Math.round(n * 1_000_000))).toString()

const independentHash = (tx: Record<string, unknown>) => {
  try {
    return createHash('sha512').update(Buffer.from(encodeForSigning(tx as never), 'hex')).digest().subarray(0, 32).toString('hex').toUpperCase()
  } catch {
    // A transaction the codec itself cannot encode (a malformed amount or index): there is no real hash to send, and the
    // review must refuse it for what it is before it ever gets as far as comparing hashes.
    return 'CD'.repeat(32)
  }
}

const common = { Account: me.classicAddress, Fee: '12', Sequence: 7, LastLedgerSequence: 5_000, SigningPubKey: me.publicKey }
const sell = (amount: string, over: Record<string, unknown> = {}) =>
  ({ TransactionType: 'NFTokenCreateOffer', ...common, NFTokenID: NFT, Amount: amount, Destination: BROKER, Flags: 1, ...over }) as Record<string, unknown>
const buy = (amount: string, over: Record<string, unknown> = {}) =>
  ({ TransactionType: 'NFTokenCreateOffer', ...common, NFTokenID: NFT, Owner: SELLER, Amount: amount, Destination: BROKER, ...over }) as Record<string, unknown>
const cancel = (over: Record<string, unknown> = {}) =>
  ({ TransactionType: 'NFTokenCancelOffer', ...common, NFTokenOffers: [OFFER], ...over }) as Record<string, unknown>

const block = (tx: Record<string, unknown>, over: Partial<SignBlock> = {}): SignBlock => ({ tx, hash: independentHash(tx), account: me.classicAddress, ...over })
const ctx = (action: ReviewAction, over: Partial<ReviewContext> = {}): ReviewContext => ({
  account: me.classicAddress,
  hubworldDelegate: null,
  broker: BROKER,
  action,
  ...over,
})
const why = async (b: SignBlock, c: ReviewContext) => {
  const r = await reviewSignRequest(b, c)
  return r.ok ? 'OK' : r.reason
}
const ok = async (b: SignBlock, c: ReviewContext) => {
  const r = await reviewSignRequest(b, c)
  if (!r.ok) throw new Error(`expected a summary, got: ${r.reason}`)
  return r
}

// Each action: how to build the right transaction for it, the context the page supplies, and what the summary must say.
const ACTIONS: Array<{
  name: string
  good: () => Record<string, unknown>
  action: ReviewAction
  title: RegExp
  says: RegExp[]
  /** A transaction of the right TYPE but wrong in the way a hostile server would make it. */
  tampered: Array<[string, () => Record<string, unknown>]>
}> = [
  {
    name: 'a purchase at the box office or on the marketplace',
    good: () => buy(drops(10)),
    action: { kind: 'buy', amountDrops: drops(10), label: 'Neon Night' },
    // The title says what is done; the exact amount signed is in the lines (shown under Details).
    title: /^Buy 1 ticket to Neon Night$/,
    says: [/You pay 10 XRP/, /1234/, /Only HubWorld/],
    tampered: [
      ['a bigger amount than the page showed', () => buy(drops(10.000001))],
      ['a smaller amount than the page showed', () => buy(drops(9))],
      ['an offer that is really a SELL offer', () => buy(drops(10), { Flags: 1 })],
    ],
  },
  {
    name: 'a bid in an auction',
    good: () => buy(drops(30)),
    action: { kind: 'bid', amountDrops: drops(30), label: 'Neon Night' },
    title: /^Bid on a ticket to Neon Night$/,
    says: [/You offer 30 XRP/, /nothing is charged/i, /1234/],
    tampered: [
      ['a bigger bid than typed', () => buy(drops(31))],
      ['a sell offer instead of a bid', () => buy(drops(30), { Flags: 1 })],
    ],
  },
  {
    name: 'listing a ticket for sale',
    good: () => sell(drops(9.5)),
    action: { kind: 'list', askDrops: drops(10), label: 'Neon Night' },
    title: /^Put your ticket to Neon Night up for sale$/,
    says: [/you receive 9\.5 XRP/i, /asking price of 10 XRP/i, /royalty/i, /1234/],
    tampered: [
      ['more than the asking price (it would never sell at the price shown)', () => sell(drops(10.000001))],
      ['far below the asking price (the seller would be robbed)', () => sell(drops(1))],
      ['just under the lowest fee anyone could be charged', () => sell(drops(8.99))],
      ['a BUY offer (with an owner) instead of a listing', () => sell(drops(9.5), { Flags: 0, Owner: SELLER })],
      ['a BUY offer with no owner, which is the only thing telling it apart from a sell offer', () => sell(drops(9.5), { Flags: 0 })],
    ],
  },
  {
    name: 'opening an auction',
    good: () => sell(drops(19)),
    action: { kind: 'auction', reserveDrops: drops(20), label: 'Neon Night' },
    title: /^Start an auction for your ticket to Neon Night$/,
    says: [/reserve of 20 XRP/i, /1234/, /19 XRP/],
    tampered: [
      ['a sell offer above the reserve', () => sell(drops(20.5))],
      ['a sell offer far below the reserve', () => sell(drops(2))],
    ],
  },
  {
    name: 'taking a listing off sale',
    good: () => cancel(),
    action: { kind: 'withdraw', label: 'Neon Night' },
    title: /^Take your ticket to Neon Night off sale$/,
    says: [/withdraws? (your|the) listing/i, /nothing is charged/i],
    tampered: [
      ['cancelling two offers at once', () => cancel({ NFTokenOffers: [OFFER, 'CD'.repeat(32)] })],
      ['cancelling nothing', () => cancel({ NFTokenOffers: [] })],
      ['an offer index that is not an index', () => cancel({ NFTokenOffers: ['not-an-index'] })],
    ],
  },
]

describe.each(ACTIONS)('$name', (a) => {
  it('ALLOWED: summarised in plain words from the transaction itself', async () => {
    const r = await ok(block(a.good()), ctx(a.action))
    expect(r.title).toMatch(a.title)
    const text = r.lines.join('\n')
    for (const re of a.says) expect(text).toMatch(re)
  })

  it('works without the page\'s own label (the title just does not name an event)', async () => {
    const { label: _l, ...rest } = a.action as ReviewAction & { label?: string }
    void _l
    const r = await ok(block(a.good()), ctx(rest as ReviewAction))
    expect(r.title).not.toMatch(/Neon Night/)
  })

  it('REFUSED when the hash the server sent is not the hash of the transaction', async () => {
    expect(await why(block(a.good(), { hash: 'AB'.repeat(32) }), ctx(a.action))).toMatch(/does not match/i)
  })

  it('REFUSED when the transaction is not for the signed-in wallet (not the holder)', async () => {
    const tx = { ...a.good(), Account: OTHER }
    expect(await why(block(tx), ctx(a.action))).toMatch(/not for your account/i)
    expect(await why(block(a.good(), { account: OTHER }), ctx(a.action))).toMatch(/not for your account/i)
  })

  it('REFUSED when it carries a field the review cannot describe', async () => {
    expect(await why(block({ ...a.good(), Memos: [{ Memo: { MemoData: 'AA' } }] }), ctx(a.action))).toMatch(/can’t describe \(Memos\)/)
  })

  it('REFUSED when it has no expiry, or an unusual fee', async () => {
    const noExpiry = a.good()
    delete noExpiry.LastLedgerSequence
    expect(await why(block(noExpiry), ctx(a.action))).toMatch(/no expiry/i)
    expect(await why(block({ ...a.good(), Fee: '5000000' }), ctx(a.action))).toMatch(/unusual network fee/i)
  })

  it('REFUSED when the page was not expecting this kind of request', async () => {
    expect(await why(block(a.good()), ctx(a.action, { action: undefined }))).toMatch(/not expected here/i)
  })

  it.each(a.tampered)('REFUSED: %s', async (_n, make) => {
    const r = await reviewSignRequest(block(make()), ctx(a.action))
    expect(r.ok).toBe(false)
  })
})

describe('offers must go to HubWorld’s broker and nowhere else', () => {
  const offers = ACTIONS.filter((a) => a.action.kind !== 'withdraw')

  it.each(offers)('$name: REFUSED when the destination is some other account', async (a) => {
    const tx = { ...a.good(), Destination: OTHER }
    expect(await why(block(tx), ctx(a.action))).toMatch(/not HubWorld’s|couldn’t confirm/i)
  })

  it.each(offers)('$name: REFUSED when there is no destination at all (an open offer anyone could take)', async (a) => {
    const tx = a.good()
    delete tx.Destination
    expect(await why(block(tx), ctx(a.action))).toMatch(/not HubWorld’s|couldn’t confirm/i)
  })

  it.each(offers)('$name: REFUSED when the broker could not be confirmed independently (never taken on the server’s word)', async (a) => {
    expect(await why(block(a.good()), ctx(a.action, { broker: null }))).toMatch(/couldn’t confirm/i)
  })

  it('a withdrawal needs no broker', async () => {
    const w = ACTIONS.find((a) => a.action.kind === 'withdraw')!
    expect((await reviewSignRequest(block(w.good()), ctx(w.action, { broker: null }))).ok).toBe(true)
  })
})

describe('the action must match the transaction', () => {
  it('a page expecting a purchase refuses a listing, a cancel, and a payment', async () => {
    const a = ctx({ kind: 'buy', amountDrops: drops(10) })
    expect((await reviewSignRequest(block(sell(drops(10))), a)).ok).toBe(false)
    expect((await reviewSignRequest(block(cancel()), a)).ok).toBe(false)
    expect((await reviewSignRequest(block({ TransactionType: 'Payment', ...common, Destination: OTHER, Amount: drops(10) }), a)).ok).toBe(false)
  })

  it('a page expecting a withdrawal refuses an offer', async () => {
    expect((await reviewSignRequest(block(sell(drops(9.5))), ctx({ kind: 'withdraw' }))).ok).toBe(false)
  })

  it('a purchase must name someone else as the owner of the ticket, never the buyer themselves', async () => {
    const tx = buy(drops(10), { Owner: me.classicAddress })
    expect(await why(block(tx), ctx({ kind: 'buy', amountDrops: drops(10) }))).toMatch(/owner|own ticket/i)
  })

  it('an amount that is not plain drops is refused (an issued-currency or zero amount)', async () => {
    for (const bad of ['0', '-5', '1.5', { currency: 'USD', issuer: OTHER, value: '10' }] as unknown[]) {
      const r = await reviewSignRequest(block(buy(drops(10), { Amount: bad })), ctx({ kind: 'buy', amountDrops: drops(10) }))
      expect(r.ok).toBe(false)
    }
  })

  it('the organizer’s existing reviews are unchanged (a delegation still needs its own context)', async () => {
    const tx = { TransactionType: 'DelegateSet', ...common, Authorize: OTHER, Permissions: [{ Permission: { PermissionValue: 'NFTokenMint' } }] }
    expect(await why(block(tx), { account: me.classicAddress, hubworldDelegate: OTHER })).toMatch(/not expected here/i)
  })
})
void XRP
