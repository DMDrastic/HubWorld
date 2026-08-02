/**
 * Dev utility: create an auction with plausible bid history.
 *
 * This exists so the price tracker can run against the real API before the
 * on-ledger bidding mechanism is settled. The Bid rows it writes are marked
 * COMMITTED but no buy offer exists on-ledger — they are display fixtures, not
 * real bids, which is exactly why this script is dev-only and refuses to run in
 * production.
 *
 *   npm run auction:create -- --event neon-rooftop-session --reserve 12
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../src/prisma.js'
import { NETWORK } from '../src/network.js'
import { env } from '../src/env.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const XRP = 1_000_000n

async function main() {
  if (env.NODE_ENV === 'production') {
    console.error('Refusing to fabricate bids in production.')
    process.exit(1)
  }

  const slug = arg('event')
  if (!slug) {
    console.error('Usage: --event <slug> [--reserve 12] [--minutes 120] [--bids 16]')
    process.exit(1)
  }

  const ticket = await prisma.ticket.findFirst({
    where: { event: { slug } },
    include: { event: true, owner: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!ticket) {
    console.error(`No minted ticket for event "${slug}" — mint one first.`)
    process.exit(1)
  }

  const existing = await prisma.auction.findFirst({
    where: { ticketId: ticket.id, status: { in: ['SCHEDULED', 'LIVE', 'SETTLING'] } },
  })
  if (existing) {
    console.error(`That ticket already has a live auction (${existing.id}).`)
    process.exit(1)
  }

  // Anyone except the current holder can bid.
  const bidders = await prisma.user.findMany({
    where: ticket.ownerId ? { id: { not: ticket.ownerId } } : {},
    take: 6,
  })
  if (bidders.length === 0) {
    console.error('No users available to bid.')
    process.exit(1)
  }

  const minutesLeft = Number(arg('minutes') ?? 25)
  const totalMinutes = Number(arg('window') ?? 120)
  const bidCount = Number(arg('bids') ?? 16)
  const reserveXrp = Number(arg('reserve') ?? 12)

  const now = Date.now()
  const endsAt = new Date(now + minutesLeft * 60_000)
  const startsAt = new Date(endsAt.getTime() - totalMinutes * 60_000)

  const auction = await prisma.auction.create({
    data: {
      network: NETWORK,
      ticketId: ticket.id,
      startsAt,
      endsAt,
      reserveDrops: BigInt(reserveXrp) * XRP,
      status: 'LIVE',
    },
  })

  await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'IN_AUCTION' } })

  // Back-loaded, because real auctions are: the late rush is the whole point of
  // the velocity strip, and a uniform spread would make it look pointless.
  const span = endsAt.getTime() - startsAt.getTime()
  let price = 8n * XRP
  const rows: Prisma.BidCreateManyInput[] = []
  for (let i = 0; i < bidCount; i++) {
    const t = (i + 1) / (bidCount + 1)
    const at = startsAt.getTime() + span * Math.pow(t, 2.6)
    if (at > now) break
    price += BigInt(Math.round((0.3 + Math.random() * 0.9 + i * 0.1) * 1_000_000))
    rows.push({
      auctionId: auction.id,
      bidderId: bidders[i % bidders.length]!.id,
      network: NETWORK,
      amountDrops: price,
      placedAt: new Date(at),
      status: 'OUTBID',
    })
  }
  if (rows.length > 0) rows[rows.length - 1]!.status = 'COMMITTED'

  // One unfunded bid, so the ghosted-pending rendering is exercised against real
  // data. It is higher than the leader and must NOT move the displayed price.
  rows.push({
    auctionId: auction.id,
    bidderId: bidders[0]!.id,
    network: NETWORK,
    amountDrops: price + 2n * XRP,
    placedAt: new Date(now - 30_000),
    status: 'PENDING',
  })

  await prisma.bid.createMany({ data: rows })

  const top = rows.filter((r) => r.status !== 'PENDING').at(-1)
  console.log(`Auction created for "${ticket.event.title}"`)
  console.log(`  id         ${auction.id}`)
  console.log(`  ticket     ${ticket.nfTokenId.slice(0, 16)}… (held by @${ticket.owner?.username ?? '?'})`)
  console.log(`  reserve    ${reserveXrp} XRP`)
  console.log(`  bids       ${rows.length} (${rows.length - 1} committed, 1 pending)`)
  console.log(`  top bid    ${Number(top?.amountDrops ?? 0n) / 1e6} XRP`)
  console.log(`  closes     in ${minutesLeft} minutes`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
