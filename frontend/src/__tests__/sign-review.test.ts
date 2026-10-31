// @vitest-environment node
/**
 * Reading what you sign, before you sign it.
 *
 * The cases that matter are the REFUSALS: each is a way a compromised server could get a person
 * to approve something they did not mean to. The hash used in the happy path is worked out here by
 * a different route (Node's crypto) from the one the page uses (WebCrypto), so the two cannot
 * agree by sharing a bug.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ECDSA, Wallet, encodeForSigning } from 'xrpl'
import { reviewSignRequest, type ReviewContext } from '@/lib/sign-review'
import type { SignBlock } from '@/lib/api'

const me = Wallet.generate(ECDSA.secp256k1)
const DELEGATE = Wallet.generate(ECDSA.secp256k1).classicAddress

const independentHash = (tx: Record<string, unknown>) =>
  createHash('sha512')
    .update(Buffer.from(encodeForSigning(tx as never), 'hex'))
    .digest()
    .subarray(0, 32)
    .toString('hex')
    .toUpperCase()

const perms = (...names: string[]) => names.map((PermissionValue) => ({ Permission: { PermissionValue } }))

function delegateSet(over: Record<string, unknown> = {}) {
  return {
    TransactionType: 'DelegateSet',
    Account: me.classicAddress,
    Authorize: DELEGATE,
    Permissions: perms('NFTokenMint'),
    Fee: '12',
    Sequence: 7,
    LastLedgerSequence: 5_000,
    SigningPubKey: me.publicKey,
    ...over,
  } as Record<string, unknown>
}

const block = (tx: Record<string, unknown>, over: Partial<SignBlock> = {}): SignBlock => ({
  tx,
  hash: independentHash(tx),
  account: me.classicAddress,
  ...over,
})

const ctx = (over: Partial<ReviewContext> = {}): ReviewContext => ({
  account: me.classicAddress,
  hubworldDelegate: DELEGATE,
  delegation: { held: { mint: false, offers: false }, action: 'grant', scope: 'mint' },
  ...over,
})

const why = async (b: SignBlock, c: ReviewContext) => {
  const r = await reviewSignRequest(b, c)
  return r.ok ? 'OK' : r.reason
}

describe('a delegation, described from the transaction itself', () => {
  it('summarises a grant in plain words and names the account being authorised', async () => {
    const r = await reviewSignRequest(block(delegateSet()), ctx())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.title).toBe('Allow HubWorld to create tickets for you')
    expect(r.lines.join('\n')).toContain('Create tickets in your wallet')
    expect(r.lines.join('\n')).toContain(DELEGATE)
    expect(r.authorises).toBe(DELEGATE)
  })

  it('describes the WHOLE resulting set, since a delegation replaces what was there', async () => {
    const tx = delegateSet({ Permissions: perms('NFTokenMint', 'NFTokenCreateOffer') })
    const r = await reviewSignRequest(block(tx), ctx({ delegation: { held: { mint: true, offers: false }, action: 'grant', scope: 'offers' } }))
    expect(r.ok && r.lines.join('\n')).toContain('Put your tickets up for sale')
    expect(r.ok && r.lines.join('\n')).toContain('Create tickets in your wallet')
  })

  it('describes taking one permission back while the other stays', async () => {
    const tx = delegateSet({ Permissions: perms('NFTokenCreateOffer') })
    const r = await reviewSignRequest(block(tx), ctx({ delegation: { held: { mint: true, offers: true }, action: 'revoke', scope: 'mint' } }))
    expect(r.ok && r.title).toBe('Stop HubWorld from being able to create tickets for you')
  })

  it('says plainly when the result is no access at all', async () => {
    const tx = delegateSet({ Permissions: [] })
    const r = await reviewSignRequest(block(tx), ctx({ delegation: { held: { mint: true, offers: false }, action: 'revoke', scope: 'mint' } }))
    expect(r.ok && r.lines.join('\n')).toContain('will not be able to act on your account at all')
  })
})

describe('what it refuses, and why that matters', () => {
  it('refuses a delegation to any account other than HubWorld’s', async () => {
    const evil = delegateSet({ Authorize: Wallet.generate(ECDSA.secp256k1).classicAddress })
    expect(await why(block(evil), ctx())).toMatch(/not HubWorld/)
  })

  it('refuses when it cannot confirm which account HubWorld’s is', async () => {
    expect(await why(block(delegateSet()), ctx({ hubworldDelegate: null }))).toMatch(/couldn’t confirm/)
  })

  it('refuses a delegation to your own account', async () => {
    const tx = delegateSet({ Authorize: me.classicAddress })
    expect(await why(block(tx), ctx({ hubworldDelegate: me.classicAddress }))).toMatch(/your own account/)
  })

  it('refuses when the hash it was handed is not the hash of the transaction', async () => {
    const tx = delegateSet()
    expect(await why(block(tx, { hash: 'A'.repeat(64) }), ctx())).toMatch(/does not match/)
  })

  it('refuses a transaction changed after the hash was made', async () => {
    const original = delegateSet()
    const changed = { ...original, Permissions: perms('NFTokenMint', 'NFTokenCreateOffer') }
    // Hash of the original, transaction of the changed one: what a server swapping the body would send.
    const b = block(changed, { hash: independentHash(original) })
    expect(await why(b, ctx({ delegation: { held: { mint: false, offers: false }, action: 'grant', scope: 'mint' } }))).toMatch(/more than you asked/)
  })

  it('refuses a grant that also grants something else', async () => {
    const tx = delegateSet({ Permissions: perms('NFTokenMint', 'NFTokenCreateOffer') })
    expect(await why(block(tx), ctx())).toMatch(/more than you asked/)
  })

  it('refuses a revoke that quietly drops a permission you did not name', async () => {
    const tx = delegateSet({ Permissions: [] })
    const c = ctx({ delegation: { held: { mint: true, offers: true }, action: 'revoke', scope: 'mint' } })
    expect(await why(block(tx), c)).toMatch(/more than you asked/)
  })

  it('refuses a permission it does not recognise', async () => {
    const tx = delegateSet({ Permissions: perms('Payment') })
    expect(await why(block(tx), ctx())).toMatch(/don’t recognise/)
  })

  it('refuses a kind of transaction it cannot describe', async () => {
    const tx = { TransactionType: 'Payment', Account: me.classicAddress, Destination: DELEGATE, Amount: '1000000', Fee: '12', Sequence: 1, LastLedgerSequence: 9, SigningPubKey: me.publicKey }
    expect(await why(block(tx), ctx())).toMatch(/can’t show you in plain words/)
  })

  it('refuses a field it cannot describe', async () => {
    const tx = delegateSet({ Destination: DELEGATE })
    expect(await why(block(tx), ctx())).toMatch(/can’t describe \(Destination\)/)
  })

  it('refuses a request for another account', async () => {
    const other = Wallet.generate(ECDSA.secp256k1)
    const tx = delegateSet({ Account: other.classicAddress })
    expect(await why(block(tx), ctx())).toMatch(/not for your account/)
    expect(await why(block(delegateSet(), { account: other.classicAddress }), ctx())).toMatch(/not for your account/)
  })

  it('refuses a request with no expiry, or an absurd fee', async () => {
    const noExpiry = delegateSet()
    delete noExpiry.LastLedgerSequence
    expect(await why(block(noExpiry), ctx())).toMatch(/no expiry/)
    expect(await why(block(delegateSet({ Fee: '5000000' })), ctx())).toMatch(/unusual network fee/)
  })
})

describe('a ticket mint', () => {
  const mint = (over: Record<string, unknown> = {}) => ({
    TransactionType: 'NFTokenMint',
    Account: me.classicAddress,
    NFTokenTaxon: 12,
    Flags: 24,
    TransferFee: 5000,
    Fee: '12',
    Sequence: 3,
    LastLedgerSequence: 5_000,
    SigningPubKey: me.publicKey,
    ...over,
  })

  it('says what it creates, and the royalty you keep', async () => {
    const r = await reviewSignRequest(block(mint()), ctx({ delegation: undefined, eventTitle: 'Neon Rooftop' }))
    expect(r.ok && r.title).toBe('Create a ticket for Neon Rooftop')
    expect(r.ok && r.lines.join('\n')).toContain('You earn 5% every time it is resold')
  })

  it('says who can complete a sale it lists', async () => {
    const r = await reviewSignRequest(block(mint({ Amount: '25000000', Destination: DELEGATE })), ctx({ delegation: undefined }))
    expect(r.ok && r.lines.join('\n')).toMatch(/25(\.0+)? XRP/)
    expect(r.ok && r.lines.join('\n')).toContain(DELEGATE)
  })

  it('refuses a listing that does not say who may complete it', async () => {
    expect(await why(block(mint({ Amount: '25000000' })), ctx({ delegation: undefined }))).toMatch(/form we can’t describe/)
  })
})
