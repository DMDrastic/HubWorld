import { accountFunding } from './ledger.js'

/**
 * Can a fee-paying account actually pay?
 *
 * Shared by the broker (pays every settlement) and the delegate (pays every
 * delegated mint). Both fail the same way: run dry and a whole class of work
 * stops, silently, with no request erroring. The reading rules are therefore the
 * same, and are written once.
 */

/**
 * Below this, say so. Not a cliff — fees are ~12 drops, so 0.5 XRP is tens of
 * thousands of transactions — but an account drifting toward its reserve is a
 * fact worth surfacing while there is still time to act on it.
 */
const LOW_WATERMARK_DROPS = 500_000n

/**
 * How long a reading is reused.
 *
 * /api/health is polled by the host's health check and by the frontend, and a
 * balance does not move between two polls a second apart. Without this, every
 * poll would be an `account_info` round trip to a public XRPL node — turning a
 * liveness probe into sustained load on someone else's infrastructure.
 */
const TTL_MS = 60_000

/** A ledger read that hangs must not hang the health endpoint. */
const TIMEOUT_MS = 2_000

export type AccountHealth =
  /** Not configured: a choice, not a fault. */
  | { mode: 'disabled' }
  /**
   * A key IS configured but cannot be turned into an account — a malformed or
   * truncated seed. A fault rather than a choice, and not a ledger problem: no
   * retry will fix it.
   */
  | { mode: 'misconfigured' }
  /**
   * `unknown` is a distinct outcome and must stay that way. "We could not read
   * the ledger" and "the balance is zero" are opposite facts, and collapsing
   * them would raise a funding alarm every time a public node is briefly
   * unreachable.
   */
  | { mode: 'live'; address: string; status: 'unknown' }
  | { mode: 'live'; address: string; status: 'ok' | 'low' | 'unfunded'; spendableDrops: bigint }

/**
 * Build a cached reader for one account.
 *
 * `enabled` says whether a key is configured at all; `address` derives it and may
 * throw. They are separate on purpose: presence of a seed is not validity of it,
 * and deriving the address outside a guard once let a malformed seed turn the
 * one endpoint that must always answer 200 into a 500.
 */
export function accountHealthReader(source: { enabled: () => boolean; address: () => string }) {
  let cached: { at: number; value: AccountHealth } | null = null

  return {
    reset(): void {
      cached = null
    },

    async read(now = Date.now()): Promise<AccountHealth> {
      if (!source.enabled()) return { mode: 'disabled' }
      if (cached && now - cached.at < TTL_MS) return cached.value

      let address: string
      try {
        address = source.address()
      } catch {
        const value = { mode: 'misconfigured' } as const
        cached = { at: now, value }
        return value
      }

      let value: AccountHealth
      try {
        const funding = await Promise.race([
          accountFunding(address),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timed out reading balance')), TIMEOUT_MS).unref(),
          ),
        ])

        const spendableDrops = funding.spendableDrops
        value = {
          mode: 'live',
          address,
          // Zero spendable is not necessarily an empty account — one exactly at
          // its reserve reads zero too. Either way it cannot pay a fee, which is
          // the question being asked.
          status:
            spendableDrops === 0n ? 'unfunded' : spendableDrops < LOW_WATERMARK_DROPS ? 'low' : 'ok',
          spendableDrops,
        }
      } catch {
        value = { mode: 'live', address, status: 'unknown' }
      }

      cached = { at: now, value }
      return value
    },
  }
}
