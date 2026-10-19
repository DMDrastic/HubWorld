import { delegateMode } from './env.js'
import { accountHealthReader, type AccountHealth } from './account-health.js'
import { delegateAddress } from './ledger.js'

/**
 * Can the delegate pay for delegated mints?
 *
 * It pays the fee of every ticket it mints on an organizer's behalf, so a dry
 * delegate stops every bulk mint on the platform at once — and, like the broker,
 * stops it silently. Same reading rules, shared in `account-health.ts`.
 *
 * Stub mode reports `disabled`: there is no real account to be short of money.
 */
export type DelegateHealth = AccountHealth

const reader = accountHealthReader({
  enabled: () => delegateMode === 'live',
  address: delegateAddress,
})

export function resetDelegateHealthCache(): void {
  reader.reset()
}

export function delegateHealth(now = Date.now()): Promise<DelegateHealth> {
  return reader.read(now)
}
