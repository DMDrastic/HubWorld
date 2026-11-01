import { delegateMode, ledgerMode } from './env.js'
import { delegateAddress } from './ledger.js'

/** Whether a signer exists to be authorised. Stub mode fabricates one. */
export const delegateConfigured = delegateMode === 'live' || ledgerMode === 'stub'

/**
 * The delegate account an organizer would authorise right now, or null when this
 * deployment has none. A bad seed is "not configured" too: deriving an address
 * asks whether the seed is USABLE, which is a different question from whether it
 * is present.
 */
export function currentDelegate(): string | null {
  if (!delegateConfigured) return null
  try {
    return delegateAddress()
  } catch {
    return null
  }
}
