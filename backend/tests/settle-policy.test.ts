/**
 * The rules for a sale stuck between "the buyer's offer is on the ledger" and "the broker matched it". Written before the code.
 *
 * A buy offer does not lock funds, so a buyer can spend the money after bidding. That is a reason to wait a while, not
 * a reason to wait forever: each wait backs off, there is a hard cap on how many times it is allowed, and past the cap
 * the sale is let go so the ticket can be sold to someone who can pay.
 */
import { describe, expect, it } from 'vitest'
import {
  CLAIM_LEASE_MS,
  MAX_SETTLE_STRIKES,
  SETTLE_BACKOFF_MS,
  STUCK_AFTER_MS,
  SWEEP_GRACE_MS,
  isFundsShortfall,
  settleStrike,
  stuckCutoff,
} from '../src/settle-policy.js'

const NOW = new Date('2026-11-01T12:00:00Z')

describe('settleStrike', () => {
  it('the first strike waits the first backoff and is not fatal', () => {
    const s = settleStrike(0, NOW)
    expect(s).toEqual({ strikes: 1, dead: false, nextAt: new Date(NOW.getTime() + SETTLE_BACKOFF_MS[0]!) })
  })

  it('counts up by one each time', () => {
    for (let i = 0; i < MAX_SETTLE_STRIKES; i++) expect(settleStrike(i, NOW).strikes).toBe(i + 1)
  })

  it('backs off: each wait is at least as long as the one before, and the later ones are strictly longer than the first', () => {
    const waits = Array.from({ length: MAX_SETTLE_STRIKES - 1 }, (_, i) => settleStrike(i, NOW).nextAt!.getTime() - NOW.getTime())
    for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1]!)
    expect(waits[waits.length - 1]).toBeGreaterThan(waits[0]!)
  })

  it('is fatal exactly at the cap, and not one strike before', () => {
    expect(settleStrike(MAX_SETTLE_STRIKES - 2, NOW).dead).toBe(false)
    expect(settleStrike(MAX_SETTLE_STRIKES - 1, NOW)).toMatchObject({ strikes: MAX_SETTLE_STRIKES, dead: true, nextAt: null })
  })

  it('stays fatal if somehow asked past the cap', () => {
    expect(settleStrike(MAX_SETTLE_STRIKES + 5, NOW).dead).toBe(true)
  })

  it('gives a buyer a real chance to fund (at least 10 minutes in total) without waiting indefinitely (at most an hour)', () => {
    let total = 0
    for (let i = 0; i < MAX_SETTLE_STRIKES - 1; i++) total += settleStrike(i, NOW).nextAt!.getTime() - NOW.getTime()
    expect(total).toBeGreaterThanOrEqual(10 * 60_000)
    expect(total).toBeLessThanOrEqual(60 * 60_000)
  })
})

describe('isFundsShortfall: only a genuinely broke buyer is waited for', () => {
  it('is true for the codes that mean "cannot pay"', () => {
    for (const c of ['tecINSUFFICIENT_FUNDS', 'tecUNFUNDED_OFFER']) expect(isFundsShortfall(c)).toBe(true)
  })
  it('is false for success, our own faults and vanished objects', () => {
    for (const c of ['tesSUCCESS', 'tecNO_PERMISSION', 'temMALFORMED', 'tecOBJECT_NOT_FOUND', 'tecNO_ENTRY', 'tefMAX_LEDGER']) {
      expect(isFundsShortfall(c)).toBe(false)
    }
  })
})

describe('timing constants', () => {
  it('the sweep waits 45 seconds before stepping in beside a live client', () => {
    expect(SWEEP_GRACE_MS).toBe(45_000)
  })
  it('an attempt is claimed for longer than a broker submit takes, but not for ever', () => {
    expect(CLAIM_LEASE_MS).toBeGreaterThanOrEqual(60_000)
    expect(CLAIM_LEASE_MS).toBeLessThanOrEqual(5 * 60_000)
  })
  it('a sale is "stuck" after 15 minutes in SETTLING', () => {
    expect(STUCK_AFTER_MS).toBe(15 * 60_000)
    expect(stuckCutoff(NOW).getTime()).toBe(NOW.getTime() - 15 * 60_000)
  })
})
