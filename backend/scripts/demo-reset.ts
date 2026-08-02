/**
 * Reset the walkthrough event so the demo can be run again.
 *
 * A demo you can only perform once is not a demo. After a run the event is
 * partly spent — tickets minted, one redeemed — and the next person sees a
 * half-used state instead of a clean start.
 *
 * This drops the demo event and everything hanging off it, then recreates it
 * with the same slug so the URL stays memorable, and a NEW taxon so old tickets
 * are not mistaken for new ones.
 *
 * It touches nothing else: accounts, other events and their provenance are left
 * alone, because a demo reset should never be able to eat real data.
 *
 *   npm run demo:reset
 *   npm run demo:reset -- --tickets 5
 *
 * ONE THING IT CANNOT DO: burn the NFTs already minted. We do not hold the
 * holders' keys, and tickets are minted without tfBurnable — deliberately, since
 * an organizer who can destroy a ticket someone paid for is a worse product than
 * one who cannot. Old demo tickets therefore stay in whoever's wallet, orphaned.
 * Anyone who wants a tidy wallet can burn their own in Xaman.
 */
import { prisma } from '../src/prisma.js'
import { NETWORK } from '../src/network.js'
import { env } from '../src/env.js'

const SLUG = 'station-square-live'
const TITLE = 'Station Square Live'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main() {
  if (env.NODE_ENV === 'production') {
    console.error('Refusing to reset demo data in production.')
    process.exit(1)
  }

  const organizerHandle = (arg('organizer') ?? 'dm_drastic').replace(/^@/, '')
  const ticketCount = Number(arg('tickets') ?? 3)

  const organizer = await prisma.user.findUnique({ where: { username: organizerHandle } })
  if (!organizer) {
    console.error(`No user @${organizerHandle}.`)
    process.exit(1)
  }

  const existing = await prisma.event.findUnique({
    where: { slug: SLUG },
    include: { tickets: { select: { id: true, nfTokenId: true } } },
  })

  if (existing) {
    const eventId = existing.id
    const ticketFilter = { ticket: { eventId } }

    // Children before parents; one transaction so a partial reset cannot leave
    // an event with dangling bids.
    const removed = await prisma.$transaction(async (tx) => {
      const bids = await tx.bid.deleteMany({ where: { auction: ticketFilter } })
      const auctions = await tx.auction.deleteMany({ where: { ticket: { eventId } } })
      const listings = await tx.listing.deleteMany({ where: { ticket: { eventId } } })
      const gifts = await tx.gift.deleteMany({ where: { ticket: { eventId } } })
      const redemptions = await tx.redemption.deleteMany({ where: { eventId } })
      const transfers = await tx.transfer.deleteMany({ where: { ticket: { eventId } } })
      const tickets = await tx.ticket.deleteMany({ where: { eventId } })
      const mints = await tx.mintRequest.deleteMany({ where: { eventId } })
      const staff = await tx.eventStaff.deleteMany({ where: { eventId } })
      await tx.event.delete({ where: { id: eventId } })
      return {
        tickets: tickets.count,
        transfers: transfers.count,
        redemptions: redemptions.count,
        listings: listings.count,
        auctions: auctions.count,
        bids: bids.count,
        gifts: gifts.count,
        mintRequests: mints.count,
        staff: staff.count,
      }
    })

    const cleared = Object.entries(removed).filter(([, n]) => n > 0)
    console.log(
      cleared.length > 0
        ? `cleared previous run: ${cleared.map(([k, n]) => `${n} ${k}`).join(', ')}`
        : 'previous run was already clean',
    )
    if (existing.tickets.length > 0) {
      console.log(
        `  note: ${existing.tickets.length} NFT(s) from that run still exist on-ledger and cannot be burned by us`,
      )
    }
  }

  // A fresh taxon per reset, so an old demo ticket can never be reconciled back
  // onto the new event as though it belonged.
  const highest = await prisma.event.findFirst({
    orderBy: { nftTaxon: 'desc' },
    select: { nftTaxon: true },
  })

  const event = await prisma.event.create({
    data: {
      network: NETWORK,
      slug: SLUG,
      title: TITLE,
      venue: 'Station Square',
      description: 'A walkthrough event. Reset with npm run demo:reset.',
      startsAt: new Date(Date.now() + 14 * 86_400_000),
      organizerId: organizer.id,
      nftTaxon: (highest?.nftTaxon ?? 1000) + 1,
      royaltyBps: 500,
      platformBps: env.PLATFORM_FEE_BPS,
      ticketCount,
      status: 'PUBLISHED',
    },
  })

  console.log(`\nready: ${event.title}`)
  console.log(`  url        /events → ${event.slug}`)
  console.log(`  organizer  @${organizer.username}`)
  console.log(`  tickets    ${event.ticketCount} (0 minted)`)
  console.log(`  royalty    ${event.royaltyBps / 100}%  ·  platform ${event.platformBps / 100}%`)
  console.log(`  taxon      ${event.nftTaxon}`)
  console.log('\nwalkthrough: mint → gift → check in → scan again (refused)')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
