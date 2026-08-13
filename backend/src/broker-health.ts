import { brokerMode } from './env.js'
import { accountFunding, platformAddress } from './ledger.js'

/**
 * Is the broker able to settle sales?
 *
 * Settlement costs HubWorld the transaction fee, because the broker is the
 * account that submits `NFTokenAcceptOffer`. A broker that runs out therefore
 * stops settling every sale on the platform at once — and stops them SILENTLY.
 * Nothing fails a health check, no request errors; auctions simply close and
 * never complete, and the first report comes from a customer.
 *
 * Roadmap §4 carries this as a missing safety net. This is the smallest thing
 * that makes it visible from outside the process, which is the same argument
 * that put `commit` and `network` on /api/health.
 */

/**
 * Below this, say so. Not a cliff — fees are ~10 drops, so 0.5 XRP is tens of
 * thousands of settlements — but a broker drifting down toward its reserve is a
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

export type BrokerHealth =
  /** No PLATFORM_SEED: sales cannot settle, and that is configuration, not a fault. */
  | { mode: 'disabled' }
  /**
   * A key IS configured but cannot be turned into an account — a malformed or
   * truncated seed.
   *
   * Distinct from `disabled` because it is a fault rather than a choice: the
   * operator believes settlement is on, and it is not. Distinct from `unknown`
   * because nothing about the ledger is in doubt; the configuration is simply
   * wrong, and no retry will fix it.
   */
  | { mode: 'misconfigured' }
  /**
   * `unknown` is a distinct outcome and must stay that way. "We could not read
   * the ledger" and "the balance is zero" are opposite facts, and collapsing
   * them would raise a funding alarm every time a public node is briefly
   * unreachable — the same rule the bid headroom fields follow.
   */
  | { mode: 'live'; address: string; status: 'unknown' }
  | { mode: 'live'; address: string; status: 'ok' | 'low' | 'unfunded'; spendableDrops: bigint }

let cached: { at: number; value: BrokerHealth } | null = null

/** Exported for tests; nothing in the app should need to clear this. */
export function resetBrokerHealthCache(): void {
  cached = null
}

export async function brokerHealth(now = Date.now()): Promise<BrokerHealth> {
  if (brokerMode !== 'live') return { mode: 'disabled' }

  if (cached && now - cached.at < TTL_MS) return cached.value

  // Deriving the address is itself fallible: `brokerMode` only asks whether
  // PLATFORM_SEED is PRESENT, while `platformWallet` asks whether it is a
  // usable seed, and those are different questions. Calling it outside this
  // guard let a malformed seed throw straight through the health route — which
  // answered 500 to a request whose entire contract is that it always answers
  // 200. Caught by CI, where brokerMode is forced live with no seed set.
  let address: string
  try {
    address = platformAddress()
  } catch {
    const value = { mode: 'misconfigured' } as const
    cached = { at: now, value }
    return value
  }

  let value: BrokerHealth
  try {
    const funding = await Promise.race([
      accountFunding(address),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out reading broker balance')), TIMEOUT_MS).unref(),
      ),
    ])

    const spendableDrops = funding.spendableDrops
    value = {
      mode: 'live',
      address,
      // Zero spendable is not necessarily an empty account — an account exactly
      // at its reserve reads zero too. Either way it cannot pay a fee, which is
      // the question being asked.
      status: spendableDrops === 0n ? 'unfunded' : spendableDrops < LOW_WATERMARK_DROPS ? 'low' : 'ok',
      spendableDrops,
    }
  } catch {
    value = { mode: 'live', address, status: 'unknown' }
  }

  cached = { at: now, value }
  return value
}
