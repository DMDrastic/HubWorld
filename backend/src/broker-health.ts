import { brokerMode } from './env.js'
import { accountHealthReader, type AccountHealth } from './account-health.js'
import { platformAddress } from './ledger.js'

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

export type BrokerHealth = AccountHealth

const reader = accountHealthReader({
  enabled: () => brokerMode === 'live',
  address: platformAddress,
})

/** Exported for tests; nothing in the app should need to clear this. */
export function resetBrokerHealthCache(): void {
  reader.reset()
}

export function brokerHealth(now = Date.now()): Promise<BrokerHealth> {
  return reader.read(now)
}
