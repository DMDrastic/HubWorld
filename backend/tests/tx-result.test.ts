/**
 * Classifying XRPL result codes.
 *
 * This exists because "not tesSUCCESS" is not a diagnosis, and treating it as
 * one produced two real invisible failures:
 *
 *   - Settlement blamed the BIDDER for every failed brokered sale. Correct for
 *     `tecINSUFFICIENT_FUNDS`; catastrophic for `tecNO_PERMISSION`, where the
 *     two offers name different brokers and nothing is wrong with the bidder at
 *     all. One misconfiguration would walk the bid list marking good bidders
 *     LOST until the auction had none left.
 *   - Bulk submission read an advancing sequence as success. A `tec` consumes
 *     the sequence and the fee while changing nothing, so hundreds of mints
 *     "succeeded" and did not exist.
 *
 * Every code asserted here was OBSERVED on testnet or devnet during the
 * delegation and MPT work, not taken from documentation.
 */
import { describe, expect, it } from 'vitest'
import { classifyResult, describeResult, isRetryable, wasApplied } from '../src/tx-result.js'

describe('classifyResult', () => {
  it('recognises success', () => {
    expect(classifyResult('tesSUCCESS')).toBe('success')
  })

  /**
   * The ONLY category that may demote a bidder. Kept to a small allow-list on
   * purpose — an unrecognised `tec` is far likelier to be our misconfiguration
   * than a broke buyer, and guessing wrong destroys a winning bid.
   */
  it('blames the counterparty only when they genuinely cannot pay', () => {
    expect(classifyResult('tecINSUFFICIENT_FUNDS')).toBe('counterparty')
    expect(classifyResult('tecUNFUNDED_OFFER')).toBe('counterparty')
    expect(classifyResult('tecINSUFFICIENT_PAYMENT')).toBe('counterparty')
  })

  /**
   * The regression that matters most. `tecNO_PERMISSION` is what a brokered
   * accept returns when the offers name a different broker — entirely our
   * problem, and the exact failure `Listing.brokerAddress` was added to prevent.
   * It must never be charged to a bidder.
   */
  it('does NOT blame the counterparty for our own misconfiguration', () => {
    for (const code of [
      'tecNO_PERMISSION', // offers name a different broker
      'tecINSUFFICIENT_RESERVE', // observed when listing 1,000 tickets at once
      'tecNO_AUTH', // observed paying an MPT holder who had not opted in
      'tefBAD_AUTH', // observed minting without NFTokenMinter authorisation
      'temDISABLED', // observed offering an MPT on the DEX
      'temMALFORMED',
    ]) {
      expect(classifyResult(code), code).toBe('ours')
    }
  })

  it('treats codes that never applied as retryable', () => {
    // All observed during bulk submission.
    expect(classifyResult('terPRE_SEQ')).toBe('transient')
    expect(classifyResult('terQUEUED')).toBe('transient')
    expect(classifyResult('telCAN_NOT_QUEUE')).toBe('transient')
    expect(classifyResult('tefMAX_LEDGER')).toBe('transient')
  })

  /** `terNO_DELEGATE_PERMISSION` is a `ter`, so it retries rather than alarms. */
  it('classifies a revoked delegation as transient, by prefix', () => {
    // Observed after revoking a mint delegation. It is retryable in the literal
    // sense — the same transaction would work if the grant came back — so the
    // prefix rule is honoured rather than special-cased.
    expect(classifyResult('terNO_DELEGATE_PERMISSION')).toBe('transient')
  })

  it('reports an already-consumed target as gone rather than failed', () => {
    expect(classifyResult('tecOBJECT_NOT_FOUND')).toBe('gone')
    expect(classifyResult('tefALREADY')).toBe('gone')
  })

  /**
   * An unknown failure must stop and be looked at. Defaulting to 'transient'
   * would retry forever; defaulting to 'counterparty' would quietly charge it
   * to a user.
   */
  it('treats unknown and missing codes as ours', () => {
    expect(classifyResult('tecSOMETHING_NEW')).toBe('ours')
    expect(classifyResult('wat')).toBe('ours')
    expect(classifyResult(null)).toBe('ours')
    expect(classifyResult(undefined)).toBe('ours')
    expect(classifyResult('')).toBe('ours')
  })
})

describe('wasApplied', () => {
  /**
   * The distinction that made 598 mints disappear. A `tec` consumes the
   * sequence and the fee, so an advancing sequence proves the transaction was
   * INCLUDED — never that it did what was asked.
   */
  it('is true for tec even though tec failed', () => {
    expect(wasApplied('tesSUCCESS')).toBe(true)
    expect(wasApplied('tecINSUFFICIENT_RESERVE')).toBe(true)
    expect(wasApplied('tecNO_PERMISSION')).toBe(true)
  })

  it('is false for everything that never reached the ledger', () => {
    for (const code of ['terPRE_SEQ', 'telCAN_NOT_QUEUE', 'tefBAD_AUTH', 'temMALFORMED', null]) {
      expect(wasApplied(code), String(code)).toBe(false)
    }
  })
})

describe('isRetryable', () => {
  /**
   * A `tec` must never be resubmitted unchanged: its sequence is spent, so the
   * retry is rejected as a past sequence and looks like a second, different
   * failure.
   */
  it('refuses to retry anything that consumed its sequence', () => {
    expect(isRetryable('tecINSUFFICIENT_RESERVE')).toBe(false)
    expect(isRetryable('tecINSUFFICIENT_FUNDS')).toBe(false)
  })

  it('allows retrying what never applied', () => {
    expect(isRetryable('terPRE_SEQ')).toBe(true)
    expect(isRetryable('telCAN_NOT_QUEUE')).toBe(true)
  })

  it('does not retry our own bugs', () => {
    expect(isRetryable('temMALFORMED')).toBe(false)
    expect(isRetryable('tefBAD_AUTH')).toBe(false)
  })
})

describe('describeResult', () => {
  /** The raw code must survive into logs and `failureReason`, never be swallowed. */
  it('keeps the code and adds what it means', () => {
    expect(describeResult('tecNO_PERMISSION')).toContain('tecNO_PERMISSION')
    expect(describeResult('tecNO_PERMISSION')).toMatch(/our side/i)
    expect(describeResult('tecINSUFFICIENT_FUNDS')).toMatch(/could not pay/i)
    expect(describeResult(null)).toContain('no result')
  })
})
