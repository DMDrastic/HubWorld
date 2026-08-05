/**
 * What the Xaman quota has been spent on.
 *
 * This is the reporting half of payload accounting. The counting happens in the
 * signer seam and cannot be skipped; this reads it back.
 *
 * **Run it before and after the mainnet dress rehearsal.** The rehearsal's whole
 * purpose is converting guesses into numbers, and payload cost per attendee is
 * the one that decides whether the unit economics work at all. Taking a reading
 * either side turns "we did an event" into "an event of N tickets cost us M
 * payloads, of which this many were waste".
 *
 *   npm run payload:report
 *   npm run payload:report -- --days 7
 *   npm run payload:report -- --all-signers    include stub (costs no quota)
 *   npm run payload:report -- --network MAINNET
 */
import type { XrplNetwork } from '@prisma/client'
import { prisma } from '../src/prisma.js'
import { NETWORK } from '../src/network.js'
import { payloadUsage } from '../src/payload-metrics.js'

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main() {
  const days = Number(flag('days') ?? '0')
  const since = days > 0 ? new Date(Date.now() - days * 86_400_000) : undefined
  const network = (flag('network')?.toUpperCase() as XrplNetwork | undefined) ?? NETWORK

  // Stub payloads cost nothing, and the e2e suite makes them by the dozen.
  // Counting them by default would overstate spend in the one direction that
  // hides a real problem, so they are opt-in.
  const signers = process.argv.includes('--all-signers')
    ? ['xaman', 'stub', 'unknown']
    : ['xaman']

  for (const signer of signers) {
    const u = await payloadUsage({ since, network, signer })
    const window = u.since ? `since ${u.since.toISOString().slice(0, 10)}` : 'all time'

    console.log(`\n  ${signer} · ${u.network} · ${window}`)
    console.log('  ' + '─'.repeat(58))

    if (u.created === 0) {
      console.log('  No payloads recorded.')
      continue
    }

    const pad = (n: number, w = 6) => String(n).padStart(w)
    console.log(`  created ${pad(u.created)}   quota consumed, unreclaimable`)
    console.log(
      `  signed  ${pad(u.signed)}   ${((u.signed / u.created) * 100).toFixed(0)}% of what we spent`,
    )
    console.log(
      `  wasted  ${pad(u.wasted)}   resolved without a signature — the only part code can improve`,
    )

    console.log('\n  by flow')
    const width = Math.max(...u.byFlow.map((r) => (r.flow ?? 'unattributed').length))
    for (const row of u.byFlow) {
      const name = (row.flow ?? 'unattributed').toLowerCase().padEnd(width)
      const bar = '█'.repeat(Math.max(1, Math.round((row.created / u.created) * 24)))
      console.log(`    ${name}  ${pad(row.created, 5)}  ${bar}`)
    }

    if (u.perIdentifiedUser !== null) {
      console.log(
        `\n  ${u.perIdentifiedUser.toFixed(1)} attributed payloads per identified user ` +
          `(${u.distinctUsers} users)`,
      )
      // Stated every time, because the number is tempting to quote alone and it
      // is not the cost per attendee. Sign-in and door check-in have no user
      // attached, and every attendee goes through both.
      console.log('  A FLOOR, not the true cost: signin and door_checkin are unattributable.')
    }
  }
  console.log('')
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
