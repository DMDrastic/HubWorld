/**
 * Test helper: what the server sends beside each XRP amount when it has a fresh price. At US$1 per XRP, so a fixture's
 * "25 XRP" reads as "US$25.00" and the arithmetic in an assertion stays obvious.
 */
import type { Fiat } from '@/lib/api'

const usdAt1 = (drops: string): Fiat => ({ currency: 'USD', minor: String(BigInt(drops) / 10_000n) })

/** The `fiat` map for every `...Drops` field on `row` that holds an amount. */
export function priced<T extends Record<string, unknown>>(row: T): T & { fiat: Record<string, Fiat> } {
  const fiat: Record<string, Fiat> = {}
  for (const [k, v] of Object.entries(row)) if (k.endsWith('Drops') && typeof v === 'string' && /^\d+$/.test(v)) fiat[k] = usdAt1(v)
  // A listing's seller share before royalty, as the server adds it.
  if (typeof row.priceDrops === 'string' && typeof row.platformFeeDrops === 'string') {
    const receives = row.feeModel === 'SELLER_PAYS_V2' ? BigInt(row.priceDrops) - BigInt(row.platformFeeDrops) : BigInt(row.priceDrops)
    fiat.sellerReceivesDrops = usdAt1(receives.toString())
  }
  return { ...row, fiat }
}
