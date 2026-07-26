/**
 * Gift lifetime rules — testing the actual module the route uses, not a
 * reimplementation of it.
 *
 * These encode a bug that shipped and was fixed: the poll treated the Xaman
 * payload TTL as the gift's lifetime, so an OFFERED gift became `expired` after
 * 60 minutes while its NFTokenOffer was still live on-ledger.
 *
 * An XRPL NFTokenOffer has no expiry. The recipient could still accept it in
 * Xaman, ownership would move, and Hubworld — believing the gift dead — would
 * never write the GIFT provenance row.
 */
import { describe, expect, it } from 'vitest'
import { ON_LEDGER_STATES, isLiveGift, isOnLedger, mayExpire } from '../src/gift-policy.js'

describe('isOnLedger', () => {
  it('covers exactly the states with a live ledger object', () => {
    expect(isOnLedger('OFFERED')).toBe(true)
    expect(isOnLedger('ACCEPTING')).toBe(true)
    expect(isOnLedger('CANCELLING')).toBe(true)
  })

  it('excludes states with nothing on-ledger', () => {
    // PENDING_OFFER is unsigned; the rest are terminal.
    for (const status of ['PENDING_OFFER', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED', 'FAILED'] as const) {
      expect(isOnLedger(status), status).toBe(false)
    }
  })
})

describe('mayExpire', () => {
  it('permits expiry only before anything reaches the ledger', () => {
    expect(mayExpire('PENDING_OFFER')).toBe(true)
  })

  it('refuses to expire a gift whose offer is live', () => {
    // The regression. A payload timeout must not kill an on-ledger offer.
    for (const status of ON_LEDGER_STATES) {
      expect(mayExpire(status), status).toBe(false)
    }
  })
})

describe('isLiveGift', () => {
  it('drops an unsigned offer once its payload goes stale', () => {
    expect(isLiveGift('PENDING_OFFER', false)).toBe(true)
    expect(isLiveGift('PENDING_OFFER', true)).toBe(false)
  })

  it('keeps an OFFERED gift actionable long after the payload TTL', () => {
    // A week later the offer is still on-ledger, so the recipient must still be
    // able to accept through Hubworld — otherwise they accept in Xaman instead
    // and we never observe the transfer.
    expect(isLiveGift('OFFERED', true)).toBe(true)
  })

  it('keeps in-flight acceptance and withdrawal live regardless of the TTL', () => {
    expect(isLiveGift('ACCEPTING', true)).toBe(true)
    expect(isLiveGift('CANCELLING', true)).toBe(true)
  })

  it('treats terminal states as not live', () => {
    for (const status of ['ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED', 'FAILED'] as const) {
      expect(isLiveGift(status, false), status).toBe(false)
      expect(isLiveGift(status, true), status).toBe(false)
    }
  })
})
