/**
 * Stamp `Listing.brokerAddress` on rows written before that column existed.
 *
 * Those listings' offers already name a broker in their on-ledger `Destination`
 * — we simply never recorded which. Until they are stamped, the code falls back
 * to "whatever `PLATFORM_SEED` is now", which is correct only while the key has
 * never changed.
 *
 * **Run this before any platform key rotation.** Rotating first makes the
 * fallback wrong and there is no way to recover the answer from our own data:
 * every affected offer becomes unsettleable, with nothing recording which key
 * it needed.
 *
 * Dry run by default, like `ledger:sync`, because a reconciler that rewrites
 * silently is worse than the gap it closes.
 *
 *   npm run broker:backfill
 *   npm run broker:backfill -- --apply
 */
import { prisma } from '../src/prisma.js'
import { platformAddress } from '../src/ledger.js'
import { disconnectLedger } from '../src/ledger.js'
import { brokerMode } from '../src/env.js'

const APPLY = process.argv.includes('--apply')

async function main() {
  if (brokerMode === 'disabled') {
    console.error('PLATFORM_SEED is not set, so there is no broker address to stamp.')
    process.exit(1)
  }
  const address = platformAddress()

  const missing = await prisma.listing.findMany({
    where: { brokerAddress: null },
    select: { id: true, status: true },
  })

  if (missing.length === 0) {
    console.log('Every listing already records its broker. Nothing to do.')
    await prisma.$disconnect()
    await disconnectLedger()
    return
  }

  const byStatus = new Map<string, number>()
  for (const l of missing) byStatus.set(l.status, (byStatus.get(l.status) ?? 0) + 1)

  console.log(`${missing.length} listing(s) with no recorded broker:`)
  for (const [status, n] of [...byStatus].sort()) console.log(`  ${status.padEnd(16)} ${n}`)
  console.log(`\nWould stamp all of them with: ${address}`)
  console.log('This is only correct if the platform key has NEVER been rotated.')

  if (!APPLY) {
    console.log('\nDry run. Re-run with -- --apply to write.')
    await prisma.$disconnect()
    await disconnectLedger()
    return
  }

  const { count } = await prisma.listing.updateMany({
    where: { brokerAddress: null },
    data: { brokerAddress: address },
  })
  console.log(`\nStamped ${count} listing(s).`)

  await prisma.$disconnect()
  // The websocket keeps the event loop alive; without this the script hangs and
  // its output is never flushed.
  await disconnectLedger()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  await disconnectLedger()
  process.exit(1)
})
