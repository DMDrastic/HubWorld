/**
 * What an XRPL result code actually means, as opposed to "not tesSUCCESS".
 *
 * Collapsing every failure into a boolean is how invisible failures happen, and
 * it has bitten this codebase in two directions:
 *
 *   - Settlement blamed the BIDDER for every failed brokered sale. That is right
 *     for `tecINSUFFICIENT_FUNDS` and wrong for `tecNO_PERMISSION`, which means
 *     the two offers name different brokers and is entirely our fault. Under the
 *     old rule a misconfiguration would march down the bid list marking one
 *     innocent bidder LOST after another until the auction had none left.
 *   - Bulk submission treated an advancing sequence as success. A `tec` consumes
 *     the sequence AND the fee while doing nothing, so hundreds of mints and
 *     sell offers reported success and did not exist.
 *
 * The load-bearing distinction is whether the transaction was APPLIED:
 *
 *   `tes`  succeeded.
 *   `tec`  applied and failed. Sequence and fee are consumed, so resubmitting
 *          the same sequence is invalid — this needs a new transaction.
 *   `tem`  malformed. Never applies, never will. Always our bug.
 *   `tef`  failed a precondition. Never applies. Usually our bug.
 *   `ter`  not applied yet; may apply later. Retry is legitimate.
 *   `tel`  rejected locally, never reached consensus. Retry is legitimate.
 *
 * Codes referenced here were observed on testnet and devnet, not guessed.
 */

export type ResultKind =
  /** Applied and succeeded. */
  | 'success'
  /**
   * The counterparty could not pay or is otherwise at fault. THE ONLY kind that
   * justifies demoting a bidder and moving to the runner-up.
   */
  | 'counterparty'
  /**
   * Something we control is wrong — malformed transaction, missing permission,
   * mismatched broker, unfunded platform account. Must NOT be blamed on a user.
   * Should page someone.
   */
  | 'ours'
  /** Did not apply; the same transaction can legitimately be retried. */
  | 'transient'
  /**
   * The thing being acted on is already gone — consumed, cancelled or expired.
   * Not a failure so much as news, and the cue to reconcile rather than retry.
   */
  | 'gone'

/**
 * `tec` codes that genuinely mean the counterparty cannot pay.
 *
 * Deliberately a small allow-list rather than "every tec": an unrecognised `tec`
 * is far more likely to be a misconfiguration on our side than a broke buyer,
 * and guessing wrong burns somebody's winning bid.
 */
const COUNTERPARTY = new Set([
  'tecINSUFFICIENT_FUNDS',
  'tecUNFUNDED',
  'tecUNFUNDED_OFFER',
  'tecUNFUNDED_PAYMENT',
  'tecINSUFFICIENT_PAYMENT',
])

/** The object is already gone. Reconcile; do not retry and do not blame anyone. */
const GONE = new Set([
  'tecOBJECT_NOT_FOUND',
  'tecNO_ENTRY',
  'tecEXPIRED',
  'tefALREADY',
])

/** Not applied, and legitimately retryable with the same transaction. */
const TRANSIENT_TEF = new Set(['tefMAX_LEDGER', 'tefPAST_SEQ'])

/**
 * Classify a raw XRPL engine result.
 *
 * Unknown or missing codes are `'ours'`, not `'transient'`: an unrecognised
 * failure should stop and be looked at rather than retry forever or be quietly
 * charged to a user.
 */
export function classifyResult(code: string | null | undefined): ResultKind {
  if (!code) return 'ours'
  if (code === 'tesSUCCESS') return 'success'

  if (GONE.has(code)) return 'gone'

  if (code.startsWith('tec')) {
    if (COUNTERPARTY.has(code)) return 'counterparty'
    // Everything else that APPLIED and failed — tecNO_PERMISSION,
    // tecINSUFFICIENT_RESERVE, tecNO_AUTH — is a configuration or funding
    // problem on our side.
    return 'ours'
  }

  // Never applied and may apply later: safe to retry as-is.
  if (code.startsWith('ter') || code.startsWith('tel')) return 'transient'
  if (TRANSIENT_TEF.has(code)) return 'transient'

  // temMALFORMED, tefBAD_AUTH and friends: never applies, never will.
  return 'ours'
}

/** Did this transaction change the ledger? `tec` did; nothing else that failed. */
export function wasApplied(code: string | null | undefined): boolean {
  if (!code) return false
  return code === 'tesSUCCESS' || code.startsWith('tec')
}

/**
 * May the SAME transaction be resubmitted unchanged?
 *
 * False for `tec` even though it failed, because the sequence is spent — a
 * resubmission would be rejected as a past sequence and look like a second,
 * different failure.
 */
export function isRetryable(code: string | null | undefined): boolean {
  return classifyResult(code) === 'transient' && !wasApplied(code)
}

/** One line for logs and `failureReason`, so the code is never lost. */
export function describeResult(code: string | null | undefined): string {
  const kind = classifyResult(code)
  const label: Record<ResultKind, string> = {
    success: 'succeeded',
    counterparty: 'the counterparty could not pay',
    ours: 'a problem on our side — do not blame the user',
    transient: 'not applied; retryable',
    gone: 'the target is already gone; reconcile',
  }
  return `${code ?? 'no result'} (${label[kind]})`
}
