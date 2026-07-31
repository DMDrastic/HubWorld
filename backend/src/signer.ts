/**
 * Did the account we built a payload for actually sign it?
 *
 * Xaman holds many accounts, and the user picks which one signs. A payload is
 * built FOR a specific account, but nothing in the returned signature ties it to
 * that account — so unless this is checked, whoever signs becomes the on-ledger
 * actor while our row still names whoever was signed in to Hubworld.
 *
 * Observed for real on testnet: a bid was started while signed in as one user,
 * signed with a different wallet, and committed under the first user's name.
 *
 * The consequences differ per flow and none are cosmetic:
 *
 *   - **Bid** — `Bid.bidderAddress` is what settlement reads spendable balance
 *     from, so it would check an account that is not paying. Worse, it lets the
 *     ISSUER bid on their own event while appearing to be someone else, which
 *     `auction-policy` deliberately prevents on the selling side — and XRPL
 *     skips `TransferFee` when the issuer is party to a trade, so such a sale
 *     silently pays no royalty.
 *   - **Gift** — ownership moves to an account we never recorded, while the
 *     GIFT provenance row names the intended party.
 *   - **Mint** — the signer becomes the NFT's ISSUER, and the issuer is who
 *     `TransferFee` pays. This one is UNFIXABLE afterwards: the issuer is baked
 *     into the NFTokenID, so a mint signed by the wrong account produces a
 *     ticket whose royalties go elsewhere forever.
 *
 * Redemption is the one flow that does not need this, because there the signing
 * address IS the claim being made — check-in asks "who signed", not "did the
 * expected person sign".
 */

/**
 * True when a payload was demonstrably signed by an account other than the one
 * it was built for.
 *
 * Returns FALSE when either address is missing, which is the deliberate choice:
 * absence is not evidence of a mismatch. Xaman may report a signature before the
 * account is known, and older rows predate `bidderAddress` being recorded — in
 * both cases we cannot verify, and blocking on "cannot verify" would reject
 * legitimate signatures. Callers must therefore treat this as a check that
 * catches a real mismatch, not as proof the right account signed.
 *
 * Comparison is exact. XRPL addresses are base58 and case-sensitive, so
 * normalising case would make distinct addresses compare equal.
 */
export function signedByOtherAccount(
  expected: string | null | undefined,
  signer: string | null | undefined,
): boolean {
  if (!expected || !signer) return false
  return expected !== signer
}
