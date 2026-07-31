/**
 * Signer verification.
 *
 * A Xaman payload is built FOR one account, but the user chooses which of their
 * accounts signs it. Nothing in the returned signature ties it to the intended
 * account, so every flow that builds a payload for a known party has to check.
 *
 * This was found the hard way on testnet: a bid started while signed in as one
 * user was signed with a different wallet and committed under the first user's
 * name. What makes it more than a bookkeeping error is that the OTHER wallet was
 * the event's issuer — and XRPL skips `TransferFee` entirely when the issuer is
 * party to a trade, so had that bid won, the sale would have paid no royalty
 * while the database recorded a completely different buyer.
 */
import { describe, expect, it } from 'vitest'
import { signedByOtherAccount } from '../src/signer.js'

const ALICE = 'r4wQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf'
const BOB = 'rGprrMfw6mhSm6YbERrN3zthsyJCNkCTGG'

describe('signedByOtherAccount', () => {
  it('accepts the account the payload was built for', () => {
    expect(signedByOtherAccount(ALICE, ALICE)).toBe(false)
  })

  it('catches a different account signing — the bug this exists for', () => {
    expect(signedByOtherAccount(ALICE, BOB)).toBe(true)
  })

  // Absence is not evidence of a mismatch. Xaman can report a signature before
  // the account is known, and rows predating `bidderAddress` have no expected
  // address to compare against. Blocking on "cannot verify" would reject
  // legitimate signatures, so these must NOT be treated as mismatches.
  it('does not flag a mismatch when the expected address is unknown', () => {
    expect(signedByOtherAccount(null, BOB)).toBe(false)
    expect(signedByOtherAccount(undefined, BOB)).toBe(false)
    expect(signedByOtherAccount('', BOB)).toBe(false)
  })

  it('does not flag a mismatch when the signer is not yet known', () => {
    expect(signedByOtherAccount(ALICE, null)).toBe(false)
    expect(signedByOtherAccount(ALICE, undefined)).toBe(false)
    expect(signedByOtherAccount(ALICE, '')).toBe(false)
  })

  // XRPL addresses are base58 and case-sensitive: `rABC…` and `rabc…` are
  // different accounts, not the same one written two ways. Normalising case
  // would make two distinct wallets compare equal, which is precisely the
  // confusion this function exists to prevent.
  it('compares exactly, because address case is significant', () => {
    expect(signedByOtherAccount(ALICE, ALICE.toLowerCase())).toBe(true)
    expect(signedByOtherAccount(ALICE, ALICE.toUpperCase())).toBe(true)
  })

  it('treats a leading- or trailing-whitespace variant as a different account', () => {
    // No trimming: an address with stray whitespace is not the same string, and
    // silently accepting it would mean trusting a value we did not verify.
    expect(signedByOtherAccount(ALICE, ` ${ALICE}`)).toBe(true)
    expect(signedByOtherAccount(ALICE, `${ALICE} `)).toBe(true)
  })
})
