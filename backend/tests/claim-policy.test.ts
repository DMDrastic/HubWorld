/**
 * The rules for the FREE claim offer: the organizer's delegate hands a ticket the database says someone holds to
 * that person's wallet, for nothing. Written before the code.
 *
 * This is a separate path from the paid primary sale (`checkSellOffer`, untouched). A zero-price offer is exactly
 * what that check exists to forbid, because a zero-price offer with the wrong destination is a stolen ticket. So
 * these rules are the only thing standing between the delegate permission and "give any ticket to anyone", and each
 * clause is pinned alone.
 */
import { describe, expect, it } from 'vitest'
import { Wallet, unixTimeToRippleTime } from 'xrpl'
import { makeNftId } from './nft-id.js'
import {
  CLAIM_GRACE_MS,
  CLAIM_TTL_SECONDS,
  checkClaimOffer,
  claimEligibility,
  claimPlan,
  type ClaimOfferExpectation,
  type ClaimOfferTx,
} from '../src/claim-policy.js'

const organizer = Wallet.generate().classicAddress
const holder = Wallet.generate().classicAddress
const stranger = Wallet.generate().classicAddress
const TAXON = 4242
const nfTokenId = makeNftId(organizer, TAXON, 7)
const NOW = 1_800_000_000_000 // ms
const rippleNow = unixTimeToRippleTime(NOW)

const expected: ClaimOfferExpectation = { organizerAddress: organizer, holderAddress: holder, eventTaxon: TAXON, nfTokenId, nowMs: NOW }
const good = (over: Partial<ClaimOfferTx> = {}): ClaimOfferTx => ({
  TransactionType: 'NFTokenCreateOffer',
  Account: organizer,
  NFTokenID: nfTokenId,
  Amount: '0',
  Destination: holder,
  Flags: 1,
  Expiration: rippleNow + 600,
  ...over,
})
const reason = (tx: ClaimOfferTx, e: ClaimOfferExpectation = expected) => {
  const v = checkClaimOffer(tx, e)
  return v.ok ? 'ok' : v.reason
}

describe('checkClaimOffer: the one shape that is allowed', () => {
  it('accepts a free, expiring sell offer from the organizer to the holder\'s own wallet', () => {
    expect(checkClaimOffer(good(), expected)).toEqual({ ok: true })
  })

  it('REFUSES an amount of 0 with no destination (anyone could take it)', () => {
    const tx = good()
    delete tx.Destination
    expect(reason(tx)).toMatch(/destination/i)
  })

  it('REFUSES a destination that is not the holder\'s wallet', () => {
    expect(reason(good({ Destination: stranger }))).toMatch(/destination/i)
  })

  it('REFUSES when the holder has no verified wallet (nothing to compare against)', () => {
    // The reason must be the missing wallet, not merely a mismatched destination that happens to mention one.
    expect(reason(good(), { ...expected, holderAddress: null })).toMatch(/no verified wallet/i)
    expect(reason(good({ Destination: undefined }), { ...expected, holderAddress: null })).toMatch(/no verified wallet/i)
  })

  it('REFUSES giving the ticket to the organizer\'s own account (it is a no-op that locks a reserve)', () => {
    expect(reason(good({ Destination: organizer }), { ...expected, holderAddress: organizer })).toMatch(/organizer/i)
  })

  it('REFUSES a priced offer: this path is free, a sale goes through checkout', () => {
    expect(reason(good({ Amount: '1' }))).toMatch(/free|amount/i)
    expect(reason(good({ Amount: '25000000' }))).toMatch(/free|amount/i)
  })

  it('REFUSES an issued-currency or malformed amount', () => {
    expect(reason(good({ Amount: { currency: 'USD', issuer: stranger, value: '0' } }))).toMatch(/amount/i)
    expect(reason(good({ Amount: 0 }))).toMatch(/amount/i)
    expect(reason(good({ Amount: '' }))).toMatch(/amount/i)
  })

  it('REFUSES a buy offer', () => {
    expect(reason(good({ Flags: 0 }))).toMatch(/sell/i)
    expect(reason(good({ Flags: undefined }))).toMatch(/sell/i)
  })

  it('REFUSES an offer created as some other account', () => {
    expect(reason(good({ Account: stranger }))).toMatch(/organizer/i)
  })

  it('REFUSES any other transaction type', () => {
    expect(reason(good({ TransactionType: 'Payment' }))).toMatch(/offer/i)
  })

  it('REFUSES a different ticket than the one being claimed', () => {
    expect(reason(good({ NFTokenID: makeNftId(organizer, TAXON, 8) }))).toMatch(/claimed ticket/i)
  })

  it('REFUSES a ticket from another event (taxon) or one the organizer did not issue', () => {
    const other = makeNftId(organizer, TAXON + 1, 7)
    expect(reason(good({ NFTokenID: other }), { ...expected, nfTokenId: other })).toMatch(/event/i)
    const foreign = makeNftId(stranger, TAXON, 7)
    expect(reason(good({ NFTokenID: foreign }), { ...expected, nfTokenId: foreign })).toMatch(/issued/i)
  })
})

describe('checkClaimOffer: the offer must expire, and soon', () => {
  it('REFUSES an offer with no expiration (it would hold the reserve and stay claimable forever)', () => {
    const tx = good()
    delete tx.Expiration
    expect(reason(tx)).toMatch(/expir/i)
  })

  it('REFUSES an expiration that is already past, or exactly now', () => {
    expect(reason(good({ Expiration: rippleNow - 1 }))).toMatch(/expir/i)
    expect(reason(good({ Expiration: rippleNow }))).toMatch(/expir/i)
  })

  it('accepts one second from now and exactly the longest allowed life', () => {
    expect(reason(good({ Expiration: rippleNow + 1 }))).toBe('ok')
    expect(reason(good({ Expiration: rippleNow + CLAIM_TTL_SECONDS }))).toBe('ok')
  })

  it('REFUSES one second past the longest allowed life', () => {
    expect(reason(good({ Expiration: rippleNow + CLAIM_TTL_SECONDS + 1 }))).toMatch(/expir/i)
  })

  it('REFUSES an expiration that is not a whole number of seconds', () => {
    expect(reason(good({ Expiration: rippleNow + 10.5 }))).toMatch(/expir/i)
    expect(reason(good({ Expiration: String(rippleNow + 10) }))).toMatch(/expir/i)
  })

  it('is short: a claim is accepted within minutes or abandoned', () => {
    expect(CLAIM_TTL_SECONDS).toBeLessThanOrEqual(15 * 60)
    expect(CLAIM_TTL_SECONDS).toBeGreaterThanOrEqual(60)
  })
})

describe('claimEligibility: who may be handed a ticket', () => {
  const ok = {
    ticket: { ownerId: 'u1', ownerAddress: organizer as string | null, status: 'MINTED' as const },
    holder: { id: 'u1', walletAddress: holder as string | null },
    organizerAddress: organizer,
    hasOpenListing: false,
    claimStatus: null as null | 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'CANCELLED' | 'FAILED',
  }

  it('allows the recorded holder, with a wallet, of an unlisted unclaimed ticket', () => {
    expect(claimEligibility(ok)).toEqual({ ok: true })
  })

  it('REFUSES a ticket nobody holds in our records', () => {
    expect(claimEligibility({ ...ok, ticket: { ...ok.ticket, ownerId: null } })).toMatchObject({ ok: false, reason: 'no-holder' })
  })

  it('REFUSES someone who is not the recorded holder', () => {
    expect(claimEligibility({ ...ok, holder: { id: 'u2', walletAddress: holder } })).toMatchObject({ ok: false, reason: 'not-the-holder' })
  })

  it('REFUSES a holder with no verified wallet', () => {
    expect(claimEligibility({ ...ok, holder: { id: 'u1', walletAddress: null } })).toMatchObject({ ok: false, reason: 'no-wallet' })
  })

  it('REFUSES a ticket with an open listing', () => {
    expect(claimEligibility({ ...ok, hasOpenListing: true })).toMatchObject({ ok: false, reason: 'listed' })
  })

  it('REFUSES a ticket whose claim was already accepted', () => {
    expect(claimEligibility({ ...ok, claimStatus: 'ACCEPTED' })).toMatchObject({ ok: false, reason: 'already-claimed' })
  })

  it('REFUSES a ticket already sitting in the holder\'s own wallet (claimed, whatever the claim row says)', () => {
    expect(claimEligibility({ ...ok, ticket: { ...ok.ticket, ownerAddress: holder } })).toMatchObject({ ok: false, reason: 'already-claimed' })
  })

  it('REFUSES a ticket in any state but MINTED (a redeemed or listed ticket is not for handing over)', () => {
    for (const status of ['LISTED', 'REDEEMED'] as const) {
      expect(claimEligibility({ ...ok, ticket: { ...ok.ticket, status } })).toMatchObject({ ok: false, reason: 'not-claimable' })
    }
  })

  it('allows a retry after an expired, cancelled or failed claim', () => {
    for (const claimStatus of ['EXPIRED', 'CANCELLED', 'FAILED'] as const) {
      expect(claimEligibility({ ...ok, claimStatus })).toEqual({ ok: true })
    }
  })
})

describe('claimPlan: a retry never makes a second offer', () => {
  const now = new Date(NOW)
  const live = { status: 'PENDING' as const, offerIndex: 'AB'.repeat(32), expiresAt: new Date(NOW + 300_000), createdAt: new Date(NOW - 120_000) }

  it('creates when there is no claim', () => {
    expect(claimPlan(null, now)).toEqual({ action: 'create' })
  })

  it('REUSES a pending claim whose offer is still alive', () => {
    expect(claimPlan(live, now)).toEqual({ action: 'reuse' })
  })

  it('REPLACES a pending claim whose offer has expired, cancelling the old one first', () => {
    expect(claimPlan({ ...live, expiresAt: new Date(NOW - 1) }, now)).toEqual({ action: 'replace', cancelOfferIndex: live.offerIndex })
    expect(claimPlan({ ...live, expiresAt: new Date(NOW) }, now)).toEqual({ action: 'replace', cancelOfferIndex: live.offerIndex })
  })

  it('REPLACES a pending claim that never got an offer (a crash between the row and the ledger), with nothing to cancel', () => {
    expect(claimPlan({ ...live, offerIndex: null }, now)).toEqual({ action: 'replace', cancelOfferIndex: null })
  })

  it('does NOT replace a claim with no offer yet that was only just made: another request is still submitting it', () => {
    const fresh = { ...live, offerIndex: null, createdAt: new Date(NOW - 5_000) }
    expect(claimPlan(fresh, now)).toEqual({ action: 'in-progress' })
    // At the edge of the grace period it becomes replaceable.
    expect(claimPlan({ ...fresh, createdAt: new Date(NOW - CLAIM_GRACE_MS - 1) }, now)).toEqual({ action: 'replace', cancelOfferIndex: null })
    expect(claimPlan({ ...fresh, createdAt: new Date(NOW - CLAIM_GRACE_MS) }, now)).toEqual({ action: 'in-progress' })
  })

  it('creates again after a claim that ended without success', () => {
    for (const status of ['EXPIRED', 'CANCELLED', 'FAILED'] as const) {
      expect(claimPlan({ ...live, status }, now)).toEqual({ action: 'create' })
    }
  })

  it('does nothing further for an accepted claim', () => {
    expect(claimPlan({ ...live, status: 'ACCEPTED' }, now)).toEqual({ action: 'none' })
  })
})
