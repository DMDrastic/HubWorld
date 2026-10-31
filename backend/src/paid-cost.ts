/**
 * What a ticket's buyer paid, for the resale cap, while the new fee model is on.
 *
 * Returns nothing at all when the model is off, so every caller behaves exactly as it did before. With the
 * model on it returns what was recorded on the ticket, which is `minor: null` for a ticket sold before the
 * amount existed or never sold (the cap then leaves the organizer's policy alone).
 */
import type { PriceCurrency } from '@prisma/client'
import { feeModelV2 } from './env.js'
import type { PaidCost } from './resale-policy.js'

export function paidCostOf(ticket: {
  originalCostMinor: bigint | null
  originalCostCurrency: PriceCurrency | null
}): PaidCost | undefined {
  if (!feeModelV2) return undefined
  return { minor: ticket.originalCostMinor, currency: ticket.originalCostCurrency }
}
