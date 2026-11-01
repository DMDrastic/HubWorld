/**
 * Move every box-office price still in XRP to US$, at today's price, and log each conversion (item 1b-i).
 *
 *   npx tsx scripts/price-in-usd.ts            dry run: what it would do, and at what rate
 *   npx tsx scripts/price-in-usd.ts --apply    do it
 *
 * Uses only a FRESH stored price (under two hours old, PRICE_FEED on), never the manual XRP_USD_CENTS. Refuses a
 * database that is not local unless --allow-remote-database is passed (the deliberate act shows in shell history).
 * Logic and tests: src/price-conversion.ts, tests/price-conversion.test.ts.
 */
import { prisma } from '../src/prisma.js'
import { assertSafeDatabase } from '../src/db-guard.js'
import { currentQuoteRate } from '../src/xrp-quote.js'
import { convertEventPricesToUsd } from '../src/price-conversion.js'

const usd = (cents: bigint) => `US$${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`
const xrp = (drops: bigint) => `${drops / 1_000_000n}.${(drops % 1_000_000n).toString().padStart(6, '0')} XRP`

async function main() {
  assertSafeDatabase('price-in-usd')
  const apply = process.argv.includes('--apply')
  const rate = await currentQuoteRate()
  if (!rate) throw new Error('refusing: no fresh XRP price (PRICE_FEED must be on and the stored price under two hours old)')
  console.log(`rate: US$${Number(rate.microUsdPerXrp) / 1e6} per XRP, read ${rate.at.toISOString()}${apply ? '' : '  (dry run: nothing changes; --apply to convert)'}`)
  const done = await convertEventPricesToUsd({ apply, rate })
  if (done.length === 0) console.log('nothing to convert')
  for (const c of done) {
    console.log(`  ${c.slug}: ${xrp(c.fromDrops)} -> ${c.skipped ? `skipped (${c.skipped})` : usd(c.toCents)}${c.applied ? '  converted, logged' : ''}`)
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
