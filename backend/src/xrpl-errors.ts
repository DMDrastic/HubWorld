/**
 * Whether a failed `tx` lookup means "this node has not seen the transaction".
 *
 * xrpl.js reports it as a RippledError whose MESSAGE is "Transaction not found."
 * and whose code `txnNotFound` lives only on `err.data.error`, so matching the
 * message alone never fires. A single-node devnet always has the transaction, so
 * it hid this; mainnet's cluster answers it for a just-submitted hash.
 */
export function isTxNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { data?: { error?: unknown } }).data?.error
  return code === 'txnNotFound' || /txnNotFound|transaction not found/i.test(err.message)
}

/**
 * Whether a failed `ledger_entry` means "no such object", as opposed to the node being unreachable or refusing us.
 *
 * The distinction is the whole point: a vanished offer is a fact about the ledger, a blinking node is a fact about the
 * network, and treating the second as the first would let go of a perfectly good sale.
 */
export function isEntryNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { data?: { error?: unknown } }).data?.error
  return code === 'entryNotFound' || /entryNotFound|entry not found/i.test(err.message)
}

/**
 * Whether a failed `account_info` means "this account does not exist (yet)", as opposed to the node being unreachable.
 * A brand-new wallet has no account on the ledger until it holds the base reserve, which is normal, not a failure.
 */
export function isAccountNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { data?: { error?: unknown } }).data?.error
  return code === 'actNotFound' || /actNotFound|account not found/i.test(err.message)
}

/** A public node refusing us for asking too much, which is a reason to wait, not to fail. */
export function isRateLimited(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { data?: { error?: unknown } }).data?.error
  return code === 'tooBusy' || code === 'slowDown' || /rate limit|too busy|slow ?down/i.test(err.message)
}

/** The node's own hint ("retry in ~12460ms"), when it gives one. */
export function retryAfterMs(err: unknown): number | null {
  const m = err instanceof Error ? /retry in ~?(\d+)\s*ms/i.exec(err.message) : null
  return m ? Number(m[1]) : null
}

const BACKOFF_ATTEMPTS = 6
const BACKOFF_FLOOR_MS = 1_000
const BACKOFF_CAP_MS = 20_000

/**
 * Runs a read, waiting out a rate limit instead of failing on it.
 *
 * Mainnet's public cluster meters each client (10,000 units per 60s was the
 * measured quota), and a 1,000-ticket run polls enough to reach it. The error
 * says nothing about the account or the transaction, so a bulk run that dies
 * on it strands whatever it was holding. Anything that is not a rate limit is
 * rethrown at once.
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (!isRateLimited(err) || attempt >= BACKOFF_ATTEMPTS) throw err
      const hint = retryAfterMs(err) ?? 0
      await sleep(Math.min(BACKOFF_CAP_MS, Math.max(BACKOFF_FLOOR_MS, hint + 250)))
    }
  }
}
