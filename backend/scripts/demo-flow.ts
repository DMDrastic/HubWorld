/**
 * Put the product into a state ready for a LIVE, repeatable flow walkthrough —
 * mint, gift, sell, auction, bid, settle, check in — filmable with zero phone
 * taps and zero collisions with real dev/testnet state.
 *
 *   npm run demo:flow
 *   npm run demo:flow -- --tickets 4 --clean
 *   npm run demo:flow -- --autosign --as attendee1
 *
 * This is the companion to `demo:seed`, not a replacement for it. `demo:seed`
 * fabricates a FINISHED state (fixtures, no ledger, nothing signable) for a
 * screenshot/b-roll clip of the UI. This script does the opposite: it creates
 * a real, empty, unsold event and leaves every step — mint, gift, list, bid,
 * settle, check in — to actually happen through the running app, resolved by
 * the in-memory fake ledger in `src/stub-ledger.ts` instead of a real one.
 * The QR/poll/state-transition UI is exactly what it is in production; only
 * what resolves it is fake.
 *
 * --autosign runs a polling loop that resolves pending Xaman payloads
 * automatically, so clicking through the UI on camera doesn't need a manual
 * curl call between every step:
 *   - mint/gift/list/auction/bid payloads are attributed to a userId, so
 *     they resolve unambiguously regardless of which actor is "current".
 *   - SignIn/door-check-in payloads carry no userId (nobody is authenticated
 *     yet), so `--as <role>` says who is signing in right now. Switch actors
 *     between takes by restarting the loop with a different `--as`.
 */
import { prisma } from '../src/prisma.js'
import { NETWORK } from '../src/network.js'
import { env, xamanMode } from '../src/env.js'
import { assertSafeDatabase } from '../src/db-guard.js'

const TAG = 'flowdemo-'
const SLUG = `${TAG}live-walkthrough`
const TITLE = 'Live Walkthrough'

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Deterministic, base58-valid, obviously-fabricated XRPL address. */
function fabricatedAddress(seedIndex: number): string {
  let s = ''
  let n = (seedIndex * 2654435761 + 12345) >>> 0
  for (let i = 0; i < 33; i++) {
    n = (n * 1103515245 + 12345) >>> 0
    s += B58[n % B58.length]
  }
  return `r${s}`
}

const ACTORS = ['attendee1', 'attendee2', 'attendee3'] as const
type Actor = (typeof ACTORS)[number]

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const flag = (name: string) => process.argv.includes(`--${name}`)

async function clean() {
  const where = { event: { slug: SLUG } }
  await prisma.bid.deleteMany({ where: { auction: { ticket: where } } })
  await prisma.listing.deleteMany({ where: { ticket: where } })
  await prisma.auction.deleteMany({ where: { ticket: where } })
  await prisma.transfer.deleteMany({ where: { ticket: where } })
  await prisma.redemption.deleteMany({ where: { event: { slug: SLUG } } })
  await prisma.gift.deleteMany({ where: { ticket: where } })
  await prisma.ticket.deleteMany({ where: { event: { slug: SLUG } } })
  // demo-seed.ts never needed this: it writes Ticket rows directly and never
  // goes through the real mint route. This script does, so real MintRequest
  // rows exist and Event has no cascade for them.
  await prisma.mintRequest.deleteMany({ where: { event: { slug: SLUG } } })
  await prisma.event.deleteMany({ where: { slug: SLUG } })
}

async function autosign(apiUrl: string, knownUserIds: Set<string>, asLabel: string, asAddress: string) {
  console.log(`\nautosign running against ${apiUrl} — anonymous sign-ins resolve as ${asLabel} (${asAddress})`)
  console.log('Ctrl+C to stop.\n')

  for (;;) {
    const pending = await prisma.xamanPayload.findMany({
      where: { terminal: false, signer: 'stub' },
      select: { uuid: true, userId: true, flow: true },
    })
    for (const p of pending) {
      const account = p.userId && knownUserIds.has(p.userId)
        ? (await prisma.user.findUnique({ where: { id: p.userId } }))?.xrplAddress
        : asAddress
      if (!account) continue
      try {
        const res = await fetch(`${apiUrl}/dev/payloads/${p.uuid}/simulate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account, outcome: 'sign' }),
        })
        if (res.ok) console.log(`  signed ${p.flow ?? '?'} ${p.uuid.slice(0, 8)} as ${account.slice(0, 10)}…`)
      } catch (err) {
        console.log(`  simulate call failed: ${(err as Error).message}`)
      }
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
}

async function main() {
  assertSafeDatabase('demo:flow')
  if (env.XRPL_NETWORK === 'mainnet') {
    console.error('Refusing to run against mainnet.')
    process.exit(1)
  }
  if (xamanMode !== 'stub') {
    console.error('demo:flow needs stub mode — unset XAMAN_API_KEY/XAMAN_API_SECRET.')
    process.exit(1)
  }
  if (!env.PLATFORM_SEED) {
    console.error(
      'PLATFORM_SEED is not set. Any valid seed works — brokerSale is faked in stub mode, ' +
        "so it does not need to be funded. Generate one with:\n" +
        `  node -e "console.log(require('xrpl').Wallet.generate().seed)"`,
    )
    process.exit(1)
  }

  const ticketCount = Number(arg('tickets') ?? 4)
  const organizerHandle = (arg('organizer') ?? 'dm_drastic').replace(/^@/, '')
  const apiUrl = arg('api-url') ?? 'http://localhost:4000/api'

  if (flag('clean')) {
    await clean()
    console.log('cleaned previous demo-flow data')
  }

  const organizer = await prisma.user.findUnique({ where: { username: organizerHandle } })
  if (!organizer) {
    console.error(`No user @${organizerHandle}. Sign in once, or pass --organizer <handle>.`)
    process.exit(1)
  }

  const attendees = []
  for (const [i, name] of ACTORS.entries()) {
    const username = `flowdemo_${name}`
    attendees.push(
      await prisma.user.upsert({
        where: { username },
        update: {},
        create: {
          username,
          displayName: name.replace(/^./, (c) => c.toUpperCase()),
          xrplAddress: fabricatedAddress(i + 1),
        },
      }),
    )
  }

  if (flag('autosign')) {
    const asArg = arg('as') ?? 'organizer'
    const allowed = ['organizer', ...ACTORS]
    if (!allowed.includes(asArg)) {
      console.error(`--as must be one of: ${allowed.join(', ')}`)
      process.exit(1)
    }
    const asAddress =
      asArg === 'organizer' ? organizer.xrplAddress : fabricatedAddress(ACTORS.indexOf(asArg as Actor) + 1)
    const asLabel = asArg === 'organizer' ? `@${organizerHandle} (organizer)` : `@flowdemo_${asArg}`
    const knownUserIds = new Set([organizer.id, ...attendees.map((a) => a.id)])
    await autosign(apiUrl, knownUserIds, asLabel, asAddress)
    return // unreachable — autosign loops forever
  }

  const existing = await prisma.event.findUnique({ where: { slug: SLUG } })
  if (existing) {
    console.error(`"${SLUG}" already exists. Re-run with --clean to rebuild it.`)
    process.exit(1)
  }

  const event = await prisma.event.create({
    data: {
      slug: SLUG,
      network: NETWORK,
      title: TITLE,
      venue: 'The Observatory, Rooftop',
      description: 'A live walkthrough of every flow, minted for real (on a fake ledger).',
      startsAt: new Date(Date.now() + 12 * 86_400_000),
      organizerId: organizer.id,
      nftTaxon: 90_000 + Math.floor(Math.random() * 9_000),
      royaltyBps: 500,
      platformBps: env.PLATFORM_FEE_BPS,
      ticketCount,
      status: 'PUBLISHED',
    },
  })

  console.log(`\nCreated "${TITLE}" (${SLUG}) on ${NETWORK} — ${ticketCount} tickets, none minted yet.\n`)
  console.log(`  organizer  @${organizerHandle}`)
  for (const [i, name] of ACTORS.entries()) {
    console.log(`  ${name.padEnd(10)} @flowdemo_${name}  ${fabricatedAddress(i + 1)}`)
  }
  console.log(`\nIn another terminal, start autosign as whoever is about to sign in — default is the organizer:`)
  console.log(`  npm run demo:flow -- --autosign\n`)
  console.log('Walkthrough, in order (restart autosign with --as <role> each time who is signing in changes):')
  console.log(`  1. [--as organizer, the default] Sign in as @${organizerHandle}`)
  console.log(`  2. Mint a few of the ${ticketCount} tickets`)
  console.log('  3. Gift one to @flowdemo_attendee1')
  console.log('  4. List one for sale')
  console.log('  5. Open an auction on one')
  console.log('  6. Sign out. [--as attendee2] Sign in as @flowdemo_attendee2')
  console.log('  7. Buy the listing, and/or bid on the auction')
  console.log('  8. `npm run auction:settle` (or wait ~15s for the sweep)')
  console.log('  9. Sign out. [--as organizer] Sign in as the organizer and check the gifted ticket in at the door')
  console.log(`\nRe-run with --clean to rebuild "${SLUG}" from scratch.\n`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => {
    if (!process.argv.includes('--autosign')) prisma.$disconnect()
  })
